/**
 * WebSocket protocol v1 — Phase R4 §7, §14-§18, §24, §29, §40.
 *
 * Central definition of the wire vocabulary. §7 requires the protocol version to
 * live in one place, and §15 forbids the WS layer from inventing a second
 * status/message vocabulary: every `event` frame carries an **R2 Gateway Event**
 * verbatim.
 */

/** WebSocket subprotocol name offered at upgrade. */
export const PROTOCOL = 'dsh-remote-v1';

/** API version reported in `hello`. */
export const API_VERSION = 1;

/** The only path that accepts an upgrade. */
export const EVENTS_PATH = '/api/v1/events';

/**
 * Server-to-client frame types.
 *
 * `hello`, `heartbeat`, `replay_complete`, `resync_required`, `overflow`,
 * `error` and `server_shutdown` are **control** frames; they are not Gateway
 * Events and consume no Gateway sequence.
 */
export const FRAME = Object.freeze({
  HELLO: 'hello',
  EVENT: 'event',
  HEARTBEAT: 'heartbeat',
  REPLAY_COMPLETE: 'replay_complete',
  RESYNC_REQUIRED: 'resync_required',
  OVERFLOW: 'overflow',
  ERROR: 'error',
  SERVER_SHUTDOWN: 'server_shutdown',
});

/** The one client-to-server frame R4 accepts (§31). */
export const CLIENT_FRAME = Object.freeze({
  PING: 'client_ping',
});

/**
 * Connection lifecycle states (§13).
 *
 * The order matters: a client is registered and its replay boundary captured
 * *before* any historical frame is sent, otherwise an event arriving during
 * replay could be lost.
 */
export const CONNECTION_STATE = Object.freeze({
  UPGRADING: 'UPGRADING',
  CONNECTED: 'CONNECTED',
  REPLAYING: 'REPLAYING',
  LIVE: 'LIVE',
  CLOSING: 'CLOSING',
  CLOSED: 'CLOSED',
});

/** Replay modes reported in `hello`. */
export const REPLAY_MODE = Object.freeze({
  LIVE_ONLY: 'live_only',
  REPLAY: 'replay',
  RESYNC: 'resync',
});

/** `resync_required` reasons (§24, §36). */
export const RESYNC_REASON = Object.freeze({
  /** The requested watermark is older than anything the ring still retains. */
  GAP_NOT_AVAILABLE: 'gap_not_available',
  /** The watermark is greater than this process's latest sequence (§36). */
  SEQUENCE_AHEAD_OF_SERVER: 'sequence_ahead_of_server',
});

/** The action a client should take after a resync (§24). */
export const RESYNC_ACTION = 'refresh_rest_state';

/**
 * Build the opening `hello` frame (§14).
 *
 * @param {object} input - frame input.
 * @param {string} input.connectionId - this connection's id.
 * @param {string} input.sessionId - the subscribed session.
 * @param {string} input.serverTime - ISO server time.
 * @param {number|null} input.latest - the latest Gateway sequence, or `null`.
 * @param {number|null} input.earliestAvailable - the oldest replayable sequence.
 * @param {number|null} input.requestedFrom - the client's `last_sequence`.
 * @param {string} input.mode - a `REPLAY_MODE` value.
 * @returns {object} the frame.
 */
export function helloFrame(input) {
  return {
    type: FRAME.HELLO,
    api_version: API_VERSION,
    protocol: PROTOCOL,
    connection_id: input.connectionId,
    session_id: input.sessionId,
    server_time: input.serverTime,
    sequence: {
      latest: input.latest,
      earliest_available: input.earliestAvailable,
    },
    replay: {
      requested_from: input.requestedFrom,
      mode: input.mode,
    },
  };
}

/**
 * Build an `event` frame carrying an R2 Gateway Event verbatim (§15).
 *
 * @param {object} event - a Gateway event.
 * @returns {object} the frame.
 */
export function eventFrame(event) {
  return { type: FRAME.EVENT, event };
}

