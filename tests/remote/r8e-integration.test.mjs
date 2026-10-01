import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryFixture, deferred } from './r8e-harness.mjs';
import { eventFrame, helloFrame, replayCompleteFrame, waitFor } from './r8d-harness.mjs';
import { createTestDocument } from './r8b-dom.mjs';
import { mount } from '../../src/remote/ui/app.js';

test('real HTTP + WS + mounted recovery: partial, drop, retention miss, Reload, fresh replay, live', async () => {
  const h = await recoveryFixture();
  let app;
  try {
    h.f.seed = 0;
    h.f.history = [];
    h.f.status = 'running';
    const doc = createTestDocument();
    const root = doc.createElement('div');
    app = await mount({ mode: 'real', doc, root, realController: h.owner });
    await h.owner.selectSession('s');
    await waitFor(() => h.owner.state.connection === 'connected');
    const oldClient = h.live.controller.client;
    const oldSocket = oldClient.socket;
    h.f.send(eventFrame({ sessionId: 's', sequence: 1, event: 'assistant.start', data: { attempt_id: 'a' } }));
    h.f.send(eventFrame({ sessionId: 's', sequence: 2, event: 'assistant.delta', data: { attempt_id: 'a', index: 0, chunk: 'partial A' } }));
    await waitFor(() => root.textContent.includes('partial A'));
    h.f.onConnection = c => {
      c.send(helloFrame({ sessionId: 's', mode: 'resync' }));
      c.send({ type: 'resync_required', reason: 'gap_not_available', action: 'refresh_rest_state' });
    };
    const reads = h.f.requests.filter(r => r.path.endsWith('/messages')).length;
    h.f.closeLatest(1006);
    await waitFor(() => h.owner.state.connection === 'resync_required');
    assert.match(root.textContent, /partial A/);
    assert.match(root.textContent, /Interrupted/);
    assert.equal(h.f.requests.filter(r => r.path.endsWith('/messages')).length, reads);
    assert.equal(h.f.connections[1].lastSequence, 2);
    h.f.seed = 40;
    h.f.history = [{ id: 'final', session_id: 's', role: 'assistant', content: 'authoritative ABC', source_sequence: 900 }];
    h.f.status = 'completed';
    h.f.hold = deferred();
    h.f.onConnection = c => {
      c.send(helloFrame({ sessionId: 's', latest: 42 }));
      for (const sequence of [38, 39, 40, 41, 42]) c.send(eventFrame({ sessionId: 's', sequence,
        event: 'session.status', data: { status: sequence <= 40 ? 'failed' : 'completed', queue_depth: 0 } }));
      // Test controls the boundary to prove OPEN/hello never means connected.
    };
    root.querySelector('#resync-banner').querySelector('button').click();
    const pending = h.recovery.pending;
    assert.equal(h.owner.state.resync, 'loading');
    assert.match(root.textContent, /partial A/);
    h.f.hold.resolve();
    await waitFor(() => h.live.controller?.client?.lastAppliedSequence === 42);
    assert.equal(h.owner.state.connection, 'connecting');
    assert.match(root.textContent, /authoritative ABC/);
    assert.equal(root.querySelector('textarea').value, 'unsent draft');
    oldSocket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(eventFrame({ sessionId: 's', sequence: 999,
      event: 'session.status', data: { status: 'failed' } })) }));
    oldSocket.dispatchEvent(new Event('close'));
    h.f.completeReplay({ sequence: 42 });
    assert.equal(await pending, true);
    assert.equal(h.owner.state.domain, 'completed');
    assert.equal(h.owner.state.connection, 'connected');
    assert.deepEqual(h.owner.state.messages.map(m => m.id), ['final']);
    assert.equal(h.live.streamMessages.length, 0);
    assert.equal(h.owner.state.draft, 'unsent draft');
    assert.equal(h.owner.state.attachments[0].file.local, true);
    assert.equal(h.f.ticketsIssued, 3);
    assert.equal(new Set(h.f.consumed).size, 3);
    assert.equal(h.f.connections[2].lastSequence, 40);
    await waitFor(() => h.f.connections.filter(c => !c.closed).length === 1);
  } finally { app?.dispose(); await h.stop(); }
});

test('ordinary mounted reconnect reaches live without any REST history reload', async () => {
  const h = await recoveryFixture();
  let app;
  try {
    const doc = createTestDocument();
    const root = doc.createElement('div');
    app = await mount({ mode: 'real', doc, root, realController: h.owner });
    await h.owner.selectSession('s');
    await waitFor(() => h.owner.state.connection === 'connected');
    const reads = h.f.requests.filter(r => !r.path.endsWith('/ws-ticket')).length;
    h.f.closeLatest(1006);
    await waitFor(() => h.f.connections.length === 2 && h.owner.state.connection === 'connected');
    assert.equal(h.f.requests.filter(r => !r.path.endsWith('/ws-ticket')).length, reads);
    assert.match(root.textContent, /server final/);
    assert.equal(h.owner.state.draft, 'unsent draft');
    assert.equal(h.owner.state.resync, 'reconnected');
    assert.equal(h.f.connections[1].lastSequence, 40);
  } finally { app?.dispose(); await h.stop(); }
});
