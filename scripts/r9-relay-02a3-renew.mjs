/**
 * R9-RELAY-02A.3 — §18 certificate renewal, PREPARED ONLY.
 *
 * ============================ NOT SCHEDULED ============================
 * This script is deliberately NOT registered with Task Scheduler and is not run automatically.
 * It exists as the reviewed, ready-to-run renewal path. Enabling a schedule requires separate
 * human authorisation.
 * =======================================================================
 *
 * lego v5 semantics: `lego run` IS the renewal path. v5 removed the old standalone `renew` command
 * and exposes renewal controls through `run`. Running it again for the same domain is idempotent:
 * lego checks the stored certificate and only reissues when it is due (or when --renew-force is
 * given, which this script never uses routinely).
 *
 * Properties this workflow guarantees, matching the taskbook requirements:
 *   * reads the SAME ACME account (D:\r9-relay-acme)
 *   * uses the SAME protected Cloudflare credential file
 *   * uses DNS-01 only
 *   * requests exactly relay.drm-jd.com
 *   * copies the renewed certificate to the bridge deployment directory atomically
 *   * never opens 80 or 443 locally for ACME validation (DNS-01 needs no inbound listener)
 *
 * Usage (manual, when renewal is due):
 *   node scripts/r9-relay-02a3-renew.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TOKEN_PATH = 'D:\\r9-relay-secrets\\cloudflare-dns-token';
const LEGO = 'D:\\DSH-testing\\r9-tooling\\bin\\lego.exe';
const ACME_ROOT = 'D:\\r9-relay-acme';
const EMAIL = '1300637954@qq.com';
const HOST = 'relay.drm-jd.com';
const ISSUED = path.join(ACME_ROOT, 'certificates', 'relay.drm-jd.com.crt');
const DEPLOY_DIR = 'D:\\r9-relay-secrets\\https-server';

// Refuse to run if anything is off before touching the certificate.
for (const required of [TOKEN_PATH, LEGO, ISSUED]) {
  if (!fs.existsSync(required)) {
    console.error(`  ABORT: required path missing: ${required}`);
    process.exit(1);
  }
}

const current = new crypto.X509Certificate(fs.readFileSync(ISSUED));
const lifetimeDays = Math.round((new Date(current.validTo) - new Date(current.validFrom)) / 86400000);
const daysRemaining = Math.floor((new Date(current.validTo).getTime() - Date.now()) / 86400000);
const threshold = Math.floor(lifetimeDays / 3);

console.log('R9 certificate renewal');
console.log('======================');
console.log(`  current expiry : ${current.validTo}`);
console.log(`  days remaining : ${daysRemaining} (renew threshold ${threshold})`);

if (daysRemaining > threshold && !process.argv.includes('--force')) {
  console.log('  not yet due — nothing to do. (Use --force only for a deliberate early rotation.)');
  process.exit(0);
}

// Process-scoped credential ONLY: never a permanent User/System environment variable.
const token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
const childEnv = { ...process.env, CF_DNS_API_TOKEN: token };

console.log('  requesting an updated certificate via DNS-01...');
const child = spawn(LEGO, [
  'run',
  '--server', 'https://acme-v02.api.letsencrypt.org/directory',
  '--email', EMAIL,
  '--path', ACME_ROOT,
  '--dns', 'cloudflare',
  '--domains', HOST,
  '--key-type', 'EC256',
  '--accept-tos',
  // See R9-RELAY-02A.3: this host has no IPv6 route, so lego's propagation check must use IPv4.
  '--ipv4only',
], { env: childEnv, stdio: ['ignore', 'inherit', 'inherit'] });

const exitCode = await new Promise((resolve) => child.on('close', resolve));
if (exitCode !== 0) {
  console.error(`  renewal FAILED (exit ${exitCode}). The existing certificate is untouched.`);
  process.exit(exitCode);
}

// ── atomic deployment ───────────────────────────────────────────────────────
// Write to a temporary name in the SAME directory, then rename over the target. A rename within one
// volume is atomic, so a reader never sees a partially written certificate.
const renewed = fs.readFileSync(ISSUED);
const renewedKey = fs.readFileSync(path.join(ACME_ROOT, 'certificates', 'relay.drm-jd.com.key'));

function atomicWrite(target, data) {
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, target);
}

for (const [name, data] of [
  ['https-server.fullchain.crt', renewed],
  ['https-server.crt', renewed],
  ['https-server.key', renewedKey],
]) {
  atomicWrite(path.join(DEPLOY_DIR, name), data);
}

// The bridge must reload the new certificate. In R9-RELAY-03 the production bridge is a supervised
// service; a restart is the simplest correct reload, and restarting it does NOT touch R7 or the DSH.
console.log('  deployment updated atomically.');
console.log('  NEXT STEP (manual, not automated): restart the R9 bridge service so it reloads the');
console.log('  certificate. Do NOT restart the operator DSH or the supervised DSH.');
console.log('  NOTE: scheduling this script is NOT enabled and requires separate authorisation.');

const after = new crypto.X509Certificate(fs.readFileSync(path.join(DEPLOY_DIR, 'https-server.crt')));
console.log(`  deployed certificate now expires: ${after.validTo}`);
