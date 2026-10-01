/**
 * Production supervisor — Phase R7 §2, §19, §20, §22, §23, §28, §31.
 *
 * One Node process owns the whole production stack: it holds the Phone credential,
 * spawns and owns the DSH child, exchanges the launch token for a cookie **in
 * memory**, constructs the real adapter, opens the R5 persistence root, and runs the
 * Gateway on loopback. DSH is a child, never a peer.
 *
 * The ordering constraints all come from the same principle — **do not claim to be
 * ready unless you are**:
 *
 * * the credential and its ACL are validated before the credential is used (§8);
 * * the DSH child is alive and its cookie is verified before the adapter exists (§17);
 * * persistence recovers from durable state before the port opens (§28);
 * * `READY` requires every axis, not just a bound port (§31).
 *
 * Seams are injected (`spawnDsh`, `createGateway`, `createAdapter`) so Gate A can
 * exercise every path with a synthetic child, and Gate B substitutes the real ones
 * without touching this file.
 */

import crypto from 'node:crypto';

import {
  R7_ERROR,
  ProductionError,
  SUPERVISOR_STATE,
  describeProductionConfig,
} from './production-config.mjs';
import { CredentialStore, assertNoSecrets } from './credential-store.mjs';
import { ControlChannel } from './control-channel.mjs';
import { CookieAuthProvider, LaunchTokenParser, exchangeLaunchToken, verifyCookie } from './dsh-bootstrap.mjs';
import { DshProcess, assertPortFree, isProcessAlive, listenerPidOf, waitForPortFree } from './dsh-process.mjs';
import { ProductionLogs } from './logger.mjs';
import { RuntimeStatus } from './runtime-status.mjs';

/** How often the control channel is polled. */
export const CONTROL_POLL_MS = 500;

/**
 * The production supervisor.
 */
export class Supervisor {
  /**
   * @param {object} options - supervisor options.
   * @param {object} options.config - the resolved production config.
   * @param {object} [options.seams] - injected collaborators.
   * @param {() => Date} [options.clock] - injectable clock.
   */
  constructor(options) {
    if (options?.config === undefined) throw new TypeError('Supervisor requires a config');
    this.config = options.config;
    this.clock = options.clock ?? (() => new Date());
    this.seams = options.seams ?? {};
    this.instanceId = options.instanceId ?? crypto.randomUUID();

    this.credential = options.credential ?? new CredentialStore({
      paths: this.config.paths,
      harden: this.seams.hardenAcl,
      verify: this.seams.verifyAcl,
      clock: () => this.clock().toISOString(),
    });

    this.logs = options.logs ?? new ProductionLogs({
      paths: this.config.paths,
      maxBytes: this.config.logMaxBytes,
      backups: this.config.logBackups,
      secrets: [],
      clock: this.clock,
    });

    this.status = options.status ?? new RuntimeStatus({
      paths: this.config.paths,
      instanceId: this.instanceId,
      clock: this.clock,
    });

    this.control = options.control ?? new ControlChannel({
      paths: this.config.paths,
      instanceId: this.instanceId,
      clock: this.clock,
    });

    /** @type {DshProcess|null} */
    this.dsh = null;
    /** @type {CookieAuthProvider} */
    this.authProvider = new CookieAuthProvider();
    /** @type {object|null} */
    this.gateway = null;
    /** @type {object|null} */
    this.adapter = null;
    this.bootstrap = null;
    this.recovery = null;
    this.consecutiveFailures = 0;
    this.lastStableAt = null;
    this.timers = new Set();
    /** Teardown for the current child's exit subscription. */
    this.exitUnsubscribe = null;
    /** Teardown for the current launch-token line subscription. */
    this.lineUnsubscribe = null;
    this.stopping = false;
    this.exitCode = null;
  }

