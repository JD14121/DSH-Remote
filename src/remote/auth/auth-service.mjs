/**
 * AuthService — Phase R6 §1, §2, §3, §10, §17-§22, §38, §46, §53, §56.
 *
 * The single entry point the REST layer, the CORS layer and the WebSocket upgrade
 * all consult. Everything security-relevant is behind one object so there is one
 * place to audit, and one place where the rules can disagree with themselves.
 *
 * Its two jobs:
 *
 *   - **authorize a request**, returning a principal or a generic 401;
 *   - **mint and atomically consume** a one-time WebSocket ticket.
 *
 * It never generates or stores a production credential (§3). The token arrives
 * through the constructor, which is R7's bootstrap seam.
 */

import { AUTH_ERROR, authError } from './errors.mjs';
import { AUTH_MODE } from './config.mjs';
import { BearerVerifier, parseAuthorizationHeader } from './bearer.mjs';
import { CorsPolicy } from './cors.mjs';
import { ConnectionLimiter } from './connection-limit.mjs';
import { OriginPolicy } from './origin-policy.mjs';
import { RateLimiter, remoteIdentity } from './rate-limit.mjs';
import { UploadQuota } from './upload-quota.mjs';
import { TicketStore } from './ws-ticket.mjs';

/** The public principal id for R6 v1 (§10). */
export const DEFAULT_PRINCIPAL_ID = 'phone';

/** The auth scheme advertised in health (§46). */
export const AUTH_SCHEME = 'bearer+ws-ticket';

/**
 * The authentication service.
 */
export class AuthService {
  /**
   * @param {object} options - service options.
   * @param {object} options.config - a resolved auth config.
   * @param {string|Buffer} [options.token] - the credential, for `required` mode.
   * @param {() => number} [options.clock] - injectable clock (ms).
   */
  constructor(options) {
    const config = options?.config;
    if (config === undefined) throw new TypeError('AuthService requires a resolved config');

    this.config = config;
    this.mode = config.mode;
    this.clock = options.clock ?? Date.now;
    this.principalId = config.principalId ?? DEFAULT_PRINCIPAL_ID;

    // The token may arrive on the config or directly; both are explicit. §48 keeps
    // the environment out of this path entirely.
    const token = options.token ?? config.token ?? null;
    /** @type {BearerVerifier|null} */
    this.verifier = null;
    if (config.mode === AUTH_MODE.REQUIRED) {
      if (token === null || token === undefined) {
        throw authError(AUTH_ERROR.CONFIG_INVALID, {
          message: 'Auth mode "required" needs a credential.',
        });
      }
      this.verifier = new BearerVerifier({ token, principalId: this.principalId });
    }

    this.originPolicy = new OriginPolicy({
      // A function, because the real port is only known after the listener binds.
      // The gate must compare against the bound port, not the configured 0.
      port: options.port ?? null,
      allowedOrigins: config.allowedOrigins ?? [],
    });
    this.cors = new CorsPolicy({ originPolicy: this.originPolicy });
    this.tickets = new TicketStore({
      clock: this.clock,
      ttlSeconds: config.ticketTtlSeconds,
      maxOutstanding: config.maxOutstandingTickets,
    });
    this.limiter = new RateLimiter({ clock: this.clock, limits: config.limits });
    this.connections = new ConnectionLimiter({ maxPerPrincipal: config.maxConnectionsPerPrincipal });
    this.uploads = new UploadQuota({ clock: this.clock, ...(config.upload ?? {}) });
    /** Bumped for diagnostics only; never exposed with a value attached. */
    this.counters = { authorized: 0, rejected: 0, ticketsMinted: 0 };
  }

  /**
   * The port this service's origin policy treats as same-origin.
   *
   * Writable because the server only knows its real port after binding, and the
   * policy must compare against the bound port rather than the configured `0`.
   * Writing `null`/`0` disables the loopback-same-port allowance, which is the safe
   * state before a listener exists.
   *
   * @param {number|(() => number|null)|null} value - the port, a getter, or `null`.
   */
  setOriginPort(value) {
    this.originPolicy.portSource = value;
    // The CORS policy shares this object, so it follows automatically.
    return this;
  }

