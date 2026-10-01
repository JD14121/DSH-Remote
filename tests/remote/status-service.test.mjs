/**
 * StatusService tests — Phase R3 §20, §21, §40.
 *
 * Covers the whole control/follow wiring: control baseline, queue added, queue
 * emptied, job running/failed/killed, follow `turn/start`, `turn/end` completed
 * and aborted, `user-questions/request`, transport lost and restored, duplicate
 * subscription prevention, and shutdown unsubscribe.
 *
 * The invariant these tests exist to protect is at the end of the list:
 * **cancel accepted is not cancelled**.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { StatusService, isPendingQueueItem, signalForJobStatus } from '../../src/remote/status-service.mjs';
import { EventsService } from '../../src/remote/events.mjs';
import { SignalServiceHarness } from './status-harness.mjs';
import { SESSION_STATUS } from '../../src/remote/model/status.mjs';
import { SIGNAL } from '../../src/remote/model/signals.mjs';

const SESSION = 'session-00000000-0000-0000-0000-000000000001';

/**
 * Build a StatusService over a scripted adapter.
 *
 * @param {object} [options] - harness options.
 * @returns {Promise<object>} the harness.
 */
async function harness(options = {}) {
  const built = new SignalServiceHarness(options);
  await built.status.start();
  return built;
}

test('the status service starts one Host-wide control stream', async () => {
  const h = await harness();
  assert.equal(h.controlSubscriptions, 1, 'exactly one control stream');
  // Idempotent start must not open a second.
  await h.status.start();
  assert.equal(h.controlSubscriptions, 1);
  await h.status.stop();
});

test('a control baseline drives queue and job state for every session', async () => {
  const h = await harness();
  h.emitBaseline({
    queues: {
      [SESSION]: [{ id: 'm1', placement: 'queued' }],
      'session-00000000-0000-0000-0000-000000000002': [],
    },
    jobs: { [SESSION]: [] },
  });

  assert.equal(h.status.getSession(SESSION).status, SESSION_STATUS.QUEUED);
  // The second session has an empty queue and no job, so it settles to idle.
  assert.equal(
    h.status.getSession('session-00000000-0000-0000-0000-000000000002').status,
    SESSION_STATUS.IDLE,
  );
  await h.status.stop();
});

test('a non-empty queue is queued evidence, and emptying it returns to idle', async () => {
  const h = await harness();
  h.emitBaseline({ queues: { [SESSION]: [{ id: 'm1', placement: 'queued' }] }, jobs: {} });
  assert.equal(h.status.getSession(SESSION).status, SESSION_STATUS.QUEUED);

  h.emitQueue(SESSION, []);
  assert.equal(h.status.getSession(SESSION).status, SESSION_STATUS.IDLE, 'queue emptied');
  await h.status.stop();
});

test('a steering item counts as pending work but injected context does not', async () => {
  assert.equal(isPendingQueueItem({ placement: 'queued' }), true);
  assert.equal(isPendingQueueItem({ placement: 'steering' }), true);
  assert.equal(isPendingQueueItem({ placement: 'context' }), false);

  const h = await harness();
  h.emitBaseline({ queues: { [SESSION]: [{ id: 'c1', placement: 'context' }] }, jobs: {} });
  assert.notEqual(h.status.getSession(SESSION).status, SESSION_STATUS.QUEUED, 'context is not work');
  await h.status.stop();
});

test('a running job moves the session to running', async () => {
  const h = await harness();
  h.emitJobs(SESSION, [{ id: 'job-1', status: 'running' }]);
  assert.equal(h.status.getSession(SESSION).status, SESSION_STATUS.RUNNING);
  await h.status.stop();
});

test('a repeated running frame does not re-emit RUN_STARTED', async () => {
  const h = await harness();
  h.emitJobs(SESSION, [{ id: 'job-1', status: 'running' }]);
  const afterFirst = h.events.log(SESSION).length;

  h.emitJobs(SESSION, [{ id: 'job-1', status: 'running' }]);
  assert.equal(h.events.log(SESSION).length, afterFirst, 'a repeated frame is not new evidence');
  await h.status.stop();
});

test('a failed job fails the session', async () => {
  const h = await harness();
  h.emitJobs(SESSION, [{ id: 'job-1', status: 'running' }]);
  h.emitJobs(SESSION, [{ id: 'job-1', status: 'failed' }]);
  assert.equal(h.status.getSession(SESSION).status, SESSION_STATUS.FAILED);
  await h.status.stop();
});

