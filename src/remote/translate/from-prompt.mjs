/**
 * Prompt translation: mobile-shaped message -> DSH `SessionPromptRequest` — R1 §10.
 *
 * The one identity that matters:
 *
 *   client_message_id  ->  requestId
 *
 * R1 §10 forbids generating a second idempotency key. DSH is the dedupe
 * authority: a duplicate `requestId` that is already queued or already logged
 * returns the original acceptance without inserting another message. So the
 * adapter must pass the caller's id straight through, unchanged.
 *
 * R1 also refuses to invent product policy: if the caller does not state a mode,
 * this module throws rather than defaulting to queue or steer. R3/UI decides the
 * default later.
 */

import { AdapterError, ADAPTER_ERROR } from '../adapter-errors.mjs';
import { redactValue } from '../redact.mjs';

/** Prompt modes DSH accepts. */
export const PROMPT_MODE = Object.freeze({ QUEUE: 'queue', STEER: 'steer' });

/** Additional adapter code raised by this module (not part of the R1 §5.2 list). */
export const INVALID_PROMPT_MODE = 'INVALID_PROMPT_MODE';

/** Additional adapter code raised when content is unusable. */
export const INVALID_PROMPT_CONTENT = 'INVALID_PROMPT_CONTENT';

/**
 * Whether a value looks like a client-minted message id.
 *
 * Deliberately permissive: DSH brands `SessionRequestId` as an opaque string and
 * imposes no format, so R1 must not add one. The check exists only to reject an
 * empty or non-string value.
 *
 * @param {unknown} value - candidate id.
 * @returns {boolean} true when usable as a requestId.
 */
