/**
 * PersistenceService — Phase R5 §2, §10, §13, §17, §26, §28, §31, §39, §41, §42.
 *
 * The composition root for durable state. It owns:
 *
 *   - the state root, its `format.json`, and the writer lock;
 *   - one `SessionJournal` per session, and the **write-ahead** append path;
 *   - the A/B snapshot store and a bounded snapshot schedule;
 *   - startup recovery: journal scan, crash-tail repair, snapshot load,
 *     high-water derivation and `GatewaySequenceAllocator` seeding;
 *   - the durable replay source (`bounds`, `eventsAfter`, `tail`), so the
 *     WebSocket layer never learns whether an event came from RAM or disk.
 *
 * §10 is the invariant everything else serves:
 *
 * ```text
 * allocate → journal append completes → ring update → fan-out → client
 * ```
 *
 * Publishes never happen before the append. If an append fails, the event is not
 * published at all and the service enters `failed` (§13) — it does not log a
 * warning and carry on, because that would break the durable sequence guarantee.
 */

import fs from 'node:fs';
import path from 'node:path';

import { PERSISTENCE_ERROR, persistenceError } from './errors.mjs';
import {
  FORMAT_FILE,
  PERSISTENCE_FORMAT_NAME,
  PERSISTENCE_FORMAT_VERSION,
  resolvePersistenceConfig,
  statePaths,
} from './config.mjs';
import { WriterLock } from './lock.mjs';
import { SessionJournal, JOURNAL_STATE } from './journal.mjs';
import { SnapshotStore } from './snapshot.mjs';
import { CursorCheckpoint } from './cursor.mjs';

/** Persistence health, as reported by `/health` (§14). */
export const PERSISTENCE_STATUS = Object.freeze({
  READY: 'ready',
  DEGRADED: 'degraded',
  FAILED: 'failed',
});

/**
 * The durable state service.
 */
export class PersistenceService {
  /**
   * @param {object} options - service options.
   * @param {object} options.config - resolved persistence config, or overrides to resolve.
   * @param {object} options.store - the `SessionViewStore`.
   * @param {() => number} [options.clock] - injectable clock.
   * @param {object} [options.timers] - injectable timers, for tests.
   * @param {(pid: number) => object} [options.probe] - injectable liveness probe.
   * @param {NodeJS.ProcessEnv} [options.env] - environment source.
   */
  constructor(options) {
    if (options?.store === undefined) throw new TypeError('PersistenceService requires a session view store');

    const config = options.config ?? {};
    // Always resolve through `resolvePersistenceConfig`, so a caller that supplies
    // only `root` still gets every documented default — `ringSize`, the segment
    // target and both retention ceilings. Treating a partial config as final is
    // how `ringSize` silently became `undefined` and left the hot cache empty.
    this.config = resolvePersistenceConfig(config, options.env ?? process.env);

    this.store = options.store;
    this.clock = options.clock ?? Date.now;
    this.timers = options.timers ?? null;
    this.paths = statePaths(this.config);
    /**
     * The events service whose ring is the hot cache.
     *
     * Supplied at construction where possible so `initialize()` can preload the
     * ring as part of recovery. `attachEvents` remains available for a caller that
     * must construct persistence first, and re-runs the preload.
     *
     * @type {object|null}
     */
    this.events = options.events ?? null;

    /** @type {Map<string, SessionJournal>} */
    this.journals = new Map();
    this.lock = new WriterLock({
      config: this.config,
      ...(options.probe === undefined ? {} : { probe: options.probe }),
    });
    this.snapshotStore = new SnapshotStore({ config: this.config, clock: this.clock });
    // §32/§36: the reconciliation checkpoint is its own durable file, so the
    // idempotency key for downtime reconciliation does not depend on a snapshot
    // that may be absent or lagging.
    this.cursorCheckpoint = new CursorCheckpoint({ config: this.config });

    this.status = PERSISTENCE_STATUS.READY;
    this.initialized = false;
    this.started = false;
    this.stopped = false;
    this.failure = null;
    this.recovery = null;
    this.retentionRuns = 0;
    this.eventsAppended = 0;
    this.lastAppendAt = null;

    this.snapshotTimer = null;
    this.snapshotScheduled = false;
    this.dirty = false;
    this.snapshotCount = 0;
    /** Ring-preload report, populated during initialization. */
    this.preloadReport = [];
    /** How many sessions were restored from the snapshot. */
    this.restoredSessions = 0;
    /** How many sessions were reconstructed from the journal alone. */
    this.synthesisedSessions = 0;
  }

