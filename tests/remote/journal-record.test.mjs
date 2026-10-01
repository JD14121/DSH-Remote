/**
 * Journal record tests — Phase R5 §6, §7, §16, §45, §54.
 *
 * The record is the durable unit, so these tests pin its shape, its checksum
 * canonicalisation, its framing, and the secret guard that must not mangle user
 * text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PERSISTENCE_ERROR,
  PERSISTENCE_FORMAT_VERSION,
  recordChecksum,
} from './r5-helpers.mjs';
import { decodeRecord, encodeRecord, assertNoCredentialMaterial } from '../../src/remote/persistence/record.mjs';

const SESSION = 'session-00000000-0000-0000-0000-000000000001';

/** A valid Gateway event. */
function event(sequence, data = { index: sequence }) {
  return {
    sequence,
    event: 'task.progress',
    session_id: SESSION,
    timestamp: null,
    observed_at: '2026-09-19T06:40:00.000Z',
    data,
    source_sequence: null,
  };
}

test('a record carries the documented fields and a canonical checksum', () => {
  const line = encodeRecord(event(7));
  const parsed = JSON.parse(line);

  assert.deepEqual(Object.keys(parsed).sort(), ['checksum', 'event', 'sequence', 'v']);
  assert.equal(parsed.v, PERSISTENCE_FORMAT_VERSION);
  assert.equal(parsed.sequence, 7);
  assert.equal(parsed.event.sequence, 7);
  assert.equal(parsed.checksum, recordChecksum(PERSISTENCE_FORMAT_VERSION, 7, event(7)));
  assert.match(parsed.checksum, /^sha256:[0-9a-f]{64}$/);
});

test('the checksum payload is a fixed array, not object enumeration order', () => {
  // §6: the payload is `JSON.stringify([v, sequence, event])`. Re-ordering the
  // event's own keys must therefore change nothing, and re-ordering the array
  // must change everything.
  const a = { sequence: 3, event: 'unknown', session_id: SESSION, timestamp: null, observed_at: null, data: { x: 1 }, source_sequence: null };
  const b = { source_sequence: null, data: { x: 1 }, observed_at: null, timestamp: null, session_id: SESSION, event: 'unknown', sequence: 3 };

  assert.notEqual(JSON.stringify(a), JSON.stringify(b), 'the fixtures really do differ textually');
  assert.equal(
    recordChecksum(1, 3, a),
    recordChecksum(1, 3, b),
    'a canonical array payload is independent of key order',
  );
  assert.notEqual(recordChecksum(1, 3, a), recordChecksum(1, 4, a), 'the sequence is covered');
  assert.notEqual(recordChecksum(1, 3, a), recordChecksum(2, 3, a), 'the version is covered');
});

test('a record is always exactly one physical line', () => {
  // §7: content newlines are escaped, so one record is one line by construction.
  const line = encodeRecord(event(1, { text: 'line one\nline two\r\nline three' }));
  assert.equal(line.includes('\n'), false, 'no literal newline may appear');
  assert.equal(line.includes('\r'), false, 'no literal carriage return either');

  const parsed = JSON.parse(line);
  assert.equal(parsed.event.data.text, 'line one\nline two\r\nline three', 'the content round-trips');
});

test('encoding is UTF-8-safe for multi-byte content', () => {
  const line = encodeRecord(event(1, { text: 'héllo — 世界 🌍' }));
  const bytes = Buffer.from(line, 'utf8');
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), JSON.parse(line));
  assert.equal(bytes.toString('utf8'), line, 'no replacement characters');
});

test('an opaque payload survives byte-for-byte', () => {
  const opaque = { nested: { deep: [1, 'two', true, null] }, emoji: '🌍' };
  const line = encodeRecord(event(1, opaque));
  assert.deepEqual(JSON.parse(line).event.data, opaque);
});

test('a large record round-trips', () => {
  const big = 'x'.repeat(200_000);
  const line = encodeRecord(event(1, { big }));
  assert.equal(JSON.parse(line).event.data.big.length, 200_000);
});

