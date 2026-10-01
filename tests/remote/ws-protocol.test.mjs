/**
 * WebSocket frame protocol tests — Phase R4 §7, §13-§18, §31, §34, §40.
 *
 * Validates the frame vocabulary itself: the opening sequence, control frames
 * consuming no Gateway sequence, client-frame policy, and the guarantee that
 * `event` frames carry **R2 Gateway Events** rather than a second vocabulary.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { startWsServer, SESSION, emitGatewayEvent } from './r4-helpers.mjs';
import {
  API_VERSION,
  CLIENT_FRAME,
  CONNECTION_STATE,
  FRAME,
  PROTOCOL,
  controlFrameTypes,
  errorFrame,
  eventFrame,
  heartbeatFrame,
  helloFrame,
  overflowFrame,
  replayCompleteFrame,
  resyncRequiredFrame,
  serverShutdownFrame,
} from '../../src/remote/ws/protocol.mjs';
import { APP_CLOSE, STANDARD_CLOSE, closeCodeTable, isApplicationCloseCode } from '../../src/remote/ws/close-codes.mjs';
import { ALL_GATEWAY_EVENTS, GATEWAY_EVENT } from '../../src/remote/model/event.mjs';

test('hello is the first frame and describes the session honestly', async () => {
  const h = await startWsServer();
  try {
    const client = await h.connect();
    await client.waitForType(FRAME.HELLO);
    const hello = client.ofType(FRAME.HELLO)[0];

    assert.equal(client.frames[0].type, FRAME.HELLO, 'hello must be first');
    assert.equal(hello.api_version, API_VERSION);
    assert.equal(hello.protocol, PROTOCOL);
    assert.equal(hello.session_id, SESSION);
    assert.equal(typeof hello.connection_id, 'string');
    assert.equal(typeof hello.server_time, 'string');
    assert.deepEqual(Object.keys(hello.sequence).sort(), ['earliest_available', 'latest']);
    assert.deepEqual(Object.keys(hello.replay).sort(), ['mode', 'requested_from']);
    assert.equal(hello.replay.requested_from, null);
    assert.equal(hello.replay.mode, 'live_only');
    await client.close();
  } finally {
    await h.close();
  }
});

test('the hello/replay_complete/live sequence is ordered exactly as specified', async () => {
  const h = await startWsServer();
  try {
    const client = await h.connect();
    await client.waitForType(FRAME.REPLAY_COMPLETE);
    assert.deepEqual(client.frames.slice(0, 2).map((frame) => frame.type), [FRAME.HELLO, FRAME.REPLAY_COMPLETE]);
    assert.equal(client.ofType(FRAME.REPLAY_COMPLETE)[0].replayed, 0);
    await client.close();
  } finally {
    await h.close();
  }
});

test('an event frame carries the R2 Gateway Event verbatim', async () => {
  const h = await startWsServer();
  try {
    const client = await h.connect();
    await client.waitForType(FRAME.REPLAY_COMPLETE);

    const emitted = emitGatewayEvent(h, SESSION, GATEWAY_EVENT.ASSISTANT_DELTA, { chunk: { opaque: true } });
    await client.waitForType(FRAME.EVENT);

    const frame = client.ofType(FRAME.EVENT)[0];
    // Byte-for-byte the domain event: no re-shaping, no second vocabulary (§15).
    assert.deepEqual(frame.event, JSON.parse(JSON.stringify(emitted)));
    assert.equal(frame.event.sequence, emitted.sequence);
    assert.equal(frame.event.event, 'assistant.delta');
    assert.equal(frame.event.session_id, SESSION);
    await client.close();
  } finally {
    await h.close();
  }
});

test('control frames consume no Gateway sequence', async () => {
  const h = await startWsServer();
  try {
    const client = await h.connect();
    await client.waitForType(FRAME.REPLAY_COMPLETE);

    const before = h.eventsService.sequenceBounds(SESSION).highWater ?? 0;
    emitGatewayEvent(h, SESSION, GATEWAY_EVENT.SESSION_STATUS, { status: 'running' });
    await client.waitForType(FRAME.EVENT);
    const after = h.eventsService.sequenceBounds(SESSION).highWater;

    assert.equal(after, before + 1, 'only the one data event consumed a sequence');
    // The sequences actually delivered are exactly 1..N with no gaps introduced by
    // hello/heartbeat/replay_complete.
    assert.deepEqual(client.sequences(), [before + 1]);
    await client.close();
  } finally {
    await h.close();
  }
});

test('replay_complete reports the replayed range and consumes nothing', async () => {
  const h = await startWsServer();
  try {
    // Three events exist before the client connects.
    for (let index = 0; index < 3; index += 1) {
      emitGatewayEvent(h, SESSION, GATEWAY_EVENT.SESSION_STATUS, { status: 'running' });
    }

    const client = await h.connect({ last_sequence: 0 });
    await client.waitForType(FRAME.REPLAY_COMPLETE);
    const complete = client.ofType(FRAME.REPLAY_COMPLETE)[0];

    assert.equal(complete.from_sequence, 1);
    assert.equal(complete.through_sequence, 3);
    assert.equal(complete.replayed, 3);
    assert.equal(complete.session_id, SESSION);
    assert.deepEqual(client.sequences(), [1, 2, 3]);
    await client.close();
  } finally {
    await h.close();
  }
});

test('a client_ping is accepted and answered without a second command channel', async () => {
  const h = await startWsServer();
  try {
    const client = await h.connect();
    await client.waitForType(FRAME.REPLAY_COMPLETE);

    client.ws.send(JSON.stringify({ type: CLIENT_FRAME.PING }));
    // The reply is an application heartbeat, not a new frame type.
    await client.waitForType(FRAME.HEARTBEAT);
    assert.equal(client.ofType(FRAME.HEARTBEAT).length >= 1, true);
    await client.close();
  } finally {
    await h.close();
  }
});

test('any other client frame is refused with 4004 and an error frame', async () => {
  const h = await startWsServer();
  try {
    const client = await h.connect();
    await client.waitForType(FRAME.REPLAY_COMPLETE);

    client.ws.send(JSON.stringify({ type: 'submit_prompt', content: 'should not work' }));
    const close = await client.waitForClose();

    assert.equal(close.code, APP_CLOSE.CLIENT_MESSAGE_NOT_ALLOWED);
    assert.equal(close.reason, 'CLIENT_MESSAGE_NOT_ALLOWED');
    const errors = client.ofType(FRAME.ERROR);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].error.code, 'CLIENT_MESSAGE_NOT_ALLOWED');
    assert.equal(errors[0].error.retryable, false);
    assert.equal(typeof errors[0].error.connection_id, 'string');
  } finally {
    await h.close();
  }
});

test('malformed client JSON is refused rather than ignored', async () => {
  const h = await startWsServer();
  try {
    const client = await h.connect();
    await client.waitForType(FRAME.REPLAY_COMPLETE);
    client.ws.send('not json at all');
    const close = await client.waitForClose();
    assert.equal(close.code, APP_CLOSE.CLIENT_MESSAGE_NOT_ALLOWED);
  } finally {
    await h.close();
  }
});

test('a server_shutdown frame is followed by close 1001', async () => {
  const h = await startWsServer();
  try {
    const client = await h.connect();
    await client.waitForType(FRAME.REPLAY_COMPLETE);

    // Trigger through the documented shutdown path, not a raw socket close.
    await h.server.stop();

    const close = await client.waitForClose();
    assert.equal(close.code, STANDARD_CLOSE.GOING_AWAY);
    const shutdown = client.ofType(FRAME.SERVER_SHUTDOWN);
    assert.equal(shutdown.length, 1);
    assert.equal(shutdown[0].retryable, true);
  } finally {
    await h.close();
  }
});

test('every frame builder produces the documented shape', () => {
  assert.deepEqual(helloFrame({
    connectionId: 'c1', sessionId: 's', serverTime: 't', latest: 1, earliestAvailable: 1, requestedFrom: null, mode: 'live_only',
  }), {
    type: 'hello',
    api_version: 1,
    protocol: 'dsh-remote-v1',
    connection_id: 'c1',
    session_id: 's',
    server_time: 't',
    sequence: { latest: 1, earliest_available: 1 },
    replay: { requested_from: null, mode: 'live_only' },
  });

  const event = { sequence: 5, event: 'unknown', session_id: 's' };
  assert.deepEqual(eventFrame(event), { type: 'event', event });

  assert.deepEqual(heartbeatFrame({ serverTime: 't', sessionId: 's', latestSequence: 3 }), {
    type: 'heartbeat', server_time: 't', session_id: 's', latest_sequence: 3,
  });

  assert.deepEqual(replayCompleteFrame({ sessionId: 's', fromSequence: 1, throughSequence: 2, replayed: 2 }), {
    type: 'replay_complete', session_id: 's', from_sequence: 1, through_sequence: 2, replayed: 2,
  });

  assert.deepEqual(resyncRequiredFrame({
    sessionId: 's', reason: 'gap_not_available', requestedSequence: 1, earliestAvailable: 5, latestAvailable: 9,
  }), {
    type: 'resync_required',
    session_id: 's',
    reason: 'gap_not_available',
    requested_sequence: 1,
    earliest_available: 5,
    latest_available: 9,
    action: 'refresh_rest_state',
  });

  assert.deepEqual(overflowFrame({ sessionId: 's', lastDeliveredSequence: 3, latestSequence: 9 }), {
    type: 'overflow',
    session_id: 's',
    last_delivered_sequence: 3,
    latest_sequence: 9,
    action: 'reconnect_with_last_sequence',
  });

  assert.deepEqual(errorFrame({ code: 'X', message: 'm', connectionId: 'c1' }), {
    type: 'error',
    error: { code: 'X', message: 'm', retryable: false, connection_id: 'c1' },
  });

  assert.deepEqual(serverShutdownFrame(), { type: 'server_shutdown', retryable: true });
});

test('an error frame never carries a secret or internal field', () => {
  const frame = errorFrame({
    code: 'INTERNAL_ERROR',
    message: 'An internal error occurred.',
    connectionId: 'c1',
  });
  assert.deepEqual(Object.keys(frame.error).sort(), ['code', 'connection_id', 'message', 'retryable']);
  const text = JSON.stringify(frame).toLowerCase();
  for (const forbidden of ['stack', 'cause', 'cookie', 'token', 'authorization', 'credentials', 'dsh_home', ':\\']) {
    assert.equal(text.includes(forbidden), false, `error frame must not contain ${forbidden}`);
  }
});

test('the close-code table is complete and application codes are in range', () => {
  const table = closeCodeTable();
  assert.equal(table.length, 10);

  const codes = table.map((row) => row.code);
  for (const expected of [1000, 1001, 1002, 1008, 1011, 1013, 4001, 4002, 4003, 4004]) {
    assert.ok(codes.includes(expected), `missing close code ${expected}`);
  }
  for (const row of table) {
    assert.equal(typeof row.reason, 'string');
    assert.ok(row.meaning.length > 10, `code ${row.code} needs a real meaning`);
    if (row.kind === 'application') assert.equal(isApplicationCloseCode(row.code), true);
    if (row.kind === 'standard') assert.equal(isApplicationCloseCode(row.code), false);
  }
  assert.equal(isApplicationCloseCode(2999), false);
  assert.equal(isApplicationCloseCode(3000), true);
  assert.equal(isApplicationCloseCode(4999), true);
  assert.equal(isApplicationCloseCode(5000), false);
});

test('the protocol layer defines no second event vocabulary', () => {
  // §15: every event name on the wire must be an R2 Gateway event name.
  const control = controlFrameTypes();
  for (const name of control) {
    assert.equal(
      ALL_GATEWAY_EVENTS.includes(name),
      false,
      `${name} is a control frame and must not be an event name`,
    );
  }
  assert.equal(control.includes(FRAME.EVENT), false, 'event is the data frame, not a control frame');
  assert.equal(new Set(control).size, control.length);
});

test('the connection state vocabulary matches the specification', () => {
  assert.deepEqual(Object.values(CONNECTION_STATE), [
    'UPGRADING', 'CONNECTED', 'REPLAYING', 'LIVE', 'CLOSING', 'CLOSED',
  ]);
});

test('heartbeat and replay frames do not disturb the session status', async () => {
  // §38: liveness traffic and the phone transport are not domain state.
  const h = await startWsServer();
  try {
    h.statusService.events.store.applySignal(SESSION, { signal: 'RUN_STARTED', sessionId: SESSION });
    const before = h.statusService.getSession(SESSION).status;

    const client = await h.connect();
    await client.waitForType(FRAME.REPLAY_COMPLETE);
    client.ws.send(JSON.stringify({ type: CLIENT_FRAME.PING }));
    await client.waitForType(FRAME.HEARTBEAT);

    assert.equal(h.statusService.getSession(SESSION).status, before, 'liveness must not change status');
    await client.close();
  } finally {
    await h.close();
  }
});
