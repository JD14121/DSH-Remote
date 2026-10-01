import { extractActivities } from '../activity/run-activity.js';
/**
 * Wire → UI normalizers.
 *
 * The Gateway's REST shapes are the authority. The UI's fixtures use a slightly different
 * shape, so the conversion lives here and **only** here — R8C §15 forbids scattering field
 * adaptation across components.
 *
 * Two rules this module must never break:
 *
 *   1. **Server ordering and identity are preserved.** No sequence number, message id or
 *      timestamp is invented. If the server did not send it, the UI does not have it.
 *   2. **Nothing is fetched here.** Pure functions from wire data to UI data.
 */

/**
 * Read a value from an object without assuming its shape.
 *
 * @param {unknown} value - the container.
 * @param {string} key - the key.
 * @returns {unknown} the value, or undefined.
 */
function pick(value, key) {
  if (value === null || typeof value !== 'object') return undefined;
  return value[key];
}

/**
 * Coerce to a string when the value is a usable scalar.
 *
 * @param {unknown} value - the candidate.
 * @returns {string|null} the string, or null.
 */
function asString(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Normalize the health payload and decide whether it is the authenticated contract.
 *
 * The distinction matters: an anonymous health endpoint may also answer `200` with a minimal
 * body, so a status-only check would accept an invalid token. The authenticated contract is
 * recognised by the fields only it carries.
 *
 * The REST envelope is unwrapped first, exactly as `normalizeSession` does with
 * `raw = pick(raw, 'data') ?? raw`. Without that step this function inspected
 * `{ api_version, data }` rather than the payload, found none of the contract fields, and reported
 * `authenticated: false` for a perfectly valid token.
 *
 * The visible effect was severe and misleading: `health()` treats a minimal `200` as an
 * authentication failure, so the credential dialog stayed on `Connecting…`, the badge read
 * "Gateway Unavailable", and no request appeared to leave the browser at all — because the
 * rejection happens *after* a successful response, which is the opposite of what the symptom
 * suggested.
 *
 * @param {unknown} body - the parsed response body, enveloped or bare.
 * @returns {{authenticated: boolean, ready: boolean|null, fields: string[]}} the verdict.
 */
export function normalizeHealth(body) {
  const payload = (body !== null && typeof body === 'object' ? pick(body, 'data') : null) ?? body;
  const fields = payload !== null && typeof payload === 'object' ? Object.keys(payload).sort() : [];
  // Observed evidence: anonymous health returns { auth, gateway, request_id }; the
  // authenticated contract adds dsh, persistence, ready and status.
  const authenticated = fields.includes('auth')
    && fields.includes('dsh')
    && fields.includes('persistence')
    && fields.includes('ready');
  const ready = typeof pick(payload, 'ready') === 'boolean' ? pick(payload, 'ready') : null;
  return { authenticated, ready, fields };
}

/**
 * Normalize one session summary.
 *
 * @param {unknown} raw - the wire session.
 * @returns {object|null} the UI session, or null when it cannot be identified.
 */
export function normalizeSession(raw) {
  raw = pick(raw, 'data') ?? raw;
  const id = asString(pick(raw, 'id')) ?? asString(pick(raw, 'session_id')) ?? asString(pick(raw, 'sessionId'));
  if (id === null) return null;

  /*
   * R1.5.1 (T1): the fallback is a GENERIC LABEL, never the raw id.
   *
   * It previously fell back to `id`, so a session the server had not titled rendered an opaque
   * identifier as its visible title -- against session-item.js's own rule that no raw identifier,
   * path or sequence number is ever shown to the user. `id` remains on the object for keys, API
   * requests and aria/debug metadata; it is simply no longer the user-visible label.
   *
   * The title is never derived from message content, task state or a local timestamp.
   */
  const title = asString(pick(raw, 'title')) ?? asString(pick(raw, 'name')) ?? 'Untitled session';
  const status = asString(pick(raw, 'status')) ?? 'idle';
  const updatedAt = asString(pick(raw, 'updated_at')) ?? asString(pick(raw, 'updatedAt')) ?? null;
  const workspaceId = asString(pick(raw, 'workspace_id')) ?? asString(pick(raw, 'workspaceId'));
  const cwd = asString(pick(raw, 'cwd'));
  const pathParts = typeof cwd === 'string' ? cwd.split(/[\\/]+/).filter(Boolean) : [];
  const workspaceLabel = pathParts.at(-1)
    ?? asString(pick(raw, 'workspace_name'))
    ?? asString(pick(raw, 'workspaceName'))
    ?? null;
  const workspaceKey = asString(pick(raw, 'workspace_key'))
    ?? workspaceId
    ?? (typeof cwd === 'string' ? stableWorkspaceKey(cwd) : null)
    ?? (typeof workspaceLabel === 'string' ? stableWorkspaceKey(workspaceLabel) : null);

  return {
    id,
    title,
    status,
    updatedAt,
    updatedLabel: describeWhen(updatedAt),
    // Keep only a display label and an opaque grouping key in UI state. The
    // full workstation path remains server-side and is never shown in the list.
    workspaceKey,
    workspaceLabel,
    lastSequence: safeSequence(pick(raw, 'last_sequence')),
    queueDepth: safeSequence(pick(raw, 'queue_depth')),
    agentPreset: asString(pick(raw, 'agent_preset')),
    modelSelection: (() => {
      const value = pick(raw, 'model_selection');
      if (value === null || typeof value !== 'object'
        || typeof value.provider !== 'string' || typeof value.model !== 'string') return null;
      return {
        provider: value.provider,
        model: value.model,
        ...(typeof value.reasoning_effort === 'string' ? { reasoningEffort: value.reasoning_effort } : {}),
      };
    })(),
  };
}

function stableWorkspaceKey(value) {
  let hash = 2166136261;
  for (const character of value.toLocaleLowerCase()) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `cwd-${(hash >>> 0).toString(16)}`;
}

/**
 * A short, non-technical activity hint. No internal sequence numbers or paths.
 *
 * @param {string} status - the domain status.
 * @param {string|null} updatedAt - the timestamp, if any.
 * @returns {string} the label.
 */
function describeWhen(updatedAt) {
  if (updatedAt === null) return '-- ago';
  const when = new Date(updatedAt);
  if (Number.isNaN(when.getTime())) return '-- ago';
  const minutes = Math.max(0, Math.round((Date.now() - when.getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * Normalize a session list response.
 *
 * Accepts either a bare array or the Gateway's paged envelope, without reordering.
 *
 * @param {unknown} body - the parsed body.
 * @returns {{sessions: object[], nextCursor: string|null}} the list and cursor.
 */
export function normalizeSessionList(body) {
  const items = Array.isArray(body) ? body : (pick(body, 'data') ?? pick(body, 'items') ?? pick(body, 'sessions') ?? []);
  const nextCursor = asString(body?.page?.next_cursor) ?? asString(pick(body, 'next_cursor')) ?? asString(pick(body, 'nextCursor')) ?? null;
  const sessions = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const session = normalizeSession(raw);
    if (session !== null) sessions.push(session);
  }
  return { sessions, nextCursor };
}

/**
 * Normalize one message.
 *
 * `sequence` and `id` are passed through **only** when the server supplied them.
 *
 * @param {unknown} raw - the wire message.
 * @returns {object|null} the UI message, or null.
 */
function isSessionTitleEvent(raw) {
  return pick(raw, 'event_type') === 'session/title';
}

export function normalizeMessage(raw) {
  if (isSessionTitleEvent(raw)) return null;
  const id = asString(pick(raw, 'id')) ?? asString(pick(raw, 'message_id'));
  if (id === null) return null;

  const role = asString(pick(raw, 'role')) ?? 'assistant';
  const content = messageText(pick(raw, 'content') ?? pick(raw, 'text'));
  const sequence = pick(raw, 'sequence');

  return {
    id,
    role,
    requestId: asString(pick(raw, 'request_id')) ?? asString(raw?.content?.source?.rpcId),
    sourceKind: asString(pick(raw, 'source_kind')) ?? asString(raw?.content?.source?.kind),
    eventType: pick(raw, 'event_type') ?? null,
    turn: safeSequence(pick(raw, 'turn')),
    step: safeSequence(pick(raw, 'step')),
    turnStartedAt: asString(pick(raw, 'turn_started_at')),
    turnEndedAt: asString(pick(raw, 'turn_ended_at')),
    activities: role === 'assistant' || role === 'tool' ? extractActivities(raw) : [],
    kind: asString(pick(raw, 'kind')) ?? 'normal',
    content,
    // Preserved verbatim when present; never synthesised.
    sequence: typeof sequence === 'number' && Number.isFinite(sequence) ? sequence : null,
    createdAt: asString(pick(raw, 'created_at')) ?? asString(pick(raw, 'createdAt')) ?? null,
    code: null,
    sessionId: asString(pick(raw, 'session_id')),
    sourceSequence: safeSequence(pick(raw, 'source_sequence')),
    usage: pick(raw, 'usage') ?? null,
    durationMs: pick(raw, 'duration_ms') ?? pick(raw, 'durationMs') ?? null,
  };
}

/**
 * Normalize a message page, preserving server order exactly.
 *
 * @param {unknown} body - the parsed body.
 * @returns {{messages: object[], nextCursor: string|null}} the messages and cursor.
 */
export function normalizeMessageList(body) {
  const items = Array.isArray(body) ? body : (pick(body, 'data') ?? pick(body, 'items') ?? pick(body, 'messages'));
  const nextCursor = asString(pick(body, 'next_cursor')) ?? asString(pick(body, 'nextCursor')) ?? null;
  const messages = [];
  let valid = Array.isArray(items);
  for (const raw of Array.isArray(items) ? items : []) {
    const message = normalizeMessage(raw);
    if (message !== null) messages.push(message);
    else if (!isSessionTitleEvent(raw)) valid = false;
  }
  return { messages, nextCursor,
    valid,
    hasMore: body?.page?.has_more === true,
    nextBeforeSequence: safeSequence(body?.page?.next_before_seq),
    throughSequence: safeSequence(body?.page?.through_seq),
  };
}

function safeSequence(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Final prose accepts only DSH text blocks. Disclosed reasoning and tool blocks
// are extracted separately into the run activity surface, never appended here.
function messageText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(block =>
    block?.type === 'text' && typeof block.text === 'string' ? block.text : '').join('');
  // The DSH container shape. Guarded to an ARRAY so an unrelated object can never be stringified.
  if (value !== null && typeof value === 'object' && Array.isArray(value.content)) {
    return messageText(value.content);
  }
  return '';
}

/**
 * Normalize an upload response into an attachment chip record.
 *
 * @param {unknown} body - the parsed body.
 * @param {object} [fallback] - `name`, `kind`, used when the server omits them.
 * @returns {object} the attachment.
 */
export function normalizeUpload(body, fallback = {}) {
  const file = pick(body, 'file') ?? body;
  return {
    id: asString(pick(file, 'id')) ?? asString(pick(body, 'id')) ?? `upload-${Date.now()}`,
    name: asString(pick(file, 'name')) ?? asString(pick(file, 'filename')) ?? fallback.name ?? 'upload',
    kind: asString(pick(file, 'kind')) ?? fallback.kind ?? 'file',
    state: 'uploaded',
    bytes: typeof pick(file, 'bytes') === 'number' ? pick(file, 'bytes') : (fallback.bytes ?? null),
  };
}

/**
 * Normalize a send response.
 *
 * The important discipline: a `200` from send means the message was **accepted or queued**.
 * It does **not** mean an assistant reply exists. R8C has no socket, so the UI must not
 * invent one.
 *
 * @param {unknown} body - the parsed body.
 * @returns {{status: string, messageId: string|null, sequence: number|null}} the outcome.
 */
export function normalizeSendResult(body) {
  const status = asString(pick(body, 'status')) ?? 'accepted';
  const sequence = pick(body, 'sequence');
  return {
    status,
    messageId: asString(pick(body, 'id')) ?? asString(pick(body, 'message_id')) ?? null,
    sequence: typeof sequence === 'number' && Number.isFinite(sequence) ? sequence : null,
  };
}

/**
 * Normalize a cancel response.
 *
 * @param {unknown} body - the parsed body.
 * @returns {{status: string}} the outcome.
 */
export function normalizeCancelResult(body) {
  return { status: asString(pick(body, 'status')) ?? 'cancelled' };
}

// Known durable WebSocket wrappers project to the same identity as REST history.
export function normalizeDurableFrame(frame) {
  const type = frame.data?.dsh_event, data = frame.data?.payload;
  if (!data || !Number.isSafeInteger(frame.sourceSequence) || typeof frame.sessionId !== 'string') return null;
  const role = type === 'tool/call' || type === 'tool/result' ? 'tool'
    : type === 'assistant/message' || type === 'assistant/attempt' ? 'assistant'
    : type === 'user/message' ? 'user' : type === 'turn/start' || type === 'turn/end' ? 'system' : null;
  if (!role) return null;
  const messageType = type === 'tool/call' ? 'tool_call' : type === 'tool/result' ? 'tool_result'
    : type.startsWith('turn/') ? 'unknown' : 'message';
  const content = type === 'tool/call' ? {name:data.name,arguments:data.arguments}
    : type === 'tool/result' ? {ok:!data.error,message:data.message} : data.message ?? data.text ?? (type === 'user/message' && Array.isArray(data.content) ? data : null);
  return normalizeMessage({id:`${frame.sessionId}:${frame.sourceSequence}:${messageType}`,
    session_id:frame.sessionId,source_sequence:frame.sourceSequence,event_type:type,role,content,
    request_id:type === 'user/message' && data.source?.kind === 'user' ? data.source.rpcId : null,
    source_kind:type === 'user/message' ? data.source?.kind : null,
    turn:data.turn,step:data.step,call_id:data.callId,created_at:frame.sourceTime,usage:data.usage});
}
