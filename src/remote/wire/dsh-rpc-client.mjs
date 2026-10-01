/**
 * DSH RPC client — Phase R1 §6.
 *
 * Responsibilities (R1 §6), and nothing else:
 *   - HTTP unary RPC                     POST /api/<namespace>/<method>
 *   - WebSocket mux logical streams      WS   /api/remote.mux
 *   - rpcId correlation
 *   - AbortSignal cancellation
 *   - transport error normalization
 *
 * Explicitly NOT this module's job (R1 §6): session normalization, status
 * derivation, mobile API schema, persistence. Those belong above the adapter.
 *
 * The client never interprets a session, an event or an assistant chunk. It
 * moves validated envelopes and validated mux frames.
 */

import { Readable } from 'node:stream';

import { AdapterError, ADAPTER_ERROR, isAbortError, mapRemoteCode } from '../adapter-errors.mjs';
import { MUX_FRAME, muxUrl, unaryPath } from './dsh-routes.mjs';
import { UPLOAD_FILE_BINARY_PATH, uploadUrl } from './dsh-routes.mjs';
import {
  validateClientRequestEnvelope,
  validateHostMuxFrame,
  validateServerResponseEnvelope,
} from './dsh-types.mjs';

/** Default per-call unary timeout. */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** Reconnect backoff for the physical mux socket. */
export const DEFAULT_BACKOFF = Object.freeze({
  baseMs: 500,
  factor: 2,
  maxMs: 10_000,
});

/**
 * Monotonic rpcId generator. Unique within one client instance; the DSH wire
 * only requires correlation, not global identity.
 */
function createRpcIdFactory(prefix = 'rpc') {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
}

/**
 * Turn a fetch/transport failure into an adapter error without leaking headers.
 *
 * Node's fetch failures can embed the request URL but never the `Cookie` header;
 * we still avoid echoing the URL path back verbatim when it could carry query
 * material, and we never include request headers.
 *
 * @param {unknown} error - thrown transport error.
 * @param {object} [options] - mapping options.
 * @param {string} [options.endpoint] - endpoint name for context.
 * @returns {AdapterError} normalized failure.
 */
export function normalizeTransportFailure(error, options = {}) {
  const endpoint = options.endpoint;
  if (isAbortError(error)) {
    return new AdapterError(ADAPTER_ERROR.STREAM_ABORTED, 'the DSH call was aborted', {
      cause: error,
      details: endpoint === undefined ? undefined : { endpoint },
    });
  }
  return new AdapterError(
    ADAPTER_ERROR.DSH_UNAVAILABLE,
    'could not reach DSH at the configured authority',
    { cause: error, details: endpoint === undefined ? undefined : { endpoint } },
  );
}

/**
 * Map a non-2xx HTTP status onto an adapter error.
 *
 * @param {number} status - HTTP status code.
 * @param {string} endpoint - endpoint name for context.
 * @returns {AdapterError} normalized failure.
 */
export function normalizeHttpStatus(status, endpoint) {
  const details = { endpoint, status };
  switch (status) {
    case 400:
      return new AdapterError(ADAPTER_ERROR.WIRE_PROTOCOL_ERROR, 'DSH rejected the request body', { details });
    case 401:
      return new AdapterError(ADAPTER_ERROR.AUTH_REJECTED, 'DSH rejected the internal credential (401)', { details, retryable: false });
    case 403:
      return new AdapterError(ADAPTER_ERROR.AUTH_REJECTED, 'DSH refused the request authority or origin (403)', { details, retryable: false });
    case 404:
      return new AdapterError(ADAPTER_ERROR.WIRE_PROTOCOL_ERROR, 'DSH has no handler at that endpoint', { details });
    case 405:
      return new AdapterError(ADAPTER_ERROR.WIRE_PROTOCOL_ERROR, 'DSH rejected the HTTP method at that endpoint', { details });
    case 415:
      return new AdapterError(ADAPTER_ERROR.WIRE_PROTOCOL_ERROR, 'DSH requires application/json at that endpoint', { details });
    default:
      if (status >= 500) {
        return new AdapterError(ADAPTER_ERROR.DSH_UNAVAILABLE, `DSH returned HTTP ${status}`, { details });
      }
      return new AdapterError(ADAPTER_ERROR.WIRE_PROTOCOL_ERROR, `unexpected HTTP status ${status} from DSH`, { details });
  }
}

