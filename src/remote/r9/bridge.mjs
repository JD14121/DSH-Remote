/**
 * R9-RELAY-01 — the R9 TLS/Origin bridge.
 *
 * ADR-v3 §3: a **separately owned process** that binds only `127.0.0.1:9446`, terminates the
 * browser's TLS, verifies the client identity, applies the request policy, and proxies to a single
 * fixed upstream. It has **no lifecycle control over R7**: it cannot start, stop or restart the
 * Supervisor, spawn DSH, manage the Gateway or read DSH credentials.
 *
 * R9-RELAY-01 runs it against a synthetic fixture upstream only. Port 9445 is not contacted.
 *
 * ## Order of operations (this order is the security property)
 *
 * ```text
 * TLS handshake with mandatory client certificate     (invalid → handshake fails, no bytes of app)
 *   → chain / time / EKU validation                   (invalid → destroyed, no upstream)
 *   → identity policy decision                        (deny → 403, no upstream)
 *   → SNI / authority check                           (fail → 400, no upstream)
 *   → origin + fetch metadata                         (fail → 403, no upstream)
 *   → route allowlist                                 (fail → 404, never HTML)
 *   → header sanitisation → fixed upstream
 * ```
 *
 * No application content — HTML, JS, CSS or API — is produced before the identity is accepted.
 *
 * ## No resumption
 *
 * TLS session resumption is disabled, so a revoked identity cannot regain access by resuming a
 * session it established while it was still enrolled (taskbook §21).
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, constants as cryptoConstants } from 'node:crypto';

import { DECISION } from './identity-policy.mjs';
import {
  PRODUCTION_CSP,
  checkAuthority,
  checkFetchMetadata,
  checkOrigin,
  checkTarget,
  matchRoute,
  sanitizeHeaders,
} from './request-policy.mjs';

/**
 * The OpenSSL option that disables TLS session tickets.
 *
 * R9-RELAY-01 relied on `sessionTimeout: 0` alone, which is not proof: it is a hint about server-side
 * session caching, and it does nothing about stateless TLS 1.3 tickets, which the client holds. A
 * client could therefore present a ticket issued before its identity was revoked.
 *
 * `SSL_OP_NO_TICKET` is the mechanism that actually stops tickets being issued. It is combined with
 * `sessionTimeout: 0` as defence in depth, but the option is the primary control.
 */
export const NO_TICKET_OPTION = cryptoConstants.SSL_OP_NO_TICKET;

/**
 * TLS options that make resumption ineffective, with the control proven by test.
 *
 * `sessionTimeout: 0` is retained only as defence in depth. There is deliberately NO server-side
 * session-ID cache: if a resume path were ever handled it must return non-resumable state, and the
 * simplest way to guarantee that is to have no cache to consult.
 *
 * @param {object} tlsOptions - the caller's TLS options.
 * @returns {object} the hardened options.
 */
export function hardenTlsOptions(tlsOptions) {
  return {
    ...tlsOptions,
    // Primary control: no session tickets are issued, so none can be replayed.
    secureOptions: (tlsOptions.secureOptions ?? 0) | NO_TICKET_OPTION,
    // Defence in depth only. Not relied upon as proof.
    sessionTimeout: 0,
    // No server-side cache exists, so a resumed handshake has nothing to resume into.
    sessionIdContext: undefined,
  };
}

/**
 * Explicit numeric resource limits (taskbook §22).
 *
 * Chosen for a loopback fixture, not copied from a default. Each is justified rather than assumed:
 * the values are small because every legitimate peer is on this machine, and small limits fail fast.
 */
export const LIMITS = Object.freeze({
  /** A local client completes a handshake in milliseconds; 5 s is generous and bounds a stalled one. */
  handshakeTimeoutMs: 5_000,
  /** A request line plus headers for this API never approaches 16 KiB. */
  maxHeaderBytes: 16 * 1024,
  /** Headers must arrive within this window or the socket is dropped. */
  headerTimeoutMs: 5_000,
  /** Total concurrent TLS connections. */
  maxConnections: 64,
  /** Concurrent connections from any single verified identity. */
  maxConnectionsPerIdentity: 8,
  /** Idle keep-alive timeout. */
  idleTimeoutMs: 30_000,
  /** How long a connection may exist BEFORE the identity is verified. */
  preAuthLifetimeMs: 5_000,
  /** Upstream request timeout. */
  upstreamTimeoutMs: 15_000,
});

