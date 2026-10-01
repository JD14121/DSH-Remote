/**
 * R7B mandatory item C — the failure diagnostic.
 *
 * ## Why this exists
 *
 * Gate B recorded only `error.toString()`. For `ReferenceError: fs is not defined` that
 * names the message and nothing else — no file, no line — so an external operator saw
 * *that* it failed without seeing *where*, and the phase could not be closed without a
 * second external round trip.
 *
 * The fix has two halves, and both are dangerous in opposite directions:
 *
 * * **Too little** and the diagnostic cannot be acted on (the original defect).
 * * **Too much** and a stack trace carries a credential into the evidence file, which is
 *   a far worse outcome than an unlocalised failure.
 *
 * So the tests below assert both directions: file and line survive, and every credential
 * shape does not.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { describeError, redactCredentialShapes } from '../../scripts/r7-gate-b.mjs';

/**
 * Throw a real error from a known file and line, so the stack has real frames.
 *
 * @returns {Error} the error, with a genuine stack.
 */
function throwFromKnownPlace() {
  // The frame this line produces is the assertion target.
  throw new ReferenceError('fs is not defined'); // <- this.mjs line matters
}

test('C: a real ReferenceError yields the throwing file and line', () => {
  let captured = null;
  try {
    throwFromKnownPlace();
  } catch (error) {
    captured = error;
  }
  assert.notEqual(captured, null, 'the helper must throw');

  const diagnostic = describeError(captured);

  assert.equal(diagnostic.error_name, 'ReferenceError');
  assert.equal(diagnostic.error_message, 'fs is not defined');

  // The whole point: the diagnostic must localise the failure.
  assert.match(
    diagnostic.sanitized_stack,
    /r7b-diagnostic\.test\.mjs:\d+:\d+/,
    'the stack must name this file and a line:column',
  );
  assert.match(diagnostic.sanitized_stack, /throwFromKnownPlace/, 'the stack must name the function');
});

test('C: a synthetic ReferenceError produces file and line information', () => {
  // A hand-built stack, so the assertion does not depend on V8 formatting.
  const error = new ReferenceError('fs is not defined');
  error.stack = [
    'ReferenceError: fs is not defined',
    '    at resolveNpxLauncher (file:///D:/proj/src/remote/production/dsh-process.mjs:46:40)',
    '    at new DshProcess (file:///D:/proj/src/remote/production/dsh-process.mjs:89:9)',
  ].join('\n');

  const diagnostic = describeError(error);
  assert.match(diagnostic.sanitized_stack, /dsh-process\.mjs:46:40/);
  assert.match(diagnostic.sanitized_stack, /dsh-process\.mjs:89:9/);
  assert.match(diagnostic.sanitized_stack, /resolveNpxLauncher/);
  assert.equal(diagnostic.error_message, 'fs is not defined');
});

test('C: a launch token in the message and the stack is redacted', () => {
  const launchToken = crypto.randomBytes(32).toString('base64url');
  assert.equal(launchToken.length, 43);

  const error = new ReferenceError(`failed to reach http://127.0.0.1:3081/?token=${launchToken}`);
  error.stack = [
    `ReferenceError: failed to reach http://127.0.0.1:3081/?token=${launchToken}`,
    `    at f (http://127.0.0.1:3081/?token=${launchToken})`,
    '    at g (file:///D:/proj/src/x.mjs:1:1)',
  ].join('\n');

  const diagnostic = describeError(error);

  const serialized = JSON.stringify(diagnostic);
  assert.equal(serialized.includes(launchToken), false, 'the launch token must not survive');
  assert.match(diagnostic.sanitized_stack, /token=<redacted>/);
  // And the useful part is still there.
  assert.match(diagnostic.sanitized_stack, /x\.mjs:1:1/);
});

