/**
 * R9-RELAY-01 — request policy for the PC TLS bridge.
 *
 * Everything here is a pure decision function so it can be tested exhaustively without a socket.
 * The bridge (ADR-v3 §3) owns exact external authority and origin checks, the route allowlist and
 * header sanitisation; this module is the rules, the bridge is the plumbing.
 *
 * HTTP/1.1 only. No HTTP/2 or HTTP/3 fallback, so there is no alternate framing path that could
 * bypass these checks.
 */

/** The fixture authority. `.invalid` is reserved by RFC 2606, so it can never resolve publicly. */
export const FIXTURE_HOSTNAME = 'relay-fixture.invalid';
/** The single canonical origin for the fixture. */
export const FIXTURE_ORIGIN = `https://${FIXTURE_HOSTNAME}`;

/** Methods that may carry an absent Origin, but only after mTLS and authority validation. */
export const SAFE_METHODS = Object.freeze(['GET', 'HEAD']);

/**
 * The pinned accepted API surface (taskbook §13).
 *
 * `:id` is matched as one path segment. Session creation is admitted only on the exact collection
 * route; the Gateway still validates the empty request and performs its own authentication and
 * durability checks. Anything else remains refused.
 */
export const API_ROUTES = Object.freeze([
  Object.freeze({ method: 'GET', pattern: /^\/api\/v1\/health$/ }),
  Object.freeze({ method: 'GET', pattern: /^\/api\/v1\/agent-presets$/ }),
  Object.freeze({ method: 'GET', pattern: /^\/api\/v1\/models$/ }),
  Object.freeze({ method: 'GET', pattern: /^\/api\/v1\/sessions$/ }),
  Object.freeze({ method: 'POST', pattern: /^\/api\/v1\/sessions$/ }),
  Object.freeze({ method: 'GET', pattern: /^\/api\/v1\/sessions\/[^/]+$/ }),
  Object.freeze({ method: 'PUT', pattern: /^\/api\/v1\/sessions\/[^/]+$/ }),
  Object.freeze({ method: 'PUT', pattern: /^\/api\/v1\/sessions\/[^/]+\/agent-preset$/ }),
  Object.freeze({ method: 'PUT', pattern: /^\/api\/v1\/sessions\/[^/]+\/model$/ }),
  Object.freeze({ method: 'DELETE', pattern: /^\/api\/v1\/sessions\/[^/]+$/ }),
  Object.freeze({ method: 'GET', pattern: /^\/api\/v1\/sessions\/[^/]+\/messages$/ }),
  Object.freeze({ method: 'POST', pattern: /^\/api\/v1\/sessions\/[^/]+\/messages$/ }),
  Object.freeze({ method: 'POST', pattern: /^\/api\/v1\/sessions\/[^/]+\/cancel$/ }),
  Object.freeze({ method: 'POST', pattern: /^\/api\/v1\/sessions\/[^/]+\/uploads$/ }),
  Object.freeze({ method: 'POST', pattern: /^\/api\/v1\/auth\/ws-ticket$/ }),
]);

/** The single WebSocket route. */
export const WS_ROUTE = /^\/api\/v1\/events$/;

/**
 * Headers that must never be forwarded upstream.
 *
 * TLS identity is deliberately NOT converted into a header: a header is spoofable, a verified
 * certificate is not. A later explicit contract would be required to change that.
 */
export const STRIPPED_HEADERS = Object.freeze([
  'origin',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'x-client-cert',
  'x-ssl-client-cert',
  'x-ssl-client-verify',
  'x-ssl-client-s-dn',
  'x-ssl-client-i-dn',
  'x-ssl-client-serial',
  'proxy-authorization',
  'proxy-connection',
  'via',
]);

/**
 * Validate the external Host authority.
 *
 * One canonical authority only. Duplicates, userinfo, absolute-form targets, port variants and
 * forwarded-host substitution are all refused (ADR-v3 §3, taskbook §10).
 *
 * @param {string|string[]|undefined} hostHeader - the raw Host header value(s).
 * @param {object} [options] - `hostname`, `allowPort443`.
 * @returns {{ok: boolean, authority: string|null, reason: string}} the verdict.
 */
