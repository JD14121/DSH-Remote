/**
 * R9-RELAY-02A.2B (continued) — §3-§6: token validity, zone access, pre-write DNS inventory.
 *
 * The token is read from the ACL-protected file into process memory only. It is never printed, never
 * placed in an environment variable, and never written to evidence. Only non-secret results are kept.
 */
import fs from 'node:fs';

const TOKEN_PATH = 'D:\\r9-relay-secrets\\cloudflare-dns-token';
const ZONE_NAME = 'drm-jd.com';
const API = 'https://api.cloudflare.com/client/v4';
const DRYRUN = `_r9-acme-dryrun.${ZONE_NAME}`;
const RELAY = `relay.${ZONE_NAME}`;
const EXPECTED_ISSUE = 'letsencrypt.org;validationmethods=dns-01;accounturi=https://acme-v02.api.letsencrypt.org/acme/acct/3780342786';

const report = { checks: [], errors: [] };
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
  try { parsed = JSON.parse(text); } catch { parsed = { raw_error: text.slice(0, 120) }; }
  return { status: response.status, body: parsed };
}

// ── §3 token validity ───────────────────────────────────────────────────────
console.log('=== 3. VERIFY TOKEN ACTIVE ===');
const verify = await api('GET', '/user/tokens/verify');
const vres = verify.body.result ?? {};
console.log(`  http status    : ${verify.status}`);
console.log(`  success        : ${verify.body.success}`);
console.log(`  result.status  : ${vres.status}`);
console.log(`  token id       : ${vres.id ?? '(not returned)'}`);
const tokenActive = verify.status === 200 && verify.body.success === true && vres.status === 'active';
check('token verify success = true', verify.body.success === true);
check('result.status = active', vres.status === 'active', String(vres.status));
report.token_verify = {
  http_status: verify.status,
  success: verify.body.success === true,
  status: vres.status ?? null,
  token_identifier: vres.id ?? null,
  authorization_header_recorded: false,
};

// ── §4 expected zone access ─────────────────────────────────────────────────
console.log('\n=== 4. VERIFY EXPECTED ZONE ACCESS ===');
const zones = await api('GET', '/zones?per_page=50');
const visible = (zones.body.result ?? []).map((z) => ({ name: z.name, status: z.status, id: z.id }));
console.log(`  zones visible  : ${JSON.stringify(visible.map((z) => `${z.name} (${z.status})`))}`);
const target = visible.find((z) => z.name === ZONE_NAME);
check('drm-jd.com is accessible to this token', target !== undefined);
check('drm-jd.com status is active', target?.status === 'active', String(target?.status));
report.zone_access = {
  zones_visible: visible.map((z) => ({ name: z.name, status: z.status })),
  target_visible: target !== undefined,
  target_status: target?.status ?? null,
  zone_id: target?.id ?? null,
};

// ── §5 scope claim precision ────────────────────────────────────────────────
console.log('\n=== 5. SCOPE CLAIM PRECISION ===');
const zoneCount = visible.length;
const onlyTarget = zoneCount === 1 && visible[0].name === ZONE_NAME;
console.log(`  zones visible to token : ${zoneCount}`);
if (onlyTarget) {
  console.log('  NOTE: only the intended zone is visible. This is CONSISTENT with a specific-zone token,');
  console.log('        but a single-zone account cannot distinguish "scoped to this zone" from');
  console.log('        "account has only this zone". It is NOT an independent negative test.');
} else {
  console.log('  NOTE: more than one zone is visible, so a specific-zone restriction is NOT demonstrated.');
}
report.scope_evidence = {
  zones_visible_count: zoneCount,
  specific_zone_restriction: onlyTarget
    ? 'OPERATOR-CONFIGURED + FUNCTIONALLY CONSISTENT'
    : 'NOT DEMONSTRATED',
  independently_negative_tested: false,
  limitation: 'no second zone exists to attempt an unauthorized read, so the restriction is not independently negative-tested',
  operator_declared_scope: ['Zone / Zone / Read', 'Zone / DNS / Edit', `specific zone = ${ZONE_NAME}`],
  broader_permissions_requested: false,
  second_zone_created: false,
};