  /**
   * Whether this service is actually enforcing authentication.
   *
   * @returns {boolean} true in `required` mode.
   */
  get enforcing() {
    return this.mode === AUTH_MODE.REQUIRED;
  }

  /**
   * Authorize a request from its Authorization header.
   *
   * In `disabled-fixture` mode this always succeeds with the fixture principal, and
   * is deliberately loud about it in `stats()` so a fixture can never be mistaken
   * for a production server.
   *
   * @param {unknown} header - `req.headers.authorization`.
   * @returns {{ok: true, principalId: string} | {ok: false, code: string, internalReason: string}} the result.
   */
  authorize(header) {
    if (!this.enforcing) {
      return { ok: true, principalId: this.principalId };
    }

    const parsed = parseAuthorizationHeader(header);
    if (!parsed.ok) {
      this.counters.rejected += 1;
      // §37: every reason collapses to one generic code. The internal reason is
      // available to the server for its own counters and is never serialised.
      return { ok: false, code: parsed.code, internalReason: parsed.internalReason };
    }

    const verified = this.verifier.verify(parsed.token);
    if (!verified.ok) {
      this.counters.rejected += 1;
      return { ok: false, code: AUTH_ERROR.INVALID, internalReason: 'credential mismatch' };
    }

    this.counters.authorized += 1;
    return { ok: true, principalId: verified.principalId };
  }

  /**
   * Assert authorization, throwing the generic error on refusal.
   *
   * @param {unknown} header - `req.headers.authorization`.
   * @returns {string} the principal id.
   * @throws {AuthError} `AUTH_REQUIRED` or `AUTH_INVALID`.
   */
  assertAuthorized(header) {
    const result = this.authorize(header);
    if (!result.ok) {
      throw authError(result.code, { internalReason: result.internalReason });
    }
    return result.principalId;
  }

  /**
   * Charge a rate-limit bucket for an authenticated principal.
   *
   * @param {string} bucket - the bucket name.
   * @param {string} principalId - the principal.
   * @returns {void}
   * @throws {AuthError} `RATE_LIMITED`.
   */
  chargeAuthenticated(bucket, principalId) {
    this.limiter.assert(bucket, principalId);
  }

  /**
   * Count a failed authentication against the per-identity and global budgets.
   *
   * §34: the identity here is the remote socket, **not** the credential and not the
   * IP alone — behind a tunnel every peer can look like `127.0.0.1`.
   *
   * @param {import('node:net').Socket|undefined} socket - the peer socket.
   * @returns {void}
   * @throws {AuthError} `RATE_LIMITED`.
   */
  chargeFailedAuth(socket) {
    const identity = remoteIdentity(socket);
    this.limiter.assert('failedAuth', identity);
    // The global bucket is the backstop a caller cannot escape by reconnecting from
    // a new source port.
    this.limiter.assert('failedAuthGlobal', 'global');
  }

  /**
   * Whether a failed-auth attempt is already over budget, without charging.
   *
   * Used so a refused request reports 429 rather than a misleading 401.
   *
   * @param {import('node:net').Socket|undefined} socket - the peer socket.
   * @returns {boolean} true when over budget.
   */
  failedAuthExhausted(socket) {
    const identity = remoteIdentity(socket);
    const perIdentity = this.limiter.charge('failedAuth', identity, 0);
    const global = this.limiter.charge('failedAuthGlobal', 'global', 0);
    return !perIdentity.allowed || !global.allowed;
  }

  /**
   * Mint a one-time WebSocket ticket.
   *
   * @param {object} input - the mint request.
   * @param {string} input.principalId - the authenticated principal.
   * @param {string} input.sessionId - the session to bind.
   * @param {string|null} [input.origin] - the normalised issuing origin.
   * @returns {object} the ticket response payload.
   * @throws {AuthError} `AUTH_TICKET_LIMIT` or `RATE_LIMITED`.
   */
  mintTicket(input) {
    this.limiter.assert('ticket', input.principalId);
    const issued = this.tickets.mint({
      sessionId: input.sessionId,
      principalId: input.principalId,
      origin: input.origin ?? null,
    });
    this.counters.ticketsMinted += 1;
    return issued;
  }

