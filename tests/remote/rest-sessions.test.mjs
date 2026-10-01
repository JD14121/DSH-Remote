/**
 * Session endpoint tests — Phase R3 §13, §14, §15, §37.
 *
 * Covers list, deterministic sort, pagination, cursor, invalid cursor, limit,
 * detail, not-found, and the leak rules: `metadata` and the DSH cursor must never
 * reach a client, while a legitimately unknown `title`/`created_at` stays `null`
 * rather than being invented.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { request, startFixtureServer, FIXTURE_SESSIONS } from './r3-helpers.mjs';
import { decodeCursor, sortSessions } from '../../src/remote/http/pagination.mjs';
import { createRemoteHttpServer } from '../../src/remote/server.mjs';
import { SessionsService } from '../../src/remote/sessions.mjs';
import { MessagesService } from '../../src/remote/messages.mjs';
import { EventsService } from '../../src/remote/events.mjs';
import { StatusService } from '../../src/remote/status-service.mjs';
import { SessionViewStore } from '../../src/remote/state/session-view-store.mjs';
import { resolveHttpConfig } from '../../src/remote/http/config.mjs';

/** A deterministic id in the audited `session-<uuid>` shape. */
const CREATED_SESSION_ID = 'session-00000000-0000-0000-0000-0000000000aa';
const CREATE_CLOCK = () => 1_789_800_000_000;

/**
 * A persistence stub whose only meaningful method is `health`.
 *
 * The create route asks `persistenceHealth()` before accepting the command, so a
 * stub is enough to prove the durability gate without touching a real state root.
 *
 * @param {string} status - the health status to report.
 * @returns {object} the stub.
 */
function persistenceStub(status) {
  return {
    initialize() {},
    attachEvents() {},
    start() {},
    shutdown() {},
    append() {},
    health() { return { status, format_version: 1 }; },
  };
}

/**
 * Start a real HTTP server over a controlled adapter that can create a session.
 *
 * @param {object} [options] - `createResult`, `createError`, `persistence`.
 * @returns {Promise<object>} the running fixture.
 */
async function startCreateServer(options = {}) {
  const createCalls = [];
  const adapter = {
    async listSessions() { return []; },
    async getSession() { return null; },
    async getMessages() { return { messages: [], raw: {}, throughSeq: 0, hasMore: false }; },
    async sendMessage() { return { accepted: true, requestId: 'req' }; },
    async cancel() { return { accepted: true }; },
    async createSession(createOptions = {}) {
      createCalls.push(createOptions);
      if (options.createError !== undefined) throw options.createError;
      return options.createResult ?? { sessionId: CREATED_SESSION_ID };
    },
  };
  const store = new SessionViewStore({ clock: CREATE_CLOCK });
  const sessionsService = new SessionsService({ adapter, store, clock: CREATE_CLOCK });
  const eventsService = new EventsService({ adapter, store, clock: CREATE_CLOCK });
  const messagesService = new MessagesService({ adapter, store, clock: CREATE_CLOCK });
  const statusService = new StatusService({ adapter, eventsService, clock: CREATE_CLOCK });

  const server = createRemoteHttpServer({
    sessionsService,
    messagesService,
    eventsService,
    statusService,
    adapter,
    config: resolveHttpConfig({ host: '127.0.0.1', port: 0, dshVersion: '0.1.5-rc.2' }, {}),
    auth: null,
    clock: CREATE_CLOCK,
    persistence: options.persistence === undefined ? null : options.persistence,
    healthFacts: () => ({ gateway: 'ready', ready: true, dsh: { status: 'ready', version: '0.1.5-rc.2' } }),
  });

  const address = await server.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    store,
    sessionsService,
    createCalls,
    baseUrl,
    get: (path) => request(baseUrl, path),
    post: (path, body) => request(baseUrl, path, { method: 'POST', body }),
    close: () => server.stop(),
  };
}

test('POST /api/v1/sessions creates through DSH with an empty request and a safe identity', async () => {
  const h = await startCreateServer();
  try {
    const res = await h.post('/api/v1/sessions', {});
    assert.equal(res.status, 201);
    assert.equal(res.body.api_version, 1);
    assert.equal(res.body.data.id, CREATED_SESSION_ID);
    assert.equal(res.body.data.status, 'idle');
    // No path/workspace scope may be echoed back to the phone.
    assert.equal('workspace_id' in res.body.data, false);
    assert.equal('cwd' in res.body.data, false);
    assert.equal(res.text.includes('workspaceId'), false);

    // DSH received exactly one empty request.
    assert.deepEqual(h.createCalls, [{}]);
    // The created session is tracked, so it is immediately addressable and listed.
    assert.equal(h.store.has(CREATED_SESSION_ID), true);
  } finally {
    await h.close();
  }
});

