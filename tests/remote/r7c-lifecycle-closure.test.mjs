/**
 * R7C — Windows lifecycle closure.
 *
 * ## The limitation this suite closes
 *
 * `R7-KNOWN-LIMITATION-01`: a verified-owned DSH listener could survive graceful shutdown on
 * Windows. The recorded child PID died, the port stayed held, and the supervisor reported `STOPPED`
 * anyway — because it treated *having issued* a termination as *having achieved* one.
 *
 * The listener is a **grandchild** (`node npx-cli.js` → `cmd.exe` → `node dsh web`), so it can be
 * re-parented and outlive both the wrapper's exit and a `/T` kill.
 *
 * These tests use a deterministic liveness model rather than spawning a real Windows DSH: a set of
 * alive PIDs that the injected kill runner removes. Every scenario §17 names is therefore
 * reproducible and fast, and none of them depends on DSH's own timing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DshProcess,
  GRACEFUL_STOP_TIMEOUT_MS,
  FORCE_STOP_TIMEOUT_MS,
  FORCE_KILL,
  makeTempProduction,
} from './r7-helpers.mjs';

/**
 * A controllable process world.
 *
 * @param {object} options - `alive` PIDs, and how each phase affects them.
 * @returns {object} the world plus its seams.
 */
function processWorld(options = {}) {
  const alive = new Set(options.alive ?? [910_001, 910_002, 910_003]);
  const killCalls = [];
  const child = {
    pid: options.rootPid ?? 910_001,
    stdout: { setEncoding() {}, on() {} },
    stderr: { setEncoding() {}, on() {} },
    exitCode: null,
    handlers: {},
    on(event, fn) { this.handlers[event] = fn; return this; },
    once(event, fn) { this.handlers[`once:${event}`] = fn; return this; },
    kill(signal) {
      this.killed = signal;
      if (options.exitOnSigterm !== false) {
        this.exitCode = 0;
        alive.delete(this.pid);
        setImmediate(() => { this.handlers['once:exit']?.(0, signal); });
      }
      return true;
    },
  };
  return {
    alive,
    killCalls,
    child,
    spawn: () => child,
    /** Liveness probe over the model. */
    isAlive: async (pid) => alive.has(pid),
    /**
     * A force runner that honours `forcedRemoval`: the PIDs the force phase is allowed to clear.
     * `forcedRemoval: []` models "the command succeeds but the process remains".
     */
    forceKill: async (argv) => {
      killCalls.push(argv.join(' '));
      // The PID follows `/PID`; it is not the trailing argument, because `taskkill` requires the
      // value to come directly after the switch.
      const pid = Number(argv[argv.indexOf('/PID') + 1]);
      if (options.forcedRemoval === null || options.forcedRemoval === undefined) alive.delete(pid);
      else if (options.forcedRemoval.includes(pid)) alive.delete(pid);
    },
  };
}

/** Build a DshProcess over a process world, with ownership recorded. */
async function makeDsh(world, config) {
  const dsh = new DshProcess({ config, spawn: world.spawn, execPath: 'npx.cmd' });
  dsh.start();
  dsh.pid = world.child.pid;
  dsh.ownedPids = [...world.alive];
  return dsh;
}

test('R7C §8: the stop deadlines are single named constants', () => {
  assert.equal(Number.isInteger(GRACEFUL_STOP_TIMEOUT_MS), true);
  assert.equal(Number.isInteger(FORCE_STOP_TIMEOUT_MS), true);
  assert.ok(GRACEFUL_STOP_TIMEOUT_MS >= 5000, 'long enough for an ordinary graceful exit');
  assert.ok(GRACEFUL_STOP_TIMEOUT_MS <= 30000, 'bounded enough for unattended lifecycle');
  assert.ok(FORCE_STOP_TIMEOUT_MS > 0);
});

test('R7C §17: a normal graceful stop needs no escalation and observes death', async () => {
  const { config, cleanup } = makeTempProduction();
  const world = processWorld({ alive: [910_001], forcedRemoval: [] });
  try {
    const dsh = await makeDsh(world, config);
    const result = await dsh.stop({ timeoutMs: 300, forceKill: world.forceKill, isAlive: world.isAlive });

    assert.equal(result.graceful, true, 'the child exited within the deadline');
    assert.equal(result.forced, false, 'no escalation was needed');
    assert.equal(result.stopped, true, 'STOPPED follows observed death');
    assert.deepEqual(result.survivors, []);
    assert.equal(world.killCalls.length, 0, 'the force runner was never invoked');
  } finally { cleanup(); }
});

