/**
 * Writer lock tests — Phase R5 §18, §19, §44.
 *
 * The lock is what makes R5 a single writer. §44's list is the specification, and
 * the most important entry is the last: a stale lock is quarantined, never killed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  makeTempStateRoot,
  resolvePersistenceConfig,
  statePaths,
  PERSISTENCE_ERROR,
} from './r5-helpers.mjs';
import { WriterLock, probeProcess, LOCK_OUTCOME } from '../../src/remote/persistence/lock.mjs';

/** A root plus its config. */
function rootFor(label = 'r5-lock') {
  const { root, cleanup } = makeTempStateRoot(label);
  return { root, cleanup, config: resolvePersistenceConfig({ root }, {}) };
}

/** The live PID of this process, as a liveness probe would see it. */
const livePid = () => process.pid;

test('the first writer acquires the lock', () => {
  const { config, cleanup } = rootFor();
  try {
    const lock = new WriterLock({ config, instanceId: 'instance-a' });
    const result = lock.acquire();
    assert.equal(result.outcome, LOCK_OUTCOME.ACQUIRED);
    assert.equal(lock.held, true);

    const onDisk = JSON.parse(fs.readFileSync(statePaths(config).lockFile, 'utf8'));
    assert.equal(onDisk.pid, process.pid);
    assert.equal(onDisk.instance_id, 'instance-a');
    assert.equal(typeof onDisk.started_at, 'string');
  } finally {
    cleanup();
  }
});

test('a second writer is refused while the owner is provably alive', () => {
  const { config, cleanup } = rootFor();
  try {
    const first = new WriterLock({ config, instanceId: 'instance-a' });
    first.acquire();

    const second = new WriterLock({ config, instanceId: 'instance-b' });
    assert.throws(
      () => second.acquire(),
      (error) => error.code === PERSISTENCE_ERROR.LOCKED,
      'a live owner must block a second writer',
    );
    // The original lock is untouched.
    assert.equal(JSON.parse(fs.readFileSync(statePaths(config).lockFile, 'utf8')).instance_id, 'instance-a');
  } finally {
    cleanup();
  }
});

test('a provably dead PID leaves a stale lock that is recovered', () => {
  const { config, cleanup } = rootFor();
  try {
    // Seed a lock from a PID that cannot be running.
    const paths = statePaths(config);
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(paths.lockFile, JSON.stringify({ pid: 999_999_999, instance_id: 'dead', started_at: 'x' }), 'utf8');

    const lock = new WriterLock({ config, instanceId: 'fresh' });
    const result = lock.acquire();
    assert.equal(result.outcome, LOCK_OUTCOME.RECOVERED);
    assert.equal(result.recoveredFrom.pid, 999_999_999);
    assert.equal(lock.held, true);

    // The stale lock was quarantined, not deleted.
    const quarantined = fs.readdirSync(paths.staleLocksDir);
    assert.ok(quarantined.some((name) => name.endsWith('.lock')), 'the stale lock is preserved as evidence');
    assert.equal(fs.existsSync(paths.lockFile), true, 'a fresh lock now exists');
  } finally {
    cleanup();
  }
});

test('an unprovable owner is treated as alive, and refused (§18)', () => {
  const { config, cleanup } = rootFor();
  try {
    const paths = statePaths(config);
    fs.mkdirSync(paths.stateDir, { recursive: true });
    // A live PID we cannot signal: the probe reports EPERM, which is unprovable.
    fs.writeFileSync(paths.lockFile, JSON.stringify({ pid: livePid(), instance_id: 'other' }), 'utf8');

    const lock = new WriterLock({
      config,
      instanceId: 'fresh',
      probe: () => ({ alive: true, provable: false, reason: 'EPERM' }),
    });
    assert.throws(
      () => lock.acquire(),
      (error) => error.code === PERSISTENCE_ERROR.LOCKED,
      'an unprovable owner must be treated as alive',
    );
  } finally {
    cleanup();
  }
});

