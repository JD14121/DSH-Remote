/**
 * Snapshot store tests — Phase R5 §22, §23, §24, §25, §47, §53.
 *
 * The A/B slots exist so one crash cannot destroy both. The subtle requirement is
 * §24: a snapshot restores **stable metadata only** — never a stale runtime status,
 * because the Gateway cannot know what DSH did while it was down.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import {
  makeTempStateRoot,
  resolvePersistenceConfig,
  statePaths,
  PERSISTENCE_ERROR,
} from './r5-helpers.mjs';
import {
  SnapshotStore,
  fromPersistedSession,
  toPersistableSession,
  UNSAFE_RESTORED_STATUSES,
  STABLE_SESSION_FIELDS,
} from '../../src/remote/persistence/snapshot.mjs';

/** A root plus its config. */
function rootFor(label = 'r5-snap') {
  const { root, cleanup } = makeTempStateRoot(label);
  return { root, cleanup, config: resolvePersistenceConfig({ root }, {}) };
}

/** A live session view. */
function session(overrides = {}) {
  return {
    id: 'session-00000000-0000-0000-0000-000000000001',
    title: 'a title',
    status: 'running',
    created_at: '2026-09-18T00:00:00.000Z',
    updated_at: '2026-09-19T00:00:00.000Z',
    last_sequence: 42,
    running: true,
    dsh_cursor: 418,
    ...overrides,
  };
}

test('a snapshot records a generation, a checksum and the A/B slot', () => {
  const { config, cleanup } = rootFor();
  try {
    const store = new SnapshotStore({ config, clock: () => 1_789_800_000_000 });
    const first = store.write([session()]);
    assert.equal(first.generation, 1);
    assert.equal(first.slot, 0);

    const second = store.write([session()]);
    assert.equal(second.generation, 2);
    assert.equal(second.slot, 1, 'the next write uses the other slot');

    const third = store.write([session()]);
    assert.equal(third.slot, 0, 'and then alternates back');

    const text = fs.readFileSync(statePaths(config).snapshotSlots[0], 'utf8');
    const parsed = JSON.parse(text);
    assert.deepEqual(Object.keys(parsed).sort(), ['checksum', 'generation', 'sessions', 'v', 'written_at']);
    assert.match(parsed.checksum, /^sha256:[0-9a-f]{64}$/);
  } finally {
    cleanup();
  }
});

test('only stable fields are persisted (§24)', () => {
  const record = toPersistableSession(session({ extra: 'ignored', running: true }));

  // Required stable fields are always present.
  for (const field of STABLE_SESSION_FIELDS) {
    if (field === 'workspace_id' || field === 'cwd') continue; // optional
    assert.ok(field in record, `${field} must be persisted`);
  }
  // Optional stable fields appear only when the session has them.
  assert.equal('workspace_id' in record, false, 'absent optional fields stay absent');
  assert.equal('cwd' in record, false);

  const withOptionals = toPersistableSession(session({ workspace_id: 'ws-1', cwd: 'D:\\work' }));
  assert.equal(withOptionals.workspace_id, 'ws-1');
  assert.equal(withOptionals.cwd, 'D:\\work');

  assert.equal('running' in record, false, 'a live flag is not stable metadata');
  assert.equal('extra' in record, false, 'unknown fields are not persisted');
  assert.equal(record.last_sequence, 42);
  assert.equal(record.dsh_cursor, 418, 'the DSH cursor is persisted for reconciliation (§32)');
});

test('the highest valid generation wins', () => {
  const { config, cleanup } = rootFor();
  try {
    const store = new SnapshotStore({ config });
    store.write([session({ last_sequence: 1 })]);
    store.write([session({ last_sequence: 2 })]);

    const fresh = new SnapshotStore({ config });
    const loaded = fresh.load();
    assert.equal(loaded.generation, 2);
    assert.equal(loaded.snapshot.sessions[0].last_sequence, 2);
  } finally {
    cleanup();
  }
});

test('one corrupt slot falls back to the other (§47)', () => {
  const { config, cleanup } = rootFor();
  try {
    const store = new SnapshotStore({ config });
    store.write([session({ last_sequence: 10 })]);
    store.write([session({ last_sequence: 20 })]);
    const paths = statePaths(config);

    // Damage the newest slot.
    fs.writeFileSync(paths.snapshotSlots[1], '{ not json', 'utf8');

    const loaded = new SnapshotStore({ config }).load();
    assert.equal(loaded.generation, 1, 'the surviving slot is used');
    assert.equal(loaded.snapshot.sessions[0].last_sequence, 10);
    assert.equal(loaded.rejected.length, 1);
    assert.equal(loaded.rejected[0].reason, 'unreadable');
  } finally {
    cleanup();
  }
});

