/**
 * Session event normalization -> mobile message shape —Phase R1 §11.
 *
 * Target shape (R1 §11):
 *
 *   { id, session_id, role, type, content, created_at, sequence }
 *
 * Two rules drive every decision here:
 *
 *   1. Fail visible, never silently discard. An unrecognised `SessionWireEvent`
 *      becomes a `system` / `unknown` message that still carries its sequence
 *      and its opaque payload. A future DSH event type must show up as data the
 *      caller can see, not vanish.
 *
 *   2. Boundaries stay opaque. The adapter does not reinterpret a tool argument
 *      string, a tool result payload, or an LLM stream chunk. It copies them.
 *
 * R1 §11 explicitly scopes this to a "usable and conservative" normalization;
 * richer presentation is R2+.
 */

import { isJsonValue, isRecord } from '../model/guards.mjs';
import { safeStringify } from '../redact.mjs';

/** Role vocabulary the mobile surface may rely on (R1 §11). */
export const MESSAGE_ROLE = Object.freeze({
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
  TOOL: 'tool',
});

/** Message `type` values this translator emits. */
export const MESSAGE_TYPE = Object.freeze({
  MESSAGE: 'message',
  TOOL_CALL: 'tool-call',
  TOOL_RESULT: 'tool-result',
  UNKNOWN: 'unknown',
});

/**
 * Explicit mapping for the durable event types R1 understands.
 *
 * Anything absent from this table is deliberately not guessed at.
 */
