/**
 * R5A compliance check — Phase R5A §12, §13.
 *
 * A read-only acceptance gate. It verifies the properties R5A exists to establish
 * and then reports them, in text and as machine-readable JSON.
 *
 * It deliberately does **not**:
 *
 *   - write the real `$DSH_HOME` or create a state root anywhere;
 *   - start production persistence or bind a listener;
 *   - open, hash or copy `.credentials.yaml`;
 *   - modify any project file.
 *
 * Exit status is 0 only when every gate passes, so it can be used as a hard
 * acceptance gate rather than an advisory report.
 *
 * Run with `npm run compliance:r5a`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePersistenceConfig, resolveDshHome } from '../src/remote/persistence/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');

/** Text file extensions that must be encoding-clean. */
const TEXT_EXTENSIONS = new Set(['.mjs', '.js', '.json', '.md']);

/** Directories never worth scanning. */
const SKIP_DIRECTORIES = new Set(['node_modules', '.git']);

const results = [];
const notes = [];

/**
 * Record one gate result.
 *
 * @param {string} name - the gate name.
 * @param {boolean} passed - whether it passed.
 * @param {object} [details] - small, safe extras.
 * @returns {void}
 */
function gate(name, passed, details = {}) {
  results.push({ name, passed, ...details });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${Object.keys(details).length > 0 ? `  ${JSON.stringify(details)}` : ''}`);
}

/**
 * Walk a directory for text files, skipping noise.
 *
 * @param {string} dir - the root.
 * @param {string[]} [out] - accumulator.
 * @returns {string[]} the file paths.
 */
function walkText(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkText(full, out);
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Scan every text file for encoding damage.
 *
 * @param {string} root - the project root.
 * @returns {{files: number, bom: string[], ufffd: string[], invalid: string[]}} the findings.
 */
function scanEncoding(root) {
  const findings = { files: 0, bom: [], ufffd: [], invalid: [] };
  for (const file of walkText(root)) {
    findings.files += 1;
    const bytes = fs.readFileSync(file);
    const relative = path.relative(root, file);

    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      findings.bom.push(relative);
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      findings.invalid.push(relative);
    }
    // Count replacement characters in the decoded text, which the strict decode
    // above would not catch if they were genuinely encoded.
    const text = bytes.toString('utf8');
    if (text.includes('\uFFFD')) findings.ufffd.push(relative);
  }
  return findings;
}

/** The cmdlet names the process gate forbids, assembled so this file never contains
 * a literal invocation of one. */
const FORBIDDEN_CMDLETS = [
  ['Set', 'Content'].join('-'),
  ['Out', 'File'].join('-'),
  ['Add', 'Content'].join('-'),
];

/**
 * Build the invocation detector.
 *
 * Recognises a forbidden cmdlet followed by PowerShell parameter syntax
 * (`-Encoding`, `-Path`, `-Value`, `-NoNewline`, `-LiteralPath`, `-Append`) on the
 * same line, which prose describing the rule does not contain.
 *
 * @returns {RegExp} the detector.
 */
function buildInvocationPattern() {
  return new RegExp(
    `\\b(?:${FORBIDDEN_CMDLETS.join('|')})\\b[^\\n]*?\\s-(?:Encoding|Path|Value|NoNewline|LiteralPath|Append)\\b`,
  );
}

/**
 * Remove fenced code blocks and inline code from Markdown.
 *
 * A report has to be able to quote the command that caused an incident — that is
 * what makes it an audit record rather than a sanitised summary. Quoted and fenced
 * material is therefore excluded before the invocation scan.
 *
 * Inline spans are matched with `[\s\S]` rather than `[^`\n]` because a long prose
 * sentence can wrap a single backtick span across a line break, and a
 * single-line-only pattern would leave the second half behind — which is exactly
 * how this scan first produced a false positive on the R4 report.
 *
 * @param {string} text - the Markdown source.
 * @returns {string} the prose only.
 */
function stripCodeFromMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`]*`/g, ' ');
}

/**
 * Whether the process gate tooling left any trace in the source tree.
 *
 * Three things are verifiable from inside this process:
 *
 *   1. a BOM, which is the signature the forbidden cmdlets leave behind;
 *   2. an actual **invocation** of one of them in executable code;
 *   3. an actual invocation in documentation prose, excluding quoted examples.
 *
 * An invocation is recognised by PowerShell parameter syntax (`-Encoding`, `-Path`,
 * `-Value`, `-NoNewline`, `-LiteralPath`, `-Append`) following the cmdlet, which
 * prose describing the rule does not contain.
 *
 * @param {string} root - the project root.
 * @returns {{cmdletsAbsent: boolean, offenders: string[], scanned: number, detectorSelfTest: boolean}} the verdict.
 */
