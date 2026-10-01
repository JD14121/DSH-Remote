/**
 * Process ownership tests — Phase R7 §14, §22, §36.
 *
 * The failure this suite exists to prevent is catastrophic and easy: stopping the
 * operator's unrelated Node processes because they happen to be called `node`. Every
 * assertion here is about the boundary between "a child we spawned" and "a process
 * that merely exists".
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';

import {
  DshProcess,
  FORCE_KILL,
  R7_ERROR,
  assertPortFree,
  dshLaunchArgv,
  dshLaunchArgvWithPort,
  isPortListening,
  makeTempProduction,
} from './r7-helpers.mjs';

/** A stub spawn that records its arguments and returns a controllable child. */
function stubSpawn(behaviour = {}) {
  const calls = [];
  const child = {
    pid: behaviour.pid ?? 555001,
    stdout: { setEncoding() {}, on() {} },
    stderr: { setEncoding() {}, on() {} },
    exitCode: null,
    handlers: {},
    on(event, fn) { this.handlers[event] = fn; return this; },
    once(event, fn) { this.handlers[`once:${event}`] = fn; return this; },
    kill(signal) {
      this.killed = signal;
      // The exit notification is scheduled, not synchronous, so a caller that
      // attaches its listener *before* calling `stop` observes it. Emitting
      // synchronously would race with the listener registration.
      if (behaviour.exitOnKill !== false) {
        this.exitCode = 0;
        setImmediate(() => { this.handlers['once:exit']?.(0, signal); });
      }
      return true;
    },
  };
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
  return { spawnImpl, calls, child };
}

test('§14: the child is spawned with pipes, never an inherited console', () => {
  const { config, cleanup } = makeTempProduction();
  const { spawnImpl, calls } = stubSpawn();
  try {
    const dsh = new DshProcess({ config, spawn: spawnImpl, execPath: 'npx.cmd' });
    dsh.start();

    assert.equal(calls.length, 1);
    const [call] = calls;
    // §15: `inherit` would send the launch token straight to a console and escape
    // every redaction control.
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(call.options.shell, false, 'no shell may reinterpret the argv');
    assert.equal(call.options.windowsHide, true);
  } finally {
    cleanup();
  }
});

test('§13: the spawn sets cwd and DSH_HOME explicitly', () => {
  const { config, cleanup } = makeTempProduction({ workspace: 'D:\\DSH-testing' });
  const { spawnImpl, calls } = stubSpawn();
  try {
    const dsh = new DshProcess({ config, spawn: spawnImpl, execPath: 'npx.cmd' });
    dsh.start();
    const [call] = calls;

    // §13: "do not depend on the shell CWD" — the workspace is passed, not inherited.
    assert.equal(call.options.cwd, 'D:\\DSH-testing');
    assert.equal(call.options.env.DSH_HOME, config.dshHome);
    assert.equal(call.options.env.DSH_REMOTE_PRODUCTION, '1');
    // R7D: the composed production port (3081) differs from DSH's own built-in default (3080), so
    // the child is always told its port explicitly. Asserting against the non-port form would pin
    // argv that would make the child bind 3080 — the operator's port.
    assert.deepEqual(call.args, dshLaunchArgvWithPort(config));
    assert.ok(call.args.includes('--port'), 'the port must be explicit');
    assert.equal(call.args.at(-1), String(config.dshPort));
  } finally {
    cleanup();
  }
});

test('§14: an owned child is tracked by handle, PID and instance id', () => {
  const { config, cleanup } = makeTempProduction();
  const { spawnImpl } = stubSpawn({ pid: 777123 });
  try {
    const dsh = new DshProcess({ config, spawn: spawnImpl, execPath: 'npx.cmd' });
    const spawned = dsh.start();
    assert.equal(spawned.pid, 777123);
    assert.equal(dsh.pid, 777123);
    assert.equal(typeof spawned.instanceId, 'string');
    assert.ok(spawned.instanceId.length > 0);
    assert.notEqual(dsh.child, null);
  } finally {
    cleanup();
  }
});

test('§22: a graceful stop signals only the owned PID', async () => {
  const { config, cleanup } = makeTempProduction();
  const { spawnImpl, child } = stubSpawn({ pid: 123456 });
  try {
    const dsh = new DshProcess({ config, spawn: spawnImpl, execPath: 'npx.cmd' });
    dsh.start();

    let forceArgv = null;
    const result = await dsh.stop({ timeoutMs: 2000, forceKill: async (argv) => { forceArgv = argv; } });

    assert.equal(child.killed, 'SIGTERM');
    assert.equal(forceArgv, null, 'a graceful exit needs no force path');
    assert.equal(result.graceful, true);
    assert.equal(result.forced, false);
  } finally {
    cleanup();
  }
});

test('§22: the force path names a PID and never a process name', async () => {
  const { config, cleanup } = makeTempProduction();
  // The escalated PID must be a process that is genuinely alive, or the stop path cannot tell
  // "the force kill worked" from "there was never anything to kill". The previous fixture used a
  // synthetic PID, which means the liveness probe correctly reported no survivor and no
  // escalation was needed — the test was asserting a sequence rather than an outcome. This
  // process's own PID gives the probe a real answer.
  const livePid = process.pid;
  const { spawnImpl } = stubSpawn({ pid: livePid, exitOnKill: false });
  try {
    const dsh = new DshProcess({ config, spawn: spawnImpl, execPath: 'npx.cmd' });
    dsh.start();

    let forceArgv = null;
    const result = await dsh.stop({
      timeoutMs: 50,
      forceTimeoutMs: 100,
      forceKill: async (argv) => { forceArgv = argv; },
    });

    assert.equal(result.forced, true, 'a surviving owned process must trigger escalation');
    assert.deepEqual(forceArgv, ['taskkill', '/PID', String(livePid), '/T', '/F']);
    // The prohibition that matters: `/IM node.exe` would kill unrelated work.
    assert.equal(forceArgv.includes('/IM'), false);
    assert.equal(forceArgv.join(' ').includes('node.exe'), false);
    // The probe cannot kill this process, so STOPPED must NOT be claimed.
    assert.equal(result.stopped, false, 'a survivor means stopped must be false');
    assert.deepEqual(result.survivors, [livePid], 'the survivor is reported, not hidden');
  } finally {
    cleanup();
  }
});

