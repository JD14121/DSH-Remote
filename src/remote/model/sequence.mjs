/**
 * Gateway-owned monotonic sequence allocator — Phase R2 §9, §10.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ DSH durable seq/cursor and Gateway event sequence are DIFFERENT SPACES.  │
 * │                                                                          │
 * │   DSH event seq       418   <- the session log's own cursor              │
 * │   Gateway sequence     92   <- this module's per-session counter         │
 * │                                                                          │
 * │ One DSH durable event may produce several Gateway events (an assistant   │
 * │ turn yields start + N deltas + end + message.created + session.status),  │
 * │ and a stream chunk may have NO durable DSH seq at all. The two are never  │
 * │ interchanged, and this module never reads a DSH cursor.                  │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * R2 scope is **in-memory only** (§9, §27). No disk, no JSONL, no recovery.
 *
 * `seed(sessionId, lastSequence)` exists specifically so R5 can restore a
 * persisted high-water mark and continue, rather than restarting at 1 (§10).
 *
 * Concurrency safety: every mutation below is a straight-line synchronous
 * operation containing no `await`, so on a single-threaded JS runtime each
 * `next()` is atomic with respect to every other `next()`. That is what makes
 * uniqueness and strict monotonicity hold under concurrent callers; the test
 * suite proves it with 1000 interleaved allocations.
 */

/** Lower bound for any legal sequence value. */
export const MIN_SEQUENCE = 0;

/**
 * Validate a sequence boundary.
 *
 * Fails closed rather than coercing: a bad seed must not silently become 0.
 *
 * @param {unknown} value - candidate integer.
 * @param {string} label - name for the error message.
 * @returns {number} the validated integer.
 * @throws {TypeError} when the value is not a safe integer >= MIN_SEQUENCE.
 */
