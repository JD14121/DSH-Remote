/**
 * R8C — session loading, the discovery semantics, and the stale-request race.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { RealModeController } from '../../src/remote/ui/api/real-mode.js';
import { ApiClient } from '../../src/remote/ui/api/api-client.js';
import { CredentialStore, createMemoryStorage } from '../../src/remote/ui/api/credential-store.js';
import { normalizeSessionList, normalizeMessageList } from '../../src/remote/ui/api/normalizers.js';

const HEALTH_OK = { status: 200, body: { auth: {}, dsh: {}, gateway: {}, persistence: {}, ready: true, status: 'ok' } };

/** A fake fetch driven by a URL→response map, recording every call. */
function routedFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init.method, signal: init.signal });
    const route = routes[url] ?? routes['*'] ?? { status: 404, body: {} };
    const step = typeof route === 'function' ? await route(url, init) : route;
    if (step.throw !== undefined) throw step.throw;
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      headers: { get: () => null },
      json: async () => step.body,
    };
  };
  return { impl, calls };
}

/** Build a controller whose credential is already accepted. */
function controllerFor(routes) {
  const { impl, calls } = routedFetch(routes);
  const controller = new RealModeController({
    client: new ApiClient({ fetchImpl: impl, credential: 'tok' }),
    credentials: new CredentialStore({ storage: createMemoryStorage() }),
  });
  return { controller, calls };
}

test('the session list status reflects loading, loaded, empty and error', async () => {
  const loaded = controllerFor({
    '/api/v1/health': HEALTH_OK,
    '/api/v1/sessions': { status: 200, body: { items: [{ id: 's-1', title: 'One', status: 'running' }] } },
  });
  await loaded.controller.loadSessions();
  assert.equal(loaded.controller.state.sessionListStatus, 'loaded');
  assert.equal(loaded.controller.state.sessions.length, 1);

  const empty = controllerFor({
    '/api/v1/health': HEALTH_OK,
    '/api/v1/sessions': { status: 200, body: { items: [] } },
  });
  await empty.controller.loadSessions();
  assert.equal(empty.controller.state.sessionListStatus, 'empty', 'zero sessions is a state, not an error');

  const failed = controllerFor({
    '/api/v1/health': HEALTH_OK,
    '/api/v1/sessions': { throw: new TypeError('Failed to fetch') },
  });
  await failed.controller.loadSessions();
  assert.equal(failed.controller.state.sessionListStatus, 'error');
  assert.equal(failed.controller.state.connection, 'gateway_unavailable');
});

test('an empty session list is reported honestly, not as a failure', async () => {
  // This is the exact condition the real Gate B run produced: adapter 37, REST 0.
  const { controller } = controllerFor({
    '/api/v1/health': HEALTH_OK,
    '/api/v1/sessions': { status: 200, body: { items: [], next_cursor: null } },
  });
  await controller.loadSessions();
  assert.equal(controller.state.sessions.length, 0);
  assert.equal(controller.state.sessionListStatus, 'empty');
  assert.equal(controller.state.error, null, 'zero is not an error');
  assert.equal(controller.state.connection, 'connected');
});

test('session selection loads the session and its messages', async () => {
  const { controller, calls } = controllerFor({
    '/api/v1/health': HEALTH_OK,
    '/api/v1/sessions': { status: 200, body: { items: [{ id: 's-1', status: 'running' }] } },
    '/api/v1/sessions/s-1': { status: 200, body: { id: 's-1', title: 'One', status: 'running' } },
    '/api/v1/sessions/s-1/messages': {
      status: 200,
      body: { items: [{ id: 'm-1', role: 'user', content: 'hi', sequence: 1 }, { id: 'm-2', role: 'assistant', content: 'hello', sequence: 2 }] },
    },
  });

  await controller.selectSession('s-1');
  assert.equal(controller.state.messageListStatus, 'loaded');
  assert.equal(controller.state.messages.length, 2);
  assert.equal(controller.state.domain, 'running');
  assert.ok(calls.some((c) => c.url === '/api/v1/sessions/s-1/messages'));
});

