/**
 * R7D — the production port contract.
 *
 * R7D freezes one deployment decision: the supervised production DSH port is **3081**, deliberately
 * distinct from the operator's interactive DSH on **3080**. The Supervisor spawns, adopts and
 * terminates the process on its port, so sharing the operator's port would mean the lifecycle
 * managing a process a human is using interactively.
 *
 * These tests pin the contract itself: the two roles never collide, stale runtime state cannot
 * redefine configuration, the child is always told its port, and an occupied port is a refusal
 * rather than a takeover.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DSH_DEFAULT_PORT,
  OPERATOR_DSH_PORT,
  makeTempProduction,
  resolveProductionConfig,
} from './r7-helpers.mjs';
import { DshProcess, R7_ERROR, dshLaunchArgvWithPort, makeTempProduction as makeRoot } from './r7-helpers.mjs';

/** Resolve a config with the port override cleared, so the composed default is tested. */
function withCleanEnv(fn) {
  const saved = process.env.DSH_REMOTE_DSH_PORT;
  delete process.env.DSH_REMOTE_DSH_PORT;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.DSH_REMOTE_DSH_PORT;
    else process.env.DSH_REMOTE_DSH_PORT = saved;
  }
}

test('R7D §1: the supervised production port is frozen at 3081', () => {
  withCleanEnv(() => {
    const config = resolveProductionConfig({ dshHome: 'C:\\temp\\r7d' });
    assert.equal(config.dshPort, 3081, 'the documented production supervised port');
    assert.equal(config.gatewayPort, 9445);
  });
});

test('R7D §1/§7: production never targets the operator port', () => {
  withCleanEnv(() => {
    const config = resolveProductionConfig({ dshHome: 'C:\\temp\\r7d' });
    assert.equal(OPERATOR_DSH_PORT, 3080);
    assert.notEqual(config.dshPort, OPERATOR_DSH_PORT,
      'the Supervisor must not manage the operator\'s interactive process');
    assert.notEqual(config.dshPort, config.gatewayPort, 'the DSH and Gateway ports must differ');
  });
});

test('R7D §1: DSH_REMOTE_DSH_PORT remains the authoritative override', () => {
  const saved = process.env.DSH_REMOTE_DSH_PORT;
  try {
    process.env.DSH_REMOTE_DSH_PORT = '3399';
    const config = resolveProductionConfig({ dshHome: 'C:\\temp\\r7d' });
    assert.equal(config.dshPort, 3399, 'the environment contract still wins');
    assert.equal(config.dshExplicitPort, true, 'and the child is told the port');
  } finally {
    if (saved === undefined) delete process.env.DSH_REMOTE_DSH_PORT;
    else process.env.DSH_REMOTE_DSH_PORT = saved;
  }
});

test('R7D §1: an explicit option still wins over the environment', () => {
  const saved = process.env.DSH_REMOTE_DSH_PORT;
  try {
    process.env.DSH_REMOTE_DSH_PORT = '3399';
    const config = resolveProductionConfig({ dshHome: 'C:\\temp\\r7d', dshPort: 3401 });
    assert.equal(config.dshPort, 3401, 'caller intent outranks the environment');
  } finally {
    if (saved === undefined) delete process.env.DSH_REMOTE_DSH_PORT;
    else process.env.DSH_REMOTE_DSH_PORT = saved;
  }
});

test('R7D §4/§5: configuration never reads runtime state', () => {
  // The resolved value must not depend on any file under the production root.
  const { config, cleanup } = makeTempProduction();
  try {
    // A stale supervisor.json naming historical ports must not influence the configuration.
    const stale = { v: 1, state: 'READY', dsh: { host: '127.0.0.1', port: 3181 }, gateway: { host: '127.0.0.1', port: 9445 } };
    fs.mkdirSync(path.dirname(config.paths.supervisorJson), { recursive: true });
    fs.writeFileSync(config.paths.supervisorJson, JSON.stringify(stale), 'utf8');

    const resolved = resolveProductionConfig({ dshHome: config.dshHome });
    assert.notEqual(resolved.dshPort, 3181, 'stale state must not become configuration');
    assert.equal(resolved.dshPort, 3081, 'the composed default is authoritative');

    // And the stale file is still there to be observed — it is state, not a setting.
    const reRead = JSON.parse(fs.readFileSync(config.paths.supervisorJson, 'utf8'));
    assert.equal(reRead.dsh.port, 3181, 'the stale file is unchanged; it is simply not consulted');
  } finally { cleanup(); }
});

