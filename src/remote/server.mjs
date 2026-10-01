/**
 * Loopback HTTP server factory — Phase R3 §4, §5, §6, §31.
 *
 * Hard rules this module enforces:
 *
 *   - **No import-time side effects.** Importing it binds nothing, opens no
 *     socket, reads no credential, touches no DSH and writes no state (§4).
 *   - **Loopback only.** A non-loopback host throws rather than being silently
 *     narrowed (§5).
 *   - **Host fence.** The `Host` authority must be loopback on this server's own
 *     port, or the request is refused with 403 (§6). Proxy headers are never
 *     consulted.
 *   - **Graceful stop.** Stop accepting, close idle connections, stop the status
 *     service, then close the adapter. It never kills a DSH process (§31).
 */

import { createServer } from 'node:http';

import { resolveHttpConfig, checkHostHeader } from './http/config.mjs';
import { API_ERROR, HTTP_STATUS, apiError, toApiError } from './http/errors.mjs';
import { newRequestId, readClientRequestId, writeJson } from './http/response.mjs';
import { buildRouter, handleRequest } from './http/routes.mjs';
import { StatusService } from './status-service.mjs';
import { UploadService } from './uploads.mjs';
import { attachWebSocketServer } from './ws/server.mjs';
import { EVENTS_PATH } from './ws/protocol.mjs';
import { PersistenceService } from './persistence/persistence.mjs';
import { AuthGate } from './auth/auth-gate.mjs';
import { validateAuthConfig } from './auth/config.mjs';
import { Reconciler } from './persistence/reconcile.mjs';

/**
 * Create the remote HTTP server.
 *
 * @param {object} options - factory options.
 * @param {object} options.sessionsService - R2 sessions service.
 * @param {object} options.messagesService - R2 messages service.
 * @param {object} options.eventsService - R2 events service.
 * @param {object} [options.statusService] - R3 status service; created when absent.
 * @param {object} [options.uploadService] - R3 upload service; created when absent.
 * @param {object} [options.config] - resolved config; otherwise resolved from the environment.
 * @param {object} [options.adapter] - required when a service must be created.
 * @param {object} [options.browserLoginService] - production-only loopback DSH Web handoff.
 * @param {object} [options.healthFacts] - override for the health endpoint's facts.
 * @returns {object} the server handle.
 * @throws {TypeError} when a required service is missing, or the host is not loopback.
 */
