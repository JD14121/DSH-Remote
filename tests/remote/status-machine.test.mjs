/**
 * Status machine tests — R2 §11, §12, §13, §16, §26.1.
 *
 * Covers the required matrix: initial state, prompt queue/steer, run start,
 * run complete, run abandoned, cancel request, cancel observed completion,
 * failure, transport lost/restore, invalid transition, duplicate signal, and
 * out-of-order signal.
 *
 * Where a raw DSH mapping has no evidence, these tests drive the **normalized
 * signal** directly rather than faking a production raw mapping (§26.1).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALL_STATUSES,
  SESSION_STATUS,
  STATUS_COUNT,
  describeStatusVocabulary,
  isActive,
  isSettled,
  isStatus,
} from '../../src/remote/model/status.mjs';
import {
  ALL_SIGNALS,
  SIGNAL,
  SIGNAL_EVIDENCE,
  UNRESOLVED_RAW_MAPPINGS,
  isSignalSupported,
} from '../../src/remote/model/signals.mjs';
import {
  SessionStateMachine,
  TRANSITIONS,
  TRANSITION_OUTCOME,
  describeTransitionTable,
} from '../../src/remote/state/session-state-machine.mjs';

/** Build a machine and apply signals in order. */
function run(...signals) {
  const machine = new SessionStateMachine();
  const results = signals.map((signal) => machine.apply(signal));
  return { machine, results, last: results[results.length - 1] };
}

test('the vocabulary has exactly eight values and invents no ninth state', () => {
  assert.equal(STATUS_COUNT, 8);
  assert.equal(ALL_STATUSES.length, 8);
  assert.deepEqual([...ALL_STATUSES].sort(), [
    'cancelled',
    'completed',
    'disconnected',
    'failed',
    'idle',
    'queued',
    'running',
    'waiting_input',
  ]);

  // The specification inconsistency is recorded, not silently resolved.
  const described = describeStatusVocabulary();
  assert.equal(described.count, 8);
  assert.match(described.note, /nine states/i);
  assert.match(described.note, /INVENTS NO NINTH STATE/);
});

test('the only statuses are the eight; anything else is rejected', () => {
  for (const status of ALL_STATUSES) assert.equal(isStatus(status), true);
  for (const bad of ['ninth', 'COMPLETED', '', null, undefined, 8]) {
    assert.equal(isStatus(bad), false, `${JSON.stringify(bad)} must not be a status`);
  }
  assert.throws(() => new SessionStateMachine({ initialStatus: 'ninth' }), TypeError);
});

test('the initial state is idle', () => {
  const machine = new SessionStateMachine();
  assert.equal(machine.status, SESSION_STATUS.IDLE);
});

test('prompt queue moves to queued, from the settled and idle states', () => {
  for (const from of [SESSION_STATUS.IDLE, SESSION_STATUS.WAITING_INPUT, SESSION_STATUS.COMPLETED, SESSION_STATUS.FAILED, SESSION_STATUS.CANCELLED]) {
    const machine = new SessionStateMachine({ initialStatus: from });
    const result = machine.apply(SIGNAL.PROMPT_ACCEPTED_QUEUE);
    assert.equal(result.outcome, TRANSITION_OUTCOME.APPLIED, `from ${from}`);
    assert.equal(result.previous, from);
    assert.equal(machine.status, SESSION_STATUS.QUEUED);
  }
});

test('prompt steer moves straight to running', () => {
  const machine = new SessionStateMachine();
  machine.apply(SIGNAL.PROMPT_ACCEPTED_STEER);
  assert.equal(machine.status, SESSION_STATUS.RUNNING);
});

test('run start moves to running from every non-active state', () => {
  for (const from of [SESSION_STATUS.IDLE, SESSION_STATUS.QUEUED, SESSION_STATUS.WAITING_INPUT, SESSION_STATUS.COMPLETED, SESSION_STATUS.FAILED, SESSION_STATUS.CANCELLED]) {
    const machine = new SessionStateMachine({ initialStatus: from });
    machine.apply(SIGNAL.RUN_STARTED);
    assert.equal(machine.status, SESSION_STATUS.RUNNING, `from ${from}`);
  }
});

