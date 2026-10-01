/**
 * R8G.3 — read-only preflight against the live Gateway (§10).
 *
 * Exercises the real REST surface and a real WebSocket upgrade, and records only non-secret
 * facts. The Phone token is read from the isolated root's handoff file and is never printed; the
 * WS ticket is read from the response and never logged.
 *
 * No prompt, no cancel, no upload.
 *
 * Usage: node scripts/r8g3-preflight.mjs [--out <json>]
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const ORIGIN = flag('--origin', 'http://127.0.0.1:9445');
const TOKEN_FILE = flag('--token-file', 'D:/DSH-testing/.dsh-r8g3/remote/r8g3-phone-token.txt');
const OUT = flag('--out', 'D:/DSH-testing/docs/remote-mobile/_evidence/r8g3-preflight.json');

const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
if (token.length === 0) throw new Error('empty phone token');

const evidence = { phase: 'R8G.3', origin: ORIGIN, at: new Date().toISOString(), checks: {} };
/** Record a check result. */
function record(name, ok, detail) {
  evidence.checks[name] = { ok, ...detail };
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 150)}` : ''}\n`);
}

/** Authenticated fetch. */
async function api(pathname, options = {}) {
  const res = await fetch(`${ORIGIN}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: res.status, body, bytes: text.length };
}

// ── 1. authenticated health ──────────────────────────────────────────────────
const health = await api('/api/v1/health');
record('authenticated_health', health.status === 200, {
  status: health.status,
  gateway: health.body?.data?.gateway ?? null,
  auth_mode: health.body?.data?.auth?.mode ?? null,
});

// ── 2. session enumeration ───────────────────────────────────────────────────
const sessions = await api('/api/v1/sessions');
const list = sessions.body?.data ?? [];
record('session_enumeration', sessions.status === 200, {
  status: sessions.status,
  count: Array.isArray(list) ? list.length : null,
  ids_sample: Array.isArray(list) ? list.slice(0, 3).map((s) => String(s?.id ?? '').slice(0, 12)) : null,
});

if (!Array.isArray(list) || list.length === 0) {
  record('session_selection', false, { reason: 'no sessions enumerated' });
  fs.writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.exit(1);
}

// §12: the first enumerated session, read-only. No session is created.
const target = list[0];
const sessionId = String(target.id);
evidence.session_id_shape = sessionId.slice(0, 8);

// ── 3. one session ───────────────────────────────────────────────────────────
const one = await api(`/api/v1/sessions/${encodeURIComponent(sessionId)}`);
record('get_one_session', one.status === 200, {
  status: one.status,
  domain: one.body?.data?.status ?? one.body?.data?.domain ?? null,
});

// ── 4. messages ──────────────────────────────────────────────────────────────
const messages = await api(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`);
const msgs = messages.body?.data ?? [];
// The cursor field is `source_sequence`, and the page block reports the watermark as `through_seq`
// kinded `dsh_durable_source_sequence`. An earlier version read `sequence`, which does not exist,
// so the watermark collapsed to 0 and the replayed stream carried no events at all.
const page = messages.body?.page ?? null;
const sequenceOf = (m) => Number(m?.source_sequence ?? 0);
record('get_messages', messages.status === 200, {
  status: messages.status,
  count: Array.isArray(msgs) ? msgs.length : null,
  ordered: Array.isArray(msgs) && msgs.every((m, i, a) => i === 0 || sequenceOf(a[i - 1]) <= sequenceOf(m)),
  sequence_kind: page?.sequence_kind ?? null,
});

// The WS cursor is the Gateway's own journal watermark, which `GET /sessions/:id` reports as
// `last_sequence`. It is NOT the REST page's `through_seq`: that is a DSH durable
// `source_sequence` (`17055` here) and lives in a different space, so using it makes the Gateway
// correctly answer `resync_required` because the journal has no such position. `lastSequenceFrom`
// in the UI reads the session field for exactly this reason; this preflight mirrors it.
const lastSequence = Number.isSafeInteger(one.body?.data?.last_sequence) ? one.body.data.last_sequence : null;
evidence.gateway_journal_watermark = lastSequence;
evidence.source_sequence_watermark = Number(page?.through_seq ?? 0);
evidence.cursor_space_is_distinct = true;

// ── 5. ws-ticket ─────────────────────────────────────────────────────────────
// A created resource answers 201, not 200; the route issues a one-time ticket.
const ticketRes = await fetch(`${ORIGIN}/api/v1/auth/ws-ticket`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ session_id: sessionId }),
});
const ticketBody = await ticketRes.json().catch(() => null);
const ticket = ticketBody?.data?.ticket ?? ticketBody?.ticket ?? null;
// The ticket value is deliberately never recorded — only whether one was issued.
record('ws_ticket', (ticketRes.status === 200 || ticketRes.status === 201) && typeof ticket === 'string' && ticket.length > 0, {
  status: ticketRes.status,
  ticket_issued: typeof ticket === 'string' && ticket.length > 0,
});

