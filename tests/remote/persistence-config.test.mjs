/**
 * Persistence configuration and path containment tests — Phase R5 §3, §5, §56.
 *
 * These are the tests that keep the state root honest: the production default must
 * be under DSH_HOME, an override must be absolute, and no path may escape the root.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';

import {
  assertSafeSegment,
  containedPath,
  parseSegmentFileName,
  resolveDshHome,
  resolvePersistenceConfig,
  segmentFileName,
  sessionDirectoryName,
  statePaths,
  PERSISTENCE_FORMAT_VERSION,
  PERSISTENCE_ERROR,
} from './r5-helpers.mjs';
import { makeTempStateRoot } from './r3-helpers.mjs';

test('the production default root sits under DSH_HOME', () => {
  const config = resolvePersistenceConfig({}, { DSH_HOME: 'D:\\some\\home' });
  assert.equal(config.root, path.join(path.resolve('D:\\some\\home'), 'remote'));
  assert.equal(config.isDefaultRoot, true);
  assert.equal(config.formatVersion, PERSISTENCE_FORMAT_VERSION);
});

test('DSH_HOME resolution matches the DSH convention', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'D:\\explicit' }), path.resolve('D:\\explicit'));
  // Without the variable, DSH falls back to `~/.dsh`; the same rule applies here.
  assert.equal(resolveDshHome({}), path.join(os.homedir(), '.dsh'));
});

test('an override must be absolute', () => {
  assert.throws(
    () => resolvePersistenceConfig({ root: 'relative/state' }, {}),
    (error) => error.code === PERSISTENCE_ERROR.PATH_INVALID,
  );
});

test('the root may not be DSH_HOME itself', () => {
  const home = 'D:\\some\\home';
  assert.throws(
    () => resolvePersistenceConfig({ root: path.resolve(home) }, { DSH_HOME: home }),
    (error) => error.code === PERSISTENCE_ERROR.PATH_INVALID,
  );
});

test('limits default to the documented Gateway values', () => {
  const config = resolvePersistenceConfig({ root: os.tmpdir() }, {});
  assert.equal(config.segmentBytes, 4_194_304);
  assert.equal(config.maxEventsPerSession, 50_000);
  assert.equal(config.maxBytesPerSession, 67_108_864);
});

test('a malformed limit is rejected rather than silently defaulted', () => {
  for (const value of ['0', '-1', '1.5', 'many']) {
    assert.throws(
      () => resolvePersistenceConfig({ root: os.tmpdir() }, { DSH_REMOTE_JOURNAL_SEGMENT_BYTES: value }),
      (error) => error.code === PERSISTENCE_ERROR.PATH_INVALID,
      `segment bytes ${value}`,
    );
  }
});

test('an unsafe path segment is refused', () => {
  for (const bad of ['..', '.', 'a/b', 'a\\b', 'a\u0000b', 'C:', 'a..b', '']) {
    assert.throws(() => assertSafeSegment(bad, 'segment'), `segment ${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(assertSafeSegment('session-abc', 'segment'), 'session-abc');
});

test('a contained path stays inside the root', () => {
  const root = path.resolve(os.tmpdir(), 'r5-root');
  assert.equal(containedPath(root, 'events'), path.join(root, 'events'));
  assert.equal(containedPath(root, 'events', 'session-a'), path.join(root, 'events', 'session-a'));
});

test('a traversal attempt is refused, including one hidden behind valid segments', () => {
  const root = path.resolve(os.tmpdir(), 'r5-root');
  assert.throws(() => containedPath(root, '..'), 'bare parent');
  assert.throws(() => containedPath(root, '..', '..', 'etc'), 'stacked parents');
  assert.throws(() => containedPath(root, 'events', '..', '..'), 'parent after a valid segment');
  // A sibling directory whose name merely shares a prefix must also be refused.
  assert.throws(() => containedPath(root, '..', 'r5-root-backup'), 'prefix sibling');
});

test('a session directory name is the validated session id', () => {
  assert.equal(sessionDirectoryName('session-00000000-0000-0000-0000-000000000001'),
    'session-00000000-0000-0000-0000-000000000001');
  assert.throws(() => sessionDirectoryName('../escape'));
  assert.throws(() => sessionDirectoryName('a/b'));
});

test('segment filenames are zero-padded start sequences and round-trip', () => {
  assert.equal(segmentFileName(1), '00000000000000000001.jsonl');
  assert.equal(segmentFileName(1001), '00000000000000001001.jsonl');
  assert.equal(parseSegmentFileName('00000000000000001001.jsonl'), 1001);
  assert.equal(parseSegmentFileName('1001.jsonl'), null, 'unpadded is not the layout');
  assert.equal(parseSegmentFileName('00000000000000000000.jsonl'), null, 'sequence 0 is invalid');
  assert.equal(parseSegmentFileName('notes.txt'), null);
  assert.throws(() => segmentFileName(0));
  assert.throws(() => segmentFileName(-1));
  assert.throws(() => segmentFileName(1.5));
});

test('the derived path set is complete and contained', () => {
  const { root, cleanup } = makeTempStateRoot('r5-paths');
  try {
    const config = resolvePersistenceConfig({ root }, {});
    const paths = statePaths(config);
    assert.equal(paths.root, path.resolve(root));
    for (const [name, value] of Object.entries(paths)) {
      if (name === 'snapshotSlots') continue;
      assert.ok(value.startsWith(paths.root), `${name} must be inside the root`);
    }
    assert.equal(paths.snapshotSlots.length, 2, 'A/B slots');
    for (const slot of paths.snapshotSlots) assert.ok(slot.startsWith(paths.root));
  } finally {
    cleanup();
  }
});

test('the format version is 1 and is the on-disk contract', () => {
  assert.equal(PERSISTENCE_FORMAT_VERSION, 1);
});
