/**
 * Windows ACL hardening — Phase R7 §7, §8.
 *
 * The production state root holds a durable credential, so "the user profile is
 * probably restrictive enough" is not an acceptable answer: an inherited `Users`
 * ACE with read access is exactly the exposure this must close.
 *
 * Two decisions shape the implementation.
 *
 * **SIDs, never localized names.** `BUILTIN\Users` is a different string on a
 * non-English Windows, so a name-based grant either fails or silently grants the
 * wrong principal. Every principal here is a SID.
 *
 * **A file ACL is replaced, not amended.** Adding an ACE to an inherited ACL leaves
 * the inherited ones in place, which is how a "hardened" directory keeps a `Users`
 * read ACE. Inheritance is disabled, inherited rules are dropped, and the resulting
 * ACL is then verified rather than assumed.
 *
 * PowerShell is used for the ACL work because it is the only supported interface to
 * `System.Security.AccessControl` from this process. Only the ACL cmdlets are used —
 * never a text-writing cmdlet (§4).
 */

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';

import { R7_ERROR, ProductionError } from './production-config.mjs';

/** Alias so the module reads clearly alongside the ACL work. */
const nodeFs = fs;

/** The only principals permitted on a protected node. */
export const SYSTEM_SID = 'S-1-5-18';

/** Broad SIDs that must never hold an Allow ACE on a protected node (§7). */
export const FORBIDDEN_SIDS = Object.freeze({
  'S-1-1-0': 'Everyone',
  'S-1-5-11': 'Authenticated Users',
  'S-1-5-32-545': 'BUILTIN\\Users',
  'S-1-5-4': 'INTERACTIVE',
  'S-1-5-32-546': 'BUILTIN\\Guests',
});

/** Rights granted to the two permitted principals. */
export const GRANTED_RIGHTS = 'FullControl';

/** The PowerShell arguments every invocation shares. */
const PS_ARGS = Object.freeze(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);

/**
 * Run a PowerShell snippet and return its stdout.
 *
 * @param {string} script - the script text.
 * @param {object} [options] - `encoding` override.
 * @returns {Promise<string>} trimmed stdout.
 * @throws {ProductionError} on a non-zero exit.
 */
export async function runPowerShell(script, options = {}) {
  // Codex and other Node launchers may prepend PowerShell 7 module directories
  // to PSModulePath. This helper deliberately invokes Windows PowerShell 5.1;
  // exposing PS7 modules there can make Microsoft.PowerShell.Security fail to
  // load with duplicate TypeData members, leaving Get-Acl unavailable.
  const env = {
    ...process.env,
    PSModulePath: String(process.env.PSModulePath ?? '')
      .split(';')
      .filter((modulePath) => /\\WindowsPowerShell(?:\\|$)/i.test(modulePath))
      .join(';'),
  };
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [...PS_ARGS, script],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024, env, ...options },
      (error, stdout, stderr) => {
        if (error !== null && error !== undefined) {
          reject(new ProductionError(
            R7_ERROR.ACL_HARDENING_FAILED,
            `PowerShell failed: ${String(stderr ?? error.message).trim().split('\n')[0]}`,
          ));
          return;
        }
        resolve(String(stdout ?? '').trim());
      },
    );
  });
}

/**
 * The current Windows user's SID.
 *
 * @returns {Promise<string>} the SID.
 */
