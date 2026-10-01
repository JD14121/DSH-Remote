/**
 * Downtime reconciliation — Phase R5 §1.2, §33-§38, §51, §52.
 *
 * A durable Gateway journal cannot contain events that happened while the Gateway
 * was not running. That is not a bug to paper over; it is a boundary (§1.2). The
 * Gateway therefore reconciles: it reads the DSH durable history it missed and
 * turns those facts into **new** Gateway events with **new** Gateway sequences.
 *
 * Reusing an old Gateway sequence would be wrong: these events were never observed
 * by the previous process, so the previous process never assigned them one.
 *
 * Ordering (§35) is the correctness core:
 *
 * ```text
 * observe the fresh DSH cursor C
 *   ↓
 * fetch durable records with source sequence > persisted cursor
 *   ↓
 * process in DSH source order
 *   ↓
 * allocate a NEW Gateway sequence, journal it, publish it
 *   ↓
 * advance the persisted cursor to the last successfully committed source record
 * ```
 *
 * §35 forbids advancing the cursor past a record that was not committed, because
 * that would skip a DSH event permanently. §36 requires the crash window to be
 * idempotent, which the persisted cursor provides.
 *
 * The source is **only** the adapter (§34). This module never reads DSH's own
 * session log.
 */

import { PERSISTENCE_ERROR, persistenceError } from './errors.mjs';

/** Reconciliation outcomes, for reporting and tests. */
export const RECONCILE_OUTCOME = Object.freeze({
  /** Nothing was missed. */
  UP_TO_DATE: 'up_to_date',
  /** Some durable records were reconciled. */
  RECONCILED: 'reconciled',
  /** DSH was not reachable; nothing was attempted. */
  UNAVAILABLE: 'unavailable',
  /** A commit failed part-way; the cursor advanced only to the last success. */
  PARTIAL: 'partial',
});

/**
 * Reconcile one session's durable gap.
 */
export class Reconciler {
  /**
   * @param {object} options - reconciler options.
   * @param {object} options.adapter - the `DshAdapter`.
   * @param {object} options.persistence - the `PersistenceService`.
   * @param {object} options.store - the `SessionViewStore`.
   * @param {object} [options.events] - the `EventsService`, for publishing.
   * @param {() => number} [options.clock] - injectable clock.
   */
  constructor(options) {
    if (options?.adapter === undefined) throw new TypeError('Reconciler requires an adapter');
    if (options?.persistence === undefined) throw new TypeError('Reconciler requires a persistence service');
    if (options?.store === undefined) throw new TypeError('Reconciler requires a session view store');
    this.adapter = options.adapter;
    this.persistence = options.persistence;
    this.store = options.store;
    this.events = options.events ?? null;
    this.clock = options.clock ?? Date.now;
    /** @type {Map<string, number>} sessionId → highest reconciled DSH source sequence. */
    this.cursors = new Map();
  }

  /**
   * The persisted DSH durable cursor for a session (§32).
   *
   * Reads the durable checkpoint first, then any in-process value, then the view.
   *
   * @param {string} sessionId - the session.
   * @returns {number|null} the cursor, or `null` when none is known.
   */
  persistedCursor(sessionId) {
    if (this.cursors.has(sessionId)) return this.cursors.get(sessionId);
    const checkpoint = this.persistence.cursorCheckpoint?.get(sessionId);
    if (Number.isSafeInteger(checkpoint)) return checkpoint;
    const view = this.store.get(sessionId);
    const fromMetadata = view?.metadata?.dsh_cursor;
    if (Number.isSafeInteger(fromMetadata)) return fromMetadata;
    const fromStore = this.store.getDshCursor(sessionId);
    return Number.isSafeInteger(fromStore) ? fromStore : null;
  }

  /**
   * Record a reconciled cursor, durably and in memory (§32, §36).
   *
   * The durable write is what makes reconciliation idempotent across a restart, so
   * it happens immediately rather than waiting for the next snapshot. It is only
   * ever called **after** a commit has been journaled, which is how §35's "never
   * advance past a record that was not committed" is enforced.
   *
   * @param {string} sessionId - the session.
   * @param {number} cursor - the highest committed DSH source sequence.
   * @returns {void}
   * @throws {PersistenceError} when the checkpoint cannot be written.
   */
  setPersistedCursor(sessionId, cursor) {
    if (!Number.isSafeInteger(cursor) || cursor < 0) return;
    const previous = this.persistedCursor(sessionId);
    // §35: never move the checkpoint backwards.
    if (previous !== null && cursor < previous) return;

    this.cursors.set(sessionId, cursor);
    // Durable first, so a crash immediately after cannot lose the idempotency key.
    this.persistence.rememberCursor(sessionId, cursor);
    this.store.rememberDshCursor(sessionId, cursor);
  }