test('C: a dsh-auth cookie, a bearer header and a WS ticket are redacted', () => {
  const cookieValue = crypto.randomBytes(32).toString('base64url');
  const ticket = crypto.randomBytes(32).toString('base64url');

  const error = new Error('bootstrap failed');
  error.stack = [
    'Error: bootstrap failed',
    `    at f (file:///D:/proj/src/a.mjs:2:2)`,
    `  set-cookie: dsh-auth-abc123=${cookieValue}; Path=/; HttpOnly`,
    `  authorization: Bearer ${cookieValue}`,
    `    at g (http://127.0.0.1:9445/api/v1/events?ticket=${ticket})`,
  ].join('\n');

  const diagnostic = describeError(error);
  const serialized = JSON.stringify(diagnostic);

  assert.equal(serialized.includes(cookieValue), false, 'the cookie value must not survive');
  assert.equal(serialized.includes(ticket), false, 'the WS ticket must not survive');
  assert.equal(/Bearer\s+[A-Za-z0-9_-]{20,}/i.test(diagnostic.sanitized_stack), false);
  // The frame is retained.
  assert.match(diagnostic.sanitized_stack, /a\.mjs:2:2/);
});

test('C: an unregistered 43-character credential is still redacted', () => {
  // The dangerous case: a credential the process never told the redactor about, because
  // it came from somewhere unexpected. Value-based redaction cannot catch it; the shape
  // scrubber must.
  const unknownSecret = crypto.randomBytes(32).toString('base64url');
  const error = new Error(`unexpected value ${unknownSecret}`);
  error.stack = `Error: unexpected value ${unknownSecret}\n    at f (file:///D:/x.mjs:3:3)`;

  const diagnostic = describeError(error);
  assert.equal(JSON.stringify(diagnostic).includes(unknownSecret), false);
  assert.match(diagnostic.sanitized_stack, /x\.mjs:3:3/);
});

test('C: redactCredentialShapes covers each documented shape', () => {
  const cases = [
    ['http://h/?token=' + 'A'.repeat(43), 'token=<redacted>'],
    ['Authorization: Bearer ' + 'B'.repeat(43), 'Bearer <redacted>'],
    ['dsh-auth-xyz=' + 'C'.repeat(43), 'dsh-auth-<redacted>'],
    ['set-cookie: dsh-auth-a=b', 'set-cookie: <redacted>'],
    ['value ' + 'D'.repeat(43), '<redacted>'],
  ];
  for (const [input, expected] of cases) {
    const output = redactCredentialShapes(input);
    assert.match(output, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `input: ${input}`);
    assert.equal(output.includes('A'.repeat(43)) || output.includes('B'.repeat(43))
      || output.includes('C'.repeat(43)) || output.includes('D'.repeat(43)), false);
  }

  // A 42- or 44-character run is NOT a credential and must be left alone, so the rule
  // does not silently eat legitimate identifiers.
  const short = 'E'.repeat(42);
  const long = 'F'.repeat(44);
  assert.equal(redactCredentialShapes(`x ${short} y`).includes(short), true);
  assert.equal(redactCredentialShapes(`x ${long} y`).includes(long), true);
});

test('C: a non-Error throw is handled without crashing', () => {
  for (const value of ['a string failure', 42, null, undefined, { code: 'X' }]) {
    const diagnostic = describeError(value);
    assert.equal(typeof diagnostic.error_name, 'string');
    assert.equal(typeof diagnostic.error_message, 'string');
    assert.equal(typeof diagnostic.sanitized_stack, 'string');
  }
});

test('C: the diagnostic record carries exactly the three required fields', () => {
  const diagnostic = describeError(new Error('x'));
  assert.deepEqual(Object.keys(diagnostic).sort(), ['error_message', 'error_name', 'sanitized_stack']);
});

test('C: no evidence file contains credential material', () => {
  const evidenceDir = 'D:\\DSH-testing\\docs\\remote-mobile\\_evidence';
  if (!fs.existsSync(evidenceDir)) return;

  const tokenPath = 'D:\\DSH-work-test\\.dsh\\remote\\secrets\\phone-token.v1';
  const token = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf8').trim() : null;

  for (const name of fs.readdirSync(evidenceDir).filter((entry) => entry.startsWith('r7b-'))) {
    const text = fs.readFileSync(path.join(evidenceDir, name), 'utf8');
    assert.equal(/\?token=[A-Za-z0-9_-]{40,}/.test(text), false, `${name}: launch announcement`);
    assert.equal(/dsh-auth-[A-Za-z0-9_-]{40,}=/.test(text), false, `${name}: cookie`);
    assert.equal(/Bearer\s+[A-Za-z0-9_-]{40,}/.test(text), false, `${name}: authorization header`);
    if (token !== null && token.length === 43) {
      assert.equal(text.includes(token), false, `${name}: Phone token`);
    }
  }
});
