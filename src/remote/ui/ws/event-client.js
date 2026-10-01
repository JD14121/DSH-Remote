/**
 * EventClient — the single owner of the WebSocket.
 *
 * ## Why one owner
 *
 * Components must never construct a WebSocket. Every socket in the application is created,
 * tracked and closed here, which is what makes the invariants checkable in one place:
 *
 * * **at most one socket per active session**;
 * * **one ticket per connection attempt**, never reused;
 * * **every asynchronous callback is generation-checked**, so a late frame or close from a
 *   superseded socket cannot touch current state;
 * * **the Gateway sequence is never synthesised** — it comes from the events, or it is absent.
 *
 * ## Transport states are not UI states
 *
 * The socket moves through `idle → ticketing → connecting → replaying → live → closing →
 * disconnected`. These are **internals** (§9) and are deliberately kept out of the six frozen
 * UI connection states. The mapping to those six happens in one function, `uiConnectionState`.
 *
 * ## Sequence discipline (§11–12)
 *
 * `lastAppliedSequence` starts from the REST snapshot (`lastSequence` supplied by the caller)
 * or from the last successfully applied Gateway event. It is never derived from a timestamp, a
 * local counter or a message index.
 *
 * ```text
 * seq <= lastAppliedSequence   → already applied; ignore
 * seq == lastAppliedSequence+1 → apply, advance
 * seq  > lastAppliedSequence+1 → GAP: do not guess, do not advance, require resync
 * ```
 *
 * A gap sets `resync_required` and stops applying. The recovery *workflow* is R8E's; R8D only
 * detects and surfaces it.
 */

import {
  FRAME,
  UI_EVENT,
  classifyClose,
  normalizeFrame,
} from './event-normalizer.js';
import { StreamAssembler } from './stream-assembler.js';
import { buildEventsUrl, redactTicketUrl, requestTicket } from './ticket-client.js';

/** Transport-internal socket states. NOT the six UI connection states. */
export const SOCKET_STATE = Object.freeze({
  IDLE: 'idle',
  TICKETING: 'ticketing',
  CONNECTING: 'connecting',
  REPLAYING: 'replaying',
  LIVE: 'live',
  CLOSING: 'closing',
  DISCONNECTED: 'disconnected',
});

/**
 * Map transport state plus close classification onto the six frozen UI states.
 *
 * @param {object} input - `socketState`, `closeKind`, `resyncRequired`.
 * @returns {string} one of the six UI connection states.
 */
export function uiConnectionState(input) {
  if (input.resyncRequired === true) return 'resync_required';
  switch (input.socketState) {
    case SOCKET_STATE.IDLE:
      return 'connecting';
    case SOCKET_STATE.TICKETING:
      return 'connecting';
    case SOCKET_STATE.CONNECTING:
      return 'connecting';
    case SOCKET_STATE.REPLAYING:
      // The socket is open but the replay boundary has NOT been reached, so the UI is not yet
      // fully live (§10). Reporting `connected` here would claim history is complete.
      return 'connecting';
    case SOCKET_STATE.LIVE:
      return 'connected';
    case SOCKET_STATE.CLOSING:
      return 'reconnecting';
    case SOCKET_STATE.DISCONNECTED:
      if (input.closeKind === 'auth_failure') return 'auth_required';
      if (input.closeKind === 'network' || input.closeKind === 'server_close') return 'reconnecting';
      return 'gateway_unavailable';
    default:
      return 'connecting';
  }
}

/**
 * Validate a caller-supplied REST-sequence seed.
 *
 * Returns `null` for anything that is not a real Gateway sequence, so a string, a float or a
 * timestamp can never be adopted as one.
 *
 * @param {unknown} value - the candidate.
 * @returns {number|null} the seed.
 */
