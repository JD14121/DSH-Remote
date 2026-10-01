/**
 * R8D — WS dev-proxy security and CSP: the upgrade is narrow, fixed-target and never logs secrets.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import {
  PROXY_TARGET_HOST,
  PROXY_TARGET_PORT,
  isAllowedPath,
  isAllowedUpgradePath,
} from '../../src/remote/ui/api/dev-proxy.mjs';
import { createUiServer } from '../../scripts/r8b-ui-server.mjs';
import { startWsFixture, waitFor } from './r8d-harness.mjs';

const PROXY = path.join(process.cwd(), 'src', 'remote', 'ui', 'api', 'dev-proxy.mjs');
const UI = path.join(process.cwd(), 'src', 'remote', 'ui');

/**
 * Start a dev server whose proxy points at a fixture Gateway.
 *
 * @param {number} targetPort - the upstream port.
 * @returns {Promise<object>} the server and its base URL.
 */
async function startDevServer(targetPort) {
  const server = createUiServer({ targetPort });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    port,
    origin: `http://127.0.0.1:${port}`,
    wsOrigin: `ws://127.0.0.1:${port}`,
    /**
     * Stop the server.
     *
     * @returns {Promise<void>} when closed.
     */
    async stop() {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('the WS upgrade allowlist is exactly the events path', () => {
  assert.equal(isAllowedUpgradePath('/api/v1/events'), true);
  for (const denied of [
    '/',
    '/api/v1/health',
    '/api/v1/sessions',
    '/api/v1/auth/ws-ticket',
    '/api/v1/events/extra',
    '/api/v2/events',
    '/ws',
    '/socket.io',
  ]) {
    assert.equal(isAllowedUpgradePath(denied), false, `${denied} must not be upgradable`);
  }
  // The REST allowlist deliberately does NOT include the events path.
  assert.equal(isAllowedPath('/api/v1/events'), false, 'the events path is WS-only');
});

test('the proxy is a fixed target and never a generic WebSocket proxy', () => {
  const source = fs.readFileSync(PROXY, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.equal(PROXY_TARGET_HOST, '127.0.0.1');
  assert.equal(PROXY_TARGET_PORT, 9445);
  assert.match(source, /options\.targetHost \?\? PROXY_TARGET_HOST/);
  assert.match(source, /options\.targetPort \?\? PROXY_TARGET_PORT/);

  // The handshake is written by hand, so the upgrade is exactly ONE request. Using
  // `http.request` with an `upgrade` header makes Node perform the upgrade internally and issue
  // the request twice, which consumes a one-time ticket before the real attempt.
  assert.match(source, /net\.connect\(/, 'the upgrade must be relayed over a raw socket');
  assert.match(source, /'Upgrade: websocket'/, 'the upgrade header is constructed, not forwarded');
  assert.match(source, /`Host: \$\{host\}:\$\{port\}`/, 'the upstream Host is fixed, never client-supplied');

  // A client-supplied Upgrade header is never copied through wholesale.
  assert.equal(/headers\.upgrade\s*=/.test(source), false, 'the client Upgrade header must not be forwarded');
  assert.equal(/req\.headers\.host/.test(source), false, 'the client Host header must not be forwarded');
});

test('a WS upgrade is proxied end to end through the dev server', async () => {
  const fixture = await startWsFixture();
  const dev = await startDevServer(fixture.port);
  try {
    fixture.onConnection = (connection) => {
      connection.send({ type: 'hello', api_version: 1, protocol: 'dsh-remote-v1', session_id: connection.sessionId, sequence: { latest: 0, earliest_available: 0 }, replay: { requested_from: null, mode: 'live_only' } });
      connection.send({ type: 'replay_complete', sequence: 0, mode: 'live_only', replayed: 0 });
    };

    // Obtain a ticket through the dev server's REST proxy.
    const ticketResponse = await fetch(`${dev.origin}/api/v1/auth/ws-ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 's-1' }),
    });
    assert.equal(ticketResponse.status, 200);
    const { ticket } = await ticketResponse.json();
    assert.ok(typeof ticket === 'string' && ticket.length > 0);

    // Upgrade through the dev server.
    const socket = new globalThis.WebSocket(
      `${dev.wsOrigin}/api/v1/events?ticket=${ticket}&session_id=s-1`,
      ['dsh-remote-v1'],
    );
    const received = [];
    socket.addEventListener('message', (event) => received.push(JSON.parse(event.data)));

    await waitFor(() => received.length >= 2, 3000);
    assert.equal(received[0].type, 'hello');
    assert.equal(received[1].type, 'replay_complete');
    assert.equal(fixture.connections.length, 1, 'the upgrade reached the upstream Gateway');
    socket.close();
  } finally {
    await dev.stop();
    await fixture.stop();
  }
});

test('a WS upgrade to a non-allowlisted path is destroyed, not proxied', async () => {
  const fixture = await startWsFixture();
  const dev = await startDevServer(fixture.port);
  try {
    const socket = new globalThis.WebSocket(`${dev.wsOrigin}/api/v1/health`, ['dsh-remote-v1']);
    const outcome = await new Promise((resolve) => {
      socket.addEventListener('error', () => resolve('error'));
      socket.addEventListener('close', () => resolve('close'));
      socket.addEventListener('open', () => resolve('open'));
      setTimeout(() => resolve('timeout'), 800);
    });
    // Node's WebSocket exposes no upgrade error code, so any non-open outcome is the assertion:
    // the important part is that the upstream never saw an upgrade.
    assert.notEqual(outcome, 'open', 'a non-allowlisted path must not upgrade');
    assert.equal(fixture.rejectedUpgrades.length, 0, 'and must not reach the upstream');
    assert.equal(fixture.connections.length, 0);
  } finally {
    await dev.stop();
    await fixture.stop();
  }
});

test('the upgrade preserves the required subprotocol', async () => {
  const fixture = await startWsFixture({ requireSubprotocol: true });
  const dev = await startDevServer(fixture.port);
  try {
    fixture.onConnection = (connection) => {
      connection.send({ type: 'hello', api_version: 1, protocol: 'dsh-remote-v1', session_id: connection.sessionId, sequence: { latest: 0, earliest_available: 0 }, replay: { requested_from: null, mode: 'live_only' } });
    };
    const ticketResponse = await fetch(`${dev.origin}/api/v1/auth/ws-ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 's-1' }),
    });
    const { ticket } = await ticketResponse.json();

    const socket = new globalThis.WebSocket(`${dev.wsOrigin}/api/v1/events?ticket=${ticket}&session_id=s-1`, ['dsh-remote-v1']);
    await waitFor(() => fixture.connections.length === 1, 3000);
    assert.equal(fixture.rejectedUpgrades.some((r) => r.reason === 'subprotocol'), false,
      'the subprotocol must survive the proxy');
    socket.close();
  } finally {
    await dev.stop();
    await fixture.stop();
  }
});

test('the proxy logs neither the ticket nor the credential', async () => {
  const fixture = await startWsFixture();
  const dev = await startDevServer(fixture.port);
  const originalWrite = process.stderr.write.bind(process.stderr);
  const logged = [];
  process.stderr.write = (chunk, ...rest) => { logged.push(String(chunk)); return originalWrite(chunk, ...rest); };

  let ticket = null;
  try {
    const ticketResponse = await fetch(`${dev.origin}/api/v1/auth/ws-ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 's-1' }),
    });
    ({ ticket } = await ticketResponse.json());

    fixture.onConnection = (connection) => {
      connection.send({ type: 'hello', api_version: 1, protocol: 'dsh-remote-v1', session_id: connection.sessionId, sequence: { latest: 0, earliest_available: 0 }, replay: { requested_from: null, mode: 'live_only' } });
    };
    const socket = new globalThis.WebSocket(`${dev.wsOrigin}/api/v1/events?ticket=${ticket}&session_id=s-1`, ['dsh-remote-v1']);
    await waitFor(() => fixture.connections.length === 1, 3000);
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    process.stderr.write = originalWrite;
  }

  const all = logged.join('');
  assert.equal(all.includes(ticket), false, 'the one-time ticket was logged');
  assert.equal(all.includes(fixture.token), false, 'the Phone credential was logged');
  assert.equal(all.includes('Bearer'), false, 'an Authorization header was logged');
  await dev.stop();
  await fixture.stop();
});

test('the proxy does not log ticket response bodies', async () => {
  const fixture = await startWsFixture();
  const dev = await startDevServer(fixture.port);
  const originalWrite = process.stderr.write.bind(process.stderr);
  const logged = [];
  process.stderr.write = (chunk, ...rest) => { logged.push(String(chunk)); return originalWrite(chunk, ...rest); };

  let ticket = null;
  try {
    const response = await fetch(`${dev.origin}/api/v1/auth/ws-ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 's-1' }),
    });
    ({ ticket } = await response.json());
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(logged.join('').includes(ticket), false, 'the ticket response body was logged');
  // The REST proxy forwards the body untouched, so the client still receives it.
  const again = await fetch(`${dev.origin}/api/v1/auth/ws-ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's-1' }),
  });
  assert.equal(again.status, 200);
  await dev.stop();
  await fixture.stop();
});

test('the CSP permits same-origin only and no socket scheme', () => {
  const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  const csp = /content="([^"]*connect-src[^"]*)"/.exec(html)?.[1] ?? '';

  // A WebSocket to a same-origin path is covered by 'self'; nothing wider is needed or allowed.
  assert.match(csp, /connect-src 'self'/);
  assert.equal(/connect-src \*/.test(csp), false, 'a wildcard is forbidden');
  assert.equal(/\bws:/.test(csp), false, 'ws: must not be listed');
  assert.equal(/\bwss:/.test(csp), false, 'wss: must not be listed');
  assert.equal(/https?:/.test(csp), false, 'an explicit http(s) origin must not be listed');
});

test('the dev server CSP header also stays same-origin only', async () => {
  const dev = await startDevServer(PROXY_TARGET_PORT);
  try {
    const response = await fetch(`${dev.origin}/`);
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /connect-src 'self'/);
    assert.equal(/\bws:/.test(csp), false);
    assert.equal(/\bwss:/.test(csp), false);
  } finally {
    await dev.stop();
  }
});

test('no UI module uses a raw ws:// or wss:// URL literal', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) continue;
      const text = fs.readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      if (/['"`]wss?:\/\//.test(text)) offenders.push(path.relative(UI, full));
    }
  };
  walk(UI);
  assert.deepEqual(offenders, [], `a hard-coded socket URL would escape the proxy:\n${offenders.join('\n')}`);
});
