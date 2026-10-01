/**
 * API route table — Phase R3 §12-§18, §25.
 *
 * Every handler consumes R2 domain services only. No handler imports `wire/*`,
 * names a DSH endpoint, or touches the filesystem. A test reads these files and
 * fails if that ever stops being true (§2).
 *
 * Four distinct identities appear in this layer and are never interchanged (§34):
 *
 *   HTTP request_id                server-generated, per request
 *   client_message_id / requestId  client-minted, one identity
 *   DSH durable source sequence    history cursor
 *   Gateway event sequence         realtime identity, not exposed here
 */

import { Router } from './router.mjs';
import { API_ERROR, HTTP_STATUS, apiError, toApiError } from './errors.mjs';
import { writeJson, writeSuccess } from './response.mjs';
import { readJsonBody, readRawBody } from './request.mjs';
import { messagePageBlock, paginateSessions } from './pagination.mjs';
import {
  normaliseMediaType,
  normaliseUploadFilename,
  parseLimit,
  parseSequenceParam,
  parseStrictQuery,
  resolvePromptMode,
  validateClientMessageId,
  validatePromptContent,
  validateSessionId,
} from './validation.mjs';
import { normaliseFilename, parseMultipart } from './multipart.mjs';
import { MESSAGE_TYPE } from '../model/message.mjs';

/** The API prefix. */
export const API_PREFIX = '/api/v1';

/**
 * Project a domain session to the mobile shape (§13).
 *
 * Drops `metadata`, `dsh_cursor`, `observed_at`, `active_run` and every raw DSH
 * field, so a client can never accidentally build on one.
 *
 * @param {object} session - a domain session view.
 * @returns {object} the projection.
 */
export function projectSession(session) {
  return {
    id: session.id,
    title: session.title ?? null,
    status: session.status,
    created_at: session.created_at ?? null,
    updated_at: session.updated_at ?? null,
    last_sequence: session.last_sequence ?? 0,
    running: session.running === true,
    ...(typeof session.agent_preset === 'string' ? { agent_preset: session.agent_preset } : {}),
    ...(session.model_selection === undefined ? {} : { model_selection: session.model_selection }),
    ...(session.workspace_id === undefined ? {} : { workspace_id: session.workspace_id }),
    ...(session.workspace_key === undefined ? {} : { workspace_key: session.workspace_key }),
    ...(session.workspace_name === undefined ? {} : { workspace_name: session.workspace_name }),
  };
}

/**
 * Project a domain message to the mobile shape.
 *
 * @param {object} message - a domain message.
 * @returns {object} the projection.
 */
export function projectMessage(message) {
  return {
    id: message.id,
    session_id: message.session_id,
    role: message.role,
    type: message.type,
    event_type: message.event_type ?? null,
    content: message.content ?? null,
      ...Object.fromEntries(['turn', 'step', 'call_id', 'turn_started_at', 'turn_ended_at']
        .filter(key => message[key] !== undefined).map(key => [key, message[key]])),
    created_at: message.created_at ?? null,
    // A DSH durable source sequence. Never a Gateway event sequence.
    source_sequence: message.source_sequence ?? null,
    ...(message.usage === undefined ? {} : { usage: message.usage }),
    ...(message.durationMs === undefined ? {} : { duration_ms: message.durationMs }),
  };
}

/**
 * Build the route table.
 *
 * @param {object} deps - resolved dependencies.
 * @param {object} deps.sessionsService - R2 sessions service.
 * @param {object} deps.messagesService - R2 messages service.
 * @param {object} deps.eventsService - R2 events service.
 * @param {object} deps.statusService - R3 status service.
 * @param {object} deps.uploadService - R3 upload service.
 * @param {object} deps.config - resolved HTTP config.
 * @param {() => object} deps.healthFacts - supplies health facts.
 * @param {() => object} deps.versionInfo - supplies the observed DSH version.
 * @returns {Router} the router.
 */
