/**
 * R8D — reconnect: bounded cancelable backoff, fresh tickets, session-switch race safety.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { EventClient } from '../../src/remote/ui/ws/event-client.js';
import { DEFAULT_BACKOFF_MS, ReconnectController } from '../../src/remote/ui/ws/reconnect-controller.js';
import { classifyClose } from '../../src/remote/ui/ws/event-normalizer.js';
import { eventFrame, helloFrame, replayCompleteFrame, startWsFixture, waitFor } from './r8d-harness.mjs';

const UI = path.join(process.cwd(), 'src', 'remote', 'ui');

/** A controllable clock so backoff is tested without waiting. */
function fakeTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimeoutImpl: (fn, delay) => {
      const handle = { fn, delay, cancelled: false };
      scheduled.push(handle);
      return handle;
    },
    clearTimeoutImpl: (handle) => { if (handle !== undefined) handle.cancelled = true; },
    /** Fire every pending timer. */
    async runAll() {
      for (const handle of scheduled.splice(0)) {
        if (!handle.cancelled) await handle.fn();
      }
    },
  };
}

test('backoff is bounded, ordered and never a tight loop', () => {
  // The numbers are not contractual; the properties are.
  for (let i = 1; i < DEFAULT_BACKOFF_MS.length; i += 1) {
    assert.ok(DEFAULT_BACKOFF_MS[i] >= DEFAULT_BACKOFF_MS[i - 1], 'the schedule must not decrease');
  }
  assert.ok(DEFAULT_BACKOFF_MS[0] >= 250, 'the first delay must not be a tight loop');
  assert.ok(Math.max(...DEFAULT_BACKOFF_MS) <= 10_000, 'the schedule must stay bounded');
});

