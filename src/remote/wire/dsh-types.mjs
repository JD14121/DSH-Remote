/**
 * Runtime validators for DSH wire shapes — Phase R1 §8.
 *
 * Principles (R1 §8):
 *   - validate the fields the adapter actually depends on;
 *   - let genuinely opaque payloads stay opaque;
 *   - never guess the internal shape of an LLM chunk.
 *
 * In particular `assistant-stream.frame.chunk` is treated as an opaque
 * `JsonValue`: R1 asserts only that it is present and JSON-representable. It is
 * never parsed into a token/block schema, because that shape belongs to the LLM
 * adapter and is free to change independently of this boundary.
 *
 * Every validator returns a discriminated result instead of throwing, so the
 * caller decides which adapter error code to raise.
 */

/** @typedef {{ok: true, value: unknown} | {ok: false, reason: string}} Validation */

// Structural primitives now live in `model/guards.mjs` so the domain services can
// use them without importing this wire module (R2 §18, §21). They are imported
// for local use here AND re-exported so existing wire-layer callers keep working:
// a bare `export ... from` would not bring them into this module's own scope.
import { isJsonValue, isRecord } from '../model/guards.mjs';

export { isJsonValue, isRecord };

const ok = (value) => ({ ok: true, value });
const bad = (reason) => ({ ok: false, reason });

/** Require a string field. */
function requireString(object, key, label) {
  if (typeof object[key] !== 'string') return bad(`${label}.${key} must be a string`);
  return ok(object[key]);
}

/** Require a finite number field. */
function requireNumber(object, key, label) {
  if (typeof object[key] !== 'number' || !Number.isFinite(object[key])) {
    return bad(`${label}.${key} must be a finite number`);
  }
  return ok(object[key]);
}

/** Require a boolean field. */
function requireBoolean(object, key, label) {
  if (typeof object[key] !== 'boolean') return bad(`${label}.${key} must be a boolean`);
  return ok(object[key]);
}

/**
 * Validate `SessionWireHeader`.
 *
 * Required per the generated declaration: `version`, `id`, `createdAt`,
 * `isSeeded`, `delegationDepth`. Optional: `cwd`, `parentSession`, `origin`,
 * `agentPreset`. Extra fields are tolerated: DSH may add header facts.
 *
 * @param {unknown} value - candidate header.
 * @returns {Validation} result.
 */
export function validateSessionWireHeader(value) {
  if (!isRecord(value)) return bad('header must be an object');
  for (const key of ['version', 'id', 'createdAt', 'isSeeded']) {
    if (!(key in value)) return bad(`header.${key} is required`);
  }
  const version = requireNumber(value, 'version', 'header');
  if (!version.ok) return version;
  const id = requireString(value, 'id', 'header');
  if (!id.ok) return id;
  const createdAt = requireNumber(value, 'createdAt', 'header');
  if (!createdAt.ok) return createdAt;
  const isSeeded = requireBoolean(value, 'isSeeded', 'header');
  if (!isSeeded.ok) return isSeeded;
  return ok(value);
}

/**
 * Validate a `SessionHistoryRecord` wrapper: `{ type: 'event', event: {...} }`.
 *
 * @param {unknown} value - candidate record.
 * @returns {Validation} result.
 */
export function validateSessionEventEntry(value) {
  if (!isRecord(value)) return bad('record must be an object');
  const type = requireString(value, 'type', 'record');
  if (!type.ok) return type;
  if (value.type !== 'event') return bad(`record.type must be "event", got ${JSON.stringify(value.type)}`);
  if (!isRecord(value.event)) return bad('record.event must be an object');
  const seq = requireNumber(value.event, 'seq', 'record.event');
  if (!seq.ok) return seq;
  const eventType = requireString(value.event, 'type', 'record.event');
  if (!eventType.ok) return eventType;
  return ok(value);
}

/**
 * Validate `SessionListValue` = `{ items: SessionSummary[] }`.
 *
 * `SessionSummary` requires `sessionId`, `updatedAt`, `running`. Extra
 * projection fields stay untouched.
 *
 * @param {unknown} value - candidate value.
 * @returns {Validation} result.
 */
export function validateSessionListValue(value) {
  if (!isRecord(value)) return bad('SessionListValue must be an object');
  if (!Array.isArray(value.items)) return bad('SessionListValue.items must be an array');
  for (const [index, item] of value.items.entries()) {
    if (!isRecord(item)) return bad(`items[${index}] must be an object`);
    const sessionId = requireString(item, 'sessionId', `items[${index}]`);
    if (!sessionId.ok) return sessionId;
    const updatedAt = requireNumber(item, 'updatedAt', `items[${index}]`);
    if (!updatedAt.ok) return updatedAt;
    const running = requireBoolean(item, 'running', `items[${index}]`);
    if (!running.ok) return running;
  }
  return ok(value);
}

