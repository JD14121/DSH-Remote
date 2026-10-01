/**
 * Production launcher — Phase R7 §29, §31.
 *
 * The one Node entry point an operator script runs. It loads the production config,
 * loads the credential, and starts the supervisor.
 *
 * **The Phone token is never a CLI argument or an environment variable** (§29). It is
 * read from its protected file by the credential store, which is also the only place
 * that verifies the file's ACL.
 *
 * Modes:
 *
 * ```text
 * --prepare   create and harden the production root, then exit
 * (default)   load config, start the supervisor, print a safe summary, stay resident
 * ```
 *
 * `--prepare` exists as a separate mode so root creation is an explicit, auditable
 * step that §6 and §28 require to happen **before** any secret or state exists.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  R7_ERROR,
  ProductionError,
  SUPERVISOR_STATE,
  describeProductionConfig,
  prepareProductionRoot,
  productionRootExists,
  resolveProductionConfig,
} from '../src/remote/production/production-config.mjs';
import { CredentialStore, creationNotice } from '../src/remote/production/credential-store.mjs';
import { Supervisor, CONTROL_POLL_MS } from '../src/remote/production/supervisor.mjs';
import { startProductionGateway } from '../src/remote/production/production-gateway.mjs';
import { hardenAcl, verifyAcl } from '../src/remote/production/windows-acl.mjs';
import { loadPcConfig, productionOverrides } from '../src/remote/production/pc-config.mjs';

/** Parse the tiny argument surface. Deliberately not a general CLI framework. */
function parseArgs(argv) {
  const flags = { prepare: false, json: false };
  for (const arg of argv) {
    if (arg === '--prepare') flags.prepare = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
  }
  return flags;
}

/**
 * Print the flag help.
 *
 * @returns {void}
 */
function printHelp() {
  process.stdout.write([
    'Usage: node scripts/remote-production.mjs [--prepare] [--json]',
    '',
    '  --prepare   create and harden the production root, then exit',
    '  --json      emit machine-readable output',
    '',
    'The Phone credential is read from its protected file. It is never passed as a',
    'CLI argument or an environment variable.',
    '',
  ].join('\n'));
}

/**
 * Create the production root if it is absent, otherwise report its state.
 *
 * @param {object} config - a resolved configuration.
 * @param {boolean} asJson - whether to emit JSON.
 * @returns {Promise<void>} resolves when done.
 */
async function runPrepare(config, asJson) {
  if (productionRootExists(config)) {
    const payload = {
      status: 'already-exists',
      root: config.root,
      code: R7_ERROR.PRODUCTION_ROOT_UNEXPECTED,
      note: 'R7 will not delete, overwrite or reuse an existing production root.',
    };
    process.stdout.write(asJson ? `${JSON.stringify(payload)}\n` : `production root already exists: ${config.root}\n`);
    process.exitCode = 2;
    return;
  }

  const created = await prepareProductionRoot({ config, harden: hardenAcl, verify: verifyAcl });
  const payload = {
    status: 'created',
    root: created.root,
    subdirs: created.subdirs,
    acl_verified: created.aclVerified,
  };
  process.stdout.write(asJson
    ? `${JSON.stringify(payload)}\n`
    : `production root created and hardened: ${created.root}\nACL verified: yes\n`);
}

/**
 * Start the supervisor and stay resident.
 *
 * @param {object} config - a resolved configuration.
 * @param {boolean} asJson - whether to emit JSON.
 * @returns {Promise<void>} resolves when the supervisor has stopped.
 */