export function checkAuthority(hostHeader, options = {}) {
  const hostname = options.hostname ?? FIXTURE_HOSTNAME;
  if (hostHeader === undefined) return { ok: false, authority: null, reason: 'no Host header was present' };
  if (Array.isArray(hostHeader)) return { ok: false, authority: null, reason: 'multiple Host headers were present' };
  const raw = String(hostHeader).trim();
  if (raw.length === 0) return { ok: false, authority: null, reason: 'the Host header was empty' };
  if (raw.includes(',')) return { ok: false, authority: null, reason: 'the Host header contained a list' };
  if (raw.includes('@')) return { ok: false, authority: null, reason: 'the authority contained userinfo, which is not permitted' };

  const lower = raw.toLowerCase();
  // A single canonical authority, optionally with the default port only when explicitly allowed.
  const allowed = options.allowPort443 === true ? [`${hostname}`, `${hostname}:443`] : [hostname];
  if (!allowed.includes(lower)) {
    return { ok: false, authority: null, reason: `the authority was not the single configured one (received a non-matching host)` };
  }
  return { ok: true, authority: lower, reason: 'authority matched the configured host' };
}

/**
 * Validate the request target.
 *
 * Rejects absolute-form targets, which would let a client choose the proxy destination (taskbook §15).
 *
 * @param {string} target - the request target.
 * @returns {{ok: boolean, path: string|null, reason: string}} the verdict.
 */
export function checkTarget(target) {
  if (typeof target !== 'string' || target.length === 0) {
    return { ok: false, path: null, reason: 'no request target was present' };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    return { ok: false, path: null, reason: 'absolute-form request targets are refused so the client cannot choose the destination' };
  }
  if (target.startsWith('//')) {
    return { ok: false, path: null, reason: 'network-path references are refused' };
  }
  if (!target.startsWith('/')) {
    return { ok: false, path: null, reason: 'the request target was not origin-form' };
  }
  if (target.includes(' ')) {
    return { ok: false, path: null, reason: 'the request target contained whitespace' };
  }
  // Keep the path and query separate; the query is not used for routing decisions.
  const [pathPart] = target.split('?');
  return { ok: true, path: pathPart, reason: 'origin-form target accepted' };
}

/**
 * Check the Origin header against the matrix in taskbook §11.
 *
 * @param {object} input - `method`, `isUpgrade`, `origin`, `originCount`.
 * @returns {{ok: boolean, reason: string}} the verdict.
 */
export function checkOrigin(input) {
  const method = String(input.method ?? '').toUpperCase();
  const requiresOrigin = input.isUpgrade === true || !SAFE_METHODS.includes(method);

  if (input.originCount !== undefined && input.originCount > 1) {
    return { ok: false, reason: 'multiple Origin values are refused' };
  }
  const origin = input.origin;

  if (requiresOrigin) {
    if (origin === undefined || origin === null || String(origin).length === 0) {
      return { ok: false, reason: `${input.isUpgrade === true ? 'a WebSocket upgrade' : `the ${method} method`} requires an Origin header` };
    }
    if (String(origin) === 'null') {
      return { ok: false, reason: 'the literal Origin "null" is refused' };
    }
    const expectedOrigin = input.expectedOrigin ?? FIXTURE_ORIGIN;
    if (String(origin) !== expectedOrigin) {
      return { ok: false, reason: 'the Origin did not exactly match the configured HTTPS origin' };
    }
    return { ok: true, reason: 'Origin exactly matched the configured origin' };
  }

  // A safe method may omit Origin, but a present one must still match.
  if (origin === undefined || origin === null || String(origin).length === 0) {
    return { ok: true, reason: 'a safe method may omit Origin after mTLS and authority validation' };
  }
  if (String(origin) === 'null') {
    return { ok: false, reason: 'the literal Origin "null" is refused even on a safe method' };
  }
  const expectedOrigin = input.expectedOrigin ?? FIXTURE_ORIGIN;
  if (String(origin) !== expectedOrigin) {
    return { ok: false, reason: 'a present Origin must still match the configured origin' };
  }
  return { ok: true, reason: 'Origin matched' };
}

/**
 * Cross-site fetch-metadata rejection (taskbook §12).
 *
 * `Sec-Fetch-*` is used only to REJECT clearly cross-site requests. It is never authentication, and
 * a request with the headers absent is allowed through — legitimate clients omit them.
 *
 * @param {object} headers - lowercase header map.
 * @returns {{ok: boolean, reason: string}} the verdict.
 */
export function checkFetchMetadata(headers) {
  const site = headers['sec-fetch-site'];
  if (site === undefined) return { ok: true, reason: 'no fetch metadata was present, which is not treated as a failure' };
  const value = String(site).toLowerCase();
  if (value === 'cross-site') return { ok: false, reason: 'a cross-site fetch-metadata request was refused' };
  return { ok: true, reason: `fetch metadata "${value}" is not cross-site` };
}

/**
 * Match a request against the route allowlist.
 *
 * An unknown `/api/v1/*` path is refused. The bridge never falls back to serving HTML for an API
 * path, so a wrong route can never masquerade as the UI.
 *
 * @param {object} input - `method`, `path`, `isUpgrade`.
 * @returns {{ok: boolean, kind: string|null, reason: string}} the verdict.
 */
