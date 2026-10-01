/**
 * Authentication and security error vocabulary — Phase R6 §51, §52.
 *
 * One table, so every auth failure reaches a client as a stable, **generic** code
 * and never as a fine-grained oracle. §51 is explicit that "ticket already used" and
 * "ticket hash not found" must not be distinguishable from outside; both collapse to
 * `WS_TICKET_INVALID`.
 */

/** Auth failure codes, in one place. */
export const AUTH_ERROR = Object.freeze({
  /** No credential was presented. */
  REQUIRED: 'AUTH_REQUIRED',
  /** A credential was presented and is wrong, malformed, or oversized. */
  INVALID: 'AUTH_INVALID',
  /** The auth configuration itself is unusable; startup must fail. */
  CONFIG_INVALID: 'AUTH_CONFIG_INVALID',

  /** The WS ticket is unknown, already used, or bound elsewhere. */
  WS_TICKET_INVALID: 'WS_TICKET_INVALID',
  /** The WS ticket existed but its TTL elapsed. */
  WS_TICKET_EXPIRED: 'WS_TICKET_EXPIRED',
  /** Too many outstanding tickets. */
  TICKET_LIMIT: 'AUTH_TICKET_LIMIT',

  /** The request Origin is not in the allowlist. */
  ORIGIN_NOT_ALLOWED: 'ORIGIN_NOT_ALLOWED',
  /** A CORS preflight named an origin, method or header that is not allowed. */
  CORS_PREFLIGHT_REJECTED: 'CORS_PREFLIGHT_REJECTED',

  /** A rate limit was exceeded. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** The per-principal WebSocket connection limit was reached. */
  WS_CONNECTION_LIMIT: 'WS_CONNECTION_LIMIT',
  /** The upload quota was exceeded. */
  UPLOAD_QUOTA_EXCEEDED: 'UPLOAD_QUOTA_EXCEEDED',
});

/**
 * A credential was rejected.
 *
 * Carries a generic code and never the offending value.
 */
export class AuthError extends Error {
  /**
   * @param {string} code - an `AUTH_ERROR` value.
   * @param {string} message - a safe, value-free description.
   * @param {object} [options] - extras.
   * @param {number} [options.status] - the HTTP status to use.
   * @param {number} [options.retryAfter] - seconds, for a 429.
   * @param {object} [options.headers] - additional response headers.
   * @param {string} [options.internalReason] - for server-side diagnostics only.
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
    if (options.headers !== undefined) this.headers = options.headers;
    if (options.internalReason !== undefined) this.internalReason = options.internalReason;
  }
}

/**
 * Whether a value is an auth failure.
 *
 * @param {unknown} error - the value to test.
 * @returns {boolean} true for an `AuthError`.
 */
export function isAuthError(error) {
  return error instanceof AuthError;
}

/** The `WWW-Authenticate` challenge §8 requires on a 401. */
export const WWW_AUTHENTICATE = 'Bearer realm="dsh-remote"';

/**
 * Safe, generic messages.
 *
 * Deliberately identical for every reason a credential can be wrong, so the
 * response cannot be used as an oracle (§37).
 */
const GENERIC_INVALID = 'The supplied credential is not valid.';

/** Fixed per-code status and message (§52). */
const TABLE = Object.freeze({
  [AUTH_ERROR.REQUIRED]: { status: 401, message: 'Authentication is required.' },
  [AUTH_ERROR.INVALID]: { status: 401, message: GENERIC_INVALID },
  [AUTH_ERROR.CONFIG_INVALID]: { status: 503, message: 'The gateway authentication is misconfigured.' },
  // §52 recommends 401 for tickets: it means "credential invalid". The reason is
  // never disclosed, so a used ticket, an unknown ticket and a session or origin
  // mismatch are indistinguishable.
  [AUTH_ERROR.WS_TICKET_INVALID]: { status: 401, message: GENERIC_INVALID },
  [AUTH_ERROR.WS_TICKET_EXPIRED]: { status: 401, message: GENERIC_INVALID },
  [AUTH_ERROR.TICKET_LIMIT]: { status: 429, message: 'Too many outstanding tickets.' },
  [AUTH_ERROR.ORIGIN_NOT_ALLOWED]: { status: 403, message: 'The request origin is not allowed.' },
  [AUTH_ERROR.CORS_PREFLIGHT_REJECTED]: { status: 403, message: 'The CORS preflight request is not allowed.' },
  [AUTH_ERROR.RATE_LIMITED]: { status: 429, message: 'Too many requests.' },
  [AUTH_ERROR.WS_CONNECTION_LIMIT]: { status: 429, message: 'Too many concurrent event streams.' },
  [AUTH_ERROR.UPLOAD_QUOTA_EXCEEDED]: { status: 429, message: 'The upload quota has been exceeded.' },
});

/**
 * Build an auth error with the fixed status and a safe message.
 *
 * @param {string} code - an `AUTH_ERROR` value.
 * @param {object} [options] - extras.
 * @param {number} [options.status] - overrides the table.
 * @param {string} [options.message] - overrides the table; keep it generic.
 * @param {number} [options.retryAfter] - seconds, for a 429.
 * @param {string} [options.internalReason] - server-side only.
 * @returns {AuthError} the error.
 */
export function authError(code, options = {}) {
  const entry = TABLE[code] ?? { status: 500, message: 'The request could not be authorized.' };
  const headers = {};
  // §8: a 401 must advertise the scheme so a client knows how to authenticate.
  if ((options.status ?? entry.status) === 401) headers['www-authenticate'] = WWW_AUTHENTICATE;
  if (options.retryAfter !== undefined) headers['retry-after'] = String(Math.max(1, Math.ceil(options.retryAfter)));

  return new AuthError(code, options.message ?? entry.message, {
    status: options.status ?? entry.status,
    retryAfter: options.retryAfter,
    headers,
    internalReason: options.internalReason,
  });
}

/**
 * The status an auth code maps to.
 *
 * @param {string} code - an `AUTH_ERROR` value.
 * @returns {number} the HTTP status.
 */
export function statusForCode(code) {
  return TABLE[code]?.status ?? 500;
}
