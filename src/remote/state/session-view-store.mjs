/**
 * In-memory session view store —Phase R2 §17.
 *
 * R2 §17 permits **only** an in-memory implementation. `restore(snapshot)` reads
 * no disk by design; it exists so R5 can plug a real reader in front of this
 * store without changing its interface.
 *
 * The store owns, per session:
 *
 *   session summary · current status · latest gateway sequence ·
 *   known DSH cursor · last update timestamp · optional active run metadata
 *
 * It also owns the Gateway sequence allocator, so "allocate a sequence and record
 * the event" is one atomic operation rather than something a caller can half-do.
 */

import { isRecord } from '../model/guards.mjs';
import { INITIAL_STATUS, assertStatus } from '../model/status.mjs';
import { assertSignal } from '../model/signals.mjs';
import { makeSession, validateSession } from '../model/session.mjs';
import { GatewaySequenceAllocator } from '../model/sequence.mjs';
import { GATEWAY_EVENT, makeGatewayEvent, validateGatewayEvent } from '../model/event.mjs';
import { observedNow } from '../model/time.mjs';
import { SessionStateMachine } from './session-state-machine.mjs';

/**
 * The in-memory session view store.
 */
export class SessionViewStore {
  /**
   * @param {object} [options] - store options.
   * @param {() => number} [options.clock] - injectable clock returning epoch millis.
   * @param {GatewaySequenceAllocator} [options.sequences] - shared allocator.
   */
  constructor(options = {}) {
    this.clock = options.clock ?? Date.now;
    this.sequences = options.sequences ?? new GatewaySequenceAllocator();
    /** @type {Map<string, object>} */
    this.sessions = new Map();
    /** @type {Map<string, SessionStateMachine>} */
    this.machines = new Map();
    /** @type {Map<string, number[]|null>} */
    this.dshCursors = new Map();
    /** @type {Map<string, object>} */
    this.activeRuns = new Map();
  }

  /**
   * Read one session view.
   *
   * @param {string} sessionId - session identity.
   * @returns {object|null} the session, or `null` when unknown.
   */
  get(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return null;
    return this.#decorate(sessionId, session);
  }

  /**
   * Insert or update a session.
   *
   * An update preserves the machine's status (the state machine owns status) and
   * the Gateway sequence high-water mark, so refreshing a summary can never
   * rewind either.
   *
   * @param {object} session - a domain session.
   * @returns {object} the stored view.
   * @throws {TypeError} when the session is invalid.
   */
  upsertSession(session) {
    const check = validateSession(session);
    if (!check.ok) throw new TypeError(`cannot store an invalid session: ${check.reason}`);

    const existing = this.sessions.get(session.id);
    if (existing === undefined) {
      this.machines.set(session.id, new SessionStateMachine({ initialStatus: session.status }));
      this.sessions.set(session.id, { ...session });
      return this.#decorate(session.id, this.sessions.get(session.id));
    }

    const machine = this.machines.get(session.id);
    const merged = {
      ...existing,
      // Enrich, never erase: a newly discovered title/created_at wins, but an
      // absent one must not null out a value already learned.
      title: session.title ?? existing.title,
      created_at: session.created_at ?? existing.created_at,
      updated_at: session.updated_at ?? existing.updated_at,
      cwd: session.cwd ?? existing.cwd,
      workspace_id: session.workspace_id ?? existing.workspace_id,
      workspace_key: session.workspace_key ?? existing.workspace_key,
      workspace_name: session.workspace_name ?? existing.workspace_name,
      running: session.running,
      // Status belongs to the machine.
      status: machine.status,
      last_sequence: existing.last_sequence,
      ...(session.observed_at === undefined ? {} : { observed_at: session.observed_at }),
      ...(session.metadata === undefined ? {} : { metadata: session.metadata }),
    };
    this.sessions.set(session.id, merged);
    return this.#decorate(session.id, merged);
  }

