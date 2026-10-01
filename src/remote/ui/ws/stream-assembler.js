import { extractActivities } from '../activity/run-activity.js';
/**
 * Assistant stream assembly.
 *
 * The rule this module exists to enforce:
 *
 * ```text
 * assistant.start  → create ONE transient assistant message
 * assistant.delta  → append to the SAME message
 * assistant.end    → finalize
 * ```
 *
 * Never one message per chunk.
 *
 * ## Identity strategy (§16)
 *
 * The Gateway's `assistant.start` carries `attempt_id` — a server-supplied identity for the
 * attempt — so that is used whenever present, prefixed to keep it visibly client-local:
 *
 * ```text
 * stream:<attempt_id>
 * ```
 *
 * When the server does not supply one, a stream-local identifier is allocated. Either way the
 * identity is **stable for the whole attempt**, which is what makes chunk appending and replay
 * de-duplication both work.
 *
 * ## De-duplication (§39)
 *
 * Chunks carry a server `index`. A chunk whose index has already been applied to this attempt
 * is ignored. That is what makes the reconnect case
 *
 * ```text
 * start, chunk A, disconnect, replay chunk A, chunk B, end   →   "AB"   not   "AAB"
 * ```
 *
 * work. Chunks with no index are always applied, because there is nothing to compare — and
 * silently dropping unindexed text would corrupt the stream in the other direction.
 */

import { UI_EVENT } from './event-normalizer.js';
import { resolveChunkText } from './event-normalizer.js';

/** A stream-local identity counter. Not a Gateway sequence, and never presented as one. */
let streamCounter = 0;

/**
 * Allocate a stream-local identity.
 *
 * @returns {string} the identity.
 */
function nextStreamLocalId() {
  streamCounter += 1;
  return `stream-local-${streamCounter}`;
}

/**
 * Reset the local counter. Test seam only.
 *
 * @returns {void}
 */
export function resetStreamIdentityCounter() {
  streamCounter = 0;
}

/**
 * The per-session streaming state machine.
 */
export class StreamAssembler {
  /**
   * @param {object} [options] - `onChange` callback.
   */
  constructor(options = {}) {
    this.onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
    /** @type {Map<string, object>} attempt identity → the transient message. */
    this.streams = new Map();
    /**
     * The stream-local identity in use when the server supplies no `attempt_id`.
     *
     * It must be **stable across every frame of one attempt** — deriving it per call would give
     * `start`, `delta` and `end` three different identities, so the chunks would never append to
     * the message the start created. A single value is enough because only one attempt can be
     * streaming on a session at a time, and it is cleared when the attempt finalizes.
     *
     * @type {string|null}
     */
    this.localFallbackId = null;
  }

  /**
   * Handle an `assistant.start`.
   *
   * @param {object} event - the normalized event.
   * @returns {object|null} the created transient message, or null when it was a duplicate.
   */
  start(event) {
    const id = this.#identityFor(event);
    if (this.streams.has(id)) {
      // A start for an attempt already streaming is a replay of the same start: keep the
      // existing message so the text is not truncated back to empty.
      return null;
    }

    const message = {
      id,
      role: 'assistant',
      sessionId: event.sessionId ?? null,
      turn: Number.isSafeInteger(event.data?.turn) ? event.data.turn : null,
      step: Number.isSafeInteger(event.data?.step) ? event.data.step : null,
      createdAt: event.sourceTime ?? null,
      activities: [],
      revision: 0,
      blocks: new Map(),
      kind: 'normal',
      content: '',
      /** The stream is active: the renderer shows a cursor. */
      streaming: true,
      /** The server's attempt identity, when it supplied one. */
      attemptId: typeof event.data?.attempt_id === 'string' ? event.data.attempt_id : null,
      /** Applied chunk indices, for replay de-duplication. */
      appliedIndices: new Set(),
      /** Chunks that carried no readable text, counted for diagnostics without being guessed at. */
      opaqueChunks: 0,
      sequence: event.sequence,
    };
    this.streams.set(id, message);
    this.onChange({ type: 'stream-start', message });
    return message;
  }

