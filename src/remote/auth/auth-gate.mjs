/**
 * The REST auth gate — Phase R6 §11, §12, §13, §29, §30, §31, §32, §35, §55.
 *
 * One place decides the order, because §13 and §55 make the order itself a security
 * property:
 *
 * ```text
 * Host (already done by the caller)
 *   ↓
 * Origin / CORS
 *   ↓
 * Bearer
 *   ↓
 * rate limit
 *   ↓
 * route-specific validation and domain lookup
 * ```
 *
 * §13 is the reason auth must precede the route: if a protected route resolved the
 * session first, an unauthenticated caller could distinguish "no such session" from
 * "forbidden", which is a session-existence oracle. Here an anonymous caller gets
 * 401 for a real session and an unknown one alike.
 *
 * OPTIONS is handled before auth on purpose. §32 is explicit that a preflight is
 * **not** authentication: a browser must be able to ask whether it may send
 * `Authorization` before it has been granted anything.
 */

import { AUTH_ERROR, authError, statusForCode } from './errors.mjs';
import { redactRequestUrl } from './redact-auth.mjs';
import { AUTH_MODE } from './config.mjs';

/** §60: headers every REST response carries. */
export const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
});

/** The one route that is reachable without a credential (§11). */
export const PUBLIC_HEALTH_PATH = '/api/v1/health';

/** The ticket mint endpoint (§14). */
export const WS_TICKET_PATH = '/api/v1/auth/ws-ticket';

/**
 * Classify a request for the gate.
 *
 * @param {string} method - the HTTP method.
 * @param {string} pathname - the request path.
 * @returns {{public: boolean, preflight: boolean, mutation: boolean, kind: string}} the classification.
 */
export function classifyRequest(method, pathname) {
  const upper = (method ?? 'GET').toUpperCase();
  const isHealth = pathname === PUBLIC_HEALTH_PATH;
  return {
    // §11: minimal health is public. Everything else needs a credential, including
    // the ticket endpoint itself.
    public: isHealth,
    preflight: upper === 'OPTIONS',
    // §35 separates read and mutation budgets.
    mutation: upper === 'POST' || upper === 'PUT' || upper === 'PATCH' || upper === 'DELETE',
    kind: isHealth ? 'health' : (pathname === WS_TICKET_PATH ? 'ticket' : 'protected'),
  };
}

/**
 * The auth gate.
 */
export class AuthGate {
  /**
   * @param {object} options - gate options.
   * @param {object|null} options.authService - the `AuthService`, or `null` when auth is not enforced.
   */
  constructor(options) {
    this.auth = options.authService ?? null;
  }

  /**
   * Whether this gate is actually enforcing anything.
   *
   * @returns {boolean} true when a credential is required.
   */
  get enforcing() {
    return this.auth !== null && this.auth.enforcing;
  }

