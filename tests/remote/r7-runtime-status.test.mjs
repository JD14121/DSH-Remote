/**
 * Runtime status tests — Phase R7 §19, §39.
 *
 * The state machine and the status file are both security-relevant: a status file
 * that leaks a credential is a disclosure, and one that reports `READY` when the stack
 * is not ready is a lie an operator will act on.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import {
  R7_ERROR,
  RuntimeStatus,
  SUPERVISOR_STATE,
  canTransition,
  makeTempProduction,
  readStatus,
  sanitizeFields,
  writeAtomic,
} from './r7-helpers.mjs';

/** Build a status writer on a temp root. */
function statusFixture() {
  const { config, cleanup } = makeTempProduction();
  const status = new RuntimeStatus({
    paths: config.paths,
    instanceId: 'instance-A',
    clock: () => new Date('2026-09-19T12:00:00.000Z'),
  });
  return { config, cleanup, status };
}

test('§19: the eight documented states exist', () => {
  assert.deepEqual(
    Object.values(SUPERVISOR_STATE).sort(),
    ['BOOTSTRAPPING_DSH', 'FAILED', 'READY', 'RESTARTING', 'STARTING', 'STARTING_GATEWAY', 'STOPPED', 'STOPPING'].sort(),
  );
});

test('§19: the happy path transitions are permitted', () => {
  const path = [
    SUPERVISOR_STATE.STOPPED,
    SUPERVISOR_STATE.STARTING,
    SUPERVISOR_STATE.BOOTSTRAPPING_DSH,
    SUPERVISOR_STATE.STARTING_GATEWAY,
    SUPERVISOR_STATE.READY,
    SUPERVISOR_STATE.STOPPING,
    SUPERVISOR_STATE.STOPPED,
  ];
  for (let index = 1; index < path.length; index += 1) {
    assert.equal(canTransition(path[index - 1], path[index]), true, `${path[index - 1]} -> ${path[index]}`);
  }
});

test('§19: a shortcut to READY is refused', () => {
  // STARTING -> READY would mean claiming readiness without bootstrapping DSH.
  assert.equal(canTransition(SUPERVISOR_STATE.STARTING, SUPERVISOR_STATE.READY), false);
  assert.equal(canTransition(SUPERVISOR_STATE.BOOTSTRAPPING_DSH, SUPERVISOR_STATE.READY), false);
  assert.equal(canTransition(SUPERVISOR_STATE.STARTING_GATEWAY, SUPERVISOR_STATE.BOOTSTRAPPING_DSH), false);
});

test('§19: an illegal transition throws rather than corrupting the state', () => {
  const { cleanup, status } = statusFixture();
  try {
    status.transition(SUPERVISOR_STATE.STARTING);
    // STARTING -> STARTING_GATEWAY skips DSH bootstrap entirely.
    assert.throws(
      () => status.transition(SUPERVISOR_STATE.STARTING_GATEWAY),
      (error) => error.code === R7_ERROR.PRODUCTION_SMOKE_FAILED,
    );
  } finally {
    cleanup();
  }
});

test('§19: the status file records the documented safe fields', () => {
  const { config, cleanup, status } = statusFixture();
  try {
    status.transition(SUPERVISOR_STATE.STARTING, { started_at: '2026-09-19T12:00:00.000Z' });
    status.transition(SUPERVISOR_STATE.BOOTSTRAPPING_DSH);
    status.transition(SUPERVISOR_STATE.STARTING_GATEWAY);
    status.transition(SUPERVISOR_STATE.READY, {
      dsh_pid: 4321,
      dsh: { host: '127.0.0.1', port: 3080, version: '0.1.5-rc.2' },
      gateway: { host: '127.0.0.1', port: 9445 },
    });

    const record = readStatus(config.paths.supervisorJson);
    assert.equal(record.state, 'READY');
    assert.equal(record.instance_id, 'instance-A');
    assert.equal(record.supervisor_pid, process.pid);
    assert.equal(record.dsh_pid, 4321);
    assert.equal(record.gateway.port, 9445);
    assert.equal(record.dsh.version, '0.1.5-rc.2');
    assert.equal(record.v, 1);
    assert.equal(record.last_error_code, null);
  } finally {
    cleanup();
  }
});

test('§19: the status file can never record a secret', () => {
  const { cleanup, status } = statusFixture();
  try {
    status.transition(SUPERVISOR_STATE.STARTING);
    for (const field of ['token', 'phone_token', 'launch_token', 'cookie', 'secret', 'authorization', 'digest', 'fingerprint']) {
      assert.throws(
        () => status.write({ [field]: 'x' }),
        (error) => error.code === R7_ERROR.PRODUCTION_SMOKE_FAILED,
        `${field} must be refused`,
      );
    }
  } finally {
    cleanup();
  }
});

