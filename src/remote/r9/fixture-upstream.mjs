/**
 * R9-RELAY-01 — synthetic fixture upstream (taskbook §5).
 *
 * Stands in for the Gateway so the bridge can be tested with no production component, no real DSH
 * and no credentials. It observes exactly what the taskbook requires:
 *
 *   method · path · Host · Origin presence/absence · which headers were forwarded ·
 *   body length · WebSocket upgrade count
 *
 * It binds loopback only and requires no secrets. Every observation is recorded in memory so a test
 * can assert on what the bridge actually forwarded rather than on what it claimed to.
 *
 * Usage: node scripts/r9relay01-fixture-upstream.mjs
 */

import http from 'node:http';
import { createHash } from 'node:crypto';

/** The loopback port the fixture listens on when run directly. Distinct from production ports. */
export const FIXTURE_UPSTREAM_PORT = 9448;

/** Headers worth recording, so the test can prove stripping happened. */
const OBSERVED_HEADERS = Object.freeze([
  'host',
  'origin',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'x-client-cert',
  'authorization',
  'upgrade',
  'connection',
  'sec-websocket-key',
  'sec-websocket-version',
  'content-type',
  'content-length',
]);

/**
 * Create the fixture upstream without starting it.
 *
 * @param {object} [options] - `runId`.
 * @returns {object} the fixture.
 */
export function createFixtureUpstream(options = {}) {
  const runId = options.runId ?? 'r9relay01-fixture';
  /** Every request the fixture received, in order. */
  const requests = [];
  /** How many WebSocket upgrade handshakes reached the upstream. */
  let upgradeCount = 0;
  /**
   * Live sockets, including ones detached by an upgrade.
   *
   * An upgraded socket is removed from the HTTP server's own connection tracking, so it must be held
   * here or shutdown cannot close it. Registered after the server exists, since it attaches to it.
   */
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    let bodyLength = 0;
    req.on('data', (chunk) => { bodyLength += chunk.length; });
    req.on('end', () => {
      requests.push({
        at: new Date().toISOString(),
        method: req.method,
        path: req.url,
        // Presence and absence are both recorded, because "absent" is the assertion for Origin.
        headers: Object.fromEntries(OBSERVED_HEADERS.map((h) => [h, req.headers[h] ?? null])),
        origin_present: req.headers.origin !== undefined,
        host: req.headers.host ?? null,
        body_length: bodyLength,
        upgrade: false,
      });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(`${JSON.stringify({ fixture: 'r9relay01', run_id: runId, path: req.url })}\n`);
    });
  });

  // Track every socket, including ones later detached by an upgrade.
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  // A WebSocket-style upgrade is counted and completed enough to prove the handshake reached here.
  server.on('upgrade', (req, socket) => {
    upgradeCount += 1;
    requests.push({
      at: new Date().toISOString(),
      method: req.method,
      path: req.url,
      headers: Object.fromEntries(OBSERVED_HEADERS.map((h) => [h, req.headers[h] ?? null])),
      origin_present: req.headers.origin !== undefined,
      host: req.headers.host ?? null,
      body_length: 0,
      upgrade: true,
    });
    // A valid 101 is required for the client to consider the upgrade accepted.
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'));
  });

  return {
    server,
    runId,
    get requests() { return requests; },
    get upgradeCount() { return upgradeCount; },
    /** Forget observations between phases of a test. */
    reset() { requests.length = 0; upgradeCount = 0; },
    /**
     * Start listening on loopback.
     *
     * @param {number} [port] - the port; 0 for ephemeral.
     * @returns {Promise<number>} the bound port.
     */
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    /**
     * Stop and release the port.
     *
     * Upgraded sockets are tracked and destroyed explicitly. `closeAllConnections()` does not cover a
     * socket that has been detached by an upgrade, so relying on it left `close()` pending forever and
     * hung the calling test.
     *
     * @returns {Promise<{closedInMs: number, forcedSockets: number}>} the outcome.
     */
    stop() {
      const startedAt = Date.now();
      const forcedSockets = sockets.size;
      for (const socket of [...sockets]) {
        try { socket.destroy(); } catch { /* already gone */ }
      }
      sockets.clear();
      return new Promise((resolve) => {
        if (!server.listening) { resolve({ closedInMs: Date.now() - startedAt, forcedSockets }); return; }
        const deadline = setTimeout(() => resolve({ closedInMs: Date.now() - startedAt, forcedSockets }), 3_000);
        deadline.unref?.();
        server.close(() => {
          clearTimeout(deadline);
          resolve({ closedInMs: Date.now() - startedAt, forcedSockets });
        });
        server.closeAllConnections?.();
      });
    },
  };
}

// ── CLI entry point ──────────────────────────────────────────────────────────
const isMain = process.argv[1] !== undefined
  && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isMain) {
  const fixture = createFixtureUpstream();
  const port = await fixture.listen(FIXTURE_UPSTREAM_PORT);
  process.stdout.write(`r9-relay-01 fixture upstream on http://127.0.0.1:${port}\n`);
  process.stdout.write('  loopback only; no production component involved\n');
  process.stdout.write('  production ports 3080/3081/9445/9446 are untouched by this process\n');
  const stop = () => { void fixture.stop().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

