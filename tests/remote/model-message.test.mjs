/**
 * Message model tests — R2 §6, §24.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALL_MESSAGE_TYPES,
  ALL_ROLES,
  MESSAGE_TYPE,
  isMessageIdStable,
  makeMessageId,
  toAssistantDeltaMessage,
  toDomainMessage,
  toDomainMessages,
} from '../../src/remote/model/message.mjs';
import { loadFixture } from './helpers.mjs';

const SESSION = 'session-00000000-0000-0000-0000-000000000001';

test('a message carries the R2 schema', () => {
  const message = toDomainMessage(
    { type: 'user/message', seq: 40, time: 1789800000000, data: { message: 'hello' } },
    SESSION,
  );

  for (const field of ['id', 'session_id', 'role', 'type', 'content', 'created_at', 'sequence', 'source_sequence']) {
    assert.ok(field in message, `message must carry ${field}`);
  }
  assert.equal(message.session_id, SESSION);
  assert.equal(message.role, 'user');
  assert.equal(message.type, MESSAGE_TYPE.MESSAGE);
  assert.equal(message.content, 'hello');
});

test('the id is deterministic and stable across repeated reads', () => {
  const event = { type: 'assistant/message', seq: 41, time: 1, data: { message: 'x' } };

  const first = toDomainMessage(event, SESSION);
  const second = toDomainMessage(event, SESSION);
  const third = toDomainMessage({ ...event }, SESSION);

  assert.equal(first.id, second.id);
  assert.equal(first.id, third.id);
  assert.equal(first.id, `${SESSION}:41:${MESSAGE_TYPE.MESSAGE}`);
  assert.equal(isMessageIdStable(first), true);
});

test('message ids are unique per (session, seq, type) and include all three', () => {
  const base = { seq: 7, time: 1, data: {} };
  const a = toDomainMessage({ ...base, type: 'user/message' }, SESSION);
  const b = toDomainMessage({ ...base, type: 'tool/call' }, SESSION);
  const c = toDomainMessage({ ...base, type: 'user/message' }, 'session-other');

  assert.notEqual(a.id, b.id);
  assert.notEqual(a.id, c.id);
});

test('a durable seq-less event still gets a deterministic, non-random id', () => {
  const frame = { attemptId: 'a1', revision: 1, index: 5, chunk: { t: 'x' }, time: 1789800000000 };
  const first = toAssistantDeltaMessage({ sessionId: SESSION, frame });
  const second = toAssistantDeltaMessage({ sessionId: SESSION, frame });

  assert.equal(first.id, second.id);
  assert.equal(first.type, MESSAGE_TYPE.ASSISTANT_DELTA);
  assert.equal(first.sequence, null);
  assert.equal(first.source_sequence, null);
  assert.ok(first.id.includes(':s:'), 'a seq-less id must be visibly derived, not sequence-shaped');
});

test('a streaming delta is distinguishable from the committed message', () => {
  const delta = toAssistantDeltaMessage({
    sessionId: SESSION,
    frame: { attemptId: 'a1', revision: 1, index: 0, chunk: { text: 'hel' }, time: 1 },
  });
  const committed = toDomainMessage(
    { type: 'assistant/message', seq: 44, time: 2, data: { message: 'hello' } },
    SESSION,
  );

  assert.notEqual(delta.id, committed.id);
  assert.notEqual(delta.type, committed.type);
  assert.equal(delta.type, MESSAGE_TYPE.ASSISTANT_DELTA);
  assert.equal(committed.type, MESSAGE_TYPE.MESSAGE);
});

test('the Gateway sequence is never used as a message id component', () => {
  // A message id contains the session id and the DSH seq, never a Gateway number.
  const message = toDomainMessage({ type: 'user/message', seq: 418, time: 1, data: { message: 'x' } }, SESSION);
  assert.equal(message.id, `${SESSION}:418:message`);
  assert.equal(message.sequence, 418);
  assert.equal(message.source_sequence, 418);
});

test('each DSH event type maps onto the right role and type, and none collapse to "message"', () => {
  const cases = [
    ['user/message', 'user', MESSAGE_TYPE.MESSAGE],
    ['system/message', 'system', MESSAGE_TYPE.MESSAGE],
    ['assistant/message', 'assistant', MESSAGE_TYPE.MESSAGE],
    ['tool/call', 'tool', MESSAGE_TYPE.TOOL_CALL],
    ['tool/result', 'tool', MESSAGE_TYPE.TOOL_RESULT],
  ];

  for (const [dshType, role, type] of cases) {
    const message = toDomainMessage({ type: dshType, seq: 1, time: 1, data: {} }, SESSION);
    assert.equal(message.role, role, `${dshType} role`);
    assert.equal(message.type, type, `${dshType} type`);
  }

  // Only the genuine message events are `message`; tool events are not flattened.
  assert.equal(new Set(ALL_MESSAGE_TYPES).has('tool_call'), true);
  assert.deepEqual([...ALL_ROLES].sort(), ['assistant', 'system', 'tool', 'user']);
});

test('an unknown event is kept with type unknown, its seq and a safe payload', () => {
  const message = toDomainMessage(
    { type: 'some-future/event', seq: 99, time: 1789800009999, data: { anything: ['opaque', 1, true] } },
    SESSION,
  );

  assert.equal(message.type, MESSAGE_TYPE.UNKNOWN);
  assert.equal(message.role, 'system');
  assert.equal(message.sequence, 99);
  assert.equal(message.source_sequence, 99);
  assert.equal(message.content.kind, 'opaque');
  assert.equal(message.content.eventType, 'some-future/event');
  assert.deepEqual(message.content.data, { anything: ['opaque', 1, true] });
});

test('an unknown event with non-JSON payload still preserves a representation', () => {
  const cyclic = { name: 'cyclic' };
  cyclic.self = cyclic;

  const message = toDomainMessage({ type: 'future/cyclic', seq: 1, time: 1, data: cyclic }, SESSION);
  assert.equal(message.type, MESSAGE_TYPE.UNKNOWN);
  assert.equal(typeof message.content.data, 'string');
  assert.ok(message.content.data.length > 0);
});

test('a tool call keeps its raw argument string unparsed', () => {
  const message = toDomainMessage(
    { type: 'tool/call', seq: 41, time: 1, data: { name: 'fs_read', arguments: '{"path":"a.md"}' } },
    SESSION,
  );
  assert.equal(message.type, MESSAGE_TYPE.TOOL_CALL);
  assert.equal(typeof message.content.arguments, 'string');
  assert.equal(message.content.arguments, '{"path":"a.md"}');
});

test('a missing source timestamp yields null, never the receive clock', () => {
  const message = toDomainMessage({ type: 'user/message', seq: 1, data: { message: 'x' } }, SESSION);
  assert.equal(message.created_at, null);
  assert.equal(message.observed_at, null);
});

test('a supplied observation time is recorded separately from the source time', () => {
  const observedAt = '2026-09-19T04:00:00.000Z';
  const message = toDomainMessage(
    { type: 'user/message', seq: 1, time: 1789800000000, data: { message: 'x' } },
    SESSION,
    { observedAt },
  );
  assert.equal(message.created_at, new Date(1789800000000).toISOString());
  assert.equal(message.observed_at, observedAt);
  assert.notEqual(message.created_at, message.observed_at);
});

test('batch normalisation preserves order and drops nothing', () => {
  const records = loadFixture('session-page.response.json').response.result.value.records;
  const messages = toDomainMessages(records, SESSION);

  assert.equal(messages.length, records.length);
  assert.deepEqual(messages.map((m) => m.sequence), [40, 41, 42]);
  assert.deepEqual(messages.map((m) => m.type), [
    MESSAGE_TYPE.MESSAGE,
    MESSAGE_TYPE.TOOL_CALL,
    MESSAGE_TYPE.TOOL_RESULT,
  ]);
});

test('batch normalisation with an unknown event keeps every record', () => {
  const records = [
    { type: 'event', event: { type: 'user/message', seq: 1, time: 1, data: { message: 'a' } } },
    { type: 'event', event: { type: 'novel/thing', seq: 2, time: 2, data: {} } },
    { type: 'event', event: { type: 'assistant/message', seq: 3, time: 3, data: { message: 'b' } } },
  ];
  const messages = toDomainMessages(records, SESSION);
  assert.equal(messages.length, 3);
  assert.equal(messages[1].type, MESSAGE_TYPE.UNKNOWN);
});

test('malformed input is rejected loudly', () => {
  assert.throws(() => toDomainMessage(null, SESSION), TypeError);
  assert.throws(() => toDomainMessage({}, ''), TypeError);
  assert.throws(() => toDomainMessages('nope', SESSION), TypeError);
  assert.throws(() => toDomainMessages([{ type: 'nope' }], SESSION), TypeError);
  assert.throws(() => makeMessageId({ sessionId: '', sourceSequence: 1, type: 'message' }), TypeError);
  assert.throws(() => toAssistantDeltaMessage({ sessionId: SESSION, frame: null }), TypeError);
});
