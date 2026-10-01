/**
 * Minimal multipart/form-data parser — Phase R3 §25, §26.
 *
 * §44 forbids pulling in Express/Fastify/Koa, and Node ships no multipart parser,
 * so this implements just enough of RFC 7578 for one file field. It is
 * deliberately small and strict rather than general:
 *
 *   - the body is already size-bounded by the caller, so parsing is bounded;
 *   - exactly one file part is accepted;
 *   - the part must declare a `filename`;
 *   - the filename is normalised and traversal is rejected by `validation.mjs`.
 */

import { API_ERROR, HTTP_STATUS, apiError } from './errors.mjs';
import { parseContentType } from './request.mjs';

/** A boundary must be a short token; anything else is rejected. */
const BOUNDARY_PATTERN = /^[A-Za-z0-9'()+_,\-./:=? ]{1,70}$/;

/**
 * Whether a content type is multipart/form-data.
 *
 * @param {unknown} headerValue - the `content-type` header.
 * @returns {boolean} true when the request is multipart.
 */
export function isMultipart(headerValue) {
  return parseContentType(headerValue).type === 'multipart/form-data';
}

/**
 * Extract the boundary from a multipart content type.
 *
 * @param {unknown} headerValue - the `content-type` header.
 * @returns {string} the boundary.
 * @throws {ApiError} `400` when the boundary is missing or malformed.
 */
export function multipartBoundary(headerValue) {
  const { parameters } = parseContentType(headerValue);
  const boundary = parameters.boundary;
  if (typeof boundary !== 'string' || boundary.length === 0) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_REQUEST, 'multipart body is missing a boundary.');
  }
  if (!BOUNDARY_PATTERN.test(boundary)) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_REQUEST, 'multipart boundary is malformed.');
  }
  return boundary;
}

/**
 * Find the position of a byte sequence inside a buffer.
 *
 * @param {Buffer} haystack - buffer to search.
 * @param {Buffer} needle - bytes to find.
 * @param {number} from - start offset.
 * @returns {number} the index, or `-1`.
 */
function indexOfBytes(haystack, needle, from) {
  return haystack.indexOf(needle, from);
}

/**
 * Parse the header block of one part into a map.
 *
 * @param {Buffer} headerBytes - the raw header block.
 * @returns {Record<string, string>} lowercased header names to values.
 */
function parsePartHeaders(headerBytes) {
  /** @type {Record<string, string>} */
  const headers = {};
  for (const line of headerBytes.toString('utf8').split('\r\n')) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (name.length > 0) headers[name] = value;
  }
  return headers;
}

/**
 * Extract a `name="..."` parameter from a `Content-Disposition` header.
 *
 * @param {unknown} disposition - the header value.
 * @param {string} parameter - the parameter to read.
 * @returns {string|null} the value, or `null`.
 */
export function dispositionParam(disposition, parameter) {
  if (typeof disposition !== 'string') return null;
  const pattern = new RegExp(`${parameter}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i');
  const match = pattern.exec(disposition);
  if (match === null) return null;
  return match[1] ?? match[2] ?? null;
}

/**
 * Parse a multipart body containing exactly one file part.
 *
 * @param {Buffer} body - the raw request body.
 * @param {string} boundary - the multipart boundary.
 * @returns {{filename: string|null, contentType: string|null, data: Buffer}} the file part.
 * @throws {ApiError} `400` when the body is malformed, or 404-style `UPLOAD_MISSING_FILE`.
 */
export function parseMultipart(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`, 'utf8');
  const crlf = Buffer.from('\r\n', 'utf8');
  const headerTerminator = Buffer.from('\r\n\r\n', 'utf8');

  let cursor = indexOfBytes(body, delimiter, 0);
  if (cursor === -1) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_REQUEST, 'multipart body does not start with its boundary.');
  }

  let found = null;

  while (cursor !== -1) {
    let partStart = cursor + delimiter.length;

    // `--` immediately after the delimiter closes the body.
    if (body.length >= partStart + 2 && body[partStart] === 0x2d && body[partStart + 1] === 0x2d) break;

    // Skip the CRLF that follows the delimiter.
    if (body.length >= partStart + 2 && body[partStart] === 0x0d && body[partStart + 1] === 0x0a) {
      partStart += 2;
    }

    const headerEnd = indexOfBytes(body, headerTerminator, partStart);
    if (headerEnd === -1) {
      throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_REQUEST, 'multipart part headers are malformed.');
    }

    const headers = parsePartHeaders(body.subarray(partStart, headerEnd));
    const dataStart = headerEnd + headerTerminator.length;
    const nextDelimiter = indexOfBytes(body, delimiter, dataStart);
    if (nextDelimiter === -1) {
      throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_REQUEST, 'multipart part is not terminated.');
    }

    // The CRLF before the next delimiter belongs to the framing, not the data.
    let dataEnd = nextDelimiter;
    if (dataEnd >= 2 && body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2;

    const filename = dispositionParam(headers['content-disposition'], 'filename');
    if (filename !== null && found === null) {
      found = {
        filename,
        contentType: headers['content-type'] ?? null,
        data: Buffer.from(body.subarray(dataStart, dataEnd)),
      };
    }

    cursor = nextDelimiter;
  }

  if (found === null) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.UPLOAD_MISSING_FILE, 'multipart body contained no file part.');
  }
  return found;
}

/**
 * Normalise a filename to a safe bare basename.
 *
 * Exported for the validation tests; the route calls
 * `validation.normaliseUploadFilename` for the client-facing checks and this for
 * the final defensive pass.
 *
 * @param {unknown} filename - the raw filename.
 * @returns {string} a safe basename.
 */
export function normaliseFilename(filename) {
  if (typeof filename !== 'string' || filename.length === 0) return 'upload';
  // Take the last path segment for either separator, then strip a leading dot-run.
  const segments = filename.split(/[/\\]/);
  let base = segments[segments.length - 1] ?? 'upload';
  base = base.replace(/^\.+/, '');
  base = base.replace(/[\u0000-\u001f\u007f]/g, '');
  base = base.trim();
  return base.length === 0 ? 'upload' : base.slice(0, 255);
}
