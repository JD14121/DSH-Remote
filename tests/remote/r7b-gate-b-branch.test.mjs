/**
 * R7B Gate B branch coverage — Phase R7B, corrective action item 4.
 *
 * ## Why this suite exists
 *
 * A real external Gate B run failed with `ReferenceError: fs is not defined` immediately
 * after `credential_ready` and before `dsh_spawn_owned`. The `--dry-run` path returns
 * *before* that point, so every test written against the driver exercised only the
 * preflight branch — and the whole live branch, including whatever symbol was missing,
 * carried **zero coverage**.
 *
 * A green suite therefore proved nothing about the branch that actually runs in
 * production, and the failure only appeared on an operator's console.
 *
 * This suite closes that gap: it drives `runGateB` through the **non-dry-run** path with
 * synthetic collaborators, so any undefined identifier there fails here instead.
 *
 * ## Isolation
 *
 * Every test points the driver at a temp root, a spare port and a temp evidence
 * directory. Nothing here touches the production root, spawns a DSH, or binds a port.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  EVALUATED_RESULT_SCHEMA,
  collectPortState,
  parseArgs,
  productionSecretScan,
  runGateB,
} from '../../scripts/r7-gate-b.mjs';
import { cookieNameForAuthority } from '../../src/remote/production/dsh-bootstrap.mjs';
import { prepareProductionRoot } from '../../src/remote/production/production-config.mjs';
import { currentUserSid, hardenAcl, removeTreeWithAclRestoreSync, verifyAcl } from '../../src/remote/production/windows-acl.mjs';
import { makeTempProduction } from './r7-helpers.mjs';

const GATE_B_EVIDENCE = 'D:\\DSH-testing\\docs\\remote-mobile\\_evidence';
const REAL_PHONE_TOKEN = 'D:\\DSH-work-test\\.dsh\\remote\\secrets\\phone-token.v1';

/**
 * A well-formed placeholder launch token.
 *
 * Exactly 43 base64url characters, because that is what DSH emits and what the parser
 * requires. An earlier version of this file used a 1-character placeholder, so two tests
 * failed inside the announcement parser, never reached the spawn, and therefore never
 * exercised the branch they existed to cover. A placeholder must satisfy the same
 * contract as the real value, or it silently weakens the test that uses it.
 */
const DUMMY_LAUNCH_TOKEN = 'A_VALID_43_CHAR_LAUNCH_TOKEN_PLACEHOLDER_ab';

/**
 * Report temp artefacts the suite failed to remove, without failing on a Windows handle race.
 *
 * `dispose()` is synchronous and runs in a `finally`, and it does remove the directory —
 * verified by tracing every `mkdtempSync`/`rmSync` pair. What remains is a Windows
 * timing effect: the ACL helper spawns `powershell.exe`, and for one directory per run
 * the handle outlives the test process by a few milliseconds, so the directory's deletion
 * is refused *during* the run and succeeds immediately afterwards.
 *
 * The suite therefore reports rather than asserts. The external check that the project
 * actually relies on is the leak counter run after `npm test`; this hook exists so the
 * residue is named in the test output instead of appearing silently.
 */
after(async () => {
  const temp = os.tmpdir();
  const debris = () => fs.readdirSync(temp)
    .filter((name) => name.startsWith('r7b-evidence-') || name.startsWith('r7-branch-'));

  let left = debris();
  for (let attempt = 0; attempt < 5 && left.length > 0; attempt += 1) {
    for (const name of left) {
      try {
        fs.rmSync(path.join(temp, name), { recursive: true, force: true, maxRetries: 3 });
      } catch { /* the holder may not have released yet */ }
    }
    if (left.length > 0) await new Promise((resolve) => { setTimeout(resolve, 150); });
    left = debris();
  }

  if (left.length > 0) {
    process.stderr.write(
      `[r7b-branch] ${left.length} temp director(ies) still held at teardown: ${left.join(', ')}\n`
      + '[r7b-branch] this is the known Windows handle race; verify with the post-suite leak count\n',
    );
  }
});

/**
 * A synthetic DSH child that announces the real rc.2 line shape.
 *
 * @param {string} launchToken - the token to announce.
 * @returns {object} the fake child.
 */
function fakeChild(launchToken) {
  return {
    pid: 910_001,
    instanceId: 'branch-test',
    alive: true,
    handlers: new Set(),
    exitHandlers: new Set(),
    start() {
      setTimeout(() => {
        for (const handler of this.handlers) {
          handler(`dsh web: http://127.0.0.1:30910/?token=${launchToken}`, 'stdout');
        }
      }, 5);
      return { pid: this.pid, instanceId: this.instanceId, argv: [] };
    },
    onLine(handler) { this.handlers.add(handler); return () => this.handlers.delete(handler); },
    onExit(handler) { this.exitHandlers.add(handler); return () => this.exitHandlers.delete(handler); },
    describe() { return { instance_id: this.instanceId, pid: this.pid, alive: this.alive }; },
    async stop() { this.alive = false; return { graceful: true, forced: false, pid: this.pid }; },
  };
}

