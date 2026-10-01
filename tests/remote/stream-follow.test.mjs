/**
 * Stream / follow tests — R1 §14, §18.3.
 *
 * Covers: snapshot, event, assistant start/chunk/end, abort, a fresh reconnect
 * snapshot, and logical stream independence on one physical socket.
 *
 * `unsubscribe()` must abort only its own logical stream: it may not close the
 * DSH server, may not cancel the session's Agent task, and may not disturb a
 * sibling stream on the same socket.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ADAPTER_ERROR } from '../../src/remote/adapter-errors.mjs';
import { DshAdapter, SUBSCRIPTION_FRAME, toSubscriptionFrame } from '../../src/remote/dsh-adapter.mjs';
import { DshRpcClient } from '../../src/remote/wire/dsh-rpc-client.mjs';
import { FixtureAuthProvider } from '../../src/remote/wire/dsh-auth.mjs';
import { staticVersionGuard } from '../../src/remote/version-guard.mjs';
import {
  FakeFetch,
  FakeWebSocket,
  FIXTURE_AUTHORITY,
  FIXTURE_SESSION,
  loadFixture,
  waitFor,
} from './helpers.mjs';

/** Build a bare RPC client over the fake transports. */
function makeRpc() {
  const rpcClient = new DshRpcClient({
    authority: FIXTURE_AUTHORITY,
    authProvider: new FixtureAuthProvider(),
    fetchImpl: new FakeFetch({}).fetch,
    WebSocketImpl: FakeWebSocket,
    callTimeoutMs: 5000,
  });
  return rpcClient;
}

/** Build an adapter over the fake transports. */
function makeAdapter() {
  const rpcClient = makeRpc();
  return new DshAdapter({
    rpcClient,
    versionGuard: staticVersionGuard('0.1.5-rc.2'),
    authProvider: new FixtureAuthProvider(),
  });
}

/** All fixture mux frames, in canonical order. */
function orderedFrames() {
  return [
    loadFixture('follow.snapshot.json').muxFrame,
    loadFixture('follow.event.json').muxFrame,
    loadFixture('follow.assistant-start.json').muxFrame,
    loadFixture('follow.assistant-chunk.json').muxFrame,
    loadFixture('follow.assistant-end.json').muxFrame,
  ];
}

test('toSubscriptionFrame maps every follow frame kind without altering it', () => {
  const [snapshot, event, start, chunk, end] = orderedFrames();

  assert.equal(toSubscriptionFrame(snapshot.value).kind, SUBSCRIPTION_FRAME.SNAPSHOT);
  assert.equal(toSubscriptionFrame(event.value).kind, SUBSCRIPTION_FRAME.EVENT);
  assert.equal(toSubscriptionFrame(start.value).kind, SUBSCRIPTION_FRAME.ASSISTANT_START);
  assert.equal(toSubscriptionFrame(chunk.value).kind, SUBSCRIPTION_FRAME.ASSISTANT_CHUNK);
  assert.equal(toSubscriptionFrame(end.value).kind, SUBSCRIPTION_FRAME.ASSISTANT_END);

  // The frame is handed over by reference, not copied or rewritten.
  assert.equal(toSubscriptionFrame(chunk.value).frame, chunk.value);
});

test('frames arrive in host order and the opaque chunk survives verbatim', async () => {
  FakeWebSocket.reset();
  const adapter = makeAdapter();
  const received = [];
  await adapter.subscribe(FIXTURE_SESSION.RUNNING, (frame) => received.push(frame));

  await waitFor(() => FakeWebSocket.instances.length >= 1);
  const socket = FakeWebSocket.latest;
  socket.simulateOpen();
  await waitFor(() => socket.sentFrames.length >= 1);

  const frames = orderedFrames();
  for (const frame of frames) socket.emitMessage(frame);
  await waitFor(() => received.length >= frames.length);

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

  // R1 §8: the chunk is opaque and must not be reinterpreted.
  const chunkFrame = frames[3].value.frame;
  assert.deepEqual(received[3].assistantFrame.chunk, chunkFrame.chunk);
  assert.equal(typeof received[3].assistantFrame.chunk, 'object');

  // A deliberately different opaque shape is also passed through untouched.
  const shapeB = loadFixture('follow.assistant-chunk.json').shapeBVariant.muxFrame;
  socket.emitMessage(shapeB);
  await waitFor(() => received.length >= frames.length + 1);
  assert.deepEqual(received[5].assistantFrame.chunk, shapeB.value.frame.chunk);
  assert.equal(Array.isArray(received[5].assistantFrame.chunk), true);

  await adapter.close();
});

