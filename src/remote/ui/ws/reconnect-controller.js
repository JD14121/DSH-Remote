/**
 * Reconnect orchestration.
 *
 * ## What R8D does, and what it deliberately does not
 *
 * R8D implements **basic** reconnect: the socket is lost, the UI shows `reconnecting`, history
 * and the draft are preserved, a **fresh** ticket is obtained, and the socket reconnects asking
 * for replay from `lastAppliedSequence`.
 *
 * It does **not** implement the recovery workflow for a replay that cannot be served — a
 * too-old sequence, a retention gap, or an explicit `resync_required`. Those set the
 * `resync_required` UI state and stop; the reload-and-recreate orchestration is R8E's (§24,
 * §35). Doing it here would be quietly absorbing a later phase.
 *
 * ## Backoff
 *
 * Bounded, cancelable, and reset after a healthy connection. The specific numbers are not part
 * of the contract; the properties are. A tight loop is the failure mode this exists to prevent.
 */

import { EventClient, SOCKET_STATE } from './event-client.js';

/** The default backoff schedule, in milliseconds. Bounded and jitter-free for determinism. */
export const DEFAULT_BACKOFF_MS = Object.freeze([500, 1000, 2000, 4000, 5000]);

/**
 * The reconnect controller for one session.
 */
export class ReconnectController {
  /**
   * @param {object} options - `clientFactory`, `backoffMs`, `setTimeoutImpl`,
   *   `clearTimeoutImpl`, `onStateChange`, `shouldReconnect`.
   */
  constructor(options = {}) {
    this.clientFactory = options.clientFactory;
    if (typeof this.clientFactory !== 'function') {
      throw new TypeError('ReconnectController requires a clientFactory');
    }
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.maxAttempts = options.maxAttempts ?? Infinity;
    // Browser timers require the Window receiver, not this controller instance.
    this.setTimeoutImpl = options.setTimeoutImpl ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? ((handle) => globalThis.clearTimeout(handle));
    this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : () => {};

    /** @type {EventClient|null} */
    this.client = null;
    /** @type {unknown} the pending timer handle. */
    this.timer = null;
    /** @type {number} how many consecutive attempts have failed. */
    this.attempt = 0;
    /** @type {boolean} once cancelled, a pending timer can never revive a socket. */
    this.cancelled = false;
    /** @type {number} the number of successful live connections, for evidence. */
    this.connections = 0;
    /** @type {number} the number of reconnect attempts made. */
    this.reconnects = 0;
  }

  /**
   * Start the first connection.
   *
   * @returns {Promise<void>} when the attempt has begun.
   */
  async start() {
    this.cancelled = false;
    this.#spawn();
    await this.client.connect();
  }

  /**
   * Create a fresh client and wire its lifecycle.
   *
   * @returns {void}
   */
  #spawn() {
    const client = this.clientFactory();
    client.onTransport = (state) => {
      if (this.cancelled || this.client !== client) return;
      // A connection that reached LIVE proves the link is healthy: reset the backoff so a later
      // drop starts from the shortest delay rather than the longest.
      if (state.socketState === SOCKET_STATE.LIVE) {
        this.attempt = 0;
        this.connections += 1;
      }
      this.onStateChange(state);
      if (state.socketState === SOCKET_STATE.DISCONNECTED && state.closeKind === 'network' && !state.resyncRequired) {
        this.scheduleReconnect();
      }
    };
    this.client = client;
  }

  /**
   * Report that the current socket closed.
   *
   * @param {object} input - `retryable`, `closeKind`.
   * @returns {void}
   */
  onClose(input = {}) {
    if (this.cancelled) return;
    if (input.retryable !== true) {
      // An intentional close, an auth failure or a protocol violation is not retried in a loop.
      // The consumer decides what the UI should do; we do not reconnect.
      return;
    }
    this.scheduleReconnect();
  }

  /**
   * Schedule the next attempt with bounded backoff.
   *
   * @returns {void}
   */
  scheduleReconnect() {
    if (this.cancelled) return;
    if (this.timer !== null) return; // already scheduled: never stack timers
    if (this.attempt >= this.maxAttempts) {
      this.onStateChange({ ...this.client?.state, uiConnection: 'gateway_unavailable', exhausted: true });
      return;
    }

    const index = Math.min(this.attempt, this.backoffMs.length - 1);
    const delay = this.backoffMs[index];
    this.attempt += 1;

    this.timer = this.setTimeoutImpl(async () => {
      this.timer = null;
      if (this.cancelled) return;
      this.reconnects += 1;
      const previous = this.client;
      this.#spawn();
      previous?.close();
      await this.client.connect();
    }, delay);
  }

  /**
   * Cancel any pending reconnect.
   *
   * Called when the user selects another session, authentication is cleared, the page unloads,
   * or fixture mode is chosen. A pending timer must never revive the old session's socket
   * (§27).
   *
   * @returns {void}
   */
  cancel() {
    this.cancelled = true;
    if (this.timer !== null) {
      this.clearTimeoutImpl(this.timer);
      this.timer = null;
    }
    if (this.client !== null) this.client.close(1000);
    this.client = null;
  }

  /**
   * Close the current socket and stop reconnecting.
   *
   * @returns {void}
   */
  stop() {
    this.cancelled = true;
    if (this.timer !== null) {
      this.clearTimeoutImpl(this.timer);
      this.timer = null;
    }
    if (this.client !== null) {
      this.client.close(1000);
      this.client = null;
    }
  }

  /**
   * Whether a reconnect is currently pending.
   *
   * @returns {boolean} true when a timer is armed.
   */
  get pending() {
    return this.timer !== null;
  }
}
