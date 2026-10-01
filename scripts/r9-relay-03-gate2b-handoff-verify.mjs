/**
 * R9-RELAY-03 GATE 2B — independent verification of the handoff material.
 *
 * Recomputes every claim from the file bytes rather than repeating what the generator printed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const B64 = '.r9-fixture-tools/r9relay03-paste-test/payload.b64';
const EXPECTED_SHA = '083b9971d6bbf203fab522b5d09ec6d7e846eb5dd0a74704787502df71efe2a8';

const raw = fs.readFileSync(B64);
const text = raw.toString('utf8');

// Line and character accounting, stated precisely so the numbers cannot be misread.
const endsWithNewline = text.endsWith('\n');
const contentLines = text.split('\n').filter((l) => l.length > 0);          // non-empty base64 lines
const splitByNewline = text.split('\n');                                    // includes trailing ''
const charCount = text.length;                                              // includes newlines
const charCountNoNewlines = text.replace(/\n/g, '').length;
const crCount = (text.match(/\r/g) ?? []).length;

// Decode exactly as the VPS verifier does: strip CR, then base64-decode.
const decoded = Buffer.from(text.replace(/\r?\n/g, ''), 'base64');
const decodedSha = crypto.createHash('sha256').update(decoded).digest('hex');

// Secret scan: the file must contain no key, token, or credential material.
const SECRET_PATTERNS = [
  ['private key PEM', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['certificate PEM', /-----BEGIN CERTIFICATE-----/],
  ['bearer value', /Bearer\s+[A-Za-z0-9._-]{20,}/],
  ['frp app-auth token', /(CF_DNS_API_TOKEN|CLOUDFLARE_DNS_API_TOKEN)/],
  ['acme account uri', /acme\/acct\/\d+/],
  ['hex key material', /[0-9a-f]{64}/i],   // a 64-hex run would look like a raw key; check below
];
const findings = [];
for (const [label, re] of SECRET_PATTERNS) {
  if (re.test(text)) findings.push(label);
}

// The hex-material heuristic needs care: base64 output is not hex, so a 64-char hex run would be
// suspicious. Report it separately with the actual match so it can be judged rather than assumed.
const hexRun = text.match(/[0-9a-f]{64}/i);

// Confirm the payload is reproducible from the documented public seed, proving it is derived from
// non-secret material and not from any key.
function rebuild() {
  const seed = Buffer.from('R9-RELAY-03 CONSOLE PASTE TEST - NON-SECRET - NOT KEY MATERIAL\n', 'utf8');
  const chunks = [];
  let total = 0;
  let counter = 0;
  while (total < 2672) {
    const block = crypto.createHash('sha256').update(`${seed.toString('utf8')}#${counter}`).digest();
    chunks.push(block);
    total += block.length;
    counter += 1;
  }
  return Buffer.concat(chunks).subarray(0, 2672);
}
const rebuilt = rebuild();
const rebuiltSha = crypto.createHash('sha256').update(rebuilt).digest('hex');
const reproducible = rebuilt.equals(decoded);

const report = {
  file: B64,
  verifiedAt: new Date().toISOString(),
  contains_secrets: findings.length > 0 ? findings : false,
  hex_run_found: hexRun ? hexRun[0] : null,
  byte_size_on_disk: raw.length,
  chars_including_newlines: charCount,
  chars_excluding_newlines: charCountNoNewlines,
  ends_with_newline: endsWithNewline,
  split_by_newline_count: splitByNewline.length,
  non_empty_line_count: contentLines.length,
  cr_count: crCount,
  line_width_of_first_line: contentLines[0].length,
  all_lines_width_76_except_last: contentLines.slice(0, -1).every((l) => l.length === 76),
  last_line_length: contentLines[contentLines.length - 1].length,
  decoded_bytes: decoded.length,
  decoded_sha256: decodedSha,
  matches_expected_sha256: decodedSha === EXPECTED_SHA,
  reproducible_from_public_seed: reproducible,
  rebuilt_sha256: rebuiltSha,
};

console.log('=== GATE 2B HANDOFF VERIFICATION ===');
console.log(`  file                      : ${B64}`);
console.log(`  bytes on disk             : ${raw.length}`);
console.log(`  characters INCLUDING newlines : ${charCount}`);
console.log(`  characters EXCLUDING newlines : ${charCountNoNewlines}`);
console.log(`  ends with a newline       : ${endsWithNewline}`);
console.log(`  non-empty base64 lines    : ${contentLines.length}`);
console.log(`  split-by-newline elements : ${splitByNewline.length} (last is '' because the file ends with \\n)`);
console.log(`  CR characters             : ${crCount}`);
console.log(`  line width                : ${contentLines[0].length} (only the final line is shorter: ${contentLines[contentLines.length - 1].length})`);
console.log(`  decoded bytes             : ${decoded.length}`);
console.log(`  decoded sha256            : ${decodedSha}`);
console.log(`  matches expected sha256   : ${decodedSha === EXPECTED_SHA}`);
console.log(`  reproducible from a PUBLIC seed (no key involved): ${reproducible}`);
console.log(`  contains secrets          : ${findings.length === 0 ? 'NO' : findings.join(', ')}`);
console.log(`  64-char hex run present   : ${hexRun ? hexRun[0] : 'none'}`);

fs.mkdirSync('.r9-fixture-tools', { recursive: true });
fs.writeFileSync('.r9-fixture-tools/r9relay03-gate2b-handoff.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log('\n  written: .r9-fixture-tools/r9relay03-gate2b-handoff.json');

const ok = decoded.length === 2672 && decodedSha === EXPECTED_SHA && findings.length === 0 && reproducible;
process.exit(ok ? 0 : 1);
