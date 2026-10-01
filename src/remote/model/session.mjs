/**
 * Session domain model —Phase R2 §4.
 *
 * Schema (§4):
 *
 *   { id, title, status, created_at, updated_at, workspace_id?, workspace_key?, workspace_name?, cwd?,
 *     last_sequence, running, metadata? }
 *
 * Rules:
 *   - `id` is the **real DSH session id**. No second conversation id is minted.
 *   - `status` comes from the state machine, never from an ad-hoc guess.
 *   - `last_sequence` is the **Gateway** event sequence, NOT the DSH cursor (§8).
 *   - `title` / `created_at` are `null` unless a real source supplied them (§5).
 *   - Raw DSH fields, if retained, live under `metadata` —and the mobile REST
 *     layer must never need `metadata` to function (§4).
 */

import { isRecord } from './guards.mjs';
import { INITIAL_STATUS, assertStatus, isStatus } from './status.mjs';
import { sourceTimeToIso } from './time.mjs';

/** Keys the mobile-facing layer is allowed to depend on. */
export const REQUIRED_SESSION_FIELDS = Object.freeze([
  'id',
  'title',
  'status',
  'created_at',
  'updated_at',
  'last_sequence',
  'running',
]);

/** Optional keys that may be present but must never be required. */
export const OPTIONAL_SESSION_FIELDS = Object.freeze(['workspace_id', 'workspace_key', 'workspace_name', 'cwd', 'observed_at', 'metadata', 'agent_preset', 'model_selection']);

/**
 * Validate a session id.
 *
 * @param {unknown} value - candidate.
 * @returns {string} the id.
 * @throws {TypeError} when unusable.
 */
export function assertSessionId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('session id must be a non-empty string from DSH');
  }
  return value;
}

/**
 * Build a domain session.
 *
 * @param {object} input - session input.
 * @param {string} input.id - the real DSH session id.
 * @param {string|null} [input.title] - title, only from an audited source (§5).
 * @param {string} [input.status] - a legal status; defaults to `idle`.
 * @param {number|string|null} [input.createdAt] - source creation time, epoch millis or ISO.
 * @param {number|string|null} [input.updatedAt] - source update time.
 * @param {string} [input.observedAt] - ISO time the Gateway observed this.
 * @param {string|null} [input.workspaceId] - owning workspace id, when known.
 * @param {string|null} [input.workspaceName] - display name from DSH, never inferred from a prompt.
 * @param {string|null} [input.workspaceKey] - opaque grouping identity; never a filesystem path.
 * @param {string|null} [input.cwd] - session working directory, when known.
 * @param {number} [input.lastSequence] - Gateway event sequence high-water mark.
 * @param {boolean} [input.running] - DSH live-agent flag.
 * @param {object} [input.metadata] - retained raw DSH facts. Never required.
 * @returns {object} the domain session.
 * @throws {TypeError} on an illegal id, status or `lastSequence`.
 */
export function makeSession(input) {
  const id = assertSessionId(input?.id);
  const status = input.status === undefined ? INITIAL_STATUS : assertStatus(input.status);

  const lastSequence = input.lastSequence ?? 0;
  if (!Number.isSafeInteger(lastSequence) || lastSequence < 0) {
    throw new TypeError(`lastSequence must be a non-negative safe integer, received ${JSON.stringify(input.lastSequence)}`);
  }

  const running = input.running ?? status === 'running';

  return {
    id,
    // null unless an audited source supplied it. Never inferred from a prompt (§5).
    title: typeof input.title === 'string' && input.title.length > 0 ? input.title : null,
    status,
    // null unless DSH supplied it. Never the file mtime, never the receive clock (§5, §24).
    // Accepts either the DSH epoch-millis shape or the adapter's ISO shape.
    created_at: sourceTimeToIso(input.createdAt),
    updated_at: sourceTimeToIso(input.updatedAt),
    ...(input.workspaceId === undefined || input.workspaceId === null
      ? {}
      : { workspace_id: input.workspaceId }),
    ...(typeof input.workspaceKey === 'string' && input.workspaceKey.length > 0
      ? { workspace_key: input.workspaceKey }
      : {}),
    ...(typeof input.workspaceName === 'string' && input.workspaceName.length > 0
      ? { workspace_name: input.workspaceName }
      : {}),
    ...(typeof input.cwd === 'string' && input.cwd.length > 0 ? { cwd: input.cwd } : {}),
    // Gateway event sequence high-water mark, NOT a DSH cursor (§8).
    last_sequence: lastSequence,
    running: running === true,
    ...(typeof input.agentPreset === 'string' && input.agentPreset.length > 0
      ? { agent_preset: input.agentPreset }
      : {}),
    ...(input.modelSelection === undefined ? {} : { model_selection: input.modelSelection }),
    ...(typeof input.observedAt === 'string' ? { observed_at: input.observedAt } : {}),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  };
}

