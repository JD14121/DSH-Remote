/**
 * R9-RELAY-02A.2B — Gates 12/13: temporary TXT absence, CAA re-verification, relay host unpublished.
 *
 * Read-only against public DNS via four independent resolvers.
 */
import { Resolver } from 'node:dns/promises';
import fs from 'node:fs';

const ZONE = 'drm-jd.com';
const DRYRUN = `_r9-acme-dryrun.${ZONE}`;
const RELAY = `relay.${ZONE}`;
const EXPECTED_ISSUE = 'letsencrypt.org;validationmethods=dns-01;accounturi=https://acme-v02.api.letsencrypt.org/acme/acct/3780342786';
const RESOLVERS = ['1.1.1.1', '8.8.8.8', '9.9.9.9', '208.67.222.222'];

const report = { checks: [], errors: [] };
const check = (name, condition, detail = '') => {
  report.checks.push({ name, pass: Boolean(condition), detail });
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${name}${!condition && detail ? ' — ' + detail : ''}`);
};

/** Query one record type through one resolver, returning [] on NXDOMAIN/NoAnswer. */
async function query(server, name, type) {
  const resolver = new Resolver({ timeout: 6000, tries: 2 });
  resolver.setServers([server]);
  try {
    if (type === 'TXT') {
      const rows = await resolver.resolveTxt(name);
      return rows.map((chunks) => chunks.join(''));
    }
    if (type === 'CAA') return await resolver.resolveCaa(name);
    if (type === 'A') return await resolver.resolve4(name);
    if (type === 'AAAA') return await resolver.resolve6(name);
    if (type === 'CNAME') return await resolver.resolveCname(name);
  } catch {
    return [];
  }
  return [];
}

console.log('=== temporary TXT absence ===');
const dryrunState = {};
for (const server of RESOLVERS) {
  const values = await query(server, DRYRUN, 'TXT');
  dryrunState[server] = values;
  console.log(`  ${server.padEnd(18)} ${values.length ? JSON.stringify(values) : 'ABSENT'}`);
}
check('temporary TXT absent from all queried resolvers',
  Object.values(dryrunState).every((v) => v.length === 0), JSON.stringify(dryrunState));
report.dryrun_txt = dryrunState;

console.log('\n=== CAA re-verification ===');
const caaState = {};
for (const server of RESOLVERS) {
  const records = await query(server, ZONE, 'CAA');
  const issue = records.filter((r) => r.issue !== undefined).map((r) => r.issue);
  const issuewild = records.filter((r) => r.issuewild !== undefined).map((r) => r.issuewild);
  caaState[server] = { issue, issuewild };
  console.log(`  ${server.padEnd(18)} issue=${JSON.stringify(issue)} issuewild=${JSON.stringify(issuewild)}`);
}
const allBound = Object.values(caaState).every((v) => v.issue.includes(EXPECTED_ISSUE));
const allWildDenied = Object.values(caaState).every((v) => v.issuewild.includes(';'));
const oldUnbound = Object.values(caaState).some((v) => v.issue.some((i) => i.includes('letsencrypt.org') && !i.includes('accounturi')));
check('CAA issue is still exactly the account-bound value on every resolver', allBound);
check('CAA issuewild still denies wildcards on every resolver', allWildDenied);
check('no old non-account-bound issue reappeared', !oldUnbound);
report.caa = { state: caaState, account_bound: allBound, wildcard_denied: allWildDenied, old_unbound: oldUnbound };

console.log('\n=== relay host remains unpublished ===');
const relayState = {};
for (const type of ['A', 'AAAA', 'CNAME']) {
  const present = [];
  for (const server of ['8.8.8.8', '1.1.1.1']) present.push(...await query(server, RELAY, type));
  relayState[type] = present;
  console.log(`  ${RELAY} ${type.padEnd(5)} : ${present.length ? JSON.stringify(present) : 'absent'}`);
}
check('relay.drm-jd.com A is absent', relayState.A.length === 0, JSON.stringify(relayState.A));
check('relay.drm-jd.com AAAA is absent', relayState.AAAA.length === 0, JSON.stringify(relayState.AAAA));
check('relay.drm-jd.com CNAME is absent', relayState.CNAME.length === 0, JSON.stringify(relayState.CNAME));
report.relay_host = relayState;

// Also confirm the dry-run name has no other record types that could affect traffic.
console.log('\n=== dry-run name has no other record types ===');
for (const type of ['A', 'CNAME']) {
  const rows = await query('1.1.1.1', DRYRUN, type);
  console.log(`  ${DRYRUN} ${type}: ${rows.length ? JSON.stringify(rows) : 'absent'}`);
  check(`dry-run name has no ${type} record`, rows.length === 0);
}

const total = report.checks.length;
const passed = report.checks.filter((c) => c.pass).length;
report.total = total;
report.pass = passed;
console.log(`\n=== final DNS verification: ${passed}/${total} checks passed ===`);

const out = '.r9-fixture-tools/dns-final.json';
fs.mkdirSync('.r9-fixture-tools', { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`  written: ${out}`);
process.exit(passed === total ? 0 : 1);
