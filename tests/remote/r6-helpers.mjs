/**
 * R6 auth test helpers.
 *
 * Every suite uses a **synthetic in-memory credential**: R6 never generates, stores
 * or reads a production Phone token (§3, §71). Temp roots only for persistence
 * (§69), and the real `$DSH_HOME` is never touched.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startFixtureServer, makeTempStateRoot, request, fixtureClock } from './r3-helpers.mjs';
import { AuthService, DEFAULT_PRINCIPAL_ID, AUTH_SCHEME } from '../../src/remote/auth/auth-service.mjs';
import { AUTH_MODE, resolveAuthConfig, validateAuthConfig } from '../../src/remote/auth/config.mjs';
import { AUTH_ERROR, AuthError, authError, WWW_AUTHENTICATE, statusForCode } from '../../src/remote/auth/errors.mjs';
import {
  BearerVerifier,
  generateSyntheticToken,
  isValidTokenShape,
  parseAuthorizationHeader,
  tokenDigest,
  TOKEN_BYTES,
} from '../../src/remote/auth/bearer.mjs';
import { normalizeOrigin, OriginPolicy, parseAllowedOrigins } from '../../src/remote/auth/origin-policy.mjs';
import { CorsPolicy, ALLOWED_REQUEST_HEADERS } from '../../src/remote/auth/cors.mjs';
import { RateLimiter, remoteIdentity, DEFAULT_LIMITS, resolveLimits } from '../../src/remote/auth/rate-limit.mjs';
import {
  ConnectionLimiter,
  DEFAULT_MAX_CONNECTIONS_PER_PRINCIPAL,
} from '../../src/remote/auth/connection-limit.mjs';
import {
  UploadQuota,
  DEFAULT_MAX_CONCURRENT_UPLOADS,
  DEFAULT_BYTES_PER_WINDOW,
} from '../../src/remote/auth/upload-quota.mjs';
import {
  DEFAULT_MAX_OUTSTANDING_TICKETS,
  DEFAULT_TICKET_TTL_SECONDS,
  generateTicket,
  TicketStore,
  ticketDigest,
  TICKET_BYTES,
} from '../../src/remote/auth/ws-ticket.mjs';
import {
  redactHeaders,
  redactRequestUrl,
  redactStructured,
  REDACTED,
  findSecret,
} from '../../src/remote/auth/redact-auth.mjs';
import { AuthGate, classifyRequest, SECURITY_HEADERS, PUBLIC_HEALTH_PATH, WS_TICKET_PATH } from '../../src/remote/auth/auth-gate.mjs';
import { startWsServer, rawHttpRequest, switchedProtocols, openClient } from './r4-helpers.mjs';
import { FRAME, PROTOCOL } from '../../src/remote/ws/protocol.mjs';

export {
  // fixture server plumbing
  startFixtureServer,
  startWsServer,
  makeTempStateRoot,
  request,
  rawHttpRequest,
  switchedProtocols,
  openClient,
  fixtureClock,
  FRAME,
  PROTOCOL,
  fs,
  os,
  path,
  // auth service
  AuthService,
  AuthGate,
  DEFAULT_PRINCIPAL_ID,
  AUTH_SCHEME,
  AUTH_MODE,
  resolveAuthConfig,
  validateAuthConfig,
  AUTH_ERROR,
  AuthError,
  authError,
  WWW_AUTHENTICATE,
  statusForCode,
  // bearer
  BearerVerifier,
  generateSyntheticToken,
  isValidTokenShape,
  parseAuthorizationHeader,
  tokenDigest,
  TOKEN_BYTES,
  // origin / cors
  normalizeOrigin,
  OriginPolicy,
  parseAllowedOrigins,
  CorsPolicy,
  ALLOWED_REQUEST_HEADERS,
  // limits
  RateLimiter,
  remoteIdentity,
  DEFAULT_LIMITS,
  resolveLimits,
  ConnectionLimiter,
  DEFAULT_MAX_CONNECTIONS_PER_PRINCIPAL,
  UploadQuota,
  DEFAULT_MAX_CONCURRENT_UPLOADS,
  DEFAULT_BYTES_PER_WINDOW,
  // tickets
  TicketStore,
  generateTicket,
  ticketDigest,
  TICKET_BYTES,
  DEFAULT_TICKET_TTL_SECONDS,
  DEFAULT_MAX_OUTSTANDING_TICKETS,
  // redaction
  redactHeaders,
  redactRequestUrl,
  redactStructured,
  REDACTED,
  findSecret,
  classifyRequest,
  SECURITY_HEADERS,
  PUBLIC_HEALTH_PATH,
  WS_TICKET_PATH,
};

/** A stable session id used across these suites. */
export const SESSION = 'session-00000000-0000-0000-0000-000000000001';
/** A second session, for binding tests. */
export const OTHER_SESSION = 'session-00000000-0000-0000-0000-000000000002';

