/**
 * Retention tests — Phase R5 §29, §30, §31, §50.
 *
 * Retention must delete only whole closed segments, never rewrite the active one,
 * never lower the high-water mark, and must leave the retained range contiguous.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import {
  makeTempStateRoot,
  processBundle,
  seedSession,
  emitEvents,
  readSegments,
  SESSION,
  resolvePersistenceConfig,
} from './r5-helpers.mjs';
import { beginReplay, REPLAY_OUTCOME } from '../../src/remote/ws/replay.mjs';

/** Boot with a tiny retention budget so eviction happens quickly. */
function tinyRetention(root, overrides = {}) {
  const bundle = processBundle({
    root,
    config: {
      segmentBytes: 800,
      maxEventsPerSession: 6,
      maxBytesPerSession: 1_000_000,
      ...overrides,
    },
  });
  bundle.boot();
  return bundle;
}

/**
 * The retention result for one session.
 *
 * `PersistenceService.enforceRetention()` returns one entry per session that
 * changed, so a suite reading a single session picks its own.
 *
 * @param {object} bundle - a process bundle.
 * @param {string} [sessionId] - the session.
 * @returns {object} the result, with an empty `removed` when nothing changed.
 */
function retentionFor(bundle, sessionId = SESSION) {
  const results = bundle.persistence.enforceRetention();
  return results.find((entry) => entry.sessionId === sessionId) ?? { removed: [] };
}

