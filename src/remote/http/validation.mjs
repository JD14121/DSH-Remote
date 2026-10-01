/**
 * Query, parameter and body validation — Phase R3 §15, §17, §30.
 *
 * Strict by design (§30): a duplicate query parameter is a **400**, not a silent
 * first-wins, and an unknown query key is rejected rather than ignored. A loose
 * contract is a contract that breaks later.
 */

import { API_ERROR, HTTP_STATUS, apiError } from './errors.mjs';
import { ALLOWED_PROMPT_MODES, MAX_PAGE_LIMIT } from './config.mjs';

/**
 * A DSH session id.
 *
 * Audited grammar from the installed DSH: every id observed is
 * `session-<uuid>`. §15 recommends accepting the observed shape and rejecting
 * malformed ids even though a session id is not a filesystem path.
 */
const SESSION_ID_PATTERN = /^session-[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

/** Characters a client-message id may contain (§17.2). */
const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** Maximum accepted client-message id length. */
export const MAX_CLIENT_MESSAGE_ID_LENGTH = 128;

/** Maximum accepted text length for one prompt part. */
export const MAX_TEXT_LENGTH = 262_144;

/**
 * Validate and normalise a session id from a URL path segment.
 *
 * Rejects traversal, backslashes, NUL, control characters and anything outside
 * the audited grammar, so a malformed id fails here rather than reaching DSH.
 *
 * @param {unknown} value - the decoded path parameter.
 * @returns {string} the validated session id.
 * @throws {ApiError} `400 INVALID_SESSION_ID`.
 */
export function validateSessionId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_SESSION_ID, 'A session id is required.');
  }
  // Explicit traversal/control rejection, even though the pattern below already
  // excludes them: the intent stays visible and the error is specific.
  if (/[\u0000-\u001f\u007f]/.test(value) || value.includes('..') || value.includes('/') || value.includes('\\')) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_SESSION_ID, 'Session id contains illegal characters.');
  }
  if (!SESSION_ID_PATTERN.test(value)) {
    throw apiError(
      HTTP_STATUS.BAD_REQUEST,
      API_ERROR.INVALID_SESSION_ID,
      'Session id does not match the expected form.',
      { details: { field: 'sessionId' } },
    );
  }
  return value;
}

/**
 * Parse a URL query with strict rules.
 *
 * @param {URLSearchParams} searchParams - the request query.
 * @param {object} options - parsing rules.
 * @param {readonly string[]} options.allowed - the only permitted keys.
 * @returns {Record<string, string>} one value per allowed key.
 * @throws {ApiError} `400` for a duplicate or unknown key.
 */
export function parseStrictQuery(searchParams, options) {
  const allowed = new Set(options.allowed);
  /** @type {Record<string, string>} */
  const out = {};

  for (const key of new Set(searchParams.keys())) {
    if (!allowed.has(key)) {
      throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_QUERY, `Unknown query parameter ${JSON.stringify(key)}.`, {
        details: { field: key },
      });
    }
    const values = searchParams.getAll(key);
    if (values.length > 1) {
      throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_QUERY, `Query parameter ${JSON.stringify(key)} was repeated.`, {
        details: { field: key },
      });
    }
    out[key] = values[0];
  }

  return out;
}

/**
 * Parse a bounded `limit` query parameter.
 *
 * @param {unknown} value - the raw value.
 * @param {object} options - bounds.
 * @param {number} options.defaultLimit - used when absent.
 * @param {number} options.maxLimit - the inclusive ceiling.
 * @returns {number} the resolved limit.
 * @throws {ApiError} `400 INVALID_QUERY`.
 */
export function parseLimit(value, options) {
  if (value === undefined) return options.defaultLimit;
  if (typeof value !== 'string' || value.length === 0) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_QUERY, 'limit must be an integer.', {
      details: { field: 'limit' },
    });
  }
  if (!/^\d+$/.test(value)) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_QUERY, 'limit must be a non-negative integer.', {
      details: { field: 'limit' },
    });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > options.maxLimit) {
    throw apiError(
      HTTP_STATUS.BAD_REQUEST,
      API_ERROR.INVALID_QUERY,
      `limit must be between 1 and ${options.maxLimit}.`,
      { details: { field: 'limit', limit: options.maxLimit } },
    );
  }
  return parsed;
}

