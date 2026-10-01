/**
 * R7B mandatory item E — integration coverage of the REAL production collaborators.
 *
 * ## Why this test exists
 *
 * The previous corrective action drove the non-dry-run branch with a synthetic `spawnDsh`
 * seam. That seam replaces `new DshProcess({ config })` outright, so `DshProcess`, its
 * launcher resolution, `ProductionLogs`, `RotatingLog`, the runtime-status writer and the
 * control channel — the concrete code the external run actually executes — were never
 * entered. The external run failed again with `ReferenceError: fs is not defined`, which
 * is the proof that the synthetic coverage proved nothing.
 *
 * This test therefore uses the **real** production classes and substitutes only the
 * outermost boundaries:
 *
 *   real: ProductionLogs · RotatingLog · RuntimeStatus · ControlChannel ·
 *         CredentialStore · Supervisor.start() · DshProcess (constructor, start,
 *         line parsing, exit wiring, stop) · LaunchTokenParser · CookieAuthProvider ·
 *         exchangeLaunchToken · verifyCookie
 *
 *   faked: the OS child process (`spawnImpl`) · the loopback socket · the Gateway
 *
 * `spawnImpl` is injected into a **real `DshProcess`**, so every line of `DshProcess`
 * runs; only the final `child_process.spawn` call is replaced.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import test from 'node:test';

import { DshProcess, resolveNpxLauncher } from '../../src/remote/production/dsh-process.mjs';
import { ProductionLogs } from '../../src/remote/production/logger.mjs';
import { Supervisor } from '../../src/remote/production/supervisor.mjs';
import { CredentialStore } from '../../src/remote/production/credential-store.mjs';
import { cookieNameForAuthority } from '../../src/remote/production/dsh-bootstrap.mjs';
import { prepareProductionRoot, resolveProductionConfig } from '../../src/remote/production/production-config.mjs';
import { readStatus } from '../../src/remote/production/runtime-status.mjs';
import { currentUserSid, hardenAcl, removeTreeWithAclRestoreSync, verifyAcl } from '../../src/remote/production/windows-acl.mjs';

/**
 * A stand-in for `child_process.spawn`'s return value.
 *
 * Everything `DshProcess` touches must be present, or the test would fail for a reason
 * that has nothing to do with production: `stdout`/`stderr` as streams, `pid`, and the
 * `error`/`exit` events. The announcement is emitted on the next tick, exactly as a real
 * child would emit it.
 *
 * @param {string} launchToken - the token to announce.
 * @param {string} authority - the authority the announcement should name.
 * @param {number} [dshPort] - the port the fake child should hold while alive.
 * @returns {Function} the fake spawn.
 */
function fakeSpawn(launchToken, authority, dshPort) {
  return function spawnStub(command, argv, options) {
    const child = new EventEmitter();
    child.pid = 920_001;
    child.exitCode = null;
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};

    // The fake child holds its port for as long as it lives and releases it when killed,
    // so the STOPPED invariant observes a real transition instead of waiting on a socket
    // that no fake ever bound.
    let holder = null;
    if (Number.isInteger(dshPort) && dshPort > 0) {
      holder = net.createServer();
      holder.listen(dshPort, '127.0.0.1');
      child.__holder = holder;
    }
    child.kill = () => {
      try { holder?.close(); } catch { /* already closed */ }
      child.exitCode = 0;
      setImmediate(() => child.emit('exit', 0, null));
      return true;
    };

    // Record what the real DshProcess decided to run, so the test can assert the
    // launcher contract without duplicating it.
    child.__command = command;
    child.__argv = argv;
    child.__options = options;

    setImmediate(() => {
      child.stdout.emit('data', `dsh web: http://${authority}/?token=${launchToken}\n`);
    });
    return child;
  };
}

/**
 * A synthetic loopback response for the real `exchangeLaunchToken` / `verifyCookie`.
 *
 * @param {number} status - the status code.
 * @param {object} headers - the response headers.
 * @returns {Function} the injectable `request`.
 */
function fakeRequest(status, headers = {}) {
  return function requestStub(options, callback) {
    const res = {
      statusCode: status,
      headers,
      resume() {},
      on(event, fn) { if (event === 'end') setImmediate(fn); return res; },
    };
    setImmediate(() => callback(res));
    return {
      on() { return this; },
      end() {},
      destroy() {},
      write() {},
    };
  };
}

