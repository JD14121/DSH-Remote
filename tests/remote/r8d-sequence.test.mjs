/**
 * R8D — sequence discipline: duplicates, gaps, ordering, and where `last_sequence` comes from.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { EventClient, SOCKET_STATE } from '../../src/remote/ui/ws/event-client.js';
import { eventFrame, helloFrame, replayCompleteFrame, startWsFixture, waitFor } from './r8d-harness.mjs';

/** Connect a client and hand the harness the connection. */
async function connected(options = {}) {
  const fixture = await startWsFixture();
  const events = [];
  const gaps = [];
  const client = new EventClient({
    sessionId: 's-1',
    baseUrl: fixture.baseUrl,
    credential: 'good-token',
    fetchImpl: fixture.fetchImpl,
    lastSequence: options.lastSequence ?? null,
    onEvent: (event) => events.push(event),
    onGap: (gap) => gaps.push(gap),
  });
  // The script must be installed BEFORE connecting, or the server greets a socket whose
  // handler does not exist yet and the handshake never completes.
  fixture.onConnection = (connection) => {
    connection.send(helloFrame({ sessionId: 's-1' }));
    if (options.replayComplete !== false) connection.send(replayCompleteFrame({ sequence: options.latest ?? 0 }));
  };
  await client.connect();
  await waitFor(() => client.socketState === SOCKET_STATE.LIVE);
  return { fixture, client, events, gaps };
}

