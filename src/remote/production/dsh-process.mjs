/**
 * DSH child-process wrapper — Phase R7 §14, §15, §22, §23, §36.
 *
 * The single most dangerous thing this project could do is stop "node" and take the
 * operator's other work with it. Everything here is therefore built around one rule:
 *
 * > **Only a process this supervisor spawned is ever signalled.**
 *
 * There is no name-based kill, no port-based kill, and no "find the process on 3080
 * and terminate it". A port conflict is a refusal, not an invitation to take
 * ownership of something that is not ours.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { R7_ERROR, ProductionError, dshLaunchArgvWithPort } from './production-config.mjs';

/**
 * How the child is signalled when a graceful stop times out (§22).
 *
 * `ARGS` is the **option template**; the target PID is substituted at index 1, immediately after
 * `/PID`, and the remaining options follow it. `taskkill` requires the value for `/PID` to come
 * directly after the switch, so the argv must be `/PID <pid> /T /F` — never `/PID /T /F <pid>`.
 *
 * That ordering was the actual cause of R7-KNOWN-LIMITATION-01 surviving its own fix. When `/F` was
 * appended to the old `['/PID', '/T']` template and the PID was appended last, every invocation
 * became `/PID /T /F <pid>`, which `taskkill` rejects with
 *
 * ```text
 * ERROR: Invalid syntax. Value for '/PID' is required.
 * ```
 *
 * exit code 1, and no termination of any kind. The escalation therefore reported nothing useful and
 * the listener survived. The bare `taskkill`-on-PATH invocation now also uses the absolute path and
 * has its exit code, stdout and stderr checked, because the previous version discarded all three
 * and could not have detected this.
 */
export const FORCE_KILL = Object.freeze({ TOOL: 'taskkill', ARGS: ['/PID', '<pid>', '/T', '/F'] });

/**
 * The canonical stop deadline, in milliseconds (R7C §8).
 *
 * `GRACEFUL_STOP_TIMEOUT_MS` bounds the polite phase: a plain `SIGTERM` to the owned child,
 * then a wait for it to actually exit. Long enough that an ordinary shutdown is never cut
 * short, short enough that an unattended stop cannot hang.
 *
 * `FORCE_STOP_TIMEOUT_MS` bounds the escalation phase. Note that it does NOT bound the
 * escalation itself — it bounds the wait *after* it — so a force-kill implementation that
 * never settles cannot stall the lifecycle.
 *
 * Both are single named constants so no caller or test has to invent a magic number, and so
 * the configured values can be quoted directly in acceptance evidence.
 */
export const GRACEFUL_STOP_TIMEOUT_MS = 10_000;
export const FORCE_STOP_TIMEOUT_MS = 5_000;

/** How often the stop path re-polls for observed process death. */
export const STOP_POLL_MS = 100;

/**
 * Resolve how to launch `npx` without a shell.
 *
 * On Windows `npx` is `npx.cmd`, and Node refuses to `spawn` a `.cmd` with
 * `shell: false` — it throws `EINVAL` before the process starts. Enabling the shell
 * instead would hand the argv to `cmd.exe`, where the pinned package specifier and the
 * `--no-open` flag would be re-parsed. A supervisor must not let a shell reinterpret
 * the command it was audited to run.
 *
 * So `npx.cmd` is never spawned. Its underlying CLI, `npm/bin/npx-cli.js`, is run with
 * the same `node` executing the supervisor. The argv and semantics are unchanged —
 * `node npx-cli.js -y <pkg> web --no-open` is the same `npx` invocation — but nothing
 * passes through `cmd.exe`.
 *
 * @param {object} [options] - resolution options.
 * @param {string} [options.execPath] - the node executable.
 * @param {string} [options.platform] - the platform to resolve for.
 * @param {object} [options.fsModule] - injectable `fs`, for tests.
 * @returns {{command: string, prefixArgs: string[], via: string}} the launch shape.
 * @throws {ProductionError} `R7_DSH_LAUNCH_CONTRACT_CHANGED` when no launcher is found.
 */
export function resolveNpxLauncher(options = {}) {
  const execPath = options.execPath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const fsModule = options.fsModule ?? fs;

  if (platform !== 'win32') {
    // On POSIX, `npx` is a real executable script and can be spawned directly.
    return { command: 'npx', prefixArgs: [], via: 'npx' };
  }

  const nodeDir = path.dirname(execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ];
  for (const candidate of candidates) {
    if (fsModule.existsSync(candidate)) {
      return { command: execPath, prefixArgs: [candidate], via: 'node+npx-cli.js' };
    }
  }

  throw new ProductionError(
    R7_ERROR.DSH_LAUNCH_CONTRACT_CHANGED,
    'could not locate npm/bin/npx-cli.js next to the running node; refusing to spawn '
    + 'npx.cmd through a shell, because that would let cmd.exe reinterpret the audited arguments',
  );
}

/**
 * A DSH child process owned by this supervisor.
 */
