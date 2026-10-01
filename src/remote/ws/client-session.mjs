/**
 * One WebSocket client session — Phase R4 §12-§18, §26, §29, §31, §38.
 *
 * One socket = one DSH session subscription (§12). That keeps the reconnect
 * watermark simple, isolates each client's backlog, and matches a phone opening
 * one chat page.
 *
 * The delicate part is the replay→live handoff (§26). The ordering is:
 *
 * ```text
 * register the live listener        (events start being captured)
 *   ↓
 * capture the replay boundary       (how far history goes)
 *   ↓
 * send hello
 *   ↓
 * send historical frames
 *   ↓
 * flush events captured during replay
 *   ↓
 * send replay_complete
 *   ↓
 * LIVE
 * ```
 *
 * Registering before reading the boundary is what makes an event that arrives
 * *during* replay safe: it is captured rather than missed. Filtering the flush by
 * the boundary is what makes it exactly-once: an event already sent as history is
 * not sent again.
 */

import {
  CONNECTION_STATE,
  FRAME,
  REPLAY_MODE,
  errorFrame,
  eventFrame,
  heartbeatFrame,
  helloFrame,
  overflowFrame,
  replayCompleteFrame,
  resyncRequiredFrame,
  serverShutdownFrame,
} from './protocol.mjs';
import { APP_CLOSE, STANDARD_CLOSE, closeReason } from './close-codes.mjs';
import { Backlog } from './backlog.mjs';
import { Heartbeat } from './heartbeat.mjs';
import { REPLAY_OUTCOME, beginReplay } from './replay.mjs';
import { observedNow } from '../model/time.mjs';

/**
 * A single client connection.
 */
export class ClientSession {
  /**
   * @param {object} options - options.
   * @param {object} options.socket - the transport: `send`, `close`, `ping`, `terminate`.
   * @param {object} options.events - the `EventsService`.
   * @param {string} options.sessionId - the subscribed DSH session.
   * @param {string} options.connectionId - this connection's id.
   * @param {number|null} [options.lastSequence] - the client's watermark.
   * @param {() => number} [options.clock] - injectable clock.
   * @param {number} [options.maxBacklogEvents] - outbound frame ceiling.
   * @param {number} [options.maxBacklogBytes] - outbound byte ceiling.
   * @param {number} [options.heartbeatMs] - application heartbeat period.
   * @param {number} [options.pingIntervalMs] - protocol ping period.
   * @param {object} [options.timers] - injectable timers, for tests.
   * @param {(info: object) => void} [options.onClosed] - called once when closed.
   */
  constructor(options) {
    if (options?.socket === undefined) throw new TypeError('ClientSession requires a socket');
    if (options?.events === undefined) throw new TypeError('ClientSession requires an events service');
    if (typeof options?.sessionId !== 'string' || options.sessionId.length === 0) {
      throw new TypeError('ClientSession requires a session id');
    }

    this.socket = options.socket;
    this.events = options.events;
    /**
     * The durable replay source, when the Gateway has one (R5).
     *
     * `null` keeps R4 behaviour exactly: bounds and history come from the in-memory
     * ring. When present, the same interface is answerable from disk.
     *
     * @type {object|null}
     */
    this.replayStore = options.replayStore ?? null;
    this.sessionId = options.sessionId;
    this.connectionId = options.connectionId ?? `conn-${Math.random().toString(36).slice(2, 10)}`;
    this.lastSequence = options.lastSequence ?? null;
    this.clock = options.clock ?? Date.now;
    this.onClosed = options.onClosed ?? null;
    this.startedAt = observedNow(this.clock);

    this.state = CONNECTION_STATE.CONNECTED;
    this.closeCode = null;
    this.closeReason = null;
    this.clientFramesAccepted = 0;
    this.clientFramesRejected = 0;
    /** Set by `prepare`, between the boundary capture and `run`. */
    this.prepared = null;
    /**
     * Closed during the replay handoff.
     *
     * While it is set, `deliver` refuses to write so the ordered drain inside
     * `begin` cannot be raced by a concurrent live write. The handoff's own
     * listener captures the event instead, and the drain picks it up.
     */
    this.draining = false;
    /** The highest Gateway sequence already handed to the transport. */
    this.lastSentSequence = null;
    /** Set by the owner: the point at which the handshake is complete. */
    this.onHandshakeComplete = options.onHandshakeComplete ?? null;

    this.backlog = new Backlog({
      send: (text, done) => this.socket.send(text, done),
      maxEvents: options.maxBacklogEvents,
      maxBytes: options.maxBacklogBytes,
      onOverflow: (info) => this.#handleOverflow(info),
    });

    this.heartbeat = new Heartbeat({
      onHeartbeat: () => this.#sendHeartbeat(),
      onPing: () => this.#ping(),
      onDead: (info) => this.#handleDeadPeer(info),
      intervalMs: options.heartbeatMs,
      pingIntervalMs: options.pingIntervalMs,
      setInterval: options.timers?.setInterval.bind(options.timers),
      clearInterval: options.timers?.clearInterval.bind(options.timers),
      clock: this.clock,
    });

    /** The captured-event handle from `beginReplay`, once started. */
    this.handoff = null;
  }

