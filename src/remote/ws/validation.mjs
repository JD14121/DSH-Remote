/**
 * Upgrade validation 鈥?Phase R4 搂8, 搂9, 搂10, 搂32.
 *
 * Node's `upgrade` event **bypasses the normal HTTP route handler**, so the R3
 * security policy does not apply automatically. This module re-applies it
 * explicitly, before any 101 is sent:
 *
 *   loopback bind (already enforced by config) 路 Host 路 path 路 query 路
 *   WebSocket version 路 Sec-WebSocket-Key 路 subprotocol 路 Origin
 *
 * The Host check **reuses R3's `checkHostHeader`** rather than reimplementing it
 * (搂9 forbids a second, different copy). A failure is reported as an HTTP error
 * *before* the handshake; 搂8 forbids sending 101 and then closing, except for
 * state that can only be known after connecting.
 */

import { checkHostHeader } from '../http/config.mjs';
import { API_ERROR, HTTP_STATUS, apiError } from '../http/errors.mjs';
import { validateSessionId } from '../http/validation.mjs';
import { OriginPolicy } from '../auth/origin-policy.mjs';
import { EVENTS_PATH, PROTOCOL } from './protocol.mjs';

/**
 * Whether an `Origin` value is acceptable (搂10).
 *
 * R4 closed the CSWSH hole immediately rather than deferring it: a browser cannot be
 * stopped from opening a WebSocket to loopback, so the server has to refuse any
 * origin that is not the loopback gateway itself.
 *
 * **Phase R6 搂27:** this now delegates to the single shared `OriginPolicy` that
 * REST, CORS, the WebSocket upgrade and ticket binding all use. R4 had the rule
 * inline; four copies of an origin rule is four chances to disagree, and a
 * disagreement here would be a security hole rather than a bug.
 *
 * @param {unknown} origin - the raw `Origin` header.
 * @param {object} config - resolved HTTP config.
 * @param {number} [actualPort] - the real bound port.
 * @param {import('../auth/origin-policy.mjs').OriginPolicy} [policy] - an already-constructed shared policy.
 * @returns {{allowed: boolean, reason: string|null}} the decision.
 */
export function checkOrigin(origin, config, actualPort, policy) {
  const shared = policy ?? new OriginPolicy({
    port: actualPort ?? config?.port ?? null,
    allowedOrigins: config?.allowedOrigins ?? [],
  });
  const decision = shared.check(origin);
  return { allowed: decision.allowed, reason: decision.reason };
}

/**
 * Parse a `Sec-WebSocket-Protocol` header into offered names.
 *
 * @param {unknown} header - the raw header.
 * @returns {string[]} the offered subprotocols, in order.
 */