  /**
   * Reconcile every known session against fresh DSH durable history.
   *
   * @param {object} [options] - reconcile options.
   * @param {ReadonlyArray<string>} [options.sessionIds] - restrict to these sessions.
   * @param {(sessionId: string) => Promise<object|null>} [options.freshCursor] - supplies the fresh cursor.
   * @param {(sessionId: string, after: number) => Promise<object[]>} [options.fetchRecords] - supplies missed records.
   * @param {(sessionId: string, record: object) => void} [options.commit] - commits one record.
   * @returns {Promise<object>} a reconciliation report.
   */
  async reconcile(options = {}) {
    const sessionIds = options.sessionIds ?? this.store.list().map((session) => session.id);
    const report = { outcome: RECONCILE_OUTCOME.UP_TO_DATE, sessions: [], reconciled: 0 };

    for (const sessionId of sessionIds) {
      const result = await this.reconcileSession(sessionId, options);
      report.sessions.push(result);
      report.reconciled += result.emitted;
      if (result.outcome === RECONCILE_OUTCOME.PARTIAL) report.outcome = RECONCILE_OUTCOME.PARTIAL;
      else if (result.outcome === RECONCILE_OUTCOME.RECONCILED && report.outcome !== RECONCILE_OUTCOME.PARTIAL) {
        report.outcome = RECONCILE_OUTCOME.RECONCILED;
      }
    }

    return report;
  }

