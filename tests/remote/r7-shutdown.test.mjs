/**
 * Shutdown tests — Phase R7 §22, §26, §39.
 *
 * §22 fixes the order, and the order matters: the Gateway stops before the DSH child,
 * so no request is ever served by a stack whose backend has already gone away.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import {
  SUPERVISOR_STATE,
  makeSupervisor,
  makeTempProduction,
  readLogRecords,
  scanTreeForSecrets,
} from './r7-helpers.mjs';

/** A supervisor whose collaborators record the order in which they stop. */
async function orderedFixture() {
  const order = [];
  const fixture = await makeSupervisor({
    createGateway: async () => ({
      stop: async () => { order.push('gateway.stop'); return { stopped: true }; },
      recovery: {},
    }),
  });
  // Record the child stop through the synthetic child.
  const child = fixture.child;
  const originalStop = child.stop.bind(child);
  child.stop = async (...args) => { order.push('dsh.stop'); return originalStop(...args); };
  return { ...fixture, order };
}

test('§22: stop runs gateway, then DSH, then logs', async () => {
  const fixture = await orderedFixture();
  try {
    await fixture.supervisor.start();
    fixture.order.length = 0;

    const result = await fixture.supervisor.stop();
    assert.deepEqual(fixture.order, ['gateway.stop', 'dsh.stop'], 'the order is fixed');
    assert.equal(result.state, SUPERVISOR_STATE.STOPPED);
    // The logs summary is per-log, so each one reports its own flush.
    assert.equal(result.logs.supervisor.flushed, true);
    assert.equal(result.logs.gateway.flushed, true);
    assert.equal(result.logs.dsh.flushed, true);
  } finally {
    await fixture.cleanupAll();
  }
});

test('§22: the shutdown is recorded and reaches STOPPED', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    const stopped = await fixture.supervisor.stop();
    assert.equal(stopped.state, 'STOPPED');
    assert.equal(fixture.supervisor.status.state, 'STOPPED');

    const events = readLogRecords(fixture.config).map((record) => record.event);
    assert.equal(events.includes('shutdown_complete'), true);

    const record = JSON.parse(fs.readFileSync(fixture.config.paths.supervisorJson, 'utf8'));
    assert.equal(record.state, 'STOPPED');
  } finally {
    await fixture.cleanupAll();
  }
});

test('§22: the gateway is stopped before the child, so no request outlives its backend', async () => {
  const observed = [];
  const fixture = await makeSupervisor({
    createGateway: async () => ({
      stop: async () => { observed.push(`gateway:child-alive=${fixture.child.alive}`); return {}; },
    }),
  });
  try {
    await fixture.supervisor.start();
    await fixture.supervisor.stop();
    assert.deepEqual(observed, ['gateway:child-alive=true'], 'the child is still alive when the gateway stops');
    assert.equal(fixture.child.alive, false, 'and stopped afterwards');
  } finally {
    await fixture.cleanupAll();
  }
});

test('§22: stopping twice is idempotent', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    const first = await fixture.supervisor.stop();
    assert.equal(first.state, 'STOPPED');
    const second = await fixture.supervisor.stop();
    assert.equal(second.alreadyStopping, true, 'the second call is a no-op');
    assert.equal(fixture.child.stopCalls, 1, 'the child was signalled exactly once');
  } finally {
    await fixture.cleanupAll();
  }
});

test('§22: a gateway stop failure does not prevent the child from being stopped', async () => {
  const fixture = await makeSupervisor({
    createGateway: async () => ({
      stop: async () => { throw new Error('gateway stuck'); },
    }),
  });
  try {
    await fixture.supervisor.start();
    const result = await fixture.supervisor.stop();
    // The failure is reported, not swallowed — and the child is still cleaned up, so
    // a broken gateway cannot orphan a DSH process.
    assert.equal(typeof result.gateway.error, 'string');
    assert.equal(fixture.child.alive, false, 'the owned child was still stopped');
    assert.equal(result.state, 'STOPPED');
  } finally {
    await fixture.cleanupAll();
  }
});

test('§22: the auth cookie is dropped on shutdown', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    assert.equal(fixture.supervisor.authProvider.ready, true);
    await fixture.supervisor.stop();
    assert.equal(fixture.supervisor.authProvider.ready, false, 'a cookie does not outlive its child');
  } finally {
    await fixture.cleanupAll();
  }
});

test('§39: shutdown leaves no secret in the durable root', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    const token = fixture.supervisor.credential.requireToken();
    await fixture.supervisor.stop();

    const scan = scanTreeForSecrets(fixture.config.paths.root, [fixture.launchToken, fixture.cookieValue]);
    assert.deepEqual(scan.leaked, [], 'the ephemeral secrets are gone with the process');

    // The Phone token survives only in its own file, which is the point of it being
    // durable.
    const credentialFiles = scanTreeForSecrets(fixture.config.paths.root, [token]).leaked
      .filter((file) => !file.endsWith('phone-token.v1'));
    assert.deepEqual(credentialFiles, [], 'and the Phone token is only in the credential file');
  } finally {
    await fixture.cleanupAll();
  }
});

test('§22: log writes are flushed by the time stop returns', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    await fixture.supervisor.stop();
    // Every log is closed and its summary reports a real byte count.
    const records = readLogRecords(fixture.config);
    assert.ok(records.length > 0);
    for (const file of [fixture.config.paths.supervisorLog, fixture.config.paths.gatewayLog]) {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      assert.equal(text.length > 0, true, `${file} has content`);
      // And nothing is left half-written: every line parses.
      for (const line of text.split('\n').filter((entry) => entry.trim().length > 0)) {
        assert.doesNotThrow(() => JSON.parse(line), `${file} must contain complete lines`);
      }
    }
  } finally {
    await fixture.cleanupAll();
  }
});

test('§22: a stop closes the supervisor even when the child was never started', async () => {
  const { config, cleanup } = makeTempProduction();
  try {
    const { Supervisor } = await import('../../src/remote/production/supervisor.mjs');
    const supervisor = new Supervisor({ config, seams: {} });
    assert.equal(supervisor.status.state, 'STOPPED', 'it starts stopped');
    // Stopping something that never started must succeed rather than perform an
    // illegal STOPPED -> STOPPING transition.
    const result = await supervisor.stop();
    assert.equal(result.state, 'STOPPED');
    assert.equal(result.dsh, null);
    assert.equal(result.gateway, null);
    assert.equal(result.logs.supervisor.flushed, true);
    assert.equal(result.logs.degraded, false);
  } finally {
    cleanup();
  }
});

test('§22: the status file records STOPPED, not a stale READY', async () => {
  const fixture = await makeSupervisor();
  try {
    await fixture.supervisor.start();
    await fixture.supervisor.stop();
    const record = JSON.parse(fs.readFileSync(fixture.config.paths.supervisorJson, 'utf8'));
    assert.equal(record.state, 'STOPPED');
    assert.notEqual(record.state, 'READY');
  } finally {
    await fixture.cleanupAll();
  }
});