/**
 * Build a domain session from an R1 adapter summary.
 *
 * The adapter summary carries only audited fields, so `title` and `created_at`
 * arrive as `null` unless the caller supplies a real source. That is intentional:
 * §5 forbids inventing either.
 *
 * @param {object} summary - an R1 `listSessions()`/`getSession()` summary.
 * @param {object} [options] - enrichment options.
 * @param {string} [options.status] - status from the state machine.
 * @param {number} [options.lastSequence] - Gateway sequence high-water mark.
 * @param {string|null} [options.title] - title from an audited source.
 * @param {number|string|null} [options.createdAt] - `SessionWireHeader.createdAt`.
 * @param {string} [options.observedAt] - ISO observation time.
 * @param {string|null} [options.workspaceId] - owning workspace id.
 * @param {object} [options.metadata] - retained raw DSH facts.
 * @returns {object} the domain session.
 * @throws {TypeError} when the summary has no usable identity.
 */
export function sessionFromAdapterSummary(summary, options = {}) {
  if (!isRecord(summary)) throw new TypeError('sessionFromAdapterSummary requires an adapter summary object');
  const id = assertSessionId(summary.id);

  return makeSession({
    id,
    title: options.title ?? null,
    status: options.status,
    createdAt: options.createdAt ?? null,
    updatedAt: summary.updated_at ?? null,
    observedAt: options.observedAt,
    workspaceId: options.workspaceId ?? summary.workspace_id ?? null,
    workspaceKey: summary.workspace_key ?? null,
    workspaceName: summary.workspace_name ?? null,
    cwd: summary.cwd ?? null,
    agentPreset: summary.agent_preset ?? null,
    modelSelection: summary.model_selection,
    lastSequence: options.lastSequence ?? 0,
    running: summary.running === true || summary.status === 'running',
    metadata: options.metadata,
  });
}

/**
 * Validate a domain session.
 *
 * @param {unknown} value - candidate.
 * @returns {{ok: true, value: object}|{ok: false, reason: string}} validation result.
 */
export function validateSession(value) {
  if (!isRecord(value)) return { ok: false, reason: 'session must be an object' };
  for (const field of REQUIRED_SESSION_FIELDS) {
    if (!(field in value)) return { ok: false, reason: `session.${field} is required` };
  }
  if (typeof value.id !== 'string' || value.id.length === 0) {
    return { ok: false, reason: 'session.id must be a non-empty string' };
  }
  if (!isStatus(value.status)) {
    return { ok: false, reason: `session.status is not a legal status: ${JSON.stringify(value.status)}` };
  }
  if (value.title !== null && typeof value.title !== 'string') {
    return { ok: false, reason: 'session.title must be a string or null' };
  }
  for (const field of ['created_at', 'updated_at']) {
    if (value[field] !== null && typeof value[field] !== 'string') {
      return { ok: false, reason: `session.${field} must be an ISO string or null` };
    }
  }
  if (!Number.isSafeInteger(value.last_sequence) || value.last_sequence < 0) {
    return { ok: false, reason: 'session.last_sequence must be a non-negative safe integer' };
  }
  if (typeof value.running !== 'boolean') {
    return { ok: false, reason: 'session.running must be a boolean' };
  }
  if (value.agent_preset !== undefined && typeof value.agent_preset !== 'string') {
    return { ok: false, reason: 'session.agent_preset must be a string when present' };
  }
  if (value.model_selection !== undefined && (value.model_selection === null
    || typeof value.model_selection !== 'object'
    || typeof value.model_selection.provider !== 'string'
    || typeof value.model_selection.model !== 'string')) {
    return { ok: false, reason: 'session.model_selection must identify a provider and model when present' };
  }
  return { ok: true, value };
}

/**
 * Project a session to the fields the mobile layer may depend on.
 *
 * Deliberately drops `metadata` so a caller cannot accidentally build a
 * dependency on raw DSH facts (§4).
 *
 * @param {object} session - a domain session.
 * @returns {object} the mobile-safe projection.
 */
export function toMobileSession(session) {
  const check = validateSession(session);
  if (!check.ok) throw new TypeError(`cannot project an invalid session: ${check.reason}`);
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    created_at: session.created_at,
    updated_at: session.updated_at,
    ...(session.workspace_id === undefined ? {} : { workspace_id: session.workspace_id }),
    ...(session.workspace_key === undefined ? {} : { workspace_key: session.workspace_key }),
    ...(session.workspace_name === undefined ? {} : { workspace_name: session.workspace_name }),
    last_sequence: session.last_sequence,
    running: session.running,
    ...(session.agent_preset === undefined ? {} : { agent_preset: session.agent_preset }),
    ...(session.model_selection === undefined ? {} : { model_selection: session.model_selection }),
  };
}
