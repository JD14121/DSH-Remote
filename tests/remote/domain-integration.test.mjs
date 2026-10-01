/**
 * Domain integration test — R2 §26.5.
 *
 * Simulates the required end-to-end sequence:
 *
 *   list session -> open follow snapshot -> send prompt(queue) -> queued
 *   -> assistant start -> running -> assistant chunks -> assistant committed
 *   -> final domain state
 *
 * and verifies:
 *   - message ids are stable,
 *   - event sequence is strictly increasing,
 *   - status transitions are legal,
 *   - the assistant chunk was never parsed,
 *   - the DSH seq was never used as a Gateway sequence.
 *
 * A single fake adapter stands in for the real one, so the whole test is offline
 * and deterministic. It also proves the architectural rule that no service
 * imports `wire/` or names a DSH endpoint.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { EventsService } from '../../src/remote/events.mjs';
import { MessagesService } from '../../src/remote/messages.mjs';
import { SessionsService } from '../../src/remote/sessions.mjs';
import { GATEWAY_EVENT } from '../../src/remote/model/event.mjs';
import { MESSAGE_TYPE } from '../../src/remote/model/message.mjs';
import { SIGNAL } from '../../src/remote/model/signals.mjs';
import { SESSION_STATUS } from '../../src/remote/model/status.mjs';
import { makeSession } from '../../src/remote/model/session.mjs';
import { SessionViewStore } from '../../src/remote/state/session-view-store.mjs';
import { staticVersionGuard } from '../../src/remote/version-guard.mjs';
import { loadFixture } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION = 'session-00000000-0000-0000-0000-000000000001';
// A DSH durable cursor deliberately far from any Gateway sequence, so a mix-up
// would be glaring.
const DSH_CURSOR = 418;
const clock = () => 1789800000000;

/**
 * A scripted stand-in for `DshAdapter`.
 *
 * Deliberately exposes only the R1 six-method contract.
 */
class FakeAdapter {
  constructor() {
    this.frames = [];
    this.listener = null;
  }

  async listSessions() {
    return [
      {
        id: SESSION,
        title: null,
        status: 'idle',
        created_at: null,
        updated_at: new Date(1789700000000).toISOString(),
        running: false,
      },
    ];
  }

  async getMessages() {
    return {
      messages: [],
      raw: { records: [], hasMore: false },
      throughSeq: DSH_CURSOR,
      hasMore: false,
    };
  }

  async sendMessage(sessionId, message) {
    assert.equal(message.mode, 'queue');
    return { accepted: true, requestId: message.client_message_id };
  }

  async cancel() {
    return { accepted: true, sessionId: SESSION };
  }

  async subscribe(_sessionId, listener) {
    this.listener = listener;
    return { unsubscribe: async () => { this.listener = null; }, cursor: () => DSH_CURSOR };
  }

  /** Deliver one subscription frame to the registered listener. */
  deliver(frame) {
    assert.ok(this.listener, 'nothing is subscribed');
    this.listener(frame);
  }
}

/** Build the full domain stack over the fake adapter. */
function buildStack() {
  const adapter = new FakeAdapter();
  const store = new SessionViewStore({ clock });
  const sessions = new SessionsService({ adapter, store, clock });
  const messages = new MessagesService({ adapter, store, clock });
  const events = new EventsService({ adapter, store, clock });
  return { adapter, store, sessions, messages, events };
}

/** The ordered frame script for the required scenario. */
function scenarioFrames() {
  return {
    snapshot: loadFixture('follow.snapshot.json').muxFrame.value,
    start: loadFixture('follow.assistant-start.json').muxFrame.value,
    chunk: loadFixture('follow.assistant-chunk.json').muxFrame.value,
    end: loadFixture('follow.assistant-end.json').muxFrame.value,
    // DSH durable order: the assistant message commits, then the turn closes.
    committed: {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: DSH_CURSOR,
        time: 1789800000400,
        data: { turn: 1, step: 2, message: 'synthetic committed answer' },
      },
    },
    // `turn/end {kind:'completed'}` is the durable statement that the run ended.
    turnEnd: {
      type: 'event',
      event: { type: 'turn/end', seq: DSH_CURSOR + 1, time: 1789800000500, data: { turn: 1, reason: { kind: 'completed' } } },
    },
  };
}

