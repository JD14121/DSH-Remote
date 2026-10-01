/**
 * R9-RELAY-03 GATE 2B — post-mortem on the failed console paste.
 *
 * The operator's result: `1L, 763B written`, `grep -c . == 1`, non-base64 characters present.
 * Expected: 47 lines / 3611 bytes. This characterises the payload to identify what could have gone
 * wrong. It does NOT claim to know the exact console behaviour — that is not observable from here.
 */
import fs from 'node:fs';

const B64 = '.r9-fixture-tools/r9relay03-paste-test/payload.b64';
const text = fs.readFileSync(B64, 'utf8');
const chars = text.replace(/\n/g, '');

console.log('=== payload character profile ===');
console.log(`  total bytes            : ${Buffer.byteLength(text)}`);
console.log(`  base64 chars (no \\n)   : ${chars.length}`);

// What fraction of the payload is made of characters that a terminal or editor might special-case?
const specials = {
  '+': (chars.match(/\+/g) ?? []).length,
  '/': (chars.match(/\//g) ?? []).length,
  '=': (chars.match(/=/g) ?? []).length,
};
console.log(`  '+' count              : ${specials['+']}`);
console.log(`  '/' count              : ${specials['/']}`);
console.log(`  '=' count (padding)    : ${specials['=']}`);

// The operationally relevant question: how long is the longest run with no '+', '/', or '='?
// Those runs are the "easy" regions; the others need careful pasting.
const runs = chars.split(/[+/=]/).map((r) => r.length);
console.log(`  longest run without + / = : ${Math.max(...runs)}`);
console.log(`  number of segments        : ${runs.length}`);

console.log('\n=== the failed transfer, in context ===');
console.log(`  bytes that arrived     : 763`);
console.log(`  bytes expected         : 3611`);
console.log(`  fraction delivered     : ${(763 / 3611 * 100).toFixed(1)}%`);
console.log(`  lines that arrived     : 1 (expected 47)`);
console.log(`  roughly equivalent to   : ${(763 / 77).toFixed(1)} lines of 76 chars + newline`);

console.log('\n=== candidate mechanisms (NOT confirmed — listed for the design) ===');
const candidates = [
  'console paste buffer truncated the input at ~763 bytes (a size cap)',
  'the console collapsed newlines, producing one long line that then hit a per-line limit',
  'a bracketed-paste / terminal flow-control issue dropped the remainder',
  'the paste was interrupted (rate limiting or a slow channel)',
];
for (const c of candidates) console.log(`  - ${c}`);
console.log('\n  All four share one remedy: stop sending the package THROUGH the console at all.');
console.log('  The VPS must obtain it over the network, outbound, instead.');

// The design constraint this establishes, stated as a number rather than a guess.
console.log('\n=== derived constraint ===');
console.log('  Any console-carried artifact must be SHORT and single-line.');
console.log(`  Observed working ceiling is at most ~763 bytes, and possibly far less for reliability.`);
console.log('  A 3611-byte multi-line blob is therefore NOT a viable console payload, independent of');
console.log('  which mechanism above was responsible.');

const report = {
  measuredAt: new Date().toISOString(),
  payload_bytes: Buffer.byteLength(text),
  base64_chars: chars.length,
  plus_count: specials['+'],
  slash_count: specials['/'],
  equals_count: specials['='],
  longest_run_without_special: Math.max(...runs),
  observed_delivered_bytes: 763,
  observed_delivered_lines: 1,
  observed_non_base64_chars: true,
  expected_bytes: 3611,
  expected_lines: 47,
  root_cause: 'NOT DETERMINED — not observable from the PC; four candidate mechanisms listed',
  established_constraint: 'console-carried artifacts must be short and single-line; a ~3.6 KB multi-line blob is not viable',
  vps_modified: false,
  secrets_transferred: false,
};
fs.writeFileSync('.r9-fixture-tools/r9relay03-gate2b-postmortem.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log('\n  written: .r9-fixture-tools/r9relay03-gate2b-postmortem.json');
