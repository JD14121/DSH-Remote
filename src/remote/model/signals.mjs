/**
 * Normalized domain signals — Phase R2 §12, §13.
 *
 * The state machine consumes **only** these signals. Raw DSH event names never
 * reach it. That is the whole point of this module: it is the one place where a
 * DSH observation becomes a domain fact, and every entry carries the evidence
 * that justifies it.
 *
 * Sourced from `docs/r2-status-evidence.md`. A signal whose raw mapping is
 * UNRESOLVED in that audit is declared here with `supported: false` and MUST NOT
 * be emitted by production code — it exists so tests can drive the state machine
 * through normalized signals without faking a production raw mapping (§26.1).
 */

/**
 * Signal vocabulary.
 *
 * `supported` records whether the audit found real DSH evidence for the raw
 * mapping. `evidence` names the raw source, or says why there is none.
 */
export const SIGNAL = Object.freeze({
  SESSION_DISCOVERED: 'SESSION_DISCOVERED',
  PROMPT_ACCEPTED_QUEUE: 'PROMPT_ACCEPTED_QUEUE',
  PROMPT_ACCEPTED_STEER: 'PROMPT_ACCEPTED_STEER',
  RUN_STARTED: 'RUN_STARTED',
  RUN_COMMITTED: 'RUN_COMMITTED',
  RUN_ABANDONED: 'RUN_ABANDONED',
  QUEUE_EMPTY: 'QUEUE_EMPTY',
  WAITING_FOR_USER: 'WAITING_FOR_USER',
  TASK_FAILED: 'TASK_FAILED',
  CANCEL_ACCEPTED: 'CANCEL_ACCEPTED',
  TRANSPORT_LOST: 'TRANSPORT_LOST',
  TRANSPORT_RESTORED: 'TRANSPORT_RESTORED',
  SESSION_COLD: 'SESSION_COLD',
});

/** Every signal name. */
export const ALL_SIGNALS = Object.freeze(Object.values(SIGNAL));

/**
 * The evidence table: signal -> raw DSH source and support status.
 *
 * This mirrors `docs/r2-status-evidence.md` §3 and is asserted against by the
 * status-machine tests, so the audit and the code cannot drift apart.
 */
export const SIGNAL_EVIDENCE = Object.freeze({
  [SIGNAL.SESSION_DISCOVERED]: Object.freeze({
    supported: true,
    raw: 'session/list row; api-session/added(summary)',
    confidence: 'HIGH',
  }),
  [SIGNAL.PROMPT_ACCEPTED_QUEUE]: Object.freeze({
    supported: true,
    raw: 'session/prompt({mode:"queue"}) -> {accepted:true}; durable user/message',
    confidence: 'MEDIUM',
    note: 'Admission is the accept receipt; the durable user/message is the corroborating fact.',
  }),
  [SIGNAL.PROMPT_ACCEPTED_STEER]: Object.freeze({
    supported: true,
    raw: 'session/prompt({mode:"steer"}) -> {accepted:true}',
    confidence: 'MEDIUM',
  }),
  [SIGNAL.RUN_STARTED]: Object.freeze({
    supported: true,
    raw: 'turn/start; session/control jobs[id].status === "running"; api-session/status(id,true)',
    confidence: 'HIGH',
  }),
  [SIGNAL.RUN_COMMITTED]: Object.freeze({
    supported: true,
    raw: 'turn/end {kind:"completed"}',
    confidence: 'HIGH',
  }),
  [SIGNAL.RUN_ABANDONED]: Object.freeze({
    supported: true,
    raw:
      'turn/end {kind:"aborted", reason:{kind:"user"|"parent"|"hook"|"disposed"|"legacy"}}; '
      + 'session/control jobs[id].status === "killed"',
    confidence: 'HIGH',
  }),
  [SIGNAL.QUEUE_EMPTY]: Object.freeze({
    supported: true,
    raw: 'session/control queues[id] empty and no running job',
    confidence: 'HIGH',
  }),
  [SIGNAL.WAITING_FOR_USER]: Object.freeze({
    supported: true,
    raw: 'user-questions/request (forwarded waterfall event)',
    confidence: 'HIGH',
    note:
      'LIVE-ONLY: this event is not replayed on reconnect, so it cannot be reconstructed from '
      + 'durable history. approval/asked is explicitly NOT usable (declared log-only, no surfaceOp).',
  }),
  [SIGNAL.TASK_FAILED]: Object.freeze({
    supported: true,
    raw: 'turn/end {kind:"error", error}; api-session/error(id,message); session/control jobs[id].status === "failed"',
    confidence: 'HIGH',
  }),
  [SIGNAL.CANCEL_ACCEPTED]: Object.freeze({
    supported: true,
    raw: 'session/cancel -> {accepted:true}',
    confidence: 'HIGH',
    note: 'ADMISSION ONLY. This is explicitly not quiescence; see r2-status-evidence.md §5.',
  }),
  [SIGNAL.TRANSPORT_LOST]: Object.freeze({
    supported: true,
    raw: 'Gateway observation: the DSH mux socket closed or a call failed with DSH_UNAVAILABLE',
    confidence: 'HIGH',
    note: 'Gateway-owned. A phone-to-Gateway disconnect is NOT this signal.',
  }),
  [SIGNAL.TRANSPORT_RESTORED]: Object.freeze({
    supported: true,
    raw: 'Gateway observation: a fresh DSH snapshot arrived after a loss',
    confidence: 'HIGH',
  }),
  [SIGNAL.SESSION_COLD]: Object.freeze({
    supported: true,
    raw: 'session/cancel raised session/not-found (not attached) => no live Agent',
    confidence: 'HIGH',
  }),
});

