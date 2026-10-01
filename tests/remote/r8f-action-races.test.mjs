/**
 * R8F — Action races: double actions, session switches, and late results.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { actionStack, waitUntil } from './r8f-harness.mjs';
import { DOMAIN_STATES, CONNECTION_STATES } from '../../src/remote/ui/state/ui-state.js';

test('every action refuses a second concurrent submission', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    // Send / queue.
    const sendGate = h.f.hold('/messages');
    const send1 = h.owner.send({ content: 'a', mode: 'queue' });
    await waitUntil(() => h.state.sendState === 'sending');
    assert.equal((await h.owner.send({ content: 'a', mode: 'queue' })).refused, 'send-in-flight');
    sendGate.release();
    await send1;

    // Cancel.
    const cancelGate = h.f.hold('/cancel');
    const cancel1 = h.owner.cancel();
    await waitUntil(() => h.state.cancelState === 'cancelling');
    assert.equal((await h.owner.cancel()).refused, 'cancel-in-flight');
    cancelGate.release();
    await cancel1;

    // Upload.
    const uploadGate = h.f.hold('/uploads');
    const upload1 = h.owner.upload({ name: 'f.bin', size: 10 });
    await waitUntil(() => h.state.attachments.some((a) => a.state === 'uploading'));
    assert.equal((await h.owner.upload({ name: 'f.bin', size: 10 })).refused, 'upload-in-flight');
    uploadGate.release();
    await upload1;

    // Exactly one of each reached the Gateway.
    assert.equal(h.f.state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages')).length, 1);
    assert.equal(h.f.countRequests('/cancel'), 1);
    assert.equal(h.f.countRequests('/uploads'), 1);
  } finally {
    await h.stop();
  }
});

test('a distinct second file is still allowed while one uploads', async () => {
  const h = await actionStack({ status: 'idle' });
  try {
    const gate = h.f.hold('/uploads');
    const first = h.owner.upload({ name: 'one.bin', size: 10 });
    await waitUntil(() => h.state.attachments.some((a) => a.state === 'uploading'));

    // The guard is keyed by file identity, so a genuinely different file is not blocked.
    const second = h.owner.upload({ name: 'two.bin', size: 20 });
    await waitUntil(() => h.state.attachments.filter((a) => a.state === 'uploading').length === 2);

    gate.release();
    await Promise.all([first, second]);
    assert.equal(h.f.countRequests('/uploads'), 2);
  } finally {
    await h.stop();
  }
});

test('a late action result cannot mutate the newly selected session', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    // Hold the POST response so the send is genuinely still in flight.
    const gate = h.f.hold('/messages');
    const inFlight = h.owner.send({ content: 'for A', mode: 'queue' });
    await waitUntil(() => h.state.sendState === 'sending');
    const sessionAtSend = h.state.activeSessionId;

    // Change the active session WITHOUT going through the held route: this is the supersession
    // the guard exists for. `selectSession` would itself block on the same hold.
    h.owner.state = { ...h.owner.state, activeSessionId: 's-OTHER' };

    // Now let the stale response land.
    gate.release();
    await inFlight;

    // The response belonged to the session that is no longer active, so it must not be reported
    // as an acceptance in the current view.
    assert.equal(sessionAtSend, 's-1');
    assert.equal(h.state.activeSessionId, 's-OTHER');
    assert.notEqual(h.state.sendState, 'accepted',
      'a superseded send must not mutate the view of the session that replaced it');
  } finally {
    await h.stop();
  }
});

test('a late cancel result cannot mutate a different session', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    const gate = h.f.hold('/cancel');
    const inFlight = h.owner.cancel();
    await waitUntil(() => h.state.cancelState === 'cancelling');

    // Supersede the session without going through the held route.
    h.owner.state = { ...h.owner.state, activeSessionId: 's-OTHER' };

    gate.release();
    await inFlight;
    assert.notEqual(h.state.cancelState, 'requested',
      'a superseded cancel must not claim a request against the new session');
  } finally {
    await h.stop();
  }
});

test('the state vocabulary stays at 8 domain and 6 connection states', () => {
  assert.equal(DOMAIN_STATES.length, 8);
  assert.equal(CONNECTION_STATES.length, 6);

  // No action substate may have leaked into either vocabulary.
  for (const invented of ['sending', 'cancelling', 'uploading', 'steering', 'queued_pending', 'replaying']) {
    assert.equal(DOMAIN_STATES.includes(invented), false, `${invented} must not be a domain state`);
    assert.equal(CONNECTION_STATES.includes(invented), false, `${invented} must not be a connection state`);
  }
});

test('an action in flight does not fabricate a domain transition', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    const observed = [];
    h.owner.onChange = (state) => observed.push(state.domain);

    const sendGate = h.f.hold('/messages');
    const send = h.owner.send({ content: 'x', mode: 'queue' });
    await waitUntil(() => h.state.sendState === 'sending');
    sendGate.release();
    await send;

    const cancelGate = h.f.hold('/cancel');
    const cancel = h.owner.cancel();
    await waitUntil(() => h.state.cancelState === 'cancelling');
    cancelGate.release();
    await cancel;

    // Every domain value the UI ever held is one of the frozen eight, and nothing advanced it.
    for (const domain of observed) assert.ok(DOMAIN_STATES.includes(domain), `${domain} escaped the vocabulary`);
    assert.equal(h.state.domain, 'running', 'no action advanced the domain on its own');
  } finally {
    await h.stop();
  }
});

test('an action with no active session is a safe no-op', async () => {
  const h = await actionStack({ status: 'idle' });
  try {
    // Simulate the state before any session is selected.
    h.owner.state = { ...h.owner.state, activeSessionId: null };
    const before = h.f.state.requests.length;

    await h.owner.send({ content: 'x', mode: 'queue' });
    await h.owner.cancel();
    await h.owner.upload({ name: 'f.bin', size: 10 });

    assert.equal(h.f.state.requests.length, before, 'no request may be issued without a session');
  } finally {
    await h.stop();
  }
});