export async function currentUserSid() {
  const raw = await runPowerShell('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
  const sid = raw.split(/\r?\n/).pop()?.trim() ?? '';
  if (!/^S-1-[\d-]+$/.test(sid)) {
    throw new ProductionError(R7_ERROR.ACL_HARDENING_FAILED, 'could not determine the current user SID');
  }
  return sid;
}

/**
 * Hard an ACL: disable inheritance, drop inherited rules, grant exactly two SIDs.
 *
 * The script is deliberately defensive about the ordered rules: `SetAccessRuleProtection`
 * must run before the purge, or the inherited rules are still present when the
 * explicit grants are added and the result silently keeps them.
 *
 * @param {string} target - a file or directory path.
 * @param {object} [options] - `extraSid` to grant as well.
 * @returns {Promise<{target: string, sid: string}>} what was done.
 */
export async function hardenAcl(target, options = {}) {
  const sid = options.sid ?? await currentUserSid();
  // `ContainerInherit,ObjectInherit` is only meaningful on a directory. Passing it for
  // a file is rejected by Windows with "no flags can be set", so the inheritance scope
  // has to match the node type.
  const isDirectory = options.isDirectory ?? isDirectorySync(target);
  const inheritance = isDirectory ? 'ContainerInherit,ObjectInherit' : 'None';
  const script = `
$ErrorActionPreference = 'Stop'
$path = ${JSON.stringify(target)}
$sid  = ${JSON.stringify(sid)}

$acl = Get-Acl -LiteralPath $path
# 1. Cut inheritance first and DROP inherited rules. Doing this after the purge
#    would re-copy the parent's ACEs.
$acl.SetAccessRuleProtection($true, $false)
# 2. Remove every remaining explicit rule, so nothing survives by accident.
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
# 3. Grant exactly the two permitted principals.
foreach ($principal in @($sid, '${SYSTEM_SID}')) {
  $identity = New-Object System.Security.Principal.SecurityIdentifier($principal)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $identity, '${GRANTED_RIGHTS}', '${inheritance}', 'None', 'Allow')
  [void]$acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $path -AclObject $acl
Write-Output "hardened"
`.trim();
  await runPowerShell(script);
  return { target, sid, isDirectory };
}

/**
 * Remove a directory tree, restoring ACL inheritance first — **synchronously**.
 *
 * The asynchronous variant cannot be relied on from a test teardown: a `void`ed promise
 * does not keep the process alive, so the restore never finished and one temp evidence
 * directory leaked per run. Node's test runner may exit as soon as the last test
 * resolves, so teardown must be complete before it returns.
 *
 * @param {string} root - the tree root.
 * @returns {boolean} true when the tree is gone.
 */
export function removeTreeWithAclRestoreSync(root) {
  if (!nodeFs.existsSync(root)) return true;
  try {
    nodeFs.rmSync(root, { recursive: true, force: true });
    return true;
  } catch {
    // The hardened DACL blocked the delete; undo it and retry.
  }

  // Restore inheritance across the tree, deepest first, in one synchronous burst.
  const nodes = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = nodeFs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      nodes.push(full);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  nodes.reverse();
  nodes.push(root);

  for (const node of nodes) {
    if (!nodeFs.existsSync(node)) continue;
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
$acl = Get-Acl -LiteralPath ${JSON.stringify(node)}
$acl.SetAccessRuleProtection($false, $true)
Set-Acl -LiteralPath ${JSON.stringify(node)} -AclObject $acl
`.trim();
    try {
      execFileSync('powershell.exe', [...PS_ARGS, script], { windowsHide: true, stdio: 'ignore' });
    } catch {
      // Keep going: one stubborn node should not abandon the whole teardown.
    }
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      nodeFs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // fall through to the next attempt
    }
    if (!nodeFs.existsSync(root)) return true;
  }
  return !nodeFs.existsSync(root);
}

/**
 * Whether a path is a directory.
 *
 * @param {string} target - the path.
 * @returns {boolean} true when it is a directory.
 */
function isDirectorySync(target) {
  try {
    return nodeFs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read a node's ACL in a structured, locale-independent form.
 *
 * @param {string} target - a file or directory path.
 * @returns {Promise<{protected: boolean, owner: string, rules: Array<{sid: string, type: string, rights: string}>}>}
 *   the ACL.
 */
export async function readAcl(target) {
  const script = `
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath ${JSON.stringify(target)}
$rules = @()
foreach ($r in @($acl.Access)) {
  $rules += [pscustomobject]@{
    sid    = $r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    type   = $r.AccessControlType.ToString()
    rights = $r.FileSystemRights.ToString()
  }
}
[pscustomobject]@{
  protected = $acl.AreAccessRulesProtected
  owner     = $acl.Owner
  rules     = @($rules)
} | ConvertTo-Json -Compress -Depth 5
`.trim();
  const raw = await runPowerShell(script);
  const line = raw.split(/\r?\n/).filter((entry) => entry.trim().startsWith('{')).pop() ?? raw;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new ProductionError(R7_ERROR.ACL_HARDENING_FAILED, 'could not parse the ACL');
  }
  const rules = Array.isArray(parsed.rules) ? parsed.rules : (parsed.rules === null ? [] : [parsed.rules]);
  return {
    protected: parsed.protected === true,
    owner: String(parsed.owner ?? ''),
    rules: rules.map((rule) => ({
      sid: String(rule.sid ?? ''),
      type: String(rule.type ?? ''),
      rights: String(rule.rights ?? ''),
    })),
  };
}

/**
 * Verify a node's ACL against the §7 policy.
 *
 * Fails closed: anything not provably correct is a refusal. An unreadable ACL is
 * never treated as compliant.
 *
 * @param {string} target - a file or directory path.
 * @param {object} [options] - `sid` (defaults to the current user) and `label`.
 * @returns {Promise<object>} the verified ACL plus its decision.
 * @throws {ProductionError} `R7_ACL_POLICY_MISMATCH` or `R7_PHONE_TOKEN_ACL_INVALID`.
 */
export async function verifyAcl(target, options = {}) {
  const sid = options.sid ?? await currentUserSid();
  const acl = await readAcl(target);
  const code = options.code ?? R7_ERROR.ACL_POLICY_MISMATCH;
  const label = options.label ?? target;
  const fail = (reason) => {
    throw new ProductionError(code, `${label}: ${reason}`);
  };

  // §7: inheritance must be off. Without this the parent's ACEs still apply.
  if (!acl.protected) fail('inheritance is not disabled (AreAccessRulesProtected is false)');

  const allowed = new Set([sid, SYSTEM_SID]);
  const allowRules = acl.rules.filter((rule) => rule.type === 'Allow');

  for (const rule of allowRules) {
    // §7: a broad Allow ACE is a mismatch, not a warning. An unusable SID that is
    // not one of the two permitted principals is equally disqualifying.
    const broadName = FORBIDDEN_SIDS[rule.sid];
    if (broadName !== undefined) fail(`a broad Allow ACE is present for ${broadName} (${rule.sid})`);
    if (!allowed.has(rule.sid)) fail(`an unexpected Allow ACE is present for ${rule.sid}`);
  }

  // Both permitted principals must actually be present: an ACL granting only the
  // user would break LocalSystem-backed operations, and one granting only SYSTEM
  // would lock the operator out.
  const grantedSids = new Set(allowRules.map((rule) => rule.sid));
  if (!grantedSids.has(sid)) fail('the current user has no Allow ACE');
  if (!grantedSids.has(SYSTEM_SID)) fail('LocalSystem has no Allow ACE');

  return { ok: true, target, sid, protected: acl.protected, rules: acl.rules };
}

/**
 * Whether this platform can enforce the ACL policy at all.
 *
 * On a non-Windows host the policy is unenforceable, and §7 forbids pretending
 * otherwise — the caller must treat `false` as a refusal, never as a pass.
 *
 * @param {string} [platform] - the platform to test.
 * @returns {boolean} true when ACL hardening is supported.
 */
export function aclSupported(platform = process.platform) {
  return platform === 'win32';
}

/**
 * Assert that ACL hardening is available.
 *
 * @param {string} [platform] - the platform to test.
 * @returns {void}
 * @throws {ProductionError} `R7_ACL_HARDENING_FAILED` off Windows.
 */
export function assertAclSupported(platform = process.platform) {
  if (!aclSupported(platform)) {
    throw new ProductionError(
      R7_ERROR.ACL_HARDENING_FAILED,
      `ACL hardening requires Windows; this platform is ${platform}`,
    );
  }
}

/**
 * Restore inheritance on a node so it can be deleted.
 *
 * ACL hardening exists to stop **other** local users reading a secret. The same
 * protection makes a test fixture undeletable: the directory's own DACL no longer grants
 * the owner the rights a recursive delete needs, and `fs.rmSync` fails with `EPERM`.
 *
 * Teardown must therefore undo the hardening **before** removing the tree. Leaving
 * fixtures behind is not merely untidy — a leaked temp root is exactly the kind of
 * residue this project's discipline exists to prevent, and 42 of them accumulated before
 * this was noticed.
 *
 * @param {string} target - a file or directory path.
 * @returns {Promise<boolean>} true when inheritance was restored.
 */
export async function restoreAclInheritance(target) {
  if (!nodeFs.existsSync(target)) return true;
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$path = ${JSON.stringify(target)}
$acl = Get-Acl -LiteralPath $path
# Re-enable inheritance and COPY the current explicit rules into inherited ones, so the
# node stays usable by its owner while becoming deletable.
$acl.SetAccessRuleProtection($false, $true)
Set-Acl -LiteralPath $path -AclObject $acl
Write-Output "restored"
`.trim();
  try {
    await runPowerShell(script);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore inheritance across a directory tree.
 *
 * @param {string} root - the tree root.
 * @returns {Promise<number>} how many nodes were processed.
 */
export async function restoreAclInheritanceRecursive(root) {
  if (!nodeFs.existsSync(root)) return 0;
  const nodes = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = nodeFs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      nodes.push(full);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  // Deepest first, then the root, so a parent cannot re-propagate onto a child.
  nodes.reverse();
  nodes.push(root);
  for (const node of nodes) {
    await restoreAclInheritance(node);
  }
  return nodes.length;
}

/**
 * Remove a directory tree, restoring ACL inheritance first.
 *
 * @param {string} root - the tree root.
 * @returns {Promise<boolean>} true when the tree is gone.
 */
export async function removeTreeWithAclRestore(root) {
  if (!nodeFs.existsSync(root)) return true;
  try {
    nodeFs.rmSync(root, { recursive: true, force: true });
    return true;
  } catch {
    // The hardened DACL blocked the delete; undo it and retry.
  }
  await restoreAclInheritanceRecursive(root);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      nodeFs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // fall through to the next attempt
    }
    if (!nodeFs.existsSync(root)) return true;
    await new Promise((resolve) => { setTimeout(resolve, 150); });
  }
  return !nodeFs.existsSync(root);
}
