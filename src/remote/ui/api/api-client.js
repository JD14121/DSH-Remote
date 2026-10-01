/**
 * ApiClient — the single boundary through which every real HTTP request passes.
 *
 * ## Why this is the only place with `fetch`
 *
 * R8C §6 requires that components never call `fetch` directly. A test enforces it by scanning
 * every other UI module for a `fetch` call, so this file is the one permitted site. That makes
 * the credential-handling rules auditable in one place:
 *
 *   * the token is sent **only** as an `Authorization: Bearer` header;
 *   * it never appears in a URL, a query string, a body, or a filename;
 *   * it is never logged, and never interpolated into an error message.
 *
 * ## Same-origin by construction
 *
 * Every path is relative (`/api/v1/…`), so the browser talks to whatever origin served the
 * page. In development that origin is the loopback dev server, which proxies to the Gateway.
 * **No Gateway CORS or origin policy was relaxed for this** — the proxy exists precisely so it
 * does not have to be.
 */

import {
  ApiError,
  ERROR_KIND,
  errorFromStatus,
  errorFromThrow,
} from './errors.js';
import {
  normalizeCancelResult,
  normalizeHealth,
  normalizeMessageList,
  normalizeSendResult,
  normalizeSession,
  normalizeSessionList,
  normalizeUpload,
} from './normalizers.js';

/** The API prefix. Relative, so requests are same-origin. */
export const API_PREFIX = '/api/v1';

/** The client-side pre-check limit, matching the server's authority. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Generate a request id.
 *
 * `crypto.randomUUID()` is preferred; the fallback mixes random values rather than relying on
 * a timestamp, which R8C §17 forbids as a sole source.
 *
 * @returns {string} a unique id.
 */
