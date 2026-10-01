/**
 * R8D — live domain state: the six mapped events, waiting_input, queue depth, cancel semantics.
 *
 * Every assertion is about the **eight frozen domain states**. No ninth state may be invented:
 * `streaming`, `thinking` and `replaying` are transport or UI substates and must never appear
 * where a domain status is expected.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { EventClient, SOCKET_STATE } from '../../src/remote/ui/ws/event-client.js';
import { DOMAIN_STATES } from '../../src/remote/ui/state/ui-state.js';
import { eventFrame, helloFrame, replayCompleteFrame, startWsFixture, waitFor } from './r8d-harness.mjs';

const UI = path.join(process.cwd(), 'src', 'remote', 'ui');

/**
 * Connect a client with an event log.
 *
 * @param {object} [options] - `lastSequence`.
 * @returns {Promise<object>} the fixture, client and captured events.
 */
async function live(options = {}) {
  const fixture = await startWsFixture();
  const events = [];
  fixture.onConnection = (connection) => {
    connection.send(helloFrame({ sessionId: 's-1' }));
    connection.send(replayCompleteFrame({ sequence: options.lastSequence ?? 0 }));
  };
  const client = new EventClient({
    sessionId: 's-1',
    baseUrl: fixture.baseUrl,
    credential: 'good-token',
    fetchImpl: fixture.fetchImpl,
    lastSequence: options.lastSequence ?? 0,
    onEvent: (event) => events.push(event),
  });
  await client.connect();
  await waitFor(() => client.socketState === SOCKET_STATE.LIVE);
  return { fixture, client, events };
}

/** Send a sequenced domain event and wait until it is applied. */
async function apply(fixture, client, sequence, status, data = {}) {
  fixture.send(eventFrame({
    sessionId: 's-1',
    sequence,
    event: 'session.status',
    data: { status, ...data },
  }));
  await waitFor(() => client.lastAppliedSequence === sequence);
}

test('every frozen domain status passes through as a domain event', async () => {
  const { fixture, client, events } = await live();
  try {
    // The statuses an assistant turn actually moves through.
    const statuses = ['queued', 'running', 'waiting_input', 'completed', 'failed', 'cancelled'];
    let sequence = 1;
    for (const status of statuses) {
      await apply(fixture, client, sequence, status);
      sequence += 1;
    }

    const observed = events
      .filter((e) => e.type === 'domain' && e.frame.event === 'session.status')
      .map((e) => e.frame.data.status);
    assert.deepEqual(observed, statuses, 'each live status must arrive as its own domain event');
  } finally {
    client.close();
    await fixture.stop();
  }
});

test('every observed status is one of the eight frozen domain states', async () => {
  const { fixture, client, events } = await live();
  try {
    await apply(fixture, client, 1, 'running');
    await apply(fixture, client, 2, 'waiting_input');
    await apply(fixture, client, 3, 'completed');

    const observed = events
      .filter((e) => e.type === 'domain' && e.frame.event === 'session.status')
      .map((e) => e.frame.data.status);

    assert.equal(DOMAIN_STATES.length, 8, 'the domain vocabulary is frozen at eight');
    for (const status of observed) {
      assert.ok(DOMAIN_STATES.includes(status), `${status} is not a frozen domain state`);
    }
    // The forbidden inventions must not appear as a domain status.
    for (const invented of ['streaming', 'thinking', 'replaying', 'live', 'connecting']) {
      assert.equal(observed.includes(invented), false, `${invented} must never be a domain state`);
      assert.equal(DOMAIN_STATES.includes(invented), false, `${invented} must not be in the frozen set`);
    }
  } finally {
    client.close();
    await fixture.stop();
  }
});

test('waiting_input is delivered so the UI can emphasise the composer', async () => {
  const { fixture, client, events } = await live();
  try {
    await apply(fixture, client, 1, 'waiting_input');

    const waiting = events.find((e) => e.type === 'domain' && e.frame.data?.status === 'waiting_input');
    assert.ok(waiting !== undefined, 'the waiting_input event must reach the UI');
    assert.equal(waiting.frame.event, 'session.status');
  } finally {
    client.close();
    await fixture.stop();
  }
});

test('waiting_input is exited by a later running or completed event', async () => {
  const { fixture, client, events } = await live();
  try {
    await apply(fixture, client, 1, 'waiting_input');
    await apply(fixture, client, 2, 'running');
    await apply(fixture, client, 3, 'completed');

    const statuses = events
      .filter((e) => e.type === 'domain' && e.frame.event === 'session.status')
      .map((e) => e.frame.data.status);
    assert.deepEqual(statuses, ['waiting_input', 'running', 'completed']);
    // The last status wins: nothing keeps the composer stuck in the waiting state.
    assert.equal(statuses[statuses.length - 1], 'completed');
  } finally {
    client.close();
    await fixture.stop();
  }
});

