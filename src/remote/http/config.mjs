/**
 * HTTP configuration and bind policy — Phase R3 §5.
 *
 * R3 binds **loopback only** and fails closed. There is no configuration that
 * can make it listen on `0.0.0.0`, `::`, a LAN address or a public IP; those
 * values are rejected loudly rather than quietly narrowed. Remote reachability is
 * R9's SSH/Tailscale tunnel to this same loopback port — never a wider bind.
 */

import { isIP } from 'node:net';

/** Defaults, overridable through the environment. */
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 9445;

/** Body size defaults (R3 §26, §27). */
export const DEFAULT_MAX_JSON_BYTES = 1_048_576; // 1 MiB
export const DEFAULT_MAX_UPLOAD_BYTES = 26_214_400; // 25 MiB

/** Prompt-mode default (R3 §17.1). */
export const DEFAULT_PROMPT_MODE = 'steer';

/** The only prompt modes the API accepts. */
export const ALLOWED_PROMPT_MODES = Object.freeze(['steer', 'queue']);

/** Pagination bounds (R3 §14, §16). */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

/** Hostnames treated as loopback. */
const LOOPBACK_HOSTNAMES = Object.freeze(new Set(['127.0.0.1', 'localhost', '::1']));

/**
 * Whether a host string is an acceptable loopback bind target.
 *
 * Accepts the three canonical loopback spellings plus any `127.0.0.0/8` literal.
 *
 * @param {unknown} host - candidate host.
 * @returns {boolean} true when the host is loopback-only.
 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string' || host.length === 0) return false;
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTNAMES.has(normalized)) return true;
  if (isIP(normalized) === 4) return normalized.startsWith('127.');
  return false;
}

/**
 * Assert that a bind host is loopback, or throw.
 *
 * The error names the rejected value so a misconfiguration is obvious in a log,
 * but it never echoes anything else from the environment.
 *
 * @param {unknown} host - candidate bind host.
 * @returns {string} a normalised loopback host.
 * @throws {TypeError} when the host is missing, non-loopback, or unsupported.
 */
export function assertLoopbackHost(host) {
  if (typeof host !== 'string' || host.length === 0) {
    throw new TypeError('DSH_REMOTE_HOST must be a non-empty string');
  }
  if (!isLoopbackHost(host)) {
    throw new TypeError(
      `refusing to bind ${JSON.stringify(host)}: R3 is loopback-only. `
      + 'Use 127.0.0.1, localhost or ::1. Remote access is an SSH/Tailscale tunnel to this port, not a wider bind.',
    );
  }
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  // `localhost` is normalised to the IPv4 literal so the actual bind address is
  // unambiguous and can be reported exactly.
  return normalized === 'localhost' ? DEFAULT_HOST : normalized;
}

/**
 * Parse a positive integer from the environment, falling back on absence.
 *
 * @param {unknown} value - candidate value.
 * @param {string} name - variable name, for the error.
 * @param {object} [bounds] - accepted range.
 * @param {number} [bounds.min] - inclusive minimum.
 * @param {number} [bounds.max] - inclusive maximum.
 * @returns {number|undefined} the parsed value, or `undefined` when absent.
 * @throws {TypeError} when present but not a valid integer in range.
 */
export function parsePositiveInt(value, name, bounds = {}) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${name} must be an integer, received ${JSON.stringify(value)}`);
  }
  const min = bounds.min ?? 0;
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER;
  if (parsed < min || parsed > max) {
    throw new TypeError(`${name} must be between ${min} and ${max}, received ${parsed}`);
  }
  return parsed;
}

/**
 * Build the effective HTTP configuration.
 *
 * @param {object} [overrides] - explicit settings, taking precedence over the environment.
 * @param {NodeJS.ProcessEnv} [env] - environment source.
 * @returns {object} the resolved configuration.
 * @throws {TypeError} on a non-loopback host or an invalid numeric setting.
 */
export function resolveHttpConfig(overrides = {}, env = process.env) {
  const rawHost = overrides.host ?? env.DSH_REMOTE_HOST ?? DEFAULT_HOST;
  const port = overrides.port
    ?? parsePositiveInt(env.DSH_REMOTE_PORT, 'DSH_REMOTE_PORT', { min: 0, max: 65_535 })
    ?? DEFAULT_PORT;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError(`port must be between 0 and 65535, received ${JSON.stringify(port)}`);
  }

  const defaultMode = overrides.defaultPromptMode
    ?? env.DSH_REMOTE_DEFAULT_PROMPT_MODE
    ?? DEFAULT_PROMPT_MODE;
  if (!ALLOWED_PROMPT_MODES.includes(defaultMode)) {
    throw new TypeError(
      `DSH_REMOTE_DEFAULT_PROMPT_MODE must be one of ${ALLOWED_PROMPT_MODES.join(', ')}, received ${JSON.stringify(defaultMode)}`,
    );
  }

  return {
    // The actual bind authority. `localhost` is normalised so the bound address
    // is reported exactly rather than left to resolver ordering.
    host: assertLoopbackHost(rawHost),
    port,
    defaultPromptMode: defaultMode,
    maxJsonBytes: overrides.maxJsonBytes
      ?? parsePositiveInt(env.DSH_REMOTE_MAX_JSON_BYTES, 'DSH_REMOTE_MAX_JSON_BYTES', { min: 1 })
      ?? DEFAULT_MAX_JSON_BYTES,
    maxUploadBytes: overrides.maxUploadBytes
      ?? parsePositiveInt(env.DSH_REMOTE_MAX_UPLOAD_BYTES, 'DSH_REMOTE_MAX_UPLOAD_BYTES', { min: 1 })
      ?? DEFAULT_MAX_UPLOAD_BYTES,
    defaultLimit: overrides.defaultLimit ?? DEFAULT_PAGE_LIMIT,
    maxLimit: overrides.maxLimit ?? MAX_PAGE_LIMIT,
    ...(overrides.dshVersion === undefined ? {} : { dshVersion: overrides.dshVersion }),
    ...(overrides.trustedHosts === undefined ? {} : { trustedHosts: overrides.trustedHosts }),
  };
}

/**
 * Whether an incoming `Host` authority is acceptable (R3 §6).
 *
 * R3 accepts only loopback authorities on this server's own port. Proxy headers
 * are deliberately never consulted — R3 does not support reverse proxies, and an
 * SSH local forward does not need them.
 *
 * @param {unknown} hostHeader - the raw `Host` header value.
 * @param {object} config - resolved configuration.
 * @param {number} [config.port] - the bound port, or `0` when OS-assigned.
 * @param {number} [actualPort] - the real bound port once known.
 * @returns {{allowed: boolean, authority: string|null, reason: string|null}} the decision.
 */
export function checkHostHeader(hostHeader, config, actualPort) {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) {
    return { allowed: false, authority: null, reason: 'missing Host header' };
  }

  let url;
  try {
    url = new URL(`http://${hostHeader}`);
  } catch {
    return { allowed: false, authority: null, reason: 'unparseable Host header' };
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!isLoopbackHost(hostname)) {
    return { allowed: false, authority: url.host, reason: 'Host is not loopback' };
  }

  // The port must be the one actually bound. A port-less Host is accepted only
  // when the server is on the default HTTP port, which it never is here.
  const expectedPort = actualPort ?? config.port;
  const hostPort = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (expectedPort !== 0 && hostPort !== expectedPort) {
    return { allowed: false, authority: url.host, reason: 'Host port does not match the bound port' };
  }

  return { allowed: true, authority: url.host, reason: null };
}
