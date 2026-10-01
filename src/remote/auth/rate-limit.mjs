/**
 * Rate limiting — Phase R6 §34, §35, §36, §63.
 *
 * A fixed-window counter per bucket. §34 is explicit that a remote IP must **not**
 * be the principal: behind an SSH or Tailscale tunnel every connection can look like
 * `127.0.0.1`, so an IP-keyed limit would either throttle every client as one or
 * exempt them all.
 *
 * So the keys are:
 *
 *   - **authenticated** traffic → `principal_id` (which R6 v1 fixes at `phone`);
 *   - **unauthenticated** abuse → the remote socket identity, *plus* a global bucket
 *     that no single caller can escape.
 *
 * Counters are memory-only and reset on restart, which §63 accepts.
 */

import { AUTH_ERROR, authError } from './errors.mjs';

/** The bucket definitions with the §35 defaults. */
export const DEFAULT_LIMITS = Object.freeze({
  /** Authenticated reads. */
  read: { limit: 120, windowSeconds: 60 },
  /** Authenticated mutations. */
  mutation: { limit: 30, windowSeconds: 60 },
  /** WS ticket minting. */
  ticket: { limit: 20, windowSeconds: 60 },
  /** Failed authentication, per remote identity. */
  failedAuth: { limit: 10, windowSeconds: 60 },
  /** Failed authentication, globally. */
  failedAuthGlobal: { limit: 100, windowSeconds: 60 },
  /** Upload starts. */
  uploadStart: { limit: 10, windowSeconds: 60 },
});

/** Every bucket name. */
export const BUCKET_NAMES = Object.freeze(Object.keys(DEFAULT_LIMITS));

/**
 * Validate a limits object, filling defaults.
 *
 * @param {object} [overrides] - per-bucket overrides.
 * @returns {object} the validated limits.
 * @throws {AuthError} `AUTH_CONFIG_INVALID`.
 */
export function resolveLimits(overrides = {}) {
  const resolved = {};
  for (const [name, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const entry = overrides[name] ?? fallback;
    const limit = entry.limit ?? fallback.limit;
    const windowSeconds = entry.windowSeconds ?? fallback.windowSeconds;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw authError(AUTH_ERROR.CONFIG_INVALID, { message: `Rate limit "${name}" must be a positive integer.` });
    }
    if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
      throw authError(AUTH_ERROR.CONFIG_INVALID, { message: `Rate window "${name}" must be a positive integer.` });
    }
    resolved[name] = { limit, windowSeconds };
  }
  for (const name of Object.keys(overrides)) {
    if (!(name in DEFAULT_LIMITS)) {
      throw authError(AUTH_ERROR.CONFIG_INVALID, { message: `Unknown rate-limit bucket "${name}".` });
    }
  }
  return resolved;
}

/**
 * A fixed-window rate limiter.
 */
export class RateLimiter {
  /**
   * @param {object} [options] - limiter options.
   * @param {() => number} [options.clock] - injectable clock (ms).
   * @param {object} [options.limits] - per-bucket limits.
   */
  constructor(options = {}) {
    this.clock = options.clock ?? Date.now;
    this.limits = resolveLimits(options.limits ?? {});
    /** @type {Map<string, {count: number, resetAt: number}>} */
    this.windows = new Map();
  }

  /**
   * Build a window key.
   *
   * The key is the bucket plus the caller identity. It is **never** a token: §83
   * requires that the credential itself is not used as a Map key.
   *
   * @param {string} bucket - the bucket name.
   * @param {string} identity - the principal or remote identity.
   * @returns {string} the key.
   */
  #key(bucket, identity) {
    return `${bucket}\u0000${identity}`;
  }

  /**
   * Charge one unit against a bucket.
   *
   * @param {string} bucket - the bucket name.
   * @param {string} identity - the principal or remote identity.
   * @param {number} [units] - how many units to charge.
   * @returns {{allowed: boolean, remaining: number, retryAfter: number}} the decision.
   * @throws {AuthError} `AUTH_CONFIG_INVALID` for an unknown bucket.
   */
  charge(bucket, identity, units = 1) {
    const limit = this.limits[bucket];
    if (limit === undefined) {
      throw authError(AUTH_ERROR.CONFIG_INVALID, { message: `Unknown rate-limit bucket "${bucket}".` });
    }
    const now = this.clock();
    const key = this.#key(bucket, identity);
    let window = this.windows.get(key);

    if (window === undefined || now >= window.resetAt) {
      window = { count: 0, resetAt: now + limit.windowSeconds * 1000 };
      this.windows.set(key, window);
    }

    if (window.count + units > limit.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
      };
    }

    window.count += units;
    return { allowed: true, remaining: limit.limit - window.count, retryAfter: 0 };
  }

  /**
   * Charge a bucket, throwing when it refuses.
   *
   * @param {string} bucket - the bucket name.
   * @param {string} identity - the principal or remote identity.
   * @param {number} [units] - how many units to charge.
   * @returns {void}
   * @throws {AuthError} `RATE_LIMITED` with `Retry-After`.
   */
  assert(bucket, identity, units = 1) {
    const decision = this.charge(bucket, identity, units);
    if (!decision.allowed) {
      // §36: the response carries Retry-After and never a token or a fingerprint.
      throw authError(AUTH_ERROR.RATE_LIMITED, { retryAfter: decision.retryAfter });
    }
  }

  /**
   * Remove expired windows, so the map cannot grow without bound.
   *
   * @returns {number} how many were removed.
   */
  cleanup() {
    const now = this.clock();
    let removed = 0;
    for (const [key, window] of this.windows) {
      if (now >= window.resetAt) {
        this.windows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Diagnostics. Never includes a token or an identity.
   *
   * @returns {object} the summary.
   */
  stats() {
    return { tracked_windows: this.windows.size };
  }
}

/**
 * Derive a non-credential remote identity from a socket.
 *
 * §34: this is the *unauthenticated* key only. It is deliberately coarse — the
 * point is to blunt a flood, not to attribute a caller precisely — and it is never
 * used as an authenticated principal.
 *
 * @param {import('node:net').Socket|undefined} socket - the peer socket.
 * @returns {string} the remote identity.
 */
export function remoteIdentity(socket) {
  const address = socket?.remoteAddress;
  if (typeof address !== 'string' || address.length === 0) return 'unknown';
  const port = socket?.remotePort;
  // Local port is included so two loopback callers are not collapsed into one
  // bucket, which would let a single abuser exhaust everyone's budget.
  return typeof port === 'number' ? `${address}:${port}` : address;
}
