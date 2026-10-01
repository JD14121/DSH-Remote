/**
 * Production configuration — Phase R7 §12, §5, §36.
 *
 * One module owns every path, port and version the production stack uses. R1-R6
 * consistently gave each fact exactly one definition so it cannot drift; the
 * production paths matter more than most, because two of them are security-relevant:
 * the credential file and the state root.
 *
 * Nothing here reads the environment for a **secret** (§48). Environment variables
 * may relocate paths, but the Phone token only ever arrives from its file.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Alias so a test can inject a different `fs` without shadowing the real one. */
const nodeFs = fs;

/** The pinned DSH version. `@latest` is forbidden (§13). */
export const DSH_VERSION = '0.1.5-rc.2';

/** The pinned package specifier used with `npx`. */
export const DSH_PACKAGE = `@deepseek-ai/dsh@${DSH_VERSION}`;

/** The production state-root directory name under `DSH_HOME`. */
export const REMOTE_DIR_NAME = 'remote';

/** R5's persistence format version. R7 must not change it (§5). */
export const PERSISTENCE_FORMAT_VERSION = 1;

/** The Gateway's loopback port (§12). */
export const GATEWAY_PORT = 9445;
/** The one public WebView origin permitted to pass the existing Gateway OriginPolicy. */
export const MOBILE_UI_ORIGINS = Object.freeze(['https://relay.drm-jd.com']);

/**
 * The operator's interactive DSH port.
 *
 * This is **not** a production port and must never be the supervised target. It is named here so
 * the two roles are distinguishable in one place, and so a test can assert they never collide.
 */
export const OPERATOR_DSH_PORT = 3080;

/**
 * DSH's own built-in default port, used only to decide whether `--port` must be passed explicitly.
 *
 * This is a property of the DSH CLI, not a production configuration value. It is deliberately
 * separate from {@link DSH_PORT} so that changing the production port cannot silently change what
 * "the child's default" means.
 */
export const DSH_DEFAULT_PORT = 3080;

/**
 * The supervised production DSH port (R7D — frozen).
 *
 * This is the port the production Supervisor owns a DSH child on. It is deliberately **not** the
 * operator's port: the Supervisor spawns and terminates the process on this port, so sharing 3080
 * would mean the lifecycle managing a process the operator is using interactively.
 *
 * History, so the value is not mysterious later:
 *
 * * `3080` was the composed default until R7D, which made a default-started Supervisor refuse to
 *   start whenever the operator's DSH was running — the normal case.
 * * `3081` appeared in lifecycle documentation and an old `supervisor.json`, but was never the
 *   composed default. R7D restores it as the documented production value.
 * * `3181` was an *acceptance override* used by R7C/R7C.1/R7C.2 to avoid contention. It is not a
 *   production port and is not promoted by this change.
 *
 * Overridable through `DSH_REMOTE_DSH_PORT`; when that variable is set the child is also launched
 * with an explicit `--port` so the listener cannot land on the composed default instead.
 */
export const DSH_PORT = 3081;

/** The launcher subcommand. */
export const DSH_SUBCOMMAND = 'web';

/**
 * The launcher flag that stops DSH opening a browser.
 *
 * Audited against the installed rc.2 CLI (§13). If a future version changes this
 * flag's meaning, startup must fail with `R7_DSH_LAUNCH_CONTRACT_CHANGED` rather
 * than guess a replacement.
 */
export const DSH_NO_OPEN_FLAG = '--no-open';

/** Addresses a Gateway must never bind (§12). */
const FORBIDDEN_HOSTS = Object.freeze(new Set([
  '0.0.0.0',
  '::',
  '[::]',
  '*',
]));

/**
 * The production error codes (§37).
 */
