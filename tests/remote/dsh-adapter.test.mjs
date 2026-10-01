/**
 * Adapter contract tests — R1 §18.1.
 *
 * Covers the six public methods with happy paths and failures:
 *   listSessions, getSession, getMessages, sendMessage, subscribe, cancel
 * including DSH unavailable, session missing, malformed response, and abort.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ADAPTER_ERROR } from '../../src/remote/adapter-errors.mjs';
import { DshAdapter, SUBSCRIPTION_FRAME } from '../../src/remote/dsh-adapter.mjs';
import { DshRpcClient } from '../../src/remote/wire/dsh-rpc-client.mjs';
import { FixtureAuthProvider } from '../../src/remote/wire/dsh-auth.mjs';
import { staticVersionGuard } from '../../src/remote/version-guard.mjs';
import {
  FakeFetch,
  FakeWebSocket,
  FIXTURE_AUTHORITY,
  FIXTURE_SESSION,
  loadFixture,
  settle,
  waitFor,
} from './helpers.mjs';

/**
 * Build an adapter over scripted transports.
 *
 * @param {object} routes - FakeFetch routes keyed by pathname.
 * @param {object} [options] - overrides.
 * @returns {{adapter: DshAdapter, fake: FakeFetch}} the wired pair.
 */
function makeAdapter(routes, options = {}) {
  const fake = new FakeFetch(routes);
  const rpcClient = new DshRpcClient({
    authority: FIXTURE_AUTHORITY,
    authProvider: new FixtureAuthProvider(),
    fetchImpl: fake.fetch,
    WebSocketImpl: FakeWebSocket,
    callTimeoutMs: 5000,
  });
  const adapter = new DshAdapter({
    rpcClient,
    versionGuard: options.versionGuard ?? staticVersionGuard('0.1.5-rc.2'),
    authProvider: new FixtureAuthProvider(),
  });
  return { adapter, fake };
}

/** Echo the live rpcId back, as real DSH does. */
function echoRpcId(spec) {
  return (record) => {
    const resolved = typeof spec === 'function' ? spec(record) : spec;
    if (resolved.body !== null && typeof resolved.body === 'object') {
      return { ...resolved, body: { ...resolved.body, rpcId: record.body.rpcId } };
    }
    return resolved;
  };
}

/** Paths used by the adapter. */
const PATH = {
  LIST: '/api/session/list',
  CREATE: '/api/session/create',
  PAGE: '/api/session/page',
  PROMPT: '/api/session/prompt',
  CANCEL: '/api/session/cancel',
};

test('listSessions maps DSH summaries onto the mobile shape', async () => {
  const fixture = loadFixture('session-list.response.json');
  const { adapter } = makeAdapter({ [PATH.LIST]: echoRpcId({ status: 200, body: fixture.response }) });

  const sessions = await adapter.listSessions();

  assert.equal(sessions.length, 3);
  assert.deepEqual(Object.keys(sessions[0]).sort(), ['created_at', 'id', 'status', 'title', 'updated_at']);
  assert.equal(sessions[0].id, FIXTURE_SESSION.RUNNING);
  assert.equal(sessions[0].status, 'running');
  assert.equal(sessions[1].status, 'idle');
  // R1 never fabricates a title or a creation time the wire does not carry.
  assert.equal(sessions[0].title, null);
  assert.equal(sessions[0].created_at, null);
  assert.equal(sessions[0].updated_at, new Date(1789800000000).toISOString());
});

test('getSession returns the addressed session', async () => {
  const fixture = loadFixture('session-list.response.json');
  const { adapter } = makeAdapter({ [PATH.LIST]: echoRpcId({ status: 200, body: fixture.response }) });

  const session = await adapter.getSession(FIXTURE_SESSION.IDLE);
  assert.equal(session.id, FIXTURE_SESSION.IDLE);
  assert.equal(session.status, 'idle');
});

