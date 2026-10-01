/**
 * Session view store tests — R2 §8, §17, §23, §27.
 *
 * Proves the store keeps the Gateway sequence and the DSH cursor strictly apart,
 * that snapshot/restore is a pure in-memory round trip, and that nothing is
 * written to disk.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionViewStore, createSessionViewStore } from '../../src/remote/state/session-view-store.mjs';
import { GATEWAY_EVENT } from '../../src/remote/model/event.mjs';
import { SIGNAL } from '../../src/remote/model/signals.mjs';
import { SESSION_STATUS } from '../../src/remote/model/status.mjs';
import { makeSession } from '../../src/remote/model/session.mjs';

const A = 'session-00000000-0000-0000-0000-000000000001';
const B = 'session-00000000-0000-0000-0000-000000000002';

/** A deterministic clock, so observation times are reproducible. */
const clock = () => 1789800000000;

/** Build a store with one session. */
function storeWithA() {
  const store = new SessionViewStore({ clock });
  store.upsertSession(makeSession({ id: A, updatedAt: 1789700000000 }));
  return store;
}

test('the store starts empty and creates on demand', () => {
  const store = new SessionViewStore({ clock });
  assert.deepEqual(store.list(), []);
  assert.equal(store.get(A), null);
  assert.equal(store.has(A), false);

  store.upsertSession(makeSession({ id: A }));
  assert.equal(store.has(A), true);
  assert.equal(store.list().length, 1);
});

test('upsert enriches but never erases a learned field', () => {
  const store = storeWithA();

  // Learn a title and a creation time.
  store.upsertSession(makeSession({ id: A, title: 'a title', createdAt: 1789600000000 }));
  assert.equal(store.get(A).title, 'a title');
  assert.equal(store.get(A).created_at, new Date(1789600000000).toISOString());

  // A later summary with no title must NOT null it out.
  store.upsertSession(makeSession({ id: A }));
  assert.equal(store.get(A).title, 'a title');
  assert.equal(store.get(A).created_at, new Date(1789600000000).toISOString());
});

test('status belongs to the state machine, not to an upsert', () => {
  const store = storeWithA();
  store.applySignal(A, SIGNAL.RUN_STARTED);
  assert.equal(store.get(A).status, SESSION_STATUS.RUNNING);

  // An upsert claiming `idle` must not overwrite the machine's status.
  store.upsertSession(makeSession({ id: A, status: SESSION_STATUS.IDLE }));
  assert.equal(store.get(A).status, SESSION_STATUS.RUNNING);
});

test('applySignal reports the transition and the resulting view', () => {
  const store = storeWithA();
  const result = store.applySignal(A, { signal: SIGNAL.RUN_STARTED, evidence: { source: 'test' } });

  assert.equal(result.outcome, 'applied');
  assert.equal(result.previous, SESSION_STATUS.IDLE);
  assert.equal(result.status, SESSION_STATUS.RUNNING);
  assert.equal(result.session.status, SESSION_STATUS.RUNNING);
});

test('applySignal on an unknown session fails closed', () => {
  const store = storeWithA();
  assert.throws(() => store.applySignal('session-unknown', SIGNAL.RUN_STARTED), TypeError);
  assert.throws(() => store.applySignal(A, 'NOT_A_SIGNAL'), TypeError);
});

test('the Gateway sequence and the DSH cursor are tracked separately', () => {
  const store = storeWithA();

  const event = store.emitEvent({
    sessionId: A,
    event: GATEWAY_EVENT.MESSAGE_CREATED,
    data: { note: 'x' },
    // A DSH durable seq that is wildly different from the Gateway sequence.
    sourceSequence: 418,
  });

  assert.equal(event.sequence, 1, 'the first Gateway sequence for this session');
  assert.equal(event.source_sequence, 418, 'the DSH cursor, untouched');
  assert.equal(store.get(A).last_sequence, 1, 'last_sequence is the GATEWAY sequence');
  assert.equal(store.get(A).dsh_cursor, 418, 'the DSH cursor is reported separately');
  assert.notEqual(store.get(A).last_sequence, store.get(A).dsh_cursor);
});

test('the DSH cursor only moves forward', () => {
  const store = storeWithA();
  store.rememberDshCursor(A, 500);
  assert.equal(store.getDshCursor(A), 500);

  store.rememberDshCursor(A, 100);
  assert.equal(store.getDshCursor(A), 500, 'a lower cursor must not rewind the high-water mark');

  store.rememberDshCursor(A, 700);
  assert.equal(store.getDshCursor(A), 700);

  assert.throws(() => store.rememberDshCursor(A, 'nope'), TypeError);
  assert.throws(() => store.rememberDshCursor('session-unknown', 1), TypeError);
});

test('Gateway sequences per session are independent and monotonic', () => {
  const store = storeWithA();
  store.upsertSession(makeSession({ id: B }));

  const a1 = store.emitEvent({ sessionId: A, event: GATEWAY_EVENT.SESSION_STATUS });
  const b1 = store.emitEvent({ sessionId: B, event: GATEWAY_EVENT.SESSION_STATUS });
  const a2 = store.emitEvent({ sessionId: A, event: GATEWAY_EVENT.SESSION_STATUS });

  assert.equal(a1.sequence, 1);
  assert.equal(b1.sequence, 1, 'session B starts its own sequence space at 1');
  assert.equal(a2.sequence, 2);
  assert.ok(a2.sequence > a1.sequence);
});

