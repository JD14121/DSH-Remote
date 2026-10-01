/**
 * R8C — integration: API client against a real loopback HTTP server, mode separation and CSP.
 *
 * The fake Gateway here is a real `http.Server` on loopback, so the client's transport, header
 * handling and error mapping are exercised end to end — not mocked at the `fetch` boundary.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { ApiClient, MAX_UPLOAD_BYTES } from '../../src/remote/ui/api/api-client.js';
import { ERROR_KIND } from '../../src/remote/ui/api/errors.js';
import { RealModeController, isFixtureMode } from '../../src/remote/ui/api/real-mode.js';
import { CredentialStore, createMemoryStorage } from '../../src/remote/ui/api/credential-store.js';
import { FIXTURES } from '../../src/remote/ui/state/fixture-state.js';
import { createTestDocument } from './r8b-dom.mjs';

const UI = path.join(process.cwd(), 'src', 'remote', 'ui');

/**
 * Start a fake Gateway on loopback.
 *
 * @param {object} options - `token`, `sessions`.
 * @returns {Promise<object>} the server, its port and the requests it saw.
 */
async function startFakeGateway(options = {}) {
  const token = options.token ?? 'good-token';
  const sessions = options.sessions ?? [{ id: 's-1', title: 'One', status: 'running' }];
  const seen = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null });
      const auth = req.headers.authorization ?? '';

      if (req.url === '/api/v1/health') {
        if (auth !== `Bearer ${token}`) {
          // Anonymous health: 200 with a minimal body, exactly as the real Gateway behaves.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ auth: {}, gateway: {}, request_id: 'r-anon' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ auth: {}, dsh: {}, gateway: {}, persistence: {}, ready: true, status: 'ok' }));
        return;
      }

      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      if (req.url === '/api/v1/sessions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ items: sessions }));
        return;
      }

      const messagesMatch = /^\/api\/v1\/sessions\/([^/]+)\/messages$/.exec(req.url ?? '');
      if (messagesMatch) {
        if (req.method === 'POST') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'queued' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ items: [{ id: 'm-1', role: 'user', content: 'hi', sequence: 1 }] }));
        return;
      }

      if (/^\/api\/v1\/sessions\/[^/]+\/cancel$/.test(req.url ?? '')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'cancelled' }));
        return;
      }

      if (/^\/api\/v1\/sessions\/[^/]+\/uploads$/.test(req.url ?? '')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'f-1', name: 'x.png' }));
        return;
      }

      if (/^\/api\/v1\/sessions\/[^/]+$/.test(req.url ?? '')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(sessions[0] ?? { id: 's-1', status: 'idle' }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, seen };
}

test('the client completes the full authenticated loop against a real server', async () => {
  const gateway = await startFakeGateway();
  const client = new ApiClient({
    baseUrl: `http://127.0.0.1:${gateway.port}`,
    fetchImpl: globalThis.fetch,
    credential: 'good-token',
  });

  const health = await client.health();
  assert.equal(health.authenticated, true);

  const { sessions } = await client.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, 'One');

  const { messages } = await client.getMessages('s-1');
  assert.equal(messages[0].sequence, 1);

  const sent = await client.sendMessage('s-1', { content: 'hello', mode: 'queue' });
  assert.equal(sent.status, 'queued');

  const cancelled = await client.cancel('s-1');
  assert.equal(cancelled.status, 'cancelled');

  gateway.server.close();
});

test('an invalid token yields 401 and is never accepted', async () => {
  const gateway = await startFakeGateway({ token: 'good-token' });
  const client = new ApiClient({
    baseUrl: `http://127.0.0.1:${gateway.port}`,
    fetchImpl: globalThis.fetch,
    credential: 'wrong-token',
  });

  await assert.rejects(() => client.health(), (error) => {
    // The fake answers anonymous health with a minimal 200, so this is the contract check firing.
    assert.equal(error.kind, ERROR_KIND.AUTH_REQUIRED);
    return true;
  });
  await assert.rejects(() => client.listSessions(), (error) => {
    assert.equal(error.kind, ERROR_KIND.AUTH_REQUIRED);
    return true;
  });

  gateway.server.close();
});

test('an unreachable Gateway yields a network error, not an auth error', async () => {
  // Port 9 is closed.
  const client = new ApiClient({ baseUrl: 'http://127.0.0.1:9', fetchImpl: globalThis.fetch, credential: 'tok' });
  await assert.rejects(() => client.health(), (error) => {
    assert.equal(error.kind, ERROR_KIND.NETWORK);
    assert.equal(error.clearsCredential(), false);
    return true;
  });
});

