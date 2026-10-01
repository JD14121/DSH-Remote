/**
 * R3 test helpers — an ephemeral loopback server over fixture data.
 *
 * Every R3 suite starts a real `node:http` server on `127.0.0.1:0` (OS-assigned
 * port) and makes real HTTP requests to it. Nothing is stubbed at the HTTP
 * boundary, so routing, the Host fence, body limits, content types and status
 * codes are all exercised as shipped.
 *
 * No test contacts a real DSH, reads a credential, or writes to the real
 * `$DSH_HOME`. R5 durability tests use `makeTempStateRoot`, which refuses a root
 * inside DSH_HOME (§61).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EventsService } from '../../src/remote/events.mjs';
import { MessagesService } from '../../src/remote/messages.mjs';
import { SessionsService } from '../../src/remote/sessions.mjs';
import { StatusService } from '../../src/remote/status-service.mjs';
import { UploadService } from '../../src/remote/uploads.mjs';
import { resolveHttpConfig } from '../../src/remote/http/config.mjs';
import { createRemoteHttpServer } from '../../src/remote/server.mjs';
import { AuthService } from '../../src/remote/auth/auth-service.mjs';
import { resolveAuthConfig } from '../../src/remote/auth/config.mjs';
import { createFixtureAdapter, seedFixtureStore, FIXTURE_SESSIONS } from '../../scripts/fixture-adapter.mjs';

/** Fixed clock so fixture timestamps are deterministic. */
export const FIXTURE_CLOCK_MS = 1_789_800_000_000;
export const fixtureClock = () => FIXTURE_CLOCK_MS;

/**
 * Create a throwaway state root under the OS temp directory (R5 §61).
 *
 * §61 forbids an automated test from writing the real `$DSH_HOME\remote`. This
 * helper is the only sanctioned way for a suite to obtain a persistence root, and
 * it fails loudly if the directory it hands back is inside DSH_HOME — so the rule
 * is enforced by construction rather than by remembering it.
 *
 * @param {string} [label] - a short label included in the directory name.
 * @returns {{root: string, cleanup: () => void}} the root and its cleanup.
 * @throws {Error} when the resolved root is inside DSH_HOME.
 */
