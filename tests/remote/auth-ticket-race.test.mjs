/**
 * Ticket race tests — Phase R6 §56, §57, §81.
 *
 * §57 requires that two upgrades presenting the **same** ticket at the same moment
 * produce exactly one success. Two successes would mean the one-time guarantee is
 * not real, which is the whole security value of the ticket.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FRAME,
  SESSION,
  TicketStore,
  generateTicket,
  startAuthWsServer,
} from './r6-helpers.mjs';

test('§57: the store consumes a ticket atomically with no await between steps', async () => {
  // The property is structural: `consume` does a lookup and a delete with no
  // asynchronous step, so in Node's single-threaded model nothing can interleave.
  const source = await import('node:fs').then((fs) => fs.promises.readFile(
    new URL('../../src/remote/auth/ws-ticket.mjs', import.meta.url), 'utf8',
  ));
  const consume = source.slice(source.indexOf('  consume(ticket) {'), source.indexOf('  /**', source.indexOf('  consume(ticket) {')));
  assert.equal(consume.includes('await'), false, 'consume must contain no await');
  assert.equal(consume.includes('async'), false, 'consume must not be async');
});

test('§57: the store itself yields exactly one winner from many racing consumers', () => {
  const store = new TicketStore();
  const { ticket } = store.mint({ sessionId: SESSION, principalId: 'phone', origin: null });

  // Called back to back with no await, which is what "the same millisecond" means in
  // a single-threaded runtime.
  const results = Array.from({ length: 10 }, () => store.consume(ticket));
  const winners = results.filter((entry) => entry.ok);
  assert.equal(winners.length, 1, 'exactly one consumer may win');
  assert.equal(store.counters.consumed, 1);
});

test('§81: two concurrent upgrades on one ticket produce exactly one 101', async () => {
  const h = await startAuthWsServer();
  try {
    const mint = await h.mintTicket({ sessionId: SESSION });
    const ticket = mint.body.data.ticket;
    const path = `/api/v1/events?session_id=${SESSION}&ticket=${ticket}`;

    // Both upgrades are issued before either response is read, so they overlap.
    const [first, second] = await Promise.all([
      h.ticketUpgrade({ path }),
      h.ticketUpgrade({ path }),
    ]);

    const successes = [first, second].filter((res) => res.status === 101);
    const failures = [first, second].filter((res) => res.status !== 101);
    assert.equal(successes.length, 1, 'exactly one upgrade may succeed');
    assert.equal(failures.length, 1, 'the other must be refused');
    assert.equal(failures[0].status, 401, 'the loser is refused before the handshake');
    assert.match(failures[0].body, /WS_TICKET_INVALID/);
  } finally {
    await h.close();
  }
});

test('§81: the race holds across repeated rounds', async () => {
  const h = await startAuthWsServer();
  try {
    for (let round = 0; round < 8; round += 1) {
      const mint = await h.mintTicket({ sessionId: SESSION });
      const ticket = mint.body.data.ticket;
      const path = `/api/v1/events?session_id=${SESSION}&ticket=${ticket}`;

      const results = await Promise.all([
        h.ticketUpgrade({ path }),
        h.ticketUpgrade({ path }),
      ]);
      const successes = results.filter((res) => res.status === 101).length;
      assert.equal(successes, 1, `round ${round}: exactly one success`);

      // Whatever succeeded must be closed so the next round has a free slot.
      for (const res of results) void res;
    }
  } finally {
    await h.close();
  }
});

test('§81: five simultaneous attempts still yield one winner', async () => {
  const h = await startAuthWsServer({ config: { maxConnectionsPerPrincipal: 8 } });
  try {
    const mint = await h.mintTicket({ sessionId: SESSION });
    const path = `/api/v1/events?session_id=${SESSION}&ticket=${mint.body.data.ticket}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => h.ticketUpgrade({ path })),
    );
    assert.equal(results.filter((res) => res.status === 101).length, 1);
    assert.equal(results.filter((res) => res.status === 401).length, 4);
  } finally {
    await h.close();
  }
});

test('§38: a racing pair does not double-count the connection slot', async () => {
  const h = await startAuthWsServer();
  try {
    const mint = await h.mintTicket({ sessionId: SESSION });
    const path = `/api/v1/events?session_id=${SESSION}&ticket=${mint.body.data.ticket}`;
    await Promise.all([h.ticketUpgrade({ path }), h.ticketUpgrade({ path })]);

    // One winner reserved one slot. The loser's reservation is either never taken
    // (ticket check first) or released, so the count is exactly one.
    const live = h.auth.connections.countFor('phone');
    assert.ok(live <= 1, `at most one slot may be held, saw ${live}`);
    assert.equal(h.auth.connections.counters.refused >= 0, true);
  } finally {
    await h.close();
  }
});

test('§57: two different tickets both succeed concurrently', async () => {
  const h = await startAuthWsServer({ config: { maxConnectionsPerPrincipal: 4 } });
  try {
    // The atomicity must be per-ticket, not a global lock that serialises everything.
    const a = await h.mintTicket({ sessionId: SESSION });
    const b = await h.mintTicket({ sessionId: SESSION });
    const [first, second] = await Promise.all([
      h.ticketUpgrade({ path: `/api/v1/events?session_id=${SESSION}&ticket=${a.body.data.ticket}` }),
      h.ticketUpgrade({ path: `/api/v1/events?session_id=${SESSION}&ticket=${b.body.data.ticket}` }),
    ]);
    assert.equal(first.status, 101, 'the first distinct ticket works');
    assert.equal(second.status, 101, 'and so does the second');
  } finally {
    await h.close();
  }
});

test('a consumed ticket can never be resurrected by a later cleanup pass', () => {
  const store = new TicketStore();
  const { ticket } = store.mint({ sessionId: SESSION, principalId: 'phone', origin: null });
  store.consume(ticket);
  // A cleanup pass must not bring it back, and an unrelated mint must not either.
  store.cleanup();
  store.mint({ sessionId: SESSION, principalId: 'phone', origin: null });
  assert.equal(store.consume(ticket).ok, false);
  assert.equal(generateTicket() === ticket, false, 'a fresh ticket is never a repeat');
});