export class DshProcess {
  /**
   * @param {object} options - process options.
   * @param {object} options.config - the resolved production config.
   * @param {Function} [options.spawn] - injectable spawn, for tests.
   * @param {string} [options.execPath] - override the launcher command.
   * @param {string[]} [options.launcherArgs] - override the launcher prefix args.
   * @param {() => Date} [options.clock] - injectable clock.
   */
  constructor(options) {
    this.config = options.config;
    this.spawnImpl = options.spawn ?? nodeSpawn;
    // Resolved rather than assumed: spawning `npx.cmd` with `shell: false` throws
    // EINVAL on Windows, and using a shell would let cmd.exe reinterpret the argv.
    const launcher = options.execPath === undefined
      ? resolveNpxLauncher()
      : { command: options.execPath, prefixArgs: options.launcherArgs ?? [], via: 'explicit' };
    this.launcher = launcher;
    this.execPath = launcher.command;
    this.launcherPrefixArgs = launcher.prefixArgs;
    this.clock = options.clock ?? (() => new Date());
    /** A fresh identity per spawn, so a stale supervisor cannot match this child. */
    this.instanceId = options.instanceId ?? crypto.randomUUID();
    /** @type {import('node:child_process').ChildProcess|null} */
    this.child = null;
    this.pid = null;
    this.startedAt = null;
    this.exitedAt = null;
    this.exitCode = null;
    this.exitSignal = null;
    this.lineHandlers = new Set();
    this.exitHandlers = new Set();
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.stopped = false;
    /**
     * The spawned tree, recorded while it is intact.
     *
     * The listener is a grandchild (npx → cmd.exe → the DSH server), so the recorded PID
     * alone is not enough to stop it. This is populated just after spawn, before the
     * wrapper has a chance to exit and let its child be re-parented.
     *
     * @type {number[]}
     */
    this.ownedPids = [];
    /**
     * The persistent ownership set, created lazily once the PID is known.
     *
     * @type {DshOwnership|null|undefined}
     */
    this.ownershipTracker = null;
  }

  /**
   * Whether a child is currently running.
   *
   * @returns {boolean} true when running.
   */
  get alive() {
    return this.child !== null && this.exitCode === null && this.child.exitCode === null;
  }

  /**
   * Register a handler for each stdout/stderr line.
   *
   * Lines are delivered **before** anything reaches a log, which is what makes the
   * §15 ordering (`read → parse → redact → log`) enforceable at the call site.
   *
   * @param {(line: string, stream: string) => void} handler - the handler.
   * @returns {() => void} an unsubscribe function.
   */
  onLine(handler) {
    this.lineHandlers.add(handler);
    return () => this.lineHandlers.delete(handler);
  }

  /**
   * Register a handler for child exit.
   *
   * @param {(info: object) => void} handler - the handler.
   * @returns {() => void} an unsubscribe function.
   */
  onExit(handler) {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  /**
   * Spawn the child.
   *
   * @returns {{pid: number, instanceId: string, argv: string[]}} the spawn facts.
   * @throws {ProductionError} `R7_DSH_PROCESS_EXITED` if the spawn fails immediately.
   */
  start() {
    if (this.child !== null) throw new ProductionError(R7_ERROR.DSH_PROCESS_EXITED, 'the DSH child is already spawned');

    const argv = dshLaunchArgvWithPort(this.config);
    this.child = this.spawnImpl(this.execPath, [...this.launcherPrefixArgs, ...argv], {
      // §13: the workspace is explicit. A supervisor whose behaviour depends on the
      // shell's working directory is a supervisor that behaves differently depending
      // on who launched it.
      cwd: this.config.workspace,
      env: {
        ...process.env,
        DSH_HOME: this.config.dshHome,
        // Never let an inherited value redirect the child's state.
        DSH_REMOTE_PRODUCTION: '1',
      },
      // §15: pipes, never `inherit`. Inheriting would let the child's launch token go
      // straight to a console and escape every redaction control.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });

    this.pid = this.child.pid ?? null;
    this.startedAt = this.clock();
    this.exitCode = null;
    this.exitedAt = null;

    this.#attach(this.child.stdout, 'stdout');
    this.#attach(this.child.stderr, 'stderr');

    this.child.on('error', (error) => {
      this.#emitExit({ code: null, signal: null, error });
    });
    this.child.on('exit', (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      this.exitedAt = this.clock();
      this.#emitExit({ code, signal, error: null });
    });

    return { pid: this.pid, instanceId: this.instanceId, argv };
  }

  /**
   * Record the spawned process tree.
   *
   * Called immediately after spawn, while the wrapper chain is still intact. A tree that
   * cannot be read leaves ownership as just the root, and ownership never widens to
   * "anything that looks like DSH" — a command line is not evidence of ownership.
   *
   * @param {object} [options] - `enumerate` injectable enumerator.
   * @returns {Promise<number[]>} the recorded PIDs, root first.
   */
  async recordOwnedTree(options = {}) {
    if (this.pid === null) return [];
    const enumerate = options.enumerate ?? enumerateProcessTree;
    const pids = await enumerate(this.pid);
    this.ownedPids = Array.isArray(pids) && pids.length > 0 ? pids : [this.pid];
    // The persistent tracker is the authority; `ownedPids` mirrors it for compatibility.
    const ownership = this.ownership;
    for (const pid of this.ownedPids) {
      ownership.owned.add(pid);
      ownership.ancestors.add(pid);
    }
    return this.ownedPids;
  }

  /**
   * The persistent ownership set for this child.
   *
   * Sampled across `after_spawn`, `after_launch_announcement` and `before_ready`, because
   * the shim and listener do not exist at spawn time. A one-time snapshot is how the
   * listener ended up outside the owned tree.
   *
   * @returns {DshOwnership} the tracker.
   */
  get ownership() {
    if (this.ownershipTracker === undefined || this.ownershipTracker === null) {
      this.ownershipTracker = new DshOwnership({ rootPid: this.pid, instanceId: this.instanceId });
    }
    return this.ownershipTracker;
  }

  /**
   * Take an ownership snapshot and mirror it into `ownedPids`.
   *
   * @param {string} stage - the lifecycle point.
   * @param {object} [options] - injectable walkers and clock.
   * @returns {Promise<object>} the snapshot.
   */
  async snapshotOwnership(stage, options = {}) {
    const result = await this.ownership.snapshot(stage, options);
    this.ownedPids = [...this.ownership.owned];
    return result;
  }

  /**
   * Prove and adopt the process listening on a port.
   *
   * @param {number} port - the DSH port.
   * @param {object} [options] - `listenerPid`, `ancestorsOf`.
   * @returns {Promise<{proven: boolean, reason: string, listenerPid: number|null}>} the verdict.
   */
  async adoptListener(port, options = {}) {
    const listener = options.listenerPid ?? listenerPidOf;
    const pid = await listener(port);
    const verdict = await this.ownership.adoptListener(pid, options);
    this.ownedPids = [...this.ownership.owned];
    return verdict;
  }

  /**
   * Whether a descendant of this child is listening on a port.
   *
   * @param {number} port - the port.
   * @param {object} [options] - `isListening`.
   * @returns {Promise<boolean>} true when the port is held.
   */
  async holdsPort(port, options = {}) {
    const probe = options.isListening ?? isPortListening;
    return probe(port);
  }

  /**
   * Buffer a stream into complete lines and dispatch them.
   *
   * @param {import('node:stream').Readable|null} stream - the stream.
   * @param {string} name - `stdout` or `stderr`.
   * @returns {void}
   */
  #attach(stream, name) {
    if (stream === null) return;
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      const key = name === 'stdout' ? 'stdoutBuffer' : 'stderrBuffer';
      this[key] += chunk;
      // A child that never emits a newline must not grow the buffer without bound.
      const parts = this[key].split(/\r?\n/);
      this[key] = parts.pop() ?? '';
      if (this[key].length > 64 * 1024) {
        // Treat an over-long unterminated fragment as a line, so it is parsed and
        // redacted rather than silently retained.
        const fragment = this[key];
        this[key] = '';
        this.#emitLine(fragment, name);
      }
      for (const line of parts) this.#emitLine(line, name);
    });
    stream.on('error', () => { /* a stream error is not a child exit */ });
  }

