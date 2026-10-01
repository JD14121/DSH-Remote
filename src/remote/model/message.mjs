/**
 * Message domain model —Phase R2 §6.
 *
 * Schema (§6):
 *
 *   { id, session_id, role, type, content, created_at, sequence,
 *     source_sequence?, observed_at, metadata? }
 *
 * Two rules carried forward from R1 and tightened here:
 *
 *   1. **Fail visible.** An unrecognised DSH event becomes a message with
 *      `type: 'unknown'` that keeps its payload and its source sequence. It is
 *      never dropped (§6.2).
 *
 *   2. **Deterministic identity.** The same durable DSH event read twice yields
 *      the same message id. No random UUID is ever minted for history (§6.1).
 *
 * `sequence` is the message's **DSH durable** seq, and is explicitly *not* a
 * Gateway event sequence. The two spaces stay separate (§8).
 *
 * Types are deliberately not collapsed to `"message"` (§6): a tool call, a tool
 * result and a streaming delta remain distinguishable, because a UI must be able
 * to render them differently and a future client must be able to tell a
 * provisional delta from committed output.
 */

import { isJsonValue, isRecord } from './guards.mjs';
import { safeStringify } from '../redact.mjs';
import { toIso } from './time.mjs';

/** Allowed roles (§6). */
export const MESSAGE_ROLE = Object.freeze({
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
  TOOL: 'tool',
});

/** Allowed types (§6, plus `assistant_delta` for the live-only stream). */
export const MESSAGE_TYPE = Object.freeze({
  MESSAGE: 'message',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  REASONING: 'reasoning',
  ASSISTANT_DELTA: 'assistant_delta',
  UNKNOWN: 'unknown',
});

/** Every legal role value. */
export const ALL_ROLES = Object.freeze(Object.values(MESSAGE_ROLE));

/** Every legal type value. */
export const ALL_MESSAGE_TYPES = Object.freeze(Object.values(MESSAGE_TYPE));

/**
 * DSH event type -> `{ role, type }`.
 *
 * Absent entries are **not** guessed at: they normalise to `system`/`unknown`.
 * Sourced from `docs/r2-status-evidence.md`.
 */
const EVENT_SHAPE = Object.freeze({
  'user/message': { role: MESSAGE_ROLE.USER, type: MESSAGE_TYPE.MESSAGE },
  'system/message': { role: MESSAGE_ROLE.SYSTEM, type: MESSAGE_TYPE.MESSAGE },
  'assistant/message': { role: MESSAGE_ROLE.ASSISTANT, type: MESSAGE_TYPE.MESSAGE },
  'assistant/attempt': { role: MESSAGE_ROLE.ASSISTANT, type: MESSAGE_TYPE.MESSAGE },
  'tool/call': { role: MESSAGE_ROLE.TOOL, type: MESSAGE_TYPE.TOOL_CALL },
  'tool/result': { role: MESSAGE_ROLE.TOOL, type: MESSAGE_TYPE.TOOL_RESULT },
  'session/title': { role: MESSAGE_ROLE.SYSTEM, type: MESSAGE_TYPE.MESSAGE },
  'goal/change': { role: MESSAGE_ROLE.SYSTEM, type: MESSAGE_TYPE.MESSAGE },
});

/**
 * Whether a DSH event type has an explicit role/type mapping.
 *
 * @param {string} dshEventType - DSH event type.
 * @returns {boolean} true when mapped.
 */
export function isKnownDshEvent(dshEventType) {
  return Object.hasOwn(EVENT_SHAPE, dshEventType);
}

/**
 * Deterministic message id.
 *
 * Recommendation from §6.1: `session-id + DSH durable sequence + normalized type`.
 * The type is included because one DSH event seq is unique per session, but
 * including it keeps the identity self-describing and makes a wrong reuse
 * visible. For an event with no durable seq (a live stream delta), a stable hash
 * over the session id and the event's own identity is used instead of a random id.
 *
 * @param {object} input - identity input.
 * @param {string} input.sessionId - owning session.
 * @param {number|null} input.sourceSequence - DSH durable seq, when one exists.
 * @param {string} input.type - normalised message type.
 * @param {unknown} [input.streamIdentity] - stable identity for a seq-less event.
 * @returns {string} a stable message id.
 */