test('the required end-to-end scenario produces the expected domain state', async () => {
  const { adapter, store, sessions, events } = buildStack();
  const frames = scenarioFrames();

  // 1. list session
  await sessions.refresh();
  assert.equal(sessions.list().length, 1);
  assert.equal(store.get(SESSION).status, SESSION_STATUS.IDLE);

  // 2. open follow snapshot
  const allEvents = [];
  const handle = await events.subscribe(SESSION, { onEvents: (batch) => allEvents.push(...batch) });
  adapter.deliver({ kind: 'snapshot', frame: frames.snapshot });

  // created_at was learned from the real snapshot header, not invented.
  assert.equal(store.get(SESSION).created_at, new Date(frames.snapshot.header.createdAt).toISOString());
  assert.equal(store.getDshCursor(SESSION), frames.snapshot.cursor);

  // 3. send prompt(queue) -> 4. queued
  await adapter.sendMessage(SESSION, { client_message_id: 'client-1', content: 'go', mode: 'queue' });
  const queuedEvents = events.applySignal(SESSION, {
    signal: SIGNAL.PROMPT_ACCEPTED_QUEUE,
    sessionId: SESSION,
    evidence: { source: 'session/prompt accepted' },
  });
  allEvents.push(...queuedEvents);
  assert.equal(store.get(SESSION).status, SESSION_STATUS.QUEUED);

  // 5. assistant start -> 6. running
  adapter.deliver({ kind: 'assistant-stream:start', frame: frames.start, assistantFrame: frames.start.frame });
  events.applySignal(SESSION, { signal: SIGNAL.RUN_STARTED, sessionId: SESSION });
  assert.equal(store.get(SESSION).status, SESSION_STATUS.RUNNING);

  // 7. assistant chunks (two, to prove ordering), then the assistant end frame
  adapter.deliver({ kind: 'assistant-stream:chunk', frame: frames.chunk, assistantFrame: frames.chunk.frame });
  adapter.deliver({ kind: 'assistant-stream:chunk', frame: frames.chunk, assistantFrame: frames.chunk.frame });
  adapter.deliver({ kind: 'assistant-stream:end', frame: frames.end, assistantFrame: frames.end.frame });

  // 8. assistant committed, then the turn closes — the durable completion evidence
  adapter.deliver({ kind: 'event', frame: frames.committed });
  adapter.deliver({ kind: 'event', frame: frames.turnEnd });

  // 9. final domain state
  assert.equal(store.get(SESSION).status, SESSION_STATUS.COMPLETED);

  // The assistant lifecycle is complete and in order.
  const kinds = allEvents.map((event) => event.event);
  assert.ok(kinds.includes(GATEWAY_EVENT.ASSISTANT_START));
  assert.equal(kinds.filter((kind) => kind === GATEWAY_EVENT.ASSISTANT_DELTA).length, 2);
  assert.ok(kinds.includes(GATEWAY_EVENT.ASSISTANT_END));
  assert.ok(kinds.includes(GATEWAY_EVENT.MESSAGE_CREATED));
  assert.ok(kinds.includes(GATEWAY_EVENT.TASK_COMPLETED));

  // Ordering: start appears before the deltas, which appear before the end.
  const startAt = kinds.indexOf(GATEWAY_EVENT.ASSISTANT_START);
  const endAt = kinds.indexOf(GATEWAY_EVENT.ASSISTANT_END);
  assert.ok(startAt < endAt, 'assistant.start must precede assistant.end');

  await handle.unsubscribe();
});