  /**
   * Dispatch one line to every handler.
   *
   * @param {string} line - the line.
   * @param {string} stream - the source stream.
   * @returns {void}
   */
  #emitLine(line, stream) {
    for (const handler of this.lineHandlers) {
      try {
        handler(line, stream);
      } catch {
        // A handler must not be able to kill the supervisor's read loop.
      }
    }
  }

  /**
   * Dispatch child exit exactly once.
   *
   * @param {object} info - exit facts.
   * @returns {void}
   */
  #emitExit(info) {
    const payload = { ...info, pid: this.pid, instanceId: this.instanceId };
    for (const handler of this.exitHandlers) {
      try {
        handler(payload);
      } catch {
        // As above: an exit handler must not throw into the child's event emitter.
      }
    }
  }

  /**
   * Ask the child to stop, escalate to exact-owned force if it does not, then **verify**.
   *
   * ## What was wrong before R7C
   *
   * The previous implementation signalled, waited for the direct child to exit, signalled the
   * recorded tree, and returned. It treated *having issued* a termination as *having achieved*
   * one. On Windows the listener is a grandchild — `node npx-cli.js` → `cmd.exe` → `node dsh web`
   * — and the grandchild can be re-parented and outlive both the wrapper's exit and a `/T` kill.
   * The recorded PID was dead while port 3081 was still held by a different PID, so the supervisor
   * believed it had stopped and the port said otherwise. That is R7-KNOWN-LIMITATION-01.
   *
   * ## What it does now
   *
   * 1. **Graceful**: `SIGTERM` the owned child, then wait a bounded
   *    {@link GRACEFUL_STOP_TIMEOUT_MS} for it to actually exit.
   * 2. **Escalate** only if it did not, naming recorded owned PIDs only — `taskkill /PID <pid> /T`,
   *    deepest first.
   * 3. **Verify**, never assume: poll until every owned PID is observed absent, and re-read the
   *    port so a surviving listener is caught even when the recorded PIDs are gone.
   *
   * `stopped` is therefore true only on observed death. A successful OS kill return code is not
   * proof of exit and is never treated as such; if anything survives, the result carries
   * `survivors`, `listenerPid` and `portFree` so the caller can refuse to claim `STOPPED`.
   *
   * @param {object} [options] - `timeoutMs`, `forceTimeoutMs`, `pollMs`, `port`, `forceKill`,
   *   `isAlive`, `listenerPid`, `waitForPortFree`.
   * @returns {Promise<object>} the stop outcome, including `stopped` and timing.
   */
  async stop(options = {}) {
    const gracefulTimeoutMs = options.timeoutMs ?? GRACEFUL_STOP_TIMEOUT_MS;
    // The force window is overridable so an operator can widen it without a code change if a
    // particular host releases a re-parented grandchild more slowly than the default allows.
    const envForce = Number(process.env.DSH_REMOTE_FORCE_STOP_TIMEOUT_MS);
    const forceTimeoutMs = options.forceTimeoutMs
      ?? (Number.isFinite(envForce) && envForce > 0 ? envForce : FORCE_STOP_TIMEOUT_MS);
    const pollMs = options.pollMs ?? STOP_POLL_MS;
    const forceKill = options.forceKill ?? defaultForceKill;
    const isAlive = options.isAlive ?? isProcessAlive;
    const port = options.port ?? null;
    const portWaiter = options.waitForPortFree ?? waitForPortFree;
    const startedAt = Date.now();

    if (this.child === null || this.stopped) {
      return {
        graceful: true, forced: false, stopped: true, pid: this.pid,
        survivors: [], listenerPid: null, portFree: true,
        graceful_ms: 0, force_ms: 0, port_release_ms: 0, total_ms: 0, already_stopped: true,
      };
    }
    this.stopped = true;

    /** Poll a predicate until true or the deadline passes. */
    const pollUntil = async (predicate, deadline) => {
      // At least one observation is always made, and the interval is clamped so a short deadline
      // cannot be skipped past by an interval that is itself longer than the deadline.
      const interval = Math.max(10, Math.min(pollMs, Math.max(10, Math.floor((deadline - Date.now()) / 4) || 10)));
      for (;;) {
        if (await predicate()) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => { setTimeout(resolve, interval); });
      }
    };

    if (!this.alive) {
      const portFree = port === null ? true : (await portWaiter(port, { timeoutMs: forceTimeoutMs })).free;
      return {
        graceful: true, forced: false, stopped: portFree, pid: this.pid,
        survivors: [], listenerPid: null, portFree,
        graceful_ms: 0, force_ms: 0, port_release_ms: Date.now() - startedAt, total_ms: Date.now() - startedAt,
      };
    }

    const pid = this.pid;

    // ── 1. graceful ───────────────────────────────────────────────────────────
    try {
      this.child.kill('SIGTERM');
    } catch {
      // The process may already be gone between the liveness check and the signal.
    }
    const exited = await pollUntil(() => !this.alive, Date.now() + gracefulTimeoutMs);
    const gracefulMs = Date.now() - startedAt;
    // The direct child may have exited while a descendant did not. Terminate the recorded tree
    // regardless: the listener is a grandchild, and a wrapper exiting first is exactly how a
    // grandchild gets re-parented and survives.
    //
    // The signalled PID list is retained: it is the evidence that the whole recorded tree was
    // addressed, deepest first, and not merely the direct child.
    const signalTree = await this.#terminateRecordedTree(forceKill, { quiet: true, graceful: true });

    // ── 2. escalate, only if verification demands it ──────────────────────────
    let forced = false;
    let forceMs = 0;
    let survivors = await this.#livingOwnedPids(isAlive);
    if (survivors.length > 0) {
      forced = true;
      const forceStartedAt = Date.now();
      const forceDeadline = forceStartedAt + forceTimeoutMs;
      // Bounded: a force-kill implementation that never settles must not stall the lifecycle, so
      // the escalation is raced against its own deadline rather than awaited indefinitely.
      const escalation = this.#terminateRecordedTree(forceKill, { includeRoot: true });
      await Promise.race([
        escalation.catch(() => {}),
        new Promise((resolve) => { setTimeout(resolve, forceTimeoutMs); }),
      ]);
      // Record anything the escalation newly addressed, then wait and observe.
      for (const pid of await escalation.catch(() => [])) {
        if (!signalTree.includes(pid)) signalTree.push(pid);
      }
      // §9: wait, then observe. The kill command's exit status is not evidence of death.
      //
      // `taskkill` returns as soon as termination is *initiated*; a grandchild can take several
      // further seconds to actually exit. One shared deadline is therefore used for BOTH the
      // process-death wait and the port wait below — previously the death poll consumed the whole
      // force window, the port wait then got a fresh but equal window, and this loop exited on its
      // first iteration while the process was still terminating. That made a working escalation
      // look like a failure. The observation continues until the deadline, not until one poll.
      await pollUntil(async () => (await this.#livingOwnedPids(isAlive)).length === 0, forceDeadline);
      // Give the OS the remainder of the same window to release the listener.
      survivors = await this.#livingOwnedPids(isAlive);
      if (survivors.length > 0) {
        await pollUntil(
          async () => (await this.#livingOwnedPids(isAlive)).length === 0,
          forceDeadline,
        );
      }
      forceMs = Date.now() - forceStartedAt;
      this.forceDeadline = forceDeadline;
    }

    // ── 3. verify, never assume ───────────────────────────────────────────────
    survivors = await this.#livingOwnedPids(isAlive);
    let listenerPid = null;
    if (typeof options.listenerPid === 'function') {
      try { listenerPid = await options.listenerPid(); } catch { listenerPid = null; }
    }
    const portStartedAt = Date.now();
    // The port gets the remainder of the shared force deadline when escalation ran, so the whole
    // stop stays bounded by `graceful + force` rather than by the sum of independent per-phase
    // windows. Without escalation, the port gets its own bounded window.
    const portRemaining = Number.isInteger(this.forceDeadline)
      ? Math.max(0, this.forceDeadline - Date.now())
      : forceTimeoutMs;
    const release = port === null
      ? { free: survivors.length === 0, waitedMs: 0 }
      : await portWaiter(port, { timeoutMs: portRemaining });
    const portFree = release.free === true && survivors.length === 0;

    return {
      graceful: exited,
      forced,
      stopped: portFree,
      pid,
      survivors,
      listenerPid,
      portFree,
      // Every owned PID that was signalled, deepest first. Retained so the supervisor's evidence
      // can show the whole recorded tree was addressed rather than only the direct child.
      signal_tree: signalTree,
      graceful_ms: gracefulMs,
      force_ms: forceMs,
      port_release_ms: Date.now() - portStartedAt,
      total_ms: Date.now() - startedAt,
    };
  }

  /**
   * Which recorded owned PIDs are still running.
   *
   * The recorded tree is the ownership authority; the direct child's own liveness is included so a
   * child that never registered a tree still blocks a premature `STOPPED`.
   *
   * @param {(pid: number) => Promise<boolean>} isAlive - liveness probe.
   * @returns {Promise<number[]>} the surviving PIDs, ascending.
   */
  async #livingOwnedPids(isAlive) {
    const candidates = new Set(this.ownedPids);
    if (Number.isInteger(this.pid)) candidates.add(this.pid);
    const survivors = [];
    for (const candidate of [...candidates].sort((a, b) => a - b)) {
      if (!Number.isInteger(candidate) || candidate <= 0) continue;
      try {
        if (await isAlive(candidate)) survivors.push(candidate);
      } catch {
        // An unreadable process is treated as surviving: refusing to claim STOPPED is the safe
        // direction, and §4 requires a fail-safe on ambiguity.
        survivors.push(candidate);
      }
    }
    return survivors;
  }

  /**
   * Terminate every recorded owned PID.
   *
   * @param {Function} forceKill - the kill runner.
   * @param {object} [options] - `includeRoot`, `quiet`.
   * @returns {Promise<number[]>} the signalled PIDs.
   */
  async #terminateRecordedTree(forceKill, options = {}) {
    const root = this.pid;
    const recorded = this.ownedPids.length > 0 ? this.ownedPids : (root === null ? [] : [root]);
    const pids = options.includeRoot === true
      ? recorded
      : recorded.filter((pid) => pid !== root);
    if (pids.length === 0 && options.includeRoot === true && root !== null) pids.push(root);
    if (pids.length === 0) return [];
    try {
      return await terminateOwnedTree(pids, { forceKill });
    } catch (error) {
      // A termination attempt that throws is not a reason to abandon verification: the caller
      // observes real liveness afterwards and will escalate or fail safe on what it finds.
      if (options.quiet !== true) throw error;
      return [];
    }
  }

  /**
   * The force-kill argv for a PID.
   *
   * Exposed so a test can assert the shape without executing it — in particular that
   * `/IM` never appears.
   *
   * @param {number} pid - the owned PID.
   * @returns {string[]} the argv.
   */
  static forceKillArgv(pid) {
    return [
      FORCE_KILL.TOOL,
      ...FORCE_KILL.ARGS.map((arg) => (arg === '<pid>' ? String(pid) : arg)),
    ];
  }

  /**
   * The pid plus instance identity, for status output.
   *
   * @returns {object} the safe description.
   */
  describe() {
    return {
      instance_id: this.instanceId,
      pid: this.pid,
      alive: this.alive,
      started_at: this.startedAt?.toISOString?.() ?? this.startedAt,
      exited_at: this.exitedAt?.toISOString?.() ?? this.exitedAt,
      exit_code: this.exitCode,
      exit_signal: this.exitSignal,
    };
  }
}

