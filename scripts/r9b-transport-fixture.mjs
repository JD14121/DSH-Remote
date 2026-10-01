/**
 * R9B.1 G4 — bounded, isolated transport fixture.
 *
 * A synthetic endpoint that proves the accepted transport reaches *something* and nothing else.
 * It is deliberately NOT production and never becomes production:
 *
 *   * binds `127.0.0.1:9447` only — never 3081/9445/9446/8099, never a wildcard or LAN address
 *   * no credentials, no disk writes, no outbound requests, no production-root access
 *   * no Gateway WS protocol and no repeat of application messages
 *
 * ## Bounded continuous responses (F4)
 *
 * The R9B fixture only served a short GET, which cannot show that an *established* stream stops
 * when a device is revoked: a completed request proves nothing about a live one. This version adds
 * `GET /r9b/stream`, a bounded server-sent stream that emits a synthetic marker and a monotonic
 * sequence once per second, so a revocation test can observe whether new bytes stop arriving.
 *
 * Bounds, all enforced per G4:
 *   * at most 2 concurrent streams; further attempts get 503
 *   * every stream ends after at most 120 s
 *   * a client disconnect clears the timer immediately
 *   * shutdown closes all live streams and releases 9447 within 5 s
 *   * `Cache-Control: no-store`, and a per-run `run_id` so a stale cached response cannot be
 *     mistaken for a fresh success
 *   * error paths never echo the request line, headers or query string
 *
 * Module entry points exist so the automated test can drive it on an ephemeral port without
 * touching 9447 or any production port.
 *
 * Usage: node scripts/r9b-transport-fixture.mjs
 */

import http from 'node:http';
import crypto from 'node:crypto';

/** Maximum concurrent long-lived streams before further attempts are refused. */
export const MAX_CONCURRENT_STREAMS = 2;
/** Hard ceiling on one stream's lifetime, in milliseconds. */
export const STREAM_MAX_MS = 120_000;
/** Emit interval for a stream. */
export const STREAM_TICK_MS = 1_000;
/** How long shutdown may take before it gives up and destroys sockets. */
export const SHUTDOWN_GRACE_MS = 5_000;

/** The canonical loopback host. Both the factory and the CLI must land on exactly this. */
export const LOOPBACK_HOST = '127.0.0.1';

/** The only fixed port the CLI may bind. Tests use 0 (system-assigned). */
export const FIXTURE_PORT = 9447;

/** Ports this fixture must never bind, because they belong to the production stack. */
export const FORBIDDEN_PORTS = Object.freeze([3080, 3081, 9445, 9446, 8099]);

/**
 * Validate the bind host, rejecting anything that is not canonical loopback.
 *
 * Rejection happens before any real `listen`, so a wrong value can never briefly expose the fixture.
 * A hostname, a LAN address, a wildcard or a non-string is refused rather than coerced.
 *
 * @param {unknown} host - the requested host.
 * @returns {string} the canonical host.
 * @throws {TypeError} when the host is not exactly loopback.
 */
export function assertLoopbackHost(host) {
  if (typeof host !== 'string') {
    throw new TypeError(`fixture host must be a string, received ${typeof host}`);
  }
  if (host !== LOOPBACK_HOST) {
    throw new TypeError(
      `fixture host must be exactly ${LOOPBACK_HOST}; refusing ${JSON.stringify(host)} `
      + '(wildcard, LAN, hostname and IPv6 binds are not permitted)',
    );
  }
  return host;
}

/**
 * Validate the bind port, rejecting production ports before any listen.
 *
 * @param {unknown} port - the requested port.
 * @returns {number} the validated port.
 * @throws {TypeError} when the port is not the fixture port or 0.
 */
export function assertFixturePort(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError(`fixture port must be an integer 0-65535, received ${JSON.stringify(port)}`);
  }
  if (FORBIDDEN_PORTS.includes(port)) {
    throw new TypeError(`fixture refuses to bind production port ${port}`);
  }
  if (port !== 0 && port !== FIXTURE_PORT) {
    throw new TypeError(`the fixture may only bind ${FIXTURE_PORT} or an ephemeral 0, received ${port}`);
  }
  return port;
}

/**
 * Resolve injectable timers that cannot exceed the production bounds.
 *
 * L3 requires the 120 s boundary to be exercised through a controllable clock. A test may supply a
 * faster scheduler, but it may NOT raise the allowed maximum: any requested value above
 * {@link STREAM_MAX_MS} or {@link SHUTDOWN_GRACE_MS} is clamped down to the production bound, so
 * injection can only make a test stricter, never the running limit weaker.
 *
 * @param {object} [timers] - `setInterval`, `clearInterval`, `setTimeout`, `clearTimeout`.
 * @returns {object} the resolved timers.
 */
function resolveTimers(timers = {}) {
  return {
    setInterval: timers.setInterval ?? setInterval,
    clearInterval: timers.clearInterval ?? clearInterval,
    setTimeout: timers.setTimeout ?? setTimeout,
    clearTimeout: timers.clearTimeout ?? clearTimeout,
  };
}

/**
 * Clamp a requested duration to its production maximum.
 *
 * @param {unknown} value - the requested duration.
 * @param {number} max - the production maximum.
 * @returns {number} the effective duration.
 */
export function clampDuration(value, max) {
  if (!Number.isFinite(value) || value <= 0) return max;
  return Math.min(value, max);
}

/**
 * Build the fixture server without starting it.
 *
 * @param {object} [options] - `runId`, `host`, `now`.
 * @returns {object} the server, its state and a bounded stop.
 */
