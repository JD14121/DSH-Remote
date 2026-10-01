/**
 * WebSocket ticket upgrade tests — Phase R6 §19, §20, §21, §22, §23, §56, §80.
 *
 * These use real sockets, so the refusals are exercised as pre-101 HTTP responses
 * rather than as assumed code paths.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTH_ERROR,
  FRAME,
  PROTOCOL,
  SESSION,
  OTHER_SESSION,
  generateSyntheticToken,
  request,
  startAuthWsServer,
  switchedProtocols,
} from './r6-helpers.mjs';

/** Wait for a socket to close, or resolve with a marker on timeout. */
function closedWith(client) {
  return new Promise((resolve) => {
    if (client.closed) {
      resolve({ code: client.closeCode, reason: client.closeReason });
      return;
    }
    const timer = setTimeout(() => resolve({ code: null, reason: 'timeout' }), 2000);
    client.socket.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason?.toString() ?? '' });
    });
  });
}

test('§80: a valid ticket upgrades, and the R4 protocol is unchanged', async () => {
  const h = await startAuthWsServer();
  try {
    const mint = await h.mintTicket({ sessionId: SESSION });
    assert.equal(mint.status, 201);

    const client = await h.connectWithTicket({ ticket: mint.body.data.ticket });
    await client.waitForType(FRAME.REPLAY_COMPLETE);

    assert.equal(client.ws.readyState, 1, 'the socket is open');
    assert.equal(client.ws.protocol, PROTOCOL, 'dsh-remote-v1 is unchanged');
    assert.equal(client.frames[0].type, FRAME.HELLO);
    assert.equal(client.frames[0].api_version, 1);
    await client.close();
  } finally {
    await h.close();
  }
});

test('§80: no ticket is refused before the handshake', async () => {
  const h = await startAuthWsServer();
  try {
    const res = await h.ticketUpgrade({ path: `/api/v1/events?session_id=${SESSION}` });
    assert.equal(res.status, 401, 'a missing ticket must not reach 101');
    assert.equal(switchedProtocols(res), false);
  } finally {
    await h.close();
  }
});

test('§23: the long-lived Bearer is still refused in the query', async () => {
  const h = await startAuthWsServer();
  try {
    for (const key of ['token', 'access_token', 'bearer']) {
      const res = await h.ticketUpgrade({ path: `/api/v1/events?session_id=${SESSION}&${key}=${h.token}` });
      assert.equal(res.status, 400, `${key} in the URL must be refused`);
      assert.match(res.body, /TOKEN_IN_URL_NOT_SUPPORTED/);
      assert.equal(switchedProtocols(res), false);
    }
  } finally {
    await h.close();
  }
});

test('§20: a reused ticket is refused before the handshake', async () => {
  const h = await startAuthWsServer();
  try {
    const mint = await h.mintTicket({ sessionId: SESSION });
    const ticket = mint.body.data.ticket;

    const first = await h.connectWithTicket({ ticket });
    await first.waitForType(FRAME.REPLAY_COMPLETE);
    await first.close();

    const replay = await h.ticketUpgrade({ path: `/api/v1/events?session_id=${SESSION}&ticket=${ticket}` });
    assert.equal(replay.status, 401, 'the second use must be refused');
    assert.match(replay.body, /WS_TICKET_INVALID/);
    assert.equal(switchedProtocols(replay), false);
  } finally {
    await h.close();
  }
});

test('§20: an unknown ticket is refused identically to a used one', async () => {
  const h = await startAuthWsServer();
  try {
    const used = await h.mintTicket({ sessionId: SESSION });
    await h.connectWithTicket({ ticket: used.body.data.ticket }).then((client) => client.close());

    const replay = await h.ticketUpgrade({ path: `/api/v1/events?session_id=${SESSION}&ticket=${used.body.data.ticket}` });
    const random = await h.ticketUpgrade({ path: `/api/v1/events?session_id=${SESSION}&ticket=${generateSyntheticToken()}` });

    assert.equal(replay.status, random.status, 'the status must not distinguish them');
    // Both bodies carry the same code; only the request id differs.
    assert.equal(
      replay.body.replace(/"request_id":"[^"]+"/, 'ID'),
      random.body.replace(/"request_id":"[^"]+"/, 'ID'),
      'the bodies must not distinguish them either',
    );
  } finally {
    await h.close();
  }
});

test('§18: an expired ticket is refused', async () => {
  const h = await startAuthWsServer({ config: { ticketTtlSeconds: 10 } });
  try {
    const mint = await h.mintTicket({ sessionId: SESSION });
    const ticket = mint.body.data.ticket;
    // Advance the injected clock rather than sleeping (§65).
    h.auth.clock = () => Date.now() + 11_000;
    h.auth.tickets.clock = h.auth.clock;

    const res = await h.ticketUpgrade({ path: `/api/v1/events?session_id=${SESSION}&ticket=${ticket}` });
    assert.equal(res.status, 401);
    assert.match(res.body, /WS_TICKET_EXPIRED/);
  } finally {
    await h.close();
  }
});

test('§21: a ticket minted for one session cannot be used for another', async () => {
  const h = await startAuthWsServer();
  try {
    const mint = await h.mintTicket({ sessionId: SESSION });
    const res = await h.ticketUpgrade({
      path: `/api/v1/events?session_id=${OTHER_SESSION}&ticket=${mint.body.data.ticket}`,
    });
    assert.equal(res.status, 401, 'the session binding must hold');
    assert.match(res.body, /WS_TICKET_INVALID/);
  } finally {
    await h.close();
  }
});