  /**
   * Whether a failure has put persistence out of service.
   *
   * @returns {boolean} true when events cannot be durably appended.
   */
  get failed() {
    return this.status === PERSISTENCE_STATUS.FAILED;
  }

  /**
   * Health facts for `/health` (§14). Never exposes a real path.
   *
   * @returns {{status: string, format_version: number}} the facts.
   */
  health() {
    return {
      status: this.status,
      format_version: PERSISTENCE_FORMAT_VERSION,
      ...(this.failure === null ? {} : { reason_code: this.failure }),
    };
  }

  /**
   * Run the full startup sequence (§17, §39).
   *
   * Recovery completes **before** the caller binds a listener, so a client can
   * never observe a sequence that starts at 1 and then jumps to a recovered value.
   *
   * @returns {object} the recovery report.
   * @throws {PersistenceError} on any condition §40 says must prevent binding.
   */
  initialize() {
    if (this.initialized) return this.recovery;

    // 1. State root and format.
    this.#ensureRoot();

    // 2. Writer lock — before any journal is opened for writing.
    this.lock.acquire();

    // 3. Journals: scan, verify, repair only an allowable crash tail.
    const journalReport = this.#scanJournals();

    // 3b. Load the reconciliation checkpoint. It is kept in the checkpoint store
    // rather than pushed into the session view here, because the sessions it
    // refers to are restored in step 5.
    const cursors = this.cursorCheckpoint.load();

    // 4. Snapshot, validated against the journal (§23).
    const snapshotReport = this.snapshotStore.load({
      journalHighWater: (sessionId) => this.journals.get(sessionId)?.highWater ?? null,
    });

    // 5. Seed the allocator and restore stable metadata.
    const seeded = this.#seedAllocators();
    const restored = this.#restoreSessions(snapshotReport.snapshot);

    // 5b. Now that the sessions exist, re-apply the durable reconciliation
    // checkpoints. This makes §36 idempotency survive a restart.
    let cursorsRestored = 0;
    for (const [sessionId, cursor] of cursors) {
      if (!this.store.has(sessionId)) continue;
      this.store.rememberDshCursor(sessionId, cursor);
      cursorsRestored += 1;
    }

    // 6. Preload the ring hot cache from the journal tail (§28).
    this.#preloadRings();

    this.initialized = true;
    this.recovery = {
      lock: this.lock.outcome,
      journals: journalReport,
      snapshot: {
        slot: snapshotReport.slot,
        generation: snapshotReport.generation,
        rejected: snapshotReport.rejected,
        repaired: snapshotReport.repaired,
      },
      seeded,
      restored,
      cursorsRestored,
      ringPreload: this.preloadReport,
    };
    return this.recovery;
  }

  /**
   * Create the state root and validate `format.json` (§5).
   *
   * @returns {void}
   * @throws {PersistenceError} `STATE_VERSION_UNSUPPORTED` on an unknown version.
   */
  #ensureRoot() {
    const root = this.paths.root;
    if (fs.existsSync(root)) {
      if (!fs.statSync(root).isDirectory()) {
        throw persistenceError(PERSISTENCE_ERROR.PATH_INVALID, {
          message: 'The state root exists and is not a directory.',
        });
      }
    } else {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    }

