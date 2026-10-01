/**
 * R8C.1 — DSH-wide session discovery.
 *
 * The core regression: `GET /api/v1/sessions` must enumerate the DSH inventory, so a Gateway
 * with an **empty store** and an adapter reporting 37 sessions returns **37** — with no manual
 * `refresh()` anywhere in the test setup. Before R8C.1 the same request returned 0.
 *
 * These tests deliberately go through **real HTTP** against a **real `SessionsService`** and a
 * **real `SessionViewStore`**, with only the `DshAdapter` controlled. Testing by calling the
 * service method directly would not prove the route uses enumeration.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createRemoteHttpServer } from '../../src/remote/server.mjs';
import { SessionsService } from '../../src/remote/sessions.mjs';
import { MessagesService } from '../../src/remote/messages.mjs';
import { EventsService } from '../../src/remote/events.mjs';
import { StatusService } from '../../src/remote/status-service.mjs';
import { SessionViewStore } from '../../src/remote/state/session-view-store.mjs';
import { resolveHttpConfig } from '../../src/remote/http/config.mjs';
import { request } from './r3-helpers.mjs';
import { mount } from '../../src/remote/ui/app.js';
import { createTestDocument } from './r8b-dom.mjs';

const CLOCK = () => 1_789_800_000_000;

/**
 * An adapter whose session list is under test control.
 *
 * @param {object} [options] - `sessions`, `failWith`.
 * @returns {object} the adapter plus its call counter.
 */
function controlledAdapter(options = {}) {
  const state = {
    sessions: options.sessions ?? [],
    failWith: options.failWith ?? null,
    listCalls: 0,
    /** Resolvers to release a deferred enumeration, for the stampede test. */
    gate: null,
  };
  return {
    state,
    async listSessions() {
      state.listCalls += 1;
      if (state.gate !== null) await state.gate;
      if (state.failWith !== null) throw state.failWith;
      return state.sessions;
    },
    // The session route needs nothing else; other routes are present but unused here.
    async getSession() { return null; },
    async listMessages() { return []; },
    async sendMessage() { return { accepted: true }; },
    async cancel() { return { cancelled: true }; },
    async health() { return { status: 'ready' }; },
  };
}

/** Build N adapter summaries with distinct ids. */
function summaries(count, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    id: `dsh-session-${String(offset + index + 1).padStart(3, '0')}`,
    title: `Session ${offset + index + 1}`,
    running: index === 0,
    updated_at: new Date(1_789_000_000_000 + index * 1000).toISOString(),
  }));
}

/**
 * Start a real HTTP server with an empty store and a controlled adapter.
 *
 * @param {object} [options] - adapter options.
 * @returns {Promise<object>} the running fixture.
 */
async function startDiscoveryServer(options = {}) {
  const adapter = controlledAdapter(options);
  // Deliberately EMPTY: this is the production condition that produced the finding.
  const store = new SessionViewStore({ clock: CLOCK });
  const sessionsService = new SessionsService({ adapter, store, clock: CLOCK });
  const eventsService = new EventsService({ adapter, store, clock: CLOCK });
  const messagesService = new MessagesService({ adapter, store, clock: CLOCK });
  const statusService = new StatusService({ adapter, eventsService, clock: CLOCK });

  const server = createRemoteHttpServer({
    sessionsService,
    messagesService,
    eventsService,
    statusService,
    adapter,
    config: resolveHttpConfig({ host: '127.0.0.1', port: 0, dshVersion: '0.1.5-rc.2' }, {}),
    auth: null,
    clock: CLOCK,
    persistence: null,
    healthFacts: () => ({ gateway: 'ready', ready: true, dsh: { status: 'ready', version: '0.1.5-rc.2' } }),
  });

  const address = await server.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    server,
    adapter,
    store,
    sessionsService,
    baseUrl,
    get: (path, opts) => request(baseUrl, path, opts),
    stop: () => server.stop(),
  };
}

