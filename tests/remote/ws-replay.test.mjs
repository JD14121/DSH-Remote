/**
 * Replay tests — Phase R4 §21-§26, §48.
 *
 * The cases are the four from §23. The important one is the race: an event that
 * arrives *while* replay is in progress must be delivered exactly once and in
 * strict order, never lost and never duplicated.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { startWsServer, SESSION, emitGatewayEvent } from './r4-helpers.mjs';
import { FRAME } from '../../src/remote/ws/protocol.mjs';
import { REPLAY_OUTCOME, beginReplay, decideReplay, verifyStrictOrder } from '../../src/remote/ws/replay.mjs';
import { GATEWAY_EVENT } from '../../src/remote/model/event.mjs';
import { EventsService } from '../../src/remote/events.mjs';
import { SessionViewStore } from '../../src/remote/state/session-view-store.mjs';
import { makeSession } from '../../src/remote/model/session.mjs';

/** Emit `count` events for a session. */
function emitMany(h, count) {
  const emitted = [];
  for (let index = 0; index < count; index += 1) {
    emitted.push(emitGatewayEvent(h, SESSION, GATEWAY_EVENT.TASK_PROGRESS, { step: index }));
  }
  return emitted;
}

test('case A: last_sequence equal to latest replays nothing', () => {
  const decision = decideReplay({ requested: 5, earliest: 1, latest: 5 });
  assert.equal(decision.outcome, REPLAY_OUTCOME.LIVE);
  assert.equal(decision.mode, 'live_only');
});

test('case B: a retained gap replays exactly the missing range', () => {
  const decision = decideReplay({ requested: 3, earliest: 1, latest: 9 });
  assert.equal(decision.outcome, REPLAY_OUTCOME.REPLAY);
  assert.equal(decision.mode, 'replay');
  assert.equal(decision.from, 4);
  assert.equal(decision.through, 9);
});

test('case B boundary: earliest-1 is still replayable', () => {
  // The client holds everything up to just before the oldest retained event, so
  // the gap is exactly the ring and nothing is missing.
  const decision = decideReplay({ requested: 4, earliest: 5, latest: 9 });
  assert.equal(decision.outcome, REPLAY_OUTCOME.REPLAY);
  assert.equal(decision.from, 5);
  assert.equal(decision.through, 9);
});

test('case C: a gap older than the ring requires resync', () => {
  const decision = decideReplay({ requested: 3, earliest: 5, latest: 9 });
  assert.equal(decision.outcome, REPLAY_OUTCOME.RESYNC);
  assert.equal(decision.reason, 'gap_not_available');
  assert.equal(decision.action, 'refresh_rest_state');
});

test('case D: a watermark ahead of the server requires resync, not a false "no events"', () => {
  const decision = decideReplay({ requested: 99, earliest: 5, latest: 9 });
  assert.equal(decision.outcome, REPLAY_OUTCOME.RESYNC);
  assert.equal(decision.reason, 'sequence_ahead_of_server');
});

test('no watermark is live-only, and a zero watermark on an empty ring is not a gap', () => {
  assert.equal(decideReplay({ requested: null, earliest: 1, latest: 9 }).outcome, REPLAY_OUTCOME.LIVE);
  // A brand-new client on a session with no retained events has missed nothing.
  assert.equal(decideReplay({ requested: 0, earliest: null, latest: null, highWater: 0 }).outcome, REPLAY_OUTCOME.LIVE);
  // But a client claiming history on an empty ring is ahead of the server.
  assert.equal(decideReplay({ requested: 7, earliest: null, latest: null, highWater: 0 }).outcome, REPLAY_OUTCOME.RESYNC);
});

test('an empty ring with a stale watermark never claims a complete replay', () => {
  const decision = decideReplay({ requested: 40, earliest: null, latest: null, highWater: 3 });
  assert.equal(decision.outcome, REPLAY_OUTCOME.RESYNC);
  assert.equal(decision.reason, 'sequence_ahead_of_server');
});

test('one-event replay delivers exactly the missing event', async () => {
  const h = await startWsServer();
  try {
    emitMany(h, 4);
    const client = await h.connect({ last_sequence: 3 });
    await client.waitForType(FRAME.REPLAY_COMPLETE);

    assert.deepEqual(client.sequences(), [4]);
    assert.equal(client.ofType(FRAME.REPLAY_COMPLETE)[0].replayed, 1);
    assert.equal(client.ofType(FRAME.HELLO)[0].replay.requested_from, 3);
    assert.equal(client.ofType(FRAME.HELLO)[0].replay.mode, 'replay');
    await client.close();
  } finally {
    await h.close();
  }
});