test('getSession raises SESSION_NOT_FOUND for an unknown session', async () => {
  const fixture = loadFixture('session-list.response.json');
  const { adapter } = makeAdapter({ [PATH.LIST]: echoRpcId({ status: 200, body: fixture.response }) });

  await assert.rejects(
    () => adapter.getSession('session-ffffffff-ffff-ffff-ffff-ffffffffffff'),
    (error) => {
      assert.equal(error.code, ADAPTER_ERROR.SESSION_NOT_FOUND);
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test('createSession invokes session/create with an EMPTY request and maps the result', async () => {
  const { adapter, fake } = makeAdapter({
    [PATH.CREATE]: echoRpcId({
      status: 200,
      body: {
        type: 'server-response',
        result: { ok: true, value: { sessionId: FIXTURE_SESSION.BLANK, agentPreset: 'default' } },
      },
    }),
  });

  const result = await adapter.createSession();

  assert.deepEqual(result, { sessionId: FIXTURE_SESSION.BLANK, agentPreset: 'default' });
  assert.equal(fake.lastCall.pathname, PATH.CREATE);
  // The security boundary: DSH receives `{}`, never a caller-supplied scope.
  assert.deepEqual(fake.lastCall.body.payload.args.request, {});
});

test('createSession never forwards a caller-supplied workspace, path, preset or id', async () => {
  const { adapter, fake } = makeAdapter({
    [PATH.CREATE]: echoRpcId({
      status: 200,
      body: {
        type: 'server-response',
        result: { ok: true, value: { sessionId: FIXTURE_SESSION.BLANK } },
      },
    }),
  });

  // A hostile/curious caller passes every optional selector DSH accepts.
  await adapter.createSession({
    workspaceId: 'C:\\arbitrary',
    cwd: 'C:\\arbitrary',
    agentPreset: 'hax',
    sessionId: 'session-attacker-chosen',
  });

  assert.deepEqual(fake.lastCall.body.payload.args.request, {}, 'no caller scope may reach DSH');
});

test('createSession reports an absent agentPreset as null rather than inventing one', async () => {
  const { adapter } = makeAdapter({
    [PATH.CREATE]: echoRpcId({
      status: 200,
      body: {
        type: 'server-response',
        result: { ok: true, value: { sessionId: FIXTURE_SESSION.BLANK } },
      },
    }),
  });

  const result = await adapter.createSession();
  assert.equal(result.sessionId, FIXTURE_SESSION.BLANK);
  assert.equal(result.agentPreset, null);
});

test('createSession rejects a malformed SessionCreateValue', async () => {
  const { adapter } = makeAdapter({
    [PATH.CREATE]: echoRpcId({
      status: 200,
      body: {
        type: 'server-response',
        result: { ok: true, value: { agentPreset: 'default' } },
      },
    }),
  });

  await assert.rejects(
    () => adapter.createSession(),
    (error) => {
      assert.equal(error.code, ADAPTER_ERROR.WIRE_PROTOCOL_ERROR);
      assert.match(error.message, /SessionCreateValue/);
      return true;
    },
  );
});

test('getMessages pages history and normalizes records', async () => {
  const fixture = loadFixture('session-page.response.json');
  const { adapter, fake } = makeAdapter({
    [PATH.PAGE]: echoRpcId({ status: 200, body: fixture.response }),
  });

  const page = await adapter.getMessages(FIXTURE_SESSION.RUNNING, { throughSeq: 42, maxMessages: 2 });

  assert.equal(page.messages.length, 3);
  assert.equal(page.hasMore, true);
  assert.equal(page.throughSeq, 42);
  assert.deepEqual(page.messages.map((m) => m.role), ['user', 'tool', 'tool']);
  assert.deepEqual(page.messages.map((m) => m.sequence), [40, 41, 42]);

  // The adapter must use session/page, never the zstd log (R1 §16).
  assert.equal(fake.lastCall.pathname, PATH.PAGE);
  assert.deepEqual(fake.lastCall.body.payload.args.request, {
    address: { kind: 'session', sessionId: FIXTURE_SESSION.RUNNING },
    throughSeq: 42,
    maxMessages: 2,
  });
});

test('getMessages resolves the cursor from a follow snapshot when omitted', async () => {
  FakeWebSocket.reset();
  const snapshotFixture = loadFixture('follow.snapshot.json');
  const pageFixture = loadFixture('session-page.response.json');
  const { adapter } = makeAdapter({
    [PATH.PAGE]: echoRpcId({ status: 200, body: pageFixture.response }),
  });

  const pending = adapter.getMessages(FIXTURE_SESSION.RUNNING, { maxMessages: 2 });
  await waitFor(() => FakeWebSocket.instances.length === 1);
  const socket = FakeWebSocket.latest;
  socket.simulateOpen();
  await waitFor(() => socket.sentFrames.length >= 1);
  assert.equal(socket.sentFrames[0].endpoint, 'session/follow');
  socket.emitMessage(snapshotFixture.muxFrame);

  const page = await pending;
  assert.equal(page.throughSeq, snapshotFixture.muxFrame.value.cursor);
});

test('sendMessage forwards client_message_id as requestId and requires mode', async () => {
  const fixture = loadFixture('prompt.accepted.response.json');
  const { adapter, fake } = makeAdapter({
    [PATH.PROMPT]: echoRpcId({ status: 200, body: fixture.response }),
  });

  const result = await adapter.sendMessage(FIXTURE_SESSION.RUNNING, {
    client_message_id: 'client-message-id-fixture-1',
    content: 'continue with phase R2',
    mode: 'queue',
  });

  assert.equal(result.accepted, true);
  assert.equal(result.requestId, 'client-message-id-fixture-1');

  const sent = fake.lastCall.body.payload.args.request;
  assert.equal(sent.requestId, 'client-message-id-fixture-1');
  assert.equal(sent.sessionId, FIXTURE_SESSION.RUNNING);
  assert.equal(sent.mode, 'queue');
  assert.deepEqual(sent.content, [{ type: 'text', text: 'continue with phase R2' }]);
});

test('sendMessage rejects a missing mode instead of choosing a default', async () => {
  const { adapter, fake } = makeAdapter({});

  await assert.rejects(
    () =>
      adapter.sendMessage(FIXTURE_SESSION.RUNNING, {
        client_message_id: 'client-message-id-fixture-1',
        content: 'no mode supplied',
      }),
    (error) => {
      assert.equal(error.code, 'INVALID_PROMPT_MODE');
      return true;
    },
  );
  assert.equal(fake.calls.length, 0, 'an invalid prompt must not reach DSH');
});

test('cancel maps a cold session to SESSION_COLD and never reports success', async () => {
  const fixture = loadFixture('cancel.cold.response.json');
  const { adapter } = makeAdapter({
    [PATH.CANCEL]: echoRpcId({
      status: 200,
      body: {
        type: 'server-response',
        result: {
          ok: false,
          error: {
            code: fixture._fixture.wireCode,
            message: fixture._fixture.wireMessage,
            details: {},
          },
        },
      },
    }),
  });

  await assert.rejects(
    () => adapter.cancel(FIXTURE_SESSION.COLD),
    (error) => {
      assert.equal(error.code, ADAPTER_ERROR.SESSION_COLD);
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test('cancel reports the Host admission receipt on success', async () => {
  const fixture = loadFixture('cancel.success.response.json');
  const { adapter, fake } = makeAdapter({
    [PATH.CANCEL]: echoRpcId({ status: 200, body: fixture.response }),
  });

  const result = await adapter.cancel(FIXTURE_SESSION.RUNNING);
  assert.deepEqual(result, { accepted: true, sessionId: FIXTURE_SESSION.RUNNING });
  assert.equal(fake.lastCall.pathname, PATH.CANCEL);
  assert.deepEqual(fake.lastCall.body.payload.args.request, { sessionId: FIXTURE_SESSION.RUNNING });
});

test('DSH unavailable surfaces as DSH_UNAVAILABLE and stays retryable', async () => {
  const { adapter } = makeAdapter({ [PATH.LIST]: 'throw' });

  await assert.rejects(
    () => adapter.listSessions(),
    (error) => {
      assert.equal(error.code, ADAPTER_ERROR.DSH_UNAVAILABLE);
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test('a malformed SessionListValue fails visibly instead of yielding junk', async () => {
  const { adapter } = makeAdapter({
    [PATH.LIST]: echoRpcId({
      status: 200,
      body: {
        type: 'server-response',
        result: { ok: true, value: { items: [{ sessionId: 'session-x' }] } },
      },
    }),
  });

  await assert.rejects(
    () => adapter.listSessions(),
    (error) => {
      assert.equal(error.code, ADAPTER_ERROR.WIRE_PROTOCOL_ERROR);
      assert.match(error.message, /SessionListValue/);
      return true;
    },
  );
});

test('an aborted signal produces STREAM_ABORTED', async () => {
  const controller = new AbortController();
  controller.abort();
  const { adapter } = makeAdapter({
    [PATH.PROMPT]: echoRpcId({
      status: 200,
      body: { type: 'server-response', result: { ok: true, value: { accepted: true } } },
    }),
  });

  await assert.rejects(
    () =>
      adapter.sendMessage(
        FIXTURE_SESSION.RUNNING,
        { client_message_id: 'id-1', content: 'text', mode: 'queue' },
        { signal: controller.signal },
      ),
    (error) => error.code === ADAPTER_ERROR.STREAM_ABORTED,
  );
});

test('subscribe opens a follow stream, delivers frames in order, and aborts only that stream', async () => {
  FakeWebSocket.reset();
  const { adapter } = makeAdapter({});
  const snapshot = loadFixture('follow.snapshot.json').muxFrame;
  const event = loadFixture('follow.event.json').muxFrame;
  const start = loadFixture('follow.assistant-start.json').muxFrame;
  const chunk = loadFixture('follow.assistant-chunk.json').muxFrame;
  const end = loadFixture('follow.assistant-end.json').muxFrame;

  const received = [];
  const handle = await adapter.subscribe(FIXTURE_SESSION.RUNNING, (frame) => {
    received.push(frame);
  });

  // `subscribe` resolves before the physical socket exists: the transport is
  // established lazily. Wait for it rather than assuming it is already there.
  await waitFor(() => FakeWebSocket.instances.length >= 1);
  const socket = FakeWebSocket.latest;
  socket.simulateOpen();
  await waitFor(() => socket.sentFrames.length >= 1);

  const open = socket.sentFrames[0];
  assert.equal(open.type, 'open');
  assert.equal(open.endpoint, 'session/follow');
  assert.equal(open.payload.args.request.address.sessionId, FIXTURE_SESSION.RUNNING);
  assert.equal(open.payload.args.request.assistantStream, true);

  for (const frame of [snapshot, event, start, chunk, end]) socket.emitMessage(frame);
  await waitFor(
    () => received.length >= 5,
    2000,
    () => `received=${received.length} kinds=${received.map((f) => f.kind).join(',')} err=${received.find((f) => f.kind === 'error')?.error?.message ?? 'none'} sent=${socket.sentFrames.length}`,
  );

  assert.deepEqual(
    received.map((frame) => frame.kind),
    [
      SUBSCRIPTION_FRAME.SNAPSHOT,
      SUBSCRIPTION_FRAME.EVENT,
      SUBSCRIPTION_FRAME.ASSISTANT_START,
      SUBSCRIPTION_FRAME.ASSISTANT_CHUNK,
      SUBSCRIPTION_FRAME.ASSISTANT_END,
    ],
  );

  // The opaque chunk is delivered verbatim (R1 §8, §14.1).
  assert.deepEqual(received[3].assistantFrame.chunk, chunk.value.frame.chunk);
  assert.equal(handle.cursor(), 42);

  await handle.unsubscribe();

  const cancels = socket.sentFrames.filter((frame) => frame.type === 'cancel');
  assert.equal(cancels.length, 1, 'unsubscribe must cancel exactly one logical stream');
  assert.equal(cancels[0].streamId, open.streamId);
  assert.equal(socket.closeCalls, 0, 'unsubscribe must not close the physical socket');
});

test('a transport disconnect is reported as retryable unavailability, not a session failure', async () => {
  FakeWebSocket.reset();
  const { adapter } = makeAdapter({});
  const received = [];
  await adapter.subscribe(FIXTURE_SESSION.RUNNING, (frame) => received.push(frame));

  await waitFor(() => FakeWebSocket.instances.length >= 1);
  const socket = FakeWebSocket.latest;
  socket.simulateOpen();
  await waitFor(() => socket.sentFrames.length >= 1);
  // Read the socket back: a duplicate transport would mean the reference taken
  // before `simulateOpen()` is stale.
  const active = FakeWebSocket.latest;
  assert.equal(FakeWebSocket.instances.length, 1, 'concurrent callers must share one physical socket');
  active.simulateClose();

  await waitFor(
    () => received.some((frame) => frame.kind === SUBSCRIPTION_FRAME.ERROR),
    2000,
    () => `received=${received.map((f) => f.kind).join(',') || 'none'} closeCalls=${active.closeCalls}`,
  );
  const error = received.find((frame) => frame.kind === SUBSCRIPTION_FRAME.ERROR).error;
  assert.equal(error.code, ADAPTER_ERROR.DSH_UNAVAILABLE);
  assert.equal(error.retryable, true);
});

test('the version guard is consulted before any wire call', async () => {
  const calls = [];
  const { adapter, fake } = makeAdapter(
    {
      [PATH.LIST]: echoRpcId({
        status: 200,
        body: { type: 'server-response', result: { ok: true, value: { items: [] } } },
      }),
    },
    {
      versionGuard: {
        async verify() {
          calls.push('verify');
          const { AdapterError, ADAPTER_ERROR } = await import('../../src/remote/adapter-errors.mjs');
          throw new AdapterError(ADAPTER_ERROR.WIRE_VERSION_MISMATCH, 'refused');
        },
      },
    },
  );

  await assert.rejects(
    () => adapter.listSessions(),
    (error) => error.code === ADAPTER_ERROR.WIRE_VERSION_MISMATCH,
  );
  assert.deepEqual(calls, ['verify']);
  assert.equal(fake.calls.length, 0, 'a failed version guard must prevent the wire call');
});
