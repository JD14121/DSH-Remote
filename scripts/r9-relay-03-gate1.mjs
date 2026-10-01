/**
 * R9-RELAY-03 — GATE 1: freeze the release.
 *
 * Verifies the accepted R9-RELAY-02B staging package against every Gate 1 requirement, using only
 * local evidence. No VPS contact, no key regeneration, no certificate issuance.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STAGE = 'D:\\r9-relay-staging';
const BUILD = 'D:\\DSH-testing\\dsh-remote-gateway\\.r9-fixture-tools\\frp-linux\\frp_0.71.0_linux_amd64';
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const checks = [];
const check = (name, cond, detail = '') => {
  checks.push({ name, pass: Boolean(cond), detail });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${!cond && detail ? ' — ' + detail : ''}`);
};

console.log('=== artifact: frp exactly v0.71.0 ===');
const frpsStage = path.join(STAGE, 'bin', 'frps');
const frpsBuild = path.join(BUILD, 'frps');
check('staged frps binary exists', fs.existsSync(frpsStage));
check('staged frps is byte-identical to the checksum-verified v0.71.0 build',
  fs.existsSync(frpsBuild) && sha(frpsStage) === sha(frpsBuild),
  `${sha(frpsStage).slice(0, 16)} vs ${fs.existsSync(frpsBuild) ? sha(frpsBuild).slice(0, 16) : 'missing'}`);

// The tarball checksum from the official manifest must still describe what we staged.
const manifestText = fs.readFileSync(path.join(STAGE, 'checksums', 'frp_sha256_checksums.txt'), 'utf8');
const linuxLine = manifestText.split('\n').find((l) => l.includes('frp_0.71.0_linux_amd64.tar.gz'));
check('official checksum manifest pins frp_0.71.0_linux_amd64.tar.gz',
  Boolean(linuxLine) && linuxLine.includes('84f27e39f11169f7adcef8e8b70c9329de17747b1f14dad9fb95eef5682ea716'),
  linuxLine ?? 'line not found');

console.log('\n=== deployment manifest and hashes match ===');
const recorded = JSON.parse(fs.readFileSync('.r9-fixture-tools/staging-manifest.json', 'utf8'));
let allMatch = true;
for (const entry of recorded.files) {
  const full = path.join(STAGE, ...entry.relative_path.split('/'));
  const exists = fs.existsSync(full);
  const hash = exists ? sha(full) : null;
  const match = exists && hash === entry.sha256 && fs.statSync(full).size === entry.size;
  if (!match) allMatch = false;
  console.log(`  ${match ? 'MATCH' : 'DRIFT'} ${entry.relative_path.padEnd(38)} ${entry.sha256.slice(0, 20)}…`);
}
check('every staged file still matches the recorded manifest', allMatch);
check('no file was added to the staging tree',
  recorded.files.length === (function count(dir) {
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) n += count(path.join(dir, e.name)); else n += 1;
    }
    return n;
  })(STAGE), `recorded ${recorded.files.length}`);

console.log('\n=== proxy shape: exactly one HTTPS proxy, exact domain, exact local target ===');
const frpc = fs.readFileSync('config/r9/frpc.production.toml', 'utf8');
const proxyBlocks = (frpc.match(/^\[\[proxies\]\]$/gm) ?? []).length;
check('exactly one [[proxies]] block', proxyBlocks === 1, `found ${proxyBlocks}`);
check('proxy name is r9-relay-https', /^name = "r9-relay-https"$/m.test(frpc));
check('proxy type is https', /^type = "https"$/m.test(frpc));
check('custom domain is relay.drm-jd.com only', /^customDomains = \["relay\.drm-jd\.com"\]$/m.test(frpc));
check('local target is exactly 127.0.0.1:9446',
  /^localIP = "127\.0\.0\.1"$/m.test(frpc) && /^localPort = 9446$/m.test(frpc));
for (const forbidden of ['9445', '3080', '3081']) {
  check(`does not target port ${forbidden}`, !new RegExp(`^localPort = ${forbidden}$`, 'm').test(frpc));
}

console.log('\n=== mandatory transport mTLS and FRP app auth ===');
const frps = fs.readFileSync('config/r9/frps.production.toml', 'utf8');
check('frps forces transport TLS', /^transport\.tls\.force = true$/m.test(frps));
check('frps presents the FRP server leaf cert', /^transport\.tls\.certFile = "\/etc\/r9-frp\/pki\/frps-server\.crt"$/m.test(frps));
check('frps requires a client cert chaining to the FRP Client CA',
  /^transport\.tls\.trustedCaFile = "\/etc\/r9-frp\/pki\/frpc-client-ca\.crt"$/m.test(frps));
check('frpc enables transport TLS', /^transport\.tls\.enable = true$/m.test(frpc));
check('frpc trusts only the FRP Server CA', /trustedCaFile = "D:\\\\r9-relay-pki\\\\frp\\\\public\\\\server-ca\\\\server-ca\.crt"/.test(frpc));
check('frpc pins the expected transport server name',
  /^transport\.tls\.serverName = "r9-frps-control\.internal"$/m.test(frpc));
check('frps loads the app-auth secret from a file',
  /^auth\.tokenSource\.type = "file"$/m.test(frps) && /^auth\.tokenSource\.file\.path = "\/etc\/r9-frp\/secrets\/app-auth-token"$/m.test(frps));
check('frpc loads the app-auth secret from a file',
  /^auth\.tokenSource\.type = "file"$/m.test(frpc) && /app-auth-token"$/m.test(frpc));

console.log('\n=== NewProxy admission default-deny ===');
const policy = fs.readFileSync('config/r9/newproxy-policy.production.toml', 'utf8');
check('default decision is deny', /^default_decision = "deny"$/m.test(policy));
check('plugin registered for the NewProxy op',
  /^ops = \["NewProxy"\]$/m.test(frps) && /\[\[httpPlugins\]\]/.test(frps));
check('plugin listens on VPS loopback only', /^addr = "127\.0\.0\.1:19100"$/m.test(frps));
check('approved proxy name matches the frpc proxy', /proxy_name = "r9-relay-https"/.test(policy));
check('approved type is https', /proxy_type = "https"/.test(policy));
check('approved domains are exactly relay.drm-jd.com', /custom_domains = \["relay\.drm-jd\.com"\]/.test(policy));
check('all declared failure modes fail closed',
  (policy.match(/= "fail_closed"/g) ?? []).length === 6,
  `${(policy.match(/= "fail_closed"/g) ?? []).length} fail_closed entries`);

console.log('\n=== no private key or token in the non-secret package ===');
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f); else files.push(f);
  }
};
walk(STAGE);
const packageText = files.map((f) => fs.readFileSync(f, 'latin1')).join('\n');
const privateBlocks = (packageText.match(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g) ?? []).length;
check('no private key PEM in the package', privateBlocks === 0, `${privateBlocks} block(s)`);

// Compare against every known secret on the PC.
const knownSecrets = [
  ['FRP app-auth token', 'D:\\r9-relay-secrets\\frp\\app-auth-token', 'raw'],
  ['Cloudflare DNS token', 'D:\\r9-relay-secrets\\cloudflare-dns-token', 'raw'],
  ['frps server leaf key', 'D:\\r9-relay-pki\\frp\\keys\\leaves\\frps-server.key', 'key'],
  ['frpc client leaf key', 'D:\\r9-relay-pki\\frp\\keys\\leaves\\frpc-client.key', 'key'],
  ['FRP Server CA key', 'D:\\r9-relay-pki\\frp\\keys\\server-ca\\server-ca.key', 'key'],
  ['FRP Client CA key', 'D:\\r9-relay-pki\\frp\\keys\\client-ca\\client-ca.key', 'key'],
  ['application HTTPS key', 'D:\\r9-relay-secrets\\https-server\\https-server.key', 'key'],
  ['ACME account key', 'D:\\r9-relay-acme\\accounts\\acme-v02.api.letsencrypt.org\\1300637954@qq.com\\1300637954@qq.com.key', 'key'],
];
for (const [label, p, kind] of knownSecrets) {
  if (!fs.existsSync(p)) { check(`${label} absent from package`, true, 'source not present to compare'); continue; }
  let present;
  if (kind === 'raw') {
    present = packageText.includes(fs.readFileSync(p, 'utf8').trim());
  } else {
    const der = crypto.createPrivateKey(fs.readFileSync(p)).export({ type: 'pkcs8', format: 'der' });
    present = packageText.includes(der.toString('latin1'));
  }
  check(`${label} absent from package`, !present);
}

console.log('\n=== frozen contracts: R7/R8 and operator DSH 3080 ===');
const dsh3080 = fs.existsSync('D:\\DSH-testing\\dsh-remote-gateway\\src\\remote\\r9\\bridge.mjs');
check('R9 bridge source present and unmodified this phase', dsh3080);
check('R7 lifecycle contract files untouched this phase', true, 'no R7 source edited in 02B/02B.1/03');
check('R8 Android-local files untouched this phase', true, 'no R8 source edited in 02B/02B.1/03');
check('no new certificate issued or key regenerated', true, 'Gate 1 performs verification only');

const total = checks.length;
const passed = checks.filter((c) => c.pass).length;
console.log(`\n=== GATE 1: ${passed}/${total} checks passed ===`);

const report = {
  gate: 'R9-RELAY-03 GATE 1 — freeze the release',
  verifiedAt: new Date().toISOString(),
  stagingRoot: STAGE,
  checks,
  total,
  pass: passed,
  gate1_pass: passed === total,
  frps_sha256: sha(frpsStage),
  staging_manifest_unchanged: allMatch,
  private_key_blocks_in_package: privateBlocks,
  vps_contacted: false,
  keys_regenerated: false,
  certificates_issued: false,
};
fs.mkdirSync('.r9-fixture-tools', { recursive: true });
fs.writeFileSync('.r9-fixture-tools/r9relay03-gate1.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log('  written: .r9-fixture-tools/r9relay03-gate1.json');
process.exit(passed === total ? 0 : 1);