  /**
   * Validate a ticket for a specific session and origin, **without consuming it**.
   *
   * @param {object} input - the validation facts.
   * @param {unknown} input.ticket - the plaintext ticket.
   * @param {string} input.sessionId - the requested session.
   * @param {string|null} input.origin - the normalised upgrade Origin.
   * @returns {{ok: true, record: object} | {ok: false, code: string, internalReason: string}} the result.
   */
  inspectTicket(input) {
    const result = this.tickets.inspect(typeof input.ticket === 'string' ? input.ticket : '');
    if (!result.ok) return result;
    return this.#checkBindings(result.record, input.sessionId, input.origin);
  }

  /**
   * Atomically consume a ticket for a specific session and origin.
   *
   * §56's order is implemented by the caller: validate, reserve a connection slot,
   * then consume. This method is the atomic half and contains no `await`, so two
   * concurrent upgrades cannot both succeed (§57).
   *
   * @param {object} input - see `inspectTicket`.
   * @returns {{ok: true, record: object} | {ok: false, code: string, internalReason: string}} the result.
   */
  consumeTicket(input) {
    const result = this.tickets.consume(typeof input.ticket === 'string' ? input.ticket : '');
    if (!result.ok) return result;
    // Bindings are re-checked here as well, so a mismatch cannot be consumed by a
    // caller that skipped the non-binding pre-check.
    const bound = this.#checkBindings(result.record, input.sessionId, input.origin);
    if (!bound.ok) return bound;
    return result;
  }

  /**
   * Check a ticket record's session and origin bindings.
   *
   * Both mismatches report the same generic code, so the response cannot be used to
   * discover which binding failed (§51).
   *
   * @param {object} record - the ticket record.
   * @param {string} sessionId - the requested session.
   * @param {string|null} origin - the normalised upgrade Origin.
   * @returns {{ok: true, record: object} | {ok: false, code: string, internalReason: string}} the result.
   */
  #checkBindings(record, sessionId, origin) {
    if (record.sessionId !== sessionId) {
      return { ok: false, code: AUTH_ERROR.WS_TICKET_INVALID, internalReason: 'session mismatch' };
    }
    const requested = origin ?? null;
    if (record.originBinding !== requested) {
      return { ok: false, code: AUTH_ERROR.WS_TICKET_INVALID, internalReason: 'origin mismatch' };
    }
    return { ok: true, record };
  }

  /**
   * The health contribution for the auth axis (§46).
   *
   * Never includes the credential, its digest, its length, its prefix, the
   * environment variable name, or a source path (§47).
   *
   * @returns {object} the auth health block.
   */
  health() {
    return {
      status: 'ready',
      mode: this.enforcing ? AUTH_SCHEME : 'disabled-fixture',
      ticket_ttl_seconds: this.config.ticketTtlSeconds,
      ...(this.enforcing ? {} : { warning: 'authentication is disabled; fixture use only' }),
    };
  }

  /**
   * Whether the minimal (unauthenticated) health response may be served.
   *
   * @returns {boolean} true when auth is enforced, so a caller must authenticate for detail.
   */
  get requiresAuthForDetail() {
    return this.enforcing;
  }

  /**
   * Diagnostics for tests. Counters and caps only — never a credential or a ticket.
   *
   * @returns {object} the summary.
   */
  stats() {
    return {
      mode: this.mode,
      enforcing: this.enforcing,
      counters: { ...this.counters },
      origin: this.originPolicy.describe(),
      tickets: this.tickets.stats(),
      limits: this.limiter.stats(),
      connections: this.connections.stats(),
      uploads: this.uploads.stats(),
    };
  }

  /**
   * Release all ephemeral state.
   *
   * Called on shutdown. Tickets and rate-limit windows are process-local by design
   * (§63, §64), so dropping them here merely makes that explicit.
   *
   * @returns {object} what was dropped.
   */
  shutdown() {
    return {
      ticketsCleared: this.tickets.clear(),
      connectionsCleared: this.connections.clear(),
      windowsCleared: this.limiter.cleanup(),
    };
  }
}
