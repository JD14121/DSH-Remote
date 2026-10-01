import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../../src/remote/ui/api/api-client.js';
import { RealModeController } from '../../src/remote/ui/api/real-mode.js';
import { CredentialStore, createMemoryStorage } from '../../src/remote/ui/api/credential-store.js';
import { LiveSessionBinding } from '../../src/remote/ui/ws/live-session.js';
import { startWsFixture, helloFrame, replayCompleteFrame, eventFrame, waitFor } from './r8d-harness.mjs';

test('real REST envelopes preserve the Gateway seed separately from DSH history cursors', async () => {
  const client = new ApiClient({ fetchImpl: async (url) => ({ ok: true, status: 200,
    json: async () => url.endsWith('/messages')
      ? { api_version: 1, data: [{ id: 'm', session_id: 's', role: 'assistant', content: [{ type: 'text', text: 'final' }], source_sequence: 900 }], page: { has_more: false, through_seq: 900 } }
      : { api_version: 1, data: { id: 's', status: 'completed', last_sequence: 40 } },
  }) });
  const session = await client.getSession('s');
  const page = await client.getMessages('s');
  assert.equal(session.lastSequence, 40);
  assert.equal(page.messages[0].content, 'final');
  assert.equal(page.messages[0].sequence, null);
  assert.equal(page.messages[0].sourceSequence, 900);
});

test('normal binding reconnect preserves the applied watermark and interrupted stream without REST', async () => {
  const f = await startWsFixture();
  const finals = [];
  const binding = new LiveSessionBinding({ baseUrl: f.baseUrl, credential: 'good-token', backoffMs: [10],
    onDomainEvent: e => { if (e.kind === 'stream-end') finals.push(e.message); } });
  const attempt = { attempt_id: 'a' };
  f.onConnection = c => {
    c.send(helloFrame({ sessionId: 's' }));
    if (f.connections.length === 1) {
      c.send(eventFrame({ sessionId: 's', sequence: 1, event: 'assistant.start', data: attempt }));
      c.send(eventFrame({ sessionId: 's', sequence: 2, event: 'assistant.delta', data: { ...attempt, index: 0, chunk: 'A' } }));
      c.send(eventFrame({ sessionId: 's', sequence: 3, event: 'assistant.delta', data: { ...attempt, index: 1, chunk: 'B' } }));
    } else {
      c.send(eventFrame({ sessionId: 's', sequence: 3, event: 'assistant.delta', data: { ...attempt, index: 1, chunk: 'B' } }));
      c.send(eventFrame({ sessionId: 's', sequence: 4, event: 'assistant.delta', data: { ...attempt, index: 2, chunk: 'C' } }));
      c.send(eventFrame({ sessionId: 's', sequence: 5, event: 'assistant.end', data: attempt }));
    }
    c.send(replayCompleteFrame());
  };
  try {
    await binding.bind({ sessionId: 's', lastSequence: 0 });
    await waitFor(() => binding.streamMessages[0]?.content === 'AB');
    f.closeLatest(1006);
    await waitFor(() => finals.length === 1);
    assert.equal(f.connections[1].lastSequence, 3);
    assert.equal(finals[0].content, 'ABC');
    assert.equal(f.ticketsIssued, 2);
  } finally { binding.unbind(); await f.stop(); }
});

test('reload is single-flight, retains visible history until success, and commits before a fresh replay', async () => {
  const f = await startWsFixture();
  let release;
  const gate = new Promise(r => { release = r; });
  let historyCalls = 0;
  const client = new ApiClient({ baseUrl: f.baseUrl, credential: 'good-token', fetchImpl: async (url, init) => {
    if (url.endsWith('/messages')) { historyCalls++; await gate; }
    return { ok: true, status: 200, json: async () => url.endsWith('/messages')
      ? { api_version: 1, data: [{ id: 'final', session_id: 's', role: 'assistant', content: 'server', source_sequence: 900 }], page: { has_more: false } }
      : { api_version: 1, data: { id: 's', status: 'completed', last_sequence: 40 } } };
  } });
  const binding = new LiveSessionBinding({ baseUrl: f.baseUrl, credential: 'good-token' });
  const owner = new RealModeController({ client, live: binding, credentials: new CredentialStore({ storage: createMemoryStorage() }) });
  owner.state = { ...owner.state, activeSessionId: 's', connection: 'resync_required', draft: 'keep', attachments: [{ id: 'local', state: 'selected' }], messages: [{ id: 'old', content: 'partial' }] };
  try {
    assert.ok(owner.recovery, 'real mode must own recovery orchestration');
    owner.recovery.requireResync({ reason: 'gap' });
    f.onConnection = c => { c.send(helloFrame({ sessionId: 's' })); c.send(replayCompleteFrame({ sequence: 40 })); };
    const a = owner.recovery.reload();
    const b = owner.recovery.reload();
    assert.equal(a, b);
    assert.equal(owner.state.messages[0].id, 'old');
    assert.equal(owner.state.resync, 'loading');
    release();
    await a;
    assert.equal(historyCalls, 1);
    assert.equal(owner.state.messages[0].id, 'final');
    assert.equal(owner.state.draft, 'keep');
    assert.equal(owner.state.attachments[0].id, 'local');
    assert.equal(owner.state.connection, 'connected');
    assert.equal(f.connections[0].lastSequence, 40);
    assert.equal(f.ticketsIssued, 1);
  } finally { release(); owner.recovery?.dispose(); binding.unbind(); await f.stop(); }
});
