/**
 * R7C.1 — instrumented Gate B runner.
 *
 * Diagnoses the two runner-side failures from R7C and then drives the full production cycle:
 * start → authenticated gate → ControlChannel stop → restart → second stop.
 *
 * ## What it instruments
 *
 * Each health attempt is bracketed by an independent listener probe and a known-good in-process
 * client call, so a failure can be attributed to the runner rather than to the product. Nothing
 * secret is recorded: no Authorization header, token, cookie, launch token or ticket.
 *
 * Usage: node scripts/r7c1-gate-runner.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';

import { resolveProductionConfig, SUPERVISOR_STATE } from '../src/remote/production/production-config.mjs';
import { CredentialStore } from '../src/remote/production/credential-store.mjs';
import { ProductionLogs } from '../src/remote/production/logger.mjs';
import { Supervisor, CONTROL_POLL_MS } from '../src/remote/production/supervisor.mjs';
import { ControlChannel } from '../src/remote/production/control-channel.mjs';
import { LaunchTokenParser } from '../src/remote/production/dsh-bootstrap.mjs';
import { startProductionGateway } from '../src/remote/production/production-gateway.mjs';
import { isProcessAlive, waitForPortFree, isPortListening } from '../src/remote/production/dsh-process.mjs';
import { hardenAcl, verifyAcl } from '../src/remote/production/windows-acl.mjs';

const EVIDENCE = 'D:/DSH-testing/docs/remote-mobile/_evidence';
const OUT = `${EVIDENCE}/r7c1-production-cycle.json`;

const config = resolveProductionConfig({});
const record = {
  phase: 'R7C.1',
  at: new Date().toISOString(),
  production_dsh_expected_port: config.dshPort,
  production_dsh_actual_port: null,
  gateway_port: config.gatewayPort,
  graceful_timeout_ms: 10_000,
  force_timeout_ms: 5_000,
  runner_diagnostics: [],
  steps: {},
};

/** Record a step. */
function step(name, value) {
  record.steps[name] = value;
  process.stdout.write(`  ${name}: ${JSON.stringify(value)}\n`);
}

/** Probe a port independently of anything the product reports. */
async function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const settle = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(500);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/**
 * One instrumented authenticated health attempt.
 *
 * @param {string} token - the Phone credential.
 * @param {string} label - which attempt this is.
 * @returns {Promise<object>} the outcome, with the failure cause if any.
 */