test('run committed settles on completed', () => {
  const { machine, last } = run(SIGNAL.RUN_STARTED, SIGNAL.RUN_COMMITTED);
  assert.equal(last.outcome, TRANSITION_OUTCOME.APPLIED);
  assert.equal(machine.status, SESSION_STATUS.COMPLETED);
  assert.equal(isSettled(machine.status), true);
});

test('run abandoned settles on cancelled', () => {
  const { machine } = run(SIGNAL.RUN_STARTED, SIGNAL.RUN_ABANDONED);
  assert.equal(machine.status, SESSION_STATUS.CANCELLED);
});

test('cancel accepted alone never produces cancelled from any OTHER state', () => {
  // §16: DSH returns an admission receipt, not quiescence. This is the single
  // most important negative property in the state machine.
  for (const from of ALL_STATUSES) {
    if (from === SESSION_STATUS.CANCELLED) continue; // already there; nothing to prove
    const machine = new SessionStateMachine({ initialStatus: from });
    const result = machine.apply(SIGNAL.CANCEL_ACCEPTED);
    assert.notEqual(machine.status, SESSION_STATUS.CANCELLED, `cancel from ${from} must not settle`);
    assert.ok(
      result.outcome === TRANSITION_OUTCOME.NO_CHANGE || result.outcome === TRANSITION_OUTCOME.DUPLICATE,
      `cancel from ${from} produced ${result.outcome}`,
    );
  }

  // And from `cancelled` it is inert: the status never moves.
  const machine = new SessionStateMachine({ initialStatus: SESSION_STATUS.CANCELLED });
  machine.apply(SIGNAL.CANCEL_ACCEPTED);
  assert.equal(machine.status, SESSION_STATUS.CANCELLED);
});

test('cancelled is reached only through observed completion evidence', () => {
  // The realistic sequence: running -> cancel admitted -> durable abort observed.
  const machine = new SessionStateMachine();
  machine.apply(SIGNAL.RUN_STARTED);
  const admitted = machine.apply(SIGNAL.CANCEL_ACCEPTED);
  assert.equal(machine.status, SESSION_STATUS.RUNNING, 'the agent is still winding down');
  assert.equal(admitted.outcome, TRANSITION_OUTCOME.NO_CHANGE);

  const observed = machine.apply(SIGNAL.RUN_ABANDONED);
  assert.equal(observed.outcome, TRANSITION_OUTCOME.APPLIED);
  assert.equal(machine.status, SESSION_STATUS.CANCELLED);
});

test('a cancel that does not take effect still settles on the real outcome', () => {
  const machine = new SessionStateMachine();
  machine.apply(SIGNAL.RUN_STARTED);
  machine.apply(SIGNAL.CANCEL_ACCEPTED);
  // The turn actually committed despite the request.
  machine.apply(SIGNAL.RUN_COMMITTED);
  assert.equal(machine.status, SESSION_STATUS.COMPLETED);
});

test('failure settles on failed', () => {
  const { machine } = run(SIGNAL.RUN_STARTED, SIGNAL.TASK_FAILED);
  assert.equal(machine.status, SESSION_STATUS.FAILED);
});

test('transport lost suspends the real status and restore resumes it', () => {
  const machine = new SessionStateMachine();
  machine.apply(SIGNAL.RUN_STARTED);
  assert.equal(machine.status, SESSION_STATUS.RUNNING);

  machine.apply(SIGNAL.TRANSPORT_LOST);
  assert.equal(machine.status, SESSION_STATUS.DISCONNECTED);

  const restored = machine.apply(SIGNAL.TRANSPORT_RESTORED);
  assert.equal(restored.outcome, TRANSITION_OUTCOME.APPLIED);
  assert.equal(machine.status, SESSION_STATUS.RUNNING, 'restore must resume, not guess');
});

test('transport restore from a settled status resumes that settled status', () => {
  const machine = new SessionStateMachine();
  machine.apply(SIGNAL.RUN_STARTED);
  machine.apply(SIGNAL.RUN_COMMITTED);
  machine.apply(SIGNAL.TRANSPORT_LOST);
  machine.apply(SIGNAL.TRANSPORT_RESTORED);
  assert.equal(machine.status, SESSION_STATUS.COMPLETED);
});