function scanProcessGate(root) {
  const invocation = buildInvocationPattern();

  // Prove the detector is not vacuous before trusting a "clean" result. A regex that
  // silently matched nothing would make every tree look compliant.
  //
  // The samples are assembled at runtime so that this file does not itself contain a
  // literal cmdlet invocation — otherwise the scanner would flag its own self-test,
  // which is a false positive by construction.
  const detectorSelfTest = [
    [['Set', 'Content'].join('-') + ' -Path a.mjs -Value $c -NoNewline -Encoding utf8', true],
    ['npm test 2>&1 | ' + ['Out', 'File'].join('-') + ' -Encoding utf8 out.txt', true],
    [['Add', 'Content'].join('-') + ' -Path a.mjs -Value x', true],
    ['No ' + ['Set', 'Content'].join('-') + ' source edits were made.', false],
    ['const x = 1;', false],
  ].every(([sample, expected]) => invocation.test(sample) === expected);

  const offenders = [];
  let scanned = 0;
  for (const file of walkText(root)) {
    scanned += 1;
    const raw = fs.readFileSync(file, 'utf8');
    // Markdown may legitimately quote an example; executable files may not contain one.
    const text = path.extname(file) === '.md' ? stripCodeFromMarkdown(raw) : raw;
    if (invocation.test(text)) offenders.push(path.relative(root, file));
  }
  return { cmdletsAbsent: offenders.length === 0 && detectorSelfTest, offenders, scanned, detectorSelfTest };
}

console.log('R5A COMPLIANCE CHECK');
console.log(`project: ${PROJECT}`);
console.log('');

