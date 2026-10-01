/**
 * R8F test harness: every real layer, with only the upstream DSH data controlled.
 *
 * Real `ApiClient`, real `LiveSessionBinding`, real `EventClient`, real `RecoveryController`, real
 * `RealModeController`, and a real HTTP + WebSocket fixture that serves the frozen REST surface.
 * Nothing in the convergence path is mocked — that is the point of R8F.
 *
 * The fixture deliberately mimics the **Gateway's own** semantics, because several R8F questions
 * are really questions about whether the UI respects them:
 *
 * * `POST …/messages` returns `202 Accepted` and does **not** change the domain status
 * * `POST …/cancel` returns `202 Accepted` and does **not** set `cancelled`
 * * `POST …/uploads` returns a file record, and `413` when the server disagrees about size
 */

import { WebSocketServer } from 'ws';
import http from 'node:http';

import { ApiClient } from '../../src/remote/ui/api/api-client.js';
import { RealModeController } from '../../src/remote/ui/api/real-mode.js';
import { CredentialStore, createMemoryStorage } from '../../src/remote/ui/api/credential-store.js';
import { LiveSessionBinding } from '../../src/remote/ui/ws/live-session.js';

/**
 * Start the fixture Gateway.
 *
 * @param {object} [options] - `sessionId`, `status`, `seed`.
 * @returns {Promise<object>} the fixture.
 */
