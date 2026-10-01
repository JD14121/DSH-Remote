/**
 * Event fan-out tests — Phase R4 §15, §19, §20, §47.
 *
 * The registry's requirements are all isolation requirements, so most of this
 * suite is about what must *not* happen: no cross-session delivery, no sibling
 * damage from one client's failure, no duplicate DSH subscription introduced by
 * the WS layer.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { startWsServer, SESSION, OTHER_SESSION, emitGatewayEvent } from './r4-helpers.mjs';
import { SubscriberRegistry } from '../../src/remote/ws/subscriber-registry.mjs';
import { FRAME } from '../../src/remote/ws/protocol.mjs';
import { GATEWAY_EVENT } from '../../src/remote/model/event.mjs';

test('an event reaches the subscriber of its own session', async () => {
  const h = await startWsServer();
  try {
    const client = await h.connect({ session_id: SESSION });
    await client.waitForType(FRAME.REPLAY_COMPLETE);

    emitGatewayEvent(h, SESSION, GATEWAY_EVENT.SESSION_STATUS, { status: 'running' });
    await client.waitForType(FRAME.EVENT);

    assert.equal(client.ofType(FRAME.EVENT).length, 1);
    await client.close();
  } finally {
    await h.close();
  }
});

test('an event never reaches a subscriber of a different session', async () => {
  const h = await startWsServer();
  try {
    const a = await h.connect({ session_id: SESSION });
    const b = await h.connect({ session_id: OTHER_SESSION });
    await a.waitForType(FRAME.REPLAY_COMPLETE);
    await b.waitForType(FRAME.REPLAY_COMPLETE);

    emitGatewayEvent(h, SESSION, GATEWAY_EVENT.SESSION_STATUS, { status: 'running' });
    await a.waitForType(FRAME.EVENT);
    // Give any erroneous delivery a chance to arrive before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(a.ofType(FRAME.EVENT).length, 1, 'the owner received it');
    assert.equal(b.ofType(FRAME.EVENT).length, 0, 'the other session must not receive it');
    await a.close();
    await b.close();
  } finally {
    await h.close();
  }
});

test('two clients on the same session both receive every event', async () => {
  const h = await startWsServer();
  try {
    const a = await h.connect({ session_id: SESSION });
    const b = await h.connect({ session_id: SESSION });
    await a.waitForType(FRAME.REPLAY_COMPLETE);
    await b.waitForType(FRAME.REPLAY_COMPLETE);

    for (let index = 0; index < 3; index += 1) {
      emitGatewayEvent(h, SESSION, GATEWAY_EVENT.TASK_PROGRESS, { step: index });
    }
    await a.waitFor(() => a.ofType(FRAME.EVENT).length >= 3, 3000, 'a: 3 events');
    await b.waitFor(() => b.ofType(FRAME.EVENT).length >= 3, 3000, 'b: 3 events');

    assert.deepEqual(a.sequences(), b.sequences(), 'both clients see the same sequence set');
    await a.close();
    await b.close();
  } finally {
    await h.close();
  }
});

test('closing one client leaves its sibling subscribed', async () => {
  const h = await startWsServer();
  try {
    const a = await h.connect({ session_id: SESSION });
    const b = await h.connect({ session_id: SESSION });
    await a.waitForType(FRAME.REPLAY_COMPLETE);
    await b.waitForType(FRAME.REPLAY_COMPLETE);
    assert.equal(h.server.ws.registry.count(SESSION), 2);

    await a.close();
    // The registry only learns of the close asynchronously.
    await b.waitFor(() => h.server.ws.registry.count(SESSION) === 1, 3000, 'one subscriber left');

    emitGatewayEvent(h, SESSION, GATEWAY_EVENT.SESSION_STATUS, { status: 'running' });
    await b.waitForType(FRAME.EVENT);
    assert.equal(b.ofType(FRAME.EVENT).length, 1, 'the sibling still receives events');
    await b.close();
  } finally {
    await h.close();
  }
});

test('the full event vocabulary is delivered, including unknown events', async () => {
  const h = await startWsServer();
  try {
    const client = await h.connect({ session_id: SESSION });
    await client.waitForType(FRAME.REPLAY_COMPLETE);

    const names = [
      GATEWAY_EVENT.SESSION_STATUS,
      GATEWAY_EVENT.ASSISTANT_START,
      GATEWAY_EVENT.ASSISTANT_DELTA,
      GATEWAY_EVENT.ASSISTANT_END,
      GATEWAY_EVENT.MESSAGE_CREATED,
      GATEWAY_EVENT.TOOL_STARTED,
      GATEWAY_EVENT.TOOL_COMPLETED,
      GATEWAY_EVENT.UNKNOWN,
    ];
    for (const name of names) {
      emitGatewayEvent(h, SESSION, name, { name });
    }
    await client.waitFor(() => client.ofType(FRAME.EVENT).length >= names.length, 3000, 'all events');

    assert.deepEqual(client.ofType(FRAME.EVENT).map((frame) => frame.event.event), names);
    await client.close();
  } finally {
    await h.close();
  }
});

test('the Gateway sequence and the DSH source sequence both survive transport', async () => {
  const h = await startWsServer();
  try {
    const client = await h.connect({ session_id: SESSION });
    await client.waitForType(FRAME.REPLAY_COMPLETE);

    const emitted = h.eventsService.emit({
      sessionId: SESSION,
      event: GATEWAY_EVENT.MESSAGE_CREATED,
      data: { note: 'x' },
      sourceSequence: 418,
    });
    await client.waitForType(FRAME.EVENT);

    const frame = client.ofType(FRAME.EVENT)[0];
    assert.equal(frame.event.sequence, emitted.sequence, 'the Gateway sequence is preserved');
    assert.equal(frame.event.source_sequence, 418, 'the DSH source sequence is preserved');
    assert.notEqual(frame.event.sequence, frame.event.source_sequence, 'the two must never be conflated');
    await client.close();
  } finally {
    await h.close();
  }
});

test('the WS layer adds no second DSH subscription', async () => {
  // §19/§60: the WS layer consumes Gateway Events only. It must not open its own
  // adapter subscription to obtain them.
  const h = await startWsServer();
  try {
    const before = h.adapter.followSubscriptions?.size ?? 0;
    const client = await h.connect({ session_id: SESSION });
    await client.waitForType(FRAME.REPLAY_COMPLETE);
    emitGatewayEvent(h, SESSION, GATEWAY_EVENT.SESSION_STATUS, { status: 'running' });
    await client.waitForType(FRAME.EVENT);

    const after = h.adapter.followSubscriptions?.size ?? 0;
    assert.equal(after, before, 'connecting a WebSocket must not subscribe to DSH');
    const status = h.server.ws.stats();
    assert.equal(status.openClients, 1);
    await client.close();
  } finally {
    await h.close();
  }
});

test('a throwing subscriber does not break its sibling or the emitter', () => {
  const registry = new SubscriberRegistry();
  const good = { delivered: [], deliver(event) { this.delivered.push(event.sequence); return true; } };
  const bad = { deliver() { throw new Error('subscriber exploded'); } };
  const other = { delivered: [], deliver(event) { this.delivered.push(event.sequence); return true; } };

  registry.subscribe('s1', good);
  registry.subscribe('s1', bad);
  registry.subscribe('s1', other);

  const event = { session_id: 's1', sequence: 7 };
  const delivered = registry.publish(event);

  assert.equal(delivered, 2, 'the two healthy subscribers received it');
  assert.deepEqual(good.delivered, [7]);
  assert.deepEqual(other.delivered, [7]);
  assert.equal(registry.publishFailures, 1);
});

test('the registry is per-session and its counts are honest', () => {
  const registry = new SubscriberRegistry();
  const a = { deliver: () => true };
  const b = { deliver: () => true };

  registry.subscribe('s1', a);
  registry.subscribe('s1', b);
  registry.subscribe('s2', a);

  assert.equal(registry.count('s1'), 2);
  assert.equal(registry.count('s2'), 1);
  assert.equal(registry.count('s3'), 0);
  assert.equal(registry.size, 3);
  assert.deepEqual(registry.sessions().sort(), ['s1', 's2']);
  assert.equal(registry.publish({ session_id: 's3' }), 0, 'an unknown session delivers nothing');

  // Unsubscribe is idempotent.
  assert.equal(registry.unsubscribe('s1', a), true);
  assert.equal(registry.unsubscribe('s1', a), false);
  assert.equal(registry.unsubscribe('nope', a), false);

  // unsubscribeAll clears every registration for one client.
  assert.equal(registry.unsubscribeAll(a), 1);
  assert.equal(registry.count('s2'), 0);
  assert.equal(registry.count('s1'), 1);
});

test('the registry closes every client and empties itself', async () => {
  const registry = new SubscriberRegistry();
  const closed = [];
  const a = { deliver: () => true, close: async (reason) => { closed.push(['a', reason]); } };
  const b = { deliver: () => true, close: async (reason) => { closed.push(['b', reason]); } };
  registry.subscribe('s1', a);
  registry.subscribe('s2', b);

  const count = await registry.closeAll('shutdown');
  assert.equal(count, 2);
  assert.equal(registry.isEmpty, true);
  assert.equal(registry.size, 0);
  assert.deepEqual(closed.map((entry) => entry[0]).sort(), ['a', 'b']);
});

test('the registry holds no event state of its own', async () => {
  // §20 forbids a second event log; the ring belongs to EventsService.
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../src/remote/ws/subscriber-registry.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // Check for state *fields*, not substrings: `during` and `ring` inside prose
  // identifiers would otherwise produce a false positive.
  for (const banned of [
    'this.eventLog',
    'this.history',
    'this.buffer',
    'this.replay',
    'this.sequences',
    'this.lastSequence',
  ]) {
    assert.equal(code.includes(banned), false, `the registry must not keep ${banned}`);
  }
  // It must not import the wire layer either.
  for (const match of code.matchAll(/from\s*['"]([^'"]+)['"]/g)) {
    assert.equal(/(^|\/)wire\//.test(match[1]), false, `the registry must not import ${match[1]}`);
  }
});

test('a session with no subscribers costs nothing', async () => {
  const h = await startWsServer();
  try {
    // No client at all: emitting must still succeed and consume a sequence.
    const event = emitGatewayEvent(h, SESSION, GATEWAY_EVENT.SESSION_STATUS, { status: 'idle' });
    assert.equal(typeof event.sequence, 'number');
    assert.equal(h.server.ws.registry.publish(event), 0);
  } finally {
    await h.close();
  }
});