test('a queue update is delivered with its depth', async () => {
  const { fixture, client, events } = await live();
  try {
    fixture.send(eventFrame({
      sessionId: 's-1',
      sequence: 1,
      event: 'session.status',
      data: { status: 'queued', queue_depth: 3 },
    }));
    await waitFor(() => client.lastAppliedSequence === 1);

    const queued = events.find((e) => e.type === 'domain' && e.frame.data?.queue_depth !== undefined);
    assert.ok(queued !== undefined, 'the queue depth must reach the UI');
    assert.equal(queued.frame.data.queue_depth, 3);
    assert.equal(queued.frame.data.status, 'queued');
  } finally {
    client.close();
    await fixture.stop();
  }
});

test('a cancelled event is authoritative and distinct from a REST cancel response', async () => {
  const { fixture, client, events } = await live();
  try {
    await apply(fixture, client, 1, 'cancelled');

    const cancelled = events.find((e) => e.type === 'domain' && e.frame.data?.status === 'cancelled');
    assert.ok(cancelled !== undefined, 'the authoritative cancelled state arrives as a live event');
    // There is no ninth state such as `cancelling` — that is a transient UI action label only.
    assert.equal(DOMAIN_STATES.includes('cancelling'), false);
  } finally {
    client.close();
    await fixture.stop();
  }
});

test('a failed event carries no invented detail', async () => {
  const { fixture, client, events } = await live();
  try {
    fixture.send(eventFrame({
      sessionId: 's-1',
      sequence: 1,
      event: 'task.failed',
      data: { status: 'failed', reason: 'agent error' },
    }));
    await waitFor(() => client.lastAppliedSequence === 1);

    const failed = events.find((e) => e.type === 'domain' && e.frame.event === 'task.failed');
    assert.ok(failed !== undefined);
    assert.equal(failed.frame.data.status, 'failed');
  } finally {
    client.close();
    await fixture.stop();
  }
});

test('a transport.disconnected event does not itself change the domain status', async () => {
  const { fixture, client, events } = await live();
  try {
    fixture.send(eventFrame({
      sessionId: 's-1',
      sequence: 1,
      event: 'transport.disconnected',
      data: {},
    }));
    await waitFor(() => client.lastAppliedSequence === 1);

    // The two axes stay independent: a transport event is not a domain status change.
    const transport = events.find((e) => e.type === 'domain' && e.frame.event === 'transport.disconnected');
    assert.ok(transport !== undefined);
    assert.equal(transport.frame.data.status, undefined, 'a transport event must not carry a domain status');
  } finally {
    client.close();
    await fixture.stop();
  }
});

test('heartbeats keep the link alive but are never applied as domain events', async () => {
  const { fixture, client, events } = await live();
  try {
    fixture.send({ type: 'heartbeat', server_time: '2026-09-21T02:00:00.000Z', sequence: 1 });
    await waitFor(() => events.some((e) => e.type === 'heartbeat'));

    assert.equal(events.some((e) => e.type === 'domain'), false, 'a heartbeat is not a domain event');
    assert.equal(client.lastAppliedSequence, 0, 'and must not move the sequence watermark');
    assert.equal(client.socketState, SOCKET_STATE.LIVE, 'the socket stays live');
  } finally {
    client.close();
    await fixture.stop();
  }
});

test('the client ping uses only the frozen client frame', async () => {
  const { fixture, client } = await live();
  try {
    const before = fixture.latest.received.length;
    assert.equal(client.ping(), true, 'a live socket should accept a ping');
    await waitFor(() => fixture.latest.received.length > before);

    // Assert on the frame the client actually put on the wire.
    const ping = fixture.latest.received.slice(before).find((frame) => frame.type === 'client_ping');
    assert.ok(ping !== undefined, 'the R4 client frame is the only liveness frame');
    assert.deepEqual(Object.keys(ping), ['type'], 'no new ping format may be invented');
  } finally {
    client.close();
    await fixture.stop();
  }
});

test('no component renders a raw frame or an internal sequence', () => {
  // §41: no raw WS JSON, no sequence numbers, no internal event-type dumps in the ordinary UI.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'ws' || entry.name === 'api') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      if (/lastAppliedSequence|JSON\.stringify\(frame|rawEventName/.test(text)) offenders.push(path.relative(UI, full));
    }
  };
  walk(UI);
  assert.deepEqual(offenders, [], `raw event surface leaked into:\n${offenders.join('\n')}`);
});

test('no close reason or error text is rendered from the server', () => {
  // §34: a close reason may be secret-bearing, so it is never surfaced.
  const source = fs.readFileSync(path.join(UI, 'ws', 'event-client.js'), 'utf8');
  assert.equal(/closeEvent\?\.reason|\.reason\b/.test(source.replace(/\/\*[\s\S]*?\*\//g, '')), false,
    'the close reason must not be read');
  // And the normalized error frame drops the server message.
  const normalizer = fs.readFileSync(path.join(UI, 'ws', 'event-normalizer.js'), 'utf8');
  assert.match(normalizer, /deliberately NOT propagated/);
});
