/**
 * Journal segment tests — Phase R5 §8, §9, §10, §16, §43, §45.
 *
 * Rotation, strict sequence continuity, multi-session isolation, indexing and the
 * write-ahead relationship between the ring and the journal.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  makeTempStateRoot,
  resolvePersistenceConfig,
  segmentPath,
  readSegments,
  SESSION,
  OTHER_SESSION,
} from './r5-helpers.mjs';
import { SessionJournal } from '../../src/remote/persistence/journal.mjs';
import { PERSISTENCE_ERROR } from '../../src/remote/persistence/errors.mjs';

/** A Gateway event for a session. */
function ev(sequence, sessionId = SESSION, data = {}) {
  return {
    sequence,
    event: 'task.progress',
    session_id: sessionId,
    timestamp: null,
    observed_at: null,
    data,
    source_sequence: null,
  };
}

/** Build a journal over a fresh temp root. */
function journal(overrides = {}, label = 'r5-seg') {
  const { root, cleanup } = makeTempStateRoot(label);
  const config = resolvePersistenceConfig({ root, segmentBytes: 2000, ...overrides }, {});
  return { config, cleanup, root };
}

test('an empty journal loads as EMPTY and starts at sequence 1', () => {
  const { config, cleanup } = journal();
  try {
    const j = new SessionJournal({ config, sessionId: SESSION });
    const loaded = j.load();
    assert.equal(loaded.state, 'empty');
    assert.equal(loaded.highWater, null);
    assert.equal(j.nextSequence(), 1);
    j.close();
  } finally {
    cleanup();
  }
});

test('appends continue the sequence and reload validates', () => {
  const { config, cleanup } = journal();
  try {
    const j = new SessionJournal({ config, sessionId: SESSION });
    j.load();
    for (let sequence = 1; sequence <= 5; sequence += 1) j.append(ev(sequence));
    assert.equal(j.highWater, 5);
    assert.equal(j.nextSequence(), 6);
    assert.deepEqual(j.bounds(), { earliest: 1, latest: 5, count: 5 });
    j.close();

    const reopened = new SessionJournal({ config, sessionId: SESSION });
    const loaded = reopened.load();
    assert.equal(loaded.state, 'valid');
    assert.equal(loaded.highWater, 5);
    assert.equal(loaded.count, 5);
    reopened.close();
  } finally {
    cleanup();
  }
});

test('a gap, a duplicate and a backwards sequence are all refused (§16)', () => {
  const { config, cleanup } = journal();
  try {
    const j = new SessionJournal({ config, sessionId: SESSION });
    j.load();
    j.append(ev(1));
    j.append(ev(2));

    // Not merely ">": it must be exactly `previous + 1`.
    for (const [sequence, why] of [[4, 'gap'], [2, 'duplicate'], [1, 'backwards'], [0, 'zero'], [1.5, 'fractional']]) {
      assert.throws(
        () => j.append(ev(sequence)),
        (error) => error.code === PERSISTENCE_ERROR.JOURNAL_SEQUENCE_ERROR,
        `${why} (${sequence}) must be refused`,
      );
    }
    // The failed attempts left the journal usable and unchanged.
    assert.equal(j.highWater, 2);
    assert.equal(j.nextSequence(), 3);
    j.close();
  } finally {
    cleanup();
  }
});

test('rotation creates a new segment at the next sequence (§8, §9)', () => {
  const { config, cleanup } = journal({ segmentBytes: 900 });
  try {
    const j = new SessionJournal({ config, sessionId: SESSION });
    j.load();
    const rotations = [];
    for (let sequence = 1; sequence <= 10; sequence += 1) {
      const result = j.append(ev(sequence, SESSION, { pad: 'x'.repeat(120) }));
      if (result.rotated) rotations.push(sequence);
    }
    const segments = j.index();
    assert.ok(segments.length > 1, 'the ceiling forced rotation');
    assert.deepEqual(rotations, segments.slice(1).map((segment) => segment.start),
      'each rotation opens a segment at the sequence that triggered it');

    // Segment starts match their filenames, and the ranges tile the sequence.
    let expectedStart = 1;
    for (const segment of segments) {
      assert.equal(segment.start, expectedStart, 'segments are contiguous');
      assert.equal(segment.file, `${String(segment.start).padStart(20, '0')}.jsonl`);
      expectedStart = segment.end + 1;
    }
    assert.equal(j.highWater, 10, 'rotation never changes a Gateway sequence');
    j.close();

    // And the whole set still validates on reload.
    const reopened = new SessionJournal({ config, sessionId: SESSION });
    assert.equal(reopened.load().count, 10);
    reopened.close();
  } finally {
    cleanup();
  }
});

test('a single record larger than the target is allowed in an empty segment (§9)', () => {
  const { config, cleanup } = journal({ segmentBytes: 200 });
  try {
    const j = new SessionJournal({ config, sessionId: SESSION });
    j.load();
    const big = ev(1, SESSION, { pad: 'y'.repeat(5000) });
    assert.doesNotThrow(() => j.append(big), 'an oversized first record must be accepted');
    assert.equal(j.highWater, 1);
    // The next record sees a non-empty segment past the target, so it rotates.
    const second = j.append(ev(2));
    assert.equal(second.rotated, true);
    j.close();
  } finally {
    cleanup();
  }
});

