/**
 * Live session binding: the controller that owns the socket for the **active** session.
 *
 * ## Why this exists
 *
 * The rule R8D has to make structurally true is *at most one socket, for exactly one session*,
 * and *a frame from session A can never be applied to session B*. Both are properties of the
 * binding, not of the socket, so they live here.
 *
 * Every bind carries a **generation**. Switching sessions increments it, closes the previous
 * socket, and cancels any pending reconnect. Any callback that arrives afterwards belongs to a
 * generation that is no longer current and is dropped — including a reconnect timer that fires
 * after the user moved on.
 *
 * ## Domain changes only
 *
 * The binding reports domain events upward. It never mutates UI state itself and never invents
 * an assistant reply: a `200` from REST still only means *accepted*, and only a Gateway event
 * advances a domain status.
 */

import { EventClient } from './event-client.js';
import { ReconnectController } from './reconnect-controller.js';

/**
 * The live binding for one Open session at a time.
 */
export class LiveSessionBinding {
  /**
   * @param {object} options - `baseUrl`, `credential`, `fetchImpl`, `WebSocketImpl`,
   *   `onDomainEvent`, `onConnectionChange`, `onResyncRequired`, `reconnect`, `backoffMs`.
   */
  constructor(options = {}) {
    this.baseUrl = options.baseUrl ?? '';
    this.credential = options.credential ?? null;
    this.fetchImpl = options.fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
    this.WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket ?? null;
    this.onDomainEvent = typeof options.onDomainEvent === 'function' ? options.onDomainEvent : () => {};
    this.onConnectionChange = typeof options.onConnectionChange === 'function' ? options.onConnectionChange : () => {};
    this.onResyncRequired = typeof options.onResyncRequired === 'function' ? options.onResyncRequired : () => {};
    this.onStreamChange = typeof options.onStreamChange === 'function' ? options.onStreamChange : () => {};
    this.reconnectEnabled = options.reconnect !== false;
    this.backoffMs = options.backoffMs ?? undefined;

    /** @type {string|null} the session the socket belongs to. */
    this.sessionId = null;
    /** @type {ReconnectController|null} */
    this.controller = null;
    /** @type {number} incremented on every bind, so stale callbacks are recognisable. */
    this.generation = 0;
    /** @type {object[]} the transient streaming messages currently visible. */
    this.streamMessages = [];
  }

  /**
   * Bind the socket to a session, replacing any previous binding.
   *
   * @param {object} input - `sessionId`, `lastSequence`.
   * @returns {Promise<void>} when the attempt has begun.
   */
  async bind(input) {
    const sessionId = input?.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TypeError('LiveSessionBinding.bind requires a sessionId');
    }

    // Tear the previous binding down BEFORE establishing the new one, so the session can never
    // briefly have two sockets.
    this.unbind();

    this.generation += 1;
    const generation = this.generation;
    this.sessionId = sessionId;
    this.streamMessages = [];

    const controller = new ReconnectController({
      clientFactory: () => {
        const previous = this.controller?.client;
        const client = this.#makeClient(sessionId, previous?.lastAppliedSequence ?? input.lastSequence, generation);
        if (previous) client.streams = previous.streams;
        client.requireStreamStart = input.requireStreamStart === true;
        return client;
      },
      // Mobile WebViews are routinely suspended in the background. Keep retrying with the
      // controller's capped backoff so returning to an idle conversation can recover itself.
      maxAttempts: Infinity,
      onStateChange: (state) => {
        if (generation === this.generation) this.onConnectionChange(state);
      },
      ...(this.backoffMs === undefined ? {} : { backoffMs: this.backoffMs }),
    });
    this.controller = controller;

    if (this.reconnectEnabled) await controller.start();
    else await controller.start();

    // The binding may have been replaced while the ticket was in flight.
    if (generation !== this.generation) return;
  }

  /**
   * Build the EventClient for one socket lifecycle.
   *
   * @param {string} sessionId - the session.
   * @param {number|null} lastSequence - the REST snapshot watermark.
   * @param {number} generation - the binding generation that owns this client.
   * @returns {EventClient} the client.
   */
  #makeClient(sessionId, lastSequence, generation) {
    const client = new EventClient({
      sessionId,
      baseUrl: this.baseUrl,
      credential: this.credential,
      fetchImpl: this.fetchImpl,
      WebSocketImpl: this.WebSocketImpl,
      lastSequence,
      onEvent: (event) => {
        // Drop anything from a binding that is no longer current. This is the single check that
        // makes an old-session frame or a late reconnect harmless.
        if (generation !== this.generation) return;
        this.#onEvent(event, client);
      },
    });
    // The reconnect controller owns `onTransport`, so the connection state is surfaced from
    // there rather than being overwritten here.
    return client;
  }

  /**
   * Handle one event from the current generation.
   *
   * @param {object} event - the client event.
   * @param {EventClient} client - the owning client.
   * @returns {void}
   */
  #onEvent(event, client) {
    switch (event.type) {
      case 'stream-start':
      case 'stream-delta':
        // Keep a live view of the transient messages for rendering.
        this.streamMessages = client.streams.active();
        this.onStreamChange(this.streamMessages);
        return;
      case 'stream-end':
        this.streamMessages = client.streams.active();
        this.onStreamChange(this.streamMessages);
        this.onDomainEvent({ kind: 'stream-end', message: event.message });
        return;
      case 'stream-interrupted':
        // The partial text stays visible; the domain status is NOT advanced.
        this.streamMessages = client.streams.active();
        this.onStreamChange(this.streamMessages);
        this.onDomainEvent({ kind: 'stream-interrupted', messages: event.messages });
        return;
      case 'resync-required':
      case 'overflow':
      case 'gap':
        // R8D surfaces the requirement; R8E performs the recovery.
        this.onResyncRequired({ reason: event.type, frame: event.frame ?? null });
        return;
      case 'close':
        if (event.retryable === true && this.reconnectEnabled && !client.resyncRequired) {
          this.controller?.onClose({ retryable: true, closeKind: client.closeKind });
        }
        this.onConnectionChange(client.state);
        return;
      case 'domain':
        if (event.frame.inert === true) return; // an unknown event is inert by contract
        this.onDomainEvent({ kind: 'domain', frame: event.frame });
        return;
      default:
        return;
    }
  }

  /**
   * The connection state the UI should show, or null when nothing is bound.
   *
   * @returns {string|null} one of the six UI connection states.
   */
  uiConnection() {
    if (this.controller?.client == null) return null;
    return this.controller.client.state.uiConnection;
  }

  /**
   * Send the protocol liveness ping on the current socket.
   *
   * @returns {boolean} true when a frame was sent.
   */
  ping() {
    return this.controller?.client?.ping() ?? false;
  }

  /**
   * Close the current socket and cancel any pending reconnect.
   *
   * @returns {void}
   */
  unbind() {
    // Invalidate every callback from the outgoing binding first.
    this.generation += 1;
    if (this.controller !== null) this.controller.stop();
    this.controller = null;
    this.sessionId = null;
    this.streamMessages = [];
  }

  /**
   * Whether a socket is currently bound.
   *
   * @returns {boolean} true when bound.
   */
  get bound() {
    return this.sessionId !== null;
  }
}
