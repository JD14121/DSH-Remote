/**
 * R7 shared test helpers.
 *
 * Every Gate A test runs against an **OS temp root**. The real production root
 * `D:\DSH-work-test\.dsh\remote` must not exist before Gate B, and a helper that could
 * accidentally create it would defeat the whole two-gate structure.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DSH_PACKAGE,
  DSH_VERSION,
  R7_ERROR,
  ProductionError,
  SUPERVISOR_STATE,
  describeProductionConfig,
  dshLaunchArgv,
  isLoopbackHost,
  prepareProductionRoot,
  productionRootExists,
  resolveProductionConfig,
} from '../../src/remote/production/production-config.mjs';
import { CredentialStore, generatePhoneToken, isValidPhoneToken } from '../../src/remote/production/credential-store.mjs';
import {
  CONTROL_ACTION,
  CONTROL_VERSION,
  ControlChannel,
  assertTargetsInstance,
  buildStopRequest,
  validateControlRequest,
} from '../../src/remote/production/control-channel.mjs';
import { DshProcess, FORCE_KILL, GRACEFUL_STOP_TIMEOUT_MS, FORCE_STOP_TIMEOUT_MS, STOP_POLL_MS, assertPortFree, isPortListening } from '../../src/remote/production/dsh-process.mjs';
import { dshLaunchArgvWithPort, OPERATOR_DSH_PORT, DSH_DEFAULT_PORT } from '../../src/remote/production/production-config.mjs';
import {
  CookieAuthProvider,
  LAUNCH_TOKEN_PATTERN,
  LaunchTokenParser,
  cookieNameForAuthority,
  exchangeLaunchToken,
  firstTokenFrom,
  readSetCookie,
  verifyCookie,
} from '../../src/remote/production/dsh-bootstrap.mjs';
import {
  LOG_EVENTS,
  ProductionLogs,
  RAW_LINE_MAX_CHARS,
  RotatingLog,
  assertLogRedacted,
  isDeniedField,
  sanitize,
} from '../../src/remote/production/logger.mjs';
import {
  RuntimeStatus,
  canTransition,
  isLiveSupervisor,
  readStatus,
  sanitizeFields,
  writeAtomic,
} from '../../src/remote/production/runtime-status.mjs';
import { Supervisor } from '../../src/remote/production/supervisor.mjs';
import {
  aclSupported,
  currentUserSid,
  hardenAcl,
  readAcl,
  removeTreeWithAclRestore,
  removeTreeWithAclRestoreSync,
  verifyAcl,
} from '../../src/remote/production/windows-acl.mjs';

export {
  crypto,
  fs,
  os,
  path,
  DSH_PACKAGE,
  DSH_VERSION,
  R7_ERROR,
  ProductionError,
  SUPERVISOR_STATE,
  describeProductionConfig,
  dshLaunchArgv,
  isLoopbackHost,
  prepareProductionRoot,
  productionRootExists,
  resolveProductionConfig,
  CredentialStore,
  generatePhoneToken,
  isValidPhoneToken,
  ControlChannel,
  CONTROL_ACTION,
  CONTROL_VERSION,
  assertTargetsInstance,
  buildStopRequest,
  validateControlRequest,
  DshProcess,
  FORCE_KILL,
  GRACEFUL_STOP_TIMEOUT_MS,
  FORCE_STOP_TIMEOUT_MS,
  STOP_POLL_MS,
  dshLaunchArgvWithPort,
  OPERATOR_DSH_PORT,
  DSH_DEFAULT_PORT,
  assertPortFree,
  isPortListening,
  CookieAuthProvider,
  LAUNCH_TOKEN_PATTERN,
  LaunchTokenParser,
  cookieNameForAuthority,
  exchangeLaunchToken,
  firstTokenFrom,
  readSetCookie,
  verifyCookie,
  ProductionLogs,
  RotatingLog,
  LOG_EVENTS,
  RAW_LINE_MAX_CHARS,
  assertLogRedacted,
  isDeniedField,
  sanitize,
  RuntimeStatus,
  canTransition,
  isLiveSupervisor,
  readStatus,
  sanitizeFields,
  writeAtomic,
  Supervisor,
  aclSupported,
  currentUserSid,
  hardenAcl,
  readAcl,
  verifyAcl,
};

/** The real production root that Gate A must never create. */
export const REAL_PRODUCTION_ROOT = 'D:\\DSH-work-test\\.dsh\\remote';

/** The real DSH_HOME. */
export const REAL_DSH_HOME = 'D:\\DSH-work-test\\.dsh';