export function parseSubprotocols(header) {
  if (typeof header !== 'string' || header.length === 0) return [];
  return header.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/**
 * Validate a WebSocket upgrade request in full.
 *
 * @param {object} input - the request facts.
 * @param {import('node:http').IncomingMessage} input.req - the upgrade request.
 * @param {string} input.pathname - the request pathname.
 * @param {URLSearchParams} input.searchParams - the parsed query.
 * @param {object} input.config - resolved HTTP config.
 * @param {number} [input.actualPort] - the real bound port.
 * @param {(request: object) => {allowed: boolean, code?: string, message?: string, status?: number}} [input.authorizeUpgrade]
 *   the R6 auth seam (搂11). Absent in R4.
 * @returns {{ok: true, sessionId: string, lastSequence: number|null, subprotocol: string}}
 *   the accepted request facts.
 * @throws {ApiError} on any rejection, always with a non-101 HTTP status.
 */
export function validateUpgrade(input) {
  const { req, pathname, searchParams, config, actualPort } = input;

  // 1. Path.
  if (pathname !== EVENTS_PATH) {
    throw apiError(HTTP_STATUS.NOT_FOUND, API_ERROR.ROUTE_NOT_FOUND, 'No such route.');
  }

  // 2. Host fence 鈥?the same validator the REST layer uses.
  const hostCheck = checkHostHeader(req.headers.host, config, actualPort);
  if (!hostCheck.allowed) {
    throw apiError(HTTP_STATUS.FORBIDDEN, API_ERROR.FORBIDDEN_HOST, 'Request Host is not accepted.');
  }

  // 3. Origin fence. CSWSH is closed here, not deferred to R6.
  const originCheck = checkOrigin(req.headers.origin, config, actualPort, input.originPolicy);
  if (!originCheck.allowed) {
    throw apiError(HTTP_STATUS.FORBIDDEN, 'ORIGIN_NOT_ALLOWED', 'Request Origin is not accepted.');
  }

  // 4. WebSocket handshake headers.
  if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
    throw apiError(
      HTTP_STATUS.UPGRADE_REQUIRED,
      'UPGRADE_REQUIRED',
      'This endpoint requires a WebSocket upgrade.',
    );
  }
  if (Number(req.headers['sec-websocket-version']) !== 13) {
    throw apiError(
      HTTP_STATUS.UPGRADE_REQUIRED,
      'UPGRADE_REQUIRED',
      'Only WebSocket version 13 is supported.',
    );
  }
  if (typeof req.headers['sec-websocket-key'] !== 'string' || req.headers['sec-websocket-key'].length === 0) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_REQUEST, 'Sec-WebSocket-Key is required.');
  }

  // 5. Subprotocol. 搂7 forbids silently degrading to an unknown protocol.
  const offered = parseSubprotocols(req.headers['sec-websocket-protocol']);
  if (offered.length === 0) {
    throw apiError(
      HTTP_STATUS.UPGRADE_REQUIRED,
      'SUBPROTOCOL_REQUIRED',
      `This endpoint requires the ${PROTOCOL} subprotocol.`,
    );
  }
  if (!offered.includes(PROTOCOL)) {
    throw apiError(
      HTTP_STATUS.UPGRADE_REQUIRED,
      'SUBPROTOCOL_UNSUPPORTED',
      `Unsupported subprotocol. This gateway speaks ${PROTOCOL}.`,
    );
  }

  // 6. Query. Strict, matching the REST layer's §30 rules.
  //
  // R6 §23 adds exactly one credential-bearing parameter, `ticket`, and nothing
  // else. The long-lived Phone Bearer must never reach a URL, and the other
  // credential names stay refused even though they would also fail authentication.
  for (const key of new Set(searchParams.keys())) {
    if (key !== 'session_id' && key !== 'last_sequence' && key !== 'ticket') {
      // A token in the URL is explicitly forbidden (§11), so name that case.
      if (['token', 'access_token', 'bearer', 'api_key', 'apikey'].includes(key.toLowerCase())) {
        throw apiError(
          HTTP_STATUS.BAD_REQUEST,
          'TOKEN_IN_URL_NOT_SUPPORTED',
          'Credentials must not be passed in the WebSocket URL.',
        );
      }
      throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_QUERY, `Unknown query parameter ${JSON.stringify(key)}.`);
    }
    if (searchParams.getAll(key).length > 1) {
      throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_QUERY, `Query parameter ${JSON.stringify(key)} was repeated.`);
    }
  }

  // A ticket has no query grammar of its own beyond "present"; a malformed one
  // simply fails the lookup, so the failure is indistinguishable from an unknown
  // ticket (§20).
  const rawTicket = searchParams.get('ticket');
  const ticket = rawTicket === null || rawTicket === '' ? null : rawTicket;

  const rawSessionId = searchParams.get('session_id');
  if (rawSessionId === null || rawSessionId === '') {
    throw apiError(HTTP_STATUS.BAD_REQUEST, 'SESSION_ID_REQUIRED', 'session_id is required.');
  }
  // Reuses the REST validator, so session-id grammar has exactly one definition.
  const sessionId = validateSessionId(rawSessionId);

  let lastSequence = null;
  const rawLast = searchParams.get('last_sequence');
  if (rawLast !== null) {
    if (!/^\d+$/.test(rawLast)) {
      throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_QUERY, 'last_sequence must be a non-negative integer.');
    }
    lastSequence = Number(rawLast);
    if (!Number.isSafeInteger(lastSequence)) {
      throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_QUERY, 'last_sequence is out of range.');
    }
  }

  // 7. The R6 authentication seam (§11). R4's default policy is loopback + Host +
  // Origin only; this hook exists so R6 can extend it without touching the
  // handshake. A token in the URL is never the mechanism.
  if (typeof input.authorizeUpgrade === 'function') {
    const decision = input.authorizeUpgrade({ req, pathname, searchParams, sessionId, ticket, config });
    if (decision?.allowed !== true) {
      throw apiError(
        decision?.status ?? HTTP_STATUS.FORBIDDEN,
        decision?.code ?? 'UNAUTHORIZED',
        decision?.message ?? 'The upgrade was refused.',
      );
    }
  }

  return { ok: true, sessionId, lastSequence, subprotocol: PROTOCOL, ticket };
}

/**
 * Validate one client-to-server application frame (搂31).
 *
 * R4 accepts exactly one: `client_ping`. There is deliberately no second command
 * channel 鈥?prompts stay on REST.
 *
 * @param {unknown} raw - the decoded frame payload.
 * @returns {{ok: true, type: string}|{ok: false, reason: string}} the decision.
 */
export function validateClientFrame(raw) {
  if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) {
    return { ok: false, reason: 'client frames must be text' };
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);
  } catch {
    return { ok: false, reason: 'client frame is not valid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'client frame must be a JSON object' };
  }
  if (parsed.type === 'client_ping') {
    return { ok: true, type: 'client_ping' };
  }
  return { ok: false, reason: `unsupported client frame type ${JSON.stringify(parsed.type)}` };
}