function assertSequenceValue(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer, received ${JSON.stringify(value)}`);
  }
  if (value < MIN_SEQUENCE) {
    throw new TypeError(`${label} must be >= ${MIN_SEQUENCE}, received ${value}`);
  }
  return value;
}

/**
 * Validate a session id.
 *
 * @param {unknown} value - candidate.
 * @returns {string} the session id.
 * @throws {TypeError} when empty or not a string.
 */
function assertSessionId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('sessionId must be a non-empty string');
  }
  return value;
}

/**
 * Per-session monotonic sequence allocator.
 */
export class GatewaySequenceAllocator {
  /**
   * @param {object} [options] - allocator options.
   * @param {number} [options.initial] - value to start an unseeded session from.
   */
  constructor(options = {}) {
    const initial = options.initial ?? MIN_SEQUENCE;
    /** @type {Map<string, {last: number, baseline: number, seeded: boolean}>} */
    this.sessions = new Map();
    this.initial = assertSequenceValue(initial, 'initial');
  }

  /**
   * Allocate the next sequence for a session.
   *
   * Strictly monotonic and never duplicating: each call increments the stored
   * high-water mark inside a synchronous critical section.
   *
   * @param {string} sessionId - owning session.
   * @returns {number} the newly allocated sequence.
   * @throws {TypeError} when the session id is unusable.
   */
  next(sessionId) {
    const id = assertSessionId(sessionId);
    const entry = this.sessions.get(id);
    if (entry === undefined) {
      const created = { last: this.initial, baseline: this.initial, seeded: false };
      created.last += 1;
      this.sessions.set(id, created);
      return created.last;
    }
    entry.last += 1;
    return entry.last;
  }

  /**
   * Read the current high-water mark without allocating.
   *
   * @param {string} sessionId - owning session.
   * @returns {number} the last allocated sequence, or `initial` when unknown.
   */
  peek(sessionId) {
    const id = assertSessionId(sessionId);
    return this.sessions.get(id)?.last ?? this.initial;
  }

  /**
   * Set the high-water mark, so the next allocation is `lastSequence + 1`.
   *
   * This is the R5 seam (§10): load persisted state, seed, continue.
   *
   * Seeds only ever move the mark **forward** for an already-seeded session.
   * Moving it backwards would hand out a sequence that was already used, which
   * breaks the never-duplicate guarantee. Forward movement is allowed because it
   * is how a restored snapshot supersedes a stale in-memory value.
   *
   * @param {string} sessionId - owning session.
   * @param {number} lastSequence - the highest already-emitted sequence.
   * @returns {number} the resulting high-water mark.
   * @throws {TypeError} when the seed is not a safe integer >= 0.
   */
  seed(sessionId, lastSequence) {
    const id = assertSessionId(sessionId);
    const value = assertSequenceValue(lastSequence, 'seed');
    const entry = this.sessions.get(id);
    if (entry === undefined) {
      this.sessions.set(id, { last: value, baseline: value, seeded: true });
      return value;
    }
    if (value < entry.last) {
      throw new TypeError(
        `seed ${value} would move session ${id} backwards from ${entry.last}; `
        + 'that would re-issue an already-used sequence',
      );
    }
    entry.last = value;
    entry.baseline = value;
    entry.seeded = true;
    return value;
  }

  /**
   * Whether a session has been seeded from persisted state.
   *
   * @param {string} sessionId - owning session.
   * @returns {boolean} true when `seed()` set the mark.
   */
  isSeeded(sessionId) {
    return this.sessions.get(assertSessionId(sessionId))?.seeded ?? false;
  }

  /**
   * Forget a session's counter entirely.
   *
   * The next `next()` for that session starts from `initial`, so this is the
   * "start over" operation. Use `seed()` to continue an existing stream.
   *
   * @param {string} sessionId - owning session.
   * @returns {boolean} true when a counter existed and was removed.
   */
  reset(sessionId) {
    return this.sessions.delete(assertSessionId(sessionId));
  }

  /**
   * Rewind a session's counter to its baseline.
   *
   * Re-issues sequences that were already emitted, so it exists for tests and
   * for R5 re-initialisation — never for a live session.
   *
   * @param {string} sessionId - owning session.
   * @returns {number} the restored baseline.
   */
  rewind(sessionId) {
    const id = assertSessionId(sessionId);
    const entry = this.sessions.get(id);
    if (entry === undefined) return this.initial;
    entry.last = entry.baseline;
    return entry.last;
  }

  /**
   * Export an in-memory snapshot.
   *
   * R2 §17/§27: this is an in-memory test seam for R5. It writes nothing.
   *
   * @returns {{initial: number, sessions: Record<string, {last: number, baseline: number, seeded: boolean}>}}
   *   a plain, JSON-safe snapshot.
   */
  snapshot() {
    /** @type {Record<string, {last: number, baseline: number, seeded: boolean}>} */
    const sessions = {};
    for (const [id, entry] of this.sessions) {
      sessions[id] = { last: entry.last, baseline: entry.baseline, seeded: entry.seeded };
    }
    return { initial: this.initial, sessions };
  }

  /**
   * Restore from a snapshot produced by `snapshot()`.
   *
   * Reads **no** disk. It replaces in-memory state only, so R5 can plug a real
   * reader in front of it without touching this class.
   *
   * @param {object} snapshot - a snapshot from `snapshot()`.
   * @returns {GatewaySequenceAllocator} this allocator.
   * @throws {TypeError} when the snapshot is malformed.
   */
  restore(snapshot) {
    if (snapshot === null || typeof snapshot !== 'object') {
      throw new TypeError('snapshot must be an object');
    }
    if (snapshot.sessions !== null && typeof snapshot.sessions !== 'object') {
      throw new TypeError('snapshot.sessions must be an object');
    }
    const initial = snapshot.initial === undefined
      ? this.initial
      : assertSequenceValue(snapshot.initial, 'snapshot.initial');
    const next = new Map();
    for (const [id, entry] of Object.entries(snapshot.sessions ?? {})) {
      if (entry === null || typeof entry !== 'object') {
        throw new TypeError(`snapshot.sessions[${JSON.stringify(id)}] must be an object`);
      }
      const last = assertSequenceValue(entry.last, `snapshot.sessions[${id}].last`);
      const baseline = entry.baseline === undefined
        ? last
        : assertSequenceValue(entry.baseline, `snapshot.sessions[${id}].baseline`);
      next.set(id, { last, baseline, seeded: entry.seeded === true });
    }
    this.initial = initial;
    this.sessions = next;
    return this;
  }

  /**
   * Session ids currently tracked.
   *
   * @returns {string[]} the ids.
   */
  sessionIds() {
    return [...this.sessions.keys()];
  }
}
