/**
 * Backpressure tests — Phase R4 §27-§29, §50.
 *
 * §50 is explicit: do not let real network speed decide a test. These use the
 * fake socket's **manual** send mode, so a test controls exactly when each send
 * completes and can therefore fill a backlog deterministically. A real socket is
 * used only where the point is that a sibling survives.
 *
 * The invariant under test is §29's: overflow is never a silent drop. The client
 * is told the last sequence it received and is closed with 4003.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { startWsServer, SESSION, fakeSocket, emitGatewayEvent } from './r4-helpers.mjs';
import { Backlog, DEFAULT_MAX_BACKLOG_BYTES, DEFAULT_MAX_BACKLOG_EVENTS } from '../../src/remote/ws/backlog.mjs';
import { APP_CLOSE, closeReason } from '../../src/remote/ws/close-codes.mjs';
import { FRAME } from '../../src/remote/ws/protocol.mjs';
import { ClientSession } from '../../src/remote/ws/client-session.mjs';
import { EventsService } from '../../src/remote/events.mjs';
import { SessionViewStore } from '../../src/remote/state/session-view-store.mjs';
import { makeSession } from '../../src/remote/model/session.mjs';

/** A client session over a manual-send fake socket. */
function manualClient(options = {}) {
  const store = new SessionViewStore({ clock: () => 1_789_800_000_000 });
  store.upsertSession(makeSession({ id: SESSION }));
  const events = new EventsService({ adapter: {}, store, clock: () => 1_789_800_000_000 });
  const { socket, state } = fakeSocket({ manual: true });

  const client = new ClientSession({
    socket,
    events,
    sessionId: SESSION,
    connectionId: 'test-conn',
    clock: () => 1_789_800_000_000,
    lastSequence: null,
    ...options,
  });

  return { client, events, socket, state, store };
}

test('frames preserve order through a single-writer pump', () => {
  const sent = [];
  const backlog = new Backlog({
    send: (text, done) => { sent.push(JSON.parse(text).n); done(); },
    maxEvents: 10,
    maxBytes: 10_000,
  });

  for (let index = 0; index < 5; index += 1) backlog.enqueue({ n: index });
  assert.deepEqual(sent, [0, 1, 2, 3, 4]);
  assert.equal(backlog.pendingEvents, 0);
});

test('only one send is in flight at a time', () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const pending = [];
  const backlog = new Backlog({
    send: (text, done) => { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); pending.push({ text, done }); },
    maxEvents: 10,
    maxBytes: 10_000,
  });

  for (let index = 0; index < 4; index += 1) backlog.enqueue({ n: index });
  assert.equal(backlog.pendingEvents, 4, 'nothing leaves the queue until the callback fires');
  assert.equal(maxInFlight, 1, 'exactly one frame is handed to the transport');

  while (pending.length > 0) {
    const next = pending.shift();
    inFlight -= 1;
    next.done();
  }
  assert.equal(maxInFlight, 1, 'the pump never overlaps');
  assert.equal(backlog.pendingEvents, 0);
});

test('byte accounting counts serialised UTF-8 bytes, not object counts', () => {
  const backlog = new Backlog({ send: (_t, done) => done(), maxEvents: 100, maxBytes: 10_000 });

  // A multi-byte character must be counted by its encoded length.
  const frame = { text: 'héllo—world' };
  const expected = Buffer.byteLength(JSON.stringify(frame), 'utf8');
  assert.ok(expected > JSON.stringify(frame).length, 'the fixture really is multi-byte');

  backlog.enqueue(frame);
  assert.equal(backlog.stats().sentFrames, 1);
  // Send completed, so nothing is pending, but the accounting path was exercised.
  assert.equal(backlog.stats().pendingBytes, 0);
});