test('the core regression: empty store, adapter 37, REST returns 37', async () => {
  const fixture = await startDiscoveryServer({ sessions: summaries(37) });
  try {
    // The production condition: nothing tracked, nothing recovered.
    assert.equal(fixture.store.list().length, 0, 'the store must start empty');
    assert.equal(fixture.adapter.state.listCalls, 0, 'no enumeration may have happened yet');

    // No manual refresh() anywhere in this test.
    const response = await fixture.get('/api/v1/sessions');
    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 37, 'the route must enumerate the DSH inventory');

    // The previous behaviour — the one the R8C finding recorded — must now fail this assertion.
    assert.notEqual(response.body.data.length, 0, 'returning the tracked set would be the old defect');
  } finally {
    await fixture.stop();
  }
});

test('one HTTP request causes exactly one adapter enumeration', async () => {
  const fixture = await startDiscoveryServer({ sessions: summaries(5) });
  try {
    const response = await fixture.get('/api/v1/sessions');
    assert.equal(response.status, 200);
    assert.equal(fixture.adapter.state.listCalls, 1, 'the route must enumerate exactly once');
  } finally {
    await fixture.stop();
  }
});

test('an empty DSH inventory returns 200 with an empty list', async () => {
  const fixture = await startDiscoveryServer({ sessions: [] });
  try {
    const response = await fixture.get('/api/v1/sessions');
    // A successful enumeration of zero is a legitimate answer, not an error.
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, []);
    assert.equal(fixture.adapter.state.listCalls, 1, 'the enumeration still happened');
  } finally {
    await fixture.stop();
  }
});

test('an adapter failure is NOT masked as a stale 200', async () => {
  const fixture = await startDiscoveryServer({
    sessions: summaries(3),
    failWith: Object.assign(new Error('dsh unavailable'), { code: 'DSH_UNAVAILABLE' }),
  });
  try {
    const response = await fixture.get('/api/v1/sessions');
    // The critical property: never report the tracked set as the DSH inventory.
    assert.notEqual(response.status, 200, 'a failed enumeration must not return 200');
    assert.ok(response.status >= 400, `expected an error status, got ${response.status}`);
  } finally {
    await fixture.stop();
  }
});

test('tracked sessions are not duplicated when the adapter reports them again', async () => {
  const fixture = await startDiscoveryServer({ sessions: summaries(37) });
  try {
    // Pre-track three of the sessions the adapter also returns.
    for (const summary of summaries(3)) {
      fixture.store.upsertSession({
        id: summary.id,
        title: summary.title,
        status: 'idle',
        created_at: null,
        updated_at: summary.updated_at,
        last_sequence: 0,
        running: false,
      });
    }
    assert.equal(fixture.store.list().length, 3);

    const response = await fixture.get('/api/v1/sessions');
    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 37, '3 tracked + 37 enumerated must be 37, not 40');

    const ids = response.body.data.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, 'no duplicate session rows');
  } finally {
    await fixture.stop();
  }
});

test('Gateway-owned metadata survives a refresh', async () => {
  const fixture = await startDiscoveryServer({ sessions: summaries(2) });
  try {
    const tracked = summaries(2)[0];
    // Seed a view carrying Gateway-owned state. `last_sequence` is owned by the journal/replay
    // machinery and `title` is learned from a `follow` snapshot — neither is something
    // `adapter.listSessions()` reports, so a refresh must not disturb them. `updated_at` IS an
    // adapter-authoritative field and must be refreshed.
    fixture.store.upsertSession({
      id: tracked.id,
      title: 'learned from a follow snapshot',
      status: 'idle',
      created_at: null,
      updated_at: null,
      last_sequence: 42,
      running: false,
    });
    const before = fixture.store.get(tracked.id);
    assert.equal(before.last_sequence, 42, 'the durable watermark should be seeded');
    assert.equal(before.updated_at, null, 'the adapter-authoritative field should start empty');

    const response = await fixture.get('/api/v1/sessions');
    assert.equal(response.status, 200);

    const after = fixture.store.get(tracked.id);
    assert.equal(after.last_sequence, 42, 'the durable watermark must not be reset by a refresh');
    assert.equal(after.title, 'learned from a follow snapshot', 'a locally learned title must not be erased');
    assert.equal(after.updated_at, tracked.updated_at, 'a DSH-authoritative field should be refreshed');
  } finally {
    await fixture.stop();
  }
});

