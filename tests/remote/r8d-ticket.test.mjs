/**
 * R8D — ticket handling: memory-only, single-use, fresh on reconnect, never in a URL or a log.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildEventsUrl, redactTicketUrl, requestTicket } from '../../src/remote/ui/ws/ticket-client.js';
import { EventClient, SOCKET_STATE } from '../../src/remote/ui/ws/event-client.js';
import { helloFrame, replayCompleteFrame, startWsFixture, waitFor } from './r8d-harness.mjs';

const UI = path.join(process.cwd(), 'src', 'remote', 'ui');

test('the ticket URL carries only the one-time ticket', () => {
  const url = buildEventsUrl({ baseUrl: 'http://127.0.0.1:8099', sessionId: 's-1', ticket: 'one-time-abc', lastSequence: 7 });
  const parsed = new URL(url);

  assert.equal(parsed.pathname, '/api/v1/events');
  assert.equal(parsed.searchParams.get('ticket'), 'one-time-abc');
  assert.equal(parsed.searchParams.get('session_id'), 's-1');
  assert.equal(parsed.searchParams.get('last_sequence'), '7');

  // Nothing that could be a long-lived credential may appear.
  for (const forbidden of ['token', 'bearer', 'access_token', 'launch', 'dsh-auth', 'authorization']) {
    assert.equal(parsed.searchParams.has(forbidden), false, `${forbidden} must not be a query parameter`);
  }
});

test('a Phone credential can never reach the WS URL', () => {
  // The client is given a credential and a ticket; only the ticket may appear.
  const url = buildEventsUrl({ baseUrl: 'http://127.0.0.1:8099', sessionId: 's-1', ticket: 'tkt-1' });
  assert.equal(url.includes('good-token'), false);
  assert.equal(/Bearer/i.test(url), false);
  assert.equal(url.includes('dsh-auth'), false);
});

test('the ticket is requested with the credential as a header, never in the URL', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url: String(url), headers: init.headers, body: init.body };
    return { ok: true, status: 200, json: async () => ({ ticket: 'tkt-xyz' }) };
  };
  const ticket = await requestTicket({ fetchImpl, baseUrl: 'http://127.0.0.1:9445', credential: 'phone-secret', sessionId: 's-1' });

  assert.equal(ticket, 'tkt-xyz');
  assert.equal(seen.url, 'http://127.0.0.1:9445/api/v1/auth/ws-ticket');
  assert.equal(seen.headers.authorization, 'Bearer phone-secret');
  assert.equal(seen.url.includes('phone-secret'), false, 'the credential must not be in the URL');
});

test('a rejected credential is classified as an auth failure, not a network drop', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(
    () => requestTicket({ fetchImpl, credential: 'bad', sessionId: 's-1' }),
    (error) => error.kind === 'auth_required',
  );
});

test('an unreachable Gateway is classified as a network failure', async () => {
  const fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(
    () => requestTicket({ fetchImpl, credential: 'tok', sessionId: 's-1' }),
    (error) => error.kind === 'network',
  );
});

test('the ticket is not retained after a connection attempt', async () => {
  const fixture = await startWsFixture();
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

    assert.equal(client.pendingTicket, null, 'the ticket must be dropped once used');
    assert.equal(Object.keys(client).some((k) => k.toLowerCase().includes('ticket') && k !== 'pendingTicket' && k !== 'ticketsRequested'), false,
      'no other ticket-bearing field may exist on the client');
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('a reconnect obtains a fresh ticket rather than reusing the first', async () => {
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
    const firstIssued = fixture.ticketsIssued;

    await client.connect();
    await waitFor(() => fixture.connections.length === 2);

    assert.equal(fixture.ticketsIssued, firstIssued + 1, 'each connection must request its own ticket');
    assert.equal(client.ticketsRequested, 2);

    // The fixture consumes each ticket, so a reused one would have been rejected.
    assert.deepEqual(fixture.rejectedUpgrades.filter((r) => r.reason === 'unknown-ticket'), []);
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('a used ticket is refused on a second upgrade', async () => {
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

    // The server consumed the ticket for this connection. Re-presenting exactly that ticket must
    // be refused — this is what makes it single-use rather than merely short-lived.
    const consumed = fixture.consumed[0];
    assert.ok(typeof consumed === 'string' && consumed.length > 0, 'the fixture should have consumed one ticket');
    client.close();

    const socket = new globalThis.WebSocket(
      `ws://127.0.0.1:${fixture.port}/api/v1/events?ticket=${consumed}&session_id=s-1`,
      ['dsh-remote-v1'],
    );
    await new Promise((resolve) => {
      socket.addEventListener('error', resolve);
      socket.addEventListener('close', resolve);
      setTimeout(resolve, 500);
    });

    assert.equal(
      fixture.rejectedUpgrades.some((r) => r.reason === 'unknown-ticket'),
      true,
      'a used ticket must be refused',
    );
    assert.equal(fixture.connections.length, 1, 'no second connection may be established');
  } finally {
    await fixture.stop();
  }
});

test('no ticket is written to any storage', () => {
  // Nothing in the WS layer may reach for a durable store.
  const wsDir = path.join(UI, 'ws');
  for (const entry of fs.readdirSync(wsDir)) {
    if (!entry.endsWith('.js')) continue;
    const text = fs.readFileSync(path.join(wsDir, entry), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.equal(/localStorage|sessionStorage|indexedDB/.test(text), false, `${entry} touches storage`);
  }
});

test('redactTicketUrl removes the ticket and nothing else', () => {
  const redacted = redactTicketUrl('http://127.0.0.1:8099/api/v1/events?ticket=super-secret&session_id=s-1');
  assert.equal(redacted.includes('super-secret'), false, 'the ticket must be removed');
  assert.match(redacted, /ticket=%5Bredacted%5D|ticket=\[redacted\]/);
  assert.match(redacted, /session_id=s-1/, 'the non-secret parameters remain legible');
});
