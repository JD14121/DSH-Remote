/**
 * WebSocket integration test — Phase R4 §35, §53.
 *
 * Drives the exact scenario §53 specifies, end to end, over real sockets and real
 * REST calls:
 *
 * ```text
 * GET /sessions/:id          -> last_sequence = 10
 * WS connect last_sequence=10 -> hello -> replay_complete 0 -> LIVE
 * POST /messages             -> 202
 * Gateway emits 11..16
 * WS receives 11..16 in exact order
 * disconnect after processing 14
 * server emits 17, 18
 * reconnect last_sequence=14 -> replay 15..18 exactly once -> LIVE
 * ```
 *
 * It also verifies the cross-cutting claims: REST is the command channel and WS
 * is the event channel, no raw DSH frame leaks, no cross-session leak, and no
 * sequence-space confusion.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { startWsServer, request, SESSION, emitGatewayEvent, fixtureClock } from './r4-helpers.mjs';
import { FRAME } from '../../src/remote/ws/protocol.mjs';
import { GATEWAY_EVENT } from '../../src/remote/model/event.mjs';
import { verifyStrictOrder } from '../../src/remote/ws/replay.mjs';
import { SESSION_STATUS } from '../../src/remote/model/status.mjs';

/** The six events §53 lists, in order, starting at sequence 11. */
const SCENARIO_EVENTS = [
  [GATEWAY_EVENT.SESSION_STATUS, { status: SESSION_STATUS.RUNNING }],
  [GATEWAY_EVENT.ASSISTANT_START, { attempt_id: 'a1' }],
  [GATEWAY_EVENT.ASSISTANT_DELTA, { chunk: { text: 'hel' } }],
  [GATEWAY_EVENT.ASSISTANT_END, { attempt_id: 'a1' }],
  [GATEWAY_EVENT.MESSAGE_CREATED, { note: 'committed' }],
  [GATEWAY_EVENT.SESSION_STATUS, { status: SESSION_STATUS.COMPLETED }],
];

test('the §53 reconnect scenario delivers the exact sequence across a disconnect', async () => {
  const h = await startWsServer();
  try {
    // ── Build the documented starting point: sequences 1..10 exist. ────────────
    for (let index = 0; index < 10; index += 1) {
      emitGatewayEvent(h, SESSION, GATEWAY_EVENT.TASK_PROGRESS, { step: index });
    }

    // 1. REST snapshot: the client learns the watermark.
    const detail = await request(h.baseUrl, `/api/v1/sessions/${SESSION}`);
    assert.equal(detail.status, 200);
    const watermark = detail.body.data.last_sequence;
    assert.equal(watermark, 10, 'the REST view reports the Gateway sequence');

    // 2. Connect with that watermark.
    const first = await h.connect({ last_sequence: watermark });
    await first.waitForType(FRAME.REPLAY_COMPLETE);

    assert.equal(first.frames[0].type, FRAME.HELLO);
    const hello = first.ofType(FRAME.HELLO)[0];
    assert.equal(hello.replay.requested_from, watermark);
    assert.equal(hello.replay.mode, 'live_only', 'nothing is missing yet');
    assert.equal(first.ofType(FRAME.REPLAY_COMPLETE)[0].replayed, 0);
    assert.deepEqual(first.sequences(), [], 'no replay needed');

    // 3. Submit a prompt over REST — the command channel.
    const submit = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`, {
      method: 'POST',
      body: { content: 'integration scenario', client_message_id: 'ws-integration-1' },
    });
    assert.equal(submit.status, 202);
    assert.equal(h.adapter._state.sentMessages.at(-1).client_message_id, 'ws-integration-1');

    // 4. The Gateway emits 11..16.
    for (const [name, data] of SCENARIO_EVENTS) {
      emitGatewayEvent(h, SESSION, name, data);
    }
    await first.waitFor(() => first.sequences().length >= 6, 3000, 'six live events');

    // 5. Received in exact order.
    assert.deepEqual(first.sequences(), [11, 12, 13, 14, 15, 16], 'exact order, no gaps');
    assert.deepEqual(
      first.ofType(FRAME.EVENT).map((frame) => frame.event.event),
      SCENARIO_EVENTS.map(([name]) => name),
    );
    assert.deepEqual(
      verifyStrictOrder(first.sequences().map((sequence) => ({ sequence }))),
      { ok: true, reason: null },
    );

    // 6. Disconnect after processing 14.
    const processed = 14;
    assert.ok(first.sequences().includes(processed));
    await first.close();
    await new Promise((resolve) => setTimeout(resolve, 80));

    // 7. The server keeps producing: 17 and 18.
    emitGatewayEvent(h, SESSION, GATEWAY_EVENT.TASK_PROGRESS, { step: 17 });
    emitGatewayEvent(h, SESSION, GATEWAY_EVENT.TASK_PROGRESS, { step: 18 });

    // 8. Reconnect from 14.
    const second = await h.connect({ last_sequence: processed });
    await second.waitForType(FRAME.REPLAY_COMPLETE);

    // 9. Replay 15..18 exactly once.
    assert.deepEqual(second.sequences(), [15, 16, 17, 18], 'exactly the missed range, no duplicates');
    const complete = second.ofType(FRAME.REPLAY_COMPLETE)[0];
    assert.equal(complete.from_sequence, 15);
    assert.equal(complete.through_sequence, 18);
    assert.equal(complete.replayed, 4);
    assert.equal(second.ofType(FRAME.HELLO)[0].replay.mode, 'replay');

    // 10. And then goes live.
    emitGatewayEvent(h, SESSION, GATEWAY_EVENT.TASK_PROGRESS, { step: 19 });
    await second.waitFor(() => second.sequences().length >= 5, 3000, 'live event 19');
    assert.deepEqual(second.sequences(), [15, 16, 17, 18, 19], 'the seam is contiguous');

    await second.close();
  } finally {
    await h.close();
  }
});

test('REST is the command channel and WS is the event channel', async () => {
  const h = await startWsServer();
  try {
    // A prompt cannot be sent over the socket — that is a policy violation.
    const client = await h.connect({ session_id: SESSION });
    await client.waitForType(FRAME.REPLAY_COMPLETE);
    client.ws.send(JSON.stringify({ type: 'submit_prompt', content: 'nope' }));
    const close = await client.waitForClose();
    assert.equal(close.code, 4004, 'commands over the socket are refused');
    assert.equal(h.adapter._state.sentMessages.length, 0, 'nothing reached DSH');

    // The same intent works over REST.
    const submit = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`, {
      method: 'POST',
      body: { content: 'over REST', client_message_id: 'rest-channel-1' },
    });
    assert.equal(submit.status, 202);
    assert.equal(h.adapter._state.sentMessages.length, 1);
  } finally {
    await h.close();
  }
});