test('server message order and identity are preserved exactly', () => {
  const body = {
    items: [
      { id: 'm-3', role: 'assistant', content: 'third', sequence: 30 },
      { id: 'm-1', role: 'user', content: 'first', sequence: 10 },
      { id: 'm-2', role: 'user', content: 'second', sequence: 20 },
    ],
  };
  const { messages } = normalizeMessageList(body);
  // The UI must not re-sort or renumber.
  assert.deepEqual(messages.map((m) => m.id), ['m-3', 'm-1', 'm-2']);
  assert.deepEqual(messages.map((m) => m.sequence), [30, 10, 20]);
});

test('a missing sequence is null rather than invented', () => {
  const { messages } = normalizeMessageList({ items: [{ id: 'm-1', role: 'user', content: 'x' }] });
  assert.equal(messages[0].sequence, null, 'the UI must never synthesise a sequence number');
});

test('a switching session aborts the previous load', async () => {
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });

  const { impl } = routedFetch({
    '/api/v1/health': HEALTH_OK,
    '/api/v1/sessions/s-a': async () => {
      await slow;
      return { status: 200, body: { id: 's-a', status: 'idle' } };
    },
    '/api/v1/sessions/s-a/messages': async () => {
      await slow;
      return { status: 200, body: { items: [{ id: 'a-1', role: 'user', content: 'from A' }] } };
    },
    '/api/v1/sessions/s-b': { status: 200, body: { id: 's-b', status: 'idle' } },
    '/api/v1/sessions/s-b/messages': { status: 200, body: { items: [{ id: 'b-1', role: 'user', content: 'from B' }] } },
  });

  const controller = new RealModeController({
    client: new ApiClient({ fetchImpl: impl, credential: 'tok' }),
    credentials: new CredentialStore({ storage: createMemoryStorage() }),
  });

  const first = controller.selectSession('s-a');
  const second = controller.selectSession('s-b');
  await second;
  // Now let the superseded request finish; it must not overwrite B.
  releaseSlow();
  await first;

  assert.equal(controller.state.activeSessionId, 's-b');
  assert.equal(controller.state.messages.length, 1);
  assert.equal(controller.state.messages[0].id, 'b-1', 'session A overwrote session B');
});

test('an aborted load does not surface as an error', async () => {
  const controller = new RealModeController({
    client: new ApiClient({
      fetchImpl: async (url, init) => {
        if (String(url).includes('/messages')) {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        }
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 's-1', status: 'idle' }) };
      },
      credential: 'tok',
    }),
    credentials: new CredentialStore({ storage: createMemoryStorage() }),
  });

  await controller.selectSession('s-1');
  assert.notEqual(controller.state.connection, 'gateway_unavailable', 'an abort is not an outage');
  assert.equal(controller.state.fatal, null);
});

test('a session that no longer exists is reported as missing', async () => {
  const { controller } = controllerFor({
    '/api/v1/health': HEALTH_OK,
    '/api/v1/sessions/s-gone': { status: 404, body: {} },
    '/api/v1/sessions/s-gone/messages': { status: 404, body: {} },
  });
  await controller.selectSession('s-gone');
  assert.equal(controller.state.messageListStatus, 'error');
  assert.equal(controller.state.connection, 'connected', 'a 404 proves the Gateway is reachable');
});

test('list normalization accepts both a bare array and a paged envelope', () => {
  const bare = normalizeSessionList([{ id: 's-1' }, { id: 's-2' }]);
  assert.equal(bare.sessions.length, 2);

  const paged = normalizeSessionList({ items: [{ id: 's-1' }], next_cursor: 'c-1' });
  assert.equal(paged.sessions.length, 1);
  assert.equal(paged.nextCursor, 'c-1');

  // Entries without an identity are dropped rather than rendered as blanks.
  const mixed = normalizeSessionList({ items: [{ id: 's-1' }, { title: 'no id' }] });
  assert.equal(mixed.sessions.length, 1);
});