export function createRequestId() {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj !== undefined && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  if (cryptoObj !== undefined && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Last resort. Not timestamp-only: it mixes a counter and randomness.
  return `req-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The API client.
 */
export class ApiClient {
  /**
   * @param {object} [options] - `baseUrl` (default ''), `fetchImpl`, `credential`.
   */
  constructor(options = {}) {
    this.baseUrl = options.baseUrl ?? '';
    /**
     * An explicitly injected transport.
     *
     * Only an injected implementation is stored. The ambient `globalThis.fetch` is deliberately
     * NOT captured here: it is resolved per request in `#request`.
     *
     * Capturing it at construction was a real defect on Android. In the debug harness's WebView
     * the module graph can evaluate before the ambient `fetch` binding is installed, so
     * `globalThis.fetch ?? null` pinned `fetchImpl` to `null` permanently. Every request then threw
     * `NETWORK` before reaching the network, which surfaced as "Gateway Unavailable" for a token
     * that was perfectly valid — and, because the throw happened before the request, it looked
     * exactly like the Gateway being unreachable rather than a client-side transport problem.
     *
     * @type {Function|null}
     */
    this.injectedFetch = typeof options.fetchImpl === 'function' ? options.fetchImpl : null;
    /** @type {string|null} */
    this.credential = options.credential ?? null;
    /** Records the last request id, for evidence and tests. */
    this.lastRequestId = null;
  }

  /**
   * The transport to use for the next request.
   *
   * An injected implementation always wins, so tests stay deterministic. Otherwise the ambient
   * `fetch` is read at call time and returned **bound to `globalThis`**.
   *
   * The binding is not cosmetic. `#request` invokes it as `this.fetchImpl(...)`, which makes the
   * receiver the `ApiClient` instance. Native `fetch` requires a `Window`/`WorkerGlobalScope`
   * receiver and throws `TypeError: Illegal invocation` otherwise. Desktop engines were permissive
   * enough for the call to go through; the Android WebView enforces it, so every request threw
   * before reaching the network and surfaced as an unreachable Gateway for a valid token.
   *
   * An earlier attempt resolved `fetch` lazily per call but returned it unbound, which fixed the
   * capture-timing problem while leaving the receiver problem in place — the two are independent.
   *
   * @returns {Function|null} the transport, or null when the environment has none.
   */
  get fetchImpl() {
    if (this.injectedFetch !== null) return this.injectedFetch;
    const ambient = globalThis.fetch;
    if (typeof ambient !== 'function') return null;
    // Cache the bound form so the receiver can never be wrong.
    this.injectedFetch = ambient.bind(globalThis);
    return this.injectedFetch;
  }

  /**
   * Override the transport.
   *
   * @param {Function|null} value - the implementation, or null to fall back to the ambient one.
   * @returns {void}
   */
  set fetchImpl(value) {
    this.injectedFetch = typeof value === 'function' ? value : null;
  }

  /**
   * Hold the credential this client sends.
   *
   * @param {string|null} value - the Phone Access Token, or null to clear.
   * @returns {void}
   */
  setCredential(value) {
    this.credential = typeof value === 'string' && value.length > 0 ? value : null;
  }

  /**
   * Perform one request.
   *
   * @param {string} method - the HTTP method.
   * @param {string} path - the path, relative to the API prefix.
   * @param {object} [options] - `body`, `headers`, `signal`, `requestId`, `raw`.
   * @returns {Promise<unknown>} the parsed body.
   */
  async #request(method, path, options = {}) {
    if (this.fetchImpl === null) {
      throw new ApiError(ERROR_KIND.NETWORK, { retryable: false });
    }

    const headers = { accept: 'application/json' };
    // The credential travels ONLY here, as a header.
    if (this.credential !== null) headers.authorization = `Bearer ${this.credential}`;

    let body;
    if (options.raw !== undefined) {
      // Multipart: the browser sets the boundary, so no content-type is written here.
      body = options.raw;
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    if (options.requestId !== undefined) headers['x-request-id'] = options.requestId;

    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${API_PREFIX}${path}`, {
        method,
        headers: { ...headers, ...(options.headers ?? {}) },
        body,
        signal: options.signal,
      });
    } catch (cause) {
      // A network failure keeps the credential: the token may be perfectly valid.
      throw errorFromThrow(cause);
    }

    const requestId = response.headers?.get?.('x-request-id') ?? options.requestId ?? null;

    if (response.ok !== true) {
      let errorCode = null;
      let remoteCode = null;
      let responseRequestId = requestId;
      try {
        const envelope = await response.json();
        const error = envelope?.error;
        if (typeof error?.code === 'string') errorCode = error.code;
        if (typeof error?.details?.remoteCode === 'string') remoteCode = error.details.remoteCode;
        if (typeof error?.request_id === 'string') responseRequestId = error.request_id;
      } catch {
        // Error bodies are optional; status remains authoritative.
      }
      throw errorFromStatus(response.status, { requestId: responseRequestId, code: errorCode, remoteCode });
    }

    if (response.status === 204) return null;

    let parsed;
    try {
      parsed = await response.json();
    } catch {
      // A body that will not parse is a protocol failure, not a credential failure.
      throw new ApiError(ERROR_KIND.SERVER, { status: response.status, requestId });
    }
    return { body: parsed, requestId };
  }

  /**
   * Authenticated health. Returns the *authenticated* contract or throws.
   *
   * A `200` alone is not enough: an anonymous health endpoint may answer with a minimal body,
   * so the payload must also carry the fields only the authenticated contract has.
   *
   * @param {object} [options] - `signal`.
   * @returns {Promise<object>} `{authenticated, ready, fields}`.
   */
  async health(options = {}) {
    const { body } = await this.#request('GET', '/health', { signal: options.signal });
    const health = normalizeHealth(body);
    if (health.authenticated !== true) {
      // Treat a minimal 200 as an authentication failure, which is what it means here.
      throw new ApiError(ERROR_KIND.AUTH_REQUIRED, { status: 200 });
    }
    return health;
  }

  /**
   * List sessions.
   *
   * The returned semantics are current DSH enumeration union retained Gateway-tracked sessions
   * (R8 Option A). An empty resulting union is a legitimate answer, not an error.
   *
   * @param {object} [options] - `signal`, `limit`, `cursor`.
   * @returns {Promise<{sessions: object[], nextCursor: string|null}>} the list.
   */
  async listSessions(options = {}) {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.cursor !== undefined) query.set('cursor', String(options.cursor));
    const suffix = query.toString().length > 0 ? `?${query}` : '';
    const { body } = await this.#request('GET', `/sessions${suffix}`, { signal: options.signal });
    return normalizeSessionList(body);
  }

  async getAgentPresets(options = {}) {
    const { body } = await this.#request('GET', '/agent-presets', { signal: options.signal });
    return body?.data ?? { presets: [] };
  }

  async getModelCatalog(options = {}) {
    const { body } = await this.#request('GET', '/models', { signal: options.signal });
    return body?.data ?? null;
  }

  /**
   * Create a new session.
   *
   * An optional DSH-rostered Agent preset and opaque, DSH-listed workspace key
   * may be supplied. The Gateway resolves workspace keys; raw paths never leave
   * the server.
   *
   * @param {object} [options] - `signal`, `requestId`, optional `agentPreset` and `workspaceKey`.
   * @returns {Promise<object>} the created session, normalized.
   */
  async createSession(options = {}) {
    const requestId = options.requestId ?? createRequestId();
    this.lastRequestId = requestId;
    const result = await this.#request('POST', '/sessions', {
      body: {
        ...(options.agentPreset ? { agent_preset: options.agentPreset } : {}),
        ...(typeof options.workspaceKey === 'string' ? { workspace_key: options.workspaceKey } : {}),
      },
      signal: options.signal,
      requestId,
    });
    const session = normalizeSession(result.body);
    if (session === null) {
      // A create that returns no usable identity is a protocol failure, not a
      // successful empty result.
      throw new ApiError(ERROR_KIND.SERVER, { status: 502, requestId: result.requestId });
    }
    return session;
  }

  async selectAgentPreset(sessionId, agentPreset, options = {}) {
    const { body } = await this.#request('PUT', `/sessions/${encodeURIComponent(sessionId)}/agent-preset`, {
      body: { agent_preset: agentPreset },
      signal: options.signal,
      requestId: options.requestId ?? createRequestId(),
    });
    return body?.data ?? null;
  }

  async selectModel(sessionId, selection, options = {}) {
    const body = {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoning_effort: selection.reasoningEffort }),
    };
    const result = await this.#request('PUT', `/sessions/${encodeURIComponent(sessionId)}/model`, {
      body,
      signal: options.signal,
      requestId: options.requestId ?? createRequestId(),
    });
    return result.body?.data ?? null;
  }

  /**
   * Fetch one session.
   *
   * @param {string} sessionId - the session id.
   * @param {object} [options] - `signal`.
   * @returns {Promise<object>} the session.
   */
  async getSession(sessionId, options = {}) {
    const { body } = await this.#request('GET', `/sessions/${encodeURIComponent(sessionId)}`, { signal: options.signal });
    const session = normalizeSession(body);
    if (session === null) throw new ApiError(ERROR_KIND.NOT_FOUND);
    return session;
  }

  /** Rename one DSH session using the server's title policy and durable event. */
  async renameSession(sessionId, title, options = {}) {
    const { body } = await this.#request('PUT', `/sessions/${encodeURIComponent(sessionId)}`, {
      body: { title },
      signal: options.signal,
      requestId: options.requestId ?? createRequestId(),
    });
    const session = normalizeSession(body);
    if (session === null) throw new ApiError(ERROR_KIND.SERVER);
    return session;
  }

  /** Archive one session from the DSH workspace. */
  async archiveSession(sessionId, options = {}) {
    const { body } = await this.#request('DELETE', `/sessions/${encodeURIComponent(sessionId)}`, {
      signal: options.signal,
      requestId: options.requestId ?? createRequestId(),
    });
    return body?.data ?? body;
  }

  /** Archive every current DSH session represented by an opaque workspace key. */
  async archiveWorkspace(workspaceKey, options = {}) {
    const { body } = await this.#request('POST', `/workspaces/${encodeURIComponent(workspaceKey)}/archive`, {
      signal: options.signal,
      requestId: options.requestId ?? createRequestId(),
    });
    return body?.data ?? body;
  }

  /**
   * Fetch a session's messages, in server order.
   *
   * @param {string} sessionId - the session id.
   * @param {object} [options] - `signal`, `limit`, `cursor`.
   * @returns {Promise<{messages: object[], nextCursor: string|null}>} the messages.
   */
  async getMessages(sessionId, options = {}) {
    const query = new URLSearchParams();
    if (options.beforeSequence !== undefined) query.set('before_seq', String(options.beforeSequence));
    if (options.throughSequence !== undefined) query.set('through_seq', String(options.throughSequence));
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.cursor !== undefined) query.set('cursor', String(options.cursor));
    const suffix = query.toString().length > 0 ? `?${query}` : '';
    const { body } = await this.#request(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/messages${suffix}`,
      { signal: options.signal },
    );
    return normalizeMessageList(body);
  }

  /**
   * Send a message.
   *
   * `mode` is **always sent explicitly**. The server is never left to infer queue versus steer
   * from UI state — that inference is exactly what R8C §16 forbids.
   *
   * @param {string} sessionId - the session id.
   * @param {object} request - `content`, `mode`, `requestId`, `clientTimeZone`.
   * @param {object} [options] - `signal`.
   * @returns {Promise<object>} `{status, messageId, sequence}`.
   */
  async sendMessage(sessionId, request, options = {}) {
    if (request.mode !== 'queue' && request.mode !== 'steer') {
      throw new ApiError(ERROR_KIND.BAD_REQUEST);
    }
    const requestId = request.requestId ?? createRequestId();
    this.lastRequestId = requestId;

    const body = {
      // The Gateway HTTP contract names the stable caller id `client_message_id`;
      // that value is forwarded unchanged as DSH's `requestId` by the adapter.
      client_message_id: requestId,
      mode: request.mode,
      content: request.content,
    };
    if (request.clientTimeZone !== undefined) body.clientTimeZone = request.clientTimeZone;

    const result = await this.#request('POST', `/sessions/${encodeURIComponent(sessionId)}/messages`, {
      body,
      signal: options.signal,
      requestId,
    });
    return normalizeSendResult(result.body);
  }

  /**
   * Cancel the running turn.
   *
   * @param {string} sessionId - the session id.
   * @param {object} [options] - `signal`, `requestId`.
   * @returns {Promise<object>} `{status}`.
   */
  async cancel(sessionId, options = {}) {
    const requestId = options.requestId ?? createRequestId();
    this.lastRequestId = requestId;
    const result = await this.#request('POST', `/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      body: {},
      signal: options.signal,
      requestId,
    });
    return normalizeCancelResult(result.body);
  }

  /**
   * Upload one file from a browser `File`.
   *
   * The client pre-checks the size, but the server remains the authority — a `413` is a real
   * possible answer and is surfaced as such. The token is never placed in the body or the
   * filename; only the `Authorization` header carries it.
   *
   * @param {string} sessionId - the session id.
   * @param {File|object} file - the browser File object.
   * @param {object} [options] - `signal`, `requestId`, `formDataFactory`.
   * @returns {Promise<object>} the attachment.
   */
  async upload(sessionId, file, options = {}) {
    const size = typeof file?.size === 'number' ? file.size : 0;
    if (size > MAX_UPLOAD_BYTES) {
      throw new ApiError(ERROR_KIND.TOO_LARGE, { status: 413 });
    }

    const factory = options.formDataFactory ?? (() => new globalThis.FormData());
    const form = factory();
    // Only the File object goes in. No path, no token, no filename rewriting.
    form.append('file', file, typeof file?.name === 'string' ? file.name : 'upload');

    const requestId = options.requestId ?? createRequestId();
    this.lastRequestId = requestId;
    const result = await this.#request('POST', `/sessions/${encodeURIComponent(sessionId)}/uploads`, {
      raw: form,
      signal: options.signal,
      requestId,
    });
    return normalizeUpload(result.body, { name: file?.name, bytes: size });
  }
}

/**
 * Create an ApiClient from browser globals.
 *
 * @param {object} [options] - overrides.
 * @returns {ApiClient} the client.
 */
export function createApiClient(options = {}) {
  return new ApiClient(options);
}