test('retention deletes only closed segments and keeps the newest (§30)', () => {
  const { root, cleanup } = makeTempStateRoot('r5-retain');
  try {
    const bundle = tinyRetention(root);
    seedSession(bundle);
    emitEvents(bundle, 20);

    const before = readSegments(bundle.persistence.config, SESSION);
    assert.ok(before.length >= 1, 'the ceiling produced segments');

    // Retention also runs opportunistically on append, so the useful assertion is
    // on the resulting state rather than on a manual call having work left to do.
    const journal = bundle.persistence.journals.get(SESSION);
    const after = readSegments(bundle.persistence.config, SESSION);

    assert.equal(journal.highWater, 20, 'the mark is intact');
    assert.ok(journal.earliest > 1, 'leading segments were removed');
    assert.ok(after.length >= 1, 'the newest segment is always kept');
    assert.equal(journal.index()[journal.index().length - 1].file, after[after.length - 1].name,
      'the active segment survives');

    // Every surviving segment is named for its own start sequence, and they tile.
    let expected = journal.earliest;
    for (const segment of journal.index()) {
      assert.equal(segment.start, expected, 'segments are contiguous after retention');
      assert.equal(segment.file, `${String(segment.start).padStart(20, '0')}.jsonl`);
      expected = segment.end + 1;
    }
    assert.equal(expected - 1, 20, 'the retained range reaches the high-water mark');

    // An explicit call is safe and idempotent.
    bundle.persistence.enforceRetention();
    assert.equal(bundle.persistence.journals.get(SESSION).highWater, 20);
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('retention never lowers the high-water mark (§31)', () => {
  const { root, cleanup } = makeTempStateRoot('r5-highwater');
  try {
    const bundle = tinyRetention(root);
    seedSession(bundle);
    emitEvents(bundle, 20);
    assert.equal(bundle.persistence.journals.get(SESSION).highWater, 20);

    bundle.persistence.enforceRetention();
    const journal = bundle.persistence.journals.get(SESSION);
    assert.equal(journal.highWater, 20, 'the highest sequence ever used is remembered');
    assert.ok(journal.earliest > 1, 'but the earliest retained moved forward');

    // The allocator must continue from 21, never from `earliest`.
    const next = bundle.events.emit({ sessionId: SESSION, event: 'task.progress', data: {} });
    assert.equal(next.sequence, 21, 'retention must not restart the sequence');
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('§50: replay works at the retained boundary and resyncs just below it', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-boundary');
  try {
    const bundle = tinyRetention(root);
    seedSession(bundle);
    emitEvents(bundle, 20);
    bundle.persistence.enforceRetention();

    const bounds = await bundle.persistence.bounds(SESSION);
    assert.ok(bounds.earliest > 1);
    assert.equal(bounds.latest, 20);

    // Exactly at `earliest - 1`: the gap is the retained range, so replay works.
    const ok = await beginReplay({
      events: bundle.events, store: bundle.persistence, sessionId: SESSION, requested: bounds.earliest - 1,
    });
    assert.equal(ok.decision.outcome, REPLAY_OUTCOME.REPLAY, 'a client at the boundary is served');
    ok.handle.stop();

    // One below: the record is gone.
    const gap = await beginReplay({
      events: bundle.events, store: bundle.persistence, sessionId: SESSION, requested: bounds.earliest - 2,
    });
    assert.equal(gap.decision.outcome, REPLAY_OUTCOME.RESYNC);
    assert.equal(gap.decision.reason, 'gap_not_available');
    gap.handle.stop();
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('the retained range stays contiguous after retention', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-contiguous');
  try {
    const bundle = tinyRetention(root);
    seedSession(bundle);
    emitEvents(bundle, 25);
    bundle.persistence.enforceRetention();

    const events = await bundle.persistence.eventsAfter(SESSION, 0);
    const sequences = events.map((event) => event.sequence);
    assert.ok(sequences.length > 0);
    for (let index = 1; index < sequences.length; index += 1) {
      assert.equal(sequences[index], sequences[index - 1] + 1, 'no hole in the retained range');
    }
    // And it ends at the high-water mark.
    assert.equal(sequences[sequences.length - 1], 25);
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('the byte ceiling alone can trigger retention', () => {
  const { root, cleanup } = makeTempStateRoot('r5-bytes');
  try {
    const bundle = processBundle({
      root,
      config: { segmentBytes: 800, maxEventsPerSession: 1_000_000, maxBytesPerSession: 3_000 },
    });
    bundle.boot();
    seedSession(bundle);
    emitEvents(bundle, 20, SESSION, { pad: 'x'.repeat(120) });

    const journal = bundle.persistence.journals.get(SESSION);
    const after = readSegments(bundle.persistence.config, SESSION);

    assert.ok(journal.earliest > 1, 'the byte ceiling forced the earliest forward');
    assert.equal(journal.highWater, 20, 'the mark is untouched');
    assert.ok(after.length >= 1, 'the active segment is kept');
    assert.equal(bundle.persistence.journals.get(SESSION).highWater, 20, 'the mark is untouched');
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('retention is a no-op when the journal is under both ceilings', () => {
  const { root, cleanup } = makeTempStateRoot('r5-noretain');
  try {
    const bundle = processBundle({ root, config: { segmentBytes: 65536 } });
    bundle.boot();
    seedSession(bundle);
    emitEvents(bundle, 5);

    const before = bundle.persistence.journals.get(SESSION).index();
    // Under both ceilings nothing is removed, so the service reports no session.
    assert.deepEqual(bundle.persistence.enforceRetention(), []);
    const after = bundle.persistence.journals.get(SESSION).index();
    assert.deepEqual(after, before, 'nothing changed');
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('retention limits are validated and bounded (§29)', () => {
  for (const value of ['0', '-5', '1.5', 'lots']) {
    assert.throws(
      () => resolvePersistenceConfig({ root: 'C:\\tmp' }, { DSH_REMOTE_JOURNAL_MAX_EVENTS_PER_SESSION: value }),
      `max events ${value} must be refused`,
    );
    assert.throws(
      () => resolvePersistenceConfig({ root: 'C:\\tmp' }, { DSH_REMOTE_JOURNAL_MAX_BYTES_PER_SESSION: value }),
      `max bytes ${value} must be refused`,
    );
  }
});

test('retention on an empty journal is harmless', () => {
  const { root, cleanup } = makeTempStateRoot('r5-empty');
  try {
    const bundle = processBundle({ root });
    bundle.boot();
    assert.deepEqual(bundle.persistence.enforceRetention(), []);
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('retention survives a restart with the mark intact', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-retain-restart');
  try {
    {
      const bundle = tinyRetention(root);
      seedSession(bundle);
      emitEvents(bundle, 20);
      retentionFor(bundle);
      bundle.stop();
    }
    {
      const bundle = tinyRetention(root);
      assert.equal(bundle.persistence.journals.get(SESSION).highWater, 20, 'the mark came back');
      assert.ok(bundle.persistence.journals.get(SESSION).earliest > 1, 'the earliest is still advanced');
      const next = bundle.events.emit({ sessionId: SESSION, event: 'task.progress', data: {} });
      assert.equal(next.sequence, 21);
      bundle.stop();
    }
  } finally {
    cleanup();
  }
});

test('no empty segment file is left behind by retention', () => {
  const { root, cleanup } = makeTempStateRoot('r5-files');
  try {
    const bundle = tinyRetention(root);
    seedSession(bundle);
    emitEvents(bundle, 20);
    bundle.persistence.enforceRetention();

    const dir = fs.readdirSync(
      bundle.persistence.journals.get(SESSION).dir,
    ).filter((name) => name.endsWith('.jsonl'));
    for (const name of dir) {
      const full = `${bundle.persistence.journals.get(SESSION).dir}\\${name}`;
      assert.ok(fs.statSync(full).size > 0, `${name} must not be an empty leftover`);
    }
    bundle.stop();
  } finally {
    cleanup();
  }
});