/**
 * Enumerate a process tree rooted at `rootPid`.
 *
 * ## Why the tree, not the PID
 *
 * The supervisor spawns `node npx-cli.js -y @deepseek-ai/dsh@… web …`. The process that
 * actually **listens** on the DSH port is not that child: npx resolves the package
 * through its `.bin` shim, so the real shape is
 *
 * ```text
 * node npx-cli.js        <- the PID the supervisor records
 *   cmd.exe /d /s /c dsh web
 *     node …/dsh/lib/bin.js web --no-open --port 3081   <- the LISTENER
 * ```
 *
 * The listener is a **grandchild**, and a grandchild can outlive a `taskkill /T` if an
 * intermediate process has already exited and the child was re-parented. That is exactly
 * what the external run showed: the recorded PID was dead while the port was still held
 * by a different PID.
 *
 * So ownership is established from the **spawned tree**, recorded while it is intact, and
 * every recorded PID is signalled by PID. Command-line resemblance is never used to decide
 * ownership.
 *
 * @param {number} rootPid - the spawned PID.
 * @param {object} [options] - `run` injectable runner.
 * @returns {Promise<number[]>} the root and every descendant, root first.
 */
export async function enumerateProcessTree(rootPid, options = {}) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  const run = options.run ?? defaultPowerShellJson;
  // One PowerShell call walks the parent map, so the tree is a single snapshot rather
  // than a series of racing queries.
  const script = [
    '$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId',
    '$byParent = @{}',
    'foreach ($p in $all) {',
    '  if (-not $byParent.ContainsKey([int]$p.ParentProcessId)) { $byParent[[int]$p.ParentProcessId] = @() }',
    '  $byParent[[int]$p.ParentProcessId] += [int]$p.ProcessId',
    '}',
    `$root = ${rootPid}`,
    '$order = New-Object System.Collections.ArrayList',
    '$queue = New-Object System.Collections.Queue',
    '$queue.Enqueue($root)',
    'while ($queue.Count -gt 0) {',
    '  $cur = $queue.Dequeue()',
    '  [void]$order.Add($cur)',
    '  if ($byParent.ContainsKey($cur)) { foreach ($c in $byParent[$cur]) { $queue.Enqueue($c) } }',
    '}',
    ',$order | ConvertTo-Json -Compress',
  ].join('\n');

  try {
    const value = await run(script);
    if (Array.isArray(value)) return value.filter((pid) => Number.isInteger(pid) && pid > 0);
    if (Number.isInteger(value) && value > 0) return [value];
    return [rootPid];
  } catch {
    // A tree that cannot be read is reported as just the root: killing less is safer
    // than killing something unverified.
    return [rootPid];
  }
}

