/**
 * Response envelope and request-id rules — Phase R3 §8, §9, §10, §11.
 *
 * One success shape and one error shape, both JSON, both UTF-8, both carrying the
 * API version once at the top level rather than on every nested object.
 *
 * `request_id` is server-generated and is deliberately **not** the same thing as
 * `client_message_id`, the DSH `requestId`, a Gateway event sequence, or a DSH
 * source sequence. §11 requires those five to stay distinct.
 */

import { randomUUID } from 'node:crypto';

import { ApiError, HTTP_STATUS } from './errors.mjs';

/** The only response content type this API emits. */
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * Generate a server request id.
 *
 * @returns {string} a fresh UUID.
 */
export function newRequestId() {
  return randomUUID();
}

/**
 * Read a client-supplied `X-Request-Id`.
 *
 * §11: the value is **not** trusted as a unique identity. It is retained only as
 * `client_request_id` for diagnostics, and the server still generates its own.
 *
 * @param {unknown} headerValue - the raw header.
 * @returns {string|null} a safe echo value, or `null`.
 */
export function readClientRequestId(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const trimmed = headerValue.trim();
  // Bound the length and allow only characters that cannot smuggle control codes.
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Build a success envelope.
 *
 * @param {unknown} data - the resource or collection.
 * @param {object} [options] - envelope options.
 * @param {object} [options.page] - pagination block for a collection.
 * @returns {object} the body.
 */
export function successEnvelope(data, options = {}) {
  return {
    api_version: 1,
    data,
    ...(options.page === undefined ? {} : { page: options.page }),
  };
}

/**
 * Write a JSON response.
 *
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - the body to serialise.
 * @param {object} [options] - write options.
 * @param {Record<string, string>} [options.headers] - extra headers.
 * @returns {void}
 */
export function writeJson(res, status, body, options = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_CONTENT_TYPE,
    'content-length': Buffer.byteLength(payload),
    // Loopback API responses are per-request facts; never cache them.
    'cache-control': 'no-store',
    ...options.headers,
  });
  res.end(payload);
}

/**
 * Write a success envelope.
 *
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {unknown} data - the payload.
 * @param {object} [options] - envelope options.
 * @param {number} [options.status] - HTTP status (default 200).
 * @param {object} [options.page] - pagination block.
 * @returns {void}
 */
export function writeSuccess(res, data, options = {}) {
  writeJson(res, options.status ?? HTTP_STATUS.OK, successEnvelope(data, { page: options.page }));
}

/**
 * Write an error envelope.
 *
 * Never emits a stack, a `cause`, a DSH cookie, a launch token, an
 * `Authorization` value, or a raw internal message (§10).
 *
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {ApiError} error - the error.
 * @param {string} requestId - the server request id.
 * @returns {void}
 */
export function writeError(res, error, requestId) {
  writeJson(res, error.status, error.toEnvelope(requestId), { headers: error.headers });
}