test('a duplicated transport loss is idempotent', () => {
  const machine = new SessionStateMachine();
  machine.apply(SIGNAL.RUN_STARTED);
  machine.apply(SIGNAL.TRANSPORT_LOST);
  const second = machine.apply(SIGNAL.TRANSPORT_LOST);
  assert.equal(second.outcome, TRANSITION_OUTCOME.DUPLICATE);
  assert.equal(machine.status, SESSION_STATUS.DISCONNECTED);

  machine.apply(SIGNAL.TRANSPORT_RESTORED);
  assert.equal(machine.status, SESSION_STATUS.RUNNING);
});

test('waiting for the user moves to waiting_input', () => {
  const machine = new SessionStateMachine();
  machine.apply(SIGNAL.WAITING_FOR_USER);
  assert.equal(machine.status, SESSION_STATUS.WAITING_INPUT);
});

test('a cold session reports idle because no Agent is running', () => {
  const machine = new SessionStateMachine({ initialStatus: SESSION_STATUS.RUNNING });
  machine.apply(SIGNAL.SESSION_COLD);
  assert.equal(machine.status, SESSION_STATUS.IDLE);
});

test('queue empty returns a queued session to idle', () => {
  const machine = new SessionStateMachine();
  machine.apply(SIGNAL.PROMPT_ACCEPTED_QUEUE);
  machine.apply(SIGNAL.QUEUE_EMPTY);
  assert.equal(machine.status, SESSION_STATUS.IDLE);
});

test('an invalid transition is refused and reports why', () => {
  const machine = new SessionStateMachine({ initialStatus: SESSION_STATUS.IDLE });
  const result = machine.apply(SIGNAL.RUN_COMMITTED);
  assert.equal(result.outcome, TRANSITION_OUTCOME.INVALID);
  assert.equal(result.status, SESSION_STATUS.IDLE, 'the status must be untouched');
  assert.match(result.reason, /not legal from idle/);
});

test('an idempotent signal repeated back to back is reported as duplicate', () => {
  // Duplicate detection applies to signals that are legitimately repeatable.
  // (A repeated RUN_STARTED while already running is INVALID, not a duplicate:
  // running -> running is not a legal transition, and the machine says so.)
  const machine = new SessionStateMachine();
  machine.apply(SIGNAL.RUN_STARTED);

  const first = machine.apply(SIGNAL.CANCEL_ACCEPTED);
  assert.equal(first.outcome, TRANSITION_OUTCOME.NO_CHANGE);

  const second = machine.apply(SIGNAL.CANCEL_ACCEPTED);
  assert.equal(second.outcome, TRANSITION_OUTCOME.DUPLICATE);
  assert.match(second.reason, /duplicate/);
  assert.equal(machine.status, SESSION_STATUS.RUNNING);
});

test('a repeated run start while already running is invalid, not silently merged', () => {
  const machine = new SessionStateMachine();
  machine.apply(SIGNAL.RUN_STARTED);
  const again = machine.apply(SIGNAL.RUN_STARTED);
  assert.equal(again.outcome, TRANSITION_OUTCOME.INVALID);
  assert.equal(machine.status, SESSION_STATUS.RUNNING);
});

test('an out-of-order signal is rejected rather than rewinding state', () => {
  const machine = new SessionStateMachine();
  machine.apply(SIGNAL.RUN_STARTED);
  machine.apply(SIGNAL.RUN_COMMITTED);
  assert.equal(machine.status, SESSION_STATUS.COMPLETED);

  // A late RUN_STARTED has a lower rank than the committed outcome already seen.
  const late = machine.apply(SIGNAL.RUN_STARTED);
  assert.equal(late.outcome, TRANSITION_OUTCOME.OUT_OF_ORDER);
  assert.equal(machine.status, SESSION_STATUS.COMPLETED, 'state must not rewind');
  assert.match(late.reason, /arrived after rank/);
});

