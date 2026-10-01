/**
 * R9-RELAY-02A.2B (continued) — §7-§13: DNS create/read/public-resolve/delete, then final verification.
 *
 * This is a DNS CONTROL test only. It is NOT an ACME challenge: no _acme-challenge record, no ACME
 * authorization, no certificate order. The single temporary name is _r9-acme-dryrun.drm-jd.com.
 *
 * The token is read from the protected file into process memory only, never printed, never placed in
 * an environment variable, never written to evidence.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Resolver } from 'node:dns/promises';

const TOKEN_PATH = 'D:\\r9-relay-secrets\\cloudflare-dns-token';
const ZONE_NAME = 'drm-jd.com';
const API = 'https://api.cloudflare.com/client/v4';
const DRYRUN = `_r9-acme-dryrun.${ZONE_NAME}`;
const RELAY = `relay.${ZONE_NAME}`;
const EXPECTED_ISSUE = 'letsencrypt.org;validationmethods=dns-01;accounturi=https://acme-v02.api.letsencrypt.org/acme/acct/3780342786';
const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8', '9.9.9.9', '208.67.222.222'];

const report = { checks: [], steps: [] };
const check = (name, condition, detail = '') => {
  report.checks.push({ name, pass: Boolean(condition), detail });
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${name}${!condition && detail ? ' — ' + detail : ''}`);
};

const token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = { raw_error: text.slice(0, 160) }; }
  return { status: response.status, body: parsed };
}

/** Query TXT through one resolver, returning [] on NXDOMAIN/NoAnswer. */
async function publicTxt(server, name) {
  const resolver = new Resolver({ timeout: 6000, tries: 2 });
  resolver.setServers([server]);
  try {
    const rows = await resolver.resolveTxt(name);
    return rows.map((chunks) => chunks.join(''));
  } catch {
    return [];
  }
}

// ── locate zone ─────────────────────────────────────────────────────────────
const zones = await api('GET', '/zones?per_page=50');
const target = (zones.body.result ?? []).find((z) => z.name === ZONE_NAME);
if (!target) { console.log('  [FAIL] zone not visible'); process.exit(1); }
const zoneId = target.id;
console.log(`  zone id: ${zoneId}`);

// ── §7 CREATE exactly one temporary TXT ─────────────────────────────────────
console.log('\n=== 7. CREATE ONE TEMPORARY TXT ===');
// A fresh random marker derived from CSPRNG bytes only — not from the token, bearer, or any key.
const marker = `r9-dryrun-${crypto.randomBytes(16).toString('hex')}`;
console.log(`  name    : ${DRYRUN}`);
console.log(`  type    : TXT`);
console.log(`  marker  : ${marker}`);
console.log('  derived from: crypto.randomBytes only (not the token, bearer, or any key)');

const created = await api('POST', `/zones/${zoneId}/dns_records`, {
  type: 'TXT', name: DRYRUN, content: marker, ttl: 60,
});
const createOk = [200, 201].includes(created.status) && created.body.success === true;
const recordId = created.body.result?.id;
console.log(`  http status : ${created.status}`);
console.log(`  success     : ${created.body.success}`);
console.log(`  record id   : ${recordId}`);
if (!createOk) console.log(`  errors: ${JSON.stringify(created.body.errors)}`);
check('temporary TXT CREATE succeeded', createOk);
report.steps.push({ step: 'create', http_status: created.status, success: created.body.success === true, record_id: recordId });

// ── §8 verify via Cloudflare API ────────────────────────────────────────────
console.log('\n=== 8. VERIFY VIA CLOUDFLARE API ===');
const fetched = await api('GET', `/zones/${zoneId}/dns_records/${recordId}`);
const result = fetched.body.result ?? {};
const apiReadOk = fetched.status === 200
  && result.type === 'TXT'
  && result.name === DRYRUN
  && result.content === marker;
console.log(`  type    : ${result.type}`);
console.log(`  name    : ${result.name}`);
console.log(`  content : ${result.content === marker ? 'matches the generated marker' : '(MISMATCH)'}`);
check('API read confirms exact type/name/content', apiReadOk);
report.steps.push({
  step: 'api_read', http_status: fetched.status,
  type_matches: result.type === 'TXT', name_matches: result.name === DRYRUN, content_matches: result.content === marker,
});

// ── §9 verify public DNS ────────────────────────────────────────────────────
console.log('\n=== 9. VERIFY PUBLIC DNS ===');
const observed = {};
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  for (const server of PUBLIC_RESOLVERS) {
    if (observed[server]?.includes(marker)) continue;
    const values = await publicTxt(server, DRYRUN);
    if (values.includes(marker)) observed[server] = values;
    console.log(`  ${server.padEnd(18)} ${values.length ? JSON.stringify(values) : 'not yet visible'}`);
  }
  if (PUBLIC_RESOLVERS.every((s) => observed[s]?.includes(marker))) break;
  await new Promise((r) => setTimeout(r, 5000));
}
const visibleCount = PUBLIC_RESOLVERS.filter((s) => observed[s]?.includes(marker)).length;
console.log(`  visible via ${visibleCount}/${PUBLIC_RESOLVERS.length} resolvers`);
check('marker observable through at least 1.1.1.1 and 8.8.8.8',
  observed['1.1.1.1']?.includes(marker) === true && observed['8.8.8.8']?.includes(marker) === true);
