/**
 * Runtime status — Phase R7 §19, §39.
 *
 * `state/supervisor.json` is what `dsh-status.ps1` reads and what an operator uses to
 * tell "still starting" from "failed". It therefore has to be both **useful** and
 * **safe**: it names paths and PIDs, which an operator needs, and it must never
 * carry a token, a cookie, a digest or a launch token.
 *
 * Writes are atomic. A status file that is half-written during a crash would make
 * `dsh-status.ps1` report a state the supervisor was never in, which is worse than
 * reporting nothing.
 */

import fs from 'node:fs';
import path from 'node:path';

import { R7_ERROR, ProductionError, SUPERVISOR_STATE } from './production-config.mjs';

/** The status schema version. */
export const STATUS_VERSION = 1;

/** Fields that must never be written to the status file (§19). */
export const FORBIDDEN_STATUS_FIELDS = Object.freeze([
  'token',
  'cookie',
  'secret',
  'authorization',
  'digest',
  'hash',
  'launch_token',
  'launchtoken',
  'ticket',
  'prefix',
  'fingerprint',
]);

/**
 * The supervisor state machine.
 *
 * Transitions are declared rather than assumed, so an accidental `READY` from
 * `FAILED` is a programming error instead of a silent state corruption. `FAILED` is
 * absorbing: recovery is a fresh start, not a transition out of failure.
 */
export const STATE_TRANSITIONS = Object.freeze({
  [SUPERVISOR_STATE.STARTING]: [SUPERVISOR_STATE.BOOTSTRAPPING_DSH, SUPERVISOR_STATE.FAILED, SUPERVISOR_STATE.STOPPING],
  [SUPERVISOR_STATE.BOOTSTRAPPING_DSH]: [SUPERVISOR_STATE.STARTING_GATEWAY, SUPERVISOR_STATE.FAILED, SUPERVISOR_STATE.STOPPING, SUPERVISOR_STATE.RESTARTING],
  [SUPERVISOR_STATE.STARTING_GATEWAY]: [SUPERVISOR_STATE.READY, SUPERVISOR_STATE.FAILED, SUPERVISOR_STATE.STOPPING, SUPERVISOR_STATE.RESTARTING],
  [SUPERVISOR_STATE.READY]: [SUPERVISOR_STATE.RESTARTING, SUPERVISOR_STATE.STOPPING, SUPERVISOR_STATE.FAILED],
  [SUPERVISOR_STATE.RESTARTING]: [SUPERVISOR_STATE.BOOTSTRAPPING_DSH, SUPERVISOR_STATE.FAILED, SUPERVISOR_STATE.STOPPING],
  [SUPERVISOR_STATE.STOPPING]: [SUPERVISOR_STATE.STOPPED, SUPERVISOR_STATE.FAILED],
  [SUPERVISOR_STATE.STOPPED]: [SUPERVISOR_STATE.STARTING],
  [SUPERVISOR_STATE.FAILED]: [SUPERVISOR_STATE.STOPPING, SUPERVISOR_STATE.STARTING],
});

/**
 * Whether a state transition is permitted.
 *
 * @param {string} from - the current state.
 * @param {string} to - the target state.
 * @returns {boolean} true when permitted.
 */