test('sessions are isolated into their own directories (§45)', () => {
  const { config, cleanup } = journal();
  try {
    const a = new SessionJournal({ config, sessionId: SESSION });
    const b = new SessionJournal({ config, sessionId: OTHER_SESSION });
    a.load();
    b.load();

    a.append(ev(1, SESSION));
    a.append(ev(2, SESSION));
    b.append(ev(1, OTHER_SESSION));

    assert.equal(a.highWater, 2);
    assert.equal(b.highWater, 1, 'each session has its own sequence space');

    // Filenames collide by design; the directories keep them apart.
    const aFiles = readSegments(config, SESSION).map((segment) => segment.name);
    const bFiles = readSegments(config, OTHER_SESSION).map((segment) => segment.name);
    assert.deepEqual(aFiles, bFiles, 'the segment names are identical');
    assert.notEqual(segmentPath(config, SESSION, 1), segmentPath(config, OTHER_SESSION, 1));

    // And a read never crosses over.
    assert.deepEqual(a.eventsAfter(0).map((e) => e.sequence), [1, 2]);
    assert.deepEqual(b.eventsAfter(0).map((e) => e.sequence), [1]);
    for (const event of b.eventsAfter(0)) assert.equal(event.session_id, OTHER_SESSION);
    a.close();
    b.close();
  } finally {
    cleanup();
  }
});

test('eventsAfter and tail read the right slice, using the index (§43)', () => {
  const { config, cleanup } = journal({ segmentBytes: 900 });
  try {
    const j = new SessionJournal({ config, sessionId: SESSION });
    j.load();
    for (let sequence = 1; sequence <= 12; sequence += 1) {
      j.append(ev(sequence, SESSION, { pad: 'z'.repeat(100) }));
    }

    assert.deepEqual(j.eventsAfter(0).map((e) => e.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.deepEqual(j.eventsAfter(10).map((e) => e.sequence), [11, 12]);
    assert.deepEqual(j.eventsAfter(12).map((e) => e.sequence), []);
    assert.deepEqual(j.eventsAfter(11, { limit: 1 }).map((e) => e.sequence), [12]);
    assert.deepEqual(j.tail(3).map((e) => e.sequence), [10, 11, 12]);
    assert.deepEqual(j.tail(100).map((e) => e.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.throws(() => j.eventsAfter('x'), (error) => error.code === PERSISTENCE_ERROR.JOURNAL_SEQUENCE_ERROR);
    j.close();
  } finally {
    cleanup();
  }
});

test('the journal is UTF-8 with LF and no BOM (§7)', () => {
  const { config, cleanup } = journal();
  try {
    const j = new SessionJournal({ config, sessionId: SESSION });
    j.load();
    j.append(ev(1, SESSION, { text: 'héllo — 世界 🌍' }));
    j.flush();
    j.close();

    const segments = readSegments(config, SESSION);
    assert.equal(segments.length, 1);
    const bytes = Buffer.from(segments[0].text, 'utf8');
    assert.notEqual(bytes[0], 0xef, 'no BOM');
    assert.equal(segments[0].text.endsWith('\n'), true, 'LF-terminated');
    assert.equal(segments[0].text.includes('\r\n'), false, 'no CRLF');
    assert.equal(segments[0].text.split('\n').length, 2, 'one record plus the terminator');
    assert.equal(JSON.parse(segments[0].text.split('\n')[0]).event.data.text, 'héllo — 世界 🌍');
  } finally {
    cleanup();
  }
});

test('the write-ahead sink makes the journal authoritative before any fan-out', () => {
  // §10: the journal append completes before the ring update and before fan-out.
  // Observable consequence: at the moment a subscriber is called, the record is
  // already on disk.
  const { config, cleanup } = journal();
  try {
    const j = new SessionJournal({ config, sessionId: SESSION });
    j.load();
    let observedOnDisk = null;

    for (let sequence = 1; sequence <= 3; sequence += 1) {
      const event = ev(sequence);
      j.append(event);
      // Reading back immediately is exactly what a subscriber would see.
      observedOnDisk = readSegments(config, SESSION)[0].text
        .split('\n')
        .filter((line) => line.length > 0)
        .length;
      assert.equal(observedOnDisk, sequence, `sequence ${sequence} must be durable before fan-out`);
    }
    j.close();
  } finally {
    cleanup();
  }
});

test('a closed journal refuses further appends', () => {
  const { config, cleanup } = journal();
  try {
    const j = new SessionJournal({ config, sessionId: SESSION });
    j.load();
    j.append(ev(1));
    j.close();
    assert.throws(() => j.append(ev(2)), (error) => error.code === PERSISTENCE_ERROR.UNAVAILABLE);
    j.close(); // idempotent
  } finally {
    cleanup();
  }
});

test('the index reports byte size, event count and range per segment', () => {
  const { config, cleanup } = journal({ segmentBytes: 900 });
  try {
    const j = new SessionJournal({ config, sessionId: SESSION });
    j.load();
    for (let sequence = 1; sequence <= 8; sequence += 1) {
      j.append(ev(sequence, SESSION, { pad: 'q'.repeat(100) }));
    }
    const index = j.index();
    assert.ok(index.length >= 2);
    for (const segment of index) {
      assert.equal(Number.isSafeInteger(segment.start), true);
      assert.equal(Number.isSafeInteger(segment.end), true);
      assert.ok(segment.count >= 1);
      assert.ok(segment.bytes > 0);
      // The recorded size matches the file on disk.
      const onDisk = readSegments(config, SESSION).find((entry) => entry.name === segment.file);
      assert.equal(segment.bytes, onDisk.bytes, `byte size for ${segment.file}`);
    }
    assert.equal(j.byteCount, readSegments(config, SESSION).reduce((sum, s) => sum + s.bytes, 0));
    j.close();
  } finally {
    cleanup();
  }
});