/**
 * Build a standalone `AuthService` with a synthetic credential.
 *
 * @param {object} [options] - service options.
 * @param {Partial<object>} [options.config] - auth config overrides.
 * @param {() => number} [options.clock] - injectable clock.
 * @param {number|(() => number|null)} [options.port] - the port for the Origin policy.
 * @returns {{auth: object, token: string, config: object}} the service and its credential.
 */
export function makeAuth(options = {}) {
  const token = options.token ?? generateSyntheticToken();
  const config = resolveAuthConfig({
    mode: AUTH_MODE.REQUIRED,
    ...(options.config ?? {}),
  }, {});
  const auth = new AuthService({
    config,
    token,
    clock: options.clock ?? fixtureClock,
    port: options.port ?? 9445,
  });
  return { auth, token, config };
}

/**
 * Start a fixture server that **enforces** authentication with a synthetic token.
 *
 * @param {object} [options] - options.
 * @param {object} [options.config] - auth config overrides.
 * @param {string} [options.token] - a specific synthetic token.
 * @param {object} [options.persistenceConfig] - durability, when a suite needs it.
 * @returns {Promise<object>} the server handle, plus `token` and an `authHeaders` helper.
 */
export async function startAuthServer(options = {}) {
  const token = options.token ?? generateSyntheticToken();
  const handle = await startFixtureServer({
    authConfig: { mode: AUTH_MODE.REQUIRED, ...(options.config ?? {}) },
    authToken: token,
    ...(options.persistenceConfig === undefined ? {} : { persistenceConfig: options.persistenceConfig }),
    ...(options.serverOptions ?? {}),
  });
  return {
    ...handle,
    token,
    /**
     * The auth service under test.
     *
     * Surfaced directly so a suite can inspect ticket records and limit counters
     * without reaching through `server`.
     *
     * @returns {object|null} the service.
     */
    get auth() {
      return handle.server.auth;
    },
    /** The Authorization header for this server's credential. */
    get authHeaders() {
      return { authorization: `Bearer ${token}` };
    },
    /**
     * Make an authenticated GET.
     *
     * @param {string} url - the path.
     * @param {object} [extra] - extra request options.
     * @returns {Promise<object>} the response.
     */
    get(url, extra = {}) {
      return request(handle.baseUrl, url, { ...extra, headers: { ...(extra.headers ?? {}), authorization: `Bearer ${token}` } });
    },
    /**
     * Make an authenticated POST.
     *
     * @param {string} url - the path.
     * @param {object} [body] - the JSON body.
     * @param {object} [extra] - extra request options.
     * @returns {Promise<object>} the response.
     */
    post(url, body, extra = {}) {
      return request(handle.baseUrl, url, {
        ...extra,
        method: 'POST',
        body,
        headers: { ...(extra.headers ?? {}), authorization: `Bearer ${token}` },
      });
    },
  };
}

/**
 * Start a WebSocket fixture server that enforces auth, and mint a ticket against it.
 *
 * @param {object} [options] - options.
 * @returns {Promise<object>} the handle with `mintTicket()` and `connectWithTicket()`.
 */
