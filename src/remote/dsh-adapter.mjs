/**
 * DSH Adapter — the single, stable, testable boundary — Phase R1 §5.1.
 *
 * Everything above this file speaks the mobile domain. Everything below it
 * speaks DSH's private wire. R1 §0.2 confines all DSH wire knowledge to
 * `src/remote/dsh-adapter.mjs` and `src/remote/wire/*`; this module is the only
 * place where the two vocabularies meet.
 *
 * Public contract (R1 §5.1):
 *
 *   listSessions()
 *   getSession(id)
 *   createSession()
 *   getMessages(id, options)
 *   sendMessage(sessionId, message)
 *   subscribe(sessionId, listener)
 *   cancel(sessionId)
 *
 * Construction performs no I/O and opens no connection (R1 §5.1). The version
 * guard is consulted lazily on the first real operation, so a misconfigured
 * adapter fails on use with a precise code rather than at import time.
 *
 * Deliberately absent from R1 (R1 §27 Stop Gate): any HTTP listener, any
 * outbound WebSocket *server*, any phone-facing auth, any persistence, any
 * supervisor, any UI.
 */

import { AdapterError, ADAPTER_ERROR, mapRemoteCode } from './adapter-errors.mjs';
import { DSH_ENDPOINT } from './wire/dsh-routes.mjs';
import { DshRpcClient } from './wire/dsh-rpc-client.mjs';
import { DshVersionGuard } from './version-guard.mjs';
import {
  validateSessionCancelValue,
  validateSessionControlFrame,
  validateSessionCreateValue,
  validateSessionFollowFrame,
  validateSessionListValue,
  validateSessionPage,
  validateSessionPromptValue,
} from './wire/dsh-types.mjs';
import { buildPromptRequest } from './translate/from-prompt.mjs';
import { toMessages } from './translate/to-messages.mjs';
import { toSummary, toSummaries } from './translate/to-summary.mjs';
import { isRecord } from './model/guards.mjs';

/** Default page size for `getMessages`, matching the DSH default. */
export const DEFAULT_MAX_MESSAGES = 50;

/** Listener frame kinds delivered by `subscribe` (R1 §14.1). */
export const SUBSCRIPTION_FRAME = Object.freeze({
  SNAPSHOT: 'snapshot',
  EVENT: 'event',
  ASSISTANT_START: 'assistant-stream:start',
  ASSISTANT_CHUNK: 'assistant-stream:chunk',
  ASSISTANT_END: 'assistant-stream:end',
  ERROR: 'error',
});

/** Listener frame kinds delivered by `subscribeControl` (R2 §21). */
export const CONTROL_FRAME = Object.freeze({
  BASELINE: 'control:baseline',
  QUEUE: 'control:queue',
  JOBS: 'control:jobs',
  PROJECTION: 'control:projection',
  ERROR: 'error',
});

/**
 * Translate one `SessionControlFrame` into a control subscription frame.
 *
 * @param {object} frame - a validated control frame.
 * @returns {{kind: string, frame: object}} subscription frame.
 * @throws {AdapterError} when the frame type is not handled.
 */
export function toControlFrame(frame) {
  switch (frame.type) {
    case 'baseline':
      return { kind: CONTROL_FRAME.BASELINE, frame };
    case 'queue':
      return { kind: CONTROL_FRAME.QUEUE, frame };
    case 'jobs':
      return { kind: CONTROL_FRAME.JOBS, frame };
    case 'projection':
      return { kind: CONTROL_FRAME.PROJECTION, frame };
    default:
      throw new AdapterError(
        ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
        `unhandled control frame type ${JSON.stringify(frame.type)}`,
      );
  }
}

/**
 * Translate one `SessionFollowFrame` into the subscription frame the listener
 * receives.
 *
 * Order is preserved exactly. Chunks are never reordered, merged or coerced to a
 * string (R1 §14.1); the frame's `chunk` value is handed over untouched.
 *
 * @param {object} frame - a validated follow frame.
 * @returns {{kind: string, frame: object, assistantFrame?: object}} subscription frame.
 */
export function toSubscriptionFrame(frame) {
  switch (frame.type) {
    case 'snapshot':
      return { kind: SUBSCRIPTION_FRAME.SNAPSHOT, frame };
    case 'event':
      return { kind: SUBSCRIPTION_FRAME.EVENT, frame };
    case 'assistant-stream': {
      const assistantFrame = frame.frame;
      const kind =
        assistantFrame.type === 'start'
          ? SUBSCRIPTION_FRAME.ASSISTANT_START
          : assistantFrame.type === 'chunk'
            ? SUBSCRIPTION_FRAME.ASSISTANT_CHUNK
            : SUBSCRIPTION_FRAME.ASSISTANT_END;
      return { kind, frame, assistantFrame };
    }
    default:
      // validateSessionFollowFrame rejects unknown types before this point, so
      // reaching here means the validator and this switch disagree.
      throw new AdapterError(
        ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
        `unhandled follow frame type ${JSON.stringify(frame.type)}`,
      );
  }
}

