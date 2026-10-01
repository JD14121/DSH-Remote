/**
 * R4 test helpers — an ephemeral server with a real WebSocket endpoint.
 *
 * Tests use the **real `ws` client** against a real `ws` server on a real
 * loopback socket, so framing, masking, the handshake and close codes are all
 * exercised as shipped rather than mocked.
 *
 * Backpressure and heartbeat tests deliberately do *not* use real sockets, because
 * §50 and §51 forbid letting network speed or a 25-second wall clock decide a
 * test outcome. Those use the injectable seams instead.
 */

import net from 'node:net';

import { WebSocket } from 'ws';

import { startFixtureServer, request, fixtureClock, FIXTURE_SESSIONS } from './r3-helpers.mjs';
import { PROTOCOL, EVENTS_PATH } from '../../src/remote/ws/protocol.mjs';
import { ManualTimers } from '../../src/remote/ws/heartbeat.mjs';

export { request, fixtureClock, FIXTURE_SESSIONS, PROTOCOL, EVENTS_PATH, ManualTimers };

/** A session id that exists in the fixture set. */
export const SESSION = FIXTURE_SESSIONS.RUNNING;
export const OTHER_SESSION = FIXTURE_SESSIONS.IDLE;

/**
 * Start a fixture server that also serves the WebSocket endpoint.
 *
 * @param {object} [options] - forwarded to `startFixtureServer`.
 * @returns {Promise<object>} the handle, with `wsUrl()` and `connect()` helpers.
 */