export async function startActionFixture(options = {}) {
  const sessionId = options.sessionId ?? 's-1';
  const state = {
    /** The authoritative domain status the fixture reports. */
    status: options.status ?? 'running',
    /** Queue depth the fixture reports on the next status event. */
    queueDepth: null,
    /** The server-derived sequence watermark. */
    seed: options.seed ?? 10,
    /** REST history returned by `GET …/messages`. */
    history: options.history ?? [
      { id: 'm-1', session_id: sessionId, role: 'user', content: 'hello', sequence: 3 },
      { id: 'm-2', session_id: sessionId, role: 'assistant', content: 'hi', sequence: 4 },
    ],
    /** Every REST request seen, for assertions. */
    requests: [],
    /** Forced status for the next REST response, or 'network' to drop the socket. */
    restStatus: null,
    /** Forced status for the ticket route. */
    ticketStatus: null,
    /** Upload response overrides. */
    uploadStatus: null,
    /** When true, `POST …/cancel` answers 409 — a reachable Gateway refusing the action. */
    cancelConflict: false,
    /** Held response gates, keyed by route fragment. */
    holds: new Map(),
  };

  const tickets = [];
  const fixture = {
    state,
    sessionId,
    tickets,
    consumed: [],
    connections: [],
    rejectedUpgrades: [],
    ticketsIssued: 0,
    onConnection: null,

    issueTicket() {
      const ticket = `t-${tickets.length + 1}-${Math.random().toString(36).slice(2)}`;
      tickets.push(ticket);
      return ticket;
    },

    get latest() {
      return this.connections[this.connections.length - 1] ?? null;
    },

    /**
     * Send a frame on the most recent connection.
     *
     * @param {object} frame - the frame.
     * @returns {void}
     */
    send(frame) {
      this.latest?.send(frame);
    },

    /**
     * Emit an authoritative `session.status` event — the ONLY thing that moves the domain.
     *
     * @param {string} status - the domain status.
     * @param {object} [extra] - additional `data` fields, e.g. `queue_depth`.
     * @returns {number} the sequence used.
     */
    emitStatus(status, extra = {}) {
      state.status = status;
      state.seed += 1;
      this.send({
        type: 'event',
        event: {
          sequence: state.seed,
          event: 'session.status',
          session_id: sessionId,
          source_sequence: null,
          source_time: null,
          data: { status, ...extra },
        },
      });
      return state.seed;
    },

    /**
     * Emit an assistant stream chunk pair.
     *
     * @param {string} attemptId - the attempt identity.
     * @param {number} index - the chunk index.
     * @param {string} text - the chunk text.
     * @returns {void}
     */
    emitChunk(attemptId, index, text) {
      this.send({
        type: 'event',
        event: {
          sequence: null,
          event: 'assistant.delta',
          session_id: sessionId,
          data: { attempt_id: attemptId, index, chunk: { text } },
        },
      });
    },

    /**
     * Emit the stream start for an attempt.
     *
     * @param {string} attemptId - the attempt identity.
     * @returns {void}
     */
    emitStreamStart(attemptId) {
      this.send({
        type: 'event',
        event: {
          sequence: null,
          event: 'assistant.start',
          session_id: sessionId,
          data: { attempt_id: attemptId, turn: 1, step: 1 },
        },
      });
    },

    /**
     * Force a `resync_required` frame.
     *
     * @returns {void}
     */
    emitResyncRequired() {
      this.send({ type: 'resync_required', reason: 'too_old', action: 'refresh_rest_state' });
    },

    /**
     * Arm a hold so a REST route blocks until released.
     *
     * @param {string} fragment - the path fragment to hold.
     * @returns {object} `{ promise, release }`.
     */
    hold(fragment) {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      state.holds.set(fragment, { promise, release });
      return { promise, release };
    },

    /**
     * Close the most recent socket.
     *
     * @param {number} code - the close code.
     * @returns {void}
     */
    closeLatest(code = 1000) {
      const socket = this.latest?.socket;
      if (socket === null || socket === undefined) return;
      if (code === 1006) { socket.terminate(); return; }
      socket.close(code, '');
    },

    /** Stop everything. */
    async stop() {
      for (const connection of this.connections) {
        try { connection.socket.terminate(); } catch { /* gone */ }
      }
      await new Promise((resolve) => wss.close(resolve));
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },

    /** Number of REST calls to a path fragment. */
    countRequests(fragment) {
      return state.requests.filter((r) => r.path.includes(fragment)).length;
    },
  };

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      state.requests.push({ method: req.method, path: url.pathname, search: url.search, auth: req.headers.authorization ?? null });

      // ── ticket ──────────────────────────────────────────────────────────────
      if (url.pathname.endsWith('/ws-ticket')) {
        if (state.ticketStatus !== null) { json(res, state.ticketStatus, { error: 'no' }); return; }
        if (req.headers.authorization !== 'Bearer good-token') { json(res, 401, { error: 'unauthorized' }); return; }
        fixture.ticketsIssued += 1;
        json(res, 200, { ticket: fixture.issueTicket(), session_id: sessionId, expires_in_seconds: 30 });
        return;
      }

      if (req.headers.authorization !== 'Bearer good-token') { json(res, 401, { error: 'unauthorized' }); return; }

      // ── health ──────────────────────────────────────────────────────────────
      if (url.pathname.endsWith('/health')) {
        json(res, 200, { auth: {}, dsh: {}, gateway: {}, persistence: {}, ready: true, status: 'ok' });
        return;
      }

      // ── session list ────────────────────────────────────────────────────────
      if (url.pathname === '/api/v1/sessions') {
        json(res, 200, { api_version: 1, data: [{ id: sessionId, title: 'One', status: state.status, last_sequence: state.seed }], page: {} });
        return;
      }

      // ── cancel ──────────────────────────────────────────────────────────────
      if (url.pathname.endsWith('/cancel')) {
        if (state.cancelConflict) { json(res, 409, { error: 'conflict' }); return; }
        if (state.restStatus === 'network') { req.socket.destroy(); return; }
        if (state.restStatus !== null && state.restStatus !== 200) { json(res, state.restStatus, {}); return; }
        // The Gateway answers 202 and does NOT set the status to cancelled. Mirror that exactly.
        json(res, 202, { api_version: 1, status: 'cancel_requested' });
        return;
      }

      // ── uploads ─────────────────────────────────────────────────────────────
      if (url.pathname.endsWith('/uploads')) {
        if (state.uploadStatus === 'network') { req.socket.destroy(); return; }
        if (state.uploadStatus !== null) { json(res, state.uploadStatus, { error: 'rejected' }); return; }
        json(res, 200, { id: `f-${state.requests.length}`, name: 'upload.bin', kind: 'file', bytes: 12 });
        return;
      }

      const hold = [...state.holds.entries()].find(([fragment]) => url.pathname.includes(fragment));
      if (hold !== undefined) await hold[1].promise;

      // ── messages ────────────────────────────────────────────────────────────
      if (url.pathname.endsWith('/messages')) {
        if (state.restStatus === 'network') { req.socket.destroy(); return; }
        if (state.restStatus !== null && state.restStatus !== 200) { json(res, state.restStatus, {}); return; }
        if (req.method === 'POST') {
          let body = null;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
          // 202 Accepted: the prompt is admitted. The status does NOT change here — only an
          // authoritative event does that.
          json(res, 202, { api_version: 1, status: 'accepted', requestId: body?.requestId ?? null });
          return;
        }
        json(res, 200, { api_version: 1, data: state.history, page: { has_more: false, through_seq: state.seed, next_before_seq: null } });
        return;
      }

      // ── one session ─────────────────────────────────────────────────────────
      if (/^\/api\/v1\/sessions\/[^/]+$/.test(url.pathname)) {
        json(res, 200, { api_version: 1, data: { id: sessionId, title: 'One', status: state.status, last_sequence: state.seed } });
        return;
      }

      json(res, 404, { error: 'not-found' });
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/api/v1/events') { fixture.rejectedUpgrades.push('path'); socket.destroy(); return; }
    const ticket = url.searchParams.get('ticket');
    const index = tickets.indexOf(ticket);
    if (index < 0) { fixture.rejectedUpgrades.push('unknown-ticket'); socket.destroy(); return; }
    tickets.splice(index, 1);
    fixture.consumed.push(ticket);
    const requested = String(req.headers['sec-websocket-protocol'] ?? '');
    if (!requested.split(',').map((s) => s.trim()).includes('dsh-remote-v1')) {
      fixture.rejectedUpgrades.push('subprotocol'); socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connection = {
        socket: ws,
        sessionId: url.searchParams.get('session_id'),
        lastSequence: url.searchParams.get('last_sequence') === null ? null : Number(url.searchParams.get('last_sequence')),
        sent: [],
        received: [],
        closed: false,
        send(frame) { this.sent.push(frame); ws.send(JSON.stringify(frame)); },
      };
      fixture.connections.push(connection);
      ws.on('message', (data) => {
        try { connection.received.push(JSON.parse(String(data))); } catch { connection.received.push({ unparseable: true }); }
      });
      ws.on('close', () => { connection.closed = true; });
      if (typeof fixture.onConnection === 'function') fixture.onConnection(connection, fixture);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fixture.port = server.address().port;
  fixture.baseUrl = `http://127.0.0.1:${fixture.port}`;

  return fixture;
}

/**
 * Compose the real application stack over a fixture — every layer exercised, none mocked.
 *
 * @param {object} [options] - `status`, `seed`, `history`, `sessionId`.
 * @returns {Promise<object>} the composed stack.
 */
export async function actionStack(options = {}) {
  const f = await startActionFixture(options);
  f.onConnection = (connection) => {
    connection.send({ type: 'hello', api_version: 1, protocol: 'dsh-remote-v1', connection_id: 'c1', session_id: connection.sessionId, server_time: null, sequence: { latest: f.state.seed, earliest_available: 0 }, replay: { requested_from: connection.lastSequence, mode: 'live_only' } });
    connection.send({ type: 'replay_complete', sequence: f.state.seed, mode: 'live_only', replayed: 0 });
  };

  const client = new ApiClient({ baseUrl: f.baseUrl, credential: 'good-token', fetchImpl: globalThis.fetch });
  const credentials = new CredentialStore({ storage: createMemoryStorage() });
  credentials.write('good-token');

  const live = new LiveSessionBinding({
    baseUrl: f.baseUrl,
    credential: 'good-token',
    fetchImpl: globalThis.fetch,
    // A very short backoff lets a reconnect happen almost instantly, which makes the
    // `reconnecting` window too narrow to observe reliably. Tests that need to observe the
    // transition pass a long backoff so the disconnected state is stable.
    backoffMs: options.backoffMs ?? [10],
  });
  const owner = new RealModeController({
    client,
    live,
    credentials,
    formDataFactory: () => ({ append() {} }),
    recoveryTimeoutMs: 1500,
  });

  // Surface the socket's connection axis into the controller, exactly as `app.js` does. Without
  // this the harness would hide transport transitions and a test could not observe a disconnect.
  const originalTransport = live.onConnectionChange;
  live.onConnectionChange = (uiState) => {
    if (typeof uiState === 'string' && uiState !== owner.state.connection) {
      owner.updateRecovery({ connection: uiState });
    }
    if (typeof originalTransport === 'function') originalTransport(uiState);
  };

  // Bring the controller up through its real boot path, so auth, health and session loading are
  // all genuinely exercised rather than injected.
  await owner.submitCredential('good-token');
  await owner.selectSession(f.sessionId);

  return {
    f,
    owner,
    client,
    live,
    recovery: owner.recovery,
    get state() { return owner.state; },
    async stop() {
      owner.recovery?.dispose?.();
      live.unbind();
      await f.stop();
    },
  };
}

/**
 * Wait for a condition.
 *
 * @param {() => boolean} condition - the predicate.
 * @param {number} [timeoutMs] - the budget.
 * @returns {Promise<void>} resolves or throws.
 */
export async function waitUntil(condition, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitUntil timed out');
}
