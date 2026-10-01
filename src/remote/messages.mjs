/**
 * Messages service —Phase R2 §19.
 *
 * ```text
 * adapter.getMessages()  ->  domain Message[]
 * ```
 *
 * Requirements (§19): deterministic ids, stable ordering, role/type
 * normalization, no silent drop, no zstd read, pagination metadata preserved, and
 * DSH source sequence kept distinct from the Gateway event sequence.
 *
 * It reaches DSH only through the adapter contract, so it never names an endpoint
 * and never imports `wire/`.
 */

import { isRecord } from './model/guards.mjs';
import {
  MESSAGE_TYPE,
  isMessageIdStable,
  toAssistantDeltaMessage,
  toDomainMessages,
} from './model/message.mjs';
import { observedNow } from './model/time.mjs';
import { SIGNAL } from './model/signals.mjs';

/**
 * Messages service.
 */
export class MessagesService {
  /**
   * @param {object} options - service options.
   * @param {object} options.adapter - the R1 `DshAdapter`.
   * @param {object} [options.store] - the shared session view store.
   * @param {() => number} [options.clock] - injectable clock.
   */
  constructor(options) {
    if (options?.adapter === undefined) throw new TypeError('MessagesService requires an adapter');
    this.adapter = options.adapter;
    this.store = options.store ?? null;
    this.clock = options.clock ?? Date.now;
  }