test('the Gateway event sequence is strictly increasing per session', async () => {
  const { adapter, store, sessions, events } = buildStack();
  const frames = scenarioFrames();

  await sessions.refresh();
  await events.subscribe(SESSION, {});
  adapter.deliver({ kind: 'snapshot', frame: frames.snapshot });
  events.applySignal(SESSION, { signal: SIGNAL.PROMPT_ACCEPTED_QUEUE, sessionId: SESSION });
  events.applySignal(SESSION, { signal: SIGNAL.RUN_STARTED, sessionId: SESSION });
  adapter.deliver({ kind: 'assistant-stream:start', frame: frames.start, assistantFrame: frames.start.frame });
  adapter.deliver({ kind: 'assistant-stream:chunk', frame: frames.chunk, assistantFrame: frames.chunk.frame });
  adapter.deliver({ kind: 'event', frame: frames.committed });
  adapter.deliver({ kind: 'event', frame: frames.turnEnd });

  const check = events.verifyMonotonic(SESSION);
  assert.equal(check.monotonic, true, check.reason ?? '');
  assert.ok(events.log(SESSION).length >= 6);
  assert.equal(store.get(SESSION).last_sequence, events.log(SESSION).at(-1).sequence);
});

test('the DSH sequence is never used as a Gateway sequence', async () => {
  const { adapter, sessions, events } = buildStack();
  const frames = scenarioFrames();

  await sessions.refresh();
  await events.subscribe(SESSION, {});
  adapter.deliver({ kind: 'snapshot', frame: frames.snapshot });
  adapter.deliver({ kind: 'event', frame: frames.committed });
  adapter.deliver({ kind: 'event', frame: frames.turnEnd });

  const logged = events.log(SESSION);
  // Every Gateway sequence is a small, densely packed counter.
  assert.deepEqual(logged.map((event) => event.sequence), [1, 2]);

  // The DSH cursor is carried separately and equals a real durable seq.
  const withSource = logged.filter((event) => typeof event.source_sequence === 'number');
  assert.ok(withSource.length >= 2, 'durable events must keep their DSH seq');
  for (const event of withSource) {
    assert.ok(
      event.source_sequence === DSH_CURSOR || event.source_sequence === DSH_CURSOR + 1,
      `unexpected DSH seq ${event.source_sequence}`,
    );
    assert.notEqual(event.sequence, event.source_sequence, 'the two spaces must never coincide');
  }
  assert.ok(withSource.some((event) => event.source_sequence === DSH_CURSOR), 'the committed event keeps its seq');
  // And the DSH high-water mark is tracked on the store, apart from last_sequence.
  assert.equal(events.store.getDshCursor(SESSION), DSH_CURSOR + 1);
  assert.notEqual(events.store.get(SESSION).last_sequence, events.store.getDshCursor(SESSION));
});

test('the assistant chunk is never parsed, only carried', async () => {
  const { adapter, sessions, events } = buildStack();
  const frames = scenarioFrames();

  await sessions.refresh();
  await events.subscribe(SESSION, {});
  adapter.deliver({ kind: 'snapshot', frame: frames.snapshot });
  adapter.deliver({ kind: 'assistant-stream:chunk', frame: frames.chunk, assistantFrame: frames.chunk.frame });

  const delta = events.log(SESSION).find((event) => event.event === GATEWAY_EVENT.ASSISTANT_DELTA);
  assert.ok(delta);
  // Byte-for-byte the same opaque value the adapter handed over.
  assert.deepEqual(delta.data.chunk, frames.chunk.frame.chunk);
  // A second, differently-shaped chunk is equally untouched.
  const shapeB = loadFixture('follow.assistant-chunk.json').shapeBVariant.muxFrame.value;
  adapter.deliver({ kind: 'assistant-stream:chunk', frame: shapeB, assistantFrame: shapeB.frame });
  const deltas = events.log(SESSION).filter((event) => event.event === GATEWAY_EVENT.ASSISTANT_DELTA);
  assert.deepEqual(deltas[1].data.chunk, shapeB.frame.chunk);
  assert.equal(Array.isArray(deltas[1].data.chunk), true);
});

