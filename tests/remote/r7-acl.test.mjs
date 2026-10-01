/**
 * Windows ACL tests — Phase R7 §6, §7, §8.
 *
 * These run against **real Windows ACLs on a temp directory**, not a mock. The R5A
 * lesson applies directly: a test that asserts a policy against a stub proves the
 * stub, not the policy. A temp directory inherits a real, broad ACL — including
 * `BUILTIN\Administrators` and often the owning user — which is exactly the starting
 * condition the hardening has to fix.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FORBIDDEN_SIDS,
  SYSTEM_SID,
  aclSupported,
  assertAclSupported,
  currentUserSid,
  hardenAcl,
  readAcl,
  verifyAcl,
} from '../../src/remote/production/windows-acl.mjs';
import {
  R7_ERROR,
  makeTempProduction,
  prepareProductionRoot,
  productionRootExists,
  resolveProductionConfig,
} from './r7-helpers.mjs';

/** Create a temp directory with its inherited ACL intact. */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'r7-acl-'));
}

test('§7: ACL hardening is only claimed where it can be enforced', () => {
  assert.equal(aclSupported('win32'), true);
  assert.equal(aclSupported('linux'), false);
  assert.equal(aclSupported('darwin'), false);
  assert.doesNotThrow(() => assertAclSupported('win32'));
  // Off Windows the policy is unenforceable, and pretending otherwise is the failure
  // mode this assertion exists to prevent.
  assert.throws(
    () => assertAclSupported('linux'),
    (error) => error.code === R7_ERROR.ACL_HARDENING_FAILED,
  );
});

test('§7: the forbidden SID list is exactly the documented one', () => {
  assert.equal(FORBIDDEN_SIDS['S-1-1-0'], 'Everyone');
  assert.equal(FORBIDDEN_SIDS['S-1-5-11'], 'Authenticated Users');
  assert.equal(FORBIDDEN_SIDS['S-1-5-32-545'], 'BUILTIN\\Users');
  assert.equal(SYSTEM_SID, 'S-1-5-18');
});