  /**
   * Apply a normalized domain signal to one session.
   *
   * @param {string} sessionId - session identity.
   * @param {object|string} signal - a signal name or `makeSignal` object.
   * @returns {object} the transition record plus the resulting view.
   * @throws {TypeError} when the session is unknown or the signal is illegal.
   */
  applySignal(sessionId, signal) {
    const session = this.#require(sessionId);
    const name = typeof signal === 'string' ? signal : signal?.signal;
    assertSignal(name);

    const machine = this.machines.get(sessionId);
    const transition = machine.apply(signal);
    session.status = machine.status;

    if (name === 'RUN_STARTED') {
      this.activeRuns.set(sessionId, { started_at: observedNow(this.clock), source: 'RUN_STARTED' });
    } else if (name === 'RUN_COMMITTED' || name === 'RUN_ABANDONED' || name === 'TASK_FAILED') {
      this.activeRuns.delete(sessionId);
    }

    // The DSH live flag tracks `running` only; a settled outcome means the Agent
    // is no longer running even though the session continues to exist.
    if (machine.status === 'running' || machine.status === 'queued') {
      session.running = true;
    } else if (machine.status === 'idle' || machine.status === 'waiting_input') {
      session.running = false;
    }

    return { ...transition, session: this.#decorate(sessionId, session) };
  }

  /**
   * Record a Gateway event against a session.
   *
   * The event's `sequence` must already have been allocated by this store's
   * allocator via `emitEvent`, or be a sequence this store has not yet seen.
   * Applying an event updates `last_sequence`, `updated_at` and the DSH cursor.
   *
   * @param {object} event - a Gateway event.
   * @returns {object} the stored event.
   * @throws {TypeError} when the event is invalid or its session is unknown.
   */
  applyGatewayEvent(event) {
    const check = validateGatewayEvent(event);
    if (!check.ok) throw new TypeError(`cannot apply an invalid gateway event: ${check.reason}`);
    const session = this.#require(event.session_id);

    if (event.sequence > session.last_sequence) {
      session.last_sequence = event.sequence;
    }
    if (event.timestamp !== null) {
      session.updated_at = session.updated_at === null || event.timestamp > session.updated_at
        ? event.timestamp
        : session.updated_at;
    }
    if (typeof event.source_sequence === 'number') {
      this.rememberDshCursor(event.session_id, event.source_sequence);
    }
    return event;
  }

  /**
   * Allocate a Gateway sequence and record the event against its session.
   *
   * This is the one place where "allocate" and "record" happen together, so the
   * sequence space cannot develop a gap that a subscriber would hang on.
   *
   * @param {object} input - event input, minus `sequence`.
   * @returns {object} the stored Gateway event.
   * @throws {TypeError} when the session is unknown.
   */
  emitEvent(input) {
    const sessionId = input?.sessionId;
    this.#require(sessionId);
    const sequence = this.sequences.next(sessionId);
    const event = makeGatewayEvent({
      sequence,
      event: input.event,
      sessionId,
      data: input.data,
      sourceTime: input.sourceTime,
      sourceSequence: input.sourceSequence ?? null,
      observedAt: input.observedAt ?? observedNow(this.clock),
    });
    this.applyGatewayEvent(event);
    return event;
  }

  /**
   * Remember the highest DSH durable cursor seen for a session.
   *
   * Kept strictly apart from the Gateway sequence (§8); this value is only ever
   * reported as `dsh_cursor` for diagnostics, never used to number events.
   *
   * @param {string} sessionId - session identity.
   * @param {number} cursor - a DSH durable seq.
   * @returns {number} the retained high-water mark.
   * @throws {TypeError} when the cursor is not a finite number.
   */
  rememberDshCursor(sessionId, cursor) {
    this.#require(sessionId);
    if (typeof cursor !== 'number' || !Number.isFinite(cursor)) {
      throw new TypeError('DSH cursor must be a finite number');
    }
    const existing = this.dshCursors.get(sessionId) ?? null;
    const next = existing === null ? cursor : Math.max(existing, cursor);
    this.dshCursors.set(sessionId, next);
    return next;
  }

  /**
   * Read the retained DSH cursor for a session.
   *
   * @param {string} sessionId - session identity.
   * @returns {number|null} the DSH durable high-water mark, or `null`.
   */
  getDshCursor(sessionId) {
    return this.dshCursors.get(sessionId) ?? null;
  }

  /**
   * List every session view.
   *
   * @returns {object[]} the views, in insertion order.
   */
  list() {
    return [...this.sessions.keys()].map((id) => this.#decorate(id, this.sessions.get(id)));
  }

  /**
   * Whether a session is present.
   *
   * @param {string} sessionId - session identity.
   * @returns {boolean} true when present.
   */
  has(sessionId) {
    return this.sessions.has(sessionId);
  }

  /**
   * Remove a session and its machine.
   *
   * @param {string} sessionId - session identity.
   * @returns {boolean} true when something was removed.
   */
  delete(sessionId) {
    this.machines.delete(sessionId);
    this.dshCursors.delete(sessionId);
    this.activeRuns.delete(sessionId);
    return this.sessions.delete(sessionId);
  }

  /**
   * Export an in-memory snapshot.
   *
   * Writes nothing anywhere (§27).
   *
   * @returns {object} a JSON-safe snapshot for `restore()`.
   */
  snapshot() {
    return {
      sequences: this.sequences.snapshot(),
      sessions: this.list().map((session) => ({ ...session })),
      dshCursors: Object.fromEntries(this.dshCursors),
      machines: Object.fromEntries(
        [...this.machines.entries()].map(([id, machine]) => [id, machine.snapshot()]),
      ),
      activeRuns: Object.fromEntries([...this.activeRuns.entries()].map(([id, run]) => [id, { ...run }])),
    };
  }

  /**
   * Restore from a snapshot produced by `snapshot()`.
   *
   * Reads **no** disk. It is the R5 seam (§17), and the test suite proves the
   * round trip without any file access.
   *
   * @param {object} snapshot - a snapshot from `snapshot()`.
   * @returns {SessionViewStore} this store.
   * @throws {TypeError} when the snapshot is malformed.
   */
  restore(snapshot) {
    if (!isRecord(snapshot)) throw new TypeError('store snapshot must be an object');
    if (!Array.isArray(snapshot.sessions)) throw new TypeError('snapshot.sessions must be an array');

    this.sessions = new Map();
    this.machines = new Map();
    this.dshCursors = new Map();
    this.activeRuns = new Map();

    this.sequences.restore(snapshot.sequences ?? { initial: 0, sessions: {} });

    for (const session of snapshot.sessions) {
      const check = validateSession(session);
      if (!check.ok) throw new TypeError(`snapshot contains an invalid session: ${check.reason}`);
      this.sessions.set(session.id, { ...session });
    }
    for (const [id, machineSnapshot] of Object.entries(snapshot.machines ?? {})) {
      const machine = new SessionStateMachine();
      machine.restore(machineSnapshot);
      this.machines.set(id, machine);
      const session = this.sessions.get(id);
      if (session === undefined) {
        throw new TypeError(`snapshot has a machine for unknown session ${JSON.stringify(id)}`);
      }
      // The machine is authoritative for status.
      session.status = machine.status;
    }
    for (const id of this.sessions.keys()) {
      if (!this.machines.has(id)) {
        const session = this.sessions.get(id);
        this.machines.set(id, new SessionStateMachine({ initialStatus: session.status }));
      }
    }
    for (const [id, cursor] of Object.entries(snapshot.dshCursors ?? {})) {
      this.dshCursors.set(id, cursor);
    }
    for (const [id, run] of Object.entries(snapshot.activeRuns ?? {})) {
      this.activeRuns.set(id, { ...run });
    }
    return this;
  }

  /**
   * Read a session's state machine, for a caller that must inspect it.
   *
   * @param {string} sessionId - session identity.
   * @returns {SessionStateMachine|null} the machine, or `null`.
   */
  machineFor(sessionId) {
    return this.machines.get(sessionId) ?? null;
  }

  /**
   * Require a session to exist.
   *
   * @param {unknown} sessionId - session identity.
   * @returns {object} the stored session.
   * @throws {TypeError} when unknown.
   */
  #require(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new TypeError(`unknown session ${JSON.stringify(sessionId)}`);
    }
    return session;
  }

  /**
   * Attach derived, read-only facts to a session view.
   *
   * @param {string} sessionId - session identity.
   * @param {object} session - the stored session.
   * @returns {object} the decorated view.
   */
  #decorate(sessionId, session) {
    return {
      ...session,
      status: this.machines.get(sessionId)?.status ?? session.status ?? INITIAL_STATUS,
      dsh_cursor: this.dshCursors.get(sessionId) ?? null,
      ...(this.activeRuns.has(sessionId) ? { active_run: { ...this.activeRuns.get(sessionId) } } : {}),
    };
  }
}

/**
 * Build a session view store with an explicit initial status.
 *
 * @param {object} [options] - store options.
 * @returns {SessionViewStore} the store.
 */
export function createSessionViewStore(options = {}) {
  return new SessionViewStore(options);
}

export { GATEWAY_EVENT, assertStatus };
