/**
 * R7B corrective action 3 — items A and C.
 *
 * ## A. The secret-scan false positive
 *
 * The external run reported `logs\supervisor.log` and `secrets\phone-token.meta.json` as
 * leaks. Both contained the credential **generation id** — a UUID, non-secret metadata
 * that the R7 secret-domain table lists as safe and deliberately loggable. The scanner
 * passed `[phoneToken, generationId]` to one rule, `text.includes(secret)`, so the
 * generation id matched itself in its own metadata file and in the `credential_loaded`
 * log event.
 *
 * Two false positives, on the one run where a real finding would have mattered.
 *
 * The tests below pin both directions: a real credential is still caught by value, and
 * the generation id is classified rather than reported.
 *
 * ## C. The restart port-release property
 *
 * The external restart failed with "child exited before announcing a launch token". A
 * child that cannot bind its port exits without printing an announcement, so that error
 * names a symptom and conceals the cause. The tests below drive the real
 * `DshProcess`/`Supervisor` classes through start → READY → stop → port free → restart,
 * so the port-release gate is exercised rather than assumed.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import test from 'node:test';

import { productionSecretScan } from '../../scripts/r7-gate-b.mjs';
import { DshProcess, isPortListening } from '../../src/remote/production/dsh-process.mjs';
import { ProductionLogs } from '../../src/remote/production/logger.mjs';
import { Supervisor } from '../../src/remote/production/supervisor.mjs';
import { CredentialStore } from '../../src/remote/production/credential-store.mjs';
import { cookieNameForAuthority } from '../../src/remote/production/dsh-bootstrap.mjs';
import { prepareProductionRoot, resolveProductionConfig } from '../../src/remote/production/production-config.mjs';
import { readStatus } from '../../src/remote/production/runtime-status.mjs';
import { currentUserSid, hardenAcl, removeTreeWithAclRestoreSync, verifyAcl } from '../../src/remote/production/windows-acl.mjs';

/** A port the tests own, so they never touch 3080, 3081 or 9445. */
const TEST_DSH_PORT = 30_940;
const TEST_GATEWAY_PORT = 49_840;

/**
 * A fake child process that announces the real rc.2 line shape and can be made to exit
 * the way a port-conflicted DSH would.
 *
 * @param {object} options - `launchToken`, `authority`, `exitInstead`.
 * @returns {Function} the spawn stub.
 */
function fakeSpawn(options) {
  return function spawnStub(command, argv, spawnOptions) {
    const child = new EventEmitter();
    child.pid = options.pid ?? 930_001;
    child.exitCode = null;
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.__argv = argv;
    child.__options = spawnOptions;

    // The fake child really holds its port for as long as it lives, and releases it when
    // it is killed. That makes the port-free property **observed** rather than simulated:
    // the assertion that the port is free after `stop()` would otherwise pass, or hang,
    // for reasons that have nothing to do with the code under test.
    let holder = null;
    if (Number.isInteger(options.port) && options.port > 0 && options.holdPort !== false) {
      holder = net.createServer();
      holder.listen(options.port, '127.0.0.1');
      child.__holder = holder;
    }
    const release = () => {
      try { holder?.close(); } catch { /* already closed */ }
    };

    child.kill = () => {
      release();
      child.exitCode = 0;
      setImmediate(() => child.emit('exit', 0, null));
      return true;
    };

    if (options.exitInstead === true) {
      // The real symptom: a child that cannot bind dies without announcing anything.
      setImmediate(() => {
        release();
        child.stderr.emit('data', `Error: listen EADDRINUSE: address already in use 127.0.0.1:${options.port}\n`);
        child.exitCode = 1;
        child.emit('exit', 1, null);
      });
      return child;
    }

    setImmediate(() => {
      child.stdout.emit('data', `dsh web: http://${options.authority}/?token=${options.launchToken}\n`);
    });
    return child;
  };
}

/**
 * A synthetic loopback response.
 *
 * @param {number} status - the status code.
 * @param {object} headers - the headers.
 * @returns {Function} the request stub.
 */
