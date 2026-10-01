/**
 * Session status state machine — Phase R2 §12, §13.
 *
 * Every transition below names four things, as §13 requires:
 *
 *   source signal -> previous state(s) -> next state, with the evidence that
 *   justifies it recorded in `SIGNAL_EVIDENCE` / `docs/r2-status-evidence.md`
 *
 * Nothing here is inferred because it "looks reasonable". Where the audit found
 * no evidence, the transition does not exist — `turn/end {kind:'blocked'}` and
 * `approval/asked`-based waiting are simply absent, and a test asserts their
 * absence so a later phase cannot quietly add them.
 *
 * `disconnected` is special (§15): it is the Gateway's observation of the DSH
 * **transport**, not a property of the session. Losing the transport suspends the
 * real status rather than destroying it, so restoring the transport resumes the
 * session's true state instead of inventing one.
 */

import { SESSION_STATUS, isStatus } from '../model/status.mjs';
import { SIGNAL, assertSignal } from '../model/signals.mjs';

/** Outcome classification for an attempted transition. */
export const TRANSITION_OUTCOME = Object.freeze({
  APPLIED: 'applied',
  NO_CHANGE: 'no_change',
  INVALID: 'invalid',
  DUPLICATE: 'duplicate',
  OUT_OF_ORDER: 'out_of_order',
});

const { IDLE, QUEUED, RUNNING, WAITING_INPUT, COMPLETED, FAILED, CANCELLED, DISCONNECTED } = SESSION_STATUS;

/**
 * The transition table.
 *
 * `from` lists the states the signal is legal from. `to` is either a status or a
 * function of the machine's current context (used only by TRANSPORT_RESTORED,
 * which must resume rather than guess).
 */
export const TRANSITIONS = Object.freeze({
  [SIGNAL.SESSION_DISCOVERED]: Object.freeze({
    from: Object.freeze([IDLE, QUEUED, RUNNING, WAITING_INPUT, COMPLETED, FAILED, CANCELLED, DISCONNECTED]),
    to: null, // discovery never changes a status; it establishes the session.
    evidence: 'session/list row; api-session/added(summary)',
  }),
  [SIGNAL.PROMPT_ACCEPTED_QUEUE]: Object.freeze({
    from: Object.freeze([IDLE, WAITING_INPUT, COMPLETED, FAILED, CANCELLED, QUEUED, DISCONNECTED]),
    to: QUEUED,
    evidence: 'session/prompt({mode:"queue"}) accepted; durable user/message admitted',
  }),
  [SIGNAL.PROMPT_ACCEPTED_STEER]: Object.freeze({
    from: Object.freeze([IDLE, WAITING_INPUT, COMPLETED, FAILED, CANCELLED, QUEUED, RUNNING, DISCONNECTED]),
    to: RUNNING,
    evidence: 'session/prompt({mode:"steer"}) accepted; the live turn is steered rather than queued',
  }),
  [SIGNAL.RUN_STARTED]: Object.freeze({
    from: Object.freeze([IDLE, QUEUED, WAITING_INPUT, COMPLETED, FAILED, CANCELLED, DISCONNECTED]),
    to: RUNNING,
    evidence: 'turn/start; session/control jobs[id].status == "running"; api-session/status(id,true)',
  }),
  [SIGNAL.RUN_COMMITTED]: Object.freeze({
    from: Object.freeze([RUNNING, QUEUED]),
    to: COMPLETED,
    evidence: 'turn/end {kind:"completed"} — the closed, durable statement that the run finished normally',
  }),
  [SIGNAL.RUN_ABANDONED]: Object.freeze({
    from: Object.freeze([RUNNING, QUEUED, COMPLETED, FAILED, WAITING_INPUT, CANCELLED]),
    to: CANCELLED,
    evidence:
      'turn/end {kind:"aborted", reason} — the durable completion evidence that makes cancellation real. '
      + 'This is the ONLY path to `cancelled`; CANCEL_ACCEPTED is not sufficient (§16).',
  }),
  [SIGNAL.TASK_FAILED]: Object.freeze({
    from: Object.freeze([RUNNING, QUEUED, IDLE, WAITING_INPUT]),
    to: FAILED,
    evidence: 'turn/end {kind:"error", error}; api-session/error(id,message); jobs[id].status == "failed"',
  }),
  [SIGNAL.QUEUE_EMPTY]: Object.freeze({
    from: Object.freeze([QUEUED]),
    to: IDLE,
    evidence: 'session/control queues[id] empty with no running job',
  }),
  [SIGNAL.WAITING_FOR_USER]: Object.freeze({
    from: Object.freeze([IDLE, RUNNING, QUEUED, COMPLETED, WAITING_INPUT]),
    to: WAITING_INPUT,
    evidence: 'user-questions/request forwarded waterfall event (LIVE ONLY, never replayed)',
  }),
  [SIGNAL.CANCEL_ACCEPTED]: Object.freeze({
    // Deliberately NOT a transition to `cancelled` (§16). DSH returns an
    // admission receipt, not quiescence, and the queued inbox may survive.
    from: Object.freeze([RUNNING, QUEUED, IDLE, WAITING_INPUT, COMPLETED, FAILED, CANCELLED, DISCONNECTED]),
    to: null,
    evidence: 'session/cancel -> {accepted:true}. ADMISSION ONLY — no status change.',
  }),
  [SIGNAL.SESSION_COLD]: Object.freeze({
    from: Object.freeze([IDLE, QUEUED, RUNNING, WAITING_INPUT, COMPLETED, FAILED, CANCELLED, DISCONNECTED]),
    to: IDLE,
    evidence: 'session/cancel raised session/not-found (not attached): no live Agent exists, so nothing is running',
  }),
  [SIGNAL.TRANSPORT_LOST]: Object.freeze({
    from: Object.freeze([IDLE, QUEUED, RUNNING, WAITING_INPUT, COMPLETED, FAILED, CANCELLED, DISCONNECTED]),
    to: DISCONNECTED,
    evidence: 'Gateway observation of the DSH mux transport (§15). A phone disconnect is NOT this signal.',
  }),
  [SIGNAL.TRANSPORT_RESTORED]: Object.freeze({
    from: Object.freeze([DISCONNECTED]),
    to: null, // resolved from the suspended status, never guessed.
    evidence: 'Gateway observation: transport reachable again; resume the suspended status',
  }),
});