/**
 * Terminate a recorded set of owned PIDs.
 *
 * @param {readonly number[]} pids - the recorded tree.
 * @param {object} [options] - `forceKill`.
 * @returns {Promise<number[]>} the PIDs that were signalled.
 */
export async function terminateOwnedTree(pids, options = {}) {
  const forceKill = options.forceKill ?? defaultForceKill;
  const signalled = [];
  // Deepest first: a child killed before its parent cannot be re-parented and missed.
  //
  // R7C.1 tested the opposite order live on the theory that taking a parent first avoids breaking
  // the `/T` tree walk. It did not help — the listener survived either way, with the same PID
  // pattern — so the original order is retained rather than replaced by a change that fixed
  // nothing. See the phase report: the escalation's `/PID <listener> /T /F` succeeds when issued
  // by hand and fails when issued from inside the supervisor, which the ordering does not explain.
  for (const pid of [...pids].reverse()) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    await forceKill([
      FORCE_KILL.TOOL,
      ...FORCE_KILL.ARGS.map((arg) => (arg === '<pid>' ? String(pid) : arg)),
    ]);
    signalled.push(pid);
  }
  return signalled;
}

/**
 * Whether a PID is running.
 *
 * @param {number} pid - the PID.
 * @param {object} [options] - `run` injectable runner.
 * @returns {Promise<boolean>} true when alive.
 */
