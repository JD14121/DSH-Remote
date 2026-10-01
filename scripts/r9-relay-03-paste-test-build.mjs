/**
 * R9-RELAY-03 — build the REALISTIC-SIZE Recovery Console paste test payload.
 *
 * The 37-byte probe proved the console preserves a few bytes. It does NOT prove a multi-kilobyte paste
 * survives, and a real secret bundle is ~2.7 KB -> ~3.6 KB of base64 in ~47 lines. Console paste can
 * fail specifically at that size: line wrapping, dropped or duplicated newlines, CR injection, or
 * truncation by a paste buffer limit.
 *
 * This generates a NON-SECRET payload of exactly the shape and size of a real bundle so the transfer
 * path is exercised end to end before any production secret is involved.
 *
 * The payload content is derived only from a public fixed string; it contains no key, token or credential.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const OUT = '.r9-fixture-tools/r9relay03-paste-test';
fs.mkdirSync(OUT, { recursive: true });

// ── 1. build a realistic-size binary blob (no secrets) ─────────────────────
// Target ~2.7 KB of payload, matching a real bundle's tar.gz size, so the base64 comes out ~3.6 KB.
const TARGET_BYTES = 2672;
const seed = Buffer.from('R9-RELAY-03 CONSOLE PASTE TEST - NON-SECRET - NOT KEY MATERIAL\n', 'utf8');
const chunks = [];
let total = 0;
let counter = 0;
while (total < TARGET_BYTES) {
  const block = crypto.createHash('sha256').update(`${seed.toString('utf8')}#${counter}`).digest();
  chunks.push(block);
  total += block.length;
  counter += 1;
}
const payload = Buffer.concat(chunks).subarray(0, TARGET_BYTES);

const payloadSha = crypto.createHash('sha256').update(payload).digest('hex');
fs.writeFileSync(path.join(OUT, 'payload.bin'), payload);

// ── 2. base64 at the SAME line width the real procedure uses ───────────────
const b64 = `${payload.toString('base64').replace(/(.{76})/g, '$1\n').replace(/\n$/, '')}\n`;
fs.writeFileSync(path.join(OUT, 'payload.b64'), b64, 'utf8');
const b64Bytes = Buffer.from(b64.replace(/\r?\n/g, ''), 'base64');

// Verify the wrap/unwrap round trip is byte-exact before shipping the test.
const roundTripOk = b64Bytes.length === payload.length && crypto.createHash('sha256').update(b64Bytes).digest('hex') === payloadSha;

const facts = {
  generatedAt: new Date().toISOString(),
  containsSecrets: false,
  payload_bytes: payload.length,
  payload_sha256: payloadSha,
  base64_chars: b64.length,
  base64_lines: b64.split('\n').filter((l) => l.length > 0).length,
  base64_line_width: 76,
  local_roundtrip_byte_exact: roundTripOk,
  real_bundle_reference: {
    note: 'a real Gate-4 bundle produced ~2.7 KB tar.gz -> ~3.6 KB base64 in ~47 lines, so this test matches it closely',
  },
};

fs.writeFileSync(path.join(OUT, 'EXPECTED.json'), `${JSON.stringify(facts, null, 2)}\n`, 'utf8');

// ── 3. the operator-facing VPS verification script ────────────────────────
const verifyScript = `#!/bin/sh
# R9-RELAY-03 — verify the realistic-size console paste test.
#
# The operator pastes the base64 blob into /tmp/paste.b64 on the VPS (using the Recovery Console), then
# runs this. It checks the payload hash, the line count, and that no CR was injected by the console.
set -u
EXPECTED_SHA="${payloadSha}"
EXPECTED_BYTES="${payload.length}"
EXPECTED_LINES="${facts.base64_lines}"

echo "=== console paste test ==="
if [ ! -s /tmp/paste.b64 ]; then echo "FAIL: /tmp/paste.b64 is empty or missing"; exit 1; fi

lines=$(grep -c . /tmp/paste.b64)
bytes=$(wc -c < /tmp/paste.b64)
cr=$(grep -c $'\\r' /tmp/paste.b64 2>/dev/null || echo 0)

echo "  lines pasted      : $lines (expected $EXPECTED_LINES)"
echo "  bytes pasted      : $bytes"
echo "  lines with CR     : $cr (expected 0)"

# Normalise CRLF the same way the real procedure does, then decode.
tr -d '\\r' < /tmp/paste.b64 | base64 -d > /tmp/paste.bin 2>/dev/null
rc=$?
if [ "$rc" -ne 0 ]; then echo "FAIL: base64 decode error"; exit 1; fi

got_bytes=$(wc -c < /tmp/paste.bin)
got_sha=$(sha256sum /tmp/paste.bin | cut -d' ' -f1)

echo "  decoded bytes     : $got_bytes (expected $EXPECTED_BYTES)"
echo "  decoded sha256    : $got_sha"
echo "  expected sha256   : $EXPECTED_SHA"

if [ "$lines" != "$EXPECTED_LINES" ]; then
  echo "RESULT: FAIL - paste was TRUNCATED or line endings changed (line count mismatch)"
  exit 1
fi
if [ "$got_bytes" != "$EXPECTED_BYTES" ] || [ "$got_sha" != "$EXPECTED_SHA" ]; then
  echo "RESULT: FAIL - payload corrupted in transit; DO NOT use this channel for secrets"
  exit 1
fi

echo "RESULT: PASS - multi-kilobyte paste survived byte-exact"
rm -f /tmp/paste.b64 /tmp/paste.bin
echo "cleaned up test files"
exit 0
`;
fs.writeFileSync(path.join(OUT, 'verify-paste.sh'), verifyScript, 'utf8');

console.log('=== realistic-size console paste test prepared ===');
console.log(`  payload           : ${payload.length} bytes`);
console.log(`  payload sha256    : ${payloadSha}`);
console.log(`  base64            : ${b64.length} chars in ${facts.base64_lines} lines (width 76)`);
console.log(`  local round trip  : ${roundTripOk ? 'byte-exact' : 'FAILED'}`);
console.log(`  contains secrets  : no`);
console.log(`\n  written to        : ${OUT}`);
console.log('    payload.b64     <- the blob the operator pastes');
console.log('    EXPECTED.json   <- expected hashes/counts');
console.log('    verify-paste.sh <- runs on the VPS after pasting');

process.exit(roundTripOk ? 0 : 1);