test('emitEvent advances last_sequence and never rewinds it', () => {
  const store = storeWithA();
  store.emitEvent({ sessionId: A, event: GATEWAY_EVENT.SESSION_STATUS });
  store.emitEvent({ sessionId: A, event: GATEWAY_EVENT.SESSION_STATUS });
  assert.equal(store.get(A).last_sequence, 2);

  // Applying an older event must not lower the mark.
  store.applyGatewayEvent({
    sequence: 1,
    event: GATEWAY_EVENT.UNKNOWN,
    session_id: A,
    timestamp: null,
    observed_at: null,
    data: null,
  });
  assert.equal(store.get(A).last_sequence, 2);
});

test('applyGatewayEvent rejects a malformed event', () => {
  const store = storeWithA();
  assert.throws(() => store.applyGatewayEvent(null), TypeError);
  assert.throws(() => store.applyGatewayEvent({ sequence: -1, event: 'unknown', session_id: A }), TypeError);
  assert.throws(
    () => store.applyGatewayEvent({ sequence: 1, event: 'unknown', session_id: 'session-unknown' }),
    TypeError,
  );
});

test('a transport loss suspends status and restore resumes it', () => {
  const store = storeWithA();
  store.applySignal(A, SIGNAL.RUN_STARTED);

  store.applySignal(A, SIGNAL.TRANSPORT_LOST);
  assert.equal(store.get(A).status, SESSION_STATUS.DISCONNECTED);

  store.applySignal(A, SIGNAL.TRANSPORT_RESTORED);
  assert.equal(store.get(A).status, SESSION_STATUS.RUNNING);
});

test('active run metadata appears while running and clears when settled', () => {
  const store = storeWithA();
  store.applySignal(A, SIGNAL.RUN_STARTED);
  assert.ok(store.get(A).active_run, 'a run in progress must be visible');

  store.applySignal(A, SIGNAL.RUN_COMMITTED);
  assert.equal(store.get(A).active_run, undefined, 'a settled run must be cleared');
});

test('snapshot and restore round-trip the whole store in memory', () => {
  const store = storeWithA();
  store.upsertSession(makeSession({ id: B, createdAt: 1789600000000 }));
  store.applySignal(A, SIGNAL.RUN_STARTED);
  const event = store.emitEvent({
    sessionId: A,
    event: GATEWAY_EVENT.TOOL_STARTED,
    data: { name: 'fs_read' },
    sourceSequence: 418,
  });

  const snapshot = store.snapshot();
  // The snapshot is plain JSON: it never carries a live object.
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);

  const restored = new SessionViewStore({ clock });
  restored.restore(snapshot);

  assert.equal(restored.list().length, 2);
  assert.equal(restored.get(A).status, SESSION_STATUS.RUNNING);
  assert.equal(restored.get(A).last_sequence, event.sequence);
  assert.equal(restored.get(A).dsh_cursor, 418);
  assert.equal(restored.get(B).created_at, new Date(1789600000000).toISOString());

  // Continuing after a restore keeps the sequence monotonic (the R5 seam).
  const next = restored.emitEvent({ sessionId: A, event: GATEWAY_EVENT.SESSION_STATUS });
  assert.equal(next.sequence, event.sequence + 1);
});

test('a malformed snapshot fails closed', () => {
  const store = storeWithA();
  assert.throws(() => store.restore(null), TypeError);
  assert.throws(() => store.restore({ sessions: 'nope' }), TypeError);
  assert.throws(() => store.restore({ sessions: [{ id: A, status: 'ninth' }] }), TypeError);
  assert.throws(
    () => store.restore({ sessions: [makeSession({ id: A })], machines: { 'session-ghost': { status: 'idle' } } }),
    TypeError,
  );
});

test('restore rebuilds a machine for a session that had none', () => {
  const store = new SessionViewStore({ clock });
  store.restore({ sessions: [makeSession({ id: A, status: SESSION_STATUS.QUEUED })] });

  assert.equal(store.get(A).status, SESSION_STATUS.QUEUED);
  assert.ok(store.machineFor(A), 'a machine must exist after restore');
  store.applySignal(A, SIGNAL.RUN_STARTED);
  assert.equal(store.get(A).status, SESSION_STATUS.RUNNING);
});

test('delete removes a session and all of its derived state', () => {
  const store = storeWithA();
  store.emitEvent({ sessionId: A, event: GATEWAY_EVENT.SESSION_STATUS, sourceSequence: 5 });
  assert.equal(store.delete(A), true);
  assert.equal(store.delete(A), false);
  assert.equal(store.get(A), null);
  assert.equal(store.getDshCursor(A), null);
  assert.equal(store.machineFor(A), null);
});

test('the store writes nothing to disk', async () => {
  // §27 forbids fs.writeFile / appendFile / createWriteStream / JSONL / SQLite
  // for domain persistence. Prove the module source contains no such call.
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../src/remote/state/session-view-store.mjs', import.meta.url), 'utf8');
  const banned = ['writeFile', 'appendFile', 'createWriteStream', 'node:fs', 'node:sqlite', 'JSONL', 'jsonl'];
  for (const token of banned) {
    assert.equal(source.includes(token), false, `the store must not reference ${token}`);
  }
});

test('createSessionViewStore returns a working store', () => {
  const store = createSessionViewStore({ clock });
  assert.ok(store instanceof SessionViewStore);
  store.upsertSession(makeSession({ id: A }));
  assert.equal(store.list().length, 1);
});
