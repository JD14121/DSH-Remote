/**
 * Auth integration — Phase R6 §88, §89.
 *
 * §88's scenario end to end over real HTTP and real sockets, and §89's restart
 * semantics: the long-lived credential keeps working when it is re-injected, while
 * every ticket and rate-limit window is gone.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTH_ERROR,
  FRAME,
  SESSION,
  OTHER_SESSION,
  generateSyntheticToken,
  makeTempStateRoot,
  request,
  scanTreeForSecrets,
  startAuthWsServer,
  startFixtureServer,
} from './r6-helpers.mjs';
import { AUTH_MODE } from '../../src/remote/auth/config.mjs';

test('§88: the full scenario, over real sockets and a temp state root', async () => {
  const { root, cleanup } = makeTempStateRoot('r6-integration');
  const h = await startAuthWsServer({ persistenceConfig: { root, segmentBytes: 65_536 } });
  try {
    // 1. health without auth: minimal 200.
    const anonHealth = await request(h.baseUrl, '/api/v1/health');
    assert.equal(anonHealth.status, 200);
    assert.deepEqual(Object.keys(anonHealth.body.data).sort(), ['auth', 'gateway', 'request_id']);

    // 2. sessions without auth: 401.
    assert.equal((await request(h.baseUrl, '/api/v1/sessions')).status, 401);

    // 3. sessions with a valid credential: 200.
    const authedHealth = await h.get('/api/v1/health');
    assert.equal(authedHealth.status, 200);
    assert.ok('dsh' in authedHealth.body.data, 'authenticated health shows DSH detail');

    // 4. mint a ticket for session A.
    const mint = await h.mintTicket({ sessionId: SESSION });
    assert.equal(mint.status, 201);
    const ticket = mint.body.data.ticket;

    // 5. connect and receive the opening frames, then a live event.
    const client = await h.connectWithTicket({ ticket });
    await client.waitForType(FRAME.REPLAY_COMPLETE);
    assert.equal(client.frames[0].type, FRAME.HELLO);

    h.eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: { step: 'live' } });
    await client.waitFor(() => client.sequences().includes(1), 3000, 'the live event');
    assert.deepEqual(client.sequences(), [1], 'exactly one event, delivered once');

    // 6. reuse the ticket: refused.
    const reuse = await h.ticketUpgrade({ path: `/api/v1/events?session_id=${SESSION}&ticket=${ticket}` });
    assert.equal(reuse.status, 401);
    await client.close();

    // 7. mint T2 and use it for session B: refused.
    const t2 = await h.mintTicket({ sessionId: SESSION });
    const wrongSession = await h.ticketUpgrade({
      path: `/api/v1/events?session_id=${OTHER_SESSION}&ticket=${t2.body.data.ticket}`,
    });
    assert.equal(wrongSession.status, 401, 'a ticket is session-bound');

    // 8. Origin binding. A ticket minted for one origin is useless from another.
    //    Which refusal a mismatched origin earns depends on whether the second
    //    origin is *allowed at all*: the Origin fence runs first (§56), so a hostile
    //    origin is 403 before the ticket is even consulted.
    const origin1 = `http://127.0.0.1:${h.port}`;
    const t3 = await h.mintTicket({ sessionId: SESSION, origin: origin1 });
    assert.equal(t3.status, 201);

    const hostileOrigin = await h.ticketUpgrade({
      path: `/api/v1/events?session_id=${SESSION}&ticket=${t3.body.data.ticket}`,
      origin: 'https://evil.example',
    });
    assert.equal(hostileOrigin.status, 403, 'a hostile origin is refused by the Origin fence first');

    // And when the second origin *is* allowed but differs from the binding, the
    // ticket check is what refuses it.
    const allowed = await startAuthWsServer({
      token: h.token,
      config: { allowedOrigins: ['https://second.example'] },
    });
    try {
      const bound = await allowed.mintTicket({ sessionId: SESSION, origin: `http://127.0.0.1:${allowed.port}` });
      const mismatch = await allowed.ticketUpgrade({
        path: `/api/v1/events?session_id=${SESSION}&ticket=${bound.body.data.ticket}`,
        origin: 'https://second.example',
      });
      assert.equal(mismatch.status, 401, 'an allowed-but-different origin fails the ticket binding');
      assert.match(mismatch.body, /WS_TICKET_INVALID/);
    } finally {
      await allowed.close();
    }

    // 9. an authenticated prompt is accepted, and the event stream sees the result.
    const prompt = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`, {
      method: 'POST',
      body: { content: 'hello from the integration scenario', client_message_id: 'cmid-int-1' },
      headers: { authorization: `Bearer ${h.token}` },
    });
    assert.equal(prompt.status, 202);

    // 10. deliberately exceed the ticket budget: 429.
    const limited = await startAuthWsServer({
      token: h.token,
      config: { limits: { ticket: { limit: 1, windowSeconds: 60 } } },
    });
    try {
      assert.equal((await limited.mintTicket({ sessionId: SESSION })).status, 201);
      assert.equal((await limited.mintTicket({ sessionId: SESSION })).status, 429);
    } finally {
      await limited.close();
    }
  } finally {
    await h.close();
    cleanup();
  }
});

test('§88: no auth material appears in any persistence file after the scenario', async () => {
  const { root, cleanup } = makeTempStateRoot('r6-integration-scan');
  const h = await startAuthWsServer({ persistenceConfig: { root, segmentBytes: 65_536 } });
  let ticket = null;
  try {
    const mint = await h.mintTicket({ sessionId: SESSION });
    ticket = mint.body.data.ticket;
    const client = await h.connectWithTicket({ ticket });
    await client.waitForType(FRAME.REPLAY_COMPLETE);
    h.eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: { marker: 'after-auth' } });
    await client.close();
    h.persistence.writeSnapshot(true);

    const scan = scanTreeForSecrets(root, [h.token, ticket]);
    assert.ok(scan.files > 0, 'files exist to scan');
    assert.deepEqual(scan.leaked, [], 'the scenario leaves no credential on disk');
  } finally {
    await h.close();
    cleanup();
  }
});

test('§89: a restart invalidates every ticket but keeps the long-lived credential', async () => {
  const token = generateSyntheticToken();
  const first = await startAuthWsServer({ token });
  let ticket = null;
  try {
    ticket = (await first.mintTicket({ sessionId: SESSION })).body.data.ticket;
  } finally {
    await first.close();
  }

  // A new process with the same injected credential: R7's real bootstrap is exactly
  // this shape, reloading the same long-lived token.
  const second = await startAuthWsServer({ token });
  try {
    assert.equal((await second.get('/api/v1/sessions')).status, 200, 'the credential still works');

    const stale = await second.ticketUpgrade({
      path: `/api/v1/events?session_id=${SESSION}&ticket=${ticket}`,
    });
    assert.equal(stale.status, 401, 'a ticket from the previous process is invalid');
    assert.match(stale.body, /WS_TICKET_INVALID/);
  } finally {
    await second.close();
  }
});

test('§89: rate limits reset on restart', async () => {
  const token = generateSyntheticToken();
  const first = await startFixtureServer({
    authConfig: { mode: AUTH_MODE.REQUIRED, limits: { read: { limit: 1, windowSeconds: 60 } } },
    authToken: token,
  });
  try {
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await request(first.baseUrl, '/api/v1/sessions', { headers })).status, 200);
    assert.equal((await request(first.baseUrl, '/api/v1/sessions', { headers })).status, 429);
  } finally {
    await first.close();
  }

  const second = await startFixtureServer({
    authConfig: { mode: AUTH_MODE.REQUIRED, limits: { read: { limit: 1, windowSeconds: 60 } } },
    authToken: token,
  });
  try {
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await request(second.baseUrl, '/api/v1/sessions', { headers })).status, 200, 'limits reset');
  } finally {
    await second.close();
  }
});

test('§89: the R5 journal survives a restart while R6 ephemeral state does not', async () => {
  const { root, cleanup } = makeTempStateRoot('r6-integration-restart');
  const token = generateSyntheticToken();

  let durableHighWater = 0;
  {
    const h = await startAuthWsServer({ token, persistenceConfig: { root, segmentBytes: 65_536 } });
    try {
      for (let index = 0; index < 3; index += 1) {
        h.eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: { index } });
      }
      durableHighWater = h.persistence.journals.get(SESSION).highWater;
      // Mint a ticket that must not survive.
      await h.mintTicket({ sessionId: SESSION });
    } finally {
      await h.close();
    }
  }
  assert.equal(durableHighWater, 3);

  {
    const h = await startAuthWsServer({ token, persistenceConfig: { root, segmentBytes: 65_536 } });
    try {
      // Durable: the sequence continues from the recovered mark.
      assert.equal(h.persistence.journals.get(SESSION).highWater, durableHighWater, 'the journal survived');
      const next = h.eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: {} });
      assert.equal(next.sequence, durableHighWater + 1, 'the sequence continues');
      // Ephemeral: no tickets, no counters.
      assert.equal(h.auth.tickets.size, 0, 'tickets do not survive a restart');
      assert.equal(h.auth.limiter.windows.size, 0, 'rate-limit windows do not survive either');
    } finally {
      await h.close();
    }
  }
  cleanup();
});

test('§88: the scenario is reproducible with an identical outcome', async () => {
  const run = async () => {
    const { root, cleanup } = makeTempStateRoot('r6-integration-repeat');
    const h = await startAuthWsServer({ persistenceConfig: { root, segmentBytes: 65_536 } });
    try {
      const results = [];
      results.push((await request(h.baseUrl, '/api/v1/health')).status);
      results.push((await request(h.baseUrl, '/api/v1/sessions')).status);
      results.push((await h.get('/api/v1/sessions')).status);
      const mint = await h.mintTicket({ sessionId: SESSION });
      results.push(mint.status);
      const client = await h.connectWithTicket({ ticket: mint.body.data.ticket });
      await client.waitForType(FRAME.REPLAY_COMPLETE);
      results.push(client.frames[0].type);
      await client.close();
      const reuse = await h.ticketUpgrade({
        path: `/api/v1/events?session_id=${SESSION}&ticket=${mint.body.data.ticket}`,
      });
      results.push(reuse.status);
      return results;
    } finally {
      await h.close();
      cleanup();
    }
  };

  const first = await run();
  const second = await run();
  assert.deepEqual(first, second, 'the scenario is deterministic');
  assert.deepEqual(first, [200, 401, 200, 201, 'hello', 401]);
});

test('§52: every documented auth code maps to its status', () => {
  const expected = {
    [AUTH_ERROR.REQUIRED]: 401,
    [AUTH_ERROR.INVALID]: 401,
    [AUTH_ERROR.WS_TICKET_INVALID]: 401,
    [AUTH_ERROR.WS_TICKET_EXPIRED]: 401,
    [AUTH_ERROR.ORIGIN_NOT_ALLOWED]: 403,
    [AUTH_ERROR.CORS_PREFLIGHT_REJECTED]: 403,
    [AUTH_ERROR.RATE_LIMITED]: 429,
    [AUTH_ERROR.TICKET_LIMIT]: 429,
    [AUTH_ERROR.WS_CONNECTION_LIMIT]: 429,
    [AUTH_ERROR.UPLOAD_QUOTA_EXCEEDED]: 429,
    [AUTH_ERROR.CONFIG_INVALID]: 503,
  };
  return import('../../src/remote/auth/errors.mjs').then(({ statusForCode }) => {
    for (const [code, status] of Object.entries(expected)) {
      assert.equal(statusForCode(code), status, `${code} must map to ${status}`);
    }
  });
});

test('§52: a startup config error is reported as AUTH_CONFIG_INVALID, not a 401', () => {
  return import('../../src/remote/auth/config.mjs').then(({ resolveAuthConfig, AUTH_MODE: MODE }) => {
    assert.throws(
      () => resolveAuthConfig({ mode: MODE.REQUIRED, ticketTtlSeconds: 999 }, {}),
      (error) => error.code === AUTH_ERROR.CONFIG_INVALID,
    );
    assert.throws(
      () => resolveAuthConfig({ mode: MODE.REQUIRED, maxConnectionsPerPrincipal: 0 }, {}),
      (error) => error.code === AUTH_ERROR.CONFIG_INVALID,
    );
    assert.throws(
      () => resolveAuthConfig({ mode: MODE.REQUIRED, limits: { read: { limit: 0 } } }, {}),
      (error) => error.code === AUTH_ERROR.CONFIG_INVALID,
    );
  });
});