/**
 * Parse a non-negative sequence query parameter.
 *
 * These are **DSH durable cursors**, not Gateway event sequences (§16).
 *
 * @param {unknown} value - the raw value.
 * @param {string} field - the parameter name, for errors.
 * @returns {number|undefined} the parsed value, or `undefined` when absent.
 * @throws {ApiError} `400 INVALID_QUERY`.
 */
export function parseSequenceParam(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_QUERY, `${field} must be a non-negative integer.`, {
      details: { field },
    });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_QUERY, `${field} is out of range.`, {
      details: { field },
    });
  }
  return parsed;
}

/**
 * Validate a prompt mode.
 *
 * @param {unknown} value - the requested mode.
 * @param {object} config - resolved configuration.
 * @param {string} config.defaultPromptMode - used when the client omits `mode`.
 * @returns {string} the mode to use.
 * @throws {ApiError} `400 INVALID_PROMPT_MODE`.
 */
export function resolvePromptMode(value, config) {
  if (value === undefined || value === null) return config.defaultPromptMode;
  if (typeof value !== 'string' || !ALLOWED_PROMPT_MODES.includes(value)) {
    throw apiError(
      HTTP_STATUS.BAD_REQUEST,
      API_ERROR.INVALID_PROMPT_MODE,
      `mode must be one of ${ALLOWED_PROMPT_MODES.join(', ')}.`,
      { details: { mode: typeof value === 'string' ? value : null } },
    );
  }
  return value;
}

/**
 * Validate a `client_message_id`.
 *
 * §17.2: required, non-empty, bounded, safe characters. It is **not** forced to
 * be a UUID, because R1 established no such client contract.
 *
 * @param {unknown} value - the candidate id.
 * @returns {string} the validated id.
 * @throws {ApiError} `400 CLIENT_MESSAGE_ID_REQUIRED`.
 */
export function validateClientMessageId(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw apiError(
      HTTP_STATUS.BAD_REQUEST,
      API_ERROR.CLIENT_MESSAGE_ID_REQUIRED,
      'client_message_id is required.',
      { details: { field: 'client_message_id' } },
    );
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_CLIENT_MESSAGE_ID_LENGTH || !CLIENT_MESSAGE_ID_PATTERN.test(trimmed)) {
    throw apiError(
      HTTP_STATUS.BAD_REQUEST,
      API_ERROR.CLIENT_MESSAGE_ID_REQUIRED,
      'client_message_id contains unsupported characters or is too long.',
      { details: { field: 'client_message_id' } },
    );
  }
  return trimmed;
}

/**
 * Validate prompt content.
 *
 * Accepts a plain string (shorthand for one text part) or an array of
 * `PromptContentPart`-shaped objects, preserving R1's contract (§17). A
 * Gateway-level `{ type: 'attachment', attachment_id }` part is translated into
 * the DSH `{ type: 'file', receiptId }` part the adapter expects, since the
 * receipt is exactly what the upload returned.
 *
 * @param {unknown} content - the client content.
 * @returns {object[]} DSH-shaped content parts.
 * @throws {ApiError} `400 INVALID_PROMPT_CONTENT`.
 */
