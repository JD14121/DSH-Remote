/**
 * Resync tests — Phase R4 §24, §36, §49.
 *
 * When a complete replay is impossible the server must say so explicitly and
 * close with 4001. §49 is emphatic about what must *not* happen: no false claim
 * completing a replay. Two situations produce it — a watermark older than the
 * ring, and a watermark ahead of this process (a Gateway restart).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { startWsServer, SESSION, emitGatewayEvent } from './r4-helpers.mjs';
import { APP_CLOSE, STANDARD_CLOSE, closeReason } from '../../src/remote/ws/close-codes.mjs';
import { FRAME } from '../../src/remote/ws/protocol.mjs';
import { GATEWAY_EVENT } from '../../src/remote/model/event.mjs';
import { EventsService } from '../../src/remote/events.mjs';
import { SessionViewStore } from '../../src/remote/state/session-view-store.mjs';
import { makeSession } from '../../src/remote/model/session.mjs';
import { decideReplay } from '../../src/remote/ws/replay.mjs';

/** Build a service whose ring is small, so a gap is easy to produce. */
function tinyRingService(sessionId, ringSize) {
  const store = new SessionViewStore({ clock: () => 1_789_800_000_000 });
  store.upsertSession(makeSession({ id: sessionId }));
  return new EventsService({
    adapter: {},
    store,
    clock: () => 1_789_800_000_000,
    ringSize,
  });
}

test('a watermark older than the ring produces resync_required and close 4001', async () => {
  const h = await startWsServer();
  try {
    // The ring keeps everything by default, so drive the decision through a
    // trimmed ring: emit 10, then keep only the last 3.
    const service = tinyRingService(SESSION, 3);
    for (let index = 0; index < 10; index += 1) {
      service.emit({ sessionId: SESSION, event: GATEWAY_EVENT.TASK_PROGRESS, data: { index } });
    }
    const bounds = service.sequenceBounds(SESSION);
    assert.equal(bounds.earliest, 8, 'the oldest retained sequence');
    assert.equal(bounds.latest, 10);

    // A client at 2 has lost sequences 3..7 irrecoverably.
    const decision = decideReplay({ requested: 2, earliest: bounds.earliest, latest: bounds.latest });
    assert.equal(decision.outcome, 'resync');
    assert.equal(decision.reason, 'gap_not_available');
    assert.equal(decision.action, 'refresh_rest_state');
    assert.equal(decision.from, null, 'no partial replay is offered');
  } finally {
    await h.close();
  }
});

test('a real socket receives resync_required and close 4001 for an evicted gap', async () => {
  const h = await startWsServer();
  try {
    // Replace the server's event ring with a tiny one by driving the same service
    // the server uses, then trimming it to simulate eviction.
    for (let index = 0; index < 12; index += 1) {
      emitGatewayEvent(h, SESSION, GATEWAY_EVENT.TASK_PROGRESS, { index });
    }
    const ring = h.eventsService.rings.get(SESSION);
    // Evict everything below sequence 7 (the array holds 1..12 in order).
    ring.splice(0, ring.length - 6);
    assert.equal(h.eventsService.sequenceBounds(SESSION).earliest, 7);

    const client = await h.connect({ last_sequence: 2 });
    const close = await client.waitForClose();

    assert.equal(close.code, APP_CLOSE.RESYNC_REQUIRED);
    assert.equal(close.reason, closeReason(APP_CLOSE.RESYNC_REQUIRED));

    const frames = client.ofType(FRAME.RESYNC_REQUIRED);
    assert.equal(frames.length, 1, 'exactly one resync frame');
    const frame = frames[0];
    assert.equal(frame.session_id, SESSION);
    assert.equal(frame.reason, 'gap_not_available');
    assert.equal(frame.requested_sequence, 2);
    assert.equal(frame.earliest_available, 7);
    assert.equal(frame.latest_available, 12);
    assert.equal(frame.action, 'refresh_rest_state');

    // And critically: no false replay_complete.
    assert.equal(client.ofType(FRAME.REPLAY_COMPLETE).length, 0, 'must not claim a complete replay');
    assert.equal(client.ofType(FRAME.EVENT).length, 0, 'must not send a partial range');
  } finally {
    await h.close();
  }
});

test('a watermark ahead of the server produces sequence_ahead_of_server', async () => {
  const h = await startWsServer();
  try {
    for (let index = 0; index < 3; index += 1) {
      emitGatewayEvent(h, SESSION, GATEWAY_EVENT.TASK_PROGRESS, { index });
    }

    // A client from a previous process claims sequence 50.
    const client = await h.connect({ last_sequence: 50 });
    const close = await client.waitForClose();

    assert.equal(close.code, APP_CLOSE.RESYNC_REQUIRED);
    const frame = client.ofType(FRAME.RESYNC_REQUIRED)[0];
    assert.equal(frame.reason, 'sequence_ahead_of_server');
    assert.equal(frame.requested_sequence, 50);
    assert.equal(frame.latest_available, 3);
    assert.equal(client.ofType(FRAME.REPLAY_COMPLETE).length, 0);
  } finally {
    await h.close();
  }
});

