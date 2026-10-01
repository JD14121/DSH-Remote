/**
 * Per-client bounded outbound backlog — Phase R4 §27, §28, §29.
 *
 * One WebSocket's outbound path is a **single-writer pump**:
 *
 * ```text
 * enqueue serialised frame
 *   ↓
 * send one frame
 *   ↓
 * send callback
 *   ↓
 * send next
 * ```
 *
 * That gives three properties §28 asks for: order is preserved by construction,
 * pending bytes are known exactly, and the OS socket buffer is never relied on as
 * an unbounded queue.
 *
 * Byte accounting uses the **serialised frame length**, never a JS object
 * estimate (§27). `ws.bufferedAmount` is deliberately not used as the limiter.
 *
 * Overflow is never a silent drop (§29). The client is told which sequence it
 * last received and is closed with 4003 so it can reconnect from a known
 * watermark.
 */

import { APP_CLOSE, STANDARD_CLOSE, closeReason } from './close-codes.mjs';

/** Default caps (§27). */
export const DEFAULT_MAX_BACKLOG_EVENTS = 256;
export const DEFAULT_MAX_BACKLOG_BYTES = 1_048_576;

/**
 * Validate a backlog limit.
 *
 * @param {unknown} value - candidate.
 * @param {number} fallback - the default.
 * @param {string} name - for the error message.
 * @returns {number} the resolved limit.
 * @throws {TypeError} when present but not a positive safe integer.
 */
