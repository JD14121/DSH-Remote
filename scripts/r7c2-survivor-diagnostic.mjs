/**
 * R7C.2 — survivor identity & termination context diagnostic.
 *
 * ## What it does
 *
 * Starts one real production stack, drives the accepted ControlChannel stop, and while the force
 * escalation runs it samples process identity at ~80 ms:
 *
 *   PID + **creation timestamp** + ParentProcessId + executable path + command line + session id
 *   + port owner
 *
 * PID alone cannot distinguish "the same process survived" from "the old process died and the
 * numeric PID was reused", which is exactly the ambiguity R7C.1 left open.
 *
 * It also captures the exact force-kill invocation: resolved executable path, argv, shell flag, cwd,
 * exit code, stdout, stderr and start/finish timestamps. The existing production `defaultForceKill`
 * discards all of that, which is why the previous phase could see `SUCCESS` in the log and a living
 * listener on the port at the same time.
 *
 * Diagnostic only — none of this sampling becomes production lifecycle logic.
 *
 * Usage: node scripts/r7c2-survivor-diagnostic.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveProductionConfig, SUPERVISOR_STATE } from '../src/remote/production/production-config.mjs';
import { CredentialStore } from '../src/remote/production/credential-store.mjs';
import { ProductionLogs } from '../src/remote/production/logger.mjs';
import { Supervisor, CONTROL_POLL_MS } from '../src/remote/production/supervisor.mjs';
import { ControlChannel } from '../src/remote/production/control-channel.mjs';
import { LaunchTokenParser } from '../src/remote/production/dsh-bootstrap.mjs';
import { startProductionGateway } from '../src/remote/production/production-gateway.mjs';
import { isProcessAlive, waitForPortFree, listenerPidOf } from '../src/remote/production/dsh-process.mjs';
import { hardenAcl, verifyAcl } from '../src/remote/production/windows-acl.mjs';

const run = promisify(execFile);
const EVIDENCE = 'D:/DSH-testing/docs/remote-mobile/_evidence';
const OUT = `${EVIDENCE}/r7c2-survivor-identity.json`;
const TASKKILL = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\taskkill.exe`;

const config = resolveProductionConfig({});
const record = {
  phase: 'R7C.2',
  at: new Date().toISOString(),
  acceptance_dsh_port: config.dshPort,
  gateway_port: config.gatewayPort,
  taskkill_path: TASKKILL,
  taskkill_exists: fs.existsSync(TASKKILL),
  taskkill_on_path_resolution: null,
  samples: [],
  force_invocations: [],
};

/** Record a step. */
function step(name, value) {
  record[name] = value;
  process.stdout.write(`  ${name}: ${JSON.stringify(value)}\n`);
}

/**
 * Full identity of one PID, or null when it is gone.
 *
 * @param {number} pid - the process id.
 * @returns {Promise<object|null>} the identity.
 */
async function identityOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const { stdout } = await run('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue;`
      + 'if ($p) { $p | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine,SessionId | ConvertTo-Json -Compress }',
    ], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const text = String(stdout).trim();
    if (text.length === 0) return null;
    const parsed = JSON.parse(text);
    return {
      pid: parsed.ProcessId,
      parent_pid: parsed.ParentProcessId,
      // Creation time is the identity discriminator: a reused PID has a different creation time.
      creation_date: parsed.CreationDate,
      executable: parsed.ExecutablePath ?? null,
      command_line: parsed.CommandLine ? String(parsed.CommandLine).replace(/[A-Za-z0-9_-]{43}/g, '<redacted>').slice(0, 180) : null,
      session_id: parsed.SessionId ?? null,
    };
  } catch {
    return null;
  }
}

/** One full identity sample. */
async function sample(label, watchPids) {
  const portOwner = await listenerPidOf(config.dshPort).catch(() => null);
  const identities = {};
  for (const pid of watchPids) identities[pid] = await identityOf(pid);
  return {
    at: new Date().toISOString(),
    label,
    supervisor_state: null,
    dsh_port_owner: portOwner,
    identities,
  };
}