  /**
   * The launch-token parser, with the timeout the config specifies.
   *
   * @returns {LaunchTokenParser} a fresh parser.
   */
  #newParser() {
    return this.seams.createParser?.() ?? new LaunchTokenParser({ timeoutMs: this.config.startTimeoutMs });
  }

  /**
   * Start the whole stack.
   *
   * @param {object} [options] - start options.
   * @param {boolean} [options.skipPortCheck] - for a restart, where we just stopped.
   * @returns {Promise<{state: string, instanceId: string, gateway: object|null}>} the outcome.
   */
  async start(options = {}) {
    // §19: STARTING first, so a crash during the early phase is still observable.
    this.status.transition(SUPERVISOR_STATE.STARTING);
    this.logs.supervisor.event('supervisor_start', {
      instance_id: this.instanceId,
      ...describeProductionConfig(this.config),
    });

    try {
      // §36: refuse rather than attach. Checked before anything is created, so a
      // port conflict leaves no partial state behind.
      //
      // The DSH port is checked here as well as the Gateway port. Checking it only at
      // spawn time meant an occupied DSH port surfaced *after* the credential and status
      // files were touched, and its error was the bootstrap's rather than the port's.
      // Failing here keeps the refusal cheap and the cause obvious.
      if (options.skipPortCheck !== true) {
        await assertPortFree(this.config.gatewayPort, R7_ERROR.PORT_IN_USE, 'Gateway');
        await assertPortFree(this.config.dshPort, R7_ERROR.DSH_PORT_IN_USE, 'DSH');
      }

      // §28: the credential is loaded and its ACL verified before it is used.
      const ensured = await this.credential.ensure();
      if (ensured.created) {
        this.logs.supervisor.event('credential_created', { generation_id: ensured.generationId });
      } else {
        this.logs.supervisor.event('credential_loaded', { generation_id: ensured.generationId });
      }

      // §23/§31: DSH first, Gateway second. A Gateway that is up while DSH is not
      // would report itself ready and then fail every request.
      this.status.transition(SUPERVISOR_STATE.BOOTSTRAPPING_DSH, {
        started_at: this.clock().toISOString(),
      });
      await this.bootstrapDsh();

      this.status.transition(SUPERVISOR_STATE.STARTING_GATEWAY);
      await this.startGateway();

      // ── Snapshot C and the listener ownership proof, before READY ────────────
      //
      // `READY` claims the stack is serving, which means a process is listening on the DSH
      // port. This supervisor must be able to say **whose** process that is — otherwise it
      // cannot honestly claim readiness, and it will not be able to stop it either.
      //
      // A PID whose command line merely mentions DSH is not accepted. Ownership is proven
      // either by the listener already being in the owned set, or by an ancestry chain that
      // intersects it.
      if (typeof this.dsh.snapshotOwnership === 'function') {
        await this.dsh.snapshotOwnership('before_ready', this.#ownershipOptions());
      }
      if (typeof this.dsh.adoptListener === 'function') {
        const verdict = await this.dsh.adoptListener(this.config.dshPort, {
          ...this.#ownershipOptions(),
          listenerPid: this.seams.listenerPid
            ?? ((port) => listenerPidOf(port, this.seams.portOwnerRun === undefined ? {} : { run: this.seams.portOwnerRun })),
        });
        this.listenerOwnership = verdict;
        this.logs.supervisor.event('dsh_listener_ownership', {
          proven: verdict.proven,
          listener_pid: verdict.listenerPid,
          reason: verdict.reason,
          owned: this.dsh.ownedPids.length,
        });
        if (verdict.proven !== true) {
          throw new ProductionError(
            R7_ERROR.DSH_LISTENER_OWNERSHIP_UNPROVEN,
            `the process listening on DSH port ${this.config.dshPort} was not proven to belong to this supervisor: ${verdict.reason}`,
          );
        }
      }

      this.status.transition(SUPERVISOR_STATE.READY, {
        dsh_pid: this.dsh?.pid ?? null,
        dsh: { host: this.config.dshHost, port: this.config.dshPort, version: this.config.dshVersion },
        gateway: { host: this.config.gatewayHost, port: this.config.gatewayPort },
      });
      this.logs.supervisor.event('gateway_ready', {
        gateway: `${this.config.gatewayHost}:${this.config.gatewayPort}`,
      });
      this.lastStableAt = this.clock();

      return {
        state: this.status.state,
        instanceId: this.instanceId,
        gateway: { host: this.config.gatewayHost, port: this.config.gatewayPort },
      };
    } catch (error) {
      const code = error?.code ?? R7_ERROR.PRODUCTION_SMOKE_FAILED;
      await this.#fail(code, error?.message);
      throw error;
    }
  }

  /**
   * Drop this supervisor's subscriptions to the current child.
   *
   * Called before every spawn, so exactly one exit handler is ever live. Without it a
   * restart chain multiplies the failure count, because each child's exit notifies
   * every handler registered so far.
   *
   * @returns {void}
   */
  #releaseChildSubscriptions() {
    if (typeof this.exitUnsubscribe === 'function') {
      try { this.exitUnsubscribe(); } catch { /* already gone */ }
    }
    this.exitUnsubscribe = null;
    if (typeof this.lineUnsubscribe === 'function') {
      try { this.lineUnsubscribe(); } catch { /* already gone */ }
    }
    this.lineUnsubscribe = null;
  }

  /**
   * Spawn the owned DSH child, parse its launch token, and obtain a cookie.
   *
   * @returns {Promise<void>} resolves when the cookie is verified.
   * @throws {ProductionError} on any bootstrap failure.
   */
  async bootstrapDsh() {
    const spawnDsh = this.seams.spawnDsh ?? ((config) => new DshProcess({ config }));

    // A previous child's subscriptions must be dropped before a new one exists.
    //
    // Without this, every restart registers another `onExit` on a *different* child
    // while the old subscriptions remain live on the old emitter — and because each
    // restart spawns a fresh child, one exit per child fires N handlers, multiplying
    // the failure counter and driving the stack to FAILED after a single real crash.
    this.#releaseChildSubscriptions();

    // §14/§36: never spawn onto a port the previous child may still hold.
    //
    // A restart stops the old child and immediately spawns a new one. On Windows the old
    // child — a `node` process under an `npx` wrapper — can still hold its listening
    // socket for a short while after it is signalled. The new child then fails to bind
    // and exits before printing its launch announcement, which surfaces as
    // `R7_DSH_BOOTSTRAP_TOKEN_UNRESOLVED`. That is a misleading symptom: the bootstrap
    // was never the problem, the port was.
    //
    // The wait is bounded, and a port still held afterwards is a refusal
    // (`R7_DSH_PORT_IN_USE`) rather than an attach or a kill — the owner is unknown here.
    const portReleased = await this.#waitPortFree(this.config.dshPort, { timeoutMs: 15_000 });
    this.lastPortRelease = portReleased;
    if (portReleased.free !== true) {
      this.logs.supervisor.event('dsh_port_not_released', {
        port: this.config.dshPort,
        waited_ms: portReleased.waitedMs,
      });
      throw new ProductionError(
        R7_ERROR.DSH_PORT_IN_USE,
        `DSH port ${this.config.dshPort} was still in use ${portReleased.waitedMs}ms after the previous child stopped; `
        + 'refusing to spawn a new child onto it',
      );
    }
    this.logs.supervisor.event('dsh_port_released', {
      port: this.config.dshPort,
      waited_ms: portReleased.waitedMs,
    });

    this.dsh = spawnDsh(this.config);

    // §17: a new child invalidates the previous cookie immediately, so it is dropped
    // before the new child can possibly be used.
    this.authProvider.clear();

    const parser = this.#newParser();
    // A child exit during bootstrap is a bootstrap failure, not a normal shutdown.
    let exitedDuringBootstrap = false;
    this.exitUnsubscribe = this.dsh.onExit((info) => {
      this.authProvider.clear();
      if (!this.stopping && this.status.state !== SUPERVISOR_STATE.READY) {
        exitedDuringBootstrap = true;
        return;
      }
      if (!this.stopping) void this.#onUnexpectedExit(info);
    });

    // Subscribe before spawn. DSH can print its launch URL while the first ownership
    // snapshot is running; missing that one line leaves a healthy listener behind
    // while bootstrap eventually times out.
    const tokenPromise = this.#awaitLaunchToken(parser, () => exitedDuringBootstrap);
    const spawned = this.dsh.start();
    this.logs.supervisor.event('dsh_spawned', { pid: spawned.pid, instance_id: spawned.instanceId });

    // Ownership is sampled at three lifecycle points, not once. The shim and the listener
    // do not exist at spawn time: a single snapshot recorded only the root, and the real
    // listener ended up outside the owned tree, holding the port after stop.
    //
    // Snapshot A — immediately after spawn.
    if (typeof this.dsh.snapshotOwnership === 'function') {
      await this.dsh.snapshotOwnership('after_spawn', this.#ownershipOptions());
      this.logs.supervisor.event('dsh_tree_recorded', {
        stage: 'after_spawn',
        root_pid: spawned.pid,
        owned: this.dsh.ownedPids.length,
      });
    }

    const token = await tokenPromise;

    // Snapshot B — the announcement proves the DSH process exists, so the shim and the
    // listener are now present and can be recorded.
    if (typeof this.dsh.snapshotOwnership === 'function') {
      await this.dsh.snapshotOwnership('after_launch_announcement', this.#ownershipOptions());
      this.logs.supervisor.event('dsh_tree_recorded', {
        stage: 'after_launch_announcement',
        owned: this.dsh.ownedPids.length,
      });
    }
    // §16: memory only. Register it for redaction before any further logging, so no
    // subsequent line can leak it.
    this.logs.addSecret(token);
    this.bootstrap = { launch_token_length: token.length, observed_at: this.clock().toISOString() };
    this.logs.supervisor.event('dsh_bootstrap_token_observed', { length: token.length });

    const authority = `${this.config.dshHost}:${this.config.dshPort}`;
    const exchanged = await exchangeLaunchToken({
      launchToken: token,
      authority,
      host: this.config.dshHost,
      port: this.config.dshPort,
      ...(this.seams.exchangeLaunchToken === undefined ? {} : { request: this.seams.exchangeLaunchToken }),
    });

    this.authProvider = new CookieAuthProvider({
      cookie: exchanged.cookie,
      cookieName: exchanged.cookieName,
      authority,
      obtainedAt: this.clock().toISOString(),
    });
    this.logs.addSecret(exchanged.cookie);
    this.logs.supervisor.event('dsh_auth_cookie_obtained', { cookie_name: exchanged.cookieName });

    // §17: verify by use before anything is built on it.
    await verifyCookie({
      cookie: exchanged.cookie,
      cookieName: exchanged.cookieName,
      authority,
      host: this.config.dshHost,
      port: this.config.dshPort,
      ...(this.seams.verifyCookie === undefined ? {} : { request: this.seams.verifyCookie }),
    });
    this.logs.supervisor.event('dsh_ready', { authority, version: this.config.dshVersion });

    // The adapter receives the DSH RPC credential; the Gateway separately owns the
    // narrowly scoped loopback browser handoff and never exposes it to mobile API data.
    const createAdapter = this.seams.createAdapter;
    if (typeof createAdapter === 'function') {
      this.adapter = await createAdapter({ config: this.config, authProvider: this.authProvider });
    }
  }

  /**
   * Wait for the launch-token announcement.
   *
   * @param {LaunchTokenParser} parser - the parser.
   * @param {() => boolean} exited - whether the child already exited.
   * @returns {Promise<string>} the launch token.
   * @throws {ProductionError} on timeout, early exit, or an unresolved announcement.
   */
  #awaitLaunchToken(parser, exited) {
    return new Promise((resolve, reject) => {
      /** Every timer this wait owns, so none can outlive it. */
      let timer = null;
      let exitCheck = null;
      let unsubscribe = () => {};
      /** Whether a resolution decision is already pending for this batch. */
      let settled = false;

      const finish = (fn, value) => {
        clearTimeout(timer);
        clearInterval(exitCheck);
        // The exit check is also in `this.timers`; leaving it there would keep the
        // process alive after a successful bootstrap.
        if (exitCheck !== null) this.timers.delete(exitCheck);
        unsubscribe();
        // Retained so a later restart can drop this subscription rather than
        // accumulating one per child.
        this.lineUnsubscribe = null;
        fn(value);
      };

      unsubscribe = this.dsh.onLine((line) => {
        parser.push(line);
        if (parser.launchToken === null) return;
        if (settled) return;
        settled = true;
        // Defer the decision by one tick. DSH's stdout arrives in chunks, and a
        // handler is called once per line within a single synchronous drain — so
        // deciding on the *first* line would make the "more than one distinct token"
        // rule unreachable for a batch. Waiting a tick lets the whole batch land, at
        // a cost of microseconds.
        setImmediate(() => {
          const decision = parser.resolve();
          if (decision.ok) finish(resolve, decision.token);
          else settled = false;
        });
      });
      this.lineUnsubscribe = unsubscribe;

      timer = setTimeout(() => {
        // §16: fail closed. An unresolved announcement is never guessed at.
        const decision = parser.resolve();
        finish(reject, new ProductionError(
          R7_ERROR.DSH_BOOTSTRAP_TOKEN_UNRESOLVED,
          decision.ok ? 'the launch-token announcement was not observed in time' : decision.reason,
        ));
      }, this.config.startTimeoutMs);

      // A child that dies before announcing cannot ever announce.
      exitCheck = setInterval(() => {
        if (exited()) {
          finish(reject, new ProductionError(
            R7_ERROR.DSH_PROCESS_EXITED,
            'the DSH child exited before announcing a launch token',
          ));
        }
      }, 100);
      // Do not let this bookkeeping timer hold the event loop open on its own.
      exitCheck.unref?.();
      this.timers.add(exitCheck);
    });
  }

  /**
   * Open the R5 persistence root and start the Gateway.
   *
   * @returns {Promise<void>} resolves when the Gateway is listening.
   */
  async startGateway() {
    const createGateway = this.seams.createGateway;
    if (typeof createGateway !== 'function') return;
    this.logs.supervisor.event('gateway_starting', {
      gateway: `${this.config.gatewayHost}:${this.config.gatewayPort}`,
    });
    // §28: `persistenceConfig: {}` is deliberate — the production root is the R5
    // default under DSH_HOME, and the caller must not be able to quietly relocate it.
    //
    // `adapter: this.adapter` is passed as `undefined` on a cold start, and the Gateway
    // builds the real `DshAdapter` itself and returns it. That returned adapter is the
    // only handle on the object the Gateway is actually using, so it is adopted here —
    // otherwise `this.adapter` stays null and an acceptance probe through the production
    // adapter has nothing to call, which is exactly what
    // `reason = no adapter with listSessions was wired` reported.
    const created = await createGateway({
      config: this.config,
      authProvider: this.authProvider,
      credential: this.credential,
      adapter: this.adapter,
      logs: this.logs,
      onEvent: (event, fields) => this.logs.gateway.event(event, fields),
    });
    this.gateway = created;
    this.recovery = created?.recovery ?? null;
    if (this.adapter === null && created?.adapter !== null && created?.adapter !== undefined) {
      // The handle the Gateway is really using. Never a fixture, never a seam.
      this.adapter = created.adapter;
      this.logs.supervisor.event('adapter_adopted', { via: 'gateway' });
    }
  }

  /**
   * Handle an unexpected DSH exit with bounded self-healing (§23).
   *
   * @param {object} info - the exit facts.
   * @returns {Promise<void>} resolves when recovery has finished or been abandoned.
   */
  async #onUnexpectedExit(info) {
    if (this.stopping) return;
    // §23: the Gateway must not keep claiming READY while DSH is gone.
    if (this.gateway !== null && typeof this.gateway.stop === 'function') {
      try { await this.gateway.stop(); } catch { /* recorded below if it matters */ }
      this.gateway = null;
    }
    this.authProvider.clear();

    // §23: a stack that stayed healthy for the stability window forgets its failures,
    // so an occasional crash over days does not accumulate into a permanent failure.
    if (this.lastStableAt !== null && this.clock().getTime() - this.lastStableAt.getTime() >= this.config.stabilityMs) {
      this.consecutiveFailures = 0;
    }

    this.consecutiveFailures += 1;
    this.logs.supervisor.event('error', {
      code: R7_ERROR.DSH_PROCESS_EXITED,
      attempt: this.consecutiveFailures,
      exit_code: info?.code ?? null,
    }, 'error');

    if (this.consecutiveFailures > this.config.maxRestarts) {
      // §23: exhausted. FAILED is terminal until an operator intervenes.
      await this.#fail(R7_ERROR.DSH_PROCESS_EXITED, 'the DSH child exited repeatedly and the retry budget is exhausted');
      return;
    }

    const backoff = this.config.restartBackoffMs[Math.min(this.consecutiveFailures - 1, this.config.restartBackoffMs.length - 1)];
    this.logs.supervisor.event('restart_scheduled', {
      attempt: this.consecutiveFailures,
      backoff_ms: backoff,
    });
    this.status.transition(SUPERVISOR_STATE.RESTARTING, { last_error_code: R7_ERROR.DSH_PROCESS_EXITED });
    await new Promise((resolve) => { setTimeout(resolve, backoff); });

    try {
      // The recovery path must walk the same states as a cold start. Jumping from
      // RESTARTING straight to READY skips the phases the state machine models, and
      // `transition` is right to refuse it — a recovery is a start, not a shortcut.
      this.status.transition(SUPERVISOR_STATE.BOOTSTRAPPING_DSH);
      await this.bootstrapDsh();
      this.status.transition(SUPERVISOR_STATE.STARTING_GATEWAY);
      await this.startGateway();
      this.status.transition(SUPERVISOR_STATE.READY, {
        dsh_pid: this.dsh?.pid ?? null,
        last_error_code: null,
      });
      this.lastStableAt = this.clock();
    } catch (error) {
      await this.#onUnexpectedExit({ code: error?.code ?? null });
    }
  }

  /**
   * Record a failure without losing the reason.
   *
   * @param {string} code - the error code.
   * @param {string} [detail] - a secret-free detail.
   * @returns {Promise<void>} resolves once recorded.
   */
  async #fail(code, detail) {
    // §39: a failure detail is stripped of secrets before it is persisted, because
    // the detail is often derived from whatever went wrong.
    let safeDetail = detail ?? null;
    try {
      assertNoSecrets(safeDetail, this.#knownSecrets(), 'the status failure detail');
    } catch {
      safeDetail = '<redacted>';
    }
    this.logs.supervisor.event('error', { code, detail: safeDetail }, 'error');
    try {
      this.status.fail(code, safeDetail);
    } catch {
      // A status write must not mask the original failure.
    }
  }

  /**
   * Every secret this supervisor is holding, for redaction and scanning.
   *
   * @returns {string[]} the secrets.
   */
  #knownSecrets() {
    const secrets = [];
    if (typeof this.credential.token === 'string') secrets.push(this.credential.token);
    if (typeof this.authProvider.cookie === 'string') secrets.push(this.authProvider.cookie);
    return secrets;
  }

  /**
   * Poll the control channel once.
   *
   * @returns {Promise<{action: string}>} what happened.
   */
  async pollControl() {
    this.control.cleanup();
    const result = this.control.poll();
    if (result.action === 'stop') {
      this.logs.supervisor.event('stop_requested', { request_id: result.request.request_id });
      // Answered asynchronously so the poller is not re-entered by its own shutdown.
      setTimeout(() => { void this.stop(); }, 0);
      return { action: 'stop' };
    }
    if (result.action === 'issue-browser-login') {
      let outcome;
      if (this.status.state !== SUPERVISOR_STATE.READY
        || typeof this.gateway?.browserLogin?.issue !== 'function') {
        outcome = {
          ok: false,
          code: 'DSH_BROWSER_LOGIN_UNAVAILABLE',
          expires_at: new Date(this.clock().getTime() + 120_000).toISOString(),
        };
      } else {
        const issued = this.gateway.browserLogin.issue();
        outcome = issued.ok
          ? {
            ok: true,
            url: issued.url,
            expires_at: new Date(issued.expiresAt).toISOString(),
            expires_in_seconds: issued.expiresInSeconds,
          }
          : {
            ok: false,
            code: issued.code,
            expires_at: new Date(this.clock().getTime() + 120_000).toISOString(),
          };
      }
      this.control.respondBrowserLogin(result.request, outcome);
      this.logs.supervisor.event('dsh_browser_login_ticket_issued', {
        request_id: result.request.request_id,
        issued: outcome.ok === true,
      });
      return { action: result.action };
    }
    return { action: result.action };
  }

  /**
   * Stop everything, in the §22 order.
   *
   * @param {object} [options] - stop options.
   * @returns {Promise<object>} the shutdown summary.
   */
  async stop(options = {}) {
    if (this.stopping) return { alreadyStopping: true };
    // §22: a stop of a never-started (or already stopped) supervisor is a no-op.
    // Transitions are declared, and STOPPED -> STOPPING is correctly illegal; the
    // caller's intent is satisfiable without one.
    if (this.status.state === SUPERVISOR_STATE.STOPPED && this.gateway === null && this.dsh === null) {
      this.stopping = true;
      return {
        alreadyStopped: true,
        state: this.status.state,
        gateway: null,
        dsh: null,
        logs: this.logs.close(),
      };
    }
    this.stopping = true;
    this.status.transition(SUPERVISOR_STATE.STOPPING);

    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
    this.#releaseChildSubscriptions();

    // 1. The Gateway first, so no request is served by a stack whose DSH is going away.
    let gatewayResult = null;
    if (this.gateway !== null && typeof this.gateway.stop === 'function') {
      try {
        gatewayResult = await this.gateway.stop();
      } catch (error) {
        gatewayResult = { error: error?.code ?? 'unknown' };
      }
      this.gateway = null;
    }

    // 2. Then the owned DSH process tree.
    let dshResult = null;
    // Captured BEFORE the reference is dropped. The STOPPED invariant below reads the owned set to
    // decide whether anything survived; reading it from `this.dsh` after this point yields an empty
    // list, which would make `treeGone` true for the wrong reason.
    const ownedTree = this.dsh === null ? [] : [...(this.dsh.ownedPids ?? [])];
    const ownedRootPid = this.dsh === null ? null : this.dsh.pid;
    const ownedListenerPid = this.dsh === null ? null : (this.dsh.listenerPid ?? null);
    if (this.dsh !== null) {
      // The DSH port is passed so the stop path verifies release itself instead of only reporting
      // that a termination was issued.
      dshResult = await this.dsh.stop({ ...options, port: this.config.dshPort });
    }
    this.authProvider.clear();

    // 3. Flush logs.
    const logResult = this.logs.close();

    // ── 4. The STOPPED invariant ─────────────────────────────────────────────
    //
    // `STOPPED` is a claim that the stack is down. Publishing it on the strength of
    // "we asked everything to stop" is how the external run reported
    // `supervisor_state_after_stop = STOPPED` while **both ports were still listening**:
    // the recorded child PID was dead, but the process that actually listened on the DSH
    // port was a re-parented grandchild that survived the tree kill.
    //
    // So each condition is *verified* rather than assumed, and a failure is `FAILED` —
    // never `STOPPED`.
    const gatewayPortReleased = await this.#waitPortFree(this.config.gatewayPort, {
      timeoutMs: options.portReleaseTimeoutMs ?? 15_000,
    });
    const dshPortReleased = await this.#waitPortFree(this.config.dshPort, {
      timeoutMs: options.portReleaseTimeoutMs ?? 15_000,
    });
    // The tree the stop path actually signalled. `stop()` now reports the escalation it performed
    // (`forced`, `survivors`) rather than a `signal_tree` array, so the evidence records both.
    const signalledTree = Array.isArray(dshResult?.signal_tree) ? dshResult.signal_tree : [];
    const treeStillAlive = [];
    for (const pid of ownedTree) {
      if (await this.#isProcessAlive(pid)) treeStillAlive.push(pid);
    }
    // A recorded root that never registered a tree still has to be accounted for.
    if (Number.isInteger(ownedRootPid) && !ownedTree.includes(ownedRootPid)
      && await this.#isProcessAlive(ownedRootPid)) {
      treeStillAlive.push(ownedRootPid);
    }

    const portsFree = gatewayPortReleased.free === true && dshPortReleased.free === true;
    const treeGone = treeStillAlive.length === 0;
    this.lastShutdown = {
      gateway_port_free: gatewayPortReleased.free,
      gateway_port_release_waited_ms: gatewayPortReleased.waitedMs,
      dsh_port_free: dshPortReleased.free,
      dsh_port_release_waited_ms: dshPortReleased.waitedMs,
      owned_tree: ownedTree,
      signalled_tree: signalledTree,
      tree_still_alive: treeStillAlive,
      // R7C: what the escalation actually did, and the exact deadline it was bounded by, so the
      // acceptance evidence can show whether force was needed and how long each phase took.
      stop_outcome: dshResult === null ? null : {
        graceful: dshResult.graceful === true,
        forced: dshResult.forced === true,
        stopped: dshResult.stopped === true,
        survivors: dshResult.survivors ?? [],
        listener_pid: dshResult.listenerPid ?? ownedListenerPid,
        port_free: dshResult.portFree === true,
        graceful_ms: dshResult.graceful_ms ?? null,
        force_ms: dshResult.force_ms ?? null,
        total_ms: dshResult.total_ms ?? null,
      },
      // Ownership as proven across the bootstrap, so the evidence shows *why* this set is
      // the owned set rather than only what it contains.
      ownership: this.dsh?.ownership?.describe?.() ?? null,
      listener_ownership: this.listenerOwnership ?? null,
      // Every port observation that fed this verdict, with provenance. Two different
      // probes once disagreed in the same evidence file; recording name, time, port and
      // owner makes a real transition distinguishable from a probe bug.
      port_observations: [
        ...(this.portObservations ?? []),
        await this.#probePort('shutdown.gateway', this.config.gatewayPort),
        await this.#probePort('shutdown.dsh', this.config.dshPort),
      ],
    };
    this.logs.supervisor.event('shutdown_invariant', this.lastShutdown);

    if (!portsFree || !treeGone) {
      // The stop did not complete. Report the owner so the operator can decide, and never
      // claim STOPPED.
      const gatewayOwner = this.lastShutdown.port_observations.at(-2)?.owner_pid ?? 0;
      const dshOwner = this.lastShutdown.port_observations.at(-1)?.owner_pid ?? 0;
      this.lastShutdown.gateway_port_owner = gatewayOwner;
      this.lastShutdown.dsh_port_owner = dshOwner;
      // §24: retain enough to explain the failure without any secret material — which owned PIDs
      // survived, which listener holds the port, and what escalation was attempted.
      this.lastShutdown.lifecycle_failure = {
        surviving_owned_pids: treeStillAlive,
        recorded_listener_pid: ownedListenerPid,
        dsh_port_owner_pid: dshOwner,
        gateway_port_owner_pid: gatewayOwner,
        dsh_port: this.config.dshPort,
        gateway_port: this.config.gatewayPort,
        dsh_port_free: dshPortReleased.free === true,
        gateway_port_free: gatewayPortReleased.free === true,
        force_escalation_attempted: dshResult?.forced === true,
        graceful_exit_observed: dshResult?.graceful === true,
      };
      const detail = [
        gatewayPortReleased.free ? null : `gateway port ${this.config.gatewayPort} still held by pid ${gatewayOwner}`,
        dshPortReleased.free ? null : `dsh port ${this.config.dshPort} still held by pid ${dshOwner}`,
        treeGone ? null : `owned pids still alive: ${treeStillAlive.join(',')}`,
      ].filter((entry) => entry !== null).join('; ');
      await this.#fail(R7_ERROR.PRODUCTION_SMOKE_FAILED, `stop did not complete: ${detail}`);
      return {
        gateway: gatewayResult,
        dsh: dshResult,
        logs: logResult,
        state: this.status.state,
        stopped: false,
        shutdown: this.lastShutdown,
        credentialGeneration: this.credential.generationId,
      };
    }

    this.status.transition(SUPERVISOR_STATE.STOPPED, { last_error_code: this.status.record.last_error_code ?? null });
    this.logs.supervisor.event('shutdown_complete', {
      gateway: gatewayResult === null ? 'not-started' : 'stopped',
      dsh: dshResult === null ? 'not-started' : (dshResult.forced ? 'forced' : 'graceful'),
      ports_free: true,
    });

    return {
      gateway: gatewayResult,
      dsh: dshResult,
      logs: logResult,
      state: this.status.state,
      stopped: true,
      shutdown: this.lastShutdown,
      credentialGeneration: this.credential.generationId,
    };
  }

  /**
   * The injectable walkers ownership capture should use.
   *
   * Both are OS boundaries, so a test that fakes the child process supplies them; the
   * bookkeeping that consumes them always runs.
   *
   * @returns {object} the options.
   */
  #ownershipOptions() {
    return {
      ...(this.seams.enumerateTree === undefined ? {} : { enumerate: this.seams.enumerateTree }),
      ...(this.seams.ancestorsOf === undefined ? {} : { ancestorsOf: this.seams.ancestorsOf }),
    };
  }

  /**
   * The single authoritative port observation.
   *
   * Every listening observation in a run comes from here, so the shutdown invariant, the
   * pre-restart evidence and the final-stop evidence cannot disagree. The observation
   * carries its probe name, timestamp, port, listening state and owner PID, so a real
   * transition can be told apart from a probe bug.
   *
   * @param {string} probe - the probe name, e.g. `shutdown.dsh`.
   * @param {number} port - the port.
   * @returns {Promise<object>} the observation.
   */
  async #probePort(probe, port) {
    const listener = this.seams.listenerPid ?? listenerPidOf;
    const ownerPid = await listener(port);
    const observation = {
      probe,
      at: this.clock().toISOString(),
      port,
      listening: Number(ownerPid) > 0,
      owner_pid: Number(ownerPid) > 0 ? Number(ownerPid) : null,
    };
    if (!Array.isArray(this.portObservations)) this.portObservations = [];
    this.portObservations.push(observation);
    return observation;
  }

  /**
   * Wait for a port to be released, through the seam when one is injected.
   *
   * The seam exists because this is an **OS boundary**: a test that fakes the child
   * process never binds a real socket, so waiting on the real port would always time out.
   * Everything around the wait — the invariant, the FAILED transition, the recorded
   * timings — still runs.
   *
   * @param {number} port - the port.
   * @param {object} options - `timeoutMs`.
   * @returns {Promise<{free: boolean, waitedMs: number}>} the outcome.
   */
  async #waitPortFree(port, options) {
    const seam = this.seams.waitPortFree;
    if (typeof seam === 'function') return seam(port, options);
    return waitForPortFree(port, options);
  }

  /**
   * Whether a owned PID is still alive, through the seam when one is injected.
   *
   * @param {number} pid - the PID.
   * @returns {Promise<boolean>} true when alive.
   */
  async #isProcessAlive(pid) {
    const seam = this.seams.isProcessAlive;
    if (typeof seam === 'function') return seam(pid);
    return isProcessAlive(pid);
  }

  /**
   * A safe description for `dsh-status.ps1`.
   *
   * @returns {object} the summary.
   */
  describe() {
    return {
      instance_id: this.instanceId,
      state: this.status.state,
      supervisor_pid: process.pid,
      dsh: this.dsh?.describe() ?? null,
      gateway: { host: this.config.gatewayHost, port: this.config.gatewayPort },
      credential: this.credential.describe(),
      auth: this.authProvider.describe(),
      control: this.control.describe(),
      consecutive_failures: this.consecutiveFailures,
      last_error_code: this.status.record.last_error_code ?? null,
    };
  }
}

export { ProductionError, R7_ERROR, SUPERVISOR_STATE };
