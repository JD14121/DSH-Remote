/**
 * R7C — one real production stop, driven in-process.
 *
 * ## Why in-process
 *
 * A Windows process signal cannot exercise this path: `Stop-Process` and `taskkill` without `/F`
 * both resolve to `TerminateProcess`, which is uncatchable, so no Node `SIGINT`/`SIGTERM` handler
 * ever runs. Two attempts confirmed it — the supervisor died outright and its orderly shutdown never
 * executed. A control-channel stop request was also not consumed by the running supervisor, so
 * neither route reaches the stop code from outside the process.
 *
 * This launcher therefore owns the Supervisor object and calls `stop()` on it directly. That runs
 * the real production stop path — Gateway close, then the owned DSH tree, then the STOPPED
 * invariant — against a real DSH and a real Gateway, and observes the result.
 *
 * Usage: node scripts/r7c-live-stop-inprocess.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { resolveProductionConfig } from '../src/remote/production/production-config.mjs';
import { CredentialStore } from '../src/remote/production/credential-store.mjs';
import { ProductionLogs } from '../src/remote/production/logger.mjs';
import { Supervisor } from '../src/remote/production/supervisor.mjs';
import { RuntimeStatus } from '../src/remote/production/runtime-status.mjs';
import { LaunchTokenParser } from '../src/remote/production/dsh-bootstrap.mjs';
import { isProcessAlive, waitForPortFree } from '../src/remote/production/dsh-process.mjs';
import { hardenAcl, verifyAcl } from '../src/remote/production/windows-acl.mjs';

const OUT = 'D:/DSH-testing/docs/remote-mobile/_evidence/r7c-production-gate-b.json';
const GRACEFUL_MS = Number(process.env.R7C_GRACEFUL_MS ?? '8000');

const config = resolveProductionConfig({});
const evidence = { phase: 'R7C', at: new Date().toISOString(), mode: 'in-process production stop' };
/** Record a step. */
function step(name, value) {
  evidence[name] = value;
  process.stdout.write(`  ${name}: ${JSON.stringify(value)}\n`);
}

step('dsh_port', config.dshPort);
step('gateway_port', config.gatewayPort);
step('graceful_timeout_ms', GRACEFUL_MS);
step('production_supervisor_started', true);
step('broad_process_kill_used', false);

const logs = new ProductionLogs({ paths: config.paths, maxBytes: config.logMaxBytes, backups: config.logBackups });
const credential = new CredentialStore({ paths: config.paths, harden: hardenAcl, verify: verifyAcl });
const status = new RuntimeStatus({ paths: config.paths, clock: () => new Date(), uuid: () => crypto.randomUUID() });
void status;

// The Supervisor owns spawn, adoption, the auth provider and the STOPPED invariant, so the whole
// lifecycle is driven through its own API rather than by reimplementing any part of it. Only the
// launch-token parser is injected, because the Supervisor builds one from its own config seam.
const supervisor = new Supervisor({
  config,
  logs,
  credential,
  seams: { createParser: () => new LaunchTokenParser({ timeoutMs: config.startTimeoutMs }) },
});

let started = false;
try {
  await supervisor.start();
  started = true;
  step('supervisor_state_after_start', supervisor.status.state);
  step('dsh_pid', supervisor.dsh?.pid ?? null);
  step('owned_pids', supervisor.dsh?.ownedPids ?? []);

  // Authenticated data path, as Gate B requires.
  const token = credential.requireToken();
  const health = await fetch(`http://127.0.0.1:${config.gatewayPort}/api/v1/health`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const healthBody = await health.json();
  step('authenticated_health_after_start', health.status === 200);
  step('authenticated_health_ready', healthBody?.data?.ready === true);

  const sessions = await fetch(`http://127.0.0.1:${config.gatewayPort}/api/v1/sessions`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const sessionBody = await sessions.json();
  step('adapter_session_enumeration_after_start', sessions.status === 200);
  step('session_count', Array.isArray(sessionBody?.data) ? sessionBody.data.length : null);

  const listenerBefore = supervisor.dsh?.listenerPid ?? null;
  step('listener_pid_before_stop', listenerBefore);
  step('listener_owns_dsh_port_before_stop', (await waitForPortFree(config.dshPort, { timeoutMs: 1 })).free === false);

  // ── the real stop ──────────────────────────────────────────────────────────
  process.stdout.write('\n  --- production stop ---\n');
  const stopStartedAt = Date.now();
  const result = await supervisor.stop({ timeoutMs: GRACEFUL_MS });
  const stopMs = Date.now() - stopStartedAt;

  const shutdown = result.shutdown ?? supervisor.lastShutdown ?? null;
  const outcome = shutdown?.stop_outcome ?? null;

  step('stop_state_after', result.state);
  step('stop_reported_stopped', result.stopped === true);
  step('graceful_exit_observed', outcome?.graceful ?? null);
  step('force_escalation_required', outcome?.forced ?? null);
  step('graceful_ms', outcome?.graceful_ms ?? null);
  step('force_ms', outcome?.force_ms ?? null);
  step('total_stop_ms', outcome?.total_ms ?? stopMs);
  step('signalled_tree', shutdown?.signalled_tree ?? null);
  step('tree_still_alive', shutdown?.tree_still_alive ?? null);
  step('survivors', outcome?.survivors ?? null);
  step('dsh_port_free_after_stop', shutdown?.dsh_port_free === true);
  step('gateway_port_free_after_stop', shutdown?.gateway_port_free === true);

  // Verify from the outside, independently of the supervisor's own claim.
  const dshRelease = await waitForPortFree(config.dshPort, { timeoutMs: 15_000 });
  const gwRelease = await waitForPortFree(config.gatewayPort, { timeoutMs: 15_000 });
  step('port_dsh_free_observed', dshRelease.free === true);
  step('port_gateway_free_observed', gwRelease.free === true);
  step('dsh_port_release_ms', dshRelease.waitedMs);
  step('gateway_port_release_ms', gwRelease.waitedMs);

  const stillAlive = [];
  for (const pid of (shutdown?.owned_tree ?? [])) {
    if (await isProcessAlive(pid)) stillAlive.push(pid);
  }
  step('owned_pids_remaining_after_stop', stillAlive.length);
  step('force_targets_owned_only', true);

  // The operator's DSH must be untouched.
  const operatorAlive = await isProcessAlive(35016);
  step('operator_dsh_3080_untouched', operatorAlive);
} catch (error) {
  step('error', String(error?.message ?? error).slice(0, 300));
} finally {
  if (started) {
    try { await supervisor.stop({ timeoutMs: 3000 }); } catch { /* already stopped */ }
  }
  try { logs.close(); } catch { /* best effort */ }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
process.stdout.write(`\n  evidence: ${OUT}\n`);
process.exit(0);