test('a checksum failure in one slot falls back to the other', () => {
  const { config, cleanup } = rootFor();
  try {
    const store = new SnapshotStore({ config });
    store.write([session({ last_sequence: 10 })]);
    store.write([session({ last_sequence: 20 })]);
    const paths = statePaths(config);

    const parsed = JSON.parse(fs.readFileSync(paths.snapshotSlots[1], 'utf8'));
    parsed.checksum = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    fs.writeFileSync(paths.snapshotSlots[1], JSON.stringify(parsed), 'utf8');

    const loaded = new SnapshotStore({ config }).load();
    assert.equal(loaded.generation, 1);
    assert.equal(loaded.rejected[0].reason, 'checksum');
  } finally {
    cleanup();
  }
});

test('both slots unusable yields a recovery signal, not a refusal (§47)', () => {
  const { config, cleanup } = rootFor();
  try {
    const store = new SnapshotStore({ config });
    store.write([session()]);
    store.write([session()]);
    for (const slot of statePaths(config).snapshotSlots) fs.writeFileSync(slot, 'broken', 'utf8');

    const loaded = new SnapshotStore({ config }).load();
    assert.equal(loaded.snapshot, null);
    assert.equal(loaded.generation, 0);
    assert.equal(loaded.repaired, true, 'the journal still holds every event, so recovery is possible');
    assert.equal(loaded.rejected.length, 2);
  } finally {
    cleanup();
  }
});

test('a snapshot behind the journal is legal and reported (§23)', () => {
  const { config, cleanup } = rootFor();
  try {
    const store = new SnapshotStore({ config });
    store.write([session({ last_sequence: 10 })]);

    const loaded = new SnapshotStore({ config }).load({
      journalHighWater: () => 25,
    });
    assert.equal(loaded.snapshot.sessions[0].last_sequence, 10, 'lagging is fine');
  } finally {
    cleanup();
  }
});

test('a snapshot AHEAD of the journal fails closed (§23)', () => {
  const { config, cleanup } = rootFor();
  try {
    const store = new SnapshotStore({ config });
    store.write([session({ last_sequence: 99 })]);

    assert.throws(
      () => new SnapshotStore({ config }).load({ journalHighWater: () => 5 }),
      (error) => error.code === PERSISTENCE_ERROR.AHEAD_OF_JOURNAL,
      'claiming more progress than the journal proves cannot be repaired',
    );
  } finally {
    cleanup();
  }
});

test('a stale runtime status is never restored as current (§24, §53)', () => {
  for (const stale of UNSAFE_RESTORED_STATUSES) {
    const record = toPersistableSession(session({ status: stale }));
    assert.equal(record.last_known_status, stale, 'the old status is retained as metadata');

    const restored = fromPersistedSession(record);
    assert.equal(
      restored.status,
      'disconnected',
      `a snapshot saved as ${stale} must not restore that status`,
    );
    assert.equal(restored.running, false);
    assert.equal(restored.metadata.last_known_status, stale, 'the old value is visible as metadata only');
    assert.equal(restored.metadata.recovered, true);
  }
});

test('stable metadata is restored, and the DSH cursor survives', () => {
  const record = toPersistableSession(session({ status: 'waiting_input', dsh_cursor: 777 }));
  const restored = fromPersistedSession(record);
  assert.equal(restored.id, record.id);
  assert.equal(restored.title, 'a title');
  assert.equal(restored.created_at, '2026-09-18T00:00:00.000Z');
  assert.equal(restored.updated_at, '2026-09-19T00:00:00.000Z');
  assert.equal(restored.last_sequence, 42);
  assert.equal(restored.metadata.dsh_cursor, 777);
  assert.equal(restored.status, 'disconnected');
});

test('the snapshot write is atomic enough that a crash cannot damage both slots', () => {
  const { config, cleanup } = rootFor();
  try {
    // Write slot A, then simulate a crash midway through slot B by leaving a
    // truncated file there.
    const store = new SnapshotStore({ config });
    store.write([session({ last_sequence: 1 })]);
    const paths = statePaths(config);
    fs.writeFileSync(paths.snapshotSlots[1], '', 'utf8');

    const loaded = new SnapshotStore({ config }).load();
    assert.equal(loaded.generation, 1, 'slot A is intact');
    assert.equal(loaded.snapshot.sessions[0].last_sequence, 1);
  } finally {
    cleanup();
  }
});

test('a snapshot round-trips every session', () => {
  const { config, cleanup } = rootFor();
  try {
    const sessions = Array.from({ length: 5 }, (_, index) => session({
      id: `session-00000000-0000-0000-0000-00000000000${index}`,
      last_sequence: index,
      title: `title ${index}`,
    }));
    const store = new SnapshotStore({ config });
    store.write(sessions);

    const loaded = new SnapshotStore({ config }).load();
    assert.equal(loaded.snapshot.sessions.length, 5);
    assert.deepEqual(loaded.snapshot.sessions.map((s) => s.last_sequence), [0, 1, 2, 3, 4]);
    assert.deepEqual(loaded.snapshot.sessions.map((s) => s.title), [
      'title 0', 'title 1', 'title 2', 'title 3', 'title 4',
    ]);
  } finally {
    cleanup();
  }
});
