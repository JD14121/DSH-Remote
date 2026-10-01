/**
 * WebSocket server 鈥?Phase R4 搂5, 搂7, 搂8, 搂19, 搂26, 搂39, 搂41.
 *
 * **Same port, same lifecycle.** This attaches to the R3 HTTP server through
 * `ws`'s `noServer` mode and handles the `upgrade` event, so there is exactly one
 * listener, one loopback restriction and one `stop()`.
 *
 * 搂8 is the reason the upgrade handler is as strict as it is: Node's `upgrade`
 * event **bypasses the normal HTTP route handler**, so R3's Host fence does not
 * apply by itself. Every check is therefore re-applied here, before any 101, by
 * reusing R3's own validators rather than a second copy.
 *
 * 搂41: the upgrade route is *not* registered in the REST router, so
 * `GET /api/v1/events` without an upgrade is still an ordinary HTTP request and
 * receives 426 rather than being served as a REST route.
 */

import { WebSocketServer } from 'ws';

import { SubscriberRegistry } from './subscriber-registry.mjs';
import { ClientSession, CONNECTION_STATE } from './client-session.mjs';
import { EVENTS_PATH, PROTOCOL } from './protocol.mjs';
import { validateClientFrame, validateUpgrade } from './validation.mjs';
import { normalizeOrigin } from '../auth/origin-policy.mjs';
import { API_ERROR, HTTP_STATUS, toApiError } from '../http/errors.mjs';
import { newRequestId, writeJson } from '../http/response.mjs';

/** Configuration for the WebSocket layer. */
export const DEFAULT_WS_OPTIONS = Object.freeze({
  heartbeatMs: 25_000,
  pingIntervalMs: 25_000,
  maxBacklogEvents: 256,
  maxBacklogBytes: 1_048_576,
});

/**
 * Attach a WebSocket event stream to an existing HTTP server.
 *
 * @param {object} options - options.
 * @param {import('node:http').Server} options.httpServer - the R3 server.
 * @param {object} options.events - the `EventsService`.
 * @param {object} options.config - resolved HTTP config.
 * @param {() => number} [options.clock] - injectable clock.
 * @param {() => number|null} [options.currentPort] - the actual bound port.
 * @param {object} [options.limits] - overrides for `DEFAULT_WS_OPTIONS`.
 * @param {object} [options.timers] - injectable timers, for tests.
 * @param {(request: object) => object} [options.authorizeUpgrade] - the R6 auth seam.
 * @param {object} [options.WebSocketServerImpl] - injectable `ws` implementation.
 * @returns {object} the WS server handle.
 */