  /**
   * Read one page of history as domain messages.
   *
   * Ordering is the Host's order, preserved exactly. Pagination metadata survives
   * as `next_before_sequence`, which is the DSH seq to pass as `beforeSeq` to
   * walk further back —a DSH cursor, never a Gateway sequence.
   *
   * @param {string} sessionId - session identity.
   * @param {object} [options] - page options.
   * @param {number} [options.throughSeq] - inclusive DSH cursor.
   * @param {number} [options.beforeSeq] - exclusive upper bound for older pages.
   * @param {number} [options.maxMessages] - page size.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @returns {Promise<object>} `{ messages, session_id, through_sequence, has_more, next_before_sequence, observed_at, raw }`.
   * @throws {TypeError} when the adapter returns an unusable page.
   */
  async list(sessionId, options = {}) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TypeError('messages.list requires a session id');
    }
    if (typeof this.adapter.getMessages !== 'function') {
      throw new TypeError('the adapter has no getMessages capability');
    }

    const page = await this.adapter.getMessages(sessionId, options);
    if (!isRecord(page) || !Array.isArray(page.messages)) {
      throw new TypeError('the adapter returned an unusable message page');
    }

    const observedAt = observedNow(this.clock);
    const messages = page.messages.map((message) => this.#fromAdapterMessage(message, sessionId, observedAt));

    // Keep the DSH durable cursor visible to the store so R2 can prove the two
    // sequence spaces are tracked separately (§8).
    const highestSourceSequence = messages.reduce(
      (max, message) => (typeof message.source_sequence === 'number' && message.source_sequence > max
        ? message.source_sequence
        : max),
      -1,
    );
    if (this.store !== null && highestSourceSequence >= 0) {
      this.store.rememberDshCursor(sessionId, highestSourceSequence);
    }

    const oldestSourceSequence = messages.length > 0
      ? messages.reduce(
        (min, message) => (typeof message.source_sequence === 'number' && message.source_sequence < min
          ? message.source_sequence
          : min),
        Number.POSITIVE_INFINITY,
      )
      : null;

    return {
      session_id: sessionId,
      messages,
      through_sequence: typeof page.throughSeq === 'number' ? page.throughSeq : null,
      has_more: page.hasMore === true,
      // A DSH cursor for the next older page. NOT a Gateway sequence.
      next_before_sequence: Number.isFinite(oldestSourceSequence) ? oldestSourceSequence : null,
      observed_at: observedAt,
      raw: page.raw ?? null,
    };
  }

  /**
   * Normalise one adapter message into a domain message.
   *
   * The adapter (R1) already produced `{id, session_id, role, type, content,
   * created_at, sequence}`; R2 adds `source_sequence`, `observed_at` and the
   * R2 type vocabulary without discarding anything the adapter decided.
   *
   * @param {object} message - an R1 adapter message.
   * @param {string} sessionId - owning session.
   * @param {string} observedAt - ISO observation time.
   * @returns {object} the domain message.
   * @throws {TypeError} when the message is unusable.
   */
  #fromAdapterMessage(message, sessionId, observedAt) {
    if (!isRecord(message)) throw new TypeError('adapter message must be an object');
    if (typeof message.id !== 'string' || message.id.length === 0) {
      throw new TypeError('adapter message is missing an id');
    }
    const sourceSequence = typeof message.sequence === 'number' ? message.sequence : null;

    const type = normaliseType(message.type);
    const domain = {
      id: message.id,
      session_id: sessionId,
      role: typeof message.role === 'string' ? message.role : 'system',
      type,
      event_type: typeof message.event_type === 'string' ? message.event_type : null,
      content: message.content ?? null,
      ...Object.fromEntries(['turn', 'step', 'call_id', 'turn_started_at', 'turn_ended_at']
        .filter(key => message[key] !== undefined).map(key => [key, message[key]])),
      created_at: message.created_at ?? null,
      sequence: sourceSequence,
      source_sequence: sourceSequence,
      observed_at: observedAt,
      // The adapter extracts DSH's durable assistant/message usage and timing
      // fields. Preserve them through the domain projection so the REST layer
      // can render the same per-turn statistics the desktop UI reads.
      ...(message.role === 'assistant' && isRecord(message.usage)
        ? { usage: message.usage }
        : {}),
      ...(message.role === 'assistant' && typeof message.durationMs === 'number'
        && Number.isFinite(message.durationMs) && message.durationMs >= 0
        ? { durationMs: message.durationMs }
        : {}),
    };

    // Assert the adapter's id really is a deterministic function of identity.
    // A non-stable id would mean history renumbers itself between reads (§6.1).
    if (!isMessageIdStable(domain) && sourceSequence !== null) {
      domain.id = `${sessionId}:${sourceSequence}:${type}`;
      domain.metadata = { id_repaired: true, adapter_id: message.id };
    }

    return domain;
  }

  /**
   * Build a live-only assistant delta message from a `follow` frame.
   *
   * Deltas are provisional and have no durable DSH sequence; they are a distinct
   * type so a client cannot mistake one for a committed message (§6.1).
   *
   * @param {string} sessionId - owning session.
   * @param {object} frame - a `SessionAssistantStreamFrame`.
   * @param {object} [options] - options.
   * @param {string} [options.observedAt] - ISO observation time.
   * @returns {object} the delta message.
   */
  deltaMessage(sessionId, frame, options = {}) {
    return toAssistantDeltaMessage({
      sessionId,
      frame,
      observedAt: options.observedAt ?? observedNow(this.clock),
    });
  }

  /**
   * Record a durable user prompt's admission as a domain signal.
   *
   * Called by the events service after the adapter accepts a prompt, so the
   * status machine and the message log agree on ordering.
   *
   * @param {string} sessionId - session identity.
   * @param {'queue'|'steer'} mode - the prompt mode that was accepted.
   * @returns {object|null} the transition record, or `null` without a store.
   */
  notePromptAccepted(sessionId, mode) {
    if (this.store === null) return null;
    const signal = mode === 'steer' ? SIGNAL.PROMPT_ACCEPTED_STEER : SIGNAL.PROMPT_ACCEPTED_QUEUE;
    return this.store.applySignal(sessionId, {
      signal,
      sessionId,
      evidence: { source: 'session/prompt accepted', mode },
    });
  }
}

/**
 * Map an R1 adapter message type onto the R2 vocabulary.
 *
 * R1 used kebab-case (`tool-call`); R2 uses snake_case (`tool_call`) per §6.
 *
 * @param {unknown} type - an adapter message type.
 * @returns {string} a `MESSAGE_TYPE` value.
 */
export function normaliseType(type) {
  switch (type) {
    case 'message':
      return MESSAGE_TYPE.MESSAGE;
    case 'tool-call':
    case 'tool_call':
      return MESSAGE_TYPE.TOOL_CALL;
    case 'tool-result':
    case 'tool_result':
      return MESSAGE_TYPE.TOOL_RESULT;
    case 'reasoning':
      return MESSAGE_TYPE.REASONING;
    case 'assistant-delta':
    case 'assistant_delta':
      return MESSAGE_TYPE.ASSISTANT_DELTA;
    default:
      return MESSAGE_TYPE.UNKNOWN;
  }
}