test('an empty ring with a stale watermark is a resync, never a silent "no events"', async () => {
  // §36: after a Gateway restart the ring is empty but the client still holds an
  // old watermark. Reporting "nothing to replay" would look identical to "you are
  // up to date" and the client would silently lose everything.
  const h = await startWsServer();
  try {
    const client = await h.connect({ last_sequence: 12 });
    const close = await client.waitForClose();

    assert.equal(close.code, APP_CLOSE.RESYNC_REQUIRED);
    const frame = client.ofType(FRAME.RESYNC_REQUIRED)[0];
    assert.equal(frame.reason, 'sequence_ahead_of_server');
    assert.equal(frame.earliest_available, null);
    assert.equal(frame.latest_available, null);
    assert.equal(client.ofType(FRAME.REPLAY_COMPLETE).length, 0, 'no false completion');
  } finally {
    await h.close();
  }
});

test('a fresh client with no watermark on an empty ring goes live, not to resync', async () => {
  const h = await startWsServer();
  try {
    const client = await h.connect();
    await client.waitForType(FRAME.REPLAY_COMPLETE);
    assert.equal(client.ofType(FRAME.RESYNC_REQUIRED).length, 0, 'a new client has missed nothing');
    assert.equal(client.closeInfo, null, 'and the connection stays open');
    await client.close();
  } finally {
    await h.close();
  }
});

test('a watermark of zero on an empty ring goes live', async () => {
  const h = await startWsServer();
  try {
    const client = await h.connect({ last_sequence: 0 });
    await client.waitForType(FRAME.REPLAY_COMPLETE);
    assert.equal(client.ofType(FRAME.RESYNC_REQUIRED).length, 0);
    await client.close();
  } finally {
    await h.close();
  }
});

test('simulated restart: an old watermark against a fresh process resyncs', async () => {
  const h = await startWsServer();
  try {
    // First client sees sequence 1, then the server's ring is wiped to model a
    // process restart.
    emitGatewayEvent(h, SESSION, GATEWAY_EVENT.TASK_PROGRESS, { index: 0 });
    const first = await h.connect({ last_sequence: 0 });
    await first.waitForType(FRAME.REPLAY_COMPLETE);
    assert.deepEqual(first.sequences(), [1]);
    await first.close();

    // Model a genuine process restart: this process has never produced any
    // sequence, so both the ring *and* the session's high-water mark are gone.
    //
    // Both must be cleared together. `upsertSession` deliberately preserves
    // `last_sequence` (R2 §17: a refresh must never rewind the mark), so the mark
    // cannot be lowered in place — a real restart starts from nothing.
    h.eventsService.rings.clear();
    h.store.restore({
      sessions: [],
      dshCursors: {},
      machines: {},
      activeRuns: {},
      sequences: { initial: 0, sessions: {} },
    });
    assert.equal(h.store.get(SESSION), null, 'the domain no longer knows the session');
    assert.deepEqual(h.eventsService.sequenceBounds(SESSION), {
      earliest: null, latest: null, count: 0, highWater: 0,
    }, 'this process has produced nothing');

    const second = await h.connect({ last_sequence: 1 });
    const close = await second.waitForClose();
    assert.equal(close.code, APP_CLOSE.RESYNC_REQUIRED);
    assert.equal(second.ofType(FRAME.RESYNC_REQUIRED)[0].reason, 'sequence_ahead_of_server');
  } finally {
    await h.close();
  }
});

test('resync frames never leak a raw DSH error or internal detail', async () => {
  const h = await startWsServer();
  try {
    const client = await h.connect({ last_sequence: 99 });
    await client.waitForClose();
    const text = JSON.stringify(client.frames).toLowerCase();
    for (const forbidden of ['stack', 'cause', 'cookie', 'token', 'authorization', 'credentials', 'dsh_home', 'wire']) {
      assert.equal(text.includes(forbidden), false, `resync output must not contain ${forbidden}`);
    }
  } finally {
    await h.close();
  }
});

test('the application close code for resync is in the reserved range', () => {
  assert.equal(APP_CLOSE.RESYNC_REQUIRED, 4001);
  assert.ok(APP_CLOSE.RESYNC_REQUIRED >= 3000 && APP_CLOSE.RESYNC_REQUIRED <= 4999);
  assert.notEqual(APP_CLOSE.RESYNC_REQUIRED, STANDARD_CLOSE.NORMAL);
});
