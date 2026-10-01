/**
 * WebSocket frame normalization.
 *
 * Every frame that arrives from the Gateway passes through here before anything else sees it.
 * Components never understand a raw frame, and they never parse a raw DSH chunk.
 *
 * ## The chunk is opaque — and that is not a formality
 *
 * The R0/R1 contract declares an assistant stream chunk to be an **opaque `JsonValue`**. The
 * Gateway passes it through untouched, and the fixtures prove how little can be assumed: one
 * shape is an object, another is an **array** of content blocks, and both are legitimate.
 *
 * So this module does **not** assume `payload.delta.text`, `payload.content` or
 * `payload.token`. It recognises a deliberately small set of *text-bearing* shapes and returns
 * the text when one matches. Anything else is preserved verbatim and contributes **no text** —
 * it is never reinterpreted, and a chunk that cannot be read is never an error.
 *
 * The consequence is a rule the UI depends on: a stream may legitimately produce zero visible
 * text while still being active. Unknown chunks must not break the socket, and must not be
 * guessed at.
 */

/** The frame types the frozen R4 protocol defines. */
export const FRAME = Object.freeze({
  HELLO: 'hello',
  EVENT: 'event',
  HEARTBEAT: 'heartbeat',
  REPLAY_COMPLETE: 'replay_complete',
  RESYNC_REQUIRED: 'resync_required',
  OVERFLOW: 'overflow',
  ERROR: 'error',
  SERVER_SHUTDOWN: 'server_shutdown',
  UNKNOWN: 'unknown',
});

/** The Gateway event names the UI acts on. Everything else is preserved but inert. */
export const UI_EVENT = Object.freeze({
  SESSION_STATUS: 'session.status',
  MESSAGE_CREATED: 'message.created',
  TOOL_STARTED: 'tool.started',
  TOOL_COMPLETED: 'tool.completed',
  TOOL_OUTPUT: 'tool.output',
  TASK_PROGRESS: 'task.progress',
  ASSISTANT_START: 'assistant.start',
  ASSISTANT_DELTA: 'assistant.delta',
  ASSISTANT_END: 'assistant.end',
  TASK_COMPLETED: 'task.completed',
  TASK_FAILED: 'task.failed',
  TASK_CANCELLED: 'task.cancelled',
  TRANSPORT_DISCONNECTED: 'transport.disconnected',
  TRANSPORT_RECONNECTED: 'transport.reconnected',
  UNKNOWN: 'unknown',
});

/**
 * Read text out of an opaque assistant chunk.
 *
 * Deliberately conservative. It checks a small, documented set of shapes and gives up
 * otherwise. It does **not** walk arbitrary structures looking for something string-shaped,
 * because that would be guessing at a contract this layer does not own.
 *
 * @param {unknown} chunk - the opaque chunk.
 * @returns {{text: string, recognised: boolean}} the text, and whether a known shape matched.
 */
export function resolveChunkText(chunk) {
  if (typeof chunk === 'string') return { text: chunk, recognised: true };
  if (chunk === null || typeof chunk !== 'object') return { text: '', recognised: false };

  // An array of blocks: concatenate the text-bearing ones, ignore the rest.
  if (Array.isArray(chunk)) {
    let text = '';
    let recognised = false;
    for (const block of chunk) {
      const inner = resolveChunkText(block);
      if (inner.recognised) recognised = true;
      text += inner.text;
    }
    return { text, recognised };
  }

  if (typeof chunk.type === 'string' && !['text', 'text-delta'].includes(chunk.type)) return {text:'', recognised:false};

  // Well-known flat text fields, in a fixed order.
  for (const key of ['text', 'delta', 'content']) {
    const value = chunk[key];
    if (typeof value === 'string') return { text: value, recognised: true };
    // `content` may itself be a block array or an object with a text field.
    if (value !== null && typeof value === 'object') {
      const inner = resolveChunkText(value);
      if (inner.recognised) return inner;
    }
  }

  // A block wrapper: `{ type: 'text', ... }`.
  if (chunk.type === 'text') {
    const inner = resolveChunkText(chunk.text ?? chunk.value ?? null);
    if (inner.recognised) return inner;
  }

  return { text: '', recognised: false };
}

/**
 * Normalize one raw frame into a UI-shaped frame.
 *
 * Unknown frame types and unknown Gateway events are returned as safe inert values rather than
 * thrown, so one unrecognised frame can never take down the connection.
 *
 * @param {unknown} raw - the parsed frame.
 * @returns {object} `{ type, ...}` — always an object, never throws.
 */
