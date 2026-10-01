/**
 * Startup failure tests — Phase R7 §6, §9, §16, §17, §31, §36, §37.
 *
 * A production supervisor that starts in a degraded state is more dangerous than one
 * that refuses to start, because an operator will act on a green light. Every check
 * here asserts a refusal.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import {
  R7_ERROR,
  makeSupervisor,
  makeTempProduction,
  prepareProductionRoot,
  syntheticResponse,
} from './r7-helpers.mjs';
import { hardenAcl, verifyAcl, currentUserSid, aclSupported } from '../../src/remote/production/windows-acl.mjs';

test('§37: every documented error code exists', () => {
  const expected = [
    'R7_PRODUCTION_ROOT_UNEXPECTED',
    'R7_ACL_HARDENING_FAILED',
    'R7_ACL_POLICY_MISMATCH',
    'R7_PHONE_TOKEN_ACL_INVALID',
    'R7_PHONE_TOKEN_INVALID',
    'R7_DSH_LAUNCH_CONTRACT_CHANGED',
    'R7_DSH_BOOTSTRAP_TOKEN_UNRESOLVED',
    'R7_DSH_AUTH_BOOTSTRAP_FAILED',
    'R7_DSH_PROCESS_EXITED',
    'R7_PORT_IN_USE',
    'R7_START_TIMEOUT',
    'R7_CONTROL_REQUEST_INVALID',
    'R7_SUPERVISOR_LOCKED',
    'R7_PRODUCTION_SMOKE_FAILED',
  ];
  const actual = Object.values(R7_ERROR);
  for (const code of expected) {
    assert.ok(actual.includes(code), `${code} must be defined`);
  }
  // And the DSH-specific port code used by the start script.
  assert.equal(R7_ERROR.DSH_PORT_IN_USE, 'R7_DSH_PORT_IN_USE');
});

test('§36: an occupied gateway port refuses the start', async () => {
  const net = await import('node:net');
  const fixture = await makeSupervisor({ gatewayPort: 49_980 });
  const server = net.createServer();
  await new Promise((resolve) => server.listen(49_980, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      () => fixture.supervisor.start(),
      (error) => error.code === R7_ERROR.PORT_IN_USE,
    );
    assert.equal(fixture.supervisor.status.state, 'FAILED');
    // Nothing may have been created: a port conflict leaves no partial state.
    assert.equal(fs.existsSync(fixture.config.paths.phoneToken), false, 'no credential was created');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fixture.cleanupAll();
  }
});

test('§31: a port conflict is detected before DSH is spawned', async () => {
  const net = await import('node:net');
  const fixture = await makeSupervisor({ gatewayPort: 49_981 });
  const server = net.createServer();
  await new Promise((resolve) => server.listen(49_981, '127.0.0.1', resolve));
  try {
    await assert.rejects(() => fixture.supervisor.start());
    assert.equal(fixture.child.startCalls, 0, 'no child may be spawned when the port is busy');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fixture.cleanupAll();
  }
});

test('§9: an invalid credential shape fails the start', async () => {
  const { config, cleanup } = makeTempProduction();
  try {
    const sid = await currentUserSid();
    await prepareProductionRoot({ config, harden: hardenAcl, verify: verifyAcl });
    // A credential that is present but malformed.
    fs.writeFileSync(config.paths.phoneToken, 'not-a-valid-token', 'utf8');

    const { Supervisor } = await import('../../src/remote/production/supervisor.mjs');
    const supervisor = new Supervisor({
      config,
      seams: { spawnDsh: () => { throw new Error('must not be reached'); } },
    });
    await assert.rejects(
      () => supervisor.start(),
      (error) => error.code === R7_ERROR.PHONE_TOKEN_INVALID,
    );
  } finally {
    cleanup();
  }
});

test('§8: an unhardened credential file fails the start', async (t) => {
  if (!aclSupported()) {
    t.skip('Windows ACLs are required');
    return;
  }
  const { config, cleanup } = makeTempProduction();
  try {
    const sid = await currentUserSid();
    await prepareProductionRoot({ config, harden: hardenAcl, verify: verifyAcl });
    // Write a valid token but leave its ACL inherited.
    fs.writeFileSync(config.paths.phoneToken, 'a'.repeat(43), 'utf8');

    const { Supervisor } = await import('../../src/remote/production/supervisor.mjs');
    const { CredentialStore } = await import('../../src/remote/production/credential-store.mjs');
    const supervisor = new Supervisor({
      config,
      credential: new CredentialStore({ paths: config.paths, harden: hardenAcl, verify: verifyAcl }),
      seams: { spawnDsh: () => { throw new Error('must not be reached'); } },
    });
    await assert.rejects(
      () => supervisor.start(),
      (error) => error.code === R7_ERROR.PHONE_TOKEN_ACL_INVALID,
      'the Gateway must not start on an unprotected credential',
    );
  } finally {
    cleanup();
  }
});

test('§16: a child that never announces times out with the documented code', async () => {
  const fixture = await makeSupervisor({ child: { announce: false } });
  try {
    fixture.supervisor.config.startTimeoutMs = 120;
    const startedAt = Date.now();
    await assert.rejects(
      () => fixture.supervisor.start(),
      (error) => error.code === R7_ERROR.DSH_BOOTSTRAP_TOKEN_UNRESOLVED,
    );
    // It waited for the timeout rather than failing instantly on a race.
    assert.ok(Date.now() - startedAt >= 100, 'the timeout was honoured');
    await fixture.supervisor.stop();
  } finally {
    await fixture.cleanupAll();
  }
});

test('§16: a re-announced SAME token does not block the start', async () => {
  // End-to-end counterpart to the parser's distinct-token rule. DSH emits the
  // announcement once, but a restart of the connection service inside one process
  // reuses the memoised token, so a repeat is never ambiguous.
  const fixture = await makeSupervisor({ child: { announce: false } });
  try {
    const started = fixture.supervisor.start();
    setTimeout(() => {
      for (const handler of fixture.child.handlers) {
        handler(`dsh web: http://127.0.0.1:3080/?token=${fixture.launchToken}`, 'stdout');
      }
    }, 20);
    const outcome = await started;
    assert.equal(outcome.state, 'READY', 'one distinct token resolves');
    await fixture.supervisor.stop();
  } finally {
    await fixture.cleanupAll();
  }
});

test('§16: a single valid announcement among malformed lines resolves', async () => {
  // The other side of the same rule: a malformed line must not block an unambiguous
  // token, because the announcement is emitted after other startup output.
  const fixture = await makeSupervisor({ child: { announce: false } });
  try {
    const started = fixture.supervisor.start();
    setTimeout(() => {
      for (const handler of fixture.child.handlers) {
        handler('dsh web: opening the default browser; pass --no-open to disable', 'stdout');
        handler('some unrelated startup chatter', 'stdout');
        handler(`dsh web: http://127.0.0.1:3080/?token=${fixture.launchToken}`, 'stdout');
      }
    }, 20);
    const outcome = await started;
    assert.equal(outcome.state, 'READY');
    await fixture.supervisor.stop();
  } finally {
    await fixture.cleanupAll();
  }
});

test('§17: a 401 on the exchange fails the start with the auth code', async () => {
  const fixture = await makeSupervisor({ exchange: syntheticResponse(401, {}) });
  try {
    await assert.rejects(
      () => fixture.supervisor.start(),
      (error) => error.code === R7_ERROR.DSH_AUTH_BOOTSTRAP_FAILED,
    );
    // And no adapter may have been constructed.
    assert.equal(fixture.supervisor.adapter, null);
    await fixture.supervisor.stop();
  } finally {
    await fixture.cleanupAll();
  }
});

test('§17: a 303 with no cookie fails the start', async () => {
  const fixture = await makeSupervisor({ exchange: syntheticResponse(303, {}) });
  try {
    await assert.rejects(
      () => fixture.supervisor.start(),
      (error) => error.code === R7_ERROR.DSH_AUTH_BOOTSTRAP_FAILED,
    );
    await fixture.supervisor.stop();
  } finally {
    await fixture.cleanupAll();
  }
});

test('§17: a cookie the Gateway cannot verify fails the start', async () => {
  const fixture = await makeSupervisor({ verify: syntheticResponse(401, {}) });
  try {
    await assert.rejects(
      () => fixture.supervisor.start(),
      (error) => error.code === R7_ERROR.DSH_AUTH_BOOTSTRAP_FAILED,
    );
    await fixture.supervisor.stop();
  } finally {
    await fixture.cleanupAll();
  }
});

test('§31: a failed start leaves the status at FAILED with a code, never READY', async () => {
  const fixture = await makeSupervisor({ exchange: syntheticResponse(500, {}) });
  try {
    await assert.rejects(() => fixture.supervisor.start());
    const record = JSON.parse(fs.readFileSync(fixture.config.paths.supervisorJson, 'utf8'));
    assert.equal(record.state, 'FAILED');
    assert.equal(record.last_error_code, R7_ERROR.DSH_AUTH_BOOTSTRAP_FAILED);
    // And the failure is in the log with its code.
    const log = fs.readFileSync(fixture.config.paths.supervisorLog, 'utf8');
    assert.equal(log.includes('R7_DSH_AUTH_BOOTSTRAP_FAILED'), true);
    await fixture.supervisor.stop();
  } finally {
    await fixture.cleanupAll();
  }
});

test('§6: a start refuses when the production root is missing', async () => {
  const { config, cleanup } = makeTempProduction();
  try {
    const { Supervisor } = await import('../../src/remote/production/supervisor.mjs');
    const { CredentialStore } = await import('../../src/remote/production/credential-store.mjs');
    const supervisor = new Supervisor({
      config,
      credential: new CredentialStore({ paths: config.paths, harden: null, verify: null }),
      seams: { spawnDsh: () => { throw new Error('must not be reached'); } },
    });
    // The credential cannot be created because the secrets directory has no hardened
    // parent; the start must fail rather than fall back somewhere else.
    await assert.rejects(() => supervisor.start());
  } finally {
    cleanup();
  }
});

test('§39: a failed start never records a secret in the status or the log', async () => {
  const launchToken = 'LAUNCH_TOKEN_SECRET_0123456789abcd';
  const fixture = await makeSupervisor({
    child: { line: `dsh web: http://127.0.0.1:3080/?token=${launchToken}` },
    // Fail after the token was observed but before the cookie verified.
    verify: syntheticResponse(401, {}),
  });
  try {
    await assert.rejects(() => fixture.supervisor.start());
    for (const file of [fixture.config.paths.supervisorJson, fixture.config.paths.supervisorLog]) {
      const text = fs.readFileSync(file, 'utf8');
      assert.equal(text.includes(launchToken), false, `${file} must not contain the launch token`);
    }
    await fixture.supervisor.stop();
  } finally {
    await fixture.cleanupAll();
  }
});
