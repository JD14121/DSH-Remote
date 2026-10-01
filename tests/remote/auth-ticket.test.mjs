/**
 * Ticket store and mint endpoint tests — Phase R6 §14, §15, §16, §17, §18, §20, §21,
 * §22, §24, §25, §26, §39, §64, §79.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import {
  AUTH_ERROR,
  DEFAULT_MAX_OUTSTANDING_TICKETS,
  DEFAULT_TICKET_TTL_SECONDS,
  SESSION,
  OTHER_SESSION,
  TICKET_BYTES,
  TicketStore,
  generateTicket,
  generateSyntheticToken,
  makeTempStateRoot,
  request,
  scanTreeForSecrets,
  startAuthServer,
  ticketDigest,
} from './r6-helpers.mjs';

/** A manual clock, so TTL tests never sleep (§65). */
function manualClock(start = 1_789_800_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

test('§16: a ticket is 32 bytes of base64url with real entropy', () => {
  const seen = new Set();
  for (let index = 0; index < 50; index += 1) {
    const ticket = generateTicket();
    assert.equal(ticket.length, 43);
    assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(ticket, 'base64url').length, TICKET_BYTES);
    seen.add(ticket);
  }
  assert.equal(seen.size, 50, 'no repeats across 50 draws');
});

test('§17: the store keeps only a digest, never the plaintext', () => {
  const store = new TicketStore();
  const { ticket } = store.mint({ sessionId: SESSION, principalId: 'phone', origin: null });
  assert.equal(store.records.size, 1, 'one record');

  const [digest, record] = [...store.records.entries()][0];
  assert.equal(digest, ticketDigest(ticket), 'the key is the digest');
  assert.equal(record.digest, ticketDigest(ticket));
  assert.equal(
    JSON.stringify(record).includes(ticket),
    false,
    'the plaintext must not be recoverable from the record',
  );
  // And the record carries the documented binding fields.
  assert.deepEqual(
    Object.keys(record).sort(),
    ['consumed', 'digest', 'expiresAt', 'issuedAt', 'originBinding', 'principalId', 'sessionId'],
  );
});

test('§18: the default TTL is 30 seconds and is configurable within range', () => {
  assert.equal(DEFAULT_TICKET_TTL_SECONDS, 30);
  const store = new TicketStore();
  const { expiresInSeconds } = store.mint({ sessionId: SESSION, principalId: 'phone', origin: null });
  assert.equal(expiresInSeconds, 30);

  for (const ttl of [10, 30, 120]) {
    assert.doesNotThrow(() => new TicketStore({ ttlSeconds: ttl }), `${ttl} must be accepted`);
  }
  for (const ttl of [0, 9, 121, 1.5, -1]) {
    assert.throws(
      () => new TicketStore({ ttlSeconds: ttl }),
      (error) => error.code === AUTH_ERROR.CONFIG_INVALID,
      `${ttl} must be refused`,
    );
  }
});

test('§18: an expired ticket fails with the expiry code, and is not renewable', () => {
  const clock = manualClock();
  const store = new TicketStore({ clock: clock.now, ttlSeconds: 30 });
  const { ticket } = store.mint({ sessionId: SESSION, principalId: 'phone', origin: null });

  assert.equal(store.consume(ticket).ok, true, 'valid before expiry');

  const second = store.mint({ sessionId: SESSION, principalId: 'phone', origin: null });
  clock.advance(30_001);
  const result = store.consume(second.ticket);
  assert.equal(result.ok, false);
  assert.equal(result.code, AUTH_ERROR.WS_TICKET_EXPIRED);
  // The expired ticket is gone, so a later attempt is simply unknown.
  assert.equal(store.records.size, 0);
});

test('§19: a ticket is exactly one successful consumption', () => {
  const store = new TicketStore();
  const { ticket } = store.mint({ sessionId: SESSION, principalId: 'phone', origin: null });

  assert.equal(store.consume(ticket).ok, true, 'the first use succeeds');
  assert.equal(store.consume(ticket).ok, false, 'the second does not');
  assert.equal(store.counters.consumed, 1);
  assert.equal(store.counters.rejectedUnknown, 1, 'a used ticket is reported as unknown, not as "used"');
});

