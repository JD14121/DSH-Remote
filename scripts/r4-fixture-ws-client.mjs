/**
 * R4 fixture WebSocket client — Phase R4 §43.
 *
 * Demonstrates the WebSocket contract against the **synthetic** fixture server.
 * It never contacts DSH, reads no credential, and exists so a human can watch the
 * protocol instead of reading it.
 *
 * What it shows:
 *   - `hello`
 *   - a live `event` frame
 *   - an application `heartbeat`
 *   - `last_sequence` reconnect and replay
 *   - `resync_required` and close 4001
 *
 * Console output is deliberately ASCII: a Windows console often decodes UTF-8
 * output as a legacy code page, which would render an em dash as mojibake even
 * though the source is valid UTF-8.
 *
 * Usage:
 *   node scripts/r4-fixture-ws-client.mjs
 */

import { WebSocket } from 'ws';

import { createRemoteHttpServer } from '../src/remote/server.mjs';
import { EventsService } from '../src/remote/events.mjs';
import { MessagesService } from '../src/remote/messages.mjs';
import { SessionsService } from '../src/remote/sessions.mjs';
import { StatusService } from '../src/remote/status-service.mjs';
import { resolveHttpConfig } from '../src/remote/http/config.mjs';
import { PROTOCOL, EVENTS_PATH, FRAME } from '../src/remote/ws/protocol.mjs';
import { createFixtureAdapter, disableNetwork, seedFixtureStore } from './fixture-adapter.mjs';

// "This script cannot reach DSH" is enforced, not merely asserted in a comment.
disableNetwork();

const clock = () => 1_789_800_000_000;
const SESSION = 'session-00000000-0000-0000-0000-000000000001';

const banner = `
================================================================
  DSH REMOTE GATEWAY - SYNTHETIC WEBSOCKET FIXTURE CLIENT
================================================================
  Demonstrates the WebSocket contract using FIXTURE DATA ONLY.

    * It does NOT connect to DSH.
    * It does NOT read any credential, cookie or token.
    * It is NOT the production client.
    * Everything runs on loopback.
================================================================
`;

/** Print a frame compactly. */
function show(label, frame) {
  console.log(`  [${label}] ${JSON.stringify(frame)}`);
}

/** Sleep, so frames arrive in a readable order. */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Collect frames from a socket. */
function collect(ws) {
  const frames = [];
  ws.on('message', (data) => {
    try {
      frames.push(JSON.parse(data.toString('utf8')));
    } catch {
      frames.push({ type: '__unparseable__' });
    }
  });
  return frames;
}

/** Wait for a frame type to appear. */
async function waitFor(frames, type, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = frames.find((frame) => frame.type === type);
    if (found !== undefined) return found;
    await wait(10);
  }
  return null;
}

// ── Start the synthetic stack ────────────────────────────────────────────────
const adapter = createFixtureAdapter({ clock });
const store = seedFixtureStore(adapter, clock);
const sessionsService = new SessionsService({ adapter, store, clock });
const messagesService = new MessagesService({ adapter, store, clock });
const eventsService = new EventsService({ adapter, store, clock });
const statusService = new StatusService({ adapter, eventsService, clock });

const server = createRemoteHttpServer({
  sessionsService,
  messagesService,
  eventsService,
  statusService,
  adapter,
  config: resolveHttpConfig({ host: '127.0.0.1', port: 0, dshVersion: '0.1.5-rc.2 (fixture)' }, {}),
  healthFacts: () => ({ gateway: 'ready', ready: true, dsh: { status: 'ready', version: '0.1.5-rc.2 (fixture)' } }),
  // A fast heartbeat so the demonstration does not take half a minute.
  websocketLimits: { heartbeatMs: 10_000, pingIntervalMs: 10_000 },
  // Explicit: a synthetic fixture must never create a durable state root, and after
  // R5A the factory requires the decision rather than defaulting to one.
  persistence: null,
  // R6 §5: explicit, and visibly unauthenticated because this is synthetic data.
  auth: null,
});

const address = await server.start();
const port = address.port;
const url = (query) => {
  const target = new URL(`ws://127.0.0.1:${port}${EVENTS_PATH}`);
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, String(value));
  return target.toString();
};

console.log(banner);
console.log(`fixture server listening on http://127.0.0.1:${port}/api/v1\n`);