test('an abandoned assistant attempt is reported as an end frame', async () => {
  FakeWebSocket.reset();
  const adapter = makeAdapter();
  const received = [];
  await adapter.subscribe(FIXTURE_SESSION.RUNNING, (frame) => received.push(frame));

  await waitFor(() => FakeWebSocket.instances.length >= 1);
  const socket = FakeWebSocket.latest;
  socket.simulateOpen();
  await waitFor(() => socket.sentFrames.length >= 1);

  socket.emitMessage(loadFixture('follow.assistant-end.json').abandonedVariant.muxFrame);
  await waitFor(() => received.length >= 1);

  assert.equal(received[0].kind, SUBSCRIPTION_FRAME.ASSISTANT_END);
  assert.equal(received[0].assistantFrame.outcome.kind, 'abandoned');

  await adapter.close();
});

test('unsubscribe cancels only its own logical stream', async () => {
  FakeWebSocket.reset();
  const adapter = makeAdapter();
  const first = [];
  const second = [];

  const handleA = await adapter.subscribe(FIXTURE_SESSION.RUNNING, (frame) => first.push(frame));
  const handleB = await adapter.subscribe(FIXTURE_SESSION.IDLE, (frame) => second.push(frame));

  await waitFor(() => FakeWebSocket.instances.length >= 1);
  const socket = FakeWebSocket.latest;
  socket.simulateOpen();
  await waitFor(() => socket.sentFrames.length >= 2);

  const opens = socket.sentFrames.filter((frame) => frame.type === 'open');
  assert.equal(opens.length, 2, 'two subscriptions must open two logical streams');
  assert.equal(
    new Set(opens.map((frame) => frame.streamId)).size,
    2,
    'logical stream ids must be distinct',
  );

  await handleA.unsubscribe();

  const cancels = socket.sentFrames.filter((frame) => frame.type === 'cancel');
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].streamId, opens[0].streamId);
  assert.equal(socket.closeCalls, 0, 'the physical socket must stay open for the sibling');

  // The sibling stream is still live and still receives frames.
  const snapshot = loadFixture('follow.snapshot.json').muxFrame;
  socket.emitMessage({ ...snapshot, streamId: opens[1].streamId });
  await waitFor(() => second.length >= 1);
  assert.equal(second[0].kind, SUBSCRIPTION_FRAME.SNAPSHOT);

  await handleB.unsubscribe();
  await adapter.close();
});

test('unsubscribe does not cancel the session Agent task', async () => {
  FakeWebSocket.reset();
  const calls = [];
  const fake = new FakeFetch({
    '/api/session/cancel': (record) => {
      calls.push(record);
      return { status: 200, body: { type: 'server-response', rpcId: record.body.rpcId, result: { ok: true, value: { accepted: true } } } };
    },
  });
  const rpcClient = new DshRpcClient({
    authority: FIXTURE_AUTHORITY,
    authProvider: new FixtureAuthProvider(),
    fetchImpl: fake.fetch,
    WebSocketImpl: FakeWebSocket,
  });
  const adapter = new DshAdapter({
    rpcClient,
    versionGuard: staticVersionGuard('0.1.5-rc.2'),
    authProvider: new FixtureAuthProvider(),
  });

  const handle = await adapter.subscribe(FIXTURE_SESSION.RUNNING, () => {});
  await waitFor(() => FakeWebSocket.instances.length >= 1);
  FakeWebSocket.latest.simulateOpen();
  await waitFor(() => FakeWebSocket.latest.sentFrames.length >= 1);

  await handle.unsubscribe();

  assert.equal(calls.length, 0, 'unsubscribing a stream must never call session/cancel');
  await adapter.close();
});

test('an external abort signal ends the subscription cleanly without an error frame', async () => {
  FakeWebSocket.reset();
  const adapter = makeAdapter();
  const received = [];
  const controller = new AbortController();

  await adapter.subscribe(FIXTURE_SESSION.RUNNING, (frame) => received.push(frame), {
    signal: controller.signal,
  });

  await waitFor(() => FakeWebSocket.instances.length >= 1);
  const socket = FakeWebSocket.latest;
  socket.simulateOpen();
  await waitFor(() => socket.sentFrames.length >= 1);

  controller.abort();
  await waitFor(() => socket.sentFrames.some((frame) => frame.type === 'cancel'));

  // A caller-requested abort is a normal end, not a session failure.
  assert.equal(
    received.some((frame) => frame.kind === SUBSCRIPTION_FRAME.ERROR),
    false,
    'a caller abort must not surface as a session error',
  );

  await adapter.close();
});

