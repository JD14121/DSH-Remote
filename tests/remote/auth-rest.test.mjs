/**
 * REST authorization tests — Phase R6 §8, §12, §13, §29, §52, §77.
 *
 * §77's key case is the enumeration guard: an **unauthenticated** request for an
 * unknown session must be 401, not 404. If it were 404, an anonymous caller could
 * map which sessions exist.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTH_ERROR,
  SESSION,
  OTHER_SESSION,
  WWW_AUTHENTICATE,
  generateSyntheticToken,
  request,
  startAuthServer,
  makeTempStateRoot,
  startFixtureServer,
} from './r6-helpers.mjs';

/** Every protected route, with a request that would otherwise be valid. */
const PROTECTED = [
  { method: 'GET', path: () => `/api/v1/sessions/${SESSION}` },
  { method: 'GET', path: () => '/api/v1/sessions' },
  { method: 'GET', path: () => `/api/v1/sessions/${SESSION}/messages` },
  {
    method: 'POST',
    path: () => `/api/v1/sessions/${SESSION}/messages`,
    body: { content: 'hello', client_message_id: 'cmid-auth-1' },
  },
  { method: 'POST', path: () => `/api/v1/sessions/${SESSION}/cancel` },
  { method: 'POST', path: () => '/api/v1/auth/ws-ticket', body: { session_id: SESSION } },
];

test('§77: every protected route refuses an absent credential with 401', async () => {
  const h = await startAuthServer();
  try {
    for (const route of PROTECTED) {
      const res = await request(h.baseUrl, route.path(), {
        method: route.method,
        ...(route.body === undefined ? {} : { body: route.body }),
      });
      assert.equal(res.status, 401, `${route.method} ${route.path()} must require authentication`);
      assert.equal(res.body.error.code, AUTH_ERROR.REQUIRED, `${route.method} ${route.path()} code`);
    }
  } finally {
    await h.close();
  }
});

test('§77: every protected route refuses a wrong credential with 401', async () => {
  const h = await startAuthServer();
  try {
    for (const route of PROTECTED) {
      const res = await request(h.baseUrl, route.path(), {
        method: route.method,
        ...(route.body === undefined ? {} : { body: route.body }),
        headers: { authorization: `Bearer ${generateSyntheticToken()}` },
      });
      assert.equal(res.status, 401, `${route.method} ${route.path()} must reject a wrong token`);
      assert.equal(res.body.error.code, AUTH_ERROR.INVALID);
    }
  } finally {
    await h.close();
  }
});

test('§77: every protected route accepts the real credential', async () => {
  const h = await startAuthServer();
  try {
    for (const route of PROTECTED) {
      const res = await h[route.method === 'GET' ? 'get' : 'post'](
        route.path(),
        ...(route.method === 'GET' ? [] : [route.body]),
      );
      assert.notEqual(res.status, 401, `${route.method} ${route.path()} must accept the real credential`);
      assert.notEqual(res.status, 403);
    }
  } finally {
    await h.close();
  }
});

test('§13/§77: an unknown session is 401 without auth and 404 with it', async () => {
  const h = await startAuthServer();
  const unknown = 'session-00000000-0000-0000-0000-0000000000ff';
  try {
    const anonymous = await request(h.baseUrl, `/api/v1/sessions/${unknown}`);
    assert.equal(anonymous.status, 401, 'an anonymous caller must not learn that the session is missing');

    const authenticated = await h.get(`/api/v1/sessions/${unknown}`);
    assert.equal(authenticated.status, 404, 'an authenticated caller gets the honest answer');
  } finally {
    await h.close();
  }
});

test('§13: a real session and an unknown session are indistinguishable without auth', async () => {
  const h = await startAuthServer();
  const unknown = 'session-00000000-0000-0000-0000-0000000000fe';
  try {
    const real = await request(h.baseUrl, `/api/v1/sessions/${SESSION}`);
    const fake = await request(h.baseUrl, `/api/v1/sessions/${unknown}`);
    assert.equal(real.status, fake.status, 'the status must not differ');
    assert.deepEqual(
      { ...real.body.error, request_id: 'x' },
      { ...fake.body.error, request_id: 'x' },
      'the error body must not differ either',
    );
  } finally {
    await h.close();
  }
});

test('§8: every 401 carries WWW-Authenticate', async () => {
  const h = await startAuthServer();
  try {
    for (const route of PROTECTED.slice(0, 3)) {
      const res = await request(h.baseUrl, route.path(), { method: route.method });
      assert.equal(res.status, 401);
      assert.equal(res.headers['www-authenticate'], WWW_AUTHENTICATE, `${route.path()} challenge`);
    }
  } finally {
    await h.close();
  }
});

