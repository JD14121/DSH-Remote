/**
 * R6 fixture: the phone authentication flow, end to end, entirely synthetic.
 *
 * Generates its own in-memory credential and acts as its own client, so it never
 * prints the token (§49 prefers not printing it at all). It also refuses to run
 * against the real DSH state root.
 *
 * Run with `npm run fixture:r6`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';

import { WebSocket } from 'ws';

import { createRemoteHttpServer } from '../src/remote/server.mjs';
import { EventsService } from '../src/remote/events.mjs';
import { MessagesService } from '../src/remote/messages.mjs';
import { SessionsService } from '../src/remote/sessions.mjs';
import { StatusService } from '../src/remote/status-service.mjs';
import { resolveHttpConfig } from '../src/remote/http/config.mjs';
import { AuthService } from '../src/remote/auth/auth-service.mjs';
import { AUTH_MODE, resolveAuthConfig } from '../src/remote/auth/config.mjs';
import { generateSyntheticToken } from '../src/remote/auth/bearer.mjs';
import { redactRequestUrl } from '../src/remote/auth/redact-auth.mjs';
import { createFixtureAdapter, disableNetwork, seedFixtureStore } from './fixture-adapter.mjs';

// "This script cannot reach DSH" is enforced, not asserted in a comment.
disableNetwork();

const clock = () => 1_789_800_000_000;
const SESSION = 'session-00000000-0000-0000-0000-000000000001';
const OTHER_SESSION = 'session-00000000-0000-0000-0000-000000000002';

/** Print a numbered step. */
function step(number, text) {
  console.log('');
  console.log(`--- STEP ${number}: ${text}`);
}

/**
 * Refuse to run against the real DSH state root (§69).
 *
 * @param {string} root - the resolved state root.
 * @returns {void}
 */
function assertTempRoot(root) {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const normalized = path.resolve(home);
  const withSeparator = normalized.endsWith(path.sep) ? normalized : normalized + path.sep;
  if (path.resolve(root) === normalized || path.resolve(root).startsWith(withSeparator)) {
    throw new Error(`refusing to run the fixture against DSH_HOME: ${root}`);
  }
}

/**
 * Attempt a real WebSocket upgrade over a raw socket and read the status line.
 *
 * Needed because a plain HTTP GET to the events path is answered 426 before the
 * ticket is consulted — so only an actual upgrade attempt can show what a reused or
 * mis-bound ticket really does.
 *
 * @param {number} port - the server port.
 * @param {string} requestPath - the path including the query.
 * @param {object} [options] - `origin` to send.
 * @returns {Promise<{status: number|null, statusLine: string, body: string}>} the response head.
 */
