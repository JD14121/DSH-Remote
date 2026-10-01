/**
 * Persistence error vocabulary and HTTP mapping — Phase R5 §57.
 *
 * One table, so a persistence failure reaches a client as a stable code and never
 * as a disk path. §57 is explicit that a real path must not leak to a phone, so
 * the messages here are deliberately path-free.
 */

import { ApiError, API_ERROR, HTTP_STATUS } from '../http/errors.mjs';

/** Persistence failure codes, in one place. */
export const PERSISTENCE_ERROR = Object.freeze({
  /** The journal cannot be opened, or has entered a failed state. */
  UNAVAILABLE: 'PERSISTENCE_UNAVAILABLE',
  /** An append failed (ENOSPC, EACCES, I/O error, checksum failure). */
  WRITE_FAILED: 'PERSISTENCE_WRITE_FAILED',
  /** Another live Gateway owns the state root. */
  LOCKED: 'STATE_LOCKED',
  /** `format.json` declares a version this build cannot read. */
  VERSION_UNSUPPORTED: 'STATE_VERSION_UNSUPPORTED',
  /** A journal is damaged in a way that must not be auto-repaired. */
  JOURNAL_CORRUPT: 'JOURNAL_CORRUPT',
  /** A per-session sequence was duplicated, gapped or reversed. */
  JOURNAL_SEQUENCE_ERROR: 'JOURNAL_SEQUENCE_ERROR',
  /** The snapshot claims more progress than the journal can prove. */
  AHEAD_OF_JOURNAL: 'STATE_AHEAD_OF_JOURNAL',
  /** A path escaped the state root, or was otherwise unsafe. */
  PATH_INVALID: 'STATE_PATH_INVALID',
  /** A snapshot is unreadable or fails its checksum. */
  SNAPSHOT_INVALID: 'STATE_SNAPSHOT_INVALID',
});

/** One failure class for the whole persistence layer. */
export class PersistenceError extends Error {
  /**
   * @param {string} code - a `PERSISTENCE_ERROR` value.
   * @param {string} message - a safe, path-free description.
   * @param {object} [options] - extra context.
   * @param {unknown} [options.cause] - the underlying error, never serialised.
   * @param {object} [options.details] - small, safe context for logs.
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'PersistenceError';
    this.code = code;
    this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Whether an error is a persistence failure.
 *
 * @param {unknown} error - the value to test.
 * @returns {boolean} true for a `PersistenceError`.
 */
export function isPersistenceError(error) {
  return error instanceof PersistenceError;
}

/** Safe, path-free messages, so an internal string never reaches a client. */
const SAFE_MESSAGE = Object.freeze({
  [PERSISTENCE_ERROR.UNAVAILABLE]: 'The gateway state store is unavailable.',
  [PERSISTENCE_ERROR.WRITE_FAILED]: 'The gateway could not persist an event, so it was not delivered.',
  [PERSISTENCE_ERROR.LOCKED]: 'Another gateway instance already owns this state store.',
  [PERSISTENCE_ERROR.VERSION_UNSUPPORTED]: 'The gateway state store has an unsupported format version.',
  [PERSISTENCE_ERROR.JOURNAL_CORRUPT]: 'The gateway event journal is damaged.',
  [PERSISTENCE_ERROR.JOURNAL_SEQUENCE_ERROR]: 'The gateway event journal has an inconsistent sequence.',
  [PERSISTENCE_ERROR.AHEAD_OF_JOURNAL]: 'The gateway state is ahead of its event journal.',
  [PERSISTENCE_ERROR.PATH_INVALID]: 'The gateway state path is not usable.',
  [PERSISTENCE_ERROR.SNAPSHOT_INVALID]: 'The gateway session snapshot is unreadable.',
});

/**
 * Build a persistence error with a safe message.
 *
 * @param {string} code - a `PERSISTENCE_ERROR` value.
 * @param {object} [options] - extras.
 * @param {string} [options.message] - overrides the safe default; keep it path-free.
 * @param {unknown} [options.cause] - the underlying failure.
 * @param {object} [options.details] - safe context.
 * @returns {PersistenceError} the error.
 */
export function persistenceError(code, options = {}) {
  return new PersistenceError(code, options.message ?? SAFE_MESSAGE[code] ?? 'The gateway state store failed.', {
    cause: options.cause,
    details: options.details,
  });
}

/**
 * Map a persistence failure onto an HTTP `ApiError` — §57 says 503 for most.
 *
 * `STATE_AHEAD_OF_JOURNAL` and `JOURNAL_CORRUPT` are startup failures, so they
 * also map to 503: from a client's perspective the gateway simply cannot serve.
 *
 * @param {unknown} error - the thrown value.
 * @returns {ApiError} an API error safe to serialise.
 */
export function toApiError(error) {
  if (error instanceof ApiError) return error;
  const code = isPersistenceError(error) ? error.code : PERSISTENCE_ERROR.UNAVAILABLE;

  // §57: map to 503 by default. A write failure is also 503 — the gateway cannot
  // honour a durable mutation, which is a downstream-availability problem rather
  // than a bad request.
  return new ApiError(
    HTTP_STATUS.UNAVAILABLE,
    code,
    SAFE_MESSAGE[code] ?? 'The gateway state store is unavailable.',
    { retryable: code === PERSISTENCE_ERROR.WRITE_FAILED || code === PERSISTENCE_ERROR.UNAVAILABLE },
  );
}

export { API_ERROR, HTTP_STATUS };