test('message ids are stable across repeated reads of the same history', async () => {
  const adapter = new FakeAdapter();
  const page = loadFixture('session-page.response.json').response.result.value;
  adapter.getMessages = async () => ({
    messages: page.records.map((record) => {
      const event = record.event;
      return {
        id: `${SESSION}:${event.seq}:message`,
        session_id: SESSION,
        role: 'user',
        type: 'message',
        content: event.data?.message ?? null,
        created_at: new Date(event.time).toISOString(),
        sequence: event.seq,
      };
    }),
    raw: page,
    throughSeq: 42,
    hasMore: false,
  });

  const store = new SessionViewStore({ clock });
  store.upsertSession(makeSession({ id: SESSION }));
  const messages = new MessagesService({ adapter, store, clock });

  const first = await messages.list(SESSION);
  const second = await messages.list(SESSION);

  assert.deepEqual(first.messages.map((m) => m.id), second.messages.map((m) => m.id));
  assert.deepEqual(
    first.messages.map((m) => m.source_sequence),
    [40, 41, 42],
  );
});

test('an unknown DSH event survives ingestion as an unknown Gateway event', async () => {
  const { adapter, sessions, events } = buildStack();
  await sessions.refresh();
  await events.subscribe(SESSION, {});

  adapter.deliver({
    kind: 'event',
    frame: { type: 'brand/new/event', seq: 900, time: 1789800009000, data: { payload: ['kept'] } },
  });

  const unknown = events.log(SESSION).find((event) => event.event === GATEWAY_EVENT.UNKNOWN);
  assert.ok(unknown, 'the unknown event must be kept, not dropped');
  assert.equal(unknown.source_sequence, 900);
  assert.deepEqual(unknown.data.payload, { payload: ['kept'] });
});

test('the DSH source sequence is preserved on the domain message, not the Gateway one', async () => {
  const adapter = new FakeAdapter();
  const page = loadFixture('session-page.response.json').response.result.value;
  adapter.getMessages = async () => ({
    messages: page.records.map((record) => ({
      id: `${SESSION}:${record.event.seq}:message`,
      session_id: SESSION,
      role: 'user',
      type: 'message',
      content: record.event.data?.message ?? null,
      created_at: null,
      sequence: record.event.seq,
    })),
    raw: page,
    throughSeq: 42,
    hasMore: false,
  });

  const store = new SessionViewStore({ clock });
  store.upsertSession(makeSession({ id: SESSION }));
  const messages = new MessagesService({ adapter, store, clock });
  const result = await messages.list(SESSION);

  for (const message of result.messages) {
    assert.equal(message.sequence, message.source_sequence, 'sequence is the DSH durable seq');
    assert.ok(message.sequence >= 40 && message.sequence <= 42);
  }
  // Pagination metadata is a DSH cursor, not a Gateway sequence.
  assert.equal(result.next_before_sequence, 40);
  assert.equal(result.through_sequence, 42);
});

