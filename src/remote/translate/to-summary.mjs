/**
 * Session summary translation —Phase R1 §12.
 *
 * Target shape (R1 §12):
 *
 *   { id, title, status, created_at, updated_at }
 *
 * R1 explicitly does NOT implement the nine-state machine and must not add
 * persistence. It produces a conservative placeholder status and, more
 * importantly, exposes the seam R2 replaces:
 *
 *   derive(dshSummary, context) -> status
 *
 * The full vocabulary is declared here so R2 fills the same holes rather than
 * inventing a second enum:
 *
 *   idle | queued | running | waiting_input | completed | failed | cancelled | disconnected
 *
 * Which of those R1 can honestly report today, and from what:
 *
 *   running       <- SessionSummary.running === true
 *   idle          <- SessionSummary.running === false
 *   disconnected  <- the caller states the DSH transport is down (context flag)
 *
 * The remaining five need `session/control` baselines (queues/jobs) and
 * Gateway-owned history that R1 does not have. They are declared, not guessed.
 */

import { isRecord } from '../model/guards.mjs';

/** Session status vocabulary (R1 §12; implemented in R2). */
export const SESSION_STATUS = Object.freeze({
  IDLE: 'idle',
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING_INPUT: 'waiting_input',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  DISCONNECTED: 'disconnected',
});

/** Statuses R1 can derive from a `SessionSummary` alone. */
export const R1_DERIVABLE_STATUSES = Object.freeze([
  SESSION_STATUS.IDLE,
  SESSION_STATUS.RUNNING,
  SESSION_STATUS.DISCONNECTED,
]);

/** Statuses that remain R2 work. */
export const R2_STATUSES = Object.freeze([
  SESSION_STATUS.QUEUED,
  SESSION_STATUS.WAITING_INPUT,
  SESSION_STATUS.COMPLETED,
  SESSION_STATUS.FAILED,
  SESSION_STATUS.CANCELLED,
]);

/**
 * R1 default status derivation.
 *
 * Deliberately blunt: it reports only what `SessionSummary` actually carries.
 * It never reports `completed`, `failed` or `cancelled`, because a boolean
 * `running` flag cannot distinguish them —guessing would produce a status the
 * mobile client could act on wrongly.
 *
 * @param {object} summary - a DSH `SessionSummary`.
 * @param {object} [context] - derivation context.
 * @param {boolean} [context.transportDown] - true when the DSH transport is known to be down.
 * @returns {string} one of `SESSION_STATUS`.
 */
export function deriveR1Status(summary, context = {}) {
  if (context.transportDown === true) return SESSION_STATUS.DISCONNECTED;
  if (!isRecord(summary)) return SESSION_STATUS.IDLE;
  if (summary.running === true) return SESSION_STATUS.RUNNING;
  return SESSION_STATUS.IDLE;
}

/**
 * Convert one DSH `SessionSummary` into the mobile summary shape.
 *
 * @param {object} summary - a DSH `SessionSummary`.
 * @param {object} [options] - translation options.
 * @param {string} [options.sessionId] - overrides `summary.sessionId`.
 * @param {string|null} [options.title] - known title; `SessionSummary` carries none.
 * @param {(summary: object, context: object) => string} [options.deriveStatus] - R2 replacement seam.
 * @param {object} [options.context] - passed through to `deriveStatus`.
 * @returns {{id: string, title: string|null, status: string, created_at: string|null, updated_at: string|null}}
 *   the mobile summary.
 * @throws {TypeError} when the summary has no usable identity.
 */