export function makeTempStateRoot(label = 'r5') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-${label}-`));
  const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const normalizedHome = path.resolve(dshHome);
  const withSeparator = normalizedHome.endsWith(path.sep) ? normalizedHome : normalizedHome + path.sep;

  if (path.resolve(root) === normalizedHome || path.resolve(root).startsWith(withSeparator)) {
    // Removing the directory first keeps the failure from leaving state behind.
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error('refusing to use a test state root inside DSH_HOME (§61)');
  }

  return {
    root,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Assert that a state root is not the real DSH state root.
 *
 * Belt-and-braces for suites that build a server inline: it catches the mistake at
 * the point of construction, before anything is written.
 *
 * @param {string} root - the candidate root.
 * @returns {string} the root, when it is safe.
 * @throws {Error} when it is inside DSH_HOME.
 */
export function assertTempStateRoot(root) {
  const dshHome = path.resolve(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'));
  const withSeparator = dshHome.endsWith(path.sep) ? dshHome : dshHome + path.sep;
  const resolved = path.resolve(root);
  if (resolved === dshHome || resolved.startsWith(withSeparator)) {
    throw new Error(`refusing to run a test against a state root inside DSH_HOME: ${root}`);
  }
  return root;
}

export { FIXTURE_SESSIONS };

/**
 * Start a fixture-backed server on an ephemeral loopback port.
 *
 * @param {object} [options] - server options.
 * @param {object} [options.configOverrides] - overrides for `resolveHttpConfig`.
 * @param {object} [options.adapterOptions] - forwarded to `createFixtureAdapter`.
 * @param {object} [options.healthFacts] - override for the health endpoint.
 * @param {object} [options.services] - service overrides.
 * @returns {Promise<object>} the running server plus helpers.
 */
export async function startFixtureServer(options = {}) {
  const adapter = createFixtureAdapter({ clock: fixtureClock, ...(options.adapterOptions ?? {}) });
  const store = seedFixtureStore(adapter, fixtureClock);
  // Resolved before the server is built, so the auth service can read the real port
  // once the listener binds — the shared Origin policy needs the bound port.
  const serverPort = { port: 0 };

  const eventsService = options.services?.eventsService
    ?? new EventsService({
      adapter,
      store,
      clock: fixtureClock,
      // R5 §28: the ring is a hot cache, so its size follows the persistence config
      // when a suite supplies one. Without this a test that shrinks the ring to
      // force journal-backed replay would silently keep the default.
      ...(options.persistenceConfig?.ringSize === undefined
        ? {}
        : { ringSize: options.persistenceConfig.ringSize }),
    });
  const sessionsService = options.services?.sessionsService
    ?? new SessionsService({ adapter, store, clock: fixtureClock });
  const messagesService = options.services?.messagesService
    ?? new MessagesService({ adapter, store, clock: fixtureClock });
  const statusService = options.services?.statusService
    ?? new StatusService({ adapter, eventsService, clock: fixtureClock });
  const uploadService = options.services?.uploadService ?? new UploadService({ adapter });

  const config = resolveHttpConfig(
    {
      host: '127.0.0.1',
      port: 0,
      dshVersion: '0.1.5-rc.2',
      ...(options.configOverrides ?? {}),
    },
    {},
  );

  const server = createRemoteHttpServer({
    sessionsService,
    messagesService,
    eventsService,
    statusService,
    uploadService,
    adapter,
    config,
    // R6 §5: the auth decision is explicit and never implicit. A fixture defaults
    // to `disabled-fixture`, which is visibly unauthenticated; a suite that wants
    // real authentication passes `authConfig` and the helper constructs a service
    // with a synthetic in-memory credential.
    ...(options.authConfig === undefined
      ? { auth: null }
      : {
        auth: new AuthService({
          config: resolveAuthConfig({ ...options.authConfig, token: options.authToken }, {}),
          token: options.authToken ?? options.authConfig.token,
          port: () => serverPort.port,
        }),
      }),
    // Share the fixture clock with the WebSocket layer, so `server_time` in a
    // `hello` frame is reproducible rather than wall-clock dependent.
    clock: fixtureClock,
    // R5 §61: automated tests must NEVER touch the real `$DSH_HOME\remote`. The
    // default here is therefore "no persistence"; a suite that wants durability
    // passes `persistenceConfig: { root: <os temp dir> }` explicitly, and the
    // server resolves a service rooted there.
    ...(options.persistenceConfig === undefined
      ? { persistence: null }
      : { persistenceConfig: options.persistenceConfig }),
    // A fixture server has a healthy synthetic backend. A test that wants the
    // degraded or unavailable shape passes its own `healthFacts` to prove the
    // gateway/downstream distinction is real rather than cosmetic.
    healthFacts: options.healthFacts ?? (() => ({
      gateway: 'ready',
      ready: true,
      dsh: { status: 'ready', version: '0.1.5-rc.2' },
    })),
  });

  const address = await server.start();
  serverPort.port = address.port;

  return {
    server,
    adapter,
    store,
    eventsService,
    sessionsService,
    messagesService,
    statusService,
    uploadService,
    config,
    address,
    baseUrl: `http://127.0.0.1:${address.port}`,
    /**
     * The R5 durable state, or `null` when this server was built without it.
     *
     * @returns {object|null} the persistence service.
     */
    get persistence() {
      return server.persistence;
    },
    /**
     * Make a GET request against this server.
     *
     * @param {string} path - the path, including `/api/v1`.
     * @param {object} [options] - forwarded to `request`.
     * @returns {Promise<object>} the parsed response.
     */
    get(path, options = {}) {
      return request(this.baseUrl, path, options);
    },
    /**
     * Make a JSON POST against this server.
     *
     * @param {string} path - the path, including `/api/v1`.
     * @param {object} [body] - the JSON body.
     * @param {object} [options] - forwarded to `request`.
     * @returns {Promise<object>} the parsed response.
     */
    post(path, body, options = {}) {
      return request(this.baseUrl, path, { ...options, method: 'POST', body });
    },
    /** Stop the server; safe to call twice. */
    async close() {
      await server.stop();
    },
  };
}