export function buildRouter(deps) {
  const router = new Router();
  const { config } = deps;

  const jsonLimits = { maxBytes: config.maxJsonBytes };

  const stringField = (value, field, maxLength = 256) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
      throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_REQUEST, `The ${field} value is invalid.`, {
        details: { field },
      });
    }
    return value;
  };

  /**
   * Refuse a mutating command when durability is unavailable (R5 §15).
   *
   * Read-only routes deliberately do not call this: §15 keeps reads available so a
   * phone can still see state while the disk problem is fixed.
   *
   * @returns {void}
   * @throws {ApiError} `503 PERSISTENCE_UNAVAILABLE`.
   */
  const requireDurable = () => {
    if (typeof deps.persistenceHealth !== 'function') return;
    const health = deps.persistenceHealth();
    if (health === null || health === undefined) return;
    if (health.status === 'ready') return;
    throw apiError(
      HTTP_STATUS.UNAVAILABLE,
      'PERSISTENCE_UNAVAILABLE',
      'The gateway cannot durably record this command, so it was not accepted.',
      { retryable: true },
    );
  };

  // ── health ─────────────────────────────────────────────────────────────────
  router.add({
    method: 'GET',
    path: `${API_PREFIX}/health`,
    handler: async ({ requestId, authenticated }) => {
      const facts = deps.healthFacts();

      // R6 §11: an unauthenticated caller gets the minimum needed to see that the
      // process is alive, and nothing operational. DSH status, persistence format
      // and failure codes are all withheld, because they describe the machine
      // rather than the service.
      if (deps.authService !== undefined && deps.authService !== null
        && deps.authService.requiresAuthForDetail && authenticated !== true) {
        return {
          status: HTTP_STATUS.OK,
          body: {
            api_version: 1,
            data: {
              gateway: facts.gateway,
              auth: { required: true, mode: deps.authService.health().mode },
              request_id: requestId,
            },
          },
        };
      }

      return {
        status: HTTP_STATUS.OK,
        body: {
          api_version: 1,
          data: {
            status: 'ok',
            gateway: facts.gateway,
            // `ready` describes the downstream, so "HTTP is up" and "DSH is
            // usable" are never collapsed into one boolean (§12).
            ready: facts.ready,
            dsh: {
              status: facts.dsh.status,
              version: facts.dsh.version ?? null,
              ...(facts.dsh.reason_code === undefined ? {} : { reason_code: facts.dsh.reason_code }),
            },
            // R5 §14: durability is a separate axis from DSH availability.
            ...(facts.persistence === undefined
              ? {}
              : {
                persistence: {
                  status: facts.persistence.status,
                  format_version: facts.persistence.format_version,
                  ...(facts.persistence.reason_code === undefined
                    ? {}
                    : { reason_code: facts.persistence.reason_code }),
                },
              }),
            // R6 §46: auth is a fourth axis, never folded into the others.
            ...(facts.auth === undefined ? {} : { auth: facts.auth }),
            request_id: requestId,
          },
        },
      };
    },
  });

  // ── sessions ───────────────────────────────────────────────────────────────
  router.add({
    method: 'GET',
    path: `${API_PREFIX}/agent-presets`,
    handler: async () => ({
      status: HTTP_STATUS.OK,
      body: { api_version: 1, data: await deps.sessionsService.adapter.listAgentPresets() },
    }),
  });

  router.add({
    method: 'GET',
    path: `${API_PREFIX}/models`,
    handler: async () => ({
      status: HTTP_STATUS.OK,
      body: { api_version: 1, data: await deps.sessionsService.adapter.getModelCatalog() },
    }),
  });

  router.add({
    method: 'GET',
    path: `${API_PREFIX}/sessions`,
    handler: async ({ url }) => {
      const query = parseStrictQuery(url.searchParams, { allowed: ['limit', 'cursor'] });
      const limit = parseLimit(query.limit, { defaultLimit: config.defaultLimit, maxLimit: config.maxLimit });
      // Enumerate DSH **before** paginating, so a page is a slice of the current DSH inventory
      // rather than of this Gateway's tracked set. `listFresh` encapsulates the refresh and
      // propagates an adapter failure, which the error mapper turns into the standard Gateway
      // error vocabulary — never a stale 200.
      const sessions = await deps.sessionsService.listFresh();
      const page = paginateSessions(sessions, { limit, cursor: query.cursor });
      return {
        status: HTTP_STATUS.OK,
        body: {
          api_version: 1,
          data: page.items.map(projectSession),
          page: page.page,
        },
      };
    },
  });

  router.add({
    method: 'POST',
    path: `${API_PREFIX}/sessions`,
    handler: async ({ req, url }) => {
      // No query parameter is meaningful. A strict empty allowlist refuses a
      // path/workspace smuggled through the query string.
      parseStrictQuery(url.searchParams, { allowed: [] });
      const body = await readJsonBody(req, jsonLimits);

      // The phone may select a DSH-rostered Agent preset and an opaque workspace
      // key from the current session inventory. It never supplies cwd/workspaceId.
      const supplied = Object.keys(body);
      const allowed = new Set(['agent_preset', 'workspace_key']);
      const unknown = supplied.find((key) => !allowed.has(key));
      if (unknown !== undefined) {
        throw apiError(
          HTTP_STATUS.BAD_REQUEST,
          API_ERROR.INVALID_REQUEST,
          'Session creation accepts only an optional Agent preset and known workspace key.',
          { details: { field: unknown } },
        );
      }
      const agentPreset = body.agent_preset === undefined ? undefined : stringField(body.agent_preset, 'agent_preset');
      const workspaceKey = body.workspace_key === undefined ? undefined : stringField(body.workspace_key, 'workspace_key', 256);
      if (agentPreset !== undefined) {
        const roster = await deps.sessionsService.adapter.listAgentPresets();
        if (!roster.presets.some((preset) => preset.id === agentPreset && preset.broken !== true)) {
          throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_REQUEST, 'The requested Agent preset is not available from DSH.', {
            details: { field: 'agent_preset' },
          });
        }
      }

      // A create is a durable mutating command: fail closed when the journal
      // cannot record it rather than acknowledging a session nothing tracked.
      requireDurable();

      const session = await deps.sessionsService.create({
        ...(agentPreset === undefined ? {} : { agentPreset }),
        ...(workspaceKey === undefined ? {} : { workspaceKey }),
      });

      // A safe identity projection. It carries no workspace/path metadata and no
      // raw DSH field, so the phone learns only what it legitimately needs to
      // select and address the new session.
      return {
        status: HTTP_STATUS.CREATED,
        body: { api_version: 1, data: projectSession(session) },
      };
    },
  });

  router.add({
    method: 'POST',
    path: `${API_PREFIX}/workspaces/:workspaceKey/archive`,
    handler: async ({ params, url }) => {
      const workspaceKey = stringField(params.workspaceKey, 'workspace_key', 256);
      parseStrictQuery(url.searchParams, { allowed: [] });
      requireDurable();

      // Resolve membership only from a fresh DSH inventory. The client sends an
      // opaque key, never a path, and this route has no filesystem operations.
      const sessions = await deps.sessionsService.listFresh({ force: true });
      const members = sessions.filter((session) => session.workspace_key === workspaceKey);
      if (members.length === 0) {
        throw apiError(HTTP_STATUS.NOT_FOUND, API_ERROR.SESSION_NOT_FOUND, 'Workspace group was not found or is empty.');
      }

      // DSH does not provide a transactional multi-session archive. Record only
      // successful archive calls so a partial failure can be reconciled on refresh.
      const archivedSessionIds = [];
      let failedCount = 0;
      for (const session of members) {
        try {
          if (await deps.sessionsService.archive(session.id)) archivedSessionIds.push(session.id);
          else failedCount += 1;
        } catch {
          failedCount += 1;
        }
      }
      return {
        status: HTTP_STATUS.OK,
        body: {
          api_version: 1,
          data: {
            archived: failedCount === 0,
            partial: failedCount > 0,
            archived_count: archivedSessionIds.length,
            failed_count: failedCount,
            archived_session_ids: archivedSessionIds,
          },
        },
      };
    },
  });

  router.add({
    method: 'PUT',
    path: `${API_PREFIX}/sessions/:sessionId/agent-preset`,
    handler: async ({ params, req, url }) => {
      const sessionId = validateSessionId(params.sessionId);
      parseStrictQuery(url.searchParams, { allowed: [] });
      const body = await readJsonBody(req, jsonLimits);
      if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'agent_preset')) {
        throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_REQUEST, 'Agent preset selection requires agent_preset.', {
          details: { field: Object.keys(body)[0] ?? 'agent_preset' },
        });
      }
      const agentPreset = stringField(body.agent_preset, 'agent_preset');
      const roster = await deps.sessionsService.adapter.listAgentPresets();
      if (!roster.presets.some((preset) => preset.id === agentPreset && preset.broken !== true)) {
        throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_REQUEST, 'The requested Agent preset is not available from DSH.', {
          details: { field: 'agent_preset' },
        });
      }
      requireDurable();
      const session = await deps.sessionsService.get(sessionId);
      if (session === null || session === undefined) {
        throw apiError(HTTP_STATUS.NOT_FOUND, API_ERROR.SESSION_NOT_FOUND, 'Session was not found.', { details: { sessionId } });
      }
      const selected = await deps.sessionsService.adapter.selectAgentPreset(sessionId, agentPreset);
      const current = deps.sessionsService.store.get(sessionId);
      if (current !== null && current !== undefined) {
        deps.sessionsService.store.upsertSession({ ...current, agent_preset: selected.agentPreset });
      }
      return { status: HTTP_STATUS.OK, body: { api_version: 1, data: selected } };
    },
  });

  router.add({
    method: 'PUT',
    path: `${API_PREFIX}/sessions/:sessionId/model`,
    handler: async ({ params, req, url }) => {
      const sessionId = validateSessionId(params.sessionId);
      parseStrictQuery(url.searchParams, { allowed: [] });
      const body = await readJsonBody(req, jsonLimits);
      const allowed = new Set(['provider', 'model', 'reasoning_effort']);
      const unknown = Object.keys(body).find((key) => !allowed.has(key));
      if (unknown !== undefined || !Object.hasOwn(body, 'provider') || !Object.hasOwn(body, 'model')) {
        throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_REQUEST, 'Model selection requires provider and model, with optional reasoning_effort.', {
          details: { field: unknown ?? (!Object.hasOwn(body, 'provider') ? 'provider' : 'model') },
        });
      }
      const provider = stringField(body.provider, 'provider');
      const model = stringField(body.model, 'model');
      const reasoningEffort = body.reasoning_effort === undefined
        ? undefined
        : stringField(body.reasoning_effort, 'reasoning_effort');
      const catalog = await deps.sessionsService.adapter.getModelCatalog();
      const providerRow = catalog.groups.find((group) => group.id === provider);
      const modelRow = providerRow?.models.find((entry) => entry.id === model);
      const effortAllowed = reasoningEffort === undefined
        || modelRow?.reasoning?.efforts?.some((effort) => effort.id === reasoningEffort) === true;
      if (modelRow === undefined || !effortAllowed) {
        throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_REQUEST, 'The requested model or reasoning strength is not in the current DSH catalog.', {
          details: { field: reasoningEffort !== undefined && modelRow !== undefined ? 'reasoning_effort' : 'model' },
        });
      }
      requireDurable();
      const session = await deps.sessionsService.get(sessionId);
      if (session === null || session === undefined) {
        throw apiError(HTTP_STATUS.NOT_FOUND, API_ERROR.SESSION_NOT_FOUND, 'Session was not found.', { details: { sessionId } });
      }
      const selected = await deps.sessionsService.adapter.selectModel(sessionId, {
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      });
      return {
        status: HTTP_STATUS.OK,
        body: {
          api_version: 1,
          data: {
            provider: selected.provider,
            model: selected.model,
            ...(selected.reasoningEffort === undefined ? {} : { reasoning_effort: selected.reasoningEffort }),
          },
        },
      };
    },
  });

  router.add({
    method: 'GET',
    path: `${API_PREFIX}/sessions/:sessionId`,
    handler: async ({ params }) => {
      const sessionId = validateSessionId(params.sessionId);
      const session = await deps.sessionsService.get(sessionId);
      if (session === null || session === undefined) {
        throw apiError(HTTP_STATUS.NOT_FOUND, API_ERROR.SESSION_NOT_FOUND, 'Session was not found.', {
          details: { sessionId },
        });
      }
      return { status: HTTP_STATUS.OK, body: { api_version: 1, data: projectSession(session) } };
    },
  });

  router.add({
    method: 'PUT',
    path: `${API_PREFIX}/sessions/:sessionId`,
    handler: async ({ params, req, url }) => {
      const sessionId = validateSessionId(params.sessionId);
      parseStrictQuery(url.searchParams, { allowed: [] });
      const body = await readJsonBody(req, jsonLimits);
      const keys = Object.keys(body);
      if (keys.some((key) => key !== 'title') || typeof body.title !== 'string' || body.title.length > 4096) {
        throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_REQUEST, 'Rename requires one title of at most 4096 characters.', {
          details: { field: keys.find((key) => key !== 'title') ?? 'title' },
        });
      }
      requireDurable();
      let session;
      try {
        session = await deps.sessionsService.rename(sessionId, body.title);
      } catch (error) {
        if (error?.code === 'session/title-invalid') {
          throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_REQUEST, 'The title is empty or exceeds the DSH title limit.');
        }
        throw error;
      }
      if (session === null || session === undefined) {
        throw apiError(HTTP_STATUS.NOT_FOUND, API_ERROR.SESSION_NOT_FOUND, 'Session was not found.', {
          details: { sessionId },
        });
      }
      return { status: HTTP_STATUS.OK, body: { api_version: 1, data: projectSession(session) } };
    },
  });

  router.add({
    method: 'DELETE',
    path: `${API_PREFIX}/sessions/:sessionId`,
    handler: async ({ params, url }) => {
      const sessionId = validateSessionId(params.sessionId);
      parseStrictQuery(url.searchParams, { allowed: [] });
      requireDurable();
      const archived = await deps.sessionsService.archive(sessionId);
      if (!archived) {
        throw apiError(HTTP_STATUS.NOT_FOUND, API_ERROR.SESSION_NOT_FOUND, 'Session was not found.', {
          details: { sessionId },
        });
      }
      return { status: HTTP_STATUS.OK, body: { api_version: 1, data: { archived: true } } };
    },
  });

  // ── history ────────────────────────────────────────────────────────────────
  router.add({
    method: 'GET',
    path: `${API_PREFIX}/sessions/:sessionId/messages`,
    handler: async ({ params, url }) => {
      const sessionId = validateSessionId(params.sessionId);
      const query = parseStrictQuery(url.searchParams, { allowed: ['limit', 'through_seq', 'before_seq'] });
      const limit = parseLimit(query.limit, { defaultLimit: config.defaultLimit, maxLimit: config.maxLimit });
      const throughSeq = parseSequenceParam(query.through_seq, 'through_seq');
      const beforeSeq = parseSequenceParam(query.before_seq, 'before_seq');

      const session = await deps.sessionsService.get(sessionId);
      if (session === null || session === undefined) {
        throw apiError(HTTP_STATUS.NOT_FOUND, API_ERROR.SESSION_NOT_FOUND, 'Session was not found.', {
          details: { sessionId },
        });
      }

      // Read history through the R2 service, which goes through the adapter's
      // page call. The HTTP layer never touches storage.
      const page = await deps.messagesService.list(sessionId, {
        maxMessages: limit,
        ...(throughSeq === undefined ? {} : { throughSeq }),
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      });

      return {
        status: HTTP_STATUS.OK,
        body: {
          api_version: 1,
          data: page.messages.map(projectMessage),
          page: messagePageBlock({
            limit,
            returned: page.messages.length,
            throughSeq: page.through_sequence,
            beforeSeq: beforeSeq ?? null,
            nextBeforeSeq: page.next_before_sequence,
            hasMore: page.has_more,
          }),
        },
      };
    },
  });

  // ── prompt ─────────────────────────────────────────────────────────────────
  router.add({
    method: 'POST',
    path: `${API_PREFIX}/sessions/:sessionId/messages`,
    handler: async ({ req, params }) => {
      const sessionId = validateSessionId(params.sessionId);
      const body = await readJsonBody(req, jsonLimits);

      const clientMessageId = validateClientMessageId(body.client_message_id);
      const mode = resolvePromptMode(body.mode, config);
      const content = validatePromptContent(body.content);

      // R5 §15: a mutating command fails closed when durability is gone. This is
      // an explicit gate rather than relying on a signal being emitted, because a
      // state-machine-ignored signal would otherwise let the command be
      // acknowledged with nothing persisted behind it.
      requireDurable();

      const session = await deps.sessionsService.get(sessionId);
      if (session === null || session === undefined) {
        throw apiError(HTTP_STATUS.NOT_FOUND, API_ERROR.SESSION_NOT_FOUND, 'Session was not found.', {
          details: { sessionId },
        });
      }

      // The id is preserved one-for-one: it IS the DSH requestId (R1 §10).
      const result = await deps.sessionsService.adapter.sendMessage(sessionId, {
        client_message_id: clientMessageId,
        content,
        mode,
      });

      // Reflect the accepted prompt in the domain immediately, without waiting
      // for the model (§17.3). The realtime answer belongs to R4.
      deps.statusService.events.applySignal(sessionId, {
        signal: mode === 'steer' ? 'PROMPT_ACCEPTED_STEER' : 'PROMPT_ACCEPTED_QUEUE',
        sessionId,
        evidence: { source: 'rest prompt accepted', mode },
      });
      await deps.statusService.ensureFollow(sessionId);

      return {
        status: HTTP_STATUS.ACCEPTED,
        body: {
          api_version: 1,
          data: {
            accepted: true,
            session_id: sessionId,
            request_id: result.requestId,
            mode,
          },
        },
      };
    },
  });

  // ── cancel ─────────────────────────────────────────────────────────────────
  router.add({
    method: 'POST',
    path: `${API_PREFIX}/sessions/:sessionId/cancel`,
    // §19: an absent/cold session on a cancel is a state conflict, so the error
    // mapper is told this is a cancel operation. Without this hint the same
    // adapter code would surface as a plain 404 and the §18 mapping would be dead.
    options: { cancelOperation: true },
    handler: async ({ params }) => {
      const sessionId = validateSessionId(params.sessionId);

      // R5 §15: cancel is a mutating command and produces events, so it fails
      // closed with durability unavailable rather than reporting a phantom
      // admission that was never recorded.
      requireDurable();

      const session = await deps.sessionsService.get(sessionId);
      if (session === null || session === undefined) {
        throw apiError(HTTP_STATUS.NOT_FOUND, API_ERROR.SESSION_NOT_FOUND, 'Session was not found.', {
          details: { sessionId },
        });
      }

      const result = await deps.sessionsService.adapter.cancel(sessionId);

      // Admission only. The status is NOT set to `cancelled` here; that requires
      // observed RUN_ABANDONED evidence (§18, and R2 §16).
      deps.statusService.events.applySignal(sessionId, {
        signal: 'CANCEL_ACCEPTED',
        sessionId,
        evidence: { source: 'rest cancel accepted' },
      });

      return {
        status: HTTP_STATUS.ACCEPTED,
        body: {
          api_version: 1,
          data: {
            accepted: true,
            session_id: result.sessionId,
            // Stated explicitly so a client cannot read 202 as "it has stopped".
            quiescent: false,
          },
        },
      };
    },
  });

  // ── upload ─────────────────────────────────────────────────────────────────
  router.add({
    method: 'POST',
    path: `${API_PREFIX}/sessions/:sessionId/uploads`,
    handler: async ({ req, params, url }) => {
      const sessionId = validateSessionId(params.sessionId);

      const session = await deps.sessionsService.get(sessionId);
      if (session === null || session === undefined) {
        throw apiError(HTTP_STATUS.NOT_FOUND, API_ERROR.SESSION_NOT_FOUND, 'Session was not found.', {
          details: { sessionId },
        });
      }

      // Only `name` is meaningful here (raw-bytes shape). Reject anything else so
      // the contract stays as strict as every other endpoint (§30).
      const query = parseStrictQuery(url.searchParams, { allowed: ['name'] });

      const upload = await deps.uploadService.receive(req, sessionId, config, url.searchParams);
      return {
        status: HTTP_STATUS.OK,
        body: {
          api_version: 1,
          data: {
            ...upload,
            ...(query.name === undefined ? {} : { requested_name: query.name }),
          },
        },
      };
    },
  });

  // ── R6 §14/§15: one-time WebSocket ticket ───────────────────────────────────
  //
  // The only way to obtain the credential a browser WebSocket can actually present.
  // The long-lived Bearer stays in the `Authorization` header and never reaches a
  // URL (§1).
  router.add({
    method: 'POST',
    path: '/api/v1/auth/ws-ticket',
    handler: async ({ req, requestId, principalId }) => {
      const auth = deps.authService;
      if (auth === undefined || auth === null) {
        throw apiError(HTTP_STATUS.NOT_FOUND, API_ERROR.ROUTE_NOT_FOUND, 'Route was not found.');
      }
      // The gate has already authenticated, but assert again so the requirement is
      // local to the handler rather than an assumption about call order.
      if (auth.enforcing && (typeof principalId !== 'string' || principalId.length === 0)) {
        throw apiError(HTTP_STATUS.UNAUTHORIZED, 'AUTH_REQUIRED', 'Authentication is required.');
      }

      const body = await readJsonBody(req, jsonLimits);
      const sessionId = validateSessionId(body.session_id);

      // §14: the origin is taken from the actual HTTP request rather than a
      // client-supplied field, so a client cannot nominate the binding it wants.
      const originDecision = auth.originPolicy.check(req.headers.origin);
      const origin = originDecision.allowed ? originDecision.origin : null;

      const issued = auth.mintTicket({
        principalId: principalId ?? auth.principalId,
        sessionId,
        origin,
      });

      return {
        status: HTTP_STATUS.CREATED,
        // §15: the ticket is returned exactly once and must not be cached anywhere,
        // so the response is explicitly non-cacheable.
        headers: { pragma: 'no-cache', 'cache-control': 'no-store' },
        body: {
          api_version: 1,
          data: {
            ticket: issued.ticket,
            expires_at: new Date(issued.expiresAt).toISOString(),
            expires_in_seconds: issued.expiresInSeconds,
            session_id: issued.sessionId,
          },
          request_id: requestId,
        },
      };
    },
  });

  return router;
}

