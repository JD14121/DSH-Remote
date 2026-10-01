/**
 * HTTP error vocabulary and adapter-code mapping — Phase R3 §10, §19.
 *
 * Two rules §10 makes non-negotiable:
 *
 *   1. Errors use non-2xx statuses. There is no `200 { error }` shape.
 *   2. A response never carries a stack, a `cause` object, a DSH cookie, a launch
 *      token, an `Authorization` value, a filesystem secret, or a raw internal
 *      exception message.
 *
 * The mapping lives here, in one table, rather than being spread across routes.
 */

import { ADAPTER_ERROR } from '../adapter-errors.mjs';

/** HTTP statuses used by the API. */
export const HTTP_STATUS = Object.freeze({
  OK: 200,
  /** R6 §15: a minted ticket is a newly created resource. */
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  /** R6 §8/§52: a missing or invalid credential. */
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNPROCESSABLE: 422,
  /** R4 §7: an upgrade without a supported subprotocol is refused, not downgraded. */
  UPGRADE_REQUIRED: 426,
  /** R6 §36/§52: a rate limit, a ticket cap, a connection cap or an upload quota. */
  TOO_MANY_REQUESTS: 429,
  INTERNAL: 500,
  NOT_IMPLEMENTED: 501,
  BAD_GATEWAY: 502,
  UNAVAILABLE: 503,
});

/**
 * API error codes. These are the only codes a client sees; DSH remote codes are
 * mapped onto them rather than forwarded.
 */
