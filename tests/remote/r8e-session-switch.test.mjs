import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryFixture, deferred } from './r8e-harness.mjs';
import { waitFor } from './r8d-harness.mjs';

test('session switch invalidates a late recovery REST response even if it ignores abort', async () => {
  const h = await recoveryFixture();
  try {
    const gate = deferred();
    const original = h.client.getMessages.bind(h.client);
    h.client.getMessages = async (id, opts) => {
      if (id === 's') { await gate.promise; return original(id); }
      return original(id, opts);
    };
    const reload = h.recovery.reload();
    await waitFor(() => h.f.requests.some(r => r.path.endsWith('/s')));
    await h.owner.selectSession('b');
    await waitFor(() => h.owner.state.connection === 'connected');
    gate.resolve();
    await reload;
    assert.equal(h.owner.state.activeSessionId, 'b');
    assert.equal(h.owner.state.messages[0].sessionId, 'b');
    assert.equal(h.f.connections.length, 1);
    assert.equal(h.f.connections[0].sessionId, 'b');
  } finally { await h.stop(); }
});

test('sign-out invalidates a late reload and cannot resurrect a socket', async () => {
  const h = await recoveryFixture();
  try {
    const gate = deferred();
    h.f.hold = gate;
    const pending = h.recovery.reload();
    await waitFor(() => h.f.requests.some(r => r.path.endsWith('/messages')));
    h.owner.signOut();
    gate.resolve();
    await pending;
    assert.equal(h.owner.state.connection, 'auth_required');
    assert.equal(h.f.ticketsIssued, 0);
    assert.equal(h.credentials.has(), false);
  } finally { await h.stop(); }
});

test('a late cancel acknowledgement cannot overwrite a completed recovery snapshot', async () => {
  const h = await recoveryFixture();
  try {
    const gate = deferred();
    h.client.cancel = async () => { await gate.promise; return { status: 'cancelled' }; };
    const pending = h.owner.cancel();
    await h.recovery.reload();
    gate.resolve();
    await pending;
    assert.equal(h.owner.state.domain, 'completed');
  } finally { await h.stop(); }
});

test('late send completion cannot clear the draft edited during recovery', async () => {
  const h = await recoveryFixture();
  try {
    const gate = deferred();
    h.client.sendMessage = async () => { await gate.promise; return { status: 'accepted' }; };
    const pending = h.owner.send({ content: 'earlier draft', mode: 'queue' });
    await h.recovery.reload();
    gate.resolve();
    await pending;
    assert.equal(h.owner.state.draft, 'unsent draft');
  } finally { await h.stop(); }
});
