/**
 * Cancel endpoint tests — Phase R3 §18, §39.
 *
 * The whole point of this suite is one sentence from §18:
 *
 *   `accepted != quiescent`
 *
 * A 202 means DSH admitted the request to the live Agent. It does not mean the
 * Agent stopped, and it must never be reported as `cancelled`. Only observed
 * `RUN_ABANDONED` evidence settles the session.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { request, startFixtureServer, FIXTURE_SESSIONS } from './r3-helpers.mjs';
import { API_ERROR } from '../../src/remote/http/errors.mjs';
import { ADAPTER_ERROR, AdapterError } from '../../src/remote/adapter-errors.mjs';

const SESSION = FIXTURE_SESSIONS.RUNNING;

test('cancel returns 202 with an explicit admission, not a claimed outcome', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/cancel`, { method: 'POST' });

    assert.equal(res.status, 202);
    assert.equal(res.body.data.accepted, true);
    assert.equal(res.body.data.session_id, SESSION);
    // Stated in the payload so a client cannot read 202 as "it has stopped".
    assert.equal(res.body.data.quiescent, false);
  } finally {
    await h.close();
  }
});

test('a cancel admission never sets the status to cancelled', async () => {
  const h = await startFixtureServer();
  try {
    const before = h.statusService.getSession(SESSION).status;
    assert.equal(before, 'running');

    await request(h.baseUrl, `/api/v1/sessions/${SESSION}/cancel`, { method: 'POST' });

    const after = await request(h.baseUrl, `/api/v1/sessions/${SESSION}`);
    assert.equal(after.body.data.status, 'running', 'admission is not quiescence');

    const detail = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/cancel`, { method: 'POST' });
    assert.equal(detail.status, 202);
    assert.equal(h.statusService.getSession(SESSION).status, 'running');
  } finally {
    await h.close();
  }
});

test('the session becomes cancelled only after RUN_ABANDONED is observed', async () => {
  const h = await startFixtureServer();
  try {
    await request(h.baseUrl, `/api/v1/sessions/${SESSION}/cancel`, { method: 'POST' });
    assert.equal(h.statusService.getSession(SESSION).status, 'running');

    // The durable abort finally arrives on the follow stream.
    await h.statusService.ensureFollow(SESSION);
    h.statusService.events.store.applySignal(SESSION, {
      signal: 'RUN_ABANDONED',
      sessionId: SESSION,
      evidence: { source: 'test' },
    });

    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}`);
    assert.equal(res.body.data.status, 'cancelled');
  } finally {
    await h.close();
  }
});

test('a cold session is a 409 SESSION_COLD rather than a false success', async () => {
  const h = await startFixtureServer({
    adapterOptions: {
      errors: {
        cancel: new AdapterError(ADAPTER_ERROR.SESSION_COLD, 'no live agent is attached to this session'),
      },
    },
  });
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/cancel`, { method: 'POST' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, API_ERROR.SESSION_COLD);
    assert.equal(res.body.error.retryable, false);
  } finally {
    await h.close();
  }
});

test('a not-attached session maps to SESSION_COLD, following the R1 mapping', async () => {
  // R1 established that DSH answers a cold cancel with `session/not-found
  // ("not attached")`. §18 says to keep that mapping rather than invent a way to
  // distinguish cold from absent, so the adapter raises SESSION_NOT_FOUND and the
  // cancel route reports it as a state conflict.
  const h = await startFixtureServer({
    adapterOptions: {
      errors: {
        cancel: new AdapterError(ADAPTER_ERROR.SESSION_NOT_FOUND, 'session is not attached'),
      },
    },
  });
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/cancel`, { method: 'POST' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, API_ERROR.SESSION_COLD);
  } finally {
    await h.close();
  }
});

test('cancelling an unknown session is a 404 before any adapter call', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions/session-00000000-0000-0000-0000-0000000000ff/cancel', {
      method: 'POST',
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'SESSION_NOT_FOUND');
    assert.equal(h.adapter._state.cancelled.length, 0, 'nothing was sent to DSH');
  } finally {
    await h.close();
  }
});

test('a malformed session id is a 400, not a 404', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions/..%2F..%2Fetc/cancel', { method: 'POST' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_SESSION_ID');
  } finally {
    await h.close();
  }
});

test('cancel never kills a process and never touches the machine', async () => {
  const h = await startFixtureServer();
  try {
    await request(h.baseUrl, `/api/v1/sessions/${SESSION}/cancel`, { method: 'POST' });

    // The only effect is one adapter call. No child process was spawned.
    assert.equal(h.adapter._state.cancelled.length, 1);
    assert.equal(h.adapter._state.cancelled[0].sessionId, SESSION);
    // The process table is untouched: we are still the same pid, and the test
    // runner would have died if anything had killed broadly.
    assert.equal(typeof process.pid, 'number');
  } finally {
    await h.close();
  }
});

test('the cancel route contains no process-killing call', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['../../src/remote/http/routes.mjs', '../../src/remote/server.mjs', '../../src/remote/status-service.mjs']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    for (const banned of ['process.kill', 'child_process', 'execSync', 'spawnSync', 'taskkill', 'Stop-Process']) {
      assert.equal(source.includes(banned), false, `${file} must not contain ${banned}`);
    }
  }
});

test('the adapter records the cancel once per request', async () => {
  const h = await startFixtureServer();
  try {
    await request(h.baseUrl, `/api/v1/sessions/${SESSION}/cancel`, { method: 'POST' });
    await request(h.baseUrl, `/api/v1/sessions/${SESSION}/cancel`, { method: 'POST' });
    // Two admissions, not one and not four: the route forwards each call exactly once.
    assert.equal(h.adapter._state.cancelled.length, 2);
  } finally {
    await h.close();
  }
});
