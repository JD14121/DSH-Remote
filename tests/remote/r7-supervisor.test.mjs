/**
 * Supervisor lifecycle tests — Phase R7 §19, §20, §23, §28, §31.
 *
 * §31 is the requirement that shapes most of these: `READY` means every axis is
 * healthy, not that a port is open. A supervisor that reported READY with a dead DSH
 * child would be worse than one that crashed, because an operator would trust it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import {
  R7_ERROR,
  SUPERVISOR_STATE,
  makeSupervisor,
  makeTempProduction,
  readLogRecords,
  scanTreeForSecrets,
  syntheticDshChild,
  syntheticResponse,
} from './r7-helpers.mjs';
import { ProductionError } from '../../src/remote/production/production-config.mjs';

test('§31: a healthy stack reaches READY with every axis proven', async () => {
  const fixture = await makeSupervisor();
  try {
    const started = await fixture.supervisor.start();
    assert.equal(started.state, 'READY');
    assert.equal(fixture.supervisor.status.state, 'READY');

    const described = fixture.supervisor.describe();
    assert.equal(described.credential.loaded, true, 'credential axis');
    assert.equal(described.auth.ready, true, 'cookie axis');
    assert.equal(described.dsh.alive, true, 'DSH process axis');
    assert.equal(described.gateway.port, fixture.config.gatewayPort, 'gateway axis');
    assert.equal(described.last_error_code, null);
  } finally {
    await fixture.cleanupAll();
  }
});

test('§19: the status file is READY only after the gateway started', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    const record = JSON.parse(fs.readFileSync(fixture.config.paths.supervisorJson, 'utf8'));
    assert.equal(record.state, 'READY');
    assert.equal(record.dsh_pid, fixture.child.pid);
    assert.equal(record.gateway.host, '127.0.0.1');
    assert.equal(record.gateway.port, fixture.config.gatewayPort);
    assert.equal(record.dsh.version, '0.1.5-rc.2');
  } finally {
    await fixture.cleanupAll();
  }
});

test('§19: the log records the documented event sequence', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    const events = readLogRecords(fixture.config)
      .map((record) => record.event)
      .filter((event) => event !== 'raw');
    // The order is the §15/§17 ordering made observable.
    assert.deepEqual(events, [
      'supervisor_start',
      'credential_created',
      'dsh_spawned',
      'dsh_bootstrap_token_observed',
      'dsh_auth_cookie_obtained',
      'dsh_ready',
      'gateway_starting',
      'gateway_ready',
    ]);
  } finally {
    await fixture.cleanupAll();
  }
});

test('§28: the credential is loaded, never regenerated, on a second start', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    const firstGeneration = fixture.supervisor.credential.generationId;
    await fixture.supervisor.stop();

    // A fresh supervisor over the same root must load the existing credential.
    const { Supervisor } = await import('../../src/remote/production/supervisor.mjs');
    const second = new Supervisor({
      config: fixture.config,
      seams: {
        spawnDsh: () => syntheticDshChild({}),
        exchangeLaunchToken: syntheticResponse(303, {
          'set-cookie': [`${fixture.cookieName}=${fixture.cookieValue}; Path=/`],
        }),
        verifyCookie: syntheticResponse(200, {}),
        createGateway: async () => ({ stop: async () => ({}) }),
      },
    });
    await second.start();
    assert.equal(second.credential.generationId, firstGeneration, 'the same credential generation');
    await second.stop();
  } finally {
    await fixture.cleanupAll();
  }
});

test('§39: no secret reaches the durable root', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    const token = fixture.supervisor.credential.requireToken();

    const scan = scanTreeForSecrets(fixture.config.paths.root, [
      token,
      fixture.launchToken,
      fixture.cookieValue,
    ]);
    // The credential file is the ONE permitted location for the Phone token.
    const permitted = new Set([
      'secrets\\phone-token.v1',
      'secrets/phone-token.v1',
    ]);
    const unexpected = scan.leaked.filter((file) => !permitted.has(file));
    assert.deepEqual(unexpected, [], `no secret may appear outside the credential file: ${scan.leaked.join(', ')}`);

    // And the two ephemeral secrets appear nowhere at all.
    const ephemeral = scanTreeForSecrets(fixture.config.paths.root, [fixture.launchToken, fixture.cookieValue]);
    assert.deepEqual(ephemeral.leaked, [], 'a launch token and cookie are memory-only');
  } finally {
    await fixture.cleanupAll();
  }
});

test('§16: an unresolved launch token fails closed and stops the child', async () => {
  const fixture = await makeSupervisor({ child: { announce: false }, seams: {} });
  try {
    // Shorten the wait so the test does not take the full 60s production timeout.
    fixture.supervisor.config.startTimeoutMs = 150;
    await assert.rejects(
      () => fixture.supervisor.start(),
      (error) => error.code === R7_ERROR.DSH_BOOTSTRAP_TOKEN_UNRESOLVED,
    );
    // The state must not be READY, and the reason must be recorded.
    assert.equal(fixture.supervisor.status.state, 'FAILED');
    const record = JSON.parse(fs.readFileSync(fixture.config.paths.supervisorJson, 'utf8'));
    assert.equal(record.last_error_code, 'R7_DSH_BOOTSTRAP_TOKEN_UNRESOLVED');
    await fixture.supervisor.stop();
  } finally {
    await fixture.cleanupAll();
  }
});

test('§17: a refused cookie exchange fails closed', async () => {
  const fixture = await makeSupervisor({ exchange: syntheticResponse(401, {}) });
  try {
    await assert.rejects(
      () => fixture.supervisor.start(),
      (error) => error.code === R7_ERROR.DSH_AUTH_BOOTSTRAP_FAILED,
    );
    assert.equal(fixture.supervisor.status.state, 'FAILED');
    await fixture.supervisor.stop();
  } finally {
    await fixture.cleanupAll();
  }
});

test('§17: a cookie that does not verify fails closed', async () => {
  const fixture = await makeSupervisor({ verify: syntheticResponse(403, {}) });
  try {
    await assert.rejects(
      () => fixture.supervisor.start(),
      (error) => error.code === R7_ERROR.DSH_AUTH_BOOTSTRAP_FAILED,
    );
    assert.equal(fixture.supervisor.status.state, 'FAILED');
    await fixture.supervisor.stop();
  } finally {
    await fixture.cleanupAll();
  }
});

test('§23: a child exit during bootstrap is a bootstrap failure', async () => {
  const fixture = await makeSupervisor({ child: { announce: false } });
  try {
    fixture.supervisor.config.startTimeoutMs = 2000;
    const started = fixture.supervisor.start().catch((error) => error);
    // The child dies before it can announce.
    setTimeout(() => fixture.child.emitExit({ code: 1 }), 30);
    const outcome = await started;
    assert.ok(outcome instanceof ProductionError, 'the start must fail');
    assert.equal(outcome.code, R7_ERROR.DSH_PROCESS_EXITED);
    await fixture.supervisor.stop();
  } finally {
    await fixture.cleanupAll();
  }
});

test('§23: an unexpected exit is recovered with bounded retries', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    assert.equal(fixture.supervisor.status.state, 'READY');

    // Make the restart backoff instant so the test does not wait 1s + 2s + 4s.
    fixture.supervisor.config.restartBackoffMs = [1, 1, 1];

    // A **fresh** child per attempt: a consumed stub cannot be restarted, and the
    // supervisor is required to spawn a new process each time.
    const spawned = [];
    fixture.supervisor.seams.spawnDsh = () => {
      const child = syntheticDshChild({ launchToken: fixture.launchToken });
      spawned.push(child);
      return child;
    };

    fixture.child.emitExit({ code: 1 });
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.ok(spawned.length >= 1, 'a fresh child was spawned');
    assert.notEqual(fixture.supervisor.dsh, fixture.child, 'the dead child was replaced');
    assert.equal(fixture.supervisor.status.state, 'READY', 'and the stack recovered');
    // Recovery resets nothing on its own; the counter records the one observed exit.
    assert.ok(fixture.supervisor.consecutiveFailures >= 1);
  } finally {
    await fixture.cleanupAll();
  }
});

test('§23: exhausting the retry budget lands in FAILED and stops claiming READY', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    fixture.supervisor.config.restartBackoffMs = [1, 1, 1];
    // Every restart attempt fails immediately.
    fixture.supervisor.seams.spawnDsh = () => {
      const child = syntheticDshChild({ announce: false });
      return child;
    };
    fixture.supervisor.config.startTimeoutMs = 30;

    fixture.child.emitExit({ code: 1 });
    await new Promise((resolve) => setTimeout(resolve, 600));

    assert.equal(fixture.supervisor.status.state, 'FAILED');
    assert.equal(fixture.supervisor.status.record.last_error_code, R7_ERROR.DSH_PROCESS_EXITED);
    assert.ok(fixture.supervisor.consecutiveFailures > fixture.supervisor.config.maxRestarts);
  } finally {
    await fixture.cleanupAll();
  }
});

test('§23: a stable period clears the consecutive failure count', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    fixture.supervisor.config.restartBackoffMs = [1, 1, 1];

    // Pretend the stack has been healthy well past the stability window.
    fixture.supervisor.lastStableAt = new Date(Date.now() - fixture.supervisor.config.stabilityMs - 1000);
    fixture.supervisor.consecutiveFailures = 2;

    fixture.supervisor.seams.spawnDsh = () => syntheticDshChild({ launchToken: fixture.launchToken });

    fixture.child.emitExit({ code: 1 });
    await new Promise((resolve) => setTimeout(resolve, 250));

    // The counter was reset before the increment, so it is 1 rather than 3.
    assert.equal(fixture.supervisor.consecutiveFailures, 1);
  } finally {
    await fixture.cleanupAll();
  }
});

test('§20: a control stop request shuts the supervisor down', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    // Write a stop request addressed to this instance, then poll.
    fixture.supervisor.control.requestStop();
    const result = await fixture.supervisor.pollControl();
    assert.equal(result.action, 'stop');

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fixture.supervisor.status.state, 'STOPPED');
  } finally {
    await fixture.cleanupAll();
  }
});

test('§20: a stop request for another instance is ignored', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    fixture.supervisor.control.requestStop({
      v: 1,
      instance_id: 'some-other-instance',
      request_id: 'r1',
      action: 'stop',
      created_at: new Date().toISOString(),
    });
    const result = await fixture.supervisor.pollControl();
    assert.equal(result.action, 'none');
    assert.equal(fixture.supervisor.status.state, 'READY', 'the healthy supervisor keeps running');
  } finally {
    await fixture.cleanupAll();
  }
});

test('§31: the gateway seam is called with everything Gate B needs', async () => {
  const calls = [];
  const fixture = await makeSupervisor({
    createGateway: async (context) => {
      calls.push(context);
      return { stop: async () => ({ stopped: true }), recovery: { recoveredSessions: 3, highWater: 7 } };
    },
  });
  try {
    await fixture.supervisor.start();
    assert.equal(calls.length, 1, 'the gateway factory ran once');
    // The seam receives the config, the credential and the auth provider, so Gate B
    // can construct a real gateway without the supervisor knowing how.
    assert.equal(calls[0].config, fixture.config);
    assert.ok(calls[0].authProvider !== undefined, 'the auth provider is passed');
    assert.ok(calls[0].credential !== undefined, 'the credential store is passed');
    assert.equal(typeof calls[0].onEvent, 'function', 'the log sink is passed');
    // And the recovery report is available for the live smoke to assert against.
    assert.equal(fixture.supervisor.recovery.recoveredSessions, 3);
    assert.equal(typeof fixture.supervisor.gateway.stop, 'function');
  } finally {
    await fixture.cleanupAll();
  }
});

test('§31: a gateway factory failure is a startup failure, not a silent READY', async () => {
  const fixture = await makeSupervisor({
    createGateway: async () => { throw new Error('bind refused'); },
  });
  try {
    await assert.rejects(() => fixture.supervisor.start(), /bind refused/);
    assert.equal(fixture.supervisor.status.state, 'FAILED');
    await fixture.supervisor.stop();
  } finally {
    await fixture.cleanupAll();
  }
});

test('the supervisor refuses to exist without a config', async () => {
  const { Supervisor } = await import('../../src/remote/production/supervisor.mjs');
  assert.throws(() => new Supervisor({}), TypeError);
  assert.throws(() => new Supervisor(), TypeError);
});

test('§19: a fresh supervisor starts from STOPPED', async () => {
  const fixture = await makeTempProduction();
  try {
    const { Supervisor } = await import('../../src/remote/production/supervisor.mjs');
    const supervisor = new Supervisor({ config: fixture.config, seams: {} });
    assert.equal(supervisor.status.state, SUPERVISOR_STATE.STOPPED);
    assert.equal(supervisor.gateway, null);
    assert.equal(supervisor.dsh, null);
  } finally {
    fixture.cleanup();
  }
});