test('§7: an inherited temp-directory ACL is broad before hardening', async (t) => {
  if (!aclSupported()) {
    t.skip('Windows ACLs are required');
    return;
  }
  const dir = tempDir();
  try {
    const before = await readAcl(dir);
    // The point of the test: the starting state really is permissive, so the
    // hardening assertions below are not vacuous.
    assert.equal(before.protected, false, 'a fresh temp directory inherits');
    assert.ok(before.rules.length > 0, 'and carries inherited rules');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('§7: hardening leaves exactly the current user and LocalSystem', async (t) => {
  if (!aclSupported()) {
    t.skip('Windows ACLs are required');
    return;
  }
  const dir = tempDir();
  try {
    const sid = await currentUserSid();
    await hardenAcl(dir, { sid });
    const acl = await readAcl(dir);

    assert.equal(acl.protected, true, 'inheritance must be disabled');
    const allow = acl.rules.filter((rule) => rule.type === 'Allow');
    assert.equal(allow.length, 2, `exactly two Allow ACEs, saw ${allow.length}`);
    const sids = allow.map((rule) => rule.sid).sort();
    assert.deepEqual(sids, [SYSTEM_SID, sid].sort());
    for (const rule of allow) assert.match(rule.rights, /FullControl/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('§7: verification passes on a hardened directory', async (t) => {
  if (!aclSupported()) {
    t.skip('Windows ACLs are required');
    return;
  }
  const dir = tempDir();
  try {
    const sid = await currentUserSid();
    await hardenAcl(dir, { sid });
    const verified = await verifyAcl(dir, { sid });
    assert.equal(verified.ok, true);
    assert.equal(verified.protected, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('§7: verification refuses a directory that still inherits', async (t) => {
  if (!aclSupported()) {
    t.skip('Windows ACLs are required');
    return;
  }
  const dir = tempDir();
  try {
    const sid = await currentUserSid();
    await assert.rejects(
      () => verifyAcl(dir, { sid }),
      (error) => error.code === R7_ERROR.ACL_POLICY_MISMATCH,
      'an unhardened directory must be refused',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('§7: verification refuses a broad Allow ACE added after hardening', async (t) => {
  if (!aclSupported()) {
    t.skip('Windows ACLs are required');
    return;
  }
  const dir = tempDir();
  try {
    const sid = await currentUserSid();
    await hardenAcl(dir, { sid });

    // Deliberately re-introduce a broad ACE, which is what an operator or an
    // installer script might do without realising.
    const { runPowerShell } = await import('../../src/remote/production/windows-acl.mjs');
    await runPowerShell(`
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath ${JSON.stringify(dir)}
$sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-545')
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'Read', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
[void]$acl.AddAccessRule($rule)
Set-Acl -LiteralPath ${JSON.stringify(dir)} -AclObject $acl
`);

    await assert.rejects(
      () => verifyAcl(dir, { sid }),
      (error) => {
        assert.equal(error.code, R7_ERROR.ACL_POLICY_MISMATCH);
        assert.match(error.message, /BUILTIN\\Users/);
        return true;
      },
      'a BUILTIN\\Users Allow ACE must be a mismatch, not a warning',
    );

    // And re-hardening fixes it, proving the check is not simply always-fail.
    await hardenAcl(dir, { sid });
    assert.equal((await verifyAcl(dir, { sid })).ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('§8: a file ACL can be hardened independently of its directory', async (t) => {
  if (!aclSupported()) {
    t.skip('Windows ACLs are required');
    return;
  }
  const dir = tempDir();
  const file = path.join(dir, 'phone-token.v1');
  try {
    fs.writeFileSync(file, 'x'.repeat(43), 'utf8');
    const sid = await currentUserSid();
    await hardenAcl(file, { sid });

    const verified = await verifyAcl(file, { sid, code: R7_ERROR.PHONE_TOKEN_ACL_INVALID });
    assert.equal(verified.ok, true);
    assert.equal((await readAcl(file)).protected, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('§8: a token ACL failure uses the token-specific code', async (t) => {
  if (!aclSupported()) {
    t.skip('Windows ACLs are required');
    return;
  }
  const dir = tempDir();
  const file = path.join(dir, 'phone-token.v1');
  try {
    fs.writeFileSync(file, 'x'.repeat(43), 'utf8');
    const sid = await currentUserSid();
    // Not hardened, so verification must fail with the credential code.
    await assert.rejects(
      () => verifyAcl(file, { sid, code: R7_ERROR.PHONE_TOKEN_ACL_INVALID }),
      (error) => error.code === R7_ERROR.PHONE_TOKEN_ACL_INVALID,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('§6: the production root is created and hardened in the required order', async (t) => {
  if (!aclSupported()) {
    t.skip('Windows ACLs are required');
    return;
  }
  const { config, cleanup } = makeTempProduction();
  try {
    const order = [];
    const sid = await currentUserSid();
    const result = await prepareProductionRoot({
      config,
      harden: async (target, options) => { order.push(`harden:${path.basename(target)}`); return hardenAcl(target, { sid, ...options }); },
      verify: async (target, options) => { order.push(`verify:${path.basename(target)}`); return verifyAcl(target, { sid, ...options }); },
    });

    assert.equal(result.created, true);
    assert.equal(result.aclVerified, true);
    // §6: protect, then VERIFY, and only then create children.
    assert.deepEqual(order, ['harden:remote', 'verify:remote']);
    assert.equal(productionRootExists(config), true);
    assert.equal((await readAcl(config.paths.root)).protected, true);

    // The children exist and inherited the protected DACL.
    for (const sub of ['secrets', 'state', 'logs', 'events', 'quarantine']) {
      assert.equal(fs.existsSync(path.join(config.paths.root, sub)), true, `${sub} must exist`);
    }
    assert.equal(fs.existsSync(config.paths.format), true, 'the R5 format marker exists');
    const format = JSON.parse(fs.readFileSync(config.paths.format, 'utf8'));
    assert.deepEqual(format, { format: 'dsh-remote-state', version: 1 });
  } finally {
    cleanup();
  }
});

test('§6: an ACL failure aborts before any child is created', async (t) => {
  if (!aclSupported()) {
    t.skip('Windows ACLs are required');
    return;
  }
  const { config, cleanup } = makeTempProduction();
  try {
    await assert.rejects(
      () => prepareProductionRoot({
        config,
        harden: async () => { throw new Error('hardening refused'); },
        verify: async () => ({ ok: true }),
      }),
      (error) => error.code === R7_ERROR.ACL_HARDENING_FAILED,
    );
    // Nothing inside the root may exist: a secret written before protection is a
    // secret that was briefly readable.
    assert.equal(fs.existsSync(config.paths.secrets), false);
    assert.equal(fs.existsSync(config.paths.format), false);
  } finally {
    cleanup();
  }
});

test('§6: a verification failure also aborts before children are created', async (t) => {
  if (!aclSupported()) {
    t.skip('Windows ACLs are required');
    return;
  }
  const { config, cleanup } = makeTempProduction();
  try {
    const sid = await currentUserSid();
    await assert.rejects(
      () => prepareProductionRoot({
        config,
        harden: async (target) => hardenAcl(target, { sid }),
        verify: async () => { throw new Error('policy mismatch'); },
      }),
      (error) => error.code === R7_ERROR.ACL_HARDENING_FAILED,
    );
    assert.equal(fs.existsSync(config.paths.secrets), false);
  } finally {
    cleanup();
  }
});

test('§6: an existing production root is refused, never reused', async (t) => {
  if (!aclSupported()) {
    t.skip('Windows ACLs are required');
    return;
  }
  const { config, cleanup } = makeTempProduction();
  try {
    const sid = await currentUserSid();
    fs.mkdirSync(config.paths.root, { recursive: true });
    fs.writeFileSync(path.join(config.paths.root, 'evidence.txt'), 'pre-existing', 'utf8');

    await assert.rejects(
      () => prepareProductionRoot({
        config,
        harden: async (target) => hardenAcl(target, { sid }),
        verify: async (target) => verifyAcl(target, { sid }),
      }),
      (error) => error.code === R7_ERROR.PRODUCTION_ROOT_UNEXPECTED,
    );
    // The pre-existing content must be untouched: R7 does not delete what it did not
    // create.
    assert.equal(fs.readFileSync(path.join(config.paths.root, 'evidence.txt'), 'utf8'), 'pre-existing');
  } finally {
    cleanup();
  }
});

test('§6: root creation requires an ACL hardener and verifier', async () => {
  const { config, cleanup } = makeTempProduction();
  try {
    await assert.rejects(
      () => prepareProductionRoot({ config, harden: null, verify: null }),
      (error) => error.code === R7_ERROR.ACL_HARDENING_FAILED,
    );
  } finally {
    cleanup();
  }
});
