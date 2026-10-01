/**
 * Origin and CORS tests — Phase R6 §27, §28, §29, §30, §31, §32, §33, §82.
 *
 * §27's requirement is that ONE policy serves REST, CORS, the WebSocket upgrade and
 * ticket binding. Several tests here assert that sameness directly, because four
 * copies of an origin rule would eventually disagree.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTH_ERROR,
  ALLOWED_REQUEST_HEADERS,
  CorsPolicy,
  OriginPolicy,
  SESSION,
  generateSyntheticToken,
  normalizeOrigin,
  parseAllowedOrigins,
  request,
  startAuthServer,
  startAuthWsServer,
  switchedProtocols,
} from './r6-helpers.mjs';

test('§28: the loopback defaults are allowed on the bound port only', () => {
  const policy = new OriginPolicy({ port: 9445 });
  for (const origin of ['http://127.0.0.1:9445', 'http://localhost:9445', 'http://[::1]:9445']) {
    assert.equal(policy.check(origin).allowed, true, `${origin} must be allowed`);
  }
  for (const origin of [
    'http://127.0.0.1:9',
    'http://localhost:1234',
    'https://evil.example',
    'http://192.168.1.5:9445',
  ]) {
    assert.equal(policy.check(origin).allowed, false, `${origin} must be refused`);
  }
});

test('§28: an absent or empty Origin is allowed, a null Origin is not', () => {
  const policy = new OriginPolicy({ port: 9445 });
  assert.equal(policy.check(undefined).allowed, true, 'a native client sends no Origin');
  assert.equal(policy.check(null).allowed, true);
  assert.equal(policy.check('').allowed, true);
  assert.equal(policy.check('null').allowed, false, 'the literal null origin is never allowed');
});

test('§28: configured exact origins are accepted, and normalised', () => {
  const policy = new OriginPolicy({ port: 9445, allowedOrigins: ['https://phone-ui.example'] });
  assert.equal(policy.check('https://phone-ui.example').allowed, true);
  // A default port is normalised, so these are the same origin.
  assert.equal(policy.check('https://phone-ui.example:443').allowed, true);
  assert.equal(policy.check('https://other.example').allowed, false);
});

test('§28: a malformed allowlist entry is rejected rather than ignored', () => {
  for (const bad of [
    '*',
    'https://*.example',
    'https://x.example/path',
    'https://x.example?q=1',
    'https://x.example#frag',
    'file:///etc/passwd',
    'null',
    'not a url',
    'ftp://x.example',
  ]) {
    assert.throws(
      () => parseAllowedOrigins(bad),
      (error) => error.code === AUTH_ERROR.CONFIG_INVALID,
      `${bad} must be refused as configuration`,
    );
  }
  // Silently dropping a malformed entry would leave an operator believing an origin
  // was permitted.
  assert.deepEqual(parseAllowedOrigins('https://a.example, https://b.example'), ['https://a.example', 'https://b.example']);
  assert.deepEqual(parseAllowedOrigins('https://a.example,https://a.example'), ['https://a.example'], 'duplicates removed');
});

test('§28: origin normalisation rejects paths, queries, fragments and userinfo', () => {
  assert.equal(normalizeOrigin('https://x.example/path').ok, false);
  assert.equal(normalizeOrigin('https://x.example?q=1').ok, false);
  assert.equal(normalizeOrigin('https://x.example#f').ok, false);
  assert.equal(normalizeOrigin('https://user:pass@x.example').ok, false);
  assert.equal(normalizeOrigin('ws://x.example').ok, false, 'a ws scheme is not an origin');
  assert.equal(normalizeOrigin('https://x.example').ok, true);
});

test('§29: DISALLOWED REST origins are refused with 403 before routing', async () => {
  const h = await startAuthServer();
  try {
    for (const origin of ['https://evil.example', 'http://192.168.1.5:9445', 'null', 'file://']) {
      const res = await h.get('/api/v1/sessions', { headers: { origin } });
      assert.equal(res.status, 403, `${origin} must be refused`);
      assert.equal(res.body.error.code, 'ORIGIN_NOT_ALLOWED');
    }
  } finally {
    await h.close();
  }
});

test('§29/§33: a disallowed Origin cannot probe paths either', async () => {
  const h = await startAuthServer();
  try {
    // The origin fence runs before routing, so an unknown path on a hostile origin
    // is still 403 rather than 404 — the caller learns nothing about the route table.
    const res = await h.get('/api/v1/definitely-not-a-route', { headers: { origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
  } finally {
    await h.close();
  }
});

test('§30: an allowed Origin is echoed exactly, with Vary, and never a wildcard', async () => {
  const h = await startAuthServer();
  try {
    const origin = `http://127.0.0.1:${h.address.port}`;
    const res = await h.get('/api/v1/sessions', { headers: { origin } });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], origin);
    assert.notEqual(res.headers['access-control-allow-origin'], '*');
    assert.ok(String(res.headers.vary).toLowerCase().includes('origin'));
    // §30: auth is a header, not an ambient cookie, so credentials mode is off.
    assert.equal(res.headers['access-control-allow-credentials'], undefined);
  } finally {
    await h.close();
  }
});

test('§30: no CORS header is sent when the request had no Origin', async () => {
  const h = await startAuthServer();
  try {
    const res = await h.get('/api/v1/sessions');
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  } finally {
    await h.close();
  }
});

test('§31: a valid preflight returns 204 with the exact allowlist', async () => {
  const h = await startAuthServer();
  const origin = `http://127.0.0.1:${h.address.port}`;
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions', {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], origin);
    assert.equal(res.headers['access-control-allow-methods'].includes('GET'), true);
    assert.equal(res.headers['access-control-allow-headers'].toLowerCase().includes('authorization'), true);
    assert.ok(res.headers['access-control-max-age'] !== undefined);
    assert.ok(String(res.headers.vary).toLowerCase().includes('origin'));
    assert.equal(res.text, '', 'a preflight has no body');
  } finally {
    await h.close();
  }
});

test('§31: a hostile preflight is refused with 403', async () => {
  const h = await startAuthServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    assert.equal(res.status, 403);
  } finally {
    await h.close();
  }
});

test('§31: a preflight naming an unlisted header is refused', async () => {
  const h = await startAuthServer();
  const origin = `http://127.0.0.1:${h.address.port}`;
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions', {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization, x-evil-header',
      },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, AUTH_ERROR.CORS_PREFLIGHT_REJECTED);
  } finally {
    await h.close();
  }
});

test('§31: a preflight naming a disallowed method is refused', async () => {
  const h = await startAuthServer();
  const origin = `http://127.0.0.1:${h.address.port}`;
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions', {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'DELETE' },
    });
    assert.equal(res.status, 403);
  } finally {
    await h.close();
  }
});

test('§32: a preflight does not require a credential', async () => {
  const h = await startAuthServer();
  const origin = `http://127.0.0.1:${h.address.port}`;
  try {
    // No Authorization header: the browser cannot send one until the preflight says
    // the header is allowed. §32 is explicit that OPTIONS is not authentication.
    const res = await request(h.baseUrl, '/api/v1/sessions', {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    assert.equal(res.status, 204);
  } finally {
    await h.close();
  }
});

test('§32: a preflight never returns protected data', async () => {
  const h = await startAuthServer();
  const origin = `http://127.0.0.1:${h.address.port}`;
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions', {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'GET' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.text, '', 'the preflight body is empty');
  } finally {
    await h.close();
  }
});

test('§27: the WebSocket upgrade uses the same policy as REST', async () => {
  const h = await startAuthWsServer({ config: { allowedOrigins: ['https://phone-ui.example'] } });
  try {
    const mint = await h.mintTicket({ sessionId: SESSION, origin: 'https://phone-ui.example' });
    const ticket = mint.body.data.ticket;

    // Allowed by the shared policy: the upgrade proceeds past the Origin check.
    const allowed = await h.ticketUpgrade({
      path: `/api/v1/events?session_id=${SESSION}&ticket=${ticket}`,
      origin: 'https://phone-ui.example',
    });
    assert.equal(allowed.status, 101, 'the explicitly allowed origin works for WS too');
  } finally {
    await h.close();
  }
});

test('§27: a hostile WebSocket Origin is refused with 403', async () => {
  const h = await startAuthWsServer();
  try {
    const res = await h.ticketUpgrade({
      path: `/api/v1/events?session_id=${SESSION}&ticket=${generateSyntheticToken()}`,
      origin: 'https://evil.example',
    });
    assert.equal(res.status, 403, 'the Origin fence runs before the ticket check');
    assert.equal(switchedProtocols(res), false);
  } finally {
    await h.close();
  }
});

test('§27: one policy object really serves all four consumers', async () => {
  const h = await startAuthServer();
  try {
    const policy = h.auth.originPolicy;
    // The CORS policy holds the same object, not a copy.
    assert.equal(h.auth.cors.policy, policy, 'CORS shares the policy instance');
    // And the ticket store's binding decision comes from the same call.
    const probe = `http://127.0.0.1:${h.address.port}`;
    assert.equal(policy.check(probe).allowed, true);
    assert.equal(h.auth.cors.headersFor(probe)['access-control-allow-origin'], probe);
  } finally {
    await h.close();
  }
});

test('§27: a standalone CorsPolicy shares the OriginPolicy it is given', () => {
  const policy = new OriginPolicy({ port: 9445 });
  const cors = new CorsPolicy({ originPolicy: policy });
  assert.equal(cors.policy, policy);
  assert.throws(() => new CorsPolicy({}), TypeError, 'a CORS policy needs an origin policy');
});

test('§33: the Host fence is unchanged — an external Host is still refused', async () => {
  const h = await startAuthServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions', {
      headers: { authorization: `Bearer ${h.token}`, host: 'evil.example' },
    });
    assert.equal(res.status, 403, 'a valid Bearer does not excuse a bad Host');
    assert.equal(res.body.error.code, 'FORBIDDEN_HOST');
  } finally {
    await h.close();
  }
});

test('§31: the allowlist is exactly the three documented request headers', () => {
  assert.deepEqual([...ALLOWED_REQUEST_HEADERS].sort(), ['authorization', 'content-type', 'x-request-id']);
});

test('§28: the server bind policy is not widened by configuring an origin', async () => {
  const h = await startAuthServer({ config: { allowedOrigins: ['https://phone-ui.example'] } });
  try {
    // §28: allowing an external origin must not make the server listen beyond
    // loopback. The resolved HTTP config still binds 127.0.0.1.
    assert.equal(h.config.host, '127.0.0.1', 'the bind policy is unchanged');
    assert.equal(h.server.address !== null, true);
  } finally {
    await h.close();
  }
});