/**
 * Validate `SessionPromptValue` = `{ accepted: true }`.
 *
 * `accepted: false` is a protocol violation, not a rejection: DSH reports
 * rejection through the error branch of the envelope.
 *
 * @param {unknown} value - candidate value.
 * @returns {Validation} result.
 */
export function validateSessionPromptValue(value) {
  if (!isRecord(value)) return bad('SessionPromptValue must be an object');
  if (value.accepted !== true) {
    return bad(`SessionPromptValue.accepted must be true, got ${JSON.stringify(value.accepted)}`);
  }
  return ok(value);
}

/**
 * Validate `SessionCreateValue` = `{ sessionId, agentPreset? }`.
 *
 * DSH 0.1.5-rc.2 `session/create` accepts a request object with optional
 * `workspaceId`, `cwd`, `sessionId` and `agentPreset`, and answers with the
 * identity of the session it created. The Gateway may forward a server-resolved
 * DSH workspaceId or cwd, but never a phone-supplied path or id. Only the
 * returned `sessionId` is required here; `agentPreset` is optional and never
 * invented.
 *
 * @param {unknown} value - candidate value.
 * @returns {Validation} result.
 */
export function validateSessionCreateValue(value) {
  if (!isRecord(value)) return bad('SessionCreateValue must be an object');
  const sessionId = requireString(value, 'sessionId', 'SessionCreateValue');
  if (!sessionId.ok) return sessionId;
  if (sessionId.value.length === 0) return bad('SessionCreateValue.sessionId must be non-empty');
  // A created identity is opaque, but it must never be path-shaped: rejecting
  // separators and traversal keeps a hostile/misbehaving DSH from handing the
  // Gateway an id that could later be read as a filesystem or URL path.
  if (/[\u0000-\u001f\u007f/\\]/.test(sessionId.value) || sessionId.value.includes('..')) {
    return bad('SessionCreateValue.sessionId contains illegal characters');
  }
  if ('agentPreset' in value && value.agentPreset !== null && value.agentPreset !== undefined
    && typeof value.agentPreset !== 'string') {
    return bad('SessionCreateValue.agentPreset must be a string when present');
  }
  return ok(value);
}

/**
 * Validate `SessionCancelValue` = `{ accepted: true }`.
 *
 * @param {unknown} value - candidate value.
 * @returns {Validation} result.
 */
export function validateSessionCancelValue(value) {
  if (!isRecord(value)) return bad('SessionCancelValue must be an object');
  if (value.accepted !== true) {
    return bad(`SessionCancelValue.accepted must be true, got ${JSON.stringify(value.accepted)}`);
  }
  return ok(value);
}

/**
 * Validate `SessionPage` = `{ records: SessionHistoryRecord[], hasMore: boolean }`.
 *
 * @param {unknown} value - candidate value.
 * @returns {Validation} result.
 */
export function validateSessionPage(value) {
  if (!isRecord(value)) return bad('SessionPage must be an object');
  if (!Array.isArray(value.records)) return bad('SessionPage.records must be an array');
  const hasMore = requireBoolean(value, 'hasMore', 'SessionPage');
  if (!hasMore.ok) return hasMore;
  for (const [index, record] of value.records.entries()) {
    const entry = validateSessionEventEntry(record);
    if (!entry.ok) return bad(`SessionPage.records[${index}]: ${entry.reason}`);
  }
  return ok(value);
}

/**
 * Validate `SessionAssistantStreamFrame`.
 *
 * `start` and `end` carry structural fields R1 depends on; `chunk.chunk` is
 * deliberately left opaque and only checked for JSON-representability.
 *
 * @param {unknown} value - candidate frame.
 * @returns {Validation} result.
 */
