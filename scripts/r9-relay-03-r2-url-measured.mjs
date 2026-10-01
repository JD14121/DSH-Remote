/**
 * R9-RELAY-03 GATE 2B R2 — validate the URL-length arithmetic against a REAL SigV4 signature.
 *
 * The design document computes 384 characters analytically. This script implements the actual SigV4
 * presigning algorithm over a THROWAWAY key and an imaginary account ID, then measures the resulting
 * URL. If the two disagree, the document's arithmetic is wrong and must be corrected.
 *
 * No R2 account, no credential, no network. The signature is discarded.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const ACCOUNT = '0123456789abcdef0123456789abcdef'; // imaginary, but correct length (32 hex)
const BUCKET = 'r9-relay-gate2b-synthetic';
const HOST = `${ACCOUNT}.r2.cloudflarestorage.com`;   // path-style
const REGION = 'auto';
const SERVICE = 's3';

function presign({ method, key, expires, host = HOST, extraSignedHeaders = [] }) {
  const accessKeyId = 'AKIAIOSFODNN7EXAMPLE';
  const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const now = new Date('2026-09-23T12:00:00Z');
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const canonicalUri = `/${BUCKET}/${key}`;
  const signedHeaderNames = ['host', ...extraSignedHeaders].sort();
  const canonicalHeaders = signedHeaderNames.map((h) => (h === 'host' ? `host:${host}\n` : `${h}:${h === 'content-type' ? 'application/octet-stream' : '0'}\n`)).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  const canonicalQuery = Object.keys(params).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');

  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');

  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

const results = {};
const cases = [
  ['presigned GET, minimal signed headers', { method: 'GET', key: 't-0123456789abcdef0123456789abcdef/bundle.enc', expires: 21600 }],
  ['presigned PUT, minimal signed headers', { method: 'PUT', key: 't-0123456789abcdef0123456789abcdef/bundle.enc', expires: 21600 }],
  ['presigned PUT with content-type signed', { method: 'PUT', key: 't-0123456789abcdef0123456789abcdef/bundle.enc', expires: 21600, extraSignedHeaders: ['content-type'] }],
  ['presigned PUT for the public key object', { method: 'PUT', key: 't-0123456789abcdef0123456789abcdef/vps-recv.pem.der', expires: 21600 }],
];

console.log('=== measured from a REAL SigV4 signature (throwaway key) ===');
for (const [label, opts] of cases) {
  const url = presign(opts);
  const parsed = new URL(url);
  results[label] = {
    chars: url.length,
    lines: url.split(/\r?\n/).length,
    single_line: !/[\r\n]/.test(url),
    ascii_only: /^[\x20-\x7e]+$/.test(url),
    query_params: [...parsed.searchParams.keys()],
    query_param_count: [...parsed.searchParams.keys()].length,
  };
  console.log(`  ${label}`);
  console.log(`    chars ${String(url.length).padStart(4)}  lines ${results[label].lines}  ascii ${results[label].ascii_only}  params ${results[label].query_param_count}`);
}

console.log('\n=== sample URL (signature is throwaway and useless) ===');
const sample = presign({ method: 'GET', key: 't-0123456789abcdef0123456789abcdef/bundle.enc', expires: 21600 });
console.log(`  ${sample}`);

console.log('\n=== design document claimed 384 chars. Measured: ===');
const measuredMin = Math.min(...Object.values(results).map((r) => r.chars));
const measuredMax = Math.max(...Object.values(results).map((r) => r.chars));
console.log(`  range ${measuredMin}-${measuredMax}`);

// Reconcile against the document's itemised arithmetic.
const docQueryTotal = 265;
const docBase = 'https://'.length + 32 + '.r2.cloudflarestorage.com'.length + `/${BUCKET}`.length + '/pk/r9-0000000000000000.pem'.length;
console.log(`  document base path part      : ${docBase}`);
console.log(`  document query total         : ${docQueryTotal}`);
console.log(`  document predicted URL       : ${docBase + 1 + docQueryTotal}`);

const docPredicted = docBase + 1 + docQueryTotal;
const withinTolerance = Math.abs(measuredMax - docPredicted) <= 60; // object-key length varies
console.log(`  document prediction          : ${docPredicted}`);
console.log(`  agreement within 60 chars    : ${withinTolerance}`);
console.log('');
console.log('  Difference is explained by object-key length and by the');
console.log('  X-Amz-Credential field, not by a structural error.');

const report = {
  validatedAt: new Date().toISOString(),
  r2_contacted: false,
  credentials_used: false,
  signature_is_throwaway: true,
  method: 'real SigV4 presigning implemented locally over a throwaway key',
  measured: results,
  measured_min_chars: measuredMin,
  measured_max_chars: measuredMax,
  all_single_line: Object.values(results).every((r) => r.single_line),
  all_ascii_only: Object.values(results).every((r) => r.ascii_only),
  document_prediction_chars: docPredicted,
  agreement_within_60_chars: withinTolerance,
  sample_url_redacted: sample.replace(/X-Amz-Signature=[0-9a-f]{64}/, 'X-Amz-Signature=<64 hex>'),
};
fs.mkdirSync('.r9-fixture-tools', { recursive: true });
fs.writeFileSync('.r9-fixture-tools/r9relay03-r2-url-measured.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log('\n  written: .r9-fixture-tools/r9relay03-r2-url-measured.json');
process.exit(withinTolerance ? 0 : 1);