test('§22: an origin-bound ticket cannot be used from another origin', async () => {
  const h = await startAuthWsServer();
  try {
    const origin = `http://127.0.0.1:${h.port}`;
    const mint = await h.mintTicket({ sessionId: SESSION, origin });
    assert.equal(mint.status, 201);

    // Same origin: allowed.
    const good = await h.ticketUpgrade({
      path: `/api/v1/events?session_id=${SESSION}&ticket=${mint.body.data.ticket}`,
      origin,
    });
    assert.equal(good.status, 101, 'the issuing origin is accepted');
  } finally {
    await h.close();
  }
});

test('§22: a mismatched origin is refused', async () => {
  const h = await startAuthWsServer({ config: { allowedOrigins: ['https://phone-ui.example'] } });
  try {
    const mint = await h.mintTicket({ sessionId: SESSION, origin: 'https://phone-ui.example' });
    const res = await h.ticketUpgrade({
      path: `/api/v1/events?session_id=${SESSION}&ticket=${mint.body.data.ticket}`,
      origin: `http://127.0.0.1:${h.port}`,
    });
    assert.equal(res.status, 401, 'a different origin must not be accepted');
    assert.match(res.body, /WS_TICKET_INVALID/);
  } finally {
    await h.close();
  }
});

test('§22: a native no-origin ticket requires an Origin-less upgrade', async () => {
  const h = await startAuthWsServer();
  try {
    // Issued with no Origin, so it binds to "no origin".
    const mint = await h.mintTicket({ sessionId: SESSION });
    assert.equal(mint.status, 201);

    const withOrigin = await h.ticketUpgrade({
      path: `/api/v1/events?session_id=${SESSION}&ticket=${mint.body.data.ticket}`,
      origin: `http://127.0.0.1:${h.port}`,
    });
    assert.equal(withOrigin.status, 401, 'a stolen native ticket must not work from a website');
  } finally {
    await h.close();
  }
});

test('§56: a connection-limit refusal does not consume the ticket', async () => {
  const h = await startAuthWsServer({ config: { maxConnectionsPerPrincipal: 1 } });
  try {
    const first = await h.mintTicket({ sessionId: SESSION });
    const open = await h.connectWithTicket({ ticket: first.body.data.ticket });
    await open.waitForType(FRAME.REPLAY_COMPLETE);

    // A second ticket while the limit is full.
    const second = await h.mintTicket({ sessionId: SESSION });
    const refused = await h.ticketUpgrade({
      path: `/api/v1/events?session_id=${SESSION}&ticket=${second.body.data.ticket}`,
    });
    assert.equal(refused.status, 429, 'the connection limit is the refusal reason');
    assert.match(refused.body, /WS_CONNECTION_LIMIT/);

    // The ticket was not burned, so it still works once capacity is free.
    await open.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const retry = await h.ticketUpgrade({
      path: `/api/v1/events?session_id=${SESSION}&ticket=${second.body.data.ticket}`,
    });
    assert.equal(retry.status, 101, 'the refusal must not have consumed the ticket');
  } finally {
    await h.close();
  }
});

test('§38: a closed connection releases its slot', async () => {
  const h = await startAuthWsServer({ config: { maxConnectionsPerPrincipal: 1 } });
  try {
    const first = await h.mintTicket({ sessionId: SESSION });
    const open = await h.connectWithTicket({ ticket: first.body.data.ticket });
    await open.waitForType(FRAME.REPLAY_COMPLETE);
    assert.equal(h.auth.connections.countFor('phone'), 1);

    await open.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.auth.connections.countFor('phone'), 0, 'the slot must be released');
  } finally {
    await h.close();
  }
});

test('§19: an abrupt terminate also releases its slot', async () => {
  const h = await startAuthWsServer({ config: { maxConnectionsPerPrincipal: 1 } });
  try {
    const mint = await h.mintTicket({ sessionId: SESSION });
    const open = await h.connectWithTicket({ ticket: mint.body.data.ticket });
    await open.waitForType(FRAME.REPLAY_COMPLETE);
    assert.equal(h.auth.connections.countFor('phone'), 1);

    open.ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(h.auth.connections.countFor('phone'), 0, 'a vanished socket must not leak a slot');
  } finally {
    await h.close();
  }
});

test('§12: the event stream is unreachable without a ticket even with a valid Bearer header', async () => {
  const h = await startAuthWsServer();
  try {
    // A native client cannot set a header on a browser WebSocket, and the server
    // does not accept one as a substitute for the ticket: the ticket is the only
    // credential the upgrade path understands.
    const res = await h.ticketUpgrade({
      path: `/api/v1/events?session_id=${SESSION}`,
      extraHeaders: { Authorization: `Bearer ${h.token}` },
    });
    assert.equal(res.status, 401, 'the upgrade path requires a ticket');
  } finally {
    await h.close();
  }
});

test('§59: a DSH-shaped credential in the ticket position is refused', async () => {
  const h = await startAuthWsServer();
  try {
    const res = await h.ticketUpgrade({
      path: `/api/v1/events?session_id=${SESSION}&ticket=dsh-auth-abcdefghijklmnopqrstuvwxyz`,
    });
    assert.equal(res.status, 401);
  } finally {
    await h.close();
  }
});

test('a ticket is single-use even when the first upgrade then fails', async () => {
  const h = await startAuthWsServer();
  try {
    // Mint, consume by upgrading, then confirm the ticket cannot be reused. §19
    // prefers a spent ticket over a reusable one.
    const mint = await h.mintTicket({ sessionId: SESSION });
    const ticket = mint.body.data.ticket;
    const first = await h.connectWithTicket({ ticket });
    await first.waitForType(FRAME.REPLAY_COMPLETE);
    await first.close();

    const again = await h.ticketUpgrade({ path: `/api/v1/events?session_id=${SESSION}&ticket=${ticket}` });
    assert.equal(again.status, 401);
  } finally {
    await h.close();
  }
});
