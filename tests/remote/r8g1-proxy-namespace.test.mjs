/**
 * R8G.1 — the static/backend namespace split in the dev server.
 *
 * ## The defect this file exists for
 *
 * The dev server proxied anything starting with `/api/`. But the UI's own browser modules live
 * under `src/remote/ui/api/`, so they are served at `/api/*.js`. Real mode therefore asked for
 * `/api/real-mode.js`, the server forwarded it to the Gateway as API traffic, and the Gateway
 * correctly answered `403 path_not_allowed` — the UI could not load its own module.
 *
 * Over ADB reverse on a phone this presented as a mobile-only failure. It was not: the prefix was
 * simply too broad. Only the backend namespace `/api/v1/*` may be proxied.
 *
 * The boundary must be exact, and it must not have been widened by adding `/api/real-mode.js` to
 * the Gateway REST allowlist. These tests pin both halves.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { createUiServer, isBackendRequest, resolveUiPath } from '../../scripts/r8b-ui-server.mjs';
import { isAllowedPath, isAllowedUpgradePath, PROXY_TARGET_HOST, PROXY_TARGET_PORT } from '../../src/remote/ui/api/dev-proxy.mjs';

const UI = path.join(process.cwd(), 'src', 'remote', 'ui');
const UI_API = path.join(UI, 'api');

/**
 * Start a dev server in front of a recording upstream.
 *
 * @returns {Promise<object>} the fixture.
 */
async function startFixture() {
  const upstreamSeen = [];
  const upstream = http.createServer((req, res) => {
    upstreamSeen.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/api/v1/health') {
      res.end(JSON.stringify({ auth: {}, dsh: {}, gateway: {}, persistence: {}, ready: true, status: 'ok' }));
      return;
    }
    if (req.url === '/api/v1/sessions') {
      res.end(JSON.stringify({ api_version: 1, data: [], page: {} }));
      return;
    }
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  const server = createUiServer({ targetPort: upstream.address().port });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  return {
    upstreamSeen,
    origin: `http://127.0.0.1:${port}`,
    server,
    async probe(p) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return { status: res.status, ctype: res.headers.get('content-type'), bytes: buf.length, text: buf.toString('utf8') };
    },
    async stop() {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await new Promise((r) => upstream.close(r));
    },
  };
}

// ── the predicate ────────────────────────────────────────────────────────────

test('only the /api/v1 namespace is backend traffic', () => {
  for (const backend of [
    '/api/v1',
    '/api/v1/',
    '/api/v1/health',
    '/api/v1/sessions',
    '/api/v1/sessions/s-1',
    '/api/v1/sessions/s-1/messages',
    '/api/v1/sessions/s-1/cancel',
    '/api/v1/sessions/s-1/uploads',
    '/api/v1/auth/ws-ticket',
    '/api/v1/events?ticket=t&session_id=s-1',
  ]) {
    assert.equal(isBackendRequest(backend), true, `${backend} should be proxied`);
  }
});

test('the UI\'s own /api/*.js modules are NOT backend traffic', () => {
  // Every module that actually lives under src/remote/ui/api/.
  for (const entry of fs.readdirSync(UI_API)) {
    assert.equal(
      isBackendRequest(`/api/${entry}`),
      false,
      `/api/${entry} is a browser module and must be served as a static asset`,
    );
  }
  // And the specific one the mobile blocker reported.
  assert.equal(isBackendRequest('/api/real-mode.js'), false);
});

test('near-miss prefixes are not treated as backend', () => {
  for (const notBackend of [
    '/api',
    '/api/',
    '/api/v1.js',
    '/api/v2/sessions',
    '/apiary/x.js',
    '/apifoo.js',
    '/api/events',
    '/index.html',
    '/',
    '',
  ]) {
    assert.equal(isBackendRequest(notBackend), false, `${notBackend} must not be proxied`);
  }
});

// ── the reported regression ──────────────────────────────────────────────────

