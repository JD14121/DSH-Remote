/**
 * R8C — dev proxy security: allowlist, fixed target, loopback-only, no credential logging.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import {
  PROXY_TARGET_HOST,
  PROXY_TARGET_PORT,
  handleProxyRequest,
  isAllowedPath,
} from '../../src/remote/ui/api/dev-proxy.mjs';

const PROXY = path.join(process.cwd(), 'src', 'remote', 'ui', 'api', 'dev-proxy.mjs');

/** Start a throwaway upstream that records what it received. */
async function startUpstream(responder) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      responder(req, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, received, port: server.address().port };
}

/** Start a proxy on a random port pointed at a given upstream port. */
async function startProxy(targetPort, options = {}) {
  const server = http.createServer((req, res) => handleProxyRequest(req, res, { targetPort, ...options }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

/** Issue a request and return status plus body text. */
async function request(port, pathname, init = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
  return { status: res.status, body: await res.text(), headers: res.headers };
}

test('path allowlist accepts exactly the R8C surface', () => {
  for (const allowed of [
    '/api/v1/health',
    '/api/v1/sessions',
    '/api/v1/sessions/s-1',
    '/api/v1/sessions/s-1/messages',
    '/api/v1/sessions/s-1/cancel',
    '/api/v1/sessions/s-1/uploads',
  ]) {
    assert.equal(isAllowedPath(allowed), true, `${allowed} should be allowed`);
  }
});

test('path allowlist refuses everything else', () => {
  for (const denied of [
    '/',
    '/index.html',
    '/api/v1/',
    '/api/v2/sessions',
    '/api/v1/sessions/s-1/messages/extra',
    '/api/v1/sessions/s-1/uploads/../../etc/passwd',
    '/api/v1/admin',
    '/api/v1/sessions/s-1/../../secrets',
    '/metrics',
    '/api/v1/ws-ticket',
  ]) {
    assert.equal(isAllowedPath(denied), false, `${denied} must be refused`);
  }
});

test('the local API proxy forwards the exact POST to the session collection', async () => {
  const upstream = await startUpstream((req, res) => { res.writeHead(200); res.end('{}'); });
  const proxy = await startProxy(upstream.port);
  const result = await request(proxy.port, '/api/v1/sessions', { method: 'POST', body: '{}' });
  assert.equal(result.status, 200, 'the API proxy must forward the explicit create route');
  // No other verb becomes valid merely because the collection path accepts POST.
  const put = await request(proxy.port, '/api/v1/sessions/s-1/messages', { method: 'PUT' });
  assert.equal(put.status, 405);
  const del = await request(proxy.port, '/api/v1/sessions/s-1', { method: 'DELETE' });
  assert.equal(del.status, 405);
  proxy.server.close();
  upstream.server.close();
});

test('only GET and POST are forwarded', async () => {
  const upstream = await startUpstream((req, res) => { res.writeHead(200); res.end('{}'); });
  const proxy = await startProxy(upstream.port);

  assert.equal((await request(proxy.port, '/api/v1/health')).status, 200);
  assert.equal((await request(proxy.port, '/api/v1/sessions', { method: 'POST', body: '{}' })).status, 200);
  for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.equal((await request(proxy.port, '/api/v1/health', { method })).status, 405, `${method} must be refused`);
  }
  proxy.server.close();
  upstream.server.close();
});

test('a disallowed path never reaches the upstream', async () => {
  const upstream = await startUpstream((req, res) => { res.writeHead(200); res.end('{}'); });
  const proxy = await startProxy(upstream.port);

  const result = await request(proxy.port, '/api/v1/admin');
  assert.equal(result.status, 403);
  assert.equal(upstream.received.length, 0, 'a refused path must not open an upstream socket');

  proxy.server.close();
  upstream.server.close();
});

test('the target is fixed and cannot be influenced by the request', async () => {
  const upstream = await startUpstream((req, res) => { res.writeHead(200); res.end('{}'); });
  const proxy = await startProxy(upstream.port);

  // Try to redirect via headers the proxy must ignore.
  await request(proxy.port, '/api/v1/health', {
    headers: { host: 'evil.example.com', 'x-forwarded-host': 'evil.example.com', 'x-target': 'http://evil.example.com' },
  });

  assert.equal(upstream.received.length, 1, 'the request should reach the configured upstream');
  // The upstream sees the fixed loopback host, never the attacker-supplied one.
  assert.notEqual(upstream.received[0].headers.host, 'evil.example.com');

  proxy.server.close();
  upstream.server.close();
});

test('the Authorization header is forwarded but never logged', async () => {
  const upstream = await startUpstream((req, res) => { res.writeHead(200); res.end('{}'); });
  const proxy = await startProxy(upstream.port);

  const originalWrite = process.stderr.write.bind(process.stderr);
  const logged = [];
  process.stderr.write = (chunk, ...rest) => { logged.push(String(chunk)); return originalWrite(chunk, ...rest); };

  try {
    await request(proxy.port, '/api/v1/health', { headers: { authorization: 'Bearer super-secret-phone-token' } });
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(upstream.received[0].headers.authorization, 'Bearer super-secret-phone-token');
  const allLogs = logged.join('');
  assert.equal(allLogs.includes('super-secret-phone-token'), false, 'the token was logged');
  assert.equal(allLogs.includes('Bearer'), false, 'the auth header was logged');

  proxy.server.close();
  upstream.server.close();
});

test('a multipart body is piped, never buffered or logged', async () => {
  const upstream = await startUpstream((req, res) => { res.writeHead(200); res.end('{}'); });
  const proxy = await startProxy(upstream.port);

  const originalWrite = process.stderr.write.bind(process.stderr);
  const logged = [];
  process.stderr.write = (chunk, ...rest) => { logged.push(String(chunk)); return originalWrite(chunk, ...rest); };

  try {
    const form = new FormData();
    form.append('file', new Blob(['secret file contents']), 'payload.bin');
    await fetch(`http://127.0.0.1:${proxy.port}/api/v1/sessions/s-1/uploads`, {
      method: 'POST', body: form, headers: { authorization: 'Bearer tok' },
    });
  } finally {
    process.stderr.write = originalWrite;
  }

  const allLogs = logged.join('');
  assert.equal(allLogs.includes('secret file contents'), false, 'the upload body was logged');
  assert.equal(allLogs.includes('payload.bin'), false, 'the filename was logged');
  assert.ok(upstream.received.length === 1, 'the upload should have been forwarded');

  proxy.server.close();
  upstream.server.close();
});

test('the upstream failure path logs only an error code', async () => {
  // Point at a port that is certainly closed.
  const proxy = await startProxy(9);
  const originalWrite = process.stderr.write.bind(process.stderr);
  const logged = [];
  process.stderr.write = (chunk, ...rest) => { logged.push(String(chunk)); return originalWrite(chunk, ...rest); };

  let result;
  try {
    result = await request(proxy.port, '/api/v1/health', { headers: { authorization: 'Bearer top-secret' } });
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(result.status, 502);
  const allLogs = logged.join('');
  assert.equal(allLogs.includes('top-secret'), false, 'a credential reached the error log');
  assert.match(allLogs, /\[r8c-proxy\] upstream error/);

  proxy.server.close();
});

test('only allowlisted response headers are returned', async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-request-id': 'req-1',
      'set-cookie': 'dsh-auth=leak; Path=/',
      'x-secret-internal': 'do-not-forward',
    });
    res.end('{}');
  });
  const proxy = await startProxy(upstream.port);
  const result = await request(proxy.port, '/api/v1/health');

  assert.equal(result.headers.get('content-type'), 'application/json');
  assert.equal(result.headers.get('x-request-id'), 'req-1');
  assert.equal(result.headers.get('set-cookie'), null, 'a cookie must not be forwarded to the page');
  assert.equal(result.headers.get('x-secret-internal'), null);
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');

  proxy.server.close();
  upstream.server.close();
});

test('the proxy source binds loopback and has a fixed target', () => {
  const source = fs.readFileSync(PROXY, 'utf8');
  assert.equal(PROXY_TARGET_HOST, '127.0.0.1');
  assert.equal(PROXY_TARGET_PORT, 9445);
  // The target must not be request-derived.
  assert.match(source, /options\.targetHost \?\? PROXY_TARGET_HOST/);
  assert.match(source, /options\.targetPort \?\? PROXY_TARGET_PORT/);
  // No dynamic URL construction from user input.
  assert.equal(/proxyUrl|req\.headers\.host.*target/i.test(source), false);
});

test('the dev server binds loopback only', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'scripts', 'r8b-ui-server.mjs'), 'utf8');
  assert.match(source, /const HOST = '127\.0\.0\.1'/);
  assert.equal(/0\.0\.0\.0/.test(source), false, 'the dev server must never bind all interfaces');
  assert.match(source, /server\.listen\(port, HOST/);
});