test('no raw DSH frame or internal object leaks onto the socket', async () => {
  const h = await startWsServer();
  try {
    const client = await h.connect({ session_id: SESSION });
    await client.waitForType(FRAME.REPLAY_COMPLETE);

    emitGatewayEvent(h, SESSION, GATEWAY_EVENT.MESSAGE_CREATED, { note: 'x' });
    await client.waitForType(FRAME.EVENT);

    const text = JSON.stringify(client.frames);
    for (const forbidden of [
      'SessionWireEvent', 'SessionFollowFrame', 'SessionControlFrame',
      'api-session/', 'session/follow', 'session/control', 'session/page',
      'dsh-auth', 'cookie', 'authorization', 'credentials', 'DSH_HOME',
      'muxFrame', 'attemptId', 'streamId', 'rpcId',
    ]) {
      assert.equal(text.includes(forbidden), false, `the socket must not carry ${forbidden}`);
    }
    await client.close();
  } finally {
    await h.close();
  }
});

test('two sockets on different sessions never cross', async () => {
  const h = await startWsServer();
  try {
    const a = await h.connect({ session_id: SESSION });
    const b = await h.connect({ session_id: 'session-00000000-0000-0000-0000-000000000002' });
    await a.waitForType(FRAME.REPLAY_COMPLETE);
    await b.waitForType(FRAME.REPLAY_COMPLETE);

    emitGatewayEvent(h, SESSION, GATEWAY_EVENT.SESSION_STATUS, { status: 'running' });
    await a.waitForType(FRAME.EVENT);
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(a.ofType(FRAME.EVENT).length, 1);
    assert.equal(b.ofType(FRAME.EVENT).length, 0, 'the other session received nothing');
    for (const frame of a.ofType(FRAME.EVENT)) {
      assert.equal(frame.event.session_id, SESSION);
    }
    await a.close();
    await b.close();
  } finally {
    await h.close();
  }
});