/**
 * Make an HTTP request against the fixture server.
 *
 * Uses `node:http` rather than `fetch` because the Host fence can only be tested
 * with a raw client: `Host` is a forbidden header for `fetch`, so an override
 * there is silently dropped and the fence would appear to pass while untested.
 *
 * @param {string} baseUrl - the server root.
 * @param {string} path - the path, including the `/api/v1` prefix.
 * @param {object} [options] - request options.
 * @param {string} [options.method] - HTTP method.
 * @param {unknown} [options.body] - JSON body, serialised.
 * @param {Record<string, string>} [options.headers] - extra headers.
 * @param {string|null} [options.host] - override the `Host` header.
 * @param {Buffer|string} [options.rawBody] - a raw body.
 * @param {string} [options.contentType] - content type for a raw body.
 * @param {number} [options.timeoutMs] - socket timeout.
 * @returns {Promise<{status: number, headers: object, body: any, text: string}>} the response.
 */
export async function request(baseUrl, path, options = {}) {
  const url = new URL(`${baseUrl}${path}`);
  /** @type {Record<string, string>} */
  const headers = { ...(options.headers ?? {}) };
  let body;

  if (options.rawBody !== undefined) {
    body = Buffer.isBuffer(options.rawBody) ? options.rawBody : Buffer.from(String(options.rawBody), 'utf8');
    if (options.contentType !== undefined) headers['content-type'] = options.contentType;
  } else if (options.body !== undefined) {
    body = Buffer.from(JSON.stringify(options.body), 'utf8');
    headers['content-type'] = headers['content-type'] ?? 'application/json';
  }

  if (body !== undefined) headers['content-length'] = String(body.length);
  if (options.host !== undefined) headers.host = options.host;

  const { request: httpRequest } = await import('node:http');

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? 'GET',
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = text.length === 0 ? null : JSON.parse(text);
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, text });
        });
      },
    );

    req.setTimeout(options.timeoutMs ?? 10_000, () => {
      req.destroy(new Error('request timed out'));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Build a `multipart/form-data` body with one file part.
 *
 * @param {object} input - part description.
 * @param {string} input.filename - the part filename.
 * @param {Buffer|string} input.data - the part bytes.
 * @param {string} [input.contentType] - the part content type.
 * @param {string} [input.fieldName] - the form field name.
 * @param {string} [input.boundary] - an explicit boundary.
 * @returns {{body: Buffer, contentType: string}} the encoded body.
 */
export function multipartBody(input) {
  const boundary = input.boundary ?? '----dshR3FixtureBoundary';
  const fieldName = input.fieldName ?? 'file';
  const contentType = input.contentType ?? 'application/octet-stream';
  const data = Buffer.isBuffer(input.data) ? input.data : Buffer.from(String(input.data), 'utf8');

  const head = Buffer.from(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="${fieldName}"; filename="${input.filename}"\r\n`
    + `Content-Type: ${contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

  return {
    body: Buffer.concat([head, data, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * Wait for a condition, reporting observed state on failure.
 *
 * @param {() => boolean} condition - predicate.
 * @param {number} [timeoutMs] - budget.
 * @param {() => string} [describe] - state reporter.
 * @returns {Promise<void>} resolves when satisfied.
 */
export async function waitFor(condition, timeoutMs = 2000, describe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out${describe === undefined ? '' : ` state=${describe()}`}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
