/**
 * Auth configuration — Phase R6 §5, §6, §18, §28, §35, §38, §41, §48, §53.
 *
 * Two things are deliberate here.
 *
 * **The mode must be explicit.** §6 defines exactly two modes and forbids an
 * `optional`, `auto` or `best-effort` third. §5 requires an explicit decision, so a
 * missing one is a `TypeError` rather than a silent disable — the same lesson R5A
 * applied to the durability decision, where an implicit default wrote the real state
 * root.
 *
 * **The token is never read by product code.** §48 is explicit: R6 does not read a
 * production Phone-token environment variable. R7 loads or generates the credential
 * and passes it to the `AuthService` constructor, which keeps the credential
 * bootstrap boundary in one place.
 */

import { AUTH_ERROR, authError } from './errors.mjs';
import { parseAllowedOrigins } from './origin-policy.mjs';
import { resolveLimits } from './rate-limit.mjs';
import {
  DEFAULT_MAX_OUTSTANDING_TICKETS,
  DEFAULT_TICKET_TTL_SECONDS,
  MAX_TICKET_TTL_SECONDS,
  MIN_TICKET_TTL_SECONDS,
} from './ws-ticket.mjs';
import { DEFAULT_MAX_CONNECTIONS_PER_PRINCIPAL } from './connection-limit.mjs';
import {
  DEFAULT_BYTES_PER_WINDOW,
  DEFAULT_MAX_CONCURRENT_UPLOADS,
  DEFAULT_WINDOW_SECONDS,
} from './upload-quota.mjs';

/** The only two permitted auth modes (§6). */
export const AUTH_MODE = Object.freeze({
  /** A production-shaped server. A credential is required. */
  REQUIRED: 'required',
  /** A synthetic fixture, explicitly and visibly unauthenticated. */
  DISABLED_FIXTURE: 'disabled-fixture',
});

/**
 * Read a positive integer from the environment, falling back when absent.
 *
 * @param {unknown} value - the raw value.
 * @param {number} fallback - the default.
 * @param {string} name - the variable name, for the error.
 * @returns {number} the resolved value.
 * @throws {AuthError} `AUTH_CONFIG_INVALID`.
 */
function readInt(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw authError(AUTH_ERROR.CONFIG_INVALID, { message: `${name} must be a positive integer.` });
  }
  return parsed;
}

/**
 * Resolve the auth configuration.
 *
 * @param {object} [overrides] - explicit settings, taking precedence over the environment.
 * @param {NodeJS.ProcessEnv} [env] - environment source.
 * @returns {object} the resolved configuration.
 * @throws {AuthError} `AUTH_CONFIG_INVALID`; `TypeError` when the mode is absent.
 */