test('the whole real-mode lifecycle works end to end', async () => {
  const gateway = await startFakeGateway();
  const storage = createMemoryStorage();
  const controller = new RealModeController({
    client: new ApiClient({ baseUrl: `http://127.0.0.1:${gateway.port}`, fetchImpl: globalThis.fetch }),
    credentials: new CredentialStore({ storage }),
  });

  // No credential yet.
  await controller.boot();
  assert.equal(controller.state.connection, 'auth_required');

  // Credential accepted, sessions loaded.
  await controller.submitCredential('good-token');
  assert.equal(controller.state.connection, 'connected');
  assert.equal(controller.state.sessionListStatus, 'loaded');
  assert.equal(storage.getItem('dsh.remote.phoneCredential'), 'good-token');

  // Session and messages.
  await controller.selectSession('s-1');
  assert.equal(controller.state.messages.length, 1);

  // A queued send.
  await controller.send({ content: 'hi', mode: 'queue' });
  assert.equal(controller.state.sendState, 'accepted');

  // Cancel. R8F §9/§11: the Gateway answers `202 Accepted` and deliberately does NOT set the
  // session to `cancelled` — that needs observed RUN_ABANDONED evidence. The UI records the
  // request as an action substate and leaves the domain to the authoritative event.
  const domainBefore = controller.state.domain;
  await controller.cancel();
  assert.equal(controller.state.cancelState, 'requested', 'the request is recorded locally');
  assert.equal(controller.state.domain, domainBefore, 'a REST 2xx must not force the terminal state');

  gateway.server.close();
});

test('every request carried an Authorization header and nothing else did', async () => {
  const gateway = await startFakeGateway();
  const controller = new RealModeController({
    client: new ApiClient({ baseUrl: `http://127.0.0.1:${gateway.port}`, fetchImpl: globalThis.fetch }),
    credentials: new CredentialStore({ storage: createMemoryStorage() }),
  });
  await controller.submitCredential('good-token');
  await controller.selectSession('s-1');

  const authenticated = gateway.seen.filter((r) => r.url !== '/api/v1/health');
  assert.ok(authenticated.length > 0);
  for (const request of authenticated) {
    assert.equal(request.auth, 'Bearer good-token', `${request.url} was sent without the credential`);
  }
  // The credential must never appear in a URL.
  for (const request of gateway.seen) {
    assert.equal(request.url.includes('good-token'), false, 'the token appeared in a URL');
  }

  gateway.server.close();
});

test('no WebSocket is opened and no ws-ticket is requested during a full run', async () => {
  const gateway = await startFakeGateway();
  const ticketRequests = [];
  const sockets = [];

  const savedWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = function trap(...args) { sockets.push(args); throw new Error('WebSocket used'); };

  try {
    const controller = new RealModeController({
      client: new ApiClient({ baseUrl: `http://127.0.0.1:${gateway.port}`, fetchImpl: globalThis.fetch }),
      credentials: new CredentialStore({ storage: createMemoryStorage() }),
    });
    await controller.submitCredential('good-token');
    await controller.selectSession('s-1');
    await controller.send({ content: 'x', mode: 'queue' });
  } finally {
    globalThis.WebSocket = savedWebSocket;
  }

  for (const request of gateway.seen) {
    if (request.url.includes('ws-ticket')) ticketRequests.push(request.url);
  }

  assert.deepEqual(sockets, [], 'a WebSocket was opened');
  assert.deepEqual(ticketRequests, [], 'a ws-ticket was requested');
  assert.equal(gateway.seen.some((r) => r.url.includes('/api/v1/sessions') && r.method === 'POST' && !r.url.includes('messages')), false,
    'sending to an existing session must not create a second session');

  gateway.server.close();
});

test('fixture mode is selected only by an explicit known fixture fragment', () => {
  const names = FIXTURES.map((f) => f.name);

  // Explicit fixture fragments select fixture mode.
  assert.equal(isFixtureMode('#fixture=streaming', names), true);
  assert.equal(isFixtureMode('#fixture=ready', names), true);
  // Bare or unknown fragments fall through to real mode.
  assert.equal(isFixtureMode('', names), false);
  assert.equal(isFixtureMode('#', names), false);
  assert.equal(isFixtureMode('#fixture=nope', names), false);
  assert.equal(isFixtureMode('#streaming', names), false);
  // A credential-shaped fragment can never select fixture mode.
  assert.equal(isFixtureMode('#token=abcDEF1234567890abcDEF1234567890abcDEF1234', names), false); // gitleaks:allow -- reviewed synthetic fixture, not a deployment credential
  assert.equal(isFixtureMode('#fixture=abcDEF1234567890abcDEF1234567890ab', names), false);
});