export const R7_ERROR = Object.freeze({
  PRODUCTION_ROOT_UNEXPECTED: 'R7_PRODUCTION_ROOT_UNEXPECTED',
  ACL_HARDENING_FAILED: 'R7_ACL_HARDENING_FAILED',
  ACL_POLICY_MISMATCH: 'R7_ACL_POLICY_MISMATCH',
  PHONE_TOKEN_ACL_INVALID: 'R7_PHONE_TOKEN_ACL_INVALID',
  PHONE_TOKEN_INVALID: 'R7_PHONE_TOKEN_INVALID',
  DSH_LAUNCH_CONTRACT_CHANGED: 'R7_DSH_LAUNCH_CONTRACT_CHANGED',
  DSH_BOOTSTRAP_TOKEN_UNRESOLVED: 'R7_DSH_BOOTSTRAP_TOKEN_UNRESOLVED',
  DSH_AUTH_BOOTSTRAP_FAILED: 'R7_DSH_AUTH_BOOTSTRAP_FAILED',
  DSH_PROCESS_EXITED: 'R7_DSH_PROCESS_EXITED',
  DSH_PORT_IN_USE: 'R7_DSH_PORT_IN_USE',
  /**
   * The process holding the DSH port could not be proven to belong to this supervisor's
   * spawn tree. `READY` is not published, because a stack that cannot say who owns its
   * own listener cannot honestly claim to be ready — nor reliably stop it later.
   */
  DSH_LISTENER_OWNERSHIP_UNPROVEN: 'R7_DSH_LISTENER_OWNERSHIP_UNPROVEN',
  PORT_IN_USE: 'R7_PORT_IN_USE',
  START_TIMEOUT: 'R7_START_TIMEOUT',
  CONTROL_REQUEST_INVALID: 'R7_CONTROL_REQUEST_INVALID',
  SUPERVISOR_LOCKED: 'R7_SUPERVISOR_LOCKED',
  PRODUCTION_SMOKE_FAILED: 'R7_PRODUCTION_SMOKE_FAILED',
  CREDENTIAL_RACE: 'R7_CREDENTIAL_RACE',
});

/** The eight supervisor states (§19). */
export const SUPERVISOR_STATE = Object.freeze({
  STARTING: 'STARTING',
  BOOTSTRAPPING_DSH: 'BOOTSTRAPPING_DSH',
  STARTING_GATEWAY: 'STARTING_GATEWAY',
  READY: 'READY',
  RESTARTING: 'RESTARTING',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED',
  FAILED: 'FAILED',
});

/**
 * An R7 configuration error.
 *
 * Carries one of the §37 codes so an operator sees a stable identifier rather than
 * a prose message.
 */
export class ProductionError extends Error {
  /**
   * @param {string} code - one of `R7_ERROR`.
   * @param {string} message - a safe, secret-free description.
   * @param {object} [options] - `cause`.
   */
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'ProductionError';
    this.code = code;
  }
}

/**
 * Assert a secret-free string. Used before anything reaches a log or a status file.
 *
 * @param {string} value - the value to check.
 * @param {readonly string[]} secrets - values that must not appear.
 * @param {string} where - a label for the error.
 * @returns {string} the value, unchanged.
 */
export function assertSecretFree(value, secrets, where) {
  const text = String(value);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0 && text.includes(secret)) {
      throw new ProductionError(R7_ERROR.PRODUCTION_SMOKE_FAILED, `a secret reached ${where}`);
    }
  }
  return value;
}

/**
 * Resolve the production layout.
 *
 * @param {object} [overrides] - path overrides, for tests and for a relocated install.
 * @param {string} [overrides.dshHome] - DSH_HOME.
 * @param {string} [overrides.workspace] - the DSH workspace directory.
 * @param {string} [overrides.gatewayHost] - the Gateway bind address.
 * @param {number} [overrides.gatewayPort] - the Gateway port.
 * @returns {object} the resolved configuration, with a frozen `paths` block.
 * @throws {ProductionError} when the bind address is not loopback.
 */