test('the domain services never import the wire layer or name a DSH endpoint', async () => {
  const services = ['sessions.mjs', 'messages.mjs', 'events.mjs'];
  // Check real import statements, not prose: these modules legitimately *mention*
  // `wire/` in comments explaining that they must not import it.
  const importPattern = /(?:^|\n)\s*(?:import|export)[^\n]*from\s*['"]([^'"]+)['"]/g;

  // The authoritative endpoint list comes from the wire layer itself, so this
  // guard cannot drift when an endpoint is added.
  const { DSH_ENDPOINT } = await import('../../src/remote/wire/dsh-routes.mjs');
  const endpointNames = Object.values(DSH_ENDPOINT).map((entry) => entry.endpoint);

  // DSH *event* types are a different namespace and are legitimately known to the
  // domain layer (messages must classify them, and unknown ones must be kept).
  const allowedEventTypes = new Set([
    'session/title',
    'session/end-seed',
    'turn/start',
    'turn/end',
    'step/start',
    'step/end',
    'user/message',
    'system/message',
    'assistant/message',
    'assistant/attempt',
    'tool/call',
    'tool/result',
    'approval/asked',
    'approval/decided',
    'goal/change',
  ]);

  for (const name of services) {
    const source = fs.readFileSync(path.join(HERE, '..', '..', 'src', 'remote', name), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '');

    for (const match of code.matchAll(importPattern)) {
      const specifier = match[1];
      assert.equal(
        /(^|\/)wire\//.test(specifier),
        false,
        `${name} must not import the wire layer (found ${specifier})`,
      );
      assert.equal(
        specifier.includes('dsh-rpc-client') || specifier.includes('dsh-routes') || specifier.includes('dsh-auth'),
        false,
        `${name} must not import ${specifier}`,
      );
    }

    for (const endpoint of endpointNames) {
      if (allowedEventTypes.has(endpoint)) continue;
      assert.equal(
        code.includes(`'${endpoint}'`) || code.includes(`"${endpoint}"`) || code.includes(`\`${endpoint}\``),
        false,
        `${name} must not name the DSH endpoint ${endpoint}`,
      );
    }
  }
});

test('waiting_input is reachable only through the normalized WAITING_FOR_USER signal', async () => {
  // Per `docs/r2-status-evidence.md` §7, a durable pending question is NOT
  // reconstructable: `approval/asked` is declared log-only and carries no surface
  // operation, and the live `user-questions/request` event is never replayed.
  // R2 therefore tests the normalized signal (§26.1) and asserts that no durable
  // event type pretends to map to it.
  const { signalForDshEvent } = await import('../../src/remote/events.mjs');
  const { SIGNAL: SIGNALS } = await import('../../src/remote/model/signals.mjs');

  const durableCandidates = [
    'approval/asked',
    'approval/decided',
    'assistant/message',
    'turn/end',
    'tool/result',
  ];
  for (const dshType of durableCandidates) {
    const signal = signalForDshEvent({ type: dshType, seq: 1, time: 1, data: {} });
    assert.notEqual(
      signal?.signal,
      SIGNALS.WAITING_FOR_USER,
      `${dshType} must not drive waiting_input: it is not reliable evidence`,
    );
  }

  // The normalized signal itself does drive the status.
  const { adapter, sessions, events } = buildStack();
  await sessions.refresh();
  events.applySignal(SESSION, { signal: SIGNALS.WAITING_FOR_USER, sessionId: SESSION });
  assert.equal(events.store.get(SESSION).status, SESSION_STATUS.WAITING_INPUT);
});

test('no module outside the adapter boundary imports the wire layer', () => {
  // R2 §2: the future server must not understand DSH wire types. Enforce that the
  // only domain-layer file touching `wire/` is the adapter itself.
  const remoteDir = path.join(HERE, '..', '..', 'src', 'remote');
  const allowed = new Set(['dsh-adapter.mjs']);

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'wire') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.mjs')) continue;
      const source = fs.readFileSync(full, 'utf8');
      for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^\n]*from\s*['"]([^'"]+)['"]/g)) {
        if (/(^|\/)wire\//.test(match[1]) && !allowed.has(entry.name)) {
          assert.fail(`${entry.name} must not import ${match[1]}; only the adapter may touch the wire layer`);
        }
      }
    }
  };
  walk(remoteDir);
});