/**
 * Relative ordering used to reject a signal that arrives too late to be
 * meaningful. `disconnected` is exempt because transport state is orthogonal to
 * run progress and may change at any time.
 */
const SIGNAL_RANK = Object.freeze({
  [SIGNAL.SESSION_DISCOVERED]: 0,
  [SIGNAL.PROMPT_ACCEPTED_QUEUE]: 10,
  [SIGNAL.PROMPT_ACCEPTED_STEER]: 10,
  [SIGNAL.RUN_STARTED]: 20,
  [SIGNAL.QUEUE_EMPTY]: 25,
  [SIGNAL.CANCEL_ACCEPTED]: 30,
  [SIGNAL.RUN_COMMITTED]: 40,
  [SIGNAL.RUN_ABANDONED]: 40,
  [SIGNAL.TASK_FAILED]: 40,
  [SIGNAL.WAITING_FOR_USER]: 50,
  [SIGNAL.SESSION_COLD]: 60,
  [SIGNAL.TRANSPORT_LOST]: -1,
  [SIGNAL.TRANSPORT_RESTORED]: -1,
});

/** Signals treated as idempotent when they would not change the status. */
const IDEMPOTENT = Object.freeze(new Set([
  SIGNAL.CANCEL_ACCEPTED,
  SIGNAL.SESSION_DISCOVERED,
  SIGNAL.TRANSPORT_LOST,
  SIGNAL.TRANSPORT_RESTORED,
  SIGNAL.SESSION_COLD,
]));

/**
 * Per-session state machine.
 *
 * One instance tracks one session. Keeping it per-session avoids a shared map
 * and makes the "status belongs to a session" rule structural.
 */
export class SessionStateMachine {
  /**
   * @param {object} [options] - machine options.
   * @param {string} [options.initialStatus] - starting status; defaults to `idle`.
   */
  constructor(options = {}) {
    const initial = options.initialStatus ?? IDLE;
    if (!isStatus(initial)) throw new TypeError(`invalid initial status ${JSON.stringify(initial)}`);
    this.status = initial;
    /** Status suspended while the transport is down (§15). */
    this.suspendedStatus = null;
    /** Highest signal rank applied, for out-of-order rejection. */
    this.highestRank = -Infinity;
    /** Signals applied since the last status change, for duplicate detection. */
    this.recentSignals = [];
  }

  /**
   * Apply a normalized signal.
   *
   * @param {object|string} signal - a `SIGNAL` value, or a `makeSignal` object.
   * @returns {{outcome: string, signal: string, previous: string, status: string, reason: string|null}}
   *   the transition record.
   * @throws {TypeError} when the signal name is not in the vocabulary.
   */
  apply(signal) {
    const name = typeof signal === 'string' ? signal : signal?.signal;
    assertSignal(name);

    const previous = this.status;
    const rule = TRANSITIONS[name];

    if (IDEMPOTENT.has(name) && this.recentSignals.at(-1) === name) {
      return this.#record(TRANSITION_OUTCOME.DUPLICATE, name, previous, `duplicate ${name} ignored`);
    }

    const rank = SIGNAL_RANK[name] ?? 0;
    if (rank >= 0 && rank < this.highestRank) {
      this.recentSignals.push(name);
      return this.#record(
        TRANSITION_OUTCOME.OUT_OF_ORDER,
        name,
        previous,
        `signal rank ${rank} arrived after rank ${this.highestRank}`,
      );
    }