test('§20: a replay is indistinguishable from an unknown ticket', () => {
  const store = new TicketStore();
  const { ticket } = store.mint({ sessionId: SESSION, principalId: 'phone', origin: null });
  store.consume(ticket);

  const replay = store.consume(ticket);
  const random = store.consume(generateTicket());
  assert.equal(replay.code, random.code, 'the same code');
  assert.equal(replay.code, AUTH_ERROR.WS_TICKET_INVALID);
  // Only the server-side counters differ.
  assert.equal(replay.internalReason, 'unknown ticket');
  assert.equal(store.counters.rejectedUnknown >= 2, true);
});

test('§21: a ticket is bound to its session', () => {
  const store = new TicketStore();
  const { ticket, sessionId } = store.mint({ sessionId: SESSION, principalId: 'phone', origin: null });
  assert.equal(sessionId, SESSION);
  const record = [...store.records.values()][0];
  assert.equal(record.sessionId, SESSION);
  assert.notEqual(record.sessionId, OTHER_SESSION);
});

test('§22: origin binding is exact, including the native no-origin case', () => {
  const store = new TicketStore();
  const browser = store.mint({ sessionId: SESSION, principalId: 'phone', origin: 'http://localhost:9445' });
  const native = store.mint({ sessionId: SESSION, principalId: 'phone', origin: null });

  const browserRecord = [...store.records.values()].find((entry) => entry.digest === ticketDigest(browser.ticket));
  const nativeRecord = [...store.records.values()].find((entry) => entry.digest === ticketDigest(native.ticket));

  assert.equal(browserRecord.originBinding, 'http://localhost:9445');
  assert.equal(nativeRecord.originBinding, null, 'a native ticket pins to "no origin"');
});

test('§26: the outstanding cap refuses rather than evicting a live ticket', () => {
  const store = new TicketStore({ maxOutstanding: 3 });
  const minted = [];
  for (let index = 0; index < 3; index += 1) {
    minted.push(store.mint({ sessionId: SESSION, principalId: 'phone', origin: null }).ticket);
  }
  assert.throws(
    () => store.mint({ sessionId: SESSION, principalId: 'phone', origin: null }),
    (error) => error.code === AUTH_ERROR.TICKET_LIMIT,
  );
  // The three existing tickets are still usable: nothing was silently evicted.
  for (const ticket of minted) {
    assert.equal(store.inspect(ticket).ok, true, 'an outstanding ticket must not be evicted to make room');
  }
});

test('§26: cleanup removes expired tickets lazily', () => {
  const clock = manualClock();
  const store = new TicketStore({ clock: clock.now, ttlSeconds: 10, maxOutstanding: 2 });
  store.mint({ sessionId: SESSION, principalId: 'phone', origin: null });
  store.mint({ sessionId: SESSION, principalId: 'phone', origin: null });
  assert.equal(store.size, 2);

  clock.advance(10_001);
  assert.equal(store.cleanup(), 2, 'both are expired');
  assert.equal(store.size, 0);
  // And a slot is available again.
  assert.doesNotThrow(() => store.mint({ sessionId: SESSION, principalId: 'phone', origin: null }));
});

test('§64: the store is memory-only and survives no restart', () => {
  const first = new TicketStore();
  const { ticket } = first.mint({ sessionId: SESSION, principalId: 'phone', origin: null });
  // A new store models a restarted process: every outstanding ticket is invalid.
  const second = new TicketStore();
  assert.equal(second.consume(ticket).ok, false, 'a ticket from a previous process must not work');
  assert.equal(second.size, 0);
});

test('§14/§15: the mint endpoint returns 201 with a one-time ticket', async () => {
  const h = await startAuthServer();
  try {
    const res = await h.post('/api/v1/auth/ws-ticket', { session_id: SESSION });
    assert.equal(res.status, 201);
    const data = res.body.data;
    assert.equal(typeof data.ticket, 'string');
    assert.equal(data.ticket.length, 43);
    assert.equal(data.session_id, SESSION);
    assert.equal(data.expires_in_seconds, 30);
    assert.ok(!Number.isNaN(Date.parse(data.expires_at)), 'expires_at is an ISO timestamp');
    // §15: the ticket is returned once and must not be cached.
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers.pragma, 'no-cache');
  } finally {
    await h.close();
  }
});