  /**
   * Run the gate for one request.
   *
   * Returns a decision rather than writing the response, so the caller keeps a
   * single place where a response is emitted — and so this is unit-testable without
   * a socket.
   *
   * @param {object} input - the request facts.
   * @param {import('node:http').IncomingMessage} input.req - the request.
   * @param {string} input.pathname - the request path.
   * @returns {{action: 'continue', headers: object, principalId: string|null} | {action: 'respond', status: number, body: object, headers: object}}
   *   the decision.
   */
  run(input) {
    const { req, pathname } = input;
    const method = req.method ?? 'GET';
    const classification = classifyRequest(method, pathname);

    // Base headers: security headers plus exact CORS for an allowed Origin. Sent on
    // refusals too, so a browser can read the error rather than only seeing a
    // generic network failure.
    const headers = { ...SECURITY_HEADERS };
    let corsHeaders = {};
    if (this.auth !== null) {
      corsHeaders = this.auth.cors.headersFor(req.headers.origin);
      Object.assign(headers, corsHeaders);
    }

    const respond = (error) => ({
      action: 'respond',
      status: error.status ?? statusForCode(error.code),
      body: {
        error: {
          code: error.code,
          message: error.message,
          // §36: a rate-limit response says when to retry, and never echoes the
          // credential or a fingerprint of it.
          ...(error.retryAfter === undefined ? {} : { retry_after: error.retryAfter }),
        },
      },
      headers: { ...headers, ...(error.headers ?? {}), ...corsHeaders },
    });

    // §32: a preflight is answered before authentication, because the browser needs
    // the answer in order to send the credential at all.
    //
    // When CORS is not enabled — an R3-shaped or fixture server — OPTIONS is left to
    // the router, which has no OPTIONS route and therefore answers 405. Refusing it
    // here instead would advertise that a CORS policy exists when none does.
    if (classification.preflight && this.auth !== null) {
      const preflight = this.auth.cors.validatePreflight({
        origin: req.headers.origin,
        requestMethod: req.headers['access-control-request-method'],
        requestHeaders: req.headers['access-control-request-headers'],
      });
      if (!preflight.ok) {
        // The Origin policy is checked first so a hostile origin is a 403 even for
        // a preflight, rather than a generic rejection.
        const originDecision = this.auth.originPolicy.check(req.headers.origin);
        if (!originDecision.allowed) {
          return respond(authError(AUTH_ERROR.ORIGIN_NOT_ALLOWED, { internalReason: originDecision.reason ?? '' }));
        }
        return respond(authError(AUTH_ERROR.CORS_PREFLIGHT_REJECTED, {
          internalReason: preflight.internalReason,
        }));
      }
      return { action: 'respond', status: 204, body: null, headers: { ...headers, ...preflight.headers } };
    }

    try {
      // §29: a present Origin must be allowed, even when the Bearer is correct. A
      // hostile page holding a stolen token is still refused.
      if (this.auth !== null) {
        const originDecision = this.auth.originPolicy.check(req.headers.origin);
        if (!originDecision.allowed) {
          throw authError(AUTH_ERROR.ORIGIN_NOT_ALLOWED, { internalReason: originDecision.reason ?? '' });
        }
      }

      // §11: minimal health is public, but it is also *more* when a valid credential
      // is supplied. So a public route still examines a presented Bearer — it simply
      // does not require one. Returning early here would make the authenticated
      // health response unreachable.
      if (classification.public) {
        if (!this.enforcing) {
          return { action: 'continue', headers, principalId: this.auth?.principalId ?? null, authenticated: false };
        }
        if (req.headers.authorization === undefined) {
          return { action: 'continue', headers, principalId: null, authenticated: false };
        }
        const verified = this.auth.authorize(req.headers.authorization);
        // A wrong credential on a public route is not an error — it just yields the
        // minimal view, so a probe cannot use health to test a token.
        return {
          action: 'continue',
          headers,
          principalId: verified.ok ? verified.principalId : null,
          authenticated: verified.ok,
        };
      }

      if (!this.enforcing) {
        // Fixture mode: no credential is required, and the gate says so explicitly
        // rather than pretending a check happened.
        return { action: 'continue', headers, principalId: this.auth?.principalId ?? null, authenticated: false };
      }

      // §37: a failure charges the failed-auth budget before the caller learns
      // anything, and an exhausted budget reports 429 rather than another 401.
      if (this.auth.failedAuthExhausted(input.socket)) {
        throw authError(AUTH_ERROR.RATE_LIMITED, { retryAfter: 1 });
      }

      let principalId;
      try {
        principalId = this.auth.assertAuthorized(req.headers.authorization);
      } catch (error) {
        this.auth.chargeFailedAuth(input.socket);
        throw error;
      }

      // §35: read and mutation budgets are separate, so a burst of reads cannot
      // exhaust the mutation allowance.
      this.auth.chargeAuthenticated(classification.mutation ? 'mutation' : 'read', principalId);

      return { action: 'continue', headers, principalId, authenticated: true };
    } catch (error) {
      void redactRequestUrl(req.url);
      if (error?.name === 'AuthError') return respond(error);
      // Anything unexpected becomes a generic refusal rather than leaking detail.
      return respond(authError(AUTH_ERROR.INVALID, { internalReason: 'unexpected gate failure' }));
    }
  }
}

export { AUTH_ERROR, AUTH_MODE };
