/**
 * R1 test helpers.
 *
 * Two fakes, no network:
 *   - `FakeFetch`     scripted HTTP responses for unary RPC, including HTTP
 *                     error statuses, non-JSON bodies and transport throws.
 *   - `FakeWebSocket` a minimal `WebSocket`-shaped object whose lifecycle the
 *                     test drives explicitly, so mux framing and logical-stream
 *                     behaviour are deterministic and never flaky.
 *
 * No helper reads the filesystem outside `tests/remote/fixtures`, and none
 * touches a live DSH.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.join(HERE, 'fixtures');

/** Deterministic fixture session ids (R1 §17.1). */
export const FIXTURE_SESSION = Object.freeze({
  RUNNING: 'session-00000000-0000-0000-0000-000000000001',
  IDLE: 'session-00000000-0000-0000-0000-000000000002',
  BLANK: 'session-00000000-0000-0000-0000-000000000003',
  COLD: 'session-00000000-0000-0000-0000-000000000009',
});

/** The authority every fixture models. */
export const FIXTURE_AUTHORITY = '127.0.0.1:3080';

/**
 * Load a fixture file and parse it as JSON.
 *
 * @param {string} name - fixture file name, e.g. `session-list.response.json`.
 * @returns {any} parsed fixture.
 */
export function loadFixture(name) {
  const file = path.join(FIXTURE_DIR, name);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Every fixture file name, for the hygiene sweep test. */
export function listFixtureFiles() {
  return fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json')).sort();
}

/**
 * Read a fixture as raw text, for secret-scanning tests.
 *
 * @param {string} name - fixture file name.
 * @returns {string} file contents.
 */
export function readFixtureText(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

/**
 * Build a `Response`-like object.
 *
 * @param {object} spec - response description.
 * @param {number} spec.status - HTTP status.
 * @param {unknown} spec.body - value to serialize, or a raw string.
 * @param {boolean} [spec.rawBody] - treat `body` as an exact string.
 * @param {boolean} [spec.invalidJson] - emit `body` as text without JSON encoding.
 * @returns {object} a fetch-compatible response.
 */
function makeResponse(spec) {
  const { status = 200 } = spec;
  let text;
  if (spec.rawBody === true) {
    text = String(spec.body ?? '');
  } else if (spec.invalidJson === true) {
    text = String(spec.body ?? '');
  } else {
    text = JSON.stringify(spec.body ?? null);
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (spec.invalidJson === true) throw new SyntaxError('not json');
      return JSON.parse(text);
    },
    async text() {
      return text;
    },
  };
}

/**
 * Scripted `fetch` replacement.
 *
 * Routes are matched by request path. A route value may be:
 *   - a response spec object (`{status, body}`),
 *   - a function `(request) => spec | Promise<spec>`,
 *   - the string `'throw'`, to simulate a transport failure.
 *
 * A function route receives the recorded call, which includes the parsed request
 * envelope, so a test can echo the live `rpcId` back (real DSH always does).
 */
export class FakeFetch {
  constructor(routes = {}) {
    /** @type {Map<string, unknown>} */
    this.routes = new Map(Object.entries(routes));
    /** @type {object[]} */
    this.calls = [];
  }

  /**
   * Register or replace a route.
   *
   * @param {string} pathname - request path, e.g. `/api/session/list`.
   * @param {unknown} handler - response spec, function, or `'throw'`.
   * @returns {void}
   */
  route(pathname, handler) {
    this.routes.set(pathname, handler);
  }

  /**
   * Perform a scripted call.
   *
   * @param {string} url - request URL.
   * @param {object} [options] - fetch options.
   * @returns {Promise<object>} the scripted response.
   */
  async fetchImpl(url, options = {}) {
    const { pathname } = new URL(url);
    const record = {
      url,
      pathname,
      method: options.method,
      headers: options.headers ?? {},
      body: options.body === undefined ? undefined : JSON.parse(options.body),
    };
    this.calls.push(record);

    if (!this.routes.has(pathname)) {
      throw new Error(`FakeFetch has no route for ${pathname}`);
    }

    const handler = this.routes.get(pathname);
    if (handler === 'throw') {
      throw new TypeError('fetch failed');
    }
    const spec = typeof handler === 'function' ? await handler(record) : handler;
    if (spec === 'throw') {
      throw new TypeError('fetch failed');
    }

    // Model the one fetch behaviour callers depend on: an aborted signal rejects
    // with an AbortError instead of resolving.
    if (options.signal?.aborted) {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }
    return makeResponse(spec);
  }

  /**
   * Bound fetch function for injection into `DshRpcClient`.
   *
   * @returns {(url: string, options?: object) => Promise<object>} the fake.
   */
  get fetch() {
    return (url, options) => this.fetchImpl(url, options);
  }

  /** The most recent recorded call. */
  get lastCall() {
    return this.calls[this.calls.length - 1];
  }
}

/**
 * Minimal `WebSocket`-shaped object whose lifecycle the test drives.
 *
 * The test calls `simulateOpen()`, `emitMessage()`, `emitError()` and
 * `simulateClose()` explicitly, so no timer or real socket is involved.
 */
export class FakeWebSocket {
  /** @type {FakeWebSocket[]} */
  static instances = [];

  /** WebSocket.OPEN */
  static OPEN = 1;

  /** Reset the instance registry between tests. */
  static reset() {
    FakeWebSocket.instances = [];
  }

  /**
   * @param {string} url - the URL the client asked for.
   * @param {object} [options] - the options the client passed.
   */
  constructor(url, options = {}) {
    this.url = url;
    this.options = options;
    this.readyState = 0; // CONNECTING
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
    /** @type {string[]} */
    this.sent = [];
    this.closeCalls = 0;
    FakeWebSocket.instances.push(this);
  }

  /**
   * Add an event listener.
   *
   * @param {string} type - event name.
   * @param {Function} handler - listener.
   * @returns {void}
   */
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  /**
   * Remove an event listener.
   *
   * @param {string} type - event name.
   * @param {Function} handler - listener.
   * @returns {void}
   */
  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  /**
   * Dispatch an event to registered listeners.
   *
   * Delivery is deferred to a macrotask, matching a real `WebSocket`: browser
   * and Node sockets never invoke a `message` listener synchronously inside the
   * sender's stack. A synchronous fake would make an awaiting consumer miss the
   * event, which is a fake bug rather than a product bug.
   *
   * @param {string} type - event name.
   * @param {object} [event] - event payload.
   * @returns {void}
   */
  emit(type, event = {}) {
    const handlers = [...(this.listeners.get(type) ?? [])];
    setTimeout(() => {
      for (const handler of handlers) handler(event);
    }, 0);
  }

  /**
   * Send a frame, recording it.
   *
   * @param {string} data - serialized frame.
   * @returns {void}
   */
  send(data) {
    if (this.readyState !== 1) throw new Error('FakeWebSocket is not open');
    this.sent.push(data);
  }

  /**
   * Close the socket.
   *
   * @returns {void}
   */
  close() {
    this.closeCalls += 1;
    this.readyState = 3;
    this.emit('close', {});
  }

  /** Drive the socket to OPEN and notify listeners. */
  simulateOpen() {
    this.readyState = 1;
    this.emit('open', {});
  }

  /**
   * Deliver a host frame.
   *
   * @param {unknown} frame - value to serialize and deliver.
   * @returns {void}
   */
  emitMessage(frame) {
    this.emit('message', { data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }

  /**
   * Alias kept for readability at call sites that deliver a host frame.
   *
   * @param {unknown} frame - value to serialize and deliver.
   * @returns {void}
   */
  deliver(frame) {
    this.emitMessage(frame);
  }

  /**
   * Deliver a socket error.
   *
   * @param {Error} [error] - underlying error.
   * @returns {void}
   */
  emitError(error = new Error('socket error')) {
    this.emit('error', { error });
  }

  /** Simulate the peer closing the connection. */
  simulateClose() {
    this.readyState = 3;
    this.emit('close', {});
  }

  /** Parsed frames the client has written. */
  get sentFrames() {
    return this.sent.map((line) => JSON.parse(line));
  }

  /** The most recently constructed fake socket. */
  static get latest() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }
}

/**
 * Wait for a condition, reporting observed state if it never holds.
 *
 * Polls on a real timer so queued macrotasks run between checks. Avoids
 * arbitrary sleeps by turning "it should be done by now" into an explicit
 * predicate with a bounded budget.
 *
 * @param {() => boolean} condition - predicate to satisfy.
 * @param {number} [timeoutMs] - budget.
 * @param {() => string} [describe] - optional state reporter for the failure message.
 * @returns {Promise<void>} resolves when satisfied.
 */
export async function waitFor(condition, timeoutMs = 2000, describe) {
  const deadline = Date.now() + timeoutMs;
  let checks = 0;
  for (;;) {
    checks += 1;
    if (condition()) return;
    if (Date.now() > deadline) {
      const state = describe === undefined ? '' : ` state=${describe()}`;
      throw new Error(`waitFor timed out after ${checks} checks and ${timeoutMs}ms${state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Yield the event loop so queued work can run.
 *
 * `FakeWebSocket` defers delivery with `setTimeout(..., 0)`, so a single
 * `setTimeout(resolve, 0)` can be queued *before* those handlers and return
 * first. A tiny non-zero delay guarantees every already-queued timer has run,
 * which keeps assertions deterministic without making tests slow.
 *
 * Prefer `waitFor(predicate)` when waiting for a specific condition; use this
 * only when the test needs to let the microtask and timer queues drain.
 *
 * @param {number} [rounds] - number of turns to yield.
 * @returns {Promise<void>} resolves after yielding.
 */
export async function settle(rounds = 3) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