test('session titles never expose a filesystem path or internal id as the label', () => {
  const { sessions } = normalizeSessionList({
    items: [{ id: 's-1', title: 'Refactor the supervisor stop path', status: 'running' }],
  });
  assert.equal(sessions[0].title, 'Refactor the supervisor stop path');
  /*
   * UI-R1.5.1 (T1) deliberately changed this fallback: a session with no title no longer falls back
   * to its raw id, because an opaque identifier is not a human label. It falls back to a generic
   * label instead.
   *
   * The assertion below was left asserting the OLD behaviour and directly contradicted this test's
   * own name ("never expose a filesystem path or internal id as the label"). Corrected here to match
   * the accepted R1.5.1 decision; found while running the UI-P0-F8 regression sweep.
   */
  const { sessions: bare } = normalizeSessionList({ items: [{ id: 's-2' }] });
  assert.equal(bare[0].title, 'Untitled session');
  assert.notEqual(bare[0].title, 's-2');
  assert.equal(/[\\/]/.test(bare[0].title), false);
});

test('loadSessions follows the opaque nextCursor across every page and de-duplicates', async () => {
  const { impl, calls } = routedFetch({
    '/api/v1/sessions': {
      status: 200,
      body: { items: [{ id: 's-1' }], page: { next_cursor: 'c-1', has_more: true } },
    },
    '/api/v1/sessions?cursor=c-1': {
      status: 200,
      body: { items: [{ id: 's-2' }], page: { next_cursor: 'c-2', has_more: true } },
    },
    '/api/v1/sessions?cursor=c-2': {
      status: 200,
      body: { items: [{ id: 's-1' }, { id: 's-3' }], page: { next_cursor: null, has_more: false } },
    },
  });
  const controller = new RealModeController({
    client: new ApiClient({ fetchImpl: impl, credential: 'tok' }),
    credentials: new CredentialStore({ storage: createMemoryStorage() }),
  });

  await controller.loadSessions();

  assert.deepEqual(controller.state.sessions.map((s) => s.id), ['s-1', 's-2', 's-3']);
  assert.equal(controller.state.sessionListStatus, 'loaded');
  assert.equal(calls.length, 3, 'every page must be requested exactly once');
});

test('loadSessions stops on a repeated cursor instead of looping forever', async () => {
  const { impl, calls } = routedFetch({
    '/api/v1/sessions': {
      status: 200,
      body: { items: [{ id: 's-1' }], page: { next_cursor: 'loop', has_more: true } },
    },
    '/api/v1/sessions?cursor=loop': {
      status: 200,
      body: { items: [{ id: 's-2' }], page: { next_cursor: 'loop', has_more: true } },
    },
  });
  const controller = new RealModeController({
    client: new ApiClient({ fetchImpl: impl, credential: 'tok' }),
    credentials: new CredentialStore({ storage: createMemoryStorage() }),
  });

  await controller.loadSessions();

  assert.deepEqual(controller.state.sessions.map((s) => s.id), ['s-1', 's-2']);
  assert.equal(calls.length, 2, 'a repeated cursor must terminate the walk');
});

test('a list failure keeps the existing inventory and draft, and marks the list errored', async () => {
  let calls = 0;
  const { impl } = routedFetch({
    '/api/v1/sessions': () => {
      calls += 1;
      if (calls === 1) return { status: 200, body: { items: [{ id: 's-1' }] } };
      return { throw: new TypeError('Failed to fetch') };
    },
  });
  const controller = new RealModeController({
    client: new ApiClient({ fetchImpl: impl, credential: 'tok' }),
    credentials: new CredentialStore({ storage: createMemoryStorage() }),
  });

  await controller.loadSessions();
  assert.equal(controller.state.sessions.length, 1);
  controller.state = { ...controller.state, draftsBySessionId: { 's-1': 'unsent' } };

  await controller.loadSessions();
  assert.equal(controller.state.sessionListStatus, 'error');
  assert.equal(controller.state.draftsBySessionId['s-1'], 'unsent', 'a failed refresh must not prune drafts');
});