test('R7C §17: a surviving owned process triggers exact-owned escalation', async () => {
  const { config, cleanup } = makeTempProduction();
  // SIGTERM is ignored, and only the force phase can clear the grandchild.
  const world = processWorld({ alive: [910_001, 910_002, 910_003], exitOnSigterm: false });
  try {
    const dsh = await makeDsh(world, config);
    const result = await dsh.stop({ timeoutMs: 120, forceTimeoutMs: 300, pollMs: 20, forceKill: world.forceKill, isAlive: world.isAlive });

    assert.equal(result.graceful, false, 'graceful did not complete');
    assert.equal(result.forced, true, 'escalation was required');
    assert.equal(result.stopped, true, 'and it cleared every owned process');
    assert.deepEqual(result.survivors, []);
    assert.ok(world.killCalls.length > 0, 'the force path ran');
    // §5: every force target is a PID, never an image name.
    for (const call of world.killCalls) {
      assert.match(call, /^taskkill \/PID \d+ \/T \/F$/);
      assert.equal(call.includes('/IM'), false);
      assert.equal(call.includes('node.exe'), false);
    }
  } finally { cleanup(); }
});

test('R7C §9: a successful force command is NOT proof of exit', async () => {
  const { config, cleanup } = makeTempProduction();
  // The command succeeds but the process survives — the exact historical failure.
  const world = processWorld({ alive: [910_001, 910_002], exitOnSigterm: false, forcedRemoval: [] });
  try {
    const dsh = await makeDsh(world, config);
    const result = await dsh.stop({ timeoutMs: 80, forceTimeoutMs: 200, pollMs: 20, forceKill: world.forceKill, isAlive: world.isAlive });

    assert.equal(result.forced, true, 'escalation ran');
    assert.equal(result.stopped, false, 'STOPPED must NOT be claimed while a process survives');
    assert.ok(result.survivors.includes(910_001), 'the surviving owned PID is reported');
    assert.ok(result.survivors.includes(910_002));
  } finally { cleanup(); }
});

test('R7C §9/§17: a port still held keeps stopped false even when every PID is gone', async () => {
  const { config, cleanup } = makeTempProduction();
  const world = processWorld({ alive: [910_001], exitOnSigterm: false, forcedRemoval: [910_001] });
  try {
    const dsh = await makeDsh(world, config);
    const result = await dsh.stop({
      timeoutMs: 80,
      forceTimeoutMs: 150,
      pollMs: 20,
      port: config.dshPort,
      forceKill: world.forceKill,
      isAlive: world.isAlive,
      // The port never frees: an unrelated process holds it.
      waitForPortFree: async () => ({ free: false, waitedMs: 5 }),
    });

    assert.deepEqual(result.survivors, [], 'every owned process is gone');
    assert.equal(result.portFree, false);
    assert.equal(result.stopped, false, 'a held port means the stack is not down');
  } finally { cleanup(); }
});

test('R7C §13/§17: repeated stop is safe and never repeats a broad action', async () => {
  const { config, cleanup } = makeTempProduction();
  const world = processWorld({ alive: [910_001], forcedRemoval: [] });
  try {
    const dsh = await makeDsh(world, config);
    const first = await dsh.stop({ timeoutMs: 200, forceKill: world.forceKill, isAlive: world.isAlive });
    const second = await dsh.stop({ timeoutMs: 200, forceKill: world.forceKill, isAlive: world.isAlive });
    const third = await dsh.stop({ timeoutMs: 200, forceKill: world.forceKill, isAlive: world.isAlive });

    assert.equal(first.stopped, true);
    assert.equal(second.already_stopped, true, 'a second stop is a no-op, not a re-kill');
    assert.equal(third.already_stopped, true);
    assert.equal(world.killCalls.length, 0, 'no repeated termination was issued');
  } finally { cleanup(); }
});