export function resolveAuthConfig(overrides = {}, env = process.env) {
  const rawMode = overrides.mode ?? env.DSH_REMOTE_AUTH_MODE;

  if (rawMode === undefined || rawMode === null || rawMode === '') {
    // §5/§6: no implicit decision. A silently disabled auth layer is exactly the
    // failure mode this phase exists to prevent.
    throw new TypeError(
      'an explicit auth mode is required: pass AUTH_MODE.REQUIRED for a '
      + 'production-shaped server or AUTH_MODE.DISABLED_FIXTURE for a synthetic '
      + 'fixture. An implicit default is not permitted (R6 §5).',
    );
  }
  if (rawMode !== AUTH_MODE.REQUIRED && rawMode !== AUTH_MODE.DISABLED_FIXTURE) {
    throw authError(AUTH_ERROR.CONFIG_INVALID, {
      message: `The auth mode must be "${AUTH_MODE.REQUIRED}" or "${AUTH_MODE.DISABLED_FIXTURE}".`,
    });
  }

  // §28: a wildcard or malformed entry is rejected rather than ignored.
  const allowedOrigins = overrides.allowedOrigins
    ?? parseAllowedOrigins(env.DSH_REMOTE_ALLOWED_ORIGINS);

  const ticketTtlSeconds = overrides.ticketTtlSeconds
    ?? readInt(env.DSH_REMOTE_WS_TICKET_TTL_SECONDS, DEFAULT_TICKET_TTL_SECONDS, 'DSH_REMOTE_WS_TICKET_TTL_SECONDS');
  if (ticketTtlSeconds < MIN_TICKET_TTL_SECONDS || ticketTtlSeconds > MAX_TICKET_TTL_SECONDS) {
    throw authError(AUTH_ERROR.CONFIG_INVALID, {
      message: `The WS ticket TTL must be between ${MIN_TICKET_TTL_SECONDS} and ${MAX_TICKET_TTL_SECONDS} seconds.`,
    });
  }

  const maxConnectionsPerPrincipal = overrides.maxConnectionsPerPrincipal
    ?? readInt(env.DSH_REMOTE_WS_MAX_CONNECTIONS_PER_PRINCIPAL, DEFAULT_MAX_CONNECTIONS_PER_PRINCIPAL, 'DSH_REMOTE_WS_MAX_CONNECTIONS_PER_PRINCIPAL');
  // §53: bounds are checked here too, not only in the limiter, so a bad value is
  // reported as a configuration problem at resolution time rather than as a
  // constructor surprise later.
  if (!Number.isSafeInteger(maxConnectionsPerPrincipal) || maxConnectionsPerPrincipal < 1) {
    throw authError(AUTH_ERROR.CONFIG_INVALID, {
      message: 'The per-principal connection limit must be a positive integer.',
    });
  }

  return {
    mode: rawMode,
    /** Whether a credential must be presented. */
    required: rawMode === AUTH_MODE.REQUIRED,
    allowedOrigins,
    ticketTtlSeconds,
    maxOutstandingTickets: overrides.maxOutstandingTickets
      ?? readInt(env.DSH_REMOTE_WS_MAX_OUTSTANDING_TICKETS, DEFAULT_MAX_OUTSTANDING_TICKETS, 'DSH_REMOTE_WS_MAX_OUTSTANDING_TICKETS'),
    maxConnectionsPerPrincipal,
    limits: resolveLimits(overrides.limits ?? {}),
    upload: {
      maxConcurrent: overrides.upload?.maxConcurrent
        ?? readInt(env.DSH_REMOTE_UPLOAD_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT_UPLOADS, 'DSH_REMOTE_UPLOAD_MAX_CONCURRENT'),
      bytesPerWindow: overrides.upload?.bytesPerWindow
        ?? readInt(env.DSH_REMOTE_UPLOAD_BYTES_PER_10_MIN, DEFAULT_BYTES_PER_WINDOW, 'DSH_REMOTE_UPLOAD_BYTES_PER_10_MIN'),
      windowSeconds: overrides.upload?.windowSeconds ?? DEFAULT_WINDOW_SECONDS,
    },
    /**
     * The credential. Present only because a caller supplied it — never read from
     * the environment by this module (§48).
     */
    token: overrides.token ?? null,
    principalId: overrides.principalId ?? 'phone',
  };
}

/**
 * Validate a resolved configuration, so startup fails before binding (§53).
 *
 * @param {object} config - a resolved config.
 * @param {object|null} service - the constructed `AuthService`, if any.
 * @returns {object} the validated config.
 * @throws {AuthError} `AUTH_CONFIG_INVALID`.
 */
export function validateAuthConfig(config, service) {
  if (config.mode === AUTH_MODE.REQUIRED) {
    if (service === null || service === undefined) {
      throw authError(AUTH_ERROR.CONFIG_INVALID, {
        message: 'Auth mode "required" needs an AuthService and a credential.',
      });
    }
    if (service.mode !== AUTH_MODE.REQUIRED) {
      throw authError(AUTH_ERROR.CONFIG_INVALID, { message: 'The AuthService mode does not match the configuration.' });
    }
  }
  // The same validation runs in both modes, so a fixture cannot carry a broken
  // limit that would only surface in production.
  resolveLimits(config.limits);
  if (!Number.isSafeInteger(config.maxConnectionsPerPrincipal) || config.maxConnectionsPerPrincipal < 1) {
    throw authError(AUTH_ERROR.CONFIG_INVALID, { message: 'The connection limit must be a positive integer.' });
  }
  if (!Number.isSafeInteger(config.maxOutstandingTickets) || config.maxOutstandingTickets < 1) {
    throw authError(AUTH_ERROR.CONFIG_INVALID, { message: 'The outstanding ticket cap must be a positive integer.' });
  }
  return config;
}
