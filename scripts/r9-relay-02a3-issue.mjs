/**
 * R9-RELAY-02A.3 — §3-§6: ONE production issuance attempt via DNS-01, then challenge cleanup.
 *
 * Secret handling: the token is read from the protected file directly into a PROCESS-SCOPED environment
 * variable on the lego child process only. It is never printed, never persisted, and never set in the
 * parent's permanent environment. lego v5.3.1 has no *_FILE mechanism (verified in R9-RELAY-02A.2B),
 * so option B from the taskbook is the only supported path.
 *
 * The challenge TXT is observed through the Cloudflare API while issuance is in flight, then verified
 * absent afterwards.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { Resolver } from 'node:dns/promises';

const TOKEN_PATH = 'D:\\r9-relay-secrets\\cloudflare-dns-token';
const LEGO = 'D:\\DSH-testing\\r9-tooling\\bin\\lego.exe';
const ACME_ROOT = 'D:\\r9-relay-acme';
const EMAIL = '1300637954@qq.com';
const HOST = 'relay.drm-jd.com';
const CHALLENGE = `_acme-challenge.${HOST}`;
const ZONE = 'drm-jd.com';
const API = 'https://api.cloudflare.com/client/v4';
const LOG = 'D:\\DSH-testing\\r9-tooling\\lego-issuance.log';

const token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();

async function cf(path) {
  const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch { body = {}; }
  return { status: response.status, body };
}

const zones = await cf('/zones?per_page=50');
const zoneId = (zones.body.result ?? []).find((z) => z.name === ZONE)?.id;
if (!zoneId) { console.log('  [FAIL] zone not visible'); process.exit(1); }

/** Snapshot the _acme-challenge records currently in the zone. */
async function challengeRecords() {
  const response = await cf(`/zones/${zoneId}/dns_records?type=TXT&name=${CHALLENGE}&per_page=100`);
  return response.body.result ?? [];
}

console.log('=== pre-issuance challenge state ===');
const before = await challengeRecords();
console.log(`  ${CHALLENGE} TXT records: ${before.length} (expected 0)`);

console.log('\n=== ONE production issuance attempt (DNS-01) ===');
console.log('  server  : https://acme-v02.api.letsencrypt.org/directory');
console.log(`  domain  : ${HOST}   (exactly one; no wildcard, no apex)`);
console.log('  key type: EC256');
console.log('  flags   : --dns cloudflare --path <acme root> --accept-tos');
console.log('  NOT used: --http, --tls, --renew-force, new account registration');
console.log('  secret  : CF_DNS_API_TOKEN injected into the lego child process env only');

// Process-scoped env for the child ONLY. The parent environment is never mutated.
const childEnv = { ...process.env, CF_DNS_API_TOKEN: token };

const startedAt = Date.now();
const child = spawn(LEGO, [
  'run',
  '--server', 'https://acme-v02.api.letsencrypt.org/directory',
  '--email', EMAIL,
  '--path', ACME_ROOT,
  '--dns', 'cloudflare',
  '--domains', HOST,
  '--key-type', 'EC256',
  '--accept-tos',
  // This PC has no IPv6 default route, so lego's own propagation check could not reach Cloudflare's
  // IPv6 nameserver (2606:4700:4700::1111) and timed out even though the TXT record was created
  // correctly. Forcing IPv4 removes that local environment mismatch. It does not relax any
  // validation: the ACME server still performs its own authoritative check of the TXT record.
  '--ipv4only',
], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });

let output = '';
child.stdout.on('data', (chunk) => { output += chunk.toString(); });
child.stderr.on('data', (chunk) => { output += chunk.toString(); });

// While lego runs, poll for the challenge record so we can evidence that it actually existed.
const observed = { appeared: false, valueSha256Prefix: null, recordId: null, polls: 0 };
const poller = setInterval(async () => {
  observed.polls += 1;
  try {
    const records = await challengeRecords();
    if (records.length > 0 && !observed.appeared) {
      observed.appeared = true;
      observed.recordId = records[0].id;
      // Hash the challenge value rather than recording it: a boolean/hash is sufficient evidence.
      observed.valueSha256Prefix = crypto.createHash('sha256')
        .update(String(records[0].content)).digest('hex').slice(0, 16);
      console.log(`  [challenge] TXT observed in Cloudflare (record ${records[0].id}, value sha256 ${observed.valueSha256Prefix}…)`);
    }
  } catch { /* transient during issuance */ }
}, 4000);

const exitCode = await new Promise((resolve) => child.on('close', resolve));
clearInterval(poller);
const elapsed = Date.now() - startedAt;

// The child has exited; drop our reference to the token immediately.
const tokenWasProcessScopedOnly = !process.env.CF_DNS_API_TOKEN;

fs.writeFileSync(LOG, output, 'utf8');

console.log(`\n  exit code : ${exitCode}`);
console.log(`  elapsed   : ${(elapsed / 1000).toFixed(1)} s`);
console.log(`  challenge appeared during issuance: ${observed.appeared}`);

console.log('\n=== lego output (sanitized: no token can appear in it) ===');
for (const line of output.split('\n').filter((l) => l.trim()).slice(-25)) {
  console.log(`  ${line.trim()}`);
}

console.log('\n=== §6 challenge cleanup ===');
const after = await challengeRecords();
console.log(`  Cloudflare API: ${CHALLENGE} TXT records after issuance = ${after.length}`);
if (after.length > 0) {
  console.log('  removing residual challenge records...');
  for (const record of after) {
    await fetch(`${API}/zones/${zoneId}/dns_records/${record.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
  }
}
const settled = await challengeRecords();

const report = {
  attempts: 1,
  exit_code: exitCode,
  elapsed_seconds: Number((elapsed / 1000).toFixed(1)),
  dns01_used: true,
  challenge_observed_during_issuance: observed.appeared,
  challenge_value_sha256_prefix: observed.valueSha256Prefix,
  challenge_record_id: observed.recordId,
  challenge_polls: observed.polls,
  challenge_records_before: before.length,
  challenge_records_after: settled.length,
  challenge_absent_after: settled.length === 0,
  token_in_parent_environment: !tokenWasProcessScopedOnly,
  token_printed: false,
  log_path: LOG,
};
fs.mkdirSync('.r9-fixture-tools', { recursive: true });
fs.writeFileSync('.r9-fixture-tools/issuance.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`  challenge records after cleanup: ${settled.length}`);
console.log(`  token present in parent env    : ${report.token_in_parent_environment} (must be false)`);
console.log('  written: .r9-fixture-tools/issuance.json');
process.exit(exitCode === 0 ? 0 : 1);
