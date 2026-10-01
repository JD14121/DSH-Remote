/**
 * Strict loopback REST proxy for R8C development and acceptance.
 *
 * ## Why a proxy instead of relaxing CORS
 *
 * The dev UI is served from `127.0.0.1:8099` and the Gateway listens on `127.0.0.1:9445` — two
 * different origins. Rather than widen the Gateway's CORS or origin policy (which R8C §4
 * forbids), the browser talks **same-origin** to `/api/...` on the dev server, which forwards
 * to the fixed loopback Gateway. The browser then never needs cross-origin permission, and the
 * page CSP can stay `connect-src 'self'`.
 *
 * ## The restrictions this module enforces
 *
 * * binds loopback only (the caller's `listen` decides, and the server is only ever started on
 *   `127.0.0.1`);
 * * the target is **fixed** at construction — never taken from the request, so there is no
 *   `Host`-header or query-driven target and no open-proxy behaviour;
 * * path allowlist: only `/api/v1/*` routes R8C actually uses;
 * * method allowlist: `GET`, `POST`, the single session-title `PUT`, and single-session archive `DELETE` routes;
 * * `Authorization` is forwarded but **never logged**;
 * * request and response bodies are never logged, so a multipart upload body cannot leak.
 */

import http from 'node:http';
import net from 'node:net';

/** The only target this proxy will ever contact. */
export const PROXY_TARGET_HOST = '127.0.0.1';
export const PROXY_TARGET_PORT = 9445;

/**
 * The exact paths R8C is permitted to reach, as patterns.
 *
 * `:id` matches one path segment. Anything else is refused with 403 before a socket is opened.
 */
const ALLOWED = [
  /^\/api\/v1\/health$/,
  // R8D: the one-time WS ticket. The response body carries the ticket, so it is forwarded but
  // never buffered or logged — only the failure *kind* is ever written to stderr.
  /^\/api\/v1\/auth\/ws-ticket$/,
  /^\/api\/v1\/sessions$/,
  /^\/api\/v1\/sessions\/[^/]+$/,
  /^\/api\/v1\/sessions\/[^/]+\/messages$/,
  /^\/api\/v1\/sessions\/[^/]+\/cancel$/,
  /^\/api\/v1\/sessions\/[^/]+\/uploads$/,
];

/** The only methods forwarded. */
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

/**
 * The only path this proxy will upgrade to a WebSocket.
 *
 * Exactly one entry. The upgrade path is deliberately narrower than the REST allowlist: this
 * must never become a generic WebSocket proxy, and no arbitrary `Upgrade` header is forwarded.
 */
const ALLOWED_UPGRADE_PATH = /^\/api\/v1\/events$/;

/** Headers needed to perform the handshake. A client-supplied Host is never forwarded. */
const FORWARDED_UPGRADE_HEADERS = ['sec-websocket-protocol', 'sec-websocket-version', 'sec-websocket-key'];

/**
 * Whether a WebSocket upgrade may be forwarded.
 *
 * @param {string} pathname - the request path, without query.
 * @returns {boolean} true when allowed.
 */
export function isAllowedUpgradePath(pathname) {
  return ALLOWED_UPGRADE_PATH.test(pathname);
}

/** Response headers worth returning to the UI. Everything else is dropped. */
const FORWARDED_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'cache-control',
  'x-request-id',
  'retry-after',
]);

/**
 * Whether a path is on the allowlist.
 *
 * @param {string} pathname - the request path, without query.
 * @returns {boolean} true when allowed.
 */
export function isAllowedPath(pathname) {
  return ALLOWED.some((pattern) => pattern.test(pathname));
}

/**
 * Handle one proxy request.
 *
 * @param {http.IncomingMessage} req - the request.
 * @param {http.ServerResponse} res - the response.
 * @param {object} [options] - `targetPort`, `targetHost`, `requestImpl`.
 * @returns {void}
 */
