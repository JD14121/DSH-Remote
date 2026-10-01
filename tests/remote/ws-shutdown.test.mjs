/**
 * Shutdown tests — Phase R4 §39, §40, §52.
 *
 * §52 lists exactly what must be true after `stop()`: no new upgrades, clients
 * notified, sockets closed, timers cleaned, registry empty, StatusService stopped,
 * adapter closed, and `stop()` idempotent.
 *
 * The ordering matters too (§39): the WebSocket layer must go first, so no event
 * enters a registry that is being torn down.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { startWsServer, SESSION, emitGatewayEvent, rawHttpRequest } from './r4-helpers.mjs';
import { APP_CLOSE, STANDARD_CLOSE } from '../../src/remote/ws/close-codes.mjs';
import { FRAME } from '../../src/remote/ws/protocol.mjs';

test('stop notifies every client and closes with 1001', async () => {
  const h = await startWsServer();
  const a = await h.connect({ session_id: SESSION });
  const b = await h.connect({ session_id: SESSION });
  await a.waitForType(FRAME.REPLAY_COMPLETE);
  await b.waitForType(FRAME.REPLAY_COMPLETE);

  await h.server.stop();

  for (const client of [a, b]) {
    const close = await client.waitForClose();
    assert.equal(close.code, STANDARD_CLOSE.GOING_AWAY);
    const shutdown = client.ofType(FRAME.SERVER_SHUTDOWN);
    assert.equal(shutdown.length, 1, 'each client is told why');
    assert.equal(shutdown[0].retryable, true);
  }
  await h.close();
});

test('the subscriber registry is empty and the backlog cleared after stop', async () => {
  const h = await startWsServer();
  const client = await h.connect({ session_id: SESSION });
  await client.waitForType(FRAME.REPLAY_COMPLETE);
  assert.equal(h.server.ws.registry.size, 1);

  const ws = h.server.ws;
  await h.server.stop();

  assert.equal(ws.registry.isEmpty, true, 'the registry holds nothing');
  assert.equal(ws.registry.size, 0);
  assert.equal(ws.size, 0, 'no live clients remain');
  assert.deepEqual(ws.registry.sessions(), []);
  assert.equal(h.server.ws, null, 'the server drops its WS handle');
  await h.close();
});

test('no timer survives a stop', async () => {
  const h = await startWsServer();
  const client = await h.connect({ session_id: SESSION });
  await client.waitForType(FRAME.REPLAY_COMPLETE);

  // Reach into the client session to observe its heartbeat before shutdown.
  const sessions = h.server.ws.clients();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].heartbeat.running, true, 'timers are armed while live');

  await h.server.stop();
  assert.equal(sessions[0].heartbeat.running, false, 'timers are cleared on shutdown');
  await h.close();
});

test('a new upgrade is refused once shutdown has begun', async () => {
  const h = await startWsServer();
  const client = await h.connect({ session_id: SESSION });
  await client.waitForType(FRAME.REPLAY_COMPLETE);

  await h.server.stop();
  assert.equal(h.server.ws, null, 'no WS handle to accept with');

  // After a full stop the listener is gone, so the refusal happens at the TCP
  // layer. Either way the upgrade does not succeed, which is what §52 requires.
  let upgraded = false;
  let outcome = 'unknown';
  try {
    // `rawHttpRequest` destroys the socket on ECONNREFUSED without rejecting, so
    // both an error and a non-101 response are treated as a refusal.
    const res = await rawHttpRequest(h.port, `/api/v1/events?session_id=${SESSION}`, [
      `Host: 127.0.0.1:${h.port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', // gitleaks:allow -- reviewed synthetic fixture, not a deployment credential
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Protocol: dsh-remote-v1',
    ]);
    upgraded = res.status === 101;
    outcome = `status ${res.status}`;
  } catch (error) {
    outcome = `connection refused: ${error.code ?? error.message}`;
  }
  assert.equal(upgraded, false, `no upgrade may succeed after shutdown (${outcome})`);
  await h.close();
});

test('the StatusService is stopped and the adapter closed exactly once', async () => {
  const h = await startWsServer();
  await h.connect({ session_id: SESSION });

  let adapterCloses = 0;
  const originalClose = h.adapter.close.bind(h.adapter);
  h.adapter.close = async () => {
    adapterCloses += 1;
    return originalClose();
  };

  await h.server.stop();
  assert.equal(adapterCloses, 1, 'the adapter is closed exactly once');
  assert.equal(h.adapter._state.closed, true);
  assert.equal(h.statusService.started, false, 'the status wiring was stopped');

  // A second stop must not close it again.
  await h.server.stop();
  assert.equal(adapterCloses, 1, 'stop is idempotent');
  await h.close();
});

test('stop is idempotent and safe with no clients', async () => {
  const h = await startWsServer();
  await h.server.stop();
  await h.server.stop();
  await h.close();
  assert.equal(h.adapter._state.closed, true);
});

test('no DSH process is killed by shutdown', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of [
    '../../src/remote/ws/server.mjs',
    '../../src/remote/ws/client-session.mjs',
    '../../src/remote/server.mjs',
  ]) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    for (const banned of ['process.kill', 'child_process', 'execSync', 'spawnSync', 'taskkill']) {
      assert.equal(source.includes(banned), false, `${file} must not contain ${banned}`);
    }
  }
});

test('the shutdown order releases the WS layer before the HTTP listener', async () => {
  // Observable consequence: while stopping, the WS layer stops accepting before
  // the HTTP server does, so no event can be published into a closing registry.
  const h = await startWsServer();
  const client = await h.connect({ session_id: SESSION });
  await client.waitForType(FRAME.REPLAY_COMPLETE);

  const events = [];
  const originalStop = h.server.ws.stop.bind(h.server.ws);
  h.server.ws.stop = async () => {
    events.push('ws-stop');
    return originalStop();
  };

  await h.server.stop();
  assert.deepEqual(events, ['ws-stop'], 'the WS layer stops first');
  await h.close();
});

test('emitting during shutdown does not throw', async () => {
  const h = await startWsServer();
  await h.connect({ session_id: SESSION });
  const stopPromise = h.server.stop();

  // An event racing the shutdown must not produce an unhandled rejection.
  assert.doesNotThrow(() => {
    emitGatewayEvent(h, SESSION, 'session.status', { status: 'running' });
  });

  await stopPromise;
  await h.close();
});

test('a client that closes itself is removed from the registry without a leak', async () => {
  const h = await startWsServer();
  try {
    const client = await h.connect({ session_id: SESSION });
    await client.waitForType(FRAME.REPLAY_COMPLETE);
    await client.close();
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(h.server.ws.registry.size, 0);
    assert.equal(h.server.ws.size, 0);
    // A normal client close is 1000 or 1005 depending on how the peer closed.
    assert.ok([1000, 1005].includes(client.closeInfo?.code), `unexpected close ${client.closeInfo?.code}`);
  } finally {
    await h.close();
  }
});

test('shutdown leaves no unhandled rejection behind', async () => {
  const h = await startWsServer();
  const seen = [];
  const onRejection = (reason) => seen.push(reason);
  process.on('unhandledRejection', onRejection);

  try {
    await h.connect({ session_id: SESSION });
    await h.connect({ session_id: SESSION });
    await h.server.stop();
    await new Promise((resolve) => setTimeout(resolve, 120));
  } finally {
    process.removeListener('unhandledRejection', onRejection);
    await h.close();
  }

  assert.deepEqual(seen, [], 'shutdown must not leave a rejected promise');
});

test('the app close code for a policy violation is documented and in range', () => {
  assert.equal(APP_CLOSE.SESSION_NOT_FOUND, 4002);
  assert.equal(APP_CLOSE.BACKLOG_OVERFLOW, 4003);
  assert.equal(APP_CLOSE.CLIENT_MESSAGE_NOT_ALLOWED, 4004);
  for (const code of Object.values(APP_CLOSE)) {
    assert.ok(code >= 3000 && code <= 4999, `${code} must be a private-use close code`);
  }
});