/**
 * Handle one request end to end.
 *
 * @param {object} context - request context.
 * @param {Router} context.router - the router.
 * @param {import('node:http').IncomingMessage} context.req - the request.
 * @param {import('node:http').ServerResponse} context.res - the response.
 * @param {string} context.requestId - the server request id.
 * @returns {Promise<void>} resolves once the response is written.
 */
export async function handleRequest(context) {
  const { router, req, res, requestId } = context;
  /** @type {{route: object}|null} */
  let match = null;

  try {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // R6 §13/§55: the auth gate runs before routing, so a protected route never
    // resolves a session for an unauthenticated caller. That ordering is what
    // prevents session-existence enumeration.
    if (context.authGate !== undefined && context.authGate !== null) {
      const decision = context.authGate.run({ req, pathname: url.pathname, socket: req.socket });
      if (decision.action === 'respond') {
        if (decision.status === 204) {
          res.writeHead(204, decision.headers);
          res.end();
          return;
        }
        writeJson(res, decision.status, { api_version: 1, ...decision.body, request_id: requestId }, {
          headers: decision.headers,
        });
        return;
      }
      // The gate's headers (security headers and exact CORS) apply to the success
      // path as well.
      context.responseHeaders = decision.headers;
      context.principalId = decision.principalId;
      context.authenticated = decision.authenticated === true;
    }

    match = router.resolve(req.method ?? 'GET', url.pathname);

    // An `OPTIONS` request is only ever answered if a route registered it, which
    // none do: R3 sends no CORS headers and does not advertise preflight (§7).
    const result = await match.route.handler({
      req,
      url,
      params: match.params,
      requestId,
      principalId: context.principalId ?? null,
      authenticated: context.authenticated === true,
      auth: context.authService ?? null,
    });

    if (result === undefined || result === null) {
      writeJson(res, HTTP_STATUS.NO_CONTENT, '', { headers: context.responseHeaders });
      return;
    }
    writeJson(res, result.status ?? HTTP_STATUS.OK, result.body, {
      // A route may add its own headers (R6's ticket endpoint sets no-store and
      // pragma). They are layered over the gate's so a route can never drop the
      // security headers by returning its own set.
      headers: { ...context.responseHeaders, ...(result.headers ?? {}) },
    });
  } catch (error) {
    // The route's own hints decide context-sensitive mappings. A routing failure
    // has no route, so it maps with no hints.
    const apiErr = toApiError(error, match?.route?.options ?? {});
    writeJson(res, apiErr.status, apiErr.toEnvelope(requestId), {
      headers: { ...context.responseHeaders, ...apiErr.headers },
    });
  }
}

export { writeSuccess, MESSAGE_TYPE, normaliseFilename, parseMultipart, readRawBody, normaliseMediaType, normaliseUploadFilename };