test('loadOlderMessages prepends older pages by before_seq and keeps local echoes', async () => {
  const pageLatest = {
    items: [
      { id: 'm-2', role: 'assistant', content: 'two', sequence: 20 },
      { id: 'm-3', role: 'assistant', content: 'three', sequence: 30 },
    ],
    page: { has_more: true, next_before_seq: 20, through_seq: 30 },
  };
  const pageOlder = {
    items: [
      { id: 'm-1', role: 'user', content: 'one', sequence: 10 },
      // Overlaps the latest page: the merge must not render it twice.
      { id: 'm-2', role: 'assistant', content: 'two', sequence: 20 },
    ],
    page: { has_more: false, next_before_seq: 10, through_seq: 20 },
  };

  const { impl, calls } = routedFetch({
    '/api/v1/sessions/s-1': { status: 200, body: { id: 's-1', status: 'running' } },
    '/api/v1/sessions/s-1/messages': (url, init) => {
      if (init.method === 'POST') return { status: 200, body: { status: 'accepted' } };
      return { status: 200, body: pageLatest };
    },
    '/api/v1/sessions/s-1/messages?before_seq=20': { status: 200, body: pageOlder },
  });
  const controller = new RealModeController({
    client: new ApiClient({ fetchImpl: impl, credential: 'tok' }),
    credentials: new CredentialStore({ storage: createMemoryStorage() }),
  });

  await controller.selectSession('s-1');
  assert.equal(controller.state.hasOlderMessages, true);
  assert.equal(controller.state.nextBeforeSequence, 20);

  // A local prompt echo fills DSH's documented user-text gap and must survive paging.
  await controller.send({ content: 'first prompt', mode: 'queue', requestId: 'req-1' });
  const echoId = 's-1:client:req-1';
  assert.equal(controller.state.messages.some((m) => m.id === echoId), true);

  await controller.loadOlderMessages();

  assert.deepEqual(
    controller.state.messages.map((m) => m.id),
    ['m-1', 'm-2', 'm-3', echoId],
    'older messages go in front, overlap is de-duplicated and the echo is retained',
  );
  assert.equal(controller.state.hasOlderMessages, false);
  assert.equal(controller.state.olderMessagesStatus, 'exhausted');
  assert.equal(calls.some((c) => c.url.includes('before_seq=20')), true);
});

test('a failed older page preserves the transcript and reports only the paging substate', async () => {
  const { impl } = routedFetch({
    '/api/v1/sessions/s-1': { status: 200, body: { id: 's-1', status: 'idle' } },
    '/api/v1/sessions/s-1/messages': (url, init) => {
      if (init.method === 'POST') return { status: 200, body: { status: 'accepted' } };
      return {
        status: 200,
        body: {
          items: [{ id: 'm-2', role: 'assistant', content: 'two', sequence: 20 }],
          page: { has_more: true, next_before_seq: 20 },
        },
      };
    },
    '/api/v1/sessions/s-1/messages?before_seq=20': { status: 500, body: {} },
  });
  const controller = new RealModeController({
    client: new ApiClient({ fetchImpl: impl, credential: 'tok' }),
    credentials: new CredentialStore({ storage: createMemoryStorage() }),
  });

  await controller.selectSession('s-1');
  const before = controller.state.messages.map((m) => m.id);

  await controller.loadOlderMessages();

  assert.deepEqual(controller.state.messages.map((m) => m.id), before, 'the visible transcript is untouched');
  assert.equal(controller.state.olderMessagesStatus, 'error');
  assert.equal(controller.state.connection, 'connected', 'a 500 proves the Gateway answered');
});

