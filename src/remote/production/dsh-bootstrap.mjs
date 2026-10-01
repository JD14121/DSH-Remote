/**
 * DSH launch-token parsing and auth-cookie bootstrap — Phase R7 §15, §16, §17, §18.
 *
 * The contract this implements was read from the installed rc.2 package and is
 * recorded, with citations, in `docs/r7-dsh-bootstrap-evidence.md`. Summary:
 *
 * ```text
 * stdout line : dsh web: http://127.0.0.1:3080/?token=<43 base64url>   [(LAN: …)]
 * exchange    : GET /?token=<t>   Host: 127.0.0.1:3080   →   303 + Set-Cookie: dsh-auth-…=…
 * cookie name : dsh-auth-<base64url(sha256(authority))>
 * failure     : a uniform minimal 401
 * ```
 *
 * **The parser is deliberately strict and anchored.** A launch token is 43 characters
 * of base64url — the *same shape* as the Gateway's own Phone token. A parser that
 * scanned for "something that looks like a token" would eventually grab the wrong
 * value, and a parser that accepted the first plausible candidate would accept a
 * *second* one just as happily. So it anchors on the announcement prefix, takes the
 * first URL's `token`, and then requires that everything it found agrees.
 *
 * Every failure is fail-closed: the child is stopped and no adapter is constructed.
 */

import crypto from 'node:crypto';
import http from 'node:http';

import { R7_ERROR, ProductionError } from './production-config.mjs';

/** The announcement prefix emitted by `dsh-web-app`. */
export const ANNOUNCE_PREFIX = 'dsh web:';

/** The exact query parameter name (§16, `TOKEN_QUERY`). */
export const TOKEN_QUERY = 'token';

/** The cookie prefix (`COOKIE_PREFIX`). */
export const COOKIE_PREFIX = 'dsh-auth-';

/** A launch token is 32 random bytes as base64url. */
export const LAUNCH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The read-only DSH endpoint used to prove a cookie works.
 *
 * `session/modelCatalog` is a **unary read taking no required arguments**, so it returns
 * a real answer rather than an argument error. An earlier version probed `/api/version`,
 * which does not exist — DSH answered 404, and treating every 4xx as an auth failure
 * made verification impossible while looking like a credential problem.
 */
export const VERIFY_PATH = '/api/session/modelCatalog';

/** How long to wait for the announcement before giving up (§30). */
export const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 45_000;

/**
 * The outcome of parsing one line.
 */
export class LaunchTokenParser {
  /**
   * @param {object} [options] - parser options.
   * @param {number} [options.timeoutMs] - how long to wait.
   * @param {() => number} [options.clock] - injectable clock (ms).
   */
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
    this.clock = options.clock ?? Date.now;
    /** Every distinct token observed, so a second one is detectable. */
    this.observed = new Set();
    /** Lines that matched the announcement shape but failed validation. */
    this.malformed = [];
    this.startedAt = this.clock();
    this.launchToken = null;
    this.announcement = null;
  }

  /**
   * Feed one stdout line.
   *
   * @param {string} line - the raw line.
   * @returns {{matched: boolean, token: string|null}} the result.
   */
  push(line) {
    const text = String(line ?? '');
    const at = text.indexOf(ANNOUNCE_PREFIX);
    if (at === -1) return { matched: false, token: null };

    const rest = text.slice(at + ANNOUNCE_PREFIX.length);
    // The first URL on the line is authoritative. The ` (LAN: …)` suffix carries the
    // SAME token, so only the first is read — reading both would make one launch look
    // like two observations and trip the "more than one distinct token" rule.
    const token = firstTokenFrom(rest);
    if (token === null) {
      this.malformed.push(text);
      return { matched: false, token: null };
    }

    this.observed.add(token);
    if (this.launchToken === null) {
      this.launchToken = token;
      this.announcement = text;
    }
    return { matched: true, token };
  }

  /**
   * Whether a valid, unambiguous outcome is available.
   *
   * @returns {{ok: true, token: string} | {ok: false, reason: string}} the decision.
   */
  resolve() {
    if (this.observed.size === 0) {
      // A line that looked like an announcement but carried no usable token is
      // reported in preference to the generic message, because it points an operator
      // at the actual problem: the output shape changed.
      if (this.malformed.length > 0) {
        return {
          ok: false,
          reason: `no valid launch token was found in ${this.malformed.length} announcement line(s)`,
        };
      }
      return { ok: false, reason: 'no launch-token announcement was observed' };
    }
    // §16: exactly one. Two distinct tokens in one launch is not a race to pick from;
    // it means the contract is not understood.
    if (this.observed.size > 1) {
      return { ok: false, reason: `${this.observed.size} distinct launch tokens were observed in one launch` };
    }
    return { ok: true, token: this.launchToken };
  }

  /**
   * Whether the timeout has elapsed.
   *
   * @returns {boolean} true when expired.
   */
  expired() {
    return this.clock() - this.startedAt >= this.timeoutMs;
  }

  /**
   * Resolve or raise.
   *
   * @returns {string} the launch token.
   * @throws {ProductionError} `R7_DSH_BOOTSTRAP_TOKEN_UNRESOLVED`.
   */
  require() {
    const decision = this.resolve();
    if (!decision.ok) {
      throw new ProductionError(R7_ERROR.DSH_BOOTSTRAP_TOKEN_UNRESOLVED, decision.reason);
    }
    return decision.token;
  }
}