test('§19: field-name normalisation catches spelling variants', () => {
  for (const field of ['launchToken', 'LAUNCH-TOKEN', 'launch_token', 'Launch_Token', 'phoneToken', 'setCookie']) {
    assert.throws(
      () => sanitizeFields({ [field]: 'x' }),
      (error) => error.code === R7_ERROR.PRODUCTION_SMOKE_FAILED,
      `${field} must be refused`,
    );
  }
  // And safe fields pass.
  assert.deepEqual(sanitizeFields({ dsh_pid: 1, gateway: { port: 2 } }), { dsh_pid: 1, gateway: { port: 2 } });
});

test('§19: a failure records the code rather than only the state', () => {
  const { config, cleanup, status } = statusFixture();
  try {
    status.transition(SUPERVISOR_STATE.STARTING);
    status.fail(R7_ERROR.DSH_BOOTSTRAP_TOKEN_UNRESOLVED, 'no announcement');
    const record = readStatus(config.paths.supervisorJson);
    assert.equal(record.state, 'FAILED');
    // "It failed" is not actionable; the code is.
    assert.equal(record.last_error_code, 'R7_DSH_BOOTSTRAP_TOKEN_UNRESOLVED');
    assert.equal(record.last_error_detail, 'no announcement');
  } finally {
    cleanup();
  }
});

test('§19: the status write is atomic, so a reader never sees a partial file', () => {
  const { config, cleanup, status } = statusFixture();
  try {
    status.transition(SUPERVISOR_STATE.STARTING);
    // No temp sibling survives a successful write.
    const leftovers = fs.readdirSync(config.paths.state).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
    // And the file parses.
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(config.paths.supervisorJson, 'utf8')));
  } finally {
    cleanup();
  }
});

test('§19: writeAtomic never leaves a temp file behind', () => {
  const { config, cleanup } = makeTempProduction();
  try {
    const target = config.paths.supervisorJson;
    writeAtomic(target, '{"a":1}\n');
    writeAtomic(target, '{"a":2}\n');
    assert.equal(fs.readFileSync(target, 'utf8'), '{"a":2}\n');
    const leftovers = fs.readdirSync(config.paths.state).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
    // No BOM (§45).
    assert.equal(fs.readFileSync(target)[0] === 0xEF, false);
  } finally {
    cleanup();
  }
});

test('§19: history is retained for diagnosis', () => {
  const { cleanup, status } = statusFixture();
  try {
    status.transition(SUPERVISOR_STATE.STARTING);
    status.transition(SUPERVISOR_STATE.BOOTSTRAPPING_DSH);
    status.transition(SUPERVISOR_STATE.STARTING_GATEWAY);
    const snapshot = status.snapshot();
    assert.equal(snapshot.history.length, 3);
    assert.deepEqual(snapshot.history.map((entry) => entry.to), ['STARTING', 'BOOTSTRAPPING_DSH', 'STARTING_GATEWAY']);
  } finally {
    cleanup();
  }
});

test('§19: a FAILED or STOPPED record is not treated as a live supervisor', async () => {
  const { isLiveSupervisor } = await import('../../src/remote/production/runtime-status.mjs');
  // A failed supervisor must not block a fresh start.
  assert.equal(isLiveSupervisor({ state: 'FAILED', supervisor_pid: process.pid }), false);
  assert.equal(isLiveSupervisor({ state: 'STOPPED', supervisor_pid: process.pid }), false);
  // A READY one whose PID is alive does block.
  assert.equal(isLiveSupervisor({ state: 'READY', supervisor_pid: process.pid }), true);
  // And a READY one whose PID is gone does not.
  assert.equal(isLiveSupervisor({ state: 'READY', supervisor_pid: process.pid }, () => false), false);
  assert.equal(isLiveSupervisor(null), false);
  assert.equal(isLiveSupervisor({ state: 'READY' }), false, 'no PID means no live supervisor');
});

test('§19: an unreadable status file reads as absent rather than throwing', () => {
  const { config, cleanup } = makeTempProduction();
  try {
    fs.mkdirSync(config.paths.state, { recursive: true });
    fs.writeFileSync(config.paths.supervisorJson, '{ not json', 'utf8');
    assert.equal(readStatus(config.paths.supervisorJson), null);
    assert.equal(readStatus('D:\\does\\not\\exist.json'), null);
  } finally {
    cleanup();
  }
});