// ── resolve how `taskkill` resolves from this process's PATH ─────────────────
try {
  const { stdout } = await run('where.exe', ['taskkill'], { windowsHide: true });
  record.taskkill_on_path_resolution = String(stdout).split(/\r?\n/).filter((l) => l.trim()).map((l) => l.trim());
} catch (error) {
  record.taskkill_on_path_resolution = `unresolved: ${error?.code ?? error?.message}`;
}
process.stdout.write(`  taskkill.exe        : ${TASKKILL} (exists=${record.taskkill_exists})\n`);
process.stdout.write(`  PATH resolution     : ${JSON.stringify(record.taskkill_on_path_resolution)}\n`);

// ── the gateway seam the runner previously omitted ───────────────────────────
const logs = new ProductionLogs({ paths: config.paths, maxBytes: config.logMaxBytes, backups: config.logBackups });
const credential = new CredentialStore({ paths: config.paths, harden: hardenAcl, verify: verifyAcl });

// Instrumented force kill: identical argv shape, but everything recorded.
const forceInvocations = record.force_invocations;
const instrumentedForceKill = async (argv) => {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const absolute = argv[0].toLowerCase().endsWith('taskkill.exe')
    ? argv[0]
    : TASKKILL;
  let exitCode = null; let stdoutText = ''; let stderrText = '';
  try {
    const result = await run(absolute, argv.slice(1), { windowsHide: true });
    stdoutText = String(result.stdout ?? ''); stderrText = String(result.stderr ?? ''); exitCode = 0;
  } catch (error) {
    exitCode = typeof error?.code === 'number' ? error.code : null;
    stdoutText = String(error?.stdout ?? ''); stderrText = String(error?.stderr ?? error?.message ?? '');
  }
  forceInvocations.push({
    executable: absolute,
    argv: argv.slice(1),
    full_argv: [absolute, ...argv.slice(1)],
    shell: false,
    cwd: process.cwd(),
    requested_executable: argv[0],
    exit_code: exitCode,
    reported_success: exitCode === 0 && /SUCCESS/i.test(stdoutText),
    stdout: stdoutText.trim().slice(0, 200),
    stderr: stderrText.trim().slice(0, 200),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - t0,
  });
};

const supervisor = new Supervisor({
  config,
  logs,
  credential,
  seams: {
    createParser: () => new LaunchTokenParser({ timeoutMs: config.startTimeoutMs }),
    createGateway: (context) => startProductionGateway({
      config: context.config,
      credential: context.credential,
      authProvider: context.authProvider,
      logs: context.logs,
      onEvent: context.onEvent,
    }),
  },
});