test('subscribeControl opens one Host-wide control stream and maps every frame kind', async () => {
  const { DshRpcClient } = await import('../../src/remote/wire/dsh-rpc-client.mjs');
  const { FixtureAuthProvider } = await import('../../src/remote/wire/dsh-auth.mjs');
  const { DshAdapter: Adapter, CONTROL_FRAME } = await import('../../src/remote/dsh-adapter.mjs');
  const { FakeWebSocket, FakeFetch, FIXTURE_AUTHORITY } = await import('./helpers.mjs');

  FakeWebSocket.reset();
  const rpc = new DshRpcClient({
    authority: FIXTURE_AUTHORITY,
    authProvider: new FixtureAuthProvider(),
    fetchImpl: new FakeFetch({}).fetch,
    WebSocketImpl: FakeWebSocket,
  });
  const adapter = new Adapter({
    rpcClient: rpc,
    versionGuard: staticVersionGuard('0.1.5-rc.2'),
    authProvider: new FixtureAuthProvider(),
  });

  const received = [];
  const handle = await adapter.subscribeControl((frame) => received.push(frame));

  // `subscribe`-style laziness: the socket is created on demand.
  const { waitFor } = await import('./helpers.mjs');
  await waitFor(() => FakeWebSocket.instances.length >= 1);
  const socket = FakeWebSocket.latest;
  socket.simulateOpen();
  await waitFor(() => socket.sentFrames.length >= 1);

  // The control stream takes no session selector.
  const open = socket.sentFrames[0];
  assert.equal(open.type, 'open');
  assert.equal(open.endpoint, 'session/control');
  assert.deepEqual(open.payload.args, {}, 'session/control takes no args');

  const fixture = loadFixture('control.baseline.json');
  socket.emitMessage(fixture.muxFrame);
  socket.emitMessage(fixture.queueFrame);
  socket.emitMessage(fixture.jobsFrame);
  await waitFor(() => received.length >= 3);

  assert.deepEqual(
    received.map((frame) => frame.kind),
    [CONTROL_FRAME.BASELINE, CONTROL_FRAME.QUEUE, CONTROL_FRAME.JOBS],
  );
  // The baseline is handed over intact, so a caller can read queues and jobs.
  const baseline = received[0].frame.value;
  assert.equal(Object.keys(baseline.queues).length, 2);
  assert.equal(baseline.jobs['session-00000000-0000-0000-0000-000000000001'][0].status, 'running');
  assert.deepEqual(baseline.queues['session-00000000-0000-0000-0000-000000000002'], []);

  await handle.unsubscribe();
  const cancels = socket.sentFrames.filter((frame) => frame.type === 'cancel');
  assert.equal(cancels.length, 1, 'unsubscribe must cancel exactly the control stream');
  assert.equal(socket.closeCalls, 0, 'the physical socket must stay open');

  await adapter.close();
});

test('a malformed control frame fails visibly instead of being applied', async () => {
  const { DshRpcClient } = await import('../../src/remote/wire/dsh-rpc-client.mjs');
  const { FixtureAuthProvider } = await import('../../src/remote/wire/dsh-auth.mjs');
  const { DshAdapter: Adapter, CONTROL_FRAME } = await import('../../src/remote/dsh-adapter.mjs');
  const { FakeWebSocket, FakeFetch, FIXTURE_AUTHORITY, waitFor } = await import('./helpers.mjs');

  FakeWebSocket.reset();
  const rpc = new DshRpcClient({
    authority: FIXTURE_AUTHORITY,
    authProvider: new FixtureAuthProvider(),
    fetchImpl: new FakeFetch({}).fetch,
    WebSocketImpl: FakeWebSocket,
  });
  const adapter = new Adapter({
    rpcClient: rpc,
    versionGuard: staticVersionGuard('0.1.5-rc.2'),
    authProvider: new FixtureAuthProvider(),
  });

  const received = [];
  await adapter.subscribeControl((frame) => received.push(frame));
  await waitFor(() => FakeWebSocket.instances.length >= 1);
  const socket = FakeWebSocket.latest;
  socket.simulateOpen();
  await waitFor(() => socket.sentFrames.length >= 1);

  // A baseline whose jobs columns are not arrays is a wire violation.
  socket.emitMessage({
    type: 'item',
    streamId: socket.sentFrames[0].streamId,
    value: { type: 'baseline', value: { queues: {}, jobs: { 'session-x': 'not-an-array' } } },
  });
  await waitFor(() => received.length >= 1);

  assert.equal(received[0].kind, CONTROL_FRAME.ERROR);
  assert.match(received[0].error.message, /control frame/);

  await adapter.close();
});