export function validatePromptContent(content) {
  if (typeof content === 'string') {
    if (content.trim().length === 0) {
      throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_PROMPT_CONTENT, 'content must not be empty.');
    }
    if (content.length > MAX_TEXT_LENGTH) {
      throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_PROMPT_CONTENT, 'content is too long.');
    }
    return [{ type: 'text', text: content }];
  }

  if (!Array.isArray(content) || content.length === 0) {
    throw apiError(
      HTTP_STATUS.BAD_REQUEST,
      API_ERROR.INVALID_PROMPT_CONTENT,
      'content must be a non-empty string or an array of content parts.',
    );
  }

  const parts = content.map((part, index) => {
    if (part === null || typeof part !== 'object' || Array.isArray(part)) {
      throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_PROMPT_CONTENT, `content[${index}] must be an object.`);
    }
    switch (part.type) {
      case 'text': {
        if (typeof part.text !== 'string') {
          throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_PROMPT_CONTENT, `content[${index}].text must be a string.`);
        }
        if (part.text.length > MAX_TEXT_LENGTH) {
          throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_PROMPT_CONTENT, `content[${index}].text is too long.`);
        }
        return { type: 'text', text: part.text };
      }
      case 'image': {
        if (typeof part.mediaType !== 'string' || typeof part.data !== 'string') {
          throw apiError(
            HTTP_STATUS.BAD_REQUEST,
            API_ERROR.INVALID_PROMPT_CONTENT,
            `content[${index}] image requires mediaType and data.`,
          );
        }
        return {
          type: 'image',
          mediaType: part.mediaType,
          data: part.data,
          ...(typeof part.name === 'string' ? { name: part.name } : {}),
        };
      }
      case 'file': {
        if (typeof part.receiptId !== 'string' || part.receiptId.length === 0) {
          throw apiError(
            HTTP_STATUS.BAD_REQUEST,
            API_ERROR.INVALID_PROMPT_CONTENT,
            `content[${index}] file requires a receiptId.`,
          );
        }
        return { type: 'file', receiptId: part.receiptId };
      }
      case 'attachment': {
        // The Gateway-facing spelling. An upload returned `attachment_id`; that
        // value IS the DSH receipt, so the translation is an identity, not a map.
        if (typeof part.attachment_id !== 'string' || part.attachment_id.length === 0) {
          throw apiError(
            HTTP_STATUS.BAD_REQUEST,
            API_ERROR.INVALID_PROMPT_CONTENT,
            `content[${index}] attachment requires an attachment_id.`,
          );
        }
        return { type: 'file', receiptId: part.attachment_id };
      }
      default:
        throw apiError(
          HTTP_STATUS.BAD_REQUEST,
          API_ERROR.INVALID_PROMPT_CONTENT,
          `content[${index}] has an unsupported type.`,
        );
    }
  });

  const hasText = parts.some((part) => part.type === 'text' && part.text.trim().length > 0);
  const hasAttachment = parts.some((part) => part.type === 'image' || part.type === 'file');
  if (!hasText && !hasAttachment) {
    throw apiError(
      HTTP_STATUS.BAD_REQUEST,
      API_ERROR.INVALID_PROMPT_CONTENT,
      'content carries neither non-whitespace text nor an attachment.',
    );
  }

  return parts;
}

/**
 * Normalise an upload filename.
 *
 * §26 requires basename-only, with traversal and control characters rejected.
 *
 * @param {unknown} value - the client-supplied name.
 * @returns {string} a safe display name.
 * @throws {ApiError} `400 UPLOAD_INVALID_FILENAME`.
 */
export function normaliseUploadFilename(value) {
  if (value === undefined || value === null || value === '') return 'upload';
  if (typeof value !== 'string') {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.UPLOAD_INVALID_FILENAME, 'Filename must be a string.');
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) return 'upload';
  if (trimmed.length > 255) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.UPLOAD_INVALID_FILENAME, 'Filename is too long.');
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.UPLOAD_INVALID_FILENAME, 'Filename contains control characters.');
  }
  // Reject any traversal or separator rather than silently stripping it: a
  // client sending a path is doing something the API does not support.
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    throw apiError(
      HTTP_STATUS.BAD_REQUEST,
      API_ERROR.UPLOAD_INVALID_FILENAME,
      'Filename must be a bare name with no path separators.',
    );
  }
  if (trimmed === '.' ) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.UPLOAD_INVALID_FILENAME, 'Filename is not usable.');
  }

  return trimmed;
}

/**
 * Validate a declared media type's *format*.
 *
 * §26 requires MIME format validation. R3 checks the syntactic form only and lets
 * DSH validate the actual bytes, because DSH infers the real type from content.
 *
 * @param {unknown} value - the declared media type.
 * @returns {string} the normalised media type.
 * @throws {ApiError} `400 UPLOAD_INVALID_MIME`.
 */
export function normaliseMediaType(value) {
  if (value === undefined || value === null || value === '') return 'application/octet-stream';
  if (typeof value !== 'string') {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.UPLOAD_INVALID_MIME, 'media_type must be a string.');
  }
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(trimmed)) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.UPLOAD_INVALID_MIME, 'media_type is not a valid MIME type.');
  }
  return trimmed;
}

export { MAX_PAGE_LIMIT };