/**
 * The one boundary between the mobile gateway and DSH.
 */
export class DshAdapter {
  /**
   * @param {object} options - adapter dependencies.
   * @param {import('./wire/dsh-rpc-client.mjs').DshRpcClient} options.rpcClient - wire client.
   * @param {import('./version-guard.mjs').DshVersionGuard} options.versionGuard - fail-closed version check.
   * @param {import('./wire/dsh-auth.mjs').DshAuthProvider} options.authProvider - internal credential source.
   * @param {(summary: object, context: object) => string} [options.deriveStatus] - R2 status seam.
   */
  constructor(options) {
    if (options?.rpcClient === undefined) throw new TypeError('DshAdapter requires an rpcClient');
    if (options?.versionGuard === undefined) throw new TypeError('DshAdapter requires a versionGuard');
    if (options?.authProvider === undefined) throw new TypeError('DshAdapter requires an authProvider');

    this.rpc = options.rpcClient;
    this.versionGuard = options.versionGuard;
    this.authProvider = options.authProvider;
    this.deriveStatus = options.deriveStatus;

    /** Session ids that have been seen, used to distinguish cold from unknown. */
    this.knownSessions = new Set();
  }

  /**
   * Ensure the wire version is acceptable before any real work.
   *
   * @returns {Promise<string>} the accepted DSH version.
   */
  async #ensureVerified() {
    return this.versionGuard.verify();
  }

  /**
   * List the sessions DSH knows about.
   *
   * Note: DSH declares a `cursor` field on the list request but ignores it — it
   * returns every visible session on one call. R1 reports that honestly rather
   * than implementing a paging loop that would never advance.
   *
   * @param {object} [options] - list options.
   * @param {object} [options.context] - status-derivation context passed to the R2 seam.
   * @returns {Promise<object[]>} mobile summaries.
   */
  async listSessions(options = {}) {
    await this.#ensureVerified();
    const value = await this.rpc.call({
      endpoint: DSH_ENDPOINT.SESSION_LIST.endpoint,
      args: { [DSH_ENDPOINT.SESSION_LIST.argKey]: {} },
    });

    const check = validateSessionListValue(value);
    if (!check.ok) {
      throw new AdapterError(
        ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
        `DSH returned an invalid SessionListValue: ${check.reason}`,
        { details: { endpoint: DSH_ENDPOINT.SESSION_LIST.endpoint } },
      );
    }

    for (const item of value.items) this.knownSessions.add(item.sessionId);

    return toSummaries(value, {
      deriveStatus: this.deriveStatus,
      context: options.context,
    });
  }

  /** Read DSH's authoritative archived-session set from the workspace baseline. */
  async listArchivedSessionIds() {
    await this.#ensureVerified();
    const controller = new AbortController();
    const stream = this.rpc.openStream({
      endpoint: DSH_ENDPOINT.WORKSPACE_FOLLOW.endpoint,
      args: {},
      signal: controller.signal,
    });
    const iterator = stream[Symbol.asyncIterator]();
    try {
      const first = await iterator.next();
      const ids = first.value?.type === 'baseline' ? first.value.value?.archivedSessionIds : null;
      if (first.done || !Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
        throw new AdapterError(
          ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
          'DSH returned an invalid workspace archive baseline',
          { details: { endpoint: DSH_ENDPOINT.WORKSPACE_FOLLOW.endpoint } },
        );
      }
      return [...ids];
    } finally {
      try { await iterator.return?.(); } finally { controller.abort(); }
    }
  }

  /**
   * Create a new session through DSH `session/create`.
   *
   * ## The phone may select only a DSH-rostered Agent preset
   *
   * DSH 0.1.5-rc.2 accepts `{ workspaceId?, cwd?, sessionId?, agentPreset? }` on
   * `session/create`. The phone supplies only an opaque workspace key. This
   * adapter resolves it against DSH's current session inventory and forwards
   * only the DSH-reported cwd/workspaceId; it never forwards a phone path.
   * Client-chosen session ids remain forbidden.
   *
   * @param {object} [options] - optional validated `agentPreset`, server-resolved `workspaceKey`, and cancellation signal.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @returns {Promise<{sessionId: string, agentPreset: string|null}>} the new identity.
   * @throws {AdapterError} `WIRE_PROTOCOL_ERROR` when DSH answers with an unusable value.
   */
  async createSession(options = {}) {
    await this.#ensureVerified();

    let agentPreset;
    if (typeof options.agentPreset === 'string' && options.agentPreset.length > 0) {
      const roster = await this.listAgentPresets();
      const preset = roster.presets.find((entry) => entry.id === options.agentPreset);
      if (preset === undefined || preset.broken) {
        throw new AdapterError(ADAPTER_ERROR.WIRE_PROTOCOL_ERROR, 'requested Agent preset is unavailable');
      }
      agentPreset = preset.id;
    }

    let selectedWorkspace = null;
    if (typeof options.workspaceKey === 'string' && options.workspaceKey.length > 0) {
      const summaries = await this.listSessions();
      const matches = summaries.filter((summary) => summary.workspace_key === options.workspaceKey);
      const directories = [...new Set(matches.map((summary) => summary.cwd).filter((cwd) => typeof cwd === 'string' && cwd.length > 0))];
      const workspaceIds = [...new Set(matches.map((summary) => summary.workspace_id).filter((id) => typeof id === 'string' && id.length > 0))];
      if (matches.length === 0 || directories.length > 1 || (directories.length === 0 && workspaceIds.length !== 1)) {
        throw new AdapterError(ADAPTER_ERROR.SESSION_NOT_FOUND, 'the selected DSH workspace is no longer available');
      }
      const request = directories.length === 1
        ? { cwd: directories[0] }
        : { workspaceId: workspaceIds[0] };
      selectedWorkspace = {
        request,
        workspaceId: workspaceIds.length === 1 ? workspaceIds[0] : null,
        workspaceKey: options.workspaceKey,
        workspaceName: matches.find((summary) => typeof summary.workspace_name === 'string')?.workspace_name ?? null,
      };
    }

    let value;
    try {
      const request = {
        ...(agentPreset === undefined ? {} : { agentPreset }),
        ...(selectedWorkspace?.request ?? {}),
      };
      value = await this.rpc.call({
        endpoint: DSH_ENDPOINT.SESSION_CREATE.endpoint,
        // Workspace paths originate from DSH's own current inventory, never the phone.
        args: { [DSH_ENDPOINT.SESSION_CREATE.argKey]: request },
        signal: options.signal,
      });
    } catch (error) {
      throw error instanceof AdapterError
        ? error
        : new AdapterError(ADAPTER_ERROR.WIRE_PROTOCOL_ERROR, 'unexpected failure while creating a session', {
          cause: error,
        });
    }

    const check = validateSessionCreateValue(value);
    if (!check.ok) {
      throw new AdapterError(
        ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
        `DSH returned an invalid SessionCreateValue: ${check.reason}`,
        { details: { endpoint: DSH_ENDPOINT.SESSION_CREATE.endpoint } },
      );
    }

    // Remember the identity so a later cold/unknown distinction is accurate.
    this.knownSessions.add(value.sessionId);

    return {
      sessionId: value.sessionId,
      agentPreset: typeof value.agentPreset === 'string' ? value.agentPreset : null,
      ...(selectedWorkspace === null ? {} : selectedWorkspace.request),
      ...(selectedWorkspace === null ? {} : {
        workspaceId: selectedWorkspace.workspaceId,
        workspaceKey: selectedWorkspace.workspaceKey,
        workspaceName: selectedWorkspace.workspaceName,
      }),
    };
  }

  /** Read DSH's path-free Agent preset roster. */
  async listAgentPresets() {
    await this.#ensureVerified();
    const value = await this.rpc.call({ endpoint: DSH_ENDPOINT.AGENT_PRESET_LIST.endpoint, args: {} });
    if (!isRecord(value) || !Array.isArray(value.presets)) {
      throw new AdapterError(ADAPTER_ERROR.WIRE_PROTOCOL_ERROR, 'DSH returned an invalid Agent preset roster');
    }
    return {
      presets: value.presets.flatMap((row) => {
        if (!isRecord(row) || typeof row.id !== 'string' || row.id.length === 0) return [];
        if (row.trust !== 'system' && row.trust !== 'user') return [];
        return [{
          id: row.id,
          name: typeof row.name === 'string' ? row.name : row.id,
          description: typeof row.description === 'string' ? row.description : null,
          trust: row.trust,
          isDefault: row.isDefault === true,
          ...(typeof row.broken === 'string' ? { broken: true } : {}),
        }];
      }),
    };
  }

  /** Read DSH's live provider/model/reasoning catalog. */
  async getModelCatalog() {
    await this.#ensureVerified();
    const value = await this.rpc.call({ endpoint: DSH_ENDPOINT.SESSION_MODEL_CATALOG.endpoint, args: {} });
    if (!isRecord(value) || !isRecord(value.default) || !Array.isArray(value.groups)) {
      throw new AdapterError(ADAPTER_ERROR.WIRE_PROTOCOL_ERROR, 'DSH returned an invalid model catalog');
    }
    const selection = (candidate) => isRecord(candidate)
      && typeof candidate.provider === 'string'
      && typeof candidate.model === 'string'
      ? {
        provider: candidate.provider,
        model: candidate.model,
        ...(typeof candidate.reasoningEffort === 'string' ? { reasoningEffort: candidate.reasoningEffort } : {}),
      }
      : null;
    const defaultSelection = selection(value.default);
    if (defaultSelection === null) {
      throw new AdapterError(ADAPTER_ERROR.WIRE_PROTOCOL_ERROR, 'DSH returned an invalid default model selection');
    }
    return {
      default: defaultSelection,
      routableProviders: Array.isArray(value.routableProviders)
        ? value.routableProviders.filter((id) => typeof id === 'string')
        : [],
      groups: value.groups.flatMap((group) => {
        if (!isRecord(group) || typeof group.id !== 'string' || !Array.isArray(group.models)) return [];
        return [{
          id: group.id,
          name: typeof group.name === 'string' ? group.name : group.id,
          models: group.models.flatMap((model) => {
            if (!isRecord(model) || typeof model.id !== 'string') return [];
            const reasoning = isRecord(model.reasoning) && Array.isArray(model.reasoning.efforts)
              ? {
                efforts: model.reasoning.efforts.flatMap((effort) => isRecord(effort) && typeof effort.id === 'string'
                  ? [{ id: effort.id, name: typeof effort.name === 'string' ? effort.name : effort.id,
                    ...(typeof effort.description === 'string' ? { description: effort.description } : {}) }]
                  : []),
                ...(typeof model.reasoning.defaultEffort === 'string' ? { defaultEffort: model.reasoning.defaultEffort } : {}),
              }
              : null;
            return [{
              id: model.id,
              name: typeof model.name === 'string' ? model.name : model.id,
              ...(typeof model.description === 'string' ? { description: model.description } : {}),
              ...(reasoning === null ? {} : { reasoning }),
            }];
          }),
        }];
      }),
      failures: Array.isArray(value.failures)
        ? value.failures.flatMap((failure) => isRecord(failure) && typeof failure.id === 'string'
          ? [{ id: failure.id, name: typeof failure.name === 'string' ? failure.name : failure.id }]
          : [])
        : [],
    };
  }

  /** Change the DSH Agent preset for a still-blank session. */
  async selectAgentPreset(sessionId, agentPreset) {
    await this.#ensureVerified();
    const roster = await this.listAgentPresets();
    const preset = roster.presets.find((entry) => entry.id === agentPreset);
    if (preset === undefined || preset.broken) {
      throw new AdapterError(ADAPTER_ERROR.WIRE_PROTOCOL_ERROR, 'requested Agent preset is unavailable');
    }
    try {
      const selected = await this.rpc.call({
        endpoint: DSH_ENDPOINT.AGENT_PRESET_SELECT.endpoint,
        args: { agentId: sessionId, agentPreset: preset.id },
      });
      if (selected !== undefined && selected !== null && selected !== preset.id) {
        throw new AdapterError(ADAPTER_ERROR.WIRE_PROTOCOL_ERROR, 'DSH returned an unexpected selected Agent preset');
      }
      return { agentPreset: preset.id };
    } catch (error) {
      throw this.#mapSessionError(error, sessionId);
    }
  }

  /** Set the DSH model and optional reasoning strength for one session. */
  async selectModel(sessionId, selection) {
    await this.#ensureVerified();
    const request = {
      sessionId,
      provider: selection.provider,
      model: selection.model,
      ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
    };
    try {
      const value = await this.rpc.call({
        endpoint: DSH_ENDPOINT.SESSION_SELECT_MODEL.endpoint,
        args: { [DSH_ENDPOINT.SESSION_SELECT_MODEL.argKey]: request },
      });
      if (!isRecord(value) || !isRecord(value.selected)
        || value.selected.provider !== request.provider || value.selected.model !== request.model) {
        throw new AdapterError(ADAPTER_ERROR.WIRE_PROTOCOL_ERROR, 'DSH returned an invalid selected model');
      }
      return value.selected;
    } catch (error) {
      throw this.#mapSessionError(error, sessionId);
    }
  }

  /**
   * Rename a DSH session through its mounted session-title service.
   *
   * DSH owns normalization, byte limits, persistence, and the durable
   * `session/title` event. The Gateway forwards only the validated identity
   * and title; it never edits DSH storage directly.
   *
   * @param {string} sessionId - DSH session identity.
   * @param {string} title - requested user-visible title.
   * @returns {Promise<{title: string, seq: number}>} accepted title and DSH sequence.
   */
  async renameSession(sessionId, title) {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof title !== 'string') {
      throw new TypeError('renameSession requires a session id and title');
    }
    await this.#ensureVerified();
    const value = await this.rpc.call({
      endpoint: DSH_ENDPOINT.SESSION_RENAME.endpoint,
      args: { [DSH_ENDPOINT.SESSION_RENAME.argKey]: { sessionId, title } },
    });
    if (!isRecord(value) || typeof value.title !== 'string' || !Number.isSafeInteger(value.seq) || value.seq < 0) {
      throw new AdapterError(
        ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
        'DSH returned an invalid SessionRenameValue',
        { details: { endpoint: DSH_ENDPOINT.SESSION_RENAME.endpoint } },
      );
    }
    return { title: value.title, seq: value.seq };
  }

  /** Archive a session through DSH. Archived history remains owned by DSH. */
  async archiveSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TypeError('archiveSession requires a session id');
    }
    await this.#ensureVerified();
    const value = await this.rpc.call({
      endpoint: DSH_ENDPOINT.WORKSPACE_ARCHIVE_SESSION.endpoint,
      args: { [DSH_ENDPOINT.WORKSPACE_ARCHIVE_SESSION.argKey]: { sessionId } },
    });
    if (!isRecord(value) || !Array.isArray(value.archivedSessionIds) || !value.archivedSessionIds.includes(sessionId)) {
      throw new AdapterError(
        ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
        'DSH returned an invalid WorkspaceArchiveSessionValue',
        { details: { endpoint: DSH_ENDPOINT.WORKSPACE_ARCHIVE_SESSION.endpoint } },
      );
    }
    return { archivedSessionIds: value.archivedSessionIds };
  }

  /**
   * Get one session summary.
   *
   * @param {string} sessionId - DSH session identity.
   * @param {object} [options] - get options.
   * @param {object} [options.context] - status-derivation context.
   * @returns {Promise<object>} the mobile summary.
   * @throws {AdapterError} `SESSION_NOT_FOUND` when no such session exists.
   */
  async getSession(sessionId, options = {}) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new AdapterError(ADAPTER_ERROR.SESSION_NOT_FOUND, 'getSession requires a session id');
    }
    await this.#ensureVerified();
    const { value } = await this.#listRaw();
    const raw = value.items.find((item) => item.sessionId === sessionId);
    if (raw === undefined) {
      throw new AdapterError(ADAPTER_ERROR.SESSION_NOT_FOUND, 'no such session in this DSH home', {
        details: { sessionId },
      });
    }
    return toSummary(raw, { deriveStatus: this.deriveStatus, context: options.context });
  }

  /**
   * Read one page of raw `SessionListValue`.
   *
   * @returns {Promise<{value: object}>} the raw list envelope.
   */
  async #listRaw() {
    const value = await this.rpc.call({
      endpoint: DSH_ENDPOINT.SESSION_LIST.endpoint,
      args: { [DSH_ENDPOINT.SESSION_LIST.argKey]: {} },
    });
    const check = validateSessionListValue(value);
    if (!check.ok) {
      throw new AdapterError(
        ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
        `DSH returned an invalid SessionListValue: ${check.reason}`,
      );
    }
    for (const item of value.items) this.knownSessions.add(item.sessionId);
    return { value };
  }

  /**
   * Read message history through `session/page`.
   *
   * R1 §16 requires the page API and forbids reading the zstd session log
   * directly. History is cold-safe on the Host: paging never activates an Agent.
   *
   * `throughSeq` is the inclusive log cursor. When the caller omits it, the
   * adapter opens a `follow` stream just far enough to read the opening
   * snapshot's cursor, then cancels it. That is the only way R1 can learn the
   * cursor, because `SessionSummary` does not carry one.
   *
   * @param {string} sessionId - DSH session identity.
   * @param {object} [options] - page options.
   * @param {number} [options.throughSeq] - inclusive cursor; resolved when omitted.
   * @param {number} [options.beforeSeq] - exclusive upper bound for older pages.
   * @param {number} [options.maxMessages] - page size, default 50.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @returns {Promise<{messages: object[], raw: object, throughSeq: number, hasMore: boolean}>}
   *   normalized messages plus the raw page.
   */
  async getMessages(sessionId, options = {}) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new AdapterError(ADAPTER_ERROR.SESSION_NOT_FOUND, 'getMessages requires a session id');
    }
    await this.#ensureVerified();

    const throughSeq = options.throughSeq ?? (await this.#resolveCursor(sessionId, options.signal));

    const args = {
      address: { kind: 'session', sessionId },
      throughSeq,
      ...(options.beforeSeq === undefined ? {} : { beforeSeq: options.beforeSeq }),
      ...(options.maxMessages === undefined ? {} : { maxMessages: options.maxMessages }),
    };

    const value = await this.rpc.call({
      endpoint: DSH_ENDPOINT.SESSION_PAGE.endpoint,
      args: { [DSH_ENDPOINT.SESSION_PAGE.argKey]: args },
      signal: options.signal,
    });

    const check = validateSessionPage(value);
    if (!check.ok) {
      throw new AdapterError(
        ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
        `DSH returned an invalid SessionPage: ${check.reason}`,
        { details: { endpoint: DSH_ENDPOINT.SESSION_PAGE.endpoint } },
      );
    }

    return {
      messages: toMessages(value.records, sessionId),
      raw: value,
      throughSeq,
      hasMore: value.hasMore,
    };
  }

  /**
   * Learn a session's current inclusive log cursor from a `follow` opening
   * snapshot, then release the stream.
   *
   * @param {string} sessionId - DSH session identity.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<number>} the snapshot cursor.
   * @throws {AdapterError} `SESSION_NOT_FOUND` when the stream reports it.
   */
  async #resolveCursor(sessionId, signal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const stream = this.rpc.openStream({
        endpoint: DSH_ENDPOINT.SESSION_FOLLOW.endpoint,
        args: {
          [DSH_ENDPOINT.SESSION_FOLLOW.argKey]: {
            address: { kind: 'session', sessionId },
            maxMessages: 1,
          },
        },
        signal: controller.signal,
      });
      for await (const frame of stream) {
        const check = validateSessionFollowFrame(frame);
        if (!check.ok) {
          throw new AdapterError(
            ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
            `DSH returned an invalid follow frame: ${check.reason}`,
          );
        }
        if (frame.type === 'snapshot') return frame.cursor;
      }
      throw new AdapterError(
        ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
        'the DSH follow stream ended before delivering an opening snapshot',
        { details: { sessionId } },
      );
    } catch (error) {
      throw this.#mapSessionError(error, sessionId);
    } finally {
      controller.abort();
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Submit a prompt to an existing session.
   *
   * `client_message_id` becomes the DSH `requestId` unchanged (R1 §10, §18.2).
   * The adapter keeps no duplicate registry: DSH is the dedupe authority, and a
   * repeated `requestId` returns the original acceptance.
   *
   * @param {string} sessionId - target session.
   * @param {object} message - prompt input.
   * @param {string} message.client_message_id - caller-minted idempotency identity.
   * @param {Array<object>|string} message.content - content parts or plain text.
   * @param {'queue'|'steer'} message.mode - explicit delivery mode.
   * @param {string} [message.clientTimeZone] - optional IANA time zone.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @returns {Promise<{accepted: true, requestId: string}>} acceptance plus the id used.
   */
  async sendMessage(sessionId, message, options = {}) {
    await this.#ensureVerified();
    const request = buildPromptRequest({ ...message, sessionId });

    let value;
    try {
      value = await this.rpc.call({
        endpoint: DSH_ENDPOINT.SESSION_PROMPT.endpoint,
        args: { [DSH_ENDPOINT.SESSION_PROMPT.argKey]: request },
        signal: options.signal,
      });
    } catch (error) {
      throw this.#mapSessionError(error, sessionId);
    }

    const check = validateSessionPromptValue(value);
    if (!check.ok) {
      throw new AdapterError(
        ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
        `DSH returned an invalid SessionPromptValue: ${check.reason}`,
      );
    }
    return { accepted: true, requestId: request.requestId };
  }

  /**
   * Subscribe to a session's live frames.
   *
   * `unsubscribe()` aborts only this logical stream: it does not close the DSH
   * server, does not cancel the session's Agent task, and does not disturb other
   * logical streams on the same physical WebSocket (R1 §14.2).
   *
   * @param {string} sessionId - DSH session identity.
   * @param {(frame: object) => void} listener - receives `{kind, frame, assistantFrame?}`.
   * @param {object} [options] - subscription options.
   * @param {number} [options.maxMessages] - snapshot size hint, default 50.
   * @param {boolean} [options.assistantStream] - request assistant delta frames.
   * @param {AbortSignal} [options.signal] - external cancellation.
   * @returns {Promise<{unsubscribe: () => Promise<void>, cursor: () => number|null}>} handle.
   */
  async subscribe(sessionId, listener, options = {}) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new AdapterError(ADAPTER_ERROR.SESSION_NOT_FOUND, 'subscribe requires a session id');
    }
    if (typeof listener !== 'function') {
      throw new TypeError('subscribe requires a listener function');
    }
    await this.#ensureVerified();

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const args = {
      address: { kind: 'session', sessionId },
      maxMessages: options.maxMessages ?? DEFAULT_MAX_MESSAGES,
      ...(options.assistantStream === false ? {} : { assistantStream: true }),
    };

    const stream = this.rpc.openStream({
      endpoint: DSH_ENDPOINT.SESSION_FOLLOW.endpoint,
      args: { [DSH_ENDPOINT.SESSION_FOLLOW.argKey]: args },
      signal: controller.signal,
    });

    let cursor = null;
    const pump = (async () => {
      try {
        for await (const frame of stream) {
          const check = validateSessionFollowFrame(frame);
          if (!check.ok) {
            listener({
              kind: SUBSCRIPTION_FRAME.ERROR,
              error: new AdapterError(
                ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
                `DSH sent an invalid follow frame: ${check.reason}`,
              ),
            });
            continue;
          }
          if (frame.type === 'snapshot' && typeof frame.cursor === 'number') cursor = frame.cursor;
          listener(toSubscriptionFrame(frame));
        }
      } catch (error) {
        const mapped = this.#mapSessionError(error, sessionId);
        // An abort requested by the caller is a normal end of subscription, not
        // an error the listener should treat as a session failure.
        if (mapped.code === ADAPTER_ERROR.STREAM_ABORTED) return;
        listener({ kind: SUBSCRIPTION_FRAME.ERROR, error: mapped });
      }
    })();

    return {
      unsubscribe: async () => {
        options.signal?.removeEventListener('abort', onExternalAbort);
        controller.abort();
        await pump;
      },
      cursor: () => cursor,
    };
  }

  /**
   * Subscribe to the Host-wide live session-control stream (R2 §21).
   *
   * `session/control` carries no session selector: one logical stream reports the
   * Host's current queues, jobs and projections for every session, opening with a
   * single `baseline` frame and then emitting per-session replacement frames.
   *
   * R2 needs this because the empty-queue transition (`QUEUE_EMPTY`) has no other
   * authoritative source: a boolean `running` flag cannot say whether work is
   * waiting. The R1 six methods are unchanged and remain the primary contract.
   *
   * Caveat recorded in the evidence audit: DSH documents control baselines as
   * process-local state, so they cannot reconstruct jobs across a Host restart.
   *
   * @param {(frame: object) => void} listener - receives `{kind, frame}`.
   * @param {object} [options] - subscription options.
   * @param {AbortSignal} [options.signal] - external cancellation.
   * @returns {Promise<{unsubscribe: () => Promise<void>}>} the subscription handle.
   */
  async subscribeControl(listener, options = {}) {
    if (typeof listener !== 'function') {
      throw new TypeError('subscribeControl requires a listener function');
    }
    await this.#ensureVerified();

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const stream = this.rpc.openStream({
      endpoint: DSH_ENDPOINT.SESSION_CONTROL.endpoint,
      args: {},
      signal: controller.signal,
    });

    const pump = (async () => {
      try {
        for await (const frame of stream) {
          const check = validateSessionControlFrame(frame);
          if (!check.ok) {
            listener({
              kind: CONTROL_FRAME.ERROR,
              error: new AdapterError(
                ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
                `DSH sent an invalid control frame: ${check.reason}`,
              ),
            });
            continue;
          }
          listener(toControlFrame(frame));
        }
      } catch (error) {
        const mapped = error instanceof AdapterError
          ? error
          : new AdapterError(ADAPTER_ERROR.DSH_UNAVAILABLE, 'the control stream failed', { cause: error });
        if (mapped.code === ADAPTER_ERROR.STREAM_ABORTED) return;
        listener({ kind: CONTROL_FRAME.ERROR, error: mapped });
      }
    })();

    return {
      unsubscribe: async () => {
        options.signal?.removeEventListener('abort', onExternalAbort);
        controller.abort();
        await pump;
      },
    };
  }

  /**
   * Upload raw bytes for a session and receive a prompt-ready receipt — R3 §24.
   *
   * DSH's upload route is addressed by session and mints a `receiptId` staged
   * against that session's Agent. The receipt is then referenced from a prompt as
   * `{ type: 'file', receiptId }`, which is exactly what `sendMessage` forwards.
   *
   * @param {string} sessionId - target session; the receipt is scoped to it.
   * @param {object} input - upload input.
   * @param {Iterable<Uint8Array>|AsyncIterable<Uint8Array>} input.chunks - body chunks.
   * @param {string} [input.name] - optional display name.
   * @param {AbortSignal} [input.signal] - caller cancellation.
   * @returns {Promise<{receiptId: string, file: object|null}>} the receipt and file facts.
   * @throws {AdapterError} `SESSION_NOT_FOUND`, `WIRE_PROTOCOL_ERROR`, or a mapped DSH code.
   */
  async uploadFile(sessionId, input = {}) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new AdapterError(ADAPTER_ERROR.SESSION_NOT_FOUND, 'uploadFile requires a session id');
    }
    if (typeof this.rpc.uploadRaw !== 'function') {
      throw new AdapterError(
        ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
        'this RPC client does not support raw uploads',
      );
    }
    await this.#ensureVerified();

    let value;
    try {
      value = await this.rpc.uploadRaw({
        sessionId,
        chunks: input.chunks,
        name: input.name,
        signal: input.signal,
      });
    } catch (error) {
      throw this.#mapSessionError(error, sessionId);
    }

    const receiptId = value?.receiptId;
    if (typeof receiptId !== 'string' || receiptId.length === 0) {
      throw new AdapterError(
        ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
        'DSH accepted the upload but returned no receiptId',
      );
    }

    return {
      receiptId,
      file: value.file ?? null,
    };
  }

  /**
   * Cancel the running task in a live session.
   *
   * Maps to DSH `session/cancel`, which reads the in-process Agent registry
   * only. A session that is not attached reports `session/not-found`, which R1
   * maps to `SESSION_COLD` (R1 §15). R1 §15 forbids returning success in that
   * case and forbids any `taskkill` / `Stop-Process` fallback.
   *
   * @param {string} sessionId - DSH session identity.
   * @param {object} [options] - cancel options.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @returns {Promise<{accepted: true, sessionId: string}>} the Host's admission receipt.
   */
  async cancel(sessionId, options = {}) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new AdapterError(ADAPTER_ERROR.SESSION_NOT_FOUND, 'cancel requires a session id');
    }
    await this.#ensureVerified();

    let value;
    try {
      value = await this.rpc.call({
        endpoint: DSH_ENDPOINT.SESSION_CANCEL.endpoint,
        args: { [DSH_ENDPOINT.SESSION_CANCEL.argKey]: { sessionId } },
        signal: options.signal,
      });
    } catch (error) {
      if (error instanceof AdapterError && error.code === ADAPTER_ERROR.SESSION_NOT_FOUND) {
        // `session/cancel` cannot tell "unknown" from "not attached". Both mean
        // there is no live Agent to cancel, which is SESSION_COLD for this call.
        throw new AdapterError(ADAPTER_ERROR.SESSION_COLD, 'the session has no live Agent to cancel', {
          details: { sessionId },
          retryable: false,
        });
      }
      throw this.#mapSessionError(error, sessionId);
    }

    const check = validateSessionCancelValue(value);
    if (!check.ok) {
      throw new AdapterError(
        ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
        `DSH returned an invalid SessionCancelValue: ${check.reason}`,
      );
    }
    return { accepted: true, sessionId };
  }

  /**
   * Add session context to a DSH failure without losing its precise code.
   *
   * @param {unknown} error - failure raised below.
   * @param {string} sessionId - session the operation addressed.
   * @returns {AdapterError} the failure, enriched.
   */
  #mapSessionError(error, sessionId) {
    if (!(error instanceof AdapterError)) {
      return new AdapterError(ADAPTER_ERROR.WIRE_PROTOCOL_ERROR, 'unexpected failure while talking to DSH', {
        cause: error,
        details: { sessionId },
      });
    }
    if (error.code === ADAPTER_ERROR.SESSION_NOT_FOUND) {
      return new AdapterError(
        this.knownSessions.has(sessionId) ? ADAPTER_ERROR.SESSION_COLD : ADAPTER_ERROR.SESSION_NOT_FOUND,
        error.message,
        { cause: error, details: { sessionId } },
      );
    }
    return error;
  }

  /**
   * Release adapter resources: closes the shared mux socket.
   *
   * @returns {Promise<void>} resolves once closed.
   */
  async close() {
    await this.rpc.close();
  }
}