export function handleProxyRequest(req, res, options = {}) {
  const method = String(req.method ?? 'GET').toUpperCase();
  // `req.url` is origin-form; parse it to split path from query without trusting the header.
  const parsed = new URL(req.url ?? '/', `http://${PROXY_TARGET_HOST}`);
  if (!ALLOWED_METHODS.has(method)
    || (['PUT', 'DELETE'].includes(method) && !/^\/api\/v1\/sessions\/[^/]+$/.test(parsed.pathname))) {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }
  if (!isAllowedPath(parsed.pathname)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'path_not_allowed' }));
    return;
  }

  // The target is fixed. Nothing from the request can redirect it.
  const forwarded = {
    host: options.targetHost ?? PROXY_TARGET_HOST,
    port: options.targetPort ?? PROXY_TARGET_PORT,
    method,
    path: `${parsed.pathname}${parsed.search}`,
  };

  // Forward only the headers the API needs. Never a client-supplied Host.
  const headers = { accept: 'application/json' };
  const auth = req.headers.authorization;
  if (typeof auth === 'string') headers.authorization = auth; // forwarded, never logged
  const contentType = req.headers['content-type'];
  if (typeof contentType === 'string') headers['content-type'] = contentType;
  const requestId = req.headers['x-request-id'];
  if (typeof requestId === 'string') headers['x-request-id'] = requestId;

  const upstream = http.request(
    { host: forwarded.host, port: forwarded.port, method: forwarded.method, path: forwarded.path, headers },
    (upstreamRes) => {
      const responseHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (FORWARDED_RESPONSE_HEADERS.has(name.toLowerCase()) && value !== undefined) {
          responseHeaders[name] = value;
        }
      }
      // Additive security headers; they never weaken the Gateway's own policy.
      responseHeaders['x-content-type-options'] = 'nosniff';
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      // Bodies are piped, never buffered or logged — so an upload body cannot be recorded.
      upstreamRes.pipe(res);
    },
  );

  upstream.on('error', (error) => {
    // Log the failure kind only. Never the headers, never the body, never the target URL.
    process.stderr.write(`[r8c-proxy] upstream error: ${error.code ?? 'unknown'}\n`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'gateway_unavailable' }));
    } else {
      res.end();
    }
  });

  req.pipe(upstream);
}

/**
 * Handle one WebSocket upgrade.
 *
 * Registered on the server's `upgrade` event, so it is only reached when a client actually asks
 * to upgrade. A path outside the WS allowlist has its socket destroyed rather than upgraded.
 *
 * @param {http.IncomingMessage} req - the upgrade request.
 * @param {import('node:stream').Duplex} clientSocket - the client's raw socket.
 * @param {Buffer} head - the first packet of the upgraded stream.
 * @param {object} [options] - `targetPort`, `targetHost`.
 * @returns {void}
 */
export function handleProxyUpgrade(req, clientSocket, head, options = {}) {
  const parsed = new URL(req.url ?? '/', `http://${PROXY_TARGET_HOST}`);

  // A path outside the WS allowlist: destroy the socket rather than upgrading anything.
  if (!isAllowedUpgradePath(parsed.pathname)) {
    clientSocket.destroy();
    return;
  }

  const host = options.targetHost ?? PROXY_TARGET_HOST;
  const port = options.targetPort ?? PROXY_TARGET_PORT;

  // The handshake is relayed over a RAW socket, deliberately.
  //
  // Using `http.request({ headers: { upgrade } })` looks equivalent but is not: Node performs the
  // upgrade internally and issues the request a SECOND time, so a one-time ticket is consumed by
  // the first attempt and the second is refused as unknown. Writing `GET … Upgrade` by hand keeps
  // exactly one upgrade request on the wire, which is what the protocol requires.
  const upstreamSocket = net.connect(port, host);

  upstreamSocket.on('connect', () => {
    const lines = [`GET ${parsed.pathname}${parsed.search} HTTP/1.1`];
    // A fixed Host, never one supplied by the client.
    lines.push(`Host: ${host}:${port}`);
    lines.push('Connection: Upgrade');
    lines.push('Upgrade: websocket');
    for (const name of FORWARDED_UPGRADE_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string') {
        const canonical = name.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('-');
        lines.push(`${canonical}: ${value}`);
      }
    }
    // The blank line terminates the header block. WS_KEY is included, so the key header is
    // always present above and this is a well-formed request.
    lines.push('', '');
    upstreamSocket.write(lines.join('\r\n'));

    // The client's first frame, if any, follows the handshake.
    if (head !== undefined && head.length > 0) upstreamSocket.write(head);
  });

  // Relay the upstream's response verbatim — it carries the 101 status and, on refusal, the
  // error status. Nothing is rewritten.
  upstreamSocket.pipe(clientSocket);
  clientSocket.pipe(upstreamSocket);

  const teardown = () => {
    upstreamSocket.destroy();
    clientSocket.destroy();
  };
  upstreamSocket.on('error', teardown);
  clientSocket.on('error', teardown);
  upstreamSocket.on('close', teardown);
  clientSocket.on('close', teardown);
}