export function createRemoteHttpServer(options = {}) {
  if (options.sessionsService === undefined) throw new TypeError('createRemoteHttpServer requires sessionsService');
  if (options.messagesService === undefined) throw new TypeError('createRemoteHttpServer requires messagesService');

  // Configuration is validated eagerly so a misconfigured host fails at
  // construction rather than at the first request.
  const config = options.config ?? resolveHttpConfig();

  const adapter = options.adapter ?? options.sessionsService.adapter;
  if (adapter === undefined) throw new TypeError('createRemoteHttpServer requires an adapter');

  const eventsService = options.eventsService ?? options.statusService?.events;
  const statusService = options.statusService ?? new StatusService({
    adapter,
    eventsService,
  });
  const uploadService = options.uploadService ?? new UploadService({ adapter });
  const browserLoginService = options.browserLoginService ?? null;

  /**
   * R6 authentication. The decision must be **explicit**.
   *
   * Three accepted forms, and no implicit default:
   *
   *   - an `AuthService` object → use it as-is;
   *   - `null` → authentication is off, which is only legitimate for a synthetic
   *     fixture (the auth config still has to say `disabled-fixture`);
   *   - omitted → `TypeError`.
   *
   * §5 is explicit that this must not repeat R5's mistake, where omitting an option
   * silently inherited a production default. Here omitting it silently disables
   * authentication, which would be worse.
   */
  const authOption = options.auth;
  if (authOption === undefined) {
    throw new TypeError(
      'createRemoteHttpServer requires an explicit auth decision: pass an AuthService '
      + 'for a production-shaped server, or `auth: null` with '
      + 'AUTH_MODE.DISABLED_FIXTURE for a synthetic fixture. Omitting it is not '
      + 'permitted (R6 §5).',
    );
  }
  /** @type {object|null} */
  let auth = authOption;
  if (auth !== null && typeof auth.authorize !== 'function') {
    throw new TypeError('createRemoteHttpServer auth must be an AuthService or null');
  }
  // The gate is constructed eagerly so a misconfiguration fails at construction
  // rather than at the first request.
  const authGate = new AuthGate({ authService: auth });

  /**
   * The caller's health facts, if any.
   *
   * Persistence is layered *on top* of these rather than replacing them, so a
   * caller that supplies its own DSH facts still gets durability reported (§14).
   * The R4 behaviour of a plain custom `healthFacts` therefore only gains a field.
   */
  const customHealthFacts = options.healthFacts;

  /**
   * The composed health facts.
   *
   * Deferred: `persistence` is initialized below, so this must not be evaluated
   * during construction.
   *
   * @returns {object} the health facts.
   */
  const computeHealthFacts = () => {
    const base = customHealthFacts !== undefined
      ? customHealthFacts()
      : statusService.healthFacts({ dshVersion: config.dshVersion ?? null });
    const withAuth = auth === null ? base : { ...base, auth: auth.health() };
    if (persistence === null) return withAuth;
    // §14: persistence health is reported alongside the downstream status, and no
    // real path is ever included.
    return { ...withAuth, persistence: persistence.health() };
  };
  const healthFacts = computeHealthFacts;

  const router = buildRouter({
    sessionsService: options.sessionsService,
    messagesService: options.messagesService,
    eventsService,
    statusService,
    uploadService,
    config,
    healthFacts,
    // §15: the mutating routes ask this before accepting a command, so a
    // durability failure fails closed instead of being acknowledged.
    persistenceHealth: () => (persistence === null ? null : persistence.health()),
    // R6: the ticket route and the health split both need the service.
    get authService() {
      return auth;
    },
    versionInfo: () => ({ version: config.dshVersion ?? null }),
  });

  /**
   * R5 durable state. The decision is **required to be explicit**.
   *
   * `null` keeps R4 behaviour exactly: no journal, in-memory replay only. An object
   * is used as-is as the service. `persistenceConfig` requests durability at the
   * given root (or the environment default when it is an empty object).
   *
   * Omitting all three is now a programming error rather than an implicit
   * production default. That default was the direct cause of the R5 incident, where
   * a test that simply did not mention persistence silently inherited
   * `%DSH_HOME%\remote` and wrote the real state root. Requiring an explicit choice
   * makes the decision visible at every call site, and a test fixture that passes
   * `persistence: null` cannot be surprised by an inherited environment (R5A §8-§9).
   *
   * A production launcher expresses "use the default root" as
   * `persistenceConfig: {}`.
   */
  const persistenceOption = options.persistence;
  const configOption = options.persistenceConfig;
  /** @type {object|null} */
  let persistence = null;

  if (persistenceOption === null) {
    persistence = null;
  } else if (persistenceOption !== undefined) {
    persistence = persistenceOption;
  } else if (configOption !== undefined) {
    persistence = new PersistenceService({
      config: configOption,
      store: options.sessionsService.store,
      // Handed over at construction so `initialize()` can preload the ring cache
      // as part of recovery rather than relying on a later attach.
      events: eventsService,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.timers === undefined ? {} : { timers: options.timers }),
      ...(options.probe === undefined ? {} : { probe: options.probe }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  } else {
    throw new TypeError(
      'createRemoteHttpServer requires an explicit durability decision: pass '
      + '`persistence: null` to run without a journal, or `persistenceConfig` to '
      + 'request one. An implicit default caused the R5 real-state-root incident.',
    );
  }

  // §10: the write-ahead sink. Registered now, before anything can emit, so no
  // event can ever be published without first reaching the journal. With
  // persistence disabled the sink is explicitly cleared, which restores R4's
  // in-memory-only behaviour rather than leaving a sink that would throw.
  //
  // The dispatch is dynamic (`persistence.append(event)` through the instance)
  // rather than a captured bound method, so a test or an operator can substitute
  // the append to model a disk failure without the sink silently bypassing it.
  if (persistence === null) {
    eventsService.setSink(null);
  } else {
    eventsService.setSink((event) => {
      persistence.append(event);
    });
  }

  /** @type {import('node:http').Server|null} */
  let httpServer = null;
  let actualPort = null;
  let stopped = false;
  /** @type {object|null} */
  let wsHandle = null;
  /** @type {object|null} */
  let recoveryReport = null;

  /**
   * Handle one connection.
   *
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @returns {Promise<void>} resolves once the response is written.
   */
  async function onRequest(req, res) {
    const requestId = newRequestId();
    // Retained for diagnostics only; never trusted as the request identity (§11).
    const clientRequestId = readClientRequestId(req.headers['x-request-id']);

    try {
      // The Host fence runs before routing, so an unknown path on a bad Host is
      // still a 403 rather than leaking which paths exist.
      const hostCheck = checkHostHeader(req.headers.host, config, actualPort);
      if (!hostCheck.allowed) {
        const error = apiError(HTTP_STATUS.FORBIDDEN, API_ERROR.FORBIDDEN_HOST, 'Request Host is not accepted.');
        writeJson(res, error.status, {
          ...error.toEnvelope(requestId),
          ...(clientRequestId === null ? {} : { client_request_id: clientRequestId }),
        });
        return;
      }

      // Production DSH browser authentication is an explicit loopback-only handoff.
      // It runs after the ordinary Host fence and before the mobile Bearer gate; the
      // handoff service independently validates the peer, method, origin and ticket.
      if (browserLoginService?.handleRequest?.(req, res) === true) return;

      // §41: the upgrade route is deliberately absent from the REST router, so a
      // plain HTTP request to it must be answered explicitly. A 426 is the honest
      // answer: the path exists, but only as a WebSocket upgrade.
      if (req.url !== undefined && new URL(req.url, 'http://localhost').pathname === EVENTS_PATH) {
        const error = apiError(
          HTTP_STATUS.UPGRADE_REQUIRED,
          'UPGRADE_REQUIRED',
          'This endpoint requires a WebSocket upgrade with the dsh-remote-v1 subprotocol.',
        );
        writeJson(res, error.status, error.toEnvelope(requestId));
        return;
      }

      await handleRequest({
        router,
        req,
        res,
        requestId,
        // R6 §13: the gate runs inside `handleRequest`, before route resolution, so
        // a protected route never looks up a session for an unauthenticated caller.
        authGate,
        authService: auth,
      });
    } catch (error) {
      // Nothing may escape: an unhandled failure still produces the standard
      // error envelope, and never a stack or a raw message (§10).
      const apiErr = toApiError(error);
      if (!res.headersSent) {
        writeJson(res, apiErr.status, apiErr.toEnvelope(requestId), { headers: apiErr.headers });
      } else {
        res.end();
      }
    }
  }

  return {
    /**
     * Begin listening and start the status wiring.
     *
     * @returns {Promise<{host: string, port: number}>} the bound address.
     */
    async start() {
      if (httpServer !== null) return { host: config.host, port: actualPort };

      // §17/§40: recovery completes BEFORE any listener binds. If it throws, the
      // port stays closed, so a client can never observe a sequence that starts at
      // 1 and then jumps to a recovered value.
      if (persistence !== null) {
        recoveryReport = persistence.initialize();
        persistence.attachEvents(eventsService);
        persistence.start();
      }

      // R6 §53/§54: auth is validated after persistence recovery and before the
      // listener binds, so an invalid auth configuration can never expose a
      // protected route. Failing here leaves the port closed.
      if (auth !== null) {
        validateAuthConfig(auth.config, auth);
        auth.setOriginPort(() => actualPort);
      }

      await statusService.start();

      httpServer = createServer((req, res) => {
        onRequest(req, res).catch(() => {
          try {
            res.destroy();
          } catch {
            // The socket is already gone; nothing left to do.
          }
        });
      });

      // Bound the header phase so a slow client cannot hold a connection open.
      httpServer.headersTimeout = 20_000;
      httpServer.requestTimeout = 60_000;
      httpServer.keepAliveTimeout = 5_000;

      await new Promise((resolve, reject) => {
        const onError = (error) => {
          httpServer?.removeListener('error', onError);
          reject(error);
        };
        httpServer.once('error', onError);
        httpServer.listen(config.port, config.host, () => {
          httpServer?.removeListener('error', onError);
          resolve();
        });
      });

      const address = httpServer.address();
      actualPort = typeof address === 'object' && address !== null ? address.port : config.port;

      // R6 §27: the shared Origin policy must compare against the *bound* port, not
      // the configured 0. Wired here because this is the first moment the real port
      // exists; before it, the loopback-same-port allowance is off, which is safe.
      auth?.setOriginPort?.(() => actualPort);

      // Attach the WebSocket stream to this same server and port (§5). There is
      // no second listener and no second loopback restriction.
      // §39: the WebSocket layer is given the durable replay source, so a
      // reconnect can replay beyond the ring. It is `null` when persistence is
      // disabled, which preserves R4 behaviour exactly.
      if (options.websocket !== false) {
        wsHandle = attachWebSocketServer({
          httpServer,
          events: eventsService,
          config,
          clock: options.clock,
          currentPort: () => actualPort,
          limits: options.websocketLimits,
          timers: options.timers,
          authorizeUpgrade: options.authorizeUpgrade,
          WebSocketServerImpl: options.WebSocketServerImpl,
          // R6 §56: the auth service owns ticket validation and the connection
          // limit. It is bound to the real port here, so the shared Origin policy
          // knows which loopback port counts as same-origin.
          ...(auth === null ? {} : { authService: auth }),
          ...(persistence === null ? {} : { replayStore: persistence }),
        });
      }

      return { host: config.host, port: actualPort };
    },

    /**
     * Stop accepting, tear down the domain subscriptions, and close the adapter.
     *
     * @returns {Promise<void>} resolves once everything is released.
     */
    async stop() {
      if (stopped) return;
      stopped = true;

      // §41 order. The WebSocket layer goes first so no new upgrade is accepted
      // and no event enters a registry that is being torn down.
      if (wsHandle !== null) {
        const handle = wsHandle;
        wsHandle = null;
        await handle.stop();
      }

      // §41 step 2: stop the HTTP listener so no new mutating request can start.
      if (httpServer !== null) {
        const server = httpServer;
        httpServer = null;
        await new Promise((resolve) => {
          server.close(() => resolve());
          // Idle sockets would otherwise keep the listener bound until they time out, and
          // a bound listener is what makes the supervisor refuse to publish STOPPED.
          server.closeIdleConnections?.();
          // An in-flight request on a keep-alive socket would do the same. This is a
          // shutdown, so the connection is being torn down regardless of its request.
          server.closeAllConnections?.();
        });
      }

      // §41 step 3: stop the DSH producers.
      await statusService.stop();

      // §41 steps 4-9: flush the journal, write a final snapshot, close every
      // handle and release the lock. Ordering matters — no producer may run after
      // persistence closes, which is why this sits after the status service.
      let persistenceReport = null;
      if (persistence !== null) {
        persistenceReport = persistence.shutdown();
      }

      // §41 step 9: close the outbound DSH socket. Never a process kill.
      if (typeof adapter.close === 'function') {
        try {
          await adapter.close();
        } catch {
          // A transport already gone is not a shutdown failure.
        }
      }

      return persistenceReport === null ? undefined : { persistence: persistenceReport };
    },

    /**
     * The bound address, or `null` before `start()`.
     *
     * @returns {{host: string, port: number}|null} the address.
     */
    address() {
      if (httpServer === null || actualPort === null) return null;
      return { host: config.host, port: actualPort };
    },

    /** The resolved configuration, for diagnostics and tests. */
    get config() {
      return config;
    },

    /** The router, so a test can assert the route table. */
    get router() {
      return router;
    },

    /** The status service, so the REST layer and tests share one instance. */
    get status() {
      return statusService;
    },

    /** The upload service. */
    get uploads() {
      return uploadService;
    },

    /** The WebSocket stream handle, once started. */
    get ws() {
      return wsHandle;
    },

    /** R5 durable state, or `null` when persistence is disabled. */
    get persistence() {
      return persistence;
    },

    /**
     * The R6 auth service, or `null` when this server is a synthetic fixture.
     *
     * Exposed so a test or an operator can see which mode a server is in without
     * inferring it from behaviour.
     */
    get auth() {
      return auth;
    },

    /** The startup recovery report, once `start()` has completed. */
    get recovery() {
      return recoveryReport;
    },

    /**
     * Reconcile durable DSH history missed while the Gateway was down (§33-§36).
     *
     * @param {object} [reconcileOptions] - forwarded to the reconciler.
     * @returns {Promise<object|null>} the report, or `null` without persistence.
     */
    async reconcile(reconcileOptions = {}) {
      if (persistence === null) return null;
      const reconciler = new Reconciler({
        adapter,
        persistence,
        store: options.sessionsService.store,
        events: eventsService,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      });
      return reconciler.reconcile(reconcileOptions);
    },
  };
}
