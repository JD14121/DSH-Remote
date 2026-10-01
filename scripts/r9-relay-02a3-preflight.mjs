/**
 * R9-RELAY-02A.3 — §1 preflight: verify everything before creating any ACME order.
 *
 * Read-only. Checks the ACME account, the ACME root, lego, the token file, the public CAA policy, and
 * that no relay address record or stale challenge record exists.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Resolver } from 'node:dns/promises';

const ACME_ROOT = 'D:\\r9-relay-acme';
const TOKEN_PATH = 'D:\\r9-relay-secrets\\cloudflare-dns-token';
const LEGO = 'D:\\DSH-testing\\r9-tooling\\bin\\lego.exe';
const ZONE = 'drm-jd.com';
const HOST = `relay.${ZONE}`;
const CHALLENGE = `_acme-challenge.${HOST}`;
const ACCOUNT_URI = 'https://acme-v02.api.letsencrypt.org/acme/acct/3780342786';
const EXPECTED_ISSUE = `letsencrypt.org;validationmethods=dns-01;accounturi=${ACCOUNT_URI}`;
const RESOLVERS = ['1.1.1.1', '8.8.8.8', '9.9.9.9', '208.67.222.222'];

const report = { checks: [] };
const check = (name, condition, detail = '') => {
  report.checks.push({ name, pass: Boolean(condition), detail });
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${name}${!condition && detail ? ' — ' + detail : ''}`);
};

async function query(server, name, type) {
  const resolver = new Resolver({ timeout: 6000, tries: 2 });
  resolver.setServers([server]);
  try {
    if (type === 'TXT') return (await resolver.resolveTxt(name)).map((c) => c.join(''));
    if (type === 'CAA') return await resolver.resolveCaa(name);
    if (type === 'A') return await resolver.resolve4(name);
    if (type === 'AAAA') return await resolver.resolve6(name);
    if (type === 'CNAME') return await resolver.resolveCname(name);
  } catch { return []; }
  return [];
}

console.log('=== ACME account ===');
const accountFile = `${ACME_ROOT}\\accounts\\acme-v02.api.letsencrypt.org\\1300637954@qq.com\\account.json`;
const meta = JSON.parse(fs.readFileSync(accountFile, 'utf8'));
const reg = meta.registration ?? {};
console.log(`  registration status : ${reg.status}`);
console.log(`  account URI         : ${reg.accountURL}`);
check('ACME account registration status is valid', reg.status === 'valid', String(reg.status));
check('ACME account URI matches the expected one', reg.accountURL === ACCOUNT_URI, String(reg.accountURL));

console.log('\n=== ACME root and lego ===');
const accountKey = `${ACME_ROOT}\\accounts\\acme-v02.api.letsencrypt.org\\1300637954@qq.com\\1300637954@qq.com.key`;
check('ACME root exists', fs.existsSync(ACME_ROOT));
check('ACME account key exists', fs.existsSync(accountKey));
const accountSpki = crypto.createHash('sha256')
  .update(crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(accountKey)))
    .export({ type: 'spki', format: 'der' })).digest('hex');
console.log(`  ACME account key SPKI : ${accountSpki}`);
check('ACME account key fingerprint matches the recorded value',
  accountSpki === '2f3d3328b5e7b9cd4c04465e3b7aa53f71d7733a7c60d96244068c316978bb63', accountSpki);
check('lego.exe present', fs.existsSync(LEGO));

console.log('\n=== Cloudflare token file ===');
check('token file exists', fs.existsSync(TOKEN_PATH));
const tokenBytes = fs.readFileSync(TOKEN_PATH);
console.log(`  bytes : ${tokenBytes.length}`);
console.log(`  tail newline : ${tokenBytes[tokenBytes.length - 1] === 10}`);
report.acme_account_spki = accountSpki;

// ── public CAA ──────────────────────────────────────────────────────────────
console.log('\n=== public CAA (independent resolvers) ===');
const caaState = {};
for (const server of RESOLVERS) {
  const records = await query(server, ZONE, 'CAA');
  const issue = records.filter((r) => r.issue !== undefined).map((r) => r.issue);
  const issuewild = records.filter((r) => r.issuewild !== undefined).map((r) => r.issuewild);
  caaState[server] = { issue, issuewild };
  console.log(`  ${server.padEnd(18)} issue=${JSON.stringify(issue)} issuewild=${JSON.stringify(issuewild)}`);
}
check('CAA issue is exactly the account-bound value on >=2 resolvers',
  Object.values(caaState).filter((v) => v.issue.includes(EXPECTED_ISSUE)).length >= 2);
check('CAA issuewild denies wildcards on >=2 resolvers',
  Object.values(caaState).filter((v) => v.issuewild.includes(';')).length >= 2);
report.caa_preflight = caaState;

// ── no address records, no stale challenge ──────────────────────────────────
console.log('\n=== relay host and challenge state ===');
const relayState = {};
for (const type of ['A', 'AAAA', 'CNAME']) {
  const rows = [];
  for (const server of ['8.8.8.8', '1.1.1.1']) rows.push(...await query(server, HOST, type));
  relayState[type] = rows;
  console.log(`  ${HOST} ${type.padEnd(5)} : ${rows.length ? JSON.stringify(rows) : 'ABSENT'}`);
}
check('relay.drm-jd.com A absent', relayState.A.length === 0);
check('relay.drm-jd.com AAAA absent', relayState.AAAA.length === 0);
check('relay.drm-jd.com CNAME absent', relayState.CNAME.length === 0);

const challengeState = {};
for (const server of RESOLVERS) {
  const rows = await query(server, CHALLENGE, 'TXT');
  challengeState[server] = rows;
  console.log(`  ${CHALLENGE} : ${rows.length ? JSON.stringify(rows) : 'ABSENT'} (${server})`);
}
check('no stale _acme-challenge TXT present',
  Object.values(challengeState).every((v) => v.length === 0));
report.relay_preflight = relayState;
report.challenge_preflight = challengeState;

const total = report.checks.length;
const passed = report.checks.filter((c) => c.pass).length;
report.total = total;
report.pass = passed;
report.preflight_clean = passed === total;
console.log(`\n=== preflight: ${passed}/${total} checks passed ===`);
fs.mkdirSync('.r9-fixture-tools', { recursive: true });
fs.writeFileSync('.r9-fixture-tools/preflight.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log('  written: .r9-fixture-tools/preflight.json');
process.exit(passed === total ? 0 : 1);