test('/api/real-mode.js is served as a static 200 module (the blocker)', async () => {
  const f = await startFixture();
  try {
    const r = await f.probe('/api/real-mode.js');
    const local = fs.readFileSync(path.join(UI_API, 'real-mode.js'));

    assert.equal(r.status, 200, 'real mode must be able to load its own module');
    assert.notEqual(r.status, 403, 'the reported failure was a 403 from the Gateway');
    assert.match(r.ctype, /javascript/);
    assert.equal(r.bytes, local.length, 'the served module must be byte-identical to disk');
    assert.equal(f.upstreamSeen.length, 0, 'and must never have reached the Gateway');
  } finally {
    await f.stop();
  }
});

test('every module under ui/api is statically served and never proxied', async () => {
  const f = await startFixture();
  try {
    for (const entry of fs.readdirSync(UI_API)) {
      const r = await f.probe(`/api/${entry}`);
      const local = fs.readFileSync(path.join(UI_API, entry));
      assert.equal(r.status, 200, `/api/${entry} should be 200`);
      assert.equal(r.bytes, local.length, `/api/${entry} should match disk`);
    }
    assert.equal(f.upstreamSeen.length, 0, 'no module request may reach the Gateway');
  } finally {
    await f.stop();
  }
});

test('the transitive module graph real mode needs resolves statically', async () => {
  const f = await startFixture();
  try {
    // real-mode.js imports recovery and the api helpers; app.js dynamic-imports both halves.
    for (const p of ['/app.js', '/recovery/recovery-controller.js', '/recovery/timeline-reconciler.js',
      '/ws/event-client.js', '/ws/live-session.js', '/api/api-client.js', '/api/normalizers.js', '/api/errors.js']) {
      const r = await f.probe(p);
      assert.equal(r.status, 200, `${p} must load`);
      assert.match(r.ctype, /javascript/);
    }
    assert.equal(f.upstreamSeen.length, 0);
  } finally {
    await f.stop();
  }
});

// ── the backend half is preserved ────────────────────────────────────────────

test('/api/v1/health takes the proxy path', async () => {
  const f = await startFixture();
  try {
    const r = await f.probe('/api/v1/health');
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('persistence'), 'the upstream body must be forwarded');
    assert.equal(f.upstreamSeen.length, 1, 'the request must have reached the Gateway');
    assert.equal(f.upstreamSeen[0].url, '/api/v1/health');
  } finally {
    await f.stop();
  }
});

test('an unknown /api/v1 path is refused and never reaches the Gateway', async () => {
  const f = await startFixture();
  try {
    for (const unknown of ['/api/v1/admin', '/api/v1/secrets', '/api/v1/sessions/s-1/../../etc/passwd']) {
      const r = await f.probe(unknown);
      assert.equal(r.status, 403, `${unknown} must be refused by the proxy allowlist`);
    }
    assert.equal(f.upstreamSeen.length, 0, 'a refused path must not open an upstream connection');
  } finally {
    await f.stop();
  }
});

test('the events path stays WebSocket-only over REST', async () => {
  const f = await startFixture();
  try {
    const r = await f.probe('/api/v1/events?ticket=t&session_id=s-1');
    // A plain GET is not a REST route: the proxy refuses it, and the upgrade is the only way in.
    assert.equal(r.status, 403);
    assert.equal(f.upstreamSeen.length, 0);
    // The upgrade allowlist is unchanged and exact.
    assert.equal(isAllowedUpgradePath('/api/v1/events'), true);
    for (const denied of ['/api/v1/health', '/api/real-mode.js', '/api/v1/events/extra', '/ws']) {
      assert.equal(isAllowedUpgradePath(denied), false, `${denied} must not be upgradable`);
    }
  } finally {
    await f.stop();
  }
});