test('a killed job is abandoned-run evidence, so the session is cancelled', async () => {
  const h = await harness();
  h.emitJobs(SESSION, [{ id: 'job-1', status: 'running' }]);
  h.emitJobs(SESSION, [{ id: 'job-1', status: 'killed' }]);
  assert.equal(h.status.getSession(SESSION).status, SESSION_STATUS.CANCELLED);
  await h.status.stop();
});

test('a completed job is NOT completion evidence for the run', async () => {
  // Only `turn/end {kind:'completed'}` may set `completed`. A finished bash job
  // says nothing about whether the Agent turn committed.
  assert.equal(signalForJobStatus('completed'), null);

  const h = await harness();
  h.emitJobs(SESSION, [{ id: 'job-1', status: 'running' }]);
  h.emitJobs(SESSION, [{ id: 'job-1', status: 'completed' }]);
  assert.notEqual(h.status.getSession(SESSION).status, SESSION_STATUS.COMPLETED);
  await h.status.stop();
});

test('follow turn/start and turn/end completed produce running then completed', async () => {
  const h = await harness();
  await h.status.ensureFollow(SESSION);

  h.emitFollowEvent(SESSION, { type: 'turn/start', seq: 10, time: 1_789_800_000_000, data: {} });
  assert.equal(h.status.getSession(SESSION).status, SESSION_STATUS.RUNNING);

  h.emitFollowEvent(SESSION, {
    type: 'turn/end',
    seq: 11,
    time: 1_789_800_000_100,
    data: { reason: { kind: 'completed' } },
  });
  assert.equal(h.status.getSession(SESSION).status, SESSION_STATUS.COMPLETED);
  await h.status.stop();
});

test('follow turn/end aborted produces cancelled', async () => {
  const h = await harness();
  await h.status.ensureFollow(SESSION);
  h.emitFollowEvent(SESSION, { type: 'turn/start', seq: 10, time: 1, data: {} });
  h.emitFollowEvent(SESSION, {
    type: 'turn/end',
    seq: 11,
    time: 2,
    data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
  });
  assert.equal(h.status.getSession(SESSION).status, SESSION_STATUS.CANCELLED);
  await h.status.stop();
});

test('user-questions/request is the only path to waiting_input, and it is live-only', async () => {
  const h = await harness();
  await h.status.ensureFollow(SESSION);
  h.events.applySignal(SESSION, { signal: SIGNAL.WAITING_FOR_USER, sessionId: SESSION });
  assert.equal(h.status.getSession(SESSION).status, SESSION_STATUS.WAITING_INPUT);

  // No durable DSH event type may produce it: absence of that evidence after a
  // restart must not be presented as idle, and must not be invented either.
  const { signalForDshEvent } = await import('../../src/remote/events.mjs');
  for (const type of ['approval/asked', 'assistant/message', 'turn/end', 'tool/result']) {
    assert.notEqual(
      signalForDshEvent({ type, seq: 1, time: 1, data: {} })?.signal,
      SIGNAL.WAITING_FOR_USER,
      `${type} must not fabricate a pending question`,
    );
  }
  await h.status.stop();
});

test('a transport error marks every known session disconnected, never idle', async () => {
  const h = await harness();
  await h.status.ensureFollow(SESSION);
  h.emitFollowEvent(SESSION, { type: 'turn/start', seq: 10, time: 1, data: {} });
  assert.equal(h.status.getSession(SESSION).status, SESSION_STATUS.RUNNING);

  h.emitControlError({ code: 'DSH_UNAVAILABLE' });
  assert.equal(h.status.getSession(SESSION).status, SESSION_STATUS.DISCONNECTED);
  await h.status.stop();
});

test('a restored transport resumes the real status rather than guessing', async () => {
  const h = await harness();
  await h.status.ensureFollow(SESSION);
  h.emitFollowEvent(SESSION, { type: 'turn/start', seq: 10, time: 1, data: {} });
  h.emitControlError({ code: 'DSH_UNAVAILABLE' });
  assert.equal(h.status.getSession(SESSION).status, SESSION_STATUS.DISCONNECTED);

  h.status.noteTransportRestored();
  assert.equal(h.status.getSession(SESSION).status, SESSION_STATUS.RUNNING, 'resumed, not guessed');
  await h.status.stop();
});

test('a restored transport resumes the suspended status, including waiting_input', async () => {
  // §15/§23 read together: the status is *suspended*, not destroyed. Restoring
  // `waiting_input` here is correct because the question really was pending when
  // the transport dropped — this process observed it.
  const h = await harness();
  await h.status.ensureFollow(SESSION);
  h.events.applySignal(SESSION, { signal: SIGNAL.WAITING_FOR_USER, sessionId: SESSION });
  assert.equal(h.status.getSession(SESSION).status, SESSION_STATUS.WAITING_INPUT);

  h.emitControlError({ code: 'DSH_UNAVAILABLE' });
  assert.equal(h.status.getSession(SESSION).status, SESSION_STATUS.DISCONNECTED);

  h.status.noteTransportRestored();
  assert.equal(h.status.getSession(SESSION).status, SESSION_STATUS.WAITING_INPUT, 'resumed, not guessed');
  await h.status.stop();
});