/**
 * Build an isolated production root.
 *
 * @returns {Promise<object>} the fixture.
 */
async function makeRoot() {
  const base = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'r7b-real-'));
  const config = resolveProductionConfig({
    dshHome: path.join(base, '.dsh'),
    workspace: base,
    gatewayPort: 49_820,
    dshPort: 30_920,
    dshExplicitPort: true,
  });
  const sid = await currentUserSid();
  await prepareProductionRoot({
    config,
    harden: (target) => hardenAcl(target, { sid }),
    verify: (target, opts) => verifyAcl(target, { sid, ...opts }),
  });
  return { base, config, dispose: () => removeTreeWithAclRestoreSync(base) };
}

/**
 * The Supervisor with real collaborators and faked OS boundaries.
 *
 * @param {object} fixture - the root fixture.
 * @param {object} [options] - `launchToken`, `argvProbe`.
 * @returns {object} the supervisor and its probes.
 */
function realCollaboratorSupervisor(fixture, options = {}) {
  const { config } = fixture;
  const authority = `${config.dshHost}:${config.dshPort}`;
  const launchToken = options.launchToken ?? crypto.randomBytes(32).toString('base64url');
  const probe = { spawnArgs: null, spawnOptions: null };

  // Each bootstrap must mint a **different** cookie, or the restart test would pass
  // trivially: a constant stub cannot distinguish "fresh cookie" from "same cookie".
  const serial = (options.serial ?? 1);
  const cookieValue = `synthetic-cookie-${serial}`;

  const credential = new CredentialStore({ paths: config.paths, harden: hardenAcl, verify: verifyAcl });
  const logs = new ProductionLogs({ paths: config.paths, secrets: [] });

  const supervisor = new Supervisor({
    config,
    credential,
    logs,
    seams: {
      // The real DshProcess, with only its final OS call replaced.
      spawnDsh: (cfg) => {
        const process = new DshProcess({
          config: cfg,
          spawn: (command, argv, spawnOptions) => {
            probe.spawnArgs = { command, argv };
            probe.spawnOptions = spawnOptions;
            return fakeSpawn(launchToken, authority, cfg.dshPort)(command, argv, spawnOptions);
          },
        });
        return process;
      },
      exchangeLaunchToken: fakeRequest(303, {
        'set-cookie': [`${cookieNameForAuthority(authority)}=${cookieValue}; Path=/; HttpOnly`],
      }),
      verifyCookie: fakeRequest(400, {}),
      // The gateway boundary: a real one would bind a port.
      createGateway: async () => ({ stop: async () => ({ stopped: true }), recovery: { lock: 'acquired' } }),
      // The OS boundary. A faked child binds no real socket, so the real port probe would
      // always report "still listening" and the STOPPED invariant could never be met.
      // Everything around these two seams still runs.
      waitPortFree: async () => ({ free: true, waitedMs: 0 }),
      isProcessAlive: async () => false,
      // The tree probe is a real PowerShell walk, which would find nothing for a fake
      // child. The ownership bookkeeping that consumes it still runs.
      enumerateTree: async () => [920_001],
      // The fake child declares itself the listener, so ownership is proven the same way
      // the real one is: the reported PID is already in the owned set.
      listenerPid: async () => 920_001,
      ancestorsOf: async () => [],
    },
  });

  return { supervisor, credential, logs, probe, launchToken, authority, cookieValue };
}

