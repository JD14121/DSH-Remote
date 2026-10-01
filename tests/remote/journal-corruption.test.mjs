/**
 * Journal corruption and crash-tail tests — Phase R5 §20, §21, §46, §69, §70.
 *
 * Exactly one corruption is repairable: the **last line of the last segment,
 * unterminated** (§20). Everything else must fail closed (§21) — never skip a bad
 * record and carry on, because that would leave a hole in a durable sequence.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  makeTempStateRoot,
  resolvePersistenceConfig,
  readSegments,
  appendRaw,
  corruptLine,
  segmentPath,
  SESSION,
} from './r5-helpers.mjs';
import { SessionJournal } from '../../src/remote/persistence/journal.mjs';
import { PERSISTENCE_ERROR } from '../../src/remote/persistence/errors.mjs';
import { encodeRecord } from '../../src/remote/persistence/record.mjs';

/** A Gateway event. */
function ev(sequence) {
  return {
    sequence,
    event: 'task.progress',
    session_id: SESSION,
    timestamp: null,
    observed_at: null,
    data: { index: sequence },
    source_sequence: null,
  };
}

/** Write `count` valid records into a fresh root and return the paths. */
function seed(count, overrides = {}) {
  const { root, cleanup } = makeTempStateRoot('r5-corrupt');
  const config = resolvePersistenceConfig({ root, segmentBytes: 1_000_000, ...overrides }, {});
  const j = new SessionJournal({ config, sessionId: SESSION });
  j.load();
  for (let sequence = 1; sequence <= count; sequence += 1) j.append(ev(sequence));
  j.flush();
  j.close();
  return { config, cleanup, root };
}

test('an unterminated final line is truncated and the rest verifies (§20)', () => {
  const { config, cleanup } = seed(3);
  try {
    // Model a crash midway through writing record 4.
    const partial = encodeRecord(ev(4)).slice(0, 60);
    appendRaw(config, SESSION, partial);

    const before = readSegments(config, SESSION)[0];
    assert.equal(before.text.endsWith('\n'), false, 'the file really is unterminated');

    const j = new SessionJournal({ config, sessionId: SESSION });
    const loaded = j.load();

    assert.equal(loaded.state, 'recovered');
    assert.equal(loaded.highWater, 3, 'the last complete record wins');
    assert.equal(loaded.count, 3);
    assert.equal(loaded.recovery.action, 'truncated-crash-tail');
    assert.ok(loaded.recovery.discardedBytes > 0);
    assert.equal(loaded.recovery.discardedUnterminated, true);

    // The file is physically repaired, so the next append lands on a clean line.
    const after = readSegments(config, SESSION)[0];
    assert.equal(after.text.endsWith('\n'), true);
    j.append(ev(4));
    j.close();

    const reopened = new SessionJournal({ config, sessionId: SESSION });
    assert.equal(reopened.load().state, 'valid');
    assert.equal(reopened.highWater, 4);
    reopened.close();
  } finally {
    cleanup();
  }
});

test('a half-written line is never reassembled into a record (§20)', () => {
  const { config, cleanup } = seed(2);
  try {
    // A truncated record that is *almost* valid JSON must still be discarded.
    const full = encodeRecord(ev(3));
    appendRaw(config, SESSION, full.slice(0, full.length - 5));

    const j = new SessionJournal({ config, sessionId: SESSION });
    const loaded = j.load();
    assert.equal(loaded.highWater, 2, 'the partial record is gone, not parsed');
    assert.deepEqual(j.eventsAfter(0).map((e) => e.sequence), [1, 2]);
    j.close();
  } finally {
    cleanup();
  }
});

test('a crash that left only a partial record in a NEW segment is recovered', () => {
  const { config, cleanup } = seed(2, { segmentBytes: 300 });
  try {
    // Force a rotation, then write a partial record into the new segment.
    const j = new SessionJournal({ config, sessionId: SESSION });
    j.load();
    j.append(ev(3));
    j.close();
    const segments = readSegments(config, SESSION);
    assert.ok(segments.length >= 2, 'the ceiling forced a rotation');
    appendRaw(config, SESSION, encodeRecord(ev(4)).slice(0, 40));

    const reopened = new SessionJournal({ config, sessionId: SESSION });
    const loaded = reopened.load();
    assert.equal(loaded.state, 'recovered');
    assert.equal(loaded.highWater, 3);
    reopened.close();
  } finally {
    cleanup();
  }
});

test('a malformed MIDDLE line fails closed, and is never skipped (§21, §70)', () => {
  const { config, cleanup } = seed(5);
  try {
    // §70 scenario: 1..2 valid, 3 corrupt, 4..5 valid bytes.
    corruptLine(config, SESSION, 2, () => '{"v":1,"sequence":3,');

    const j = new SessionJournal({ config, sessionId: SESSION });
    assert.throws(
      () => j.load(),
      (error) => error.code === PERSISTENCE_ERROR.JOURNAL_CORRUPT,
      'a middle-of-file malformed line must not be tolerated',
    );
  } finally {
    cleanup();
  }
});

test('a complete final line with a bad checksum fails closed (§21)', () => {
  const { config, cleanup } = seed(3);
  try {
    corruptLine(config, SESSION, 2, (line) => {
      const parsed = JSON.parse(line);
      parsed.checksum = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
      return JSON.stringify(parsed);
    });

    const j = new SessionJournal({ config, sessionId: SESSION });
    assert.throws(() => j.load(), (error) => error.code === PERSISTENCE_ERROR.JOURNAL_CORRUPT);
  } finally {
    cleanup();
  }
});