test('an unreadable lock is treated as owned, not stolen', () => {
  const { config, cleanup } = rootFor();
  try {
    const paths = statePaths(config);
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(paths.lockFile, 'this is not json', 'utf8');

    const lock = new WriterLock({
      config,
      instanceId: 'fresh',
      // A `null` record makes the probe report "unprovable".
      probe: (pid) => probeProcess(pid),
    });
    assert.throws(() => lock.acquire(), (error) => error.code === PERSISTENCE_ERROR.LOCKED);
  } finally {
    cleanup();
  }
});

test('release removes the lock, and only for the owning instance (§19)', () => {
  const { config, cleanup } = rootFor();
  try {
    const paths = statePaths(config);
    const lock = new WriterLock({ config, instanceId: 'owner' });
    lock.acquire();
    assert.equal(lock.release(), true);
    assert.equal(fs.existsSync(paths.lockFile), false);
    assert.equal(lock.held, false);
    // Releasing again is harmless.
    assert.equal(lock.release(), false);
  } finally {
    cleanup();
  }
});

test('an instance that no longer owns the lock cannot remove it', () => {
  const { config, cleanup } = rootFor();
  try {
    const paths = statePaths(config);
    const lock = new WriterLock({ config, instanceId: 'owner' });
    lock.acquire();

    // Another instance takes over (as if the first had been quarantined).
    fs.writeFileSync(paths.lockFile, JSON.stringify({ pid: livePid(), instance_id: 'intruder' }), 'utf8');

    assert.equal(lock.release(), false, 'the wrong owner must not delete the lock');
    assert.equal(fs.existsSync(paths.lockFile), true, 'the intruder lock survives');
    assert.equal(JSON.parse(fs.readFileSync(paths.lockFile, 'utf8')).instance_id, 'intruder');
  } finally {
    cleanup();
  }
});

test('a crash-style stale lock is recovered on the next start', () => {
  const { config, cleanup } = rootFor();
  try {
    // Instance A acquires, then "crashes" without releasing.
    const a = new WriterLock({ config, instanceId: 'crashed' });
    a.acquire();
    const paths = statePaths(config);
    const seeded = JSON.parse(fs.readFileSync(paths.lockFile, 'utf8'));
    // Rewrite with a dead PID to model a process that no longer exists.
    fs.writeFileSync(paths.lockFile, JSON.stringify({ ...seeded, pid: 999_999_998 }), 'utf8');

    const b = new WriterLock({ config, instanceId: 'restarted' });
    const result = b.acquire();
    assert.equal(result.outcome, LOCK_OUTCOME.RECOVERED);
    assert.equal(result.recoveredFrom.instance_id, 'crashed');
    assert.equal(JSON.parse(fs.readFileSync(paths.lockFile, 'utf8')).instance_id, 'restarted');
    b.release();
  } finally {
    cleanup();
  }
});

test('this process is provably alive, an impossible PID is not, and an unknown owner is unprovable', () => {
  assert.equal(probeProcess(process.pid).alive, true);
  assert.equal(probeProcess(process.pid).provable, true);
  assert.equal(probeProcess(999_999_999).alive, false);
  assert.equal(probeProcess(999_999_999).provable, true);
  // §18: an unusable PID is "owner unknown", which must count as alive.
  for (const bad of [0, -1, 'x', null, undefined]) {
    assert.equal(probeProcess(bad).alive, true, `pid ${JSON.stringify(bad)} must read as alive`);
    assert.equal(probeProcess(bad).provable, false);
  }
});

test('the lock module never delivers a signal', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../src/remote/persistence/lock.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // No process management at all.
  for (const banned of ['child_process', 'execSync', 'spawnSync', 'taskkill', 'SIGKILL', 'SIGTERM']) {
    assert.equal(code.includes(banned), false, `the lock must not use ${banned}`);
  }
  // The only `process.kill` is the zero-signal liveness probe.
  const calls = [...code.matchAll(/process\.kill\(([^)]*)\)/g)].map((match) => match[1].trim());
  assert.ok(calls.length >= 1, 'the liveness probe must exist');
  for (const call of calls) {
    assert.match(call, /,\s*0\s*$/, `process.kill(${call}) must use the zero signal`);
  }
});