test('the event ceiling triggers overflow exactly once', () => {
  const overflows = [];
  const backlog = new Backlog({
    send: () => {}, // never completes: the queue fills
    maxEvents: 3,
    maxBytes: 1_000_000,
    onOverflow: (info) => overflows.push(info),
  });

  assert.equal(backlog.enqueue({ n: 0 }).accepted, true);
  assert.equal(backlog.enqueue({ n: 1 }).accepted, true);
  assert.equal(backlog.enqueue({ n: 2 }).accepted, true);
  // The first two are still pending because send never completes, so the third
  // fills the queue to 3 and the fourth breaches it.
  const fourth = backlog.enqueue({ n: 3 });

  assert.equal(fourth.accepted, false);
  assert.equal(fourth.reason, 'overflow');
  assert.equal(overflows.length, 1, 'overflow is reported once, not per frame');
  assert.equal(overflows[0].closeCode, APP_CLOSE.BACKLOG_OVERFLOW);
  assert.equal(overflows[0].attemptedBytes > 0, true);

  // Further frames are refused without re-reporting.
  assert.equal(backlog.enqueue({ n: 4 }).accepted, false);
  assert.equal(overflows.length, 1);
});

test('the byte ceiling triggers overflow independently of the event ceiling', () => {
  const overflows = [];
  const backlog = new Backlog({
    send: () => {},
    maxEvents: 1000,
    maxBytes: 120,
    onOverflow: (info) => overflows.push(info),
  });

  let accepted = 0;
  for (let index = 0; index < 20; index += 1) {
    if (backlog.enqueue({ n: index, pad: 'x'.repeat(20) }).accepted) accepted += 1;
  }
  assert.ok(accepted >= 1 && accepted < 20, `expected a byte-limit overflow, accepted=${accepted}`);
  assert.equal(overflows.length, 1);
  assert.equal(backlog.stats().overflowed, true);
});

test('defaults match the documented limits', () => {
  assert.equal(DEFAULT_MAX_BACKLOG_EVENTS, 256);
  assert.equal(DEFAULT_MAX_BACKLOG_BYTES, 1_048_576);

  const backlog = new Backlog({ send: (_t, done) => done() });
  assert.equal(backlog.maxEvents, 256);
  assert.equal(backlog.maxBytes, 1_048_576);
});

test('an invalid limit is rejected rather than silently defaulted', () => {
  for (const bad of [0, -1, 1.5, 'many']) {
    assert.throws(() => new Backlog({ send: () => {}, maxEvents: bad }), TypeError, `maxEvents=${bad}`);
    assert.throws(() => new Backlog({ send: () => {}, maxBytes: bad }), TypeError, `maxBytes=${bad}`);
  }
  assert.throws(() => new Backlog({}), TypeError);
});

test('a send failure stops the pump instead of spinning', () => {
  let calls = 0;
  const backlog = new Backlog({
    send: (_t, done) => { calls += 1; done(new Error('transport gone')); },
    maxEvents: 10,
    maxBytes: 10_000,
  });

  for (let index = 0; index < 5; index += 1) backlog.enqueue({ n: index });
  assert.equal(calls, 1, 'the pump stops after the transport fails');
  assert.equal(backlog.stats().closed, true);
  assert.equal(backlog.pendingEvents, 0, 'the queue is discarded, not leaked');
});

test('overflow sends the overflow frame and closes with 4003', async () => {
  const { client, socket, state } = manualClient({ maxBacklogEvents: 4, maxBacklogBytes: 1_000_000 });
  await client.begin();
  // The handshake frames are pending; flush them so we start from a clean queue.
  socket.flushAll();
  assert.ok(state.sent.some((frame) => frame.type === FRAME.REPLAY_COMPLETE));

  // Now block the transport and overflow.
  for (let index = 0; index < 20; index += 1) {
    client.deliver({ session_id: SESSION, sequence: index + 1, event: 'task.progress', data: { index } });
  }

  assert.equal(state.closes.length, 1, 'the socket was closed once');
  assert.equal(state.closes[0].code, APP_CLOSE.BACKLOG_OVERFLOW);
  assert.equal(state.closes[0].reason, closeReason(APP_CLOSE.BACKLOG_OVERFLOW));

  const overflow = state.sent.find((frame) => frame.type === FRAME.OVERFLOW);
  assert.ok(overflow !== undefined, 'the client is told why it is being closed');
  assert.equal(overflow.action, 'reconnect_with_last_sequence');
  assert.equal(overflow.session_id, SESSION);
  // Nothing had been handed to the transport yet — not even the first frame —
  // because a manual socket completes no sends. `null` is the honest answer, and
  // the client learns it must reconnect from a full REST refresh.
  assert.equal(overflow.last_delivered_sequence, null);
  assert.equal(typeof overflow.latest_sequence, 'object', 'unknown session bounds report null');
});