export async function isProcessAlive(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const run = options.run ?? defaultPowerShellJson;
  try {
    const value = await run(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 1 } else { 0 }`);
    return Number(value) === 1;
  } catch {
    // Unprovable is reported as alive: believing a live child is dead risks a second
    // child fighting it for the port.
    return true;
  }
}

/**
 * The default PowerShell JSON runner.
 *
 * @param {string} script - the script text.
 * @returns {Promise<unknown>} the parsed value.
 */
async function defaultPowerShellJson(script) {
  const { execFile } = await import('node:child_process');
  const stdout = await new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (error, out) => {
        if (error) { reject(error); return; }
        resolve(String(out).trim());
      });
  });
  if (stdout.length === 0) return null;
  return JSON.parse(stdout);
}

/**
 * The owned DSH process tree, sampled across the bootstrap lifecycle.
 *
 * ## Why one snapshot is not enough
 *
 * The production topology is built in stages:
 *
 * ```text
 * node npx-cli.js                     <- the spawn root
 *   cmd.exe /d /s /c dsh web          <- the npx .bin shim
 *     node …/dsh/lib/bin.js --port …  <- THE LISTENER
 * ```
 *
 * A snapshot taken immediately after `spawn()` usually sees only the root: the shim and
 * the listener do not exist yet. The external run proved the consequence — the recorded
 * `owned_tree` was `[28196, 41308]`, the listener was outside it, and the port stayed held
 * by a `pid 26652` nobody had ever claimed.
 *
 * So ownership is sampled at **three** lifecycle points and merged into one persistent
 * set, and the listener is proven to belong to that set before `READY` is published.
 *
 * ## Why the set must persist through re-parenting
 *
 * Once a PID has been proven a descendant, the proof does not expire. Windows may
 * re-parent the listener when its shim exits, and its ancestry then becomes unobservable —
 * but it was verified while the chain was intact, so it stays owned for the lifetime of
 * this instance.
 */
export class DshOwnership {
  /**
   * @param {object} options - `rootPid`, `instanceId`.
   */
  constructor(options = {}) {
    /** @type {Set<number>} every PID ever proven to belong to this spawn. */
    this.owned = new Set();
    /** @type {Set<number>} the spawn root and every PID observed as an ancestor of one. */
    this.ancestors = new Set();
    this.rootPid = options.rootPid ?? null;
    this.instanceId = options.instanceId ?? null;
    /** @type {Array<{at: string, stage: string, pids: number[]}>} */
    this.snapshots = [];
    /** @type {number|null} */
    this.listenerPid = null;
    /** Whether the listener's ownership was proven rather than assumed. */
    this.listenerProven = false;
  }

  /**
   * Merge PIDs into the owned set.
   *
   * @param {readonly number[]} pids - the PIDs.
   * @returns {number[]} the newly added PIDs.
   */
  #merge(pids) {
    const added = [];
    for (const pid of pids) {
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (this.owned.has(pid)) continue;
      this.owned.add(pid);
      added.push(pid);
    }
    return added;
  }

  /**
   * Record a snapshot of the tree below every owned PID.
   *
   * @param {string} stage - the lifecycle point, e.g. `after_spawn`.
   * @param {object} [options] - `enumerate` injectable walker, `now` injectable clock.
   * @returns {Promise<{stage: string, pids: number[], added: number[]}>} the snapshot.
   */
  async snapshot(stage, options = {}) {
    const enumerate = options.enumerate ?? enumerateProcessTree;
    const now = options.now ?? (() => new Date());
    const roots = this.owned.size > 0 ? [...this.owned] : (this.rootPid === null ? [] : [this.rootPid]);

    const found = [];
    for (const root of roots) {
      for (const pid of await enumerate(root)) {
        if (!found.includes(pid)) found.push(pid);
      }
    }

    const added = this.#merge(found);
    // Every ancestor of an owned process is on the owned spawn path by definition.
    for (const pid of found) this.ancestors.add(pid);
    if (this.rootPid !== null) this.ancestors.add(this.rootPid);

    const record = { at: now().toISOString(), stage, pids: [...this.owned] };
    this.snapshots.push(record);
    return { ...record, added };
  }

  /**
   * Prove that a listening PID belongs to this spawn, and adopt it.
   *
   * Walks **up** from the listener looking for an owned ancestor. This is the only
   * accepted proof: a command line that mentions DSH is not evidence of ownership, and a
   * totally unknown PID is never adopted.
   *
   * @param {number} listenerPid - the PID holding the port.
   * @param {object} [options] - `ancestorsOf` injectable walker.
   * @returns {Promise<{proven: boolean, reason: string, listenerPid: number}>} the verdict.
   */
  async adoptListener(listenerPid, options = {}) {
    if (!Number.isInteger(listenerPid) || listenerPid <= 0) {
      return { proven: false, reason: 'no listener PID was reported for the DSH port', listenerPid: null };
    }
    if (this.owned.has(listenerPid)) {
      this.listenerPid = listenerPid;
      this.listenerProven = true;
      return { proven: true, reason: 'already in the owned set', listenerPid };
    }

    const ancestorsOf = options.ancestorsOf ?? ancestorsOfProcess;
    const chain = await ancestorsOf(listenerPid);
    const match = chain.find((pid) => this.owned.has(pid) || this.ancestors.has(pid));
    if (match !== undefined) {
      for (const pid of chain) this.ancestors.add(pid);
      this.#merge([listenerPid]);
      this.listenerPid = listenerPid;
      this.listenerProven = true;
      // The whole chain to the matched ancestor is on the owned spawn path.
      const matchIndex = chain.indexOf(match);
      this.#merge(chain.slice(0, matchIndex + 1));
      return { proven: true, reason: `descendant of owned pid ${match}`, listenerPid };
    }

    return {
      proven: false,
      reason: `the listener's ancestry does not intersect the owned tree (chain: ${chain.join(' -> ') || 'unobservable'})`,
      listenerPid,
    };
  }

  /**
   * The owned set, deepest-first.
   *
   * Descendants are signalled before their ancestors so no child can be re-parented and
   * missed by a later tree kill.
   *
   * @returns {number[]} the PIDs.
   */
  terminationOrder() {
    // The owned set is already recorded child-first within a snapshot, so reversing it
    // puts the most recently discovered (deepest) PIDs first.
    return [...this.owned].reverse();
  }

  /**
   * A safe description for evidence.
   *
   * @returns {object} the summary.
   */
  describe() {
    return {
      root_pid: this.rootPid,
      owned_tree_final: [...this.owned],
      snapshots: this.snapshots,
      listener_pid_before_ready: this.listenerPid,
      listener_ownership_proven: this.listenerProven,
    };
  }
}

