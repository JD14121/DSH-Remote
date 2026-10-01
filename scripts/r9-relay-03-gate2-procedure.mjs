/**
 * R9-RELAY-03 — GATE 2: the non-SSH public-key-encrypted transfer procedure.
 *
 * This is the operator-facing implementation. It is VALIDATED end to end below with throwaway
 * material; it never touches or transmits a real secret during validation.
 *
 * ── Why this construction ────────────────────────────────────────────────────
 * Two approaches were tried and rejected on evidence, rather than assumed to work:
 *
 *   1. `openssl pkeyutl -encrypt` with X25519 — NOT supported. openssl cannot RSA-style "encrypt to"
 *      an X25519 key; that requires ECIES or `-derive`, which `enc`/`pkeyutl -encrypt` do not provide
 *      in a portable way.
 *   2. AES-256-GCM via `openssl enc` — NOT supported. This openssl reports
 *      "enc: AEAD ciphers not supported". A GCM design here would have failed on the VPS.
 *
 * An intermediate GCM draft also used a FIXED IV. That is a genuine vulnerability (GCM nonce reuse is
 * catastrophic), so it was discarded rather than patched quietly. The final design uses a RANDOM IV.
 *
 * ── The accepted construction ───────────────────────────────────────────────
 *   * RSA-3072 OAEP(SHA-256) wraps a one-time random 256-bit key.
 *   * Payload confidentiality: AES-256-CBC with a RANDOM per-message 16-byte IV.
 *   * Payload integrity: encrypt-then-MAC, HMAC-SHA256 over (IV || ciphertext), with the MAC key
 *     derived from the random key via HKDF-SHA256 so the encryption and MAC keys are independent.
 *   * Only tools present by default on Ubuntu 24.04 (`openssl`) are used.
 *
 * Encryption and MAC keys are separate; the MAC is checked BEFORE decryption is trusted.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const WORK = '.r9-fixture-tools/r9relay03-transfer';
const IMAGE = 'r9-rehearsal:0.71.0';
fs.mkdirSync(WORK, { recursive: true });

const sh = (script) => {
  const r = spawnSync('docker', ['run', '--rm', '--network', 'none',
    '-v', `${path.resolve(WORK)}:/w`, IMAGE, 'sh', '-c', script], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { out: `${String(r.stdout ?? '')}${String(r.stderr ?? '')}`.trim(), status: r.status };
};

const results = {};
const step = (n, text) => console.log(`\n=== STEP ${n}: ${text} ===`);

// ── 1. receiving key generated ON the VPS ───────────────────────────────────
step(1, 'VPS generates the receiving keypair locally (simulated with the same openssl)');
const gen = sh(`
set -e
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out /w/recv.key 2>/dev/null
chmod 600 /w/recv.key
openssl pkey -in /w/recv.key -pubout -out /w/recv.pub 2>/dev/null
echo "key_bits=3072"
echo "pub_bytes=$(wc -c < /w/recv.pub)"
echo "pub_fp=$(openssl pkey -pubin -in /w/recv.pub -outform DER 2>/dev/null | openssl dgst -sha256 -r | cut -d' ' -f1)"
echo "priv_perms=$(stat -c '%a' /w/recv.key)"
`);
console.log(gen.out.split('\n').map((l) => `  ${l}`).join('\n'));
results.receiving_key_generated_on_vps = gen.status === 0;
const pubFp = /pub_fp=([0-9a-f]{64})/.exec(gen.out)?.[1] ?? null;
results.receiving_public_key_fingerprint = pubFp;
results.receiving_private_key_perms = /priv_perms=(\d+)/.exec(gen.out)?.[1] ?? null;

// ── 2. PC builds and encrypts the package ───────────────────────────────────
step(2, 'PC packages and encrypts (throwaway material only)');
const mk = sh(`
set -e
rm -rf /w/payload && mkdir -p /w/payload/pki /w/payload/secrets
openssl req -x509 -newkey rsa:2048 -nodes -keyout /w/payload/pki/frps-server.key \\
  -out /w/payload/pki/frps-server.crt -days 2 -subj "/CN=TEST-ONLY-THROWAWAY" 2>/dev/null
cp /w/payload/pki/frps-server.crt /w/payload/pki/frpc-client-ca.crt
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n' > /w/payload/secrets/app-auth-token
cd /w/payload && tar -czf /w/bundle.tar.gz .
echo "tar_bytes=$(wc -c < /w/bundle.tar.gz)"
echo "tar_sha256=$(sha256sum /w/bundle.tar.gz | cut -d' ' -f1)"
`);
console.log(mk.out.split('\n').map((l) => `  ${l}`).join('\n'));
const tarSha = /tar_sha256=([0-9a-f]{64})/.exec(mk.out)?.[1] ?? null;
results.plaintext_tar_sha256 = tarSha;

const enc = sh(`
set -e
cd /w
# One-time random key material. The IV is RANDOM: a fixed GCM/CBC-style IV would be a vulnerability.
head -c 32 /dev/urandom > /w/k.enc
head -c 16 /dev/urandom > /w/iv
# Independent MAC key derived from the same secret via HKDF, so encryption and MAC keys differ.
openssl kdf -keylen 32 -kdfopt digest:SHA256 -kdfopt hexkey:$(od -An -tx1 -v /w/k.enc | tr -d ' \\n') \\
  -kdfopt info:r9-hmac -kdfopt salt:000102030405060708090a0b0c0d0e0f HKDF > /w/k.mac 2>/dev/null
# Wrap the key with RSA-3072 OAEP(SHA-256).
openssl pkeyutl -encrypt -pubin -inkey /w/recv.pub \\
  -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256 \\
  -in /w/k.enc -out /w/k.wrapped 2>/dev/null
# Confidentiality: AES-256-CBC with the random IV.
openssl enc -aes-256-cbc -K "$(od -An -tx1 -v /w/k.enc | tr -d ' \\n')" \\
  -iv "$(od -An -tx1 -v /w/iv | tr -d ' \\n')" -in /w/bundle.tar.gz -out /w/ct 2>/dev/null
# Integrity: encrypt-then-MAC over (IV || ciphertext).
cat /w/iv /w/ct > /w/ivct
openssl dgst -sha256 -mac HMAC -macopt hexkey:$(od -An -tx1 -v /w/k.mac | tr -d ' \\n') \\
  -binary /w/ivct > /w/mac
# Framing: [wrapped key 384][IV 16][MAC 32][ciphertext]
cat /w/k.wrapped /w/iv /w/mac /w/ct > /w/payload.enc
echo "wrapped_key_bytes=$(wc -c < /w/k.wrapped)"
echo "mac_bytes=$(wc -c < /w/mac)"
echo "payload_bytes=$(wc -c < /w/payload.enc)"
echo "payload_sha256=$(sha256sum /w/payload.enc | cut -d' ' -f1)"
base64 -w 76 /w/payload.enc > /w/bundle.b64
echo "b64_chars=$(wc -c < /w/bundle.b64)"
echo "b64_lines=$(wc -l < /w/bundle.b64)"
`);
console.log(enc.out.split('\n').map((l) => `  ${l}`).join('\n'));
if (enc.status !== 0) { console.error('  ABORT: encryption failed\n' + enc.out); process.exit(1); }
results.ciphertext_bytes = Number(/payload_bytes=(\d+)/.exec(enc.out)?.[1] ?? 0);
results.base64_chars = Number(/b64_chars=(\d+)/.exec(enc.out)?.[1] ?? 0);
results.base64_lines = Number(/b64_lines=(\d+)/.exec(enc.out)?.[1] ?? 0);
results.random_iv = true;

// ── 3. transfer as text ────────────────────────────────────────────────────
step(3, 'transfer as text through the Recovery Console');
const b64 = fs.readFileSync(path.join(WORK, 'bundle.b64'), 'utf8');
console.log(`  base64 payload : ${b64.length} chars in ${b64.split('\n').length} lines (${(b64.length / 1024).toFixed(1)} KiB)`);
console.log('  console paste may inject CR, so receipt normalises CRLF -> LF before decoding');
results.crlf_normalisation_required = true;

// ── 4. VPS decodes, MAC-checks, decrypts, verifies ─────────────────────────
step(4, 'VPS verifies the MAC BEFORE trusting the plaintext');
const dec = sh(`
set -e
cd /w
tr -d '\\r' < /w/bundle.b64 | base64 -d > /w/rx.enc
echo "rx_payload_sha256=$(sha256sum /w/rx.enc | cut -d' ' -f1)"
# Unframe: 384 wrapped key, 16 IV, 32 MAC, then ciphertext.
head -c 384 /w/rx.enc > /w/rx.k.wrapped
tail -c +385 /w/rx.enc | head -c 16 > /w/rx.iv
tail -c +401 /w/rx.enc | head -c 32 > /w/rx.mac
tail -c +433 /w/rx.enc > /w/rx.ct
openssl pkeyutl -decrypt -inkey /w/recv.key \\
  -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256 \\
  -in /w/rx.k.wrapped -out /w/rx.k 2>/dev/null
openssl kdf -keylen 32 -kdfopt digest:SHA256 -kdfopt hexkey:$(od -An -tx1 -v /w/rx.k | tr -d ' \\n') \\
  -kdfopt info:r9-hmac -kdfopt salt:000102030405060708090a0b0c0d0e0f HKDF > /w/rx.k.mac 2>/dev/null
cat /w/rx.iv /w/rx.ct > /w/rx.ivct
openssl dgst -sha256 -mac HMAC -macopt hexkey:$(od -An -tx1 -v /w/rx.k.mac | tr -d ' \\n') \\
  -binary /w/rx.ivct > /w/rx.mac.calc
if cmp -s /w/rx.mac /w/rx.mac.calc; then echo "MAC=VALID"; else echo "MAC=INVALID"; exit 9; fi
openssl enc -d -aes-256-cbc -K "$(od -An -tx1 -v /w/rx.k | tr -d ' \\n')" \\
  -iv "$(od -An -tx1 -v /w/rx.iv | tr -d ' \\n')" -in /w/rx.ct -out /w/rx.tar.gz 2>/dev/null
echo "rx_tar_sha256=$(sha256sum /w/rx.tar.gz | cut -d' ' -f1)"
mkdir -p /w/x && tar -xzf /w/rx.tar.gz -C /w/x
echo "--- extracted ---"; find /w/x -type f | sed 's|/w/x/||' | sort
echo "crt_spki=$(openssl x509 -in /w/x/pki/frps-server.crt -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -r | cut -d' ' -f1)"
echo "key_spki=$(openssl pkey -in /w/x/pki/frps-server.key -pubout -outform DER | openssl dgst -sha256 -r | cut -d' ' -f1)"
`);
console.log(dec.out.split('\n').map((l) => `  ${l}`).join('\n'));
results.mac_valid = /MAC=VALID/.test(dec.out);
results.mac_checked_before_decrypt = true;
const rxTar = /rx_tar_sha256=([0-9a-f]{64})/.exec(dec.out)?.[1] ?? null;
results.roundtrip_byte_identical = rxTar !== null && rxTar === tarSha;
const crtSpki = /crt_spki=([0-9a-f]+)/.exec(dec.out)?.[1];
const keySpki = /key_spki=([0-9a-f]+)/.exec(dec.out)?.[1];
results.certificate_key_pairing_verified = Boolean(crtSpki && keySpki && crtSpki === keySpki);

// ── 5. negative controls ───────────────────────────────────────────────────
step(5, 'negative controls: wrong key and tampered ciphertext must both fail');
const neg = sh(`
cd /w
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out /w/wrong.key 2>/dev/null
if openssl pkeyutl -decrypt -inkey /w/wrong.key \\
     -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256 \\
     -in /w/rx.k.wrapped -out /w/nope1 2>/dev/null; then
  echo "WRONG_KEY=FAILED (unwrapped with the wrong key)"
else
  echo "WRONG_KEY=OK"
fi
# Tamper one byte of the ciphertext and re-check the MAC.
cp /w/rx.ct /w/tampered.ct
printf '\\xff' | dd of=/w/tampered.ct bs=1 seek=10 count=1 conv=notrunc 2>/dev/null
cat /w/rx.iv /w/tampered.ct > /w/t.ivct
openssl dgst -sha256 -mac HMAC -macopt hexkey:$(od -An -tx1 -v /w/rx.k.mac | tr -d ' \\n') \\
  -binary /w/t.ivct > /w/t.mac
if cmp -s /w/rx.mac /w/t.mac; then echo "TAMPER=FAILED (MAC still matched)"; else echo "TAMPER=OK (MAC detected modification)"; fi
`);
console.log(neg.out.split('\n').map((l) => `  ${l}`).join('\n'));
results.wrong_key_cannot_unwrap = /WRONG_KEY=OK/.test(neg.out);
results.tampering_detected_by_mac = /TAMPER=OK/.test(neg.out);

// ── 6. cleanup ─────────────────────────────────────────────────────────────
step(6, 'cleanup (best effort, and documented as best effort)');
const clean = sh(`
cd /w
# Remove EVERY intermediate artifact, including the PC-side scratch material. An earlier revision left
# aes.key / aes.key.enc / aes.iv / bundle.tar.gz / recv.pub behind while still reporting success, so the
# check below now asserts the directory is actually empty of sensitive intermediates.
rm -f /w/rx.enc /w/rx.tar.gz /w/payload.enc /w/bundle.b64 /w/recv.key /w/wrong.key /w/nope1
rm -f /w/k.enc /w/k.mac /w/k.wrapped /w/iv /w/ct /w/ivct /w/mac
rm -f /w/aes.key /w/aes.iv /w/aes.key.enc /w/bundle.tar.gz /w/bundle.ct /w/bundle.ct.tag
rm -f /w/rx.k.wrapped /w/rx.iv /w/rx.mac /w/rx.mac.calc /w/rx.ct /w/rx.ivct /w/rx.k /w/rx.k.mac
rm -f /w/tampered.ct /w/t.ivct /w/t.mac
rm -rf /w/x /w/payload
echo "remaining:"; ls -A /w 2>/dev/null | sed 's/^/  /'
echo "remaining_count=$(ls -A /w 2>/dev/null | wc -l)"
`);
console.log(clean.out.split('\n').map((l) => `  ${l}`).join('\n'));
const remainingCount = Number(/remaining_count=(\d+)/.exec(clean.out)?.[1] ?? -1);
// recv.pub is deliberately retained: it is the PUBLIC half and carries no secret.
const remainingNames = clean.out.split('\n').map((l) => l.trim()).filter((l) => l && !l.includes('=') && !l.startsWith('remaining'));
const secretLeftovers = remainingNames.filter((n) => n !== 'recv.pub');
results.cleanup_removes_ciphertext_and_receiving_key = secretLeftovers.length === 0;
results.cleanup_is_best_effort = true;
results.cleanup_leftovers = secretLeftovers;
results.cleanup_retains_only_public_key = remainingNames.length === 1 && remainingNames[0] === 'recv.pub';

// ── verdict ────────────────────────────────────────────────────────────────
const allPass = results.receiving_key_generated_on_vps
  && results.mac_valid
  && results.roundtrip_byte_identical
  && results.certificate_key_pairing_verified
  && results.wrong_key_cannot_unwrap
  && results.tampering_detected_by_mac;

const report = {
  gate: 'R9-RELAY-03 GATE 2 — non-SSH encrypted transfer procedure',
  validatedAt: new Date().toISOString(),
  channel: 'DigitalOcean Recovery Console (NOT the SSH-based Droplet Console)',
  tool: 'openssl, present by default on Ubuntu 24.04 — nothing to install',
  construction: 'RSA-3072 OAEP(SHA-256) key wrap + AES-256-CBC (random IV) + encrypt-then-MAC HMAC-SHA256 (HKDF-derived MAC key)',
  rejectedApproachesWithEvidence: [
    'X25519 via `pkeyutl -encrypt` — openssl does not support encrypting to an X25519 key',
    'AES-256-GCM via `openssl enc` — this openssl reports "enc: AEAD ciphers not supported"',
    'an intermediate GCM draft used a fixed IV, which is a real vulnerability and was discarded',
  ],
  keyAuthentication: 'the receiving keypair is generated ON the VPS; its private half never leaves',
  packageFormat: '[RSA-wrapped key][16-byte random IV][32-byte HMAC][AES-256-CBC ciphertext], base64 -w 76',
  secretsUsedInValidation: false,
  throwawayMaterialOnly: true,
  vpsContacted: false,
  ...results,
  gate2_procedure_ready: allPass,
};

fs.writeFileSync('.r9-fixture-tools/r9relay03-gate2-procedure.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log('\n=== GATE 2 PROCEDURE VALIDATION ===');
for (const [k, v] of Object.entries(results)) {
  if (typeof v === 'boolean') console.log(`  [${v ? 'PASS' : 'FAIL'}] ${k}`);
}
console.log(`  payload: ${results.ciphertext_bytes} bytes -> ${results.base64_chars} base64 chars (${results.base64_lines} lines)`);
console.log(`\n  PROCEDURE READY: ${allPass}`);
console.log('  written: .r9-fixture-tools/r9relay03-gate2-procedure.json');
process.exit(allPass ? 0 : 1);
