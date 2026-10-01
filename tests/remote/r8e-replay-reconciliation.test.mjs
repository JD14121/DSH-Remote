import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryFixture } from './r8e-harness.mjs';
import { eventFrame, helloFrame, replayCompleteFrame, waitFor } from './r8d-harness.mjs';

test('REST seed 40 rejects replay 38–40 and applies 41–42 exactly once', async () => {
  const h = await recoveryFixture();
  try {
    h.f.onConnection = c => {
      c.send(helloFrame({ sessionId: 's' }));
      for (const sequence of [38, 39, 40, 41, 42]) c.send(eventFrame({ sessionId: 's', sequence,
        event: 'session.status', data: { status: sequence === 42 ? 'waiting_input' : 'queued', queue_depth: sequence === 42 ? 0 : 2 } }));
      c.send(replayCompleteFrame({ sequence: 42 }));
    };
    assert.equal(await h.recovery.reload(), true);
    assert.equal(h.live.controller.client.lastAppliedSequence, 42);
    assert.equal(h.owner.state.messages.length, 1);
    assert.equal(h.owner.state.domain, 'waiting_input');
    assert.equal(h.owner.state.queueDepth, 0);
  } finally { await h.stop(); }
});

test('a second gap stops the new generation and never auto-reloads in a loop', async () => {
  const h = await recoveryFixture();
  try {
    h.f.onConnection = c => {
      c.send(helloFrame({ sessionId: 's' }));
      c.send(eventFrame({ sessionId: 's', sequence: 45, event: 'session.status', data: { status: 'failed' } }));
      c.send(eventFrame({ sessionId: 's', sequence: 46, event: 'session.status', data: { status: 'cancelled' } }));
      c.send(replayCompleteFrame({ sequence: 46 }));
    };
    assert.equal(await h.recovery.reload(), false);
    assert.equal(h.owner.state.connection, 'resync_required');
    assert.equal(h.owner.state.domain, 'completed');
    assert.equal(h.owner.state.resync, 'reload_failed');
    assert.equal(h.f.ticketsIssued, 1);
    assert.equal(h.live.bound, false);
    assert.equal(await h.recovery.reload(), false);
    assert.equal(h.f.ticketsIssued, 2, 'another operator action is required for every retry');
  } finally { await h.stop(); }
});

test('explicit server retention resync blocks further sequenced events', async () => {
  const h = await recoveryFixture();
  try {
    await h.recovery.reload();
    h.f.send({ type: 'resync_required', reason: 'gap_not_available', action: 'refresh_rest_state' });
    h.f.send(eventFrame({ sessionId: 's', sequence: 41, event: 'session.status', data: { status: 'failed' } }));
    await waitFor(() => h.owner.state.connection === 'resync_required');
    assert.equal(h.owner.state.domain, 'completed');
    assert.equal(h.live.bound, false);
  } finally { await h.stop(); }
});

test('frozen close code 4001 alone requires operator resync rather than a retry loop', async () => {
  const h = await recoveryFixture();
  try {
    await h.recovery.reload();
    h.f.closeLatest(4001, 'untrusted raw reason');
    await waitFor(() => h.owner.state.connection === 'resync_required');
    assert.equal(h.live.bound, false);
    assert.equal(h.f.ticketsIssued, 1);
  } finally { await h.stop(); }
});
