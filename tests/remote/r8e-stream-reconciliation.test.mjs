import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryFixture } from './r8e-harness.mjs';
import { eventFrame, helloFrame, replayCompleteFrame } from './r8d-harness.mjs';

test('authoritative final replaces interrupted/optimistic entries without identity guessing', async () => {
  const h = await recoveryFixture();
  try {
    h.owner.state.messages.push({ id: 'optimistic', role: 'user', content: 'pending' });
    await h.recovery.reload();
    assert.deepEqual(h.owner.state.messages.map(m => m.id), ['final']);
    assert.equal(h.live.streamMessages.length, 0);
    assert.equal(h.owner.state.attachments[0].file.local, true);
  } finally { await h.stop(); }
});

test('authoritative history without a final retires the partial without inventing completion', async () => {
  const h = await recoveryFixture();
  try {
    h.f.history = [];
    h.f.status = 'running';
    await h.recovery.reload();
    assert.deepEqual(h.owner.state.messages, []);
    assert.equal(h.owner.state.domain, 'running');
  } finally { await h.stop(); }
});

test('a replay tail without its pre-snapshot start cannot duplicate REST final history', async () => {
  const h = await recoveryFixture();
  try {
    h.f.onConnection = c => {
      c.send(helloFrame({ sessionId: 's' }));
      c.send(eventFrame({ sessionId: 's', sequence: 38, event: 'assistant.start', data: { attempt_id: 'old' } }));
      c.send(eventFrame({ sessionId: 's', sequence: 41, event: 'assistant.delta', data: { attempt_id: 'old', index: 4, chunk: 'server final' } }));
      c.send(eventFrame({ sessionId: 's', sequence: 42, event: 'assistant.end', data: { attempt_id: 'old' } }));
      c.send(replayCompleteFrame({ sequence: 42 }));
    };
    await h.recovery.reload();
    assert.equal(h.owner.state.messages.length, 1);
    assert.equal(h.owner.state.messages[0].id, 'final');
    assert.equal(h.live.controller.client.lastAppliedSequence, 42);
  } finally { await h.stop(); }
});

test('cancel acknowledgement cannot override the authoritative status after reload', async () => {
  const h = await recoveryFixture();
  try {
    const domainBefore = h.owner.state.domain;
    await h.owner.cancel();

    // R8F §9/§11: a REST `2xx` from cancel is ADMISSION, not the state transition. The Gateway's
    // own cancel route returns 202 and deliberately does not set `cancelled` — that needs
    // observed RUN_ABANDONED evidence. So the local action state records the request while the
    // domain stays exactly as the server last reported it.
    assert.equal(h.owner.state.cancelState, 'requested', 'the request is recorded as a UI substate');
    assert.equal(h.owner.state.domain, domainBefore, 'the domain must NOT be forced to cancelled');

    // And an authoritative reload still wins, which is the property this test is named for.
    h.f.status = 'waiting_input';
    await h.recovery.reload();
    assert.equal(h.owner.state.domain, 'waiting_input');
  } finally { await h.stop(); }
});