try {
  // ── 1. Real DSH_HOME state root must be absent, or a legitimate production root ──
  //
  // Before R7 Gate B this gate asserts absence: a root that appears during development is
  // the R5 incident repeating. Gate B exists to create that root deliberately, so after it
  // the gate would fail forever for the wrong reason.
  //
  // The gate therefore distinguishes the two, and the property is unchanged: a root must
  // never appear *by accident*. A legitimate one carries the R5 format marker and a
  // credential; anything else is residue and still fails.
  const dshHome = resolveDshHome(process.env);
  const realRoot = path.join(dshHome, 'remote');
  const realRootExists = fs.existsSync(realRoot);
  const formatMarker = path.join(realRoot, 'format.json');
  const credentialFile = path.join(realRoot, 'secrets', 'phone-token.v1');
  const legitimateRoot = realRootExists
    && fs.existsSync(formatMarker)
    && fs.existsSync(credentialFile);

  gate(
    'real_state_root_absent',
    realRootExists === false || legitimateRoot,
    {
      path: realRoot,
      exists: realRootExists,
      legitimate_production_root: legitimateRoot,
    },
  );
  if (realRootExists && legitimateRoot) {
    notes.push('R5A_PRODUCTION_ROOT_PRESENT: a Gate B production root is in place; this is expected after R7 Gate B.');
  } else if (realRootExists) {
    notes.push('R5A_REAL_STATE_ROOT_PREEXISTS: the root exists without a format marker and credential, so something wrote it by accident; stop and await a human decision, do not delete.');
  }

  // ── 2. Production default is still `%DSH_HOME%\remote` ───────────────────
  // Verified with a synthetic home, so the check does not depend on this machine's
  // environment and never touches the real one.
  const syntheticHome = path.join(os.tmpdir(), 'r5a-synthetic-home', '.dsh');
  const production = resolvePersistenceConfig({}, { DSH_HOME: syntheticHome });
  const expectedRoot = path.join(path.resolve(syntheticHome), 'remote');
  gate('production_default_correct', production.root === expectedRoot, {
    expected: expectedRoot,
    actual: production.root,
    isDefaultRoot: production.isDefaultRoot,
  });

  // ── 3. An override must stay absolute ─────────────────────────────────────
  let overrideRejected = false;
  try {
    resolvePersistenceConfig({ root: 'relative/root' }, { DSH_HOME: syntheticHome });
  } catch {
    overrideRejected = true;
  }
  gate('relative_override_rejected', overrideRejected);

  // ── 4. Temp roots are outside DSH_HOME ────────────────────────────────────
  const tempProbe = fs.mkdtempSync(path.join(os.tmpdir(), 'r5a-compliance-'));
  const homeResolved = path.resolve(dshHome);
  const homeWithSeparator = homeResolved.endsWith(path.sep) ? homeResolved : homeResolved + path.sep;
  const probeResolved = path.resolve(tempProbe);
  const outside = probeResolved !== homeResolved && !probeResolved.startsWith(homeWithSeparator);
  gate('temp_root_outside_dsh_home', outside, { tempRoot: probeResolved });
  fs.rmSync(tempProbe, { recursive: true, force: true });

  // ── 5. Fixture persistence defaults are safe ──────────────────────────────
  // Read the shipped helper and confirm the default is an explicit opt-out, rather
  // than trusting the prose comment that says so.
  const helperSource = fs.readFileSync(path.join(PROJECT, 'tests', 'remote', 'r3-helpers.mjs'), 'utf8');
  const fixtureDefaultSafe = helperSource.includes('? { persistence: null }')
    && helperSource.includes('makeTempStateRoot')
    && helperSource.includes('assertTempStateRoot');
  gate('fixture_default_persistence_safe', fixtureDefaultSafe);

  // ── 6. The factory requires an explicit durability decision ───────────────
  const serverSource = fs.readFileSync(path.join(PROJECT, 'src', 'remote', 'server.mjs'), 'utf8');
  const explicitDecision = serverSource.includes('explicit durability decision');
  gate('factory_requires_explicit_decision', explicitDecision);

  // ── 7. Encoding ───────────────────────────────────────────────────────────
  const encoding = scanEncoding(PROJECT);
  gate('bom_zero', encoding.bom.length === 0, { files: encoding.files, found: encoding.bom.slice(0, 5) });
  gate('ufffd_zero', encoding.ufffd.length === 0, { found: encoding.ufffd.slice(0, 5) });
  gate('invalid_utf8_zero', encoding.invalid.length === 0, { found: encoding.invalid.slice(0, 5) });

  // ── 8. No forbidden cmdlet invocation in project files ────────────────────
  const cmdletScan = scanProcessGate(PROJECT);
  gate('no_forbidden_cmdlet_invocation', cmdletScan.cmdletsAbsent, {
    scanned: cmdletScan.scanned,
    detectorSelfTest: cmdletScan.detectorSelfTest,
    offenders: cmdletScan.offenders.slice(0, 5),
  });

  // ── 9. The state root is not DSH_HOME itself ──────────────────────────────
  let rootIsHomeRejected = false;
  try {
    resolvePersistenceConfig({ root: homeResolved }, { DSH_HOME: homeResolved });
  } catch {
    rootIsHomeRejected = true;
  }
  gate('root_may_not_be_dsh_home', rootIsHomeRejected);
} catch (error) {
  // An unexpected failure is itself a failed gate, never a pass.
  gate('unexpected_error', false, { message: String(error?.message ?? error) });
}

const failed = results.filter((entry) => entry.passed === false);
const report = {
  phase: 'R5A',
  kind: 'compliance-check',
  passed: failed.length === 0,
  gates: results,
  failed: failed.map((entry) => entry.name),
  notes,
  host: { platform: process.platform, node: process.version },
};

// Machine-readable evidence. This writes into the evidence directory, which is
// outside the state root and is not DSH_HOME.
const evidenceDir = 'D:\\DSH-testing\\docs\\remote-mobile\\_evidence';
fs.mkdirSync(evidenceDir, { recursive: true });
const evidencePath = path.join(evidenceDir, 'r5a-compliance.json');
fs.writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log('');
console.log(`real_state_root_exists: ${fs.existsSync(path.join(resolveDshHome(process.env), 'remote'))}`);
console.log(`encoding files scanned: ${results.find((entry) => entry.name === 'bom_zero')?.files ?? 0}`);
console.log(`evidence written: ${evidencePath}`);
console.log('');
console.log(failed.length === 0
  ? 'R5A COMPLIANCE CHECK: PASS'
  : `R5A COMPLIANCE CHECK: FAIL (${failed.map((entry) => entry.name).join(', ')})`);

process.exitCode = failed.length === 0 ? 0 : 1;