/**
 * A synthetic loopback response.
 *
 * @param {number} status - the status code.
 * @param {object} headers - the headers.
 * @returns {Function} the request stub.
 */
function respond(status, headers = {}) {
  return (options, callback) => {
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
 * Every seam the non-dry-run branch needs, so it runs end to end without a real DSH, a
 * real port or a real gateway.
 *
 * @param {object} options - `dshPort` and `launchToken`.
 * @returns {object} the seams.
 */
function syntheticSeams(options) {
  const authority = `127.0.0.1:${options.dshPort}`;
  return {
    // Claim an external console, so the branch is not short-circuited by the §4 refusal.
    detectEnvironment: async () => ({ inside: false, ancestry: [], reason: 'synthetic external console' }),
    spawnDsh: () => fakeChild(options.launchToken),
    exchangeLaunchToken: respond(303, {
      'set-cookie': [`${cookieNameForAuthority(authority)}=synthetic-cookie-value; Path=/; HttpOnly`],
    }),
    verifyCookie: respond(400, {}),
    createGateway: async () => ({
      stop: async () => ({ stopped: true }),
      recovery: { lock: 'acquired', journals: { sessions: 0, records: 0 } },
    }),
  };
}

/**
 * A prepared temp root, and the options that keep the driver inside it.
 *
 * `dshHome`, `workspace` and `gatewayPort` are overridden deliberately. Without them the
 * driver resolves the **real** production root and the real 9445 — which an earlier
 * version of this suite did, and which wrote test supervisor logs into the production
 * root.
 *
 * `evidenceDir` is deliberately **not** overridden. The driver must write R7B §31
 * evidence only to the real evidence directory, because that is where the operator's
 * Gate B record lives. An earlier version injected a temp directory here, and a later
 * version wrote to the real one — clobbering the journal from the operator's actual
 * external run with synthetic data. Neither is acceptable, so the driver now refuses to
 * write evidence when it can tell it is running under a test (see `isTestContext`).
 */
class Fixture {
  /**
   * @param {object} parts - the resolved pieces.
   */
  constructor(parts) {
    Object.assign(this, parts);
  }

  /**
   * Build a fixture.
   *
   * @returns {Promise<Fixture>} the fixture.
   */
  static async create() {
    const temp = makeTempProduction({ gatewayPort: 49_810, dshPort: 30_910 });
    const sid = await currentUserSid();
    await prepareProductionRoot({
      config: temp.config,
      harden: (target) => hardenAcl(target, { sid }),
      verify: (target, opts) => verifyAcl(target, { sid, ...opts }),
    });
    // Assert the isolation rather than trusting it.
    assert.equal(temp.config.root.startsWith('D:\\DSH-work-test'), false, 'the fixture must not be the real root');
    return new Fixture({
      config: temp.config,
      root: temp.root,
      cleanupTemp: temp.cleanup,
    });
  }

  /**
   * The options to pass to `runGateB`.
   *
   * @param {object} [extra] - overrides.
   * @returns {object} the options.
   */
  options(extra = {}) {
    return {
      dshHome: this.config.dshHome,
      workspace: this.config.workspace,
      dshPort: this.config.dshPort,
      gatewayPort: this.config.gatewayPort,
      dshPid: 0,
      launcherPid: 0,
      restoreDsh: false,
      dryRun: false,
      force: false,
      ...extra,
    };
  }

  /**
   * Remove every temp artefact.
   *
   * Synchronous, and cannot throw: a teardown that fails or rejects leaks a temp root,
   * and Node's test runner may exit as soon as the last test resolves.
   *
   * @returns {void}
   */
  dispose() {
    try {
      removeTreeWithAclRestoreSync(this.root);
    } catch { /* nothing else to try */ }
    this.cleanupTemp();
  }
}

test('R7B: the driver parses its flags, and enables no dangerous default', () => {
  assert.equal(parseArgs(['--dsh-port', '3081']).dshPort, 3081);
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
  assert.equal(parseArgs(['--force']).force, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);

  const defaults = parseArgs([]);
  assert.equal(defaults.dryRun, false);
  assert.equal(defaults.force, false, 'the DSH-job override must never default on');
  assert.equal(defaults.restoreDsh, true);
});

test('R7B: the non-dry-run branch reaches the DSH spawn seam with no undefined symbol', async () => {
  // The regression guard. Before it this branch had no coverage at all, so a missing
  // import survived a fully green suite and surfaced only on a real operator run.
  const fixture = await Fixture.create();
  try {
    const result = await runGateB(fixture.options({
      seams: syntheticSeams({ dshPort: fixture.config.dshPort, launchToken: crypto.randomBytes(32).toString('base64url') }),
    }));

    // Reaching the spawn seam is the assertion: a ReferenceError anywhere between
    // `credential_ready` and the spawn would have thrown out of `runGateB`.
    assert.equal(result.dsh_spawn_owned, true, 'a child was spawned and owned');
    assert.equal(result.launch_token_observed, true, 'the announcement was parsed');
    assert.equal(result.cookie_exchange, true, 'the cookie was exchanged');
    assert.equal(result.cookie_verified, true, 'the cookie verified');
    assert.equal(result.persistence_ready, true, 'the recovery report was read');
    assert.equal(result.steps.preflight === undefined, true, 'this was not the dry-run path');

    // The seam reports a READY supervisor, so `gateway_ready` is true here. That is the
    // honest intermediate state; the authenticated probe is what proves a real listener
    // exists, and it does not, because the gateway is a stub on a spare port.
    assert.equal(result.gateway_ready, true, 'the supervisor reported READY');
    assert.equal(result.health_authenticated, false, 'but no real gateway answered');
  } finally {
    fixture.dispose();
  }
});

test('R7B: the branch emits every §32 field, with none left undefined', async () => {
  const fixture = await Fixture.create();
  try {
    const result = await runGateB(fixture.options({
      seams: syntheticSeams({ dshPort: fixture.config.dshPort, launchToken: crypto.randomBytes(32).toString('base64url') }),
    }));

    for (const field of EVALUATED_RESULT_SCHEMA) {
      // Present, and never `undefined`: an absent key is indistinguishable from a
      // forgotten assignment when a consumer reads the evidence.
      assert.ok(field in result, `the result must carry ${field}`);
      assert.notEqual(result[field], undefined, `${field} must be assigned, not undefined`);
    }
    assert.equal(result.phase, 'R7B');
    assert.equal(result.dsh_port, fixture.config.dshPort);
    assert.equal(result.gateway_port, fixture.config.gatewayPort);
  } finally {
    fixture.dispose();
  }
});

test('R7B: the branch never persists the launch token or the cookie', async () => {
  const fixture = await Fixture.create();
  const launchToken = crypto.randomBytes(32).toString('base64url');
  try {
    await runGateB(fixture.options({
      seams: syntheticSeams({ dshPort: fixture.config.dshPort, launchToken }),
    }));

    const token = fs.readFileSync(fixture.config.paths.phoneToken, 'utf8').trim();
    const leaked = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (full === fixture.config.paths.phoneToken) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (text.includes(launchToken)) leaked.push(`${path.relative(fixture.root, full)}: launch token`);
        if (text.includes('synthetic-cookie-value')) leaked.push(`${path.relative(fixture.root, full)}: cookie`);
        if (text.includes(token)) leaked.push(`${path.relative(fixture.root, full)}: phone token`);
      }
    };
    walk(fixture.config.paths.root);
    assert.deepEqual(leaked, [], 'no ephemeral credential may reach disk');
  } finally {
    fixture.dispose();
  }
});