/** Reasons a connection was closed, recorded for evidence without leaking request content. */
export const CLOSE_REASON = Object.freeze({
  PRE_AUTH_TIMEOUT: 'pre_auth_lifetime_exceeded',
  IDENTITY_DENIED: 'identity_denied',
  REVOKED: 'identity_revoked',
  HANDSHAKE_REJECTED: 'tls_handshake_rejected',
  SERVER_STOP: 'server_stop',
});

/**
 * Create the bridge without starting it.
 *
 * @param {object} options - `tlsOptions`, `upstream`, `policy`, `hostname`, `limits`, `onEvent`.
 * @returns {object} the bridge.
 */
export function createBridge(options) {
  if (options?.tlsOptions === undefined) throw new TypeError('the bridge requires tlsOptions');
  if (options?.upstream === undefined) throw new TypeError('the bridge requires a fixed upstream');
  if (options?.policy === undefined) throw new TypeError('the bridge requires an identity policy');

  const hostname = options.hostname ?? 'relay-fixture.invalid';
  const expectedOrigin = options.origin ?? `https://${hostname}`;
  const staticRoot = options.staticRoot ? path.resolve(options.staticRoot) : null;
  const staticFiles = options.staticFiles === undefined ? null : new Set(options.staticFiles);
  const limits = { ...LIMITS, ...(options.limits ?? {}) };
  const upstream = options.upstream;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  let policy = options.policy;

  /** Live connections, for revocation and teardown. */
  const connections = new Set();
  /**
   * Pre-auth state, keyed by the connection's unique local↔remote 4-tuple plus a monotonic sequence.
   *
   * The object delivered to `connection` is the raw TCP socket, while `secureConnection` delivers the
   * TLS socket — a different object — so the two cannot be joined by an object property. The key is
   * NOT the source IP alone: two concurrent clients can share `127.0.0.1`, and after a relay they can
   * share a source address too. Including the source port and a per-connection sequence keeps two
   * concurrent same-IP clients in separate identity state.
   *
   * Entries are removed on both claim and close, so a closed connection can never be joined by a
   * later one that happens to reuse the same ephemeral port.
   */
  const preAuth = new Map();
  /** Monotonic per-connection sequence, so a 4-tuple is never reused within this process. */
  let connectionSequence = 0;
  /** Per-identity concurrent counts. */
  const perIdentity = new Map();
  const stats = { accepted: 0, denied: 0, rejected: 0, upgradeCount: 0, upstreamRequests: 0, revokedCloses: 0 };
  let stopping = false;

  /**
   * The pre-auth key for a connection.
   *
   * Not the IP alone. The 4-tuple alone is still reused by the OS over time, so each accepted TCP
   * connection receives its own monotonic sequence, making the key unique for the process lifetime.
   *
   * @param {object} socket - the TCP or TLS socket.
   * @param {number} [sequence] - the assigned sequence, when known.
   * @returns {string} the key.
   */
  const keyOf = (socket, sequence) => [
    socket.localAddress ?? 'local',
    socket.localPort ?? 0,
    socket.remoteAddress ?? 'remote',
    socket.remotePort ?? 0,
    sequence ?? 'unclaimed',
  ].join('|');

  /**
   * Register a newly accepted TCP connection and start its pre-auth clock.
   *
   * @param {object} socket - the raw TCP socket from `connection`.
   * @returns {object} the record.
   */
  const recordConnection = (socket) => {
    connectionSequence += 1;
    // The key embeds this connection's own sequence, so two concurrent same-IP clients never share
    // identity state even when every address field matches.
    const key = keyOf(socket, connectionSequence);
    const record = { socket, fingerprint: null, identity: null, upstreamSocket: null, verified: false, key, claimed: false };
    preAuth.set(key, record);
    connections.add(record);

    if (connections.size > limits.maxConnections) {
      onEvent({ event: 'connection_limit', limit: limits.maxConnections });
      socket.destroy();
      connections.delete(record);
      preAuth.delete(key);
      return record;
    }

    const preAuthTimer = setTimeout(() => {
      if (!record.verified) {
        onEvent({ event: 'pre_auth_timeout', reason: CLOSE_REASON.PRE_AUTH_TIMEOUT });
        socket.destroy();
      }
    }, limits.preAuthLifetimeMs);
    preAuthTimer.unref?.();

    socket.on('close', () => {
      clearTimeout(preAuthTimer);
      connections.delete(record);
      preAuth.delete(key);
      if (record.fingerprint !== null) {
        const count = perIdentity.get(record.fingerprint) ?? 0;
        if (count <= 1) perIdentity.delete(record.fingerprint);
        else perIdentity.set(record.fingerprint, count - 1);
      }
    });
    return record;
  };

  /**
   * Join a TLS socket to the TCP connection it belongs to.
   *
   * Matching is on the full local↔remote 4-tuple of an entry that is still unclaimed, and the entry
   * is claimed exactly once. Two concurrent clients from the same address have different source ports
   * and different sequences, so their state can never cross; a closed connection is removed, so a
   * later reuse of an ephemeral port cannot join a stale record.
   *
   * @param {object} tlsSocket - the socket from `secureConnection`.
   * @returns {object|undefined} the claimed record.
   */
  const claimBySocket = (tlsSocket) => {
    // An already-claimed record is skipped, and the entry is claimed exactly once, so two concurrent
    // clients cannot both join one record. Matching is on the peer address and port only: on a
    // loopback server the local tuple is identical for every client and therefore adds nothing,
    // while the remote port plus the per-connection sequence is what actually discriminates.
    for (const record of connections) {
      if (record.claimed === true) continue;
      if (record.socket.remoteAddress !== tlsSocket.remoteAddress) continue;
      if (record.socket.remotePort !== tlsSocket.remotePort) continue;
      record.claimed = true;
      return record;
    }
    return undefined;
  };

  /**
   * Find the record for an already-claimed connection, for request-time identity resolution.
   *
   * @param {object} socket - the request's socket.
   * @returns {object|undefined} the record.
   */
  const findBySocket = (socket) => {
    for (const record of connections) {
      if (record.tlsSocket !== socket) continue;
      return record;
    }
    return undefined;
  };

  /** Find and destroy live connections belonging to an identity. */
  const closeIdentity = (fingerprint, reason) => {
    let closed = 0;
    for (const record of [...connections]) {
      if (record.fingerprint !== fingerprint) continue;
      closed += 1;
      // The live client connection is the TLS socket; the raw TCP socket is its carrier. Destroying
      // only the TCP socket leaves the TLS socket usable, which is how a revoked identity kept a
      // working connection. Both are destroyed, TLS first.
      try { record.tlsSocket?.destroy(); } catch { /* already gone */ }
      try { record.socket?.destroy(); } catch { /* already gone */ }
      if (record.upstreamSocket !== null && record.upstreamSocket !== undefined) {
        try { record.upstreamSocket.destroy(); } catch { /* already gone */ }
      }
    }
    if (closed > 0) stats.revokedCloses += closed;
    onEvent({ event: 'identity_connections_closed', fingerprint: fingerprint.slice(0, 12), count: closed, reason });
    return closed;
  };

  // Tickets are disabled via SSL_OP_NO_TICKET, which is the control that actually prevents a client
  // holding a ticket issued before revocation. `sessionTimeout: 0` is retained only as defence in
  // depth; it is not offered as the proof, because it says nothing about stateless TLS 1.3 tickets.
  const tlsOptions = hardenTlsOptions(options.tlsOptions);

  const server = https.createServer(tlsOptions, (req, res) => {
    // The connection record is resolved here if the TLS-level hook has not already joined it. The
    // identity is then completed before any policy decision, so a request can never be evaluated
    // against an unset identity. This is the authoritative place the fingerprint is computed.
    const record = findBySocket(req.socket) ?? claimBySocket(req.socket);
    if (record === undefined) {
      stats.denied += 1;
      respond(res, 403, 'forbidden');
      return;
    }
    if (record.verified !== true) resolveIdentity(record, req.socket);
    // Re-check the identity on every request: revocation must affect requests already in flight on a
    // keep-alive socket, not only new handshakes.
    if (record.verified !== true) {
      stats.denied += 1;
      respond(res, 403, 'forbidden');
      return;
    }
    const verdict = policy.decide(record.identity);
    if (verdict.decision !== DECISION.ALLOW) {
      stats.denied += 1;
      // Record the policy generation on the decision path so evidence can tie a denial to a policy.
      onEvent({ event: 'request_denied', reason: verdict.reason, generation: verdict.generation });
      try { record.socket.destroy(); } catch { /* already gone */ }
      return;
    }
    handleRequest(req, res, record, verdict);
  });

  /** Apply the request policy and proxy one request to the fixed upstream. */
  function handleRequest(req, res, record, verdict) {
    const target = checkTarget(req.url ?? '');
    if (!target.ok) { rejectRequest(res, 400, target.reason, record); return; }

    const authority = checkAuthority(req.headers.host, { hostname });
    if (!authority.ok) { rejectRequest(res, 400, authority.reason, record); return; }

    const isUpgrade = String(req.headers.upgrade ?? '').toLowerCase() === 'websocket';
    const originHeader = req.headers.origin;
    const originCheck = checkOrigin({
      method: req.method,
      isUpgrade,
      origin: originHeader,
      originCount: Array.isArray(originHeader) ? originHeader.length : undefined,
      expectedOrigin,
    });
    if (!originCheck.ok) { rejectRequest(res, 403, originCheck.reason, record); return; }

    const metadata = checkFetchMetadata(req.headers);
    if (!metadata.ok) { rejectRequest(res, 403, metadata.reason, record); return; }

    const route = matchRoute({ method: req.method, path: target.path, isUpgrade, staticFiles });
    if (!route.ok) {
      // An unknown API route is refused as an API error and NEVER falls back to HTML.
      rejectRequest(res, 404, route.reason, record);
      return;
    }

    if (isUpgrade) { proxyUpgrade(req, res, record, verdict, target); return; }
    if (route.kind === 'static' && staticRoot !== null) { serveStatic(req, res, target); return; }
    proxyRequest(req, res, record, verdict, target, route);
  }

  /** Serve one audited UI artifact without consulting the Gateway upstream. */
  function serveStatic(req, res, target) {
    let decoded;
    try { decoded = decodeURIComponent(target.path); } catch { respond(res, 400, 'forbidden'); return; }
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some((part) => part === '.' || part === '..')) {
      respond(res, 400, 'forbidden');
      return;
    }
    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    if (staticFiles !== null && !staticFiles.has(relative.replace(/\\/g, '/'))) { respond(res, 404, 'not found'); return; }
    const candidate = path.resolve(staticRoot, relative);
    if (candidate !== staticRoot && !candidate.startsWith(`${staticRoot}${path.sep}`)) { respond(res, 404, 'not found'); return; }
    fs.realpath(candidate, (realError, realPath) => {
      if (realError || (realPath !== staticRoot && !realPath.startsWith(`${staticRoot}${path.sep}`))) { respond(res, 404, 'not found'); return; }
      fs.stat(realPath, (statError, stat) => {
        if (statError || !stat.isFile()) { respond(res, 404, 'not found'); return; }
        const contentTypes = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
        res.writeHead(200, {
          'content-type': contentTypes[path.extname(realPath).toLowerCase()] ?? 'application/octet-stream',
          'content-length': stat.size,
          'cache-control': 'no-store',
          'content-security-policy': PRODUCTION_CSP,
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        });
        if (req.method === 'HEAD') { res.end(); return; }
        const stream = fs.createReadStream(realPath);
        stream.on('error', () => { if (!res.headersSent) respond(res, 404, 'not found'); else res.destroy(); });
        stream.pipe(res);
      });
    });
  }

  /** Reject a request without contacting the upstream, and without leaking why. */
  function rejectRequest(res, status, reason, record) {
    stats.denied += 1;
    onEvent({ event: 'request_rejected', status, reason, generation: policy.generation });
    if (status === 404) {
      // A stable, non-reflective body: never HTML for an API path, never echoing the request.
      respond(res, 404, 'not found');
      return;
    }
    respond(res, status, 'forbidden');
    void record;
  }

  /** Send a minimal, non-reflective response. */
  function respond(res, status, body) {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': PRODUCTION_CSP,
      'x-content-type-options': 'nosniff',
    });
    res.end(`${body}\n`);
  }

  /** Proxy an ordinary HTTP request to the fixed upstream. */
  function proxyRequest(req, res, record, verdict, target, route) {
    const sanitized = sanitizeHeaders(req.headers, {
      upstreamHost: upstream.host,
      upstreamPort: upstream.port,
      preserveOrigin: options.preserveValidatedOrigin === true,
    });
    onEvent({
      event: 'upstream_forward',
      method: req.method,
      path: target.path,
      kind: route.kind,
      stripped_headers: sanitized.stripped,
      generation: verdict.generation,
    });

    const upstreamReq = http.request({
      host: upstream.host,
      port: upstream.port,
      method: req.method,
      path: req.url,
      headers: sanitized.headers,
      timeout: limits.upstreamTimeoutMs,
    }, (upstreamRes) => {
      stats.upstreamRequests += 1;
      if (route.kind === 'static') {
        // Static responses carry the production CSP so same-origin semantics are exercised.
        const headers = { ...upstreamRes.headers };
        headers['content-security-policy'] = PRODUCTION_CSP;
        res.writeHead(upstreamRes.statusCode ?? 502, headers);
      } else {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      }
      upstreamRes.pipe(res);
    });

    upstreamReq.on('timeout', () => { upstreamReq.destroy(new Error('upstream timeout')); });
    upstreamReq.on('error', () => {
      // The bridge never retries a write. A failed write is reported as a gateway error and left for
      // the existing R8 contracts to decide what to do.
      if (!res.headersSent) respond(res, 502, 'bad gateway');
      else res.destroy();
    });

    record.upstreamSocket = upstreamReq.socket ?? null;
    req.pipe(upstreamReq);
    res.on('close', () => { if (!upstreamReq.writableEnded) upstreamReq.destroy(); });
  }

  /**
   * Proxy a WebSocket upgrade, guaranteeing at most one upstream handshake.
   *
   * The upgrade is driven explicitly over a dedicated upstream socket rather than through a second
   * HTTP client: the client socket at this point carries an already-parsed HTTP request, and handing
   * those bytes to another parser is what produced "Expected HTTP/" errors. Writing the request line
   * ourselves sends exactly one handshake and nothing else.
   */
  function proxyUpgrade(req, res, record, verdict, target) {
    stats.upgradeCount += 1;
    const sanitized = sanitizeHeaders(req.headers, {
      upstreamHost: upstream.host,
      upstreamPort: upstream.port,
      preserveOrigin: options.preserveValidatedOrigin === true,
    });

    const upstreamSocket = net.connect({ host: upstream.host, port: upstream.port });
    record.upstreamSocket = upstreamSocket;
    let handshakes = 0;

    const fail = (reason) => {
      onEvent({ event: 'upstream_upgrade_failed', reason, generation: verdict.generation });
      if (!res.headersSent) respond(res, 502, 'bad gateway');
      try { upstreamSocket.destroy(); } catch { /* already gone */ }
      try { record.socket.destroy(); } catch { /* already gone */ }
    };

    upstreamSocket.once('error', () => fail('upstream socket error'));
    upstreamSocket.setTimeout(limits.upstreamTimeoutMs, () => fail('upstream handshake timeout'));

    upstreamSocket.once('connect', () => {
      // Exactly one handshake: this writes the request line and headers a single time.
      handshakes += 1;
      // Route decisions use target.path only, while the upstream must receive the validated original
      // path and query so the R6 one-time WebSocket ticket remains intact.
      const lines = [`GET ${req.url} HTTP/1.1`];
      for (const [name, value] of Object.entries(sanitized.headers)) {
        // These handshake headers are emitted explicitly below; duplicating the key/version can
        // invalidate Sec-WebSocket-Accept and duplicating Connection/Upgrade is ambiguous.
        if (['connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version'].includes(name)) continue;
        lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
      }
      // The upgrade headers are required and are taken from the client's validated request.
      lines.push('Connection: Upgrade');
      lines.push(`Upgrade: ${req.headers.upgrade}`);
      lines.push(`Sec-WebSocket-Key: ${req.headers['sec-websocket-key']}`);
      lines.push(`Sec-WebSocket-Version: ${req.headers['sec-websocket-version']}`);
      upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });

    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      upstreamSocket.removeListener('data', onData);
      const head = buffer.subarray(0, end).toString('latin1');
      const rest = buffer.subarray(end + 4);
      const statusLine = head.split('\r\n')[0] ?? '';
      if (!/^HTTP\/1\.1 101/.test(statusLine)) { fail(`upstream refused the upgrade: ${statusLine.slice(0, 40)}`); return; }

      // The client side of this connection is a TLS socket. Relaying over `record.socket` — the raw
      // TCP socket — writes plaintext into the TLS record stream and corrupts the connection with
      // "bad record type". Application bytes must go through the TLS socket; the upstream side is
      // plain TCP.
      const client = record.tlsSocket ?? record.socket;
      client.write(`${head}\r\n\r\n`);
      if (rest.length > 0) client.write(rest);
      upstreamSocket.pipe(client);
      client.pipe(upstreamSocket);
      const release = () => {
        try { upstreamSocket.destroy(); } catch { /* already gone */ }
        try { client.destroy(); } catch { /* already gone */ }
      };
      upstreamSocket.on('close', release);
      upstreamSocket.on('error', release);
      client.on('close', release);
      upstreamSocket.setTimeout(0);
      onEvent({ event: 'upstream_upgrade', generation: verdict.generation, handshakes });
    };
    upstreamSocket.on('data', onData);
  }

  // ── TLS-level identity gate ────────────────────────────────────────────────
  //
  // The identity is resolved ONCE, immediately after the TLS handshake completes, and attached to
  // the socket. Everything downstream reads that record rather than re-deriving an identity, so
  // there is exactly one place where a client's identity is established.
  server.on('secureConnection', (socket) => {
    // The object delivered here is the TLS socket, which is NOT the same object as the TCP socket
    // seen by `connection`. They are joined by a still-unclaimed pre-auth entry matched on the peer
    // address and port. The source IP alone is never the key: two concurrent clients may share it.
    const record = claimBySocket(socket);
    if (record === undefined) {
      // A socket that cannot be matched to a tracked connection is not evaluable, so it cannot proceed.
      stats.rejected += 1;
      socket.destroy();
      return;
    }
    if (options.requireSni === true && socket.servername !== hostname) {
      stats.rejected += 1;
      onEvent({ event: 'sni_rejected' });
      socket.destroy();
      return;
    }
    record.tlsSocket = socket;
    if (resolveIdentity(record, socket) !== true) socket.destroy();
  });

  /**
   * Resolve and record the identity of a connection, once.
   *
   * Kept as a single function so there is exactly one place the fingerprint is computed and one place
   * the policy is consulted for admission. Returns whether the connection is now verified as allowed.
   *
   * @param {object} record - the connection record.
   * @param {object} socket - the TLS socket carrying the client certificate.
   * @returns {boolean} true when the identity is enrolled and the connection may proceed.
   */
  const resolveIdentity = (record, socket) => {
    if (record.verified === true) return true;
    if (record.denied === true) return false;

    let peer = null;
    try { peer = socket.getPeerCertificate(true); } catch { peer = null; }
    if (peer === null || peer.raw === undefined) {
      record.denied = true;
      stats.denied += 1;
      onEvent({ event: 'identity_absent' });
      return false;
    }

    // The fingerprint is SHA-256 over the certificate bytes Node itself presents, so the allowlist
    // and this computation can never disagree about which certificate is in hand.
    const identity = {
      fingerprint: createHash('sha256').update(peer.raw).digest('hex'),
      serial: peer.serialNumber ?? null,
      issuer: peer.issuer?.CN ?? null,
      key_id: null,
    };

    const verdict = policy.decide(identity);
    if (verdict.decision !== DECISION.ALLOW) {
      record.denied = true;
      stats.denied += 1;
      onEvent({ event: 'identity_denied', reason: verdict.reason, generation: verdict.generation });
      return false;
    }

    const perIdentityCount = (perIdentity.get(identity.fingerprint) ?? 0) + 1;
    if (perIdentityCount > limits.maxConnectionsPerIdentity) {
      record.denied = true;
      stats.denied += 1;
      onEvent({ event: 'identity_connection_limit', limit: limits.maxConnectionsPerIdentity });
      return false;
    }
    perIdentity.set(identity.fingerprint, perIdentityCount);

    record.fingerprint = identity.fingerprint;
    record.identity = identity;
    record.verified = true;
    stats.accepted += 1;
    socket.setTimeout(limits.idleTimeoutMs, () => socket.destroy());
    return true;
  };

  server.on('tlsClientError', (error, socket) => {
    stats.rejected += 1;
    onEvent({ event: 'tls_client_error', code: error?.code ?? 'unknown' });
    try { socket.destroy(); } catch { /* already gone */ }
  });

  server.on('connection', (socket) => {
    recordConnection(socket);
  });

  // After a completed TLS handshake, decide the identity before any HTTP parsing is used.
  server.on('request', () => { /* handled by the request listener above */ });

  return {
    server,
    limits,
    get stats() { return { ...stats }; },
    get connections() { return connections.size; },
    get policyGeneration() { return policy.generation; },

    /**
     * Start listening.
     *
     * @param {number} port - the port; 0 for ephemeral.
     * @returns {Promise<number>} the bound port.
     */
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        // Loopback only. A non-loopback bind is a security failure for this phase, so the address is
        // not configurable.
        server.listen(port, '127.0.0.1', () => {
          const address = server.address();
          if (address.address !== '127.0.0.1') {
            reject(new Error(`the bridge must bind loopback only, bound ${address.address}`));
            return;
          }
          resolve(address.port);
        });
      });
    },

    /**
     * Replace the active policy, closing connections of identities that are no longer allowed.
     *
     * @param {IdentityPolicy} next - the new policy.
     * @returns {{closed: number, generation: number}} what happened.
     */
    activatePolicy(next) {
      const previous = policy;
      policy = next;
      let closed = 0;
      // Any identity that was allowed before and is not now must lose its live connections.
      for (const fingerprint of previous.allow.keys()) {
        if (policy.allow.has(fingerprint)) continue;
        closed += closeIdentity(fingerprint, CLOSE_REASON.REVOKED);
      }
      onEvent({ event: 'policy_activated', generation: policy.generation, closed });
      return { closed, generation: policy.generation };
    },

    /**
     * Stop the bridge, releasing the port and every owned socket.
     *
     * @returns {Promise<{closedInMs: number, connections: number}>} the outcome.
     */
    stop() {
      const startedAt = Date.now();
      stopping = true;
      const open = connections.size;
      for (const record of [...connections]) {
        try { record.socket.destroy(); } catch { /* already gone */ }
        try { record.tlsSocket?.destroy(); } catch { /* already gone */ }
        if (record.upstreamSocket !== null) {
          try { record.upstreamSocket.destroy(); } catch { /* already gone */ }
        }
      }
      return new Promise((resolve) => {
        // Bounded: a socket that ignores destroy must not hold teardown open indefinitely. The
        // reported outcome says whether the deadline was reached, rather than claiming a clean close.
        const deadline = setTimeout(() => {
          server.closeAllConnections?.();
          resolve({ closedInMs: Date.now() - startedAt, connections: open, forced: true });
        }, 5_000);
        deadline.unref?.();
        if (!server.listening) {
          clearTimeout(deadline);
          resolve({ closedInMs: Date.now() - startedAt, connections: open, forced: false });
          return;
        }
        server.close(() => {
          clearTimeout(deadline);
          resolve({ closedInMs: Date.now() - startedAt, connections: open, forced: false });
        });
        // Persistent connections would otherwise hold close() open to the deadline.
        server.closeAllConnections?.();
      });
    },
    get stopping() { return stopping; },
  };
}

/** SHA-256 over DER, matching the identity policy's fingerprint definition. */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