  /**
   * Whether the connection can still accept frames.
   *
   * @returns {boolean} true when open.
   */
  get open() {
    return this.state !== CONNECTION_STATE.CLOSED && this.state !== CONNECTION_STATE.CLOSING;
  }

  /**
   * Capture the replay boundary and register the live listener.
   *
   * Split from `begin` so the owner can call this **before** the WebSocket
   * handshake is announced to the client. Otherwise an event emitted between the
   * handshake completing and the listener registering is in neither the captured
   * history nor the pending queue, and is lost with no way for the client to know.
   *
   * **Phase R5:** the boundary may come from durable storage, so this awaits. The
   * listener registration inside `beginReplay` happens *before* that await, so an
   * event emitted during the read is captured rather than missed.
   *
   * @returns {Promise<object>} the replay decision.
   */
  async prepare() {
    if (this.prepared !== null) return this.prepared.decision;
    const { handle, decision, historical } = await beginReplay({
      events: this.events,
      sessionId: this.sessionId,
      requested: this.lastSequence,
      // R5: prefer the durable replay source when the Gateway has one. The WS layer
      // does not know or care whether this reads RAM or disk (§26).
      ...(this.replayStore === null ? {} : { store: this.replayStore }),
    });
    this.handoff = handle;
    this.prepared = { handle, decision, historical };
    return decision;
  }

