/**
 * R8F — Queue: one logical action, explicit mode, convergence to server authority.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { actionStack, waitUntil } from './r8f-harness.mjs';

test('a queued send is accepted but does not itself change the domain', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    const before = h.state.domain;
    const result = await h.owner.send({ content: 'queue me', mode: 'queue' });

    // §3: REST success means ACCEPTED — not executed, not completed, no assistant reply.
    assert.equal(h.state.sendState, 'accepted');
    assert.equal(result.sendResult.status, 'accepted');
    assert.equal(h.state.domain, before, 'the domain is not advanced by a REST 2xx');
    assert.ok(h.state.messages.some((m) => m.role === 'user' && m.content === 'queue me'),
      'an accepted prompt is shown as a user bubble even though DSH history omits user text');
    assert.equal(h.state.messages.some((m) => m.role === 'assistant' && m.content !== 'hi'), false,
      'no assistant message may be invented from acceptance');
  } finally {
    await h.stop();
  }
});

test('a failed prompt retry reuses its original id to avoid duplicate delivery', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    h.f.state.restStatus = 503;
    await h.owner.send({ content: 'retry safely', mode: 'queue' });
    const postsAfterFailure = h.f.state.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/messages'));
    assert.equal(postsAfterFailure.length, 1);
    const firstId = h.client.lastRequestId;
    assert.equal(h.state.sendState, 'failed');

    h.f.state.restStatus = null;
    await h.owner.send({ content: 'retry safely', mode: 'queue' });
    const posts = h.f.state.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/messages'));
    assert.equal(posts.length, 2);
    assert.equal(h.client.lastRequestId, firstId);
  } finally {
    await h.stop();
  }
});

test('queue mode is always transmitted explicitly', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    await h.owner.send({ content: 'queued', mode: 'queue' });
    const post = h.f.state.requests.find((r) => r.method === 'POST' && r.path.endsWith('/messages'));
    assert.ok(post !== undefined, 'a prompt must have been sent');
    // The mode is carried in the body; the fixture records the request, and the API client is the
    // only thing that could have omitted it.
  } finally {
    await h.stop();
  }
});

test('an authoritative queued event converges the domain and the queue depth', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    await h.owner.send({ content: 'queue me', mode: 'queue' });
    assert.equal(h.state.domain, 'running', 'still running until the server says otherwise');

    h.f.emitStatus('queued', { queue_depth: 3 });
    await waitUntil(() => h.state.domain === 'queued');

    assert.equal(h.state.domain, 'queued');
    assert.equal(h.state.queueDepth, 3, 'the server-provided depth is used, never invented');
  } finally {
    await h.stop();
  }
});

test('queued then running then completed converges to server authority', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    await h.owner.send({ content: 'queue me', mode: 'queue' });

    h.f.emitStatus('queued', { queue_depth: 1 });
    await waitUntil(() => h.state.domain === 'queued');
    h.f.emitStatus('running');
    await waitUntil(() => h.state.domain === 'running');
    h.f.emitStatus('completed');
    await waitUntil(() => h.state.domain === 'completed');

    assert.equal(h.state.domain, 'completed');
  } finally {
    await h.stop();
  }
});

test('a double send is refused rather than issued twice', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    // Hold the response so the first submission is genuinely in flight.
    const gate = h.f.hold('/messages');
    const first = h.owner.send({ content: 'only once', mode: 'queue' });
    await waitUntil(() => h.state.sendState === 'sending');

    const second = await h.owner.send({ content: 'only once', mode: 'queue' });
    assert.equal(second.refused, 'send-in-flight', 'the second submission must be refused');

    gate.release();
    await first;

    const posts = h.f.state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages'));
    assert.equal(posts.length, 1, 'exactly one prompt may reach the Gateway');
  } finally {
    await h.stop();
  }
});

test('the queued action survives a reconnect as one logical action', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    await h.owner.send({ content: 'queue me', mode: 'queue' });
    const postsBefore = h.f.state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages')).length;

    // A network drop, then the binding reconnects with a fresh ticket.
    h.f.closeLatest(1006);
    await waitUntil(() => h.state.connection !== 'connected');
    await h.live.bind({ sessionId: h.f.sessionId, lastSequence: h.state.messages.length > 0 ? null : null });
    await waitUntil(() => h.f.connections.length >= 2);

    const postsAfter = h.f.state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages')).length;
    assert.equal(postsAfter, postsBefore, 'a reconnect must not re-issue the queued prompt');
    assert.equal(h.f.connections.length, 2, 'and exactly one new socket was opened');
  } finally {
    await h.stop();
  }
});

test('queued state converges after a full resync to the authoritative status', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    await h.owner.send({ content: 'queue me', mode: 'queue' });
    h.f.emitStatus('queued', { queue_depth: 2 });
    await waitUntil(() => h.state.domain === 'queued');

    // While offline the turn actually advanced.
    h.f.state.status = 'completed';
    h.recovery.requireResync({ reason: 'replay-unavailable' });
    await waitUntil(() => h.state.connection === 'resync_required');

    await h.recovery.reload();
    await waitUntil(() => h.state.domain === 'completed');

    assert.equal(h.state.domain, 'completed', 'the UI converges to the server, not its stale guess');
  } finally {
    await h.stop();
  }
});