test('sessions absent from the adapter are not deleted', async () => {
  const fixture = await startDiscoveryServer({ sessions: summaries(2) });
  try {
    // A tracked session the adapter does not return. Absence is not proof of deletion — it
    // could be archived, filtered, or temporarily unavailable — so refresh must not remove it.
    fixture.store.upsertSession({
      id: 'gateway-only-session',
      title: 'tracked but not enumerated',
      status: 'idle',
      created_at: null,
      updated_at: null,
      last_sequence: 7,
      running: false,
    });

    const response = await fixture.get('/api/v1/sessions');
    assert.equal(response.status, 200);
    const ids = response.body.data.map((s) => s.id);
    assert.ok(ids.includes('gateway-only-session'), 'refresh must be additive, never destructive');
    assert.equal(fixture.store.get('gateway-only-session').last_sequence, 7);
  } finally {
    await fixture.stop();
  }
});

test('pagination is applied to the refreshed inventory, not the old store', async () => {
  const fixture = await startDiscoveryServer({ sessions: summaries(37) });
  try {
    const page = await fixture.get('/api/v1/sessions?limit=10');
    assert.equal(page.status, 200);
    assert.equal(page.body.data.length, 10, 'the first page is a slice of the DSH inventory');
    assert.equal(page.body.page.has_more, true);

    const second = await fixture.get('/api/v1/sessions?limit=10&cursor=' + encodeURIComponent(page.body.page.next_cursor));
    assert.equal(second.status, 200);
    assert.equal(second.body.data.length, 10);
    // Pages must not overlap.
    const firstIds = new Set(page.body.data.map((s) => s.id));
    for (const session of second.body.data) {
      assert.equal(firstIds.has(session.id), false, 'pages must not repeat sessions');
    }
  } finally {
    await fixture.stop();
  }
});

test('two sequential requests each reflect the latest adapter inventory', async () => {
  const fixture = await startDiscoveryServer({ sessions: summaries(2) });
  try {
    const first = await fixture.get('/api/v1/sessions');
    assert.equal(first.body.data.length, 2);

    // The DSH inventory grows between requests.
    fixture.adapter.state.sessions = summaries(5);
    const second = await fixture.get('/api/v1/sessions');
    assert.equal(second.body.data.length, 5, 'a second request must re-enumerate, not cache');

    assert.equal(fixture.adapter.state.listCalls, 2, 'one enumeration per request');
  } finally {
    await fixture.stop();
  }
});

test('overlapping enumerations are coalesced rather than stampeded', async () => {
  const fixture = await startDiscoveryServer({ sessions: summaries(4) });
  try {
    // Three HTTP requests do not reliably overlap in this environment — each tends to complete
    // before the next is parsed — so asserting on wall-clock concurrency would test the
    // scheduler, not the guard. Instead the overlap is created deterministically: hold the
    // adapter open, then issue the three service calls the route issues, from one tick.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    fixture.adapter.state.gate = gate;

    const inFlight = [
      fixture.sessionsService.listFresh(),
      fixture.sessionsService.listFresh(),
      fixture.sessionsService.listFresh(),
    ];
    // All three have now reached the guard within the same synchronous tick.
    assert.equal(fixture.adapter.state.listCalls, 1, 'a single enumeration should be shared');
    assert.notEqual(fixture.sessionsService.refreshInFlight, null, 'the in-flight marker must be set');

    release();
    fixture.adapter.state.gate = null;
    const views = await Promise.all(inFlight);
    for (const result of views) assert.equal(result.length, 4, 'every caller sees the same inventory');

    assert.equal(fixture.adapter.state.listCalls, 1, 'overlapping callers must not each enumerate');
    assert.equal(fixture.sessionsService.refreshInFlight, null, 'the marker must be cleared');
  } finally {
    await fixture.stop();
  }
});