export function resolveProductionConfig(overrides = {}) {
  const dshHome = path.resolve(
    overrides.dshHome ?? process.env.DSH_REMOTE_DSH_HOME ?? path.join('D:\\DSH-work-test', '.dsh'),
  );
  const workspace = path.resolve(overrides.workspace ?? process.env.DSH_REMOTE_WORKSPACE ?? 'D:\\DSH-testing');
  const gatewayHost = overrides.gatewayHost ?? '127.0.0.1';
  const gatewayPort = overrides.gatewayPort ?? GATEWAY_PORT;
  const dshHost = overrides.dshHost ?? '127.0.0.1';
  /**
   * The DSH port the supervisor will own.
   *
   * Overridable by `DSH_REMOTE_DSH_PORT`, following the same `DSH_REMOTE_*` convention as the
   * other tunables. R7C needed this: the operator's interactive DSH holds the composed default
   * (3080), and the supervisor must own a child on a free port rather than stop a process it does
   * not own. `dshExplicitPort` is what actually puts `--port` on the child's argv.
   */
  const dshPortOverride = process.env.DSH_REMOTE_DSH_PORT;
  const dshPort = overrides.dshPort
    ?? (dshPortOverride === undefined || dshPortOverride === '' ? DSH_PORT : Number(dshPortOverride));
  /**
   * Whether to pass `--port` to the DSH child explicitly.
   *
   * This is now driven by the port value rather than by the caller, because the composed production
   * port (3081) no longer coincides with DSH's own built-in default (3080). Without an explicit
   * `--port`, the child would silently bind 3080 — the operator's port — so the Supervisor would end
   * up contending for exactly the port this contract exists to avoid, and `adoptListener` would then
   * fail against a process it does not own.
   *
   * Passing `--port` whenever the configured port differs from DSH's default makes the invariant
   * structural: the listener binds the configured port, or the start fails visibly.
   *
   * The original reason is preserved: it is also turned on when the caller already knows the
   * composed port is taken by a DSH the supervisor does not own — owning a child on a free port is
   * better than stopping somebody else's process. Setting `DSH_REMOTE_DSH_PORT` implies it too.
   */
  const dshExplicitPort = overrides.dshExplicitPort === true
    || (dshPortOverride !== undefined && dshPortOverride !== '')
    || dshPort !== DSH_DEFAULT_PORT;

  // §12: a non-loopback bind is refused at configuration time, not at bind time.
  // "It would have failed to bind anyway" is not good enough — a LAN bind can
  // succeed, and that is precisely the outcome this must prevent.
  if (!isLoopbackHost(gatewayHost)) {
    throw new ProductionError(
      R7_ERROR.PRODUCTION_ROOT_UNEXPECTED,
      `the Gateway must bind loopback, not ${JSON.stringify(gatewayHost)}`,
    );
  }
  if (typeof gatewayPort !== 'number' || !Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) {
    throw new TypeError('gatewayPort must be an integer in 1..65535');
  }

  const root = path.join(dshHome, REMOTE_DIR_NAME);

  return {
    dshVersion: DSH_VERSION,
    dshPackage: DSH_PACKAGE,
    dshSubcommand: DSH_SUBCOMMAND,
    dshNoOpenFlag: DSH_NO_OPEN_FLAG,
    dshHome,
    workspace,
    gatewayHost,
    gatewayPort,
    mobileAllowedOrigins: MOBILE_UI_ORIGINS,
    dshHost,
    dshPort,
    dshExplicitPort,
    /** The production state root (§5). */
    root,
    paths: Object.freeze({
      root,
      format: path.join(root, 'format.json'),
      secrets: path.join(root, 'secrets'),
      phoneToken: path.join(root, 'secrets', 'phone-token.v1'),
      phoneTokenMeta: path.join(root, 'secrets', 'phone-token.meta.json'),
      state: path.join(root, 'state'),
      gatewayLock: path.join(root, 'state', 'gateway.lock'),
      supervisorLock: path.join(root, 'state', 'supervisor.lock'),
      supervisorJson: path.join(root, 'state', 'supervisor.json'),
      control: path.join(root, 'state', 'control'),
      events: path.join(root, 'events'),
      logs: path.join(root, 'logs'),
      supervisorLog: path.join(root, 'logs', 'supervisor.log'),
      gatewayLog: path.join(root, 'logs', 'gateway.log'),
      dshLog: path.join(root, 'logs', 'dsh.log'),
      quarantine: path.join(root, 'quarantine'),
    }),
    /** §26: rotation defaults. */
    logMaxBytes: Number(process.env.DSH_REMOTE_LOG_MAX_BYTES ?? 10_485_760),
    logBackups: Number(process.env.DSH_REMOTE_LOG_BACKUPS ?? 5),
    /**
     * §30: how long start may take before it is a failure.
     *
     * The DSH child is launched through `npx`, which must resolve the pinned package
     * before the real listener starts. Measured spawn -> announcement latency is
     * ~40-49 s, so a 60 s budget left only a ~11 s margin and intermittently expired,
     * surfacing as `R7_DSH_BOOTSTRAP_TOKEN_UNRESOLVED` ("no launch-token announcement
     * was observed") even though the child was healthy. The budget is therefore sized
     * for the slowest observed npx-mediated start plus headroom.
     */
    startTimeoutMs: Number(process.env.DSH_REMOTE_START_TIMEOUT_MS ?? 180_000),
    /** §23: self-healing policy. */
    maxRestarts: Number(process.env.DSH_REMOTE_MAX_RESTARTS ?? 3),
    restartBackoffMs: Object.freeze([1000, 2000, 4000]),
    /** §23: how long the stack must be stable before the failure count clears. */
    stabilityMs: Number(process.env.DSH_REMOTE_STABILITY_MS ?? 60_000),
  };
}

