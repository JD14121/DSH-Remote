/**
 * Persistence shutdown tests — Phase R5 §41, §42.
 *
 * §41 requires that no producer runs after persistence closes, that the journal is
 * flushed, that a final snapshot is written and that the lock is released.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import {
  makeTempStateRoot,
  processBundle,
  seedSession,
  emitEvents,
  SESSION,
  PERSISTENCE_ERROR,
} from './r5-helpers.mjs';
import { ManualTimers } from '../../src/remote/ws/heartbeat.mjs';
import { statePaths } from '../../src/remote/persistence/config.mjs';
import { startFixtureServer } from './r3-helpers.mjs';

/** Boot a bundle with injectable timers so snapshots are deterministic. */
function timedBundle(root, overrides = {}) {
  const timers = new ManualTimers();
  const bundle = processBundle({ root, timers, config: { snapshotIntervalMs: 1_000, ...overrides } });
  bundle.boot();
  return { bundle, timers };
}

test('shutdown flushes the journal so every event is readable afterwards', () => {
  const { root, cleanup } = makeTempStateRoot('r5-shutdown');
  try {
    const { bundle } = timedBundle(root);
    seedSession(bundle);
    emitEvents(bundle, 8);

    const report = bundle.persistence.shutdown();
    assert.deepEqual(report.flushed.map((entry) => entry.sessionId), [SESSION]);
    assert.equal(report.flushed[0].latest, 8, 'every appended record is flushed');
    assert.equal(report.lockReleased, true);

    // The data is genuinely on disk: a second process recovers all of it.
    const next = processBundle({ root });
    const recovery = next.boot();
    assert.equal(recovery.journals.records, 8);
    assert.equal(recovery.seeded[0].seeded, 8);
    next.stop();
  } finally {
    cleanup();
  }
});

test('shutdown writes a final snapshot even when nothing was scheduled', () => {
  const { root, cleanup } = makeTempStateRoot('r5-final-snap');
  try {
    const { bundle } = timedBundle(root);
    seedSession(bundle);
    emitEvents(bundle, 3);

    const report = bundle.persistence.shutdown();
    assert.ok(report.snapshot !== null, 'a final snapshot is written');
    assert.ok(report.snapshot.generation >= 1);

    for (const slot of statePaths(bundle.persistence.config).snapshotSlots) {
      if (!fs.existsSync(slot)) continue;
      const parsed = JSON.parse(fs.readFileSync(slot, 'utf8'));
      assert.ok(parsed.generation >= 1);
    }
  } finally {
    cleanup();
  }
});

test('shutdown clears a pending snapshot timer, so nothing fires afterwards', () => {
  const { root, cleanup } = makeTempStateRoot('r5-timer');
  try {
    const { bundle, timers } = timedBundle(root);
    seedSession(bundle);
    emitEvents(bundle, 3);
    assert.ok(bundle.persistence.snapshotTimer !== null, 'a snapshot write is scheduled');

    bundle.persistence.shutdown();
    assert.equal(bundle.persistence.snapshotTimer, null, 'the timer handle is cleared');

    // Advancing the clock must not run a snapshot for a closed service.
    const before = bundle.persistence.snapshotCount;
    timers.advance(10_000);
    assert.equal(bundle.persistence.snapshotCount, before, 'no late write happens');
  } finally {
    cleanup();
  }
});

test('shutdown releases the lock so the next instance can start (§19)', () => {
  const { root, cleanup } = makeTempStateRoot('r5-lock-release');
  try {
    const first = processBundle({ root });
    first.boot();
    first.stop();
    assert.equal(fs.existsSync(statePaths(first.persistence.config).lockFile), false, 'the lock is gone');

    const second = processBundle({ root });
    assert.equal(second.boot().lock, 'acquired');
    second.stop();
  } finally {
    cleanup();
  }
});

test('shutdown is idempotent', () => {
  const { root, cleanup } = makeTempStateRoot('r5-idem');
  try {
    const { bundle } = timedBundle(root);
    seedSession(bundle);
    emitEvents(bundle, 2);

    const first = bundle.persistence.shutdown();
    assert.equal(first.alreadyStopped, undefined);
    const second = bundle.persistence.shutdown();
    assert.equal(second.alreadyStopped, true, 'a second shutdown is a no-op');
  } finally {
    cleanup();
  }
});

test('no producer can append after persistence has closed (§41)', () => {
  const { root, cleanup } = makeTempStateRoot('r5-no-producer');
  try {
    const { bundle } = timedBundle(root);
    seedSession(bundle);
    emitEvents(bundle, 2);
    bundle.persistence.shutdown();

    assert.throws(
      () => bundle.events.emit({ sessionId: SESSION, event: 'task.progress', data: {} }),
      (error) => error.code === PERSISTENCE_ERROR.UNAVAILABLE,
      'emitting after shutdown must fail rather than silently dropping',
    );
  } finally {
    cleanup();
  }
});

test('the server stop order closes the WebSocket before persistence (§41)', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-order');
  const h = await startFixtureServer({ persistenceConfig: { root, segmentBytes: 65_536 } });
  try {
    const order = [];
    const realWsStop = h.server.ws.stop.bind(h.server.ws);
    h.server.ws.stop = async () => { order.push('ws'); return realWsStop(); };

    const persistence = h.persistence;
    const realShutdown = persistence.shutdown.bind(persistence);
    persistence.shutdown = () => { order.push('persistence'); return realShutdown(); };

    await h.close();
    assert.deepEqual(order, ['ws', 'persistence'], 'the transport stops before durable state closes');
  } finally {
    cleanup();
  }
});

test('a stop after a full lifecycle leaves a recoverable root', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-lifecycle');
  try {
    const h = await startFixtureServer({ persistenceConfig: { root, segmentBytes: 65_536 } });
    for (let index = 0; index < 6; index += 1) {
      h.eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: { index } });
    }
    await h.close();

    const next = processBundle({ root });
    const recovery = next.boot();
    assert.equal(recovery.journals.records, 6);
    assert.equal(recovery.seeded[0].seeded, 6);
    // And the next event continues the sequence across the restart.
    const event = next.events.emit({ sessionId: SESSION, event: 'task.progress', data: {} });
    assert.equal(event.sequence, 7);
    next.stop();
  } finally {
    cleanup();
  }
});

test('a crash without a graceful stop leaves a recoverable journal and a stale lock', () => {
  const { root, cleanup } = makeTempStateRoot('r5-crash');
  try {
    // Boot, append, then model a crash: no flush, no snapshot, no lock release.
    const crashed = processBundle({ root });
    crashed.boot();
    seedSession(crashed);
    emitEvents(crashed, 5);
    const lockPath = statePaths(crashed.persistence.config).lockFile;
    // A crashed process leaves a lock whose PID may still look alive, so the lock
    // is rewritten with a PID that provably is not running.
    const record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    fs.writeFileSync(lockPath, JSON.stringify({ ...record, pid: 999_999_997 }), 'utf8');

    const restarted = processBundle({ root });
    const report = restarted.boot();
    assert.equal(report.lock, 'recovered', 'the stale lock is quarantined, not killed');
    assert.equal(report.journals.records, 5, 'the journal is intact');
    assert.equal(restarted.events.emit({ sessionId: SESSION, event: 'task.progress', data: {} }).sequence, 6);
    restarted.stop();
  } finally {
    cleanup();
  }
});
