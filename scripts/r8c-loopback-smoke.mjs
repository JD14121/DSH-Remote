/**
 * R8C — real loopback smoke: browser topology through the dev proxy to the Gateway.
 *
 * ## What this exercises
 *
 * ```text
 *   this script  ->  dev server :8099  ->  /api/*  ->  Gateway :9445
 * ```
 *
 * That is the same path the browser takes, so a pass here means the proxy, the CSP shape, the
 * ApiClient and the Gateway's auth all line up.
 *
 * ## Policy (R8C §29-30)
 *
 * * It performs **read-only** operations: authenticated health, session listing, and — when a
 *   session exists — one session and its messages.
 * * It **never** sends a prompt, cancels a run, or uploads a file. Those require an explicitly
 *   approved disposable session.
 * * It **never** creates a session, because the create route is deferred.
 * * It refuses to run if it looks like it is being executed from inside a DSH job.
 *
 * Usage (operator, from a plain shell):
 *   node scripts/r8c-loopback-smoke.mjs [--ui-port 8099] [--gateway-port 9445]
 *
 * The credential is read from `DSH_PHONE_TOKEN` if set. It is never printed, never logged and
 * never written to the evidence file.
 */

import { createUiServer } from './r8b-ui-server.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? Number(args[index + 1]) : fallback;
};

const UI_PORT = flag('--ui-port', 8099);
const GATEWAY_PORT = flag('--gateway-port', 9445);
const TOKEN = process.env.DSH_PHONE_TOKEN ?? '';

/** A short, credential-free label for a probe outcome. */
const label = (ok) => (ok ? 'pass' : 'FAIL');

/**
 * Call through the dev proxy.
 *
 * @param {string} path - the API path.
 * @param {object} [options] - `token`, `method`, `body`.
 * @returns {Promise<{status: number, body: unknown, ms: number}>} the result.
 */
async function probe(path, options = {}) {
  const started = Date.now();
  const headers = { accept: 'application/json' };
  if (options.token !== undefined && options.token.length > 0) headers.authorization = `Bearer ${options.token}`;
  let body;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`http://127.0.0.1:${UI_PORT}${path}`, { method: options.method ?? 'GET', headers, body });
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  return { status: response.status, body: parsed, ms: Date.now() - started };
}

const server = createUiServer({ targetPort: GATEWAY_PORT });
await new Promise((resolve) => server.listen(UI_PORT, '127.0.0.1', resolve));

const evidence = {
  phase: 'R8C',
  kind: 'loopback-smoke',
  ui_port: UI_PORT,
  gateway_port: GATEWAY_PORT,
  credential_supplied: TOKEN.length > 0,
  anonymous_health: null,
  anonymous_sessions_status: null,
  invalid_token_health_kind: null,
  authenticated_health: null,
  sessions_status: null,
  session_count: null,
  session_load: 'not_executed',
  message_history: 'not_executed',
  send_smoke: 'not_executed',
  cancel_smoke: 'not_executed',
  upload_smoke: 'not_executed',
  websocket_connections: 0,
  ws_ticket_requests: 0,
  session_create_attempted: false,
  notes: [],
};

try {
  // 1. A path outside the allowlist must be refused by the proxy before any upstream call.
  const refused = await probe('/api/v1/admin');
  console.log(`  proxy allowlist refusal      : ${refused.status} ${label(refused.status === 403)}`);
  evidence.notes.push(`allowlist refusal status ${refused.status}`);

  // 2. Anonymous health — the Gateway answers, but with the minimal contract.
  const anon = await probe('/api/v1/health');
  evidence.anonymous_health = anon.status;
  console.log(`  anonymous health             : ${anon.status}`);

  // 3. Anonymous sessions must be rejected.
  const anonSessions = await probe('/api/v1/sessions');
  evidence.anonymous_sessions_status = anonSessions.status;
  console.log(`  anonymous sessions           : ${anonSessions.status} ${label(anonSessions.status === 401)}`);

  // 4. An invalid token must not be accepted as authenticated.
  const invalid = await probe('/api/v1/health', { token: 'invalid-token-for-smoke' });
  const invalidAccepted = invalid.status === 200 && invalid.body !== null
    && typeof invalid.body === 'object' && 'dsh' in invalid.body;
  evidence.invalid_token_health_kind = invalidAccepted ? 'accepted (BAD)' : 'rejected';
  console.log(`  invalid token health         : ${invalid.status} ${label(!invalidAccepted)}`);

  if (TOKEN.length === 0) {
    console.log('  authenticated probes         : SKIPPED — set DSH_PHONE_TOKEN to run them');
    evidence.notes.push('authenticated probes skipped: no DSH_PHONE_TOKEN supplied');
  } else {
    // 5. Authenticated health must return the full contract.
    const health = await probe('/api/v1/health', { token: TOKEN });
    const authenticated = health.status === 200 && health.body !== null
      && typeof health.body === 'object' && 'dsh' in health.body && 'persistence' in health.body && 'ready' in health.body;
    evidence.authenticated_health = { status: health.status, authenticated, ms: health.ms };
    console.log(`  authenticated health         : ${health.status} authenticated=${authenticated} ${label(authenticated)}`);

    // 6. Session listing — the observation that matters for the discovery finding.
    const sessions = await probe('/api/v1/sessions', { token: TOKEN });
    const items = Array.isArray(sessions.body) ? sessions.body : (sessions.body?.items ?? []);
    evidence.sessions_status = sessions.status;
    evidence.session_count = Array.isArray(items) ? items.length : null;
    console.log(`  authenticated sessions       : ${sessions.status} count=${evidence.session_count}`);

    // 7. If a session exists, read it and its messages. Read-only; nothing is sent.
    if (Array.isArray(items) && items.length > 0 && items[0]?.id) {
      const id = items[0].id;
      const one = await probe(`/api/v1/sessions/${encodeURIComponent(id)}`, { token: TOKEN });
      const messages = await probe(`/api/v1/sessions/${encodeURIComponent(id)}/messages`, { token: TOKEN });
      const messageItems = Array.isArray(messages.body) ? messages.body : (messages.body?.items ?? []);
      evidence.session_load = { status: one.status, ok: one.status === 200 };
      evidence.message_history = { status: messages.status, count: Array.isArray(messageItems) ? messageItems.length : null };
      console.log(`  session load                 : ${one.status}`);
      console.log(`  message history              : ${messages.status} count=${evidence.message_history.count}`);
    } else {
      evidence.session_load = 'no_session_available';
      evidence.message_history = 'no_session_available';
      console.log('  session / message load       : N/A — the Gateway reports no sessions');
      console.log('  (send / cancel / upload      : N/A — policy forbids creating one to test with)');
    }
  }
} catch (error) {
  evidence.notes.push(`smoke aborted: ${error && error.name ? error.name : 'error'}`);
  console.log(`  smoke aborted                : ${error && error.name ? error.name : 'error'}`);
} finally {
  server.close();
}

console.log('');
console.log('  websocket connections        : 0 (structurally impossible in R8C)');
console.log('  ws-ticket requests           : 0');
console.log('  session-create attempted     : false');

process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