export function validateSessionAssistantStreamFrame(value) {
  if (!isRecord(value)) return bad('assistant-stream frame must be an object');
  const type = requireString(value, 'type', 'frame');
  if (!type.ok) return type;

  switch (value.type) {
    case 'start': {
      for (const key of ['attemptId', 'revision', 'startedAfterSeq', 'turn', 'step']) {
        if (!(key in value)) return bad(`frame.start.${key} is required`);
      }
      return ok(value);
    }
    case 'chunk': {
      for (const key of ['attemptId', 'revision', 'index', 'chunk']) {
        if (!(key in value)) return bad(`frame.chunk.${key} is required`);
      }
      if (!isJsonValue(value.chunk)) {
        return bad('frame.chunk must be an opaque JSON value');
      }
      return ok(value);
    }
    case 'end': {
      for (const key of ['attemptId', 'revision', 'index', 'outcome']) {
        if (!(key in value)) return bad(`frame.end.${key} is required`);
      }
      if (!isRecord(value.outcome)) return bad('frame.end.outcome must be an object');
      const kind = requireString(value.outcome, 'kind', 'frame.end.outcome');
      if (!kind.ok) return kind;
      if (value.outcome.kind !== 'committed' && value.outcome.kind !== 'abandoned') {
        return bad(`frame.end.outcome.kind must be "committed" or "abandoned"`);
      }
      return ok(value);
    }
    default:
      return bad(`unknown assistant-stream frame type ${JSON.stringify(value.type)}`);
  }
}

/**
 * Validate `SessionFollowFrame`, the union yielded by `session/follow`.
 *
 * Variants: opening `snapshot`; `SessionEventEntry`; `assistant-stream`.
 *
 * @param {unknown} value - candidate frame.
 * @returns {Validation} result.
 */
export function validateSessionFollowFrame(value) {
  if (!isRecord(value)) return bad('follow frame must be an object');
  const type = requireString(value, 'type', 'follow frame');
  if (!type.ok) return type;

  switch (value.type) {
    case 'snapshot': {
      const header = validateSessionWireHeader(value.header);
      if (!header.ok) return bad(`snapshot.header: ${header.reason}`);
      const cursor = requireNumber(value, 'cursor', 'snapshot');
      if (!cursor.ok) return cursor;
      if (!Array.isArray(value.records)) return bad('snapshot.records must be an array');
      for (const [index, record] of value.records.entries()) {
        const entry = validateSessionEventEntry(record);
        if (!entry.ok) return bad(`snapshot.records[${index}]: ${entry.reason}`);
      }
      const hasMore = requireBoolean(value, 'hasMore', 'snapshot');
      if (!hasMore.ok) return hasMore;
      return ok(value);
    }
    case 'event':
      return validateSessionEventEntry(value);
    case 'assistant-stream': {
      const frame = validateSessionAssistantStreamFrame(value.frame);
      if (!frame.ok) return bad(`assistant-stream: ${frame.reason}`);
      return ok(value);
    }
    default:
      return bad(`unknown follow frame type ${JSON.stringify(value.type)}`);
  }
}

/**
 * Validate a DSH `client-request` envelope before sending it.
 *
 * @param {unknown} value - candidate envelope.
 * @returns {Validation} result.
 */
export function validateClientRequestEnvelope(value) {
  if (!isRecord(value)) return bad('client-request must be an object');
  if (value.type !== 'client-request') return bad('client-request.type must be "client-request"');
  const rpcId = requireString(value, 'rpcId', 'client-request');
  if (!rpcId.ok) return rpcId;
  if (value.rpcId.length === 0) return bad('client-request.rpcId must be non-empty');
  const method = requireString(value, 'method', 'client-request');
  if (!method.ok) return method;
  if (!isRecord(value.payload)) return bad('client-request.payload must be an object');
  return ok(value);
}

/**
 * Validate a DSH `server-response` envelope, including rpcId correlation.
 *
 * R1 §6.1 forbids treating "any JSON" as success: `type`, `rpcId`, `result.ok`
 * and `result.error` are all checked.
 *
 * @param {unknown} value - candidate envelope.
 * @param {string} expectedRpcId - the rpcId this call is awaiting.
 * @returns {Validation} result.
 */
export function validateServerResponseEnvelope(value, expectedRpcId) {
  if (!isRecord(value)) return bad('server-response must be an object');
  if (value.type !== 'server-response') {
    return bad(`server-response.type must be "server-response", got ${JSON.stringify(value.type)}`);
  }
  const rpcId = requireString(value, 'rpcId', 'server-response');
  if (!rpcId.ok) return rpcId;
  if (value.rpcId !== expectedRpcId) {
    return bad('server-response.rpcId does not match the request rpcId');
  }
  if (!isRecord(value.result)) return bad('server-response.result must be an object');
  const { result } = value;
  if (result.ok === true) {
    if (!('value' in result)) return bad('server-response.result.value is required when ok is true');
    return ok(value);
  }
  if (result.ok === false) {
    const error = validateRpcError(result.error);
    if (!error.ok) return bad(`server-response.result.error: ${error.reason}`);
    return ok(value);
  }
  return bad('server-response.result.ok must be a boolean');
}

