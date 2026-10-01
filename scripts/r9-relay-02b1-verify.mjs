/**
 * R9-RELAY-02B.1 — independent final verification of the offline backup.
 *
 * Verifies the copy ON THE ENCRYPTED VOLUME directly against the AUTHORITATIVE PKI on D:, rather than
 * against the now-deleted staging bundle. This is the check that matters for a recovery guarantee.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const AUTH = 'D:\\r9-relay-pki\\frp';
const VOL = 'R:\\FRP-ISSUER-CA';
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const spki = (p) => crypto.createHash('sha256')
  .update(new crypto.X509Certificate(fs.readFileSync(p)).publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
const keySpki = (p) => crypto.createHash('sha256')
  .update(crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(p))).export({ type: 'spki', format: 'der' })).digest('hex');

const pairs = [
  ['server-ca/server-ca.key', path.join(AUTH, 'keys', 'server-ca', 'server-ca.key')],
  ['server-ca/server-ca.crt', path.join(AUTH, 'public', 'server-ca', 'server-ca.crt')],
  ['client-ca/client-ca.key', path.join(AUTH, 'keys', 'client-ca', 'client-ca.key')],
  ['client-ca/client-ca.crt', path.join(AUTH, 'public', 'client-ca', 'client-ca.crt')],
];

console.log('=== volume copy vs AUTHORITATIVE PKI ===');
const results = [];
for (const [rel, authPath] of pairs) {
  const volPath = path.join(VOL, ...rel.split('/'));
  const a = sha256(authPath);
  const b = sha256(volPath);
  results.push({ file: rel, authoritative_sha256: a, volume_sha256: b, match: a === b });
  console.log(`  ${a === b ? 'MATCH' : 'FAIL '} ${rel.padEnd(28)} ${a.slice(0, 28)}…`);
}
const allMatch = results.every((r) => r.match);

console.log('\n=== restored-key usability (would a recovery actually work?) ===');
const serverRestored = keySpki(path.join(VOL, 'server-ca', 'server-ca.key')) === spki(path.join(VOL, 'server-ca', 'server-ca.crt'));
const clientRestored = keySpki(path.join(VOL, 'client-ca', 'client-ca.key')) === spki(path.join(VOL, 'client-ca', 'client-ca.crt'));
console.log(`  Server CA key on volume matches its certificate : ${serverRestored}`);
console.log(`  Client CA key on volume matches its certificate : ${clientRestored}`);

// A restored CA must still be a CA capable of signing.
const serverCa = new crypto.X509Certificate(fs.readFileSync(path.join(VOL, 'server-ca', 'server-ca.crt')));
const clientCa = new crypto.X509Certificate(fs.readFileSync(path.join(VOL, 'client-ca', 'client-ca.crt')));
console.log(`  Server CA cert is CA:TRUE                      : ${serverCa.ca}`);
console.log(`  Client CA cert is CA:TRUE                      : ${clientCa.ca}`);

// The two restored CA keys must remain distinct from each other.
const distinct = keySpki(path.join(VOL, 'server-ca', 'server-ca.key')) !== keySpki(path.join(VOL, 'client-ca', 'client-ca.key'));
console.log(`  Server and Client CA keys still distinct       : ${distinct}`);

console.log('\n=== exclusion: what is NOT on the volume ===');
const volumeText = (function collect(dir, acc = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    acc += e.isDirectory() ? collect(full) : fs.readFileSync(full, 'latin1');
  }
  return acc;
})(VOL);

const excluded = [];
for (const [label, p] of [
  ['frpc client leaf private key', path.join(AUTH, 'keys', 'leaves', 'frpc-client.key')],
  ['frps server leaf private key', path.join(AUTH, 'keys', 'leaves', 'frps-server.key')],
  ['application HTTPS server key', 'D:\\r9-relay-secrets\\https-server\\https-server.key'],
  ['ACME account private key', 'D:\\r9-relay-acme\\accounts\\acme-v02.api.letsencrypt.org\\1300637954@qq.com\\1300637954@qq.com.key'],
]) {
  if (!fs.existsSync(p)) { console.log(`  (source absent, cannot compare) ${label}`); continue; }
  const der = crypto.createPrivateKey(fs.readFileSync(p)).export({ type: 'pkcs8', format: 'der' });
  const present = volumeText.includes(der.toString('latin1'));
  excluded.push({ item: label, present_on_volume: present });
  console.log(`  ${present ? 'PRESENT — LEAK' : 'absent'}  ${label}`);
}
const tokenPath = 'D:\\r9-relay-secrets\\frp\\app-auth-token';
if (fs.existsSync(tokenPath)) {
  const present = volumeText.includes(fs.readFileSync(tokenPath, 'utf8').trim());
  excluded.push({ item: 'FRP application auth token', present_on_volume: present });
  console.log(`  ${present ? 'PRESENT — LEAK' : 'absent'}  FRP application auth token`);
}
const cfPresent = fs.existsSync('D:\\r9-relay-secrets\\cloudflare-dns-token')
  && volumeText.includes(fs.readFileSync('D:\\r9-relay-secrets\\cloudflare-dns-token', 'utf8').trim());
excluded.push({ item: 'Cloudflare DNS token', present_on_volume: cfPresent });
console.log(`  ${cfPresent ? 'PRESENT — LEAK' : 'absent'}  Cloudflare DNS token`);

const privateBlocks = (volumeText.match(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g) ?? []).length;
const anyLeak = excluded.some((e) => e.present_on_volume);

console.log('\n=== volume contents (exhaustive) ===');
const listing = [];
const walk = (dir, base = '') => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), r);
    else listing.push(r);
  }
};
walk(VOL);
for (const f of listing.sort()) console.log(`  ${f}  ${fs.statSync(path.join(VOL, ...f.split('/'))).size}b`);
console.log(`  private key blocks: ${privateBlocks} (expected 2)`);
console.log(`  MANIFEST.sha256 present: ${listing.includes('MANIFEST.sha256')}`);

const report = {
  phase: 'R9-RELAY-02B.1',
  verified_against: 'authoritative PKI on D:, not the deleted staging bundle',
  volume_path: VOL,
  verified_at: new Date().toISOString(),
  files: results,
  all_hashes_match_authoritative: allMatch,
  server_ca_key_usable: serverRestored,
  client_ca_key_usable: clientRestored,
  server_ca_true: serverCa.ca === true,
  client_ca_true: clientCa.ca === true,
  ca_keys_distinct: distinct,
  excluded_items: excluded,
  private_key_blocks_on_volume: privateBlocks,
  forbidden_material_present: anyLeak,
  volume_listing: listing.sort(),
  recovery_guarantee_met: allMatch && serverRestored && clientRestored && !anyLeak && privateBlocks === 2,
};
fs.mkdirSync('.r9-fixture-tools', { recursive: true });
fs.writeFileSync('.r9-fixture-tools/frp-issuer-final-verify.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`\n  RECOVERY GUARANTEE MET: ${report.recovery_guarantee_met}`);
console.log('  written: .r9-fixture-tools/frp-issuer-final-verify.json');