test('the REST watermark and the WS replay agree on one sequence space', async () => {
  const h = await startWsServer();
  try {
    for (let index = 0; index < 5; index += 1) {
      emitGatewayEvent(h, SESSION, GATEWAY_EVENT.TASK_PROGRESS, { index });
    }
    const detail = await request(h.baseUrl, `/api/v1/sessions/${SESSION}`);
    const watermark = detail.body.data.last_sequence;
    assert.equal(watermark, 5);

    const client = await h.connect({ last_sequence: watermark });
    await client.waitForType(FRAME.REPLAY_COMPLETE);
    assert.deepEqual(client.sequences(), [], 'the REST watermark is exactly current');

    // And a history page uses a different space entirely.
    const history = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`);
    assert.equal(history.body.page.sequence_kind, 'dsh_durable_source_sequence');
    assert.equal('last_sequence' in history.body.page, false);
    await client.close();
  } finally {
    await h.close();
  }
});

test('a heartbeat and the events share one socket without disturbing sequences', async () => {
  const h = await startWsServer();
  try {
    const client = await h.connect({ session_id: SESSION });
    await client.waitForType(FRAME.REPLAY_COMPLETE);

    for (let index = 0; index < 3; index += 1) {
      emitGatewayEvent(h, SESSION, GATEWAY_EVENT.TASK_PROGRESS, { index });
    }
    client.ws.send(JSON.stringify({ type: 'client_ping' }));

    await client.waitFor(() => client.ofType(FRAME.HEARTBEAT).length >= 1 && client.sequences().length >= 3, 3000, 'both');

    assert.deepEqual(client.sequences(), [1, 2, 3], 'control frames consume no sequence');
    assert.equal(h.eventsService.sequenceBounds(SESSION).latest, 3);
    await client.close();
  } finally {
    await h.close();
  }
});

test('a restart-like loss of the ring forces an explicit resync rather than silence', async () => {
  const h = await startWsServer();
  try {
    for (let index = 0; index < 4; index += 1) {
      emitGatewayEvent(h, SESSION, GATEWAY_EVENT.TASK_PROGRESS, { index });
    }
    const client = await h.connect({ last_sequence: 99 });
    const close = await client.waitForClose();

    assert.equal(close.code, 4001);
    assert.equal(client.ofType(FRAME.RESYNC_REQUIRED)[0].reason, 'sequence_ahead_of_server');
    // The documented recovery is a REST refresh, so the frame says exactly that.
    assert.equal(client.ofType(FRAME.RESYNC_REQUIRED)[0].action, 'refresh_rest_state');
    // And crucially it does not pretend the client is up to date.
    assert.equal(client.ofType(FRAME.REPLAY_COMPLETE).length, 0);
  } finally {
    await h.close();
  }
});

test('the fixture clock keeps the scenario deterministic', async () => {
  const h = await startWsServer();
  try {
    assert.equal(fixtureClock(), 1_789_800_000_000);
    const client = await h.connect({ session_id: SESSION });
    await client.waitForType(FRAME.REPLAY_COMPLETE);
    // `server_time` is derived from the injected clock, so it is reproducible.
    assert.equal(client.ofType(FRAME.HELLO)[0].server_time, new Date(1_789_800_000_000).toISOString());
    await client.close();
  } finally {
    await h.close();
  }
});

test('a full session lifecycle is observable over the socket', async () => {
  const h = await startWsServer();
  try {
    const client = await h.connect({ session_id: SESSION });
    await client.waitForType(FRAME.REPLAY_COMPLETE);

    // The fixture seeds this session as `running` and has already recorded the
    // RUN_STARTED rank. Install a fresh machine so the documented lifecycle can
    // start from idle — the rank guard would otherwise (correctly) refuse a
    // lower-ranked signal after a higher-ranked one.
    const { SessionStateMachine } = await import('../../src/remote/state/session-state-machine.mjs');
    h.store.machines.set(SESSION, new SessionStateMachine({ initialStatus: SESSION_STATUS.IDLE }));

    // Drive the real domain transitions, then emit the Gateway events they
    // produce. This mirrors what StatusService does: the machine decides the
    // status, and the service publishes the event.
    for (const signal of ['PROMPT_ACCEPTED_QUEUE', 'RUN_STARTED', 'RUN_COMMITTED']) {
      const transition = h.store.applySignal(SESSION, { signal, sessionId: SESSION });
      assert.equal(transition.outcome, 'applied', `${signal} should apply`);
      h.eventsService.emit({
        sessionId: SESSION,
        event: GATEWAY_EVENT.SESSION_STATUS,
        data: { status: transition.status },
      });
    }

    await client.waitFor(() => client.ofType(FRAME.EVENT).length >= 3, 3000, 'lifecycle events');

    const statuses = client.ofType(FRAME.EVENT)
      .filter((frame) => frame.event.event === GATEWAY_EVENT.SESSION_STATUS)
      .map((frame) => frame.event.data.status);
    assert.deepEqual(
      statuses,
      [SESSION_STATUS.QUEUED, SESSION_STATUS.RUNNING, SESSION_STATUS.COMPLETED],
      'the lifecycle is observable in order',
    );

    // The REST view agrees with what the socket delivered.
    const detail = await request(h.baseUrl, `/api/v1/sessions/${SESSION}`);
    assert.equal(detail.body.data.status, SESSION_STATUS.COMPLETED);
    assert.equal(detail.body.data.last_sequence, 3, 'the REST watermark matches the socket count');
    await client.close();
  } finally {
    await h.close();
  }
});