test('a sequence must be a positive integer', () => {
  for (const bad of [0, -1, 1.5, 'x', null, undefined]) {
    assert.throws(
      () => encodeRecord({ ...event(1), sequence: bad }),
      (error) => error.code === PERSISTENCE_ERROR.JOURNAL_SEQUENCE_ERROR,
      `sequence ${JSON.stringify(bad)}`,
    );
  }
});

test('a record needs a session id', () => {
  assert.throws(
    () => encodeRecord({ ...event(1), session_id: '' }),
    (error) => error.code === PERSISTENCE_ERROR.JOURNAL_SEQUENCE_ERROR,
  );
});

test('decode validates structure, version, sequence and checksum', () => {
  const good = encodeRecord(event(4));
  const context = { sessionId: SESSION, expectedSequence: 4 };
  const record = decodeRecord(good, context);
  assert.equal(record.sequence, 4);
  assert.deepEqual(record.event, event(4));

  const corrupt = (line, why) => assert.throws(
    () => decodeRecord(line, context),
    (error) => error.code === PERSISTENCE_ERROR.JOURNAL_CORRUPT,
    why,
  );

  corrupt('', 'empty line');
  corrupt('not json', 'not JSON');
  corrupt('[]', 'array');
  corrupt('null', 'null');
  corrupt(JSON.stringify({ ...JSON.parse(good), v: 99 }), 'unknown version');
  corrupt(JSON.stringify({ ...JSON.parse(good), sequence: 0 }), 'zero sequence');
  corrupt(JSON.stringify({ ...JSON.parse(good), sequence: 5 }), 'record/event sequence mismatch');
  corrupt(JSON.stringify({ ...JSON.parse(good), checksum: 'sha256:deadbeef' }), 'checksum mismatch');
  corrupt(JSON.stringify({ ...JSON.parse(good), event: { ...event(4), session_id: 'session-other' } }), 'session mismatch');
  corrupt(JSON.stringify({ v: 1, sequence: 4, event: null, checksum: 'x' }), 'no event');
});

test('a record for the wrong session is refused, not accepted', () => {
  const line = encodeRecord(event(1));
  assert.throws(
    () => decodeRecord(line, { sessionId: 'session-00000000-0000-0000-0000-000000000099' }),
    (error) => error.code === PERSISTENCE_ERROR.JOURNAL_CORRUPT,
  );
});

test('the secret guard blocks internal credential material (§54)', () => {
  for (const field of ['cookie', 'authorization', 'token', 'api_key', 'credentials', 'password', 'secret', 'launchToken']) {
    assert.throws(
      () => encodeRecord(event(1, { [field]: 'anything' })),
      (error) => error.code === PERSISTENCE_ERROR.WRITE_FAILED,
      `field ${field} must be refused`,
    );
    // Also nested, and inside an array.
    assert.throws(() => encodeRecord(event(1, { outer: { [field]: 'x' } })), `nested ${field}`);
    assert.throws(() => encodeRecord(event(1, { list: [{ [field]: 'x' }] })), `array ${field}`);
  }
});

test('the secret guard blocks credential-shaped values', () => {
  assert.throws(() => encodeRecord(event(1, { note: 'dsh-auth-abcdefghijklmnop' })));
  assert.throws(() => encodeRecord(event(1, { note: 'Bearer abcdefghijklmnopqrstuvwxyz012345' })));
  assert.throws(() => encodeRecord(event(1, { note: '-----BEGIN RSA PRIVATE KEY-----' })));
});

test('the secret guard does NOT rewrite genuine user text (§54)', () => {
  // §54 is explicit: a user message containing the word "token" is not a secret,
  // and mangling user content would be a data-loss bug.
  const text = 'I lost my token for the bank and the cookie recipe is secret sauce';
  const line = encodeRecord(event(1, { text }));
  assert.equal(JSON.parse(line).event.data.text, text, 'user text is preserved verbatim');

  assert.doesNotThrow(() => assertNoCredentialMaterial('my token expired', 'x'));
  assert.doesNotThrow(() => assertNoCredentialMaterial({ message: 'authorization is hard' }, 'x'));
});