/**
 * RPC client for one DSH authority.
 *
 * Nothing connects at construction time (R1 §5.1): the first `call` or
 * `openStream` establishes the connection.
 */
export class DshRpcClient {
  /**
   * @param {object} options - client settings.
   * @param {string} options.authority - `host:port` of the DSH Web server.
   * @param {import('./dsh-auth.mjs').DshAuthProvider} options.authProvider - internal credential source.
   * @param {typeof fetch} [options.fetchImpl] - injectable fetch (tests).
   * @param {typeof WebSocket} [options.WebSocketImpl] - injectable WebSocket (tests).
   * @param {number} [options.callTimeoutMs] - per-unary-call timeout.
   * @param {boolean} [options.debug] - enable debug logging (default false, R1 §23).
   * @param {(line: string) => void} [options.logger] - debug sink.
   */
  constructor(options) {
    if (typeof options?.authority !== 'string' || options.authority.length === 0) {
      throw new TypeError('DshRpcClient requires an authority (host:port)');
    }
    if (options.authProvider === undefined) {
      throw new TypeError('DshRpcClient requires an authProvider');
    }
    this.authority = options.authority;
    this.authProvider = options.authProvider;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.debug = options.debug === true;
    this.logger = options.logger ?? (() => {});
    this.nextRpcId = createRpcIdFactory();

    /** @type {Map<string, {socket: WebSocket, streams: Map<string, object>, generation: number}>} */
    this.connections = new Map();
    this.closed = false;
    this.streamCounter = 0;
  }