test('R7D §5: a stale file naming 3081 or 3181 cannot override the environment', () => {
  const { config, cleanup } = makeTempProduction();
  const saved = process.env.DSH_REMOTE_DSH_PORT;
  try {
    fs.mkdirSync(path.dirname(config.paths.supervisorJson), { recursive: true });
    fs.writeFileSync(config.paths.supervisorJson,
      JSON.stringify({ dsh: { port: 3181 }, gateway: { port: 9445 } }), 'utf8');
    process.env.DSH_REMOTE_DSH_PORT = '3397';
    const resolved = resolveProductionConfig({ dshHome: config.dshHome });
    assert.equal(resolved.dshPort, 3397, 'the environment, not the file, defines the port');
  } finally {
    if (saved === undefined) delete process.env.DSH_REMOTE_DSH_PORT;
    else process.env.DSH_REMOTE_DSH_PORT = saved;
    cleanup();
  }
});

test('R7D §4: the child is always told its port when it differs from DSH\'s default', () => {
  withCleanEnv(() => {
    const config = resolveProductionConfig({ dshHome: 'C:\\temp\\r7d' });
    // The production port (3081) is not DSH's built-in default (3080). Without an explicit --port
    // the child would bind 3080 — the operator's port — so the flag is mandatory here.
    assert.equal(DSH_DEFAULT_PORT, 3080);
    assert.notEqual(config.dshPort, DSH_DEFAULT_PORT);
    assert.equal(config.dshExplicitPort, true, 'the explicit-port flag must be on');
    const argv = dshLaunchArgvWithPort(config);
    assert.equal(argv.at(-2), '--port');
    assert.equal(argv.at(-1), '3081');
  });
});

test('R7D §4: an audited argv passes --port rather than relying on the child default', () => {
  const config = resolveProductionConfig({ dshHome: 'C:\\temp\\r7d', dshPort: 3081, dshExplicitPort: true });
  const argv = dshLaunchArgvWithPort(config);
  assert.ok(argv.includes('--port'), 'the port is explicit');
  // No shell metacharacters and no LAN exposure.
  assert.equal(argv.join(' ').includes('--host'), false, 'DSH stays on loopback');
  assert.equal(argv.includes('--no-open'), true, 'no browser may open');
});

test('R7D §6: an occupied production port is a refusal, not a takeover', async () => {
  const { config, cleanup } = makeTempProduction();
  try {
    // Model an unrelated listener by pointing assertPortFree at one that is genuinely held.
    const net = await import('node:net');
    const held = net.createServer();
    await new Promise((resolve) => { held.listen(config.dshPort, '127.0.0.1', resolve); });
    try {
      const { assertPortFree } = await import('./r7-helpers.mjs');
      await assert.rejects(
        () => assertPortFree(config.dshPort, R7_ERROR.DSH_PORT_IN_USE, 'DSH'),
        (error) => {
          assert.equal(error.code, R7_ERROR.DSH_PORT_IN_USE);
          // The refusal must name the port and decline to attach or stop the owner.
          assert.match(error.message, new RegExp(String(config.dshPort)));
          assert.match(error.message, /will not attach to or stop an unknown owner/);
          return true;
        },
        'an occupied DSH port must refuse the start',
      );
    } finally {
      await new Promise((resolve) => { held.close(resolve); });
    }
  } finally { cleanup(); }
});

test('R7D §6: the DSH process is spawned with the configured port, never a fallback', () => {
  const { config, cleanup } = makeRoot({ dshPort: 3081, dshExplicitPort: true });
  const calls = [];
  try {
    const dsh = new DshProcess({
      config,
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return {
          pid: 770_001,
          stdout: { setEncoding() {}, on() {} },
          stderr: { setEncoding() {}, on() {} },
          on() { return this; },
          once() { return this; },
          kill() { return true; },
        };
      },
      execPath: 'npx.cmd',
    });
    dsh.start();
    assert.equal(calls.length, 1);
    const argv = calls[0].args;
    assert.equal(argv[argv.indexOf('--port') + 1], '3081');
    // The operator port must not appear anywhere in the audited argv.
    assert.equal(argv.includes(String(OPERATOR_DSH_PORT)), false, '3080 must not appear in argv');
  } finally { cleanup(); }
});
