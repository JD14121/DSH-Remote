/**
 * Gateway Event model —Phase R2 §7, §8, §24.
 *
 * A Gateway event is the **only** realtime structure a future phone API will
 * see. It carries two separate identities that must never be confused:
 *
 *   sequence         Gateway-owned, per-session, monotonic  (this Gateway)
 *   source_sequence  the DSH durable event seq, when one exists (DSH)
 *
 * They are unrelated numbers. `source_sequence` is `null` for anything that has
 * no durable DSH event behind it —an assistant streaming delta, for example,
 * which is a process-local presentation frame. That is exactly why the Gateway
 * needs its own sequence (R2 §8).
 *
 * Vocabulary (§7): the full list is declared even where the audit found no raw
 * signal, so the shape cannot drift later. R2 fabricates **no** event: a
 * vocabulary entry with no evidence is simply never emitted.
 */

import { isJsonValue } from './guards.mjs';
import { safeStringify } from '../redact.mjs';
import { toIso } from './time.mjs';

/** Gateway event vocabulary (R2 §7). */
export const GATEWAY_EVENT = Object.freeze({
  SESSION_STATUS: 'session.status',
  MESSAGE_CREATED: 'message.created',
  ASSISTANT_START: 'assistant.start',
  ASSISTANT_DELTA: 'assistant.delta',
  ASSISTANT_END: 'assistant.end',
  TOOL_STARTED: 'tool.started',
  TOOL_OUTPUT: 'tool.output',
  TOOL_COMPLETED: 'tool.completed',
  TASK_PROGRESS: 'task.progress',
  TASK_COMPLETED: 'task.completed',
  TASK_FAILED: 'task.failed',
  TASK_CANCELLED: 'task.cancelled',
  TRANSPORT_DISCONNECTED: 'transport.disconnected',
  TRANSPORT_RECONNECTED: 'transport.reconnected',
  UNKNOWN: 'unknown',
});

/** Every vocabulary value. */
export const ALL_GATEWAY_EVENTS = Object.freeze(Object.values(GATEWAY_EVENT));

/**
 * Which vocabulary entries actually have DSH evidence in R2.
 *
 * From `docs/r2-status-evidence.md` §8. Entries absent here are declared but not
 * emitted —the vocabulary is forward-compatible without being fiction.
 */
export const EVIDENCED_GATEWAY_EVENTS = Object.freeze([
  GATEWAY_EVENT.SESSION_STATUS,
  GATEWAY_EVENT.MESSAGE_CREATED,
  GATEWAY_EVENT.ASSISTANT_START,
  GATEWAY_EVENT.ASSISTANT_DELTA,
  GATEWAY_EVENT.ASSISTANT_END,
  GATEWAY_EVENT.TOOL_STARTED,
  GATEWAY_EVENT.TOOL_COMPLETED,
  GATEWAY_EVENT.TASK_PROGRESS,
  GATEWAY_EVENT.TASK_COMPLETED,
  GATEWAY_EVENT.TASK_FAILED,
  GATEWAY_EVENT.TASK_CANCELLED,
  GATEWAY_EVENT.TRANSPORT_DISCONNECTED,
  GATEWAY_EVENT.TRANSPORT_RECONNECTED,
  GATEWAY_EVENT.UNKNOWN,
]);

/**
 * DSH durable event type -> Gateway event kind.
 *
 * Only mappings justified by `docs/r2-status-evidence.md` appear here. Anything
 * else becomes `unknown`, which is a **kept** event, never a dropped one.
 */
export const DSH_EVENT_TO_GATEWAY_EVENT = Object.freeze({
  'assistant/message': GATEWAY_EVENT.MESSAGE_CREATED,
  'assistant/attempt': GATEWAY_EVENT.MESSAGE_CREATED,
  'user/message': GATEWAY_EVENT.MESSAGE_CREATED,
  'system/message': GATEWAY_EVENT.MESSAGE_CREATED,
  'tool/call': GATEWAY_EVENT.TOOL_STARTED,
  'tool/result': GATEWAY_EVENT.TOOL_COMPLETED,
  'step/start': GATEWAY_EVENT.TASK_PROGRESS,
  'step/end': GATEWAY_EVENT.TASK_PROGRESS,
  'turn/start': GATEWAY_EVENT.SESSION_STATUS,
  'turn/end': GATEWAY_EVENT.SESSION_STATUS,
});

/**
 * Assert a value is a legal Gateway event name.
 *
 * @param {unknown} value - candidate.
 * @returns {string} the event name.
 * @throws {TypeError} when unknown.
 */
export function assertGatewayEvent(value) {
  if (typeof value !== 'string' || !ALL_GATEWAY_EVENTS.includes(value)) {
    throw new TypeError(
      `unknown gateway event ${JSON.stringify(value)}; legal values are ${ALL_GATEWAY_EVENTS.join(', ')}`,
    );
  }
  return value;
}

/**
 * Map a DSH durable event type onto a Gateway event kind.
 *
 * An unmapped type yields `unknown` —it is never discarded (R2 §6.2).
 *
 * @param {unknown} dshEventType - a `SessionWireEvent.type`.
 * @returns {string} a `GATEWAY_EVENT` value.
 */