/**
 * Whether a host is a loopback address.
 *
 * @param {string} host - the host to test.
 * @returns {boolean} true when loopback.
 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;
  const bare = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (FORBIDDEN_HOSTS.has(bare)) return false;
  if (bare === 'localhost' || bare === '::1') return true;
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (match === null) return false;
  return match.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * A concise, secret-free description of where production state lives.
 *
 * Used by `dsh-status.ps1` and the startup banner. It deliberately reports paths
 * because an operator needs them, and paths are not secrets.
 *
 * @param {object} config - a resolved configuration.
 * @returns {object} the summary.
 */
export function describeProductionConfig(config) {
  return {
    dsh_version: config.dshVersion,
    dsh_home: config.dshHome,
    workspace: config.workspace,
    root: config.root,
    gateway: `${config.gatewayHost}:${config.gatewayPort}`,
    dsh: `http://${config.dshHost}:${config.dshPort}`,
    platform: `${os.platform()} ${os.release()}`,
    node: process.version,
  };
}

/**
 * The launcher argv for DSH, audited against rc.2 (§13).
 *
 * Returned as an array so no shell parses it, and so a test can assert the exact
 * shape without executing anything.
 *
 * @param {object} config - a resolved configuration.
 * @returns {string[]} the argument vector after `npx`.
 */
export function dshLaunchArgv(config) {
  return ['-y', config.dshPackage, config.dshSubcommand, config.dshNoOpenFlag];
}

/**
 * The launcher argv including an explicit port, when one is configured.
 *
 * The composed `web` profile already binds the configured port, so `--port` is
 * normally redundant and is not emitted. It exists for one case: a differently
 * configured DSH is already running on the composed port, and the supervisor must own
 * its own child. Owning a child on a free port is strictly better than stopping a
 * process the supervisor does not own.
 *
 * `--port` is a documented rc.2 flag, verified empirically by running
 * `dsh web --no-open --port <n>` and observing the announcement on that port.
 *
 * @param {object} config - a resolved configuration.
 * @returns {string[]} the argument vector after `npx`.
 */
export function dshLaunchArgvWithPort(config) {
  const base = dshLaunchArgv(config);
  if (config.dshExplicitPort !== true) return base;
  return [...base, '--port', String(config.dshPort)];
}