  /**
   * Handle an `assistant.delta`.
   *
   * @param {object} event - the normalized event.
   * @returns {object|null} the updated message, or null when ignored.
   */
  delta(event) {
    const id = this.#identityFor(event);
    let message = this.streams.get(id);

    // A delta arriving before its start — possible after a reconnect whose replay began
    // mid-stream — creates the message rather than dropping the text.
    if (message === undefined) {
      message = this.start(event);
    }

    // Replay de-duplication by server index.
    const index = event.data?.index;
    if (typeof index === 'number' && Number.isSafeInteger(index)) {
      if (message.appliedIndices.has(index)) {
        this.onChange({ type: 'stream-duplicate', message, index });
        return null;
      }
      message.appliedIndices.add(index);
    }

    const chunk = event.data?.chunk;
    let { text, recognised } = resolveChunkText(chunk);
    message.revision = (message.revision ?? 0) + 1;
    message.streaming = true;
    message.interrupted = false;
    const typed = chunk && typeof chunk === 'object' && Number.isSafeInteger(chunk.index)
      && ['text-delta','reasoning-delta','tool-call-delta','block-end'].includes(chunk.type);
    if (typed) {
      const prior = message.blocks.get(chunk.index) ?? {};
      if (chunk.type === 'block-end' && chunk.block) message.blocks.set(chunk.index, {...chunk.block});
      else if (chunk.type === 'tool-call-delta') message.blocks.set(chunk.index, {
        ...prior,type:'tool-call',id:chunk.id ?? prior.id,name:chunk.name ?? prior.name,
        arguments:(prior.arguments ?? '') + (chunk.argumentsDelta ?? '')});
      else message.blocks.set(chunk.index, {...prior,type:chunk.type === 'reasoning-delta' ? 'reasoning' : 'text',
        text:(prior.text ?? '') + (chunk.text ?? '')});
      const ordered = [...message.blocks.entries()].sort((a,b)=>a[0]-b[0]).map(([,b])=>b);
      message.content = (message.legacyText ?? '') + ordered.filter(b=>b.type==='text').map(b=>b.text ?? '').join('');
      message.activities = extractActivities({content:ordered});
      recognised = true;
    } else if (recognised) {
      message.legacyText = (message.legacyText ?? '') + text;
      message.content += text;
    } else message.opaqueChunks += 1;

    this.onChange({ type: 'stream-delta', message, text, recognised });
    return message;
  }

  /**
   * Handle an `assistant.end`.
   *
   * @param {object} event - the normalized event.
   * @returns {object|null} the finalized message, or null when there was nothing to finalize.
   */
  end(event) {
    const id = this.#identityFor(event);
    const message = this.streams.get(id);
    if (message === undefined) return null;

    message.streaming = false;
    message.interrupted = false;
    message.outcome = event.data?.outcome ?? null;
    this.streams.delete(id);
    // Release the fallback so the next attempt is a genuinely new stream rather than reusing
    // the finished attempt's identity.
    if (this.streams.size === 0) this.localFallbackId = null;
    this.onChange({ type: 'stream-end', message });
    return message;
  }

  /**
   * Every currently-streaming message.
   *
   * @returns {object[]} the transient messages.
   */
  active() {
    return [...this.streams.values()];
  }

  /**
   * Whether any attempt is currently streaming.
   *
   * @returns {boolean} true when a stream is open.
   */
  get streaming() {
    return this.streams.size > 0;
  }

  /**
   * §17: a socket that dies mid-stream must not delete the partial text.
   *
   * The message is marked interrupted rather than completed, and the streaming flag is cleared
   * so the cursor stops — but the accumulated text stays exactly as it was. No `end` event is
   * invented, and the domain state is not advanced.
   *
   * @returns {object[]} the messages left visible, in the order they were streaming.
   */
  interruptAll(options = {}) {
    const interrupted = [...this.streams.values()];
    for (const message of interrupted) {
      message.streaming = false;
      message.interrupted = true;
    }
    if (options.retain !== true) {
      this.streams.clear();
      this.localFallbackId = null;
    }
    return interrupted;
  }

  /**
   * The attempt identity for an event.
   *
   * @param {object} event - the normalized event.
   * @returns {string} the identity.
   */
  #identityFor(event) {
    const attemptId = event?.data?.attempt_id;
    if (typeof attemptId === 'string' && attemptId.length > 0) return `stream:${attemptId}`;
    // Without a server identity, fall back to ONE stream-local identity that stays stable for
    // the whole attempt. It is never presented as a Gateway sequence.
    if (this.localFallbackId === null) this.localFallbackId = nextStreamLocalId();
    return `stream:${this.localFallbackId}`;
  }
}

export { UI_EVENT };
