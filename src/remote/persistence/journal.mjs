/**
 * Segmented, checksummed, append-only event journal — Phase R5 §8-§13, §16, §20,
 * §21, §29-§31, §43.
 *
 * One directory per session, one file per segment, one record per line. The
 * journal is the **replay authority** (§2); the ring is only a hot cache.
 *
 * Writes are **synchronous**, and that is a deliberate correctness choice, not an
 * oversight — see §11 and `docs/r5-persistence-design.md`. Write-ahead ordering
 * requires the append to be complete before the fan-out, and a synchronous append
 * in a single-threaded runtime makes that ordering structural: there is no await
 * point between "allocated" and "on disk" where another operation could interleave.
 *
 * The only corruption this class repairs is §20's crash tail: the **last** line of
 * the **last** segment, unterminated. Everything else fails closed (§21).
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  PERSISTENCE_ERROR,
  persistenceError,
} from './errors.mjs';
import { decodeRecord, encodeRecord } from './record.mjs';
import { parseSegmentFileName, segmentFileName, sessionJournalDir } from './config.mjs';

/** How a journal was classified during load. */
export const JOURNAL_STATE = Object.freeze({
  /** No segments exist yet. */
  EMPTY: 'empty',
  /** Records are contiguous and every checksum verified. */
  VALID: 'valid',
  /** A crash tail was truncated and the remainder verified. */
  RECOVERED: 'recovered',
});

/**
 * A segmented journal for one session.
 */
export class SessionJournal {
  /**
   * @param {object} options - journal options.
   * @param {object} options.config - resolved persistence config.
   * @param {string} options.sessionId - the session this journal belongs to.
   * @param {number} [options.segmentBytes] - rotation target.
   */
  constructor(options) {
    if (options?.config === undefined) throw new TypeError('SessionJournal requires a config');
    if (typeof options?.sessionId !== 'string' || options.sessionId.length === 0) {
      throw new TypeError('SessionJournal requires a session id');
    }
    this.config = options.config;
    this.sessionId = options.sessionId;
    this.segmentBytes = options.segmentBytes ?? options.config.segmentBytes ?? 4_194_304;
    this.dir = sessionJournalDir(options.config, options.sessionId);

    /** @type {Array<{start: number, end: number, count: number, bytes: number, file: string}>} */
    this.segments = [];
    /** @type {number|null} The highest sequence on disk. */
    this.highWater = null;
    /** @type {number|null} The lowest retained sequence. */
    this.earliest = null;
    this.state = JOURNAL_STATE.EMPTY;
    /** @type {number|null} */
    this.openFd = null;
    /** @type {string|null} */
    this.openFile = null;
    this.openBytes = 0;
    this.openCount = 0;
    this.recoveryEvidence = null;
    this.closed = false;
  }

  /**
   * The total records retained.
   *
   * @returns {number} the record count.
   */
  get eventCount() {
    return this.segments.reduce((total, segment) => total + segment.count, 0);
  }

  /**
   * The total bytes retained.
   *
   * @returns {number} the byte count.
   */
  get byteCount() {
    return this.segments.reduce((total, segment) => total + segment.bytes, 0);
  }

