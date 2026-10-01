/**
 * R9-RELAY-03 GATE 2B-M1 — INDEPENDENT SigV4 verification of a presigned URL.
 *
 * WHY THIS EXISTS
 *   The presign tool computing a signature and then agreeing with itself proves nothing. This module is
 *   a SECOND, INDEPENDENT implementation written from the SigV4 definition: it parses a URL's
 *   components, rebuilds the canonical request itself, and recomputes the signature, comparing the
 *   result to the one embedded in the URL.
 *
 *   The two implementations share no code. Where they agree on generated URLs, the presigning logic is
 *   corroborated rather than self-confirmed.
 *
 * WHAT THIS DOES NOT PROVE
 *   Agreement proves both implementations follow the SAME algorithm. It does not prove the algorithm
 *   matches R2's server-side expectations — only a real request does that (M1's probe, run by the
 *   operator with their own credential). This limitation is stated rather than glossed over.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import { fileURLToPath } from 'node:url';

// Resolve the presign tool relative to THIS file, so the folder works wherever it is placed and
// from any working directory. Hard-coded repo-relative paths broke as soon as it was moved.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, 'r9-relay-03-m1-presign.mjs');

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/**
 * Independently verify a presigned URL's signature. Written from the SigV4 spec, not copied from the
 * presign tool.
 */
export function verifyPresignedUrl(url, secretAccessKey) {
  const u = new URL(url);

  // The signature comes from the query string; everything else is reconstructed from scratch.
  const providedSignature = u.searchParams.get('X-Amz-Signature');
  if (!providedSignature) return { ok: false, reason: 'no X-Amz-Signature in the URL' };

  const algorithm = u.searchParams.get('X-Amz-Algorithm');
  const credential = u.searchParams.get('X-Amz-Credential');
  const amzDate = u.searchParams.get('X-Amz-Date');
  const expires = u.searchParams.get('X-Amz-Expires');
  const signedHeaders = u.searchParams.get('X-Amz-SignedHeaders');
  if (!algorithm || !credential || !amzDate || !expires || !signedHeaders) {
    return { ok: false, reason: 'missing a required SigV4 query parameter' };
  }

  // Credential looks like: <accessKeyId>/<date>/<region>/<service>/aws4_request
  const parts = credential.split('/');
  if (parts.length !== 5) return { ok: false, reason: 'malformed X-Amz-Credential' };
  const [, dateStamp, region, service] = parts;

  // Canonical query string: all params EXCEPT the signature, sorted, percent-encoded.
  const canonicalPairs = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (k === 'X-Amz-Signature') continue;
    canonicalPairs.push([encodeURIComponent(k), encodeURIComponent(v)]);
  }
  canonicalPairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalQuery = canonicalPairs.map(([k, v]) => `${k}=${v}`).join('&');

  // Canonical headers: only the ones declared in X-Amz-SignedHeaders.
  const declared = signedHeaders.split(';');
  const headerValues = { host: u.host };
  const canonicalHeaders = declared.map((h) => `${h}:${headerValues[h] ?? ''}\n`).join('');

  const canonicalRequest = [
    'GET',
    u.pathname,               // already percent-encoded as sent
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
  const expected = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    ok: expected === providedSignature,
    expected,
    provided: providedSignature,
    canonicalRequest,
    stringToSign,
  };
}

// ── test ────────────────────────────────────────────────────────────────────
// Windows path comparison via URL objects. A naive string compare silently did nothing and the file
// produced no output, which is exactly the kind of failure that should be caught rather than shipped.
const invokedDirectly = process.argv[1]
  && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;

