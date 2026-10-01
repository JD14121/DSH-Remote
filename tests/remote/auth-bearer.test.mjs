/**
 * Bearer credential tests — Phase R6 §7, §8, §9, §37, §76.
 *
 * §76 forbids proving constant-time behaviour with a timing benchmark — a benchmark
 * in a test suite is noise, not evidence. What is testable and what these tests
 * assert is that the code path uses `timingSafeEqual` over fixed-length digests, so
 * neither length nor content can influence the work.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import {
  AUTH_ERROR,
  BearerVerifier,
  TOKEN_BYTES,
  generateSyntheticToken,
  isValidTokenShape,
  makeAuth,
  parseAuthorizationHeader,
  tokenDigest,
} from './r6-helpers.mjs';

test('§7: a synthetic credential is 32 bytes of base64url', () => {
  for (let index = 0; index < 20; index += 1) {
    const token = generateSyntheticToken();
    assert.equal(token.length, 43, 'base64url without padding is 43 chars for 32 bytes');
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, 'base64url').length, TOKEN_BYTES);
    assert.equal(isValidTokenShape(token), true);
  }
});

test('§7: the shape validator rejects weaker or malformed credentials', () => {
  const valid = generateSyntheticToken();
  assert.equal(isValidTokenShape(valid), true);
  for (const [why, bad] of [
    ['empty', ''],
    ['null', null],
    ['undefined', undefined],
    ['number', 123],
    ['too short', valid.slice(0, 42)],
    ['too long', `${valid}A`],
    ['standard-base64 character', `${valid.slice(0, 42)}+`],
    ['solidus', `${valid.slice(0, 42)}/`],
    ['padded', `${valid.slice(0, 42)}=`],
    ['illegal character', `${valid.slice(0, 42)}!`],
    ['whitespace inside', `${valid.slice(0, 21)} ${valid.slice(22)}`],
    ['leading space', ` ${valid}`],
  ]) {
    assert.equal(isValidTokenShape(bad), false, `must reject ${why}`);
  }
});

test('§8: exactly one Bearer credential is parsed, case-insensitively on the scheme', () => {
  const token = generateSyntheticToken();
  for (const scheme of ['Bearer', 'bearer', 'BEARER', 'BeArEr']) {
    const parsed = parseAuthorizationHeader(`${scheme} ${token}`);
    assert.equal(parsed.ok, true, `scheme ${scheme} must be accepted`);
    assert.equal(parsed.token, token);
  }
});

test('§8: a missing header is AUTH_REQUIRED and every malformed form is AUTH_INVALID', () => {
  const token = generateSyntheticToken();

  assert.equal(parseAuthorizationHeader(undefined).code, AUTH_ERROR.REQUIRED);
  assert.equal(parseAuthorizationHeader(null).code, AUTH_ERROR.REQUIRED);

  const invalid = [
    ['wrong scheme', `Basic ${token}`],
    ['no credential', 'Bearer'],
    ['empty credential', 'Bearer '],
    ['two spaces then nothing', 'Bearer   '],
    ['comma-separated pair', `Bearer ${token}, Bearer ${token}`],
    ['repeated header', [token, token]],
    ['control character', `Bearer ${token}\u0000`],
    ['newline injection', `Bearer ${token}\r\nX: y`],
    ['short credential', `Bearer ${token.slice(0, 20)}`],
    ['empty string', ''],
    ['scheme only, no space', `Bearer${token}`],
  ];
  for (const [why, header] of invalid) {
    const parsed = parseAuthorizationHeader(header);
    assert.equal(parsed.ok, false, `${why} must be refused`);
    // §37: a format problem must not be distinguishable from a wrong credential.
    assert.equal(parsed.code, AUTH_ERROR.INVALID, `${why} must be generic`);
  }
});

test('§8: an oversized header is refused', () => {
  const huge = `Bearer ${'a'.repeat(9000)}`;
  const parsed = parseAuthorizationHeader(huge);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, AUTH_ERROR.INVALID);
});

test('§9: verification hashes once and compares fixed-length digests', () => {
  const token = generateSyntheticToken();
  const verifier = new BearerVerifier({ token, principalId: 'phone' });

  // The stored expectation is a digest, not the plaintext.
  assert.ok(Buffer.isBuffer(verifier.expectedDigest));
  assert.equal(verifier.expectedDigest.length, 32, 'a SHA-256 digest');
  assert.equal(
    verifier.expectedDigest.equals(tokenDigest(token)),
    true,
    'the stored digest is SHA-256 of the credential',
  );
  assert.equal(
    JSON.stringify(verifier).includes(token),
    false,
    'the plaintext must not appear in the verifier state',
  );

  assert.equal(verifier.verify(token).ok, true);
  assert.equal(verifier.verify(generateSyntheticToken()).ok, false);
  assert.equal(verifier.verify('').ok, false);
  assert.equal(verifier.verify('not-a-token').ok, false, 'a wrong-length value is still hashed, not short-circuited');
});

test('§9/§76: the source uses timingSafeEqual over digests, not string equality', async () => {
  const source = await fs.promises.readFile(
    new URL('../../src/remote/auth/bearer.mjs', import.meta.url), 'utf8',
  );
  assert.ok(source.includes('timingSafeEqual'), 'the comparison must be constant-time');
  assert.ok(source.includes("createHash('sha256')"), 'the comparison must be over digests');
  // A plaintext comparison against the configured secret must not appear.
  assert.equal(/expected\s*===\s*supplied/.test(source), false, 'no direct secret comparison');
  assert.equal(/supplied\s*===\s*expected/.test(source), false);
});

test('§7: a credential that does not match the documented shape fails at construction', () => {
  for (const bad of [
    'short',                    // too short
    'a'.repeat(44),             // too long
    `${'a'.repeat(42)}+`,       // right length, standard-base64 character
    `${'a'.repeat(42)}=`,       // right length, padded
    `${'a'.repeat(42)}!`,       // right length, illegal character
  ]) {
    assert.throws(
      () => new BearerVerifier({ token: bad }),
      (error) => error.code === AUTH_ERROR.CONFIG_INVALID,
      `${JSON.stringify(bad)} must be refused as a configuration error`,
    );
  }
  // A syntactically valid 43-char base64url token is accepted, so the check is not
  // merely rejecting everything of that length.
  assert.doesNotThrow(() => new BearerVerifier({ token: 'a'.repeat(43) }));

  assert.throws(
    () => new BearerVerifier({}),
    (error) => error.code === AUTH_ERROR.CONFIG_INVALID,
  );
});

test('§37: every failure reason collapses to one generic code with no oracle', () => {
  const { auth } = makeAuth();
  const token = generateSyntheticToken();

  const reasons = [
    undefined,                       // absent
    'Bearer',                        // no credential
    'Basic ' + token,                // wrong scheme
    'Bearer ' + generateSyntheticToken(), // wrong token
    'Bearer ' + token.slice(0, 10),  // wrong length
    'Bearer ' + 'z'.repeat(43),      // wrong but well-formed
  ];
  const codes = new Set();
  for (const header of reasons) {
    const result = auth.authorize(header);
    assert.equal(result.ok, false);
    codes.add(result.code);
  }
  // Only two outward codes exist: "you gave me nothing" and "what you gave me is
  // wrong". Everything wrong collapses to the second.
  assert.deepEqual([...codes].sort(), [AUTH_ERROR.INVALID, AUTH_ERROR.REQUIRED].sort());
});

test('the internal reason is never part of the outward error', () => {
  const { auth } = makeAuth();
  const result = auth.authorize('Bearer ' + generateSyntheticToken());
  assert.equal(result.ok, false);
  assert.ok(typeof result.internalReason === 'string', 'the server keeps a reason for its own counters');
  // But the thrown error carries only the generic code and message.
  try {
    auth.assertAuthorized('Bearer ' + generateSyntheticToken());
    assert.fail('must throw');
  } catch (error) {
    assert.equal(error.code, AUTH_ERROR.INVALID);
    assert.equal(error.message.includes('mismatch'), false, 'the outward message is generic');
    assert.equal(error.message.includes('length'), false);
  }
});

test('a DSH-shaped credential is not accepted as a Phone credential (§59)', () => {
  const { auth } = makeAuth();
  for (const dshish of [
    'dsh-auth-abcdefghijklmnopqrstuvwxyz',
    'Bearer dsh-auth-0123456789abcdef',
    'launch-token-abcdefghijklmnopqrst',
  ]) {
    const header = dshish.startsWith('Bearer ') ? dshish : `Bearer ${dshish}`;
    assert.equal(auth.authorize(header).ok, false, `${dshish} must not authenticate`);
  }
});