export const API_ERROR = Object.freeze({
  // request shape
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_QUERY: 'INVALID_QUERY',
  INVALID_CURSOR: 'INVALID_CURSOR',
  INVALID_SESSION_ID: 'INVALID_SESSION_ID',
  INVALID_PROMPT_MODE: 'INVALID_PROMPT_MODE',
  INVALID_PROMPT_CONTENT: 'INVALID_PROMPT_CONTENT',
  CLIENT_MESSAGE_ID_REQUIRED: 'CLIENT_MESSAGE_ID_REQUIRED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  // routing
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  FORBIDDEN_HOST: 'FORBIDDEN_HOST',
  // domain
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_COLD: 'SESSION_COLD',
  PROMPT_REJECTED: 'PROMPT_REJECTED',
  CANCEL_UNSUPPORTED: 'CANCEL_UNSUPPORTED',
  // uploads
  UPLOAD_INVALID_FILENAME: 'UPLOAD_INVALID_FILENAME',
  UPLOAD_INVALID_MIME: 'UPLOAD_INVALID_MIME',
  UPLOAD_MISSING_FILE: 'UPLOAD_MISSING_FILE',
  UPLOAD_NOT_AVAILABLE: 'UPLOAD_NOT_AVAILABLE',
  // downstream
  AUTH_UNAVAILABLE: 'AUTH_UNAVAILABLE',
  AUTH_REJECTED: 'AUTH_REJECTED',
  DSH_UNAVAILABLE: 'DSH_UNAVAILABLE',
  WIRE_VERSION_MISMATCH: 'WIRE_VERSION_MISMATCH',
  WIRE_PROTOCOL_ERROR: 'WIRE_PROTOCOL_ERROR',
  STREAM_ABORTED: 'STREAM_ABORTED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

/**
 * One API failure, ready to serialise.
 *
 * Only `code`, a human `message`, `retryable` and optional safe `details` survive.
 */
export class ApiError extends Error {
  /**
   * @param {number} status - HTTP status.
   * @param {string} code - an `API_ERROR` value.
   * @param {string} message - a safe, human-readable description.
   * @param {object} [options] - extra fields.
   * @param {boolean} [options.retryable] - whether a client may retry.
   * @param {object} [options.details] - small, non-secret context.
   * @param {Record<string, string>} [options.headers] - extra response headers.
   */
  constructor(status, code, message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.headers = options.headers;
  }

  /**
   * The response body for this error.
   *
   * @param {string} requestId - the server-generated request id.
   * @returns {{error: object}} the envelope.
   */
  toEnvelope(requestId) {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        request_id: requestId,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

/** Default retryability per code. */
const RETRYABLE_CODES = Object.freeze(new Set([
  API_ERROR.DSH_UNAVAILABLE,
  API_ERROR.STREAM_ABORTED,
  API_ERROR.INTERNAL_ERROR,
]));

/** Safe, generic messages so an internal string never reaches a client. */
const SAFE_MESSAGES = Object.freeze({
  [API_ERROR.INTERNAL_ERROR]: 'An internal error occurred.',
  [API_ERROR.DSH_UNAVAILABLE]: 'The DSH backend is unavailable.',
  [API_ERROR.AUTH_UNAVAILABLE]: 'The gateway has no DSH credential configured.',
  [API_ERROR.AUTH_REJECTED]: 'DSH rejected the gateway credential.',
  [API_ERROR.WIRE_VERSION_MISMATCH]: 'The DSH version is not supported by this gateway.',
  [API_ERROR.WIRE_PROTOCOL_ERROR]: 'The DSH backend returned an unexpected response.',
});

/**
 * Safe messages for persistence codes (R5 §57).
 *
 * Deliberately path-free: §57 forbids leaking a real disk path to a phone.
 */
const SAFE_PERSISTENCE_MESSAGES = Object.freeze({
  PERSISTENCE_UNAVAILABLE: 'The gateway state store is unavailable.',
  PERSISTENCE_WRITE_FAILED: 'The gateway could not persist an event, so it was not delivered.',
  STATE_LOCKED: 'Another gateway instance already owns this state store.',
  STATE_VERSION_UNSUPPORTED: 'The gateway state store has an unsupported format version.',
  JOURNAL_CORRUPT: 'The gateway event journal is damaged.',
  JOURNAL_SEQUENCE_ERROR: 'The gateway event journal has an inconsistent sequence.',
  STATE_AHEAD_OF_JOURNAL: 'The gateway state is ahead of its event journal.',
  STATE_PATH_INVALID: 'The gateway state path is not usable.',
  STATE_SNAPSHOT_INVALID: 'The gateway session snapshot is unreadable.',
});

/**
 * Build an API error for a code, using a safe default message.
 *
 * @param {number} status - HTTP status.
 * @param {string} code - an `API_ERROR` value.
 * @param {string} [message] - overrides the safe default.
 * @param {object} [options] - see `ApiError`.
 * @returns {ApiError} the error.
 */
export function apiError(status, code, message, options = {}) {
  return new ApiError(status, code, message ?? SAFE_MESSAGES[code] ?? 'Request failed.', {
    retryable: options.retryable ?? RETRYABLE_CODES.has(code),
    details: options.details,
    headers: options.headers,
  });
}

/**
 * Map an adapter error code onto an HTTP status and API code (§19).
 *
 * `cancelOperation` distinguishes `SESSION_COLD` from `SESSION_NOT_FOUND` for a
 * cancel call, mirroring the adapter's own distinction.
 *
 * @param {string} adapterCode - an `ADAPTER_ERROR` value, or an extra domain code.
 * @param {object} [context] - mapping hints.
 * @returns {{status: number, code: string}} the mapping.
 */
export function mapAdapterCode(adapterCode, context = {}) {
  switch (adapterCode) {
    case ADAPTER_ERROR.SESSION_NOT_FOUND:
      return context.cancelOperation === true
        ? { status: HTTP_STATUS.CONFLICT, code: API_ERROR.SESSION_COLD }
        : { status: HTTP_STATUS.NOT_FOUND, code: API_ERROR.SESSION_NOT_FOUND };
    case ADAPTER_ERROR.SESSION_COLD:
      return { status: HTTP_STATUS.CONFLICT, code: API_ERROR.SESSION_COLD };
    case ADAPTER_ERROR.PROMPT_REJECTED:
      // Per §19: 409 or 422 depending on subclass. A prompt refused because the
      // session cannot accept it is a state conflict; unusable content is a
      // semantic problem with the request itself.
      return context.contentProblem === true
        ? { status: HTTP_STATUS.UNPROCESSABLE, code: API_ERROR.PROMPT_REJECTED }
        : { status: HTTP_STATUS.CONFLICT, code: API_ERROR.PROMPT_REJECTED };
    case 'INVALID_PROMPT_MODE':
      return { status: HTTP_STATUS.BAD_REQUEST, code: API_ERROR.INVALID_PROMPT_MODE };
    case 'INVALID_PROMPT_CONTENT':
      return { status: HTTP_STATUS.BAD_REQUEST, code: API_ERROR.INVALID_PROMPT_CONTENT };
    case ADAPTER_ERROR.CANCEL_UNSUPPORTED:
      return { status: HTTP_STATUS.CONFLICT, code: API_ERROR.CANCEL_UNSUPPORTED };
    case ADAPTER_ERROR.AUTH_UNAVAILABLE:
      return { status: HTTP_STATUS.UNAVAILABLE, code: API_ERROR.AUTH_UNAVAILABLE };
    case ADAPTER_ERROR.AUTH_REJECTED:
      return { status: HTTP_STATUS.BAD_GATEWAY, code: API_ERROR.AUTH_REJECTED };
    case ADAPTER_ERROR.DSH_UNAVAILABLE:
      return { status: HTTP_STATUS.UNAVAILABLE, code: API_ERROR.DSH_UNAVAILABLE };
    case ADAPTER_ERROR.WIRE_VERSION_MISMATCH:
      return { status: HTTP_STATUS.UNAVAILABLE, code: API_ERROR.WIRE_VERSION_MISMATCH };
    case ADAPTER_ERROR.WIRE_PROTOCOL_ERROR:
      return { status: HTTP_STATUS.BAD_GATEWAY, code: API_ERROR.WIRE_PROTOCOL_ERROR };
    case ADAPTER_ERROR.STREAM_ABORTED:
      // §19: no non-standard 499 is emitted. An aborted stream is a state
      // conflict for a live operation; a client-caused abort never reaches here.
      return { status: HTTP_STATUS.CONFLICT, code: API_ERROR.STREAM_ABORTED };
    default:
      return { status: HTTP_STATUS.INTERNAL, code: API_ERROR.INTERNAL_ERROR };
  }
}

/**
 * Convert any thrown value into an `ApiError`.
 *
 * An `ApiError` passes through unchanged so a precise code is never downgraded.
 * Anything else becomes a generic internal error: the original message is **not**
 * forwarded, because it could contain a path, a header value or a DSH detail.
 *
 * @param {unknown} error - thrown value.
 * @param {object} [context] - mapping hints.
 * @returns {ApiError} an API error.
 */
export function toApiError(error, context = {}) {
  if (error instanceof ApiError) return error;

  // R6 §51/§52: an auth failure carries its own fixed status and a generic message.
  // Mapping it here means any route that authenticates — or any handler that calls
  // into the auth service directly — reports the documented status automatically.
  if (error?.name === 'AuthError' && typeof error.code === 'string') {
    return apiError(error.status ?? 401, error.code, error.message, {
      ...(error.headers === undefined ? {} : { headers: error.headers }),
      ...(error.retryAfter === undefined ? {} : { details: { retry_after: error.retryAfter } }),
      retryable: (error.status ?? 401) === 429,
    });
  }

  // R5 §57: a persistence failure reaches a client as a stable code with no disk
  // path. Mapping it here means any route that appends to the journal — directly
  // or through a signal — fails closed with 503 automatically.
  if (error?.name === 'PersistenceError' && typeof error.code === 'string') {
    const status = error.code === 'PERSISTENCE_WRITE_FAILED'
      || error.code === 'PERSISTENCE_UNAVAILABLE'
      ? HTTP_STATUS.UNAVAILABLE
      : HTTP_STATUS.UNAVAILABLE;
    return apiError(status, error.code, SAFE_PERSISTENCE_MESSAGES[error.code], {
      retryable: error.code === 'PERSISTENCE_WRITE_FAILED' || error.code === 'PERSISTENCE_UNAVAILABLE',
    });
  }

  const adapterCode = error?.code;
  if (typeof adapterCode === 'string' && adapterCode.length > 0) {
    const mapped = mapAdapterCode(adapterCode, context);
    return apiError(mapped.status, mapped.code, SAFE_MESSAGES[mapped.code], {
      details: error?.details === undefined ? undefined : SAFE_DETAIL_KEYS_ONLY(error.details),
    });
  }

  return apiError(HTTP_STATUS.INTERNAL, API_ERROR.INTERNAL_ERROR);
}

/** Detail keys considered safe to echo back to a client. */
const SAFE_DETAIL_KEYS = Object.freeze(new Set([
  'endpoint',
  'sessionId',
  'status',
  'remoteCode',
  'mode',
  'limit',
  'field',
]));

/**
 * Keep only client-safe keys from an adapter details object.
 *
 * Adapter details are already redacted, but this is a second, structural gate so
 * a future field added upstream cannot silently reach a response.
 *
 * @param {object} details - adapter details.
 * @returns {object|undefined} the filtered details, or `undefined` when empty.
 */
export function SAFE_DETAIL_KEYS_ONLY(details) {
  if (details === null || typeof details !== 'object') return undefined;
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (!SAFE_DETAIL_KEYS.has(key)) continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