/**
 * Signals the audit could NOT map, and therefore must never be emitted by
 * production code.
 *
 * They are listed so the limitation is explicit rather than forgotten, and a
 * test asserts none of them is in `SIGNAL`.
 */
export const UNRESOLVED_RAW_MAPPINGS = Object.freeze([
  Object.freeze({
    raw: 'turn/end {kind:"blocked"}',
    why: 'No documentation and no derivable status meaning. Mapping it would be invention.',
  }),
  Object.freeze({
    raw: 'turn/end {kind:"max-tokens"} as a terminal outcome',
    why: 'Documented as possibly continued by a plugin, so it is not terminal by itself.',
  }),
  Object.freeze({
    raw: 'approval/asked -> WAITING_FOR_USER',
    why: 'Declared log-only audit and explicitly NOT a surface event; unsafe to depend on.',
  }),
  Object.freeze({
    raw: 'durable reconstruction of a pending user question',
    why: 'The live signal is not replayed after reconnect, so a durable rebuild would be fabrication.',
  }),
]);

/**
 * Assert a value is a legal signal.
 *
 * @param {unknown} value - candidate.
 * @returns {string} the signal.
 * @throws {TypeError} when the value is not a known signal.
 */
export function assertSignal(value) {
  if (typeof value !== 'string' || !ALL_SIGNALS.includes(value)) {
    throw new TypeError(
      `unknown domain signal ${JSON.stringify(value)}; legal signals are ${ALL_SIGNALS.join(', ')}`,
    );
  }
  return value;
}

/**
 * Whether a signal has real DSH evidence behind it.
 *
 * Production code paths assert this; tests may construct unsupported signals to
 * prove the state machine rejects them.
 *
 * @param {string} signal - a legal signal.
 * @returns {boolean} true when the audit marked it supported.
 */
export function isSignalSupported(signal) {
  assertSignal(signal);
  return SIGNAL_EVIDENCE[signal].supported === true;
}

/**
 * Build a signal occurrence.
 *
 * @param {object} input - signal input.
 * @param {string} input.signal - a `SIGNAL` value.
 * @param {string} [input.sessionId] - the session the signal concerns.
 * @param {number|string|null} [input.sourceSequence] - DSH durable seq, when the raw source had one.
 * @param {number|string|null} [input.sourceTime] - DSH source time, when available.
 * @param {object} [input.evidence] - raw facts justifying the signal.
 * @returns {{signal: string, sessionId: string|null, sourceSequence: number|null, sourceTime: number|string|null, evidence: object}}
 *   the normalized occurrence.
 */
export function makeSignal(input) {
  assertSignal(input?.signal);
  const sourceSequence =
    typeof input.sourceSequence === 'number' && Number.isFinite(input.sourceSequence)
      ? input.sourceSequence
      : null;
  return {
    signal: input.signal,
    sessionId: input.sessionId ?? null,
    sourceSequence,
    sourceTime: input.sourceTime ?? null,
    evidence: input.evidence ?? {},
  };
}