export function normalizeFrame(raw) {
  if (raw === null || typeof raw !== 'object') {
    return { type: FRAME.UNKNOWN, rawType: null, reason: 'not-an-object' };
  }
  const rawType = typeof raw.type === 'string' ? raw.type : null;

  switch (rawType) {
    case FRAME.HELLO:
      return {
        type: FRAME.HELLO,
        protocol: typeof raw.protocol === 'string' ? raw.protocol : null,
        apiVersion: typeof raw.api_version === 'number' ? raw.api_version : null,
        connectionId: typeof raw.connection_id === 'string' ? raw.connection_id : null,
        sessionId: typeof raw.session_id === 'string' ? raw.session_id : null,
        serverTime: typeof raw.server_time === 'string' ? raw.server_time : null,
        sequence: {
          latest: numberOrNull(raw.sequence?.latest),
          earliestAvailable: numberOrNull(raw.sequence?.earliest_available),
        },
        replay: {
          requestedFrom: numberOrNull(raw.replay?.requested_from),
          mode: typeof raw.replay?.mode === 'string' ? raw.replay.mode : null,
        },
      };

    case FRAME.EVENT:
      return normalizeEventFrame(raw.event);

    case FRAME.HEARTBEAT:
      return {
        type: FRAME.HEARTBEAT,
        serverTime: typeof raw.server_time === 'string' ? raw.server_time : null,
        sequence: numberOrNull(raw.sequence),
      };

    case FRAME.REPLAY_COMPLETE:
      return {
        type: FRAME.REPLAY_COMPLETE,
        mode: typeof raw.mode === 'string' ? raw.mode : null,
        sequence: numberOrNull(raw.sequence),
        replayed: numberOrNull(raw.replayed),
      };

    case FRAME.RESYNC_REQUIRED:
      return {
        type: FRAME.RESYNC_REQUIRED,
        reason: typeof raw.reason === 'string' ? raw.reason : null,
        action: typeof raw.action === 'string' ? raw.action : null,
      };

    case FRAME.OVERFLOW:
      return { type: FRAME.OVERFLOW, dropped: numberOrNull(raw.dropped) };

    case FRAME.ERROR:
      return {
        type: FRAME.ERROR,
        code: typeof raw.code === 'string' ? raw.code : null,
        // The server's message is deliberately NOT propagated: it may carry internals.
        retryable: raw.retryable === true,
      };

    case FRAME.SERVER_SHUTDOWN:
      return { type: FRAME.SERVER_SHUTDOWN, retryable: raw.retryable === true };

    default:
      return { type: FRAME.UNKNOWN, rawType, reason: 'unrecognised-frame-type' };
  }
}

/**
 * Normalize the `event` frame's inner Gateway event.
 *
 * @param {unknown} event - the Gateway event.
 * @returns {object} the UI event.
 */
export function normalizeEventFrame(event) {
  if (event === null || typeof event !== 'object') {
    return { type: FRAME.EVENT, event: UI_EVENT.UNKNOWN, sequence: null, sessionId: null, data: {}, inert: true };
  }

  const name = typeof event.event === 'string' ? event.event : UI_EVENT.UNKNOWN;
  const known = Object.values(UI_EVENT).includes(name);

  return {
    type: FRAME.EVENT,
    event: known ? name : UI_EVENT.UNKNOWN,
    // The Gateway sequence is the ONLY sequence the UI may use. It is never synthesised.
    sequence: numberOrNull(event.sequence),
    sessionId: typeof event.session_id === 'string' ? event.session_id : null,
    sourceSequence: numberOrNull(event.source_sequence),
    sourceTime: typeof event.timestamp === 'string' ? event.timestamp : typeof event.source_time === 'string' ? event.source_time : null,
    data: event.data !== null && typeof event.data === 'object' ? event.data : {},
    /** An unrecognised event is kept, marked inert, and never acted upon. */
    inert: known !== true,
    rawEventName: known ? null : name,
  };
}

/**
 * Coerce a wire value to a safe integer or null.
 *
 * @param {unknown} value - the candidate.
 * @returns {number|null} the number, or null.
 */
function numberOrNull(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/**
 * Normalize a WebSocket close event into a classification.
 *
 * The purpose is to stop every close from looking like an authentication failure: only a
 * ticket/auth rejection may clear the credential.
 *
 * @param {object} input - `code`, `wasClean`, `reason`.
 * @returns {{kind: string, code: number|null, retryable: boolean}} the classification.
 */
export function classifyClose(input = {}) {
  const code = typeof input.code === 'number' ? input.code : null;

  // 1000 is a normal closure: the client asked for it, or the server finished cleanly.
  if (code === 1000) return { kind: 'intentional', code, retryable: false };
  // 1008 policy violation carries auth/ticket rejection in this protocol.
  if (code === 1008) return { kind: 'auth_failure', code, retryable: false };
  if (code === 1002 || code === 1003) return { kind: 'protocol_violation', code, retryable: false };
  // 1001 going away and 4000-series application closes are server-side; retrying is reasonable.
  if (code === 1001) return { kind: 'server_close', code, retryable: true };
  if (code !== null && code >= 4000 && code < 5000) return { kind: 'server_close', code, retryable: true };
  // 1006 abnormal closure: no close frame reached us — a network drop.
  if (code === 1006) return { kind: 'network', code, retryable: true };
  if (code === null) return { kind: 'network', code: null, retryable: true };
  return { kind: 'unknown', code, retryable: true };
}