test('POST /api/v1/sessions rejects a mobile-controlled workspace, path, preset or id', async () => {
  const h = await startCreateServer();
  try {
    const cases = [
      { workspaceId: 'C:\\arbitrary' },
      { cwd: '/etc' },
      { agentPreset: 'hax' },
      { sessionId: 'session-attacker-chosen' },
    ];
    for (const body of cases) {
      const res = await h.post('/api/v1/sessions', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error.code, 'INVALID_REQUEST');
    }
    assert.equal(h.createCalls.length, 0, 'a refused selector must never reach DSH');
  } finally {
    await h.close();
  }
});

test('POST /api/v1/sessions rejects an invalid DSH create response', async () => {
  const h = await startCreateServer({
    createError: Object.assign(new Error('invalid SessionCreateValue'), { code: 'WIRE_PROTOCOL_ERROR' }),
  });
  try {
    const res = await h.post('/api/v1/sessions', {});
    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, 'WIRE_PROTOCOL_ERROR');
  } finally {
    await h.close();
  }
});

test('POST /api/v1/sessions fails closed when durability is unavailable', async () => {
  const h = await startCreateServer({ persistence: persistenceStub('unavailable') });
  try {
    const res = await h.post('/api/v1/sessions', {});
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'PERSISTENCE_UNAVAILABLE');
    assert.equal(h.createCalls.length, 0, 'nothing may be created when it cannot be recorded');
  } finally {
    await h.close();
  }
});

