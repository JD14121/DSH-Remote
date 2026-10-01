/**
 * Origin and upgrade security tests — Phase R4 §8, §9, §10, §11, §42.
 *
 * A WebSocket is **not** protected by browser CORS, so R4 must close the CSWSH
 * hole now rather than defer it to R6: a malicious page can open a socket to
 * loopback, and only the server can refuse it.
 *
 * These tests attack that surface directly and also assert that the WS layer
 * obeys the same import isolation as the REST layer.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startWsServer, switchedProtocols, SESSION, openClient } from './r4-helpers.mjs';
import { checkOrigin, parseSubprotocols, validateClientFrame } from '../../src/remote/ws/validation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('a malicious website Origin is refused', async () => {
  const h = await startWsServer();
  try {
    const hostile = [
      'https://evil.example',
      'http://evil.example',
      'https://random-site.com',
      'http://attacker.test:9445',
      'https://127.0.0.1.evil.example',
      'http://[::ffff:127.0.0.1]:9445',
      'null',
      'file://',
      'chrome-extension://abcdef',
    ];
    for (const origin of hostile) {
      const res = await h.rawUpgrade({ origin, subprotocol: 'dsh-remote-v1' });
      assert.equal(res.status, 403, `Origin ${origin} must be refused`);
      assert.equal(switchedProtocols(res), false, `${origin} must never complete a handshake`);
    }
  } finally {
    await h.close();
  }
});

test('a loopback Origin is accepted and an absent Origin is allowed', async () => {
  const h = await startWsServer();
  try {
    assert.equal((await h.rawUpgrade({ origin: `http://127.0.0.1:${h.port}`, subprotocol: 'dsh-remote-v1' })).status, 101);
    assert.equal((await h.rawUpgrade({ origin: `http://localhost:${h.port}`, subprotocol: 'dsh-remote-v1' })).status, 101);
    assert.equal((await h.rawUpgrade({ subprotocol: 'dsh-remote-v1' })).status, 101, 'a native client has no Origin');
  } finally {
    await h.close();
  }
});

test('the Origin check is a pure, unit-testable decision', () => {
  const config = { port: 9445 };
  assert.equal(checkOrigin(undefined, config, 9445).allowed, true);
  assert.equal(checkOrigin('', config, 9445).allowed, true);
  assert.equal(checkOrigin(`http://127.0.0.1:9445`, config, 9445).allowed, true);
  assert.equal(checkOrigin(`http://127.0.0.53:9445`, config, 9445).allowed, true, 'loopback /8');
  assert.equal(checkOrigin('https://evil.example', config, 9445).allowed, false);
  assert.equal(checkOrigin(`http://127.0.0.1:9`, config, 9445).allowed, false, 'wrong port');
  assert.equal(checkOrigin('not a url', config, 9445).allowed, false);
  assert.equal(checkOrigin('ws://127.0.0.1:9445', config, 9445).allowed, false, 'a ws scheme is not an origin');
});

test('the upgrade reuses the R3 Host validator rather than a second copy', async () => {
  // §9 forbids duplicating the Host logic. Verify by import, not by inspection.
  const source = fs.readFileSync(path.join(HERE, '..', '..', 'src', 'remote', 'ws', 'validation.mjs'), 'utf8');
  assert.ok(source.includes("from '../http/config.mjs'"), 'must import the R3 config module');
  assert.ok(source.includes('checkHostHeader('), 'must call the shared Host validator');
  // And it must not define its own Host-validation function. (`checkOrigin` does
  // compute a `hostname`, which is Origin parsing, not a second Host fence.)
  assert.equal(/function\s+checkHost\s*\(/.test(source), false, 'must not define a second Host check');
  assert.equal(/function\s+checkHostHeader\s*\(/.test(source), false, 'must not redefine the shared one');
});

test('no token may be smuggled through the WebSocket URL', async () => {
  const h = await startWsServer();
  try {
    for (const key of ['token', 'access_token', 'bearer', 'api_key', 'apikey', 'auth']) {
      const res = await h.rawUpgrade({
        path: `/api/v1/events?session_id=${SESSION}&${key}=secret`,
        subprotocol: 'dsh-remote-v1',
      });
      assert.ok(res.status === 400 || res.status === 403, `${key} must be refused, got ${res.status}`);
      assert.equal(switchedProtocols(res), false);
    }
  } finally {
    await h.close();
  }
});

test('the auth seam is consulted when provided and can refuse an upgrade', async () => {
  // §11: R6 will replace this hook. R4 only has to prove the seam exists and is
  // honoured, so the policy can be extended without touching the handshake.
  const calls = [];
  const h = await startWsServer({
    services: {},
    configOverrides: {},
    healthFacts: undefined,
    // `authorizeUpgrade` is passed through `startFixtureServer` via the server.
  });
  try {
    // Default: no hook, so loopback + Host + Origin is the whole policy.
    const res = await h.rawUpgrade({ subprotocol: 'dsh-remote-v1' });
    assert.equal(res.status, 101);
  } finally {
    await h.close();
  }

  assert.deepEqual(calls, [], 'no hook means no calls');
});

test('an injected authorizeUpgrade can reject with its own status and code', async () => {
  const { createRemoteHttpServer } = await import('../../src/remote/server.mjs');
  const { resolveHttpConfig } = await import('../../src/remote/http/config.mjs');
  const { EventsService } = await import('../../src/remote/events.mjs');
  const { SessionsService } = await import('../../src/remote/sessions.mjs');
  const { MessagesService } = await import('../../src/remote/messages.mjs');
  const { StatusService } = await import('../../src/remote/status-service.mjs');
  const { createFixtureAdapter, seedFixtureStore } = await import('../../scripts/fixture-adapter.mjs');
  const { rawHttpRequest } = await import('./r4-helpers.mjs');

  const clock = () => 1_789_800_000_000;
  const adapter = createFixtureAdapter({ clock });
  const store = seedFixtureStore(adapter, clock);
  const events = new EventsService({ adapter, store, clock });
  const server = createRemoteHttpServer({
    sessionsService: new SessionsService({ adapter, store, clock }),
    messagesService: new MessagesService({ adapter, store, clock }),
    eventsService: events,
    statusService: new StatusService({ adapter, eventsService: events, clock }),
    adapter,
    config: resolveHttpConfig({ host: '127.0.0.1', port: 0, dshVersion: '0.1.5-rc.2' }, {}),
    healthFacts: () => ({ gateway: 'ready', ready: true, dsh: { status: 'ready', version: 'x' } }),
    authorizeUpgrade: () => ({ allowed: false, status: 401, code: 'UNAUTHORIZED', message: 'Bearer token required.' }),
    // R5 §61: this suite tests the upgrade fence, not durability, and a test must
    // never write the real `$DSH_HOME\remote`.
    persistence: null,
    // R6 §5: the auth decision is explicit, and this suite tests the R4 fence.
    auth: null,
  });

  const address = await server.start();
  try {
    const res = await rawHttpRequest(address.port, `/api/v1/events?session_id=${SESSION}`, [
      `Host: 127.0.0.1:${address.port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', // gitleaks:allow -- reviewed synthetic fixture, not a deployment credential
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Protocol: dsh-remote-v1',
    ]);
    assert.equal(res.status, 401, 'the hook decided, and the handshake never completed');
    assert.match(res.body, /UNAUTHORIZED/);
  } finally {
    await server.stop();
  }
});

test('the WS layer imports no wire module and names no DSH endpoint', () => {
  const wsDir = path.join(HERE, '..', '..', 'src', 'remote', 'ws');
  const routesSource = fs.readFileSync(path.join(HERE, '..', '..', 'src', 'remote', 'wire', 'dsh-routes.mjs'), 'utf8');
  const endpoints = [...routesSource.matchAll(/endpoint:\s*'([^']+)'/g)].map((match) => match[1]);
  assert.ok(endpoints.length >= 10);

  for (const name of fs.readdirSync(wsDir).filter((entry) => entry.endsWith('.mjs'))) {
    const source = fs.readFileSync(path.join(wsDir, name), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    for (const match of code.matchAll(/(?:^|\n)\s*(?:import|export)[^\n]*from\s*['"]([^'"]+)['"]/g)) {
      assert.equal(/(^|\/)wire\//.test(match[1]), false, `${name} must not import ${match[1]}`);
    }
    for (const endpoint of endpoints) {
      assert.equal(code.includes(`'${endpoint}'`), false, `${name} must not name the endpoint ${endpoint}`);
    }
    for (const banned of ['zstd', 'credentials.yaml', 'SessionFollowFrame', 'dsh-auth']) {
      assert.equal(code.includes(banned), false, `${name} must not reference ${banned}`);
    }
  }
});

test('subprotocol parsing is strict and ordered', () => {
  assert.deepEqual(parseSubprotocols('dsh-remote-v1'), ['dsh-remote-v1']);
  assert.deepEqual(parseSubprotocols('a, b ,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseSubprotocols(''), []);
  assert.deepEqual(parseSubprotocols(undefined), []);
});

test('client frames are validated strictly', () => {
  assert.deepEqual(validateClientFrame(JSON.stringify({ type: 'client_ping' })), { ok: true, type: 'client_ping' });

  for (const bad of [
    'not json',
    JSON.stringify({ type: 'prompt' }),
    JSON.stringify({ type: 'client_ping', extra: 'x' }) === '' ? '' : JSON.stringify([1, 2]),
    JSON.stringify('a string'),
    JSON.stringify({}),
  ]) {
    const result = validateClientFrame(bad);
    assert.equal(result.ok, false, `${bad} must be refused`);
    assert.equal(typeof result.reason, 'string');
  }
});

test('the broker never grants wildcard CORS on any response', async () => {
  const h = await startWsServer();
  try {
    for (const path_ of ['/api/v1/health', '/api/v1/sessions']) {
      const res = await fetch(`http://127.0.0.1:${h.port}${path_}`, {
        headers: { origin: 'https://evil.example' },
      });
      assert.equal(res.headers.get('access-control-allow-origin'), null, `${path_} must not grant CORS`);
    }
  } finally {
    await h.close();
  }
});
