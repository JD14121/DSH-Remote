/**
 * Persistence health and failure-policy tests — Phase R5 §13, §14, §15, §57.
 *
 * Health must report durability as its own axis, and a runtime write failure must
 * fail closed: no unpersisted event is ever fanned out, and a mutating command
 * answers 503 rather than appearing to succeed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  makeTempStateRoot,
  PERSISTENCE_STATUS,
  PERSISTENCE_ERROR,
  SESSION,
} from './r5-helpers.mjs';
import { startFixtureServer } from './r3-helpers.mjs';
import { toApiError } from '../../src/remote/http/errors.mjs';
import { HTTP_STATUS } from '../../src/remote/http/errors.mjs';

/** Boot a fixture server with durability on a temp root. */
async function durableServer(root, options = {}) {
  return startFixtureServer({
    persistenceConfig: { root, segmentBytes: 65536, snapshotIntervalMs: 50_000, ...(options.config ?? {}) },
    ...options.server,
  });
}

/**
 * Break the journal layer, which is where a real disk failure lands.
 *
 * Substituting `persistence.append` itself would bypass the state transition the
 * service is supposed to perform, so the failure is injected one level down.
 *
 * @param {object} h - a fixture server handle.
 * @returns {() => void} a restore function.
 */
function failJournalWrites(h) {
  const journals = [...h.persistence.journals.values()];
  const originals = journals.map((journal) => [journal, journal.append]);
  for (const journal of journals) {
    journal.append = () => {
      const error = new Error('no space left on device');
      error.code = PERSISTENCE_ERROR.WRITE_FAILED;
      error.name = 'PersistenceError';
      throw error;
    };
  }
  return () => {
    for (const [journal, original] of originals) journal.append = original;
  };
}

test('health reports persistence separately from DSH availability (§14)', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-health');
  const h = await durableServer(root);
  try {
    const res = await h.get('/api/v1/health');
    assert.equal(res.status, 200);

    const data = res.body.data;
    assert.equal(data.gateway, 'ready');
    assert.ok(data.dsh !== undefined, 'the downstream status is still reported');
    assert.equal(data.persistence.status, PERSISTENCE_STATUS.READY);
    assert.equal(data.persistence.format_version, 1);
  } finally {
    await h.close();
    cleanup();
  }
});

test('a failed journal append flips health to failed and reports a reason code (§13, §14)', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-health-failed');
  const h = await durableServer(root);
  try {
    // Ensure the session has a journal to break.
    h.eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: { seed: true } });
    failJournalWrites(h);

    assert.throws(
      () => h.eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: {} }),
      'the emit must propagate the failure',
    );

    assert.equal(h.persistence.status, PERSISTENCE_STATUS.FAILED);
    const res = await h.get('/api/v1/health');
    assert.equal(res.body.data.persistence.status, PERSISTENCE_STATUS.FAILED);
    assert.equal(res.body.data.persistence.reason_code, PERSISTENCE_ERROR.WRITE_FAILED);
  } finally {
    await h.close();
    cleanup();
  }
});

test('§13: an event whose append failed is never fanned out', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-no-fanout');
  const h = await durableServer(root);
  try {
    h.eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: { seed: true } });

    const delivered = [];
    h.eventsService.onEvent((event) => delivered.push(event.sequence));
    const before = h.eventsService.ringDepth(SESSION);
    failJournalWrites(h);

    assert.throws(() => h.eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: {} }));
    assert.deepEqual(delivered, [], 'a subscriber must never see an unpersisted event');
    // The ring is fed after the sink, so it must be unchanged too.
    assert.equal(h.eventsService.ringDepth(SESSION), before);
  } finally {
    await h.close();
    cleanup();
  }
});

test('§15: a mutating command fails closed with 503 when persistence is down', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-503');
  const h = await durableServer(root);
  try {
    h.eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: { seed: true } });
    failJournalWrites(h);
    // Drive one failing emission, which is what puts the service into `failed`.
    assert.throws(() => h.eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: {} }));
    assert.equal(h.persistence.status, PERSISTENCE_STATUS.FAILED);

    const res = await h.post(`/api/v1/sessions/${SESSION}/messages`, {
      content: 'hello', client_message_id: 'cmid-1',
    });
    assert.equal(res.status, 503, 'a prompt that cannot be persisted must not be acknowledged');
    assert.equal(res.body.error.code, 'PERSISTENCE_UNAVAILABLE');
  } finally {
    await h.close();
    cleanup();
  }
});

