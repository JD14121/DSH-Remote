/**
 * Gateway-side pagination — Phase R3 §14.
 *
 * DSH's `session/list` returns every session on one call (R1 confirmed that its
 * declared `cursor` field is ignored), so bounding and paging happen **here**.
 *
 * The cursor is opaque: base64url-encoded JSON. It is a *best-effort in-memory
 * list cursor*, not a durable snapshot (§14). If the underlying list changes
 * between pages the window can shift slightly; that is a documented limitation,
 * not a defect, and R5 does not fix it.
 *
 * The message cursor is a different thing entirely: it carries a **DSH durable
 * sequence**, never a Gateway event sequence (§16).
 */

import { API_ERROR, HTTP_STATUS, apiError } from './errors.mjs';

/** Cursor format version, so an old cursor fails loudly rather than silently. */
export const CURSOR_VERSION = 1;

/** The only session-list sort implemented. */
export const SESSION_SORT = 'updated_desc_id_asc';

/**
 * Encode a cursor payload as an opaque base64url token.
 *
 * @param {object} payload - the cursor contents.
 * @returns {string} the opaque token.
 */
export function encodeCursor(payload) {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, ...payload }), 'utf8').toString('base64url');
}

/**
 * Decode an opaque cursor token.
 *
 * @param {unknown} value - the token.
 * @returns {object} the decoded payload.
 * @throws {ApiError} `400 INVALID_CURSOR` for anything unrecognised.
 */
export function decodeCursor(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_CURSOR, 'cursor must be a non-empty string.');
  }
  if (value.length > 512) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_CURSOR, 'cursor is too long.');
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_CURSOR, 'cursor is not a valid token.');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_CURSOR, 'cursor payload is malformed.');
  }
  if (parsed.v !== CURSOR_VERSION) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_CURSOR, 'cursor version is not supported.');
  }
  if (!Number.isSafeInteger(parsed.offset) || parsed.offset < 0) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_CURSOR, 'cursor offset is malformed.');
  }
  if (parsed.sort !== SESSION_SORT) {
    throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_CURSOR, 'cursor sort is not supported.');
  }
  return parsed;
}

/**
 * Deterministic session ordering: `updated_at DESC`, then `id ASC`, with a null
 * `updated_at` last.
 *
 * `updated_at` is an ISO 8601 string on the domain session. Comparing strings
 * would be wrong for mixed offsets, so it is parsed to epoch millis first.
 *
 * @param {object} left - a session view.
 * @param {object} right - a session view.
 * @returns {number} the comparator result.
 */
export function compareSessions(left, right) {
  const leftTime = left?.updated_at === null || left?.updated_at === undefined
    ? Number.NEGATIVE_INFINITY
    : Date.parse(left.updated_at);
  const rightTime = right?.updated_at === null || right?.updated_at === undefined
    ? Number.NEGATIVE_INFINITY
    : Date.parse(right.updated_at);

  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);
  // A session with no usable timestamp sorts last, regardless of direction.
  if (leftValid !== rightValid) return leftValid ? -1 : 1;
  if (leftValid && leftTime !== rightTime) return rightTime - leftTime;

  return String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
}

/**
 * Sort sessions deterministically.
 *
 * @param {readonly object[]} sessions - the session views.
 * @returns {object[]} a new, sorted array.
 */
export function sortSessions(sessions) {
  return [...sessions].sort(compareSessions);
}

/**
 * Page a session list.
 *
 * @param {readonly object[]} sessions - all known session views.
 * @param {object} options - page options.
 * @param {number} options.limit - page size, already validated.
 * @param {string} [options.cursor] - an opaque cursor from a previous page.
 * @returns {{items: object[], page: object}} the page and its metadata.
 * @throws {ApiError} `400 INVALID_CURSOR`.
 */
export function paginateSessions(sessions, options) {
  const sorted = sortSessions(sessions);
  const offset = options.cursor === undefined ? 0 : decodeCursor(options.cursor).offset;
  const items = sorted.slice(offset, offset + options.limit);
  const nextOffset = offset + items.length;
  const hasMore = nextOffset < sorted.length;

  return {
    items,
    page: {
      limit: options.limit,
      returned: items.length,
      total: sorted.length,
      has_more: hasMore,
      next_cursor: hasMore
        ? encodeCursor({ offset: nextOffset, sort: SESSION_SORT })
        : null,
    },
  };
}

/**
 * Build the message-history page block (§16).
 *
 * Every sequence here is a **DSH durable** cursor. The Gateway event sequence is
 * deliberately absent, because it is a realtime identity and has no meaning for
 * history.
 *
 * @param {object} input - page facts.
 * @param {number|null} input.throughSeq - the inclusive cut used.
 * @param {number|null} input.beforeSeq - the exclusive upper bound used.
 * @param {number|null} input.nextBeforeSeq - the DSH seq to request next.
 * @param {boolean} input.hasMore - whether older records remain.
 * @param {number} input.limit - the requested page size.
 * @param {number} input.returned - how many records came back.
 * @returns {object} the `page` block.
 */
export function messagePageBlock(input) {
  return {
    limit: input.limit,
    returned: input.returned,
    through_seq: input.throughSeq,
    before_seq: input.beforeSeq ?? null,
    next_before_seq: input.nextBeforeSeq,
    has_more: input.hasMore === true,
    // Names the sequence space explicitly so a client cannot confuse it with the
    // Gateway realtime sequence.
    sequence_kind: 'dsh_durable_source_sequence',
  };
}
