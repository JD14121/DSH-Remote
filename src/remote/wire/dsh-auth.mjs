/**
 * Internal authentication: Remote Gateway -> DSH Web — Phase R1 §9.
 *
 * This is NOT the future phone Bearer token. Two authentication layers exist and
 * R1 must keep them visibly distinct:
 *
 *   Phone -> Gateway          future R6 Bearer token        (not implemented in R1)
 *   Gateway -> DSH Web        DSH launch cookie / token     (this module)
 *
 * R1 uses `Deferred Bootstrap` (R1 §3):
 *   R1 contract tests -> fixture/static auth -> DSH Adapter
 * Real boot-token/cookie acquisition is DEFERRED TO R7.
 *
 * Hard security rules enforced by this module (R1 §3, §23):
 *   - it never reads `$DSH_HOME/.credentials.yaml`;
 *   - it never scrapes the desktop console for a launch token;
 *   - it never modifies the DSH launcher;
 *   - it never writes a real token anywhere;
 *   - a real cookie must never be committed into a fixture.
 *
 * The production-grade provider (R7) must satisfy this same interface without
 * changing any caller.
 */

import { AdapterError, ADAPTER_ERROR } from '../adapter-errors.mjs';
import { redactString, REDACTED } from '../redact.mjs';

/**
 * The authority shape DSH expects in the `Host` header and binds the cookie to.
 * The cookie name is `dsh-auth-<base64url(sha256(authority))>`, so the authority
 * is part of the credential, not decoration.
 */
export const DEFAULT_AUTHORITY = '127.0.0.1:3080';

/**
 * Cookie names DSH accepts. Used to reject an obviously wrong value early
 * without ever echoing it.
 */
const COOKIE_NAME_PATTERN = /^dsh-auth-[A-Za-z0-9_-]+=/;

/**
 * @typedef {object} DshAuth
 * @property {string} cookie - the full `name=value` cookie header value.
 * @property {string} authority - `host:port` the cookie is bound to.
 */

/**
 * Abstract internal-auth provider.
 *
 * A provider yields the credential the adapter presents to DSH. Implementations
 * must never log, echo or persist the value.
 */
export class DshAuthProvider {
  /**
   * @returns {Promise<DshAuth>} the current internal credential.
   * @throws {AdapterError} `AUTH_UNAVAILABLE` when no credential can be produced.
   */
  // eslint-disable-next-line class-methods-use-this
  async getAuth() {
    throw new AdapterError(
      ADAPTER_ERROR.AUTH_UNAVAILABLE,
      'DshAuthProvider.getAuth() is abstract; use FixtureAuthProvider or StaticAuthProvider',
    );
  }

  /**
   * Redact a value that may contain this provider's credential.
   *
   * @param {unknown} value - value to sanitise.
   * @returns {string} the value with the credential removed.
   */
  // eslint-disable-next-line class-methods-use-this
  redact(value) {
    return redactString(value, []);
  }
}

/**
 * Fixture auth for contract tests.
 *
 * Accepts only an obviously synthetic cookie. A real DSH cookie has the form
 * `dsh-auth-<hash>=v1.<payload>.<signature>`; this provider refuses anything
 * that looks like one so a live credential can never be pasted into a test.
 */
export class FixtureAuthProvider extends DshAuthProvider {
  /**
   * @param {object} [options] - fixture settings.
   * @param {string} [options.cookie] - synthetic cookie value.
   * @param {string} [options.authority] - authority the fixture models.
   */
  constructor(options = {}) {
    super();
    this.cookie = options.cookie ?? 'dsh-auth-fixture=synthetic-test-cookie';
    this.authority = options.authority ?? DEFAULT_AUTHORITY;
    this.#assertSynthetic(this.cookie);
  }

  /**
   * Reject a cookie that could be a real DSH credential.
   *
   * @param {string} cookie - candidate.
   * @throws {AdapterError} `AUTH_REJECTED` when the value is not synthetic.
   */
  #assertSynthetic(cookie) {
    if (typeof cookie !== 'string' || cookie.length === 0) {
      throw new AdapterError(ADAPTER_ERROR.AUTH_UNAVAILABLE, 'fixture cookie must be a non-empty string');
    }
    if (!COOKIE_NAME_PATTERN.test(cookie)) {
      throw new AdapterError(
        ADAPTER_ERROR.AUTH_REJECTED,
        'fixture cookie must be named dsh-auth-<hash>=...',
      );
    }
    // A real cookie carries a v1 payload with an HMAC signature. Refuse it.
    if (/=v\d+\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(cookie)) {
      throw new AdapterError(
        ADAPTER_ERROR.AUTH_REJECTED,
        'fixture cookie must be synthetic; a real DSH session cookie was supplied',
      );
    }
  }

  /** @returns {Promise<DshAuth>} the synthetic credential. */
  async getAuth() {
    return { cookie: this.cookie, authority: this.authority };
  }

  /** @returns {string} the value with the synthetic cookie removed. */
  redact(value) {
    return redactString(value, [this.cookie]);
  }
}

/**
 * Static auth for a supervised implementation or a manual verification run.
 *
 * The cookie is passed in by the caller. R1's own tooling never obtains one from
 * disk, so this provider is for an operator who has deliberately supplied the
 * credential themselves.
 */
export class StaticAuthProvider extends DshAuthProvider {
  /**
   * @param {object} options - static settings.
   * @param {string} options.cookie - the cookie header value.
   * @param {string} [options.authority] - authority the cookie is bound to.
   */
  constructor(options) {
    super();
    if (typeof options?.cookie !== 'string' || options.cookie.length === 0) {
      throw new AdapterError(
        ADAPTER_ERROR.AUTH_UNAVAILABLE,
        'StaticAuthProvider requires a non-empty cookie',
      );
    }
    if (!COOKIE_NAME_PATTERN.test(options.cookie)) {
      throw new AdapterError(
        ADAPTER_ERROR.AUTH_REJECTED,
        'supplied cookie is not in dsh-auth-<hash>=... form',
      );
    }
    this.cookie = options.cookie;
    this.authority = options.authority ?? DEFAULT_AUTHORITY;
  }

  /** @returns {Promise<DshAuth>} the supplied credential. */
  async getAuth() {
    return { cookie: this.cookie, authority: this.authority };
  }

  /** @returns {string} the value with the cookie removed. */
  redact(value) {
    return redactString(value, [this.cookie]);
  }
}

/**
 * Auth provider that always fails.
 *
 * The default for a live-mode adapter built without a credential, and the
 * provider that proves `AUTH_UNAVAILABLE` is reachable.
 */
export class UnavailableAuthProvider extends DshAuthProvider {
  /**
   * @param {string} [reason] - why no credential exists.
   */
  constructor(reason = 'no DSH credential is configured; bootstrap is DEFERRED TO R7') {
    super();
    this.reason = reason;
  }

  /** @throws {AdapterError} always, with `AUTH_UNAVAILABLE`. */
  async getAuth() {
    throw new AdapterError(ADAPTER_ERROR.AUTH_UNAVAILABLE, this.reason);
  }
}

/**
 * Describe a credential for logging without revealing it.
 *
 * @param {DshAuth} auth - credential to describe.
 * @returns {string} a description such as `dsh-auth-<hash>=<redacted> @ 127.0.0.1:3080`.
 */
export function describeAuth(auth) {
  const name = typeof auth?.cookie === 'string' ? auth.cookie.split('=')[0] : '(none)';
  return `${name}=${REDACTED} @ ${auth?.authority ?? '(no authority)'}`;
}