  /**
   * Reconcile one session.
   *
   * @param {string} sessionId - the session.
   * @param {object} options - see `reconcile`.
   * @returns {Promise<object>} the per-session result.
   */
  async reconcileSession(sessionId, options = {}) {
    const persisted = this.persistedCursor(sessionId);

    // 1. Observe the fresh DSH cursor.
    let fresh;
    try {
      fresh = await (options.freshCursor ?? ((id) => this.#freshCursor(id)))(sessionId);
    } catch (error) {
      if (error?.code === PERSISTENCE_ERROR.WRITE_FAILED) throw error;
      return { sessionId, outcome: RECONCILE_OUTCOME.UNAVAILABLE, emitted: 0, reason: error?.code ?? 'unavailable' };
    }
    if (fresh === null || fresh === undefined) {
      return { sessionId, outcome: RECONCILE_OUTCOME.UNAVAILABLE, emitted: 0, reason: 'no fresh cursor' };
    }

    const freshSequence = fresh.cursor ?? fresh.sourceSequence ?? fresh.sequence;
    if (!Number.isSafeInteger(freshSequence)) {
      return { sessionId, outcome: RECONCILE_OUTCOME.UNAVAILABLE, emitted: 0, reason: 'unusable fresh cursor' };
    }

    // No persisted cursor means this session has never been reconciled. Adopting
    // the fresh cursor without fetching would be safest against flooding, but it
    // would also hide real history, so the caller decides by supplying one.
    const from = persisted ?? 0;
    if (freshSequence <= from) {
      return { sessionId, outcome: RECONCILE_OUTCOME.UP_TO_DATE, emitted: 0, cursor: from };
    }

    // 2. Fetch the missed durable records.
    let records;
    try {
      records = await (options.fetchRecords ?? ((id, after) => this.#fetchRecords(id, after)))
        (sessionId, from);
    } catch (error) {
      if (error?.code === PERSISTENCE_ERROR.WRITE_FAILED) throw error;
      return { sessionId, outcome: RECONCILE_OUTCOME.UNAVAILABLE, emitted: 0, reason: error?.code ?? 'fetch failed' };
    }
    if (!Array.isArray(records) || records.length === 0) {
      // Nothing to turn into events, but the cursor still advances: the durable
      // history holds nothing in this range.
      this.setPersistedCursor(sessionId, freshSequence);
      return { sessionId, outcome: RECONCILE_OUTCOME.UP_TO_DATE, emitted: 0, cursor: freshSequence };
    }

    // 3. Process in DSH source order — never in whatever order DSH returned.
    const ordered = [...records].sort(
      (left, right) => (left.sourceSequence ?? left.sequence) - (right.sourceSequence ?? right.sequence),
    );

    let emitted = 0;
    let committedThrough = from;
    for (const record of ordered) {
      const sourceSequence = record.sourceSequence ?? record.sequence;
      if (!Number.isSafeInteger(sourceSequence)) continue;

      // §36: idempotency. A record at or below the checkpoint was already turned
      // into a Gateway event by a previous run.
      if (sourceSequence <= committedThrough) continue;

      try {
        const event = options.commit !== undefined
          ? options.commit(sessionId, record)
          : this.#commit(sessionId, record, sourceSequence);
        if (event !== null && event !== undefined) emitted += 1;
      } catch (error) {
        // §52: the checkpoint advances only to the last successful commit. A
        // failure here must not jump the cursor forward.
        this.setPersistedCursor(sessionId, committedThrough);
        return {
          sessionId,
          outcome: RECONCILE_OUTCOME.PARTIAL,
          emitted,
          cursor: committedThrough,
          failedAt: sourceSequence,
          reason: error?.code ?? 'commit failed',
        };
      }

      committedThrough = sourceSequence;
    }

    // 4. Advance the persisted cursor to the last successful commit.
    this.setPersistedCursor(sessionId, committedThrough);
    return { sessionId, outcome: RECONCILE_OUTCOME.RECONCILED, emitted, cursor: committedThrough };
  }

  /**
   * Read a fresh DSH durable cursor through the adapter.
   *
   * Only the adapter is used, so no wire detail leaks into the persistence layer
   * (§34). The cursor comes from the same `follow` opening snapshot R2 used to
   * learn `created_at`.
   *
   * @param {string} sessionId - the session.
   * @returns {Promise<{cursor: number}|null>} the cursor, or `null`.
   */
  #freshCursor(sessionId) {
    if (typeof this.adapter.subscribe !== 'function') return Promise.resolve(null);
    const controller = new AbortController();
    const timeoutMs = 4000;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        controller.abort();
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      timer.unref?.();

      this.adapter.subscribe(
        sessionId,
        (frame) => {
          if (frame?.kind === 'snapshot' && Number.isSafeInteger(frame.frame?.cursor)) {
            finish({ cursor: frame.frame.cursor });
          }
        },
        { signal: controller.signal, maxMessages: 1 },
      ).catch(() => finish(null));
    });
  }

  /**
   * Fetch durable records after a cursor through the adapter.
   *
   * @param {string} sessionId - the session.
   * @param {number} after - the exclusive source-sequence bound.
   * @returns {Promise<object[]>} the normalized records.
   */
  async #fetchRecords(sessionId, after) {
    if (typeof this.adapter.getMessages !== 'function') return [];
    const page = await this.adapter.getMessages(sessionId, { maxMessages: 200 });
    const messages = Array.isArray(page?.messages) ? page.messages : [];
    return messages
      .filter((message) => Number.isSafeInteger(message?.sequence) && message.sequence > after)
      .map((message) => ({ ...message, sourceSequence: message.sequence }));
  }

  /**
   * Turn one missed DSH durable record into a new Gateway event.
   *
   * The Gateway sequence is allocated fresh by the events service; the DSH source
   * sequence is carried as `source_sequence`.
   *
   * @param {string} sessionId - the session.
   * @param {object} record - the DSH durable record.
   * @param {number} sourceSequence - its DSH source sequence.
   * @returns {object} the emitted Gateway event.
   * @throws {PersistenceError} when the append fails; the cursor must not advance.
   */
  #commit(sessionId, record, sourceSequence) {
    if (this.events === null) {
      throw persistenceError(PERSISTENCE_ERROR.UNAVAILABLE, {
        message: 'Reconciliation requires an events service to publish through.',
      });
    }
    return this.events.emit({
      sessionId,
      event: 'message.created',
      data: {
        // Marked so a client can tell a reconciled fact from one observed live.
        reconciled: true,
        source_kind: record.kind ?? record.type ?? 'durable',
        content: record.content ?? record.data ?? null,
      },
      sourceTime: record.created_at ?? null,
      sourceSequence,
    });
  }
}