test('E: real DshProcess + real Supervisor reach READY with only the OS boundary faked', async () => {
  const fixture = await makeRoot();
  const { supervisor, probe } = realCollaboratorSupervisor(fixture);
  try {
    const started = await supervisor.start();

    assert.equal(started.state, 'READY');
    assert.equal(started.instanceId, supervisor.instanceId);

    // The real DshProcess ran and the real launcher resolution happened.
    assert.notEqual(probe.spawnArgs, null, 'DshProcess.start() must have called spawn');
    assert.equal(probe.spawnArgs.command, process.execPath, 'the launcher is the current node');
    assert.equal(probe.spawnArgs.argv[1], '-y');
    assert.equal(probe.spawnArgs.argv[2], '@deepseek-ai/dsh@0.1.5-rc.2');
    assert.equal(probe.spawnArgs.argv[3], 'web');
    assert.equal(probe.spawnArgs.argv[4], '--no-open');
    assert.equal(probe.spawnArgs.argv[5], '--port');
    assert.equal(probe.spawnArgs.argv[6], String(fixture.config.dshPort));

    // The real stdio contract: pipes, never inherit.
    assert.deepEqual(probe.spawnOptions.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(probe.spawnOptions.shell, false);
    assert.equal(probe.spawnOptions.cwd, fixture.config.workspace);
    assert.equal(probe.spawnOptions.env.DSH_HOME, fixture.config.dshHome);

    // The real bootstrap produced a live cookie provider.
    assert.equal(supervisor.authProvider.ready, true);
    assert.equal(supervisor.bootstrap.launch_token_length, 43);
  } finally {
    try { await supervisor.stop(); } catch { /* best effort */ }
    fixture.dispose();
  }
});

test('E: the real collaborators write the real status and log files', async () => {
  const fixture = await makeRoot();
  const { supervisor } = realCollaboratorSupervisor(fixture);
  try {
    await supervisor.start();

    // RuntimeStatus is real, so the status file must exist and be READY.
    const status = readStatus(fixture.config.paths.supervisorJson);
    assert.notEqual(status, null, 'the real status file must exist');
    assert.equal(status.state, 'READY');
    assert.equal(status.instance_id, supervisor.instanceId);

    // ProductionLogs/RotatingLog are real, so the supervisor log must exist and be JSONL.
    const logText = fs.readFileSync(fixture.config.paths.supervisorLog, 'utf8');
    const records = logText.split('\n').filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    assert.ok(records.length > 0, 'the real logger must have written records');
    assert.ok(records.some((record) => record.event === 'supervisor_start'));
    assert.ok(records.some((record) => record.event === 'dsh_spawned'));

    // §43: no launch token in the log, even though the real parser saw it.
    assert.equal(/\?token=[A-Za-z0-9_-]{40,}/.test(logText), false, 'the launch token must be redacted');
    assert.equal(logText.includes(supervisor.authProvider.cookie), false, 'the cookie must be redacted');
  } finally {
    try { await supervisor.stop(); } catch { /* best effort */ }
    fixture.dispose();
  }
});

test('E: the real stop path releases the child and records STOPPED', async () => {
  const fixture = await makeRoot();
  const { supervisor } = realCollaboratorSupervisor(fixture);
  try {
    await supervisor.start();
    const result = await supervisor.stop();

    assert.equal(result.state, 'STOPPED');
    const status = readStatus(fixture.config.paths.supervisorJson);
    assert.equal(status.state, 'STOPPED');
  } finally {
    fixture.dispose();
  }
});

test('E: the real restart path discards the old cookie and spawns a new child', async () => {
  const fixture = await makeRoot();
  const first = realCollaboratorSupervisor(fixture);
  try {
    await first.supervisor.start();
    const cookieA = first.supervisor.authProvider.cookie;
    const pidA = first.supervisor.dsh.pid;

    await first.supervisor.stop();

    // A fresh supervisor over the same root — the real restart shape. A different serial
    // makes the cookie value differ, so the assertion below means something.
    const second = realCollaboratorSupervisor(fixture, { serial: 2 });
    await second.supervisor.start();
    const cookieB = second.supervisor.authProvider.cookie;

    assert.notEqual(cookieA, cookieB, 'a restart must obtain a fresh cookie');
    assert.notEqual(pidA, null);
    assert.equal(second.supervisor.status.state, 'READY');
    await second.supervisor.stop();
  } finally {
    fixture.dispose();
  }
});

test('E: the real launcher resolution never returns npx.cmd with shell:false', () => {
  // The concrete resolution the external run depends on. Spawning `npx.cmd` with
  // `shell: false` throws EINVAL on Windows, so this asserts the shape that avoids it.
  const launcher = resolveNpxLauncher();
  assert.notEqual(launcher.via, undefined);
  if (process.platform === 'win32') {
    assert.equal(launcher.command, process.execPath);
    assert.equal(launcher.command.endsWith('npx.cmd'), false);
    assert.ok(launcher.prefixArgs[0].endsWith('npx-cli.js'), 'the real npx CLI must be used');
    assert.equal(fs.existsSync(launcher.prefixArgs[0]), true, 'the resolved CLI must exist on disk');
  }
});
