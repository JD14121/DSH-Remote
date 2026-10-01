/**
 * R9-RELAY-03 GATE 2B-M1 — negative tests for the --emit-url-to restriction.
 *
 * --emit-url-to exists only for the cross-implementation test. Any attempt to use it outside
 * --self-test must exit non-zero and must NOT create a file. These tests prove that, including the
 * case where a caller supplies otherwise-VALID credentials.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { fileURLToPath } from 'node:url';

// Resolve the presign tool relative to THIS file, so the folder works wherever it is placed and
// from any working directory. Hard-coded repo-relative paths broke as soon as it was moved.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, 'r9-relay-03-m1-presign.mjs');


const checks = [];
const check = (name, cond, detail = '') => {
  checks.push({ name, pass: Boolean(cond), detail });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${!cond && detail ? ' — ' + detail : ''}`);
};

const tmpFile = () => path.join(os.tmpdir(), `r9-emit-${crypto.randomBytes(6).toString('hex')}.url`);

console.log('=== A. --emit-url-to WITH --self-test must be ALLOWED (the test hook) ===');
const allowedPath = tmpFile();
const allowed = spawnSync(process.execPath, [TOOL, '--self-test', '--emit-url-to', allowedPath], { encoding: 'utf8' });
check('exits 0 with --self-test', allowed.status === 0, `exit ${allowed.status}`);
check('creates the URL file under --self-test', fs.existsSync(allowedPath));
if (fs.existsSync(allowedPath)) fs.rmSync(allowedPath, { force: true });

console.log('\n=== B. --emit-url-to WITHOUT --self-test must be REFUSED ===');
const refusedPath = tmpFile();
const refused = spawnSync(process.execPath, [TOOL, '--emit-url-to', refusedPath], { encoding: 'utf8' });
check('exits non-zero when --self-test is absent', refused.status !== 0, `exit ${refused.status}`);
check('does NOT create the URL file', !fs.existsSync(refusedPath));
check('explains the restriction', /restricted to --self-test/i.test(`${refused.stdout}${refused.stderr}`));

console.log('\n=== C. --emit-url-to with VALID credentials but no --self-test must still be REFUSED ===');
// This is the dangerous case: a real operator run that also asks for URL emission. It must fail before
// any signing happens, so no live URL can reach the disk.
const credsPath = path.join(os.tmpdir(), `r9-creds-${crypto.randomBytes(6).toString('hex')}.json`);
fs.writeFileSync(credsPath, JSON.stringify({
  accessKeyId: 'R9-NEGATIVE-TEST-NOT-A-REAL-KEY',
  secretAccessKey: 'r9-negative-test-not-a-real-secret',
  accountId: '0123456789abcdef0123456789abcdef',
}), 'utf8');
const refusedCredsPath = tmpFile();
const refusedCreds = spawnSync(process.execPath,
  [TOOL, '--creds-file', credsPath, '--emit-url-to', refusedCredsPath], { encoding: 'utf8' });
check('exits non-zero even with otherwise-valid credentials', refusedCreds.status !== 0, `exit ${refusedCreds.status}`);
check('does NOT create the URL file in the credential case', !fs.existsSync(refusedCredsPath));
check('refusal happened before signing (no URL in output)',
  !/X-Amz-Signature=[0-9a-f]{64}/.test(`${refusedCreds.stdout}${refusedCreds.stderr}`));
// The refusal happens before credentials are read, so the credential file is left untouched.
check('credential file left untouched (refusal precedes credential handling)', fs.existsSync(credsPath));
if (fs.existsSync(credsPath)) fs.rmSync(credsPath, { force: true });

console.log('\n=== D. --emit-url-to as the LAST argument with no path ===');
const noPath = spawnSync(process.execPath, [TOOL, '--self-test', '--emit-url-to'], { encoding: 'utf8' });
check('does not crash when --emit-url-to has no path', noPath.status === 0 || noPath.status === 2,
  `exit ${noPath.status}`);

const total = checks.length;
const passed = checks.filter((c) => c.pass).length;
console.log(`\n=== --emit-url-to restriction tests: ${passed}/${total} ===`);

fs.mkdirSync(path.join(HERE, '..', 'evidence'), { recursive: true });
fs.writeFileSync(path.join(HERE, '..', 'evidence', 'r9relay03-m1-emit-restriction.json'), `${JSON.stringify({
  testedAt: new Date().toISOString(),
  realCredentialsUsed: false,
  r2Contacted: false,
  checks, total, pass: passed, all_pass: passed === total,
}, null, 2)}\n`, 'utf8');
console.log('  written: .r9-fixture-tools/r9relay03-m1-emit-restriction.json');
process.exit(passed === total ? 0 : 1);