export function toSummary(summary, options = {}) {
  const id = options.sessionId ?? summary?.sessionId;
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('SessionSummary requires a sessionId');
  }

  const derive = options.deriveStatus ?? deriveR1Status;
  const status = derive(summary, options.context ?? {});
  // DSH 0.1.5-rc.2 carries cold-safe projection hints on SessionSummary. The
  // `title` projection is client-visible and is the DSH title service's
  // authoritative folded value; `titleInput` remains host-only and is never
  // read or projected here.
  const projectedTitle = summary?.projections?.values?.title;
  const title = typeof options.title === 'string'
    ? options.title
    : typeof summary?.title === 'string'
      ? summary.title
      : typeof projectedTitle === 'string'
        ? projectedTitle
        : null;
  const agentPreset = summary?.projections?.values?.agentPreset;
  const modelProjection = summary?.projections?.values?.modelSelection;
  const modelSelection = [modelProjection?.next, modelProjection?.lastUsed].find((selection) =>
    selection !== null && typeof selection === 'object'
      && typeof selection.provider === 'string' && typeof selection.model === 'string');
  const cwdParts = typeof summary?.cwd === 'string' ? summary.cwd.split(/[\\/]+/).filter(Boolean) : [];
  const workspaceName = cwdParts.at(-1) ?? null;
  const workspaceId = typeof summary?.workspaceId === 'string' && summary.workspaceId.length > 0
    ? summary.workspaceId
    : typeof summary?.workspace_id === 'string' && summary.workspace_id.length > 0
      ? summary.workspace_id
      : null;

  return {
    id,
    // Empty/missing projection means DSH has not generated a title yet.
    title: title?.trim() ? title : null,
    status,
    // `SessionSummary` carries no createdAt either. Reported as null, not guessed.
    created_at: null,
    updated_at:
      typeof summary?.updatedAt === 'number' && Number.isFinite(summary.updatedAt)
        ? new Date(summary.updatedAt).toISOString()
        : null,
    // DSH may include these optional workspace facts on SessionSummary. Keep
    // them through the domain projection so clients can mirror its workspace
    // grouping without inventing a relationship from the session title.
    ...(workspaceId === null ? {} : { workspace_id: workspaceId }),
    ...(workspaceId !== null
      ? { workspace_key: `id-${workspaceId}` }
      : typeof summary?.cwd === 'string' && summary.cwd.length > 0
        ? { workspace_key: hashWorkspacePath(summary.cwd) }
        : {}),
    ...(workspaceName === null ? {} : { workspace_name: workspaceName }),
    // Internal only: the Gateway uses DSH's own summary to resolve an opaque
    // workspace key when creating a session. HTTP projections omit this path.
    ...(typeof summary?.cwd === 'string' && summary.cwd.length > 0 ? { cwd: summary.cwd } : {}),
    ...(typeof agentPreset === 'string' ? { agent_preset: agentPreset } : {}),
    ...(modelSelection === undefined ? {} : {
      model_selection: {
        provider: modelSelection.provider,
        model: modelSelection.model,
        ...(typeof modelSelection.reasoningEffort === 'string' ? { reasoning_effort: modelSelection.reasoningEffort } : {}),
      },
    }),
  };
}

function hashWorkspacePath(value) {
  let hash = 2166136261;
  for (const character of value.toLocaleLowerCase()) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `path-${(hash >>> 0).toString(16)}`;
}

/**
 * Convert a `SessionListValue` into mobile summaries.
 *
 * @param {object} listValue - a validated `SessionListValue`.
 * @param {object} [options] - translation options.
 * @param {(summary: object, context: object) => string} [options.deriveStatus] - R2 replacement seam.
 * @param {object} [options.context] - derivation context.
 * @returns {object[]} mobile summaries, in Host order.
 * @throws {TypeError} when the value is not a list.
 */
export function toSummaries(listValue, options = {}) {
  if (!isRecord(listValue) || !Array.isArray(listValue.items)) {
    throw new TypeError('toSummaries requires a SessionListValue with an items array');
  }
  return listValue.items.map((item) =>
    toSummary(item, {
      deriveStatus: options.deriveStatus,
      context: options.context,
      title: options.titles?.get?.(item.sessionId) ?? options.titles?.[item.sessionId],
    }),
  );
}