test('the route issues one enumeration per request, not two', async () => {
  const fixture = await startDiscoveryServer({ sessions: summaries(3) });
  try {
    await fixture.get('/api/v1/sessions');
    // The defect this guards against is a route that refreshes and then also lazily refreshes
    // through get(), doubling adapter traffic for a single browser load.
    assert.equal(fixture.adapter.state.listCalls, 1);

    await fixture.get('/api/v1/sessions');
    assert.equal(fixture.adapter.state.listCalls, 2, 'each request enumerates exactly once');
  } finally {
    await fixture.stop();
  }
});

test('the REST response shape is unchanged', async () => {
  const fixture = await startDiscoveryServer({ sessions: summaries(1) });
  try {
    const response = await fixture.get('/api/v1/sessions');
    assert.equal(response.status, 200);
    // The same envelope R8C's normalizers already consume.
    assert.equal(response.body.api_version, 1);
    assert.ok(Array.isArray(response.body.data));
    assert.ok(response.body.page !== undefined);
    const session = response.body.data[0];
    for (const key of ['id', 'title', 'status']) {
      assert.ok(key in session, `expected the session projection to carry ${key}`);
    }
  } finally {
    await fixture.stop();
  }
});

test('listFresh is the service method the route depends on', async () => {
  // A structural guarantee: if someone reverts the route to the pure read, this fails.
  const fs = await import('node:fs');
  const source = fs.readFileSync('src/remote/http/routes.mjs', 'utf8');
  const start = source.indexOf('path: `${API_PREFIX}/sessions`');
  assert.ok(start > 0, 'the sessions route should exist');
  const handler = source.slice(start, start + 700);
  assert.match(handler, /listFresh\(\)/, 'the sessions route must enumerate via listFresh()');
  assert.equal(/sessionsService\.list\(\)/.test(handler), false, 'the pure store read must not be used here');
});

test('the opaque cursor walks every page of the inventory without gaps or duplicates', async () => {
  const fixture = await startDiscoveryServer({ sessions: summaries(37) });
  try {
    const ids = [];
    const cursors = [];
    let cursor;
    let pages = 0;

    for (;;) {
      const path = cursor === undefined
        ? '/api/v1/sessions?limit=10'
        : `/api/v1/sessions?limit=10&cursor=${encodeURIComponent(cursor)}`;
      const response = await fixture.get(path);
      assert.equal(response.status, 200);
      pages += 1;
      for (const session of response.body.data) ids.push(session.id);

      if (response.body.page.next_cursor === null) break;
      cursor = response.body.page.next_cursor;
      // A repeated cursor would mean the walk cannot advance.
      assert.equal(cursors.includes(cursor), false, 'the cursor must advance every page');
      cursors.push(cursor);
      assert.ok(pages < 10, 'a 37-session inventory must not take unbounded pages');
    }

    assert.equal(ids.length, 37, 'every session must appear exactly once');
    assert.equal(new Set(ids).size, 37, 'no session may be duplicated across pages');
    assert.equal(pages, 4, '37 sessions at 10 per page is four pages');
  } finally {
    await fixture.stop();
  }
});

test('no UI code calls DSH directly', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (/dsh-adapter|DshAdapter|dsh-routes|dsh-rpc-client/.test(text)) offenders.push(full);
    }
  };
  walk(path.join(process.cwd(), 'src', 'remote', 'ui'));
  assert.deepEqual(offenders, [], `the UI must reach DSH only through the Gateway:\n${offenders.join('\n')}`);
});

