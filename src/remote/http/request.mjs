/**
 * Request parsing and limits — Phase R3 §27, §28.
 *
 * Two rules that must hold before any route logic runs:
 *
 *   - a JSON body larger than `maxJsonBytes` is refused with **413**, so the
 *     server never buffers an unbounded body (§27);
 *   - a JSON endpoint only accepts `application/json`, optionally with a
 *     `charset`, and refuses anything else with **415** (§28).
 */

import { API_ERROR, HTTP_STATUS, apiError } from './errors.mjs';

/** Media types accepted for JSON bodies. */
const JSON_MEDIA_TYPE = 'application/json';

/**
 * Normalise a content type: lowercase the type, keep the parameters.
 *
 * @param {unknown} value - the raw header.
 * @returns {{type: string, parameters: Record<string, string>}} parsed parts.
 */
export function parseContentType(value) {
  if (typeof value !== 'string' || value.length === 0) return { type: '', parameters: {} };
  const [rawType, ...rawParams] = value.split(';');
  const parameters = {};
  for (const raw of rawParams) {
    const index = raw.indexOf('=');
    if (index === -1) continue;
    const key = raw.slice(0, index).trim().toLowerCase();
    let paramValue = raw.slice(index + 1).trim();
    if (paramValue.startsWith('"') && paramValue.endsWith('"')) paramValue = paramValue.slice(1, -1);
    if (key.length > 0) parameters[key] = paramValue;
  }
  return { type: rawType.trim().toLowerCase(), parameters };
}

/**
 * Assert a request body is JSON of an acceptable content type.
 *
 * @param {unknown} headerValue - the `content-type` header.
 * @returns {void}
 * @throws {ApiError} `415` when the media type is unsupported, or `400` for a
 *   non-UTF-8 charset.
 */
export function assertJsonContentType(headerValue) {
  const { type, parameters } = parseContentType(headerValue);
  if (type !== JSON_MEDIA_TYPE) {
    throw apiError(
      HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE,
      API_ERROR.UNSUPPORTED_MEDIA_TYPE,
      'Request body must be application/json.',
      { details: { field: 'content-type' } },
    );
  }
  const charset = parameters.charset;
  if (charset !== undefined && charset.toLowerCase() !== 'utf-8' && charset.toLowerCase() !== 'utf8') {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_REQUEST, 'Only UTF-8 JSON is supported.', {
      details: { field: 'charset' },
    });
  }
}

/**
 * Read a request body with a hard byte ceiling.
 *
 * The stream is destroyed as soon as the limit is exceeded, so an oversized body
 * is never fully buffered.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {object} options - limits.
 * @param {number} options.maxBytes - the inclusive ceiling.
 * @returns {Promise<Buffer>} the body.
 * @throws {ApiError} `413` when the ceiling is exceeded.
 */
export async function readBoundedBody(req, options) {
  const maxBytes = options.maxBytes;
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw apiError(HTTP_STATUS.PAYLOAD_TOO_LARGE, API_ERROR.PAYLOAD_TOO_LARGE, 'Request body is too large.', {
      details: { limit: maxBytes },
    });
  }

  const chunks = [];
  let total = 0;

  try {
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxBytes) {
        // Stop reading immediately; do not accumulate the rest.
        req.destroy();
        throw apiError(
          HTTP_STATUS.PAYLOAD_TOO_LARGE,
          API_ERROR.PAYLOAD_TOO_LARGE,
          'Request body is too large.',
          { details: { limit: maxBytes } },
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error?.code === API_ERROR.PAYLOAD_TOO_LARGE) throw error;
    // A client that disconnects mid-body is a bad request, not a server fault.
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_REQUEST, 'Request body could not be read.');
  }

  return Buffer.concat(chunks, total);
}

/**
 * Read and parse a JSON body.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {object} options - limits.
 * @param {number} options.maxBytes - the inclusive ceiling.
 * @returns {Promise<object>} the parsed object.
 * @throws {ApiError} `415`, `413` or `400`.
 */
export async function readJsonBody(req, options) {
  assertJsonContentType(req.headers['content-type']);
  const buffer = await readBoundedBody(req, options);
  if (buffer.length === 0) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_REQUEST, 'A JSON body is required.');
  }

  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_REQUEST, 'Request body is not valid JSON.');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_REQUEST, 'JSON body must be an object.');
  }
  return parsed;
}

/**
 * Read a raw binary body with a ceiling.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {object} options - limits.
 * @param {number} options.maxBytes - the inclusive ceiling.
 * @returns {Promise<Buffer>} the body bytes.
 */
export async function readRawBody(req, options) {
  return readBoundedBody(req, options);
}

/**
 * Split an `X-Forwarded-*`-style trust decision.
 *
 * R3 §6: proxy headers are never trusted. This helper exists so the decision is
 * explicit and testable rather than implied by their absence.
 *
 * @returns {{trusted: false, reason: string}} always untrusted in R3.
 */
export function trustProxyHeaders() {
  return { trusted: false, reason: 'R3 does not support reverse proxies' };
}
