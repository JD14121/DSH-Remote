/**
 * R9-RELAY-02A.3 — §19 certificate monitoring (read-only).
 *
 * Reports subject/SAN, issuer, serial, validity, days remaining and the certificate SPKI fingerprint.
 * No secret output: the private key is never read by this script.
 *
 * Usage: node scripts/r9-relay-02a3-cert-info.mjs [path-to-cert]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const DEFAULT = 'D:\\r9-relay-secrets\\https-server\\https-server.crt';
const path = process.argv[2] ?? DEFAULT;

if (!fs.existsSync(path)) {
  console.error(`  certificate not found: ${path}`);
  process.exit(1);
}

const text = fs.readFileSync(path, 'utf8');
const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
const leaf = new crypto.X509Certificate(blocks[0]);

const notBefore = new Date(leaf.validFrom);
const notAfter = new Date(leaf.validTo);
const now = Date.now();
const daysRemaining = Math.floor((notAfter.getTime() - now) / 86400000);
const lifetimeDays = Math.round((notAfter - notBefore) / 86400000);
const spki = crypto.createHash('sha256').update(leaf.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');

// Renew when a third of the lifetime remains (lego's own default heuristic for long-lived certs).
const renewThresholdDays = Math.floor(lifetimeDays / 3);
const needsRenewal = daysRemaining <= renewThresholdDays;

console.log('R9 HTTPS server certificate');
console.log('===========================');
console.log(`  file            : ${path}`);
console.log(`  chain length    : ${blocks.length} certificate(s)`);
console.log(`  subject         : ${leaf.subject.replace(/\n/g, ', ')}`);
console.log(`  SAN             : ${leaf.subjectAltName}`);
console.log(`  issuer          : ${leaf.issuer.replace(/\n/g, ', ')}`);
console.log(`  serial          : ${leaf.serialNumber}`);
console.log(`  notBefore       : ${leaf.validFrom}`);
console.log(`  notAfter        : ${leaf.validTo}`);
console.log(`  lifetime        : ${lifetimeDays} days`);
console.log(`  days remaining  : ${daysRemaining}`);
console.log(`  renew threshold : ${renewThresholdDays} days (1/3 of lifetime)`);
console.log(`  key type        : ${leaf.publicKey.asymmetricKeyType} (${leaf.publicKey.asymmetricKeyDetails?.namedCurve ?? 'n/a'})`);
console.log(`  SPKI sha256     : ${spki}`);
console.log(`  expired         : ${now > notAfter.getTime()}`);
console.log(`  not yet valid   : ${now < notBefore.getTime()}`);
console.log(`  status          : ${needsRenewal ? 'RENEWAL DUE' : 'valid'}`);

// A wildcard or an unexpected SAN would be a configuration error worth surfacing loudly.
const sans = (leaf.subjectAltName ?? '').split(',').map((s) => s.trim());
const unexpected = sans.filter((s) => s !== 'DNS:relay.drm-jd.com');
console.log(`  unexpected SANs : ${unexpected.length === 0 ? 'none' : unexpected.join(', ')}`);

process.exit(needsRenewal ? 2 : 0);