export function makeMessageId(input) {
  const { sessionId, sourceSequence, type } = input;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('message id requires a sessionId');
  }
  if (sourceSequence !== null && sourceSequence !== undefined) {
    if (!Number.isFinite(sourceSequence)) {
      throw new TypeError('message id sourceSequence must be a finite number when present');
    }
    return `${sessionId}:${sourceSequence}:${type}`;
  }
  // No durable seq: derive a stable token from the event's own identity.
  const identity = safeStringify(input.streamIdentity ?? null);
  return `${sessionId}:s:${hashToken(`${identity}|${type}`)}:${type}`;
}

/**
 * Small deterministic non-cryptographic hash (FNV-1a, 32-bit) rendered as hex.
 *
 * Used only to make a seq-less message id stable and readable. It is not a
 * security primitive and is never used for integrity.
 *
 * @param {string} text - text to hash.
 * @returns {string} 8 hex characters.
 */
export function hashToken(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Extract display content for a known event.
 *
 * Strings pass through. Structured values are preserved as data rather than
 * flattened, and the raw tool argument string is never parsed (§22 of R1 still
 * holds: a tool argument string stays a string).
 *
 * @param {string} dshEventType - DSH event type.
 * @param {object} data - the event's payload.
 * @returns {unknown} content.
 */
function contentForKnownEvent(dshEventType, data) {
  if (dshEventType === 'tool/call') {
    return {
      name: typeof data.name === 'string' ? data.name : null,
      // Raw, unparsed JSON string as DSH recorded it.
      arguments: data.arguments ?? null,
      call_id: data.callId ?? null,
    };
  }
  if (dshEventType === 'tool/result') {
    return {
      ok: data.error === undefined || data.error === null,
      message: data.message ?? null,
      ...(data.error === undefined ? {} : { error: data.error }),
      ...(data.callId === undefined ? {} : { call_id: data.callId }),
    };
  }
  if (dshEventType === 'session/title') {
    return {
      title: data.title ?? null,
      source: data.source ?? null,
    };
  }
  if ('message' in data) return data.message;
  if ('text' in data) return data.text;
  return null;
}

/**
 * Build the opaque-safe content of an unrecognised event (§6.2).
 *
 * @param {object} event - the wire event.
 * @returns {object} content preserving the event type and payload.
 */
function contentForUnknownEvent(event) {
  return {
    kind: 'opaque',
    eventType: typeof event.type === 'string' ? event.type : null,
    data: isJsonValue(event.data) ? (event.data ?? null) : safeStringify(event.data),
  };
}

/**
 * Normalise one DSH `SessionWireEvent` into a domain Message.
 *
 * @param {object} event - a `SessionWireEvent`.
 * @param {string} sessionId - owning session.
 * @param {object} [options] - normalisation options.
 * @param {string} [options.observedAt] - ISO time the Gateway saw the event.
 * @param {object} [options.metadata] - extra domain metadata to attach.
 * @returns {object} the domain message.
 * @throws {TypeError} when the event is unusable.
 */
export function toDomainMessage(event, sessionId, options = {}) {
  if (!isRecord(event)) throw new TypeError('message normalisation requires a SessionWireEvent object');
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('message normalisation requires a sessionId');
  }
  const hasSequence = typeof event.seq === 'number' && Number.isFinite(event.seq);
  if (!hasSequence && typeof event.type !== 'string') {
    throw new TypeError('SessionWireEvent requires either a numeric seq or a string type');
  }

  const dshEventType = typeof event.type === 'string' ? event.type : '';
  const data = isRecord(event.data) ? event.data : {};
  const shape = EVENT_SHAPE[dshEventType];
  const role = shape?.role ?? MESSAGE_ROLE.SYSTEM;
  const type = shape?.type ?? MESSAGE_TYPE.UNKNOWN;
  const content = shape === undefined
    ? contentForUnknownEvent(event)
    : contentForKnownEvent(dshEventType, data);

  return {
    id: makeMessageId({
      sessionId,
      sourceSequence: hasSequence ? event.seq : null,
      type,
      streamIdentity: hasSequence ? null : { type: dshEventType, data: event.data },
    }),
    session_id: sessionId,
    role,
    type,
    event_type: dshEventType || null,
    content,
    // Source time only. `null` when DSH gave none —never the receive clock (§24).
    created_at: hasSequence || typeof event.time === 'number' ? toIso(event.time) : null,
    // DSH durable sequence. NOT a Gateway event sequence (§8).
    sequence: hasSequence ? event.seq : null,
    source_sequence: hasSequence ? event.seq : null,
    observed_at: options.observedAt ?? null,
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  };
}

