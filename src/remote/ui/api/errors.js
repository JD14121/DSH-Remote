/**
 * REST error taxonomy.
 *
 * The UI must distinguish situations that a single "Something went wrong" would collapse —
 * most importantly `401` (the credential is wrong, so discard it and ask again) from a
 * *network failure* (the Gateway is unreachable, so **keep** the credential and retry later).
 * Conflating those two is the bug this module exists to prevent.
 *
 * No error message may carry server internals, and none may carry a credential. The mapper
 * reads only the status and a short reason; response bodies are never interpolated into
 * user-facing text.
 */

/**
 * The kind of failure, as the UI needs to reason about it.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const ERROR_KIND = Object.freeze({
  AUTH_REQUIRED: 'auth_required',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  TOO_LARGE: 'too_large',
  RATE_LIMITED: 'rate_limited',
  BAD_REQUEST: 'bad_request',
  SERVER: 'server',
  NETWORK: 'network',
  ABORTED: 'aborted',
  UNKNOWN: 'unknown',
});

/**
 * The operator-facing message for each kind.
 *
 * Deliberately free of status codes, URLs, stack traces and server text.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const ERROR_MESSAGE = Object.freeze({
  [ERROR_KIND.AUTH_REQUIRED]: 'Authentication failed. Check the token and try again.',
  [ERROR_KIND.FORBIDDEN]: 'This action is not permitted for this credential.',
  [ERROR_KIND.NOT_FOUND]: 'That resource no longer exists.',
  [ERROR_KIND.CONFLICT]: 'The session is not in a state that allows that action.',
  [ERROR_KIND.TOO_LARGE]: 'That file is too large. The limit is 25 MiB.',
  [ERROR_KIND.RATE_LIMITED]: 'Too many requests. Wait a moment and try again.',
  [ERROR_KIND.BAD_REQUEST]: 'The request was rejected as invalid.',
  [ERROR_KIND.SERVER]: 'The Gateway reported a failure. The operator can check its log.',
  [ERROR_KIND.NETWORK]: 'Cannot reach the Gateway. It may not be running.',
  [ERROR_KIND.ABORTED]: 'The request was cancelled.',
  [ERROR_KIND.UNKNOWN]: 'The request could not be completed.',
});

/**
 * An API failure carrying a UI-safe classification.
 */
export class ApiError extends Error {
  /**
   * @param {string} kind - one of `ERROR_KIND`.
   * @param {object} [details] - `status`, `requestId`, `retryable`.
   */
  constructor(kind, details = {}) {
    super(ERROR_MESSAGE[kind] ?? ERROR_MESSAGE[ERROR_KIND.UNKNOWN]);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = details.status ?? null;
    this.requestId = details.requestId ?? null;
    this.code = typeof details.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(details.code)
      ? details.code
      : null;
    this.remoteCode = typeof details.remoteCode === 'string' && /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/.test(details.remoteCode)
      ? details.remoteCode
      : null;
    if (kind === ERROR_KIND.SERVER && (this.code !== null || this.remoteCode !== null)) {
      const diagnostic = [this.code, this.remoteCode].filter(Boolean).join(': ');
      this.message = `${ERROR_MESSAGE[kind]} (${diagnostic}${this.requestId ? `; request ${this.requestId}` : ''})`;
    }
    this.retryable = details.retryable ?? false;
  }

  /**
   * Whether the credential should be discarded because of this failure.
   *
   * Only `401` means the credential is bad. A network failure must never clear it.
   *
   * @returns {boolean} true when the credential should be cleared.
   */
  clearsCredential() {
    return this.kind === ERROR_KIND.AUTH_REQUIRED;
  }
}

/**
 * Map an HTTP status to an error kind.
 *
 * @param {number} status - the status code.
 * @returns {string} the kind.
 */
export function kindForStatus(status) {
  if (status === 401) return ERROR_KIND.AUTH_REQUIRED;
  if (status === 403) return ERROR_KIND.FORBIDDEN;
  if (status === 404) return ERROR_KIND.NOT_FOUND;
  if (status === 409) return ERROR_KIND.CONFLICT;
  if (status === 413) return ERROR_KIND.TOO_LARGE;
  if (status === 429) return ERROR_KIND.RATE_LIMITED;
  if (status === 400 || status === 422) return ERROR_KIND.BAD_REQUEST;
  if (status >= 500) return ERROR_KIND.SERVER;
  return ERROR_KIND.UNKNOWN;
}

/**
 * Build an ApiError from a response status.
 *
 * @param {number} status - the HTTP status.
 * @param {object} [details] - `requestId`.
 * @returns {ApiError} the error.
 */
export function errorFromStatus(status, details = {}) {
  const kind = kindForStatus(status);
  return new ApiError(kind, {
    status,
    requestId: details.requestId ?? null,
    code: details.code ?? null,
    remoteCode: details.remoteCode ?? null,
    // Rate limiting and server faults are worth retrying; a bad credential is not.
    retryable: kind === ERROR_KIND.RATE_LIMITED || kind === ERROR_KIND.SERVER,
  });
}

/**
 * Build an ApiError from a thrown network or abort failure.
 *
 * @param {unknown} cause - whatever was thrown.
 * @returns {ApiError} the error.
 */
export function errorFromThrow(cause) {
  if (cause instanceof ApiError) return cause;
  const name = cause && typeof cause === 'object' && 'name' in cause ? String(cause.name) : '';
  if (name === 'AbortError') return new ApiError(ERROR_KIND.ABORTED);
  // Everything else is treated as "the Gateway could not be reached" — which is exactly the
  // case where the credential must be preserved.
  return new ApiError(ERROR_KIND.NETWORK, { retryable: true });
}

/**
 * The connection state a failure implies.
 *
 * @param {ApiError} error - the error.
 * @returns {string} a connection state from the UI's six.
 */
export function connectionStateForError(error) {
  if (error.kind === ERROR_KIND.AUTH_REQUIRED) return 'auth_required';
  if (error.kind === ERROR_KIND.NETWORK) return 'gateway_unavailable';
  // Any other HTTP answer proves the Gateway is reachable.
  return 'connected';
}