async function runSupervisor(config, asJson) {
  // §28: no `persistenceConfig` override is threaded from here. `startProductionGateway`
  // passes `{}`, so the R5 default under DSH_HOME is the production root and a launcher
  // argument cannot relocate it.
  const store = new CredentialStore({
    paths: config.paths,
    harden: hardenAcl,
    verify: verifyAcl,
  });

  const supervisor = new Supervisor({
    config,
    credential: store,
    seams: {
      // Gate B: the real gateway, built from the verified cookie.
      createGateway: (context) => startProductionGateway({
        config: context.config,
        credential: context.credential,
        authProvider: context.authProvider,
        logs: context.logs,
        onEvent: context.onEvent,
      }),
    },
  });

  // A launcher is a long-lived process: it must not die from an unhandled rejection
  // while still holding an owned DSH child, or that child would be orphaned.
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`unhandled rejection: ${reason?.code ?? reason?.message ?? 'unknown'}\n`);
  });

  const installShutdown = () => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      void supervisor.stop().then(() => { process.exit(0); });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  };
  installShutdown();

  const result = await supervisor.start();

  const safe = {
    status: 'ready',
    gateway: `${config.gatewayHost}:${config.gatewayPort}`,
    dsh: supervisor.describe().dsh,
    credential: supervisor.describe().credential,
    instance_id: result.instanceId,
    ...describeProductionConfig(config),
  };
  process.stdout.write(asJson ? `${JSON.stringify(safe)}\n` : [
    'Gateway READY',
    `DSH RUNNING (pid ${safe.dsh?.pid ?? 'unknown'})`,
    `${config.gatewayHost}:${config.gatewayPort}`,
    'Phone credential: stored securely',
    `logs: ${config.paths.logs}`,
    '',
  ].join('\n'));

  if (supervisor.status.state !== SUPERVISOR_STATE.READY) {
    process.exitCode = 1;
    return;
  }

  // ── Resident control loop ───────────────────────────────────────────────────
  //
  // This is why the ControlChannel stop request was never consumed. The launcher printed READY and
  // RETURNED: nothing kept the process alive and nothing ever called `pollControl()`. The request
  // file was written correctly, and the poller that would have renamed and dispatched it simply
  // never ran. The Supervisor only observes a request when something polls it, so the canonical
  // operator stop had no path into a production launcher.
  //
  // SIGINT/SIGTERM cannot substitute for this on Windows: they resolve to `TerminateProcess`, which
  // is uncatchable, so the handlers below never run for an external stop.
  const poll = setInterval(() => {
    void supervisor.pollControl().catch(() => {
      // A failed poll must not kill a launcher that is holding an owned DSH child.
    });
  }, CONTROL_POLL_MS);
  poll.unref?.();

  // Wait for a terminal state, then exit with a status the operator can rely on. The owned DSH
  // child keeps the event loop alive while the loop timers are unref'd.
  const finalState = await new Promise((resolve) => {
    const check = setInterval(() => {
      const state = supervisor.status.state;
      if (state === SUPERVISOR_STATE.STOPPED || state === SUPERVISOR_STATE.FAILED) {
        clearInterval(check);
        clearInterval(poll);
        resolve(state);
      }
    }, CONTROL_POLL_MS);
    check.unref?.();
  });

  // A completed stop leaves the stack down, which is success. FAILED is not.
  if (finalState !== SUPERVISOR_STATE.STOPPED) process.exitCode = 1;
}

/**
 * Entry point.
 *
 * @returns {Promise<void>} resolves when the process is done.
 */
async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    return;
  }

  const pc = loadPcConfig();
  const config = resolveProductionConfig(pc === null ? {} : productionOverrides(pc));

  if (flags.prepare) {
    await runPrepare(config, flags.json);
    return;
  }

  // The root must exist and be hardened before the supervisor can use it. Refusing
  // here is the §6/§28 guarantee: no credential is created without a protected root.
  if (!productionRootExists(config)) {
    throw new ProductionError(
      R7_ERROR.ACL_HARDENING_FAILED,
      `the production root does not exist at ${config.root}; run with --prepare first`,
    );
  }

  await runSupervisor(config, flags.json);
}

// Only run when executed directly, so the module is importable by a test.
const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

if (invokedDirectly) {
  main().catch((error) => {
    const code = error?.code ?? 'R7_UNKNOWN';
    process.stderr.write(`${code}: ${error?.message ?? 'unknown failure'}\n`);
    process.exitCode = 1;
  });
}

export { main, parseArgs, runPrepare, runSupervisor, creationNotice, fs };