/**
 * Build an application heartbeat frame (§17).
 *
 * @param {object} input - frame input.
 * @param {string} input.serverTime - ISO server time.
 * @param {string} input.sessionId - the subscribed session.
 * @param {number|null} input.latestSequence - the latest Gateway sequence.
 * @returns {object} the frame.
 */
export function heartbeatFrame(input) {
  return {
    type: FRAME.HEARTBEAT,
    server_time: input.serverTime,
    session_id: input.sessionId,
    latest_sequence: input.latestSequence,
  };
}

/**
 * Build a `replay_complete` frame (§16).
 *
 * @param {object} input - frame input.
 * @param {string} input.sessionId - the subscribed session.
 * @param {number|null} input.fromSequence - the first replayed sequence.
 * @param {number|null} input.throughSequence - the last replayed sequence.
 * @param {number} input.replayed - how many events were sent.
 * @returns {object} the frame.
 */
export function replayCompleteFrame(input) {
  return {
    type: FRAME.REPLAY_COMPLETE,
    session_id: input.sessionId,
    from_sequence: input.fromSequence,
    through_sequence: input.throughSequence,
    replayed: input.replayed,
  };
}

/**
 * Build a `resync_required` frame (§24).
 *
 * @param {object} input - frame input.
 * @param {string} input.sessionId - the subscribed session.
 * @param {string} input.reason - a `RESYNC_REASON` value.
 * @param {number} input.requestedSequence - what the client asked for.
 * @param {number|null} input.earliestAvailable - the oldest retained sequence.
 * @param {number|null} input.latestAvailable - the newest retained sequence.
 * @returns {object} the frame.
 */
export function resyncRequiredFrame(input) {
  return {
    type: FRAME.RESYNC_REQUIRED,
    session_id: input.sessionId,
    reason: input.reason,
    requested_sequence: input.requestedSequence,
    earliest_available: input.earliestAvailable,
    latest_available: input.latestAvailable,
    action: RESYNC_ACTION,
  };
}

/**
 * Build an `overflow` frame (§29).
 *
 * @param {object} input - frame input.
 * @param {string} input.sessionId - the subscribed session.
 * @param {number|null} input.lastDeliveredSequence - the last sequence actually sent.
 * @param {number|null} input.latestSequence - the latest available sequence.
 * @returns {object} the frame.
 */
export function overflowFrame(input) {
  return {
    type: FRAME.OVERFLOW,
    session_id: input.sessionId,
    last_delivered_sequence: input.lastDeliveredSequence,
    latest_sequence: input.latestSequence,
    action: 'reconnect_with_last_sequence',
  };
}

/**
 * Build an `error` frame (§34).
 *
 * Only safe fields survive: no stack, no `cause`, no cookie, no token, no
 * credential, no filesystem path, no raw wire object.
 *
 * @param {object} input - frame input.
 * @param {string} input.code - a stable error code.
 * @param {string} input.message - a safe, human-readable message.
 * @param {boolean} [input.retryable] - whether the client may retry.
 * @param {string|null} [input.connectionId] - this connection's id.
 * @returns {object} the frame.
 */
export function errorFrame(input) {
  return {
    type: FRAME.ERROR,
    error: {
      code: input.code,
      message: input.message,
      retryable: input.retryable === true,
      connection_id: input.connectionId ?? null,
    },
  };
}

/**
 * Build the `server_shutdown` frame (§40).
 *
 * @returns {object} the frame.
 */
export function serverShutdownFrame() {
  return { type: FRAME.SERVER_SHUTDOWN, retryable: true };
}

/**
 * Every control frame type, for validation and documentation.
 *
 * @returns {string[]} the control frame names.
 */
export function controlFrameTypes() {
  return [
    FRAME.HELLO,
    FRAME.HEARTBEAT,
    FRAME.REPLAY_COMPLETE,
    FRAME.RESYNC_REQUIRED,
    FRAME.OVERFLOW,
    FRAME.ERROR,
    FRAME.SERVER_SHUTDOWN,
  ];
}