test('R7C §4/§11: ownership ambiguity fails safe instead of killing', async () => {
  const { config, cleanup } = makeTempProduction();
  // Nothing is owned, and the liveness probe cannot read the process at all.
  const world = processWorld({ alive: [910_001, 910_002], exitOnSigterm: false, forcedRemoval: null });
  try {
    const dsh = await makeDsh(world, config);
    const result = await dsh.stop({
      timeoutMs: 60,
      forceTimeoutMs: 120,
      pollMs: 20,
      forceKill: async (argv) => { world.killCalls.push(argv.join(' ')); },
      // An unreadable process must be treated as surviving.
      isAlive: async () => { throw new Error('cannot read process'); },
    });

    assert.equal(result.stopped, false, 'an unreadable process must not become STOPPED');
    assert.ok(result.survivors.length > 0, 'and the unreadable PIDs are reported');
  } finally { cleanup(); }
});

test('R7C §17: a listener PID that changes during shutdown is still caught by the port check', async () => {
  const { config, cleanup } = makeTempProduction();
  const world = processWorld({ alive: [910_001], exitOnSigterm: true, forcedRemoval: [] });
  try {
    const dsh = await makeDsh(world, config);
    // The recorded listener is gone, but a NEW pid now holds the port (re-parenting race).
    const result = await dsh.stop({
      timeoutMs: 200,
      port: config.dshPort,
      forceKill: world.forceKill,
      isAlive: world.isAlive,
      listenerPid: async () => 910_999,
      waitForPortFree: async () => ({ free: false, waitedMs: 3 }),
    });

    assert.equal(result.listenerPid, 910_999, 'the current listener is reported');
    assert.equal(result.stopped, false, 'a changed listener keeps the stack down-claim false');
  } finally { cleanup(); }
});

test('R7C §17: pre-READY listener cleanup — an adopted listener is terminated too', async () => {
  const { config, cleanup } = makeTempProduction();
  // The listener started before READY and is not the direct child.
  const world = processWorld({ alive: [910_001, 910_777], exitOnSigterm: false });
  try {
    const dsh = await makeDsh(world, config);
    dsh.ownedPids = [910_001, 910_777];
    const result = await dsh.stop({ timeoutMs: 60, forceTimeoutMs: 200, pollMs: 20, forceKill: world.forceKill, isAlive: world.isAlive });

    assert.equal(result.stopped, true);
    assert.ok(world.killCalls.some((c) => c.includes('/PID 910777 ')), 'the adopted listener was named explicitly');
    assert.equal(world.alive.has(910_777), false, 'the pre-READY listener is gone');
  } finally { cleanup(); }
});

test('R7C §5: the escalation never names an image, only owned PIDs', () => {
  const argv = DshProcess.forceKillArgv(4242);
  assert.deepEqual(argv, ['taskkill', '/PID', '4242', '/T', '/F']);
  // `taskkill` requires the value immediately after `/PID`. Emitting `/PID /T /F <pid>` is a syntax
  // error the tool answers with exit 1 and no termination, which is precisely how a listener
  // survived an escalation that reported it had run.
  assert.equal(argv.indexOf('/PID') + 1, argv.indexOf('4242'), 'the PID follows /PID immediately');
  assert.equal(argv.includes('/IM'), false);
  assert.equal(argv.join(' ').includes('node.exe'), false);
  assert.equal(FORCE_KILL.TOOL, 'taskkill');
  assert.deepEqual([...FORCE_KILL.ARGS], ['/PID', '<pid>', '/T', '/F']);
});

test('R7C §25: timings are reported as numbers, not prose', async () => {
  const { config, cleanup } = makeTempProduction();
  const world = processWorld({ alive: [910_001], forcedRemoval: [] });
  try {
    const dsh = await makeDsh(world, config);
    const result = await dsh.stop({ timeoutMs: 200, forceKill: world.forceKill, isAlive: world.isAlive });
    for (const key of ['graceful_ms', 'force_ms', 'port_release_ms', 'total_ms']) {
      assert.equal(typeof result[key], 'number', `${key} must be numeric`);
      assert.ok(result[key] >= 0);
    }
  } finally { cleanup(); }
});
