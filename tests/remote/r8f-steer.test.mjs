/**
 * R8F — Steer: explicit, separate, and never inferred; plus the queue/steer race.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { actionStack, waitUntil } from './r8f-harness.mjs';
import { primarySendLabel, steerAvailable, sendIntent } from '../../src/remote/ui/state/ui-state.js';

test('steer is an explicit separate action, never inferred', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    // The label rule is binding: a running turn labels the PRIMARY action "Send later", and
    // steer is available only as its own control.
    assert.equal(primarySendLabel('running'), 'Send later');
    assert.equal(sendIntent('running'), 'queue');
    assert.equal(steerAvailable('running'), true);

    // The transmitted mode is what the caller said — nothing derives steer from the running state.
    await h.owner.send({ content: 'redirect', mode: 'steer' });
    assert.equal(h.state.sendState, 'accepted');
  } finally {
    await h.stop();
  }
});

test('the mode is never inferred from the running state', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    const seen = [];
    const original = h.client.sendMessage.bind(h.client);
    h.client.sendMessage = async (sessionId, request, opts) => {
      seen.push(request.mode);
      return original(sessionId, request, opts);
    };

    await h.owner.send({ content: 'a', mode: 'queue' });
    await h.owner.send({ content: 'b', mode: 'steer' });

    assert.deepEqual(seen, ['queue', 'steer'], 'both modes must be transmitted as given');
    assert.equal(seen.includes(undefined), false, 'no mode may be omitted');
  } finally {
    await h.stop();
  }
});

test('a steer acknowledgement is the existing session.status event, not a new frame', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    await h.owner.send({ content: 'redirect', mode: 'steer' });
    // §7: the Gateway emits no `steer_confirmed`. Its own route applies PROMPT_ACCEPTED_STEER,
    // which surfaces as the existing `session.status` event. That is the authoritative signal.
    h.f.emitStatus('running');
    await waitUntil(() => h.state.domain === 'running');

    const frameTypes = h.f.latest.received.map((f) => f.type);
    assert.equal(frameTypes.includes('steer_confirmed'), false, 'no such frame may be invented');
  } finally {
    await h.stop();
  }
});

test('queue then steer keeps both intents distinct', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    const modes = [];
    const original = h.client.sendMessage.bind(h.client);
    h.client.sendMessage = async (sessionId, request, opts) => {
      modes.push(request.mode);
      return original(sessionId, request, opts);
    };

    await h.owner.send({ content: 'queue A', mode: 'queue' });
    // A running turn labels the primary action "Send later", so a queue is what it sends.
    assert.equal(primarySendLabel(h.state.domain), 'Send later');
    await h.owner.send({ content: 'steer B', mode: 'steer' });

    assert.deepEqual(modes, ['queue', 'steer'], 'the queue must not be silently converted to a steer');
  } finally {
    await h.stop();
  }
});

test('steer then queue keeps both intents distinct', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    const modes = [];
    const original = h.client.sendMessage.bind(h.client);
    h.client.sendMessage = async (sessionId, request, opts) => {
      modes.push(request.mode);
      return original(sessionId, request, opts);
    };

    await h.owner.send({ content: 'steer B', mode: 'steer' });
    await h.owner.send({ content: 'queue A', mode: 'queue' });

    assert.deepEqual(modes, ['steer', 'queue'], 'the steer must not be silently converted to a queue');
  } finally {
    await h.stop();
  }
});

test('a double steer is refused while one is in flight', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    const gate = h.f.hold('/messages');
    const first = h.owner.send({ content: 'steer', mode: 'steer' });
    await waitUntil(() => h.state.sendState === 'sending');

    const second = await h.owner.send({ content: 'steer', mode: 'steer' });
    assert.equal(second.refused, 'send-in-flight');

    gate.release();
    await first;
    assert.equal(h.f.state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages')).length, 1);
  } finally {
    await h.stop();
  }
});

test('a steer does not advance the domain by itself', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    h.f.emitStatus('running');
    await waitUntil(() => h.state.domain === 'running');
    await h.owner.send({ content: 'redirect', mode: 'steer' });

    // Acceptance is not a state transition, and the UI must not manufacture a `steering` state.
    assert.equal(h.state.domain, 'running');
    assert.equal(h.state.sendState, 'accepted');
  } finally {
    await h.stop();
  }
});