test('R7B: the §4 refusal short-circuits before any child is spawned', async () => {
  const fixture = await Fixture.create();
  let spawned = 0;
  try {
    const result = await runGateB(fixture.options({
      seams: {
        ...syntheticSeams({ dshPort: fixture.config.dshPort, launchToken: DUMMY_LAUNCH_TOKEN }),
        // Claim to be inside the job object, which must stop the run.
        detectEnvironment: async () => ({ inside: true, ancestry: ['1|node.exe|dsh web'], reason: 'synthetic DSH ancestor' }),
        spawnDsh: () => { spawned += 1; return fakeChild(DUMMY_LAUNCH_TOKEN); },
      },
    }));

    assert.match(String(result.error), /R7B_INSIDE_DSH_JOB/);
    assert.equal(result.external_powershell, false);
    assert.equal(spawned, 0, 'no DSH child may be spawned from inside the job object');
    assert.equal(result.dsh_spawn_owned, false);
  } finally {
    fixture.dispose();
  }
});

test('R7B: --dry-run still spawns nothing and stops at the preflight', async () => {
  const fixture = await Fixture.create();
  let spawned = 0;
  try {
    const result = await runGateB(fixture.options({
      dryRun: true,
      seams: {
        ...syntheticSeams({ dshPort: fixture.config.dshPort, launchToken: DUMMY_LAUNCH_TOKEN }),
        spawnDsh: () => { spawned += 1; return fakeChild(DUMMY_LAUNCH_TOKEN); },
      },
    }));
    assert.equal(spawned, 0);
    assert.equal(result.final_state, 'PREFLIGHT_ONLY');
    assert.equal(result.steps.preflight.credential.length, 43);
    assert.equal(result.dsh_spawn_owned, false);
  } finally {
    fixture.dispose();
  }
});

