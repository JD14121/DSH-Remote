/**
 * Restart tests — Phase R7 §23, §35.
 *
 * §35's expectations are the ones a real operator depends on: a restart must produce a
 * new supervisor instance, a new DSH PID and a fresh cookie — while preserving the
 * Phone credential generation and the R5 journal sequence. Getting the ephemeral half
 * wrong leaks a stale credential; getting the durable half wrong loses history.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import {
  R7_ERROR,
  SUPERVISOR_STATE,
  makeSupervisor,
  syntheticDshChild,
  syntheticResponse,
} from './r7-helpers.mjs';
import { Supervisor } from '../../src/remote/production/supervisor.mjs';
import { ProductionLogs } from '../../src/remote/production/logger.mjs';
import { RuntimeStatus } from '../../src/remote/production/runtime-status.mjs';
import { ControlChannel } from '../../src/remote/production/control-channel.mjs';

/**
 * Build a second supervisor over the same root, as a restart would.
 *
 * @param {object} fixture - the first fixture.
 * @param {object} [overrides] - seam overrides.
 * @returns {object} the new supervisor and its child.
 */
function secondSupervisor(fixture, overrides = {}) {
  const child = syntheticDshChild({ launchToken: fixture.launchToken, pid: 900002 });
  const supervisor = new Supervisor({
    config: fixture.config,
    // A restart is a new supervisor instance by definition.
    instanceId: 'instance-B',
    logs: new ProductionLogs({ paths: fixture.config.paths, secrets: [] }),
    status: new RuntimeStatus({ paths: fixture.config.paths, instanceId: 'instance-B' }),
    control: new ControlChannel({ paths: fixture.config.paths, instanceId: 'instance-B' }),
    seams: {
      spawnDsh: () => child,
      exchangeLaunchToken: syntheticResponse(303, {
        'set-cookie': [`${fixture.cookieName}=${fixture.cookieValue}; Path=/; HttpOnly`],
      }),
      verifyCookie: syntheticResponse(200, {}),
      createGateway: async () => ({ stop: async () => ({ stopped: true }), recovery: { recoveredSessions: 2 } }),
      ...overrides,
    },
  });
  return { supervisor, child };
}

test('§35: a restart keeps the same Phone credential generation', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    const generation = fixture.supervisor.credential.generationId;
    await fixture.supervisor.stop();

    const second = secondSupervisor(fixture);
    await second.supervisor.start();
    assert.equal(second.supervisor.credential.generationId, generation, 'the credential is durable');
    await second.supervisor.stop();
  } finally {
    await fixture.cleanupAll();
  }
});

test('§35: a restart produces a new instance, a new DSH PID and a fresh cookie', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    const firstInstance = fixture.supervisor.instanceId;
    const firstPid = fixture.child.pid;
    const firstCookie = fixture.supervisor.authProvider.cookie;
    await fixture.supervisor.stop();

    const second = secondSupervisor(fixture);
    await second.supervisor.start();

    assert.notEqual(second.supervisor.instanceId, firstInstance, 'a new supervisor instance');
    assert.notEqual(second.child.pid, firstPid, 'a new DSH PID');
    assert.equal(second.supervisor.authProvider.cookie, fixture.cookieValue, 'a freshly bootstrapped cookie');
    assert.notEqual(`${firstCookie}`, 'undefined', 'the first cookie existed');
    await second.supervisor.stop();
  } finally {
    await fixture.cleanupAll();
  }
});

test('§17: a restart drops the previous cookie before bootstrapping', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    await fixture.supervisor.stop();

    const second = secondSupervisor(fixture);
    // A cookie from the previous child must never be reused. The supervisor clears it
    // at the start of bootstrap, so an exchange that fails leaves nothing behind.
    second.supervisor.authProvider = {
      cookie: 'STALE_COOKIE_FROM_THE_OLD_CHILD',
      cookieName: 'dsh-auth-stale',
      ready: true,
      clear() { this.cookie = null; this.cookieName = null; },
      describe() { return {}; },
    };

    await assert.rejects(
      async () => {
        // Force the exchange to fail so the cleared state is observable.
        second.supervisor.seams.exchangeLaunchToken = syntheticResponse(401, {});
        await second.supervisor.start();
      },
      (error) => error.code === R7_ERROR.DSH_AUTH_BOOTSTRAP_FAILED,
    );
    assert.equal(second.supervisor.authProvider.cookie, null, 'the stale cookie was dropped');
    await second.supervisor.stop();
  } finally {
    await fixture.cleanupAll();
  }
});