if (invokedDirectly) {
  const checks = [];
  const check = (name, cond, detail = '') => {
    checks.push({ name, pass: Boolean(cond), detail });
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${!cond && detail ? ' — ' + detail : ''}`);
  };

  
  // A fixed throwaway secret so the test is reproducible and involves no real credential.
  const FAKE_SECRET = 'r9-selftest-not-a-real-secret-access-key';
  const FAKE_KEY = 'R9-SELFTEST-NOT-A-REAL-ACCESS-KEY';
  const ACCOUNT = '0123456789abcdef0123456789abcdef';

  // ── CROSS-IMPLEMENTATION TEST (the one that actually matters) ────────────
  // An earlier revision of this file built its own fixture and verified that. That proved only that
  // THIS module agrees with itself — it said nothing about the presign tool's real output, and the
  // report overstated it. The test now takes the URL the TOOL actually produced and verifies it here.
  console.log('=== CROSS-IMPLEMENTATION: verify the URL the presign tool ACTUALLY produced ===');
  // The emitted URL is a TRANSIENT test artifact, so it goes to the system temp dir -- not into the
  // evidence folder, and not next to the script. A blanket path edit had previously sent both this
  // transient file and the results file to the same wrong location; they are kept separate now.
  const emitPath = path.join(os.tmpdir(), `r9-crossimpl-${process.pid}.tmp`);
  fs.mkdirSync(path.join(HERE, '..', 'evidence'), { recursive: true });
  // --emit-url-to is now restricted to --self-test, so the cross-implementation test drives the tool
  // in self-test mode. That is sufficient: the point is to verify the TOOL'S OWN SIGNING OUTPUT with a
  // second implementation, and self-test exercises the identical signing path.
  const run = spawnSync(process.execPath, [TOOL, '--self-test', '--emit-url-to', emitPath],
    { encoding: 'utf8' });
  check('presign tool ran', run.status === 0, `exit ${run.status}`);
  check('presign tool did NOT print the URL to stdout', !/X-Amz-Signature=[0-9a-f]{64}/.test(run.stdout));
  check('presign tool emitted a URL for cross-verification', fs.existsSync(emitPath));

  let toolUrl = null;
  if (fs.existsSync(emitPath)) {
    toolUrl = fs.readFileSync(emitPath, 'utf8');
    const cross = verifyPresignedUrl(toolUrl, FAKE_SECRET);
    check('INDEPENDENT VERIFIER ACCEPTS THE TOOL\'S REAL URL', cross.ok === true,
      cross.ok ? '' : `expected ${cross.expected?.slice(0, 16)}… got ${cross.provided?.slice(0, 16)}…`);

    // Negative control ON THE TOOL'S OWN OUTPUT, not on a self-built fixture.
    const wrongSecretOnToolUrl = verifyPresignedUrl(toolUrl, 'a-different-secret');
    check('independent verifier REJECTS the tool\'s URL under a wrong secret', wrongSecretOnToolUrl.ok === false);

    const tamperedToolUrl = toolUrl.replace(/X-Amz-Expires=900/, 'X-Amz-Expires=901');
    check('independent verifier REJECTS the tool\'s URL when a signed parameter is altered',
      verifyPresignedUrl(tamperedToolUrl, FAKE_SECRET).ok === false);

    // Clean up immediately: a live URL must not linger on disk.
    fs.rmSync(emitPath, { force: true });
    check('test-emitted URL file deleted after verification', !fs.existsSync(emitPath));
  } else {
    check('INDEPENDENT VERIFIER ACCEPTS THE TOOL\'S REAL URL', false, 'no URL emitted to verify');
  }

  // ── Self-consistency checks, clearly labelled as NOT cross-implementation ─
  console.log('\n=== self-consistency only (NOT cross-implementation) ===');
  console.log('  The following verify this module against a fixture it builds itself. They are reported');
  console.log('  separately because they cannot corroborate the presign tool.');

  // Reconstruct the same URL by calling the tool's logic is not possible without exporting it, so the
  // independent check runs against a locally built URL using THIS module's own signing path, plus a
  // frozen fixture. Both directions are exercised below.

  // Fixture: build a URL here, independently of the tool, and confirm the verifier accepts it.
  function buildUrl({ secret, accessKey, account, key, date }) {
    const host = `${account}.r2.cloudflarestorage.com`;
    const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const params = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${accessKey}/${dateStamp}/auto/s3/aws4_request`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': '900',
      'X-Amz-SignedHeaders': 'host',
    };
    const canonicalQuery = Object.keys(params).sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
    const canonicalRequest = ['GET', `/${'r9-relay-gate2b-synthetic'}/${key}`, canonicalQuery,
      `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const scope = `${dateStamp}/auto/s3/aws4_request`;
    const sts = ['AWS4-HMAC-SHA256', amzDate, scope,
      crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), 'auto'), 's3'), 'aws4_request');
    const sig = crypto.createHmac('sha256', kSigning).update(sts).digest('hex');
    return `https://${host}/r9-relay-gate2b-synthetic/${key}?${canonicalQuery}&X-Amz-Signature=${sig}`;
  }

  const fixture = buildUrl({
    secret: FAKE_SECRET, accessKey: FAKE_KEY, account: ACCOUNT,
    key: 't-0123456789abcdef0123456789abcdef/probe.pem', date: new Date('2026-09-23T12:00:00Z'),
  });

  console.log('\n=== independent verification of a locally built fixture ===');
  const good = verifyPresignedUrl(fixture, FAKE_SECRET);
  check('the verifier ACCEPTS a correctly signed URL', good.ok === true, JSON.stringify(good).slice(0, 200));

  console.log('\n=== negative controls ===');
  const wrongSecret = verifyPresignedUrl(fixture, 'a-different-secret-entirely');
  check('REJECTS the URL when the secret is wrong', wrongSecret.ok === false);

  const tampered = fixture.replace(/X-Amz-Expires=900/, 'X-Amz-Expires=901');
  const tamperedResult = verifyPresignedUrl(tampered, FAKE_SECRET);
  check('REJECTS the URL when a SIGNED parameter is tampered', tamperedResult.ok === false,
    'changing X-Amz-Expires alters the canonical query');

  const tamperedSig = fixture.replace(/X-Amz-Signature=[0-9a-f]{64}/, `X-Amz-Signature=${'0'.repeat(64)}`);
  check('REJECTS a URL with a substituted signature', verifyPresignedUrl(tamperedSig, FAKE_SECRET).ok === false);

  const noSig = fixture.replace(/&X-Amz-Signature=[0-9a-f]{64}/, '');
  check('REJECTS a URL with no signature', verifyPresignedUrl(noSig, FAKE_SECRET).ok === false);

  const missingParam = fixture.replace(/&X-Amz-Expires=900/, '');
  check('REJECTS a URL missing a required parameter', verifyPresignedUrl(missingParam, FAKE_SECRET).ok === false);

  const total = checks.length;
  const passed = checks.filter((c) => c.pass).length;
  console.log(`\n=== independent signature verification: ${passed}/${total} ===`);
  console.log('');
  console.log('  LIMITATION, stated deliberately: agreement between two implementations proves they');
  console.log('  follow the SAME algorithm. It does NOT prove R2 will accept the signature. Only the');
  console.log('  operator\'s real M1 probe can establish that.');

  fs.mkdirSync(path.join(HERE, '..', 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(HERE, '..', 'evidence', 'r9relay03-m1-signature-verification.json'), `${JSON.stringify({
    validatedAt: new Date().toISOString(),
    realCredentialsUsed: false,
    r2Contacted: false,
    fixturesAreSynthetic: true,
    checks, total, pass: passed, all_pass: passed === total,
    limitation: 'agreement proves a shared algorithm, not R2 acceptance; only a real request proves that',
  }, null, 2)}\n`, 'utf8');
  console.log('  written: .r9-fixture-tools/r9relay03-m1-signature-verification.json');
  process.exit(passed === total ? 0 : 1);
}
