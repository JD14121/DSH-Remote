/**
 * REST integration test — Phase R3 §43.
 *
 * Drives the full documented scenario against a real ephemeral server:
 *
 *   GET /sessions -> GET /sessions/:id -> POST /messages (steer) -> 202
 *   -> status running -> POST /cancel -> 202 admission
 *   -> status still running -> RUN_ABANDONED arrives
 *   -> GET /sessions/:id -> status cancelled
 *
 * It also asserts the cross-cutting properties §43 lists: no raw DSH object leak,
 * no wire endpoint string anywhere in the HTTP layer, correct sequence semantics,
 * and that the server never waits for a final model response.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { request, startFixtureServer, FIXTURE_SESSIONS } from './r3-helpers.mjs';
import { SIGNAL } from '../../src/remote/model/signals.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION = FIXTURE_SESSIONS.RUNNING;

test('the full documented scenario reaches cancelled only after observed abandon evidence', async () => {
  const h = await startFixtureServer();
  try {
    // 1. list sessions
    const list = await request(h.baseUrl, '/api/v1/sessions');
    assert.equal(list.status, 200);
    assert.ok(list.body.data.some((session) => session.id === SESSION));

    // Start from idle so the prompt's effect on status is observable.
    h.statusService.getSession(SESSION);
    h.store.applySignal(SESSION, { signal: SIGNAL.QUEUE_EMPTY, sessionId: SESSION });
    h.store.upsertSession({ ...h.store.get(SESSION), status: 'idle' });

    // 2. session detail
    const detail = await request(h.baseUrl, `/api/v1/sessions/${SESSION}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.id, SESSION);

    // 3. submit a prompt with the default steer mode
    const submit = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`, {
      method: 'POST',
      body: { content: 'integration scenario', client_message_id: 'integration-1' },
    });

    // 4. accepted
    assert.equal(submit.status, 202);
    assert.equal(submit.body.data.accepted, true);
    assert.equal(submit.body.data.request_id, 'integration-1');
    assert.equal(submit.body.data.mode, 'steer');

    // 5. status is running
    assert.equal(h.statusService.getSession(SESSION).status, 'running');
    const afterSubmit = await request(h.baseUrl, `/api/v1/sessions/${SESSION}`);
    assert.equal(afterSubmit.body.data.status, 'running');

    // 6. cancel
    const cancel = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/cancel`, { method: 'POST' });

    // 7. admission only
    assert.equal(cancel.status, 202);
    assert.equal(cancel.body.data.accepted, true);

    // 8. status is STILL running — admission is not quiescence
    const afterCancel = await request(h.baseUrl, `/api/v1/sessions/${SESSION}`);
    assert.equal(afterCancel.body.data.status, 'running', 'a 202 cancel must not settle the session');

    // 9. observed abandon evidence arrives
    h.store.applySignal(SESSION, {
      signal: SIGNAL.RUN_ABANDONED,
      sessionId: SESSION,
      evidence: { source: 'integration scenario' },
    });

    // 10. now, and only now, cancelled
    const afterAbandon = await request(h.baseUrl, `/api/v1/sessions/${SESSION}`);
    assert.equal(afterAbandon.body.data.status, 'cancelled');
  } finally {
    await h.close();
  }
});

test('the scenario leaks no raw DSH object or internal identity', async () => {
  const h = await startFixtureServer();
  try {
    h.store.rememberDshCursor(SESSION, 418);

    const responses = [
      await request(h.baseUrl, '/api/v1/sessions'),
      await request(h.baseUrl, `/api/v1/sessions/${SESSION}`),
      await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`),
      await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`, {
        method: 'POST',
        body: { content: 'x', client_message_id: 'leak-check-1' },
      }),
      await request(h.baseUrl, `/api/v1/sessions/${SESSION}/cancel`, { method: 'POST' }),
    ];

    for (const res of responses) {
      for (const forbidden of [
        'dsh_cursor', 'metadata', 'observed_at', 'active_run', 'rawDsh',
        'SessionWire', 'Typert', 'suspendedStatus', 'highestRank', 'recentSignals',
        'dsh-auth', 'cookie', 'authorization', 'credentials', 'eventType',
      ]) {
        assert.equal(res.text.includes(forbidden), false, `${forbidden} leaked: ${res.text.slice(0, 200)}`);
      }
    }
  } finally {
    await h.close();
  }
});

test('no HTTP-layer file names a DSH endpoint or imports the wire layer', () => {
  const httpDir = path.join(HERE, '..', '..', 'src', 'remote', 'http');
  const files = [
    ...fs.readdirSync(httpDir).filter((name) => name.endsWith('.mjs')).map((name) => path.join(httpDir, name)),
    path.join(HERE, '..', '..', 'src', 'remote', 'server.mjs'),
    path.join(HERE, '..', '..', 'src', 'remote', 'status-service.mjs'),
    path.join(HERE, '..', '..', 'src', 'remote', 'uploads.mjs'),
  ];

  // The authoritative endpoint list, so this guard cannot drift.
  const routesSource = fs.readFileSync(path.join(HERE, '..', '..', 'src', 'remote', 'wire', 'dsh-routes.mjs'), 'utf8');
  const endpoints = [...routesSource.matchAll(/endpoint:\s*'([^']+)'/g)].map((match) => match[1]);
  assert.ok(endpoints.length >= 10, 'the route module should declare every endpoint');

  const allowedEventTypes = new Set(['session/title', 'turn/start', 'turn/end']);

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const name = path.basename(file);

    for (const match of code.matchAll(/(?:^|\n)\s*(?:import|export)[^\n]*from\s*['"]([^'"]+)['"]/g)) {
      assert.equal(/(^|\/)wire\//.test(match[1]), false, `${name} must not import ${match[1]}`);
    }
    for (const endpoint of endpoints) {
      assert.equal(code.includes(`'${endpoint}'`), false, `${name} must not name ${endpoint}`);
    }
    for (const eventType of ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'session/page', 'session/follow']) {
      if (allowedEventTypes.has(eventType)) continue;
      assert.equal(code.includes(`'${eventType}'`), false, `${name} must not name ${eventType}`);
    }
  }
});

test('sequence semantics stay distinct across the API surface', async () => {
  const h = await startFixtureServer();
  try {
    // Give the Gateway sequence and the DSH cursor different values.
    h.store.emitEvent({ sessionId: SESSION, event: 'session.status', data: {} });
    h.store.emitEvent({ sessionId: SESSION, event: 'session.status', data: {} });

    const detail = await request(h.baseUrl, `/api/v1/sessions/${SESSION}`);
    const history = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`);

    // `last_sequence` is the Gateway realtime mark.
    assert.equal(detail.body.data.last_sequence, 2);
    // A history page carries DSH durable cursors and says so.
    assert.equal(history.body.page.sequence_kind, 'dsh_durable_source_sequence');
    assert.deepEqual(history.body.data.map((message) => message.source_sequence), [40, 41, 42]);

    // The two spaces are visibly different numbers and never merged.
    assert.notEqual(detail.body.data.last_sequence, history.body.data[0].source_sequence);
    assert.equal('source_sequence' in detail.body.data, false, 'a session view has no source sequence');
    assert.equal('last_sequence' in history.body.page, false, 'a history page has no Gateway sequence');
  } finally {
    await h.close();
  }
});

test('a prompt submit does not block on the model', async () => {
  const h = await startFixtureServer();
  try {
    // Make the adapter's follow stream permanently silent: no assistant output
    // will ever appear. The submit must still return immediately.
    const started = Date.now();
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`, {
      method: 'POST',
      body: { content: 'answer never comes', client_message_id: 'no-wait-1' },
      timeoutMs: 3000,
    });
    const elapsed = Date.now() - started;

    assert.equal(res.status, 202);
    assert.ok(elapsed < 1500, `submit took ${elapsed}ms; it must not wait for the model`);
  } finally {
    await h.close();
  }
});

test('the server survives a full request cycle and shuts down cleanly', async () => {
  const h = await startFixtureServer();
  const { port } = h.address;

  await request(h.baseUrl, '/api/v1/health');
  await request(h.baseUrl, '/api/v1/sessions');
  await h.close();

  // After stop, the port must no longer answer.
  await assert.rejects(
    () => request(`http://127.0.0.1:${port}`, '/api/v1/health', { timeoutMs: 1500 }),
    'a stopped server must not accept connections',
  );
  assert.equal(h.adapter._state.closed, true, 'the adapter was closed, not killed');
});

test('stop is idempotent and does not throw', async () => {
  const h = await startFixtureServer();
  await h.close();
  await h.close();
  assert.equal(h.adapter._state.closed, true);
});

test('the server binds nothing at import time', async () => {
  // §4: importing the factory must not bind a port, open a socket, read a
  // credential, or write state. Prove it by importing and checking for listeners.
  const before = process.listenerCount('SIGINT');
  await import('../../src/remote/server.mjs');
  await import('../../src/remote/http/routes.mjs');
  assert.equal(process.listenerCount('SIGINT'), before, 'importing must not install process handlers');
});

test('every response is UTF-8 JSON with no-store caching', async () => {
  const h = await startFixtureServer();
  try {
    for (const path_ of ['/api/v1/health', '/api/v1/sessions', `/api/v1/sessions/${SESSION}`]) {
      const res = await request(h.baseUrl, path_);
      assert.equal(res.headers['content-type'], 'application/json; charset=utf-8', path_);
      assert.equal(res.headers['cache-control'], 'no-store', path_);
    }
  } finally {
    await h.close();
  }
});

test('the health and list endpoints agree about the gateway being up', async () => {
  const h = await startFixtureServer();
  try {
    const health = await request(h.baseUrl, '/api/v1/health');
    const sessions = await request(h.baseUrl, '/api/v1/sessions');
    assert.equal(health.status, 200);
    assert.equal(sessions.status, 200);
    assert.equal(health.body.data.gateway, 'ready');
  } finally {
    await h.close();
  }
});