  /**
   * Send the opening sequence: hello, history, handoff flush, replay_complete.
   *
   * Order matters. `replay_complete` is the seam marker, so every replayed event
   * must precede it — including the events captured *during* replay. Sending the
   * flush after the marker would make a live event indistinguishable from
   * replayed history, and would lose it entirely if the flush overflowed.
   *
   * @returns {Promise<{mode: string, replayed: number, outcome: string}>} what happened.
   */
  async begin() {
    if (this.state === CONNECTION_STATE.LIVE) {
      return { mode: 'live_only', replayed: 0, outcome: REPLAY_OUTCOME.LIVE };
    }
    await this.prepare();
    const { handle, decision, historical } = this.prepared;

    const bounds = this.replayStore === null
      ? this.events.sequenceBounds(this.sessionId)
      : await this.replayStore.bounds(this.sessionId);

    this.#send(helloFrame({
      connectionId: this.connectionId,
      sessionId: this.sessionId,
      serverTime: observedNow(this.clock),
      latest: bounds.latest,
      earliestAvailable: bounds.earliest,
      requestedFrom: this.lastSequence,
      mode: decision.mode,
    }), true);

    // A resync is decided before any replay: the client must refresh REST state,
    // so there is nothing useful to send first.
    if (decision.outcome === REPLAY_OUTCOME.RESYNC) {
      this.#send(resyncRequiredFrame({
        sessionId: this.sessionId,
        reason: decision.reason,
        requestedSequence: this.lastSequence ?? 0,
        earliestAvailable: bounds.earliest,
        latestAvailable: bounds.latest,
      }), true);
      this.#finishClose(APP_CLOSE.RESYNC_REQUIRED);
      this.#announceHandshake();
      return { mode: decision.mode, replayed: 0, outcome: decision.outcome };
    }

    this.state = CONNECTION_STATE.REPLAYING;
    // Close the live-write gate. From here until the handoff is finalised, a
    // concurrent `deliver` would write outside the ordered drain, so it is refused
    // and the handoff's own listener captures the event instead.
    this.draining = true;

    // 1. Historical frames: the retained events at or below the boundary.
    for (const event of historical) this.#sendEvent(event);

    // 2. Finalise synchronously: drain everything the handoff captured, then stop
    //    its listener in the same tick. Both operations are synchronous, so no
    //    event can be emitted into the gap between them — which is what makes
    //    "everything drained lands before the marker" a real guarantee rather than
    //    a hopeful one.
    const flushed = this.#finaliseHandoff();

    // 3. The seam marker. It is queued, not written immediately, and only after
    //    the queue has fully drained — otherwise it would overtake the replayed
    //    frames still waiting for the transport and the client would see live
    //    frames on the wrong side of the seam.
    const marker = replayCompleteFrame({
      sessionId: this.sessionId,
      fromSequence: historical.length > 0 ? historical[0].sequence : null,
      throughSequence: historical.length > 0
        ? historical[historical.length - 1].sequence
        : null,
      replayed: historical.length,
    });

    this.backlog.notifyOnIdle(() => {
      this.#send(marker);
      // The marker is now queued, so live delivery may resume. Any event that was
      // captured before the handoff was finalised is already in the queue ahead of
      // the marker.
      this.state = CONNECTION_STATE.LIVE;
      this.draining = false;
      this.#announceHandshake();
      this.heartbeat.start();
    });

    return { mode: decision.mode, replayed: historical.length, outcome: decision.outcome };
  }

  /**
   * Drain the handoff and stop its listener, synchronously and in that order.
   *
   * @returns {object[]} the events sent.
   */
  #finaliseHandoff() {
    const sent = this.#drainNow();
    // Stop receiving *after* the final drain: an event emitted between the drain
    // and the stop would be captured and then never read.
    this.handoff?.stop();
    return sent;
  }

  /**
   * Take everything the handoff has captured and send it.
   *
   * @returns {object[]} the events actually sent.
   */
  #drainNow() {
    if (this.handoff === null) return [];
    const pending = this.handoff.pending;
    if (pending.length === 0) return [];

    const ordered = [...pending].sort((left, right) => left.sequence - right.sequence);
    pending.length = 0;

    const sent = [];
    for (const event of ordered) {
      // `#sendEvent` de-duplicates by sequence, so an event already sent as
      // history or already drained is not repeated.
      if (this.#sendEvent(event)) sent.push(event);
    }
    return sent;
  }

  /**
   * Notify the owner that the handshake is complete.
   *
   * @returns {void}
   */
  #announceHandshake() {
    try {
      this.onHandshakeComplete?.(this);
    } catch {
      // An observer must not break the connection setup.
    }
  }

  /**
   * Deliver one Gateway event to this client.
   *
   * Called by the subscriber registry. While the handoff is still running the
   * event is captured by `beginReplay`'s listener instead, so this returns false
   * and the owner drains it through `drainPending` once the handoff completes.
   *
   * @param {object} event - a Gateway event for this session.
   * @returns {boolean} true when the event entered the backlog.
   */
  deliver(event) {
    if (!this.open || event?.session_id !== this.sessionId) return false;
    if (this.state === CONNECTION_STATE.REPLAYING || this.draining === true) return false;
    return this.#sendEvent(event);
  }

  /**
   * Take any events the handoff captured after its own flush ran.
   *
   * §26 allows an event to arrive *during* replay. The flush covers everything
   * captured up to that point, but between the flush and `LIVE` another event can
   * still land in the pending queue. Returning it here means the owner can publish
   * it instead of losing it.
   *
   * @returns {object[]} events to deliver now, strictly ascending.
   */
  drainPending() {
    if (this.handoff === null) return [];
    const pending = this.handoff.pending;
    if (pending.length === 0) return [];
    const ordered = [...pending].sort((left, right) => left.sequence - right.sequence);
    pending.length = 0;
    // `#sendEvent` de-duplicates, so an event already sent as history or already
    // captured by the flush is not repeated here.
    const delivered = [];
    for (const event of ordered) {
      if (this.#sendEvent(event)) delivered.push(event);
    }
    return delivered;
  }

  /**
   * Serialise and enqueue an event frame.
   *
   * De-duplicates by Gateway sequence. That makes the replay/live seam safe even
   * if an event is offered twice — once as captured history and once via the live
   * fan-out — which is exactly the race §26 requires to be exactly-once.
   *
   * @param {object} event - a Gateway event.
   * @returns {boolean} true when accepted.
   */
  #sendEvent(event) {
    if (!Number.isSafeInteger(event?.sequence)) {
      // A malformed event is not silently sent; the domain guarantees a sequence.
      return false;
    }
    if (this.lastSentSequence !== null && event.sequence <= this.lastSentSequence) {
      return false; // already delivered
    }
    const result = this.backlog.enqueue(eventFrame(event), { sequence: event.sequence });
    if (result.accepted) this.lastSentSequence = event.sequence;
    return result.accepted;
  }

  /**
   * Serialise and enqueue any frame.
   *
   * Control frames are marked `critical`: they must reach the client even when
   * the backlog is at its ceiling. Otherwise a small backlog could close the
   * socket *before* the frame explaining why — the client would see a bare close
   * with no reason, which §29 forbids.
   *
   * @param {object} frame - the frame.
   * @param {boolean} [critical] - bypass the caps.
   * @returns {boolean} true when accepted.
   */
  #send(frame, critical = false) {
    if (critical === true) {
      this.backlog.sendImmediate(frame);
      return true;
    }
    return this.backlog.enqueue(frame).accepted;
  }

  /**
   * Emit an application heartbeat (§17).
   *
   * @returns {void}
   */
  #sendHeartbeat() {
    if (!this.open) return;
    const bounds = this.events.sequenceBounds(this.sessionId);
    this.#send(heartbeatFrame({
      serverTime: observedNow(this.clock),
      sessionId: this.sessionId,
      latestSequence: bounds.latest,
    }));
  }

  /**
   * Send an RFC 6455 ping (§18).
   *
   * @returns {void}
   */
  #ping() {
    if (!this.open) return;
    try {
      this.socket.ping?.();
    } catch {
      // The transport is already gone; the missing-pong path will finish cleanup.
    }
  }

  /**
   * Handle a missed pong: the peer is dead.
   *
   * A phone disconnect never touches domain state (§38).
   *
   * @param {object} info - ping statistics.
   * @returns {void}
   */
  #handleDeadPeer(info) {
    this.#finishClose(STANDARD_CLOSE.GOING_AWAY, `dead peer (${info.pingsSent} pings unanswered)`, {
      terminate: true,
    });
  }

  /**
   * Handle a backlog overflow (§29).
   *
   * The overflow frame bypasses the caps and the connection is then closed with
   * 4003, so the client reconnects from the last sequence it actually holds.
   * Nothing is silently dropped.
   *
   * @param {object} info - overflow facts.
   * @returns {void}
   */
  #handleOverflow(info) {
    if (!this.open) return;
    const bounds = this.events.sequenceBounds(this.sessionId);
    // Best effort: the frame may not fit, in which case the close below is all
    // the client learns — and that is still explicit, not silent.
    this.backlog.enqueueBypass(overflowFrame({
      sessionId: this.sessionId,
      lastDeliveredSequence: info.lastDeliveredSequence,
      latestSequence: bounds.latest,
    }));
    this.#finishClose(APP_CLOSE.BACKLOG_OVERFLOW, closeReason(APP_CLOSE.BACKLOG_OVERFLOW));
  }

  /**
   * Accept one client-to-server frame (§31).
   *
   * @param {unknown} raw - the decoded payload.
   * @param {(raw: unknown) => {ok: boolean, reason?: string}} validate - the validator.
   * @returns {{accepted: boolean, reason: string|null}} the decision.
   */
  acceptClientFrame(raw, validate) {
    if (!this.open) return { accepted: false, reason: 'closed' };
    const result = validate(raw);
    if (result.ok) {
      this.clientFramesAccepted += 1;
      if (result.type === 'client_ping') {
        // Answer with the application heartbeat so a client can measure liveness
        // without inventing a second channel.
        this.#sendHeartbeat();
      }
      return { accepted: true, reason: null };
    }

    this.clientFramesRejected += 1;
    this.#send(errorFrame({
      code: 'CLIENT_MESSAGE_NOT_ALLOWED',
      message: result.reason ?? 'Client frames are not accepted on this endpoint.',
      retryable: false,
      connectionId: this.connectionId,
    }));
    this.#finishClose(APP_CLOSE.CLIENT_MESSAGE_NOT_ALLOWED, closeReason(APP_CLOSE.CLIENT_MESSAGE_NOT_ALLOWED));
    return { accepted: false, reason: result.reason ?? 'rejected' };
  }

  /**
   * Note a pong from the peer.
   *
   * @returns {void}
   */
  notePong() {
    this.heartbeat.notePong();
  }

  /**
   * Send a safe error frame without closing.
   *
   * @param {object} input - error input.
   * @param {string} input.code - a stable code.
   * @param {string} input.message - a safe message.
   * @param {boolean} [input.retryable] - retryability.
   * @returns {void}
   */
  sendError(input) {
    if (!this.open) return;
    this.#send(errorFrame({ ...input, connectionId: this.connectionId }));
  }

  /**
   * Announce and perform a server-initiated close (§40).
   *
   * @param {string} [reason] - recorded reason.
   * @returns {void}
   */
  shutdown(reason = 'server_shutdown') {
    if (!this.open) return;
    this.#send(serverShutdownFrame(), true);
    this.#finishClose(STANDARD_CLOSE.GOING_AWAY, reason);
  }

  /**
   * Close the connection.
   *
   * @param {string} [reason] - recorded reason.
   * @returns {Promise<void>} resolves once the socket is closed.
   */
  async close(reason = 'closed by server') {
    if (this.state === CONNECTION_STATE.CLOSED) return;
    this.#finishClose(STANDARD_CLOSE.NORMAL, reason);
  }

  /**
   * Perform the terminal transition exactly once.
   *
   * @param {number} code - the close code.
   * @param {string} reason - the close reason.
   * @param {object} [options] - close options.
   * @param {boolean} [options.terminate] - destroy the socket instead of closing.
   * @returns {void}
   */
  #finishClose(code, reason, options = {}) {
    if (this.state === CONNECTION_STATE.CLOSED) return;
    const previous = this.state;
    this.state = CONNECTION_STATE.CLOSING;

    this.heartbeat.stop();
    this.handoff?.stop();
    this.closeCode = code;
    this.closeReason = reason ?? closeReason(code);

    try {
      if (options.terminate === true) this.socket.terminate?.();
      else this.socket.close?.(code, this.closeReason);
    } catch {
      // The transport may already be destroyed; the state machine still completes.
    }

    this.backlog.close();
    this.state = CONNECTION_STATE.CLOSED;
    try {
      this.onClosed?.({ connectionId: this.connectionId, sessionId: this.sessionId, code, reason: this.closeReason, previous });
    } catch {
      // A close observer must not break teardown.
    }
  }

  /**
   * A snapshot for diagnostics and tests.
   *
   * @returns {object} the state.
   */
  stats() {
    return {
      connectionId: this.connectionId,
      sessionId: this.sessionId,
      state: this.state,
      lastSequence: this.lastSequence,
      closeCode: this.closeCode,
      closeReason: this.closeReason,
      clientFramesAccepted: this.clientFramesAccepted,
      clientFramesRejected: this.clientFramesRejected,
      backlog: this.backlog.stats(),
      heartbeat: this.heartbeat.stats(),
    };
  }
}

export { CONNECTION_STATE, FRAME, REPLAY_MODE };