test('§14/§22: the force-kill argv never contains a process-name kill', () => {
  const argv = DshProcess.forceKillArgv(4242);
  assert.deepEqual(argv, ['taskkill', '/PID', '4242', '/T', '/F']);
  // The PID must sit immediately after /PID: `taskkill` rejects `/PID /T /F <pid>` with exit 1,
  // and that malformed order is what let the listener survive two phases of "successful" kills.
  assert.equal(argv.indexOf('/PID') + 1, argv.indexOf('4242'), 'the PID follows /PID immediately');
  assert.equal(argv.includes('/IM'), false);
  assert.equal(FORCE_KILL.TOOL, 'taskkill');
  assert.deepEqual([...FORCE_KILL.ARGS], ['/PID', '<pid>', '/T', '/F']);
});

test('§14: the production source contains no name-based kill', async () => {
  const fs = await import('node:fs');
  const raw = await fs.promises.readFile(
    new URL('../../src/remote/production/dsh-process.mjs', import.meta.url), 'utf8',
  );
  // Strip comments before scanning. The file *documents* the prohibition by naming
  // `/IM node.exe`, and a naive scan would flag its own documentation — the same
  // false positive R5A had to solve for PowerShell cmdlets.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['/IM', 'Stop-Process', 'killall', 'pkill']) {
    assert.equal(code.includes(banned), false, `the process wrapper must not contain ${banned}`);
  }
  // The comment really does explain it, so the prohibition is discoverable.
  assert.equal(raw.includes('/IM'), true, 'the file documents what it must not do');
});

test('§22: stopping an already-stopped child is a no-op', async () => {
  const { config, cleanup } = makeTempProduction();
  const { spawnImpl } = stubSpawn();
  try {
    const dsh = new DshProcess({ config, spawn: spawnImpl, execPath: 'npx.cmd' });
    const first = await dsh.stop();
    assert.equal(first.graceful, true, 'never spawned counts as already stopped');
    const second = await dsh.stop();
    assert.equal(second.graceful, true);
  } finally {
    cleanup();
  }
});

test('§14: spawning twice is refused rather than orphaning the first', () => {
  const { config, cleanup } = makeTempProduction();
  const { spawnImpl } = stubSpawn();
  try {
    const dsh = new DshProcess({ config, spawn: spawnImpl, execPath: 'npx.cmd' });
    dsh.start();
    assert.throws(
      () => dsh.start(),
      (error) => error.code === R7_ERROR.DSH_PROCESS_EXITED,
    );
  } finally {
    cleanup();
  }
});

test('§14: a spawn error surfaces as a child exit, not an uncaught throw', () => {
  const { config, cleanup } = makeTempProduction();
  const { spawnImpl, child } = stubSpawn();
  try {
    const dsh = new DshProcess({ config, spawn: spawnImpl, execPath: 'npx.cmd' });
    const exits = [];
    dsh.onExit((info) => exits.push(info));
    dsh.start();
    child.handlers.error?.(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    assert.equal(exits.length, 1);
    assert.equal(exits[0].error.code, 'ENOENT');
  } finally {
    cleanup();
  }
});

test('§36: port availability is detected honestly', async () => {
  // An unbound high port is free.
  assert.equal(await isPortListening(49_991), false);

  // And a bound one is detected. This listener is our own, closed in `finally`, so
  // the check cannot be satisfied by accident.
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(49_992, '127.0.0.1', resolve));
  try {
    assert.equal(await isPortListening(49_992), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await isPortListening(49_992), false, 'and free again once closed');
});

test('§36: an occupied port is a refusal, never an attach', async () => {
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(49_993, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      () => assertPortFree(49_993, R7_ERROR.PORT_IN_USE, 'Gateway'),
      (error) => {
        assert.equal(error.code, R7_ERROR.PORT_IN_USE);
        assert.match(error.message, /will not attach to or stop an unknown owner/);
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('§36: a free port passes the check', async () => {
  await assert.doesNotReject(() => assertPortFree(49_994, R7_ERROR.PORT_IN_USE, 'Gateway'));
});

test('§14: an unrelated Node process is never signalled', async () => {
  // Launch a child that is deliberately long-lived and unrelated to the supervisor,
  // then prove the supervisor's own machinery does not touch it.
  const unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    const { config, cleanup } = makeTempProduction();
    const { spawnImpl } = stubSpawn({ pid: 111222, exitOnKill: false });
    const dsh = new DshProcess({ config, spawn: spawnImpl, execPath: 'npx.cmd' });
    dsh.start();
    await dsh.stop({ timeoutMs: 30, forceKill: async () => {} });
    cleanup();

    // The unrelated process must still be alive: nothing signalled it.
    assert.equal(unrelated.exitCode, null);
    assert.equal(unrelated.killed, false);
  } finally {
    unrelated.kill();
  }
});
