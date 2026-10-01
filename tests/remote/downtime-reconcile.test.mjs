/**
 * Downtime reconciliation tests — Phase R5 §1.2, §33, §34, §35, §36, §37, §38,
 * §51, §52.
 *
 * A journal cannot contain what the Gateway never observed. These tests pin the
 * contract for that boundary: missed durable DSH facts become **new** Gateway
 * events with **new** sequences, the checkpoint advances only past commits, and a
 * crash mid-reconciliation never duplicates a fact.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  makeTempStateRoot,
  processBundle,
  seedSession,
  SESSION,
  Reconciler,
  PERSISTENCE_ERROR,
} from './r5-helpers.mjs';
import { RECONCILE_OUTCOME } from '../../src/remote/persistence/reconcile.mjs';

/**
 * A fixture DSH whose durable history can be advanced behind the Gateway's back.
 *
 * @param {number} startCursor - the durable cursor DSH begins at.
 * @returns {object} the fixture.
 */
function fixtureDsh(startCursor = 0) {
  const state = { cursor: startCursor, records: [] };
  return {
    state,
    /** Commit a durable fact, as DSH would while the Gateway is down. */
    commit(content) {
      state.cursor += 1;
      state.records.push({ sequence: state.cursor, content, created_at: null });
      return state.cursor;
    },
    adapter: {
      async getMessages() {
        return {
          messages: state.records.map((record) => ({ ...record })),
          raw: {},
          throughSeq: state.cursor,
          hasMore: false,
        };
      },
      async subscribe(_sessionId, listener) {
        setImmediate(() => listener({ kind: 'snapshot', frame: { cursor: state.cursor } }));
        return { unsubscribe: async () => {} };
      },
    },
  };
}

/** Boot a bundle wired to a fixture DSH. */
function bundleWith(root, dsh, options = {}) {
  const bundle = processBundle({ root, adapter: dsh.adapter, ...options });
  bundle.boot();
  const reconciler = new Reconciler({
    adapter: dsh.adapter,
    persistence: bundle.persistence,
    store: bundle.store,
    events: bundle.events,
  });
  return { bundle, reconciler };
}

test('§51: a downtime gap becomes new Gateway events with new sequences', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-rec');
  const dsh = fixtureDsh(50);
  try {
    // The Gateway is up and has reconciled through source 50.
    const { bundle, reconciler } = bundleWith(root, dsh);
    seedSession(bundle);
    reconciler.setPersistedCursor(SESSION, 50);

    // DSH advances while the Gateway is "down".
    for (let index = 0; index < 5; index += 1) dsh.commit(`durable fact ${51 + index}`);

    const report = await reconciler.reconcile({ sessionIds: [SESSION] });
    const result = report.sessions[0];

    assert.equal(result.outcome, RECONCILE_OUTCOME.RECONCILED);
    assert.equal(result.emitted, 5, 'every missed durable fact became a Gateway event');
    assert.equal(result.cursor, 55, 'the checkpoint advanced to the fresh cursor');

    // The events are journaled with NEW Gateway sequences and the DSH source
    // sequence carried alongside — never reused as the Gateway sequence.
    const events = await bundle.persistence.eventsAfter(SESSION, 0);
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5]);
    assert.deepEqual(events.map((event) => event.source_sequence), [51, 52, 53, 54, 55]);
    assert.ok(
      events.every((event) => event.sequence !== event.source_sequence),
      'a reconciled event must not reuse a DSH sequence as its Gateway sequence',
    );
    assert.ok(events.every((event) => event.data.reconciled === true), 'marked as reconciled');
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('§51: reconciling twice emits nothing the second time (§36)', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-rec-idem');
  const dsh = fixtureDsh(50);
  try {
    const { bundle, reconciler } = bundleWith(root, dsh);
    seedSession(bundle);
    reconciler.setPersistedCursor(SESSION, 50);
    for (let index = 0; index < 5; index += 1) dsh.commit(`fact ${51 + index}`);

    const first = await reconciler.reconcile({ sessionIds: [SESSION] });
    assert.equal(first.sessions[0].emitted, 5);

    const second = await reconciler.reconcile({ sessionIds: [SESSION] });
    assert.equal(second.sessions[0].outcome, RECONCILE_OUTCOME.UP_TO_DATE);
    assert.equal(second.sessions[0].emitted, 0, 'no duplicate Gateway events');

    const events = await bundle.persistence.eventsAfter(SESSION, 0);
    assert.equal(events.length, 5, 'the journal did not grow');
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('§36: a crash mid-reconciliation does not duplicate what was committed', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-rec-crash');
  const dsh = fixtureDsh(50);
  try {
    {
      const { bundle, reconciler } = bundleWith(root, dsh);
      seedSession(bundle);
      reconciler.setPersistedCursor(SESSION, 50);
      for (let index = 0; index < 10; index += 1) dsh.commit(`fact ${51 + index}`);

      // Make the journal append fail at source 56. The write-ahead sink throws
      // *before* anything is published, so source 56 is genuinely uncommitted —
      // which is exactly the state a crash mid-reconcile leaves behind.
      const originalSink = bundle.events.sink;
      let appends = 0;
      bundle.events.setSink((event) => {
        appends += 1;
        if (appends > 5) throw Object.assign(new Error('disk full'), { code: PERSISTENCE_ERROR.WRITE_FAILED });
        return originalSink(event);
      });

      const partial = await reconciler.reconcile({ sessionIds: [SESSION] });
      assert.equal(partial.sessions[0].outcome, RECONCILE_OUTCOME.PARTIAL);
      assert.equal(partial.sessions[0].cursor, 55, 'the checkpoint stopped at the last commit');
      assert.equal(partial.sessions[0].failedAt, 56);

      // Only 51..55 reached the journal.
      assert.equal(bundle.persistence.journals.get(SESSION).highWater, 5);
      bundle.events.setSink(originalSink);
      bundle.stop();
    }

    // Restart: the checkpoint is durable, so 51..55 are not redone.
    {
      const { bundle, reconciler } = bundleWith(root, dsh);
      const cursor = reconciler.persistedCursor(SESSION);
      assert.equal(cursor, 55, 'the checkpoint survived the restart');

      const retry = await reconciler.reconcile({ sessionIds: [SESSION] });
      assert.equal(retry.sessions[0].emitted, 5, 'only the missing 56..60 are emitted');
      assert.equal(retry.sessions[0].cursor, 60);

      const events = await bundle.persistence.eventsAfter(SESSION, 0);
      const sources = events.map((event) => event.source_sequence);
      assert.deepEqual(sources, [51, 52, 53, 54, 55, 56, 57, 58, 59, 60],
        'each source fact appears exactly once across the whole history');
      assert.equal(new Set(sources).size, sources.length, 'no duplicate source');
      assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        'Gateway sequences are contiguous, with the recovered range continuing them');
      bundle.stop();
    }
  } finally {
    cleanup();
  }
});

