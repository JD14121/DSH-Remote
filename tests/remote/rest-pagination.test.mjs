/**
 * Pagination tests — Phase R3 §14, §16.
 *
 * Two separate concerns live here:
 *
 *   - the **session list** is bounded and paged on the Gateway side, with an
 *     opaque best-effort cursor;
 *   - the **message history** uses a DSH durable cursor, which is a different
 *     kind of thing entirely and must never be a Gateway event sequence.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { request, startFixtureServer, FIXTURE_SESSIONS } from './r3-helpers.mjs';
import {
  CURSOR_VERSION,
  SESSION_SORT,
  decodeCursor,
  encodeCursor,
  messagePageBlock,
  paginateSessions,
  sortSessions,
} from '../../src/remote/http/pagination.mjs';
import { SessionsService } from '../../src/remote/sessions.mjs';
import { SessionViewStore } from '../../src/remote/state/session-view-store.mjs';
import { StatusService } from '../../src/remote/status-service.mjs';
import { EventsService } from '../../src/remote/events.mjs';
import { MessagesService } from '../../src/remote/messages.mjs';
import { UploadService } from '../../src/remote/uploads.mjs';
import { createRemoteHttpServer } from '../../src/remote/server.mjs';
import { resolveHttpConfig } from '../../src/remote/http/config.mjs';
import { createFixtureAdapter } from '../../scripts/fixture-adapter.mjs';

/** Build 250 synthetic sessions with deterministic timestamps. */
function syntheticSessions(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${String(index).padStart(8, '0')}-0000-0000-0000-000000000000`,
    title: null,
    status: 'idle',
    created_at: null,
    // Descending timestamps so the expected order is simply index ASC.
    updated_at: new Date(1_789_000_000_000 - index * 60_000).toISOString(),
    last_sequence: 0,
    running: false,
  }));
}

test('a 250-session list pages through every session exactly once', () => {
  const sessions = syntheticSessions(250);
  const seen = [];
  let cursor;
  let pages = 0;

  for (;;) {
    const page = paginateSessions(sessions, { limit: 50, cursor });
    seen.push(...page.items.map((session) => session.id));
    pages += 1;
    if (page.page.has_more !== true) break;
    cursor = page.page.next_cursor;
    assert.ok(pages < 20, 'pagination must terminate');
  }

  assert.equal(pages, 5);
  assert.equal(seen.length, 250);
  assert.equal(new Set(seen).size, 250, 'no session is returned twice');
  // Deterministic order: descending updated_at means ascending index.
  assert.deepEqual(seen.slice(0, 3), [
    'session-00000000-0000-0000-0000-000000000000',
    'session-00000001-0000-0000-0000-000000000000',
    'session-00000002-0000-0000-0000-000000000000',
  ]);
});

test('the cursor is opaque and carries no session identity', () => {
  const sessions = syntheticSessions(3);
  const page = paginateSessions(sessions, { limit: 1 });
  const cursor = page.page.next_cursor;

  assert.equal(typeof cursor, 'string');
  assert.equal(cursor.includes('session-'), false, 'a cursor must not embed an id');
  assert.equal(/^[A-Za-z0-9_-]+$/.test(cursor), true, 'base64url alphabet');

  const decoded = decodeCursor(cursor);
  assert.equal(decoded.v, CURSOR_VERSION);
  assert.equal(decoded.offset, 1);
  assert.equal(decoded.sort, SESSION_SORT);
});

test('cursor encoding is stable for the same position', () => {
  const first = encodeCursor({ offset: 50, sort: SESSION_SORT });
  const second = encodeCursor({ offset: 50, sort: SESSION_SORT });
  assert.equal(first, second);
});

test('a cursor from a different version is rejected, not reinterpreted', () => {
  const stale = Buffer.from(JSON.stringify({ v: 99, offset: 0, sort: SESSION_SORT })).toString('base64url');
  assert.throws(() => decodeCursor(stale), (error) => {
    assert.equal(error.code, 'INVALID_CURSOR');
    return true;
  });
});

test('an offset past the end yields an empty final page, not an error', () => {
  const sessions = syntheticSessions(3);
  const page = paginateSessions(sessions, {
    limit: 10,
    cursor: encodeCursor({ offset: 50, sort: SESSION_SORT }),
  });
  assert.deepEqual(page.items, []);
  assert.equal(page.page.has_more, false);
  assert.equal(page.page.next_cursor, null);
});

test('a limit of 200 is the documented maximum for a session page', () => {
  const sessions = syntheticSessions(250);
  const page = paginateSessions(sessions, { limit: 200 });
  assert.equal(page.items.length, 200);
  assert.equal(page.page.has_more, true);
});

test('message pagination names the DSH durable sequence space', () => {
  const block = messagePageBlock({
    limit: 50,
    returned: 12,
    throughSeq: 123,
    beforeSeq: 100,
    nextBeforeSeq: 88,
    hasMore: true,
  });

  assert.equal(block.through_seq, 123);
  assert.equal(block.before_seq, 100);
  assert.equal(block.next_before_seq, 88);
  assert.equal(block.has_more, true);
  assert.equal(block.sequence_kind, 'dsh_durable_source_sequence');
  // Nothing in a history page may be described as a Gateway sequence.
  const text = JSON.stringify(block).toLowerCase();
  for (const forbidden of ['gateway', 'last_sequence', 'event_sequence']) {
    assert.equal(text.includes(forbidden), false, `a history page must not mention ${forbidden}`);
  }
});

test('message pagination bounds the page and reports a DSH cursor', async () => {
  const h = await startFixtureServer();
  try {
    const sessionId = FIXTURE_SESSIONS.RUNNING;
    const res = await request(h.baseUrl, `/api/v1/sessions/${sessionId}/messages?limit=1`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.page.limit, 1);
    assert.equal(res.body.page.returned, 1);
    // The Gateway paginates history through the adapter page call, which is a
    // DSH durable cursor — never the realtime sequence.
    assert.equal(res.body.page.sequence_kind, 'dsh_durable_source_sequence');
    if (res.body.page.through_seq !== null) {
      assert.equal(typeof res.body.page.through_seq, 'number');
    }
  } finally {
    await h.close();
  }
});

test('the message page size is capped at 200', async () => {
  const h = await startFixtureServer();
  try {
    const tooMany = await request(h.baseUrl, `/api/v1/sessions/${FIXTURE_SESSIONS.RUNNING}/messages?limit=201`);
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.error.code, 'INVALID_QUERY');

    const atMax = await request(h.baseUrl, `/api/v1/sessions/${FIXTURE_SESSIONS.RUNNING}/messages?limit=200`);
    assert.equal(atMax.status, 200);
  } finally {
    await h.close();
  }
});

test('the session cursor is a best-effort list cursor, not a snapshot', async () => {
  // §14 requires this limitation to be explicit. Prove it: inserting a session
  // between pages can shift the window, because the cursor is an offset.
  const sessions = syntheticSessions(4);
  const first = paginateSessions(sessions, { limit: 2 });
  assert.deepEqual(first.items.map((session) => session.id.slice(8, 16)), ['00000000', '00000001']);

  // A newer session appears at the head, pushing everything down.
  const withNewcomer = [
    {
      id: 'session-99999999-0000-0000-0000-000000000000',
      title: null,
      status: 'idle',
      created_at: null,
      updated_at: new Date(1_790_000_000_000).toISOString(),
      last_sequence: 0,
      running: false,
    },
    ...sessions,
  ];

  const second = paginateSessions(withNewcomer, { limit: 2, cursor: first.page.next_cursor });
  // The shift is real and documented — 'session-00000001' is seen twice.
  assert.deepEqual(second.items.map((session) => session.id.slice(8, 16)), ['00000001', '00000002']);
});

test('sorting handles unparseable timestamps without throwing', () => {
  const sorted = sortSessions([
    { id: 'session-00000000-0000-0000-0000-00000000000a', updated_at: 'not-a-date' },
    { id: 'session-00000000-0000-0000-0000-00000000000b', updated_at: '2026-01-01T00:00:00.000Z' },
    { id: 'session-00000000-0000-0000-0000-00000000000c', updated_at: undefined },
  ]);
  // A usable timestamp sorts first; unusable ones fall to the end in id order.
  assert.equal(sorted[0].id.slice(-1), 'b');
  assert.deepEqual(sorted.slice(1).map((s) => s.id.slice(-1)), ['a', 'c']);
});

test('the session list served over HTTP is bounded even when DSH returns everything', async () => {
  // DSH's `session/list` returns the full set (R1 confirmed the declared cursor is
  // ignored), so the bound has to be applied by the Gateway.
  const adapter = createFixtureAdapter({ clock: () => 1_789_800_000_000 });
  const many = new Map();
  for (let index = 0; index < 300; index += 1) {
    many.set(`session-${String(index).padStart(8, '0')}-0000-0000-0000-000000000000`, {
      running: false,
      updatedAt: 1_789_000_000_000 - index * 1000,
      blank: false,
    });
  }
  adapter._state.sessions = many;

  const store = new SessionViewStore({ clock: () => 1_789_800_000_000 });
  const sessionsService = new SessionsService({ adapter, store, clock: () => 1_789_800_000_000 });
  await sessionsService.refresh();

  const eventsService = new EventsService({ adapter, store, clock: () => 1_789_800_000_000 });
  const statusService = new StatusService({ adapter, eventsService, clock: () => 1_789_800_000_000 });
  const messagesService = new MessagesService({ adapter, store, clock: () => 1_789_800_000_000 });

  const server = createRemoteHttpServer({
    sessionsService,
    messagesService,
    eventsService,
    statusService,
    adapter,
    config: resolveHttpConfig({ host: '127.0.0.1', port: 0, dshVersion: '0.1.5-rc.2' }, {}),
    healthFacts: () => ({ gateway: 'ready', ready: true, dsh: { status: 'ready', version: '0.1.5-rc.2' } }),
    // R5 §61: this suite is about pagination, not durability, and an automated test
    // must never touch the real `$DSH_HOME\remote`. Persistence is opted out.
    persistence: null,
    // R6 §5: the auth decision is explicit, and this suite is not about auth.
    auth: null,
  });

  const address = await server.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const first = await request(baseUrl, '/api/v1/sessions');
    assert.equal(first.status, 200);
    assert.equal(first.body.data.length, 50, 'a 300-session backend still returns a bounded page');
    assert.equal(first.body.page.total, 300);
    assert.equal(first.body.page.has_more, true);

    // Walk every page and confirm completeness.
    const seen = new Set(first.body.data.map((session) => session.id));
    let cursor = first.body.page.next_cursor;
    while (cursor !== null) {
      const page = await request(baseUrl, `/api/v1/sessions?cursor=${encodeURIComponent(cursor)}`);
      for (const session of page.body.data) seen.add(session.id);
      cursor = page.body.page.next_cursor;
    }
    assert.equal(seen.size, 300, 'every session was reachable exactly once');
  } finally {
    await server.stop();
  }
});
