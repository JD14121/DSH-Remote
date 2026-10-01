/**
 * R8D test harness: a real HTTP + WebSocket fixture Gateway.
 *
 * Built on the already-present `ws` dependency and Node's global `WebSocket` client, so the
 * integration tests exercise a genuine upgrade handshake, genuine frames, and genuine close
 * codes rather than a mocked socket object.
 *
 * It serves the two frozen routes:
 *
 * ```text
 * POST /api/v1/auth/ws-ticket   → a one-time ticket
 * GET  /api/v1/events?ticket=…  → the WebSocket upgrade
 * ```
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';

/**
 * Start a fixture Gateway.
 *
 * @param {object} [options] - `token`, `requireSubprotocol`, `onTicket`.
 * @returns {Promise<object>} the fixture with helpers to drive the protocol.
 */
export async function startWsFixture(options = {}) {
  const token = options.token ?? 'good-token';
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/api/v1/auth/ws-ticket' && req.method === 'POST') {
        if (req.headers.authorization !== `Bearer ${token}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        fixture.ticketsIssued += 1;
        const body = chunks.length > 0 ? String(Buffer.concat(chunks)) : '{}';
        let sessionId = null;
        try { sessionId = JSON.parse(body).session_id ?? null; } catch { sessionId = null; }
        fixture.lastTicketSession = sessionId;
        // Mint a FRESH ticket for every request. Returning a fixed one would hand the client a
        // ticket the first connection already consumed, and the upgrade would be refused.
        const issued = fixture.issueTicket();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ticket: issued, session_id: sessionId, expires_in_seconds: 30 }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  const fixture = {
    server,
    wss,
    token,
    tickets: [],
    ticketsIssued: 0,
    lastTicketSession: null,
    /** Every accepted connection, in order. */
    connections: [],
    /** Every rejected upgrade, for assertions. */
    rejectedUpgrades: [],
    /** Optional hook invoked on each accepted socket. */
    onConnection: options.onConnection ?? null,

    /** Every ticket the server has consumed, in order. */
    consumed: [],

    /**
     * Issue a ticket that the next upgrade must present.
     *
     * @returns {string} the ticket.
     */
    issueTicket() {
      const ticket = `ticket-${this.tickets.length + 1}-${Math.random().toString(36).slice(2)}`;
      this.tickets.push(ticket);
      return ticket;
    },

    /** The most recent connection. */
    get latest() {
      return this.connections[this.connections.length - 1] ?? null;
    },

    /**
     * Send a frame on the most recent connection.
     *
     * `connection.send` serializes, so the frame goes over the wire exactly once.
     *
     * @param {object} frame - the frame.
     * @returns {void}
     */
    send(frame) {
      this.latest?.send(frame);
    },

    /**
     * Send the `replay_complete` boundary on the most recent connection.
     *
     * @param {object} [input] - `sequence`, `mode`, `replayed`.
     * @returns {void}
     */
    completeReplay(input = {}) {
      this.send({
        type: 'replay_complete',
        sequence: input.sequence ?? 0,
        mode: input.mode ?? 'live_only',
        replayed: input.replayed ?? 0,
      });
    },

    /**
     * Close the most recent connection.
     *
     * @param {number} code - the close code.
     * @param {string} [reason] - the reason.
     * @returns {void}
     */
    closeLatest(code = 1000, reason = '') {
      const socket = this.latest?.socket;
      if (socket === undefined || socket === null) return;
      // 1006 is reserved: it means "closed abnormally" and may not be sent as a close code. To
      // simulate a network drop, terminate instead — the peer then observes 1006.
      if (code === 1006 || code === 1005) {
        socket.terminate();
        return;
      }
      socket.close(code, reason);
    },

    /** Stop everything. */
    async stop() {
      for (const connection of this.connections) {
        try { connection.socket.terminate(); } catch { /* already gone */ }
      }
      await new Promise((resolve) => wss.close(resolve));
      // `server.close()` only waits for idle connections; an upgraded socket stays attached to
      // the server and would hold the process open. Destroy them explicitly.
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };

  // A ticket must be issued before any upgrade can succeed.
  fixture.issueTicket();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/api/v1/events') {
      fixture.rejectedUpgrades.push({ reason: 'path', path: url.pathname });
      socket.destroy();
      return;
    }
    const ticket = url.searchParams.get('ticket');
    const sessionId = url.searchParams.get('session_id');
    const rawLast = url.searchParams.get('last_sequence');

    // A ticket is single-use: consuming it removes it.
    const index = fixture.tickets.indexOf(ticket);
    if (index < 0) {
      fixture.rejectedUpgrades.push({ reason: 'unknown-ticket', sessionId });
      socket.destroy();
      return;
    }
    fixture.tickets.splice(index, 1);
    fixture.consumed.push(ticket);

    // The frozen subprotocol is mandatory.
    const requested = String(req.headers['sec-websocket-protocol'] ?? '');
    if (options.requireSubprotocol !== false && !requested.split(',').map((s) => s.trim()).includes('dsh-remote-v1')) {
      fixture.rejectedUpgrades.push({ reason: 'subprotocol', requested });
      socket.destroy();
      return;
    }

    const protocol = requested.split(',').map((s) => s.trim()).find((s) => s === 'dsh-remote-v1');
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connection = {
        socket: ws,
        sessionId,
        lastSequence: rawLast === null ? null : Number(rawLast),
        /** Frames the SERVER sent. */
        sent: [],
        /** Frames the CLIENT sent, so a test can assert on them. */
        received: [],
        closed: false,
        send(frame) {
          this.sent.push(frame);
          ws.send(JSON.stringify(frame));
        },
      };
      fixture.connections.push(connection);
      // Record everything the client sends, so client-side frames are assertable. Previously the
      // harness only tracked outbound frames, so a test could not see the client's own ping.
      ws.on('message', (data) => {
        try {
          connection.received.push(JSON.parse(String(data)));
        } catch {
          connection.received.push({ unparseable: true });
        }
      });
      if (typeof fixture.onConnection === 'function') fixture.onConnection(connection, fixture);
      ws.on('close', () => { connection.closed = true; });
      wss.emit('connection', ws, req, protocol);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fixture.port = server.address().port;
  fixture.baseUrl = `http://127.0.0.1:${fixture.port}`;

  /**
   * Install the connection script.
   *
   * Must be called BEFORE `client.connect()`. An earlier version of several suites called
   * `connect()` and only then assigned `onConnection`, so the server greeted a socket whose
   * handler did not exist yet and the handshake never completed.
   *
   * @param {(connection: object, fixture: object) => void} handler - the script.
   * @returns {void}
   */
  fixture.onConnect = (handler) => {
    fixture.onConnection = handler;
  };

  /**
   * A minimal client-side fetch that talks to this fixture.
   *
   * @param {string} url - the URL.
   * @param {object} init - fetch init.
   * @returns {Promise<object>} the response.
   */
  fixture.fetchImpl = (url, init) => {
    const target = String(url).startsWith('http') ? String(url) : `${fixture.baseUrl}${url}`;
    return globalThis.fetch(target, init);
  };

  return fixture;
}

/**
 * Build a `hello` frame.
 *
 * @param {object} input - `sessionId`, `connectionId`, `latest`, `earliest`, `from`, `mode`.
 * @returns {object} the frame.
 */
export function helloFrame(input = {}) {
  return {
    type: 'hello',
    api_version: 1,
    protocol: 'dsh-remote-v1',
    connection_id: input.connectionId ?? 'conn-1',
    session_id: input.sessionId ?? 's-1',
    server_time: '2026-09-21T02:00:00.000Z',
    sequence: { latest: input.latest ?? 0, earliest_available: input.earliest ?? 0 },
    replay: { requested_from: input.from ?? null, mode: input.mode ?? 'live_only' },
  };
}

/**
 * Build an `event` frame.
 *
 * @param {object} input - `sessionId`, `sequence`, `event`, `data`, `sourceTime`.
 * @returns {object} the frame.
 */
export function eventFrame(input = {}) {
  return {
    type: 'event',
    event: {
      sequence: input.sequence ?? null,
      event: input.event,
      session_id: input.sessionId ?? 's-1',
      source_sequence: input.sourceSequence ?? null,
      source_time: input.sourceTime ?? null,
      data: input.data ?? {},
    },
  };
}

/**
 * Build a `replay_complete` frame.
 *
 * @param {object} input - `sequence`, `mode`, `replayed`.
 * @returns {object} the frame.
 */
export function replayCompleteFrame(input = {}) {
  return { type: 'replay_complete', sequence: input.sequence ?? 0, mode: input.mode ?? 'live_only', replayed: input.replayed ?? 0 };
}

/**
 * Wait until a condition holds.
 *
 * @param {() => boolean} condition - the predicate.
 * @param {number} [timeoutMs] - the timeout.
 * @returns {Promise<void>} resolves, or rejects on timeout.
 */
export async function waitFor(condition, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}
