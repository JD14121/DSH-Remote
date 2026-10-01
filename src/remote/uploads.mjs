/**
 * Upload service — Phase R3 §25, §26.
 *
 * Bridges a Gateway-facing upload to DSH's raw-byte route through the adapter.
 * The wire itself was audited first; see `docs/r3-upload-evidence.md`.
 *
 * Two accepted request shapes:
 *
 *   `application/octet-stream`   raw bytes, name from `?name=`
 *   `multipart/form-data`        one file part, the shape §25 recommends
 *
 * Both end up as the same raw stream to DSH, because DSH accepts only
 * `application/octet-stream` (`dsh-client-file-upload`).
 *
 * R3 minimum safety, all from §26: a hard byte limit, basename-only filename
 * normalisation, traversal and control-character rejection, MIME *format*
 * validation, no client-supplied server path, and bounded buffering.
 *
 * This service holds **no** filesystem code. It never touches
 * `<DSH_HOME>/attachments`; writing there would bypass DSH's admission,
 * validation and normalisation, and is forbidden by §24.
 */

import { API_ERROR, HTTP_STATUS, apiError } from './http/errors.mjs';
import { isMultipart, multipartBoundary, normaliseFilename, parseMultipart } from './http/multipart.mjs';
import { readRawBody } from './http/request.mjs';
import {
  normaliseMediaType,
  normaliseUploadFilename,
} from './http/validation.mjs';

/**
 * Upload service.
 */
export class UploadService {
  /**
   * @param {object} options - service options.
   * @param {object} options.adapter - the `DshAdapter`.
   */
  constructor(options) {
    if (options?.adapter === undefined) throw new TypeError('UploadService requires an adapter');
    this.adapter = options.adapter;
  }

  /**
   * Whether this deployment can accept uploads at all.
   *
   * @returns {boolean} true when the adapter exposes the capability.
   */
  get available() {
    return typeof this.adapter.uploadFile === 'function';
  }

  /**
   * Receive one upload and return the Gateway-facing attachment facts.
   *
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {string} sessionId - the session the receipt is minted for.
   * @param {object} config - resolved HTTP config.
   * @param {number} config.maxUploadBytes - the inclusive byte ceiling.
   * @param {URLSearchParams} [searchParams] - query, for the raw-bytes shape.
   * @returns {Promise<object>} `{ attachment_id, name, media_type, size }`.
   * @throws {ApiError} on a malformed, over-large, or refused upload.
   */
  async receive(req, sessionId, config, searchParams) {
    if (!this.available) {
      // Fail visible rather than silently accepting something the host cannot
      // honour (§42).
      throw apiError(
        HTTP_STATUS.NOT_IMPLEMENTED,
        API_ERROR.UPLOAD_NOT_AVAILABLE,
        'Uploads are not available on this gateway.',
      );
    }

    const contentType = req.headers['content-type'];
    const bareType = parseMediaType(contentType);
    let filename;
    let mediaType;
    let bytes;

    if (bareType === 'multipart/form-data') {
      const boundary = multipartBoundary(contentType);
      const body = await readRawBody(req, { maxBytes: config.maxUploadBytes });
      const part = parseMultipart(body, boundary);
      // Both checks run: the client-facing rules, then a defensive basename pass.
      filename = normaliseFilename(normaliseUploadFilename(part.filename));
      mediaType = normaliseMediaType(part.contentType ?? 'application/octet-stream');
      bytes = part.data;
    } else if (bareType === 'application/octet-stream') {
      // Mirrors DSH's own route shape: raw bytes, name supplied separately.
      bytes = await readRawBody(req, { maxBytes: config.maxUploadBytes });
      const declared = searchParams?.get('name') ?? undefined;
      filename = normaliseFilename(normaliseUploadFilename(declared));
      mediaType = 'application/octet-stream';
    } else {
      throw apiError(
        HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE,
        API_ERROR.UNSUPPORTED_MEDIA_TYPE,
        'Uploads must be application/octet-stream or multipart/form-data.',
      );
    }

    if (bytes.length === 0) {
      throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.UPLOAD_MISSING_FILE, 'The upload contained no bytes.');
    }

    let result;
    try {
      // The adapter streams the bytes to DSH; nothing is written to disk here.
      result = await this.adapter.uploadFile(sessionId, { chunks: [bytes], name: filename });
    } catch (error) {
      // A refusal from DSH is surfaced, never swallowed. The adapter error is
      // mapped centrally; its message never reaches the client verbatim.
      throw error;
    }

    return {
      // The DSH receipt. It is session-scoped, so a client must upload through
      // the same session it will prompt.
      attachment_id: result.receiptId,
      name: result.file?.name ?? filename,
      media_type: result.file?.mediaType ?? mediaType,
      size: typeof result.file?.bytes === 'number' ? result.file.bytes : bytes.length,
    };
  }
}

/**
 * Read the bare media type from a header value.
 *
 * @param {unknown} value - the header.
 * @returns {string} the lowercased type, without parameters.
 */
function parseMediaType(value) {
  if (typeof value !== 'string') return '';
  return value.split(';', 1)[0].trim().toLowerCase();
}