export function canTransition(from, to) {
  if (from === to) return true;
  const allowed = STATE_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * The supervisor's persisted status.
 */
export class RuntimeStatus {
  /**
   * @param {object} options - status options.
   * @param {object} options.paths - the resolved `paths` block.
   * @param {string} [options.instanceId] - this supervisor's instance id.
   * @param {() => Date} [options.clock] - injectable clock.
   * @param {(record: object) => void} [options.onWrite] - an observer, for tests.
   */
  constructor(options) {
    this.paths = options.paths;
    this.instanceId = options.instanceId ?? null;
    this.clock = options.clock ?? (() => new Date());
    this.onWrite = options.onWrite ?? null;
    this.state = SUPERVISOR_STATE.STOPPED;
    this.history = [];
    this.record = {
      v: STATUS_VERSION,
      instance_id: this.instanceId,
      state: this.state,
      supervisor_pid: process.pid,
      dsh_pid: null,
      started_at: null,
      gateway: null,
      dsh: null,
      last_error_code: null,
      updated_at: null,
    };
  }

  /**
   * Transition to a new state and persist.
   *
   * @param {string} next - the target state.
   * @param {object} [fields] - extra fields to merge.
   * @returns {object} the written record.
   * @throws {ProductionError} on an illegal transition.
   */
  transition(next, fields = {}) {
    if (!canTransition(this.state, next)) {
      throw new ProductionError(
        R7_ERROR.PRODUCTION_SMOKE_FAILED,
        `illegal supervisor transition ${this.state} -> ${next}`,
      );
    }
    this.history.push({ from: this.state, to: next, at: this.clock().toISOString() });
    this.state = next;
    return this.write({ ...fields, state: next });
  }

  /**
   * Merge fields and persist.
   *
   * @param {object} [fields] - fields to merge.
   * @returns {object} the written record.
   * @throws {ProductionError} when a forbidden field is present.
   */
  write(fields = {}) {
    const merged = { ...this.record, ...sanitizeFields(fields), updated_at: this.clock().toISOString() };
    merged.instance_id = this.instanceId ?? merged.instance_id;
    merged.state = this.state;
    this.record = merged;
    writeAtomic(this.paths.supervisorJson, `${JSON.stringify(merged, null, 2)}\n`);
    this.onWrite?.(merged);
    return merged;
  }

  /**
   * Record a failure code without losing the reason.
   *
   * `FAILED` is set **and** the code is stored, because "it failed" is not actionable
   * while "it failed with `R7_DSH_BOOTSTRAP_TOKEN_UNRESOLVED`" is.
   *
   * @param {string} code - the error code.
   * @param {string} [detail] - a secret-free detail.
   * @returns {object} the written record.
   */
  fail(code, detail) {
    if (canTransition(this.state, SUPERVISOR_STATE.FAILED)) {
      return this.transition(SUPERVISOR_STATE.FAILED, {
        last_error_code: code,
        last_error_detail: detail ?? null,
      });
    }
    return this.write({ last_error_code: code, last_error_detail: detail ?? null });
  }

  /**
   * The current record, for reading back in-process.
   *
   * @returns {object} a copy.
   */
  snapshot() {
    return { ...this.record, history: this.history.slice(-20) };
  }
}

/**
 * Remove forbidden fields from a status payload.
 *
 * A denylist rather than an allowlist because §19's permitted fields will grow, and
 * a mistake in an allowlist drops a useful field silently while a mistake here is
 * caught by a test.
 *
 * @param {object} fields - the candidate fields.
 * @returns {object} the sanitized fields.
 * @throws {ProductionError} when a forbidden field is present.
 */
export function sanitizeFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const forbidden = FORBIDDEN_STATUS_FIELDS.some((word) => normalised.includes(word.replace(/[^a-z0-9]/g, '')));
    if (forbidden) {
      throw new ProductionError(R7_ERROR.PRODUCTION_SMOKE_FAILED, `the status field ${JSON.stringify(key)} may not be recorded`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Write a file atomically: write a temporary sibling, then rename over the target.
 *
 * @param {string} filePath - the target.
 * @param {string} text - the content.
 * @returns {void}
 */
export function writeAtomic(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}`;
  // Explicit UTF-8 without a BOM (§45).
  fs.writeFileSync(temp, text, { encoding: 'utf8' });
  fs.renameSync(temp, filePath);
}

/**
 * Read a status file.
 *
 * @param {string} filePath - the status file.
 * @returns {object|null} the parsed record, or `null` when absent or unreadable.
 */
export function readStatus(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Whether a status record claims a live, ready stack.
 *
 * Used by `dsh-start.ps1` to decide whether a supervisor is already running. A
 * `FAILED` record is deliberately **not** live: a failed supervisor must not block a
 * fresh start.
 *
 * @param {object|null} record - the status record.
 * @param {(pid: number) => boolean} [probe] - PID liveness probe.
 * @returns {boolean} true when a live supervisor appears to be running.
 */
export function isLiveSupervisor(record, probe) {
  if (record === null || typeof record !== 'object') return false;
  const state = record.state;
  if (state === SUPERVISOR_STATE.STOPPED || state === SUPERVISOR_STATE.FAILED) return false;
  const pid = record.supervisor_pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  if (typeof probe !== 'function') return true;
  return probe(pid) === true;
}