test('waiting_input is never invented for a session that never observed it', async () => {
  // §23 draws the line at *evidence in this process*. A session restored from a
  // fresh Gateway start has no pending-question evidence, and must not present
  // `waiting_input` — nor may its absence be reported as a settled `idle`.
  const h = await harness();
  await h.status.ensureFollow(SESSION);
  h.emitFollowEvent(SESSION, { type: 'turn/start', seq: 10, time: 1, data: {} });
  assert.equal(h.status.getSession(SESSION).status, SESSION_STATUS.RUNNING);

  h.emitControlError({ code: 'DSH_UNAVAILABLE' });
  h.status.noteTransportRestored();

  assert.notEqual(
    h.status.getSession(SESSION).status,
    SESSION_STATUS.WAITING_INPUT,
    'no pending-question evidence existed, so it must not appear',
  );
  assert.equal(h.status.getSession(SESSION).status, SESSION_STATUS.RUNNING, 'the real status resumes');
  await h.status.stop();
});

test('follow streams are deduplicated to at most one per session', async () => {
  const h = await harness();
  const first = await h.status.ensureFollow(SESSION);
  const second = await h.status.ensureFollow(SESSION);

  assert.equal(first, true);
  assert.equal(second, false, 'the second call is a no-op');
  assert.equal(h.status.followCount, 1);
  assert.equal(h.followSubscriptions.get(SESSION), 1, 'exactly one stream opened');
  await h.status.stop();
});

test('concurrent ensureFollow calls still open only one stream', async () => {
  const h = await harness();
  await Promise.all([
    h.status.ensureFollow(SESSION),
    h.status.ensureFollow(SESSION),
    h.status.ensureFollow(SESSION),
  ]);
  assert.equal(h.followSubscriptions.get(SESSION), 1);
  await h.status.stop();
});

test('an idle follow is released by the sweep', async () => {
  let now = 1_000_000;
  const h = await harness({ clock: () => now, followIdleMs: 100 });
  await h.status.ensureFollow(SESSION);
  assert.equal(h.status.followCount, 1);

  now += 99;
  assert.deepEqual(await h.status.sweepIdleFollows(), [], 'not yet idle');
  assert.equal(h.status.followCount, 1);

  now += 2;
  assert.deepEqual(await h.status.sweepIdleFollows(), [SESSION]);
  assert.equal(h.status.followCount, 0);
  await h.status.stop();
});

test('stop unsubscribes every control and follow stream', async () => {
  const h = await harness();
  await h.status.ensureFollow(SESSION);
  assert.equal(h.status.followCount, 1);

  await h.status.stop();
  assert.equal(h.status.followCount, 0);
  assert.equal(h.controlUnsubscribed, true, 'the control stream was released');
  assert.equal(h.liveFollows(), 0, 'every follow stream was released');
});

test('stop is idempotent and stops reopening streams', async () => {
  const h = await harness();
  await h.status.stop();
  await h.status.stop();
  assert.equal(await h.status.ensureFollow(SESSION), false, 'no stream opens after stop');
  assert.equal(h.status.followCount, 0);
});

test('the single most important invariant: cancel accepted is not cancelled', async () => {
  const h = await harness();
  await h.status.ensureFollow(SESSION);
  h.emitFollowEvent(SESSION, { type: 'turn/start', seq: 10, time: 1, data: {} });
  assert.equal(h.status.getSession(SESSION).status, SESSION_STATUS.RUNNING);

  h.events.applySignal(SESSION, { signal: SIGNAL.CANCEL_ACCEPTED, sessionId: SESSION });
  assert.equal(
    h.status.getSession(SESSION).status,
    SESSION_STATUS.RUNNING,
    'an admission receipt is not quiescence',
  );

  // Only observed abort evidence settles it.
  h.emitFollowEvent(SESSION, {
    type: 'turn/end',
    seq: 11,
    time: 2,
    data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
  });
  assert.equal(h.status.getSession(SESSION).status, SESSION_STATUS.CANCELLED);
  await h.status.stop();
});

test('the status service honours the domain/HTTP isolation rules', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../src/remote/status-service.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '');

  assert.equal(code.includes('wire/'), false, 'the status service must not import wire/');
  assert.equal(/session\/(list|prompt|follow|control|cancel|page)/.test(code), false, 'no DSH endpoint names');
});
