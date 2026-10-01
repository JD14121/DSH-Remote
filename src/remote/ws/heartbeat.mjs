/**
 * Liveness: application heartbeat and protocol ping/pong — Phase R4 §17, §18, §38.
 *
 * Two mechanisms with two different jobs, deliberately kept apart:
 *
 * | | job | wire |
 * | --- | --- | --- |
 * | application `heartbeat` | tells the UI the stream is alive and how far it has reached | a JSON frame |
 * | RFC 6455 `ping`/`pong` | transport liveness; detects a dead peer | a protocol control frame |
 *
 * Neither consumes a Gateway sequence, and neither may mutate domain status
 * (§38). A phone disconnecting is a **phone transport** event; R2's `disconnected`
 * means the Gateway lost DSH, and conflating them would corrupt the session state.
 *
 * Timers are injectable so tests never wait 25 real seconds (§51).
 */

/** Default application heartbeat interval, in milliseconds (§17). */
export const DEFAULT_HEARTBEAT_MS = 25_000;

/** Accepted heartbeat range (§17). */
export const MIN_HEARTBEAT_MS = 10_000;
export const MAX_HEARTBEAT_MS = 60_000;

/**
 * Resolve a heartbeat interval, clamped and validated.
 *
 * @param {unknown} value - candidate interval.
 * @returns {number} a valid interval in milliseconds.
 * @throws {TypeError} when present but out of range or not an integer.
 */
export function resolveHeartbeatMs(value) {
  if (value === undefined || value === null) return DEFAULT_HEARTBEAT_MS;
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`heartbeat interval must be an integer, received ${JSON.stringify(value)}`);
  }
  if (value < MIN_HEARTBEAT_MS || value > MAX_HEARTBEAT_MS) {
    throw new TypeError(
      `heartbeat interval must be between ${MIN_HEARTBEAT_MS} and ${MAX_HEARTBEAT_MS} ms, received ${value}`,
    );
  }
  return value;
}

/**
 * Liveness manager for one client connection.
 */
export class Heartbeat {
  /**
   * @param {object} options - options.
   * @param {() => void} options.onHeartbeat - emit an application heartbeat frame.
   * @param {() => void} options.onPing - send a protocol ping.
   * @param {(info: object) => void} options.onDead - the peer missed a pong.
   * @param {number} [options.intervalMs] - application heartbeat period.
   * @param {number} [options.pingIntervalMs] - protocol ping period.
   * @param {(fn: () => void, ms: number) => unknown} [options.setInterval]
   *   timer factory; injectable for tests.
   * @param {(handle: unknown) => void} [options.clearInterval] - matching canceller.
   * @param {() => number} [options.clock] - wall clock, for timestamps.
   */
  constructor(options) {
    if (typeof options?.onHeartbeat !== 'function') throw new TypeError('Heartbeat requires onHeartbeat');
    if (typeof options?.onPing !== 'function') throw new TypeError('Heartbeat requires onPing');
    if (typeof options?.onDead !== 'function') throw new TypeError('Heartbeat requires onDead');

    this.onHeartbeat = options.onHeartbeat;
    this.onPing = options.onPing;
    this.onDead = options.onDead;
    this.clock = options.clock ?? Date.now;

    this.intervalMs = resolveHeartbeatMs(options.intervalMs);
    this.pingIntervalMs = resolveHeartbeatMs(options.pingIntervalMs);
    this.setIntervalFn = options.setInterval ?? setInterval;
    this.clearIntervalFn = options.clearInterval ?? clearInterval;

    this.heartbeatTimer = null;
    this.pingTimer = null;
    this.stopped = false;
    /** Whether a pong arrived since the last ping. */
    this.alive = true;
    this.pingsSent = 0;
    this.pongsReceived = 0;
    this.heartbeatsSent = 0;
  }

  /**
   * Begin both timers.
   *
   * @returns {void}
   */
  start() {
    if (this.stopped || this.heartbeatTimer !== null) return;

    this.heartbeatTimer = this.setIntervalFn(() => {
      this.heartbeatsSent += 1;
      // §38: emitting a heartbeat must not touch domain state. This callback only
      // writes a frame.
      this.onHeartbeat();
    }, this.intervalMs);

    this.pingTimer = this.setIntervalFn(() => {
      if (!this.alive) {
        // A full ping period elapsed with no pong: the peer is gone.
        this.stop();
        this.onDead({ pingsSent: this.pingsSent, pongsReceived: this.pongsReceived });
        return;
      }
      this.alive = false;
      this.pingsSent += 1;
      this.onPing();
    }, this.pingIntervalMs);

    // Do not let liveness timers hold the process open.
    this.heartbeatTimer?.unref?.();
    this.pingTimer?.unref?.();
  }

  /**
   * Record a pong from the peer.
   *
   * @returns {void}
   */
  notePong() {
    this.alive = true;
    this.pongsReceived += 1;
  }

  /**
   * Stop both timers. Idempotent.
   *
   * @returns {void}
   */
  stop() {
    this.stopped = true;
    if (this.heartbeatTimer !== null) {
      this.clearIntervalFn(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pingTimer !== null) {
      this.clearIntervalFn(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Whether any timer is still armed.
   *
   * @returns {boolean} true when a timer is pending.
   */
  get running() {
    return this.heartbeatTimer !== null || this.pingTimer !== null;
  }

  /**
   * A snapshot for diagnostics and tests.
   *
   * @returns {object} the state.
   */
  stats() {
    return {
      intervalMs: this.intervalMs,
      pingIntervalMs: this.pingIntervalMs,
      running: this.running,
      stopped: this.stopped,
      alive: this.alive,
      pingsSent: this.pingsSent,
      pongsReceived: this.pongsReceived,
      heartbeatsSent: this.heartbeatsSent,
    };
  }
}

/**
 * A manual timer, for tests that must not wait on wall-clock time.
 *
 * `advance(ms)` runs every callback whose due time has passed, in order, so a
 * test can simulate 25 seconds instantly and deterministically.
 */
export class ManualTimers {
  constructor() {
    /** @type {Array<{fn: () => void, ms: number, due: number, cancelled: boolean}>} */
    this.timers = [];
    this.now = 0;
  }

  /**
   * Schedule a repeating callback, matching `setInterval`'s shape.
   *
   * @param {() => void} fn - the callback.
   * @param {number} ms - the period.
   * @returns {object} the timer handle.
   */
  setInterval(fn, ms) {
    const timer = { fn, ms, due: this.now + ms, cancelled: false };
    this.timers.push(timer);
    return timer;
  }

  /**
   * Cancel a timer.
   *
   * @param {object} handle - the timer handle.
   * @returns {void}
   */
  clearInterval(handle) {
    if (handle !== null && typeof handle === 'object') handle.cancelled = true;
  }

  /**
   * Advance the clock, firing due callbacks.
   *
   * @param {number} ms - how far to advance.
   * @returns {number} how many callbacks ran.
   */
  advance(ms) {
    this.now += ms;
    let fired = 0;
    // Re-scan after each firing so timers rescheduled during a callback are seen.
    for (;;) {
      const due = this.timers
        .filter((timer) => !timer.cancelled && timer.due <= this.now)
        .sort((left, right) => left.due - right.due);
      if (due.length === 0) break;
      const next = due[0];
      next.due += next.ms;
      fired += 1;
      next.fn();
      if (fired > 10_000) break; // guard against a pathological callback
    }
    return fired;
  }

  /**
   * Whether any timer is still armed.
   *
   * @returns {boolean} true when a timer is pending.
   */
  get pending() {
    return this.timers.filter((timer) => !timer.cancelled).length;
  }
}