/**
 * Create an isolated temp root and a production config pointing at it.
 *
 * @param {object} [options] - overrides.
 * @returns {{root: string, config: object, cleanup: () => void}} the fixture.
 */
export function makeTempProduction(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r7-'));
  const dshHome = path.join(root, '.dsh');
  const config = resolveProductionConfig({
    dshHome,
    workspace: options.workspace ?? root,
    gatewayHost: options.gatewayHost,
    // A real, unbound port number. The config deliberately rejects 0 — "let the OS
    // choose" is not something a production Gateway should ever do, because the
    // operator would not know which port to expect.
    gatewayPort: options.gatewayPort ?? 19445,
    // A real, unbound DSH port. Left at the composed default of 3080 a fixture would
    // collide with the operator's running DSH, and the supervisor — correctly — refuses
    // to spawn onto an occupied port. The default here is deliberately far from 3080.
    dshPort: options.dshPort ?? 19446,
  });
  return {
    root,
    config,
    /**
     * Remove the temp tree.
     *
     * @returns {void}
     */
    /**
     * Remove the temp tree.
     *
     * ACL-hardened fixtures cannot always be deleted with a plain recursive remove: the
     * hardening that stops other users reading the secret also removes some rights a
     * delete needs. So a failed remove schedules an inheritance restore and retry.
     *
     * Synchronous on the common path, because almost every call site is synchronous and
     * making them all `await` would be a large change for a rare case.
     *
     * @returns {void}
     */
    cleanup() {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 2 });
        return;
      } catch {
        // Fall through to the hardened-fixture path.
      }
      // Synchronous, because a `void`ed promise does not keep the process alive: the
      // restore never completed and one temp root leaked per run. Teardown must finish
      // before the test runner exits.
      removeTreeWithAclRestoreSync(root);
    },
  };
}

/**
 * Assert that a temp fixture is genuinely outside the real DSH_HOME.
 *
 * @param {string} root - the temp root.
 * @returns {void}
 */
export function assertOutsideRealDshHome(root) {
  const real = path.resolve(REAL_DSH_HOME);
  const resolved = path.resolve(root);
  if (resolved === real || resolved.startsWith(`${real}${path.sep}`)) {
    throw new Error(`refusing to use a root inside the real DSH_HOME: ${resolved}`);
  }
}

/** A manual clock, so no test sleeps. */
export function manualClock(start = Date.parse('2026-09-19T12:00:00.000Z')) {
  let now = start;
  return {
    now: () => now,
    date: () => new Date(now),
    advance: (ms) => { now += ms; },
    set: (value) => { now = value; },
  };
}

/**
 * A synthetic DSH child that behaves like the real one's observable surface.
 *
 * @param {object} [options] - behaviour overrides.
 * @returns {object} the synthetic child.
 */
export function syntheticDshChild(options = {}) {
  const launchToken = options.launchToken ?? crypto.randomBytes(32).toString('base64url');
  const child = {
    pid: options.pid ?? 900001,
    instanceId: options.instanceId ?? 'synthetic-child',
    alive: true,
    startCalls: 0,
    stopCalls: 0,
    handlers: new Set(),
    exitHandlers: new Set(),
    start() {
      this.startCalls += 1;
      if (options.announce !== false) {
        setTimeout(() => {
          for (const handler of this.handlers) {
            handler(options.line ?? `dsh web: http://127.0.0.1:3080/?token=${launchToken}`, 'stdout');
          }
        }, options.announceDelayMs ?? 5);
      }
      return { pid: this.pid, instanceId: this.instanceId, argv: [] };
    },
    onLine(handler) { this.handlers.add(handler); return () => this.handlers.delete(handler); },
    onExit(handler) { this.exitHandlers.add(handler); return () => this.exitHandlers.delete(handler); },
    /**
     * Simulate the child exiting.
     *
     * @param {object} [info] - exit facts.
     * @returns {void}
     */
    emitExit(info = { code: 1, signal: null }) {
      this.alive = false;
      for (const handler of this.exitHandlers) handler({ ...info, pid: this.pid, instanceId: this.instanceId });
    },
    describe() { return { instance_id: this.instanceId, pid: this.pid, alive: this.alive }; },
    async stop() { this.stopCalls += 1; this.alive = false; return { graceful: true, forced: false, pid: this.pid }; },
  };
  return child;
}

/**
 * A synthetic loopback HTTP responder for the exchange and verification calls.
 *
 * @param {number} status - the status code.
 * @param {object} headers - the response headers.
 * @param {string} [body] - the body.
 * @returns {Function} a `(options, callback) => ClientRequest` stub.
 */