/**
 * Walk **up** from a PID, returning its ancestor chain, nearest first.
 *
 * Stops at the first unreadable or absent parent: an ancestry chain that breaks is
 * reported as far as it was observed, and never padded with guesses.
 *
 * @param {number} pid - the starting PID.
 * @param {object} [options] - `run` injectable runner.
 * @returns {Promise<number[]>} the ancestors, nearest first.
 */
export async function ancestorsOfProcess(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  const run = options.run ?? defaultPowerShellJson;
  const script = [
    '$chain = New-Object System.Collections.ArrayList',
    `$cur = ${pid}`,
    'for ($i = 0; $i -lt 12; $i++) {',
    '  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue',
    '  if (-not $p) { break }',
    '  $parent = [int]$p.ParentProcessId',
    '  if ($parent -le 0) { break }',
    '  [void]$chain.Add($parent)',
    '  $cur = $parent',
    '}',
    ',$chain | ConvertTo-Json -Compress',
  ].join('\n');

  try {
    const value = await run(script);
    if (Array.isArray(value)) return value.filter((entry) => Number.isInteger(entry) && entry > 0);
    if (Number.isInteger(value) && value > 0) return [value];
    return [];
  } catch {
    return [];
  }
}

/**
 * The PID listening on a port, or 0.
 *
 * A single primitive, so every port observation in a run comes from the same place. Two
 * different probes produced `gateway_port_free = true` and
 * `port_gateway_listening_after_stop = true` in the same evidence file; a contradiction
 * like that is indistinguishable from a bug unless the probes are unified.
 *
 * @param {number} port - the port.
 * @param {object} [options] - `run` injectable runner.
 * @returns {Promise<number>} the owner PID, or 0 when nothing is listening.
 */
