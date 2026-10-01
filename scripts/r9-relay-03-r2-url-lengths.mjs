/**
 * R9-RELAY-03 GATE 2B R2 — establish the ACTUAL length of every proposed R2 URL.
 *
 * A presigned R2 (S3-compatible) URL is a single line. That matters because the Gate 2B failure
 * collapsed 47 lines into 1 and corrupted content — consistent with a newline-handling defect, NOT a
 * proven byte ceiling (that assertion was withdrawn). A single-line URL is therefore a materially
 * different test case, but its length still has to be known rather than assumed.
 *
 * No R2 account is touched here. Lengths are computed from the documented SigV4 query-parameter
 * structure, with every component itemised so the arithmetic can be checked by hand and re-measured
 * against a real URL in the operator's verification step.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const checks = [];
const note = (name, value, detail = '') => {
  checks.push({ name, value, detail });
  console.log(`  ${name.padEnd(46)} ${value}${detail ? '  ' + detail : ''}`);
};

console.log('=== component lengths (SigV4 presigned URL, R2 S3 API) ===');

// R2 account IDs are 32 lowercase hex characters — deterministic length even though the value is unknown.
const ACCOUNT_ID_LEN = 32;
const BUCKET = 'r9-relay-gate2b-synthetic';
const JURISDICTION = 'https://<account_id>.r2.cloudflarestorage.com';

const components = {
  'scheme+host (r2.cloudflarestorage.com)': 'https://'.length + '<account_id>'.length + '.r2.cloudflarestorage.com'.length,
  'account_id actual (32 hex)': 'https://'.length + ACCOUNT_ID_LEN + '.r2.cloudflarestorage.com'.length,
  'bucket path (path-style)': `/${BUCKET}`.length,
  'object key (measured, e.g. pk/r9-<16hex>.pem)': '/pk/r9-0000000000000000.pem'.length,
};

for (const [k, v] of Object.entries(components)) note(k, v);

// Query parameters, with realistic lengths for each.
const q = {
  'X-Amz-Algorithm=AWS4-HMAC-SHA256': 'X-Amz-Algorithm=AWS4-HMAC-SHA256'.length,
  'X-Amz-Credential=<32hex>/<date>/auto/s3/aws4_request': 'X-Amz-Credential='.length + 32 + 1 + 8 + 1 + 4 + 1 + 2 + 1 + 12,
  'X-Amz-Date=<16>': 'X-Amz-Date='.length + 16,
  'X-Amz-Expires=<4>': 'X-Amz-Expires='.length + 4,
  'X-Amz-SignedHeaders=host': 'X-Amz-SignedHeaders=host'.length,
  'X-Amz-Signature=<64hex>': 'X-Amz-Signature='.length + 64,
};

console.log('\n=== query parameter lengths ===');
let queryTotal = 0;
for (const [k, v] of Object.entries(q)) {
  queryTotal += v;
  note(k, v);
}
queryTotal += Object.keys(q).length - 1; // '&' separators
note('separators (&)', Object.keys(q).length - 1);
note('QUERY TOTAL', queryTotal);

const basePath = 'https://'.length + ACCOUNT_ID_LEN + '.r2.cloudflarestorage.com'.length
  + `/${BUCKET}`.length + '/pk/r9-0000000000000000.pem'.length;

const variants = {
  'presigned GET, path-style, minimal signed headers': basePath + 1 + queryTotal,
  'presigned PUT, path-style, minimal signed headers': basePath + 1 + queryTotal,
  'presigned with X-Amz-Security-Token (R2 API tokens usually avoid this)':
    basePath + 1 + queryTotal + '&X-Amz-Security-Token='.length + 200,
  'presigned with extra signed headers (content-type, content-length)':
    basePath + 1 + queryTotal + '&X-Amz-SignedHeaders='.length - 'X-Amz-SignedHeaders=host'.length + 'host;content-type;content-length'.length,
  'virtual-hosted style (bucket in hostname)': 'https://'.length + BUCKET.length + 1 + ACCOUNT_ID_LEN + '.r2.cloudflarestorage.com'.length
    + '/pk/r9-0000000000000000.pem'.length + 1 + queryTotal,
};

console.log('\n=== computed URL lengths ===');
for (const [k, v] of Object.entries(variants)) note(k, `${v} chars`);

console.log('\n=== comparison points ===');
note('failed multi-line paste (observed)', '3611 bytes / 47 lines', 'CORRUPTED, 763 bytes arrived');
note('37-byte probe (earlier, single line)', '37 bytes', 'verifiable, but too small to prove anything');
note('shortest R2 variant above', `${Math.min(...Object.values(variants))} chars`, 'single line');
note('longest R2 variant above', `${Math.max(...Object.values(variants))} chars`, 'single line');

console.log('\n=== the actual question: single-line feasibility ===');
const shortest = Math.min(...Object.values(variants));
const longest = Math.max(...Object.values(variants));
console.log(`  All R2 URL variants are SINGLE-LINE, ${shortest}-${longest} characters.`);
console.log('  They differ in kind from the failed attempt, which was 47 lines:');
console.log('    the observed failure collapsed newlines and corrupted content,');
console.log('    so a single-line value is a DIFFERENT test case, not merely a smaller one.');
console.log('');
console.log('  This is NOT a claim that any specific length is safe. The failed attempt');
console.log('  establishes no ceiling (that assertion was withdrawn). Feasibility must be');
console.log('  MEASURED with a real URL before any real transfer — see the verification plan.');

// A reproducible measurement harness the operator runs against a REAL presigned URL.
const measureScript = `#!/usr/bin/env node
/**
 * Measure a REAL presigned URL. Run this on the PC once a URL exists.
 * Reports length, line count, and whether the whole value is a single ASCII line.
 */