export function isClientMessageId(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Normalize one content part.
 *
 * Accepted shapes mirror DSH's `PromptContentPart` without redefining it:
 *   { type: 'text',  text }
 *   { type: 'image', mediaType, data, name? }
 *   { type: 'file',  receiptId }
 *
 * @param {unknown} part - candidate part.
 * @param {number} index - position, for error messages.
 * @returns {object} a wire-ready content part.
 * @throws {AdapterError} `INVALID_PROMPT_CONTENT` when unusable.
 */
function normalizeContentPart(part, index) {
  if (part === null || typeof part !== 'object' || Array.isArray(part)) {
    throw new AdapterError(
      INVALID_PROMPT_CONTENT,
      `content[${index}] must be an object`,
    );
  }
  switch (part.type) {
    case 'text':
      if (typeof part.text !== 'string') {
        throw new AdapterError(INVALID_PROMPT_CONTENT, `content[${index}].text must be a string`);
      }
      return { type: 'text', text: part.text };
    case 'image':
      if (typeof part.mediaType !== 'string' || typeof part.data !== 'string') {
        throw new AdapterError(
          INVALID_PROMPT_CONTENT,
          `content[${index}] image requires mediaType and data`,
        );
      }
      return {
        type: 'image',
        mediaType: part.mediaType,
        data: part.data,
        ...(typeof part.name === 'string' ? { name: part.name } : {}),
      };
    case 'file':
      if (typeof part.receiptId !== 'string' || part.receiptId.length === 0) {
        throw new AdapterError(
          INVALID_PROMPT_CONTENT,
          `content[${index}] file requires a receiptId from a preceding upload`,
        );
      }
      return { type: 'file', receiptId: part.receiptId };
    default:
      throw new AdapterError(
        INVALID_PROMPT_CONTENT,
        `content[${index}] has an unsupported type ${JSON.stringify(part.type)}`,
      );
  }
}

/**
 * Build a DSH `SessionPromptRequest` from a mobile-shaped message.
 *
 * @param {object} input - prompt input.
 * @param {string} input.sessionId - target DSH session.
 * @param {string} input.client_message_id - caller-minted idempotency identity.
 * @param {Array<object>|string} input.content - content parts, or a plain string.
 * @param {'queue'|'steer'} input.mode - explicit delivery mode; required.
 * @param {string} [input.clientTimeZone] - optional IANA time zone.
 * @returns {{sessionId: string, requestId: string, mode: string, content: object[], clientTimeZone?: string}}
 *   the wire-ready request.
 * @throws {AdapterError} `INVALID_PROMPT_MODE`, `INVALID_PROMPT_CONTENT`, or `PROMPT_REJECTED`.
 */
export function buildPromptRequest(input) {
  if (input === null || typeof input !== 'object') {
    throw new AdapterError(ADAPTER_ERROR.PROMPT_REJECTED, 'prompt input must be an object');
  }

  const { sessionId } = input;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new AdapterError(ADAPTER_ERROR.SESSION_NOT_FOUND, 'prompt requires a sessionId');
  }

  if (!isClientMessageId(input.client_message_id)) {
    throw new AdapterError(
      ADAPTER_ERROR.PROMPT_REJECTED,
      'prompt requires a non-empty client_message_id; the adapter does not mint one',
    );
  }

  if (input.mode === undefined || input.mode === null) {
    throw new AdapterError(
      INVALID_PROMPT_MODE,
      'prompt requires an explicit mode of "queue" or "steer"; the adapter does not choose product policy',
    );
  }
  if (input.mode !== PROMPT_MODE.QUEUE && input.mode !== PROMPT_MODE.STEER) {
    throw new AdapterError(
      INVALID_PROMPT_MODE,
      `prompt mode must be "queue" or "steer", received ${JSON.stringify(input.mode)}`,
    );
  }

  const rawContent = typeof input.content === 'string' ? [{ type: 'text', text: input.content }] : input.content;
  if (!Array.isArray(rawContent) || rawContent.length === 0) {
    throw new AdapterError(ADAPTER_ERROR.PROMPT_REJECTED, 'prompt content must be a non-empty array or string');
  }

  const content = rawContent.map((part, index) => normalizeContentPart(part, index));

  // Mirror DSH's own admission rule so a hopeless prompt fails locally with a
  // clear code instead of a round trip: content needs text or an attachment.
  const hasText = content.some((part) => part.type === 'text' && part.text.trim().length > 0);
  const hasAttachment = content.some((part) => part.type === 'image' || part.type === 'file');
  if (!hasText && !hasAttachment) {
    throw new AdapterError(
      ADAPTER_ERROR.PROMPT_REJECTED,
      'prompt content carries neither non-whitespace text nor an attachment',
    );
  }

  return {
    sessionId,
    requestId: input.client_message_id,
    mode: input.mode,
    content,
    ...(typeof input.clientTimeZone === 'string' && input.clientTimeZone.length > 0
      ? { clientTimeZone: input.clientTimeZone }
      : {}),
  };
}

/**
 * Describe a prompt for logging or reporting without exposing its text.
 *
 * R1 §23 forbids persisting a real user prompt in a fixture or a report.
 *
 * @param {object} request - a built prompt request.
 * @returns {object} a redacted shape summary.
 */
export function describePromptRequest(request) {
  return {
    sessionId: request.sessionId,
    requestId: request.requestId,
    mode: request.mode,
    partCount: request.content.length,
    partTypes: request.content.map((part) => part.type),
    approximateTextLength: request.content
      .filter((part) => part.type === 'text')
      .reduce((total, part) => total + part.text.length, 0),
  };
}

/**
 * Redact a prompt request for safe embedding.
 *
 * @param {object} request - a built prompt request.
 * @returns {object} the request with text and binary payloads removed.
 */
export function redactPromptRequest(request) {
  return redactValue({
    ...request,
    content: request.content.map((part) => {
      if (part.type === 'text') return { type: 'text', text: '[redacted]' };
      if (part.type === 'image') return { type: 'image', mediaType: part.mediaType, data: '[redacted]' };
      return { type: 'file', receiptId: '[redacted]' };
    }),
  });
}
