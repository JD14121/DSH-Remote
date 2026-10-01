/**
 * R8F — Cancel: admission versus authority, conflicts, and convergence after a disconnect.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { actionStack, waitUntil } from './r8f-harness.mjs';
import { DOMAIN_STATES } from '../../src/remote/ui/state/ui-state.js';

test('a REST cancel response is admission, not the final cancelled state', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    await h.owner.cancel();

    // §9: the Gateway answers 202 and deliberately does NOT set `cancelled` — that needs observed
    // RUN_ABANDONED evidence. The UI mirrors the rule exactly.
    assert.equal(h.state.cancelState, 'requested', 'the request is recorded as a local substate');
    assert.equal(h.state.domain, 'running', 'the domain is NOT forced to cancelled');
  } finally {
    await h.stop();
  }
});

test('only an authoritative event produces the cancelled domain state', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    await h.owner.cancel();
    assert.notEqual(h.state.domain, 'cancelled');

    h.f.emitStatus('cancelled');
    await waitUntil(() => h.state.domain === 'cancelled');
    assert.equal(h.state.domain, 'cancelled');
  } finally {
    await h.stop();
  }
});

test('cancelling is a UI substate, never a ninth domain state', async () => {
  assert.equal(DOMAIN_STATES.length, 8, 'the domain vocabulary is frozen at eight');
  for (const invented of ['cancelling', 'cancelled_requested', 'steering', 'uploading', 'sending']) {
    assert.equal(DOMAIN_STATES.includes(invented), false, `${invented} must not be a domain state`);
  }
  assert.ok(DOMAIN_STATES.includes('cancelled'), 'the real cancelled state exists');

  const h = await actionStack({ status: 'running' });
  try {
    const seen = [];
    h.owner.onChange = (state) => seen.push(state.domain);
    await h.owner.cancel();
    // Whatever the substate does, the domain is never set to anything outside the frozen eight.
    for (const domain of seen) assert.ok(DOMAIN_STATES.includes(domain), `${domain} escaped the vocabulary`);
  } finally {
    await h.stop();
  }
});

test('a double cancel is refused while one is in flight', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    const gate = h.f.hold('/cancel');
    const first = h.owner.cancel();
    await waitUntil(() => h.state.cancelState === 'cancelling');

    const second = await h.owner.cancel();
    assert.equal(second.refused, 'cancel-in-flight', '§10: repeated submissions are disabled');

    gate.release();
    await first;
    assert.equal(h.f.countRequests('/cancel'), 1, 'exactly one cancel may reach the Gateway');
  } finally {
    await h.stop();
  }
});

test('a cancel conflict is a reachable-Gateway refusal, not an outage', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    h.f.state.cancelConflict = true;
    await h.owner.cancel();

    // §12: a 409 proves the Gateway answered. It must never be mapped to gateway_unavailable.
    assert.equal(h.state.error.kind, 'conflict');
    assert.equal(h.state.connection, 'connected');
    assert.notEqual(h.state.connection, 'gateway_unavailable');
    assert.equal(h.state.cancelState, 'failed');
  } finally {
    await h.stop();
  }
});

test('cancel converges after a disconnect that beat the cancelled event', async () => {
  // A long backoff keeps the disconnected state observable; an instant reconnect would hide the
  // very window this test is about.
  const h = await actionStack({ status: 'running', backoffMs: [60_000] });
  try {
    await h.owner.cancel();
    assert.equal(h.state.cancelState, 'requested');
    assert.equal(h.state.domain, 'running', 'still running until the server confirms');

    // The socket dies before the authoritative cancelled event arrives.
    h.f.closeLatest(1006);
    await waitUntil(() => h.state.connection !== 'connected');

    // §11: the UI must NOT hold a forced cancelled state. It follows the server on recovery.
    assert.notEqual(h.state.domain, 'cancelled', 'a 202 must not survive as a forced terminal state');

    // The recovery controller now owns the resync decision — this is exactly what its close-code
    // 4001 path does. Requesting it directly tests the UI contract without relying on a frame
    // reaching a socket that is, by construction, gone.
    h.f.state.status = 'completed';   // the turn actually finished while offline
    h.recovery.requireResync({ reason: 'server-close-before-cancelled' });
    await waitUntil(() => h.state.connection === 'resync_required');
    await h.recovery.reload();
    await waitUntil(() => h.state.domain === 'completed');

    assert.equal(h.state.domain, 'completed', 'recovery follows server authority, not the 202');
  } finally {
    await h.stop();
  }
});

test('cancel converges to cancelled when the server did cancel', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    await h.owner.cancel();
    h.f.state.status = 'cancelled';
    h.recovery.requireResync({ reason: 'test' });
    await waitUntil(() => h.state.connection === 'resync_required');
    await h.recovery.reload();
    await waitUntil(() => h.state.domain === 'cancelled');

    assert.equal(h.state.domain, 'cancelled');
  } finally {
    await h.stop();
  }
});

test('a cancel on a cold session reports a conflict', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    h.f.state.cancelConflict = true;
    await h.owner.cancel();
    assert.equal(h.state.cancelState, 'failed');
    assert.equal(h.state.connection, 'connected');
  } finally {
    await h.stop();
  }
});