    if (rule === undefined) {
      return this.#record(TRANSITION_OUTCOME.INVALID, name, previous, `no transition rule for ${name}`);
    }

    if (!rule.from.includes(previous)) {
      return this.#record(
        TRANSITION_OUTCOME.INVALID,
        name,
        previous,
        `${name} is not legal from ${previous}`,
      );
    }

    let next = rule.to;

    if (name === SIGNAL.TRANSPORT_LOST) {
      // Suspend the true status so restore can resume it rather than guess (§15).
      this.suspendedStatus = previous === DISCONNECTED ? this.suspendedStatus : previous;
      if (previous === DISCONNECTED) {
        return this.#record(TRANSITION_OUTCOME.NO_CHANGE, name, previous, 'transport already down');
      }
      next = DISCONNECTED;
    }

    if (name === SIGNAL.TRANSPORT_RESTORED) {
      next = this.suspendedStatus ?? IDLE;
      this.suspendedStatus = null;
    }

    if (rank >= 0) this.highestRank = Math.max(this.highestRank, rank);
    this.recentSignals.push(name);
    if (this.recentSignals.length > 32) this.recentSignals.shift();

    if (next === null) {
      return this.#record(TRANSITION_OUTCOME.NO_CHANGE, name, previous, `${name} does not change status`);
    }

    if (next === previous) {
      return this.#record(TRANSITION_OUTCOME.NO_CHANGE, name, previous, `${name} leaves status at ${next}`);
    }

    this.status = next;
    return this.#record(TRANSITION_OUTCOME.APPLIED, name, previous, null);
  }

  /**
   * Build a transition record.
   *
   * @param {string} outcome - a `TRANSITION_OUTCOME` value.
   * @param {string} signal - the signal name.
   * @param {string} previous - status before.
   * @param {string|null} reason - why nothing changed, when applicable.
   * @returns {{outcome: string, signal: string, previous: string, status: string, reason: string|null}}
   *   the record.
   */
  #record(outcome, signal, previous, reason) {
    return { outcome, signal, previous, status: this.status, reason };
  }

  /**
   * Export machine state.
   *
   * `highestRank` is reported as `null` when no ranked signal has been seen,
   * rather than as `-Infinity`: `JSON.stringify(-Infinity)` produces `null`, so a
   * snapshot would otherwise not round-trip and a restored machine could reject
   * its first legitimate signal.
   *
   * @returns {{status: string, suspendedStatus: string|null, highestRank: number|null, recentSignals: string[]}}
   *   a plain, JSON-safe snapshot.
   */
  snapshot() {
    return {
      status: this.status,
      suspendedStatus: this.suspendedStatus,
      highestRank: this.highestRank === -Infinity ? null : this.highestRank,
      recentSignals: [...this.recentSignals],
    };
  }

  /**
   * Restore machine state from a snapshot.
   *
   * @param {object} snapshot - a snapshot from `snapshot()`.
   * @returns {SessionStateMachine} this machine.
   * @throws {TypeError} when the snapshot is malformed.
   */
  restore(snapshot) {
    if (snapshot === null || typeof snapshot !== 'object') {
      throw new TypeError('state machine snapshot must be an object');
    }
    if (!isStatus(snapshot.status)) {
      throw new TypeError(`snapshot.status is not a legal status: ${JSON.stringify(snapshot.status)}`);
    }
    if (snapshot.suspendedStatus !== null && snapshot.suspendedStatus !== undefined
      && !isStatus(snapshot.suspendedStatus)) {
      throw new TypeError('snapshot.suspendedStatus is not a legal status');
    }
    this.status = snapshot.status;
    this.suspendedStatus = snapshot.suspendedStatus ?? null;
    // `null` means "nothing ranked seen yet", which is the empty-machine default.
    this.highestRank = typeof snapshot.highestRank === 'number' ? snapshot.highestRank : -Infinity;
    this.recentSignals = Array.isArray(snapshot.recentSignals) ? [...snapshot.recentSignals] : [];
    return this;
  }
}

/**
 * Describe the transition table for a report or a capability document.
 *
 * @returns {object[]} one row per signal.
 */
export function describeTransitionTable() {
  return Object.entries(TRANSITIONS).map(([signal, rule]) => ({
    signal,
    from: [...rule.from],
    to: rule.to,
    evidence: rule.evidence,
    changesStatus: rule.to !== null,
  }));
}
