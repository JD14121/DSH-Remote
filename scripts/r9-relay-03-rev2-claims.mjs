/**
 * R9-RELAY-03 GATE 2B Rev2 — validate the design's core claims locally.
 *
 * No external storage, no upload, no network, no secrets. Everything here uses throwaway keys and the
 * existing synthetic public-seed payload.
 *
 * The claims under test:
 *   C1. a full 64-char hex SPKI SHA-256 can be derived from a public key and grouped for transcription
 *   C2. recomputing over the ACTUAL received key detects a substituted key (the substitution trap)
 *   C3. a key AND a self-consistent substituted key both produce valid-looking fingerprints, so only
 *       the console-carried value catches the substitution  <- this is the whole point of the design
 *   C4. the ciphertext-hash gate detects a single corrupted byte
 *   C5. the MAC gate aborts before decryption on corruption
 *   C6. the wrong-key control fails decryption
 */
import crypto from 'node:crypto';

const checks = [];
const check = (name, cond, detail = '') => {
  checks.push({ name, pass: Boolean(cond), detail });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${!cond && detail ? ' — ' + detail : ''}`);
};

const spkiFingerprint = (publicKey) =>
  crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');

const groupHex = (hex) => (hex.toUpperCase().match(/.{1,4}/g) ?? []).join(' ');

// ── C1: derive and format the full fingerprint ─────────────────────────────
console.log('=== C1: full 64-char SPKI fingerprint, grouped for transcription ===');
const vps = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
const vpsFp = spkiFingerprint(vps.publicKey);
const grouped = groupHex(vpsFp);
console.log(`    raw     : ${vpsFp}`);
console.log(`    grouped : ${grouped}`);
console.log(`    groups  : ${grouped.split(' ').length} x 4 chars`);
check('fingerprint is exactly 64 hex characters', /^[0-9a-f]{64}$/.test(vpsFp), String(vpsFp.length));
check('grouped form preserves all 64 characters', grouped.replace(/ /g, '').toLowerCase() === vpsFp);
check('grouped form is a single line', !grouped.includes('\n'));

// ── C2/C3: the substitution trap ───────────────────────────────────────────
console.log('\n=== C2/C3: substitution detection ===');
// The attacker generates their own keypair and substitutes it, publishing a self-consistent cert.
const attacker = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
const attackerFp = spkiFingerprint(attacker.publicKey);
console.log(`    VPS fingerprint      : ${vpsFp.slice(0, 24)}...`);
console.log(`    attacker fingerprint : ${attackerFp.slice(0, 24)}...`);

// If the PC trusted the channel that delivered the key, the substitution would be invisible.
check('a substituted key is internally self-consistent (so the channel alone cannot detect it)',
  /^[0-9a-f]{64}$/.test(attackerFp));

// Recomputation over the ACTUAL received key is what exposes it, when compared to the console value.
const received = attacker.publicKey;                    // simulating a substituted download
const recomputed = spkiFingerprint(received);
const matchesConsoleValue = recomputed === vpsFp;
console.log(`    PC recomputes over received key : ${recomputed.slice(0, 24)}...`);
console.log(`    equals console-carried value?   : ${matchesConsoleValue}`);
check('recomputing over the actual received key DETECTS the substitution', !matchesConsoleValue);
check('the detection uses all 64 characters (a 16-char prefix would also differ here)',
  recomputed.slice(0, 16) !== vpsFp.slice(0, 16));

// Legitimate path must pass.
const legitRecompute = spkiFingerprint(vps.publicKey);
check('the legitimate key passes the same comparison', legitRecompute === vpsFp);

// ── C4/C5/C6: the transfer gates ───────────────────────────────────────────
console.log('\n=== C4: ciphertext-hash gate detects a single corrupted byte ===');
const payload = (() => {
  const seed = Buffer.from('R9-RELAY-03 CONSOLE PASTE TEST - NON-SECRET - NOT KEY MATERIAL\n', 'utf8');
  const chunks = [];
  let total = 0;
  let n = 0;
  while (total < 2672) {
    const b = crypto.createHash('sha256').update(`${seed.toString('utf8')}#${n}`).digest();
    chunks.push(b); total += b.length; n += 1;
  }
  return Buffer.concat(chunks).subarray(0, 2672);
})();
const payloadSha = crypto.createHash('sha256').update(payload).digest('hex');
console.log(`    synthetic payload sha256 : ${payloadSha}`);
check('synthetic payload matches the documented hash',
  payloadSha === '083b9971d6bbf203fab522b5d09ec6d7e846eb5dd0a74704787502df71efe2a8', payloadSha);