try {
  await supervisor.start();
  step('supervisor_state_after_start', supervisor.status.state);
  const listenerPid = await listenerPidOf(config.dshPort).catch(() => null);
  const owned = [...(supervisor.dsh?.ownedPids ?? [])];
  step('owned_pids', owned);
  step('listener_pid', listenerPid);
  step('supervisor_pid', process.pid);

  // §17: the true tree, with executable path and command line for every layer.
  const tree = [];
  for (const pid of owned) tree.push(await identityOf(pid));
  record.process_tree = tree.filter(Boolean);
  for (const node of record.process_tree) {
    process.stdout.write(`    pid ${node.pid} parent=${node.parent_pid} ${path.basename(String(node.executable ?? '?'))} ${String(node.command_line ?? '').slice(0, 70)}\n`);
  }

  // The accepted gate before stopping.
  const token = credential.requireToken();
  const health = await fetch(`http://127.0.0.1:${config.gatewayPort}/api/v1/health`, { headers: { authorization: `Bearer ${token}` } });
  step('authenticated_health_before_stop', health.status === 200);

  // ── sampler: 50 ms cadence through the whole stop ─────────────────────────
  const watchPids = [...new Set([...owned, listenerPid, process.pid].filter(Number.isInteger))];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const snap = await sample('tick', watchPids);
      snap.supervisor_state = supervisor.status.state;
      record.samples.push(snap);
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
  })();

  // ── drive the stop, polling the channel as the resident launcher does ─────
  const control = new ControlChannel({ paths: config.paths, instanceId: supervisor.instanceId });
  control.ensure();
  control.requestStop();
  const stopStartedAt = Date.now();
  const poll = setInterval(() => { void supervisor.pollControl().catch(() => {}); }, CONTROL_POLL_MS);
  const stopResult = await supervisor.stop({ forceKill: instrumentedForceKill }).catch((error) => ({ error: String(error?.message) }));
  clearInterval(poll);
  await new Promise((resolve) => { setTimeout(resolve, 3000); });
  sampling = false;
  await sampler;

  step('stop_ms', Date.now() - stopStartedAt);
  step('stop_state', supervisor.status.state);
  step('stop_stopped', stopResult?.stopped === true);
  step('stop_forced', stopResult?.forced === true);
  step('stop_survivors', stopResult?.survivors ?? null);
  step('force_invocation_count', forceInvocations.length);

  // ── classification (§5) ───────────────────────────────────────────────────
  const finalSurvivors = [];
  for (const pid of watchPids) {
    const identity = await identityOf(pid);
    if (identity) finalSurvivors.push(identity);
  }
  record.final_survivors = finalSurvivors;
  const portOwnerAfter = await listenerPidOf(config.dshPort).catch(() => null);
  step('dsh_port_owner_after_stop', portOwnerAfter);

  // Compare identity before vs after for each watched PID.
  const comparisons = [];
  for (const pid of watchPids) {
    const before = record.process_tree.find((n) => n.pid === pid) ?? null;
    const after = finalSurvivors.find((n) => n.pid === pid) ?? null;
    comparisons.push({
      pid,
      before_present: before !== null,
      after_present: after !== null,
      before_creation: before?.creation_date ?? null,
      after_creation: after?.creation_date ?? null,
      same_identity: before !== null && after !== null && before.creation_date === after.creation_date,
      creation_changed: before !== null && after !== null && before.creation_date !== after.creation_date,
    });
  }
  record.identity_comparisons = comparisons;

  // CASE classification
  const sameIdentitySurvivors = comparisons.filter((c) => c.same_identity);
  const creationChanged = comparisons.filter((c) => c.creation_changed);
  if (creationChanged.length > 0 && sameIdentitySurvivors.length === 0) {
    record.survivor_classification = 'CASE C — same numeric PID with a different creation time (PID reuse)';
    record.pid_reuse_observed = true;
  } else if (sameIdentitySurvivors.length > 0) {
    record.survivor_classification = 'CASE A — same PID and same creation time survived';
    record.pid_reuse_observed = false;
  } else if (finalSurvivors.length > 0) {
    record.survivor_classification = 'CASE B — old PID gone, a new process appeared';
    record.pid_reuse_observed = false;
  } else if (portOwnerAfter !== null) {
    record.survivor_classification = 'CASE D — processes gone but the port moved to another owner';
    record.pid_reuse_observed = false;
  } else {
    record.survivor_classification = 'no survivor — the stop completed';
    record.pid_reuse_observed = false;
  }
  record.same_process_identity_survived = sameIdentitySurvivors.length > 0;

  step('survivor_classification', record.survivor_classification);
  step('same_process_identity_survived', record.same_process_identity_survived);

  // ── did the port actually free? ───────────────────────────────────────────
  const dshRelease = await waitForPortFree(config.dshPort, { timeoutMs: 10_000 });
  const gwRelease = await waitForPortFree(config.gatewayPort, { timeoutMs: 10_000 });
  step('dsh_port_free', dshRelease.free === true);
  step('gateway_port_free', gwRelease.free === true);
} catch (error) {
  step('error', String(error?.message ?? error).slice(0, 300));
} finally {
  try { await supervisor.stop({ timeoutMs: 2000 }); } catch { /* best effort */ }
  try { logs.close(); } catch { /* best effort */ }
}

// Keep only the interesting samples: transitions, and the window around the first force.
const interesting = record.samples.filter((s, i) => {
  if (i === 0) return true;
  const previous = record.samples[i - 1];
  return previous.supervisor_state !== s.supervisor_state
    || previous.dsh_port_owner !== s.dsh_port_owner
    || JSON.stringify(previous.identities) !== JSON.stringify(s.identities);
});
record.sample_transitions = interesting.length;
record.samples = interesting;
record.sampling_interval_ms = 50;

fs.mkdirSync(EVIDENCE, { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
process.stdout.write(`\n  transitions: ${interesting.length} | evidence: ${OUT}\n`);
process.exit(0);