export async function startAuthWsServer(options = {}) {
  const token = options.token ?? generateSyntheticToken();
  const handle = await startWsServer({
    authConfig: { mode: AUTH_MODE.REQUIRED, ...(options.config ?? {}) },
    authToken: token,
    ...(options.persistenceConfig === undefined ? {} : { persistenceConfig: options.persistenceConfig }),
  });
  return {
    ...handle,
    token,
    /**
     * Attempt a raw upgrade, defaulting to the required subprotocol.
     *
     * Without `dsh-remote-v1` every attempt fails with 426 before reaching the ticket
     * check, which would make an auth assertion pass for the wrong reason.
     *
     * @param {object} [opts] - upgrade options.
     * @returns {Promise<object>} the raw response.
     */
    ticketUpgrade(opts = {}) {
      return handle.rawUpgrade({ subprotocol: PROTOCOL, ...opts });
    },
    /**
     * The auth service under test.
     *
     * @returns {object|null} the service.
     */
    get auth() {
      return handle.server.auth;
    },
    /** The Authorization header for this server's credential. */
    get authHeaders() {
      return { authorization: `Bearer ${token}` };
    },
    /**
     * Make an authenticated GET.
     *
     * The fixture handle's own `get` is unauthenticated, so this shadows it —
     * otherwise a suite would silently send no credential and see 401.
     *
     * @param {string} url - the path.
     * @param {object} [extra] - extra request options.
     * @returns {Promise<object>} the response.
     */
    get(url, extra = {}) {
      return request(handle.baseUrl, url, {
        ...extra,
        headers: { ...(extra.headers ?? {}), authorization: `Bearer ${token}` },
      });
    },
    /**
     * Mint a ticket through the real REST endpoint.
     *
     * @param {object} [mint] - mint options.
     * @param {string} [mint.sessionId] - the session to bind.
     * @param {string} [mint.origin] - the issuing Origin.
     * @returns {Promise<object>} the mint response.
     */
    mintTicket(mint = {}) {
      return request(handle.baseUrl, '/api/v1/auth/ws-ticket', {
        method: 'POST',
        body: { session_id: mint.sessionId ?? SESSION },
        headers: {
          authorization: `Bearer ${token}`,
          ...(mint.origin === undefined ? {} : { origin: mint.origin }),
        },
      });
    },
    /**
     * Open a WebSocket with a ticket.
     *
     * @param {object} [q] - query and origin.
     * @returns {Promise<object>} the client handle.
     */
    connectWithTicket(q = {}) {
      const url = handle.wsUrl({
        session_id: q.session_id ?? SESSION,
        ...(q.last_sequence === undefined ? {} : { last_sequence: q.last_sequence }),
        ...(q.ticket === undefined ? {} : { ticket: q.ticket }),
      });
      return openClient(url, {
        ...(q.origin === undefined ? {} : { origin: q.origin }),
        protocol: PROTOCOL,
      });
    },
  };
}

/**
 * Assert that a response never carries one of the supplied secrets.
 *
 * @param {object} response - a request result.
 * @param {readonly string[]} secrets - the values that must not appear.
 * @returns {void}
 */
export function assertNoSecret(response, secrets) {
  const text = `${JSON.stringify(response.body ?? {})}\n${response.text ?? ''}\n${JSON.stringify(response.headers ?? {})}`;
  const found = findSecret(text, secrets);
  if (found !== null) throw new Error('a secret leaked into the response');
}

/**
 * Scan a directory tree for one of the supplied secrets.
 *
 * @param {string} root - the directory root.
 * @param {readonly string[]} secrets - the values that must not appear.
 * @returns {{files: number, leaked: string[]}} the scan result.
 */
export function scanTreeForSecrets(root, secrets) {
  const leaked = [];
  let files = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      files += 1;
      const text = fs.readFileSync(full, 'utf8');
      if (findSecret(text, secrets) !== null) leaked.push(path.relative(root, full));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return { files, leaked };
}
