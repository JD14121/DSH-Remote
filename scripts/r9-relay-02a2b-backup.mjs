/**
 * R9-RELAY-02A.2B — Gates 2-6: minimal ACME recovery bundle, hash integrity, offline recovery test.
 *
 * Reads only from D:\r9-relay-acme and writes only under R:\R9-RECOVERY.
 * The only secret-derived value that leaves this script is a PUBLIC key fingerprint.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE_ROOT = 'D:\\r9-relay-acme';
const DEST_ROOT = 'R:\\R9-RECOVERY';
const ACME_DEST = path.join(DEST_ROOT, 'ACME');
const DOCS_DEST = path.join(DEST_ROOT, 'DOCS');

// Discovered from the ACTUAL lego v5.3.1 layout rather than assumed:
//   accounts/<server>/<email>/<email>.key   -> the ACME account private key
//   accounts/<server>/<email>/account.json  -> account registration metadata
const SERVER_DIR = 'acme-v02.api.letsencrypt.org';
const EMAIL_DIR = '1300637954@qq.com';
const ACCOUNT_REL = path.join('accounts', SERVER_DIR, EMAIL_DIR);

const SELECTED = [
  { rel: path.join(ACCOUNT_REL, `${EMAIL_DIR}.key`), role: 'ACME account private key (EC P-256)' },
  { rel: path.join(ACCOUNT_REL, 'account.json'), role: 'ACME account registration metadata' },
];

const EXPECTED_SPKI = '2f3d3328b5e7b9cd4c04465e3b7aa53f71d7733a7c60d96244068c316978bb63';
const EXPECTED_ACCOUNT_URI = 'https://acme-v02.api.letsencrypt.org/acme/acct/3780342786';

const report = { files: [], checks: [], errors: [] };
const check = (name, condition, detail = '') => {
  report.checks.push({ name, pass: Boolean(condition), detail });
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${name}${!condition && detail ? ' — ' + detail : ''}`);
};
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

console.log('=== GATE 2: create the minimal recovery bundle ===');
fs.mkdirSync(ACME_DEST, { recursive: true });
fs.mkdirSync(DOCS_DEST, { recursive: true });
console.log(`  created ${ACME_DEST}`);
console.log(`  created ${DOCS_DEST}`);

for (const { rel, role } of SELECTED) {
  const src = path.join(SOURCE_ROOT, rel);
  const dst = path.join(ACME_DEST, rel);
  if (!fs.existsSync(src)) {
    report.errors.push(`missing source: ${rel}`);
    console.log(`  [FAIL] source missing: ${rel}`);
    continue;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const sourceHash = sha256(src);
  fs.copyFileSync(src, dst);
  // copyFileSync does not carry timestamps; that is fine and avoids writing odd metadata to FAT32.
  const backupHash = sha256(dst);
  const bytes = fs.statSync(dst).size;
  const entry = {
    relative_filename: rel.replace(/\\/g, '/'),
    role,
    bytes,
    source_sha256: sourceHash,
    backup_sha256: backupHash,
    match: sourceHash === backupHash,
  };
  report.files.push(entry);
  console.log(`  [${entry.match ? 'PASS' : 'FAIL'}] ${entry.relative_filename}`);
  console.log(`         role  : ${role}`);
  console.log(`         bytes : ${bytes}`);
  console.log(`         src   : ${sourceHash}`);
  console.log(`         bak   : ${backupHash}`);
}

console.log('\n=== GATE 4: hash integrity ===');
const allMatch = report.files.length === SELECTED.length && report.files.every((f) => f.match);
check('every selected file was copied', report.files.length === SELECTED.length, `${report.files.length}/${SELECTED.length}`);
check('all source/backup SHA-256 pairs match exactly', allMatch);

console.log('\n=== GATE 5: independent recovery test FROM THE BACKUP COPY ===');
let spkiOk = false;
let curveOk = false;
try {
  const backupKeyPath = path.join(ACME_DEST, ACCOUNT_REL, `${EMAIL_DIR}.key`);
  const key = crypto.createPrivateKey(fs.readFileSync(backupKeyPath));
  const details = key.asymmetricKeyDetails ?? {};
  const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  const derived = crypto.createHash('sha256').update(spki).digest('hex');
  console.log(`  key type                  : ${key.asymmetricKeyType}`);
  console.log(`  curve                     : ${details.namedCurve}`);
  console.log(`  backup-derived SPKI sha256: ${derived}`);
  console.log(`  expected live fingerprint : ${EXPECTED_SPKI}`);
  spkiOk = derived === EXPECTED_SPKI;
  curveOk = details.namedCurve === 'prime256v1';
  check('backup-derived fingerprint equals the live account fingerprint', spkiOk, derived);
  check('backup key is EC P-256 (prime256v1)', curveOk, String(details.namedCurve));
} catch (error) {
  console.log(`  [FAIL] could not derive fingerprint: ${error.message}`);
  check('backup-derived fingerprint equals the live account fingerprint', false, error.message);
  report.errors.push(String(error.message));
}

let uriOk = false;
let statusOk = false;
try {
  const meta = JSON.parse(fs.readFileSync(path.join(ACME_DEST, ACCOUNT_REL, 'account.json'), 'utf8'));
  const registration = meta.registration ?? {};
  const uri = registration.accountURL ?? registration.uri ?? null;
  const status = registration.status ?? null;
  console.log(`  backed-up registration status : ${status}`);
  console.log(`  backed-up account URI         : ${uri}`);
  statusOk = status === 'valid';
  uriOk = uri === EXPECTED_ACCOUNT_URI;
  check('backed-up metadata registration status is valid', statusOk, String(status));
  check('backed-up metadata contains the expected account URI', uriOk, String(uri));
} catch (error) {
  console.log(`  [FAIL] could not parse backed-up metadata: ${error.message}`);
  check('backed-up metadata parses', false, error.message);
  report.errors.push(String(error.message));
}

console.log('\n=== GATE 6: offline backup result ===');
const verified = allMatch && spkiOk && uriOk && statusOk && curveOk;
report.offline_acme_backup = verified ? 'VERIFIED' : 'NOT_VERIFIED';
check('OFFLINE_ACME_BACKUP = VERIFIED', verified);

report.expected_spki = EXPECTED_SPKI;
report.expected_account_uri = EXPECTED_ACCOUNT_URI;
report.selected_count = SELECTED.length;

const out = path.resolve('..', 'dsh-remote-gateway', '.r9-fixture-tools', 'backup-verification.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`\n  written: ${out}`);
process.exit(verified ? 0 : 1);
