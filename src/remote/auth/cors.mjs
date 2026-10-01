/**
 * CORS and preflight — Phase R6 §30, §31, §32, §55.
 *
 * R3 sent no CORS headers at all. R6 adds **exact** CORS, because a browser client on
 * an allowed origin needs to know it may send `Authorization`.
 *
 * The rules that matter:
 *
 *   - the allowed origin is echoed **exactly**, never `*`;
 *   - `Vary: Origin` is always sent, so a cache cannot serve one origin's response
 *     to another;
 *   - `Access-Control-Allow-Credentials` is **not** sent, because auth travels in an
 *     `Authorization` header rather than an ambient cookie (§30, §74);
 *   - a preflight is validated strictly. §32 is explicit that OPTIONS is not
 *     authentication — a browser must be able to ask about `Authorization` before it
 *     has been granted anything.
 */

import { AUTH_ERROR, authError } from './errors.mjs';

/** Request headers a preflight may ask for (§31). */
export const ALLOWED_REQUEST_HEADERS = Object.freeze(['authorization', 'content-type', 'x-request-id']);

/** Methods the API exposes. */
export const ALLOWED_METHODS = Object.freeze(['GET', 'POST', 'OPTIONS']);

/** How long a preflight result may be cached, in seconds. */
export const PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * The CORS policy, sharing one `OriginPolicy` with REST, WS and ticket binding (§27).
 */
export class CorsPolicy {
  /**
   * @param {object} options - policy options.
   * @param {import('./origin-policy.mjs').OriginPolicy} options.originPolicy - the shared policy.
   */
  constructor(options) {
    if (options?.originPolicy === undefined) throw new TypeError('CorsPolicy requires an originPolicy');
    this.originPolicy = options.originPolicy;
  }

  /**
   * The CORS response headers for a request.
   *
   * Only sent when the request carries an Origin that the shared policy accepts, so
   * an allowed-origin response can never be replayed to a hostile one.
   *
   * @param {unknown} origin - the request Origin.
   * @returns {object} the headers, possibly empty.
   */
  headersFor(origin) {
    if (origin === undefined || origin === null) return {};
    const decision = this.originPolicy.check(origin);
    if (!decision.allowed || decision.origin === null) return {};
    return {
      'access-control-allow-origin': decision.origin,
      // Always vary, so a shared cache cannot confuse two origins.
      vary: 'Origin',
    };
  }

  /**
   * Validate a preflight request.
   *
   * @param {object} input - the preflight facts.
   * @param {unknown} input.origin - the request Origin.
   * @param {unknown} input.requestMethod - `Access-Control-Request-Method`.
   * @param {unknown} input.requestHeaders - `Access-Control-Request-Headers`.
   * @returns {{ok: true, headers: object} | {ok: false, code: string, internalReason: string}} the decision.
   */
  validatePreflight(input) {
    const fail = (internalReason) => ({
      ok: false,
      code: AUTH_ERROR.CORS_PREFLIGHT_REJECTED,
      internalReason,
    });

    // A preflight without an Origin is not a browser preflight at all.
    if (input.origin === undefined || input.origin === null) return fail('no origin');
    const decision = this.originPolicy.check(input.origin);
    if (!decision.allowed || decision.origin === null) return fail('origin not allowed');

    const method = typeof input.requestMethod === 'string' ? input.requestMethod.toUpperCase() : '';
    if (method.length === 0) return fail('no requested method');
    if (!ALLOWED_METHODS.includes(method)) return fail(`method ${method} not allowed`);
    // OPTIONS itself is not a resource method; asking to preflight it is nonsense.
    if (method === 'OPTIONS') return fail('OPTIONS is not a resource method');

    const requested = typeof input.requestHeaders === 'string' && input.requestHeaders.length > 0
      ? input.requestHeaders.split(',').map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0)
      : [];
    const unlisted = requested.filter((entry) => !ALLOWED_REQUEST_HEADERS.includes(entry));
    if (unlisted.length > 0) return fail(`requested headers not allowed: ${unlisted.join(',')}`);

    return {
      ok: true,
      headers: {
        'access-control-allow-origin': decision.origin,
        'access-control-allow-methods': ALLOWED_METHODS.join(', '),
        // Echo only what was actually asked for, intersected with the allowlist, so
        // the response never advertises more than the policy permits.
        'access-control-allow-headers': (requested.length > 0 ? requested : [...ALLOWED_REQUEST_HEADERS]).join(', '),
        'access-control-max-age': String(PREFLIGHT_MAX_AGE_SECONDS),
        vary: 'Origin',
      },
    };
  }

  /**
   * Assert a preflight, throwing on refusal.
   *
   * @param {object} input - see `validatePreflight`.
   * @returns {object} the response headers.
   * @throws {AuthError} `CORS_PREFLIGHT_REJECTED`.
   */
  assertPreflight(input) {
    const result = this.validatePreflight(input);
    if (!result.ok) {
      throw authError(AUTH_ERROR.CORS_PREFLIGHT_REJECTED, { internalReason: result.internalReason });
    }
    return result.headers;
  }

  /**
   * The origin policy, for callers that need the shared rule directly.
   *
   * @returns {import('./origin-policy.mjs').OriginPolicy} the policy.
   */
  get policy() {
    return this.originPolicy;
  }
}