test('an unknown record version fails closed', () => {
  const { config, cleanup } = seed(3);
  try {
    corruptLine(config, SESSION, 1, (line) => {
      const parsed = JSON.parse(line);
      parsed.v = 99;
      return JSON.stringify(parsed);
    });
    const j = new SessionJournal({ config, sessionId: SESSION });
    assert.throws(() => j.load(), (error) => error.code === PERSISTENCE_ERROR.JOURNAL_CORRUPT);
  } finally {
    cleanup();
  }
});

test('a duplicate sequence on disk fails closed', () => {
  const { config, cleanup } = seed(3);
  try {
    corruptLine(config, SESSION, 1, (line) => {
      const parsed = JSON.parse(line);
      // Rewrite record 2 as a copy of record 1, checksum and all, so only the
      // sequence continuity is wrong.
      return JSON.stringify({ ...parsed, sequence: 1, event: { ...parsed.event, sequence: 1 } });
    });
    const j = new SessionJournal({ config, sessionId: SESSION });
    assert.throws(
      () => j.load(),
      (error) => error.code === PERSISTENCE_ERROR.JOURNAL_CORRUPT
        || error.code === PERSISTENCE_ERROR.JOURNAL_SEQUENCE_ERROR,
    );
  } finally {
    cleanup();
  }
});

test('a sequence gap on disk fails closed', () => {
  const { config, cleanup } = seed(4);
  try {
    // Drop record 2 entirely, leaving 1,3,4.
    const segments = readSegments(config, SESSION);
    const lines = segments[0].text.split('\n').filter((line) => line.length > 0);
    const dir = path.dirname(segmentPath(config, SESSION, 1));
    fs.writeFileSync(path.join(dir, segments[0].name), `${[lines[0], lines[2], lines[3]].join('\n')}\n`, 'utf8');

    const j = new SessionJournal({ config, sessionId: SESSION });
    assert.throws(
      () => j.load(),
      (error) => error.code === PERSISTENCE_ERROR.JOURNAL_CORRUPT
        || error.code === PERSISTENCE_ERROR.JOURNAL_SEQUENCE_ERROR,
    );
  } finally {
    cleanup();
  }
});

test('a record whose session does not match its directory fails closed', () => {
  const { config, cleanup } = seed(3);
  try {
    corruptLine(config, SESSION, 1, (line) => {
      const parsed = JSON.parse(line);
      parsed.event = { ...parsed.event, session_id: 'session-00000000-0000-0000-0000-000000000099' };
      // Recompute so the failure is the session mismatch, not the checksum.
      return JSON.stringify(parsed);
    });
    const j = new SessionJournal({ config, sessionId: SESSION });
    assert.throws(() => j.load(), (error) => error.code === PERSISTENCE_ERROR.JOURNAL_CORRUPT);
  } finally {
    cleanup();
  }
});

test('a segment filename that is not a start sequence fails closed', () => {
  const { config, cleanup } = seed(2);
  try {
    const dir = path.dirname(segmentPath(config, SESSION, 1));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello\n', 'utf8');
    const j = new SessionJournal({ config, sessionId: SESSION });
    assert.throws(
      () => j.load(),
      (error) => error.code === PERSISTENCE_ERROR.JOURNAL_CORRUPT,
      'an unexpected file in the journal directory is not skipped',
    );
  } finally {
    cleanup();
  }
});

test('a segment whose start does not match its first record fails closed', () => {
  const { config, cleanup } = seed(2);
  try {
    const dir = path.dirname(segmentPath(config, SESSION, 1));
    // Rename 0000...01.jsonl to 0000...05.jsonl: the contents start at 1.
    fs.renameSync(path.join(dir, '00000000000000000001.jsonl'), path.join(dir, '00000000000000000005.jsonl'));
    const j = new SessionJournal({ config, sessionId: SESSION });
    assert.throws(
      () => j.load(),
      (error) => error.code === PERSISTENCE_ERROR.JOURNAL_CORRUPT,
      'the declared start must match the first record',
    );
  } finally {
    cleanup();
  }
});

test('an unterminated NON-final segment is not repaired', () => {
  const { config, cleanup } = seed(6, { segmentBytes: 500 });
  try {
    const segments = readSegments(config, SESSION);
    assert.ok(segments.length >= 2);
    // Truncate the *first* segment mid-line. Only the last may be repaired.
    const dir = path.dirname(segmentPath(config, SESSION, 1));
    const first = segments[0];
    fs.writeFileSync(path.join(dir, first.name), first.text.slice(0, first.text.length - 20), 'utf8');

    const j = new SessionJournal({ config, sessionId: SESSION });
    assert.throws(
      () => j.load(),
      (error) => error.code === PERSISTENCE_ERROR.JOURNAL_CORRUPT,
      'a non-final unterminated segment means real damage',
    );
  } finally {
    cleanup();
  }
});

test('an empty final segment after a rotation is legal', () => {
  const { config, cleanup } = seed(2);
  try {
    const dir = path.dirname(segmentPath(config, SESSION, 1));
    // A rotation that opened a segment and then died before writing.
    fs.writeFileSync(path.join(dir, '00000000000000000003.jsonl'), '', 'utf8');
    const j = new SessionJournal({ config, sessionId: SESSION });
    const loaded = j.load();
    assert.equal(loaded.state, 'valid');
    assert.equal(loaded.highWater, 2);
    j.close();
  } finally {
    cleanup();
  }
});