/**
 * Extract the first `token` query value from the text after the announcement prefix.
 *
 * @param {string} text - the text following `dsh web:`.
 * @returns {string|null} the token, or `null` when absent or malformed.
 */
export function firstTokenFrom(text) {
  const match = /https?:\/\/\S+/.exec(text);
  if (match === null) return null;
  let url;
  try {
    url = new URL(match[0]);
  } catch {
    return null;
  }
  const values = url.searchParams.getAll(TOKEN_QUERY);
  // Exactly one, matching DSH's own requirement (`tokens.length === 1`).
  if (values.length !== 1) return null;
  const token = values[0];
  return LAUNCH_TOKEN_PATTERN.test(token) ? token : null;
}

/**
 * Whether a value has the launch-token shape.
 *
 * @param {unknown} value - the candidate.
 * @returns {boolean} true when valid.
 */
export function isValidLaunchToken(value) {
  return typeof value === 'string' && LAUNCH_TOKEN_PATTERN.test(value);
}

/**
 * The cookie name DSH derives for an authority.
 *
 * Reimplemented so R7 can assert which cookie it expects, rather than accepting any
 * `dsh-auth-*` value a response happens to carry.
 *
 * @param {string} authority - the `Host` header value.
 * @returns {string} the cookie name.
 */
export function cookieNameForAuthority(authority) {
  // Matches `cookieName(authority)` in dsh-client-connection: the authority is
  // normalised through `new URL` first, so `127.0.0.1:3080` and `LOCALHOST:3080`
  // produce different names exactly as DSH intends.
  const normalised = new URL(`http://${authority}`).host;
  return COOKIE_PREFIX + crypto.createHash('sha256').update(normalised).digest('base64url');
}

/**
 * Extract a specific cookie value from a `Set-Cookie` header or array.
 *
 * @param {string|string[]|undefined} headerValue - the header.
 * @param {string} name - the cookie name.
 * @returns {string|null} the value, or `null`.
 */
export function readSetCookie(headerValue, name) {
  const headers = Array.isArray(headerValue) ? headerValue : (headerValue === undefined ? [] : [headerValue]);
  for (const header of headers) {
    const first = String(header).split(';')[0];
    const at = first.indexOf('=');
    if (at === -1) continue;
    if (first.slice(0, at).trim() !== name) continue;
    return first.slice(at + 1).trim();
  }
  return null;
}