test('a created session appears in the session inventory', async () => {
  const h = await startCreateServer();
  try {
    const created = await h.post('/api/v1/sessions', {});
    assert.equal(created.status, 201);

    const list = await h.get('/api/v1/sessions');
    assert.equal(list.status, 200);
    assert.equal(list.body.data.some((session) => session.id === CREATED_SESSION_ID), true);

    const detail = await h.get(`/api/v1/sessions/${CREATED_SESSION_ID}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.id, CREATED_SESSION_ID);
  } finally {
    await h.close();
  }
});


test('the session list returns the mobile projection of every session', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions');
    assert.equal(res.status, 200);
    assert.equal(res.body.api_version, 1);
    assert.ok(Array.isArray(res.body.data));
    assert.equal(res.body.data.length, 3);

    const session = res.body.data.find((entry) => entry.id === FIXTURE_SESSIONS.RUNNING);
    assert.ok(session);
    assert.equal(session.status, 'running');
    assert.equal(session.running, true);
    // A field with no audited source stays null; it is never guessed (§13).
    assert.equal(session.title, null);
    assert.equal(session.created_at, null);
    assert.equal(typeof session.updated_at, 'string');
    assert.equal(typeof session.last_sequence, 'number');
  } finally {
    await h.close();
  }
});

test('the list never leaks metadata, the DSH cursor, or raw DSH objects', async () => {
  const h = await startFixtureServer();
  try {
    // Give a session metadata and a DSH cursor so a leak would be visible.
    h.store.rememberDshCursor(FIXTURE_SESSIONS.RUNNING, 418);
    h.store.upsertSession({
      id: FIXTURE_SESSIONS.RUNNING,
      title: null,
      status: 'running',
      created_at: null,
      updated_at: null,
      last_sequence: 3,
      running: true,
      metadata: { rawDshObject: { internal: 'must-not-leak' } },
    });

    const list = await request(h.baseUrl, '/api/v1/sessions');
    const detail = await request(h.baseUrl, `/api/v1/sessions/${FIXTURE_SESSIONS.RUNNING}`);

    for (const res of [list, detail]) {
      const text = res.text;
      assert.equal(text.includes('metadata'), false, 'metadata must not be projected');
      assert.equal(text.includes('must-not-leak'), false, 'raw DSH values must not be projected');
      assert.equal(text.includes('dsh_cursor'), false, 'the DSH cursor must not be projected');
      assert.equal(text.includes('rawDshObject'), false);
      assert.equal(text.includes('observed_at'), false);
      assert.equal(text.includes('active_run'), false);
    }
  } finally {
    await h.close();
  }
});

test('the list is sorted by updated_at descending then id ascending', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions');
    const ids = res.body.data.map((entry) => entry.id);

    // RUNNING has the newest timestamp; BLANK has none and sorts last.
    assert.deepEqual(ids, [
      FIXTURE_SESSIONS.RUNNING,
      FIXTURE_SESSIONS.IDLE,
      FIXTURE_SESSIONS.BLANK,
    ]);
  } finally {
    await h.close();
  }
});

test('a session with no updated_at sorts last, not first', async () => {
  // Sorting a null timestamp as 0 would put it *before* every real date, which
  // would look like the oldest session instead of an unknown one.
  const sorted = sortSessions([
    { id: 'session-00000000-0000-0000-0000-00000000000a', updated_at: null },
    { id: 'session-00000000-0000-0000-0000-00000000000b', updated_at: '2020-01-01T00:00:00.000Z' },
    { id: 'session-00000000-0000-0000-0000-00000000000c', updated_at: '2026-01-01T00:00:00.000Z' },
  ]);
  assert.deepEqual(sorted.map((s) => s.id.slice(-1)), ['c', 'b', 'a']);
});

test('sorting is deterministic and independent of input order', async () => {
  const forward = sortSessions([
    { id: 'session-00000000-0000-0000-0000-00000000000a', updated_at: '2026-01-01T00:00:00.000Z' },
    { id: 'session-00000000-0000-0000-0000-00000000000b', updated_at: '2026-01-01T00:00:00.000Z' },
  ]);
  const reversed = sortSessions([
    { id: 'session-00000000-0000-0000-0000-00000000000b', updated_at: '2026-01-01T00:00:00.000Z' },
    { id: 'session-00000000-0000-0000-0000-00000000000a', updated_at: '2026-01-01T00:00:00.000Z' },
  ]);
  // Equal timestamps fall back to id ascending, so both orders agree.
  assert.deepEqual(forward.map((s) => s.id), reversed.map((s) => s.id));
});

test('session detail returns one session and 404s an unknown id', async () => {
  const h = await startFixtureServer();
  try {
    const found = await request(h.baseUrl, `/api/v1/sessions/${FIXTURE_SESSIONS.IDLE}`);
    assert.equal(found.status, 200);
    assert.equal(found.body.data.id, FIXTURE_SESSIONS.IDLE);
    assert.equal(found.body.data.status, 'idle');

    const missing = await request(h.baseUrl, '/api/v1/sessions/session-00000000-0000-0000-0000-0000000000ff');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'SESSION_NOT_FOUND');
  } finally {
    await h.close();
  }
});

test('default limit is 50 and the maximum is 200', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions');
    assert.equal(res.body.page.limit, 50);

    // The fixture has only 3 sessions, so a larger limit still returns all 3.
    const big = await request(h.baseUrl, '/api/v1/sessions?limit=200');
    assert.equal(big.status, 200);
    assert.equal(big.body.page.limit, 200);

    const tooBig = await request(h.baseUrl, '/api/v1/sessions?limit=201');
    assert.equal(tooBig.status, 400);
    assert.equal(tooBig.body.error.code, 'INVALID_QUERY');
  } finally {
    await h.close();
  }
});

test('limit rejects zero, negatives, fractions and non-numeric values', async () => {
  const h = await startFixtureServer();
  try {
    for (const bad of ['0', '-1', '1.5', 'abc', '']) {
      const res = await request(h.baseUrl, `/api/v1/sessions?limit=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, `limit=${bad} must be rejected`);
      assert.equal(res.body.error.code, 'INVALID_QUERY');
    }
  } finally {
    await h.close();
  }
});

test('an unknown query parameter is rejected rather than ignored', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions?sort=id');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_QUERY');
  } finally {
    await h.close();
  }
});

test('a repeated query parameter is a 400, not a silent first-wins', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions?limit=1&limit=2');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_QUERY');
  } finally {
    await h.close();
  }
});

test('malformed session ids are rejected before reaching the domain', async () => {
  const h = await startFixtureServer();
  try {
    // Traversal, separators, control characters and a wrong shape must all fail
    // as 400 rather than being passed to DSH (§15).
    const cases = [
      '..%2F..%2Fetc%2Fpasswd',
      'session-..%5C..%5Cwindows',
      'notasession-123',
      'session-%00abc',
      'session-%0Aabc',
      'session-',
      '%2Fetc%2Fpasswd',
    ];
    for (const candidate of cases) {
      const res = await request(h.baseUrl, `/api/v1/sessions/${candidate}`);
      assert.equal(res.status, 400, `${candidate} must be refused`);
      assert.equal(res.body.error.code, 'INVALID_SESSION_ID', `${candidate} code`);
    }
  } finally {
    await h.close();
  }
});