export function attachWebSocketServer(options) {
  if (options?.httpServer === undefined) throw new TypeError('attachWebSocketServer requires an httpServer');
  if (options?.events === undefined) throw new TypeError('attachWebSocketServer requires an events service');
  if (options?.config === undefined) throw new TypeError('attachWebSocketServer requires a config');

  const config = options.config;
  const limits = { ...DEFAULT_WS_OPTIONS, ...(options.limits ?? {}) };
  const clock = options.clock ?? Date.now;
  const currentPort = options.currentPort ?? (() => config.port);
  const WebSocketServerImpl = options.WebSocketServerImpl ?? WebSocketServer;
  /**
   * The R6 auth service, when this server is enforcing authentication.
   *
   * `null` keeps R4 behaviour exactly, which is what a `disabled-fixture` server
   * gets. When present it owns ticket validation, the per-principal connection
   * limit and the shared Origin policy.
   */
  const authService = options.authService ?? null;

  const registry = new SubscriberRegistry();
  /** @type {Set<ClientSession>} */
  const clients = new Set();
  /**
   * Clients whose replay handoff has completed.
   *
   * The live fan-out delivers through `registry.publish`, and a client's own
   * `deliver` refuses to send while it is still REPLAYING 鈥?so an event emitted
   * after registration but before the handoff completes would be dropped. Those
   * events are captured by the handoff's pending queue instead, and this set is
   * what makes "registered" and "ready for live fan-out" the same condition.
   */
  const readyClients = new Set();
  let accepting = true;
  let stopped = false;
  let connectionsTotal = 0;

  /**
   * Mark a client ready for live fan-out and drain anything the handoff captured
   * after its flush ran.
   *
   * @param {ClientSession} client - the client.
   * @returns {void}
   */
  function announceReady(client) {
    readyClients.add(client);
    const drained = client.drainPending();
    for (const event of drained) registry.publish(event);
  }

  const wss = new WebSocketServerImpl({
    noServer: true,
    clientTracking: false,
    // `ws` defaults to echoing the client's *first* offered protocol, which would
    // agree to a protocol we do not speak whenever the client lists ours second.
    // Selecting explicitly is required by RFC 6455's agreement rule.
    handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false),
  });

  /**
   * Detach one client from every registry it appears in.
   *
   * @param {ClientSession} client - the client.
   * @returns {void}
   */
  function forget(client) {
    registry.unsubscribe(client.sessionId, client);
    clients.delete(client);
  }

  /**
   * Reject an upgrade with an HTTP error, before any 101 (搂8).
   *
   * @param {import('node:net').Socket} socket - the raw socket.
   * @param {number} status - the HTTP status.
   * @param {object} error - the `ApiError`.
   * @param {string} requestId - the request id.
   * @returns {void}
   */
  function rejectUpgrade(socket, status, error, requestId) {
    const body = Buffer.from(JSON.stringify(error.toEnvelope(requestId)), 'utf8');
    const lines = [
      `HTTP/1.1 ${status} ${statusText(status)}`,
      'content-type: application/json; charset=utf-8',
      `content-length: ${body.length}`,
      'connection: close',
      ...(error.headers?.allow === undefined ? [] : [`allow: ${error.headers.allow}`]),
      '',
      '',
    ];
    try {
      socket.write(lines.join('\r\n'));
      socket.write(body);
    } catch {
      // The peer may already be gone; nothing to report.
    }
    socket.destroy();
  }

  /**
   * The reason phrase for a status code.
   *
   * @param {number} status - the status.
   * @returns {string} the phrase.
   */
  function statusText(status) {
    switch (status) {
      case 400: return 'Bad Request';
      case 403: return 'Forbidden';
      case 404: return 'Not Found';
      case 405: return 'Method Not Allowed';
      case 426: return 'Upgrade Required';
      default: return 'Error';
    }
  }

  /**
   * Handle a raw upgrade request.
   *
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:net').Socket} socket - the socket.
   * @param {Buffer} head - the first packet.
   * @returns {void}
   */
  function onUpgrade(req, socket, head) {
    const requestId = newRequestId();

    // §39: no new upgrades once shutdown has begun.
    if (!accepting) {
      rejectUpgrade(
        socket,
        HTTP_STATUS.UNAVAILABLE,
        toApiError(Object.assign(new Error('shutting down'), { code: API_ERROR.DSH_UNAVAILABLE })),
        requestId,
      );
      return;
    }

    let pathname;
    let searchParams;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      pathname = url.pathname;
      searchParams = url.searchParams;
    } catch {
      rejectUpgrade(
        socket,
        HTTP_STATUS.BAD_REQUEST,
        toApiError(Object.assign(new Error('bad url'), { code: API_ERROR.INVALID_REQUEST })),
        requestId,
      );
      return;
    }

    // R6 §56 ordering. A reservation is taken only after the ticket has been
    // validated, and the ticket is consumed only after the reservation succeeded, so
    // a connection-limit refusal does not burn a usable ticket.
    //
    // `reserved` is released on every failure path below and handed to the client
    // session on success, where it is released when the socket closes.
    let reservation = null;

    let accepted;
    try {
      accepted = validateUpgrade({
        req,
        pathname,
        searchParams,
        config,
        actualPort: currentPort(),
        // R6 §27: one shared OriginPolicy, so the WS rule cannot drift from REST's.
        originPolicy: authService?.originPolicy,
        authorizeUpgrade: (facts) => {
          // The R4 seam still runs, so a caller-supplied hook keeps working.
          if (typeof options.authorizeUpgrade === 'function') {
            const decision = options.authorizeUpgrade(facts);
            if (decision?.allowed !== true) return decision;
          }
          if (authService === null || !authService.enforcing) return { allowed: true };

          const origin = normalizeOrigin(facts.req?.headers?.origin).ok
            ? normalizeOrigin(facts.req.headers.origin).origin
            : null;
          const ticketResult = authService.inspectTicket({
            ticket: facts.ticket,
            sessionId: facts.sessionId,
            origin,
          });
          if (!ticketResult.ok) {
            // §20/§51: one generic code, identical for unknown, used, expired,
            // session-mismatched and origin-mismatched tickets.
            return { allowed: false, status: HTTP_STATUS.UNAUTHORIZED, code: ticketResult.code };
          }

          const principalId = ticketResult.record.principalId;
          const slot = authService.connections.reserve(principalId);
          if (!slot.ok) {
            // No ticket has been consumed, so the client may retry once a stream frees.
            return {
              allowed: false,
              status: HTTP_STATUS.TOO_MANY_REQUESTS,
              code: 'WS_CONNECTION_LIMIT',
            };
          }

          // §57: the atomic step. Synchronous, with no await between lookup and
          // delete, so two simultaneous upgrades cannot both succeed.
          const consumed = authService.consumeTicket({
            ticket: facts.ticket,
            sessionId: facts.sessionId,
            origin,
          });
          if (!consumed.ok) {
            authService.connections.release(principalId);
            return { allowed: false, status: HTTP_STATUS.UNAUTHORIZED, code: consumed.code };
          }

          reservation = { principalId, released: false };
          authService.connections.commit();
          return { allowed: true };
        },
      });
    } catch (error) {
      // A refused upgrade must not leak the reservation it may have taken.
      releaseReservation();
      const apiErr = toApiError(error);
      rejectUpgrade(socket, apiErr.status, apiErr, requestId);
      return;
    }

    /**
     * Release a reservation exactly once.
     *
     * Idempotent, because a failed handshake and a later socket close can both
     * reach it, and double-releasing would under-count live streams.
     *
     * @returns {void}
     */
    function releaseReservation() {
      if (reservation === null || reservation.released) return;
      reservation.released = true;
      authService?.connections.release(reservation.principalId);
    }

    // Past every policy check: complete the handshake. The subprotocol was
    // already pinned by `handleProtocols` above.
    wss.handleUpgrade(req, socket, head, (ws) => {
      onConnection(ws, { ...accepted, releaseReservation });
    });
  }

  /**
   * Wire up one accepted socket.
   *
   * @param {import('ws').WebSocket} ws - the socket.
   * @param {object} accepted - validated handshake facts.
   * @returns {void}
   */
  function onConnection(ws, accepted) {
    connectionsTotal += 1;
    const sessionId = accepted.sessionId;

    const client = new ClientSession({
      socket: ws,
      events: options.events,
      sessionId,
      lastSequence: accepted.lastSequence,
      clock,
      // R5: the durable replay source, when present. Forwarded verbatim, so the
      // client session does not care whether it reads RAM or disk.
      ...(options.replayStore === undefined ? {} : { replayStore: options.replayStore }),
      maxBacklogEvents: limits.maxBacklogEvents,
      maxBacklogBytes: limits.maxBacklogBytes,
      heartbeatMs: limits.heartbeatMs,
      pingIntervalMs: limits.pingIntervalMs,
      ...(options.timers === undefined ? {} : { timers: options.timers }),
      // Announced only once the session is genuinely live, so a client that sees
      // `replay_complete` knows the fan-out is armed.
      onHandshakeComplete: () => announceReady(client),
      onClosed: () => {
        // A phone disconnect touches no domain state (§38); it only leaves the
        // registry. R6 also returns the connection slot here, so a socket that
        // vanishes without a clean close cannot leak capacity.
        forget(client);
        readyClients.delete(client);
        accepted.releaseReservation?.();
      },
    });

    // Register *before* beginning, so the replay boundary capture and the live
    // subscription happen in the order 搂26 requires. `ClientSession.begin`
    // registers its own live listener through `beginReplay`; this registration is
    // the fan-out path used after `LIVE`.
    registry.subscribe(sessionId, client);
    clients.add(client);

    // The socket handlers are attached synchronously, so nothing is missed while
    // the handoff is being prepared.
    ws.on('pong', () => client.notePong());
    ws.on('message', (data) => {
      client.acceptClientFrame(data, validateClientFrame);
    });
    ws.on('close', () => {
      client.close('socket closed');
    });
    ws.on('error', () => {
      // Transport errors are the socket's business; cleanup happens on close.
      forget(client);
    });

    // R5: preparing the handoff may read durable storage, so it is asynchronous.
    // The listener registration inside `beginReplay` still happens before that
    // read, so an event emitted during it is captured rather than lost.
    void (async () => {
      try {
        // Capture the replay boundary and register the live listener *before* the
        // handshake is announced to the client. An event emitted between the two
        // would otherwise be in neither the captured history nor the pending queue,
        // and would be lost silently.
        await client.prepare();
        readyClients.add(client);
        await client.begin();
      } catch (error) {
        client.sendError({
          code: API_ERROR.INTERNAL_ERROR,
          message: 'The event stream could not be started.',
        });
        client.close('start failure');
        readyClients.delete(client);
      }
    })();
  }

  // Fan-out: every newly emitted Gateway event goes to that session's subscribers.
  const offEvents = options.events.onEvent((event) => {
    registry.publish(event);
  });

  options.httpServer.on('upgrade', onUpgrade);

  return {
    /** The registry, for tests and diagnostics. */
    get registry() {
      return registry;
    },

    /** The live client sessions. */
    clients() {
      return [...clients];
    },

    /** How many client sessions are open. */
    get size() {
      return clients.size;
    },

    /** Total connections accepted since start. */
    get connectionsTotal() {
      return connectionsTotal;
    },

    /** Whether new upgrades are currently accepted. */
    get accepting() {
      return accepting;
    },

    /**
     * Stop accepting, notify every client, close every socket, clear timers.
     *
     * @returns {Promise<void>} resolves once everything is released.
     */
    async stop() {
      if (stopped) return;
      stopped = true;
      // 1. No new upgrades.
      accepting = false;
      options.httpServer.removeListener('upgrade', onUpgrade);

      // 2. Stop fan-out so no event enters a closing registry.
      offEvents();

      // 3. Notify and close every client (timers are cleared inside).
      const all = [...clients];
      for (const client of all) {
        try {
          client.shutdown('server_shutdown');
        } catch {
          // A client that cannot be notified is closed anyway.
        }
      }
      registry.bySession.clear();
      clients.clear();

      // 4. Close the WebSocket server itself.
      await new Promise((resolve) => {
        try {
          wss.close(() => resolve());
        } catch {
          resolve();
        }
      });
    },

    /**
     * Diagnostics for tests and the report.
     *
     * @returns {object} the state.
     */
    stats() {
      return {
        accepting,
        connectionsTotal,
        openClients: clients.size,
        registrySize: registry.size,
        publishFailures: registry.publishFailures,
        clients: [...clients].map((client) => client.stats()),
      };
    },
  };
}

export { EVENTS_PATH, CONNECTION_STATE, SubscriberRegistry };