/**
 * Normalise a batch of `SessionEventEntry` records into domain messages.
 *
 * Order is preserved exactly; nothing is de-duplicated, dropped, or re-sorted.
 *
 * @param {readonly object[]} records - `{ type: 'event', event }` records.
 * @param {string} sessionId - owning session.
 * @param {object} [options] - normalisation options.
 * @returns {object[]} domain messages in the order received.
 * @throws {TypeError} when a record is not an event entry.
 */
export function toDomainMessages(records, sessionId, options = {}) {
  if (!Array.isArray(records)) throw new TypeError('toDomainMessages requires an array of records');
  const out = [];
  for (const [index, record] of records.entries()) {
    if (!isRecord(record) || record.type !== 'event' || !isRecord(record.event)) {
      throw new TypeError(`records[${index}] is not a SessionEventEntry`);
    }
    out.push(toDomainMessage(record.event, sessionId, options));
  }
  return out;
}

/**
 * Build a live-only assistant delta message.
 *
 * This is the process-local presentation channel. It has **no** durable DSH seq,
 * which is exactly the case §8 describes, so `sequence` is `null` and the id is
 * derived from the attempt identity plus the chunk index. It is a distinct type
 * so a client can never mistake it for a committed message (§6.1).
 *
 * @param {object} input - delta input.
 * @param {string} input.sessionId - owning session.
 * @param {object} input.frame - a `SessionAssistantStreamFrame`.
 * @param {string} [input.observedAt] - ISO observation time.
 * @returns {object} a `type: 'assistant_delta'` message.
 * @throws {TypeError} when the frame is unusable.
 */
export function toAssistantDeltaMessage(input) {
  const { frame } = input;
  if (!isRecord(frame)) throw new TypeError('assistant delta requires a frame object');
  if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) {
    throw new TypeError('assistant delta requires a sessionId');
  }
  const identity = {
    attemptId: frame.attemptId ?? null,
    revision: frame.revision ?? null,
    index: frame.index ?? null,
  };
  return {
    id: makeMessageId({
      sessionId: input.sessionId,
      sourceSequence: null,
      type: MESSAGE_TYPE.ASSISTANT_DELTA,
      streamIdentity: identity,
    }),
    session_id: input.sessionId,
    role: MESSAGE_ROLE.ASSISTANT,
    type: MESSAGE_TYPE.ASSISTANT_DELTA,
    // The chunk is opaque and passed through untouched (§22 of R1, §6 of R2).
    content: { kind: 'assistant_delta', chunk: frame.chunk ?? null },
    created_at: toIso(frame.time),
    sequence: null,
    source_sequence: null,
    observed_at: input.observedAt ?? null,
    metadata: { attempt_id: identity.attemptId, revision: identity.revision, index: identity.index },
  };
}

/**
 * Assert a message id is stable by recomputing it.
 *
 * @param {object} message - a domain message.
 * @returns {boolean} true when the id matches the message's own identity.
 */
export function isMessageIdStable(message) {
  if (!isRecord(message)) return false;
  if (message.type === MESSAGE_TYPE.ASSISTANT_DELTA) {
    return typeof message.id === 'string' && message.id.includes(':s:');
  }
  if (message.source_sequence === null || message.source_sequence === undefined) return false;
  return message.id === `${message.session_id}:${message.source_sequence}:${message.type}`;
}