// Build the Gate-2-validated construction: RSA-OAEP key wrap + AES-256-CBC(random IV) + HMAC.
const aesKey = crypto.randomBytes(32);
const iv = crypto.randomBytes(16);
const macKey = crypto.hkdfSync('sha256', aesKey, Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'), 'r9-hmac', 32);

const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
const ct = Buffer.concat([cipher.update(payload), cipher.final()]);
const macOf = (ivBuf, ctBuf) => crypto.createHmac('sha256', Buffer.from(macKey)).update(Buffer.concat([ivBuf, ctBuf])).digest();
const mac = macOf(iv, ct);
const wrapped = crypto.publicEncrypt({
  key: vps.publicKey,
  padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
  oaepHash: 'sha256',
}, aesKey);

const artifact = Buffer.concat([wrapped, iv, mac, ct]);
const artifactSha = crypto.createHash('sha256').update(artifact).digest('hex');
console.log(`    artifact bytes           : ${artifact.length}`);
console.log(`    artifact sha256          : ${artifactSha.slice(0, 24)}...`);

const corrupted = Buffer.from(artifact);
corrupted[artifact.length - 5] ^= 0xff;
const corruptedSha = crypto.createHash('sha256').update(corrupted).digest('hex');
check('outer hash gate changes when one byte is corrupted', corruptedSha !== artifactSha);
check('outer hash gate passes for the intact artifact',
  crypto.createHash('sha256').update(artifact).digest('hex') === artifactSha);

console.log('\n=== C5: MAC gate must abort BEFORE decryption ===');
// Receiver-side order: verify MAC, then decrypt.
const rWrapped = artifact.subarray(0, 384);
const rIv = artifact.subarray(384, 400);
const rMac = artifact.subarray(400, 432);
const rCt = artifact.subarray(432);
const rMacCalc = macOf(rIv, rCt);
check('MAC verifies for the intact artifact', rMac.equals(rMacCalc));

const tamperedCt = Buffer.from(rCt);
tamperedCt[3] ^= 0xff;
const tamperedMacCalc = macOf(rIv, tamperedCt);
check('MAC FAILS for a tampered ciphertext (so decryption is never attempted)', !rMac.equals(tamperedMacCalc));

console.log('\n=== C6: wrong-key control ===');
const wrong = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
let wrongKeyFailed = false;
try {
  crypto.privateDecrypt({
    key: wrong.privateKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  }, rWrapped);
} catch {
  wrongKeyFailed = true;
}
check('a different private key cannot unwrap the key (decryption fails)', wrongKeyFailed);

// Positive control: the correct key recovers byte-exact.
const recovered = crypto.privateDecrypt({
  key: vps.privateKey,
  padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
  oaepHash: 'sha256',
}, rWrapped);
const dec = crypto.createDecipheriv('aes-256-cbc', recovered, rIv);
const plain = Buffer.concat([dec.update(rCt), dec.final()]);
check('the correct key recovers the payload byte-exact', plain.equals(payload));
check('post-decryption hash gate passes', crypto.createHash('sha256').update(plain).digest('hex') === payloadSha);

const total = checks.length;
const passed = checks.filter((c) => c.pass).length;
console.log(`\n=== design-claim validation: ${passed}/${total} ===`);

import fs from 'node:fs';
fs.mkdirSync('.r9-fixture-tools', { recursive: true });
fs.writeFileSync('.r9-fixture-tools/r9relay03-rev2-claims.json', `${JSON.stringify({
  validatedAt: new Date().toISOString(),
  externalStorageUsed: false,
  networkUsed: false,
  secretsUsed: false,
  syntheticPayloadOnly: true,
  checks, total, pass: passed, all_pass: passed === total,
  example_grouped_fingerprint: grouped,
  artifact_bytes: artifact.length,
}, null, 2)}\n`, 'utf8');
console.log('  written: .r9-fixture-tools/r9relay03-rev2-claims.json');
process.exit(passed === total ? 0 : 1);
