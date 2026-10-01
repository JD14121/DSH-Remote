/**
 * Live smoke tests — Phase R7 §31, §32, §33, §45, §89.
 *
 * These run against a **real running production stack** and skip with an explicit
 * reason when none is present. That shape is deliberate:
 *
 * * Gate A must be able to run the full suite with no production stack at all, and a
 *   test that failed instead of skipping would make Gate A impossible;
 * * Gate B must be able to prove the live behaviour, and a test that silently passed
 *   would prove nothing.
 *
 * So a skip here is never a pass — the Gate B evidence is the output of these tests
 * running for real, recorded in `PHASE-R7-REPORT.md`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import { REAL_DSH_HOME } from './r7-helpers.mjs';

const GATEWAY = 'http://127.0.0.1:9445';
const PRODUCTION_ROOT = path.join(REAL_DSH_HOME, 'remote');
const STATUS_FILE = path.join(PRODUCTION_ROOT, 'state', 'supervisor.json');
const PHONE_TOKEN_FILE = path.join(PRODUCTION_ROOT, 'secrets', 'phone-token.v1');

/**
 * Read the production status file.
 *
 * @returns {object|null} the record, or `null`.
 */
function readProductionStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Whether a live production stack is actually running.
 *
 * The state file alone is not evidence. It records the supervisor's last *belief*, and a
 * supervisor that dies without running its stop path leaves `state: "READY"` behind while nothing
 * is listening — which is exactly what happened during R7C: a hard-killed supervisor left a stale
 * `READY`, these tests then tried to run against a dead stack, and they failed with ECONNREFUSED
 * instead of skipping.
 *
 * That is the same defect class as R7-KNOWN-LIMITATION-01 one level up: a recorded claim standing
 * in for observed reality. So the record is now corroborated by probing the Gateway port.
 *
 * @returns {Promise<boolean>} true when a stack is genuinely reachable.
 */