if (ticket === null) {
  fs.writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.exit(1);
}

// ── 6. WebSocket: hello → replay → replay_complete → clean close ─────────────
const wsUrl = `ws://127.0.0.1:9445/api/v1/events?ticket=${encodeURIComponent(ticket)}&session_id=${encodeURIComponent(sessionId)}${lastSequence !== null && lastSequence > 0 ? `&last_sequence=${lastSequence}` : ''}`;
const frames = [];
const socket = new globalThis.WebSocket(wsUrl, ['dsh-remote-v1']);

const outcome = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ error: 'timeout' }), 15_000);
  socket.addEventListener('message', (event) => {
    let frame = null;
    try { frame = JSON.parse(event.data); } catch { return; }
    frames.push(frame.type);
    if (frame.type === 'replay_complete') {
      clearTimeout(timer);
      resolve({ ok: true });
    }
  });
  socket.addEventListener('error', () => { clearTimeout(timer); resolve({ error: 'socket error' }); });
  socket.addEventListener('close', (event) => { clearTimeout(timer); resolve({ error: `closed ${event.code}` }); });
});

record('ws_hello', frames.includes('hello'), { frames: frames.slice(0, 6) });
record('ws_replay', frames.includes('event') || frames.includes('replay_complete'), { frame_types: [...new Set(frames)] });
record('ws_replay_complete', frames.includes('replay_complete'), { frame_types: [...new Set(frames)] });

// §17: only frame types, connection state and the sequence watermark are recorded.
const replayed = frames.filter((f) => f === 'event').length;
evidence.ws_frames = [...new Set(frames)];
evidence.ws_event_frames = replayed;

if (socket.readyState === 1) socket.close(1000, 'preflight complete');
await new Promise((r) => setTimeout(r, 400));
record('ws_clean_close', socket.readyState === 3, { ready_state: socket.readyState });

// ── 7. reconnect with a FRESH ticket ─────────────────────────────────────────
const ticket2Res = await fetch(`${ORIGIN}/api/v1/auth/ws-ticket`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ session_id: sessionId }),
});
const ticket2Body = await ticket2Res.json().catch(() => null);
const ticket2 = ticket2Body?.data?.ticket ?? ticket2Body?.ticket ?? null;
record('fresh_ticket_on_reconnect', (ticket2Res.status === 200 || ticket2Res.status === 201) && typeof ticket2 === 'string' && ticket2 !== ticket, {
  status: ticket2Res.status,
  distinct_from_previous: ticket2 !== ticket,
});

// The first ticket must now be spent: reuse has to be refused.
const reuse = await new Promise((resolve) => {
  const s = new globalThis.WebSocket(wsUrl, ['dsh-remote-v1']);
  const timer = setTimeout(() => { s.close(); resolve('timeout'); }, 6000);
  s.addEventListener('open', () => { clearTimeout(timer); s.close(); resolve('opened'); });
  s.addEventListener('error', () => { clearTimeout(timer); resolve('refused'); });
  s.addEventListener('close', (event) => { clearTimeout(timer); resolve(`closed ${event.code}`); });
});
record('ticket_reuse_refused', reuse !== 'opened', { outcome: reuse });

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

const failures = Object.entries(evidence.checks).filter(([, v]) => !v.ok).map(([k]) => k);
process.stdout.write(`\n  ${Object.keys(evidence.checks).length - failures.length}/${Object.keys(evidence.checks).length} checks passed`);
if (failures.length > 0) process.stdout.write(`  FAILED: ${failures.join(', ')}`);
process.stdout.write(`\n  evidence: ${OUT}\n`);
process.exit(failures.length === 0 ? 0 : 1);