try {
  // ── 1. Seed some history so a replay is meaningful ─────────────────────────
  console.log('STEP 1 - seeding 10 synthetic Gateway events');
  for (let index = 0; index < 10; index += 1) {
    eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: { step: index } });
  }
  const bounds = eventsService.sequenceBounds(SESSION);
  console.log(`  sequences ${bounds.earliest}..${bounds.latest} retained\n`);

  // ── 2. hello, and live events ──────────────────────────────────────────────
  console.log(`STEP 2 - connect ${url({ session_id: SESSION })}`);
  const first = new WebSocket(url({ session_id: SESSION }), PROTOCOL);
  const firstFrames = collect(first);
  await new Promise((resolve, reject) => { first.on('open', resolve); first.on('error', reject); });

  const hello = await waitFor(firstFrames, FRAME.HELLO);
  show('hello', hello);
  show('replay_complete', await waitFor(firstFrames, FRAME.REPLAY_COMPLETE));

  console.log('\nSTEP 3 - emit three live events');
  for (let index = 0; index < 3; index += 1) {
    eventsService.emit({ sessionId: SESSION, event: 'assistant.delta', data: { chunk: `part-${index}` } });
  }
  await waitFor(firstFrames, FRAME.EVENT);
  await wait(120);
  for (const frame of firstFrames.filter((entry) => entry.type === FRAME.EVENT)) {
    show('event', frame);
  }

  console.log('\nSTEP 4 - ask for an application heartbeat (client_ping)');
  first.send(JSON.stringify({ type: 'client_ping' }));
  show('heartbeat', await waitFor(firstFrames, FRAME.HEARTBEAT));

  const receivedThrough = Math.max(...firstFrames
    .filter((frame) => frame.type === FRAME.EVENT)
    .map((frame) => frame.event.sequence));
  console.log(`\n  client has processed up to sequence ${receivedThrough}`);

  // ── 3. Disconnect, let the server advance, then reconnect ─────────────────
  console.log('\nSTEP 5 - disconnect, then let the Gateway produce more events');
  first.close();
  await wait(150);
  for (let index = 0; index < 3; index += 1) {
    eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: { after: index } });
  }
  const afterBounds = eventsService.sequenceBounds(SESSION);
  console.log(`  sequences now ${afterBounds.earliest}..${afterBounds.latest}`);

  console.log(`\nSTEP 6 - reconnect with last_sequence=${receivedThrough}`);
  const second = new WebSocket(url({ session_id: SESSION, last_sequence: receivedThrough }), PROTOCOL);
  const secondFrames = collect(second);
  await new Promise((resolve, reject) => { second.on('open', resolve); second.on('error', reject); });

  show('hello', await waitFor(secondFrames, FRAME.HELLO));
  await waitFor(secondFrames, FRAME.REPLAY_COMPLETE);
  await wait(120);
  for (const frame of secondFrames.filter((entry) => entry.type === FRAME.EVENT)) {
    show('replayed', frame);
  }
  show('replay_complete', secondFrames.find((frame) => frame.type === FRAME.REPLAY_COMPLETE));
  second.close();
  await wait(120);

  // ── 4. resync_required ────────────────────────────────────────────────────
  console.log('\nSTEP 7 - reconnect with an impossible watermark to force resync');
  const third = new WebSocket(url({ session_id: SESSION, last_sequence: 9999 }), PROTOCOL);
  const thirdFrames = collect(third);
  let closeInfo = null;
  third.on('close', (code, reason) => { closeInfo = { code, reason: reason?.toString('utf8') ?? '' }; });
  await new Promise((resolve, reject) => { third.on('open', resolve); third.on('error', reject); });

  show('hello', await waitFor(thirdFrames, FRAME.HELLO));
  show('resync_required', await waitFor(thirdFrames, FRAME.RESYNC_REQUIRED));
  await wait(200);
  console.log(`  closed with code ${closeInfo?.code} reason ${closeInfo?.reason}`);

  console.log(`
================================================================
  DEMONSTRATION COMPLETE
================================================================
  Observed: hello, event, heartbeat, replay_complete,
            resync_required, and close 4001.
  All data was synthetic. DSH was never contacted.
================================================================
`);
} finally {
  await server.stop();
}