test('a valid but unknown session id is a 404, distinct from a malformed one', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions/session-deadbeef-0000-0000-0000-000000000000');
    assert.equal(res.status, 404, 'well-formed but absent is NOT a 400');
    assert.equal(res.body.error.code, 'SESSION_NOT_FOUND');
  } finally {
    await h.close();
  }
});

test('pagination walks the list with an opaque cursor and no gaps', async () => {
  const h = await startFixtureServer();
  try {
    const first = await request(h.baseUrl, '/api/v1/sessions?limit=2');
    assert.equal(first.body.data.length, 2);
    assert.equal(first.body.page.has_more, true);
    assert.equal(typeof first.body.page.next_cursor, 'string');

    // Opaque: it decodes to a versioned payload, not to a readable id list.
    const decoded = decodeCursor(first.body.page.next_cursor);
    assert.equal(decoded.v, 1);
    assert.equal(decoded.offset, 2);
    assert.equal(decoded.sort, 'updated_desc_id_asc');
    assert.equal(first.body.page.next_cursor.includes('session-'), false, 'the cursor must not embed ids');

    const second = await request(
      h.baseUrl,
      `/api/v1/sessions?limit=2&cursor=${encodeURIComponent(first.body.page.next_cursor)}`,
    );
    assert.equal(second.status, 200);
    assert.equal(second.body.data.length, 1);
    assert.equal(second.body.page.has_more, false);
    assert.equal(second.body.page.next_cursor, null);

    // No overlap and no gap across the two pages.
    const all = [...first.body.data, ...second.body.data].map((entry) => entry.id);
    assert.equal(new Set(all).size, 3);
  } finally {
    await h.close();
  }
});

test('an invalid cursor is a 400 INVALID_CURSOR', async () => {
  const h = await startFixtureServer();
  try {
    const cases = [
      'not-base64!!',
      Buffer.from('{"v":2,"offset":0,"sort":"updated_desc_id_asc"}').toString('base64url'),
      Buffer.from('{"v":1,"offset":-1,"sort":"updated_desc_id_asc"}').toString('base64url'),
      Buffer.from('{"v":1,"offset":0,"sort":"id"}').toString('base64url'),
      Buffer.from('[1,2,3]').toString('base64url'),
      Buffer.from('"string"').toString('base64url'),
    ];
    for (const cursor of cases) {
      const res = await request(h.baseUrl, `/api/v1/sessions?cursor=${encodeURIComponent(cursor)}`);
      assert.equal(res.status, 400, `cursor ${cursor} must be refused`);
      assert.equal(res.body.error.code, 'INVALID_CURSOR');
    }
  } finally {
    await h.close();
  }
});

test('a limit larger than the remaining rows yields no cursor', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions?limit=50');
    assert.equal(res.body.page.has_more, false);
    assert.equal(res.body.page.next_cursor, null);
    assert.equal(res.body.page.total, 3);
  } finally {
    await h.close();
  }
});

test('the HTTP layer enumerates through the service, never the adapter directly', async () => {
  // Originally (§13) this asserted ZERO adapter calls, because the route served the tracked
  // store. R8C.1 deliberately changed that semantic: `GET /api/v1/sessions` now enumerates the
  // DSH inventory. The property worth guarding is therefore no longer "never calls the
  // adapter" — it is "never calls the adapter ITSELF". The enumeration must come from
  // SessionsService, and the route must not reach past it.
  const h = await startFixtureServer();
  try {
    let adapterCalls = 0;
    const original = h.adapter.listSessions;
    h.adapter.listSessions = async (...args) => {
      adapterCalls += 1;
      return original.apply(h.adapter, args);
    };

    // Count service-level enumerations too, so the route cannot bypass the service.
    let serviceFreshCalls = 0;
    const originalListFresh = h.sessionsService.listFresh.bind(h.sessionsService);
    h.sessionsService.listFresh = async (...args) => {
      serviceFreshCalls += 1;
      return originalListFresh(...args);
    };

    const response = await request(h.baseUrl, '/api/v1/sessions');
    assert.equal(response.status, 200);

    // Exactly one enumeration, and it went through the service.
    assert.equal(serviceFreshCalls, 1, 'the route must enumerate via SessionsService.listFresh()');
    assert.equal(adapterCalls, 1, 'exactly one adapter enumeration per list request');
  } finally {
    await h.close();
  }
});
