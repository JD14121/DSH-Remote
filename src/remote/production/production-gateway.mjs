/**
 * The production Gateway — Phase R7 §2, §18, §28, §31.
 *
 * This is the Gate B seam: it takes the verified cookie, builds the real DSH adapter,
 * opens the R5 persistence root, and starts the R3/R6 HTTP + WebSocket Gateway on
 * loopback. The supervisor knows none of these details.
 *
 * Two things are deliberately explicit here:
 *
 * * **`persistenceConfig: {}`** (§28) — the production root is the R5 default under
 *   `DSH_HOME`. Threading a path through from here would let a launcher argument
 *   relocate production state, which is exactly what §28 forbids.
 * * **`auth`** is a real `AuthService` built from the protected file (§5) — no
 *   implicit default, matching the decision R6 made explicit.
 */

import { createRemoteHttpServer } from '../server.mjs';
import { AuthService } from '../auth/auth-service.mjs';
import { AUTH_MODE, resolveAuthConfig } from '../auth/config.mjs';
import { EventsService } from '../events.mjs';
import { MessagesService } from '../messages.mjs';
import { SessionsService } from '../sessions.mjs';
import { StatusService } from '../status-service.mjs';
import { resolveHttpConfig } from '../http/config.mjs';
import { createDshAdapter } from '../dsh-adapter.mjs';
import { waitForPortFree } from './dsh-process.mjs';
import { DshBrowserLoginService } from './dsh-browser-login.mjs';

/**
 * Build the real adapter bound to the bootstrapped cookie (§18).
 *
 * The auth provider retains the cookie for DSH RPC and the explicit loopback-only
 * browser handoff. It is never returned to a mobile REST route, the Phone `AuthService`,
 * an event, the journal or a WebSocket.
 *
 * @param {object} options - adapter options.
 * @param {object} options.config - the resolved production config.
 * @param {object} options.authProvider - the `CookieAuthProvider`.
 * @param {object} [options.rpcClient] - an injected wire client, for tests.
 * @param {object} [options.versionGuard] - an injected guard, for tests.
 * @returns {object} the adapter.
 */
export function createProductionAdapter(options) {
  const { config, authProvider } = options;

  // The wire construction lives in `dsh-adapter.mjs`, which is the only module allowed
  // to import `wire/` (R2 §2). The cookie is consumed there for DSH RPC.
  return createDshAdapter({
    authority: `${config.dshHost}:${config.dshPort}`,
    authProvider,
    expectedVersion: config.dshVersion,
    ...(options.rpcClient === undefined ? {} : { rpcClient: options.rpcClient }),
    ...(options.versionGuard === undefined ? {} : { versionGuard: options.versionGuard }),
  });
}

/** Build the required-auth production policy with the exact configured mobile UI origins. */
export function productionGatewayAuthConfig(mobileAllowedOrigins = []) {
  if (!Array.isArray(mobileAllowedOrigins) || mobileAllowedOrigins.some((origin) => origin !== 'https://relay.drm-jd.com')) {
    throw new TypeError('production mobile Origin allowlist may contain only https://relay.drm-jd.com');
  }
  return resolveAuthConfig({ mode: AUTH_MODE.REQUIRED, allowedOrigins: mobileAllowedOrigins }, {});
}

/**
 * Start the production Gateway.
 *
 * @param {object} options - gateway options.
 * @param {object} options.config - the resolved production config.
 * @param {object} options.credential - the loaded `CredentialStore`.
 * @param {object} options.authProvider - the `CookieAuthProvider`.
 * @param {object} [options.adapter] - a pre-built adapter.
 * @param {object} [options.logs] - the production logs, for the gateway event sink.
 * @param {(event: string, fields: object) => void} [options.onEvent] - the log sink.
 * @param {object} [options.server] - an injected server, for tests.
 * @returns {Promise<object>} the started gateway.
 */
export async function startProductionGateway(options) {
  const { config, credential, authProvider } = options;
  const adapter = options.adapter ?? options.createAdapter?.({ config, authProvider })
    ?? createProductionAdapter({ config, authProvider });

  // §5/§28: the credential comes from its protected file, and the auth decision is
  // explicit. There is no implicit mode.
  const authConfig = productionGatewayAuthConfig(config.mobileAllowedOrigins ?? options.mobileAllowedOrigins ?? []);
  const auth = new AuthService({
    config: authConfig,
    token: credential.requireToken(),
    // The shared Origin policy must compare against the **bound** port, which the
    // server wires once the listener is up.
    port: null,
  });

  const httpConfig = resolveHttpConfig({
    host: config.gatewayHost,
    port: config.gatewayPort,
    dshVersion: config.dshVersion,
  }, {});

  const browserLogin = new DshBrowserLoginService({ config, authProvider, clock: options.clock });

  const eventsService = new EventsService({
    adapter,
    store: options.store ?? new (await import('../state/session-view-store.mjs')).SessionViewStore({}),
    clock: options.clock,
  });
  const sessionsService = new SessionsService({ adapter, store: eventsService.store, clock: options.clock });
  const messagesService = new MessagesService({ adapter, store: eventsService.store, clock: options.clock });
  const statusService = new StatusService({ adapter, eventsService, clock: options.clock });

  const server = options.server ?? createRemoteHttpServer({
    sessionsService,
    messagesService,
    eventsService,
    statusService,
    adapter,
    config: httpConfig,
    auth,
    // §28: the R5 production root, **explicitly resolved from this production config**
    // rather than left to the persistence layer's own environment default.
    //
    // This matters more than it looks. An empty `{}` makes `PersistenceService` resolve
    // its root from `DSH_HOME`, which is correct in production but wrong everywhere
    // else: a test that supplied a temp `dshHome` would still write the real
    // `$DSH_HOME\remote`. Passing the already-resolved absolute path keeps the single
    // source of truth in `production-config.mjs` and makes the root impossible to
    // redirect from a second place.
    persistenceConfig: { root: config.paths.root },
    browserLoginService: browserLogin,
  });

  const address = await server.start();

  return {
    server,
    address,
    adapter,
    browserLogin,
    auth,
    services: { eventsService, sessionsService, messagesService, statusService },
    // The R5 recovery report is a server getter, not a return value.
    recovery: server.recovery ?? null,
    /**
     * Stop the Gateway in the §22 order.
     *
     * @returns {Promise<object>} the stop summary.
     */
    /**
     * Stop the Gateway in the §22 order, and do not return until the listener is gone.
     *
     * The server awaits `close()`, but a resolved `close()` is not by itself proof that
     * the port has been released — a lingering socket can keep it bound. The external run
     * observed `STOPPED` with 9445 still listening, so the release is **verified** here
     * rather than assumed, and the measured wait is returned for the acceptance evidence.
     *
     * @returns {Promise<object>} the stop summary.
     */
    async stop() {
      options.onEvent?.('shutdown_complete', { component: 'gateway' });
      const result = await server.stop();
      const boundPort = typeof server.address === 'function' ? server.address()?.port : config.gatewayPort;
      const release = await waitForPortFree(boundPort ?? config.gatewayPort, {
        timeoutMs: options.portReleaseTimeoutMs ?? 15_000,
      });
      return {
        ...(result ?? {}),
        gateway_port_free: release.free,
        gateway_port_release_waited_ms: release.waitedMs,
      };
    },
  };
}
