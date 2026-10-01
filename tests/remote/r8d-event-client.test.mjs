/**
 * R8D — EventClient transport behaviour, subprotocol, single-socket ownership and generation.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { EventClient, SOCKET_STATE, uiConnectionState } from '../../src/remote/ui/ws/event-client.js';
import { helloFrame, eventFrame, replayCompleteFrame, startWsFixture, waitFor } from './r8d-harness.mjs';

const UI = path.join(process.cwd(), 'src', 'remote', 'ui');

test('connect performs a real ticket + upgrade + handshake', async () => {
  const fixture = await startWsFixture();
  try {
    const client = new EventClient({
      sessionId: 's-1',
      baseUrl: fixture.baseUrl,
      credential: 'good-token',
      fetchImpl: fixture.fetchImpl,
    });
    fixture.onConnection = (connection) => {
      connection.send(helloFrame({ sessionId: 's-1' }));
      connection.send(replayCompleteFrame());
    };
    await client.connect();
    await waitFor(() => client.socketState === SOCKET_STATE.LIVE);

    assert.equal(fixture.ticketsIssued, 1, 'exactly one ticket for one connection');
    assert.equal(fixture.connections.length, 1);
    assert.deepEqual(fixture.rejectedUpgrades, [], 'the upgrade must not be rejected');
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('the frozen subprotocol is requested', async () => {
  const fixture = await startWsFixture({ requireSubprotocol: true });
  try {
    const client = new EventClient({
      sessionId: 's-1', baseUrl: fixture.baseUrl, credential: 'good-token', fetchImpl: fixture.fetchImpl,
    });
    fixture.onConnection = (connection) => {
      connection.send(helloFrame({ sessionId: 's-1' }));
      connection.send(replayCompleteFrame());
    };
    await client.connect();
    await waitFor(() => client.socketState === SOCKET_STATE.LIVE);
    assert.equal(fixture.connections.length, 1, 'the subprotocol must be accepted');
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('an open socket is not reported as connected before the replay boundary', async () => {
  const fixture = await startWsFixture();
  try {
    // `hello` only. The boundary is withheld so the socket genuinely sits in the replaying
    // state — sending both in the same tick would make the intermediate state unobservable.
    fixture.onConnection = (connection) => connection.send(helloFrame({ sessionId: 's-1' }));

    const client = new EventClient({
      sessionId: 's-1', baseUrl: fixture.baseUrl, credential: 'good-token', fetchImpl: fixture.fetchImpl,
    });
    await client.connect();
    await waitFor(() => client.socketState === SOCKET_STATE.REPLAYING);

    assert.equal(client.state.uiConnection, 'connecting', 'the UI must not claim connected yet');

    fixture.completeReplay();
    await waitFor(() => client.socketState === SOCKET_STATE.LIVE);
    assert.equal(client.state.uiConnection, 'connected');
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('at most one socket exists for the session', async () => {
  const fixture = await startWsFixture();
  try {
    fixture.onConnection = (connection) => {
      connection.send(helloFrame({ sessionId: 's-1' }));
      connection.send(replayCompleteFrame());
    };
    const client = new EventClient({
      sessionId: 's-1', baseUrl: fixture.baseUrl, credential: 'good-token', fetchImpl: fixture.fetchImpl,
    });
    await client.connect();
    await waitFor(() => client.socketState === SOCKET_STATE.LIVE);
    assert.equal(fixture.connections.length, 1);

    // A second connect supersedes the first rather than leaving two sockets open.
    await client.connect();
    await waitFor(() => client.socketState === SOCKET_STATE.LIVE);
    assert.equal(client.generation, 2, 'the generation must advance');
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('a late frame from a superseded generation is ignored', async () => {
  const fixture = await startWsFixture();
  try {
    const events = [];
    fixture.onConnection = (connection) => {
      connection.send(helloFrame({ sessionId: 's-1' }));
      connection.send(replayCompleteFrame());
    };
    const client = new EventClient({
      sessionId: 's-1', baseUrl: fixture.baseUrl, credential: 'good-token', fetchImpl: fixture.fetchImpl,
      onEvent: (event) => events.push(event),
    });
    await client.connect();
    await waitFor(() => client.socketState === SOCKET_STATE.LIVE);
    const firstConnection = fixture.latest;

    // Supersede with a second connection, then have the OLD socket emit a frame.
    await client.connect();
    await waitFor(() => fixture.connections.length === 2);
    await waitFor(() => client.socketState === SOCKET_STATE.LIVE);

    // Count only applied DOMAIN events. The close of the superseded socket legitimately raises a
    // transport event, so counting everything would conflate "the old socket closed" with "the
    // old socket's payload was applied" — which is the distinction under test.
    const before = events.filter((e) => e.type === 'domain').length;
    const staleSequenceBefore = client.lastAppliedSequence;

    firstConnection.send(eventFrame({ sessionId: 's-1', sequence: 1, event: 'session.status', data: { status: 'failed' } }));
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(events.filter((e) => e.type === 'domain').length, before, 'a superseded socket must not deliver domain events');
    assert.equal(client.lastAppliedSequence, staleSequenceBefore, 'and must not move the watermark');
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('a hello for a different session closes the socket rather than applying anything', async () => {
  const fixture = await startWsFixture();
  try {
    const events = [];
    const client = new EventClient({
      sessionId: 's-A', baseUrl: fixture.baseUrl, credential: 'good-token', fetchImpl: fixture.fetchImpl,
      onEvent: (event) => events.push(event),
    });
    // The server greets us as a different session.
    fixture.onConnection = (connection) => connection.send(helloFrame({ sessionId: 's-B' }));

    await client.connect();
    await waitFor(() => client.socketState === SOCKET_STATE.DISCONNECTED);

    assert.equal(client.closeKind, 'protocol_violation');
    assert.equal(events.some((e) => e.type === 'domain'), false, 'no event may be applied');
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('an unparseable frame is inert and does not kill the socket', async () => {
  const fixture = await startWsFixture();
  try {
    const events = [];
    const client = new EventClient({
      sessionId: 's-1', baseUrl: fixture.baseUrl, credential: 'good-token', fetchImpl: fixture.fetchImpl,
      onEvent: (event) => events.push(event),
    });
    fixture.onConnection = (connection) => {
      connection.send(helloFrame({ sessionId: 's-1' }));
      connection.socket.send('{not json at all');
      connection.send(replayCompleteFrame());
    };
    await client.connect();
    await waitFor(() => client.socketState === SOCKET_STATE.LIVE);
    assert.equal(events.some((e) => e.type === 'unparseable'), true, 'it should be reported');
    assert.equal(client.socketState, SOCKET_STATE.LIVE, 'the socket must survive it');
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('an unknown frame type and an unknown event are both inert', async () => {
  const fixture = await startWsFixture();
  try {
    const events = [];
    const client = new EventClient({
      sessionId: 's-1', baseUrl: fixture.baseUrl, credential: 'good-token', fetchImpl: fixture.fetchImpl,
      onEvent: (event) => events.push(event),
    });
    fixture.onConnection = (connection) => {
      connection.send(helloFrame({ sessionId: 's-1' }));
      connection.send({ type: 'a-frame-from-the-future', payload: {} });
      connection.send(eventFrame({ sessionId: 's-1', sequence: 1, event: 'event.invented.later', data: {} }));
      connection.send(replayCompleteFrame({ sequence: 1 }));
    };
    await client.connect();
    await waitFor(() => client.socketState === SOCKET_STATE.LIVE);

    assert.equal(events.some((e) => e.type === 'unsupported'), true);
    const domain = events.find((e) => e.type === 'domain');
    assert.equal(domain.frame.inert, true, 'an unknown event must be marked inert');
    assert.equal(client.socketState, SOCKET_STATE.LIVE);
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('components never construct a WebSocket', () => {
  // Every socket must be owned by EventClient.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'ws') continue; // the owner
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) continue;
      const text = fs.readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      if (/new\s+WebSocket|new\s+globalThis\.WebSocket/.test(text)) offenders.push(path.relative(UI, full));
    }
  };
  walk(UI);
  assert.deepEqual(offenders, [], `WebSocket constructed outside ws/:\n${offenders.join('\n')}`);
});

test('the UI connection state mapping exposes exactly the six frozen states', () => {
  const produced = new Set();
  for (const socketState of Object.values(SOCKET_STATE)) {
    produced.add(uiConnectionState({ socketState, closeKind: null, resyncRequired: false }));
  }
  // Plus the close-derived states.
  produced.add(uiConnectionState({ socketState: SOCKET_STATE.DISCONNECTED, closeKind: 'auth_failure' }));
  produced.add(uiConnectionState({ socketState: SOCKET_STATE.DISCONNECTED, closeKind: 'network' }));
  produced.add(uiConnectionState({ socketState: SOCKET_STATE.LIVE, resyncRequired: true }));

  const allowed = ['auth_required', 'connecting', 'connected', 'reconnecting', 'resync_required', 'gateway_unavailable'];
  for (const state of produced) {
    assert.ok(allowed.includes(state), `${state} is not one of the six UI connection states`);
  }
  // Transport internals must never leak into the UI vocabulary.
  for (const internal of ['idle', 'ticketing', 'replaying', 'live', 'closing']) {
    assert.equal(allowed.includes(internal), false);
  }
});