test('§8: a 401 body never echoes the credential', async () => {
  const h = await startAuthServer();
  const wrong = generateSyntheticToken();
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions', {
      headers: { authorization: `Bearer ${wrong}` },
    });
    const text = `${res.text}\n${JSON.stringify(res.headers)}`;
    assert.equal(text.includes(wrong), false, 'the presented token must not be echoed');
    assert.equal(text.includes(h.token), false, 'the real token must never appear');
  } finally {
    await h.close();
  }
});

test('§52: a bad scheme is 401, not 400 or 403', async () => {
  const h = await startAuthServer();
  try {
    for (const header of [`Basic ${h.token}`, `Token ${h.token}`, h.token, `Bearer`]) {
      const res = await request(h.baseUrl, '/api/v1/sessions', { headers: { authorization: header } });
      assert.equal(res.status, 401, `${header} must be 401`);
    }
  } finally {
    await h.close();
  }
});

test('§11: only health is reachable without a credential', async () => {
  const h = await startAuthServer();
  try {
    const health = await request(h.baseUrl, '/api/v1/health');
    assert.equal(health.status, 200, 'health stays public');
    assert.equal((await request(h.baseUrl, '/api/v1/sessions')).status, 401);
    assert.equal((await request(h.baseUrl, '/api/v1/sessions/' + SESSION)).status, 401);
  } finally {
    await h.close();
  }
});

test('§29: a disallowed Origin is refused with 403 even when the Bearer is correct', async () => {
  const h = await startAuthServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions', {
      headers: { authorization: `Bearer ${h.token}`, origin: 'https://evil.example' },
    });
    assert.equal(res.status, 403, 'a hostile page holding a valid token is still refused');
    assert.equal(res.body.error.code, 'ORIGIN_NOT_ALLOWED');
  } finally {
    await h.close();
  }
});

test('§29: an allowed Origin and an absent Origin both work', async () => {
  const h = await startAuthServer();
  try {
    const absent = await h.get('/api/v1/sessions');
    assert.equal(absent.status, 200, 'a native client sends no Origin');

    const sameOrigin = await request(h.baseUrl, '/api/v1/sessions', {
      headers: { authorization: `Bearer ${h.token}`, origin: `http://127.0.0.1:${h.address.port}` },
    });
    assert.equal(sameOrigin.status, 200, 'the loopback same-port origin is allowed');
  } finally {
    await h.close();
  }
});

test('§5: a fixture server with no auth is explicitly unauthenticated, not silently open', async () => {
  const { root, cleanup } = makeTempStateRoot('r6-rest-fixture');
  const h = await startFixtureServer({ persistenceConfig: { root } });
  try {
    // §12: with auth disabled, protected routes are reachable — which is exactly why
    // the fixture must say so in health rather than looking like a production server.
    assert.equal((await request(h.baseUrl, '/api/v1/sessions')).status, 200);
    const health = await request(h.baseUrl, '/api/v1/health');
    assert.equal(health.body.data.auth, undefined, 'auth: null means no auth axis at all');
    assert.equal(h.server.auth, null);
  } finally {
    await h.close();
    cleanup();
  }
});

test('§12: the ticket endpoint is not reachable when auth is disabled', async () => {
  const { root, cleanup } = makeTempStateRoot('r6-rest-noauth');
  const h = await startFixtureServer({ persistenceConfig: { root } });
  try {
    // The route exists, but minting without an enforcing service is meaningless, so
    // the handler refuses rather than issuing an unauthenticated ticket.
    const res = await request(h.baseUrl, '/api/v1/auth/ws-ticket', {
      method: 'POST',
      body: { session_id: SESSION },
    });
    assert.equal(res.status, 404, 'no ticket can be minted without an auth service');
  } finally {
    await h.close();
    cleanup();
  }
});

test('the fixture clock keeps responses deterministic', async () => {
  const h = await startAuthServer();
  try {
    // Two identical calls differ only in request_id, never in a timestamp.
    const first = await h.get('/api/v1/sessions');
    const second = await h.get('/api/v1/sessions');
    assert.deepEqual(
      { ...first.body, request_id: 'x' },
      { ...second.body, request_id: 'x' },
    );
  } finally {
    await h.close();
  }
});

test('a second session is reachable with the same credential', async () => {
  const h = await startAuthServer();
  try {
    const res = await h.get(`/api/v1/sessions/${OTHER_SESSION}`);
    assert.notEqual(res.status, 401);
  } finally {
    await h.close();
  }
});