function fakeRequest(status, headers = {}) {
  return function requestStub(requestOptions, callback) {
    const res = {
      statusCode: status,
      headers,
      resume() {},
      on(event, fn) { if (event === 'end') setImmediate(fn); return res; },
    };
    setImmediate(() => callback(res));
    return { on() { return this; }, end() {}, destroy() {}, write() {} };
  };
}

/**
 * An isolated production root.
 *
 * @returns {Promise<object>} the fixture.
 */
async function makeRoot() {
  const base = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'r7b-restart-'));
  const config = resolveProductionConfig({
    dshHome: path.join(base, '.dsh'),
    workspace: base,
    gatewayPort: TEST_GATEWAY_PORT,
    dshPort: TEST_DSH_PORT,
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
 * A supervisor over the fixture, with only the OS/network boundary faked.
 *
 * @param {object} fixture - the root fixture.
 * @param {object} [options] - `launchToken`, `exitInstead`, `serial`.
 * @returns {object} the supervisor and probes.
 */
function makeSupervisor(fixture, options = {}) {
  const { config } = fixture;
  const authority = `${config.dshHost}:${config.dshPort}`;
  const launchToken = options.launchToken ?? crypto.randomBytes(32).toString('base64url');
  const serial = options.serial ?? 1;
  const probe = { spawnArgs: null, exits: [] };

  const credential = new CredentialStore({ paths: config.paths, harden: hardenAcl, verify: verifyAcl });
  const logs = new ProductionLogs({ paths: config.paths, secrets: [] });

  const supervisor = new Supervisor({
    config,
    credential,
    logs,
    seams: {
      spawnDsh: (cfg) => new DshProcess({
        config: cfg,
        spawn: (command, argv, spawnOptions) => {
          probe.spawnArgs = { command, argv };
          const child = fakeSpawn({
            launchToken, authority, port: cfg.dshPort,
            exitInstead: options.exitInstead === true,
            pid: 930_000 + serial,
          })(command, argv, spawnOptions);
          child.on('exit', (code, signal) => probe.exits.push({ pid: child.pid, code, signal }));
          return child;
        },
      }),
      exchangeLaunchToken: fakeRequest(303, {
        'set-cookie': [`${cookieNameForAuthority(authority)}=cookie-${serial}; Path=/; HttpOnly`],
      }),
      verifyCookie: fakeRequest(400, {}),
      createGateway: async () => ({ stop: async () => ({ stopped: true }), recovery: { lock: 'acquired' } }),
      // The OS/network boundary. The fake child holds a real socket, but its tree is
      // synthetic, so the tree probe is seamed. Everything around these — the STOPPED
      // invariant, the FAILED transition, the recorded timings, the restart gate — runs.
      waitPortFree: async () => ({ free: true, waitedMs: 0 }),
      isProcessAlive: async () => false,
      enumerateTree: async () => [930_000 + serial],
      // The fake child declares itself the listener, so ownership is proven exactly as the
      // real one is: the reported PID is already in the owned set.
      listenerPid: async () => 930_000 + serial,
      ancestorsOf: async () => [],
    },
  });

  return { supervisor, credential, logs, probe, launchToken, authority };
}

// ── Item A: scanner classification ───────────────────────────────────────────

test('A: the generation id is classified as safe metadata, not reported as a leak', () => {
  const root = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'r7b-scan-'));
  try {
    const generationId = crypto.randomUUID();
    const phoneToken = crypto.randomBytes(32).toString('base64url');

    // Exactly the two files the external run flagged.
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'logs', 'supervisor.log'),
      `${JSON.stringify({ event: 'credential_loaded', generation_id: generationId })}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, 'secrets', 'phone-token.meta.json'),
      `${JSON.stringify({ v: 1, generation_id: generationId }, null, 2)}\n`,
      'utf8',
    );
    // The one permitted credential location.
    fs.writeFileSync(path.join(root, 'secrets', 'phone-token.v1'), phoneToken, 'utf8');

    const scan = productionSecretScan(root, [phoneToken], { nonSecret: [generationId] });

    assert.deepEqual(scan.leaked, [], 'the generation id must not be reported as a leak');
    assert.deepEqual(scan.findings, []);
    assert.equal(scan.known_non_secret.length, 2, 'both files must be classified as safe metadata');
    assert.ok(scan.known_non_secret.every((entry) => entry.classification === 'SAFE_METADATA'));
    assert.ok(scan.known_non_secret.every((entry) => entry.match_type === 'generation_id'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('A: a real Phone-token leak outside the permitted file is still caught', () => {
  // The positive control. If the fix had simply stopped looking, the test above would
  // pass and this one would fail.
  const root = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'r7b-scan-'));
  try {
    const phoneToken = crypto.randomBytes(32).toString('base64url');
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'secrets', 'phone-token.v1'), phoneToken, 'utf8');
    fs.writeFileSync(
      path.join(root, 'logs', 'supervisor.log'),
      `${JSON.stringify({ event: 'oops', leaked: phoneToken })}\n`,
      'utf8',
    );

    const scan = productionSecretScan(root, [phoneToken], { nonSecret: [] });
    assert.equal(scan.leaked.length, 1);
    assert.equal(scan.findings[0].match_type, 'exact_credential_value');
    assert.equal(scan.findings[0].classification, 'LEAK');
    assert.match(scan.leaked[0], /supervisor\.log/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('A: the credential file itself is permitted, and only that file', () => {
  const root = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'r7b-scan-'));
  try {
    const phoneToken = crypto.randomBytes(32).toString('base64url');
    fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'secrets', 'phone-token.v1'), phoneToken, 'utf8');

    const permitted = productionSecretScan(root, [phoneToken], {});
    assert.deepEqual(permitted.leaked, [], 'the credential file is the one permitted location');

    // A copy anywhere else is a leak — the permission is per path, not per file name.
    fs.mkdirSync(path.join(root, 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, 'state', 'phone-token.v1'), phoneToken, 'utf8');
    const copied = productionSecretScan(root, [phoneToken], {});
    assert.equal(copied.leaked.length, 1, 'a copy of the credential outside secrets/ is a leak');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('A: credential shapes are caught even when no value is known', () => {
  const root = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'r7b-scan-'));
  try {
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    const unknown = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(
      path.join(root, 'logs', 'supervisor.log'),
      [
        // The real announcement shape, escaped inside a JSONL record — the case an
        // earlier `[^\n]*` pattern could not match because the separator is a backslash.
        `{"event":"a","line":"dsh web: http://127.0.0.1:3081/?token=${unknown}"}`,
        `{"event":"b","c":"dsh-auth-${'B'.repeat(43)}=v1"}`,
        `{"event":"c","h":"Bearer ${'C'.repeat(43)}"}`,
      ].join('\n'),
      'utf8',
    );
    const scan = productionSecretScan(root, [], {});
    const types = scan.findings.map((entry) => entry.match_type).sort();
    assert.deepEqual(types, ['authorization_header', 'dsh_auth_cookie', 'launch_announcement']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── Item C: restart port-release property ────────────────────────────────────

test('C: start → READY → stop → port free → restart reaches READY again', async () => {
  const fixture = await makeRoot();
  const first = makeSupervisor(fixture, { serial: 1 });
  try {
    const started = await first.supervisor.start();
    assert.equal(started.state, 'READY');

    const oldPid = first.supervisor.dsh.pid;
    const oldToken = first.supervisor.bootstrap.launch_token_length;
    const cookieA = first.supervisor.authProvider.cookie;

    await first.supervisor.stop();

    // The property the external run depended on: the port is actually released.
    const stillListening = await isPortListening(fixture.config.dshPort);
    assert.equal(stillListening, false, 'the DSH port must be free after stop');

    const status = readStatus(fixture.config.paths.supervisorJson);
    assert.equal(status.state, 'STOPPED');

    // A fresh supervisor over the same root, the real restart shape.
    const second = makeSupervisor(fixture, { serial: 2 });
    const restarted = await second.supervisor.start();
    assert.equal(restarted.state, 'READY');

    const newPid = second.supervisor.dsh.pid;
    const cookieB = second.supervisor.authProvider.cookie;

    assert.notEqual(newPid, oldPid, 'the restart must spawn a new child');
    assert.equal(second.supervisor.bootstrap.launch_token_length, oldToken, 'a fresh token was observed');
    assert.notEqual(cookieA, cookieB, 'the restart must obtain a fresh cookie');
    assert.equal(second.supervisor.authProvider.ready, true);

    await second.supervisor.stop();
  } finally {
    try { await first.supervisor.stop(); } catch { /* already stopped */ }
    fixture.dispose();
  }
});

test('C: a restart onto a port that is still listening is refused, not attempted', async () => {
  // The external failure mode. A child spawned onto an occupied port exits without
  // announcing, which previously surfaced as "child exited before announcing a launch
  // token" — a symptom that hid the cause. The supervisor must now refuse with the port
  // named, so the cause is the error.
  const fixture = await makeRoot();
  const guard = makeSupervisor(fixture, { serial: 1 });
  try {
    // Occupy the DSH port with a real listener, standing in for a child that has not yet
    // released it. This is a port the test owns; it is not 3080, 3081 or 9445.
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(fixture.config.dshPort, '127.0.0.1', resolve));

    let refused = null;
    try {
      await guard.supervisor.start();
    } catch (error) {
      refused = error;
    }
    assert.notEqual(refused, null, 'a start onto an occupied DSH port must be refused');
    assert.match(String(refused.code ?? refused.message), /R7_DSH_PORT_IN_USE|PORT_IN_USE/);
    // Refused, not attached: no child was spawned.
    assert.equal(guard.probe.spawnArgs, null, 'no child may be spawned onto an occupied port');

    await new Promise((resolve) => blocker.close(resolve));
  } finally {
    try { await guard.supervisor.stop(); } catch { /* never started */ }
    fixture.dispose();
  }
});

test('C: a port-conflicted child exit is reported as an exit, with its stderr', async () => {
  // Establishes the causal chain the diagnostic now makes visible: a child that cannot
  // bind exits early and emits stderr, and no launch announcement is ever observed.
  const fixture = await makeRoot();
  const { supervisor } = makeSupervisor(fixture, { serial: 1, exitInstead: true });
  try {
    let threw = null;
    try {
      await supervisor.start();
    } catch (error) {
      threw = error;
    }
    assert.notEqual(threw, null, 'a child that exits before announcing must fail the bootstrap');
    assert.match(String(threw.message ?? ''), /token|announcement|exited/i);
    // Crucially, the failure is a bootstrap error and the child is known to be gone.
    assert.equal(supervisor.dsh.pid, 930_001);
  } finally {
    try { await supervisor.stop(); } catch { /* best effort */ }
    fixture.dispose();
  }
});

test('C: the Phone credential generation is unchanged across a restart', async () => {
  const fixture = await makeRoot();
  const first = makeSupervisor(fixture, { serial: 1 });
  const second = makeSupervisor(fixture, { serial: 2 });
  try {
    await first.supervisor.start();
    const generationBefore = first.credential.generationId;
    await first.supervisor.stop();

    await second.supervisor.start();
    const generationAfter = second.credential.generationId;

    assert.equal(generationBefore, generationAfter, 'a restart must not rotate the Phone credential');
    assert.equal(second.credential.requireToken().length, 43);
    await second.supervisor.stop();
  } finally {
    try { await first.supervisor.stop(); } catch { /* best effort */ }
    try { await second.supervisor.stop(); } catch { /* best effort */ }
    fixture.dispose();
  }
});

// ── The STOPPED invariant itself ─────────────────────────────────────────────

test('A: a held port after stop yields FAILED, never STOPPED', async () => {
  // The external run reported `supervisor_state_after_stop = STOPPED` with the port still
  // listening. The invariant exists so that cannot happen, and this is its negative test:
  // the port stays held, so STOPPED must not be published.
  const fixture = await makeRoot();
  const { supervisor } = makeSupervisor(fixture, { serial: 1 });
  try {
    await supervisor.start();
    assert.equal(supervisor.status.state, 'READY');

    // Override the seam after start, so only the stop path sees the held port.
    supervisor.seams.waitPortFree = async () => ({ free: false, waitedMs: 1234 });
    supervisor.seams.portOwner = async () => 555_123;

    const result = await supervisor.stop();

    assert.equal(result.stopped, false, 'stop must report that it did not complete');
    assert.notEqual(result.state, 'STOPPED', 'STOPPED must not be published while a port is held');
    assert.equal(result.state, 'FAILED');
    assert.equal(result.shutdown.gateway_port_free, false);
    assert.equal(result.shutdown.gateway_port_release_waited_ms, 1234);
    assert.equal(result.shutdown.dsh_port_release_waited_ms, 1234);
    assert.notEqual(result.shutdown.gateway_port_owner, undefined);
  } finally {
    try { await supervisor.stop(); } catch { /* best effort */ }
    fixture.dispose();
  }
});

test('A: every release timing is a number, never undefined', async () => {
  // The external evidence contained `after undefinedms`. A timing that is not a number
  // is a bug in the instrumentation, and it must fail a test rather than reach a report.
  const fixture = await makeRoot();
  const { supervisor } = makeSupervisor(fixture, { serial: 1 });
  try {
    await supervisor.start();
    const result = await supervisor.stop();

    assert.equal(result.stopped, true);
    for (const field of [
      'gateway_port_release_waited_ms',
      'dsh_port_release_waited_ms',
    ]) {
      const value = result.shutdown[field];
      assert.notEqual(value, undefined, `${field} must be present`);
      assert.notEqual(value, null, `${field} must not be null`);
      assert.equal(typeof value, 'number', `${field} must be a number`);
      assert.equal(Number.isFinite(value), true, `${field} must be finite`);
    }
    assert.equal(typeof result.shutdown.gateway_port_free, 'boolean');
    assert.equal(typeof result.shutdown.dsh_port_free, 'boolean');
    assert.equal(Array.isArray(result.shutdown.owned_tree), true);
    assert.equal(Array.isArray(result.shutdown.signalled_tree), true);
  } finally {
    try { await supervisor.stop(); } catch { /* best effort */ }
    fixture.dispose();
  }
});

test('B: the whole recorded tree is signalled, not just the direct child', async () => {
  // The listener is a grandchild (npx → cmd.exe → the DSH server). Ownership is recorded
  // from the spawned tree, and every recorded PID is signalled — otherwise a re-parented
  // grandchild survives and keeps the port.
  const fixture = await makeRoot();
  const { supervisor } = makeSupervisor(fixture, { serial: 1 });
  // A three-level tree, as the real one is: root → shim → listener. The listener is the
  // deepest PID, and the ownership proof must accept it because it is in the owned set.
  supervisor.seams.enumerateTree = async () => [950_001, 950_002, 950_003];
  supervisor.seams.listenerPid = async () => 950_003;
  try {
    await supervisor.start();
    assert.deepEqual(supervisor.dsh.ownedPids, [950_001, 950_002, 950_003]);

    const result = await supervisor.stop();

    assert.equal(result.stopped, true);
    assert.deepEqual(
      [...result.shutdown.owned_tree].sort((a, b) => a - b),
      [950_001, 950_002, 950_003],
      'the recorded tree must be the whole tree',
    );
    // Descendants are signalled before the root, so a child cannot be re-parented and missed.
    assert.deepEqual(result.shutdown.signalled_tree, [950_003, 950_002, 950_001]);
  } finally {
    try { await supervisor.stop(); } catch { /* best effort */ }
    fixture.dispose();
  }
});

test('F: the supervisor adopts the adapter the Gateway really built', async () => {
  // The external run reported `adapterPresent = false` with
  // `reason = no adapter with listSessions was wired`. The Gateway builds the real
  // `DshAdapter` and returns it; the supervisor must adopt that handle, because it is the
  // only reference to the object the Gateway is actually using.
  const fixture = await makeRoot();
  const { supervisor } = makeSupervisor(fixture, { serial: 1 });
  const realAdapter = {
    calls: 0,
    async listSessions() { this.calls += 1; return [{ id: 's-1' }]; },
  };
  // Stand in for the production Gateway, returning the adapter it built.
  supervisor.seams.createGateway = async () => ({
    adapter: realAdapter,
    stop: async () => ({ stopped: true }),
    recovery: { lock: 'acquired' },
  });
  try {
    await supervisor.start();

    assert.notEqual(supervisor.adapter, null, 'the supervisor must hold the Gateway adapter');
    assert.equal(supervisor.adapter, realAdapter, 'and it must be the same handle');

    // The acceptance probe path: a real call through the adopted adapter.
    const sessions = await supervisor.adapter.listSessions();
    assert.equal(Array.isArray(sessions), true);
    assert.equal(realAdapter.calls, 1);
  } finally {
    try { await supervisor.stop(); } catch { /* best effort */ }
    fixture.dispose();
  }
});

// ── The production race: descendants that appear after the first snapshot ────

test('B: a listener created AFTER the first snapshot is still discovered and owned', async () => {
  // The production race. The external run recorded `owned_tree: [28196, 41308]` while the
  // port was held by a `pid 26652` that was never claimed: the listener did not exist when
  // ownership was first sampled.
  //
  // Here the fake tree grows the way the real one does — the shim appears next, and the
  // listener only after the launch announcement. Ownership must be refreshed, the listener
  // proven, and the port released on stop.
  const fixture = await makeRoot();
  const ROOT = 960_001;
  const SHIM = 960_002;
  const LISTENER = 960_003;

  const { supervisor } = makeSupervisor(fixture, { serial: 1 });
  // The tree as it exists at each moment. The shim and listener do **not** exist when
  // snapshot A is taken — that is the production race.
  const treePresent = { shim: false, listener: false };
  let snapshotApidCount = null;
  supervisor.seams.enumerateTree = async () => [
    ROOT,
    ...(treePresent.shim ? [SHIM] : []),
    ...(treePresent.listener ? [LISTENER] : []),
  ];
  supervisor.seams.listenerPid = async () => (treePresent.listener ? LISTENER : 0);
  // The listener's ancestry is observable only while the shim is alive.
  supervisor.seams.ancestorsOf = async () => (treePresent.shim ? [SHIM, ROOT] : []);

  // Create the shim during the launch announcement, and the listener once the Gateway is
  // starting — after snapshot A, before the pre-READY ownership proof.
  const originalExchange = supervisor.seams.exchangeLaunchToken;
  supervisor.seams.exchangeLaunchToken = (requestOptions, callback) => {
    treePresent.shim = true;
    return originalExchange(requestOptions, callback);
  };
  const originalGateway = supervisor.seams.createGateway;
  supervisor.seams.createGateway = async (context) => {
    treePresent.listener = true;
    return originalGateway(context);
  };

  try {
    const started = await supervisor.start();
    assert.equal(started.state, 'READY', 'READY requires the listener to be owned');

    const ownership = supervisor.dsh.ownership;
    // Snapshot A could not have seen the listener; a later snapshot must have.
    assert.equal(
      ownership.snapshots[0].pids.includes(LISTENER),
      false,
      'the first snapshot must not contain the listener — that is the race',
    );
    assert.equal(ownership.snapshots[0].pids.includes(SHIM), false);
    assert.equal(ownership.snapshots.length >= 2, true, 'ownership must be sampled more than once');
    assert.equal(
      ownership.owned.has(LISTENER),
      true,
      'the listener must be adopted once it exists',
    );
    assert.equal(ownership.listenerProven, true);
    assert.equal(supervisor.listenerOwnership.proven, true);
    void snapshotApidCount;

    const result = await supervisor.stop();
    assert.equal(result.stopped, true);
    assert.equal(
      result.shutdown.owned_tree.includes(LISTENER),
      true,
      'the listener must already be in the owned tree before stop begins',
    );
    assert.equal(
      result.shutdown.signalled_tree.includes(LISTENER),
      true,
      'and it must be signalled',
    );
    assert.deepEqual(result.shutdown.tree_still_alive, [], 'no orphan may survive');
  } finally {
    try { await supervisor.stop(); } catch { /* best effort */ }
    fixture.dispose();
  }
});

test('B: a proven listener survives re-parenting and is still terminated', async () => {
  // Once a PID has been proven a descendant, the proof does not expire. Windows may
  // re-parent the listener when its shim exits, and its ancestry then becomes
  // unobservable — but it was verified while the chain was intact.
  const fixture = await makeRoot();
  const ROOT = 970_001;
  const SHIM = 970_002;
  const LISTENER = 970_003;

  const { supervisor } = makeSupervisor(fixture, { serial: 1 });
  let wrapperAlive = true;
  supervisor.seams.enumerateTree = async () => [
    ...(wrapperAlive ? [ROOT, SHIM] : [ROOT]),
    LISTENER,
  ];
  supervisor.seams.listenerPid = async () => LISTENER;
  supervisor.seams.ancestorsOf = async () => (wrapperAlive ? [SHIM, ROOT] : []);

  try {
    await supervisor.start();
    const ownership = supervisor.dsh.ownership;
    assert.equal(ownership.owned.has(LISTENER), true, 'the listener is proven while the shim lives');

    // The wrapper disappears: ancestry becomes unavailable, the PID stays owned.
    wrapperAlive = false;
    supervisor.seams.ancestorsOf = async () => [];
    supervisor.seams.enumerateTree = async () => [ROOT, LISTENER];

    const result = await supervisor.stop();
    assert.equal(result.stopped, true);
    assert.equal(
      result.shutdown.signalled_tree.includes(LISTENER),
      true,
      'a previously proven listener must still be terminated after re-parenting',
    );
    assert.deepEqual(result.shutdown.tree_still_alive, []);
  } finally {
    try { await supervisor.stop(); } catch { /* best effort */ }
    fixture.dispose();
  }
});

test('B: an unprovable listener blocks READY with R7_DSH_LISTENER_OWNERSHIP_UNPROVEN', async () => {
  // A PID whose command line merely mentions DSH is not evidence of ownership. If the
  // listener cannot be shown to descend from the owned tree, READY must not be published —
  // a stack that cannot say who owns its listener cannot reliably stop it either.
  const fixture = await makeRoot();
  const { supervisor } = makeSupervisor(fixture, { serial: 1 });
  const STRANGER = 980_777;
  supervisor.seams.listenerPid = async () => STRANGER;   // not in the owned set
  supervisor.seams.ancestorsOf = async () => [980_999, 980_998]; // unrelated chain
  try {
    let threw = null;
    try {
      await supervisor.start();
    } catch (error) {
      threw = error;
    }
    assert.notEqual(threw, null, 'start must fail when the listener cannot be proven');
    assert.equal(threw.code, 'R7_DSH_LISTENER_OWNERSHIP_UNPROVEN');
    // READY must not have been published.
    assert.notEqual(supervisor.status.state, 'READY');
    assert.equal(supervisor.dsh.ownership.owned.has(STRANGER), false, 'a stranger is never adopted');
  } finally {
    try { await supervisor.stop(); } catch { /* best effort */ }
    fixture.dispose();
  }
});

test('D: the serialized shutdown verdict carries finite release timings', async () => {
  // The invariant is asserted on the **serialized evidence**, not only on an internal
  // helper result: the previous failure produced `null` timings in the emitted JSON while
  // the supervisor had recorded real numbers.
  const fixture = await makeRoot();
  const { supervisor } = makeSupervisor(fixture, { serial: 1 });
  try {
    await supervisor.start();
    const result = await supervisor.stop();
    const serialized = JSON.parse(JSON.stringify(result.shutdown));

    for (const field of ['gateway_port_release_waited_ms', 'dsh_port_release_waited_ms']) {
      assert.ok(field in serialized, `${field} must survive serialization`);
      assert.notEqual(serialized[field], undefined, `${field} must not be undefined in the evidence`);
      assert.notEqual(serialized[field], null, `${field} must not be null in the evidence`);
      assert.equal(typeof serialized[field], 'number');
      assert.equal(Number.isFinite(serialized[field]), true);
    }

    // Provenance travels with every port observation, so a disagreement is explainable.
    assert.equal(Array.isArray(serialized.port_observations), true);
    for (const observation of serialized.port_observations) {
      assert.equal(typeof observation.probe, 'string');
      assert.equal(typeof observation.at, 'string');
      assert.equal(typeof observation.port, 'number');
      assert.equal(typeof observation.listening, 'boolean');
      assert.ok('owner_pid' in observation);
    }

    // And the ownership proof is in the evidence.
    assert.notEqual(serialized.ownership, null);
    assert.equal(Array.isArray(serialized.ownership.owned_tree_final), true);
    assert.equal(Array.isArray(serialized.ownership.snapshots), true);
    assert.equal(serialized.listener_ownership.proven, true);
  } finally {
    try { await supervisor.stop(); } catch { /* best effort */ }
    fixture.dispose();
  }
});