test('lastAppliedSequence is seeded from the REST snapshot, not invented', async () => {
  const { fixture, client } = await connected({ lastSequence: 40 });
  try {
    assert.equal(client.lastAppliedSequence, 40, 'the seed must come from the caller');
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('the seed is sent to the server as last_sequence', async () => {
  const { fixture, client } = await connected({ lastSequence: 12 });
  try {
    assert.equal(fixture.connections[0].lastSequence, 12, 'replay must resume from the seed');
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('a duplicate sequence is ignored silently', async () => {
  const { fixture, client, events } = await connected({ lastSequence: 5 });
  try {
    fixture.send(eventFrame({ sessionId: 's-1', sequence: 6, event: 'session.status', data: { status: 'running' } }));
    await waitFor(() => client.lastAppliedSequence === 6);

    const before = events.filter((e) => e.type === 'domain').length;
    // Replay re-sends the same event.
    fixture.send(eventFrame({ sessionId: 's-1', sequence: 6, event: 'session.status', data: { status: 'running' } }));
    await waitFor(() => events.some((e) => e.type === 'duplicate'));

    assert.equal(events.filter((e) => e.type === 'domain').length, before, 'a duplicate must not be applied again');
    assert.equal(client.lastAppliedSequence, 6, 'and must not move the watermark');
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('an older sequence (seq <= lastApplied) is ignored', async () => {
  const { fixture, client, events } = await connected({ lastSequence: 10 });
  try {
    fixture.send(eventFrame({ sessionId: 's-1', sequence: 9, event: 'session.status', data: { status: 'failed' } }));
    await waitFor(() => events.some((e) => e.type === 'duplicate'));
    assert.equal(client.lastAppliedSequence, 10, 'the watermark must never rewind');
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('a contiguous sequence is applied and advances the watermark', async () => {
  const { fixture, client, events } = await connected({ lastSequence: 10 });
  try {
    fixture.send(eventFrame({ sessionId: 's-1', sequence: 11, event: 'session.status', data: { status: 'queued' } }));
    await waitFor(() => client.lastAppliedSequence === 11);

    const domain = events.find((e) => e.type === 'domain');
    assert.equal(domain.frame.event, 'session.status');
    assert.equal(domain.frame.data.status, 'queued');
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('a gap does NOT advance the watermark and sets resync_required', async () => {
  const { fixture, client, events, gaps } = await connected({ lastSequence: 10 });
  try {
    // seq 12 with 11 missing.
    fixture.send(eventFrame({ sessionId: 's-1', sequence: 12, event: 'session.status', data: { status: 'completed' } }));
    await waitFor(() => client.resyncRequired);

    assert.equal(client.lastAppliedSequence, 10, 'the watermark must NOT jump to 12');
    assert.notEqual(client.lastAppliedSequence, 12);
    assert.equal(client.state.uiConnection, 'resync_required');
    assert.deepEqual(gaps, [{ expected: 11, received: 12 }]);

    const gap = events.find((e) => e.type === 'gap');
    assert.ok(gap !== undefined);
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('after a gap, later events are not applied either', async () => {
  const { fixture, client, events } = await connected({ lastSequence: 10 });
  try {
    fixture.send(eventFrame({ sessionId: 's-1', sequence: 12, event: 'session.status', data: { status: 'completed' } }));
    await waitFor(() => client.resyncRequired);
    const appliedBefore = events.filter((e) => e.type === 'domain').length;

    // Even the "missing" event must not be applied, and neither must anything after it: doing
    // so would silently skip the gap.
    fixture.send(eventFrame({ sessionId: 's-1', sequence: 14, event: 'session.status', data: { status: 'failed' } }));
    await waitFor(() => events.some((e) => e.type === 'suppressed-after-resync'));

    assert.equal(events.filter((e) => e.type === 'domain').length, appliedBefore, 'nothing may be applied after a gap');
    assert.equal(client.lastAppliedSequence, 10);
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('resync_required and overflow both stop normal application', async () => {
  for (const frame of [
    { type: 'resync_required', reason: 'too_old', action: 'refresh_rest_state' },
    { type: 'overflow', dropped: 5 },
  ]) {
    const { fixture, client, events } = await connected({ lastSequence: 3 });
    try {
      fixture.send(frame);
      await waitFor(() => client.resyncRequired);
      assert.equal(client.state.uiConnection, 'resync_required', `${frame.type} should require resync`);

      const before = events.filter((e) => e.type === 'domain').length;
      fixture.send(eventFrame({ sessionId: 's-1', sequence: 4, event: 'session.status', data: { status: 'running' } }));
      await waitFor(() => events.some((e) => e.type === 'suppressed-after-resync'));
      assert.equal(events.filter((e) => e.type === 'domain').length, before, 'a contiguous event must still be held back');
      client.close();
    } finally {
      await fixture.stop();
    }
  }
});

test('a frame for another session is never applied', async () => {
  const { fixture, client, events } = await connected({ lastSequence: 1 });
  try {
    fixture.send(eventFrame({ sessionId: 's-OTHER', sequence: 2, event: 'session.status', data: { status: 'failed' } }));
    await waitFor(() => events.some((e) => e.type === 'foreign-session'));

    assert.equal(client.lastAppliedSequence, 1, 'a foreign frame must not move our watermark');
    assert.equal(events.some((e) => e.type === 'domain'), false);
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('with no REST snapshot the first sequenced event becomes the baseline', async () => {
  const { fixture, client, events } = await connected({ lastSequence: null });
  try {
    // There is no seed, so the first event anchors the watermark rather than being rejected as
    // a gap. A timestamp or local counter is never used instead.
    fixture.send(eventFrame({ sessionId: 's-1', sequence: 100, event: 'session.status', data: { status: 'running' } }));
    await waitFor(() => client.lastAppliedSequence === 100);

    assert.equal(events.some((e) => e.type === 'gap'), false, 'the first event must not be treated as a gap');
    assert.equal(events.some((e) => e.type === 'domain'), true, 'and it must be applied');
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('the client never derives a sequence from a clock or a local counter', async () => {
  // Structural: every assignment to `lastAppliedSequence` must come from the caller's REST seed
  // or from a real event frame's `sequence`. A `Date.now()`, a local counter or a message index
  // masquerading as a Gateway sequence would corrupt replay for the whole session.
  const fs = await import('node:fs');
  const source = fs.readFileSync('src/remote/ui/ws/event-client.js', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  // Only top-level assignments, matched up to the first `;` at the end of the statement.
  const assignments = [...source.matchAll(/^\s*this\.lastAppliedSequence\s*=\s*(.+);\s*$/gm)].map((m) => m[1].trim());
  assert.ok(assignments.length > 0, 'expected to find the assignments');
  for (const expression of assignments) {
    const legitimate = expression === 'seedSequence(options.lastSequence)' || expression === 'sequence';
    assert.ok(legitimate, `unexpected sequence source: ${expression}`);
  }

  const { seedSequence } = await import('../../src/remote/ui/ws/event-client.js');
  assert.equal(seedSequence(0), 0, 'zero is a legitimate sequence');
  assert.equal(seedSequence(41), 41);
  for (const bad of [undefined, null, '41', 4.5, -1, Number.NaN, Number.POSITIVE_INFINITY, Date.now() + 0.5, {}, []]) {
    assert.equal(seedSequence(bad), null, `${JSON.stringify(bad)} must not be adopted as a sequence`);
  }

  assert.equal(/lastAppliedSequence\s*=\s*Date\.now/.test(source), false);
  assert.equal(/Date\.now\(\)/.test(source), false, 'a clock must not appear as a sequence source');
});