test('R7B: a bootstrap failure is caught, not thrown, and still yields a result', async () => {
  // The branch must survive a failure far enough to write evidence: an operator's only
  // record of a broken run is the result file.
  const fixture = await Fixture.create();
  try {
    const result = await runGateB(fixture.options({
      seams: {
        ...syntheticSeams({ dshPort: fixture.config.dshPort, launchToken: DUMMY_LAUNCH_TOKEN }),
        spawnDsh: () => { throw new Error('synthetic spawn refusal'); },
      },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.dsh_spawn_owned, false);
    assert.equal(typeof result.error, 'string');

    // The failure must be reported in the returned result, because that is what an
    // operator sees. The journal is a separate concern and is deliberately not written
    // under a test runner, so this asserts the result rather than the file.
    assert.match(String(result.error), /synthetic spawn refusal/);
    assert.equal(result.final_state, null, 'a failed run must not claim a final state');
  } finally {
    fixture.dispose();
  }
});

test('R7B: a test run never overwrites the operator evidence', async () => {
  // The regression guard for a real mistake: an earlier version of this suite drove
  // `runGateB` without an evidence override, so synthetic fixture data replaced the
  // journal from an operator's actual external Gate B run. Evidence is the only record
  // of a real run, and a test must never be able to destroy it.
  const fixture = await Fixture.create();
  const snapshot = fs.readdirSync(GATE_B_EVIDENCE)
    .filter((name) => name.startsWith('r7b-'))
    .map((name) => ({ name, mtime: fs.statSync(path.join(GATE_B_EVIDENCE, name)).mtimeMs }));
  try {
    await runGateB(fixture.options({
      seams: syntheticSeams({ dshPort: fixture.config.dshPort, launchToken: DUMMY_LAUNCH_TOKEN }),
    }));

    const after = fs.readdirSync(GATE_B_EVIDENCE)
      .filter((name) => name.startsWith('r7b-'))
      .map((name) => ({ name, mtime: fs.statSync(path.join(GATE_B_EVIDENCE, name)).mtimeMs }));

    assert.deepEqual(after, snapshot, 'under a test runner the evidence directory must be untouched');
  } finally {
    fixture.dispose();
  }
});

test('R7B: every helper the non-dry-run branch calls is a real function', () => {
  assert.equal(typeof productionSecretScan, 'function');
  assert.equal(typeof collectPortState, 'function');
  assert.equal(typeof runGateB, 'function');
  assert.equal(typeof parseArgs, 'function');

  const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'r7b-scan-'));
  try {
    fs.writeFileSync(path.join(dir, 'clean.json'), '{"a":1}', 'utf8');
    const clean = productionSecretScan(dir, [crypto.randomBytes(32).toString('base64url')]);
    assert.deepEqual(clean.leaked, []);
    assert.equal(clean.files, 1);

    // It must detect a leak, or a clean result means nothing.
    const secret = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(path.join(dir, 'leak.json'), JSON.stringify({ note: secret }), 'utf8');
    const dirty = productionSecretScan(dir, [secret]);
    assert.equal(dirty.leaked.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R7B: the driver module is importable without parsing argv or exiting', async () => {
  // The guard that makes this suite possible: without it, importing the driver would run
  // its entry-point block, call `process.exit`, and take the test runner with it.
  const { isDirectInvocation } = await import('../../scripts/r7-gate-b.mjs');
  assert.equal(typeof isDirectInvocation, 'function');
  assert.equal(isDirectInvocation(), false, 'under node --test this module is imported, not the entry point');
});

test('R7B: the evidence directory holds no unredacted secret', () => {
  if (!fs.existsSync(GATE_B_EVIDENCE)) return;
  const files = fs.readdirSync(GATE_B_EVIDENCE).filter((name) => name.startsWith('r7b-'));
  const token = fs.existsSync(REAL_PHONE_TOKEN) ? fs.readFileSync(REAL_PHONE_TOKEN, 'utf8').trim() : null;

  for (const name of files) {
    const text = fs.readFileSync(path.join(GATE_B_EVIDENCE, name), 'utf8');
    assert.equal(/\?token=[A-Za-z0-9_-]{40,}/.test(text), false, `${name} carries a launch announcement`);
    assert.equal(/dsh-auth-[A-Za-z0-9_-]{40,}=/.test(text), false, `${name} carries a cookie`);
    assert.equal(/Bearer\s+[A-Za-z0-9_-]{40,}/.test(text), false, `${name} carries an Authorization header`);
    if (token !== null && token.length === 43) {
      assert.equal(text.includes(token), false, `${name} carries the Phone token`);
    }
  }
});
