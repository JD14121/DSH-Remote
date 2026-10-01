#!/usr/bin/env node
/**
 * R9-RELAY-03 GATE 2B-M1 — PC-local R2 presigned-GET feasibility tool.
 *
 * PURPOSE
 *   Produce ONE real presigned GET URL for a random NONEXISTENT object, so the operator can test
 *   whether a real ~400-character single-line URL survives the DigitalOcean Recovery Console.
 *
 * WHAT THIS DOES NOT DO
 *   * It never uploads. It never reads, writes, lists, or deletes any object.
 *   * It never contacts R2. Presigning is pure local computation (SigV4 needs no API call).
 *   * It never stores credentials in the repository.
 *   * It never prints the URL or any credential to stdout — only length, SHA-256 and expiry.
 *
 * CREDENTIAL HANDLING
 *   Credentials arrive one of three ways, never via argv:
 *     1. --creds-file <path>  PREFERRED on Windows. A short-lived UTF-8 JSON file whose path is passed
 *        as an argument (the PATH is not secret). The tool reads it and DELETES it immediately.
 *     2. --stdin              read JSON from stdin. Works from a shell with redirection, but was found
 *        NOT to work reliably when the parent is a .NET Process pipe on Windows PowerShell 5.1
 *        (fs.readFileSync(0) returned nothing), so it is not the recommended path there.
 *     3. environment          AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / R2_ACCOUNT_ID.
 *   They are NEVER accepted as command-line arguments, because argv is visible in process listings and
 *   shell history — the file PATH is passed, never the values.
 *
 * USAGE
 *   node r9-relay-03-m1-presign.mjs --creds-file <path>   -> recommended
 *   node r9-relay-03-m1-presign.mjs --stdin               -> read JSON from stdin
 *   node r9-relay-03-m1-presign.mjs --copy                -> also copy to the clipboard AND verify it
 *   node r9-relay-03-m1-presign.mjs --self-test           -> throwaway creds; no real credential
 *   node r9-relay-03-m1-presign.mjs --emit-url-to <path>  -> TEST-ONLY cross-implementation hook
 *
 * The URL is emitted ONLY to the clipboard (or, for testing, to an explicit file), never to stdout.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ARGV = process.argv.slice(2);
const ARGS = new Set(ARGV);
const COPY = ARGS.has('--copy');
const SELF_TEST = ARGS.has('--self-test');
const USE_STDIN = ARGS.has('--stdin');
// Test-only escape hatch, parsed explicitly so it cannot be confused with a credential argument.
const EMIT_INDEX = ARGV.indexOf('--emit-url-to');
const EMIT_PATH = EMIT_INDEX >= 0 ? ARGV[EMIT_INDEX + 1] : null;
const CREDS_INDEX = ARGV.indexOf('--creds-file');
const CREDS_FILE = CREDS_INDEX >= 0 ? ARGV[CREDS_INDEX + 1] : null;

// --emit-url-to exists ONLY so the cross-implementation test can verify the tool's real output. It must
// never be usable in an operator run: with a real credential it would write a LIVE presigned URL to
// disk. It is therefore gated on --self-test, and any other combination exits non-zero WITHOUT
// creating a file. The check happens before any credential is read, so no work is done first.
if (EMIT_PATH && !SELF_TEST) {
  console.error('  Refusing to run: --emit-url-to is restricted to --self-test (throwaway credentials).');
  console.error('  It exists only for the cross-implementation test and would otherwise write a live');
  console.error('  presigned URL to disk. No file has been created.');
  process.exit(2);
}

const BUCKET = 'r9-relay-gate2b-synthetic';
const REGION = 'auto';
const SERVICE = 's3';
const EXPIRES_SECONDS = 900; // 15 minutes, as specified

/** Read credentials from stdin (preferred) or the environment. Never from argv. */
function credentials() {
  if (SELF_TEST) {
    // Deliberately OBVIOUSLY-FAKE values. An earlier revision used examples that pattern-match a
    // secret scanner, which could alarm a reviewer even though they grant nothing. These cannot be
    // mistaken for real credentials and still exercise the full signing path.
    return {
      accessKeyId: 'R9-SELFTEST-NOT-A-REAL-ACCESS-KEY',
      secretAccessKey: 'r9-selftest-not-a-real-secret-access-key',
      accountId: '0123456789abcdef0123456789abcdef', // imaginary, correct length
      source: 'throwaway (self-test)',
    };
  }

  if (CREDS_FILE) {
    // PREFERRED on Windows. The path is passed as an argument; the values are not. The file is read
    // and then removed in a finally block, so it exists for milliseconds.
    let raw = null;
    let reason = null;
    try {
      raw = fs.readFileSync(CREDS_FILE, 'utf8');
    } catch (e) {
      reason = `could not read ${CREDS_FILE}: ${e.code}`;
    } finally {
      try { fs.rmSync(CREDS_FILE, { force: true }); } catch { /* already gone */ }
    }
    if (reason) { console.error(`  Refusing to run: ${reason}`); process.exit(2); }

    const problems = [];
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      problems.push('the credential file was not valid JSON');
    }
    const accessKeyId = parsed.accessKeyId;
    const secretAccessKey = parsed.secretAccessKey;
    const accountId = parsed.accountId;
    if (!accessKeyId) problems.push('accessKeyId');
    if (!secretAccessKey) problems.push('secretAccessKey');
    if (!accountId) problems.push('accountId');
    if (problems.length) {
      console.error('  Refusing to run: the credential file did not provide:');
      for (const m of problems) console.error(`    ${m}`);
      process.exit(2);
    }
    if (!/^[0-9a-f]{32}$/i.test(accountId)) {
      console.error('  Refusing to run: accountId must be 32 hexadecimal characters.');
      process.exit(2);
    }
    return {
      accessKeyId,
      secretAccessKey,
      accountId,
      source: 'short-lived credential file (deleted on read; no environment variable, no argv value)',
    };
  }

  if (USE_STDIN) {
    // Preferred path: the operator's PowerShell helper pipes a JSON object on stdin. Nothing touches an
    // environment variable and nothing is written to disk.
    //
    // BOM: .NET Framework's redirected StandardInput ALWAYS prepends a UTF-8 BOM. Measured on Windows
    // PowerShell 5.1: writing the plain ASCII text "HELLO" arrives at the child as 8 bytes with a
    // leading U+FEFF, unconditionally, regardless of the writer's encoding. That was the true cause of
    // an earlier "stdin was not valid JSON" failure. The fix is this one-line strip, NOT abandoning
    // stdin — credentials never needed to touch the filesystem.
    let raw = '';
    try {
      raw = fs.readFileSync(0, 'utf8');
    } catch {
      raw = '';
    }
    const hadBom = raw.charCodeAt(0) === 0xFEFF;
    if (hadBom) raw = raw.slice(1);

    const stdinMissing = [];
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      stdinMissing.push('stdin was not valid JSON');
    }
    const accessKeyId = parsed.accessKeyId;
    const secretAccessKey = parsed.secretAccessKey;
    const accountId = parsed.accountId;
    if (!accessKeyId) stdinMissing.push('accessKeyId');
    if (!secretAccessKey) stdinMissing.push('secretAccessKey');
    if (!accountId) stdinMissing.push('accountId');
    if (stdinMissing.length) {
      console.error('  Refusing to run: stdin did not provide:');
      for (const m of stdinMissing) console.error(`    ${m}`);
      process.exit(2);
    }
    if (!/^[0-9a-f]{32}$/i.test(accountId)) {
      console.error('  Refusing to run: accountId must be 32 hexadecimal characters.');
      process.exit(2);
    }
    return {
      accessKeyId,
      secretAccessKey,
      accountId,
      source: 'stdin (no environment variable, nothing written to disk'
        + (hadBom ? '; leading BOM stripped' : '') + ')',
    };
  }

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? process.env.R2_SECRET_ACCESS_KEY;
  const accountId = process.env.R2_ACCOUNT_ID;
  const missing = [];
  if (!accessKeyId) missing.push('AWS_ACCESS_KEY_ID');
  if (!secretAccessKey) missing.push('AWS_SECRET_ACCESS_KEY');
  if (!accountId) missing.push('R2_ACCOUNT_ID');
  if (missing.length) {
    console.error('  Refusing to run: missing environment variable(s):');
    for (const m of missing) console.error(`    ${m}`);
    console.error('');
    console.error('  Preferred: pipe credentials on stdin instead, so no environment variable is used:');
    console.error('    node scripts\\r9-relay-03-m1-presign.mjs --stdin');
    console.error('');
    console.error('  Or set them in YOUR PowerShell session (never read from argv):');
    console.error('    $env:AWS_ACCESS_KEY_ID     = "<access key id>"');
    console.error('    $env:AWS_SECRET_ACCESS_KEY = "<secret access key>"');
    console.error('    $env:R2_ACCOUNT_ID         = "<32-hex account id>"');
    process.exit(2);
  }
  if (!/^[0-9a-f]{32}$/i.test(accountId)) {
    console.error('  Refusing to run: R2_ACCOUNT_ID must be 32 hexadecimal characters.');
    process.exit(2);
  }
  return { accessKeyId, secretAccessKey, accountId, source: 'operator environment' };
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** AWS Signature Version 4 presigning for a single GET on a single object. */
function presignGet({ accessKeyId, secretAccessKey, accountId, key, now }) {
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

  const canonicalUri = `/${BUCKET}/${key}`;
  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';

  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(EXPIRES_SECONDS),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  const canonicalQuery = Object.keys(params).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');

  const canonicalRequest = [
    'GET', canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), REGION), SERVICE), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const url = `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  return { url, canonicalRequest, stringToSign, key, host, amzDate };
}

// ── main ────────────────────────────────────────────────────────────────────
const creds = credentials();

// A fresh random prefix and a random object name that does NOT exist and will NOT be created.
const prefix = `t-${crypto.randomBytes(16).toString('hex')}`;
const key = `${prefix}/m1-nonexistent-${crypto.randomBytes(8).toString('hex')}.probe`;

const now = new Date();
const { url } = presignGet({ ...creds, key, now });

// ── the only things ever displayed: THIS run's length, lines, hash and times ─
const urlSha = crypto.createHash('sha256').update(url, 'utf8').digest('hex');
const expiry = new Date(now.getTime() + EXPIRES_SECONDS * 1000);
const urlBytes = Buffer.byteLength(url, 'utf8');
const lineCount = url.split(/\r?\n/).length;

console.log('=== R9-RELAY-03 GATE 2B-M1 — presigned GET for M1 ===');
console.log(`  credential source : ${creds.source}`);
console.log(`  method            : GET (read only)`);
console.log(`  object exists     : NO (deliberate — M1 must not touch real data)`);
console.log(`  uploads performed : NONE`);
console.log('');
console.log('  URL is deliberately NOT printed. Use --copy to place it on the clipboard.');
console.log('');
console.log(`  URL byte length   : ${urlBytes}`);
console.log(`  URL line count    : ${lineCount} ${lineCount === 1 ? '(single line)' : '*** MULTI-LINE ***'}`);
console.log(`  URL SHA-256       : ${urlSha}`);
console.log(`  created (UTC)     : ${now.toISOString()}`);
console.log(`  expires (UTC)     : ${expiry.toISOString()}`);
console.log(`  validity          : ${EXPIRES_SECONDS} seconds (${EXPIRES_SECONDS / 60} minutes)`);
console.log('');

// Machine-readable metadata for the operator record. Contains NO URL and NO credential, and
// deliberately NO signature prefix — a signature prefix adds no verification value and is one more
// fragment of the live URL written to disk.
const meta = {
  phase: 'R9-RELAY-03 GATE 2B-M1',
  generatedAt: now.toISOString(),
  expiresAt: expiry.toISOString(),
  validitySeconds: EXPIRES_SECONDS,
  credentialSource: creds.source,
  method: 'GET',
  objectExists: false,
  uploadsPerformed: false,
  r2Contacted: false,
  urlByteLength: urlBytes,
  urlLineCount: lineCount,
  urlSha256: urlSha,
  fullUrlPrinted: false,
  credentialsPrinted: false,
  signaturePrefixPersisted: false,
};
// WHERE THE METADATA GOES: the system temporary directory, in `r9-m1-metadata`. Two earlier choices
// were both wrong: a repo-relative `.r9-fixture-tools/` path (left scratch files in the repository) and
// the operator's working directory (left them inside this delivery folder whenever the suites were run
// from it). A single fixed temp location is predictable, always writable, and never pollutes a folder
// that is meant to be handed over unchanged.
function writeMetadata() {
  const dir = path.join(os.tmpdir(), 'r9-m1-metadata');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `m1-${now.toISOString().replace(/[:.]/g, '-')}-${process.pid}.json`);
    fs.writeFileSync(p, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    return p;
  } catch {
    return null;
  }
}
const metaPath = writeMetadata();
console.log(metaPath
  ? `  metadata written  : ${metaPath}  (no URL, no credential, no signature fragment)`
  : '  metadata          : not written (no writable location); nothing sensitive was lost');

// ── clipboard, operator-initiated only, and VERIFIED ────────────────────────
if (COPY) {
  // The URL goes to the clipboard only. It is never echoed to stdout, so it cannot land in a log,
  // a transcript, or this conversation.
  const set = spawnSync('powershell.exe',
    ['-NoProfile', '-Command', 'Set-Clipboard -Value ([Console]::In.ReadToEnd())'],
    { input: url, encoding: 'utf8' });
  if (set.status !== 0) {
    console.error('  clipboard         : FAILED to copy. The URL was not displayed, so it is now unavailable.');
    console.error('                      Re-run with --copy to generate a fresh URL.');
    process.exit(1);
  }

  // Read the clipboard BACK and compare length and hash. Round-tripping exposed a real hazard:
  // Set-Clipboard appends a newline, so a naive comparison would fail — and, more importantly, a
  // clipboard that mangles the value would otherwise go unnoticed. The URL is still never printed.
  const get = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'],
    { encoding: 'utf8' });
  const clipRaw = get.stdout ?? '';
  // Normalise ONLY a single trailing newline, which Set-Clipboard adds.
  const clip = clipRaw.replace(/\r?\n$/, '');
  const clipBytes = Buffer.byteLength(clip, 'utf8');
  const clipSha = crypto.createHash('sha256').update(clip, 'utf8').digest('hex');
  const clipLines = clip.split(/\r?\n/).length;
  const roundTripOk = clipSha === urlSha && clipBytes === urlBytes && clipLines === 1;

  console.log(`  clipboard length  : ${clipBytes} bytes ${clipBytes === urlBytes ? '(matches)' : '(*** MISMATCH ***)'}`);
  console.log(`  clipboard lines   : ${clipLines}`);
  console.log(`  clipboard SHA-256 : ${clipSha}`);
  console.log(`  clipboard match   : ${roundTripOk ? 'YES — the clipboard holds the exact URL' : 'NO — DO NOT PASTE'}`);

  if (!roundTripOk) {
    console.error('');
    console.error('  *** Clipboard round-trip FAILED. The clipboard content does not match the generated');
    console.error('      URL. Do NOT paste it. Re-run to generate a fresh URL. ***');
    process.exit(1);
  }
  console.log('  clipboard         : verified. Paste it into the Recovery Console now.');
} else {
  console.log('  clipboard         : not copied (re-run with --copy when you are ready to paste)');
}

// ── test-only emission, for cross-implementation verification ───────────────
// A cross-implementation test is only meaningful if it verifies the URL this tool ACTUALLY produced.
// Rebuilding a fixture independently proves nothing about this tool's output. This path exists solely
// so the test harness can hand the real URL to an independent verifier. It is never printed.
if (EMIT_PATH) {
  fs.writeFileSync(EMIT_PATH, url, { encoding: 'utf8', mode: 0o600 });
  console.log(`  test emission     : URL written to ${EMIT_PATH} (test-only; delete after verifying)`);
}

if (lineCount !== 1) {
  console.error('');
  console.error('  *** The URL is NOT a single line. M1 cannot pass. STOP. ***');
  process.exit(1);
}
