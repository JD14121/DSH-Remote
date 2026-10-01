/**
 * R8F — Waiting input: convergence on reconnect and resync, and the composer emphasis.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { actionStack, waitUntil } from './r8f-harness.mjs';
import { primarySendLabel, steerAvailable, sendIntent } from '../../src/remote/ui/state/ui-state.js';
import { createTestDocument } from './r8b-dom.mjs';
import { renderComposer } from '../../src/remote/ui/components/composer.js';

test('waiting_input labels the primary action Send and hides steer', () => {
  // §13: in waiting_input the composer's primary action is a reply.
  assert.equal(primarySendLabel('waiting_input'), 'Send');
  assert.equal(sendIntent('waiting_input'), 'reply');
  assert.equal(steerAvailable('waiting_input'), false, 'there is no running turn to steer');
});

test('waiting_input is reached only by an authoritative event', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    assert.notEqual(h.state.domain, 'waiting_input', 'the UI must not invent waiting_input');

    h.f.emitStatus('waiting_input');
    await waitUntil(() => h.state.domain === 'waiting_input');
    assert.equal(h.state.domain, 'waiting_input');
  } finally {
    await h.stop();
  }
});

test('a waiting-input reply uses an existing explicit mode', async () => {
  const h = await actionStack({ status: 'waiting_input' });
  try {
    // §13: no new `reply` backend mode is invented. The reply is a queue submission with the
    // primary action labelled "Send".
    assert.equal(primarySendLabel(h.state.domain), 'Send');

    const modes = [];
    const original = h.client.sendMessage.bind(h.client);
    h.client.sendMessage = async (sessionId, request, opts) => {
      modes.push(request.mode);
      return original(sessionId, request, opts);
    };

    await h.owner.send({ content: 'my answer', mode: 'queue' });
    assert.deepEqual(modes, ['queue'], 'the reply must use an existing frozen mode');
    assert.equal(h.state.sendState, 'accepted');
  } finally {
    await h.stop();
  }
});

test('waiting_input converges when the turn advanced while offline (resync)', async () => {
  const h = await actionStack({ status: 'waiting_input' });
  try {
    assert.equal(h.state.domain, 'waiting_input');

    // The turn advanced while the client was away.
    h.f.state.status = 'running';
    h.recovery.requireResync({ reason: 'replay-unavailable' });
    await waitUntil(() => h.state.connection === 'resync_required');
    await h.recovery.reload();
    await waitUntil(() => h.state.domain === 'running');

    assert.equal(h.state.domain, 'running', 'a stale waiting_input must not survive recovery');
  } finally {
    await h.stop();
  }
});

test('waiting_input converges to completed after a reconnect', async () => {
  const h = await actionStack({ status: 'waiting_input', backoffMs: [60_000] });
  try {
    h.f.closeLatest(1006);
    await waitUntil(() => h.state.connection !== 'connected');

    // The server moved on while the socket was down.
    h.f.state.status = 'completed';
    h.recovery.requireResync({ reason: 'server-close' });
    await waitUntil(() => h.state.connection === 'resync_required');
    await h.recovery.reload();
    await waitUntil(() => h.state.domain === 'completed');

    assert.equal(h.state.domain, 'completed');
  } finally {
    await h.stop();
  }
});

test('the composer emphasizes Send and disables steer when waiting', () => {
  const doc = createTestDocument();
  const composer = renderComposer(
    { domain: 'waiting_input', connection: 'connected', draft: '', queueDepth: 0, attachments: [] },
    { doc, onSend: () => {}, onSteer: () => {}, onCancel: () => {} },
  );

  const send = composer.querySelector('#composer-send');
  assert.equal(send.textContent, 'Send', 'the primary label states a reply, not a queue');
  assert.equal(send.disabled, false);
  assert.equal(composer.querySelector('#composer-steer'), null, 'steer is absent while waiting');
  assert.equal(composer.querySelector('#composer-cancel'), null, 'nothing is running to cancel');
});

test('an action substate never becomes a domain state', async () => {
  const h = await actionStack({ status: 'waiting_input' });
  try {
    await h.owner.send({ content: 'answer', mode: 'queue' });
    // `sending`/`accepted` are UI-local; the domain stays whatever the server last said.
    assert.equal(h.state.sendState, 'accepted');
    assert.equal(h.state.domain, 'waiting_input', 'acceptance does not advance the domain');
  } finally {
    await h.stop();
  }
});