  /**
   * Emit a debug line. Debug logging is OFF by default (R1 §23) and any line is
   * redacted through the auth provider before it is emitted.
   *
   * @param {string} line - message.
   */
  #debug(line) {
    if (!this.debug) return;
    this.logger(this.authProvider.redact(line));
  }

  /**
   * Number of physical mux connections successfully opened so far.
   *
   * Exposed because "one physical socket shared by many logical streams" is a
   * contract the adapter depends on, and it is not otherwise observable from
   * outside the client.
   *
   * @returns {number} count of opened connections.
   */
  get connectionCount() {
    return this.openedConnections ?? 0;
  }

  /**
   * Perform one unary RPC.
   *
   * @param {object} request - call description.
   * @param {string} request.endpoint - e.g. `session/list`.
   * @param {object} [request.args] - wire `args` object.
   * @param {AbortSignal} [request.signal] - caller cancellation.
   * @param {number} [request.timeoutMs] - overrides the client default.
   * @returns {Promise<unknown>} the validated `result.value`.
   * @throws {AdapterError} on any failure, always with an `ADAPTER_ERROR` code.
   */
  async call(request) {
    if (this.closed) {
      throw new AdapterError(ADAPTER_ERROR.DSH_UNAVAILABLE, 'the RPC client is closed');
    }
    const { endpoint } = request;
    const rpcId = this.nextRpcId();

    const envelope = {
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: { args: request.args ?? {} },
    };
    const envelopeCheck = validateClientRequestEnvelope(envelope);
    if (!envelopeCheck.ok) {
      throw new AdapterError(
        ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
        `refusing to send a malformed client-request: ${envelopeCheck.reason}`,
        { details: { endpoint } },
      );
    }

    const auth = await this.#auth(endpoint);
    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? this.callTimeoutMs;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = () => controller.abort();
    if (request.signal !== undefined) {
      if (request.signal.aborted) {
        clearTimeout(timer);
        throw new AdapterError(ADAPTER_ERROR.STREAM_ABORTED, 'the DSH call was aborted before it started');
      }
      request.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    let response;
    try {
      response = await this.fetchImpl(`http://${auth.authority ?? this.authority}${unaryPath(endpoint)}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: auth.authority ?? this.authority,
          cookie: auth.cookie,
        },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });
    } catch (error) {
      throw timedOut
        ? new AdapterError(ADAPTER_ERROR.DSH_UNAVAILABLE, 'the DSH call timed out', {
            details: { endpoint, timeoutMs },
          })
        : normalizeTransportFailure(error, { endpoint });
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onCallerAbort);
    }

    if (!response.ok) {
      throw normalizeHttpStatus(response.status, endpoint);
    }

    let parsed;
    try {
      parsed = await response.json();
    } catch (error) {
      throw new AdapterError(
        ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
        'DSH returned a body that is not JSON',
        { cause: error, details: { endpoint } },
      );
    }

    const check = validateServerResponseEnvelope(parsed, rpcId);
    if (!check.ok) {
      throw new AdapterError(
        ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
        `DSH returned an invalid server-response: ${check.reason}`,
        { details: { endpoint } },
      );
    }

    const { result } = parsed;
    if (result.ok === true) return result.value;

    throw new AdapterError(mapRemoteCode(result.error.code, { cancelOperation: false }), result.error.message, {
      details: { endpoint, remoteCode: result.error.code },
    });
  }

  /**
   * Open one logical stream on the shared mux WebSocket.
   *
   * The returned async iterator yields validated host frames of the logical
   * stream only. Aborting `signal` cancels just this logical stream: it does not
   * close the socket and does not affect sibling streams (R1 §14.2).
   *
   * @param {object} request - stream description.
   * @param {string} request.endpoint - e.g. `session/follow`.
   * @param {object} [request.args] - wire `args` object.
   * @param {AbortSignal} [request.signal] - caller cancellation.
   * @param {(reason: string) => void} [request.onInvalidFrame] - invalid-frame sink.
   * @returns {AsyncIterable<object>} validated host mux frames.
   */
  openStream(request) {
    const { endpoint } = request;
    const self = this;
    // Allocate the logical stream id here, not inside the iterator factory.
    // A lazy allocation would hand the same id to two concurrent streams that
    // have not started iterating yet, and one of them would lose its socket
    // registration to the other.
    const streamId = `s${(self.streamCounter += 1)}`;

    return {
      [Symbol.asyncIterator]() {
        /** @type {object[]} */
        const buffer = [];
        /** @type {Array<() => void>} */
        const waiters = [];
        /** @type {AdapterError | null} */
        let failure = null;
        let finished = false;

        /**
         * Hand a value to the oldest waiter, or buffer it.
         *
         * Concurrent `next()` calls are supported: each one owns a waiter, so a
         * frame is never dropped because a later call overwrote an earlier one.
         *
         * @param {object} frame - validated host frame.
         */
        const push = (frame) => {
          const waiter = waiters.shift();
          if (waiter !== undefined) {
            waiter();
            // The woken `next()` re-reads the buffer, so the frame cannot be lost.
            if (buffer.length === 0) buffer.push(frame);
            return;
          }
          buffer.push(frame);
        };

        /** Wake every waiter so each re-reads the terminal state. */
        const wakeAll = () => {
          while (waiters.length > 0) waiters.shift()();
        };

        const entry = {
          streamId,
          endpoint,
          args: request.args ?? {},
          push,
          fail: (error) => {
            if (finished) return;
            failure = error;
            finished = true;
            wakeAll();
          },
          end: () => {
            if (finished) return;
            finished = true;
            wakeAll();
          },
          closed: false,
        };

        const onAbort = () => {
          entry.closed = true;
          self.#cancelStream(streamId);
          entry.fail(
            new AdapterError(ADAPTER_ERROR.STREAM_ABORTED, 'the logical stream was aborted', {
              details: { endpoint },
            }),
          );
        };
        request.signal?.addEventListener('abort', onAbort, { once: true });

        self.#registerStream(entry).catch((error) => {
          entry.fail(
            error instanceof AdapterError
              ? error
              : new AdapterError(ADAPTER_ERROR.DSH_UNAVAILABLE, 'could not open the DSH stream'),
          );
        });

        return {
          async next() {
            for (;;) {
              if (buffer.length > 0) return { value: buffer.shift(), done: false };
              // A terminal failure must reach the consumer as a throw, including
              // when it arrived while this call was parked.
              if (failure !== null) {
                const error = failure;
                failure = null;
                throw error;
              }
              if (finished) return { value: undefined, done: true };
              await new Promise((resolve) => {
                waiters.push(resolve);
              });
            }
          },
          async return() {
            request.signal?.removeEventListener('abort', onAbort);
            if (!entry.closed) {
              entry.closed = true;
              self.#cancelStream(streamId);
            }
            finished = true;
            wakeAll();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  /**
   * Resolve the internal credential, mapping provider failures to adapter codes.
   *
   * @param {string} endpoint - endpoint for context.
   * @returns {Promise<{cookie: string, authority: string}>} the credential.
   */
  async #auth(endpoint) {
    try {
      const auth = await this.authProvider.getAuth();
      if (typeof auth?.cookie !== 'string' || typeof auth?.authority !== 'string') {
        throw new AdapterError(ADAPTER_ERROR.AUTH_UNAVAILABLE, 'auth provider returned an incomplete credential');
      }
      return auth;
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError(ADAPTER_ERROR.AUTH_UNAVAILABLE, 'could not obtain the internal DSH credential', {
        cause: error,
        details: { endpoint },
      });
    }
  }

  /**
   * Attach a stream to the shared socket, opening the socket if needed.
   *
   * @param {object} entry - stream bookkeeping record.
   * @returns {Promise<void>} resolves once the open frame has been written.
   */
  async #registerStream(entry) {
    const connection = await this.#connection();
    if (this.closed) {
      throw new AdapterError(ADAPTER_ERROR.DSH_UNAVAILABLE, 'the RPC client is closed');
    }
    // The caller may have aborted while the socket was still connecting.
    if (entry.closed) return;
    connection.streams.set(entry.streamId, entry);
    this.#send(connection, {
      type: MUX_FRAME.OPEN,
      streamId: entry.streamId,
      endpoint: entry.endpoint,
      payload: { args: entry.args },
    });
  }

  /**
   * Remove a logical stream and tell the Host to cancel it.
   *
   * @param {string} streamId - logical stream identity.
   */
  #cancelStream(streamId) {
    for (const connection of this.connections.values()) {
      if (!connection.streams.has(streamId)) continue;
      connection.streams.delete(streamId);
      this.#send(connection, { type: MUX_FRAME.CANCEL, streamId });
    }
  }

  /**
   * Write a frame, tolerating a socket that is not open yet.
   *
   * @param {object} connection - connection record.
   * @param {object} frame - frame to send.
   */
  #send(connection, frame) {
    const { socket } = connection;
    try {
      socket.send(JSON.stringify(frame));
    } catch (error) {
      this.#failConnection(connection, error);
    }
  }

  /**
   * Get or create the shared mux connection.
   *
   * A connection is created once and reused. While it is still opening, the
   * in-flight promise is shared rather than starting a second socket: a real
   * `readyState` is not yet OPEN during that window, so keying reuse on the
   * ready state alone would open a duplicate transport per concurrent caller.
   *
   * @returns {Promise<object>} the connection record, socket open.
   */
  async #connection() {
    for (;;) {
      const existing = this.connections.get(this.authority);
      if (existing !== undefined) {
        if (existing.socket.readyState === 1) return existing;
        // Share the in-flight handshake. The stored promise must resolve to the
        // *connection*, not to `undefined`: a shared bare promise would hand
        // every waiting caller nothing, and their streams would fail silently.
        if (existing.opening !== undefined) return existing.opening;
      }

      if (typeof this.WebSocketImpl !== 'function') {
        throw new AdapterError(
          ADAPTER_ERROR.DSH_UNAVAILABLE,
          'no WebSocket implementation is available in this runtime',
        );
      }

      // Deciding to create a socket requires the credential, which is awaited.
      // Two callers can therefore both pass the check above before either
      // registers a connection, so the check must be repeated after the await:
      // otherwise each opens its own socket and one logical stream is orphaned
      // on a connection nobody else can reach.
      const auth = await this.#auth('remote.mux');
      if (this.connections.get(this.authority) !== undefined) continue;

      const socket = new this.WebSocketImpl(muxUrl(auth.authority ?? this.authority), {
        headers: {
          host: auth.authority ?? this.authority,
          cookie: auth.cookie,
        },
      });

      const connection = {
        socket,
        streams: new Map(),
        generation: (this.connections.get(this.authority)?.generation ?? 0) + 1,
      };
      this.connections.set(this.authority, connection);

      connection.opening = new Promise((resolve, reject) => {
        const onOpen = () => {
          socket.removeEventListener?.('open', onOpen);
          socket.removeEventListener?.('error', onError);
          resolve(connection);
        };
        const onError = (event) => {
          socket.removeEventListener?.('open', onOpen);
          socket.removeEventListener?.('error', onError);
          reject(
            new AdapterError(ADAPTER_ERROR.DSH_UNAVAILABLE, 'the DSH stream socket failed to open', {
              details: { authority: this.authority },
              cause: event?.error ?? undefined,
            }),
          );
        };
        socket.addEventListener?.('open', onOpen);
        socket.addEventListener?.('error', onError);
        socket.addEventListener?.('message', (event) => this.#onMessage(connection, event));
        socket.addEventListener?.('close', () => this.#onClose(connection));
      });

      try {
        const opened = await connection.opening;
        this.openedConnections = (this.openedConnections ?? 0) + 1;
        return opened;
      } catch (error) {
        if (this.connections.get(this.authority) === connection) {
          this.connections.delete(this.authority);
        }
        throw error;
      }
    }
  }

  /**
   * Dispatch one host frame to its logical stream.
   *
   * @param {object} connection - connection record.
   * @param {{data?: unknown}} event - message event.
   */
  #onMessage(connection, event) {
    let parsed;
    try {
      parsed = JSON.parse(typeof event?.data === 'string' ? event.data : String(event?.data ?? ''));
    } catch {
      // A malformed mux frame is a wire violation. Fail every stream on this
      // socket visibly rather than silently dropping the frame (R1 §18.1).
      this.#failConnection(
        connection,
        new AdapterError(ADAPTER_ERROR.WIRE_PROTOCOL_ERROR, 'DSH sent a mux frame that is not JSON'),
      );
      return;
    }

    const check = validateHostMuxFrame(parsed);
    if (!check.ok) {
      this.#failConnection(
        connection,
        new AdapterError(ADAPTER_ERROR.WIRE_PROTOCOL_ERROR, `DSH sent an invalid mux frame: ${check.reason}`),
      );
      return;
    }

    const entry = connection.streams.get(parsed.streamId);
    if (entry === undefined) return;

    switch (parsed.type) {
      case MUX_FRAME.ITEM:
        entry.push(parsed.value);
        break;
      case MUX_FRAME.END:
        connection.streams.delete(parsed.streamId);
        entry.end();
        break;
      case MUX_FRAME.ERROR:
        connection.streams.delete(parsed.streamId);
        entry.fail(
          new AdapterError(mapRemoteCode(parsed.error.code, { cancelOperation: false }), parsed.error.message, {
            details: { remoteCode: parsed.error.code },
          }),
        );
        break;
      default:
        break;
    }
  }

  /**
   * Upload raw bytes to DSH's streaming upload route — Phase R3 §24.
   *
   * This is DSH's own non-JSON HTTP route (declared in `dsh-routes.mjs` as
   * `UPLOAD_FILE_BINARY`), not a Typert Remote endpoint, so it does not use the
   * `client-request` envelope. DSH requires `application/octet-stream` and
   * answers `{ ok, value | error }` with HTTP 200 — the same result shape as an
   * RPC envelope but without the rpcId correlation.
   *
   * @param {object} request - upload description.
   * @param {string} request.sessionId - the Session the receipt is minted for.
   * @param {Iterable<Uint8Array>|AsyncIterable<Uint8Array>} request.chunks - body chunks.
   * @param {string} [request.name] - optional display name.
   * @param {AbortSignal} [request.signal] - caller cancellation.
   * @returns {Promise<object>} the validated `value` (contains `receiptId`).
   */
  async uploadRaw(request) {
    if (this.closed) {
      throw new AdapterError(ADAPTER_ERROR.DSH_UNAVAILABLE, 'the RPC client is closed');
    }
    const { sessionId } = request;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new AdapterError(ADAPTER_ERROR.SESSION_NOT_FOUND, 'an upload requires a session id');
    }

    const auth = await this.#auth(UPLOAD_FILE_BINARY_PATH);
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    if (request.signal !== undefined) {
      if (request.signal.aborted) {
        throw new AdapterError(ADAPTER_ERROR.STREAM_ABORTED, 'the upload was aborted before it started');
      }
      request.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    // DSH needs a duplex request to stream a body; `duplex: 'half'` is required by
    // Node's fetch for a ReadableStream body.
    const body = Readable.from(request.chunks ?? []);

    let response;
    try {
      response = await this.fetchImpl(`${uploadUrl(auth.authority ?? this.authority, sessionId, request.name)}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          host: auth.authority ?? this.authority,
          cookie: auth.cookie,
        },
        body,
        duplex: 'half',
        signal: controller.signal,
      });
    } catch (error) {
      throw normalizeTransportFailure(error, { endpoint: UPLOAD_FILE_BINARY_PATH });
    } finally {
      request.signal?.removeEventListener('abort', onCallerAbort);
    }

    if (!response.ok) {
      throw normalizeHttpStatus(response.status, UPLOAD_FILE_BINARY_PATH);
    }

    let parsed;
    try {
      parsed = await response.json();
    } catch (error) {
      throw new AdapterError(
        ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
        'DSH returned an upload response that is not JSON',
        { cause: error },
      );
    }

    if (parsed === null || typeof parsed !== 'object') {
      throw new AdapterError(ADAPTER_ERROR.WIRE_PROTOCOL_ERROR, 'DSH returned an invalid upload result');
    }
    if (parsed.ok === true) {
      if (parsed.value === null || typeof parsed.value !== 'object') {
        throw new AdapterError(ADAPTER_ERROR.WIRE_PROTOCOL_ERROR, 'DSH accepted the upload without a value');
      }
      return parsed.value;
    }
    if (parsed.ok === false && parsed.error !== undefined) {
      const code = parsed.error?.code;
      throw new AdapterError(mapRemoteCode(code, { cancelOperation: false }), parsed.error?.message ?? 'upload failed', {
        details: { remoteCode: code ?? null },
      });
    }
    throw new AdapterError(ADAPTER_ERROR.WIRE_PROTOCOL_ERROR, 'DSH returned an unrecognised upload result');
  }

  /**
   * Handle socket closure: fail every attached stream. A transport disconnect is
   * a transport fact, not a session failure (R1 §14.1), so it is reported as
   * `DSH_UNAVAILABLE` with `retryable: true`.
   *
   * @param {object} connection - connection record.
   */
  #onClose(connection) {
    if (this.connections.get(this.authority) === connection) {
      this.connections.delete(this.authority);
    }
    if (connection.streams.size === 0) return;
    this.#failConnection(
      connection,
      new AdapterError(ADAPTER_ERROR.DSH_UNAVAILABLE, 'the DSH stream socket closed', { retryable: true }),
    );
  }

  /**
   * Fail every stream attached to a connection.
   *
   * @param {object} connection - connection record.
   * @param {Error} error - failure to deliver.
   */
  #failConnection(connection, error) {
    const entries = [...connection.streams.values()];
    connection.streams.clear();
    for (const entry of entries) {
      entry.fail(
        error instanceof AdapterError
          ? error
          : new AdapterError(ADAPTER_ERROR.DSH_UNAVAILABLE, 'the DSH stream socket failed', { cause: error }),
      );
    }
  }

  /**
   * Close the shared socket and refuse further work.
   *
   * @returns {Promise<void>} resolves once the socket is closed.
   */
  async close() {
    this.closed = true;
    for (const connection of [...this.connections.values()]) {
      this.#failConnection(
        connection,
        new AdapterError(ADAPTER_ERROR.STREAM_ABORTED, 'the RPC client was closed'),
      );
      try {
        connection.socket.close();
      } catch {
        // Closing an already-closed socket is not a failure worth reporting.
      }
    }
    this.connections.clear();
  }
}