const url = process.argv[2];
if (!url) { console.error('usage: node measure-url.mjs "<presigned url>"'); process.exit(2); }
const ascii = /^[\\x20-\\x7e]+$/.test(url);
console.log(JSON.stringify({
  chars: url.length,
  lines: url.split(/\\r?\\n/).length,
  single_line: !/[\\r\\n]/.test(url),
  ascii_printable_only: ascii,
  contains_space: / /.test(url),
  contains_plus: /\\+/.test(url),
  contains_percent_encoding: /%[0-9A-Fa-f]{2}/.test(url),
  host: (() => { try { return new URL(url).host; } catch { return null; } })(),
  query_param_count: (() => { try { return [...new URL(url).searchParams.keys()].length; } catch { return null; } })(),
}, null, 2));
`;
fs.mkdirSync('.r9-fixture-tools', { recursive: true });
fs.writeFileSync('.r9-fixture-tools/measure-r2-url.mjs', measureScript, 'utf8');

const report = {
  measuredAt: new Date().toISOString(),
  r2_accounts_contacted: false,
  r2_credentials_used: false,
  anything_uploaded: false,
  method: 'computed from the documented SigV4 query structure; all components itemised',
  account_id_length: ACCOUNT_ID_LEN,
  bucket: BUCKET,
  component_lengths: components,
  query_parameter_lengths: q,
  query_total: queryTotal,
  url_variants: variants,
  shortest_chars: shortest,
  longest_chars: longest,
  all_variants_single_line: true,
  failed_paste_bytes: 3611,
  failed_paste_lines: 47,
  failed_paste_arrived_bytes: 763,
  ceiling_claimed: false,
  feasibility: 'MUST BE MEASURED with a real URL before any real transfer; no length is claimed safe',
};
fs.writeFileSync('.r9-fixture-tools/r9relay03-r2-url-lengths.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log('\n  written: .r9-fixture-tools/r9relay03-r2-url-lengths.json');
console.log('  written: .r9-fixture-tools/measure-r2-url.mjs  (run against a REAL url to confirm)');
