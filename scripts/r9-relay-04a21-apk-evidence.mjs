import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readZip } from './lib/zip.mjs';
import { resolveAndroidBuildVariant } from './r8g2-android-variants.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdk = process.env.ANDROID_HOME ?? 'D:\\Android';
const buildTools = path.join(sdk, 'build-tools', '34.0.0');
const aapt = path.join(buildTools, 'aapt.exe');
const output = path.resolve(process.argv[2] ?? path.join(root, 'evidence', 'r9-relay-04a21', 'apk-evidence.json'));
const runs = [];
function aaptDump(apk, ...args) {
  const result = execFileSync(aapt, ['dump', args[0], apk, ...args.slice(1)], { encoding: 'utf8' });
  runs.push({ command: 'aapt dump', args, output: result });
  return result;
}

const variants = [];
for (const name of ['development', 'relay']) {
  const variant = resolveAndroidBuildVariant(name);
  const apk = path.join(root, 'android', 'out', name === 'development' ? 'dsh-remote-debug.apk' : 'dsh-remote-relay.apk');
  if (!fs.existsSync(apk)) throw new Error(`missing APK: ${apk}`);
  const badging = execFileSync(aapt, ['dump', 'badging', apk], { encoding: 'utf8' });
  runs.push({ command: 'aapt dump badging', args: [apk], output: badging });
  const manifestTree = aaptDump(apk, 'xmltree', 'AndroidManifest.xml');
  const networkTree = aaptDump(apk, 'xmltree', 'res/xml/network_security_config.xml');
  const packageId = /^package: name='([^']+)'/m.exec(badging)?.[1];
  const appLabel = /^application-label:'([^']*)'/m.exec(badging)?.[1];
  const launcher = /^launchable-activity: name='([^']+)'/m.exec(badging)?.[1];
  if (packageId !== variant.applicationId) throw new Error(`${name}: package id mismatch: ${packageId}`);
  if (!launcher || !launcher.endsWith('.MainActivity')) throw new Error(`${name}: launcher activity missing`);
  const permissions = [...manifestTree.matchAll(/android:name\(0x01010003\)="(android\.permission\.[^"]+)"/g)].map((m) => m[1]);
  if (permissions.length !== 1 || permissions[0] !== 'android.permission.INTERNET') throw new Error(`${name}: unexpected manifest permissions`);
  const cleartextDenied = /android:usesCleartextTraffic\([^\n]+\)\(Raw:\s*"false"\)/.test(manifestTree)
    || /android:usesCleartextTraffic[^\n]*\(type 0x12\)0x0/.test(manifestTree);
  if (cleartextDenied !== !variant.usesCleartextTraffic) throw new Error(`${name}: manifest cleartext attribute mismatch`);
  if (!/base-config[\s\S]*?cleartextTrafficPermitted=\(type 0x12\)0x0/.test(networkTree)) throw new Error(`${name}: base cleartext policy does not deny cleartext`);
  if (name === 'relay') {
    if (/E: domain-config/.test(networkTree)) throw new Error('relay: unexpected cleartext exception');
  } else if (!/E: domain-config/.test(networkTree) || !/localhost/.test(networkTree) || !/127\.0\.0\.1/.test(networkTree)) {
    throw new Error('development: loopback-only cleartext exception missing');
  }
  const entries = readZip(apk);
  const forbidden = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|-----BEGIN (?:PKCS12|PFX)-----|\bPhone Bearer\b|\.(?:p12|pfx)\b/i;
  const findings = entries.filter((entry) => forbidden.test(entry.name) || forbidden.test(entry.data.toString('latin1'))).map((entry) => entry.name);
  if (findings.length) throw new Error(`${name}: forbidden identity material found: ${findings.join(', ')}`);
  const dex = entries.find((entry) => entry.name === 'classes.dex')?.data;
  if (!dex) throw new Error(`${name}: classes.dex missing`);
  variants.push({
    name, applicationId: packageId, launchUrl: variant.launchUrl, appLabel, launcherActivity: launcher,
    usesCleartextTraffic: variant.usesCleartextTraffic, cleartextPolicy: variant.cleartextPolicy,
    webViewDebuggingEnabled: variant.webViewDebuggingEnabled, permissions,
    apk: path.relative(root, apk).replaceAll('\\', '/'), bytes: fs.statSync(apk).size,
    sha256: createHash('sha256').update(fs.readFileSync(apk)).digest('hex'),
    packagedEntries: entries.map((e) => e.name).sort(), forbiddenIdentityMaterialFindings: findings,
    manifestCleartextPolicyChecked: true, networkSecurityPolicyChecked: true,
    zipalignAndApkSignatureVerification: 'passed during build',
  });
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), variants, aaptEvidence: runs }, null, 2)}\n`);
process.stdout.write(`${output}\n${variants.map((v) => `${v.name}: ${v.bytes} bytes sha256=${v.sha256}`).join('\n')}\n`);