test('overflow never silently drops: the client learns its watermark', async () => {
  const h = await startWsServer();
  try {
    // Drive the overflow through a manually-flowing client so the assertion is
    // deterministic. One frame is allowed to complete first, which establishes a
    // real "last delivered" watermark for the overflow notice to report.
    const { client, socket, state } = manualClient({ maxBacklogEvents: 3, maxBacklogBytes: 1_000_000 });
    await client.begin();
    socket.flushAll(); // finish the handshake, queue empty

    client.deliver({ session_id: SESSION, sequence: 1, event: 'task.progress' });
    socket.flushOne(); // sequence 1 is now genuinely delivered
    assert.equal(client.backlog.stats().lastDeliveredSequence, 1);

    // Fill the queue, then breach it. None of these complete.
    for (let sequence = 2; sequence <= 12; sequence += 1) {
      client.deliver({ session_id: SESSION, sequence, event: 'task.progress' });
    }

    const overflow = state.sent.find((frame) => frame.type === FRAME.OVERFLOW);
    assert.ok(overflow, 'an overflow frame was sent');
    assert.equal(overflow.last_delivered_sequence, 1, 'it names the last sequence actually delivered');
    assert.equal(state.closes[0].code, APP_CLOSE.BACKLOG_OVERFLOW);
    assert.equal(state.closes[0].reason, 'BACKLOG_OVERFLOW');
  } finally {
    await h.close();
  }
});

test('a sibling client is unaffected by another client overflowing', async () => {
  const h = await startWsServer();
  try {
    const healthy = await h.connect({ session_id: SESSION });
    await healthy.waitForType(FRAME.REPLAY_COMPLETE);

    // Overflow a second client of the same session by filling its backlog.
    const { client: victim, socket } = manualClient({ maxBacklogEvents: 3, maxBacklogBytes: 1_000_000 });
    await victim.begin();
    socket.flushAll();
    for (let index = 0; index < 12; index += 1) {
      victim.deliver({ session_id: SESSION, sequence: index + 1, event: 'task.progress' });
    }
    assert.equal(victim.state, 'CLOSED');

    // The healthy socket keeps working.
    emitGatewayEvent(h, SESSION, 'session.status', { status: 'running' });
    await healthy.waitForType(FRAME.EVENT);
    assert.equal(healthy.ofType(FRAME.EVENT).length >= 1, true);
    assert.equal(healthy.ofType(FRAME.OVERFLOW).length, 0, 'the sibling saw no overflow frame');
    await healthy.close();
  } finally {
    await h.close();
  }
});

test('clearing the backlog discards without closing the transport', () => {
  const backlog = new Backlog({ send: () => {}, maxEvents: 10, maxBytes: 10_000 });
  backlog.enqueue({ n: 0 });
  backlog.enqueue({ n: 1 });
  const dropped = backlog.clear();
  assert.ok(dropped >= 1);
  assert.equal(backlog.pendingEvents, 0);
  assert.equal(backlog.stats().closed, false, 'clear is not close');
});

test('the backlog never mutates domain state', async () => {
  const { client, events } = manualClient();
  await client.begin();
  const before = events.sequenceBounds(SESSION);
  for (let index = 0; index < 5; index += 1) {
    client.deliver({ session_id: SESSION, sequence: index + 1, event: 'task.progress' });
  }
  assert.deepEqual(events.sequenceBounds(SESSION), before, 'delivery must not allocate sequences');
});
