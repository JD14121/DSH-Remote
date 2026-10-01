/**
 * Centralized DSH wire route constants — Phase R1 §7.
 *
 * R1 §7 forbids scattering DSH endpoint magic strings across modules. Every
 * endpoint name, HTTP path and mux frame type used by the adapter is declared
 * exactly once, here. `dsh-rpc-client.mjs` consumes these constants; no other
 * module may name an endpoint.
 *
 * Wire facts verified against @deepseek-ai/dsh@0.1.5-rc.2:
 *   - unary:  POST /api/<namespace>/<method>
 *   - stream: WS   /api/remote.mux, frames open|cancel -> item|end|error
 *   - the session Remote namespace is `session` (service `sessionController`);
 *     skills and fileReferences are separate namespaces in the same controller.
 */

/** The single HTTP channel owned by `dsh-client-connection`. */
export const API_CHANNEL = '/api';

/**
 * DSH's raw-byte file upload route (R3 §24).
 *
 * Read from `dsh-client-file-upload`: `POST`, `application/octet-stream`,
 * `sessionId` (required, query) plus an optional `name` (query), streamed body,
 * and a `{ ok, value | error }` JSON result at HTTP 200.
 */
export const UPLOAD_FILE_BINARY_PATH = '/api/session/uploadFileBinary';

/**
 * Build the upload URL for one session.
 *
 * @param {string} authority - `host:port`.
 * @param {string} sessionId - target session.
 * @param {string} [name] - optional display name.
 * @returns {string} the absolute upload URL.
 * @throws {TypeError} when the authority or session id is unusable.
 */
export function uploadUrl(authority, sessionId, name) {
  if (typeof authority !== 'string' || authority.length === 0) {
    throw new TypeError('authority must be a non-empty host:port string');
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('uploadUrl requires a sessionId');
  }
  const url = new URL(`http://${authority}${UPLOAD_FILE_BINARY_PATH}`);
  url.searchParams.set('sessionId', sessionId);
  if (typeof name === 'string' && name.length > 0) url.searchParams.set('name', name);
  return url.toString();
}

/** The multiplexed WebSocket path owned by `dsh-api-gateway`. */
export const REMOTE_MUX_PATH = '/api/remote.mux';

/** The Gateway-reserved logical endpoint for forwarded Host application events. */
export const EVENTS_ENDPOINT = '$events';

/**
 * DSH Remote endpoints used by R1, keyed by a stable local alias.
 *
 * `mode` records whether the endpoint is a unary call or a logical stream, so
 * the adapter can assert it is using the right carrier.
 */
export const DSH_ENDPOINT = Object.freeze({
  SESSION_LIST: Object.freeze({ endpoint: 'session/list', mode: 'unary', argKey: '_request' }),
  SESSION_CREATE: Object.freeze({ endpoint: 'session/create', mode: 'unary', argKey: 'request' }),
  SESSION_FORK: Object.freeze({ endpoint: 'session/fork', mode: 'unary', argKey: 'request' }),
  SESSION_PROMPT: Object.freeze({ endpoint: 'session/prompt', mode: 'unary', argKey: 'request' }),
  SESSION_ATTACHMENT: Object.freeze({ endpoint: 'session/attachment', mode: 'unary', argKey: 'request' }),
  SESSION_UPDATE_QUEUE: Object.freeze({ endpoint: 'session/updateQueue', mode: 'unary', argKey: 'request' }),
  SESSION_CANCEL: Object.freeze({ endpoint: 'session/cancel', mode: 'unary', argKey: 'request' }),
  SESSION_RENAME: Object.freeze({ endpoint: 'session/rename', mode: 'unary', argKey: 'request' }),
  WORKSPACE_ARCHIVE_SESSION: Object.freeze({ endpoint: 'workspace/archiveSession', mode: 'unary', argKey: 'request' }),
  WORKSPACE_FOLLOW: Object.freeze({ endpoint: 'workspace/follow', mode: 'stream', argKey: null }),
  SESSION_PAGE: Object.freeze({ endpoint: 'session/page', mode: 'unary', argKey: 'request' }),
  SESSION_FOLLOW: Object.freeze({ endpoint: 'session/follow', mode: 'stream', argKey: 'request' }),
  SESSION_CONTROL: Object.freeze({ endpoint: 'session/control', mode: 'stream', argKey: null }),
  SESSION_MODEL_CATALOG: Object.freeze({ endpoint: 'session/modelCatalog', mode: 'unary', argKey: null }),
  SESSION_SELECT_MODEL: Object.freeze({ endpoint: 'session/selectModel', mode: 'unary', argKey: 'request' }),
  AGENT_PRESET_LIST: Object.freeze({ endpoint: 'agentPresets/list', mode: 'unary', argKey: null }),
  AGENT_PRESET_SELECT: Object.freeze({ endpoint: 'agentPresets/select', mode: 'unary', argKey: null }),
});

/**
 * Build the HTTP path for a unary endpoint.
 *
 * @param {string} endpoint - a `DSH_ENDPOINT` endpoint value, e.g. `session/list`.
 * @returns {string} the request path, e.g. `/api/session/list`.
 * @throws {TypeError} when the endpoint is not a non-empty slash-joined name.
 */
export function unaryPath(endpoint) {
  if (typeof endpoint !== 'string' || !/^[A-Za-z0-9_$.-]+\/[A-Za-z0-9_$.-]+$/.test(endpoint)) {
    throw new TypeError(`invalid DSH endpoint name: ${JSON.stringify(endpoint)}`);
  }
  return `${API_CHANNEL}/${endpoint}`;
}

/** WebSocket mux frame types, both directions (verified shape). */
export const MUX_FRAME = Object.freeze({
  // client -> host
  OPEN: 'open',
  CANCEL: 'cancel',
  // host -> client
  ITEM: 'item',
  END: 'end',
  ERROR: 'error',
});

/** Default WebSocket subprotocol-free URL for a given authority. */
export const DEFAULT_AUTHORITY = '127.0.0.1:3080';

/**
 * Build the mux WebSocket URL for an authority.
 *
 * @param {string} authority - `host:port`.
 * @returns {string} `ws://<authority>/api/remote.mux`.
 */
export function muxUrl(authority) {
  if (typeof authority !== 'string' || authority.length === 0) {
    throw new TypeError('authority must be a non-empty host:port string');
  }
  return `ws://${authority}${REMOTE_MUX_PATH}`;
}
