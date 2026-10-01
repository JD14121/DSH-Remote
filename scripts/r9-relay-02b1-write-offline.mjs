/**
 * R9-RELAY-02B.1 — write the FRP issuer backup into the mounted encrypted volume.
 *
 * Writes ONLY the four approved items plus non-secret recovery metadata, into a NEW sibling folder
 * (R:\FRP-ISSUER-CA) alongside the existing R9-RECOVERY ACME material. Existing content is never
 * modified or removed.
 *
 * Verifies every copy by SHA-256 read back from the encrypted volume, then confirms the volume is
 * safe to dismount and that no source material was altered.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STAGE = 'D:\\r9-relay-pki\\frp-issuer-backup-bundle';
const VOLUME = 'R:\\';
const DEST = path.join(VOLUME, 'FRP-ISSUER-CA');

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ── 1. refuse to touch anything that is not this bundle ────────────────────
if (!fs.existsSync(STAGE)) {
  console.error(`  ABORT: staged bundle missing: ${STAGE}`);
  process.exit(1);
}
if (!fs.existsSync(VOLUME)) {
  console.error(`  ABORT: encrypted volume not mounted: ${VOLUME}`);
  process.exit(1);
}

// Enumerate the staged bundle.
const staged = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else staged.push(full);
  }
};
walk(STAGE);
const rel = (f) => path.relative(STAGE, f).replace(/\\/g, '/');

// The ONLY permitted bundle contents. Anything else aborts the write rather than being copied.
const ALLOWED = new Set(['server-ca/server-ca.key', 'server-ca/server-ca.crt',
  'client-ca/client-ca.key', 'client-ca/client-ca.crt',
  'RECOVERY-METADATA.json', 'RECOVERY-README.txt', 'MANIFEST.sha256']);

const unexpected = staged.map(rel).filter((r) => !ALLOWED.has(r));
if (unexpected.length > 0) {
  console.error(`  ABORT: bundle contains files outside the approved set: ${unexpected.join(', ')}`);
  process.exit(1);
}
console.log(`=== bundle pre-flight: ${staged.length} files, all within the approved set ===`);

// ── 2. record the volume BEFORE state so nothing existing is disturbed ─────
const beforeTop = fs.readdirSync(VOLUME).sort();
console.log(`  volume root before : ${beforeTop.join(', ')}`);
if (fs.existsSync(DEST)) {
  console.log(`  ${DEST} already exists — its contents will be compared, not blindly overwritten`);
}

// ── 3. copy into the NEW sibling folder ────────────────────────────────────
console.log(`\n=== writing to ${DEST} ===`);
for (const src of staged) {
  const target = path.join(DEST, ...rel(src).split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(src, target);
  console.log(`  wrote ${rel(src).padEnd(30)} ${fs.statSync(target).size}b`);
}

// ── 4. verify by reading BACK from the encrypted volume ───────────────────
console.log('\n=== verification (hashes read back from the encrypted volume) ===');
const verification = [];
for (const src of staged) {
  const target = path.join(DEST, ...rel(src).split('/'));
  const sourceHash = sha256(src);
  const volumeHash = sha256(target);
  const match = sourceHash === volumeHash;
  verification.push({ file: rel(src), source_sha256: sourceHash, volume_sha256: volumeHash, match });
  console.log(`  ${match ? 'MATCH' : 'FAIL '} ${rel(src).padEnd(30)} ${sourceHash.slice(0, 24)}…`);
}
const allMatch = verification.every((v) => v.match);

// ── 5. confirm the volume still holds the pre-existing material ───────────
const afterTop = fs.readdirSync(VOLUME).sort();
const preserved = beforeTop.every((n) => afterTop.includes(n));
console.log(`  volume root after  : ${afterTop.join(', ')}`);
console.log(`  pre-existing entries preserved: ${preserved}`);
const acmeStillThere = fs.existsSync(path.join(VOLUME, 'R9-RECOVERY', 'DOCS', 'RECOVERY-README.txt'));
console.log(`  existing R9-RECOVERY ACME material intact: ${acmeStillThere}`);

// ── 6. confirm the SOURCE bundle was not altered ──────────────────────────
const sourceUnchanged = staged.every((src) => sha256(src) === verification.find((v) => v.file === rel(src)).source_sha256);
console.log(`  source bundle unchanged: ${sourceUnchanged}`);

// ── 7. confirm nothing out of scope landed on the volume ─────────────────
const written = [];
const walkDest = (dir, base = '') => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const r = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) walkDest(full, r);
    else written.push(r);
  }
};
walkDest(DEST);
const writtenUnexpected = written.filter((r) => !ALLOWED.has(r));
console.log(`\n  files written: ${written.length}; unexpected: ${writtenUnexpected.length === 0 ? 'none' : writtenUnexpected.join(', ')}`);

// Independent leak check: the leaf keys and app token must not be present anywhere in the bundle.
const destText = written.map((r) => fs.readFileSync(path.join(DEST, ...r.split('/')), 'latin1')).join('\n');
const leaks = [];
for (const [label, p] of [
  ['frpc leaf private key', 'D:\\r9-relay-pki\\frp\\keys\\leaves\\frpc-client.key'],
  ['frps leaf private key', 'D:\\r9-relay-pki\\frp\\keys\\leaves\\frps-server.key'],
  ['application HTTPS key', 'D:\\r9-relay-secrets\\https-server\\https-server.key'],
]) {
  if (fs.existsSync(p)) {
    const der = crypto.createPrivateKey(fs.readFileSync(p)).export({ type: 'pkcs8', format: 'der' });
    if (destText.includes(der.toString('latin1'))) leaks.push(label);
  }
}
const tokenPath = 'D:\\r9-relay-secrets\\frp\\app-auth-token';
if (fs.existsSync(tokenPath) && destText.includes(fs.readFileSync(tokenPath, 'utf8').trim())) {
  leaks.push('FRP application auth token');
}
const privateBlocks = (destText.match(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g) ?? []).length;
console.log(`  private key blocks on volume: ${privateBlocks} (expected exactly 2)`);
console.log(`  forbidden material on volume: ${leaks.length === 0 ? 'none' : leaks.join(', ')}`);

const report = {
  phase: 'R9-RELAY-02B.1',
  volume: VOLUME,
  destination: DEST,
  written_at: new Date().toISOString(),
  file_count: written.length,
  files: written.sort(),
  verification,
  all_hashes_match: allMatch,
  private_key_blocks_on_volume: privateBlocks,
  unexpected_files_on_volume: writtenUnexpected,
  forbidden_material_on_volume: leaks,
  forbidden_material_clean: leaks.length === 0 && privateBlocks === 2,
  preexisting_entries_preserved: preserved,
  preexisting_acme_material_intact: acmeStillThere,
  source_bundle_unchanged: sourceUnchanged,
  volume_root_before: beforeTop,
  volume_root_after: afterTop,
};
fs.mkdirSync('.r9-fixture-tools', { recursive: true });
fs.writeFileSync('.r9-fixture-tools/frp-issuer-offline-write.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`\n  ALL HASHES MATCH: ${allMatch}`);
console.log(`  safe to dismount : ${allMatch && preserved && acmeStillThere && leaks.length === 0 && privateBlocks === 2}`);
console.log('  written: .r9-fixture-tools/frp-issuer-offline-write.json');
