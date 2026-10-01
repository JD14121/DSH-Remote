/**
 * A synthetic DshAdapter for the fixture server and for tests.
 *
 * It satisfies exactly the adapter contract and nothing more:
 *
 *   listSessions · getSession · getMessages · sendMessage · subscribe
 *   cancel · subscribeControl · uploadFile · close
 *
 * It performs **no network I/O**, reads no credential, touches no DSH and writes
 * nothing to disk. Every value is synthetic.
 *
 * The usual network entry points are replaced with throwing stubs. That is not
 * security theatre: it makes "this fixture cannot reach the real DSH" a runtime
 * guarantee rather than a claim, so an accidental future edit cannot quietly turn
 * the fixture server into a real client.
 */

import { SessionViewStore } from '../src/remote/state/session-view-store.mjs';
import { GATEWAY_EVENT } from '../src/remote/model/event.mjs';
import { makeSession } from '../src/remote/model/session.mjs';

/**
 * Build a function that refuses to perform network I/O.
 *
 * @param {string} name - the disabled global.
 * @returns {() => never} the throwing stub.
 */
function offlineOnly(name) {
  const stub = () => {
    throw new Error(
      `the fixture adapter is offline-only: ${name} is disabled. `
      + 'Use a real adapter for live DSH access.',
    );
  };
  Object.defineProperty(stub, 'name', { value: `offlineOnly(${name})` });
  return stub;
}

/**
 * Harden the module scope against accidental network use.
 *
 * @returns {Record<string, unknown>} the previous values, for restoration.
 */
export function disableNetwork() {
  const previous = {
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket,
  };
  globalThis.fetch = offlineOnly('fetch');
  if ('WebSocket' in globalThis) globalThis.WebSocket = offlineOnly('WebSocket');
  return previous;
}

/**
 * Restore globals replaced by `disableNetwork`.
 *
 * @param {Record<string, unknown>} previous - the saved values.
 * @returns {void}
 */
export function restoreNetwork(previous) {
  if (previous?.fetch !== undefined) globalThis.fetch = previous.fetch;
  if (previous?.WebSocket !== undefined) globalThis.WebSocket = previous.WebSocket;
}

/** Deterministic fixture session ids. */
export const FIXTURE_SESSIONS = Object.freeze({
  RUNNING: 'session-00000000-0000-0000-0000-000000000001',
  IDLE: 'session-00000000-0000-0000-0000-000000000002',
  BLANK: 'session-00000000-0000-0000-0000-000000000003',
  COLD: 'session-00000000-0000-0000-0000-000000000009',
});

/**
 * A scripted adapter.
 *
 * @param {object} [options] - adapter options.
 * @param {() => number} [options.clock] - injectable clock.
 * @param {number} [options.updatedAt] - fixed `updated_at` epoch for ordering tests.
 * @param {Array<object>} [options.messages] - history to return.
 * @param {object} [options.errors] - per-method errors to raise on demand.
 */