test('§15: read-only REST keeps working while persistence is failed', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-readonly');
  const h = await durableServer(root);
  try {
    h.persistence.status = PERSISTENCE_STATUS.FAILED;
    h.persistence.failure = PERSISTENCE_ERROR.WRITE_FAILED;

    for (const path of ['/api/v1/health', '/api/v1/sessions']) {
      const res = await h.get(path);
      assert.equal(res.status, 200, `${path} must still answer`);
    }
    const detail = await h.get(`/api/v1/sessions/${SESSION}`);
    assert.equal(detail.status, 200);
  } finally {
    await h.close();
    cleanup();
  }
});

test('§57: every persistence code maps to a 503 with a safe, path-free message', () => {
  const codes = [
    PERSISTENCE_ERROR.UNAVAILABLE,
    PERSISTENCE_ERROR.WRITE_FAILED,
    PERSISTENCE_ERROR.LOCKED,
    PERSISTENCE_ERROR.VERSION_UNSUPPORTED,
    PERSISTENCE_ERROR.JOURNAL_CORRUPT,
    PERSISTENCE_ERROR.JOURNAL_SEQUENCE_ERROR,
    PERSISTENCE_ERROR.AHEAD_OF_JOURNAL,
    PERSISTENCE_ERROR.PATH_INVALID,
    PERSISTENCE_ERROR.SNAPSHOT_INVALID,
  ];

  for (const code of codes) {
    const error = new Error('internal detail that must not leak');
    error.name = 'PersistenceError';
    error.code = code;

    const api = toApiError(error);
    assert.equal(api.status, HTTP_STATUS.UNAVAILABLE, `${code} must map to 503`);
    assert.equal(api.code, code);
    assert.equal(/internal detail/.test(api.message), false, `${code} must not leak the cause`);
    // No Windows drive path, no UNC path, no DSH_HOME reference.
    assert.equal(/[A-Za-z]:\\/.test(api.message), false, `${code} must not leak a path`);
    assert.equal(api.message.includes('DSH_HOME'), false);
    assert.equal(api.message.includes('\\'), false);
  }
});

test('a persistence error never carries a disk path to a client', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-nopath');
  const h = await durableServer(root);
  try {
    const realPath = h.persistence.config.root;
    h.eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: { seed: true } });
    failJournalWrites(h);
    assert.throws(() => h.eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: {} }));

    const res = await h.post(`/api/v1/sessions/${SESSION}/messages`, {
      content: 'hello', client_message_id: 'cmid-2',
    });
    const text = JSON.stringify(res.body);
    assert.equal(res.status, 503);
    assert.equal(text.includes(realPath), false, 'the state root must not appear in the response');
    assert.equal(text.includes('ENOSPC'), false, 'the OS error must not appear either');
    assert.equal(text.includes('no space left'), false);
    assert.equal(text.includes('.jsonl'), false);
  } finally {
    await h.close();
    cleanup();
  }
});

test('a snapshot failure degrades rather than losing journal sequence (§42)', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-degrade');
  const h = await durableServer(root);
  try {
    h.persistence.snapshotStore.write = () => { throw new Error('snapshot write failed'); };
    // A forced snapshot failure must not touch the journal or the allocator.
    const before = h.persistence.journals.get(SESSION)?.highWater ?? 0;
    assert.throws(() => h.persistence.writeSnapshot(true));
    assert.equal(h.persistence.journals.get(SESSION)?.highWater ?? 0, before, 'the journal is untouched');

    // And emission still works, because the journal is the authority.
    const event = h.eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: {} });
    assert.ok(event.sequence >= 1);
  } finally {
    await h.close();
    cleanup();
  }
});

test('health never includes the state root, journal filenames or DSH_HOME (§14)', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-health-safe');
  const h = await durableServer(root);
  try {
    const res = await h.get('/api/v1/health');
    const text = JSON.stringify(res.body);
    assert.equal(text.includes(root), false);
    assert.equal(text.includes('.jsonl'), false);
    assert.equal(text.includes('DSH_HOME'), false);
    assert.equal(text.includes('gateway.lock'), false);
    // The persistence block carries only the documented fields.
    assert.deepEqual(Object.keys(res.body.data.persistence).sort(), ['format_version', 'status']);
  } finally {
    await h.close();
    cleanup();
  }
});