export function syntheticResponse(status, headers, body = '') {
  return (options, callback) => {
    const res = {
      statusCode: status,
      headers,
      resume() {},
      on(event, fn) {
        if (event === 'end') setImmediate(fn);
        return res;
      },
    };
    setImmediate(() => callback(res));
    return { on() { return this; }, end() {}, destroy() {}, write() {} };
  };
}

/**
 * A supervisor wired entirely to synthetic collaborators.
 *
 * @param {object} [options] - overrides.
 * @returns {Promise<object>} `{ supervisor, config, root, cleanup, launchToken, cookieValue }`.
 */
export async function makeSupervisor(options = {}) {
  const fixture = makeTempProduction(options);
  if (options.prepare !== false) {
    const sid = options.sid ?? await currentUserSid();
    await prepareProductionRoot({ config: fixture.config, harden: hardenAcl, verify: verifyAcl });
    fixture.sid = sid;
  }

  const launchToken = crypto.randomBytes(32).toString('base64url');
  const cookieValue = crypto.randomBytes(32).toString('base64url');
  const authority = `${fixture.config.dshHost}:${fixture.config.dshPort}`;
  const cookieName = cookieNameForAuthority(authority);

  const child = syntheticDshChild({ launchToken, ...(options.child ?? {}) });
  const events = [];

  const supervisor = new Supervisor({
    config: fixture.config,
    instanceId: options.instanceId,
    seams: {
      spawnDsh: () => child,
      exchangeLaunchToken: options.exchange
        ?? syntheticResponse(303, { 'set-cookie': [`${cookieName}=${cookieValue}; Path=/; HttpOnly; SameSite=Strict`] }),
      verifyCookie: options.verify ?? syntheticResponse(200, {}),
      createGateway: options.createGateway ?? (async () => ({
        stop: async () => ({ stopped: true }),
        recovery: { recoveredSessions: 1 },
      })),
      // The OS boundaries. A synthetic child owns no real tree and binds no real socket,
      // so the probes are seamed; the ownership proof, the STOPPED invariant and the
      // restart gate that consume them all still run. The synthetic child declares itself
      // the listener, so ownership is proven the same way the real one is — the reported
      // PID is already in the owned set.
      enumerateTree: options.enumerateTree ?? (() => [child.pid]),
      listenerPid: options.listenerPid ?? (async () => child.pid ?? 0),
      ancestorsOf: options.ancestorsOf ?? (async () => []),
      waitPortFree: options.waitPortFree ?? (async () => ({ free: true, waitedMs: 0 })),
      isProcessAlive: options.isProcessAlive ?? (async () => false),
      ...(options.seams ?? {}),
    },
  });
  if (options.collectEvents !== false) {
    supervisor.logs.supervisor.onWriteObserver = null;
  }

  return {
    ...fixture,
    supervisor,
    child,
    launchToken,
    cookieValue,
    cookieName,
    authority,
    events,
    /**
     * Stop the supervisor and remove the temp tree.
     *
     * @returns {Promise<void>} resolves when clean.
     */
    async cleanupAll() {
      try { await supervisor.stop(); } catch { /* best effort */ }
      fixture.cleanup();
    },
  };
}

/**
 * Read every log line a production fixture produced.
 *
 * @param {object} config - a resolved config.
 * @returns {Array<object>} the parsed JSONL records.
 */
export function readLogRecords(config) {
  const out = [];
  for (const file of [config.paths.supervisorLog, config.paths.gatewayLog, config.paths.dshLog]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        out.push({ unparseable: line });
      }
    }
  }
  return out;
}

/**
 * Scan a tree for a set of secrets.
 *
 * @param {string} root - the tree.
 * @param {readonly string[]} secrets - the forbidden values.
 * @returns {{files: number, leaked: string[]}} the scan.
 */
export function scanTreeForSecrets(root, secrets) {
  const leaked = [];
  let files = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      files += 1;
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      for (const secret of secrets) {
        if (typeof secret === 'string' && secret.length >= 8 && text.includes(secret)) {
          leaked.push(path.relative(root, full));
          break;
        }
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return { files, leaked };
}

/**
 * Assert the real production root does not exist.
 *
 * @returns {void}
 */
export function assertRealProductionRootAbsent() {
  if (fs.existsSync(REAL_PRODUCTION_ROOT)) {
    throw new Error(`the real production root exists at ${REAL_PRODUCTION_ROOT}; Gate A must not create it`);
  }
}