test('many-event replay is strictly ordered with no duplicates', async () => {
  const h = await startWsServer();
  try {
    emitMany(h, 40);
    const client = await h.connect({ last_sequence: 0 });
    await client.waitForType(FRAME.REPLAY_COMPLETE);

    const sequences = client.sequences();
    assert.equal(sequences.length, 40);
    assert.deepEqual(sequences, Array.from({ length: 40 }, (_, index) => index + 1));
    assert.deepEqual(verifyStrictOrder(sequences.map((sequence) => ({ sequence }))), { ok: true, reason: null });
    await client.close();
  } finally {
    await h.close();
  }
});

test('the critical race: an event arriving during replay is delivered exactly once', async () => {
  // The handoff is exercised at the unit level so the timing is deterministic
  // rather than dependent on socket scheduling.
  const S = 'session-00000000-0000-0000-0000-000000000001';
  const store = new SessionViewStore({ clock: () => 1_789_800_000_000 });
  store.upsertSession(makeSession({ id: S }));
  const events = new EventsService({ adapter: {}, store, clock: () => 1_789_800_000_000 });

  for (let index = 0; index < 5; index += 1) events.emit({ sessionId: S, event: 'task.progress', data: { index } });

  // Begin the handoff: the live listener is registered before the boundary read.
  const { handle, historical, decision } = await beginReplay({ events, sessionId: S, requested: 2 });
  assert.equal(decision.outcome, REPLAY_OUTCOME.REPLAY);
  assert.deepEqual(historical.map((event) => event.sequence), [3, 4, 5]);

  // Now an event arrives *while* the historical frames are being sent.
  events.emit({ sessionId: S, event: 'task.progress', data: { index: 99 } });

  const flushed = handle.flush();
  assert.deepEqual(flushed.map((event) => event.sequence), [6], 'the raced event is captured, not lost');

  // Nothing is sent twice: history covered 3-5, the flush covers 6.
  const all = [...historical, ...flushed].map((event) => event.sequence);
  assert.deepEqual(all, [3, 4, 5, 6]);
  assert.deepEqual(verifyStrictOrder(all.map((sequence) => ({ sequence }))), { ok: true, reason: null });
  handle.stop();
});

test('an event captured during replay but already sent as history is not repeated', async () => {
  const S = 'session-00000000-0000-0000-0000-000000000001';
  const store = new SessionViewStore({ clock: () => 1_789_800_000_000 });
  store.upsertSession(makeSession({ id: S }));
  const events = new EventsService({ adapter: {}, store, clock: () => 1_789_800_000_000 });

  for (let index = 0; index < 4; index += 1) events.emit({ sessionId: S, event: 'task.progress', data: { index } });

  const { handle, historical } = await beginReplay({ events, sessionId: S, requested: 0 });
  assert.deepEqual(historical.map((event) => event.sequence), [1, 2, 3, 4]);

  // The listener captured everything emitted after registration, which includes
  // the events already present when the boundary was read.
  const flushed = handle.flush();
  assert.deepEqual(flushed, [], 'nothing at or below the boundary may be re-sent');
  handle.stop();
});

test('events for other sessions are not captured by this handoff', async () => {
  const S = 'session-00000000-0000-0000-0000-000000000001';
  const OTHER = 'session-00000000-0000-0000-0000-000000000002';
  const store = new SessionViewStore({ clock: () => 1_789_800_000_000 });
  for (const id of [S, OTHER]) store.upsertSession(makeSession({ id }));
  const events = new EventsService({ adapter: {}, store, clock: () => 1_789_800_000_000 });

  events.emit({ sessionId: S, event: 'task.progress' });
  const { handle } = await beginReplay({ events, sessionId: S, requested: 0 });
  events.emit({ sessionId: OTHER, event: 'task.progress' });
  events.emit({ sessionId: S, event: 'task.progress' });

  const flushed = handle.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].session_id, S);
  handle.stop();
});

