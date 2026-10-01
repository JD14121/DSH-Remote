/**
 * Single-writer lock — Phase R5 §18, §19.
 *
 * R5 is the sole writer of durable state, so exactly one Gateway instance may own
 * a state root. The lock is created with an **exclusive create** (`wx`), which is
 * atomic on every platform Node supports.
 *
 * Staleness is decided conservatively:
 *
 *   - the owner is provably gone (`ESRCH`) → stale, quarantine and take over;
 *   - `EPERM` or anything else → treat as **alive** and refuse to start;
 *   - a matching PID in another process is not assumed to be ours.
 *
 * §18 accepts the cost of this: a recycled PID producing a false "locked" is a
 * safe failure, and far better than two writers corrupting one journal.
 *
 * **This module never kills a process.** It does not import `child_process`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { PERSISTENCE_ERROR, persistenceError } from './errors.mjs';
import { containedPath, statePaths } from './config.mjs';

/** How a lock acquisition resolved. */
export const LOCK_OUTCOME = Object.freeze({
  ACQUIRED: 'acquired',
  /** A stale lock was quarantined and the lock was then acquired. */
  RECOVERED: 'recovered',
  LOCKED: 'locked',
});

/**
 * Whether a PID is provably not running.
 *
 * @param {number} pid - the process id to probe.
 * @returns {{alive: boolean, provable: boolean, reason: string}} the decision.
 */
export function probeProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    // §18: an absent or unusable PID means "owner unknown", and an unknown owner
    // must be treated as alive. Reporting it as provably dead would let a second
    // writer steal a lock it cannot prove is stale.
    return { alive: true, provable: false, reason: 'owner unknown' };
  }
  if (pid === process.pid) {
    return { alive: true, provable: true, reason: 'this process' };
  }
  try {
    process.kill(pid, 0);
    return { alive: true, provable: true, reason: 'signal delivered' };
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return { alive: false, provable: true, reason: 'no such process' };
    }
    // EPERM means the process exists but belongs to someone else; anything else is
    // equally unprovable. §18 chooses the safe answer.
    return { alive: true, provable: false, reason: error?.code ?? 'unprovable' };
  }
}

/**
 * The writer lock for one state root.
 */
export class WriterLock {
  /**
   * @param {object} options - lock options.
   * @param {object} options.config - resolved persistence config.
   * @param {string} [options.instanceId] - this instance's identity.
   * @param {(pid: number) => object} [options.probe] - injectable liveness probe, for tests.
   */
  constructor(options) {
    if (options?.config === undefined) throw new TypeError('WriterLock requires a config');
    this.config = options.config;
    this.paths = statePaths(options.config);
    this.instanceId = options.instanceId ?? randomUUID();
    this.probe = options.probe ?? probeProcess;
    this.held = false;
    this.record = null;
    this.outcome = null;
    this.recoveredFrom = null;
  }

  /**
   * Acquire the lock, quarantining a provably stale one.
   *
   * @returns {{outcome: string, instanceId: string, recoveredFrom: object|null}} the result.
   * @throws {PersistenceError} `STATE_LOCKED` when another instance may be live.
   */
  acquire() {
    fs.mkdirSync(this.paths.stateDir, { recursive: true, mode: 0o700 });
    const lockPath = this.paths.lockFile;

    const record = {
      pid: process.pid,
      instance_id: this.instanceId,
      started_at: new Date().toISOString(),
    };

    const first = this.#tryCreate(lockPath, record);
    if (first === true) {
      this.held = true;
      this.record = record;
      this.outcome = LOCK_OUTCOME.ACQUIRED;
      return { outcome: this.outcome, instanceId: this.instanceId, recoveredFrom: null };
    }

    // The lock exists. Decide whether its owner can still be running.
    const existing = this.#read(lockPath);
    const probe = this.probe(existing?.pid);

    if (probe.alive || probe.provable === false) {
      throw persistenceError(PERSISTENCE_ERROR.LOCKED, {
        message: 'Another gateway instance already owns this state store.',
        details: { reason: probe.reason },
      });
    }

    // Provably stale. §18: quarantine it, never delete it in place, and never kill
    // the recorded PID.
    this.recoveredFrom = existing;
    this.#quarantine(lockPath, existing);

    const second = this.#tryCreate(lockPath, record);
    if (second !== true) {
      // Something else won the race between quarantine and create.
      throw persistenceError(PERSISTENCE_ERROR.LOCKED, {
        message: 'Another gateway instance acquired the state store first.',
      });
    }

    this.held = true;
    this.record = record;
    this.outcome = LOCK_OUTCOME.RECOVERED;
    return { outcome: this.outcome, instanceId: this.instanceId, recoveredFrom: existing };
  }