const KNOWN_EVENT_TYPES = Object.freeze({
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
 * Whether a durable event type is one R1 maps to a role and type.
 *
 * @param {string} eventType - DSH event type, e.g. `user/message`.
 * @returns {boolean} true when the event is in the known table.
 */
export function isKnownEventType(eventType) {
  return Object.hasOwn(KNOWN_EVENT_TYPES, eventType);
}

/**
 * Extract the best available display content from a known event.
 *
 * Only string-or-absent handling happens here; every other value is passed
 * through untouched so no information is lost.
 *
 * @param {string} eventType - DSH event type.
 * @param {object} data - the event's `data` payload.
 * @returns {unknown} display content.
 */
function contentFromKnownEvent(eventType, data) {
  if (eventType === 'tool/call') {
    return {
      name: typeof data.name === 'string' ? data.name : null,
      // `arguments` is the raw, unparsed JSON string DSH recorded. R1 copies it.
      arguments: data.arguments ?? null,
    };
  }
  if (eventType === 'tool/result') {
    return {
      ok: data.error === undefined || data.error === null,
      message: data.message ?? null,
      ...(data.error === undefined ? {} : { error: data.error }),
    };
  }
  if (eventType === 'session/title') {
    return data.title ?? data.text ?? null;
  }
  if ('message' in data) return data.message;
  if ('text' in data) return data.text;
  return null;
}

/**
 * Build a conservative, opaque-safe content value for an unrecognised event.
 *
 * @param {object} event - the wire event.
 * @returns {object} content carrying the event type and its payload.
 */
function contentFromUnknownEvent(event) {
  const data = event.data;
  return {
    kind: 'opaque',
    eventType: typeof event.type === 'string' ? event.type : null,
    // Preserve the payload when it is JSON-safe; otherwise preserve a string
    // form so the fact of its existence still reaches the caller.
    data: isJsonValue(data) ? data : safeStringify(data),
  };
}

/**
 * Convert one `SessionWireEvent` into a mobile message.
 *
 * @param {object} event - a `SessionWireEvent` (`type`, `seq`, `time`, `data`).
 * @param {string} sessionId - owning session.
 * @returns {object} `{ id, session_id, role, type, content, created_at, sequence }`.
 * @throws {TypeError} when the event is not a usable wire event.
 */
export function toMessage(event, sessionId, options = {}) {
  if (!isRecord(event)) {
    throw new TypeError('message translation requires a SessionWireEvent object');
  }
  if (typeof event.seq !== 'number' || !Number.isFinite(event.seq)) {
    throw new TypeError('SessionWireEvent.seq must be a finite number');
  }
  const eventType = typeof event.type === 'string' ? event.type : '';
  const data = isRecord(event.data) ? event.data : {};
  const known = KNOWN_EVENT_TYPES[eventType];

  const role = known?.role ?? MESSAGE_ROLE.SYSTEM;
  const type = known?.type ?? MESSAGE_TYPE.UNKNOWN;
  const content = known === undefined
    ? contentFromUnknownEvent(event)
    : contentFromKnownEvent(eventType, data);

  return {
    id: `${sessionId}:${event.seq}`,
    session_id: sessionId,
    role,
    type,
    event_type: eventType || null,
    content,
    created_at: typeof event.time === 'number' ? new Date(event.time).toISOString() : null,
    sequence: event.seq,
    ...(Number.isSafeInteger(data.turn) ? { turn: data.turn } : {}),
    ...(Number.isSafeInteger(data.step) ? { step: data.step } : {}),
    ...(typeof data.callId === 'string' ? { call_id: data.callId } : {}),
    ...(options.turnStartedAt ? { turn_started_at: options.turnStartedAt } : {}),
    ...(options.turnEndedAt ? { turn_ended_at: options.turnEndedAt } : {}),
    ...(known?.role === MESSAGE_ROLE.ASSISTANT && options.usage !== undefined
      ? { usage: options.usage }
      : {}),
    ...(known?.role === MESSAGE_ROLE.ASSISTANT && options.durationMs !== undefined
      ? { durationMs: options.durationMs }
      : {}),
  };
}

/**
 * Convert a page of `SessionEventEntry` records into messages.
 *
 * Order is preserved exactly; duplicates are not removed and gaps are not
 * closed. Range correctness belongs to the Host.
 *
 * @param {readonly object[]} records - `{ type: 'event', event }` records.
 * @param {string} sessionId - owning session.
 * @returns {object[]} messages in the order received.
 * @throws {TypeError} when a record is not an event entry.
 */
export function toMessages(records, sessionId) {
  if (!Array.isArray(records)) {
    throw new TypeError('toMessages requires an array of SessionEventEntry records');
  }
  const stepStarts = new Map();
  const turns = new Map();
  for (const { event } of records) {
    if (!Number.isSafeInteger(event?.data?.turn) || !Number.isFinite(event.time)) continue;
    const times = turns.get(event.data.turn) ?? {};
    if (event.type === 'turn/start') times.start = new Date(event.time).toISOString();
    if (event.type === 'turn/end') times.end = new Date(event.time).toISOString();
    turns.set(event.data.turn, times);
  }
  for (const record of records) {
    const event = record?.event;
    const data = isRecord(event?.data) ? event.data : {};
    if (event?.type === 'step/start'
      && Number.isInteger(data.turn) && Number.isInteger(data.step)
      && typeof event.time === 'number' && Number.isFinite(event.time)) {
      stepStarts.set(`${data.turn}:${data.step}`, event.time);
    }
  }
  const out = [];
  for (const [index, record] of records.entries()) {
    if (!isRecord(record) || record.type !== 'event' || !isRecord(record.event)) {
      throw new TypeError(`records[${index}] is not a SessionEventEntry`);
    }
    const event = record.event;
    const data = isRecord(event.data) ? event.data : {};
    const usage = event.type === 'assistant/message' ? normalizeUsage(data.usage) : undefined;
    const stepStart = event.type === 'assistant/message'
      ? stepStarts.get(`${data.turn}:${data.step}`)
      : undefined;
    const durationMs = stepStart !== undefined && typeof event.time === 'number'
      ? Math.max(0, event.time - stepStart)
      : undefined;
    out.push(toMessage(event, sessionId, {
      turnStartedAt: turns.get(data.turn)?.start,
      turnEndedAt: turns.get(data.turn)?.end,
      ...(usage === undefined ? {} : { usage }),
      ...(durationMs === undefined ? {} : { durationMs }),
    }));
  }
  return out;
}

/** Copy DSH's provider-reported usage, deriving total only from disjoint buckets. */
function normalizeUsage(value) {
  if (!isRecord(value)) return undefined;
  const keys = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
  const usage = {};
  for (const key of keys) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0) usage[key] = value[key];
  }
  if (usage.totalTokens === undefined
    && typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number') {
    usage.totalTokens = usage.inputTokens + usage.outputTokens
      + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  }
  return typeof usage.totalTokens === 'number' ? usage : undefined;
}

/**
 * Project the conversation turns a mobile client would render.
 *
 * Kept separate so a caller can choose raw events or a rendered view without
 * either choice leaking into the other.
 *
 * @param {readonly object[]} messages - output of `toMessages`.
 * @returns {object[]} only `user` and `assistant` messages.
 */
export function toConversation(messages) {
  return messages.filter(
    (message) => message.role === MESSAGE_ROLE.USER || message.role === MESSAGE_ROLE.ASSISTANT,
  );
}