/** The child directories created inside a freshly hardened root (§6). */
export const PROTECTED_SUBDIRS = Object.freeze([
  'secrets',
  'state',
  'state/control',
  'events',
  'logs',
  'quarantine',
]);

/**
 * Whether the production root already exists.
 *
 * @param {object} config - a resolved configuration.
 * @param {object} [fsModule] - injectable `fs`, for tests.
 * @returns {boolean} true when present.
 */
export function productionRootExists(config, fsModule) {
  const fs = fsModule ?? nodeFs;
  return fs.existsSync(config.paths.root);
}

/**
 * Create and harden the production root (§6, §28).
 *
 * The order is the security property, so it is implemented as a single function
 * rather than left to a caller:
 *
 * ```text
 * create empty root → protect DACL → VERIFY → create child dirs → write format.json
 * ```
 *
 * Nothing is created inside the root until the DACL has been verified, because a
 * secret written into a not-yet-protected directory is a secret that was briefly
 * world-readable — and "briefly" is not a meaningful mitigation.
 *
 * @param {object} options - creation options.
 * @param {object} options.config - a resolved configuration.
 * @param {object} [options.fsModule] - injectable `fs`.
 * @param {(target: string, options: object) => Promise<object>} [options.harden] - ACL hardener.
 * @param {(target: string, options: object) => Promise<object>} [options.verify] - ACL verifier.
 * @returns {Promise<{created: boolean, root: string, subdirs: string[], aclVerified: boolean}>} the outcome.
 * @throws {ProductionError} `R7_PRODUCTION_ROOT_UNEXPECTED` or `R7_ACL_HARDENING_FAILED`.
 */
export async function prepareProductionRoot(options) {
  const fs = options.fsModule ?? nodeFs;
  const config = options.config;
  const root = config.paths.root;

  if (fs.existsSync(root)) {
    // §6: an existing root is never deleted, overwritten or blindly reused. If R7 did
    // not create it, an operator must decide what it is.
    throw new ProductionError(
      R7_ERROR.PRODUCTION_ROOT_UNEXPECTED,
      `the production root already exists at ${root}; R7 will not overwrite or reuse it`,
    );
  }

  const harden = options.harden;
  const verify = options.verify;
  if (typeof harden !== 'function' || typeof verify !== 'function') {
    throw new ProductionError(
      R7_ERROR.ACL_HARDENING_FAILED,
      'creating the production root requires an ACL hardener and verifier',
    );
  }

  // 1. An empty root, so the DACL has something to protect.
  fs.mkdirSync(root, { recursive: true });

  // 2. Protect the DACL on the root FIRST.
  try {
    await harden(root, { label: 'root' });
  } catch (error) {
    throw new ProductionError(
      R7_ERROR.ACL_HARDENING_FAILED,
      `could not harden the production root: ${error?.message ?? 'unknown'}`,
    );
  }

  // 3. VERIFY before anything else is created. An unverified ACL is not an ACL.
  try {
    await verify(root, { code: R7_ERROR.ACL_POLICY_MISMATCH, label: 'root' });
  } catch (error) {
    throw new ProductionError(
      R7_ERROR.ACL_HARDENING_FAILED,
      `the production root ACL did not verify: ${error?.message ?? 'unknown'}`,
    );
  }

  // 4. Only now may children be created. They inherit the protected DACL.
  for (const sub of PROTECTED_SUBDIRS) {
    fs.mkdirSync(path.join(root, ...sub.split('/')), { recursive: true });
  }

  // 5. The format marker, matching R5's v1 schema exactly (§5).
  fs.writeFileSync(
    config.paths.format,
    `${JSON.stringify({ format: 'dsh-remote-state', version: PERSISTENCE_FORMAT_VERSION }, null, 2)}\n`,
    { encoding: 'utf8' },
  );

  return { created: true, root, subdirs: [...PROTECTED_SUBDIRS], aclVerified: true };
}