report.steps.push({
  step: 'public_visibility', visible_count: visibleCount, total_resolvers: PUBLIC_RESOLVERS.length,
  per_resolver: Object.fromEntries(PUBLIC_RESOLVERS.map((s) => [s, observed[s]?.includes(marker) ?? false])),
  observed_at: new Date().toISOString(),
});

// ── §10 DELETE by exact record id ───────────────────────────────────────────
console.log('\n=== 10. DELETE THE TXT (by exact record id) ===');
const deleted = await api('DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
const deleteOk = deleted.status === 200 && deleted.body.success === true;
console.log(`  http status : ${deleted.status}`);
console.log(`  success     : ${deleted.body.success}`);
check('DELETE by exact record id succeeded', deleteOk);
report.steps.push({ step: 'delete', http_status: deleted.status, success: deleted.body.success === true, deleted_record_id: recordId });

// ── §11 verify delete ───────────────────────────────────────────────────────
console.log('\n=== 11. VERIFY DELETE ===');
const gone = await api('GET', `/zones/${zoneId}/dns_records/${recordId}`);
const apiAbsent = gone.status === 404 || gone.body.success === false;
console.log(`  API lookup http status : ${gone.status} (404 = gone)`);
check('Cloudflare API reports the record absent', apiAbsent);

console.log('  waiting for public resolvers to drop the cached TXT (TTL 60s; allowing negative caching)...');
const finalState = {};
const deadline2 = Date.now() + 240000;
while (Date.now() < deadline2) {
  let stillVisible = 0;
  for (const server of PUBLIC_RESOLVERS) {
    const values = await publicTxt(server, DRYRUN);
    finalState[server] = values.includes(marker);
    if (finalState[server]) stillVisible += 1;
  }
  console.log(`  still visible via ${stillVisible}/${PUBLIC_RESOLVERS.length} resolvers`);
  if (stillVisible === 0) break;
  await new Promise((r) => setTimeout(r, 15000));
}
const stillVisible = PUBLIC_RESOLVERS.filter((s) => finalState[s] === true);
console.log(`  final: ${stillVisible.length === 0 ? 'ABSENT everywhere' : `still cached at ${stillVisible.join(', ')}`}`);
check('temporary TXT ultimately absent from public DNS', stillVisible.length === 0, String(stillVisible));
report.steps.push({
  step: 'final_absence', api_absent: apiAbsent, still_visible: stillVisible,
  per_resolver: finalState, checked_at: new Date().toISOString(),
});

// ── §12 reverify CAA ────────────────────────────────────────────────────────
console.log('\n=== 12. REVERIFY PRODUCTION CAA ===');
const parseCaa = (content) => {
  const match = /^(\d+)\s+(\S+)\s+"?(.*?)"?$/.exec(String(content).trim());
  return match ? { tag: match[2], value: match[3] } : { tag: null, value: String(content) };
};
const caaRecords = (await api('GET', `/zones/${zoneId}/dns_records?type=CAA&per_page=100`)).body.result ?? [];
const parsed = caaRecords.map((r) => parseCaa(r.content));
const issues = parsed.filter((r) => r.tag === 'issue').map((r) => r.value);
const wilds = parsed.filter((r) => r.tag === 'issuewild').map((r) => r.value);
console.log(`  CAA : ${JSON.stringify(parsed.map((r) => `${r.tag}="${r.value}"`))}`);
const caaOk = caaRecords.length === 2 && issues.length === 1 && issues[0] === EXPECTED_ISSUE && wilds.length === 1 && wilds[0] === ';';
const oldUnbound = issues.some((v) => v.includes('letsencrypt.org') && !v.includes('accounturi'));
check('CAA remains exactly the approved account-bound policy', caaOk);
check('no old non-account-bound issue reappeared', !oldUnbound);
report.steps.push({ step: 'caa_reverify', records: parsed, exact_policy: caaOk, old_unbound: oldUnbound });

// ── §13 relay host still absent ─────────────────────────────────────────────
console.log('\n=== 13. VERIFY RELAY HOST STILL ABSENT ===');
const relayRecords = (await api('GET', `/zones/${zoneId}/dns_records?per_page=100`)).body.result ?? [];
const relayHits = relayRecords.filter((r) => r.name === RELAY);
console.log(`  ${RELAY} records : ${relayHits.length === 0 ? 'ABSENT' : JSON.stringify(relayHits.map((r) => r.type))}`);
check('relay.drm-jd.com A absent', !relayHits.some((r) => r.type === 'A'));
check('relay.drm-jd.com AAAA absent', !relayHits.some((r) => r.type === 'AAAA'));
check('relay.drm-jd.com CNAME absent', !relayHits.some((r) => r.type === 'CNAME'));
report.steps.push({ step: 'relay_absence', records: relayHits.map((r) => r.type), absent: relayHits.length === 0 });

// ── summary ─────────────────────────────────────────────────────────────────
const total = report.checks.length;
const passed = report.checks.filter((c) => c.pass).length;
report.total = total;
report.pass = passed;
report.marker_class = 'random non-secret, single-use';
report.acme_challenge_created = false;
report.acme_order_created = false;
console.log(`\n=== §7-§13: ${passed}/${total} checks passed ===`);
fs.mkdirSync('.r9-fixture-tools', { recursive: true });
fs.writeFileSync('.r9-fixture-tools/dns-dryrun.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log('  written: .r9-fixture-tools/dns-dryrun.json');
process.exit(passed === total ? 0 : 1);
