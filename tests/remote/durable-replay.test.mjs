/**
 * Durable replay tests — Phase R5 §2, §26, §27, §28, §48, §49, §58, §59.
 *
 * The acceptance centre of R5. §49 is explicit: when the ring has evicted a range
 * but the journal still holds it, replay must read the journal rather than report
 * `gap_not_available`.
 *
 * The wire contract is unchanged (§58): the same `hello`, `event`,
 * `replay_complete`, `resync_required` and close codes as R4.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  makeTempStateRoot,
  processBundle,
  seedSession,
  emitEvents,
  SESSION,
  PERSISTENCE_ERROR,
} from './r5-helpers.mjs';
import { beginReplay, REPLAY_OUTCOME } from '../../src/remote/ws/replay.mjs';
import { FRAME } from '../../src/remote/ws/protocol.mjs';
import { startWsServer } from './r4-helpers.mjs';

/** Boot a process with a small ring so eviction is easy to produce. */
function durableProcess(root, options = {}) {
  const bundle = processBundle({ root, config: { ringSize: 4, ...(options.config ?? {}) } });
  const report = bundle.boot();
  return { bundle, report };
}

test('the durable store reports the journal bounds, not the ring bounds (§59)', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-bounds');
  try {
    const { bundle } = durableProcess(root);
    seedSession(bundle);
    emitEvents(bundle, 10);

    // The ring holds only the last 4; the journal holds all 10.
    assert.equal(bundle.events.ringDepth(SESSION), 4);
    assert.deepEqual(bundle.events.sequenceBounds(SESSION).earliest, 7, 'the ring is a cache');

    const durable = await bundle.persistence.bounds(SESSION);
    assert.equal(durable.earliest, 1, 'the durable earliest is the journal boundary');
    assert.equal(durable.latest, 10);
    assert.equal(durable.count, 10);
    assert.equal(durable.source, 'durable-journal');
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('§49: a range the ring evicted is still replayable from the journal', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-journal-vs-ring');
  try {
    const { bundle } = durableProcess(root, { config: { ringSize: 4 } });
    seedSession(bundle);
    emitEvents(bundle, 10);
    // Journal holds 1..10, ring holds 7..10, and this client is at 3.
    assert.equal(bundle.events.ringDepth(SESSION), 4);

    const decision = await beginReplay({
      events: bundle.events,
      store: bundle.persistence,
      sessionId: SESSION,
      requested: 3,
    });

    assert.equal(decision.decision.outcome, REPLAY_OUTCOME.REPLAY, 'the journal must serve it, not a resync');
    assert.deepEqual(decision.historical.map((e) => e.sequence), [4, 5, 6, 7, 8, 9, 10]);
    decision.handle.stop();
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('the ring boundary alone would have produced a false gap', async () => {
  // Prove the fix matters: with the ring as the authority, the same request is a
  // resync, because the ring no longer holds the needed range.
  const { root, cleanup } = makeTempStateRoot('r5-false-gap');
  try {
    const { bundle } = durableProcess(root, { config: { ringSize: 4 } });
    seedSession(bundle);
    emitEvents(bundle, 10);

    const ringOnly = await beginReplay({ events: bundle.events, sessionId: SESSION, requested: 3 });
    assert.equal(
      ringOnly.decision.outcome,
      REPLAY_OUTCOME.RESYNC,
      'without the journal this is a gap — the R4 behaviour',
    );
    assert.equal(ringOnly.decision.reason, 'gap_not_available');
    ringOnly.handle.stop();

    const withJournal = await beginReplay({
      events: bundle.events, store: bundle.persistence, sessionId: SESSION, requested: 3,
    });
    assert.equal(withJournal.decision.outcome, REPLAY_OUTCOME.REPLAY);
    withJournal.handle.stop();
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('§48: a cross-restart reconnect replays exactly the missed range', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-cross-restart');
  try {
    // Process A emits 1..20; the client consumes through 12.
    {
      const { bundle } = durableProcess(root);
      seedSession(bundle);
      emitEvents(bundle, 20);
      bundle.stop();
    }
    // Process B recovers and must serve 13..20 from the journal.
    {
      const { bundle, report } = durableProcess(root);
      assert.equal(report.seeded[0].seeded, 20, 'the allocator was seeded to 20');
      assert.equal(bundle.store.get(SESSION).status, 'disconnected');

      const replay = await beginReplay({
        events: bundle.events, store: bundle.persistence, sessionId: SESSION, requested: 12,
      });
      assert.equal(replay.decision.outcome, REPLAY_OUTCOME.REPLAY);
      assert.deepEqual(replay.historical.map((e) => e.sequence), [13, 14, 15, 16, 17, 18, 19, 20]);
      replay.handle.stop();

      // The next live event continues from the recovered mark.
      const next = bundle.events.emit({ sessionId: SESSION, event: 'task.progress', data: {} });
      assert.equal(next.sequence, 21, 'a restart must not restart the sequence');
      bundle.stop();
    }
  } finally {
    cleanup();
  }
});

test('a watermark at the high-water mark replays nothing and goes live', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-current');
  try {
    const { bundle } = durableProcess(root);
    seedSession(bundle);
    emitEvents(bundle, 6);

    const replay = await beginReplay({
      events: bundle.events, store: bundle.persistence, sessionId: SESSION, requested: 6,
    });
    assert.equal(replay.decision.outcome, REPLAY_OUTCOME.LIVE);
    assert.deepEqual(replay.historical, []);
    replay.handle.stop();
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('a watermark older than retention resyncs, and the retained range stays contiguous (§30)', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-retained');
  try {
    const { bundle } = durableProcess(root, { config: { segmentBytes: 900, maxEventsPerSession: 6 } });
    seedSession(bundle);
    emitEvents(bundle, 14);
    bundle.persistence.enforceRetention();

    const bounds = await bundle.persistence.bounds(SESSION);
    assert.ok(bounds.earliest > 1, 'retention moved the earliest boundary forward');
    assert.equal(bounds.latest, 14, 'the high-water mark is untouched by retention');

    // At `earliest - 1` the gap is exactly the retained range: replay works.
    const atBoundary = await beginReplay({
      events: bundle.events,
      store: bundle.persistence,
      sessionId: SESSION,
      requested: bounds.earliest - 1,
    });
    assert.equal(atBoundary.decision.outcome, REPLAY_OUTCOME.REPLAY);
    assert.deepEqual(
      atBoundary.historical.map((e) => e.sequence),
      Array.from({ length: bounds.latest - bounds.earliest + 1 }, (_, index) => bounds.earliest + index),
      'the retained range is contiguous',
    );
    atBoundary.handle.stop();

    // One below that is genuinely gone.
    const below = await beginReplay({
      events: bundle.events,
      store: bundle.persistence,
      sessionId: SESSION,
      requested: bounds.earliest - 2,
    });
    assert.equal(below.decision.outcome, REPLAY_OUTCOME.RESYNC);
    assert.equal(below.decision.reason, 'gap_not_available');
    below.handle.stop();
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('a watermark ahead of the server resyncs across a restart (§36)', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-ahead');
  try {
    const { bundle } = durableProcess(root);
    seedSession(bundle);
    emitEvents(bundle, 4);

    const replay = await beginReplay({
      events: bundle.events, store: bundle.persistence, sessionId: SESSION, requested: 999,
    });
    assert.equal(replay.decision.outcome, REPLAY_OUTCOME.RESYNC);
    assert.equal(replay.decision.reason, 'sequence_ahead_of_server');
    replay.handle.stop();
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('§27: an event arriving during an awaitable disk read is captured exactly once', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-slow-read');
  try {
    const { bundle } = durableProcess(root);
    seedSession(bundle);
    emitEvents(bundle, 5);

    // A deliberately slow durable source, so the live event lands mid-read.
    const slow = {
      async bounds(sessionId) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return bundle.persistence.bounds(sessionId);
      },
      async eventsAfter(sessionId, after) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return bundle.persistence.eventsAfter(sessionId, after);
      },
    };

    const pending = beginReplay({
      events: bundle.events, store: slow, sessionId: SESSION, requested: 3,
    });
    // Emitted shortly after the call, while the slower of the two awaits is still
    // in flight — so the boundary/history reads straddle it.
    setTimeout(() => {
      bundle.events.emit({ sessionId: SESSION, event: 'task.progress', data: { live: true } });
    }, 45);

    const replay = await pending;
    assert.deepEqual(replay.historical.map((e) => e.sequence), [4, 5], 'history is what the read returned');
    const flushed = replay.handle.flush();
    // The raced event is captured somewhere — never lost. Depending on exactly
    // which await it landed in it is either history or the live flush, so the
    // assertion is on the union, which is the property that matters.
    const all = [...replay.historical, ...flushed].map((e) => e.sequence);
    assert.deepEqual(all, [4, 5, 6], 'no duplicate and no gap across the seam');
    replay.handle.stop();
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('§58: the wire frames and close codes are unchanged from R4', async () => {
  // The protocol did not change; only how long the server can remember did.
  const { root, cleanup } = makeTempStateRoot('r5-wire');
  const h = await startWsServer({ persistenceConfig: { root, segmentBytes: 65536 } });
  try {
    // Seed durable events through the server's own domain.
    h.store.upsertSession({
      id: SESSION, title: null, status: 'idle', created_at: null, updated_at: null,
      last_sequence: 0, running: false,
    });
    for (let index = 0; index < 12; index += 1) {
      h.eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: { index } });
    }

    const client = await h.connect({ session_id: SESSION, last_sequence: 5 });
    await client.waitForType(FRAME.REPLAY_COMPLETE);

    assert.equal(client.frames[0].type, FRAME.HELLO, 'hello is still first');
    const hello = client.ofType(FRAME.HELLO)[0];
    assert.equal(hello.api_version, 1);
    assert.equal(hello.protocol, 'dsh-remote-v1');
    assert.equal(hello.replay.mode, 'replay');
    assert.deepEqual(client.sequences(), [6, 7, 8, 9, 10, 11, 12], 'replayed from the durable journal');
    const complete = client.ofType(FRAME.REPLAY_COMPLETE)[0];
    assert.equal(complete.replayed, 7);

    // A live event after the seam continues the sequence.
    h.eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: { live: true } });
    await client.waitFor(() => client.sequences().length >= 8, 3000, 'live event');
    assert.deepEqual(client.sequences(), [6, 7, 8, 9, 10, 11, 12, 13]);
    await client.close();
  } finally {
    await h.close();
    cleanup();
  }
});

test('§48: replay through a real socket survives a restart with no gap and no duplicate', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-socket-restart');
  try {
    // Process A over a real server.
    const first = await startWsServer({ persistenceConfig: { root, segmentBytes: 65536 } });
    try {
      first.store.upsertSession({
        id: SESSION, title: null, status: 'idle', created_at: null, updated_at: null,
        last_sequence: 0, running: false,
      });
      for (let index = 0; index < 15; index += 1) {
        first.eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: { index } });
      }
      const a = await first.connect({ session_id: SESSION, last_sequence: 0 });
      await a.waitForType(FRAME.REPLAY_COMPLETE);
      assert.deepEqual(a.sequences(), Array.from({ length: 15 }, (_, index) => index + 1));
      await a.close();
    } finally {
      // A graceful stop releases the lock so process B can take over.
      await first.close();
    }

    // Process B on the same root.
    const second = await startWsServer({ persistenceConfig: { root, segmentBytes: 65536 } });
    try {
      assert.ok(second.server.recovery !== null, 'recovery ran before binding');
      assert.equal(second.server.recovery.seeded[0].seeded, 15);

      const b = await second.connect({ session_id: SESSION, last_sequence: 10 });
      await b.waitForType(FRAME.REPLAY_COMPLETE);
      assert.deepEqual(b.sequences(), [11, 12, 13, 14, 15], 'exactly the missed range');

      second.eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: { live: true } });
      await b.waitFor(() => b.sequences().length >= 6, 3000, 'live event');
      assert.deepEqual(b.sequences(), [11, 12, 13, 14, 15, 16], 'and then continues live');
      await b.close();
    } finally {
      await second.close();
    }
  } finally {
    cleanup();
  }
});

test('the durable source is the authority, so a restart cannot shorten history', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-authority');
  try {
    {
      const { bundle } = durableProcess(root, { config: { ringSize: 2 } });
      seedSession(bundle);
      emitEvents(bundle, 8);
      // The ring holds 2; the journal holds 8.
      assert.equal(bundle.events.ringDepth(SESSION), 2);
      bundle.stop();
    }
    {
      const { bundle } = durableProcess(root, { config: { ringSize: 2 } });
      const bounds = await bundle.persistence.bounds(SESSION);
      assert.equal(bounds.earliest, 1);
      assert.equal(bounds.count, 8, 'the whole history is still available after a restart');
      const events = await bundle.persistence.eventsAfter(SESSION, 0);
      assert.deepEqual(events.map((e) => e.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
      bundle.stop();
    }
  } finally {
    cleanup();
  }
});