  /**
   * Load every segment, verify it, and repair only an allowable crash tail.
   *
   * @returns {{state: string, highWater: number|null, earliest: number|null, count: number, recovery: object|null}}
   *   the load result.
   * @throws {PersistenceError} `JOURNAL_CORRUPT` or `JOURNAL_SEQUENCE_ERROR`.
   */
  load() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });

    const names = fs.readdirSync(this.dir);
    const starts = [];
    for (const name of names) {
      const start = parseSegmentFileName(name);
      if (start === null) {
        // §21: a segment filename that does not match the layout is not skipped —
        // it means the directory is not the journal we think it is.
        throw persistenceError(PERSISTENCE_ERROR.JOURNAL_CORRUPT, {
          message: 'The journal directory contains an unexpected file.',
        });
      }
      starts.push(start);
    }
    starts.sort((left, right) => left - right);

    this.segments = [];
    // The sequence the next non-empty segment must start at. An empty segment
    // carries no records, so it is validated by filename but must **not** reset
    // this cursor — otherwise a rotation that opened a file and then died before
    // writing would lose the high-water mark entirely.
    //
    // Retention may legitimately have removed leading segments (§30), so the first
    // segment's start is the journal's declared earliest and the contiguity rule
    // applies from there: each following segment must begin immediately after the
    // previous one ends. It is **not** an assertion that the journal starts at 1.
    let expected = starts[0] ?? 1;
    let lastEnd = null;

    for (const [index, start] of starts.entries()) {
      const isLast = index === starts.length - 1;
      const loaded = this.#loadSegment(start, { expected, isLast });
      this.segments.push(loaded.segment);
      if (loaded.segment.count > 0) {
        expected = loaded.segment.end + 1;
        lastEnd = loaded.segment.end;
      }
      if (loaded.recovery !== null) this.recoveryEvidence = loaded.recovery;
    }

    if (this.segments.length === 0) {
      this.state = JOURNAL_STATE.EMPTY;
      this.highWater = null;
      this.earliest = null;
      return { state: this.state, highWater: null, earliest: null, count: 0, recovery: null };
    }

    // The earliest retained sequence comes from the first segment that actually
    // holds a record; a leading empty segment must not become `earliest`.
    const firstPopulated = this.segments.find((segment) => segment.count > 0);
    this.earliest = firstPopulated?.start ?? null;
    this.highWater = lastEnd;
    this.state = this.recoveryEvidence === null ? JOURNAL_STATE.VALID : JOURNAL_STATE.RECOVERED;

    // Re-open the last segment for appending, so the next append continues there —
    // or rotates, when it already holds records and is past the target.
    this.#openForAppend(this.segments[this.segments.length - 1]);

    return {
      state: this.state,
      highWater: this.highWater,
      earliest: this.earliest,
      count: this.eventCount,
      recovery: this.recoveryEvidence,
    };
  }

  /**
   * Read and verify one segment file.
   *
   * @param {number} start - the segment's declared start sequence.
   * @param {object} context - load context.
   * @param {number} context.expected - the sequence the first record must carry.
   * @param {boolean} context.isLast - whether this is the final segment.
   * @returns {{segment: object, recovery: object|null}} the segment and any recovery evidence.
   * @throws {PersistenceError} on any non-repairable damage.
   */
  #loadSegment(start, context) {
    // §21: a segment whose filename disagrees with where it sits in the sequence
    // is corruption, not something to tolerate. Without this check a renamed file
    // would silently shift every sequence it holds.
    if (start !== context.expected) {
      throw persistenceError(PERSISTENCE_ERROR.JOURNAL_CORRUPT, {
        message: 'A journal segment filename does not match its expected start sequence.',
        details: { declared: start, expected: context.expected },
      });
    }

    const file = path.join(this.dir, segmentFileName(start));
    let raw = fs.readFileSync(file);
    let recovery = null;

    // §20: only the last segment's last, unterminated line may be repaired.
    const endsWithNewline = raw.length === 0 || raw[raw.length - 1] === 0x0a;
    if (!endsWithNewline) {
      if (!context.isLast) {
        throw persistenceError(PERSISTENCE_ERROR.JOURNAL_CORRUPT, {
          message: 'A non-final journal segment is unterminated.',
        });
      }
      const lastNewline = raw.lastIndexOf(0x0a);
      const truncateAt = lastNewline + 1; // 0 when there is no newline at all
      const discarded = raw.subarray(truncateAt).toString('utf8');
      raw = raw.subarray(0, truncateAt);
      fs.truncateSync(file, raw.length);
      recovery = {
        action: 'truncated-crash-tail',
        file: segmentFileName(start),
        discardedBytes: Buffer.byteLength(discarded, 'utf8'),
        // The discarded bytes are recorded as evidence, not re-parsed (§20).
        discardedUnterminated: discarded.length > 0,
      };
    }

    const text = raw.toString('utf8');
    if (text.length === 0) {
      // An empty final segment is legal after a rotation that never wrote.
      return {
        segment: { start, end: null, count: 0, bytes: raw.length, file: segmentFileName(start) },
        recovery,
      };
    }

    const lines = text.split('\n');
    // A trailing newline yields one empty final element, which is not a record.
    if (lines[lines.length - 1] === '') lines.pop();

    let expected = context.expected;
    let previous = null;
    for (const line of lines) {
      // §21: a malformed *middle* line, a checksum mismatch, a gap, a duplicate or
      // a backwards sequence all fail closed. None of them are skipped.
      const record = decodeRecord(line, { sessionId: this.sessionId, expectedSequence: expected });
      if (previous !== null && record.sequence !== previous + 1) {
        throw persistenceError(PERSISTENCE_ERROR.JOURNAL_SEQUENCE_ERROR, {
          message: 'A journal segment has a discontinuous sequence.',
        });
      }
      previous = record.sequence;
      expected += 1;
    }

    return {
      segment: {
        start,
        end: previous,
        count: lines.length,
        bytes: raw.length,
        file: segmentFileName(start),
      },
      recovery,
    };
  }

  /**
   * Re-open a segment for appending and position the write cursor at its end.
   *
   * The cursor is seeded from the segment's on-disk size, so appending continues
   * the file rather than overwriting it.
   *
   * @param {object} segment - the segment descriptor.
   * @returns {void}
   */
  #openForAppend(segment) {
    const file = path.join(this.dir, segment.file);
    this.openFd = fs.openSync(file, 'a');
    this.openFile = file;
    this.openBytes = fs.statSync(file).size;
    // The cursor counts records already in the file, regardless of whether the
    // index was built by `load` or by an append in this process.
    this.openCount = segment.count;
  }

  /**
   * The next sequence this journal will accept.
   *
   * @returns {number} `highWater + 1`, or `1` for an empty journal.
   */
  nextSequence() {
    return this.highWater === null ? 1 : this.highWater + 1;
  }

  /**
   * Append one Gateway event.
   *
   * §16: the sequence must be exactly `highWater + 1`. A duplicate, a gap or a
   * backwards sequence is a `JOURNAL_SEQUENCE_ERROR`, not a tolerated condition.
   *
   * §9: rotation happens *before* the record that would cross the target, and only
   * when the current segment is non-empty, so a single oversized record is allowed.
   *
   * @param {object} event - the Gateway event to append.
   * @returns {{sequence: number, bytes: number, rotated: boolean}} the append result.
   * @throws {PersistenceError} on a sequence violation or a write failure.
   */
  append(event) {
    if (this.closed) {
      throw persistenceError(PERSISTENCE_ERROR.UNAVAILABLE, { message: 'The journal is closed.' });
    }
    const expected = this.nextSequence();
    if (event?.sequence !== expected) {
      const actual = event?.sequence;
      throw persistenceError(PERSISTENCE_ERROR.JOURNAL_SEQUENCE_ERROR, {
        message: 'A journal append must continue the sequence exactly.',
        details: {
          expected,
          actual: Number.isSafeInteger(actual) ? actual : null,
        },
      });
    }

    // `encodeRecord` runs the structural secret guard (§54) and can throw; the
    // caller must not publish the event if it does.
    const line = `${encodeRecord(event)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');

    let rotated = false;
    if (this.openCount > 0 && this.openFd !== null && this.openBytes + bytes > this.segmentBytes) {
      this.#rotate(event.sequence);
      rotated = true;
    }
    if (this.openFd === null) {
      this.#startFirstSegment(event.sequence);
    }

    try {
      fs.writeSync(this.openFd, line, null, 'utf8');
    } catch (error) {
      // §13: the event MUST NOT be published.
      throw persistenceError(PERSISTENCE_ERROR.WRITE_FAILED, {
        message: 'A journal append failed.',
        cause: error,
      });
    }

    this.openBytes += bytes;
    this.openCount += 1;
    this.highWater = event.sequence;
    if (this.earliest === null) this.earliest = event.sequence;

    const last = this.segments[this.segments.length - 1];
    if (last !== undefined && last.file === path.basename(this.openFile ?? '')) {
      last.end = event.sequence;
      last.count = this.openCount;
      last.bytes = this.openBytes;
    }

    return { sequence: event.sequence, bytes, rotated };
  }

  /**
   * Create the first segment for a session.
   *
   * @param {number} startSequence - the first sequence.
   * @returns {void}
   */
  #startFirstSegment(startSequence) {
    const name = segmentFileName(startSequence);
    const file = path.join(this.dir, name);
    this.openFd = fs.openSync(file, 'a');
    this.openFile = file;
    this.openBytes = 0;
    this.openCount = 0;
    this.segments.push({ start: startSequence, end: null, count: 0, bytes: 0, file: name });
  }

  /**
   * Rotate to a new segment (§9).
   *
   * The closed segment is flushed before the new one opens, and rotation never
   * changes a Gateway sequence.
   *
   * @param {number} nextSequence - the sequence that will open the new segment.
   * @returns {void}
   */
  #rotate(nextSequence) {
    this.#flush();
    if (this.openFd !== null) {
      fs.closeSync(this.openFd);
      this.openFd = null;
    }
    this.openFile = null;
    this.openBytes = 0;
    this.openCount = 0;

    const name = segmentFileName(nextSequence);
    const file = path.join(this.dir, name);
    this.openFd = fs.openSync(file, 'a');
    this.openFile = file;
    this.segments.push({ start: nextSequence, end: null, count: 0, bytes: 0, file: name });
  }

  /**
   * Flush the open segment to the OS, and request a device sync.
   *
   * @returns {void}
   */
  #flush() {
    if (this.openFd === null) return;
    try {
      fs.fsyncSync(this.openFd);
    } catch {
      // A filesystem that refuses fsync (some network mounts) is not a data-loss
      // event for process-restart durability, which is R5's contract. Power-loss
      // durability is explicitly bounded — see §12 and the report.
    }
  }

  /**
   * Flush the journal. Called on rotation and on graceful shutdown (§12).
   *
   * @returns {void}
   */
  flush() {
    this.#flush();
  }

  /**
   * Every segment descriptor.
   *
   * @returns {object[]} a copy of the index.
   */
  index() {
    return this.segments.map((segment) => ({ ...segment }));
  }

  /**
   * Read records from one segment, in order.
   *
   * @param {object} segment - a segment descriptor.
   * @returns {object[]} the parsed records.
   * @throws {PersistenceError} on damage.
   */
  #readSegment(segment) {
    const file = path.join(this.dir, segment.file);
    const raw = fs.readFileSync(file);
    const text = raw.toString('utf8');
    if (text.length === 0) return [];

    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();

    const records = [];
    let expected = segment.start;
    for (const line of lines) {
      records.push(decodeRecord(line, { sessionId: this.sessionId, expectedSequence: expected }));
      expected += 1;
    }
    return records;
  }

  /**
   * Every retained record with `sequence > after`, in ascending order.
   *
   * @param {number} after - the exclusive lower bound.
   * @param {object} [options] - read options.
   * @param {number} [options.limit] - a ceiling on returned records.
   * @returns {object[]} the Gateway events.
   * @throws {PersistenceError} when `after` is not a safe integer.
   */
  eventsAfter(after, options = {}) {
    if (!Number.isSafeInteger(after)) {
      throw persistenceError(PERSISTENCE_ERROR.JOURNAL_SEQUENCE_ERROR, {
        message: 'A journal read requires an integer sequence.',
      });
    }
    const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
    const out = [];

    for (const segment of this.segments) {
      // §43: the index lets a read skip a segment entirely.
      if (segment.end !== null && segment.end <= after) continue;
      if (segment.count === 0) continue;
      for (const record of this.#readSegment(segment)) {
        if (record.sequence <= after) continue;
        out.push(record.event);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /**
   * The newest `count` retained events, oldest first.
   *
   * @param {number} count - how many to read.
   * @returns {object[]} the Gateway events.
   */
  tail(count) {
    if (!Number.isSafeInteger(count) || count < 1) return [];
    const out = [];
    for (let index = this.segments.length - 1; index >= 0 && out.length < count; index -= 1) {
      const segment = this.segments[index];
      if (segment.count === 0) continue;
      const records = this.#readSegment(segment);
      for (let cursor = records.length - 1; cursor >= 0 && out.length < count; cursor -= 1) {
        out.unshift(records[cursor].event);
      }
    }
    return out;
  }

  /**
   * The retained bounds.
   *
   * @returns {{earliest: number|null, latest: number|null, count: number}} the bounds.
   */
  bounds() {
    return { earliest: this.earliest, latest: this.highWater, count: this.eventCount };
  }

  /**
   * Apply the retention policy (§29, §30, §31).
   *
   * Deletes whole **closed** segments oldest-first until the journal is under both
   * ceilings, always keeping at least the newest segment. The active segment is
   * never rewritten, and `highWater` is never lowered — deleting old segments must
   * not let the allocator restart.
   *
   * @returns {{removed: string[], earliest: number|null, highWater: number|null, bytes: number, events: number}}
   *   what was removed.
   */
  enforceRetention() {
    const removed = [];
    const maxEvents = this.config.maxEventsPerSession;
    const maxBytes = this.config.maxBytesPerSession;

    // Only closed segments are candidates; the last one is always retained.
    let candidates = this.segments.length - 1;
    let events = this.eventCount;
    let bytes = this.byteCount;

    while (candidates > 0 && (events > maxEvents || bytes > maxBytes)) {
      const segment = this.segments[0];
      const file = path.join(this.dir, segment.file);
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          // Already gone; treat as removed so the index stays truthful.
        } else {
          throw persistenceError(PERSISTENCE_ERROR.WRITE_FAILED, {
            message: 'Retention could not remove an old journal segment.',
            cause: error,
          });
        }
      }
      removed.push(segment.file);
      this.segments.shift();
      events -= segment.count;
      bytes -= segment.bytes;
      candidates -= 1;
    }

    this.earliest = this.segments[0]?.start ?? null;
    // §31: `highWater` is the highest sequence ever used, not the highest retained.
    // It is untouched by retention, so the allocator cannot restart from `earliest`.
    return { removed, earliest: this.earliest, highWater: this.highWater, bytes, events };
  }

  /**
   * Flush and close the journal.
   *
   * @returns {void}
   */
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.openFd !== null) {
      this.#flush();
      try {
        fs.closeSync(this.openFd);
      } catch {
        // Already closed by the OS.
      }
      this.openFd = null;
      this.openFile = null;
    }
  }
}
