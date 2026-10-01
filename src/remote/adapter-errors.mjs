/**
 * Adapter error vocabulary — Phase R1 §5.2.
 *
 * Every failure that crosses the adapter boundary is one of these codes. The
 * mobile surface (R3+) must never see a DSH error code, an HTTP status, or a
 * wire string; it sees `code` and a redacted `message`.
 *
 * Security invariant: no error produced by this module ever contains a cookie,
 * a token, an `Authorization` value, or a credential. Messages are passed
 * through `redactString` before construction, and `details` is redacted with
 * `redactValue`.
 */

import { redactString, redactValue } from './redact.mjs';

/** Stable adapter error codes (R1 §5.2). */
export const ADAPTER_ERROR = Object.freeze({
  DSH_UNAVAILABLE: 'DSH_UNAVAILABLE',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_COLD: 'SESSION_COLD',
  PROMPT_REJECTED: 'PROMPT_REJECTED',
  CANCEL_UNSUPPORTED: 'CANCEL_UNSUPPORTED',
  WIRE_VERSION_MISMATCH: 'WIRE_VERSION_MISMATCH',
  AUTH_UNAVAILABLE: 'AUTH_UNAVAILABLE',
  AUTH_REJECTED: 'AUTH_REJECTED',
  WIRE_PROTOCOL_ERROR: 'WIRE_PROTOCOL_ERROR',
  STREAM_ABORTED: 'STREAM_ABORTED',
});

/** Codes regarded as retryable by a caller. */
const RETRYABLE = Object.freeze(
  new Set([
    ADAPTER_ERROR.DSH_UNAVAILABLE,
    ADAPTER_ERROR.STREAM_ABORTED,
  ]),
);

/**
 * One adapter failure.
 *
 * Carries `code`, `message`, optional `cause`, `retryable` and `details`, per
 * R1 §5.2.
 */
export class AdapterError extends Error {
  /**
   * @param {string} code - one of `ADAPTER_ERROR`.
   * @param {string} message - human-readable, already-safe description.
   * @param {object} [options] - extra fields.
   * @param {unknown} [options.cause] - underlying failure, kept for local debugging.
   * @param {boolean} [options.retryable] - overrides the code's default.
   * @param {object} [options.details] - structured, redacted context.
   * @param {readonly string[]} [options.secrets] - values that must never appear.
   */
  constructor(code, message, options = {}) {
    const secrets = options.secrets ?? [];
    super(redactString(message, secrets));
    this.name = 'AdapterError';
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.details = options.details === undefined
      ? undefined
      : redactValue(options.details, secrets);
    if (options.cause !== undefined) {
      // Keep the cause for local debugging but never let it reach serialization
      // unredacted: a cause's own message may embed a URL or header value.
      this.cause = options.cause instanceof Error
        ? new Error(redactString(options.cause.message, secrets))
        : redactValue(options.cause, secrets);
    }
  }

  /** JSON-safe projection for logs and wire responses. */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

/**
 * Build an `AdapterError`.
 *
 * @param {string} code - one of `ADAPTER_ERROR`.
 * @param {string} message - description.
 * @param {object} [options] - see `AdapterError`.
 * @returns {AdapterError} the constructed error.
 */
export function adapterError(code, message, options) {
  return new AdapterError(code, message, options);
}

/**
 * Whether a value is an `AdapterError`.
 *
 * @param {unknown} value - value to test.
 * @returns {boolean} true for an `AdapterError`.
 */
export function isAdapterError(value) {
  return value instanceof AdapterError;
}

/**
 * Coerce any thrown value into an `AdapterError`.
 *
 * An already-adapter error passes through unchanged so that an inner, more
 * precise code is never downgraded by an outer wrapper.
 *
 * @param {unknown} error - thrown value.
 * @param {string} [fallbackCode] - code to use for an unrecognised value.
 * @param {readonly string[]} [secrets] - values that must never appear.
 * @returns {AdapterError} an adapter error.
 */
export function toAdapterError(error, fallbackCode = ADAPTER_ERROR.WIRE_PROTOCOL_ERROR, secrets = []) {
  if (error instanceof AdapterError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AdapterError(fallbackCode, message, { cause: error, secrets });
}

/**
 * Whether an abort signal caused a failure.
 *
 * @param {unknown} error - thrown value.
 * @returns {boolean} true when the failure is an abort.
 */
export function isAbortError(error) {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

/**
 * Map a DSH Remote error code (from the `server-response` error branch) onto an
 * adapter code.
 *
 * R1 observed codes come from `dsh-api-gateway` / `dsh-api-session-controller`:
 * `gateway/*`, `session/not-found`, `session/agent-busy`, `session/conflict`.
 *
 * @param {string} remoteCode - the DSH-side error code.
 * @param {object} [context] - mapping hints.
 * @param {boolean} [context.cancelOperation] - true when mapping a cancel call.
 * @returns {string} an `ADAPTER_ERROR` code.
 */
export function mapRemoteCode(remoteCode, context = {}) {
  if (typeof remoteCode !== 'string' || remoteCode.length === 0) {
    return ADAPTER_ERROR.WIRE_PROTOCOL_ERROR;
  }

  if (remoteCode.startsWith('gateway/')) {
    switch (remoteCode) {
      case 'gateway/cancelled':
        return ADAPTER_ERROR.STREAM_ABORTED;
      case 'gateway/arguments-invalid':
      case 'gateway/bad-request':
      case 'gateway/signature-invalid':
        return ADAPTER_ERROR.WIRE_PROTOCOL_ERROR;
      default:
        return ADAPTER_ERROR.DSH_UNAVAILABLE;
    }
  }

  switch (remoteCode) {
    case 'session/not-found':
      // `session/cancel` reads `ctx.agents.get()` only, so a not-attached
      // session is indistinguishable from an unknown one. For a cancel call
      // that means the session is cold; R1 §15 requires SESSION_COLD there.
      return context.cancelOperation
        ? ADAPTER_ERROR.SESSION_COLD
        : ADAPTER_ERROR.SESSION_NOT_FOUND;
    case 'session/agent-busy':
    case 'session/conflict':
    case 'session/model-unavailable':
    case 'session/attachment-invalid':
    case 'session/invalid-time-zone':
    case 'agent-preset/locked':
    case 'agent-preset/not-found':
    case 'agent-preset/invalid':
      return ADAPTER_ERROR.PROMPT_REJECTED;
    default:
      return ADAPTER_ERROR.DSH_UNAVAILABLE;
  }
}
