/**
 * Connection-limit tests — Phase R6 §38, §39, §84.
 *
 * §38's requirement is that the accounting is leak-free: a slot is taken on a
 * successful upgrade and returned on close, terminate, or a failed handshake.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTH_ERROR,
  ConnectionLimiter,
  DEFAULT_MAX_CONNECTIONS_PER_PRINCIPAL,
  FRAME,
  SESSION,
  generateSyntheticToken,
  startAuthWsServer,
} from './r6-helpers.mjs';

/** Give the close handler a moment to run. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 60); });

test('§38: the default per-principal limit is 4', () => {
  assert.equal(DEFAULT_MAX_CONNECTIONS_PER_PRINCIPAL, 4);
  const limiter = new ConnectionLimiter();
  assert.equal(limiter.maxPerPrincipal, 4);
  for (const bad of [0, -1, 1.5]) {
    assert.throws(
      () => new ConnectionLimiter({ maxPerPrincipal: bad }),
      (error) => error.code === AUTH_ERROR.CONFIG_INVALID,
    );
  }
});

test('§38: reservations are counted immediately and released correctly', () => {
  const limiter = new ConnectionLimiter({ maxPerPrincipal: 2 });
  assert.equal(limiter.reserve('phone').ok, true);
  assert.equal(limiter.reserve('phone').ok, true);
  assert.equal(limiter.reserve('phone').ok, false, 'the third is refused');
  assert.equal(limiter.countFor('phone'), 2);

  assert.equal(limiter.release('phone'), true);
  assert.equal(limiter.countFor('phone'), 1);
  assert.equal(limiter.reserve('phone').ok, true, 'capacity is available again');
});

test('§38: a release never drives the count below zero', () => {
  const limiter = new ConnectionLimiter({ maxPerPrincipal: 1 });
  limiter.reserve('phone');
  assert.equal(limiter.release('phone'), true);
  assert.equal(limiter.release('phone'), false, 'a double release is a no-op');
  assert.equal(limiter.countFor('phone'), 0, 'the count never goes negative');
});

test('§84: 1..N connections succeed and N+1 is refused pre-101', async () => {
  const h = await startAuthWsServer({ config: { maxConnectionsPerPrincipal: 2 } });
  const open = [];
  try {
    for (let index = 0; index < 2; index += 1) {
      const mint = await h.mintTicket({ sessionId: SESSION });
      const client = await h.connectWithTicket({ ticket: mint.body.data.ticket });
      await client.waitForType(FRAME.REPLAY_COMPLETE);
      open.push(client);
    }
    assert.equal(h.auth.connections.countFor('phone'), 2);

    const third = await h.mintTicket({ sessionId: SESSION });
    const refused = await h.ticketUpgrade({
      path: `/api/v1/events?session_id=${SESSION}&ticket=${third.body.data.ticket}`,
    });
    assert.equal(refused.status, 429, 'the third must be refused');
    assert.match(refused.body, /WS_CONNECTION_LIMIT/);
    assert.notEqual(refused.status, 101, 'never a 101 followed by a close');
  } finally {
    for (const client of open) await client.close();
    await h.close();
  }
});

test('§84: closing one connection frees exactly one slot', async () => {
  const h = await startAuthWsServer({ config: { maxConnectionsPerPrincipal: 2 } });
  try {
    const clients = [];
    for (let index = 0; index < 2; index += 1) {
      const mint = await h.mintTicket({ sessionId: SESSION });
      const client = await h.connectWithTicket({ ticket: mint.body.data.ticket });
      await client.waitForType(FRAME.REPLAY_COMPLETE);
      clients.push(client);
    }

    await clients[0].close();
    await settle();
    assert.equal(h.auth.connections.countFor('phone'), 1);

    // A new one now fits.
    const mint = await h.mintTicket({ sessionId: SESSION });
    const replacement = await h.connectWithTicket({ ticket: mint.body.data.ticket });
    await replacement.waitForType(FRAME.REPLAY_COMPLETE);
    assert.equal(h.auth.connections.countFor('phone'), 2);

    for (const client of [clients[1], replacement]) await client.close();
  } finally {
    await h.close();
  }
});

test('§84: an abrupt terminate releases the slot', async () => {
  const h = await startAuthWsServer({ config: { maxConnectionsPerPrincipal: 1 } });
  try {
    const mint = await h.mintTicket({ sessionId: SESSION });
    const client = await h.connectWithTicket({ ticket: mint.body.data.ticket });
    await client.waitForType(FRAME.REPLAY_COMPLETE);
    assert.equal(h.auth.connections.countFor('phone'), 1);

    client.ws.terminate();
    await settle();
    assert.equal(h.auth.connections.countFor('phone'), 0, 'a killed socket must not leak');
  } finally {
    await h.close();
  }
});

test('§84: a refused upgrade releases its reservation', async () => {
  const h = await startAuthWsServer({ config: { maxConnectionsPerPrincipal: 4 } });
  try {
    // An invalid ticket must never leave a reservation behind.
    for (let index = 0; index < 5; index += 1) {
      const res = await h.ticketUpgrade({
        path: `/api/v1/events?session_id=${SESSION}&ticket=${generateSyntheticToken()}`,
      });
      assert.equal(res.status, 401);
    }
    assert.equal(h.auth.connections.countFor('phone'), 0, 'a failed handshake must not hold a slot');
  } finally {
    await h.close();
  }
});

test('§39/§84: minting a ticket does not count as a connection', async () => {
  const h = await startAuthWsServer({ config: { maxConnectionsPerPrincipal: 1 } });
  try {
    for (let index = 0; index < 6; index += 1) {
      assert.equal((await h.mintTicket({ sessionId: SESSION })).status, 201);
    }
    assert.equal(h.auth.connections.countFor('phone'), 0, 'unused tickets consume no connection');
  } finally {
    await h.close();
  }
});

test('§84: a ticket race does not double-count', async () => {
  const h = await startAuthWsServer({ config: { maxConnectionsPerPrincipal: 4 } });
  try {
    const mint = await h.mintTicket({ sessionId: SESSION });
    const path = `/api/v1/events?session_id=${SESSION}&ticket=${mint.body.data.ticket}`;
    await Promise.all([h.ticketUpgrade({ path }), h.ticketUpgrade({ path })]);
    assert.equal(h.auth.connections.countFor('phone'), 1, 'exactly one winner, one slot');
  } finally {
    await h.close();
  }
});

test('§38: many sessions share one principal budget', async () => {
  const h = await startAuthWsServer({ config: { maxConnectionsPerPrincipal: 1 } });
  try {
    const mint = await h.mintTicket({ sessionId: SESSION });
    const client = await h.connectWithTicket({ ticket: mint.body.data.ticket });
    await client.waitForType(FRAME.REPLAY_COMPLETE);

    // The limit is per principal, not per session, so a second session does not help.
    const other = await h.mintTicket({ sessionId: 'session-00000000-0000-0000-0000-000000000002' });
    const refused = await h.ticketUpgrade({
      path: `/api/v1/events?session_id=session-00000000-0000-0000-0000-000000000002&ticket=${other.body.data.ticket}`,
    });
    assert.equal(refused.status, 429, 'the principal budget spans sessions');

    await client.close();
  } finally {
    await h.close();
  }
});

test('§38: shutdown clears every reservation', () => {
  const limiter = new ConnectionLimiter({ maxPerPrincipal: 5 });
  for (const principal of ['a', 'b', 'c']) limiter.reserve(principal);
  assert.equal(limiter.clear(), 3);
  assert.equal(limiter.stats().active, 0);
});

test('§38: stats never expose a credential', () => {
  const limiter = new ConnectionLimiter();
  limiter.reserve('phone');
  const stats = limiter.stats();
  assert.deepEqual(
    Object.keys(stats).sort(),
    ['active', 'counters', 'max_per_principal', 'principals'],
  );
  assert.equal(JSON.stringify(stats).includes('Bearer'), false);
});