test('newSession creates, refreshes and selects the created session', async () => {
  const createdId = 'session-00000000-0000-0000-0000-0000000000aa';
  const { impl, calls } = routedFetch({
    '/api/v1/sessions': (url, init) => {
      if (init.method === 'POST') {
        return { status: 201, body: { api_version: 1, data: { id: createdId, status: 'idle' } } };
      }
      return { status: 200, body: { items: [{ id: createdId }], page: { next_cursor: null } } };
    },
    [`/api/v1/sessions/${createdId}`]: { status: 200, body: { id: createdId, status: 'idle' } },
    [`/api/v1/sessions/${createdId}/messages`]: { status: 200, body: { items: [], page: { has_more: false } } },
  });
  const controller = new RealModeController({
    client: new ApiClient({ fetchImpl: impl, credential: 'tok' }),
    credentials: new CredentialStore({ storage: createMemoryStorage() }),
  });

  const result = await controller.newSession();

  assert.equal(result.createdSessionId, createdId);
  assert.equal(controller.state.activeSessionId, createdId);
  assert.equal(controller.state.sessions.some((s) => s.id === createdId), true);
  assert.equal(controller.state.messageListStatus, 'empty');
  assert.equal(calls.some((c) => c.method === 'POST' && c.url === '/api/v1/sessions'), true);
  assert.equal(calls.some((c) => c.url === `/api/v1/sessions/${createdId}`), true);
});

test('newSession leaves history immediately and shows a send-gated blank view while create is pending', async () => {
  const createdId = 'session-00000000-0000-0000-0000-0000000000ab';
  let releaseCreate;
  const createResponse = new Promise((resolve) => { releaseCreate = resolve; });
  const { impl } = routedFetch({
    '/api/v1/sessions': (url, init) => init.method === 'POST'
      ? createResponse
      : { status: 200, body: { items: [{ id: createdId }], page: { next_cursor: null } } },
    [`/api/v1/sessions/${createdId}`]: { status: 200, body: { id: createdId, status: 'idle' } },
    [`/api/v1/sessions/${createdId}/messages`]: { status: 200, body: { items: [], page: { has_more: false } } },
  });
  const controller = new RealModeController({
    client: new ApiClient({ fetchImpl: impl, credential: 'tok' }),
    credentials: new CredentialStore({ storage: createMemoryStorage() }),
  });
  controller.state = {
    ...controller.state,
    activeSessionId: 'historical-session',
    drawerOpen: true,
    messages: [{ id: 'old-message', role: 'user', content: 'old transcript' }],
    messageListStatus: 'loaded',
  };

  const pending = controller.newSession();

  assert.equal(controller.state.drawerOpen, false);
  assert.equal(controller.state.activeSessionId, null);
  assert.deepEqual(controller.state.messages, []);
  assert.equal(controller.state.messageListStatus, 'loading');
  assert.equal(controller.state.creatingSession, true);

  releaseCreate({
    status: 201,
    body: { api_version: 1, data: { id: createdId, status: 'idle' } },
  });
  await pending;

  assert.equal(controller.state.activeSessionId, createdId);
  assert.deepEqual(controller.state.messages, []);
  assert.equal(controller.state.messageListStatus, 'empty');
});

test('newSession surfaces a create failure without changing the selection', async () => {
  const { impl } = routedFetch({
    '/api/v1/sessions': {
      status: 500,
      body: {
        api_version: 1,
        error: {
          code: 'UPSTREAM_FAILURE',
          details: { remoteCode: 'session/create' },
          request_id: 'request-create-test',
        },
      },
    },
    '*': { status: 404, body: {} },
  });
  const controller = new RealModeController({
    client: new ApiClient({ fetchImpl: impl, credential: 'tok' }),
    credentials: new CredentialStore({ storage: createMemoryStorage() }),
  });
  controller.state = {
    ...controller.state,
    activeSessionId: 's-existing',
    messages: [{ id: 'existing-message', role: 'user', content: 'keep this transcript' }],
    messageListStatus: 'loaded',
  };

  await controller.newSession();

  assert.equal(controller.state.activeSessionId, 's-existing');
  assert.equal(controller.state.creatingSession, false);
  assert.deepEqual(controller.state.messages.map((message) => message.id), ['existing-message']);
  assert.equal(controller.state.messageListStatus, 'loaded');
  assert.notEqual(controller.state.error, null);
  assert.equal(
    controller.state.newSessionError,
    'The Gateway reported a failure. The operator can check its log. (UPSTREAM_FAILURE: session/create; request request-create-test)',
  );
});