/**
 * Validate an `rpcError` = `{ code, message, details }`.
 *
 * @param {unknown} value - candidate error.
 * @returns {Validation} result.
 */
export function validateRpcError(value) {
  if (!isRecord(value)) return bad('rpc error must be an object');
  const code = requireString(value, 'code', 'rpc error');
  if (!code.ok) return code;
  const message = requireString(value, 'message', 'rpc error');
  if (!message.ok) return message;
  return ok(value);
}

/**
 * Validate a `RemoteError`-shaped failure emitted on a mux stream.
 *
 * @param {unknown} value - candidate error.
 * @returns {Validation} result.
 */
export function validateStreamError(value) {
  const base = validateRpcError(value);
  if (!base.ok) return base;
  if ('details' in value && !isRecord(value.details)) {
    return bad('stream error.details must be an object when present');
  }
  return ok(value);
}

/**
 * Validate one `SessionControlFrame` (R2 §21).
 *
 * The union is: opening `baseline` (Host-wide queues/jobs/projections), then
 * per-session replacement frames `queue`, `jobs` and `projection`.
 *
 * @param {unknown} value - candidate frame.
 * @returns {Validation} result.
 */
export function validateSessionControlFrame(value) {
  if (!isRecord(value)) return bad('control frame must be an object');
  const type = requireString(value, 'type', 'control frame');
  if (!type.ok) return type;

  switch (value.type) {
    case 'baseline': {
      if (!isRecord(value.value)) return bad('control baseline requires a value object');
      const { queues, jobs } = value.value;
      if (!isRecord(queues)) return bad('control baseline.value.queues must be an object');
      if (!isRecord(jobs)) return bad('control baseline.value.jobs must be an object');
      for (const [sessionId, items] of Object.entries(queues)) {
        if (!Array.isArray(items)) return bad(`control baseline queues[${sessionId}] must be an array`);
      }
      for (const [sessionId, rows] of Object.entries(jobs)) {
        if (!Array.isArray(rows)) return bad(`control baseline jobs[${sessionId}] must be an array`);
        for (const [index, job] of rows.entries()) {
          if (!isRecord(job)) return bad(`control baseline jobs[${sessionId}][${index}] must be an object`);
          if (typeof job.status !== 'string') {
            return bad(`control baseline jobs[${sessionId}][${index}].status must be a string`);
          }
        }
      }
      return ok(value);
    }
    case 'queue': {
      const sessionId = requireString(value, 'sessionId', 'control queue frame');
      if (!sessionId.ok) return sessionId;
      if (!Array.isArray(value.items)) return bad('control queue frame requires an items array');
      return ok(value);
    }
    case 'jobs': {
      const sessionId = requireString(value, 'sessionId', 'control jobs frame');
      if (!sessionId.ok) return sessionId;
      if (!Array.isArray(value.jobs)) return bad('control jobs frame requires a jobs array');
      return ok(value);
    }
    case 'projection': {
      const sessionId = requireString(value, 'sessionId', 'control projection frame');
      if (!sessionId.ok) return sessionId;
      const key = requireString(value, 'key', 'control projection frame');
      if (!key.ok) return key;
      return ok(value);
    }
    default:
      return bad(`unknown control frame type ${JSON.stringify(value.type)}`);
  }
}

/**
 * Validate a mux frame received from the Host.
 *
 * @param {unknown} value - candidate frame.
 * @returns {Validation} result.
 */
export function validateHostMuxFrame(value) {
  if (!isRecord(value)) return bad('mux frame must be an object');
  const type = requireString(value, 'type', 'mux frame');
  if (!type.ok) return type;

  switch (value.type) {
    case 'item': {
      const streamId = requireString(value, 'streamId', 'mux frame');
      if (!streamId.ok) return streamId;
      if (!('value' in value)) return bad('mux item frame requires value');
      return ok(value);
    }
    case 'end': {
      const streamId = requireString(value, 'streamId', 'mux frame');
      if (!streamId.ok) return streamId;
      return ok(value);
    }
    case 'error': {
      const streamId = requireString(value, 'streamId', 'mux frame');
      if (!streamId.ok) return streamId;
      const error = validateStreamError(value.error);
      if (!error.ok) return bad(`mux error frame: ${error.reason}`);
      return ok(value);
    }
    default:
      return bad(`unknown host mux frame type ${JSON.stringify(value.type)}`);
  }
}