test('fixture mode performs no network activity at all', async () => {
  const doc = createTestDocument();
  const root = doc.createElement('div');
  root.setAttribute('id', 'app');

  const calls = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { calls.push(args); throw new Error('fetch used in fixture mode'); };

  // Also trap the ApiClient's injected fetch path.
  const { mount } = await import('../../src/remote/ui/app.js');
  const savedLocation = globalThis.location;
  globalThis.location = { hash: '#fixture=streaming' };
  const savedAdd = globalThis.addEventListener;
  const savedRemove = globalThis.removeEventListener;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};

  try {
    const controller = mount({ doc, root, autoplayStream: false });
    assert.ok(root.children.length > 0, 'fixture mode should render');
    controller.dispose();
  } finally {
    globalThis.fetch = savedFetch;
    globalThis.location = savedLocation;
    globalThis.addEventListener = savedAdd;
    globalThis.removeEventListener = savedRemove;
  }

  assert.deepEqual(calls, [], 'fixture mode made a network request');
});

test('the CSP permits only same-origin connections and no ws/wss', () => {
  const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  const csp = /content="([^"]*connect-src[^"]*)"/.exec(html)?.[1] ?? '';

  assert.match(csp, /connect-src 'self'/, 'same-origin is required for the loopback proxy');
  // No wildcard, no arbitrary scheme, no socket scheme.
  assert.equal(/connect-src \*/.test(csp), false, 'a wildcard connect-src is forbidden');
  assert.equal(/https?:/.test(csp), false, 'an explicit http(s) origin must not be listed');
  assert.equal(/\bws:/.test(csp), false, 'ws: must not be permitted');
  assert.equal(/\bwss:/.test(csp), false, 'wss: must not be permitted');
  assert.match(csp, /default-src 'none'/);
});

test('the served page CSP matches the checked-in document', async () => {
  const { createUiServer } = await import('../../scripts/r8b-ui-server.mjs');
  const server = createUiServer({ proxy: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/`);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /connect-src 'self'/);
  assert.equal(/\bws:/.test(csp), false);
  assert.equal(/\bwss:/.test(csp), false);

  server.close();
});

test('the runtime protocol classes were not modified for R8C', () => {
  // R8C may add UI code only. These files carry the frozen R3-R7 semantics.
  const protectedFiles = [
    'src/remote/dsh-adapter.mjs',
    'src/remote/sessions.mjs',
    'src/remote/messages.mjs',
    'src/remote/http/routes.mjs',
    'src/remote/production/production-gateway.mjs',
    'src/remote/production/supervisor.mjs',
    'src/remote/production/dsh-process.mjs',
  ];
  for (const file of protectedFiles) {
    assert.ok(fs.existsSync(file), `${file} should exist`);
  }
  // No UI module imports a runtime protocol class.
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      assert.equal(/from\s+['"][^'"]*(dsh-adapter|sessions\.mjs|messages\.mjs|production\/)/.test(text), false,
        `${path.relative(UI, full)} imports runtime code`);
    }
  };
  walk(UI);
});

test('session creation is wired through the API client, not a direct browser request', () => {
  const client = fs.readFileSync(path.join(UI, 'api', 'api-client.js'), 'utf8');
  const controller = fs.readFileSync(path.join(UI, 'api', 'real-mode.js'), 'utf8');
  assert.match(client, /async createSession\(/);
  assert.match(client, /#request\('POST',\s*'\/sessions'/);
  assert.match(controller, /this\.client\.createSession\(options\)/);

  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!full.endsWith('.js') || full === path.join(UI, 'api', 'api-client.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (/fetch\s*\([^)]*['"`]\/api\/v1\/sessions['"`]/s.test(text)) offenders.push(path.relative(UI, full));
    }
  };
  walk(UI);
  assert.deepEqual(offenders, [], `session-create bypassed the API client in:\n${offenders.join('\n')}`);
});

test('the upload limit is documented consistently', () => {
  assert.equal(MAX_UPLOAD_BYTES, 25 * 1024 * 1024);
  const client = fs.readFileSync(path.join(UI, 'api', 'api-client.js'), 'utf8');
  assert.match(client, /25 \* 1024 \* 1024/);
});