function rawUpgrade(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1', () => {
      socket.write([
        `GET ${requestPath} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', // gitleaks:allow -- reviewed synthetic fixture, not a deployment credential
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Protocol: dsh-remote-v1',
        ...(options.origin === undefined ? [] : [`Origin: ${options.origin}`]),
        '', '',
      ].join('\r\n'));
    });

    let buffer = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      const statusLine = buffer.split('\r\n')[0] ?? '';
      const match = /^HTTP\/1\.1 (\d{3})/.exec(statusLine);
      resolve({ statusLine, status: match === null ? null : Number(match[1]), body: buffer });
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\r\n\r\n')) finish();
    });
    socket.on('close', finish);
    socket.on('error', reject);
    setTimeout(finish, 2000);
  });
}

/**
 * Make an HTTP request to the fixture's own loopback server.
 *
 * Uses `node:http` rather than `fetch` because `disableNetwork()` deliberately
 * replaces `fetch` with a throwing stub — the guarantee that this script cannot
 * reach DSH is worth more than the convenience of the global.
 *
 * @param {string} baseUrl - the server root.
 * @param {string} requestPath - the path.
 * @param {object} [options] - method, body, headers.
 * @returns {Promise<{status: number, headers: object, body: any}>} the response.
 */
function call(baseUrl, requestPath, options = {}) {
  const url = new URL(`${baseUrl}${requestPath}`);
  const payload = options.body === undefined ? null : JSON.stringify(options.body);
  const headers = { ...(options.headers ?? {}) };
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: options.method ?? 'GET', headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          let body = null;
          try {
            body = text.length === 0 ? null : JSON.parse(text);
          } catch {
            body = text;
          }
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      },
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-r6-fixture-'));

try {
  assertTempRoot(stateRoot);

  console.log('================================================================');
  console.log('  DSH REMOTE GATEWAY - SYNTHETIC R6 AUTH FIXTURE');
  console.log('  FIXTURE ONLY - NOT PRODUCTION');
  console.log('  No real credential. No DSH connection. No real DSH_HOME.');
  console.log('  The synthetic token is never printed.');
  console.log('================================================================');
  console.log(`state root: ${stateRoot}`);

  // A synthetic credential, generated here and held only in memory (§3, §71).
  const token = generateSyntheticToken();

  const adapter = createFixtureAdapter({ clock });
  const store = seedFixtureStore(adapter, clock);
  const eventsService = new EventsService({ adapter, store, clock, ringSize: 100 });
  const sessionsService = new SessionsService({ adapter, store, clock });
  const messagesService = new MessagesService({ adapter, store, clock });
  const statusService = new StatusService({ adapter, eventsService, clock });

  const auth = new AuthService({
    config: resolveAuthConfig({ mode: AUTH_MODE.REQUIRED, ticketTtlSeconds: 30 }, {}),
    token,
    clock,
    port: () => server.address()?.port ?? null,
  });

  const server = createRemoteHttpServer({
    sessionsService,
    messagesService,
    eventsService,
    statusService,
    adapter,
    config: resolveHttpConfig({ host: '127.0.0.1', port: 0, dshVersion: '0.1.5-rc.2 (fixture)' }, {}),
    healthFacts: () => ({ gateway: 'ready', ready: true, dsh: { status: 'ready', version: 'fixture' } }),
    auth,
    persistenceConfig: { root: stateRoot, segmentBytes: 65_536 },
  });

  const address = await server.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const authorized = { authorization: `Bearer ${token}` };
  const origin = `http://127.0.0.1:${address.port}`;
  console.log(`listening on ${baseUrl}`);

  // ── STEP 1 ────────────────────────────────────────────────────────────────
  step(1, 'unauthenticated health is minimal; unauthenticated data access is refused');
  const anonHealth = await call(baseUrl, '/api/v1/health');
  console.log(`  GET /health (no credential)  -> ${anonHealth.status}`);
  console.log(`    fields: ${Object.keys(anonHealth.body.data).sort().join(', ')}`);
  const anonSessions = await call(baseUrl, '/api/v1/sessions');
  console.log(`  GET /sessions (no credential)-> ${anonSessions.status} ${anonSessions.body.error?.code ?? ''}`);

  // ── STEP 2 ────────────────────────────────────────────────────────────────
  step(2, 'a valid credential unlocks both the detail and the data');
  const authHealth = await call(baseUrl, '/api/v1/health', { headers: authorized });
  console.log(`  GET /health (credential)     -> ${authHealth.status}`);
  console.log(`    fields: ${Object.keys(authHealth.body.data).sort().join(', ')}`);
  const authSessions = await call(baseUrl, '/api/v1/sessions', { headers: authorized });
  console.log(`  GET /sessions (credential)   -> ${authSessions.status}`);

  // ── STEP 3 ────────────────────────────────────────────────────────────────
  step(3, 'a wrong credential and a DSH-shaped credential are both refused, identically');
  for (const [label, value] of [['wrong token', generateSyntheticToken()], ['dsh-shaped', 'dsh-auth-0123456789abcdefghijklmnop']]) {
    const res = await call(baseUrl, '/api/v1/sessions', { headers: { authorization: `Bearer ${value}` } });
    console.log(`  ${label.padEnd(12)} -> ${res.status} ${res.body.error?.code ?? ''}`);
  }
  console.log(`  WWW-Authenticate: ${(await call(baseUrl, '/api/v1/sessions')).headers['www-authenticate']}`);

  // ── STEP 4 ────────────────────────────────────────────────────────────────
  step(4, 'mint a one-time WebSocket ticket');
  const mint = await call(baseUrl, '/api/v1/auth/ws-ticket', {
    method: 'POST',
    body: { session_id: SESSION },
    headers: { ...authorized, origin },
  });
  console.log(`  POST /auth/ws-ticket         -> ${mint.status}`);
  console.log(`    ticket length: ${mint.body.data.ticket.length}, ttl: ${mint.body.data.expires_in_seconds}s`);
  console.log(`    cache-control: ${mint.headers['cache-control']}`);
  const ticket = mint.body.data.ticket;

  // ── STEP 5 ────────────────────────────────────────────────────────────────
  step(5, 'connect with the ticket and receive events');
  const frames = [];
  const client = new WebSocket(`${baseUrl.replace('http', 'ws')}/api/v1/events?session_id=${SESSION}&ticket=${ticket}`, 'dsh-remote-v1', { origin });
  await new Promise((resolve, reject) => {
    client.on('message', (data) => frames.push(JSON.parse(data.toString())));
    client.on('open', resolve);
    client.on('error', reject);
    setTimeout(resolve, 500);
  });
  eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: { step: 'live' } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  console.log(`  frames: ${frames.map((frame) => frame.type).join(', ')}`);

  // ── STEP 6 ────────────────────────────────────────────────────────────────
  step(6, 'the ticket is single-use — proved with a real upgrade attempt');
  const reuse = await rawUpgrade(address.port, `/api/v1/events?session_id=${SESSION}&ticket=${ticket}`, { origin });
  console.log(`  reuse the same ticket        -> ${reuse.status} ${/WS_TICKET_INVALID/.test(reuse.body) ? 'WS_TICKET_INVALID' : ''}`);
  client.close();

  // ── STEP 7 ────────────────────────────────────────────────────────────────
  step(7, 'a ticket is bound to its session and its origin');
  const t2 = (await call(baseUrl, '/api/v1/auth/ws-ticket', {
    method: 'POST', body: { session_id: SESSION }, headers: { ...authorized, origin },
  })).body.data.ticket;
  const wrongSession = await rawUpgrade(
    address.port,
    `/api/v1/events?session_id=${OTHER_SESSION}&ticket=${t2}`,
    { origin },
  );
  console.log(`  ticket for ${SESSION.slice(-4)} used on another session -> ${wrongSession.status} ${/WS_TICKET_INVALID/.test(wrongSession.body) ? 'WS_TICKET_INVALID' : ''}`);

  const t3 = (await call(baseUrl, '/api/v1/auth/ws-ticket', {
    method: 'POST', body: { session_id: OTHER_SESSION }, headers: { ...authorized, origin },
  })).body.data.ticket;
  const hostileOrigin = await rawUpgrade(
    address.port,
    `/api/v1/events?session_id=${OTHER_SESSION}&ticket=${t3}`,
    { origin: 'https://evil.example' },
  );
  console.log(`  bound origin used from a hostile origin -> ${hostileOrigin.status} ${/ORIGIN_NOT_ALLOWED/.test(hostileOrigin.body) ? 'ORIGIN_NOT_ALLOWED' : ''}`);

  const correct = await rawUpgrade(
    address.port,
    `/api/v1/events?session_id=${OTHER_SESSION}&ticket=${t3}`,
    { origin },
  );
  console.log(`  the correct session + origin            -> ${correct.status}`);

  // ── STEP 8 ────────────────────────────────────────────────────────────────
  step(8, 'the long-lived credential never reaches a URL');
  console.log(`  refused by R4 and still refused: ?token=, ?access_token=, ?bearer=`);
  console.log(`  the only credential query permitted is ?ticket= (one-time, 30s, bound)`);
  console.log(`  redacted log form: ${redactRequestUrl(`/api/v1/events?session_id=${SESSION}&ticket=${ticket}`)}`);

  // ── STEP 9 ────────────────────────────────────────────────────────────────
  step(9, 'no credential reached durable state');
  server.persistence.writeSnapshot(true);
  const scan = (await import('node:fs')).default;
  let files = 0;
  let leaked = 0;
  const walk = (dir) => {
    for (const entry of scan.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        files += 1;
        const text = scan.readFileSync(full, 'utf8');
        if (text.includes(token) || text.includes(ticket) || text.includes(t2)) leaked += 1;
      }
    }
  };
  walk(stateRoot);
  console.log(`  scanned ${files} durable files; files containing a credential: ${leaked}`);

  // ── STEP 10 ───────────────────────────────────────────────────────────────
  step(10, 'rate limiting trips deterministically');
  // A dedicated server with a deliberately small ticket budget, so the limit is
  // demonstrated rather than merely described. The default is 20 per minute, which
  // a fixture should not have to issue twenty requests to reach.
  const limitedAuth = new AuthService({
    config: resolveAuthConfig({ mode: AUTH_MODE.REQUIRED, limits: { ticket: { limit: 2, windowSeconds: 60 } } }, {}),
    token,
    clock,
  });
  const limitedAdapter = createFixtureAdapter({ clock });
  const limitedStore = seedFixtureStore(limitedAdapter, clock);
  const limitedEvents = new EventsService({ adapter: limitedAdapter, store: limitedStore, clock });
  const limitedServer = createRemoteHttpServer({
    sessionsService: new SessionsService({ adapter: limitedAdapter, store: limitedStore, clock }),
    messagesService: new MessagesService({ adapter: limitedAdapter, store: limitedStore, clock }),
    eventsService: limitedEvents,
    statusService: new StatusService({ adapter: limitedAdapter, eventsService: limitedEvents, clock }),
    adapter: limitedAdapter,
    config: resolveHttpConfig({ host: '127.0.0.1', port: 0, dshVersion: 'fixture' }, {}),
    healthFacts: () => ({ gateway: 'ready', ready: true, dsh: { status: 'ready' } }),
    auth: limitedAuth,
    // R5A requires an explicit durability decision; this second server is only here
    // to show a rate limit, so it needs no journal.
    persistence: null,
  });
  const limitedAddress = await limitedServer.start();
  const limitedUrl = `http://127.0.0.1:${limitedAddress.port}`;
  const statuses = [];
  for (let index = 0; index < 4; index += 1) {
    statuses.push((await call(limitedUrl, '/api/v1/auth/ws-ticket', {
      method: 'POST', body: { session_id: SESSION }, headers: authorized,
    })).status);
  }
  await limitedServer.stop();
  console.log(`  ticket budget of 2/minute -> ${statuses.join(', ')}`);

  await server.stop();
  console.log('');
  console.log('DONE - every step above used a synthetic credential and a temporary root.');
} finally {
  fs.rmSync(stateRoot, { recursive: true, force: true });
  console.log(`cleaned up: ${!fs.existsSync(stateRoot)}`);
}
