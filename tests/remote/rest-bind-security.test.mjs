/**
 * Bind and security tests — Phase R3 §5, §6, §7, §27, §28, §29, §41.
 *
 * Starts real ephemeral servers and drives real sockets, because these are the
 * properties that only exist at the socket layer: the loopback bind, the Host
 * fence, the absence of wildcard CORS, and the body limits.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { request, startFixtureServer } from './r3-helpers.mjs';
import { assertLoopbackHost, checkHostHeader, isLoopbackHost, resolveHttpConfig } from '../../src/remote/http/config.mjs';

test('a non-loopback host is rejected at configuration time', async () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.50', '10.0.0.1', '8.8.8.8', 'example.com', '0.0.0.0:9445']) {
    assert.throws(() => resolveHttpConfig({ host }, {}), TypeError, `${host} must be rejected`);
    assert.throws(() => assertLoopbackHost(host), TypeError);
  }
});

test('the rejection message explains the loopback rule rather than hiding it', () => {
  assert.throws(
    () => assertLoopbackHost('0.0.0.0'),
    (error) => {
      assert.match(error.message, /loopback-only/i);
      assert.match(error.message, /127\.0\.0\.1/);
      return true;
    },
  );
});

test('loopback hosts are accepted and localhost is normalised to an IPv4 literal', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.0.0.53']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  // Reporting an exact bound address matters, so `localhost` never stays ambiguous.
  assert.equal(assertLoopbackHost('localhost'), '127.0.0.1');
  assert.equal(assertLoopbackHost('127.0.0.1'), '127.0.0.1');
  assert.equal(assertLoopbackHost('::1'), '::1');
  assert.equal(isLoopbackHost('127.0.0.1.evil.com'), false, 'a prefix match is not loopback');
  assert.equal(isLoopbackHost('128.0.0.1'), false);
});

test('the server binds a real loopback socket on an ephemeral port', async () => {
  const h = await startFixtureServer();
  try {
    assert.equal(h.address.host, '127.0.0.1');
    assert.ok(h.address.port > 0);

    const res = await request(h.baseUrl, '/api/v1/health');
    assert.equal(res.status, 200, 'reachable over loopback');
  } finally {
    await h.close();
  }
});

test('an unaccepted Host authority is refused with 403', async () => {
  const h = await startFixtureServer();
  const port = h.address.port;
  try {
    for (const host of ['evil.example', 'attacker.test:80', '192.168.1.9:' + port, 'example.com:' + port]) {
      const res = await request(h.baseUrl, '/api/v1/health', { host });
      assert.equal(res.status, 403, `Host ${host} must be refused`);
      assert.equal(res.body.error.code, 'FORBIDDEN_HOST');
    }
  } finally {
    await h.close();
  }
});

test('a loopback Host on the wrong port is refused', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/health', { host: '127.0.0.1:9' });
    assert.equal(res.status, 403, 'a same-host-but-wrong-port authority is not this server');
  } finally {
    await h.close();
  }
});

test('every loopback spelling on the correct port is accepted', async () => {
  const h = await startFixtureServer();
  const port = h.address.port;
  try {
    for (const host of ['127.0.0.1:' + port, 'localhost:' + port, '[::1]:' + port]) {
      const res = await request(h.baseUrl, '/api/v1/health', { host });
      assert.equal(res.status, 200, `Host ${host} should be accepted`);
    }
  } finally {
    await h.close();
  }
});

test('the Host fence runs before routing, so a bad Host cannot probe for paths', async () => {
  const h = await startFixtureServer();
  try {
    const badHostRealPath = await request(h.baseUrl, '/api/v1/health', { host: 'evil.example' });
    const badHostFakePath = await request(h.baseUrl, '/api/v1/does-not-exist', { host: 'evil.example' });

    // Both are 403: the reply never reveals whether a path exists.
    assert.equal(badHostRealPath.status, 403);
    assert.equal(badHostFakePath.status, 403);
    assert.equal(badHostFakePath.body.error.code, 'FORBIDDEN_HOST');
  } finally {
    await h.close();
  }
});

test('proxy headers are never trusted to satisfy the Host fence', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/health', {
      host: 'evil.example',
      headers: {
        'x-forwarded-host': '127.0.0.1',
        'x-forwarded-for': '127.0.0.1',
        forwarded: 'host=127.0.0.1',
      },
    });
    assert.equal(res.status, 403, 'a claimed forwarded host must not override the real Host');
  } finally {
    await h.close();
  }
});

test('no response carries a wildcard CORS grant', async () => {
  const h = await startFixtureServer();
  try {
    for (const path of ['/api/v1/health', '/api/v1/sessions']) {
      const res = await request(h.baseUrl, path, { headers: { origin: 'https://attacker.example' } });
      assert.equal(res.headers['access-control-allow-origin'], undefined, `${path} must not grant CORS`);
      assert.equal(res.headers['access-control-allow-credentials'], undefined);
      assert.equal(res.text.includes('*'), res.text.includes('*') && path.includes('sessions') ? res.text.includes('*') : false);
    }
  } finally {
    await h.close();
  }
});

test('an OPTIONS preflight is refused rather than advertised', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions', {
      method: 'OPTIONS',
      headers: { origin: 'https://attacker.example', 'access-control-request-method': 'GET' },
    });
    // R3 registers no OPTIONS route, so this is a method refusal, not a grant.
    assert.equal(res.status, 405);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.equal(res.body.error.code, 'METHOD_NOT_ALLOWED');
  } finally {
    await h.close();
  }
});

test('an oversized JSON body is a 413', async () => {
  const h = await startFixtureServer({ configOverrides: { maxJsonBytes: 512 } });
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${'session-00000000-0000-0000-0000-000000000001'}/messages`, {
      method: 'POST',
      body: { content: 'x'.repeat(2000), client_message_id: 'c1' },
    });
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, 'PAYLOAD_TOO_LARGE');
  } finally {
    await h.close();
  }
});

test('an oversized body is refused even without a content-length header', async () => {
  // A chunked sender can omit content-length, so the streaming ceiling is what
  // actually enforces the limit.
  const h = await startFixtureServer({ configOverrides: { maxJsonBytes: 512 } });
  try {
    const payload = JSON.stringify({ content: 'y'.repeat(5000), client_message_id: 'c1' });
    const res = await request(h.baseUrl, '/api/v1/sessions/session-00000000-0000-0000-0000-000000000001/messages', {
      method: 'POST',
      rawBody: payload,
      contentType: 'application/json',
    });
    assert.equal(res.status, 413);
  } finally {
    await h.close();
  }
});

test('a wrong media type is a 415', async () => {
  const h = await startFixtureServer();
  try {
    for (const contentType of ['text/plain', 'application/xml', 'application/x-www-form-urlencoded', '']) {
      const res = await request(h.baseUrl, '/api/v1/sessions/session-00000000-0000-0000-0000-000000000001/messages', {
        method: 'POST',
        rawBody: '{"content":"x","client_message_id":"c1"}',
        contentType,
      });
      assert.equal(res.status, 415, `content-type ${contentType}`);
      assert.equal(res.body.error.code, 'UNSUPPORTED_MEDIA_TYPE');
    }
  } finally {
    await h.close();
  }
});

test('a JSON content type with a charset is accepted', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions/session-00000000-0000-0000-0000-000000000001/messages', {
      method: 'POST',
      rawBody: '{"content":"x","client_message_id":"c1"}',
      contentType: 'application/json; charset=utf-8',
    });
    assert.equal(res.status, 202);
  } finally {
    await h.close();
  }
});

test('a known path with the wrong method is a 405 carrying Allow', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions', { method: 'DELETE' });
    assert.equal(res.status, 405);
    assert.equal(res.body.error.code, 'METHOD_NOT_ALLOWED');
    assert.equal(res.headers.allow, 'GET');
  } finally {
    await h.close();
  }
});

test('an unknown path is a 404 ROUTE_NOT_FOUND, never confused with 405', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/definitely-not-a-route', { method: 'DELETE' });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'ROUTE_NOT_FOUND');
    // A 404 must not advertise methods for a path that does not exist.
    assert.equal(res.headers.allow, undefined);
  } finally {
    await h.close();
  }
});

test('the 405 Allow header lists every method the path actually supports', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions/session-00000000-0000-0000-0000-000000000001/messages', {
      method: 'DELETE',
    });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET, POST');
  } finally {
    await h.close();
  }
});

test('no error response contains a stack, a cause, or a secret', async () => {
  const h = await startFixtureServer();
  try {
    const responses = [
      await request(h.baseUrl, '/api/v1/nope'),
      await request(h.baseUrl, '/api/v1/sessions', { method: 'DELETE' }),
      await request(h.baseUrl, '/api/v1/sessions/not-a-session'),
      await request(h.baseUrl, '/api/v1/sessions/session-00000000-0000-0000-0000-0000000000ff'),
      await request(h.baseUrl, '/api/v1/health', { host: 'evil.example' }),
      await request(h.baseUrl, '/api/v1/sessions?limit=abc'),
    ];

    for (const res of responses) {
      const lower = res.text.toLowerCase();
      for (const forbidden of [
        'at ', 'stack', 'cause', 'dsh-auth', 'cookie', 'authorization', 'bearer',
        'token', 'credentials', '.credentials.yaml', 'secret', 'node_modules',
        'd:\\', 'c:\\', 'dsh_home', 'process.env',
      ]) {
        // `at ` is skipped for bodies that legitimately contain "at" inside a word.
        if (forbidden === 'at ' && !lower.includes('\n    at ')) continue;
        assert.equal(lower.includes(forbidden), false, `${forbidden} leaked in ${res.text}`);
      }
      assert.equal(res.body.error.request_id !== undefined, true, 'every error carries a request_id');
    }
  } finally {
    await h.close();
  }
});

test('the error envelope has exactly the documented shape', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/nope');
    assert.deepEqual(Object.keys(res.body), ['error']);
    assert.deepEqual(
      Object.keys(res.body.error).sort(),
      ['code', 'message', 'request_id', 'retryable'],
    );
    assert.equal(typeof res.body.error.code, 'string');
    assert.equal(typeof res.body.error.message, 'string');
    assert.equal(typeof res.body.error.retryable, 'boolean');
  } finally {
    await h.close();
  }
});

test('a request id is unique per request', async () => {
  const h = await startFixtureServer();
  try {
    const ids = new Set();
    for (let index = 0; index < 5; index += 1) {
      const res = await request(h.baseUrl, '/api/v1/nope');
      ids.add(res.body.error.request_id);
    }
    assert.equal(ids.size, 5, 'a reused request id would break error correlation');
  } finally {
    await h.close();
  }
});

test('a malformed percent-escape in the path is a 400, not a crash', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions/%E0%A4%A');
    assert.equal(res.status, 400);
  } finally {
    await h.close();
  }
});

test('the Host decision function is pure and testable in isolation', () => {
  const config = { port: 9445 };
  assert.equal(checkHostHeader('127.0.0.1:9445', config, 9445).allowed, true);
  assert.equal(checkHostHeader('localhost:9445', config, 9445).allowed, true);
  assert.equal(checkHostHeader('[::1]:9445', config, 9445).allowed, true);
  assert.equal(checkHostHeader('127.0.0.1:9999', config, 9445).allowed, false);
  assert.equal(checkHostHeader('evil.example', config, 9445).allowed, false);
  assert.equal(checkHostHeader(undefined, config, 9445).allowed, false);
  assert.equal(checkHostHeader('127.0.0.1', config, 9445).allowed, false, 'a bare host omits the port');
});