  /**
   * Attempt an exclusive create.
   *
   * @param {string} lockPath - the lock file.
   * @param {object} record - the record to write.
   * @returns {boolean} true when created.
   * @throws {PersistenceError} on a filesystem failure other than "exists".
   */
  #tryCreate(lockPath, record) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw persistenceError(PERSISTENCE_ERROR.UNAVAILABLE, {
        message: 'The state lock could not be created.',
        cause: error,
      });
    }
    try {
      fs.writeSync(fd, JSON.stringify(record), null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  }

  /**
   * Read the existing lock record.
   *
   * @param {string} lockPath - the lock file.
   * @returns {object|null} the record, or `null` when unreadable.
   */
  #read(lockPath) {
    try {
      const raw = fs.readFileSync(lockPath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' ? parsed : null;
    } catch {
      // An unreadable lock is treated as "owner unknown", which §18 says to treat
      // as alive. Returning `null` makes the probe report unprovable.
      return null;
    }
  }

  /**
   * Move a stale lock into quarantine.
   *
   * @param {string} lockPath - the lock file.
   * @param {object|null} existing - the stale record.
   * @returns {void}
   */
  #quarantine(lockPath, existing) {
    fs.mkdirSync(this.paths.staleLocksDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = containedPath(this.paths.staleLocksDir, `gateway-${stamp}-${randomUUID().slice(0, 8)}.lock`);
    try {
      fs.renameSync(lockPath, target);
    } catch (error) {
      if (error?.code === 'ENOENT') return; // someone else already moved it
      throw persistenceError(PERSISTENCE_ERROR.UNAVAILABLE, {
        message: 'A stale state lock could not be quarantined.',
        cause: error,
      });
    }
    // Leave a breadcrumb beside the quarantined lock so the reason is auditable.
    try {
      fs.writeFileSync(
        path.join(this.paths.staleLocksDir, `${path.basename(target)}.json`),
        JSON.stringify({ reason: 'pid-not-running', previous: existing, quarantined_at: new Date().toISOString() }),
        { encoding: 'utf8', mode: 0o600 },
      );
    } catch {
      // Evidence is best-effort; the lock is already safely out of the way.
    }
  }

  /**
   * Release the lock, but only if this instance still owns it.
   *
   * §19: never delete another instance's lock.
   *
   * @returns {boolean} true when the lock was removed.
   */
  release() {
    if (!this.held) return false;
    const current = this.#read(this.paths.lockFile);
    if (current === null || current.instance_id !== this.instanceId) {
      // Someone else owns it now. Removing it would break their exclusivity.
      this.held = false;
      return false;
    }
    try {
      fs.unlinkSync(this.paths.lockFile);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw persistenceError(PERSISTENCE_ERROR.UNAVAILABLE, {
          message: 'The state lock could not be released.',
          cause: error,
        });
      }
    }
    this.held = false;
    return true;
  }

  /**
   * The lock record currently on disk.
   *
   * @returns {object|null} the record.
   */
  current() {
    return this.#read(this.paths.lockFile);
  }
}

export { PERSISTENCE_ERROR };
