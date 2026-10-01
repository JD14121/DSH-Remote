/**
 * Log rotation tests — Phase R7 §26.
 *
 * A log that grows without bound is a slow outage, and a rotation that renames in the
 * wrong order silently destroys the older backups one by one. Both matter, so the
 * order is asserted rather than assumed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import { RotatingLog, makeTempProduction } from './r7-helpers.mjs';

/** A rotating log on a temp root. */
function rotationFixture(options = {}) {
  const { config, cleanup } = makeTempProduction();
  const log = new RotatingLog({
    filePath: config.paths.supervisorLog,
    maxBytes: options.maxBytes ?? 512,
    backups: options.backups ?? 3,
  });
  return { config, cleanup, log };
}

/** Write enough lines to exceed the limit. */
function fill(log, count = 10) {
  for (let index = 0; index < count; index += 1) {
    log.event('gateway_ready', { index, padding: 'x'.repeat(40) });
  }
}

test('§26: the documented defaults are 10 MiB and 5 backups', () => {
  const { config, cleanup } = makeTempProduction();
  try {
    assert.equal(config.logMaxBytes, 10_485_760);
    assert.equal(config.logBackups, 5);
  } finally {
    cleanup();
  }
});

test('§26: a log below the limit does not rotate', () => {
  const { cleanup, log } = rotationFixture();
  try {
    log.event('gateway_ready', { small: true });
    assert.equal(log.rotations, 0);
    assert.equal(fs.existsSync(`${log.filePath}.1`), false);
  } finally {
    cleanup();
  }
});

test('§26: exceeding the limit rotates to .1', () => {
  const { cleanup, log } = rotationFixture({ maxBytes: 400 });
  try {
    fill(log, 20);
    assert.ok(log.rotations >= 1, 'at least one rotation happened');
    assert.equal(fs.existsSync(`${log.filePath}.1`), true, 'and a backup exists');
  } finally {
    cleanup();
  }
});

test('§26: rotation renames upward, so backups are not destroyed', () => {
  // Renaming downward (`N` -> `N+1` starting at 1) overwrites `.1` with `.2` and
  // loses the oldest history every cycle. Ascending order is what makes it lossless.
  const { cleanup, log } = rotationFixture({ maxBytes: 200, backups: 3 });
  try {
    // Force several rotations with distinguishable content.
    for (let round = 0; round < 12; round += 1) {
      log.writeLine(JSON.stringify({ marker: `round-${round}`, padding: 'y'.repeat(120) }));
    }

    const backups = [];
    for (let index = 1; index <= 3; index += 1) {
      const file = `${log.filePath}.${index}`;
      if (fs.existsSync(file)) {
        const first = fs.readFileSync(file, 'utf8').trim().split('\n')[0];
        backups.push({ index, marker: JSON.parse(first).marker });
      }
    }
    assert.ok(backups.length >= 2, `at least two backups, saw ${backups.length}`);

    // `.1` must be NEWER than `.2`, which must be newer than `.3` — that ordering is
    // what proves the rename direction.
    const roundOf = (marker) => Number(marker.replace('round-', ''));
    for (let index = 1; index < backups.length; index += 1) {
      assert.ok(
        roundOf(backups[index - 1].marker) > roundOf(backups[index].marker),
        `.${backups[index - 1].index} (${backups[index - 1].marker}) must be newer than .${backups[index].index} (${backups[index].marker})`,
      );
    }
  } finally {
    cleanup();
  }
});

test('§26: the backup count is bounded', () => {
  const { cleanup, log } = rotationFixture({ maxBytes: 150, backups: 2 });
  try {
    for (let round = 0; round < 40; round += 1) {
      log.writeLine(JSON.stringify({ marker: `round-${round}`, padding: 'z'.repeat(100) }));
    }
    // No `.3` may exist when the limit is 2.
    assert.equal(fs.existsSync(`${log.filePath}.3`), false, 'beyond the backup count');
    assert.equal(fs.existsSync(`${log.filePath}.2`), true, 'the limit itself exists');
  } finally {
    cleanup();
  }
});

test('§26: zero backups truncates rather than growing without bound', () => {
  const { cleanup, log } = rotationFixture({ maxBytes: 150, backups: 0 });
  try {
    for (let round = 0; round < 20; round += 1) {
      log.writeLine(JSON.stringify({ marker: `round-${round}`, padding: 'w'.repeat(100) }));
    }
    assert.ok(log.rotations >= 1);
    assert.equal(fs.existsSync(`${log.filePath}.1`), false, 'no backups were requested');
    // And the current file is not enormous.
    assert.ok(log.size() < 150 * 3, `the log stayed bounded, saw ${log.size()}`);
  } finally {
    cleanup();
  }
});

test('§26: a rotation is not attempted on every single write', () => {
  const { cleanup, log } = rotationFixture({ maxBytes: 400 });
  try {
    fill(log, 5);
    const first = log.rotations;
    // A few small writes below the limit must not rotate again.
    log.writeLine('{"small":1}');
    assert.equal(log.rotations, first);
  } finally {
    cleanup();
  }
});

test('§26: rotation is reported, not silent', () => {
  const { cleanup, log } = rotationFixture({ maxBytes: 200 });
  try {
    fill(log, 20);
    const summary = log.close();
    assert.equal(summary.flushed, true);
    assert.ok(summary.rotations >= 1);
    assert.ok(summary.bytesWritten > 0);
    assert.equal(summary.degraded, false);
  } finally {
    cleanup();
  }
});

test('§26: a rotation failure degrades rather than throwing', () => {
  const { config, cleanup } = makeTempProduction();
  try {
    fs.mkdirSync(config.paths.logs, { recursive: true });
    const log = new RotatingLog({ filePath: config.paths.supervisorLog, maxBytes: 10 });
    // Create a DIRECTORY where the backup file should go, so the rename fails.
    fs.mkdirSync(`${log.filePath}.1`);
    const wrote = log.event('gateway_ready', { a: 'x'.repeat(50) });
    // Either it wrote before rotating, or the rotation failed — but it must not throw.
    assert.equal(typeof wrote, 'boolean');
    assert.doesNotThrow(() => log.event('error', { code: 'X' }));
  } finally {
    cleanup();
  }
});

test('§26: size() returns 0 for a missing file', () => {
  const { cleanup, log } = rotationFixture();
  try {
    assert.equal(log.size(), 0);
  } finally {
    cleanup();
  }
});

test('§26: rotation preserves the whole content, losing nothing', () => {
  // Every marker written must exist somewhere: in the live file or in a backup.
  const { cleanup, log } = rotationFixture({ maxBytes: 300, backups: 5 });
  try {
    const markers = [];
    for (let round = 0; round < 8; round += 1) {
      markers.push(`keep-${round}`);
      log.writeLine(JSON.stringify({ marker: `keep-${round}`, padding: 'k'.repeat(40) }));
    }

    const seen = new Set();
    const files = [log.filePath];
    for (let index = 1; index <= 5; index += 1) {
      const file = `${log.filePath}.${index}`;
      if (fs.existsSync(file)) files.push(file);
    }
    for (const file of files) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (line.trim().length === 0) continue;
        try { seen.add(JSON.parse(line).marker); } catch { /* ignore */ }
      }
    }

    // With 5 backups and 8 writes, everything must still be present.
    for (const marker of markers) {
      assert.equal(seen.has(marker), true, `${marker} must survive rotation`);
    }
  } finally {
    cleanup();
  }
});