test('an unknown signal fails closed', () => {
  const machine = new SessionStateMachine();
  assert.throws(() => machine.apply('NOT_A_SIGNAL'), TypeError);
  assert.throws(() => machine.apply(undefined), TypeError);
  assert.throws(() => machine.apply({ signal: 'NOPE' }), TypeError);
});

test('the transition table documents evidence for every transition', () => {
  const table = describeTransitionTable();
  assert.ok(table.length > 0);

  for (const row of table) {
    assert.equal(typeof row.signal, 'string');
    assert.ok(Array.isArray(row.from) && row.from.length > 0, `${row.signal} must list source states`);
    assert.equal(typeof row.evidence, 'string');
    assert.ok(row.evidence.length > 20, `${row.signal} must cite real evidence`);
    for (const status of row.from) {
      assert.equal(isStatus(status), true, `${row.signal} lists an illegal source status ${status}`);
    }
    if (row.to !== null) {
      assert.equal(isStatus(row.to), true, `${row.signal} targets an illegal status`);
    }
  }

  // Every signal in the vocabulary has a rule.
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...ALL_SIGNALS].sort());
});

test('every signal carries an audit entry, and unsupported ones are explicit', () => {
  for (const signal of ALL_SIGNALS) {
    assert.ok(SIGNAL_EVIDENCE[signal], `${signal} must have an evidence entry`);
    assert.equal(typeof SIGNAL_EVIDENCE[signal].raw, 'string');
    assert.ok(SIGNAL_EVIDENCE[signal].raw.length > 0, `${signal} must name its raw source`);
  }
  // Every signal R2 uses has real evidence.
  for (const signal of ALL_SIGNALS) {
    assert.equal(isSignalSupported(signal), true, `${signal} must be evidence-backed`);
  }
});

test('the unresolved raw mappings are recorded and never became signals', () => {
  assert.ok(UNRESOLVED_RAW_MAPPINGS.length >= 4);
  for (const entry of UNRESOLVED_RAW_MAPPINGS) {
    assert.ok(entry.raw.length > 0);
    assert.ok(entry.why.length > 20, 'each unresolved mapping must explain why');
  }

  // `blocked` and `max-tokens` have no signal, so they cannot drive a transition.
  const signalNames = ALL_SIGNALS.join(' ');
  assert.equal(/BLOCKED/.test(signalNames), false, 'there must be no BLOCKED signal');
  assert.equal(/MAX_TOKENS/.test(signalNames), false, 'there must be no MAX_TOKENS signal');
  assert.equal(/APPROVAL/.test(signalNames), false, 'approval must not drive waiting_input');
});

test('active and settled classification is consistent with the vocabulary', () => {
  assert.equal(isActive(SESSION_STATUS.RUNNING), true);
  assert.equal(isActive(SESSION_STATUS.QUEUED), true);
  assert.equal(isActive(SESSION_STATUS.IDLE), false);

  assert.equal(isSettled(SESSION_STATUS.COMPLETED), true);
  assert.equal(isSettled(SESSION_STATUS.FAILED), true);
  assert.equal(isSettled(SESSION_STATUS.CANCELLED), true);
  assert.equal(isSettled(SESSION_STATUS.RUNNING), false);
  assert.equal(isSettled(SESSION_STATUS.DISCONNECTED), false);
});

test('a state machine round-trips through snapshot and restore', () => {
  const machine = new SessionStateMachine();
  machine.apply(SIGNAL.RUN_STARTED);
  machine.apply(SIGNAL.TRANSPORT_LOST);

  const snapshot = machine.snapshot();
  const restored = new SessionStateMachine();
  restored.restore(snapshot);

  assert.equal(restored.status, machine.status);
  assert.equal(restored.suspendedStatus, SESSION_STATUS.RUNNING);
  restored.apply(SIGNAL.TRANSPORT_RESTORED);
  assert.equal(restored.status, SESSION_STATUS.RUNNING);
});

test('a malformed state machine snapshot fails closed', () => {
  const machine = new SessionStateMachine();
  assert.throws(() => machine.restore(null), TypeError);
  assert.throws(() => machine.restore({ status: 'ninth' }), TypeError);
  assert.throws(() => machine.restore({ status: 'idle', suspendedStatus: 'ninth' }), TypeError);
});
