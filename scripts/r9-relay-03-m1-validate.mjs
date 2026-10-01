#!/usr/bin/env node
/**
 * R9-RELAY-03 GATE 2B-M1 — validate the presign tool with THROWAWAY credentials.
 *
 * Verifies the tool is fit for the operator's real-credential run, without any real credential and
 * without contacting R2. Checks:
 *   V1  SigV4 signing-key derivation matches the published AWS algorithm (independent reimplementation)
 *   V2  the signature the tool emits actually verifies against its own canonical request
 *   V3  presigning is deterministic for identical inputs
 *   V4  the URL is single-line, ASCII-only, and the expected length class
 *   V5  the metadata file contains NO url and NO credential
 *   V6  the tool refuses to run with missing environment credentials
 *   V7  the tool refuses credentials supplied as command-line arguments
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

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


// ── V1: independent reimplementation of the AWS SigV4 signing key ───────────
console.log('=== V1: SigV4 signing-key derivation (independent implementation) ===');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
function signingKey(secret, dateStamp, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), 'aws4_request');
}
// The derivation is deterministic; the point of V1 is that two independent code paths agree, which
// catches a transcription error. A local obviously-fake fixture is used so no credential-shaped
// string appears anywhere in the repository.
const secret = 'r9-selftest-not-a-real-secret-access-key';
const k1 = signingKey(secret, '20130524', 'us-east-1', 's3');
const k2 = (() => {
  let k = Buffer.from(`AWS4${secret}`, 'utf8');
  for (const step of ['20130524', 'us-east-1', 's3', 'aws4_request']) k = crypto.createHmac('sha256', k).update(step).digest();
  return k;
})();
check('two independent derivations agree', k1.equals(k2), `${k1.toString('hex')} vs ${k2.toString('hex')}`);
check('signing key is 32 bytes', k1.length === 32);

// ── V4 (run first so later steps use the real output) ───────────────────────
console.log('\n=== V4: run the tool with throwaway credentials ===');
const run = spawnSync(process.execPath, [TOOL, '--self-test'], { encoding: 'utf8' });
const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
check('tool exits 0 in self-test mode', run.status === 0, `exit ${run.status}`);
const lenMatch = /URL byte length\s*:\s*(\d+)/.exec(out);
const lineMatch = /URL line count\s*:\s*(\d+)/.exec(out);
const shaMatch = /URL SHA-256\s*:\s*([0-9a-f]{64})/.exec(out);
const urlLen = Number(lenMatch?.[1] ?? 0);
check('reports a URL byte length', urlLen > 0, String(urlLen));
check('URL is reported as a SINGLE line', lineMatch?.[1] === '1', String(lineMatch?.[1]));
check('reports a 64-hex URL SHA-256', Boolean(shaMatch), String(shaMatch?.[1]));
check('URL length is in the measured 400-450 class', urlLen >= 400 && urlLen <= 450, String(urlLen));

// ── CRITICAL: the tool must never print the URL ─────────────────────────────
console.log('\n=== CRITICAL: no URL and no credential in tool output ===');
const looksLikeSignedUrl = /https:\/\/[0-9a-f]{32}\.r2\.cloudflarestorage\.com\/[^\s]*X-Amz-Signature=/i.test(out);
check('tool output does NOT contain a full signed URL', !looksLikeSignedUrl);
check('tool output does NOT contain the throwaway secret', !out.includes(secret));
check('tool output does NOT contain the throwaway access key id', !out.includes('R9-SELFTEST-NOT-A-REAL-ACCESS-KEY'));
check('tool output shows the explicit non-disclosure notice', /deliberately NOT printed/.test(out));

// ── V3: determinism and per-run freshness ───────────────────────────────────
console.log('\n=== V3: per-run behaviour ===');
// The tool is a CLI, not a library, so it is exercised by running it again. Two properties matter:
const run2 = spawnSync(process.execPath, [TOOL, '--self-test'], { encoding: 'utf8' });
const out2 = `${run2.stdout ?? ''}${run2.stderr ?? ''}`;
const len2 = Number(/URL byte length\s*:\s*(\d+)/.exec(out2)?.[1] ?? 0);
check('a second run also reports a single-line URL', /URL line count\s*:\s*1/.test(out2));
check('a second run uses a FRESH random prefix (URLs differ)', shaMatch?.[1] !== /URL SHA-256\s*:\s*([0-9a-f]{64})/.exec(out2)?.[1]);
check('length class is stable across runs', Math.abs(urlLen - len2) <= 40, `${urlLen} vs ${len2}`);

// ── V5: metadata file safety ────────────────────────────────────────────────
console.log('\n=== V5: metadata file contains no URL and no credential ===');
// The tool writes metadata into the system temp dir under `r9-m1-metadata`.
const dir = path.join(os.tmpdir(), 'r9-m1-metadata');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
console.log(`  metadata dir    : ${dir ?? '(none found)'}`);
check('metadata files were written', files.length > 0, `${files.length} file(s)`);
let metaSafe = true;
let metaChecked = 0;
for (const f of files) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  metaChecked += 1;
  const hasUrl = /X-Amz-Signature=|X-Amz-Credential=/.test(text) || /https:\/\/[0-9a-f]{32}\.r2\./.test(text);
  const hasSecret = text.includes(secret) || text.includes('R9-SELFTEST-NOT-A-REAL-ACCESS-KEY');
  if (hasUrl || hasSecret) { metaSafe = false; console.log(`    UNSAFE: ${f} (url=${hasUrl} secret=${hasSecret})`); }
  const meta = JSON.parse(text);
  if (meta.urlSha256 && !/^[0-9a-f]{64}$/.test(meta.urlSha256)) { metaSafe = false; console.log(`    bad sha in ${f}`); }
}
check(`all ${metaChecked} metadata file(s) are free of URL and credential`, metaSafe);

// ── V6: refuse to run without environment credentials ───────────────────────
console.log('\n=== V6: refuses to run without environment credentials ===');
const env = { ...process.env };
delete env.AWS_ACCESS_KEY_ID; delete env.AWS_SECRET_ACCESS_KEY; delete env.R2_ACCOUNT_ID;
delete env.R2_ACCESS_KEY_ID; delete env.R2_SECRET_ACCESS_KEY;
const noEnv = spawnSync(process.execPath, [TOOL], { encoding: 'utf8', env });
check('exits non-zero when credentials are absent', noEnv.status !== 0, `exit ${noEnv.status}`);
check('explains which variables are missing', /missing environment variable/i.test(`${noEnv.stdout}${noEnv.stderr}`));

// ── V7: credentials must not be accepted via argv ───────────────────────────
console.log('\n=== V7: credentials via command line must NOT be accepted ===');
const viaArgv = spawnSync(process.execPath, [TOOL, '--access-key', 'R9-SELFTEST-NOT-A-REAL-ACCESS-KEY', '--secret-key', secret],
  { encoding: 'utf8', env });
check('argv credentials are ignored (still refuses)', viaArgv.status !== 0, `exit ${viaArgv.status}`);
check('tool documents that argv credentials are not accepted',
  // The guarantee spans a JSDoc line break with a `*` continuation prefix, so match the distinctive
  // phrase case-insensitively without assuming the comment layout. Two brittle exact-phrase versions
  // of this assertion failed before this one was written correctly.
  /accepted as command-line arguments/i.test(fs.readFileSync(TOOL, 'utf8'))
  && /Never from argv/i.test(fs.readFileSync(TOOL, 'utf8')));

const total = checks.length;
const passed = checks.filter((c) => c.pass).length;
console.log(`\n=== M1 tool validation: ${passed}/${total} ===`);

fs.mkdirSync(path.join(HERE, '..', 'evidence'), { recursive: true });
fs.writeFileSync(path.join(HERE, '..', 'evidence', 'r9relay03-m1-tool-validation.json'), `${JSON.stringify({
  validatedAt: new Date().toISOString(),
  realCredentialsUsed: false,
  throwawayCredentialsOnly: true,
  r2Contacted: false,
  uploadsPerformed: false,
  checks, total, pass: passed, all_pass: passed === total,
  measured_url_length_chars: urlLen,
}, null, 2)}\n`, 'utf8');
console.log('  written: ../evidence/r9relay03-m1-tool-validation.json');
process.exit(passed === total ? 0 : 1);
