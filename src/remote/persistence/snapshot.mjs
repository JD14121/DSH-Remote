/**
 * Dual-slot session snapshot store — Phase R5 §22, §23, §24, §42.
 *
 * The journal is the replay authority; a snapshot is only a **recovery
 * accelerator** (§2, §23). Two slots are written alternately, so a crash during a
 * write can damage at most one of them.
 *
 * §24 is the subtle part: a snapshot must not restore a stale runtime status. A
 * Gateway that was stopped while a session was `running`, `queued` or
 * `waiting_input` cannot know what DSH did in the meantime, so the stable metadata
 * is restored and the live status is deliberately **not**.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { PERSISTENCE_ERROR, persistenceError } from './errors.mjs';
import { PERSISTENCE_FORMAT_VERSION, statePaths } from './config.mjs';

/** Snapshot fields that are safe to restore (§24). */
export const STABLE_SESSION_FIELDS = Object.freeze([
  'id',
  'title',
  'created_at',
  'updated_at',
  'workspace_id',
  'workspace_key',
  'workspace_name',
  'cwd',
]);

/** Runtime statuses that must never be restored as current (§24, §25, §53). */
export const UNSAFE_RESTORED_STATUSES = Object.freeze(['running', 'queued', 'waiting_input']);

/**
 * The checksum of a snapshot's canonical payload.
 *
 * @param {object} input - the snapshot fields.
 * @returns {string} `sha256:<hex>`.
 */
