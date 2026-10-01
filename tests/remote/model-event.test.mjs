/**
 * Gateway event model tests — R2 §7, §8, §24, §29.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALL_GATEWAY_EVENTS,
  EVIDENCED_GATEWAY_EVENTS,
  GATEWAY_EVENT,
  gatewayEventForDshEvent,
  inspectForSecrets,
  makeGatewayEvent,
  safeEventData,
  validateGatewayEvent,
} from '../../src/remote/model/event.mjs';

const SESSION = 'session-00000000-0000-0000-0000-000000000001';

test('a gateway event carries the R2 schema', () => {
  const event = makeGatewayEvent({
    sequence: 92,
    event: GATEWAY_EVENT.ASSISTANT_DELTA,
    sessionId: SESSION,
    data: { chunk: { opaque: true } },
    sourceTime: 1789800000000,
    observedAt: '2026-09-19T04:00:00.000Z',
    sourceSequence: 418,
  });

  for (const field of ['sequence', 'event', 'session_id', 'timestamp', 'data']) {
    assert.ok(field in event, `gateway event must carry ${field}`);
  }
  assert.equal(event.sequence, 92);
  assert.equal(event.event, 'assistant.delta');
  assert.equal(event.session_id, SESSION);
  assert.equal(event.timestamp, new Date(1789800000000).toISOString());
  assert.equal(event.observed_at, '2026-09-19T04:00:00.000Z');
});

test('the full §7 vocabulary is declared', () => {
  assert.deepEqual([...ALL_GATEWAY_EVENTS].sort(), [
    'assistant.delta',
    'assistant.end',
    'assistant.start',
    'message.created',
    'session.status',
    'task.cancelled',
    'task.completed',
    'task.failed',
    'task.progress',
    'tool.completed',
    'tool.output',
    'tool.started',
    'transport.disconnected',
    'transport.reconnected',
    'unknown',
  ]);
  // Every evidenced event is part of the vocabulary.
  for (const name of EVIDENCED_GATEWAY_EVENTS) {
    assert.ok(ALL_GATEWAY_EVENTS.includes(name), `${name} must be in the vocabulary`);
  }
});

test('the Gateway sequence is independent of the DSH source sequence', () => {
  const event = makeGatewayEvent({
    sequence: 92,
    event: GATEWAY_EVENT.MESSAGE_CREATED,
    sessionId: SESSION,
    sourceSequence: 418,
  });

  assert.equal(event.sequence, 92, 'Gateway-owned');
  assert.equal(event.source_sequence, 418, 'DSH-owned');
  assert.notEqual(event.sequence, event.source_sequence);
});

test('source_sequence is absent when the raw source had no durable seq', () => {
  const event = makeGatewayEvent({
    sequence: 1,
    event: GATEWAY_EVENT.ASSISTANT_DELTA,
    sessionId: SESSION,
    data: { chunk: 'x' },
  });
  assert.equal('source_sequence' in event, false);
});

test('the source timestamp is never back-filled from the observation clock', () => {
  const event = makeGatewayEvent({
    sequence: 1,
    event: GATEWAY_EVENT.SESSION_STATUS,
    sessionId: SESSION,
    observedAt: '2026-09-19T04:00:00.000Z',
  });
  assert.equal(event.timestamp, null, 'no source time means null, not Date.now()');
  assert.equal(event.observed_at, '2026-09-19T04:00:00.000Z');
});

test('DSH event types map onto the vocabulary, and anything unmapped is unknown', () => {
  assert.equal(gatewayEventForDshEvent('assistant/message'), GATEWAY_EVENT.MESSAGE_CREATED);
  assert.equal(gatewayEventForDshEvent('tool/call'), GATEWAY_EVENT.TOOL_STARTED);
  assert.equal(gatewayEventForDshEvent('tool/result'), GATEWAY_EVENT.TOOL_COMPLETED);
  assert.equal(gatewayEventForDshEvent('step/start'), GATEWAY_EVENT.TASK_PROGRESS);
  assert.equal(gatewayEventForDshEvent('turn/start'), GATEWAY_EVENT.SESSION_STATUS);
  assert.equal(gatewayEventForDshEvent('turn/end'), GATEWAY_EVENT.SESSION_STATUS);
  // An unmapped type is `unknown`, never dropped.
  assert.equal(gatewayEventForDshEvent('brand/new/event'), GATEWAY_EVENT.UNKNOWN);
  assert.equal(gatewayEventForDshEvent(undefined), GATEWAY_EVENT.UNKNOWN);
});

test('an opaque payload is passed through by reference, not copied or parsed', () => {
  const chunk = { type: 'text-delta', nested: { deep: [1, 2, 3] } };
  const event = makeGatewayEvent({
    sequence: 1,
    event: GATEWAY_EVENT.ASSISTANT_DELTA,
    sessionId: SESSION,
    data: { chunk },
  });
  assert.equal(event.data.chunk, chunk, 'the chunk must be the same object');
});

test('a non-JSON payload is preserved as a string rather than lost', () => {
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  const safe = safeEventData(cyclic);
  assert.equal(typeof safe, 'string');
  assert.ok(safe.length > 0);
  assert.equal(safeEventData(undefined), null);
});

test('an illegal sequence or event name fails closed', () => {
  const base = { event: GATEWAY_EVENT.UNKNOWN, sessionId: SESSION };

  assert.throws(() => makeGatewayEvent({ ...base }), TypeError);
  assert.throws(() => makeGatewayEvent({ ...base, sequence: -1 }), TypeError);
  assert.throws(() => makeGatewayEvent({ ...base, sequence: 1.5 }), TypeError);
  assert.throws(() => makeGatewayEvent({ ...base, sequence: 1, event: 'not.an.event' }), TypeError);
  assert.throws(() => makeGatewayEvent({ sequence: 1, event: GATEWAY_EVENT.UNKNOWN }), TypeError);
});

test('validateGatewayEvent accepts a good event and rejects each broken shape', () => {
  const good = makeGatewayEvent({ sequence: 1, event: GATEWAY_EVENT.UNKNOWN, sessionId: SESSION });
  assert.equal(validateGatewayEvent(good).ok, true);

  assert.equal(validateGatewayEvent(null).ok, false);
  assert.equal(validateGatewayEvent({ ...good, sequence: -1 }).ok, false);
  assert.equal(validateGatewayEvent({ ...good, event: 'nope' }).ok, false);
  assert.equal(validateGatewayEvent({ ...good, session_id: '' }).ok, false);
  assert.equal(validateGatewayEvent({ ...good, timestamp: 123 }).ok, false);
  assert.equal(validateGatewayEvent({ ...good, source_sequence: 'x' }).ok, false);
});

test('domain events carry no secret-like field', () => {
  const event = makeGatewayEvent({
    sequence: 1,
    event: GATEWAY_EVENT.UNKNOWN,
    sessionId: SESSION,
    data: { note: 'ordinary' },
  });
  assert.equal(inspectForSecrets(event).clean, true);

  // Each forbidden name is caught, at any depth.
  for (const key of ['cookie', 'authorization', 'token', 'api_key', 'credentials', 'secret', 'password']) {
    assert.equal(inspectForSecrets({ [key]: 'value' }).clean, false, `${key} must be rejected`);
    assert.equal(
      inspectForSecrets({ nested: { deeper: { [key]: 'value' } } }).clean,
      false,
      `nested ${key} must be rejected`,
    );
    assert.equal(
      inspectForSecrets({ list: [{ [key]: 'value' }] }).clean,
      false,
      `array-nested ${key} must be rejected`,
    );
  }

  // A dsh-auth cookie name inside a string is caught too.
  assert.equal(inspectForSecrets({ note: 'dsh-auth-abcdefghijklmnop=value' }).clean, false);
});

test('a validated event rejects a secret-bearing payload', () => {
  const event = makeGatewayEvent({
    sequence: 1,
    event: GATEWAY_EVENT.UNKNOWN,
    sessionId: SESSION,
    data: { authorization: 'Bearer x' },
  });
  const check = validateGatewayEvent(event);
  assert.equal(check.ok, false);
  assert.match(check.reason, /secret-like/);
});
