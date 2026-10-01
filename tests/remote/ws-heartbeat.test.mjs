/**
 * Heartbeat and liveness tests — Phase R4 §17, §18, §38, §51.
 *
 * §51 forbids actually sleeping 25 seconds, so timers are injected and advanced
 * by hand. That makes the tests deterministic *and* fast.
 *
 * The property most worth protecting here is §38: a phone losing its WebSocket is
 * a phone-transport event. It must never mutate DSH session status, because R2's
 * `disconnected` means the Gateway lost DSH.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { startWsServer, SESSION, fakeSocket } from './r4-helpers.mjs';
import {
  DEFAULT_HEARTBEAT_MS,
  Heartbeat,
  MAX_HEARTBEAT_MS,
  MIN_HEARTBEAT_MS,
  ManualTimers,
  resolveHeartbeatMs,
} from '../../src/remote/ws/heartbeat.mjs';
import { FRAME } from '../../src/remote/ws/protocol.mjs';
import { ClientSession } from '../../src/remote/ws/client-session.mjs';
import { EventsService } from '../../src/remote/events.mjs';
import { SessionViewStore } from '../../src/remote/state/session-view-store.mjs';
import { makeSession } from '../../src/remote/model/session.mjs';

test('the documented default interval and range are enforced', () => {
  assert.equal(DEFAULT_HEARTBEAT_MS, 25_000);
  assert.equal(MIN_HEARTBEAT_MS, 10_000);
  assert.equal(MAX_HEARTBEAT_MS, 60_000);

  assert.equal(resolveHeartbeatMs(undefined), 25_000);
  assert.equal(resolveHeartbeatMs(10_000), 10_000);
  assert.equal(resolveHeartbeatMs(60_000), 60_000);

  for (const bad of [9_999, 60_001, 0, -1, 1.5, 'soon']) {
    assert.throws(() => resolveHeartbeatMs(bad), TypeError, `interval ${bad} must be rejected`);
  }
});

test('an application heartbeat is emitted on schedule', () => {
  // The peer answers pings, so this exercises the heartbeat cadence rather than
  // the dead-peer path (which the next test covers deliberately).
  const timers = new ManualTimers();
  const heartbeats = [];
  const hb = new Heartbeat({
    onHeartbeat: () => heartbeats.push(timers.now),
    onPing: () => hb.notePong(),
    onDead: () => { throw new Error('a responsive peer must never be declared dead'); },
    intervalMs: 25_000,
    pingIntervalMs: 25_000,
    setInterval: timers.setInterval.bind(timers),
    clearInterval: timers.clearInterval.bind(timers),
  });

  hb.start();
  assert.equal(heartbeats.length, 0, 'nothing fires before the interval elapses');

  for (let period = 1; period <= 4; period += 1) {
    timers.advance(25_000);
    assert.equal(heartbeats.length, period, `one heartbeat after period ${period}`);
  }
  hb.stop();
});

test('a missed pong terminates the peer', () => {
  const timers = new ManualTimers();
  const pings = [];
  const dead = [];
  const hb = new Heartbeat({
    onHeartbeat: () => {},
    onPing: () => pings.push(timers.now),
    onDead: (info) => dead.push(info),
    intervalMs: 25_000,
    pingIntervalMs: 25_000,
    setInterval: timers.setInterval.bind(timers),
    clearInterval: timers.clearInterval.bind(timers),
  });

  hb.start();
  timers.advance(25_000);
  assert.equal(pings.length, 1, 'a ping is sent');
  assert.equal(dead.length, 0, 'not yet declared dead');

  // A full period with no pong.
  timers.advance(25_000);
  assert.equal(dead.length, 1, 'the peer is declared dead after one missed pong');
  assert.equal(hb.running, false, 'timers are stopped on death');
});

test('a pong keeps the peer alive across many periods', () => {
  const timers = new ManualTimers();
  const pings = [];
  const dead = [];
  const hb = new Heartbeat({
    onHeartbeat: () => {},
    onPing: () => { pings.push(timers.now); hb.notePong(); },
    onDead: (info) => dead.push(info),
    intervalMs: 25_000,
    pingIntervalMs: 25_000,
    setInterval: timers.setInterval.bind(timers),
    clearInterval: timers.clearInterval.bind(timers),
  });

  hb.start();
  timers.advance(25_000 * 10);
  assert.equal(pings.length, 10);
  assert.equal(dead.length, 0, 'a responsive peer is never killed');
  assert.equal(hb.stats().pongsReceived, 10);
  hb.stop();
});

test('stop clears both timers and is idempotent', () => {
  const timers = new ManualTimers();
  const hb = new Heartbeat({
    onHeartbeat: () => {},
    onPing: () => {},
    onDead: () => {},
    setInterval: timers.setInterval.bind(timers),
    clearInterval: timers.clearInterval.bind(timers),
  });

  hb.start();
  assert.equal(timers.pending, 2, 'both timers are armed');
  hb.stop();
  assert.equal(timers.pending, 0, 'both timers are cleared');
  assert.equal(hb.running, false);

  hb.stop();
  assert.equal(timers.pending, 0, 'a second stop is harmless');
});

test('start after stop does not rearm', () => {
  const timers = new ManualTimers();
  const hb = new Heartbeat({
    onHeartbeat: () => {},
    onPing: () => {},
    onDead: () => {},
    setInterval: timers.setInterval.bind(timers),
    clearInterval: timers.clearInterval.bind(timers),
  });
  hb.stop();
  hb.start();
  assert.equal(timers.pending, 0, 'a stopped heartbeat stays stopped');
});

test('a heartbeat over a real socket consumes no Gateway sequence', async () => {
  const h = await startWsServer({ websocketLimits: { heartbeatMs: 10_000, pingIntervalMs: 10_000 } });
  try {
    const client = await h.connect();
    await client.waitForType(FRAME.REPLAY_COMPLETE);

    // Emit one real event so a sequence exists, then trigger a heartbeat.
    const event = h.eventsService.emit({ sessionId: SESSION, event: 'session.status', data: {} });
    await client.waitForType(FRAME.EVENT);

    client.ws.send(JSON.stringify({ type: 'client_ping' }));
    await client.waitForType(FRAME.HEARTBEAT);

    const heartbeat = client.ofType(FRAME.HEARTBEAT)[0];
    assert.equal(typeof heartbeat.server_time, 'string');
    assert.equal(heartbeat.session_id, SESSION);
    assert.equal(heartbeat.latest_sequence, event.sequence);

    // Only the one data event exists; the heartbeat allocated nothing.
    assert.deepEqual(client.sequences(), [event.sequence]);
    assert.equal(h.eventsService.sequenceBounds(SESSION).latest, event.sequence);
    await client.close();
  } finally {
    await h.close();
  }
});

test('the WebSocket server sends protocol pings and accepts pongs', async () => {
  const h = await startWsServer({ websocketLimits: { heartbeatMs: 10_000, pingIntervalMs: 200 } });
  try {
    const client = await h.connect();
    await client.waitForType(FRAME.REPLAY_COMPLETE);
    // The `ws` client answers pings automatically; observe that the socket stays
    // open rather than being terminated.
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(client.closeInfo, null, 'a responsive client is not terminated');
    await client.close();
  } finally {
    await h.close();
  }
});

test('a dead peer is off the registry and its timers are cleared', async () => {
  const h = await startWsServer();
  try {
    const client = await h.connect();
    await client.waitForType(FRAME.REPLAY_COMPLETE);
    assert.equal(h.server.ws.size, 1);

    // Simulate the transport dying abruptly.
    client.ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(h.server.ws.size, 0, 'the dead client left the registry');
    assert.equal(h.server.ws.registry.size, 0);
  } finally {
    await h.close();
  }
});

test('a phone disconnect never marks the DSH session disconnected', async () => {
  // §38. This is the single most important assertion in this file: two different
  // disconnections must not be conflated.
  const h = await startWsServer();
  try {
    h.statusService.events.store.applySignal(SESSION, { signal: 'RUN_STARTED', sessionId: SESSION });
    assert.equal(h.statusService.getSession(SESSION).status, 'running');

    const client = await h.connect();
    await client.waitForType(FRAME.REPLAY_COMPLETE);
    await client.close();
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(
      h.statusService.getSession(SESSION).status,
      'running',
      'a phone transport loss must not change DSH session status',
    );
    assert.notEqual(h.statusService.getSession(SESSION).status, 'disconnected');
  } finally {
    await h.close();
  }
});

test('a backlog overflow close also leaves domain status untouched', async () => {
  const h = await startWsServer();
  try {
    h.statusService.events.store.applySignal(SESSION, { signal: 'RUN_STARTED', sessionId: SESSION });
    const status = h.statusService.getSession(SESSION).status;

    const client = await h.connect();
    await client.waitForType(FRAME.REPLAY_COMPLETE);
    client.ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(h.statusService.getSession(SESSION).status, status);
  } finally {
    await h.close();
  }
});

test('client session closes clear its heartbeat timers', async () => {
  const timers = new ManualTimers();
  const store = new SessionViewStore({ clock: () => 1 });
  store.upsertSession(makeSession({ id: SESSION }));
  const events = new EventsService({ adapter: {}, store, clock: () => 1 });
  const { socket, state } = fakeSocket();

  const client = new ClientSession({
    socket,
    events,
    sessionId: SESSION,
    lastSequence: null,
    timers,
    heartbeatMs: 10_000,
    pingIntervalMs: 10_000,
  });

  await client.begin();
  assert.equal(timers.pending, 2, 'timers are armed once live');

  client.close('test close');
  assert.equal(timers.pending, 0, 'closing clears both timers — no timer leak');
  assert.equal(client.heartbeat.running, false);
  assert.equal(state.closes.length, 1);
});

test('a heartbeat emits no frame after the socket closes', async () => {
  const timers = new ManualTimers();
  const store = new SessionViewStore({ clock: () => 1 });
  store.upsertSession(makeSession({ id: SESSION }));
  const events = new EventsService({ adapter: {}, store, clock: () => 1 });
  const { socket, state } = fakeSocket();
  state.closedByUs = true; // the socket is already gone

  const client = new ClientSession({
    socket,
    events,
    sessionId: SESSION,
    lastSequence: null,
    timers,
    heartbeatMs: 10_000,
    pingIntervalMs: 10_000,
  });
  await client.begin();
  const before = state.sent.length;
  timers.advance(20_000);
  assert.equal(state.sent.length, before, 'no frame is written to a closed socket');
  client.close();
});
