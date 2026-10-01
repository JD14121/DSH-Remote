import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryFixture } from './r8e-harness.mjs';
import { eventFrame, waitFor } from './r8d-harness.mjs';

for (const status of [401, 'network', 404, 500]) {
  test(`reload ${status} preserves history and applies the correct credential/retry policy`, async () => {
    const h = await recoveryFixture();
    try {
      const old = h.owner.state.messages;
      h.f.restStatus = status;
      assert.equal(await h.recovery.reload(), false);
      assert.equal(h.owner.state.messages, old);
      assert.equal(h.owner.state.draft, 'unsent draft');
      assert.equal(h.credentials.has(), status !== 401);
      assert.equal(h.owner.state.connection, status === 401 ? 'auth_required' : 'resync_required');
      assert.equal(h.f.ticketsIssued, 0);
      assert.equal(h.live.bound, false);
      assert.equal(h.owner.state.resync, 'reload_failed');
      if (status === 404) {
        await waitFor(() => h.owner.state.sessionListStatus === 'loaded');
        assert.equal(h.owner.state.sessionUnavailable, true);
        assert.equal(await h.recovery.reload(), false);
      } else if (status !== 401) {
        h.f.restStatus = 200;
        assert.equal(await h.recovery.reload(), true);
        assert.equal(h.f.ticketsIssued, 1);
      }
    } finally { await h.stop(); }
  });
}

test('unusable sequence seed fails closed without clearing history or requesting a ticket', async () => {
  const h = await recoveryFixture();
  try {
    h.f.seed = null;
    assert.equal(await h.recovery.reload(), false);
    assert.equal(h.owner.state.messages[0].id, 'partial');
    assert.equal(h.f.ticketsIssued, 0);
  } finally { await h.stop(); }
});

test('missing replay boundary times out and releases single-flight for an operator retry', async () => {
  const h = await recoveryFixture({ timeoutMs: 80 });
  try {
    h.f.onConnection = () => {};
    assert.equal(await h.recovery.reload(), false);
    assert.equal(h.owner.state.resync, 'reload_failed');
    assert.equal(h.recovery.pending, null);
    assert.equal(h.live.bound, false);
  } finally { await h.stop(); }
});

test('ticket 401 after REST commit clears credentials and stops recovery', async () => {
  const h = await recoveryFixture();
  try {
    h.f.ticketStatus = 401;
    assert.equal(await h.recovery.reload(), false);
    assert.equal(h.owner.state.messages[0].id, 'final');
    assert.equal(h.credentials.has(), false);
    assert.equal(h.client.credential, null);
    assert.equal(h.owner.state.connection, 'auth_required');
    assert.equal(h.f.connections.length, 0);
  } finally { await h.stop(); }
});

test('repeated ticket outages stop after five automatic retries and keep the credential', async () => {
  const h = await recoveryFixture();
  try {
    h.f.ticketStatus = 503;
    assert.equal(await h.recovery.reload(), false);
    assert.equal(h.f.requests.filter(r => r.path.endsWith('/ws-ticket')).length, 6);
    assert.equal(h.owner.state.connection, 'gateway_unavailable');
    assert.equal(h.credentials.has(), true);
    assert.equal(h.live.bound, false);
    assert.equal(h.owner.state.messages[0].id, 'final');
  } finally { await h.stop(); }
});

test('exhausted reconnect retains the interrupted assistant text for operator recovery', async () => {
  const h = await recoveryFixture();
  try {
    await h.recovery.reload();
    h.f.send(eventFrame({ sessionId: 's', sequence: 41, event: 'assistant.start', data: { attempt_id: 'later' } }));
    h.f.send(eventFrame({ sessionId: 's', sequence: 42, event: 'assistant.delta', data: { attempt_id: 'later', index: 0, chunk: 'keep partial' } }));
    await waitFor(() => h.live.streamMessages.length === 1);
    h.f.ticketStatus = 503;
    h.f.closeLatest(1006);
    await waitFor(() => h.owner.state.connection === 'gateway_unavailable');
    assert.ok(h.owner.state.messages.some(m => m.content === 'keep partial' && m.interrupted));
  } finally { await h.stop(); }
});