export function createFixture(options = {}) {
  const runId = options.runId ?? `r9b1-${crypto.randomUUID()}`;
  // The host is validated, never defaulted into place: an explicit canonical loopback value is
  // required, so no code path can bind a wildcard or LAN address by omission.
  const host = assertLoopbackHost(options.host ?? LOOPBACK_HOST);
  const live = new Set();
  const timers = resolveTimers(options.timers);
  const streamMaxMs = clampDuration(options.streamMaxMs ?? STREAM_MAX_MS, STREAM_MAX_MS);
  const shutdownGraceMs = clampDuration(options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS, SHUTDOWN_GRACE_MS);

  const server = http.createServer((req, res) => {
    // Exact route match. No parsing of the query string is needed, and error paths never echo the
    // request line or headers.
    if (req.method === 'GET' && req.url === '/r9b/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(`${JSON.stringify({ fixture: 'r9b1', run_id: runId, canary: 'R9B1-TRANSPORT-CANARY', at: new Date().toISOString() })}\n`);
      return;
    }

    if (req.method === 'GET' && req.url === '/r9b/stream') {
      if (live.size >= MAX_CONCURRENT_STREAMS) {
        res.writeHead(503, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        res.end('stream limit reached\n');
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });

      let sequence = 0;
      let closed = false;
      /** Release this stream exactly once, clearing its timer. */
      const release = () => {
        if (closed) return;
        closed = true;
        timers.clearInterval(tick);
        timers.clearTimeout(deadline);
        live.delete(release);
      };

      const send = () => {
        if (closed) return;
        sequence += 1;
        res.write(`data: ${JSON.stringify({ run_id: runId, marker: 'R9B1-STREAM', sequence, at: new Date().toISOString() })}\n\n`);
      };

      const tick = timers.setInterval(send, STREAM_TICK_MS);
      // The hard ceiling is independent of the tick, so a stream cannot outlive its bound even if
      // the interval is delayed.
      const deadline = timers.setTimeout(() => {
        if (closed) return;
        res.write(`data: ${JSON.stringify({ run_id: runId, marker: 'R9B1-STREAM-END', sequence })}\n\n`);
        res.end();
        release();
      }, streamMaxMs);

      live.add(release);
      // A disconnect must free the timer immediately, not at the deadline.
      res.on('close', release);
      send();
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.end('not found\n');
  });

  // Track every socket so shutdown can destroy ones that outlive the grace period.
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  /** Idempotence guard for repeated or concurrent stops. */
  let stopped = false;
  /** Only one stop may run at a time; a concurrent call awaits the same outcome. */
  let stopping = null;

  return {
    server,
    runId,
    host,
    get liveStreams() { return live.size; },
    get openSockets() { return sockets.size; },
    /**
     * Start listening.
     *
     * @param {number} port - the fixture port or 0 for an ephemeral one.
     * @returns {Promise<number>} the bound port.
     */
    listen(port) {
      const validated = assertFixturePort(port);
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(validated, host, () => resolve(server.address().port));
      });
    },
    /**
     * Stop within the grace period, closing live streams and releasing the port.
     *
     * The reported numbers are the actions actually taken: destroying a socket because it outlived
     * the grace period is counted as forced, and an ordinary close is not. A run that never bound
     * reports `notStarted`, and a repeated stop is idempotent rather than an error.
     *
     * @returns {Promise<object>} the outcome.
     */
    stop() {
      // A repeated stop is idempotent; a concurrent stop joins the in-flight one. Either way exactly
      // one teardown runs, so no timer is orphaned and no socket is destroyed twice.
      if (stopping !== null) return stopping;
      if (stopped) {
        return Promise.resolve({ alreadyStopped: true, closedInMs: 0, forcedSockets: 0, releasedStreams: 0, listening: false });
      }
      stopped = true;
      stopping = (async () => {
        const startedAt = Date.now();
        const releasedStreams = live.size;
        for (const release of [...live]) release();

        // If the server never bound, there is nothing to close and no port to release.
        if (!server.listening) {
          return {
            notStarted: true, closedInMs: Date.now() - startedAt, forcedSockets: 0, releasedStreams, listening: false,
          };
        }

        return new Promise((resolve) => {
          let forced = 0;
          const destroyAll = () => {
            for (const socket of sockets) { forced += 1; socket.destroy(); }
          };
          const timer = timers.setTimeout(() => {
            // The grace period expired: destroy what remains and report the real count.
            destroyAll();
            finish();
          }, shutdownGraceMs);
          const finish = () => {
            timers.clearTimeout(timer);
            resolve({
              closedInMs: Date.now() - startedAt,
              forcedSockets: forced,
              releasedStreams,
              listening: server.listening,
            });
          };
          server.close(finish);
          // Idle keep-alive sockets would otherwise hold close() open to the grace period, so they
          // are destroyed deliberately and counted as forced rather than misreported as a clean close.
          destroyAll();
        });
      })();
      // Clear the in-flight reference once it settles, so a later stop observes the idempotent path
      // rather than the resolved promise of the first one.
      void stopping.finally(() => { stopping = null; });
      return stopping;
    },
  };
}

// ── CLI entry point ──────────────────────────────────────────────────────────
const isMain = process.argv[1] !== undefined
  && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isMain) {
  const fixture = createFixture();
  await fixture.listen(9447);
  process.stdout.write(`r9b1 fixture on http://${fixture.host}:9447/r9b/health\n`);
  process.stdout.write(`  run_id: ${fixture.runId}\n`);
  process.stdout.write('  routes: GET /r9b/health, GET /r9b/stream (bounded)\n');
  process.stdout.write('  production ports 3081/9445/9446/8099 are untouched by this process\n');

  /** Clean shutdown for the harness. */
  const shutdown = async () => {
    const result = await fixture.stop();
    process.stdout.write(`  stopped in ${result.closedInMs} ms (forced sockets: ${result.forcedSockets})\n`);
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}