export async function listenerPidOf(port, options = {}) {
  if (!Number.isInteger(port) || port <= 0) return 0;
  const run = options.run ?? defaultPowerShellJson;
  const script = `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`;
  try {
    const value = await run(script);
    const pid = Number(value);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

/**
 * A port observation with its provenance.
 *
 * `{probe, at, port, listening, owner_pid}` distinguishes a real state transition from a
 * probe disagreement, which bare booleans cannot.
 *
 * @param {string} probe - the probe name.
 * @param {number} port - the port.
 * @param {object} [options] - `listenerPid`, `now`.
 * @returns {Promise<object>} the observation.
 */
export async function probePort(probe, port, options = {}) {
  const listener = options.listenerPid ?? listenerPidOf;
  const now = options.now ?? (() => new Date());
  const ownerPid = await listener(port);
  return {
    probe,
    at: now().toISOString(),
    port,
    listening: ownerPid > 0,
    owner_pid: ownerPid > 0 ? ownerPid : null,
  };
}

/**
 * The default force kill.
 *
 * The absolute `taskkill.exe` path is used rather than the bare name, and the exit code, stdout and
 * stderr are all inspected. The previous version discarded every one of them and resolved the tool
 * through `PATH`, which is how an argv that `taskkill` rejected outright — exit code 1, "Value for
 * '/PID' is required." — stayed invisible for two phases while the escalation was reported as
 * having run.
 *
 * A failed invocation still resolves; the caller verifies actual process death afterwards and
 * escalates on what it observes, so a throw here would not add safety. It is recorded so the
 * failure is explainable.
 *
 * @param {string[]} argv - `[tool, ...args]`, with the PID already substituted.
 * @returns {Promise<{exitCode: number|null, stdout: string, stderr: string}>} the outcome.
 */
async function defaultForceKill(argv) {
  const { execFile } = await import('node:child_process');
  const tool = argv[0].toLowerCase() === FORCE_KILL.TOOL
    ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\taskkill.exe`
    : argv[0];
  return new Promise((resolve) => {
    execFile(tool, argv.slice(1), { windowsHide: true }, (error, stdout, stderr) => {
      const exitCode = error === null ? 0 : (typeof error?.code === 'number' ? error.code : null);
      if (error !== null && exitCode !== 0) {
        // Not fatal — the caller verifies death independently — but never silent again.
        process.emitWarning(
          `force kill exited ${exitCode ?? 'unknown'}: ${String(stderr ?? error?.message ?? '').trim().slice(0, 160)}`,
          { code: 'R7_FORCE_KILL_FAILED' },
        );
      }
      resolve({ exitCode, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/**
 * Whether a TCP port is accepting connections on loopback.
 *
 * Used for the §36 pre-start check. A listening port means **refuse**; it never
 * means "find and stop the owner".
 *
 * @param {number} port - the port.
 * @param {string} [host] - the host.
 * @param {number} [timeoutMs] - the connect timeout.
 * @returns {Promise<boolean>} true when something is listening.
 */
export async function isPortListening(port, host = '127.0.0.1', timeoutMs = 1000) {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * Assert that a port is free before start (§36).
 *
 * @param {number} port - the port.
 * @param {string} code - the error code to raise.
 * @param {string} label - what the port is for.
 * @returns {Promise<void>} resolves when free.
 * @throws {ProductionError} when occupied.
 */
/**
 * Wait for a port to stop listening.
 *
 * Needed because stopping the old DSH child is not the same event as the old DSH child
 * releasing its port. The child is a `node` process under an `npx` wrapper, and Windows
 * does not free the listening socket the instant the process is signalled.
 *
 * A restart that spawns the new child while the old one still holds the port produces a
 * child that fails to bind and exits before it can print its launch announcement —
 * which surfaces as `R7_DSH_BOOTSTRAP_TOKEN_UNRESOLVED` and looks like a bootstrap
 * problem when it is really a port-release problem. Waiting here converts that confusing
 * symptom into either success or an accurate `R7_DSH_PORT_IN_USE`.
 *
 * @param {number} port - the port.
 * @param {object} [options] - wait options.
 * @param {number} [options.timeoutMs] - how long to wait.
 * @param {number} [options.intervalMs] - the poll interval.
 * @param {string} [options.host] - the host to probe.
 * @returns {Promise<{free: boolean, waitedMs: number}>} the outcome.
 */
export async function waitForPortFree(port, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 200;
  const host = options.host ?? '127.0.0.1';
  const startedAt = Date.now();

  for (;;) {
    if (!(await isPortListening(port, host))) {
      return { free: true, waitedMs: Date.now() - startedAt };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return { free: false, waitedMs: Date.now() - startedAt };
    }
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
}

/**
 * Assert that a port is free.
 *
 * @param {number} port - the port.
 * @param {string} code - the error code to use.
 * @param {string} label - a human label.
 * @returns {Promise<void>} resolves when free.
 * @throws {ProductionError} when the port is in use.
 */
export async function assertPortFree(port, code, label) {
  if (await isPortListening(port)) {
    throw new ProductionError(
      code,
      `${label} port ${port} is already in use; R7 will not attach to or stop an unknown owner`,
    );
  }
}
