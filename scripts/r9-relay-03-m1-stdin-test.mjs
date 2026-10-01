/** Quick check that stdin credential mode works and refuses incomplete input. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Resolve the presign tool relative to THIS file, so the folder works wherever it is placed and
// from any working directory. Hard-coded repo-relative paths broke as soon as it was moved.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, 'r9-relay-03-m1-presign.mjs');


const run = (input) => spawnSync(process.execPath, [TOOL, '--stdin'], { input, encoding: 'utf8' });

const good = run(JSON.stringify({
  accessKeyId: 'R9-TEST-FAKE-KEY',
  secretAccessKey: 'r9-test-fake-secret',
  accountId: '0123456789abcdef0123456789abcdef',
}));
console.log('=== stdin mode with complete fake credentials ===');
for (const line of `${good.stdout}${good.stderr}`.split('\n')) {
  if (/credential source|URL byte|URL line|URL SHA|created|expires|validity/.test(line)) {
    console.log(`  ${line.trim()}`);
  }
}
console.log(`  exit code: ${good.status}`);
console.log(`  output contains a signed URL: ${/X-Amz-Signature=/.test(good.stdout)} (must be false)`);

console.log('\n=== stdin mode with INCOMPLETE credentials must refuse ===');
const bad = run(JSON.stringify({ accessKeyId: 'x' }));
console.log(`  exit code: ${bad.status} (must be non-zero)`);
console.log(`  stderr: ${`${bad.stdout}${bad.stderr}`.trim().split('\n').map((l) => l.trim()).filter(Boolean).join(' | ')}`);

console.log('\n=== stdin mode with a bad account id must refuse ===');
const badAcct = run(JSON.stringify({ accessKeyId: 'a', secretAccessKey: 'b', accountId: 'nothex' }));
console.log(`  exit code: ${badAcct.status} (must be non-zero)`);

console.log('\n=== stdin mode with malformed JSON must refuse ===');
const badJson = run('not json at all');
console.log(`  exit code: ${badJson.status} (must be non-zero)`);

const ok = good.status === 0 && !/X-Amz-Signature=/.test(good.stdout)
  && bad.status !== 0 && badAcct.status !== 0 && badJson.status !== 0;
console.log(`\n  ${ok ? 'PASS' : 'FAIL'} — stdin mode works and refusals are enforced`);
process.exit(ok ? 0 : 1);