/**
 * Re-export of the remote-code mapper, so callers above the adapter can classify
 * a failure without importing the wire layer.
 */
export { mapRemoteCode };

/**
 * Build a production `DshAdapter` over a real wire client.
 *
 * This factory lives here, next to the adapter, because `dsh-adapter.mjs` is the only
 * module permitted to import `wire/` (R2 §2). The R7 supervisor needs a real adapter,
 * and giving it the wire knowledge directly would put DSH protocol types above the
 * boundary the whole architecture depends on.
 *
 * The `authProvider` is the production cookie provider. It is consumed here and never
 * travels further up: §18 confines the DSH cookie to the adapter boundary.
 *
 * @param {object} options - factory options.
 * @param {string} options.authority - the DSH `host:port` the cookie is bound to.
 * @param {object} options.authProvider - the DSH cookie provider.
 * @param {string} [options.expectedVersion] - the pinned DSH version.
 * @param {string[]} [options.supportedVersions] - the accepted version list.
 * @param {object} [options.rpcClient] - an injected wire client, for tests.
 * @param {object} [options.versionGuard] - an injected guard, for tests.
 * @returns {DshAdapter} the adapter.
 */
export function createDshAdapter(options) {
  const rpcClient = options.rpcClient ?? new DshRpcClient({
    authority: options.authority,
    authProvider: options.authProvider,
  });
  const versionGuard = options.versionGuard ?? new DshVersionGuard({
    observedVersion: options.expectedVersion,
    supported: options.supportedVersions ?? (options.expectedVersion === undefined ? undefined : [options.expectedVersion]),
    source: 'r7-production-config',
  });
  return new DshAdapter({ rpcClient, versionGuard, authProvider: options.authProvider });
}
