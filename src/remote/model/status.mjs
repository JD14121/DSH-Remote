/**
 * Status vocabulary — Phase R2 §11.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ SPECIFICATION INCONSISTENCY, RECORDED DELIBERATELY (R2 §11.2)            │
 * │                                                                          │
 * │ The task book calls this the "nine-state" (九状态) machine, and R0 §3.2   │
 * │ and R1 §12 reproduced that wording. The enumeration it actually gives is │
 * │ **eight** values. This module takes the enumeration as authoritative,    │
 * │ sets STATUS_COUNT = 8, and invents no ninth state.                       │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Evidence for each value is in `docs/r2-status-evidence.md`. Only statuses with
 * a SUPPORTED mapping there may be produced by the state machine.
 */

/** The eight legal statuses. */
export const SESSION_STATUS = Object.freeze({
  IDLE: 'idle',
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING_INPUT: 'waiting_input',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  DISCONNECTED: 'disconnected',
});

/** Every legal status value, in vocabulary order. */
export const ALL_STATUSES = Object.freeze(Object.values(SESSION_STATUS));

/**
 * The real count. The prose says nine; the enum has eight. See the banner above.
 */
export const STATUS_COUNT = ALL_STATUSES.length;

/** The only status a session may be created in before any evidence exists. */
export const INITIAL_STATUS = SESSION_STATUS.IDLE;

/**
 * Statuses that represent a settled outcome of the last run.
 *
 * Note that none of these is *final* for the session: a later prompt moves the
 * session back to `queued`/`running`. "Terminal" here means "the previous run's
 * outcome is known", nothing more.
 */
export const SETTLED_STATUSES = Object.freeze([
  SESSION_STATUS.COMPLETED,
  SESSION_STATUS.FAILED,
  SESSION_STATUS.CANCELLED,
]);

/** Statuses in which the Agent is doing work. */
export const ACTIVE_STATUSES = Object.freeze([SESSION_STATUS.RUNNING, SESSION_STATUS.QUEUED]);

/**
 * Whether a value is a legal status.
 *
 * @param {unknown} value - candidate.
 * @returns {boolean} true when the value is one of the eight.
 */
export function isStatus(value) {
  return typeof value === 'string' && ALL_STATUSES.includes(value);
}

/**
 * Assert a value is a legal status.
 *
 * @param {unknown} value - candidate.
 * @returns {string} the status.
 * @throws {TypeError} when the value is not one of the eight.
 */
export function assertStatus(value) {
  if (!isStatus(value)) {
    throw new TypeError(
      `unknown session status ${JSON.stringify(value)}; legal values are ${ALL_STATUSES.join(', ')}`,
    );
  }
  return value;
}

/**
 * Whether a status is a settled run outcome.
 *
 * @param {string} status - a legal status.
 * @returns {boolean} true for completed/failed/cancelled.
 */
export function isSettled(status) {
  return SETTLED_STATUSES.includes(status);
}

/**
 * Whether the Agent is busy in this status.
 *
 * @param {string} status - a legal status.
 * @returns {boolean} true for running/queued.
 */
export function isActive(status) {
  return ACTIVE_STATUSES.includes(status);
}

/**
 * Describe the vocabulary for a report or an API capability document.
 *
 * @returns {{count: number, values: string[], note: string}} the vocabulary.
 */
export function describeStatusVocabulary() {
  return {
    count: STATUS_COUNT,
    values: [...ALL_STATUSES],
    note:
      'Specification prose says "nine states"; the enumeration contains eight unique values. '
      + 'R2 uses the enumeration and INVENTS NO NINTH STATE.',
  };
}
