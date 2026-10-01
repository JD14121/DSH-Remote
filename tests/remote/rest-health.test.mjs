/**
 * Health endpoint tests — Phase R3 §12, §36.
 *
 * The point of these tests is the distinction §12 demands: "HTTP server is up"
 * and "DSH is authenticated" are different facts and must not be collapsed into
 * one boolean.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { request, startFixtureServer } from './r3-helpers.mjs';

test('health reports the gateway ready while the downstream is unavailable', async () => {
  // The real R3 runtime: no credential exists yet (R7 supplies it), so the
  // gateway is healthy but DSH cannot be used. Health must still be 200.
  const h = await startFixtureServer({
    healthFacts: () => ({
      gateway: 'ready',
      ready: false,
      dsh: { status: 'unavailable', version: '0.1.5-rc.2', reason_code: 'AUTH_UNAVAILABLE' },
    }),
  });
  try {
    const res = await request(h.baseUrl, '/api/v1/health');
    assert.equal(res.status, 200, 'the HTTP gateway itself is healthy');
    assert.equal(res.body.api_version, 1);
    assert.equal(res.body.data.status, 'ok');
    assert.equal(res.body.data.gateway, 'ready');
    assert.equal(res.body.data.ready, false, 'the downstream is not usable');
    assert.equal(res.body.data.dsh.status, 'unavailable');
    assert.equal(res.body.data.dsh.version, '0.1.5-rc.2');
    assert.equal(res.body.data.dsh.reason_code, 'AUTH_UNAVAILABLE');
  } finally {
    await h.close();
  }
});

test('health reports both ready when the downstream is usable', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.gateway, 'ready');
    assert.equal(res.body.data.ready, true);
    assert.equal(res.body.data.dsh.status, 'ready');
    assert.equal('reason_code' in res.body.data.dsh, false, 'no reason code when nothing is wrong');
  } finally {
    await h.close();
  }
});

test('a degraded downstream is distinct from both ready and unavailable', async () => {
  const h = await startFixtureServer({
    healthFacts: () => ({ gateway: 'ready', ready: false, dsh: { status: 'degraded', version: '0.1.5-rc.2' } }),
  });
  try {
    const res = await request(h.baseUrl, '/api/v1/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.dsh.status, 'degraded');
    assert.equal(res.body.data.ready, false);
    assert.equal(res.body.data.gateway, 'ready', 'a degraded DSH never marks the gateway unhealthy');
  } finally {
    await h.close();
  }
});

test('health always carries the observed DSH version', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/health');
    assert.equal(res.body.data.dsh.version, '0.1.5-rc.2');
  } finally {
    await h.close();
  }
});

test('health leaks no secret, path, command line or environment value', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/health');
    const lower = res.text.toLowerCase();

    for (const forbidden of [
      'dsh-auth',
      'cookie',
      'authorization',
      'bearer',
      'token',
      'credentials',
      '.credentials.yaml',
      'secret',
      'dsh_home',
      'dsh-work-test',
      'node_modules',
      'npx',
      'commandline',
      'process.env',
      'stack',
    ]) {
      assert.equal(lower.includes(forbidden), false, `health must not mention ${forbidden}`);
    }
  } finally {
    await h.close();
  }
});

test('health returns a request_id and distinguishes it from other identities', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/health');
    const requestId = res.body.data.request_id;
    assert.equal(typeof requestId, 'string');
    assert.match(requestId, /^[0-9a-f-]{36}$/, 'a server-generated UUID');

    // A client-supplied X-Request-Id is retained for diagnostics but never
    // becomes the server request id (§11).
    const withHeader = await request(h.baseUrl, '/api/v1/health', {
      headers: { 'x-request-id': 'client-supplied-id-1' },
    });
    assert.notEqual(withHeader.body.data.request_id, 'client-supplied-id-1');
    assert.match(withHeader.body.data.request_id, /^[0-9a-f-]{36}$/);
  } finally {
    await h.close();
  }
});

test('the server is healthy even with no DSH control stream at all', async () => {
  // No baseline was ever received: the status service has nothing to go on, yet
  // routing, JSON encoding and the envelope all still work.
  const h = await startFixtureServer({ adapterOptions: { errors: {} } });
  try {
    const health = await request(h.baseUrl, '/api/v1/health');
    assert.equal(health.status, 200);

    const sessions = await request(h.baseUrl, '/api/v1/sessions');
    assert.equal(sessions.status, 200, 'session listing still works without DSH telemetry');
  } finally {
    await h.close();
  }
});