export function createFixtureAdapter(options = {}) {
  const clock = options.clock ?? (() => 1_789_800_000_000);
  const updatedAt = options.updatedAt ?? 1_789_700_000_000;

  const state = {
    /** @type {Map<string, object>} */
    sessions: new Map([
      [FIXTURE_SESSIONS.RUNNING, { running: true, updatedAt: updatedAt + 2000, blank: false }],
      [FIXTURE_SESSIONS.IDLE, { running: false, updatedAt, blank: false }],
      [FIXTURE_SESSIONS.BLANK, { running: false, updatedAt: null, blank: true }],
    ]),
    /** @type {Array<object>} */
    messages: options.messages ?? [
      {
        id: `${FIXTURE_SESSIONS.RUNNING}:40:message`,
        session_id: FIXTURE_SESSIONS.RUNNING,
        role: 'user',
        type: 'message',
        content: 'synthetic user message',
        created_at: new Date(updatedAt + 1000).toISOString(),
        sequence: 40,
      },
      {
        id: `${FIXTURE_SESSIONS.RUNNING}:41:tool_call`,
        session_id: FIXTURE_SESSIONS.RUNNING,
        role: 'tool',
        type: 'tool-call',
        content: { name: 'fs_read', arguments: '{"path":"README.md"}', call_id: 'call-1' },
        created_at: new Date(updatedAt + 1100).toISOString(),
        sequence: 41,
      },
      {
        id: `${FIXTURE_SESSIONS.RUNNING}:42:message`,
        session_id: FIXTURE_SESSIONS.RUNNING,
        role: 'assistant',
        type: 'message',
        content: 'synthetic assistant message',
        created_at: new Date(updatedAt + 1200).toISOString(),
        sequence: 42,
      },
    ],
    /** @type {object[]} */
    controlFrames: [],
    /** @type {Map<string, Function>} */
    listeners: new Map(),
    /** @type {object[]} */
    sentMessages: [],
    /** @type {object[]} */
    cancelled: [],
    /** @type {object[]} */
    uploads: [],
    closed: false,
    errors: options.errors ?? {},
  };

  const adapter = {
    /** @returns {Promise<object[]>} */
    async listSessions() {
      if (state.errors.listSessions !== undefined) throw state.errors.listSessions;
      return [...state.sessions.entries()].map(([id, facts]) => ({
        id,
        title: null,
        status: facts.running ? 'running' : 'idle',
        created_at: null,
        updated_at: facts.updatedAt === null ? null : new Date(facts.updatedAt).toISOString(),
        last_sequence: 0,
        running: facts.running,
      }));
    },

    /** @returns {Promise<object|null>} */
    async getSession(id) {
      const facts = state.sessions.get(id);
      if (facts === undefined) return null;
      return {
        id,
        title: null,
        status: facts.running ? 'running' : 'idle',
        created_at: null,
        updated_at: facts.updatedAt === null ? null : new Date(facts.updatedAt).toISOString(),
        running: facts.running,
      };
    },

    /** @returns {Promise<object>} */
    async getMessages(sessionId, opts = {}) {
      if (state.errors.getMessages !== undefined) throw state.errors.getMessages;
      const limit = opts.maxMessages ?? 50;
      const pool = state.messages.filter((message) => message.session_id === sessionId);
      const sliced = pool.slice(Math.max(0, pool.length - limit));
      return {
        messages: sliced,
        raw: { records: [], hasMore: false },
        throughSeq: sliced.length > 0 ? sliced[sliced.length - 1].sequence : 0,
        hasMore: pool.length > limit,
      };
    },

    /** @returns {Promise<object>} */
    async sendMessage(sessionId, message) {
      if (state.errors.sendMessage !== undefined) throw state.errors.sendMessage;
      state.sentMessages.push({ sessionId, ...message });
      return { accepted: true, requestId: message.client_message_id };
    },

    /** @returns {Promise<object>} */
    async cancel(sessionId) {
      if (state.errors.cancel !== undefined) throw state.errors.cancel;
      state.cancelled.push({ sessionId });
      return { accepted: true, sessionId };
    },

    /** @returns {Promise<object>} */
    async subscribe(sessionId, listener) {
      state.listeners.set(sessionId, listener);
      return { unsubscribe: async () => { state.listeners.delete(sessionId); }, cursor: () => 42 };
    },

    /** @returns {Promise<object>} */
    async subscribeControl(listener) {
      state.controlFrames.push = (frame) => {
        listener(frame);
        return 0;
      };
      return { unsubscribe: async () => { state.controlFrames.push = Array.prototype.push; } };
    },

    /** @returns {Promise<object>} */
    async uploadFile(sessionId, input) {
      if (state.errors.uploadFile !== undefined) throw state.errors.uploadFile;
      const bytes = Array.isArray(input.chunks) ? input.chunks.reduce((sum, chunk) => sum + chunk.length, 0) : 0;
      const receiptId = 'receipt-fixture-0001';
      state.uploads.push({ sessionId, name: input.name ?? null, bytes });
      return {
        receiptId,
        file: { attachmentId: 'attachment-fixture-0001', name: input.name ?? 'upload', bytes },
      };
    },

    /** @returns {Promise<void>} */
    async close() {
      state.closed = true;
    },

    // ── test-only surface ────────────────────────────────────────────────────
    /** @internal */
    _state: state,
  };

  return adapter;
}

/**
 * Seed a view store so sessions exist before the server serves them.
 *
 * @param {object} adapter - a fixture adapter.
 * @param {() => number} [clock] - injectable clock.
 * @returns {SessionViewStore} the seeded store.
 */
export function seedFixtureStore(adapter, clock) {
  const store = new SessionViewStore({ clock });
  for (const [id, facts] of adapter._state.sessions) {
    store.upsertSession(makeSession({
      id,
      status: facts.running ? 'running' : 'idle',
      updatedAt: facts.updatedAt,
    }));
    if (facts.running) {
      store.applySignal(id, { signal: 'RUN_STARTED', sessionId: id });
    }
  }
  return store;
}

export { GATEWAY_EVENT };