async function healthAttempt(token, label) {
  const target = `http://127.0.0.1:${config.gatewayPort}/api/v1/health`;
  const listeningBefore = await probePort(config.gatewayPort);
  const startedAt = Date.now();
  const diagnostics = { label, target, listening_before: listeningBefore };
  try {
    const response = await fetch(target, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.json().catch(() => null);
    Object.assign(diagnostics, {
      status: response.status,
      ready: body?.data?.ready ?? null,
      duration_ms: Date.now() - startedAt,
      listening_after: await probePort(config.gatewayPort),
    });
  } catch (error) {
    Object.assign(diagnostics, {
      error_name: error?.name ?? null,
      error_message: String(error?.message ?? error).slice(0, 200),
      cause_code: error?.cause?.code ?? null,
      cause_message: String(error?.cause?.message ?? '').slice(0, 200) || null,
      duration_ms: Date.now() - startedAt,
      listening_after: await probePort(config.gatewayPort),
    });
  }
  record.runner_diagnostics.push(diagnostics);
  return diagnostics;
}

// ── one full production lifecycle ────────────────────────────────────────────
const logs = new ProductionLogs({ paths: config.paths, maxBytes: config.logMaxBytes, backups: config.logBackups });
const credential = new CredentialStore({ paths: config.paths, harden: hardenAcl, verify: verifyAcl });

/** Build a fresh Supervisor for one cycle, wired exactly as the production launcher wires it. */
function makeSupervisor() {
  return new Supervisor({
    config,
    logs: new ProductionLogs({ paths: config.paths, maxBytes: config.logMaxBytes, backups: config.logBackups }),
    credential,
    seams: {
      createParser: () => new LaunchTokenParser({ timeoutMs: config.startTimeoutMs }),
      // The real Gateway. Omitting this seam was the runner defect: the Supervisor then had no
      // gateway to start, reported READY anyway, and every authenticated call was refused because
      // nothing was listening on 9445. The launcher in `remote-production.mjs` supplies it, so
      // leaving it out made the runner unrepresentative rather than exposing a product fault.
      createGateway: (context) => startProductionGateway({
        config: context.config,
        credential: context.credential,
        authProvider: context.authProvider,
        logs: context.logs,
        onEvent: context.onEvent,
      }),
    },
  });
}

/**
 * Run one cycle: start, verify, then stop through the ControlChannel.
 *
 * @param {object} supervisor - the supervisor for this cycle.
 * @param {string} phaseName - `first` or `second`.
 * @returns {Promise<object>} the cycle result.
 */
async function runCycle(supervisor, phaseName) {
  process.stdout.write(`\n  --- cycle ${phaseName}: start ---\n`);
  const startedAt = Date.now();
  await supervisor.start();

  const dshPid = supervisor.dsh?.pid ?? null;
  const ownedPids = [...(supervisor.dsh?.ownedPids ?? [])];
  const listenerPid = supervisor.dsh?.listenerPid ?? null;
  step(`${phaseName}_state`, supervisor.status.state);
  step(`${phaseName}_dsh_pid`, dshPid);
  step(`${phaseName}_owned_pids`, ownedPids);
  step(`${phaseName}_listener_pid`, listenerPid);
  step(`${phaseName}_gateway_listening`, await probePort(config.gatewayPort));
  step(`${phaseName}_dsh_listening`, await probePort(config.dshPort));
  step(`${phaseName}_start_ms`, Date.now() - startedAt);
  record.production_dsh_actual_port = config.dshPort;

  // A state string is not evidence. R7C.1's whole point is that a claim must match reality, so the
  // runner refuses to continue on a READY that the sockets do not corroborate.
  const gatewayUp = await probePort(config.gatewayPort);
  const dshUp = await probePort(config.dshPort);
  if (!gatewayUp || !dshUp) {
    step(`${phaseName}_readiness_corroborated`, false);
    return {
      ok: false,
      reason: `state was ${supervisor.status.state} but gateway_listening=${gatewayUp} dsh_listening=${dshUp}`,
      dshPid, ownedPids, listenerPid,
    };
  }
  step(`${phaseName}_readiness_corroborated`, true);

  // §5: the runner's own call, plus an independent known-good call, so a failure can be attributed.
  const token = credential.requireToken();
  const runnerHealth = await healthAttempt(token, `${phaseName}-runner`);
  step(`${phaseName}_runner_health_status`, runnerHealth.status ?? null);
  step(`${phaseName}_runner_health_error`, runnerHealth.error_message ?? null);
  step(`${phaseName}_runner_health_cause`, runnerHealth.cause_code ?? null);

  // The known-good path: the authenticated REST surface reached the same way the phone does.
  let knownGood = null;
  try {
    const response = await fetch(`http://127.0.0.1:${config.gatewayPort}/api/v1/sessions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await response.json();
    knownGood = { status: response.status, sessions: Array.isArray(body?.data) ? body.data.length : null };
  } catch (error) {
    knownGood = { error: String(error?.message ?? error).slice(0, 160), cause: error?.cause?.code ?? null };
  }
  step(`${phaseName}_known_good_sessions`, knownGood);

  const healthOk = runnerHealth.status === 200;
  const adapterOk = knownGood?.status === 200;
  step(`${phaseName}_authenticated_health`, healthOk);
  step(`${phaseName}_adapter_enumeration`, adapterOk);

  if (!healthOk || !adapterOk) {
    // §10: do not proceed to stop until the authenticated path passes.
    return { ok: false, reason: 'authenticated gate failed', dshPid, ownedPids, runnerHealth, knownGood };
  }

  // ── ControlChannel stop ────────────────────────────────────────────────────
  process.stdout.write(`  --- cycle ${phaseName}: ControlChannel stop ---\n`);
  const control = new ControlChannel({ paths: config.paths, instanceId: supervisor.instanceId });
  control.ensure();
  const written = control.requestStop();
  step(`${phaseName}_control_request_written`, written !== null && written !== undefined);
  step(`${phaseName}_control_dir`, config.paths.control);

  // Observe the transition, and drive the poll ourselves exactly as the resident launcher now does.
  const stopStartedAt = Date.now();
  let sawStopping = false;
  const stopPromise = (async () => {
    const poll = setInterval(() => { void supervisor.pollControl().catch(() => {}); }, CONTROL_POLL_MS);
    try {
      for (;;) {
        if (supervisor.status.state === SUPERVISOR_STATE.STOPPING) sawStopping = true;
        if (supervisor.status.state === SUPERVISOR_STATE.STOPPED
          || supervisor.status.state === SUPERVISOR_STATE.FAILED) break;
        await new Promise((resolve) => { setTimeout(resolve, 200); });
      }
    } finally {
      clearInterval(poll);
    }
    return supervisor.status.state;
  })();
  const finalState = await stopPromise;
  step(`${phaseName}_control_request_consumed`, sawStopping);
  step(`${phaseName}_stop_state_entered`, sawStopping);
  step(`${phaseName}_stop_state_final`, finalState);
  step(`${phaseName}_stop_ms`, Date.now() - stopStartedAt);

  const shutdown = supervisor.lastShutdown ?? null;
  const outcome = shutdown?.stop_outcome ?? null;
  step(`${phaseName}_force_escalation_required`, outcome?.forced ?? null);
  step(`${phaseName}_graceful_exit_observed`, outcome?.graceful ?? null);
  step(`${phaseName}_graceful_ms`, outcome?.graceful_ms ?? null);
  step(`${phaseName}_force_ms`, outcome?.force_ms ?? null);
  step(`${phaseName}_signalled_tree`, shutdown?.signalled_tree ?? null);
  step(`${phaseName}_survivors`, outcome?.survivors ?? null);
  step(`${phaseName}_tree_still_alive`, shutdown?.tree_still_alive ?? null);

  // §12: accept STOPPED only from observed reality, never the state string alone.
  const dshRelease = await waitForPortFree(config.dshPort, { timeoutMs: 15_000 });
  const gwRelease = await waitForPortFree(config.gatewayPort, { timeoutMs: 15_000 });
  const survivors = [];
  for (const pid of [...ownedPids, dshPid, listenerPid]) {
    if (Number.isInteger(pid) && await isProcessAlive(pid)) survivors.push(pid);
  }
  step(`${phaseName}_dsh_port_free`, dshRelease.free === true);
  step(`${phaseName}_gateway_port_free`, gwRelease.free === true);
  step(`${phaseName}_owned_pids_remaining`, survivors.length);
  step(`${phaseName}_listener_absent`, listenerPid === null || !(await isProcessAlive(listenerPid)));
  step(`${phaseName}_stopped_reflects_reality`,
    finalState === SUPERVISOR_STATE.STOPPED && dshRelease.free && gwRelease.free && survivors.length === 0);

  return {
    ok: finalState === SUPERVISOR_STATE.STOPPED && dshRelease.free && gwRelease.free && survivors.length === 0,
    dshPid, ownedPids, listenerPid, finalState, survivors,
  };
}

const operatorPidBefore = await (async () => {
  // The operator's DSH is the process listening on the composed default port, which this run does
  // NOT own. It is recorded so it can be proven untouched afterwards.
  const listening = await isPortListening(config.dshPort);
  return listening ? 'listening-before' : 'free-before';
})();
step('operator_dsh_port_state_before', operatorPidBefore);

// ── cycle 1 ──────────────────────────────────────────────────────────────────
const first = makeSupervisor();
const cycleOne = await runCycle(first, 'first');
record.first_cycle = cycleOne;

// ── cycle 2: restart, prove a new PID, then stop again ───────────────────────
if (cycleOne.ok) {
  process.stdout.write('\n  --- restart ---\n');
  const second = makeSupervisor();
  const cycleTwo = await runCycle(second, 'second');
  record.second_cycle = cycleTwo;
  record.restart_completed = cycleTwo.ok === true || cycleTwo.dshPid !== null;
  record.new_dsh_pid = cycleOne.dshPid !== null && cycleTwo.dshPid !== null && cycleOne.dshPid !== cycleTwo.dshPid;
  record.second_stop_completed = cycleTwo.ok === true;
}

// ── final machine state ──────────────────────────────────────────────────────
step('gateway_9445_free_final', (await probePort(config.gatewayPort)) === false);
step('production_dsh_port_free_final', (await probePort(config.dshPort)) === false);

fs.mkdirSync(EVIDENCE, { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
process.stdout.write(`\n  evidence: ${OUT}\n`);
process.exit(0);