export function seedSequence(value) {
  if (typeof value !== 'number') return null;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/**
 * The event client for exactly one session.
 */
export class EventClient {
  /**
   * @param {object} options - see the constructor body.
   */
  constructor(options = {}) {
    if (typeof options.sessionId !== 'string' || options.sessionId.length === 0) {
      throw new TypeError('EventClient requires a sessionId');
    }
    this.sessionId = options.sessionId;
    this.baseUrl = options.baseUrl ?? '';
    this.credential = options.credential ?? null;
    this.fetchImpl = options.fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
    this.WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket ?? null;
    this.onTransport = typeof options.onTransport === 'function' ? options.onTransport : () => {};
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
    this.onGap = typeof options.onGap === 'function' ? options.onGap : () => {};

    /**
     * The sequence to request on connect and to compare against.
     *
     * Seeded from the REST snapshot. Never invented from a clock or a counter.
     *
     * @type {number|null}
     */
    this.lastAppliedSequence = seedSequence(options.lastSequence);

    /**
     * Increments for every socket lifecycle.
     *
     * Every asynchronous callback captures the generation it belongs to and returns early when
     * it no longer matches, so a superseded socket cannot write state.
     *
     * @type {number}
     */
    this.generation = 0;

    /** @type {object} transport state. */
    this.socketState = SOCKET_STATE.IDLE;
    /** @type {string|null} */
    this.closeKind = null;
    /** @type {boolean} */
    this.resyncRequired = false;
    /** @type {import('ws').WebSocket|null} — never exposed outside this class. */
    this.socket = null;
    /** @type {string|null} the in-flight ticket. Cleared the moment it is used. */
    this.pendingTicket = null;
    this.streams = new StreamAssembler();
    this.closed = false;
    /**
     * Resolves when the socket reaches OPEN, or immediately when it never will.
     *
     * `connect()` awaits this so it does not return while the handshake is still in flight.
     *
     * @type {Promise<void>}
     */
    /**
     * Counts tickets requested, so a test can prove a reconnect obtained a FRESH one rather
     * than reusing the previous value (§25).
     *
     * @type {number}
     */
    this.ticketsRequested = 0;
  }

  /**
   * The normalized events and stream messages this client produces.
   *
   * Deliberately does not expose the socket, the ticket, or any raw frame.
   *
   * @returns {object} the observable state.
   */
  get state() {
    return {
      sessionId: this.sessionId,
      generation: this.generation,
      socketState: this.socketState,
      closeKind: this.closeKind,
      resyncRequired: this.resyncRequired,
      lastAppliedSequence: this.lastAppliedSequence,
      uiConnection: uiConnectionState({
        socketState: this.socketState,
        closeKind: this.closeKind,
        resyncRequired: this.resyncRequired,
      }),
      streaming: this.streams.streaming,
    };
  }

  /**
   * Update the transport state and notify.
   *
   * @param {string} next - the new socket state.
   * @returns {void}
   */
  #setState(next) {
    this.socketState = next;
    this.onTransport(this.state);
  }

  /**
   * Connect: obtain a ticket, then open the socket.
   *
   * @returns {Promise<object>} the state after the attempt begins.
   */
  async connect() {
    if (this.closed) return this.state;

    // Retire any existing socket FIRST. Bumping the generation is not enough on its own: the old
    // socket would stay open, so the session would briefly have two live connections and the
    // server would keep a stray peer.
    const previous = this.socket;
    this.socket = null;
    if (previous !== null) {
      try {
        previous.close(1000, 'superseded');
      } catch {
        /* already gone */
      }
    }

    // A newer generation supersedes anything still in flight.
    this.generation += 1;
    const generation = this.generation;

    this.resyncRequired = false;
    this.closeKind = null;
    this.#setState(SOCKET_STATE.TICKETING);

    const ticket = await this.#acquireTicket(generation);
    if (ticket === null) return this.state;

    await this.#open(ticket, generation);
    return this.state;
  }

  /**
   * Obtain a ticket for this generation.
   *
   * Returns `null` when the attempt must be abandoned — either because the ticket could not be
   * obtained (state already reflects why), or because a newer generation superseded it while the
   * request was in flight.
   *
   * @param {number} generation - this attempt's lifecycle.
   * @returns {Promise<string|null>} the ticket, or null.
   */
  async #acquireTicket(generation) {
    let ticket;
    try {
      this.ticketsRequested += 1;
      ticket = await requestTicket({
        fetchImpl: this.fetchImpl,
        baseUrl: this.baseUrl,
        credential: this.credential,
        sessionId: this.sessionId,
      });
    } catch (error) {
      // A superseded attempt must not overwrite the state of the attempt that replaced it.
      if (generation !== this.generation) return null;
      // A rejected credential is the one case that must not look like a network drop.
      this.closeKind = error?.kind === 'auth_required' ? 'auth_failure' : 'network';
      this.#setState(SOCKET_STATE.DISCONNECTED);
      return null;
    }

    if (generation !== this.generation || this.closed) return null;
    return ticket;
  }

  /**
   * Open the socket with a ticket.
   *
   * Returns a promise that settles when **this** socket opens, errors or closes, so `connect()`
   * can await the handshake without reading state back off the instance.
   *
   * @param {string} ticket - the one-time ticket.
   * @param {number} generation - the lifecycle this socket belongs to.
   * @returns {Promise<void>} settles when the dial concludes.
   */
  #open(ticket, generation) {
    if (this.WebSocketImpl === null) {
      this.closeKind = 'network';
      this.#setState(SOCKET_STATE.DISCONNECTED);
      return Promise.resolve();
    }

    this.pendingTicket = ticket;
    const url = buildEventsUrl({
      baseUrl: this.baseUrl,
      sessionId: this.sessionId,
      ticket,
      ...(this.lastAppliedSequence === null ? {} : { lastSequence: this.lastAppliedSequence }),
    });

    this.#setState(SOCKET_STATE.CONNECTING);

    let socket;
    try {
      // The subprotocol is mandatory in this protocol, not decorative.
      socket = new this.WebSocketImpl(url, ['dsh-remote-v1']);
    } catch (cause) {
      // A construction failure is a real, actionable fault — most often a malformed URL — and it
      // must not be silent. Swallowing it here is what made R8G3-OPEN-1 expensive: the socket
      // simply never dialled, the caller saw a network-shaped failure, and the UI reported
      // "Gateway unavailable" even though the Gateway had just answered health `200`,
      // sessions `200` and ticket `201`. `redactTicketUrl` keeps the ticket out of the message.
      this.pendingTicket = null;
      this.closeKind = 'network';
      this.lastConstructionError = {
        name: cause?.name ?? 'Error',
        message: String(cause?.message ?? cause).slice(0, 200),
        url: redactTicketUrl(url),
      };
      this.onTransport?.('socket_construction_failed', { ...this.lastConstructionError });
      this.#setState(SOCKET_STATE.DISCONNECTED);
      return Promise.resolve();
    }

    // The ticket has been handed to the socket; drop our reference immediately so it is never
    // reused for a later connection.
    this.pendingTicket = null;
    this.socket = socket;

    // Settles whether the socket opens, errors or closes, so a failed dial cannot leave the
    // caller waiting forever.
    const opened = new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      socket.addEventListener('open', settle);
      socket.addEventListener('error', settle);
      socket.addEventListener('close', settle);
    });

    socket.addEventListener('open', () => {
      if (generation !== this.generation) return;
      // Open is NOT live: the replay boundary has not been reached yet (§10).
      this.#setState(SOCKET_STATE.REPLAYING);
    });

    socket.addEventListener('message', (message) => {
      if (generation !== this.generation) return;
      this.#onMessage(message);
    });

    socket.addEventListener('error', () => {
      if (generation !== this.generation) return;
      // The error event carries no useful detail, and nothing from it is surfaced.
      this.closeKind = this.closeKind ?? 'network';
    });

    socket.addEventListener('close', (closeEvent) => {
      if (generation !== this.generation) return;
      this.#onClose(closeEvent);
    });

    return opened;
  }

  /**
   * Handle one inbound frame.
   *
   * @param {object} message - the WebSocket message event.
   * @returns {void}
   */
  #onMessage(message) {
    let raw;
    try {
      raw = typeof message.data === 'string' ? JSON.parse(message.data) : JSON.parse(String(message.data));
    } catch {
      // An unparseable frame is a protocol violation, not a reason to crash.
      this.onEvent({ type: 'unparseable' });
      return;
    }

    const frame = normalizeFrame(raw);

    switch (frame.type) {
      case FRAME.HELLO:
        // The handshake confirms identity. A hello for a different session means this socket
        // belongs to a session we are no longer on: refuse to apply anything from it.
        if (frame.sessionId !== null && frame.sessionId !== this.sessionId) {
          this.closeKind = 'protocol_violation';
          this.close();
          return;
        }
        this.onEvent({ type: 'hello', frame });
        return;

      case FRAME.REPLAY_COMPLETE:
        // Only now is the connection fully live.
        this.#setState(SOCKET_STATE.LIVE);
        this.onEvent({ type: 'replay-complete', frame });
        return;

      case FRAME.EVENT:
        this.#onEventFrame(frame);
        return;

      case FRAME.HEARTBEAT:
        // Liveness only. Never applied as a domain event.
        this.onEvent({ type: 'heartbeat', frame });
        return;

      case FRAME.RESYNC_REQUIRED:
        // R8D detects and surfaces this; R8E performs the recovery workflow.
        this.resyncRequired = true;
        this.#setState(this.socketState);
        this.onEvent({ type: 'resync-required', frame });
        return;

      case FRAME.OVERFLOW:
        // Dropped frames mean a gap we cannot close from this socket.
        this.resyncRequired = true;
        this.#setState(this.socketState);
        this.onEvent({ type: 'overflow', frame });
        return;

      case FRAME.SERVER_SHUTDOWN:
        this.closeKind = 'server_close';
        this.onEvent({ type: 'server-shutdown', frame });
        return;

      case FRAME.ERROR:
        if (frame.retryable === true) this.closeKind = 'server_close';
        this.onEvent({ type: 'server-error', frame });
        return;

      default:
        // An unrecognised frame is inert. It must never break the socket.
        this.onEvent({ type: 'unsupported', frame });
        return;
    }
  }

  /**
   * Apply the sequence rule to one event and dispatch it.
   *
   * @param {object} frame - the normalized event frame.
   * @returns {void}
   */
  #onEventFrame(frame) {
    // Session identity is checked before anything is applied, so a frame from another session
    // can never reach this session's state (§7).
    if (frame.sessionId !== null && frame.sessionId !== this.sessionId) {
      this.onEvent({ type: 'foreign-session', frame });
      return;
    }

    if (this.resyncRequired) {
      // Once a gap has been detected, nothing further is applied from this socket: applying a
      // later sequence would silently skip the missing events.
      this.onEvent({ type: 'suppressed-after-resync', frame });
      return;
    }

    const sequence = frame.sequence;

    if (sequence === null) {
      // Presentation-only events (a streaming delta) carry no Gateway sequence. They are
      // applied directly, and they never move `lastAppliedSequence`.
      this.#dispatch(frame);
      return;
    }

    if (this.lastAppliedSequence === null) {
      // No REST snapshot to anchor against. Accept the first sequenced event as the baseline
      // rather than inventing one from a clock or a counter.
      this.lastAppliedSequence = sequence;
      this.#dispatch(frame);
      return;
    }

    if (sequence <= this.lastAppliedSequence) {
      // Already applied. Replay makes this normal and it must be silent.
      this.onEvent({ type: 'duplicate', frame });
      return;
    }

    if (sequence > this.lastAppliedSequence + 1) {
      // A gap. Do not guess, and do not advance — advancing would permanently hide the
      // missing events.
      this.resyncRequired = true;
      this.onGap({ expected: this.lastAppliedSequence + 1, received: sequence });
      this.#setState(this.socketState);
      this.onEvent({ type: 'gap', frame, expected: this.lastAppliedSequence + 1 });
      return;
    }

    this.lastAppliedSequence = sequence;
    this.#dispatch(frame);
  }

  /**
   * Dispatch an accepted event to the stream assembler and the consumer.
   *
   * @param {object} frame - the normalized event frame.
   * @returns {void}
   */
  #dispatch(frame) {
    // After authoritative replacement, a tail whose start precedes the snapshot has no
    // provable identity link to REST history. Keep REST authoritative; do not create a second
    // assistant from that tail. Ordinary reconnect retains its existing assembler instead.
    if (this.requireStreamStart === true
        && (frame.event === UI_EVENT.ASSISTANT_DELTA || frame.event === UI_EVENT.ASSISTANT_END)
        && !this.streams.active().some(message => frame.data?.attempt_id
          ? message.attemptId === frame.data.attempt_id : message.attemptId === null)) {
      this.onEvent({ type: 'unmatched-stream-tail', frame });
      return;
    }
    switch (frame.event) {
      case UI_EVENT.ASSISTANT_START: {
        const message = this.streams.start(frame);
        if (message !== null) this.onEvent({ type: 'stream-start', message, frame });
        return;
      }
      case UI_EVENT.ASSISTANT_DELTA: {
        const message = this.streams.delta(frame);
        if (message !== null) this.onEvent({ type: 'stream-delta', message, frame });
        return;
      }
      case UI_EVENT.ASSISTANT_END: {
        const message = this.streams.end(frame);
        if (message !== null) this.onEvent({ type: 'stream-end', message, frame });
        return;
      }
      default:
        // Every other event is passed through as a domain event. Inert/unknown events are
        // marked, and the consumer ignores them.
        this.onEvent({ type: 'domain', frame });
        return;
    }
  }

  /**
   * Handle a close for this generation.
   *
   * @param {object} closeEvent - `code`, `wasClean`.
   * @returns {void}
   */
  #onClose(closeEvent) {
    const classification = classifyClose({
      code: closeEvent?.code,
      wasClean: closeEvent?.wasClean,
    });
    // A deliberate local close is not a failure.
    this.closeKind = this.closed ? 'intentional' : classification.kind;
    this.socket = null;
    const requiresReload = !this.closed && classification.code === 4001;
    if (requiresReload) this.resyncRequired = true;

    // §17: a stream cut off mid-flight keeps its partial text. Nothing is deleted, completed
    // or invented here.
    const interrupted = this.streams.interruptAll({ retain: true });
    if (interrupted.length > 0) this.onEvent({ type: 'stream-interrupted', messages: interrupted });

    this.#setState(SOCKET_STATE.DISCONNECTED);
    if (requiresReload) {
      this.onEvent({ type: 'resync-required' });
      return;
    }
    this.onEvent({ type: 'close', classification, retryable: classification.retryable && !this.closed });
  }

  /**
   * Send the protocol's client ping.
   *
   * The R4 contract defines `client_ping` as the application-level liveness frame; the browser
   * WebSocket API cannot send a protocol-level ping, so this is the correct substitute and no
   * new ping format is invented (§22).
   *
   * @returns {boolean} true when the frame was sent.
   */
  ping() {
    if (this.socket === null || this.socketState !== SOCKET_STATE.LIVE) return false;
    try {
      this.socket.send(JSON.stringify({ type: 'client_ping' }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Close the socket deliberately.
   *
   * @param {number} [code] - the close code.
   * @returns {void}
   */
  close(code = 1000) {
    this.closed = true;
    // Invalidate any in-flight callback from a previous generation.
    this.generation += 1;
    const socket = this.socket;
    this.socket = null;
    this.pendingTicket = null;
    if (socket !== null) {
      this.#setState(SOCKET_STATE.CLOSING);
      try {
        socket.close(code, 'client closing');
      } catch {
        /* already gone */
      }
    }
    this.#setState(SOCKET_STATE.DISCONNECTED);
  }
}