const zoneId = target?.id;
if (!zoneId) {
  console.log('\n  cannot continue without the zone id');
  fs.writeFileSync('.r9-fixture-tools/token-verify.json', `${JSON.stringify(report, null, 2)}\n`);
  process.exit(1);
}

// ── §6 pre-dry-run DNS inventory ────────────────────────────────────────────
console.log('\n=== 6. PRE-DRY-RUN DNS INVENTORY (no writes) ===');
const records = await api('GET', `/zones/${zoneId}/dns_records?per_page=100`);
const all = records.body.result ?? [];
console.log(`  total records in zone : ${all.length}`);

const caa = all.filter((r) => r.type === 'CAA');
const dryrun = all.filter((r) => r.name === DRYRUN);
const relay = all.filter((r) => r.name === RELAY);

/**
 * Cloudflare returns a CAA record's `content` in presentation form, e.g.
 *     0 issue "letsencrypt.org;validationmethods=dns-01;accounturi=..."
 * so the tag and the quoted value must be extracted before comparing to the policy value. Comparing
 * the raw content directly would never match.
 */
const parseCaa = (content) => {
  const match = /^(\d+)\s+(\S+)\s+"?(.*?)"?$/.exec(String(content).trim());
  return match ? { flags: Number(match[1]), tag: match[2], value: match[3] } : { flags: null, tag: null, value: String(content) };
};
const caaParsed = caa.map((r) => parseCaa(r.content));
const caaIssues = caaParsed.filter((r) => r.tag === 'issue').map((r) => r.value);
const caaWilda = caaParsed.filter((r) => r.tag === 'issuewild').map((r) => r.value);

console.log(`  CAA records           : ${JSON.stringify(caaParsed.map((r) => `${r.tag}="${r.value}"`))}`);
console.log(`  ${DRYRUN} : ${dryrun.length === 0 ? 'ABSENT' : JSON.stringify(dryrun.map((r) => r.content))}`);
console.log(`  ${RELAY} : ${relay.length === 0 ? 'ABSENT' : JSON.stringify(relay.map((r) => `${r.type}`))}`);

const caaOk = caa.length === 2
  && caaIssues.length === 1 && caaIssues[0] === EXPECTED_ISSUE
  && caaWilda.length === 1 && caaWilda[0] === ';';
check('CAA is exactly the approved two-record policy', caaOk, JSON.stringify(caaParsed));
check('no old non-account-bound issue record', !caaIssues.some((v) => v.includes('letsencrypt.org') && !v.includes('accounturi')));
check('no unexpected issue/issuewild authorization', caaIssues.length === 1 && caaWilda.length === 1);
check('_r9-acme-dryrun is absent before the test', dryrun.length === 0);
check('relay.drm-jd.com has no A/AAAA/CNAME record', relay.filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type)).length === 0);

report.pre_inventory = {
  total_records: all.length,
  caa_raw: caa.map((r) => r.content),
  caa_parsed: caaParsed,
  caa_exactly_approved_policy: caaOk,
  old_unbound_issue_present: caaIssues.some((v) => v.includes('letsencrypt.org') && !v.includes('accounturi')),
  dryrun_absent: dryrun.length === 0,
  relay_absent: relay.length === 0,
  record_types_present: [...new Set(all.map((r) => r.type))].sort(),
};

const total = report.checks.length;
const passed = report.checks.filter((c) => c.pass).length;
report.total = total;
report.pass = passed;
console.log(`\n=== §3-§6: ${passed}/${total} checks passed ===`);
fs.mkdirSync('.r9-fixture-tools', { recursive: true });
fs.writeFileSync('.r9-fixture-tools/token-verify.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log('  written: .r9-fixture-tools/token-verify.json');
process.exit(passed === total ? 0 : 1);