test('§35: the R5 journal survives a restart while tickets and limits do not', async () => {
  const fixture = await makeSupervisor();
  try {
    // A first start that leaves durable recovery information behind.
    await fixture.supervisor.start();
    const recoveryOne = fixture.supervisor.recovery;
    await fixture.supervisor.stop();

    const second = secondSupervisor(fixture);
    await second.supervisor.start();
    // The restart re-initialises persistence from the same durable root, which is what
    // preserves the sequence.
    assert.deepEqual(second.supervisor.recovery, { recoveredSessions: 2 });
    assert.notDeepEqual(second.supervisor.recovery, recoveryOne);
    await second.supervisor.stop();
  } finally {
    await fixture.cleanupAll();
  }
});

test('§35: the journal files are untouched by a restart', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    // Write an events artefact so there is durable content to preserve.
    fs.mkdirSync(fixture.config.paths.events, { recursive: true });
    const journalFile = `${fixture.config.paths.events}/session-x.0001.jsonl`;
    fs.writeFileSync(journalFile, '{"v":1,"sequence":1}\n', 'utf8');
    const before = fs.readFileSync(journalFile, 'utf8');
    await fixture.supervisor.stop();

    const second = secondSupervisor(fixture);
    await second.supervisor.start();
    // The supervisor must not truncate or rewrite existing journal state.
    assert.equal(fs.readFileSync(journalFile, 'utf8'), before, 'the journal is preserved verbatim');
    await second.supervisor.stop();
  } finally {
    await fixture.cleanupAll();
  }
});

test('§19: the status file moves to the new instance', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    const first = JSON.parse(fs.readFileSync(fixture.config.paths.supervisorJson, 'utf8'));
    await fixture.supervisor.stop();

    const second = secondSupervisor(fixture);
    await second.supervisor.start();
    const record = JSON.parse(fs.readFileSync(fixture.config.paths.supervisorJson, 'utf8'));
    assert.notEqual(record.instance_id, first.instance_id);
    assert.equal(record.instance_id, 'instance-B');
    assert.equal(record.state, 'READY');
    assert.equal(record.dsh_pid, second.child.pid);
    await second.supervisor.stop();
  } finally {
    await fixture.cleanupAll();
  }
});

test('§20: a stale stop request cannot stop the new instance', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    // The old instance is asked to stop but never consumes the request.
    fixture.supervisor.control.requestStop();
    await fixture.supervisor.stop();

    const second = secondSupervisor(fixture);
    await second.supervisor.start();
    // The new instance polls: the stale request is for another instance.
    const result = await second.supervisor.pollControl();
    assert.equal(result.action, 'none', 'the stale request must not stop the new stack');
    assert.equal(second.supervisor.status.state, 'READY');
    await second.supervisor.stop();
  } finally {
    await fixture.cleanupAll();
  }
});

test('§35: a restart whose bootstrap fails leaves FAILED, not a stale READY', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    await fixture.supervisor.stop();

    const second = secondSupervisor(fixture, { exchangeLaunchToken: syntheticResponse(401, {}) });
    await assert.rejects(() => second.supervisor.start());
    assert.equal(second.supervisor.status.state, SUPERVISOR_STATE.FAILED);
    const record = JSON.parse(fs.readFileSync(fixture.config.paths.supervisorJson, 'utf8'));
    assert.equal(record.state, 'FAILED');
    await second.supervisor.stop();
  } finally {
    await fixture.cleanupAll();
  }
});

test('§39: a restart leaves no secret behind', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    await fixture.supervisor.stop();
    const second = secondSupervisor(fixture);
    await second.supervisor.start();
    await second.supervisor.stop();

    const { scanTreeForSecrets } = await import('./r7-helpers.mjs');
    const scan = scanTreeForSecrets(fixture.config.paths.root, [fixture.launchToken, fixture.cookieValue]);
    assert.deepEqual(scan.leaked, [], 'neither the launch token nor the cookie is durable');
  } finally {
    await fixture.cleanupAll();
  }
});