export function matchRoute(input) {
  const method = String(input.method ?? '').toUpperCase();
  const path = input.path;

  if (path.startsWith('/api/v1/')) {
    if (input.isUpgrade === true) {
      if (method === 'GET' && WS_ROUTE.test(path)) return { ok: true, kind: 'ws', reason: 'the single WebSocket route matched' };
      return { ok: false, kind: null, reason: 'the upgrade path is not the single accepted WebSocket route' };
    }
    for (const route of API_ROUTES) {
      if (route.method === method && route.pattern.test(path)) {
        return { ok: true, kind: 'api', reason: `matched ${route.method} route` };
      }
    }
    // Distinguish "known path, wrong method" from "unknown path" — both are refused, but the reason
    // differs and that matters for diagnosing a client.
    const pathKnown = API_ROUTES.some((route) => route.pattern.test(path));
    return {
      ok: false,
      kind: null,
      reason: pathKnown ? `the method ${method} is not allowed on this path` : 'the path is not in the accepted API surface',
    };
  }

  if (path.startsWith('/api/')) {
    // Browser modules live under `/api/`, but are not Gateway REST routes. Serve only a
    // manifest-listed JavaScript module as static content; all other `/api/` paths stay closed.
    if (method === 'GET' && input.isUpgrade !== true
      && path.endsWith('.js')
      && input.staticFiles instanceof Set
      && input.staticFiles.has(path.slice(1))) {
      return { ok: true, kind: 'static', reason: 'the JavaScript module is allowlisted by the static UI manifest' };
    }
    if (method === 'HEAD' && input.isUpgrade !== true
      && path.endsWith('.js')
      && input.staticFiles instanceof Set
      && input.staticFiles.has(path.slice(1))) {
      return { ok: true, kind: 'static', reason: 'the JavaScript module is allowlisted by the static UI manifest' };
    }
    return { ok: false, kind: null, reason: 'a non-v1 /api/ path is not a bridge-proxied API route' };
  }

  if (input.isUpgrade === true) {
    return { ok: false, kind: null, reason: 'WebSocket upgrades are not accepted on static UI paths' };
  }

  if (method === 'GET' || method === 'HEAD') {
    return { ok: true, kind: 'static', reason: 'a safe method on a non-API path may be served from the static artifact' };
  }
  return { ok: false, kind: null, reason: `the method ${method} is not allowed on a static path` };
}

/**
 * Compute the upstream header set for a request.
 *
 * A fixed upstream Host is set, external identity and forwarding headers are removed, and only the
 * headers the Gateway needs are forwarded.
 *
 * @param {object} headers - the incoming lowercase header map.
 * @param {object} [options] - `upstreamHost`, `upstreamPort`.
 * @returns {{headers: object, stripped: string[]}} the sanitised headers.
 */
export function sanitizeHeaders(headers, options = {}) {
  const host = options.upstreamHost ?? '127.0.0.1';
  const port = options.upstreamPort ?? 9446;
  const out = {};
  const stripped = [];

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (STRIPPED_HEADERS.includes(lower) && !(lower === 'origin' && options.preserveOrigin === true)) { stripped.push(lower); continue; }
    if (lower === 'host') { stripped.push('host'); continue; }
    out[lower] = value;
  }

  // The upstream Host is fixed and never derived from the client.
  out.host = `${host}:${port}`;
  return { headers: out, stripped };
}

/**
 * Whether a write request may be retried by the bridge.
 *
 * Never. Application retry belongs to the existing R8 contracts (taskbook §19). The bridge must not
 * resend a POST, because a retried ticket request or message send could have already taken effect.
 *
 * @param {string} method - the HTTP method.
 * @returns {boolean} always false.
 */
export function mayRetryWrite(method) {
  void method;
  return false;
}

/** The Content-Security-Policy the production UI is expected to carry (taskbook §25). */
export const PRODUCTION_CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Validate a CSP string retains same-origin semantics.
 *
 * @param {string} csp - the policy.
 * @returns {{ok: boolean, reason: string}} the verdict.
 */
export function checkCsp(csp) {
  if (typeof csp !== 'string' || csp.length === 0) return { ok: false, reason: 'no CSP was set' };
  if (csp.includes('*')) return { ok: false, reason: 'the CSP contained a wildcard' };
  if (!csp.includes("connect-src 'self'")) return { ok: false, reason: "connect-src 'self' must be retained" };
  if (!csp.includes("default-src 'self'")) return { ok: false, reason: "default-src 'self' must be retained" };
  return { ok: true, reason: 'the CSP retains same-origin semantics with no wildcard' };
}