/**
 * Exchange a launch token for a `dsh-auth` cookie over loopback (§17).
 *
 * Requires **both** the `303` and a `dsh-auth-…` cookie. A `303` alone is not proof:
 * DSH also returns `303` to a caller that already holds a valid cookie, without
 * issuing a new one — so accepting the status alone would report success having
 * obtained nothing.
 *
 * @param {object} options - exchange options.
 * @param {string} options.launchToken - the launch token.
 * @param {string} options.authority - the `Host` authority, e.g. `127.0.0.1:3080`.
 * @param {number} options.port - the DSH port.
 * @param {string} [options.host] - the DSH host.
 * @param {number} [options.timeoutMs] - the request timeout.
 * @param {Function} [options.request] - injectable request, for tests.
 * @returns {Promise<{cookie: string, cookieName: string, status: number}>} the cookie.
 * @throws {ProductionError} `R7_DSH_AUTH_BOOTSTRAP_FAILED`.
 */
export async function exchangeLaunchToken(options) {
  const host = options.host ?? '127.0.0.1';
  const authority = options.authority ?? `${host}:${options.port}`;
  const expectedName = cookieNameForAuthority(authority);
  const requestImpl = options.request ?? http.request;

  const result = await new Promise((resolve, reject) => {
    const req = requestImpl({
      host,
      port: options.port,
      method: 'GET',
      // The token is the sole authentication input, and it is a URL query value by
      // design — that is the audited contract, not an R7 choice.
      path: `/?${TOKEN_QUERY}=${encodeURIComponent(options.launchToken)}`,
      headers: { host: authority },
      timeout: options.timeoutMs ?? 10_000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
    req.end();
  }).catch((error) => {
    throw new ProductionError(
      R7_ERROR.DSH_AUTH_BOOTSTRAP_FAILED,
      `the launch-token exchange did not complete: ${error.code ?? error.message}`,
    );
  });

  if (result.status !== 303) {
    // 401 is DSH's uniform refusal. It is not echoed, and the body is not logged.
    throw new ProductionError(
      R7_ERROR.DSH_AUTH_BOOTSTRAP_FAILED,
      `the launch-token exchange was refused with status ${result.status}`,
    );
  }

  const cookie = readSetCookie(result.headers['set-cookie'], expectedName);
  if (cookie === null) {
    throw new ProductionError(
      R7_ERROR.DSH_AUTH_BOOTSTRAP_FAILED,
      'the exchange returned 303 but issued no dsh-auth cookie',
    );
  }

  return { cookie, cookieName: expectedName, status: result.status };
}

/**
 * Verify a cookie by calling a known read-only DSH endpoint (§17).
 *
 * Compatibility is proven by use, not by the cookie's shape: an accepted cookie is
 * one DSH acts on.
 *
 * @param {object} options - verification options.
 * @param {string} options.cookie - the cookie value.
 * @param {string} options.cookieName - the cookie name.
 * @param {number} options.port - the DSH port.
 * @param {string} [options.host] - the DSH host.
 * @param {string} [options.path] - the endpoint to probe.
 * @param {number} [options.timeoutMs] - the request timeout.
 * @param {Function} [options.request] - injectable request.
 * @returns {Promise<{ok: boolean, status: number}>} the result.
 * @throws {ProductionError} `R7_DSH_AUTH_BOOTSTRAP_FAILED`.
 */
export async function verifyCookie(options) {
  const host = options.host ?? '127.0.0.1';
  const authority = options.authority ?? `${host}:${options.port}`;
  const requestImpl = options.request ?? http.request;
  const probePath = options.path ?? VERIFY_PATH;
  const payload = '{}';

  const result = await new Promise((resolve, reject) => {
    const req = requestImpl({
      host,
      port: options.port,
      // The unary API is POST; a GET on the same path is a different route.
      method: options.method ?? 'POST',
      path: probePath,
      headers: {
        host: authority,
        cookie: `${options.cookieName}=${options.cookie}`,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
      },
      timeout: options.timeoutMs ?? 10_000,
    }, (res) => {
      // Drain, so the socket closes and the process can exit.
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  }).catch((error) => {
    throw new ProductionError(
      R7_ERROR.DSH_AUTH_BOOTSTRAP_FAILED,
      `cookie verification did not complete: ${error.code ?? error.message}`,
    );
  });

  // Only an explicit auth rejection proves the cookie is bad. A 400 from a handler that
  // wanted different arguments still means the request was authenticated and routed —
  // treating that as an auth failure is what made the previous probe unusable.
  if (result.status === 401 || result.status === 403) {
    throw new ProductionError(
      R7_ERROR.DSH_AUTH_BOOTSTRAP_FAILED,
      `the DSH cookie was rejected with status ${result.status}`,
    );
  }
  if (result.status === 404) {
    // A 404 means the probe path is wrong, which is a contract problem rather than a
    // credential one. Saying so avoids sending an operator after the wrong cause.
    throw new ProductionError(
      R7_ERROR.DSH_LAUNCH_CONTRACT_CHANGED,
      `the readiness probe ${probePath} does not exist on this DSH build`,
    );
  }
  return { ok: true, status: result.status };
}

/**
 * A cookie-based auth provider for the production DSH boundary.
 *
 * The cookie is visible only to the DSH adapter and the dedicated, one-time
 * loopback browser handoff. It is never returned by a mobile REST route or sent to
 * the Phone `AuthService`, journal, event stream, or WebSocket.
 */
export class CookieAuthProvider {
  /**
   * @param {object} [options] - provider options.
   */
  constructor(options = {}) {
    this.cookieName = options.cookieName ?? null;
    /** The value. Intentionally not enumerable in `describe()`. */
    this.cookie = options.cookie ?? null;
    /** The authority the cookie is bound to; DSH rejects a different one. */
    this.authority = options.authority ?? null;
    this.obtainedAt = options.obtainedAt ?? null;
  }

  /**
   * Whether a cookie is held.
   *
   * @returns {boolean} true when present.
   */
  get ready() {
    return typeof this.cookie === 'string' && this.cookie.length > 0;
  }

  /**
   * The `Cookie` header value for an outgoing DSH request.
   *
   * @returns {string|null} the header value, or `null` when not ready.
   */
  header() {
    if (!this.ready) return null;
    return `${this.cookieName}=${this.cookie}`;
  }

  /**
   * Apply the cookie to a header bag in place.
   *
   * @param {object} headers - the header bag to mutate.
   * @returns {object} the same bag.
   */
  apply(headers) {
    const value = this.header();
    if (value !== null) headers.cookie = value;
    return headers;
  }

  /**
   * Drop the cookie, e.g. when the child it belongs to exits (§17).
   *
   * A cookie is only meaningful for the process that issued it, so reusing one after
   * a restart would be wrong even if it still validated.
   *
   * @returns {void}
   */
  clear() {
    this.cookie = null;
    this.cookieName = null;
    this.authority = null;
    this.obtainedAt = null;
  }

  /**
   * The `DshAuth` shape the R1 adapter expects.
   *
   * `FixtureAuthProvider` deliberately rejects anything shaped like a real cookie, so
   * production needs its own provider rather than a reused fixture one. The adapter
   * consumes it for DSH RPC; the dedicated local handoff is the only browser recipient.
   *
   * @returns {Promise<{cookie: string, authority: string}>} the credential.
   * @throws {ProductionError} `R7_DSH_AUTH_BOOTSTRAP_FAILED` when not ready.
   */
  async getAuth() {
    if (!this.ready) {
      throw new ProductionError(
        R7_ERROR.DSH_AUTH_BOOTSTRAP_FAILED,
        'no DSH auth cookie is available; the child has not been bootstrapped',
      );
    }
    return { cookie: this.header(), authority: this.authority };
  }

  /**
   * Redact this provider's cookie from a value.
   *
   * @param {unknown} value - the value to sanitize.
   * @returns {string} the value with the cookie removed.
   */
  redact(value) {
    const text = String(value ?? '');
    if (!this.ready) return text;
    return text.split(this.cookie).join('<redacted>');
  }

  /**
   * A safe description. Never includes the cookie value.
   *
   * @returns {object} the summary.
   */
  describe() {
    return {
      ready: this.ready,
      cookie_name: this.cookieName,
      authority: this.authority ?? null,
      cookie_length: this.cookie === null ? 0 : this.cookie.length,
      obtained_at: this.obtainedAt,
    };
  }
}

export { ProductionError, R7_ERROR };
