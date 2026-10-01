/**
 * Shared Origin policy — Phase R6 §27, §28, §29.
 *
 * §27 requires **one** policy used by REST, CORS, the WebSocket upgrade and ticket
 * binding. Four copies of an origin rule is four chances to disagree, and the
 * disagreement would be a security hole rather than a bug.
 *
 * R4 already had a loopback-only check inside the WS layer. That logic now lives
 * here and the WS layer delegates to it, so the rule cannot drift.
 */

import { AUTH_ERROR, authError } from './errors.mjs';

/** Schemes that can never be a legitimate browser origin here. */
const FORBIDDEN_SCHEMES = Object.freeze(['null', 'file:', 'chrome-extension:', 'moz-extension:', 'data:', 'blob:']);

/**
 * Normalise one origin string.
 *
 * §28: absolute `http:`/`https:` only, no path, query or fragment, no wildcard, no
 * `null`, no `file:`, no extension scheme, and default ports normalised so
 * `https://x:443` and `https://x` are one origin.
 *
 * @param {unknown} value - the raw origin.
 * @returns {{ok: true, origin: string, isLoopback: boolean} | {ok: false, reason: string}} the result.
 */
export function normalizeOrigin(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'not a string' };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  if (trimmed === 'null') return { ok: false, reason: 'null origin' };

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }

  const scheme = url.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') {
    return { ok: false, reason: `scheme ${scheme} is not http or https` };
  }
  if (FORBIDDEN_SCHEMES.some((entry) => trimmed.toLowerCase().startsWith(entry))) {
    return { ok: false, reason: 'forbidden scheme' };
  }
  // A path, query or fragment means this is not a bare origin.
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return { ok: false, reason: 'origin carries a path, query or fragment' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'origin carries userinfo' };
  }
  if (url.hostname.includes('*')) return { ok: false, reason: 'wildcard host' };

  // `URL` already drops a default port, so `origin` is normalised for us.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // R4 accepted the whole loopback /8, and narrowing that here would be a silent
  // behaviour change rather than a hardening. The rule is shared, so it is stated
  // once: `127.0.0.0/8`, `localhost`, and IPv6 `::1`.
  const isLoopback = host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (isLoopback && host !== 'localhost' && host !== '::1') {
    // Reject an out-of-range octet such as 127.999.0.1, which `/^127\./` alone would
    // have accepted.
    const octets = host.split('.').map(Number);
    if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
      return { ok: false, reason: 'loopback address has an out-of-range octet' };
    }
  }
  return { ok: true, origin: url.origin.toLowerCase(), isLoopback };
}

/**
 * Parse the `DSH_REMOTE_ALLOWED_ORIGINS` value.
 *
 * Comma-separated exact origins; duplicates removed. A wildcard or a path-bearing
 * entry is **rejected**, not ignored, because silently dropping a malformed
 * allowlist entry could leave an operator believing an origin is permitted.
 *
 * @param {unknown} raw - the configured value.
 * @returns {string[]} the normalised origins.
 * @throws {AuthError} `AUTH_CONFIG_INVALID` on a malformed entry.
 */
export function parseAllowedOrigins(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  if (typeof raw !== 'string') {
    throw authError(AUTH_ERROR.CONFIG_INVALID, { message: 'DSH_REMOTE_ALLOWED_ORIGINS must be a string.' });
  }
  if (raw.includes('*')) {
    throw authError(AUTH_ERROR.CONFIG_INVALID, { message: 'A wildcard origin is not allowed.' });
  }

  const seen = new Set();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const normalised = normalizeOrigin(trimmed);
    if (!normalised.ok) {
      throw authError(AUTH_ERROR.CONFIG_INVALID, {
        message: `An allowed origin is not usable: ${normalised.reason}.`,
      });
    }
    seen.add(normalised.origin);
  }
  return [...seen];
}

/**
 * The origin policy shared by REST, CORS, WebSocket and ticket binding.
 */
export class OriginPolicy {
  /**
   * @param {object} [options] - policy options.
   * @param {number|(() => number|null)} [options.port] - this server's own port, for the
   *   loopback default. A function is accepted because the port is only known after
   *   the listener binds, and the policy must reflect the real one rather than 0.
   * @param {string[]} [options.allowedOrigins] - extra exact origins.
   */
  constructor(options = {}) {
    this.portSource = options.port ?? null;
    /** @type {Set<string>} */
    this.allowed = new Set(options.allowedOrigins ?? []);
  }

  /**
   * The port this policy treats as same-origin.
   *
   * @returns {number|null} the port, or `null` when it is not yet known.
   */
  get port() {
    const value = typeof this.portSource === 'function' ? this.portSource() : this.portSource;
    return typeof value === 'number' && value > 0 ? value : null;
  }

  /**
   * Whether an origin is the loopback same-port origin.
   *
   * @param {string} origin - a normalised origin.
   * @returns {boolean} true when it is loopback on this server's port.
   */
  #isLoopbackSamePort(origin) {
    if (this.port === null) return false;
    const parsed = normalizeOrigin(origin);
    if (!parsed.ok || !parsed.isLoopback) return false;
    const url = new URL(parsed.origin);
    const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
    return port === this.port;
  }

  /**
   * Decide whether an origin is allowed.
   *
   * An **absent** Origin is allowed: native clients and same-origin `fetch` do not
   * send one, and §29 only requires a *present* Origin to pass the allowlist.
   *
   * @param {unknown} origin - the request Origin, or undefined.
   * @returns {{allowed: boolean, origin: string|null, reason: string|null}} the decision.
   */
  check(origin) {
    // An **absent** Origin is allowed: native clients and same-origin `fetch` do not
    // send one, and §29 only requires a *present* Origin to pass the allowlist. R4
    // also treated an empty string as absent, and narrowing that here would be a
    // silent behaviour change rather than a hardening.
    if (origin === undefined || origin === null || origin === '') {
      return { allowed: true, origin: null, reason: null };
    }
    const normalized = normalizeOrigin(origin);
    if (!normalized.ok) {
      return { allowed: false, origin: null, reason: normalized.reason };
    }
    if (this.allowed.has(normalized.origin)) {
      return { allowed: true, origin: normalized.origin, reason: null };
    }
    if (this.#isLoopbackSamePort(normalized.origin)) {
      return { allowed: true, origin: normalized.origin, reason: null };
    }
    return { allowed: false, origin: normalized.origin, reason: 'not in the allowlist' };
  }

  /**
   * Assert an origin, throwing on refusal.
   *
   * @param {unknown} origin - the request Origin.
   * @returns {string|null} the normalised origin, or `null` when absent.
   * @throws {AuthError} `ORIGIN_NOT_ALLOWED`.
   */
  assert(origin) {
    const decision = this.check(origin);
    if (!decision.allowed) {
      throw authError(AUTH_ERROR.ORIGIN_NOT_ALLOWED, { internalReason: decision.reason ?? 'origin refused' });
    }
    return decision.origin;
  }

  /**
   * Every origin this policy accepts, for diagnostics.
   *
   * @returns {object} the policy summary. Never includes a credential.
   */
  describe() {
    return {
      port: this.port,
      explicit: [...this.allowed].sort(),
      loopbackSamePort: this.port !== null,
    };
  }
}