test('§14: minting requires a credential and a valid session id', async () => {
  const h = await startAuthServer();
  try {
    assert.equal(
      (await request(h.baseUrl, '/api/v1/auth/ws-ticket', { method: 'POST', body: { session_id: SESSION } })).status,
      401,
      'no credential',
    );
    assert.equal(
      (await request(h.baseUrl, '/api/v1/auth/ws-ticket', {
        method: 'POST',
        body: { session_id: SESSION },
        headers: { authorization: `Bearer ${generateSyntheticToken()}` },
      })).status,
      401,
      'wrong credential',
    );
    assert.equal((await h.post('/api/v1/auth/ws-ticket', {})).status, 400, 'no session id');
    assert.equal((await h.post('/api/v1/auth/ws-ticket', { session_id: 'not-a-session' })).status, 400);
  } finally {
    await h.close();
  }
});

test('§22: the mint endpoint binds to the request Origin, not a client field', async () => {
  const h = await startAuthServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/auth/ws-ticket', {
      method: 'POST',
      body: {
        session_id: SESSION,
        // A client-supplied origin must be ignored: the binding comes from the real
        // request, so a caller cannot nominate a binding it was not granted.
        origin: 'http://evil.example',
      },
      headers: { authorization: `Bearer ${h.token}`, origin: `http://127.0.0.1:${h.address.port}` },
    });
    assert.equal(res.status, 201);
    const record = [...h.auth.tickets.records.values()][0];
    assert.equal(
      record.originBinding,
      `http://127.0.0.1:${h.address.port}`,
      'the actual request Origin wins',
    );
  } finally {
    await h.close();
  }
});

test('§24: a ticket is never written to disk (§25)', async () => {
  const { root, cleanup } = makeTempStateRoot('r6-ticket-durable');
  const h = await startAuthServer({ persistenceConfig: { root, segmentBytes: 65_536 } });
  try {
    const res = await h.post('/api/v1/auth/ws-ticket', { session_id: SESSION });
    const ticket = res.body.data.ticket;
    // Emit a durable event so the journal and snapshot actually exist.
    h.eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: { marker: 'after-ticket' } });
    h.persistence.writeSnapshot(true);

    const scan = scanTreeForSecrets(root, [ticket]);
    assert.equal(scan.files > 0, true, 'the state root really has files to scan');
    assert.deepEqual(scan.leaked, [], 'no ticket may appear in any durable artefact');
    // And the digest is not stored either.
    assert.deepEqual(scanTreeForSecrets(root, [ticketDigest(ticket)]).leaked, []);
  } finally {
    await h.close();
    cleanup();
  }
});

test('§39: minting does not consume a connection slot', async () => {
  const h = await startAuthServer();
  try {
    for (let index = 0; index < 10; index += 1) {
      const res = await h.post('/api/v1/auth/ws-ticket', { session_id: SESSION });
      assert.equal(res.status, 201, `mint ${index} must succeed`);
    }
    // Unused tickets must not consume the connection budget.
    assert.equal(h.auth.connections.countFor('phone'), 0, 'minting reserves no connection');
  } finally {
    await h.close();
  }
});

test('§26: the mint endpoint reports 429 once the outstanding cap is reached', async () => {
  const h = await startAuthServer({ config: { maxOutstandingTickets: 2 } });
  try {
    assert.equal((await h.post('/api/v1/auth/ws-ticket', { session_id: SESSION })).status, 201);
    assert.equal((await h.post('/api/v1/auth/ws-ticket', { session_id: SESSION })).status, 201);
    const third = await h.post('/api/v1/auth/ws-ticket', { session_id: SESSION });
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, AUTH_ERROR.TICKET_LIMIT);
  } finally {
    await h.close();
  }
});
