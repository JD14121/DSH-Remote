/**
 * Durable reconciliation checkpoint — Phase R5 §32, §35, §36.
 *
 * The checkpoint records the **highest DSH durable source sequence** reconciled for
 * a session. It must survive a Gateway restart, independent of the session
 * snapshot: §36 requires that the same durable DSH fact never produces a second
 * Gateway event, and §35 forbids advancing past a record that was not committed.
 *
 * It is deliberately not stored in the session snapshot. A snapshot is a
 * best-effort accelerator that may be absent, lagging, or discarded, whereas the
 * checkpoint is the idempotency key for reconciliation — so it gets its own file
 * with its own checksum, written synchronously the moment a commit succeeds.
 *
 * This is **not** the Gateway sequence. It never appears in a mobile projection
 * (§32); it exists only to know where DSH history resumes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { PERSISTENCE_ERROR, persistenceError } from './errors.mjs';
import { assertSafeSegment, containedPath, statePaths } from './config.mjs';

/** The checkpoint file name inside `state/`. */
export const CURSOR_FILE = 'dsh-cursors.json';

/** The checkpoint schema version. Distinct from the journal format version. */
export const CURSOR_FORMAT_VERSION = 1;

/**
 * The canonical checksum of a checkpoint payload.
 *
 * @param {number} version - the format version.
 * @param {object} cursors - sessionId → source sequence.
 * @returns {string} `sha256:<hex>`.
 */
function checkpointChecksum(version, cursors) {
  const sorted = Object.keys(cursors).sort();
  const canonical = JSON.stringify([version, sorted.map((key) => [key, cursors[key]])]);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/**
 * The reconciliation checkpoint store.
 */
export class CursorCheckpoint {
  /**
   * @param {object} options - store options.
   * @param {object} options.config - resolved persistence config.
   * @param {number} [options.version] - the format version to write.
   */
  constructor(options) {
    if (options?.config === undefined) throw new TypeError('CursorCheckpoint requires a config');
    this.config = options.config;
    this.paths = statePaths(options.config);
    this.file = containedPath(this.paths.stateDir, CURSOR_FILE);
    this.version = options.version ?? CURSOR_FORMAT_VERSION;
    /** @type {Map<string, number>} */
    this.cursors = new Map();
  }

  /**
   * Load the checkpoint, if present and valid.
   *
   * A damaged checkpoint is refused rather than ignored: silently dropping it would
   * let reconciliation re-emit facts that were already delivered, which §36 exists
   * to prevent.
   *
   * @returns {Map<string, number>} the loaded cursors.
   * @throws {PersistenceError} `STATE_SNAPSHOT_INVALID` when the file is unreadable.
   */
  load() {
    this.cursors = new Map();
    if (!fs.existsSync(this.file)) return this.cursors;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed?.v !== this.version || parsed?.cursors === null || typeof parsed?.cursors !== 'object') {
        throw new Error('unexpected shape');
      }
      if (parsed.checksum !== checkpointChecksum(parsed.v, parsed.cursors)) {
        throw new Error('checksum');
      }
      for (const [sessionId, cursor] of Object.entries(parsed.cursors)) {
        if (Number.isSafeInteger(cursor) && cursor >= 0) this.cursors.set(sessionId, cursor);
      }
      return this.cursors;
    } catch (error) {
      throw persistenceError(PERSISTENCE_ERROR.SNAPSHOT_INVALID, {
        message: 'The reconciliation checkpoint is unreadable.',
        cause: error,
      });
    }
  }

  /**
   * The recorded checkpoint for a session.
   *
   * @param {string} sessionId - the session.
   * @returns {number|null} the cursor, or `null`.
   */
  get(sessionId) {
    return this.cursors.has(sessionId) ? this.cursors.get(sessionId) : null;
  }

  /**
   * Record a checkpoint for a session and write it durably.
   *
   * @param {string} sessionId - the session.
   * @param {number} cursor - the highest committed DSH source sequence.
   * @returns {number} the stored value.
   * @throws {PersistenceError} `STATE_PATH_INVALID` on an unsafe session id.
   */
  set(sessionId, cursor) {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw persistenceError(PERSISTENCE_ERROR.PATH_INVALID, {
        message: 'A reconciliation checkpoint must be a non-negative integer.',
      });
    }
    assertSafeSegment(sessionId, 'session id');
    this.cursors.set(sessionId, cursor);
    this.flush();
    return cursor;
  }

  /**
   * Write the checkpoint to disk synchronously.
   *
   * Synchronous by design: the write happens between a successful journal commit
   * and the next record, so §35's "never advance past an uncommitted record" is
   * enforceable only if the checkpoint is durable before the loop continues.
   *
   * @returns {void}
   * @throws {PersistenceError} `PERSISTENCE_WRITE_FAILED` on any write failure.
   */
  flush() {
    fs.mkdirSync(this.paths.stateDir, { recursive: true, mode: 0o700 });
    const cursors = {};
    for (const key of [...this.cursors.keys()].sort()) cursors[key] = this.cursors.get(key);
    const payload = { v: this.version, cursors };
    const text = JSON.stringify({ ...payload, checksum: checkpointChecksum(this.version, cursors) });

    let fd;
    try {
      fd = fs.openSync(this.file, 'w', 0o600);
      fs.writeSync(fd, text, null, 'utf8');
      fs.fsyncSync(fd);
    } catch (error) {
      throw persistenceError(PERSISTENCE_ERROR.WRITE_FAILED, {
        message: 'The reconciliation checkpoint could not be written.',
        cause: error,
      });
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Already closed.
        }
      }
    }
  }
}
