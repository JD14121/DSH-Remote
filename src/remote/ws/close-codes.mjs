/**
 * WebSocket close codes — Phase R4 §33.
 *
 * Standard codes are RFC 6455; application codes must sit in the 3000-4999 range
 * that the RFC reserves for private use. Both are defined here once so the
 * documented contract and the implementation cannot drift.
 */

/** Standard RFC 6455 close codes. */
export const STANDARD_CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  POLICY_VIOLATION: 1008,
  INTERNAL_ERROR: 1011,
  TRY_AGAIN_LATER: 1013,
});

/** Application close codes, all inside the RFC's private 3000-4999 range. */
export const APP_CLOSE = Object.freeze({
  RESYNC_REQUIRED: 4001,
  SESSION_NOT_FOUND: 4002,
  BACKLOG_OVERFLOW: 4003,
  CLIENT_MESSAGE_NOT_ALLOWED: 4004,
});

/** Machine-readable reasons sent alongside a close code. */
export const CLOSE_REASON = Object.freeze({
  [APP_CLOSE.RESYNC_REQUIRED]: 'RESYNC_REQUIRED',
  [APP_CLOSE.SESSION_NOT_FOUND]: 'SESSION_NOT_FOUND',
  [APP_CLOSE.BACKLOG_OVERFLOW]: 'BACKLOG_OVERFLOW',
  [APP_CLOSE.CLIENT_MESSAGE_NOT_ALLOWED]: 'CLIENT_MESSAGE_NOT_ALLOWED',
  [STANDARD_CLOSE.NORMAL]: 'NORMAL',
  [STANDARD_CLOSE.GOING_AWAY]: 'SERVER_SHUTDOWN',
  [STANDARD_CLOSE.PROTOCOL_ERROR]: 'PROTOCOL_ERROR',
  [STANDARD_CLOSE.POLICY_VIOLATION]: 'POLICY_VIOLATION',
  [STANDARD_CLOSE.INTERNAL_ERROR]: 'INTERNAL_ERROR',
});

/**
 * The full close-code table, for documentation and tests.
 *
 * @returns {Array<{code: number, reason: string, meaning: string, kind: string}>} the table.
 */
export function closeCodeTable() {
  return [
    { code: 1000, reason: 'NORMAL', kind: 'standard', meaning: 'the client or server closed cleanly' },
    { code: 1001, reason: 'SERVER_SHUTDOWN', kind: 'standard', meaning: 'the gateway is going away' },
    { code: 1002, reason: 'PROTOCOL_ERROR', kind: 'standard', meaning: 'a WebSocket protocol violation' },
    { code: 1008, reason: 'POLICY_VIOLATION', kind: 'standard', meaning: 'policy refusal' },
    { code: 1011, reason: 'INTERNAL_ERROR', kind: 'standard', meaning: 'an unexpected server failure' },
    { code: 1013, reason: 'TRY_AGAIN_LATER', kind: 'standard', meaning: 'the server is not ready' },
    { code: 4001, reason: 'RESYNC_REQUIRED', kind: 'application', meaning: 'replay was impossible; refresh REST state' },
    { code: 4002, reason: 'SESSION_NOT_FOUND', kind: 'application', meaning: 'the subscribed session does not exist' },
    { code: 4003, reason: 'BACKLOG_OVERFLOW', kind: 'application', meaning: 'this client fell too far behind' },
    { code: 4004, reason: 'CLIENT_MESSAGE_NOT_ALLOWED', kind: 'application', meaning: 'the client sent an unsupported frame' },
  ];
}

/**
 * Whether a code is a legal application close code.
 *
 * @param {unknown} code - candidate code.
 * @returns {boolean} true when the code is in 3000-4999.
 */
export function isApplicationCloseCode(code) {
  return Number.isSafeInteger(code) && code >= 3000 && code <= 4999;
}

/**
 * The reason string for a close code.
 *
 * @param {number} code - the close code.
 * @returns {string} a short reason.
 */
export function closeReason(code) {
  return CLOSE_REASON[code] ?? 'CLOSED';
}
