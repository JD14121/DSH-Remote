/**
 * R9-RELAY-03 GATE 3.4A — update delivery artifacts after the anchor-IP change.
 *
 * Updates the staging copy, recomputes hashes, refreshes the staging manifest, and re-scans the
 * non-secret package for any private key, token or credential.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PROD = 'config/r9/frps.production.toml';
const STAGE = 'D:\\r9-relay-staging';
const STAGED_CFG = path.join(STAGE, 'etc', 'frps.toml');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

console.log('=== before ===');
const prodHash = sha(PROD);
const stagedHashBefore = sha(STAGED_CFG);
console.log(`  production config : ${prodHash}`);
console.log(`  staging copy      : ${stagedHashBefore}`);
console.log(`  in sync           : ${prodHash === stagedHashBefore}`);

// ── 1. update the staging copy to match the approved production config ─────
fs.copyFileSync(PROD, STAGED_CFG);
const stagedHashAfter = sha(STAGED_CFG);
console.log('\n=== after ===');
console.log(`  staging copy      : ${stagedHashAfter}`);
console.log(`  in sync           : ${prodHash === stagedHashAfter}`);

// ── 2. confirm the staged copy carries the anchored binds ─────────────────
const stagedText = fs.readFileSync(STAGED_CFG, 'utf8');
const stagedBind = /^bindAddr = "([^"]+)"/m.exec(stagedText)?.[1];
const stagedProxyBind = /^proxyBindAddr = "([^"]+)"/m.exec(stagedText)?.[1];
const stagedPlugin = /^addr = "([^"]+)"/m.exec(stagedText)?.[1];
console.log(`  staged bindAddr      : ${stagedBind}`);
console.log(`  staged proxyBindAddr : ${stagedProxyBind}`);
console.log(`  staged plugin addr   : ${stagedPlugin}`);

// ── 3. refresh the staging manifest entry and hash ───────────────────────
const manifestPath = '.r9-fixture-tools/staging-manifest.json';
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const entry = manifest.files.find((f) => f.relative_path === 'etc/frps.toml');
const previousEntryHash = entry.sha256;
entry.sha256 = stagedHashAfter;
entry.size = fs.statSync(STAGED_CFG).size;
entry.role = 'frps production config (anchor-IP bound)';
manifest.config_parse_json_recomputed = true;
manifest.anchor_bind_change = {
  applied_in: 'R9-RELAY-03 Gate 3.4A',
  field: 'bindAddr + proxyBindAddr',
  from: '0.0.0.0',
  to: '10.15.0.5',
  previous_sha256: previousEntryHash,
  new_sha256: stagedHashAfter,
  fallback_to_wildcard_permitted: false,
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`\n=== manifest updated ===`);
console.log(`  etc/frps.toml sha256 : ${previousEntryHash} -> ${stagedHashAfter}`);

// ── 4. re-scan the non-secret package for secrets ────────────────────────
console.log('\n=== §3 secret re-scan of the non-secret deployment package ===');
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
console.log(`  files in package     : ${files.length}`);
console.log(`  private key PEM blocks: ${privateBlocks} (must be 0)`);

const secrets = [
  ['FRP app-auth token', 'D:\\r9-relay-secrets\\frp\\app-auth-token', 'raw'],
  ['Cloudflare DNS token', 'D:\\r9-relay-secrets\\cloudflare-dns-token', 'raw'],
  ['frps server leaf key', 'D:\\r9-relay-pki\\frp\\keys\\leaves\\frps-server.key', 'key'],
  ['frpc client leaf key', 'D:\\r9-relay-pki\\frp\\keys\\leaves\\frpc-client.key', 'key'],
  ['FRP Server CA key', 'D:\\r9-relay-pki\\frp\\keys\\server-ca\\server-ca.key', 'key'],
  ['FRP Client CA key', 'D:\\r9-relay-pki\\frp\\keys\\client-ca\\client-ca.key', 'key'],
  ['application HTTPS key', 'D:\\r9-relay-secrets\\https-server\\https-server.key', 'key'],
  ['ACME account key', 'D:\\r9-relay-acme\\accounts\\acme-v02.api.letsencrypt.org\\1300637954@qq.com\\1300637954@qq.com.key', 'key'],
];
const leaks = [];
for (const [label, p, kind] of secrets) {
  if (!fs.existsSync(p)) { console.log(`  ${label.padEnd(24)} source absent (nothing to compare)`); continue; }
  let present;
  if (kind === 'raw') {
    present = packageText.includes(fs.readFileSync(p, 'utf8').trim());
  } else {
    const der = crypto.createPrivateKey(fs.readFileSync(p)).export({ type: 'pkcs8', format: 'der' });
    present = packageText.includes(der.toString('latin1'));
  }
  if (present) leaks.push(label);
  console.log(`  ${label.padEnd(24)} ${present ? 'PRESENT — LEAK' : 'absent'}`);
}
const clean = privateBlocks === 0 && leaks.length === 0;
console.log(`\n  package clean: ${clean}`);

const result = {
  phase: 'R9-RELAY-03 Gate 3.4A',
  updatedAt: new Date().toISOString(),
  production_config_sha256: prodHash,
  staging_copy_sha256: stagedHashAfter,
  in_sync: prodHash === stagedHashAfter,
  manifest_updated: true,
  previous_staged_sha256: previousEntryHash,
  staged_bind_addr: stagedBind,
  staged_proxy_bind_addr: stagedProxyBind,
  staged_plugin_addr: stagedPlugin,
  package_file_count: files.length,
  private_key_blocks: privateBlocks,
  secret_leaks: leaks,
  package_clean: clean,
  vps_modified: false,
  secrets_transferred: false,
};
fs.writeFileSync('.r9-fixture-tools/r9relay03-gate34a-staging.json', `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log('\n  written: .r9-fixture-tools/r9relay03-gate34a-staging.json');
process.exit(clean && prodHash === stagedHashAfter ? 0 : 1);
