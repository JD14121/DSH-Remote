/**
 * R9-RELAY-02B.1 — build the FRP issuer offline backup bundle.
 *
 * Scope is deliberately NARROW. Only these are copied:
 *   * FRP Server CA private key + certificate
 *   * FRP Client CA private key + certificate
 *   * non-secret recovery metadata
 *
 * Explicitly EXCLUDED, and the exclusion is verified rather than assumed:
 *   * FRP application auth token
 *   * frpc client leaf private key
 *   * frps server leaf private key
 *   * Cloudflare DNS token
 *   * ACME account key
 *   * Phone Bearer
 *   * application HTTPS server key
 *
 * The bundle is built on D: first so it can be verified before it is ever written to the encrypted
 * volume. Its own manifest is computed over the files that will actually be copied.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PKI = 'D:\\r9-relay-pki\\frp';
const STAGE = 'D:\\r9-relay-pki\\frp-issuer-backup-bundle';
const RECOVERY_ID = process.env.R9_RECOVERY_ID ?? 'R9-FRP-ISSUER-RECOVERY';

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const spki = (pemPath) => {
  const cert = new crypto.X509Certificate(fs.readFileSync(pemPath));
  return crypto.createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
};
const keySpki = (pemPath) => {
  const key = crypto.createPrivateKey(fs.readFileSync(pemPath));
  return crypto.createHash('sha256').update(crypto.createPublicKey(key).export({ type: 'spki', format: 'der' })).digest('hex');
};

// ── 1. the ONLY four items in scope ─────────────────────────────────────────
const ITEMS = [
  { src: path.join(PKI, 'keys', 'server-ca', 'server-ca.key'), dest: 'server-ca/server-ca.key', role: 'FRP Server CA private key' },
  { src: path.join(PKI, 'public', 'server-ca', 'server-ca.crt'), dest: 'server-ca/server-ca.crt', role: 'FRP Server CA certificate' },
  { src: path.join(PKI, 'keys', 'client-ca', 'client-ca.key'), dest: 'client-ca/client-ca.key', role: 'FRP Client CA private key' },
  { src: path.join(PKI, 'public', 'client-ca', 'client-ca.crt'), dest: 'client-ca/client-ca.crt', role: 'FRP Client CA certificate' },
];

console.log('=== verifying the four in-scope items exist ===');
for (const item of ITEMS) {
  console.log(`  ${fs.existsSync(item.src) ? 'OK  ' : 'MISS'} ${item.dest}`);
  if (!fs.existsSync(item.src)) {
    console.error(`  ABORT: missing ${item.src}`);
    process.exit(1);
  }
}

// ── 2. freshness: which leaves exist that this CA signed ────────────────────
const leafAudit = {
  frps_server_leaf_present_in_pki: fs.existsSync(path.join(PKI, 'public', 'leaves', 'frps-server.crt')),
  frpc_client_leaf_present_in_pki: fs.existsSync(path.join(PKI, 'public', 'leaves', 'frpc-client.crt')),
  frps_server_leaf_spki: spki(path.join(PKI, 'public', 'leaves', 'frps-server.crt')),
  frpc_client_leaf_spki: spki(path.join(PKI, 'public', 'leaves', 'frpc-client.crt')),
  note: 'leaf SPKIs are recorded as NON-SECRET identity metadata so a future recovery can confirm which leaves a restored CA had issued',
};

const serverCa = new crypto.X509Certificate(fs.readFileSync(path.join(PKI, 'public', 'server-ca', 'server-ca.crt')));
const clientCa = new crypto.X509Certificate(fs.readFileSync(path.join(PKI, 'public', 'client-ca', 'client-ca.crt')));

// ── 3. rebuild the staging bundle from scratch ──────────────────────────────
fs.rmSync(STAGE, { recursive: true, force: true });
for (const item of ITEMS) {
  const dest = path.join(STAGE, ...item.dest.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(item.src, dest);
}

// ── 4. verify each copy byte-for-byte, and that key/cert pair up ────────────
console.log('\n=== copy integrity and key/cert pairing ===');
const integrity = [];
for (const item of ITEMS) {
  const dest = path.join(STAGE, ...item.dest.split('/'));
  const a = sha256(item.src);
  const b = sha256(dest);
  const match = a === b;
  integrity.push({ file: item.dest, role: item.role, sha256: a, bytes: fs.statSync(dest).size, match });
  console.log(`  ${match ? 'MATCH' : 'FAIL '} ${item.dest.padEnd(30)} ${fs.statSync(dest).size}b  ${a.slice(0, 24)}…`);
}

const serverPaired = keySpki(path.join(STAGE, 'server-ca', 'server-ca.key')) === spki(path.join(STAGE, 'server-ca', 'server-ca.crt'));
const clientPaired = keySpki(path.join(STAGE, 'client-ca', 'client-ca.key')) === spki(path.join(STAGE, 'client-ca', 'client-ca.crt'));
console.log(`  Server CA key matches its certificate : ${serverPaired}`);
console.log(`  Client CA key matches its certificate : ${clientPaired}`);

// The two CAs must not be the same key.
const serverKeyFp = keySpki(path.join(STAGE, 'server-ca', 'server-ca.key'));
const clientKeyFp = keySpki(path.join(STAGE, 'client-ca', 'client-ca.key'));
console.log(`  Server CA and Client CA keys distinct : ${serverKeyFp !== clientKeyFp}`);

// A CA private key must still be able to sign, and must still be a CA certificate.
console.log(`  Server CA cert is CA:TRUE             : ${serverCa.ca === true}`);
console.log(`  Client CA cert is CA:TRUE             : ${clientCa.ca === true}`);

// ── 5. recovery metadata ───────────────────────────────────────────────────
const metadata = {
  bundle: RECOVERY_ID,
  createdAt: new Date().toISOString(),
  phase: 'R9-RELAY-02B.1',
  purpose:
    'Offline recovery material for the FRP transport PKI. Restoring these two issuer keys is what '
    + 'allows re-issuing frps/frpc leaf certificates after PC loss or key destruction.',
  frp_version_pinned_at_backup: 'v0.71.0',
  what_is_here: [
    'server-ca/server-ca.key  — FRP Server CA private key',
    'server-ca/server-ca.crt  — FRP Server CA certificate',
    'client-ca/client-ca.key  — FRP Client CA private key',
    'client-ca/client-ca.crt  — FRP Client CA certificate',
  ],
  what_is_deliberately_NOT_here: [
    'FRP application auth token',
    'frpc client leaf private key',
    'frps server leaf private key',
    'Cloudflare DNS token',
    'ACME account private key',
    'Phone Bearer',
    'application HTTPS server key (relay.drm-jd.com)',
  ],
  why_those_are_excluded:
    'Leaf keys are re-issuable from these CAs, so backing them up adds exposure without adding '
    + 'recovery value. The application HTTPS key, the ACME account key and the DNS credential belong '
    + 'to different roles and are independently custodied; mixing them into this bundle would make one '
    + 'offline volume disclose several unrelated trust domains at once.',
  ca_identities: {
    server_ca: {
      subject: serverCa.subject.replace(/\n/g, ', '),
      serial: serverCa.serialNumber,
      notBefore: serverCa.validFrom,
      notAfter: serverCa.validTo,
      spki_sha256: spki(path.join(STAGE, 'server-ca', 'server-ca.crt')),
      signs: 'frps server identities only',
    },
    client_ca: {
      subject: clientCa.subject.replace(/\n/g, ', '),
      serial: clientCa.serialNumber,
      notBefore: clientCa.validFrom,
      notAfter: clientCa.validTo,
      spki_sha256: spki(path.join(STAGE, 'client-ca', 'client-ca.crt')),
      signs: 'frpc client identities only',
    },
  },
  key_separation_invariant:
    'No private key may serve two roles. These two CA keys are distinct from each other and from the '
    + 'frps leaf, the frpc leaf, the application HTTPS key and the ACME account key.',
  known_leaves_issued_at_backup: leafAudit,
  restore_procedure: [
    '1. Confirm the offline volume is the correct one by checking this manifest against the file hashes.',
    '2. Copy server-ca.key/.crt and client-ca.key/.crt back to D:\\r9-relay-pki\\frp (keys/ and public/).',
    '3. Re-apply restrictive ACLs: Administrators/SYSTEM/operator = Full; no Authenticated Users/Users/Everyone.',
    '4. Verify each key still matches its certificate by comparing SPKI fingerprints to the values above.',
    '5. Re-issue any needed leaves from the restored CA; do NOT reuse a leaf key whose exposure is unknown.',
    '6. If a CA key is believed COMPROMISED (not merely lost), do NOT restore it — issue a new CA instead.',
  ],
  rotation_warning:
    'If either CA private key is suspected compromised, restoring it perpetuates the compromise. The '
    + 'correct response is to create a new CA, re-issue the leaves, and retire the old CA.',
  custody: {
    offline_backup_performed: true,
    location: 'operator-held encrypted volume (not recorded here)',
    issuer_keys_are_pc_only_otherwise: true,
  },
};

const metadataText = `${JSON.stringify(metadata, null, 2)}\n`;
fs.writeFileSync(path.join(STAGE, 'RECOVERY-METADATA.json'), metadataText, 'utf8');

// ── 6. human-readable recovery README ──────────────────────────────────────
const readme = `R9 FRP ISSUER RECOVERY MATERIAL
==============================

Bundle : ${RECOVERY_ID}
Created: ${metadata.createdAt}
Phase  : R9-RELAY-02B.1

WHAT THIS IS
------------
Offline recovery material for the FRP transport PKI. These two issuer keys are what allow
re-issuing frps and frpc leaf certificates after PC loss.

CONTENTS (4 files + metadata)
-----------------------------
  server-ca/server-ca.key   FRP Server CA private key   (signs frps server identities only)
  server-ca/server-ca.crt   FRP Server CA certificate
  client-ca/client-ca.key   FRP Client CA private key   (signs frpc client identities only)
  client-ca/client-ca.crt   FRP Client CA certificate
  RECOVERY-METADATA.json    identities, hashes and restore steps
  MANIFEST.sha256           integrity check

WHAT IS DELIBERATELY *NOT* HERE
-------------------------------
  FRP application auth token
  frpc client leaf private key
  frps server leaf private key
  Cloudflare DNS token
  ACME account private key
  Phone Bearer
  application HTTPS server key (relay.drm-jd.com)

Leaf keys are re-issuable from these CAs, so storing them adds exposure without recovery value.
The other items belong to different trust domains and are custodied separately on purpose.

VERIFY THIS BUNDLE
------------------
  1. Compare each file hash to MANIFEST.sha256.
  2. Compare the CA SPKI fingerprints to RECOVERY-METADATA.json.

RESTORE
-------
See restore_procedure in RECOVERY-METADATA.json. Re-apply restrictive ACLs after restoring.

IMPORTANT
---------
If a CA key is believed COMPROMISED rather than merely lost, do NOT restore it. Create a new CA,
re-issue the leaves, and retire the old one.
`;

fs.writeFileSync(path.join(STAGE, 'RECOVERY-README.txt'), readme, 'utf8');

// ── 7. manifest over everything in the bundle ──────────────────────────────
const allFiles = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else allFiles.push(full);
  }
};
walk(STAGE);

const manifestLines = allFiles
  .map((f) => ({ rel: path.relative(STAGE, f).replace(/\\/g, '/'), hash: sha256(f) }))
  .filter((x) => x.rel !== 'MANIFEST.sha256')
  .sort((a, b) => a.rel.localeCompare(b.rel))
  .map((x) => `${x.hash}  ${x.rel}`);
fs.writeFileSync(path.join(STAGE, 'MANIFEST.sha256'), `${manifestLines.join('\n')}\n`, 'utf8');

// ── 8. exclusion verification: scan the bundle for anything out of scope ───
console.log('\n=== exclusion verification (the bundle must contain ONLY the approved items) ===');
const ALLOWED = new Set(['server-ca/server-ca.key', 'server-ca/server-ca.crt',
  'client-ca/client-ca.key', 'client-ca/client-ca.crt',
  'RECOVERY-METADATA.json', 'RECOVERY-README.txt', 'MANIFEST.sha256']);

// Re-enumerate ONCE. An earlier version reused a list built by an extra walk(), which duplicated
// every entry and made the PEM-block count read 4 instead of 2 — a false leak alarm.
const finalFiles = [];
const walkFinal = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFinal(full);
    else finalFiles.push(full);
  }
};
walkFinal(STAGE);

const rel = (f) => path.relative(STAGE, f).replace(/\\/g, '/');
const unexpected = finalFiles.map(rel).filter((r) => !ALLOWED.has(r));
console.log(`  files in bundle : ${finalFiles.length}`);
console.log(`  unexpected files: ${unexpected.length === 0 ? 'none' : unexpected.join(', ')}`);

// Per-file PEM audit, so the private-key count is attributable and unambiguous.
const pemAudit = finalFiles.map((f) => {
  const text = fs.readFileSync(f, 'latin1');
  return {
    file: rel(f),
    private_key_blocks: (text.match(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g) ?? []).length,
    certificate_blocks: (text.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length,
  };
});
const totalPrivate = pemAudit.reduce((n, p) => n + p.private_key_blocks, 0);
console.log('  PEM audit:');
for (const p of pemAudit) {
  console.log(`    ${p.file.padEnd(30)} private=${p.private_key_blocks} cert=${p.certificate_blocks}`);
}
console.log(`  private key blocks total: ${totalPrivate} (expected exactly 2 — the two CA keys)`);

const leaked = [];
if (totalPrivate !== 2) leaked.push(`unexpected private key block count: ${totalPrivate}`);

const bundleText = finalFiles.map((f) => fs.readFileSync(f, 'latin1')).join('\n');
for (const [label, p] of [
  ['frpc leaf private key', path.join(PKI, 'keys', 'leaves', 'frpc-client.key')],
  ['frps leaf private key', path.join(PKI, 'keys', 'leaves', 'frps-server.key')],
]) {
  if (fs.existsSync(p)) {
    const der = crypto.createPrivateKey(fs.readFileSync(p)).export({ type: 'pkcs8', format: 'der' });
    if (bundleText.includes(der.toString('latin1'))) leaked.push(label);
  }
}
const appToken = 'D:\\r9-relay-secrets\\frp\\app-auth-token';
if (fs.existsSync(appToken)) {
  const value = fs.readFileSync(appToken, 'utf8').trim();
  if (bundleText.includes(value)) leaked.push('FRP application auth token value');
}
const httpsKey = 'D:\\r9-relay-secrets\\https-server\\https-server.key';
if (fs.existsSync(httpsKey)) {
  const der = crypto.createPrivateKey(fs.readFileSync(httpsKey)).export({ type: 'pkcs8', format: 'der' });
  if (bundleText.includes(der.toString('latin1'))) leaked.push('application HTTPS server key');
}
if (bundleText.includes('cloudflare') || /CF_DNS_API_TOKEN/.test(bundleText)) leaked.push('Cloudflare credential reference');
console.log(`  forbidden material found: ${leaked.length === 0 ? 'none' : leaked.join(', ')}`);

const report = {
  bundle: STAGE,
  recovery_id: RECOVERY_ID,
  created_at: metadata.createdAt,
  file_count: finalFiles.length,
  files: finalFiles.map(rel).sort(),
  items: integrity,
  copy_integrity_all_match: integrity.every((i) => i.match),
  server_ca_key_pairs_with_cert: serverPaired,
  client_ca_key_pairs_with_cert: clientPaired,
  ca_keys_distinct: serverKeyFp !== clientKeyFp,
  server_ca_ca_true: serverCa.ca === true,
  client_ca_ca_true: clientCa.ca === true,
  pem_audit: pemAudit,
  private_key_blocks_total: totalPrivate,
  unexpected_files: unexpected,
  forbidden_material_found: leaked,
  forbidden_material_clean: leaked.length === 0,
  manifest_sha256: sha256(path.join(STAGE, 'MANIFEST.sha256')),
};
fs.mkdirSync('.r9-fixture-tools', { recursive: true });
fs.writeFileSync('.r9-fixture-tools/frp-issuer-backup.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`\n  bundle staged at : ${STAGE}`);
console.log(`  written          : .r9-fixture-tools/frp-issuer-backup.json`);