function snapshotChecksum(input) {
  const canonical = JSON.stringify([input.v, input.generation, input.written_at, input.sessions]);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/**
 * Project a live session view onto the stable, persistable field set.
 *
 * @param {object} session - a domain session view.
 * @returns {object} the persistable record.
 */
export function toPersistableSession(session) {
  const out = {};
  for (const field of STABLE_SESSION_FIELDS) {
    if (session[field] !== undefined) out[field] = session[field];
  }
  // The Gateway sequence is durable via the journal, but recording it lets a
  // recovery detect a snapshot that claims more progress than the journal proves.
  out.last_sequence = Number.isSafeInteger(session.last_sequence) ? session.last_sequence : 0;
  // §32: the DSH durable cursor is persisted for downtime reconciliation. It is
  // not a Gateway sequence and never appears in a mobile projection.
  out.dsh_cursor = Number.isSafeInteger(session.dsh_cursor) ? session.dsh_cursor : null;
  // §24: the last *known* status is retained as internal metadata only, so an
  // operator can see why a session looked a certain way. It is never applied as
  // current state.
  if (typeof session.status === 'string') out.last_known_status = session.status;
  return out;
}

/**
 * Restore a persistable record into a session view, refusing a stale runtime status.
 *
 * @param {object} record - a persistable session.
 * @param {object} [options] - restore options.
 * @param {string} [options.status] - the status to apply; defaults to `disconnected`.
 * @returns {object} the restored session view.
 */
export function fromPersistedSession(record, options = {}) {
  const restored = {
    id: record.id,
    title: record.title ?? null,
    status: options.status ?? 'disconnected',
    created_at: record.created_at ?? null,
    updated_at: record.updated_at ?? null,
    last_sequence: Number.isSafeInteger(record.last_sequence) ? record.last_sequence : 0,
    running: false,
  };
  if (record.workspace_id !== undefined) restored.workspace_id = record.workspace_id;
  if (record.workspace_key !== undefined) restored.workspace_key = record.workspace_key;
  if (record.workspace_name !== undefined) restored.workspace_name = record.workspace_name;
  if (record.cwd !== undefined) restored.cwd = record.cwd;
  restored.metadata = {
    recovered: true,
    ...(Number.isSafeInteger(record.dsh_cursor) ? { dsh_cursor: record.dsh_cursor } : {}),
    ...(typeof record.last_known_status === 'string' ? { last_known_status: record.last_known_status } : {}),
  };
  return restored;
}

/**
 * The A/B snapshot store.
 */
export class SnapshotStore {
  /**
   * @param {object} options - store options.
   * @param {object} options.config - resolved persistence config.
   * @param {() => number} [options.clock] - injectable clock.
   */
  constructor(options) {
    if (options?.config === undefined) throw new TypeError('SnapshotStore requires a config');
    this.config = options.config;
    this.paths = statePaths(options.config);
    this.clock = options.clock ?? Date.now;
    this.generation = 0;
    /** Index of the slot to write next. */
    this.nextSlot = 0;
    this.lastWritten = null;
  }

  /**
   * Prepare the state directory.
   *
   * @returns {void}
   */
  ensure() {
    fs.mkdirSync(this.paths.stateDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Write a snapshot into the inactive slot, then swap (§22).
   *
   * @param {readonly object[]} sessions - the session views.
   * @returns {{generation: number, slot: number, bytes: number, sessions: number}} the write result.
   * @throws {PersistenceError} `STATE_SNAPSHOT_INVALID` on a write failure.
   */
  write(sessions) {
    this.ensure();
    const generation = this.generation + 1;
    const writtenAt = new Date(this.clock()).toISOString();
    const persistable = sessions.map(toPersistableSession);

    const payload = {
      v: PERSISTENCE_FORMAT_VERSION,
      generation,
      written_at: writtenAt,
      sessions: persistable,
    };
    const snapshot = { ...payload, checksum: snapshotChecksum(payload) };
    const text = JSON.stringify(snapshot);
    const target = this.paths.snapshotSlots[this.nextSlot];

    // §22: truncate/write/flush/close on the inactive slot, so a crash mid-write
    // leaves the other slot intact.
    let fd;
    try {
      fd = fs.openSync(target, 'w', 0o600);
      fs.writeSync(fd, text, null, 'utf8');
      fs.fsyncSync(fd);
    } catch (error) {
      throw persistenceError(PERSISTENCE_ERROR.SNAPSHOT_INVALID, {
        message: 'The session snapshot could not be written.',
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

    this.generation = generation;
    this.lastWritten = { generation, slot: this.nextSlot, bytes: Buffer.byteLength(text, 'utf8') };
    this.nextSlot = (this.nextSlot + 1) % this.paths.snapshotSlots.length;
    return { ...this.lastWritten, sessions: persistable.length };
  }

  /**
   * Validate one slot.
   *
   * @param {number} slot - the slot index.
   * @returns {{ok: boolean, snapshot: object|null, reason: string|null}} the result.
   */
  #readSlot(slot) {
    const target = this.paths.snapshotSlots[slot];
    if (!fs.existsSync(target)) return { ok: false, snapshot: null, reason: 'absent' };
    try {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (parsed === null || typeof parsed !== 'object') return { ok: false, snapshot: null, reason: 'not an object' };
      if (parsed.v !== PERSISTENCE_FORMAT_VERSION) return { ok: false, snapshot: null, reason: 'version' };
      if (!Number.isSafeInteger(parsed.generation) || parsed.generation < 1) {
        return { ok: false, snapshot: null, reason: 'generation' };
      }
      if (!Array.isArray(parsed.sessions)) return { ok: false, snapshot: null, reason: 'sessions' };
      const expected = snapshotChecksum({
        v: parsed.v,
        generation: parsed.generation,
        written_at: parsed.written_at,
        sessions: parsed.sessions,
      });
      if (parsed.checksum !== expected) return { ok: false, snapshot: null, reason: 'checksum' };
      return { ok: true, snapshot: parsed, reason: null };
    } catch {
      return { ok: false, snapshot: null, reason: 'unreadable' };
    }
  }

  /**
   * Load the highest valid generation from either slot (§22).
   *
   * A snapshot behind the journal is legal and the journal tail fills the gap
   * (§23). A snapshot *ahead* of the journal is an integrity violation and fails
   * closed.
   *
   * @param {object} [options] - load options.
   * @param {(sessionId: string) => number|null} [options.journalHighWater] - the journal's high-water mark.
   * @returns {{snapshot: object|null, slot: number|null, generation: number, rejected: object[], repaired: boolean}}
   *   the load result.
   * @throws {PersistenceError} `STATE_AHEAD_OF_JOURNAL`.
   */
  load(options = {}) {
    const rejected = [];
    let best = null;
    let bestSlot = null;

    for (const [slot] of this.paths.snapshotSlots.entries()) {
      const result = this.#readSlot(slot);
      if (!result.ok) {
        rejected.push({ slot, reason: result.reason });
        continue;
      }
      if (best === null || result.snapshot.generation > best.generation) {
        best = result.snapshot;
        bestSlot = slot;
      }
    }

    if (best === null) {
      // §47: both slots unusable. The journal still holds every event, so recovery
      // reconstructs a minimal view rather than refusing to start.
      this.generation = 0;
      return { snapshot: null, slot: null, generation: 0, rejected, repaired: true };
    }

    if (typeof options.journalHighWater === 'function') {
      for (const record of best.sessions) {
        const journalMark = options.journalHighWater(record.id);
        const claimed = Number.isSafeInteger(record.last_sequence) ? record.last_sequence : 0;
        if (journalMark !== null && claimed > journalMark) {
          // §23: this cannot be repaired by reading more journal — it is a
          // contradiction, so it fails closed.
          throw persistenceError(PERSISTENCE_ERROR.AHEAD_OF_JOURNAL, {
            message: 'The session snapshot claims more progress than the journal proves.',
            details: { sessionId: record.id, claimed, journalMark },
          });
        }
      }
    }

    this.generation = best.generation;
    // Continue in the other slot so the valid one stays intact as long as possible.
    this.nextSlot = (bestSlot + 1) % this.paths.snapshotSlots.length;
    return { snapshot: best, slot: bestSlot, generation: best.generation, rejected, repaired: false };
  }
}

export { PERSISTENCE_ERROR, PERSISTENCE_FORMAT_VERSION };