    const formatFile = path.join(root, FORMAT_FILE);
    if (!fs.existsSync(formatFile)) {
      const text = `${JSON.stringify({ format: PERSISTENCE_FORMAT_NAME, version: PERSISTENCE_FORMAT_VERSION })}\n`;
      fs.writeFileSync(formatFile, text, { encoding: 'utf8', mode: 0o600 });
    } else {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(formatFile, 'utf8'));
      } catch (error) {
        throw persistenceError(PERSISTENCE_ERROR.JOURNAL_CORRUPT, {
          message: 'The state format file is unreadable.',
          cause: error,
        });
      }
      if (parsed?.format !== PERSISTENCE_FORMAT_NAME) {
        throw persistenceError(PERSISTENCE_ERROR.VERSION_UNSUPPORTED, {
          message: 'The state root was not created by this gateway.',
        });
      }
      if (parsed?.version !== PERSISTENCE_FORMAT_VERSION) {
        // §5: fail closed. R5 implements no migration framework.
        throw persistenceError(PERSISTENCE_ERROR.VERSION_UNSUPPORTED, {
          message: 'The state format version is not supported.',
          details: { found: parsed?.version ?? null, supported: PERSISTENCE_FORMAT_VERSION },
        });
      }
    }

    for (const dir of [this.paths.eventsDir, this.paths.stateDir, this.paths.quarantineDir]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * Scan every session journal on disk (§39 step 2).
   *
   * @returns {object} the scan report.
   */
  #scanJournals() {
    this.journals = new Map();
    if (!fs.existsSync(this.paths.eventsDir)) {
      return { sessions: 0, records: 0, recovered: [], corrupt: [] };
    }

    const entries = fs.readdirSync(this.paths.eventsDir, { withFileTypes: true });
    const report = { sessions: 0, records: 0, recovered: [], corrupt: [] };

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        throw persistenceError(PERSISTENCE_ERROR.JOURNAL_CORRUPT, {
          message: 'The events directory contains an unexpected file.',
        });
      }
      const sessionId = entry.name;
      const journal = new SessionJournal({ config: this.config, sessionId });
      const loaded = journal.load();
      this.journals.set(sessionId, journal);
      report.sessions += 1;
      report.records += loaded.count;
      if (loaded.state === JOURNAL_STATE.RECOVERED) {
        report.recovered.push({ sessionId, evidence: loaded.recovery });
      }
    }

    return report;
  }

  /**
   * Seed each session's Gateway sequence allocator from its journal high-water mark
   * (§31, §39 step 3).
   *
   * @returns {Array<{sessionId: string, seeded: number}>} what was seeded.
   */
  #seedAllocators() {
    const seeded = [];
    for (const [sessionId, journal] of this.journals) {
      if (journal.highWater === null) continue;
      // `seed` is R2's, written for exactly this purpose. It never moves backwards,
      // so a re-run cannot lower a mark.
      this.store.sequences.seed(sessionId, journal.highWater);
      seeded.push({ sessionId, seeded: journal.highWater });
    }
    return seeded;
  }

  /**
   * Restore stable session metadata from the snapshot (§24, §25).
   *
   * The runtime status is deliberately **not** restored: a Gateway that was down
   * cannot know what DSH did meanwhile, so every recovered session starts
   * `disconnected` and waits for fresh evidence. That is why a stale
   * `waiting_input` can never come back as current state.
   *
   * @param {object|null} snapshot - the chosen snapshot, if any.
   * @returns {number} how many sessions were restored.
   */
  #restoreSessions(snapshot) {
    const records = snapshot?.sessions ?? [];
    let restored = 0;

    for (const record of records) {
      if (typeof record?.id !== 'string' || record.id.length === 0) continue;
      const journal = this.journals.get(record.id);
      const journalMark = journal?.highWater ?? 0;
      const claimed = Number.isSafeInteger(record.last_sequence) ? record.last_sequence : 0;

      const session = {
        id: record.id,
        title: record.title ?? null,
        // §24/§53: never a stale runtime status.
        status: 'disconnected',
        created_at: record.created_at ?? null,
        updated_at: record.updated_at ?? null,
        last_sequence: Math.max(claimed, journalMark),
        running: false,
        observed_at: new Date(this.clock()).toISOString(),
        metadata: {
          recovered: true,
          last_known_status: record.last_known_status ?? null,
          dsh_cursor: Number.isSafeInteger(record.dsh_cursor) ? record.dsh_cursor : null,
          snapshot_generation: snapshot.generation,
        },
      };
      if (record.workspace_id !== undefined) session.workspace_id = record.workspace_id;
      if (record.workspace_key !== undefined) session.workspace_key = record.workspace_key;
      if (record.workspace_name !== undefined) session.workspace_name = record.workspace_name;
      if (record.cwd !== undefined) session.cwd = record.cwd;

      this.store.upsertSession(session);
      // The recovery status must be the machine's status too, so a later signal
      // composes with the recovered state rather than fighting it.
      this.store.applySignal(record.id, {
        signal: 'SESSION_DISCOVERED',
        sessionId: record.id,
        evidence: { source: 'persistence recovery' },
      });
      this.store.machines.get(record.id)?.restore({
        status: 'disconnected',
        suspendedStatus: null,
        highestRank: null,
        recentSignals: [],
      });
      restored += 1;
    }

    // §47: a session with a journal but no snapshot entry is still real. Give it a
    // minimal recovered view so its events have somewhere to land.
    let synthesised = 0;
    for (const [sessionId, journal] of this.journals) {
      if (this.store.has(sessionId)) continue;
      if (journal.highWater === null) continue;
      this.store.upsertSession({
        id: sessionId,
        title: null,
        status: 'disconnected',
        created_at: null,
        updated_at: null,
        last_sequence: journal.highWater,
        running: false,
        metadata: { recovered: true, reconstructed_from_journal: true },
      });
      this.store.applySignal(sessionId, {
        signal: 'SESSION_DISCOVERED',
        sessionId,
        evidence: { source: 'journal reconstruction' },
      });
      this.store.machines.get(sessionId)?.restore({
        status: 'disconnected',
        suspendedStatus: null,
        highestRank: null,
        recentSignals: [],
      });
      synthesised += 1;
    }

    this.restoredSessions = restored;
    this.synthesisedSessions = synthesised;
    return restored + synthesised;
  }

  /**
   * Preload the ring hot cache from the journal tail (§28).
   *
   * The ring is a cache after R5: its eviction no longer decides
   * `earliest_available`.
   *
   * @returns {void}
   */
  #preloadRings() {
    const report = [];
    for (const [sessionId, journal] of this.journals) {
      const tail = journal.tail(this.config.ringSize);
      if (tail.length === 0) continue;
      // The ring lives in `EventsService`; inject the tail there. Without an
      // attached service the preload is recorded and applied on `attachEvents`.
      this.events?.loadRing(sessionId, tail);
      report.push({ sessionId, preloaded: tail.length });
    }
    this.preloadReport = report;
  }

  /**
   * Attach the ring holder so preload can populate it.
   *
   * Safe to call before or after `initialize()`: when it is called afterwards the
   * preload is re-run immediately, so the ordering of construction cannot silently
   * leave the hot cache empty.
   *
   * @param {object} events - the `EventsService`.
   * @returns {number} how many sessions were preloaded by this call.
   */
  attachEvents(events) {
    this.events = events;
    if (this.initialized) {
      this.#preloadRings();
      return this.preloadReport.length;
    }
    return 0;
  }

  /**
   * Preload the ring cache directly from the journal.
   *
   * @param {string} sessionId - the session.
   * @param {number} limit - how many trailing events to load.
   * @returns {object[]} the loaded events.
   */
  ringTail(sessionId, limit) {
    const journal = this.journals.get(sessionId);
    if (journal === undefined) return [];
    return journal.tail(limit);
  }

  /**
   * Begin accepting appends and start the snapshot schedule.
   *
   * @returns {void}
   */
  start() {
    if (!this.initialized) this.initialize();
    this.started = true;
    this.#scheduleSnapshot();
  }

  /**
   * The journal for a session, created on demand.
   *
   * @param {string} sessionId - the session.
   * @returns {SessionJournal} the journal.
   */
  journalFor(sessionId) {
    let journal = this.journals.get(sessionId);
    if (journal === undefined) {
      journal = new SessionJournal({ config: this.config, sessionId });
      journal.load();
      this.journals.set(sessionId, journal);
    }
    return journal;
  }

  /**
   * Append one Gateway event durably.
   *
   * This is the write-ahead step. It must be called **before** any fan-out, and it
   * is synchronous so that ordering cannot be interleaved.
   *
   * @param {object} event - the Gateway event.
   * @returns {object} the append result.
   * @throws {PersistenceError} `PERSISTENCE_WRITE_FAILED` after which nothing is published.
   */
  append(event) {
    // §41: no producer may append after durable state has closed. Without this the
    // journals map has been emptied and a late emit would silently recreate a
    // journal on disk — writing after shutdown instead of failing.
    if (this.stopped) {
      throw persistenceError(PERSISTENCE_ERROR.UNAVAILABLE, {
        message: 'The gateway state store is closed; no further events can be persisted.',
      });
    }
    if (this.failed) {
      throw persistenceError(PERSISTENCE_ERROR.WRITE_FAILED, {
        message: 'The gateway state store has failed; no further events can be persisted.',
      });
    }
    if (!this.initialized) {
      throw persistenceError(PERSISTENCE_ERROR.UNAVAILABLE, {
        message: 'The gateway state store is not initialized.',
      });
    }

    const journal = this.journalFor(event.session_id);
    try {
      const result = journal.append(event);
      this.eventsAppended += 1;
      this.lastAppendAt = new Date(this.clock()).toISOString();
      this.dirty = true;
      this.#scheduleSnapshot();
      this.#maybeEnforceRetention(event.session_id);
      return result;
    } catch (error) {
      // §13: fail closed. Entering `failed` stops further fan-out, so a client can
      // never receive an event the journal does not hold.
      if (error?.code === PERSISTENCE_ERROR.WRITE_FAILED
        || error?.code === PERSISTENCE_ERROR.JOURNAL_SEQUENCE_ERROR) {
        this.status = PERSISTENCE_STATUS.FAILED;
        this.failure = error.code;
      }
      throw error;
    }
  }

  /**
   * Record a reconciled DSH cursor durably (§32, §36).
   *
   * Called by the reconciler only after a commit has been journaled, so the stored
   * value never runs ahead of what the journal can prove.
   *
   * @param {string} sessionId - the session.
   * @param {number} cursor - the highest committed DSH source sequence.
   * @returns {number} the stored value.
   * @throws {PersistenceError} when the checkpoint cannot be written.
   */
  rememberCursor(sessionId, cursor) {
    return this.cursorCheckpoint.set(sessionId, cursor);
  }

  /**
   * The recorded reconciliation cursor for a session.
   *
   * @param {string} sessionId - the session.
   * @returns {number|null} the cursor, or `null`.
   */
  recalledCursor(sessionId) {
    return this.cursorCheckpoint.get(sessionId);
  }

  /**
   * Enforce retention for a session once it is worth checking (§29, §30).
   *
   * @param {string} sessionId - the session.
   * @returns {void}
   */
  #maybeEnforceRetention(sessionId) {
    const journal = this.journals.get(sessionId);
    if (journal === undefined) return;
    if (journal.eventCount <= this.config.maxEventsPerSession
      && journal.byteCount <= this.config.maxBytesPerSession) {
      return;
    }
    // §31: retention lowers `earliest` only. The allocator mark is untouched.
    journal.enforceRetention();
    this.retentionRuns += 1;
  }

  /**
   * Force a retention pass on every session.
   *
   * @returns {object[]} one result per session that changed.
   */
  enforceRetention() {
    const results = [];
    for (const [sessionId, journal] of this.journals) {
      const result = journal.enforceRetention();
      if (result.removed.length > 0) results.push({ sessionId, ...result });
    }
    if (results.length > 0) this.retentionRuns += 1;
    return results;
  }

  /**
   * The authoritative retained bounds for a session (§26, §59).
   *
   * `earliest` comes from durable storage, never from ring eviction, and `latest`
   * is the journal high-water mark so it can never lag behind what was published.
   *
   * @param {string} sessionId - the session.
   * @returns {Promise<{earliest: number|null, latest: number|null, count: number, highWater: number}>} the bounds.
   */
  async bounds(sessionId) {
    const journal = this.journals.get(sessionId);
    const durable = journal?.bounds() ?? { earliest: null, latest: null, count: 0 };
    return {
      earliest: durable.earliest,
      latest: durable.latest,
      count: durable.count,
      highWater: journal?.highWater ?? 0,
      source: 'durable-journal',
    };
  }

  /**
   * Every retained event after a watermark, preferring the ring and falling back
   * to the journal (§26).
   *
   * @param {string} sessionId - the session.
   * @param {number} after - the exclusive lower bound.
   * @param {object} [options] - read options.
   * @returns {Promise<object[]>} the Gateway events, ascending.
   */
  async eventsAfter(sessionId, after, options = {}) {
    const journal = this.journals.get(sessionId);
    if (journal === undefined) return [];

    const durable = journal.bounds();
    if (durable.earliest === null) return [];
    // The requested range is entirely retained by the journal, so the journal is
    // the answer. The ring may hold the same events; reading one source avoids
    // duplicates and keeps ordering trivially correct.
    void options;
    return journal.eventsAfter(after);
  }

  /**
   * The newest retained events for a session.
   *
   * @param {string} sessionId - the session.
   * @param {number} count - how many.
   * @returns {Promise<object[]>} the events, oldest first.
   */
  async tail(sessionId, count) {
    const journal = this.journals.get(sessionId);
    if (journal === undefined) return [];
    return journal.tail(count);
  }

  /**
   * Schedule a debounced snapshot write (§42).
   *
   * @returns {void}
   */
  #scheduleSnapshot() {
    if (!this.started || this.stopped) return;
    if (this.snapshotScheduled) return;
    this.snapshotScheduled = true;

    const setTimer = this.timers?.setTimeout ?? setTimeout;
    this.snapshotTimer = setTimer(() => {
      this.snapshotScheduled = false;
      this.snapshotTimer = null;
      try {
        this.writeSnapshot();
      } catch {
        // §42: a snapshot failure must not lose journal sequence. The next
        // scheduled write retries, and the journal remains authoritative.
        this.status = this.status === PERSISTENCE_STATUS.FAILED
          ? PERSISTENCE_STATUS.FAILED
          : PERSISTENCE_STATUS.DEGRADED;
      }
    }, this.config.snapshotIntervalMs);
    this.snapshotTimer?.unref?.();
  }

  /**
   * Write a snapshot now, if anything changed.
   *
   * §23: the journal is the sequence authority, so a snapshot must never claim more
   * progress than the journal can prove. When an append was rejected the allocator
   * has already advanced while the view still carries the higher mark, so the
   * persisted value is clamped down to the journal's high-water mark and the
   * requested value is kept only as a diagnostic. Without this clamp a perfectly
   * normal rejected append would be recorded as permanent corruption.
   *
   * The `STATE_AHEAD_OF_JOURNAL` check still guards the real case: a snapshot file
   * that already exists on disk claiming more than its journal (see `load`).
   *
   * @param {boolean} [force] - write even when not dirty.
   * @returns {object|null} the write result, or `null` when nothing was written.
   */
  writeSnapshot(force = false) {
    if (!force && !this.dirty) return null;
    const sessions = this.store.list().map((session) => {
      const journal = this.journals.get(session.id);
      const proven = journal?.highWater ?? 0;
      const claimed = Number.isSafeInteger(session.last_sequence) ? session.last_sequence : 0;
      if (claimed <= proven) return session;
      return {
        ...session,
        // The durable truth.
        last_sequence: proven,
        metadata: {
          ...(session.metadata ?? {}),
          // What the in-memory view believed, for diagnosis only.
          unpersisted_sequence: claimed,
        },
      };
    });
    const result = this.snapshotStore.write(sessions);
    this.snapshotCount += 1;
    this.dirty = false;
    return result;
  }

  /**
   * Flush and shut down in §41's order.
   *
   * @returns {object} a shutdown report.
   */
  shutdown() {
    if (this.stopped) return { alreadyStopped: true };
    this.stopped = true;

    // 1. Stop scheduling, and cancel a pending write so no timer outlives us.
    const clearTimer = this.timers?.clearTimeout ?? clearTimeout;
    if (this.snapshotTimer !== null) {
      clearTimer(this.snapshotTimer);
      this.snapshotTimer = null;
    }

    // 2. Final snapshot while the journals are still readable.
    let snapshot = null;
    try {
      snapshot = this.writeSnapshot(true);
    } catch (error) {
      snapshot = { error: error?.code ?? 'SNAPSHOT_FAILED' };
    }

    // 3. Flush and close every journal, then release the lock.
    const flushed = [];
    for (const [sessionId, journal] of this.journals) {
      const bounds = journal.bounds();
      journal.flush();
      journal.close();
      flushed.push({ sessionId, ...bounds });
    }
    this.journals = new Map();

    const released = this.lock.release();
    this.status = PERSISTENCE_STATUS.READY;

    return { snapshot, flushed, lockReleased: released };
  }

  /**
   * A diagnostics snapshot, for tests and the report.
   *
   * @returns {object} the state.
   */
  stats() {
    return {
      status: this.status,
      initialized: this.initialized,
      started: this.started,
      stopped: this.stopped,
      sessions: this.journals.size,
      eventsAppended: this.eventsAppended,
      snapshotCount: this.snapshotCount,
      retentionRuns: this.retentionRuns,
      lock: { held: this.lock.held, outcome: this.lock.outcome, instanceId: this.lock.instanceId },
    };
  }
}