test('a reconnect delivers a fresh opening snapshot', async () => {
  FakeWebSocket.reset();
  const adapter = makeAdapter();

  const firstRun = [];
  const handleA = await adapter.subscribe(FIXTURE_SESSION.RUNNING, (frame) => firstRun.push(frame));
  await waitFor(() => FakeWebSocket.instances.length >= 1);
  const socketA = FakeWebSocket.latest;
  socketA.simulateOpen();
  await waitFor(() => socketA.sentFrames.length >= 1);

  socketA.emitMessage(loadFixture('follow.snapshot.json').muxFrame);
  await waitFor(() => firstRun.length >= 1);
  assert.equal(handleA.cursor(), 42);

  // Transport dies mid-conversation.
  socketA.simulateClose();
  await waitFor(() => firstRun.some((frame) => frame.kind === SUBSCRIPTION_FRAME.ERROR));

  // A new subscription is a new logical stream and re-opens with a snapshot.
  const secondRun = [];
  await adapter.subscribe(FIXTURE_SESSION.RUNNING, (frame) => secondRun.push(frame));
  await waitFor(() => FakeWebSocket.instances.length >= 2);
  const socketB = FakeWebSocket.instances[1];
  assert.notEqual(socketB, socketA, 'a reconnect must build a new physical socket');
  socketB.simulateOpen();
  await waitFor(() => socketB.sentFrames.length >= 1);

  // A `streamId` is per physical socket, so the fixture frame must be re-keyed to
  // the new logical stream rather than replayed with its original id.
  const rekeyed = { ...loadFixture('follow.snapshot.json').muxFrame };
  rekeyed.streamId = socketB.sentFrames[0].streamId;
  socketB.emitMessage(rekeyed);
  await waitFor(
    () => secondRun.length >= 1,
    2000,
    () => `secondRun=${secondRun.map((f) => f.kind).join(',') || 'none'}`,
  );

  assert.equal(secondRun[0].kind, SUBSCRIPTION_FRAME.SNAPSHOT);
  assert.equal(secondRun[0].frame.cursor, 42);
  assert.equal(socketB.sentFrames[0].endpoint, 'session/follow');

  await adapter.close();
});

test('a stream that ends terminates iteration instead of hanging', async () => {
  FakeWebSocket.reset();
  const rpcClient = makeRpc();
  const iterator = rpcClient.openStream({ endpoint: 'session/follow', args: {} })[Symbol.asyncIterator]();

  await waitFor(() => FakeWebSocket.instances.length >= 1);
  const socket = FakeWebSocket.latest;
  socket.simulateOpen();
  await waitFor(() => socket.sentFrames.length >= 1);

  const streamId = socket.sentFrames[0].streamId;
  socket.emitMessage(loadFixture('follow.event.json').muxFrame);
  socket.emitMessage({ type: 'end', streamId });

  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value.type, 'event');

  const second = await iterator.next();
  assert.equal(second.done, true);

  await rpcClient.close();
});

test('a stream error surfaces as an adapter error, not a silent end', async () => {
  FakeWebSocket.reset();
  const rpcClient = makeRpc();
  const iterator = rpcClient.openStream({ endpoint: 'session/follow', args: {} })[Symbol.asyncIterator]();

  await waitFor(() => FakeWebSocket.instances.length >= 1);
  const socket = FakeWebSocket.latest;
  socket.simulateOpen();
  await waitFor(() => socket.sentFrames.length >= 1);

  const streamId = socket.sentFrames[0].streamId;
  socket.emitMessage({
    type: 'error',
    streamId,
    error: { code: 'session/not-found', message: 'synthetic', details: {} },
  });

  await assert.rejects(
    () => iterator.next(),
    (error) => {
      assert.equal(error.code, ADAPTER_ERROR.SESSION_NOT_FOUND);
      return true;
    },
  );

  await rpcClient.close();
});

test('an invalid mux frame fails the stream visibly', async () => {
  FakeWebSocket.reset();
  const rpcClient = makeRpc();
  const iterator = rpcClient.openStream({ endpoint: 'session/follow', args: {} })[Symbol.asyncIterator]();

  await waitFor(() => FakeWebSocket.instances.length >= 1);
  const socket = FakeWebSocket.latest;
  socket.simulateOpen();
  await waitFor(() => socket.sentFrames.length >= 1);

  // Not valid JSON: must not be swallowed.
  socket.emitMessage('{not json');

  await assert.rejects(
    () => iterator.next(),
    (error) => error.code === ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
  );

  await rpcClient.close();
});
