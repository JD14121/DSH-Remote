/**
 * WebSocket ticket acquisition.
 *
 * A WS ticket is short-lived, single-use, session-bound and origin-bound — the mechanism that
 * exists so a **long-lived credential never has to appear in a URL**. This module is the only
 * place a ticket is requested, and the only place one is held.
 *
 * ## Handling rules, all enforced here rather than by convention
 *
 * * the ticket is returned to the caller and **never stored**;
 * * it is never written to `sessionStorage`, `localStorage` or IndexedDB;
 * * it is never logged, and never placed in an error message;
 * * after a connection attempt it is dropped, so a reconnect must obtain a **fresh** one.
 *
 * The Phone credential is used exactly once per call — as the `Authorization` header — and the
 * `EventClient` never sees it.
 */

import { ApiError, ERROR_KIND, errorFromStatus, errorFromThrow } from '../api/errors.js';

/** The frozen ticket route. */
export const TICKET_PATH = '/api/v1/auth/ws-ticket';

/**
 * Request a one-time WebSocket ticket.
 *
 * @param {object} options - `fetchImpl`, `baseUrl`, `credential`, `sessionId`, `signal`.
 * @returns {Promise<string>} the ticket.
 * @throws {ApiError} classified by the standard taxonomy.
 */
export async function requestTicket(options = {}) {
  // Bound for the same reason the other transports are: a native `fetch` needs a global receiver,
  // and the Android WebView enforces it where desktop engines were permissive.
  const fetchImpl = options.fetchImpl
    ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  if (fetchImpl === null) throw new ApiError(ERROR_KIND.NETWORK);

  const headers = { accept: 'application/json' };
  if (typeof options.credential === 'string' && options.credential.length > 0) {
    // The credential travels ONLY here, as a header. Never in the URL.
    headers.authorization = `Bearer ${options.credential}`;
  }

  const body = {};
  if (typeof options.sessionId === 'string' && options.sessionId.length > 0) {
    body.session_id = options.sessionId;
  }
  headers['content-type'] = 'application/json';

  let response;
  try {
    response = await fetchImpl(`${options.baseUrl ?? ''}${TICKET_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (cause) {
    throw errorFromThrow(cause);
  }

  if (response.ok !== true) throw errorFromStatus(response.status);

  let parsed;
  try {
    parsed = await response.json();
  } catch {
    throw new ApiError(ERROR_KIND.SERVER, { status: response.status });
  }

  // The response envelope is unwrapped tolerantly, but the ticket itself is never inspected
  // beyond "is it a usable string".
  const ticket = extractTicket(parsed);
  if (ticket === null) throw new ApiError(ERROR_KIND.SERVER, { status: response.status });
  return ticket;
}

/**
 * Find the ticket in a response envelope.
 *
 * @param {unknown} parsed - the parsed body.
 * @returns {string|null} the ticket.
 */
function extractTicket(parsed) {
  if (parsed === null || typeof parsed !== 'object') return null;
  const candidates = [parsed.ticket, parsed.data?.ticket];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

/**
 * Build the WebSocket URL for one session.
 *
 * **Only the one-time ticket may appear in this URL.** The Phone credential, a launch token, an
 * `Authorization` value and a `dsh-auth` cookie are all forbidden here, and a test asserts it.
 *
 * The scheme must be `ws:`/`wss:`. `new URL('/api/v1/events', origin)` inherits the page's `http:`
 * scheme, and passing that to the `WebSocket` constructor is a specification violation. Desktop
 * engines were lenient enough to accept it; the Android WebView enforces the spec and throws
 * `SyntaxError: The URL's scheme must be either 'ws' or 'wss'. 'http' is not allowed.` The scheme
 * is therefore converted explicitly rather than relying on the engine to be forgiving.
 *
 * @param {object} input - `baseUrl`, `sessionId`, `ticket`, `lastSequence`.
 * @returns {string} the URL.
 */
export function buildEventsUrl(input) {
  const base = input.baseUrl ?? '';
  // A relative base resolves against the page origin, which keeps the socket same-origin and
  // inside `connect-src 'self'`.
  const origin = base.length > 0 ? base : (globalThis.location?.origin ?? 'http://localhost');
  const url = new URL('/api/v1/events', origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', input.ticket);
  url.searchParams.set('session_id', input.sessionId);
  if (typeof input.lastSequence === 'number' && Number.isSafeInteger(input.lastSequence)) {
    url.searchParams.set('last_sequence', String(input.lastSequence));
  }
  return url.toString();
}

/**
 * Redact a ticket-bearing URL for any diagnostic string.
 *
 * Returns the URL with the ticket replaced, so a log line can carry the shape of a request
 * without carrying the secret.
 *
 * @param {string} url - the full URL.
 * @returns {string} a safe description.
 */
export function redactTicketUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('ticket')) parsed.searchParams.set('ticket', '[redacted]');
    return parsed.toString();
  } catch {
    return '[unparseable-url]';
  }
}