test('§52: a partial failure advances the checkpoint only to the last commit', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-rec-partial');
  const dsh = fixtureDsh(50);
  try {
    const { bundle, reconciler } = bundleWith(root, dsh);
    seedSession(bundle);
    reconciler.setPersistedCursor(SESSION, 50);
    for (let index = 0; index < 5; index += 1) dsh.commit(`fact ${51 + index}`);

    // 51 and 52 commit; 53 fails.
    let calls = 0;
    const commit = (sessionId, record) => {
      calls += 1;
      if (calls === 3) throw Object.assign(new Error('disk full'), { code: PERSISTENCE_ERROR.WRITE_FAILED });
      return bundle.events.emit({
        sessionId,
        event: 'message.created',
        data: { reconciled: true },
        sourceSequence: record.sourceSequence,
      });
    };

    const result = await reconciler.reconcileSession(SESSION, { commit });
    assert.equal(result.outcome, RECONCILE_OUTCOME.PARTIAL);
    assert.equal(result.emitted, 2, '51 and 52 were committed');
    assert.equal(result.cursor, 52, 'the checkpoint advanced only to 52');
    assert.equal(result.failedAt, 53);
    assert.notEqual(result.cursor, 55, 'it must not jump to the fresh cursor');
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('a failure at the very first record leaves the checkpoint unchanged', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-rec-firstfail');
  const dsh = fixtureDsh(10);
  try {
    const { bundle, reconciler } = bundleWith(root, dsh);
    seedSession(bundle);
    reconciler.setPersistedCursor(SESSION, 10);
    dsh.commit('one');
    dsh.commit('two');

    const result = await reconciler.reconcileSession(SESSION, {
      commit: () => { throw Object.assign(new Error('nope'), { code: PERSISTENCE_ERROR.WRITE_FAILED }); },
    });
    assert.equal(result.outcome, RECONCILE_OUTCOME.PARTIAL);
    assert.equal(result.emitted, 0);
    assert.equal(result.cursor, 10, 'the checkpoint is exactly where it started');
    assert.equal(reconciler.persistedCursor(SESSION), 10);
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('the fresh cursor is observed before any record is fetched (§35)', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-rec-order');
  const dsh = fixtureDsh(10);
  try {
    const { bundle, reconciler } = bundleWith(root, dsh);
    seedSession(bundle);
    reconciler.setPersistedCursor(SESSION, 10);
    dsh.commit('one');

    const order = [];
    await reconciler.reconcileSession(SESSION, {
      freshCursor: async () => { order.push('cursor'); return { cursor: 11 }; },
      fetchRecords: async () => { order.push('fetch'); return [{ sourceSequence: 11 }]; },
      commit: () => { order.push('commit'); return null; },
    });
    assert.deepEqual(order, ['cursor', 'fetch', 'commit'], 'the order §35 requires');
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('records are processed in DSH source order regardless of arrival order (§35)', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-rec-sort');
  const dsh = fixtureDsh(10);
  try {
    const { bundle, reconciler } = bundleWith(root, dsh);
    seedSession(bundle);
    reconciler.setPersistedCursor(SESSION, 10);

    const seen = [];
    await reconciler.reconcileSession(SESSION, {
      freshCursor: async () => ({ cursor: 13 }),
      // Deliberately out of order.
      fetchRecords: async () => [
        { sourceSequence: 13 }, { sourceSequence: 11 }, { sourceSequence: 12 },
      ],
      commit: (_sessionId, record) => { seen.push(record.sourceSequence); return null; },
    });
    assert.deepEqual(seen, [11, 12, 13], 'processed in source order');
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('an unavailable DSH yields UNAVAILABLE without advancing the checkpoint', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-rec-unavail');
  const dsh = fixtureDsh(10);
  try {
    const { bundle, reconciler } = bundleWith(root, dsh);
    seedSession(bundle);
    reconciler.setPersistedCursor(SESSION, 10);

    const result = await reconciler.reconcileSession(SESSION, {
      freshCursor: async () => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); },
    });
    assert.equal(result.outcome, RECONCILE_OUTCOME.UNAVAILABLE);
    assert.equal(result.emitted, 0);
    assert.equal(reconciler.persistedCursor(SESSION), 10, 'nothing moved');
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('a fresh cursor with nothing missed is UP_TO_DATE', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-rec-uptodate');
  const dsh = fixtureDsh(10);
  try {
    const { bundle, reconciler } = bundleWith(root, dsh);
    seedSession(bundle);
    reconciler.setPersistedCursor(SESSION, 10);

    const result = await reconciler.reconcileSession(SESSION, { freshCursor: async () => ({ cursor: 10 }) });
    assert.equal(result.outcome, RECONCILE_OUTCOME.UP_TO_DATE);
    assert.equal(result.cursor, 10);
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('the checkpoint never moves backwards', () => {
  const { root, cleanup } = makeTempStateRoot('r5-rec-back');
  const dsh = fixtureDsh(10);
  try {
    const { bundle, reconciler } = bundleWith(root, dsh);
    seedSession(bundle);
    reconciler.setPersistedCursor(SESSION, 50);
    reconciler.setPersistedCursor(SESSION, 20);
    assert.equal(reconciler.persistedCursor(SESSION), 50, 'a lower checkpoint is ignored');
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('§37/§38: the reconciler reads only through the adapter, never DSH files', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../src/remote/persistence/reconcile.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // No direct session-log access, no wire knowledge, no zstd.
  for (const banned of ['node:fs', 'readFile', 'writeFile', 'zstd', 'session.v3', 'jsonl', 'DSH_HOME', 'wire/']) {
    assert.equal(code.includes(banned), false, `reconciliation must not use ${banned}`);
  }
  assert.ok(code.includes('this.adapter'), 'it goes through the adapter');
});

test('§37: token deltas and other ephemeral data are not claimed as recoverable', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../src/remote/persistence/reconcile.mjs', import.meta.url), 'utf8');
  // The module documents the limitation in its header, and emits only durable
  // message facts — never an assistant delta.
  assert.ok(/cannot contain events that happened while the Gateway/.test(source),
    'the boundary is documented where the code lives');
  assert.equal(source.includes("event: 'assistant.delta'"), false,
    'ephemeral deltas must not be fabricated during reconciliation');
});

test('reconciliation marks the snapshot dirty so the cursor is durable (§32)', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-rec-durable');
  const dsh = fixtureDsh(10);
  try {
    {
      const { bundle, reconciler } = bundleWith(root, dsh);
      seedSession(bundle);
      reconciler.setPersistedCursor(SESSION, 10);
      dsh.commit('one');
      dsh.commit('two');
      const result = await reconciler.reconcile({ sessionIds: [SESSION] });
      assert.equal(result.sessions[0].cursor, 12);
      bundle.persistence.writeSnapshot(true);
      bundle.stop();
    }
    {
      const { bundle, reconciler } = bundleWith(root, dsh);
      assert.equal(reconciler.persistedCursor(SESSION), 12, 'the DSH cursor survived the restart');
      // And a further reconcile sees nothing to do.
      const again = await reconciler.reconcile({ sessionIds: [SESSION] });
      assert.equal(again.sessions[0].emitted, 0);
      bundle.stop();
    }
  } finally {
    cleanup();
  }
});
