/**
 * Upload quotas — Phase R6 §41, §42.
 *
 * R3 already caps a single upload at 25 MiB. R6 adds three aggregate controls:
 *
 *   - a concurrent-upload cap;
 *   - a rolling byte budget over a window;
 *   - the existing per-upload size limit, unchanged.
 *
 * §42 is the important part: accounting must be **streamed**. `Content-Length` is a
 * client claim, so a caller could declare a small body and send a large one. Bytes
 * are therefore charged as they are read, and the request stream is destroyed the
 * moment the budget is exceeded — the oversized bytes are never forwarded to DSH.
 */

import { AUTH_ERROR, authError } from './errors.mjs';

/** Defaults (§41). */
export const DEFAULT_MAX_CONCURRENT_UPLOADS = 2;
export const DEFAULT_BYTES_PER_WINDOW = 104_857_600; // 100 MiB
export const DEFAULT_WINDOW_SECONDS = 600; // 10 minutes

/**
 * The upload quota accountant.
 */
export class UploadQuota {
  /**
   * @param {object} [options] - quota options.
   * @param {() => number} [options.clock] - injectable clock (ms).
   * @param {number} [options.maxConcurrent] - concurrent uploads allowed.
   * @param {number} [options.bytesPerWindow] - the rolling byte budget.
   * @param {number} [options.windowSeconds] - the budget window.
   */
  constructor(options = {}) {
    this.clock = options.clock ?? Date.now;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_UPLOADS;
    this.bytesPerWindow = options.bytesPerWindow ?? DEFAULT_BYTES_PER_WINDOW;
    this.windowSeconds = options.windowSeconds ?? DEFAULT_WINDOW_SECONDS;

    for (const [name, value, min] of [
      ['maxConcurrent', this.maxConcurrent, 1],
      ['bytesPerWindow', this.bytesPerWindow, 1],
      ['windowSeconds', this.windowSeconds, 1],
    ]) {
      if (!Number.isSafeInteger(value) || value < min) {
        throw authError(AUTH_ERROR.CONFIG_INVALID, { message: `Upload quota "${name}" must be a positive integer.` });
      }
    }

    /** @type {number} Live uploads. */
    this.active = 0;
    /** @type {number} Bytes charged in the current window. */
    this.bytesUsed = 0;
    /** @type {number} When the current window ends. */
    this.windowEndsAt = this.clock() + this.windowSeconds * 1000;
    this.counters = { started: 0, finished: 0, refusedConcurrent: 0, refusedBytes: 0, aborted: 0 };
  }

  /**
   * Roll the window when it has elapsed.
   *
   * @returns {void}
   */
  #roll() {
    const now = this.clock();
    if (now >= this.windowEndsAt) {
      this.bytesUsed = 0;
      this.windowEndsAt = now + this.windowSeconds * 1000;
    }
  }

  /**
   * Begin an upload.
   *
   * @returns {{ok: true, finish: (bytes: number) => void, abort: (bytes: number) => void} | {ok: false, reason: string, retryAfter: number}}
   *   the handle, or a refusal.
   */
  begin() {
    this.#roll();
    if (this.active >= this.maxConcurrent) {
      this.counters.refusedConcurrent += 1;
      return { ok: false, reason: 'concurrent', retryAfter: 1 };
    }
    this.active += 1;
    this.counters.started += 1;

    let settled = false;
    const settle = (bytes, aborted) => {
      if (settled) return;
      settled = true;
      this.active = Math.max(0, this.active - 1);
      // Bytes are charged either way: they were read, and a client must not be able
      // to escape accounting by aborting.
      this.bytesUsed += Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
      if (aborted) this.counters.aborted += 1;
      else this.counters.finished += 1;
    };

    return {
      ok: true,
      finish: (bytes) => settle(bytes, false),
      abort: (bytes) => settle(bytes, true),
    };
  }

  /**
   * Charge bytes as they stream in.
   *
   * @param {number} bytes - the bytes just read.
   * @returns {{allowed: boolean, used: number, remaining: number}} the decision.
   */
  chargeBytes(bytes) {
    this.#roll();
    const amount = Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
    this.bytesUsed += amount;
    const remaining = Math.max(0, this.bytesPerWindow - this.bytesUsed);
    if (this.bytesUsed > this.bytesPerWindow) {
      this.counters.refusedBytes += 1;
      return { allowed: false, used: this.bytesUsed, remaining: 0 };
    }
    return { allowed: true, used: this.bytesUsed, remaining };
  }

  /**
   * Whether a further chunk would exceed the budget.
   *
   * Checked *before* forwarding, so the oversized bytes never reach DSH.
   *
   * @param {number} bytes - the size of the next chunk.
   * @returns {boolean} true when the budget would be exceeded.
   */
  wouldExceed(bytes) {
    this.#roll();
    const amount = Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
    return this.bytesUsed + amount > this.bytesPerWindow;
  }

  /**
   * Assert room for an upload, throwing when refused.
   *
   * @returns {void}
   * @throws {AuthError} `UPLOAD_QUOTA_EXCEEDED`.
   */
  assertCapacity() {
    this.#roll();
    if (this.active >= this.maxConcurrent) {
      this.counters.refusedConcurrent += 1;
      throw authError(AUTH_ERROR.UPLOAD_QUOTA_EXCEEDED, { retryAfter: 1 });
    }
  }

  /**
   * Diagnostics. Never includes a filename or content.
   *
   * @returns {object} the summary.
   */
  stats() {
    this.#roll();
    return {
      active: this.active,
      max_concurrent: this.maxConcurrent,
      bytes_used: this.bytesUsed,
      bytes_per_window: this.bytesPerWindow,
      window_seconds: this.windowSeconds,
      counters: { ...this.counters },
    };
  }
}