export function resolveLimit(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer, received ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * A bounded, order-preserving outbound queue with a single-writer pump.
 */
export class Backlog {
  /**
   * @param {object} options - backlog options.
   * @param {(text: string, onDone: (error?: Error) => void) => void} options.send
   *   the transport send function; must call `onDone` exactly once.
   * @param {number} [options.maxEvents] - pending frame ceiling.
   * @param {number} [options.maxBytes] - pending byte ceiling.
   * @param {(info: object) => void} [options.onOverflow] - called once on overflow.
   */
  constructor(options) {
    if (typeof options?.send !== 'function') throw new TypeError('Backlog requires a send function');
    this.send = options.send;
    this.maxEvents = resolveLimit(options.maxEvents, DEFAULT_MAX_BACKLOG_EVENTS, 'maxEvents');
    this.maxBytes = resolveLimit(options.maxBytes, DEFAULT_MAX_BACKLOG_BYTES, 'maxBytes');
    this.onOverflow = options.onOverflow ?? null;

    /** @type {Array<{text: string, bytes: number, meta: object|null}>} */
    this.queue = [];
    this.pendingBytes = 0;
    this.pumping = false;
    this.closed = false;
    this.overflowed = false;
    /** The highest Gateway sequence actually handed to the transport. */
    this.lastDeliveredSequence = null;
    /** Frames accepted and later sent, for diagnostics and tests. */
    this.sentFrames = 0;
    /** @type {Array<() => void>} */
    this.idleCallbacks = [];
  }

  /**
   * The number of frames waiting for the transport.
   *
   * @returns {number} the pending frame count.
   */
  get pendingEvents() {
    return this.queue.length;
  }

  /**
   * Enqueue a serialised frame.
   *
   * @param {unknown} frame - the frame object to serialise.
   * @param {object} [meta] - delivery metadata.
   * @param {number|null} [meta.sequence] - the Gateway sequence, when it is an event.
   * @returns {{accepted: boolean, reason: string|null}} the decision.
   */
  enqueue(frame, meta = {}) {
    if (this.closed) return { accepted: false, reason: 'closed' };
    if (this.overflowed) return { accepted: false, reason: 'overflowed' };

    const text = JSON.stringify(frame);
    const bytes = Buffer.byteLength(text, 'utf8');

    // §29: reaching either ceiling ends the connection; nothing is dropped to
    // stay under it, because a silent gap in a chat stream is unacceptable.
    if (this.queue.length + 1 > this.maxEvents || this.pendingBytes + bytes > this.maxBytes) {
      this.#handleOverflow(bytes);
      return { accepted: false, reason: 'overflow' };
    }

    this.queue.push({ text, bytes, meta: meta.sequence === undefined ? null : { sequence: meta.sequence } });
    this.pendingBytes += bytes;
    this.#pump();
    return { accepted: true, reason: null };
  }

  /**
   * Send a must-deliver frame immediately, bypassing the queue and the caps.
   *
   * Used for the frames that explain a closure — `resync_required`, `overflow`,
   * `server_shutdown`, `error`. These cannot go through the normal pump, because
   * the owner closes the socket right afterwards and `close()` clears the queue;
   * a queued notice would be discarded before it was ever written. They also must
   * not be subject to the caps, since telling the client *why* it is being closed
   * is precisely what §29 requires.
   *
   * @param {unknown} frame - the frame to send.
   * @returns {boolean} true when the transport accepted the write.
   */
  sendImmediate(frame) {
    const text = JSON.stringify(frame);
    const bytes = Buffer.byteLength(text, 'utf8');
    try {
      this.send(text, () => {});
      this.sentFrames += 1;
      return true;
    } catch {
      // The transport is already gone. The close below is still explicit.
      this.lastImmediateBytes = bytes;
      return false;
    }
  }

  /**
   * Send a frame immediately, bypassing the caps.
   *
   * Used only for the last-resort overflow/close notice, which must be attempted
   * even though the queue is already at its ceiling.
   *
   * @param {unknown} frame - the frame to send.
   * @returns {void}
   */
  enqueueBypass(frame) {
    this.sendImmediate(frame);
  }

  /**
   * Move frames to the transport, one at a time.
   *
   * @returns {void}
   */
  #pump() {
    if (this.pumping || this.closed) return;
    const next = this.queue[0];
    if (next === undefined) return;

    this.pumping = true;
    const finish = (error) => {
      this.pumping = false;
      if (this.closed) return;
      if (error !== undefined && error !== null) {
        // The transport is gone; stop trying and let the owner close us.
        this.closed = true;
        this.queue = [];
        this.pendingBytes = 0;
        return;
      }
      // Only now is the frame really off our hands.
      this.queue.shift();
      this.pendingBytes -= next.bytes;
      this.sentFrames += 1;
      if (next.meta !== null) this.lastDeliveredSequence = next.meta.sequence;
      this.#pump();
      // Fired after the recursive pump, so the callbacks see a settled queue.
      this.#flushIdle();
    };

    try {
      this.send(next.text, finish);
    } catch (error) {
      finish(error);
    }
  }

  /**
   * Handle a ceiling breach exactly once.
   *
   * @param {number} attemptedBytes - the frame that did not fit.
   * @returns {void}
   */
  #handleOverflow(attemptedBytes) {
    if (this.overflowed) return;
    this.overflowed = true;
    // The queue may be full, so the notice bypasses the caps. If even that
    // cannot be sent the owner will terminate the socket.
    if (typeof this.onOverflow === 'function') {
      this.onOverflow({
        lastDeliveredSequence: this.lastDeliveredSequence,
        pendingEvents: this.queue.length,
        pendingBytes: this.pendingBytes,
        attemptedBytes,
        closeCode: APP_CLOSE.BACKLOG_OVERFLOW,
        closeReason: closeReason(APP_CLOSE.BACKLOG_OVERFLOW),
      });
    }
  }

  /**
   * Register a callback that fires once when the queue drains.
   *
   * `resync_required` cannot be queued until every replayed event has been handed
   * to the transport, so `ClientSession` uses this to sequence the seam marker
   * strictly after the history instead of racing it.
   *
   * @param {() => void} callback - the callback.
   * @returns {void}
   */
  notifyOnIdle(callback) {
    if (typeof callback !== 'function') throw new TypeError('notifyOnIdle requires a function');
    if (this.#isIdle()) {
      callback();
      return;
    }
    this.idleCallbacks.push(callback);
  }

  /**
   * Whether nothing is queued and nothing is in flight.
   *
   * @returns {boolean} true when the queue is fully drained.
   */
  #isIdle() {
    return this.queue.length === 0 && this.pumping === false;
  }

  /**
   * Fire the idle callbacks, once.
   *
   * @returns {void}
   */
  #flushIdle() {
    if (!this.#isIdle() || this.idleCallbacks.length === 0) return;
    const callbacks = this.idleCallbacks;
    this.idleCallbacks = [];
    for (const callback of callbacks) {
      try {
        callback();
      } catch {
        // A sequencing callback must not break the pump.
      }
    }
  }

  /**
   * Discard everything queued without closing the transport.
   *
   * @returns {number} how many frames were discarded.
   */
  clear() {
    const dropped = this.queue.length;
    this.queue = [];
    this.pendingBytes = 0;
    return dropped;
  }

  /**
   * Stop accepting frames.
   *
   * @returns {void}
   */
  close() {
    this.closed = true;
    this.clear();
  }

  /**
   * A snapshot for diagnostics and tests.
   *
   * @returns {object} the state.
   */
  stats() {
    return {
      pendingEvents: this.queue.length,
      pendingBytes: this.pendingBytes,
      maxEvents: this.maxEvents,
      maxBytes: this.maxBytes,
      pumping: this.pumping,
      closed: this.closed,
      overflowed: this.overflowed,
      sentFrames: this.sentFrames,
      lastDeliveredSequence: this.lastDeliveredSequence,
    };
  }
}

export { APP_CLOSE, STANDARD_CLOSE };
