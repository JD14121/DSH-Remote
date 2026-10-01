/**
 * Startup recovery tests — Phase R5 §17, §23, §24, §28, §30, §31, §39, §40, §47, §59.
 *
 * The order §17 requires is the point: recovery completes before any listener
 * binds, so a client can never see a sequence that starts at 1 and then jumps.
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
  OTHER_SESSION,
  PERSISTENCE_ERROR,
  resolvePersistenceConfig,
  segmentPath,
} from './r5-helpers.mjs';
import { statePaths } from '../../src/remote/persistence/config.mjs';

/** Run one full "process": boot, emit, shut down. */
function runProcess(root, options = {}) {
  const bundle = processBundle({ root, ...options });
  const report = bundle.boot();
  return { bundle, report };
}

test('a fresh root initializes cleanly and reports what it did', () => {
  const { root, cleanup } = makeTempStateRoot('r5-start');
  try {
    const { bundle, report } = runProcess(root);
    assert.equal(report.lock, 'acquired');
    assert.equal(report.journals.sessions, 0);
    assert.equal(report.snapshot.generation, 0);
    assert.deepEqual(report.seeded, []);
    assert.equal(report.restored, 0);
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('format.json is written with the format name and version', () => {
  const { root, cleanup } = makeTempStateRoot('r5-format');
  try {
    const { bundle } = runProcess(root);
    const parsed = JSON.parse(fs.readFileSync(statePaths(bundle.persistence.config).formatFile, 'utf8'));
    assert.deepEqual(parsed, { format: 'dsh-remote-state', version: 1 });
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('an unsupported format version fails closed (§5)', () => {
  const { root, cleanup } = makeTempStateRoot('r5-version');
  try {
    const { bundle } = runProcess(root);
    const paths = statePaths(bundle.persistence.config);
    bundle.stop();

    fs.writeFileSync(paths.formatFile, JSON.stringify({ format: 'dsh-remote-state', version: 99 }), 'utf8');

    const next = processBundle({ root });
    assert.throws(
      () => next.boot(),
      (error) => error.code === PERSISTENCE_ERROR.VERSION_UNSUPPORTED,
      'an unknown version must not be migrated or ignored',
    );
  } finally {
    cleanup();
  }
});

test('a state root written by something else fails closed', () => {
  const { root, cleanup } = makeTempStateRoot('r5-foreign');
  try {
    const { bundle } = runProcess(root);
    const paths = statePaths(bundle.persistence.config);
    bundle.stop();
    fs.writeFileSync(paths.formatFile, JSON.stringify({ format: 'something-else', version: 1 }), 'utf8');

    assert.throws(() => processBundle({ root }).boot(), (error) => error.code === PERSISTENCE_ERROR.VERSION_UNSUPPORTED);
  } finally {
    cleanup();
  }
});

test('the sequence allocator is seeded from the journal, and the next event continues (§31)', () => {
  const { root, cleanup } = makeTempStateRoot('r5-seed');
  try {
    {
      const { bundle } = runProcess(root);
      seedSession(bundle);
      emitEvents(bundle, 12);
      assert.equal(bundle.persistence.journals.get(SESSION).highWater, 12);
      bundle.stop();
    }
    {
      const { bundle, report } = runProcess(root);
      assert.deepEqual(report.seeded, [{ sessionId: SESSION, seeded: 12 }]);
      assert.equal(bundle.store.sequences.peek(SESSION), 12, 'the allocator was seeded');

      // The next live event continues from the recovered high-water mark.
      const next = bundle.events.emit({ sessionId: SESSION, event: 'task.progress', data: {} });
      assert.equal(next.sequence, 13, 'a restart must not restart the sequence at 1');
      bundle.stop();
    }
  } finally {
    cleanup();
  }
});

test('recovered sessions start disconnected and never restore a stale status (§24, §53)', () => {
  const { root, cleanup } = makeTempStateRoot('r5-status');
  try {
    {
      const { bundle } = runProcess(root);
      seedSession(bundle);
      emitEvents(bundle, 4);
      // Drive the session to a live status the way the domain would.
      bundle.store.applySignal(SESSION, { signal: 'RUN_STARTED', sessionId: SESSION });
      assert.equal(bundle.store.get(SESSION).status, 'running');
      bundle.persistence.writeSnapshot(true);
      bundle.stop();
    }
    {
      const { bundle } = runProcess(root);
      // The snapshot recorded `running` as last_known_status, but the recovered
      // current status must not be that.
      assert.equal(bundle.store.get(SESSION).status, 'disconnected');
      assert.equal(bundle.store.get(SESSION).running, false);
      assert.equal(bundle.store.get(SESSION).metadata.last_known_status, 'running');
      bundle.stop();
    }
  } finally {
    cleanup();
  }
});

test('a stale waiting_input is not restored as current (§25, §53)', () => {
  const { root, cleanup } = makeTempStateRoot('r5-waiting');
  try {
    {
      const { bundle } = runProcess(root);
      seedSession(bundle);
      emitEvents(bundle, 2);
      bundle.store.applySignal(SESSION, { signal: 'WAITING_FOR_USER', sessionId: SESSION });
      assert.equal(bundle.store.get(SESSION).status, 'waiting_input');
      bundle.persistence.writeSnapshot(true);
      bundle.stop();
    }
    {
      const { bundle } = runProcess(root);
      assert.notEqual(
        bundle.store.get(SESSION).status,
        'waiting_input',
        'a pending question may have been answered while the Gateway was down',
      );
      assert.equal(bundle.store.get(SESSION).status, 'disconnected');
      bundle.stop();
    }
  } finally {
    cleanup();
  }
});

test('stable metadata survives a restart', () => {
  const { root, cleanup } = makeTempStateRoot('r5-meta');
  try {
    {
      const { bundle } = runProcess(root);
      bundle.store.upsertSession({
        id: SESSION,
        title: 'recovered title',
        status: 'idle',
        created_at: '2026-09-18T00:00:00.000Z',
        updated_at: '2026-09-19T00:00:00.000Z',
        last_sequence: 3,
        running: false,
        workspace_id: 'ws-9',
        cwd: 'D:\\work',
      });
      emitEvents(bundle, 3);
      bundle.persistence.writeSnapshot(true);
      bundle.stop();
    }
    {
      const { bundle } = runProcess(root);
      const view = bundle.store.get(SESSION);
      assert.equal(view.title, 'recovered title');
      assert.equal(view.created_at, '2026-09-18T00:00:00.000Z');
      assert.equal(view.updated_at, '2026-09-19T00:00:00.000Z');
      assert.equal(view.workspace_id, 'ws-9');
      assert.equal(view.cwd, 'D:\\work');
      assert.equal(view.status, 'disconnected', 'only the runtime status is withheld');
      bundle.stop();
    }
  } finally {
    cleanup();
  }
});

test('a session with a journal but no snapshot entry is reconstructed from the journal (§47)', () => {
  const { root, cleanup } = makeTempStateRoot('r5-reconstruct');
  try {
    {
      const { bundle } = runProcess(root);
      seedSession(bundle);
      emitEvents(bundle, 5);
      // Shut down cleanly so the lock is released, then delete the snapshot slots
      // to model a state root whose snapshot was lost but whose journal survived.
      bundle.stop();
    }
    const config = resolvePersistenceConfig({ root }, {});
    for (const slot of statePaths(config).snapshotSlots) {
      if (fs.existsSync(slot)) fs.unlinkSync(slot);
    }

    const { bundle } = runProcess(root);
    const view = bundle.store.get(SESSION);
    assert.ok(view !== null, 'the session is known from its journal alone');
    assert.equal(view.last_sequence, 5, 'the high-water mark comes from the journal');
    assert.equal(view.status, 'disconnected');
    assert.equal(view.metadata.reconstructed_from_journal, true);
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('multiple sessions are recovered independently', () => {
  const { root, cleanup } = makeTempStateRoot('r5-multi');
  try {
    {
      const { bundle } = runProcess(root);
      seedSession(bundle, SESSION);
      seedSession(bundle, OTHER_SESSION);
      emitEvents(bundle, 7, SESSION);
      emitEvents(bundle, 3, OTHER_SESSION);
      bundle.stop();
    }
    {
      const { bundle, report } = runProcess(root);
      assert.equal(report.journals.sessions, 2);
      assert.equal(report.journals.records, 10);
      assert.deepEqual(
        report.seeded.map((entry) => [entry.sessionId, entry.seeded]).sort(),
        [[OTHER_SESSION, 3], [SESSION, 7]].sort(),
      );
      assert.equal(bundle.store.sequences.peek(SESSION), 7);
      assert.equal(bundle.store.sequences.peek(OTHER_SESSION), 3);
      bundle.stop();
    }
  } finally {
    cleanup();
  }
});

test('the ring hot cache is preloaded from the journal tail (§28)', () => {
  const { root, cleanup } = makeTempStateRoot('r5-preload');
  try {
    {
      const { bundle } = runProcess(root, { config: { ringSize: 4 } });
      seedSession(bundle);
      emitEvents(bundle, 10);
      bundle.stop();
    }
    {
      const { bundle, report } = runProcess(root, { config: { ringSize: 4 } });
      const preload = report.ringPreload.find((entry) => entry.sessionId === SESSION);
      assert.ok(preload !== undefined, 'the session was preloaded');
      assert.equal(preload.preloaded, 4, 'only the ring size is loaded');
      assert.deepEqual(bundle.events.ringFor(SESSION).map((e) => e.sequence), [7, 8, 9, 10]);
      bundle.stop();
    }
  } finally {
    cleanup();
  }
});

test('an active lock stops a second instance from starting (§18, §40)', () => {
  const { root, cleanup } = makeTempStateRoot('r5-locked');
  try {
    const first = processBundle({ root });
    first.boot();

    const second = processBundle({ root });
    assert.throws(
      () => second.boot(),
      (error) => error.code === PERSISTENCE_ERROR.LOCKED,
      'a second writer must be refused',
    );

    first.stop();
    // After a clean release the next instance starts normally.
    const third = processBundle({ root });
    assert.equal(third.boot().lock, 'acquired');
    third.stop();
  } finally {
    cleanup();
  }
});

test('a corrupt journal prevents startup entirely (§21, §40, §70)', () => {
  const { root, cleanup } = makeTempStateRoot('r5-corrupt-start');
  try {
    {
      const { bundle } = runProcess(root);
      seedSession(bundle);
      emitEvents(bundle, 5);
      bundle.stop();
    }
    // Corrupt a middle line.
    const config = resolvePersistenceConfig({ root }, {});
    const dir = segmentPath(config, SESSION, 1).replace(/[^\\/]+$/, '');
    const file = fs.readdirSync(dir).find((name) => name.endsWith('.jsonl'));
    const lines = fs.readFileSync(`${dir}${file}`, 'utf8').split('\n');
    lines[2] = '{"v":1,"sequence":3,';
    fs.writeFileSync(`${dir}${file}`, lines.join('\n'), 'utf8');

    assert.throws(
      () => processBundle({ root }).boot(),
      (error) => error.code === PERSISTENCE_ERROR.JOURNAL_CORRUPT,
      'a mid-file corruption must stop the server from starting',
    );
  } finally {
    cleanup();
  }
});

test('recovery is reported in the order §17 requires', () => {
  const { root, cleanup } = makeTempStateRoot('r5-order');
  try {
    const { bundle, report } = runProcess(root);
    // The report exposes each stage, so the ordering is observable rather than
    // merely asserted in a comment.
    assert.deepEqual(
      Object.keys(report),
      ['lock', 'journals', 'snapshot', 'seeded', 'restored', 'cursorsRestored', 'ringPreload'],
    );
    assert.equal(report.lock, 'acquired', 'the lock precedes the journal scan');
    bundle.stop();
  } finally {
    cleanup();
  }
});
