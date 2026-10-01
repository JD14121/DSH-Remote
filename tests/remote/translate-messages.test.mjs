/**
 * Message normalization tests — R1 §11, §18.1.
 *
 * Two required properties:
 *   1. an unrecognised `SessionWireEvent` is never silently discarded;
 *   2. an opaque assistant chunk is preserved, never parsed or coerced.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MESSAGE_ROLE,
  MESSAGE_TYPE,
  isKnownEventType,
  toConversation,
  toMessage,
  toMessages,
} from '../../src/remote/translate/to-messages.mjs';
import { loadFixture } from './helpers.mjs';

/** The fixture session id. */
const SESSION = 'session-00000000-0000-0000-0000-000000000001';

test('the target message shape is exactly the R1 §11 contract', () => {
  const message = toMessage(
    { type: 'user/message', seq: 40, time: 1789800000000, data: { message: 'hello' } },
    SESSION,
  );

  assert.deepEqual(Object.keys(message).sort(), [
    'content',
    'created_at',
    'id',
    'role',
    'sequence',
    'session_id',
    'type',
  ]);
  assert.equal(message.id, `${SESSION}:40`);
  assert.equal(message.session_id, SESSION);
  assert.equal(message.role, 'user');
  assert.equal(message.type, 'message');
  assert.equal(message.sequence, 40);
  assert.equal(message.created_at, new Date(1789800000000).toISOString());
});

test('every fixture record maps onto a message and the order is preserved', () => {
  const records = loadFixture('session-page.response.json').response.result.value.records;
  const messages = toMessages(records, SESSION);

  assert.equal(messages.length, 3);
  assert.deepEqual(messages.map((m) => m.sequence), [40, 41, 42]);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'tool', 'tool']);
  assert.deepEqual(messages.map((m) => m.type), ['message', 'tool-call', 'tool-result']);
});

test('only the four allowed roles are ever produced', () => {
  const allowed = new Set(Object.values(MESSAGE_ROLE));
  const records = loadFixture('session-page.response.json').response.result.value.records;

  for (const message of toMessages(records, SESSION)) {
    assert.equal(allowed.has(message.role), true, `unexpected role ${message.role}`);
  }
});

test('a tool call keeps its raw argument string untouched', () => {
  const records = loadFixture('session-page.response.json').response.result.value.records;
  const toolCall = toMessages(records, SESSION).find((m) => m.type === MESSAGE_TYPE.TOOL_CALL);

  assert.equal(toolCall.content.name, 'fs_read');
  // DSH stores the arguments as an unparsed JSON string. R1 copies it; parsing
  // it here would invent a schema DSH never promised.
  assert.equal(typeof toolCall.content.arguments, 'string');
  assert.equal(toolCall.content.arguments, '{"path":"README.md"}');
});

test('an unknown event type becomes a visible system/unknown message, never dropped', () => {
  const unknown = {
    type: 'some-future/event-type',
    seq: 99,
    time: 1789800009999,
    data: { anything: ['opaque', 1, true] },
  };

  assert.equal(isKnownEventType(unknown.type), false);

  const message = toMessage(unknown, SESSION);

  // Fail-visible: still a real message with its identity and payload.
  assert.equal(message.role, MESSAGE_ROLE.SYSTEM);
  assert.equal(message.type, MESSAGE_TYPE.UNKNOWN);
  assert.equal(message.sequence, 99);
  assert.equal(message.id, `${SESSION}:99`);
  assert.equal(message.content.kind, 'opaque');
  assert.equal(message.content.eventType, 'some-future/event-type');
  assert.deepEqual(message.content.data, unknown.data);
});

test('an unknown event carrying non-JSON data still preserves a representation', () => {
  const cyclic = { name: 'cyclic' };
  cyclic.self = cyclic;

  const message = toMessage(
    { type: 'future/cyclic', seq: 100, time: 1789800010000, data: cyclic },
    SESSION,
  );

  assert.equal(message.type, MESSAGE_TYPE.UNKNOWN);
  assert.equal(typeof message.content.data, 'string');
  assert.ok(message.content.data.length > 0);
});

test('a batch containing an unknown event keeps every record', () => {
  const records = [
    { type: 'event', event: { type: 'user/message', seq: 1, time: 1, data: { message: 'a' } } },
    { type: 'event', event: { type: 'novel/thing', seq: 2, time: 2, data: {} } },
    { type: 'event', event: { type: 'assistant/message', seq: 3, time: 3, data: { message: 'b' } } },
  ];

  const messages = toMessages(records, SESSION);
  assert.equal(messages.length, 3, 'an unknown event must not shrink the batch');
  assert.deepEqual(messages.map((m) => m.type), ['message', 'unknown', 'message']);
});

test('assistant and system messages map onto their roles', () => {
  const assistant = toMessage(
    { type: 'assistant/message', seq: 2, time: 2, data: { message: 'answer' } },
    SESSION,
  );
  const system = toMessage(
    { type: 'system/message', seq: 3, time: 3, data: { message: 'notice' } },
    SESSION,
  );

  assert.equal(assistant.role, MESSAGE_ROLE.ASSISTANT);
  assert.equal(assistant.content, 'answer');
  assert.equal(system.role, MESSAGE_ROLE.SYSTEM);
});

test('toConversation keeps only user and assistant messages', () => {
  const records = loadFixture('session-page.response.json').response.result.value.records;
  const conversation = toConversation(toMessages(records, SESSION));

  assert.equal(conversation.length, 1);
  assert.equal(conversation[0].role, MESSAGE_ROLE.USER);
});

test('malformed input is rejected loudly instead of producing a partial message', () => {
  assert.throws(() => toMessage(null, SESSION), TypeError);
  assert.throws(() => toMessage({ type: 'user/message' }, SESSION), TypeError);
  assert.throws(() => toMessage({ type: 'user/message', seq: 'x' }, SESSION), TypeError);
  assert.throws(() => toMessages('not an array', SESSION), TypeError);
  assert.throws(() => toMessages([{ type: 'nope' }], SESSION), TypeError);
});

test('missing time yields null rather than a fabricated timestamp', () => {
  const message = toMessage({ type: 'user/message', seq: 1, data: { message: 'x' } }, SESSION);
  assert.equal(message.created_at, null);
});