test('replay followed by live delivery stays gap-free across the handoff', async () => {
  const h = await startWsServer();
  try {
    emitMany(h, 3);
    const client = await h.connect({ last_sequence: 1 });
    // Wait for the handoff to complete before emitting live events, otherwise the
    // events race the replay boundary and the test would be measuring scheduling.
    await client.waitForType(FRAME.REPLAY_COMPLETE);
    assert.deepEqual(client.sequences(), [2, 3], 'the historical gap was replayed');

    // Live events strictly after the handoff.
    for (let index = 0; index < 5; index += 1) {
      emitGatewayEvent(h, SESSION, GATEWAY_EVENT.TASK_PROGRESS, { index });
    }
    await client.waitFor(() => client.sequences().length >= 7, 3000, 'seven sequences');

    // Contiguous across the handoff: no gap, no repeat at the seam.
    assert.deepEqual(client.sequences(), [2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(
      verifyStrictOrder(client.sequences().map((sequence) => ({ sequence }))),
      { ok: true, reason: null },
    );
    await client.close();
  } finally {
    await h.close();
  }
});

test('events emitted during an unfinished replay land on exactly one side of the seam', async () => {
  // This is the §26 race driven through a real socket. Events are emitted while
  // the handshake is still in flight, so some are captured as history and some
  // wait in the handoff queue. Whichever side captures them, each sequence must
  // appear exactly once, strictly ascending, and every replayed event must arrive
  // *before* `replay_complete` — the marker is what tells the client where live
  // delivery begins.
  const h = await startWsServer();
  try {
    emitMany(h, 3);

    const connected = h.connect({ last_sequence: 1 });
    // Emit immediately, without waiting for the handshake to settle.
    for (let index = 0; index < 5; index += 1) {
      emitGatewayEvent(h, SESSION, GATEWAY_EVENT.TASK_PROGRESS, { index });
    }

    const client = await connected;
    await client.waitForType(FRAME.REPLAY_COMPLETE);
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Every produced sequence is delivered exactly once, in strict order, and —
    // because the handoff drain is a synchronous barrier — every one of them lands
    // *before* the marker, which is what makes the seam meaningful.
    const sequences = client.sequences();
    assert.deepEqual(sequences, [2, 3, 4, 5, 6, 7, 8], 'all seven, in order');
    assert.deepEqual(sequences, [...new Set(sequences)], 'no sequence is delivered twice');
    assert.deepEqual(
      verifyStrictOrder(sequences.map((sequence) => ({ sequence }))),
      { ok: true, reason: null },
    );

    // The seam: `hello`, then every event, then the marker, and nothing but
    // control frames after it.
    const markerIndex = client.frames.findIndex((frame) => frame.type === FRAME.REPLAY_COMPLETE);
    assert.ok(markerIndex > 0, 'the marker exists');
    assert.equal(client.frames[0].type, FRAME.HELLO, 'hello is always first');
    for (const [index, frame] of client.frames.entries()) {
      if (index === 0) continue; // hello
      if (index < markerIndex) {
        assert.equal(frame.type, FRAME.EVENT, `frame ${index} before the seam must be an event`);
      } else if (index > markerIndex) {
        assert.notEqual(frame.type, FRAME.EVENT, 'no event may follow the seam marker');
      }
    }
    await client.close();
  } finally {
    await h.close();
  }
});

test('replay reads only the in-memory ring and touches no disk', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../src/remote/ws/replay.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['node:fs', 'writeFile', 'readFile', 'zstd', 'jsonl', 'sqlite', 'DSH_HOME']) {
    assert.equal(code.includes(banned), false, `replay.mjs must not reference ${banned}`);
  }
});

test('replay never regenerates a sequence, it only reads the ring', () => {
  // A replay source that could mint sequences would be able to invent history.
  const events = new EventsService({
    adapter: {},
    store: new SessionViewStore({ clock: () => 1 }),
    clock: () => 1,
  });
  const S = 'session-00000000-0000-0000-0000-000000000001';
  events.store.upsertSession(makeSession({ id: S }));
  for (let index = 0; index < 3; index += 1) events.emit({ sessionId: S, event: 'task.progress' });

  const first = events.eventsAfter(S, 0).map((event) => event.sequence);
  const second = events.eventsAfter(S, 0).map((event) => event.sequence);
  assert.deepEqual(first, [1, 2, 3]);
  assert.deepEqual(second, first, 'reading replay data must not advance the allocator');
});

test('verifyStrictOrder actually detects gaps and duplicates', () => {
  assert.deepEqual(verifyStrictOrder([{ sequence: 1 }, { sequence: 2 }]), { ok: true, reason: null });
  assert.equal(verifyStrictOrder([{ sequence: 1 }, { sequence: 3 }]).ok, false);
  assert.match(verifyStrictOrder([{ sequence: 1 }, { sequence: 3 }]).reason, /gap/);
  assert.equal(verifyStrictOrder([{ sequence: 2 }, { sequence: 2 }]).ok, false);
  assert.match(verifyStrictOrder([{ sequence: 2 }, { sequence: 2 }]).reason, /duplicate/);
  assert.equal(verifyStrictOrder([{ sequence: 3 }, { sequence: 2 }]).ok, false);
  assert.equal(verifyStrictOrder([{ sequence: 'x' }]).ok, false);
});