/**
 * A deterministic stand-in for RealModeController.
 *
 * It carries the same state shape the real controller exposes to `mountRealMode`'s render and
 * records the async actions the mounted shell dispatches. It performs no transport and never
 * reaches DSH or the Gateway, so these tests observe the app-layer wiring alone.
 *
 * @param {object} [overrides] - state fields to override.
 * @returns {object} the fake controller plus its call counters.
 */
function fakeRealController(overrides = {}) {
  const calls = { newSession: 0, loadOlderMessages: 0 };
  return {
    calls,
    state: {
      domain: 'idle',
      connection: 'connected',
      drawerOpen: true,
      credentialDialogOpen: false,
      credentialState: 'entry',
      settingsOpen: false,
      draft: '',
      queueDepth: 0,
      attachments: [],
      sendState: 'idle',
      error: null,
      cancelState: 'idle',
      resync: 'none',
      sessionUnavailable: null,
      fatal: null,
      sessions: [{ id: 's-1', title: 'Session 1', status: 'idle' }],
      activeSessionId: 's-1',
      messages: [{ id: 'm-1', role: 'user', content: 'hello', kind: 'normal' }],
      messageListStatus: 'loaded',
      hasOlderMessages: false,
      olderMessagesStatus: 'idle',
      creatingSession: false,
      ...overrides,
    },
    credentials: { isRemembered: () => false },
    live: null,
    recovery: null,
    sessionAbort: null,
    async boot() {},
    // Body runs synchronously on call, so the click's effect is observable without awaiting.
    async newSession() { calls.newSession += 1; },
    async loadOlderMessages() { calls.loadOlderMessages += 1; },
  };
}

test('mounted real UI: a click on the rendered New session control invokes controller.newSession()', async () => {
  const doc = createTestDocument();
  const root = doc.createElement('div');
  const controller = fakeRealController();
  const app = await mount({ mode: 'real', doc, root, realController: controller });
  try {
    const button = root.querySelector('#new-session');
    assert.notEqual(button, null, 'the New session control must be rendered');
    assert.equal(button.disabled, false, 'it must be enabled when no create is in flight');

    button.click();
    assert.equal(controller.calls.newSession, 1, 'the click must reach controller.newSession()');
  } finally {
    app.dispose();
  }
});

test('mounted real UI: a failed New session is visible with its diagnostic', async () => {
  const doc = createTestDocument();
  const root = doc.createElement('div');
  const controller = fakeRealController({
    newSessionError: 'The Gateway reported a failure. (UPSTREAM_FAILURE; request req-test)',
  });
  const app = await mount({ mode: 'real', doc, root, realController: controller });
  try {
    const failure = root.querySelector('[data-kind="new-session-error"]');
    assert.notEqual(failure, null, 'the mounted UI must expose create failures');
    assert.equal(failure.getAttribute('role'), 'alert');
    assert.match(failure.textContent, /UPSTREAM_FAILURE; request req-test/);
  } finally {
    app.dispose();
  }
});

test('mounted real UI: a click on the rendered Load older control invokes controller.loadOlderMessages()', async () => {
  const doc = createTestDocument();
  const root = doc.createElement('div');
  // The controller says earlier pages remain, which is what makes the affordance render.
  const controller = fakeRealController({ hasOlderMessages: true, olderMessagesStatus: 'idle' });
  const app = await mount({ mode: 'real', doc, root, realController: controller });
  try {
    const button = root.querySelector('#load-older-messages');
    assert.notEqual(button, null, 'the Load older control must render while older pages remain');
    assert.equal(button.textContent, 'Load older messages');
    assert.equal(button.disabled, false);

    button.click();
    assert.equal(controller.calls.loadOlderMessages, 1, 'the click must reach controller.loadOlderMessages()');
  } finally {
    app.dispose();
  }
});