export async function startWsServer(options = {}) {
  const handle = await startFixtureServer(options);
  const port = handle.address.port;

  return {
    ...handle,
    port,
    /** Build an events URL. @param {object} [q] - query. @returns {string} the URL. */
    wsUrl(q = {}) {
      const url = new URL(`ws://127.0.0.1:${port}${EVENTS_PATH}`);
      for (const [key, value] of Object.entries(q)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
      return url.toString();
    },
    /**
     * Open a WebSocket and collect frames in order.
     *
     * @param {object} [q] - query parameters, e.g. `{ session_id, last_sequence }`.
     * @param {object} [wsOptions] - `ws` client options.
     * @returns {Promise<object>} a live client handle.
     */
    async connect(q = {}, wsOptions = {}) {
      return openClient(this.wsUrl({ session_id: q.session_id ?? SESSION, ...q }), wsOptions);
    },
    /**
     * Attempt an upgrade with a raw socket, to observe the pre-101 rejection.
     *
     * @param {object} [opts] - request facts.
     * @returns {Promise<{statusLine: string, status: number|null, body: string}>} the raw response.
     */
    async rawUpgrade(opts = {}) {
      const path = opts.path ?? `${EVENTS_PATH}?session_id=${SESSION}`;
      const headers = [
        `Host: ${opts.host ?? `127.0.0.1:${port}`}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', // gitleaks:allow -- reviewed synthetic fixture, not a deployment credential
        `Sec-WebSocket-Version: ${opts.version ?? 13}`,
        ...(opts.origin === undefined ? [] : [`Origin: ${opts.origin}`]),
        ...(opts.subprotocol === undefined ? [] : [`Sec-WebSocket-Protocol: ${opts.subprotocol}`]),
        ...(opts.omitKey === true ? [] : []),
        // R6 needs to present headers the R4 fence never inspected, such as an
        // `Authorization` value, to prove the upgrade path does not accept one as a
        // substitute for a ticket.
        ...(opts.extraHeaders === undefined
          ? []
          : Object.entries(opts.extraHeaders).map(([key, value]) => `${key}: ${value}`)),
      ].filter((line) => !(opts.omitKey === true && line.startsWith('Sec-WebSocket-Key')));

      return rawHttpRequest(port, path, headers);
    },
  };
}

/**
 * Whether a raw response actually switched protocols.
 *
 * Checks the **status line**, not the whole body. Asserting that a body does not
 * contain the substring `101` is wrong: the response echoes request headers, and a
 * loopback `Host` such as `127.0.0.1:10113` contains `101`.
 *
 * @param {{statusLine?: string, status?: number|null}} res - a raw response.
 * @returns {boolean} true when the server answered 101.
 */
export function switchedProtocols(res) {
  if (res?.status === 101) return true;
  return /^HTTP\/1\.1 101\b/.test(res?.statusLine ?? '');
}

/**
 * Send a raw HTTP request and read the response head.
 *
 * @param {number} port - the target port.
 * @param {string} path - the request path.
 * @param {string[]} headers - header lines.
 * @returns {Promise<{statusLine: string, status: number|null, body: string}>} the response.
 */
export function rawHttpRequest(port, path, headers) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(['GET ' + path + ' HTTP/1.1', ...headers, '', ''].join('\r\n'));
    });
    let buffer = '';
    let settled = false;
    let timer = null;

    const finish = () => {
      const statusLine = buffer.split('\r\n')[0] ?? '';
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(statusLine)?.[1] ?? NaN);
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve({ statusLine, status: Number.isFinite(status) ? status : null, body: buffer });
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      // Resolve as soon as the response head is complete. A 101 has no body, so
      // waiting for `end` would mean waiting for the timeout, which makes the
      // suite slow and — under parallel file execution — flaky.
      if (buffer.includes('\r\n\r\n')) {
        finish();
        socket.destroy();
      }
    });

    socket.on('close', finish);
    // Without this the refusal surfaces as an uncaught exception rather than a
    // rejected promise, because `net.connect` emits `error` with no listener.
    socket.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      socket.destroy();
      reject(error);
    });

    // Generous ceiling: this only fires if the peer never answers at all.
    timer = setTimeout(() => {
      socket.destroy();
      finish();
    }, 3000);
  });
}

/**
 * Open a WebSocket client and start collecting frames.
 *
 * @param {string} url - the ws URL.
 * @param {object} [options] - `ws` client options.
 * @returns {Promise<object>} the client handle.
 */
export async function openClient(url, options = {}) {
  const ws = new WebSocket(url, options.protocols ?? PROTOCOL, options);
  /** @type {object[]} */
  const frames = [];
  /** @type {object[]} */
  const pongs = [];
  let closeInfo = null;

  ws.on('message', (data) => {
    try {
      frames.push(JSON.parse(data.toString('utf8')));
    } catch {
      frames.push({ type: '__unparseable__', raw: data.toString('utf8') });
    }
  });
  ws.on('pong', () => pongs.push({ at: Date.now() }));
  ws.on('close', (code, reason) => {
    closeInfo = { code, reason: reason?.toString('utf8') ?? '' };
  });

  const handle = {
    ws,
    frames,
    pongs,
    get closeInfo() {
      return closeInfo;
    },
    /** Frames of one type, in order. @param {string} type - frame type. @returns {object[]} matches. */
    ofType(type) {
      return frames.filter((frame) => frame.type === type);
    },
    /** Event frames' Gateway sequences, in order. @returns {number[]} the sequences. */
    sequences() {
      return frames.filter((frame) => frame.type === 'event').map((frame) => frame.event.sequence);
    },
    /**
     * Wait until a predicate holds.
     *
     * @param {() => boolean} condition - the predicate.
     * @param {number} [timeoutMs] - budget.
     * @param {string} [label] - for the error.
     * @returns {Promise<void>} resolves when satisfied.
     */
    async waitFor(condition, timeoutMs = 3000, label = 'condition') {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (condition()) return;
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for ${label}; frames=[${frames.map((f) => f.type).join(',')}] `
            + `close=${JSON.stringify(closeInfo)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    /**
     * Wait until at least `count` frames of a type have arrived.
     *
     * @param {string} type - frame type.
     * @param {number} [count] - how many.
     * @returns {Promise<void>} resolves when satisfied.
     */
    async waitForType(type, count = 1) {
      return handle.waitFor(() => handle.ofType(type).length >= count, 3000, `${count} x ${type}`);
    },
    /**
     * Wait for the socket to close and return its close info.
     *
     * @param {number} [timeoutMs] - budget.
     * @returns {Promise<object>} `{code, reason}`.
     */
    async waitForClose(timeoutMs = 3000) {
      await handle.waitFor(() => closeInfo !== null, timeoutMs, 'close');
      return closeInfo;
    },
    /** Close the client and wait for the socket to finish. */
    async close() {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
        await handle.waitFor(() => closeInfo !== null, 2000, 'close').catch(() => {});
      } else if (closeInfo === null) {
        ws.terminate?.();
      }
    },
  };

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => {
      reject(new Error(`unexpected upgrade response ${res.statusCode}`));
    });
  });

  return handle;
}

/**
 * Emit a Gateway event for a session through the server's own EventsService.
 *
 * This is the real path: the WS layer only ever sees Gateway Events, never a DSH
 * frame (§2).
 *
 * @param {object} handle - the server handle.
 * @param {string} sessionId - the session.
 * @param {string} eventName - a Gateway event name.
 * @param {object} [data] - payload.
 * @returns {object} the emitted event.
 */
export function emitGatewayEvent(handle, sessionId, eventName, data = {}) {
  return handle.eventsService.emit({ sessionId, event: eventName, data });
}

/**
 * Build a fake socket for backlog and client-session unit tests.
 *
 * @param {object} [options] - options.
 * @param {boolean} [options.manual] - do not auto-complete sends.
 * @param {Error} [options.sendError] - fail sends with this error.
 * @returns {object} the fake socket plus its recorded state.
 */
export function fakeSocket(options = {}) {
  const sent = [];
  const state = {
    sent,
    closes: [],
    terminates: 0,
    pings: 0,
    /** Pending send callbacks, when `manual` is set. */
    pending: [],
    open: true,
  };

  const socket = {
    send(text, done) {
      if (state.closedByUs === true) {
        done?.(new Error('socket closed'));
        return;
      }
      if (options.sendError !== undefined) {
        done?.(options.sendError);
        return;
      }
      sent.push(JSON.parse(text));
      if (options.manual === true) state.pending.push(done);
      else done?.();
    },
    close(code, reason) {
      state.closes.push({ code, reason });
      state.open = false;
      state.closedByUs = true;
    },
    terminate() {
      state.terminates += 1;
      state.open = false;
      state.closedByUs = true;
    },
    ping() {
      state.pings += 1;
    },
    /** Complete the oldest pending send. @param {Error} [error] - optional failure. */
    flushOne(error) {
      const done = state.pending.shift();
      if (done !== undefined) done(error);
    },
    /** Complete every pending send. @param {Error} [error] - optional failure. */
    flushAll(error) {
      // `flushOne` lives on the socket object, not on `state`.
      while (state.pending.length > 0) socket.flushOne(error);
    },
  };

  return { socket, state };
}