export function gatewayEventForDshEvent(dshEventType) {
  if (typeof dshEventType !== 'string') return GATEWAY_EVENT.UNKNOWN;
  return DSH_EVENT_TO_GATEWAY_EVENT[dshEventType] ?? GATEWAY_EVENT.UNKNOWN;
}

/**
 * Make a payload safe to carry on a Gateway event.
 *
 * A JSON-safe payload is passed through **by reference** so an opaque assistant
 * chunk is never copied or reinterpreted. A non-JSON payload is preserved as a
 * string so the fact of its existence still reaches the caller.
 *
 * @param {unknown} data - candidate payload.
 * @returns {unknown} a JSON-safe payload.
 */
export function safeEventData(data) {
  if (data === undefined || data === null) return null;
  return isJsonValue(data) ? data : safeStringify(data);
}

/**
 * Build a Gateway event.
 *
 * @param {object} input - event input.
 * @param {number} input.sequence - Gateway-owned sequence, from the allocator.
 * @param {string} input.event - a `GATEWAY_EVENT` value.
 * @param {string} input.sessionId - owning session.
 * @param {unknown} [input.data] - JSON-safe payload.
 * @param {number|string|null} [input.sourceTime] - DSH source time (epoch millis or ISO).
 * @param {string} [input.observedAt] - ISO time the Gateway observed this.
 * @param {number|null} [input.sourceSequence] - DSH durable seq, when one exists.
 * @returns {object} the Gateway event.
 * @throws {TypeError} on an illegal sequence, event name, or session id.
 */
export function makeGatewayEvent(input) {
  assertGatewayEvent(input?.event);
  if (typeof input.sequence !== 'number' || !Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    throw new TypeError(`sequence must be a non-negative safe integer, received ${JSON.stringify(input.sequence)}`);
  }
  if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) {
    throw new TypeError('Gateway event requires a sessionId');
  }

  const event = {
    sequence: input.sequence,
    event: input.event,
    session_id: input.sessionId,
    // Source time, or null. Never back-filled from the observation clock (§24).
    timestamp: toIso(input.sourceTime),
    observed_at: input.observedAt ?? null,
    data: safeEventData(input.data),
  };

  // Present only when the raw source actually had a durable DSH seq, so the two
  // sequence spaces stay visibly distinct rather than being defaulted together.
  if (typeof input.sourceSequence === 'number' && Number.isFinite(input.sourceSequence)) {
    event.source_sequence = input.sourceSequence;
  }

  return event;
}

/**
 * Validate a Gateway event.
 *
 * @param {unknown} value - candidate.
 * @returns {{ok: true, value: object}|{ok: false, reason: string}} validation result.
 */
export function validateGatewayEvent(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'event must be an object' };
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) {
    return { ok: false, reason: 'event.sequence must be a non-negative safe integer' };
  }
  if (typeof value.event !== 'string' || !ALL_GATEWAY_EVENTS.includes(value.event)) {
    return { ok: false, reason: `event.event is not a known gateway event: ${JSON.stringify(value.event)}` };
  }
  if (typeof value.session_id !== 'string' || value.session_id.length === 0) {
    return { ok: false, reason: 'event.session_id must be a non-empty string' };
  }
  if (value.timestamp !== null && value.timestamp !== undefined && typeof value.timestamp !== 'string') {
    return { ok: false, reason: 'event.timestamp must be an ISO string or null' };
  }
  if (value.source_sequence !== undefined
    && value.source_sequence !== null
    && !Number.isFinite(value.source_sequence)) {
    return { ok: false, reason: 'event.source_sequence must be a finite number or absent' };
  }
  const inspection = inspectForSecrets(value);
  if (!inspection.clean) {
    return { ok: false, reason: `event carries a secret-like field: ${inspection.reason}` };
  }
  return { ok: true, value };
}

/** Field names that must never appear on a domain object (R2 §29). */
export const FORBIDDEN_FIELD_NAMES = Object.freeze([
  'cookie',
  'set-cookie',
  'authorization',
  'token',
  'accesstoken',
  'access_token',
  'launchtoken',
  'launch_token',
  'apikey',
  'api_key',
  'secret',
  'password',
  'credentials',
]);

/**
 * Inspect an arbitrary domain value for secret-like keys.
 *
 * R2 §29 forbids model/event objects from carrying cookie, Authorization, launch
 * token, API key or credentials. This walks plain data only.
 *
 * @param {unknown} value - value to inspect.
 * @param {number} [depth] - recursion guard.
 * @returns {{clean: boolean, reason?: string}} inspection result.
 */
export function inspectForSecrets(value, depth = 0) {
  if (depth > 12) return { clean: true };
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && /dsh-auth-[A-Za-z0-9_-]{4,}/.test(value)) {
      return { clean: false, reason: 'a dsh-auth cookie name appears in a string value' };
    }
    return { clean: true };
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = inspectForSecrets(item, depth + 1);
      if (!nested.clean) return nested;
    }
    return { clean: true };
  }
  for (const [key, item] of Object.entries(value)) {
    const lowered = key.toLowerCase().replace(/[-_]/g, '');
    const forbidden = FORBIDDEN_FIELD_NAMES.some((name) => name.replace(/[-_]/g, '') === lowered);
    if (forbidden) return { clean: false, reason: `forbidden field name ${JSON.stringify(key)}` };
    const nested = inspectForSecrets(item, depth + 1);
    if (!nested.clean) return nested;
  }
  return { clean: true };
}
