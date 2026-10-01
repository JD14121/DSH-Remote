/**
 * R8F — Action + recovery matrix (§22).
 *
 * The risk-bearing combinations, not every permutation: each action crossed with the recovery
 * path that could plausibly corrupt it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { actionStack, waitUntil } from './r8f-harness.mjs';

/**
 * Force a full resync and let it complete.
 *
 * @param {object} h - the stack.
 * @param {string} status - the status the server will report.
 * @returns {Promise<void>} when recovered.
 */
async function resyncTo(h, status) {
  h.f.state.status = status;
  h.recovery.requireResync({ reason: 'test' });
  await waitUntil(() => h.state.connection === 'resync_required');
  await h.recovery.reload();
  await waitUntil(() => h.state.domain === status);
}

test('queue + reconnect keeps one logical action', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    await h.owner.send({ content: 'queued once', mode: 'queue' });
    const posts = () => h.f.state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages')).length;
    const before = posts();

    await h.live.bind({ sessionId: h.f.sessionId, lastSequence: h.f.state.seed });
    await waitUntil(() => h.f.connections.length >= 2);

    assert.equal(posts(), before, 'a reconnect must not re-issue the prompt');
    assert.equal(h.f.connections.length, 2, 'exactly one new socket');
  } finally {
    await h.stop();
  }
});

test('queue + full resync converges to the authoritative status', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    await h.owner.send({ content: 'queued once', mode: 'queue' });
    h.f.emitStatus('queued', { queue_depth: 2 });
    await waitUntil(() => h.state.domain === 'queued');

    await resyncTo(h, 'completed');
    assert.equal(h.state.domain, 'completed');
  } finally {
    await h.stop();
  }
});

test('steer + reconnect does not duplicate the steer', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    await h.owner.send({ content: 'redirect', mode: 'steer' });
    const posts = () => h.f.state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages')).length;
    const before = posts();

    await h.live.bind({ sessionId: h.f.sessionId, lastSequence: h.f.state.seed });
    await waitUntil(() => h.f.connections.length >= 2);

    assert.equal(posts(), before, 'a reconnect must not re-issue the steer');
  } finally {
    await h.stop();
  }
});

test('cancel + reconnect still requires authoritative confirmation', async () => {
  const h = await actionStack({ status: 'running', backoffMs: [60_000] });
  try {
    await h.owner.cancel();
    assert.equal(h.state.cancelState, 'requested');
    assert.equal(h.state.domain, 'running');

    h.f.closeLatest(1006);
    await waitUntil(() => h.state.connection !== 'connected');
    assert.notEqual(h.state.domain, 'cancelled', 'the request must not become a terminal state');
  } finally {
    await h.stop();
  }
});

test('cancel + full resync follows the server, whichever way it went', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    await h.owner.cancel();
    await resyncTo(h, 'cancelled');
    assert.equal(h.state.domain, 'cancelled');
  } finally {
    await h.stop();
  }
});

test('cancel + full resync does not stay cancelled when the turn actually completed', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    await h.owner.cancel();
    await resyncTo(h, 'completed');
    assert.equal(h.state.domain, 'completed', 'the 202 must not override the server');
  } finally {
    await h.stop();
  }
});

test('waiting_input + reconnect converges to the latest server status', async () => {
  const h = await actionStack({ status: 'waiting_input', backoffMs: [60_000] });
  try {
    h.f.closeLatest(1006);
    await waitUntil(() => h.state.connection !== 'connected');

    await h.recovery.reload().catch(() => {});
    // The reload path requires a resync request; drive it the way the UI does.
    h.recovery.requireResync({ reason: 'server-close' });
    await waitUntil(() => h.state.connection === 'resync_required');
    h.f.state.status = 'running';
    await h.recovery.reload();
    await waitUntil(() => h.state.domain === 'running');

    assert.equal(h.state.domain, 'running', 'a stale waiting-input must not survive');
  } finally {
    await h.stop();
  }
});

test('waiting_input + full resync converges', async () => {
  const h = await actionStack({ status: 'waiting_input' });
  try {
    await resyncTo(h, 'completed');
    assert.equal(h.state.domain, 'completed');
  } finally {
    await h.stop();
  }
});

test('upload + network failure leaves a removable failed chip and keeps the credential', async () => {
  const h = await actionStack({ status: 'idle' });
  try {
    h.f.state.uploadStatus = 'network';
    await h.owner.upload({ name: 'x.bin', size: 100 });

    const failed = h.state.attachments.find((a) => a.state === 'failed');
    assert.ok(failed !== undefined, 'the chip must be removable, not silently dropped');
    assert.notEqual(h.owner.credentials.read(), null, 'the credential survives a network failure');

    h.owner.removeAttachment(failed.id);
    assert.equal(h.state.attachments.length, 0);
  } finally {
    await h.stop();
  }
});

test('upload selection + resync preserves the local selection and re-uploads nothing', async () => {
  const h = await actionStack({ status: 'idle' });
  try {
    h.owner.state = {
      ...h.owner.state,
      attachments: [{ id: 'sel-1', name: 'picked.png', state: 'selected', file: { local: true } }],
    };

    await resyncTo(h, 'idle');
    assert.equal(h.state.attachments.some((a) => a.id === 'sel-1'), true, 'the local selection survives');
    assert.equal(h.f.countRequests('/uploads'), 0, 'a resync must not upload anything');
  } finally {
    await h.stop();
  }
});

test('a full resync retires an interrupted stream and accepts authoritative history', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    const attempt = 'att-1';
    h.f.emitStreamStart(attempt);
    h.f.emitChunk(attempt, 0, 'partial');
    await waitUntil(() => h.live.streamMessages.length === 1);
    assert.equal(h.live.streamMessages[0].content, 'partial');

    h.f.state.history = [
      { id: 'm-1', session_id: h.f.sessionId, role: 'user', content: 'hello', sequence: 3 },
      { id: 'm-final', session_id: h.f.sessionId, role: 'assistant', content: 'the full answer', sequence: 4 },
    ];
    await resyncTo(h, 'completed');

    // The transient is gone and the authoritative message is present exactly once.
    assert.equal(h.live.streamMessages.length, 0, 'the transient must be retired by a reload');
    const finals = h.state.messages.filter((m) => m.id === 'm-final');
    assert.equal(finals.length, 1, 'the authoritative message appears once, never duplicated');
    assert.equal(finals[0].content, 'the full answer');
  } finally {
    await h.stop();
  }
});

test('no action auto-retries during recovery', async () => {
  const h = await actionStack({ status: 'idle' });
  try {
    h.f.state.uploadStatus = 500;
    await h.owner.upload({ name: 'bad.bin', size: 10 });
    const uploads = h.f.countRequests('/uploads');

    const postsBefore = h.f.state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages')).length;
    await resyncTo(h, 'idle');

    assert.equal(h.f.countRequests('/uploads'), uploads, 'no upload may be retried by recovery');
    assert.equal(
      h.f.state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages')).length,
      postsBefore,
      'no prompt may be re-sent by recovery',
    );
  } finally {
    await h.stop();
  }
});