test('the WebSocket upgrade still relays through the proxy', async () => {
  // A full upgrade handshake against the dev server, proving the WS path was not disturbed.
  const { WebSocketServer } = await import('ws');

  const wss = new WebSocketServer({ noServer: true });
  const upstream = http.createServer((req, res) => { res.writeHead(200); res.end('{}'); });
  const upgrades = [];
  upstream.on('upgrade', (req, socket, head) => {
    upgrades.push(req.url);
    if (!String(req.headers['sec-websocket-protocol'] ?? '').includes('dsh-remote-v1')) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: 'hello', protocol: 'dsh-remote-v1', session_id: 's-1' }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  const server = createUiServer({ targetPort: upstream.address().port });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    const socket = new globalThis.WebSocket(`ws://127.0.0.1:${port}/api/v1/events?ticket=t&session_id=s-1`, ['dsh-remote-v1']);
    const received = [];
    socket.addEventListener('message', (e) => received.push(JSON.parse(e.data)));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no frame relayed')), 3000);
      socket.addEventListener('message', () => { clearTimeout(timer); resolve(); });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('socket error')); });
    });

    assert.equal(received[0].type, 'hello', 'the WS relay must still work');
    assert.equal(upgrades.length, 1, 'exactly one upgrade reached the upstream');
    assert.match(upgrades[0], /^\/api\/v1\/events\?/, 'and it carried the ticket query');
    socket.close();
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise((r) => wss.close(r));
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
  }
});

// ── the surrounding contract is unchanged ────────────────────────────────────

test('the Gateway REST allowlist was NOT widened to include /api/real-mode.js', () => {
  // The requested fix explicitly forbids this shortcut: the module must be static, not allowed.
  assert.equal(isAllowedPath('/api/real-mode.js'), false, 'the module must not be an API route');
  for (const entry of fs.readdirSync(UI_API)) {
    assert.equal(isAllowedPath(`/api/${entry}`), false, `/api/${entry} must not be in the REST allowlist`);
  }
  // And the genuine routes are still allowed.
  for (const allowed of ['/api/v1/health', '/api/v1/sessions', '/api/v1/sessions/s-1',
    '/api/v1/sessions/s-1/messages', '/api/v1/sessions/s-1/cancel',
    '/api/v1/sessions/s-1/uploads', '/api/v1/auth/ws-ticket']) {
    assert.equal(isAllowedPath(allowed), true, `${allowed} should still be allowed`);
  }
});

test('the proxy keeps its fixed loopback target', () => {
  assert.equal(PROXY_TARGET_HOST, '127.0.0.1');
  assert.equal(PROXY_TARGET_PORT, 9445);
  const source = fs.readFileSync('scripts/r8b-ui-server.mjs', 'utf8');
  assert.match(source, /const HOST = '127\.0\.0\.1'/, 'the dev server stays loopback-only');
  assert.equal(/0\.0\.0\.0/.test(source), false, 'no LAN bind may be introduced');
});

test('CSP is unchanged: same-origin only, no socket scheme', async () => {
  const f = await startFixture();
  try {
    const res = await fetch(`${f.origin}/`);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /connect-src 'self'/);
    assert.equal(/connect-src \*/.test(csp), false);
    assert.equal(/\bws:/.test(csp), false);
    assert.equal(/\bwss:/.test(csp), false);
    assert.match(csp, /default-src 'none'/);
  } finally {
    await f.stop();
  }
});

test('path traversal is still refused', async () => {
  const f = await startFixture();
  try {
    for (const p of ['/../package.json', '/../../etc/passwd', '/styles/../../package.json']) {
      const r = await f.probe(p);
      assert.ok(r.status === 403 || r.status === 404, `${p} must be refused, got ${r.status}`);
    }
    assert.equal(f.upstreamSeen.length, 0);
  } finally {
    await f.stop();
  }
});

test('no module request is ever logged with its body or credentials', async () => {
  const originalWrite = process.stderr.write.bind(process.stderr);
  const logged = [];
  process.stderr.write = (chunk, ...rest) => { logged.push(String(chunk)); return originalWrite(chunk, ...rest); };

  const f = await startFixture();
  try {
    await f.probe('/api/real-mode.js');
    await f.probe('/api/v1/health');
  } finally {
    process.stderr.write = originalWrite;
    await f.stop();
  }

  const all = logged.join('');
  assert.equal(/Bearer/.test(all), false, 'an Authorization header must never be logged');
  assert.equal(/ticket=/.test(all), false, 'a ticket must never be logged');
});

test('resolveUiPath still serves the api directory and refuses escapes', () => {
  const resolved = resolveUiPath('/api/real-mode.js');
  assert.notEqual(resolved, null);
  assert.ok(resolved.startsWith(UI));
  assert.equal(path.basename(resolved), 'real-mode.js');
  assert.equal(resolveUiPath('/../package.json'), null, 'an escape must resolve to null');
});