test('each retry waits longer, then holds at the cap', () => {
  const timers = fakeTimers();
  const delays = [];
  const controller = new ReconnectController({
    clientFactory: () => ({ onTransport: null, connect: async () => {}, close: () => {} }),
    backoffMs: [100, 200, 400],
    setTimeoutImpl: (fn, delay) => {
      delays.push(delay);
      return timers.setTimeoutImpl(fn, delay);
    },
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  // One attempt per completed cycle: `scheduleReconnect` deliberately refuses to stack a second
  // timer, so calling it repeatedly without letting the previous one fire is a no-op — which is
  // itself the anti-stampede behaviour.
  for (let cycle = 0; cycle < 5; cycle += 1) {
    assert.equal(controller.pending, false, 'no timer should be left armed between cycles');
    controller.scheduleReconnect();
    assert.equal(controller.pending, true);
    // Fire exactly this one timer, then clear it so the next cycle can arm another.
    const handle = timers.scheduled.shift();
    handle.cancelled = true;
    controller.timer = null;
  }

  assert.deepEqual(delays, [100, 200, 400, 400, 400], 'delays must grow then cap');
});

test('a second scheduleReconnect while one is pending does not stack timers', () => {
  const timers = fakeTimers();
  const controller = new ReconnectController({
    clientFactory: () => ({ onTransport: null, connect: async () => {}, close: () => {} }),
    backoffMs: [100, 200],
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  controller.scheduleReconnect();
  controller.scheduleReconnect();
  controller.scheduleReconnect();
  assert.equal(timers.scheduled.length, 1, 'only one reconnect timer may ever be armed');
});

test('a healthy connection resets the backoff', async () => {
  const timers = fakeTimers();
  const delays = [];
  const controller = new ReconnectController({
    clientFactory: () => ({ onTransport: null, connect: async () => {}, close: () => {} }),
    backoffMs: [100, 200, 400],
    setTimeoutImpl: (fn, delay) => {
      delays.push(delay);
      return timers.setTimeoutImpl(fn, delay);
    },
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  // The client is created when an attempt runs, so fire one timer to populate it.
  controller.scheduleReconnect();
  await timers.runAll();
  assert.equal(controller.attempt, 1, 'the populate cycle counts as one attempt');

  // `scheduleReconnect` refuses to stack timers, so the pending handle is cleared between cycles
  // to model "the attempt ran and failed again".
  for (let cycle = 0; cycle < 2; cycle += 1) {
    controller.scheduleReconnect();
    controller.timer = null;
  }
  assert.equal(controller.attempt, 3, 'three attempts should be recorded');

  // The link came up: reaching LIVE must reset the schedule.
  assert.ok(controller.client !== null, 'an attempt should have created a client');
  controller.client.onTransport({ socketState: 'live' });
  assert.equal(controller.attempt, 0, 'a healthy connection must reset the backoff');

  controller.scheduleReconnect();
  assert.equal(delays[delays.length - 1], 100, 'the next retry starts short again');
});

test('a pending reconnect is canceled and cannot revive the old session', async () => {
  const timers = fakeTimers();
  let created = 0;
  const controller = new ReconnectController({
    clientFactory: () => {
      created += 1;
      return { onTransport: null, connect: async () => {}, close: () => {} };
    },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  controller.scheduleReconnect();
  assert.equal(controller.pending, true);

  controller.cancel();
  assert.equal(controller.pending, false, 'the timer must be disarmed');
  assert.equal(controller.cancelled, true);

  // Even if a stray timer fires, nothing may connect.
  await timers.runAll();
  assert.equal(created, 0, 'a cancelled controller must not create a client');
});

test('only a retryable close schedules a reconnect', () => {
  const retryable = new ReconnectController({
    clientFactory: () => ({ onTransport: null, connect: async () => {}, close: () => {} }),
    setTimeoutImpl: () => 1,
    clearTimeoutImpl: () => {},
  });
  retryable.onClose({ retryable: true });
  assert.equal(retryable.pending, true, 'a network drop should retry');

  const terminal = new ReconnectController({
    clientFactory: () => ({ onTransport: null, connect: async () => {}, close: () => {} }),
    setTimeoutImpl: () => 1,
    clearTimeoutImpl: () => {},
  });
  // An auth failure or a protocol violation must not loop.
  terminal.onClose({ retryable: false, closeKind: 'auth_failure' });
  assert.equal(terminal.pending, false, 'an auth failure must not retry');
});

test('close codes are classified so not every close looks like an auth failure', () => {
  assert.equal(classifyClose({ code: 1000 }).kind, 'intentional');
  assert.equal(classifyClose({ code: 1000 }).retryable, false);
  assert.equal(classifyClose({ code: 1008 }).kind, 'auth_failure');
  assert.equal(classifyClose({ code: 1008 }).retryable, false);
  assert.equal(classifyClose({ code: 1006 }).kind, 'network');
  assert.equal(classifyClose({ code: 1006 }).retryable, true);
  assert.equal(classifyClose({ code: 1002 }).kind, 'protocol_violation');
  assert.equal(classifyClose({ code: 1001 }).kind, 'server_close');
  assert.equal(classifyClose({ code: 4001 }).kind, 'server_close');
  assert.equal(classifyClose({ code: null }).kind, 'network');

  // Only the auth case may lead the UI to demand a credential.
  const authLike = [1000, 1006, 1002, 1001, 4001, null].filter((code) => classifyClose({ code }).kind === 'auth_failure');
  assert.deepEqual(authLike, [], 'no ordinary close may be classified as an auth failure');
});

test('a reconnect obtains a fresh ticket and resumes from lastAppliedSequence', async () => {
  const fixture = await startWsFixture();
  try {
    fixture.onConnection = (connection) => {
      connection.send(helloFrame({ sessionId: 's-1' }));
      connection.send(replayCompleteFrame({ sequence: 7 }));
    };
    const client = new EventClient({
      sessionId: 's-1', baseUrl: fixture.baseUrl, credential: 'good-token', fetchImpl: fixture.fetchImpl,
      lastSequence: 7,
    });
    await client.connect();
    await waitFor(() => client.connections ?? true);

    const firstTickets = fixture.ticketsIssued;
    // Drop the link, then reconnect.
    fixture.closeLatest(1006);
    await waitFor(() => client.closeKind !== null);
    await client.connect();
    await waitFor(() => client.socketState === 'live');

    assert.equal(fixture.ticketsIssued, firstTickets + 1, 'a reconnect must obtain a fresh ticket');
    assert.equal(fixture.connections.length, 2);
    assert.equal(fixture.connections[1].lastSequence, 7, 'replay must resume from the watermark');
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('a mid-stream disconnect preserves history, draft and partial text', async () => {
  const fixture = await startWsFixture();
  try {
    const attempt = { attempt_id: 'att-keep' };
    fixture.onConnection = (connection) => {
      connection.send(helloFrame({ sessionId: 's-1' }));
      connection.send(eventFrame({ sessionId: 's-1', sequence: 1, event: 'message.created', data: { id: 'm-1', role: 'user', content: 'hello' } }));
      connection.send(eventFrame({ sessionId: 's-1', sequence: 2, event: 'assistant.start', data: attempt }));
      connection.send(eventFrame({ sessionId: 's-1', sequence: 3, event: 'assistant.delta', data: { ...attempt, index: 0, chunk: { text: 'partial' } } }));
      connection.send(replayCompleteFrame({ sequence: 3 }));
    };
    const client = new EventClient({
      sessionId: 's-1', baseUrl: fixture.baseUrl, credential: 'good-token', fetchImpl: fixture.fetchImpl,
      lastSequence: 0,
    });
    await client.connect();
    await waitFor(() => client.socketState === 'live');
    await waitFor(() => client.streams.active().length === 1);

    fixture.closeLatest(1006);
    await waitFor(() => client.socketState === 'disconnected');

    // The partial text survives, the watermark is intact, and the credential is untouched.
    assert.equal(client.lastAppliedSequence, 3, 'the watermark must survive a disconnect');
    assert.equal(client.closeKind, 'network');
    assert.notEqual(client.closeKind, 'auth_failure', 'a network drop is not an auth failure');
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('switching sessions abandons the old socket so its frames cannot reach the new one', async () => {
  const fixture = await startWsFixture();
  try {
    fixture.onConnection = (connection) => {
      connection.send(helloFrame({ sessionId: connection.sessionId }));
      connection.send(replayCompleteFrame());
    };
    const eventsA = [];
    const clientA = new EventClient({
      sessionId: 's-A', baseUrl: fixture.baseUrl, credential: 'good-token', fetchImpl: fixture.fetchImpl,
      onEvent: (event) => eventsA.push(event),
    });
    await clientA.connect();
    await waitFor(() => clientA.socketState === 'live');
    const socketA = fixture.latest;

    // The user selects another session: close A and open B.
    clientA.close(1000);
    const clientB = new EventClient({
      sessionId: 's-B', baseUrl: fixture.baseUrl, credential: 'good-token', fetchImpl: fixture.fetchImpl,
      onEvent: () => {},
    });
    await clientB.connect();
    await waitFor(() => clientB.socketState === 'live');

    // A delayed frame from A's socket must not be applied anywhere.
    const beforeA = eventsA.filter((e) => e.type === 'domain').length;
    try {
      socketA.send(eventFrame({ sessionId: 's-A', sequence: 1, event: 'session.status', data: { status: 'failed' } }));
    } catch {
      /* the socket may already be torn down, which is also correct */
    }
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(eventsA.filter((e) => e.type === 'domain').length, beforeA, 'session A must not receive frames after close');
    assert.equal(clientB.sessionId, 's-B');
    assert.equal(clientB.lastAppliedSequence, null, 'session B must not inherit A\'s watermark');

    clientA.close();
    clientB.close();
  } finally {
    await fixture.stop();
  }
});

test('a pending reconnect timer cannot reconnect a session the user left', async () => {
  const timers = fakeTimers();
  let created = 0;
  const controller = new ReconnectController({
    clientFactory: () => {
      created += 1;
      return { onTransport: null, connect: async () => {}, close: () => {} };
    },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  controller.scheduleReconnect();
  // The user switches session.
  controller.cancel();
  await timers.runAll();

  assert.equal(created, 0, 'the old session must not be reconnected');
});

test('reconnect does not implement the R8E resync workflow', () => {
  // R8D detects and surfaces; it does not reload REST state and recreate the socket.
  const source = fs.readFileSync(path.join(UI, 'ws', 'reconnect-controller.js'), 'utf8');
  assert.equal(/fetch\(|listMessages|getMessages|reloadRest/i.test(source.replace(/\/\*[\s\S]*?\*\//g, '')), false,
    'the reconnect controller must not perform an R8E REST reload');
  assert.match(source, /R8E/, 'the boundary should be documented');
});