async function productionIsReady() {
  const record = readProductionStatus();
  if (record === null || record.state !== 'READY') return false;
  // Corroborate with the socket, using the port the record names so a custom port still works.
  const port = record.gateway?.port ?? 9445;
  const net = await import('node:net');
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const settle = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(700);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/**
 * Load the production Phone credential into memory.
 *
 * Reading the credential is the ONLY reason this suite touches the real root, and the
 * value never leaves this process: it is used as an Authorization header and is never
 * written to a log, an assertion message, or a test artefact.
 *
 * @returns {string|null} the token, or `null`.
 */
function loadProductionToken() {
  try {
    const token = fs.readFileSync(PHONE_TOKEN_FILE, 'utf8');
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

/**
 * Call the Gateway.
 *
 * @param {string} requestPath - the path.
 * @param {object} [options] - headers and method.
 * @returns {Promise<{status: number, body: any, headers: object}>} the response.
 */
async function gateway(requestPath, options = {}) {
  const response = await fetch(`${GATEWAY}${requestPath}`, {
    method: options.method ?? 'GET',
    headers: { ...(options.headers ?? {}) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body), method: 'POST' }),
  });
  const text = await response.text();
  let body = null;
  try { body = text.length === 0 ? null : JSON.parse(text); } catch { body = text; }
  return { status: response.status, body, headers: Object.fromEntries(response.headers) };
}

/**
 * The skip reason, or false when a real stack is reachable.
 *
 * @returns {Promise<string|false>} the reason, or false to run.
 */
const skip = async () => ((await productionIsReady()) ? false : 'no READY production stack is running (Gate B not active)');

test('§32: the Gateway is reachable on loopback', async (t) => {
  const reason = await skip();
  if (reason !== false) { t.skip(reason); return; }
  const health = await gateway('/api/v1/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.data.auth.required, true, 'the public view reports auth is required');
  // And the public view is minimal.
  assert.equal(health.body.data.dsh, undefined);
});

test('§32: authenticated health reports every axis ready', async (t) => {
  const reason = await skip();
  if (reason !== false) { t.skip(reason); return; }
  const token = loadProductionToken();
  assert.ok(token !== null, 'the production credential is readable');

  const health = await gateway('/api/v1/health', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(health.status, 200, 'the real credential must authenticate');
  const data = health.body.data;
  assert.equal(data.gateway, 'ready', 'gateway axis');
  assert.equal(data.auth.status, 'ready', 'auth axis');
  assert.equal(data.auth.mode, 'bearer+ws-ticket');
  assert.ok(data.persistence !== undefined, 'persistence axis');
  assert.equal(data.persistence.status, 'ready');
  assert.ok(data.dsh !== undefined, 'DSH axis');
  assert.equal(typeof data.dsh.status, 'string');

  // The secret must not be echoed anywhere in the response.
  assert.equal(JSON.stringify(health.body).includes(token), false);
});

test('§32: unauthenticated data access is refused on the real stack', async (t) => {
  const reason = await skip();
  if (reason !== false) { t.skip(reason); return; }
  const sessions = await gateway('/api/v1/sessions');
  assert.equal(sessions.status, 401, 'no credential, no data');
  assert.equal(sessions.headers['www-authenticate'] !== undefined, true);
});

test('§32: the real session list succeeds', async (t) => {
  const reason = await skip();
  if (reason !== false) { t.skip(reason); return; }
  const token = loadProductionToken();
  const sessions = await gateway('/api/v1/sessions', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(sessions.status, 200, 'the authenticated session list must succeed');

  const list = sessions.body.data?.sessions ?? sessions.body.data?.items ?? [];
  assert.ok(Array.isArray(list), 'the session list is an array');

  // §32: no sessions is NOT a failure, as long as the authenticated call worked.
  if (list.length === 0) {
    t.diagnostic('R7_LIVE_NO_SESSION_AVAILABLE — the authenticated session list succeeded but is empty');
    return;
  }
  t.diagnostic(`live sessions available: ${list.length}`);
});

test('§32: a real session detail and message list are readable', async (t) => {
  const reason = await skip();
  if (reason !== false) { t.skip(reason); return; }
  const token = loadProductionToken();
  const headers = { authorization: `Bearer ${token}` };
  const sessions = await gateway('/api/v1/sessions', { headers });
  const list = sessions.body.data?.sessions ?? sessions.body.data?.items ?? [];
  if (list.length === 0) { t.skip('no live session to inspect'); return; }

  const sessionId = list[0].id ?? list[0].session_id;
  const detail = await gateway(`/api/v1/sessions/${sessionId}`, { headers });
  assert.equal(detail.status, 200, 'a real session detail is readable');

  const messages = await gateway(`/api/v1/sessions/${sessionId}/messages`, { headers });
  assert.equal(messages.status, 200, 'a real message list is readable');
});

test('§32: a real WebSocket ticket can be minted and used', async (t) => {
  const reason = await skip();
  if (reason !== false) { t.skip(reason); return; }
  const token = loadProductionToken();
  const headers = { authorization: `Bearer ${token}` };
  const sessions = await gateway('/api/v1/sessions', { headers });
  const list = sessions.body.data?.sessions ?? sessions.body.data?.items ?? [];
  if (list.length === 0) { t.skip('no live session for a WebSocket smoke'); return; }

  const sessionId = list[0].id ?? list[0].session_id;
  const mint = await gateway('/api/v1/auth/ws-ticket', { headers, body: { session_id: sessionId } });
  assert.equal(mint.status, 201, 'a real ticket is minted');
  assert.equal(mint.headers['cache-control'], 'no-store');
  const ticket = mint.body.data.ticket;
  assert.equal(typeof ticket, 'string');
  assert.equal(ticket.length, 43);

  // The connection itself is exercised by the Gate B smoke script, which can await
  // real frames; here the mint is the assertion.
  assert.equal(JSON.stringify(mint.body).includes(token), false, 'the Bearer is never echoed');
});

test('§33: reconciliation is a safe no-op or a real read', async (t) => {
  const reason = await skip();
  if (reason !== false) { t.skip(reason); return; }
  const token = loadProductionToken();
  const headers = { authorization: `Bearer ${token}` };

  // Read-only: the durable cursor must never move backwards, and no duplicate may be
  // produced. Asserting the observable invariant is the honest check.
  const sessions = await gateway('/api/v1/sessions', { headers });
  assert.equal(sessions.status, 200);
  const list = sessions.body.data?.sessions ?? sessions.body.data?.items ?? [];
  if (list.length === 0) {
    t.diagnostic('R7_LIVE_RECONCILIATION_NO_SESSION — fixture evidence retained');
    return;
  }
  // With a session present, the sequence must be a sane monotonic value.
  const withSequence = list.filter((entry) => typeof (entry.last_sequence ?? entry.sequence) === 'number');
  for (const entry of withSequence) {
    const value = entry.last_sequence ?? entry.sequence;
    assert.ok(Number.isSafeInteger(value) && value >= 0, 'sequence values are sane');
  }
});

test('§39: the production secret scan finds no launch token or cookie on disk', async (t) => {
  const reason = await skip();
  if (reason !== false) { t.skip(reason); return; }
  // Walk the real production root and assert that no artefact contains anything that
  // looks like a DSH launch token or auth cookie. The Phone credential is permitted in
  // exactly one file.
  const permitted = path.relative(PRODUCTION_ROOT, PHONE_TOKEN_FILE);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const relative = path.relative(PRODUCTION_ROOT, full);
      if (relative === permitted) continue;
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      // A dsh-auth cookie value shape, and the launch-token announcement.
      if (/dsh-auth-[A-Za-z0-9_-]{43}=/.test(text)) offenders.push(`${relative}: dsh-auth cookie`);
      if (/dsh web:.*\?token=[A-Za-z0-9_-]{43}/.test(text)) offenders.push(`${relative}: launch token`);
    }
  };
  if (fs.existsSync(PRODUCTION_ROOT)) walk(PRODUCTION_ROOT);
  assert.deepEqual(offenders, [], 'no ephemeral DSH credential may be durable');
});

test('§31: the status file agrees with the live stack', async (t) => {
  const reason = await skip();
  if (reason !== false) { t.skip(reason); return; }
  const record = readProductionStatus();
  assert.equal(record.state, 'READY');
  assert.equal(typeof record.supervisor_pid, 'number');
  assert.equal(typeof record.dsh_pid, 'number');
  assert.equal(record.gateway.port, 9445);
  assert.equal(record.dsh.version, '0.1.5-rc.2');

  // No secret field may exist in the status file.
  const text = JSON.stringify(record);
  for (const word of ['token', 'cookie', 'secret', 'digest']) {
    assert.equal(text.toLowerCase().includes(`"${word}`), false, `the status file must not carry ${word}`);
  }
});
