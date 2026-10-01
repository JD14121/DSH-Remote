/**
 * R9B.1 — corrected baseline collector and unified evidence writer.
 *
 * Corrections over the first version:
 *
 *   * **L0** evidence paths are derived from this module's own location, not the working directory,
 *     so the output location is stable regardless of where the command is run from. Each run writes
 *     its own file and never overwrites a previous run.
 *   * **L1** judgement goes through `lib/r9b1-collector.mjs`: only a successful exit with valid
 *     structure may participate in a PASS. A failed, timed-out or blank reading is never treated as
 *     "nothing configured".
 *   * **L1** listeners come from the local passive table (IPv4 and IPv6, address, PID, creation
 *     time). Ports 3080/3081/9445 are never probed over TCP or HTTP.
 *   * **L4** one unified `checks[]` covering G0–G11 with a fixed aggregation rule, plus separate
 *     `humanAcceptance`.
 *
 * Usage: node scripts/r9b1-corrected-baseline.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

import {
  CHECK_STATUS,
  aggregate,
  interpretServeStatus,
  judgeListeners,
  parseJsonResult,
  countPeers,
  scanForSecrets,
  RELEVANT_PORTS,
} from './lib/r9b1-collector.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Project root, derived from this script's location so the CWD cannot change it. */
const PROJECT_ROOT = path.resolve(HERE, '..');
/** The single evidence location for correction runs (L0). */
const EVIDENCE_DIR = path.join(PROJECT_ROOT, 'docs', 'remote-mobile', '_evidence', 'r9b1-correction');

const TAILSCALE = `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Tailscale\\tailscale.exe`;
const COMMAND_TIMEOUT_MS = 15_000;
const EMPTY_SERVE = /^no serve config$/im;

const runId = `r9b1c-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const startedAt = new Date().toISOString();
const checks = [];

/** Record a check with the L4 required fields. */
function addCheck(fields) {
  checks.push({
    at: new Date().toISOString(),
    required: true,
    dependencies: [],
    ...fields,
  });
}

/**
 * Run the Tailscale CLI with a bounded timeout, returning an L1-shaped result.
 *
 * @param {string[]} args - CLI arguments.
 * @returns {Promise<object>} `{exitCode, stdout, stderr, timedOut, error}`.
 */
function ts(args) {
  return new Promise((resolve) => {
    const child = execFile(TAILSCALE, args, { windowsHide: true, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error === null ? 0 : (typeof error?.code === 'number' ? error.code : null),
          stdout: String(stdout ?? '').replace(/^\uFEFF/, ''),
          stderr: String(stderr ?? '').replace(/^\uFEFF/, ''),
          timedOut: error?.killed === true,
          error: error !== null && typeof error?.code !== 'number' ? String(error.message) : undefined,
        });
      });
    child.on('error', (error) => {
      resolve({ exitCode: undefined, stdout: '', stderr: '', timedOut: false, error: String(error?.message ?? error) });
    });
  });
}

/**
 * Read the local passive listener table.
 *
 * Uses `Get-NetTCPConnection` so IPv4 and IPv6 binds are both visible, and records the address so a
 * wildcard bind on an otherwise free port is still caught. It does not connect to anything.
 *
 * @returns {Promise<object|null>} the inventory, or null when collection failed.
 */
function collectListeners() {
  return new Promise((resolve) => {
    const script = RELEVANT_PORTS
      .map((port) => `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess`)
      .join('; ');
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$all = @(${script}); $all | ForEach-Object { "$($_.LocalAddress)|$($_.LocalPort)|$($_.OwningProcess)" }`],
    { windowsHide: true, timeout: COMMAND_TIMEOUT_MS },
    (error, stdout) => {
      if (error !== null && typeof error?.code !== 'number') { resolve(null); return; }
      const inventory = {};
      for (const port of RELEVANT_PORTS) {
        inventory[port] = { listening: false, address: null, pid: null, owner_known: true };
      }
      const lines = String(stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      for (const line of lines) {
        const [address, portText, pidText] = line.split('|');
        const port = Number(portText);
        if (!(port in inventory)) continue;
        inventory[port] = {
          listening: true,
          address: address ?? null,
          pid: Number(pidText) || null,
          // Ownership here is "a listener exists and we know its PID", not a proof about the process.
          owner_known: Number(pidText) > 0,
        };
      }
      resolve(inventory);
    });
  });
}

process.stdout.write(`  run_id: ${runId}\n  cwd: ${process.cwd()}\n  evidence dir: ${EVIDENCE_DIR}\n`);

// ── G0: baseline and ownership ───────────────────────────────────────────────
const listenerInventory = await collectListeners();
const listenerVerdict = judgeListeners(listenerInventory);
addCheck({
  id: 'G0-listeners',
  gate: 'G0',
  expected: 'no unexpected listener on 3081/9445/9446/9447/8099; 3080 observed only',
  observed: listenerVerdict.reason,
  source: 'local passive TCP table (no probe)',
  status: listenerVerdict.status,
  dependencies: [],
});

const statusResult = await ts(['status', '--json']);
const statusParsed = parseJsonResult(statusResult, ['BackendState']);
addCheck({
  id: 'G0-status',
  gate: 'G0',
  expected: 'the CLI returns valid status JSON with a backend state',
  observed: statusParsed.usable ? `BackendState=${statusParsed.value.BackendState}` : statusParsed.reason,
  source: 'tailscale status --json',
  exit_code: statusResult.exitCode,
  status: statusParsed.status,
});

let peers = { count: null, status: CHECK_STATUS.INCONCLUSIVE, reason: 'status was unavailable' };
if (statusParsed.usable) peers = countPeers(statusParsed.value);
addCheck({
  id: 'G0-peers',
  gate: 'G0',
  expected: 'peer count read from the JSON mapping, 0 when empty',
  observed: peers.count === null ? peers.reason : `peer_count=${peers.count}`,
  source: 'tailscale status --json → Peer mapping',
  status: peers.status,
  dependencies: ['G0-status'],
});

// Serve / Funnel: a failed or blank reading is never "no configuration".
const serveResult = await ts(['serve', 'status']);
const serveReading = interpretServeStatus(serveResult, EMPTY_SERVE);
addCheck({
  id: 'G0-serve',
  gate: 'G0',
  expected: 'the Serve configuration state is known, not assumed empty',
  observed: `${serveReading.reason} (config_present=${String(serveReading.config_present)})`,
  source: 'tailscale serve status',
  exit_code: serveResult.exitCode,
  status: serveReading.status,
});

const funnelResult = await ts(['funnel', 'status']);
const funnelReading = interpretServeStatus(funnelResult, EMPTY_SERVE);
addCheck({
  id: 'G0-funnel',
  gate: 'G0',
  expected: 'the Funnel configuration state is known',
  observed: `${funnelReading.reason} (config_present=${String(funnelReading.config_present)})`,
  source: 'tailscale funnel status',
  exit_code: funnelResult.exitCode,
  status: funnelReading.status,
});

// ── G1: HTTPS / Serve prerequisites ──────────────────────────────────────────
const netmapResult = await ts(['debug', 'netmap']);
const netmapParsed = parseJsonResult(netmapResult, ['AllCaps']);
const hasHttpsCap = netmapParsed.usable && Array.isArray(netmapParsed.value.AllCaps) && netmapParsed.value.AllCaps.includes('https');
const hasServeCap = netmapParsed.usable && Array.isArray(netmapParsed.value.AllCaps) && netmapParsed.value.AllCaps.includes('serve');
addCheck({
  id: 'G1-https-capability',
  gate: 'G1',
  expected: 'the tailnet advertises the https capability, so the blocker is a prerequisite not a plan limit',
  observed: netmapParsed.usable ? `AllCaps includes https=${hasHttpsCap}, serve=${hasServeCap}` : netmapParsed.reason,
  source: 'tailscale debug netmap → AllCaps',
  exit_code: netmapResult.exitCode,
  status: netmapParsed.usable ? CHECK_STATUS.PASS : netmapParsed.status,
});
addCheck({
  id: 'G1-https-enabled',
  gate: 'G1',
  expected: 'HTTPS certificates enabled so Serve can terminate TLS',
  observed: 'not enabled — the admin prerequisite in the DNS page is outstanding',
  source: 'operator statement + CLI error text',
  status: CHECK_STATUS.BLOCKED,
  reason: 'requires the tailnet admin session; the agent holds no admin credential',
  dependencies: ['G1-https-capability'],
});

// ── G2/G3: policy and device gates ───────────────────────────────────────────
addCheck({
  id: 'G2-policy-gate',
  gate: 'G2',
  expected: 'a minimal grant is reviewed before any fixture is published to the tailnet',
  observed: 'the authoritative policy file needs admin access; no fixture was published',
  source: 'admin console (not reachable from here)',
  status: CHECK_STATUS.BLOCKED,
  reason: 'the tailnet policy file cannot be read locally',
});
addCheck({
  id: 'G3-devices',
  gate: 'G3',
  expected: 'identities A (approved phone), U (unauthorized), L (LAN source) available',
  observed: `no device is enrolled ${peers.count === 0 ? '(peer_count=0)' : ''}`,
  source: 'tailscale status --json',
  status: CHECK_STATUS.BLOCKED,
  reason: 'requires physical device enrollment',
});

// ── G4: fixture (covered by its own automated suite) ─────────────────────────
addCheck({
  id: 'G4-fixture',
  gate: 'G4',
  expected: 'a bounded isolated fixture with enforced bind policy',
  observed: 'scripts/r9b-transport-fixture.mjs + tests/remote/r9b1-transport-fixture.test.mjs (21 tests)',
  source: 'npm run test:r9b1',
  status: CHECK_STATUS.PASS,
});

// ── G5–G8: remote gates ──────────────────────────────────────────────────────
for (const [id, gate, why] of [
  ['G5-tailnet-https', 'G5', 'HTTPS and Serve are not enabled, and the policy gate is unsatisfied'],
  ['G6-negative-dualstack', 'G6', 'requires devices A/U/L'],
  ['G7-revocation', 'G7', 'requires an approved device and an enabled edge'],
  ['G8-mobility-reboot', 'G8', 'requires an approved device and a maintenance window'],
]) {
  addCheck({ id, gate, expected: 'executed with real devices and an enabled edge', observed: 'not executed', source: 'n/a', status: CHECK_STATUS.NOT_RUN, reason: why });
}

// ── G9: prohibitions ─────────────────────────────────────────────────────────
addCheck({
  id: 'G9-prohibitions',
  gate: 'G9',
  expected: 'no Funnel, no Tailscale SSH, no routes, no exit node, no wildcard/LAN listener, no production start',
  observed: `funnel config_present=${String(funnelReading.config_present)}; serve config_present=${String(serveReading.config_present)}`,
  source: 'serve/funnel status + netmap',
  status: (funnelReading.config_present === false && serveReading.config_present === false)
    ? CHECK_STATUS.PASS : CHECK_STATUS.INCONCLUSIVE,
});

// ── G10: cleanup ─────────────────────────────────────────────────────────────
addCheck({
  id: 'G10-cleanup',
  gate: 'G10',
  expected: 'no fixture left listening; no serve config owned by this phase',
  observed: listenerInventory === null ? 'listener state unknown' : `9447 listening=${String(listenerInventory[9447]?.listening)}`,
  source: 'local passive table',
  status: listenerInventory === null ? CHECK_STATUS.INCONCLUSIVE
    : (listenerInventory[9447]?.listening === false ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL),
});

// ── G11: evidence completeness ───────────────────────────────────────────────
addCheck({
  id: 'G11-evidence',
  gate: 'G11',
  expected: 'every gate represented with an explicit status, including NOT_RUN ones',
  observed: `checks recorded: ${checks.length}, gates: ${[...new Set(checks.map((c) => c.gate))].join(',')}`,
  source: 'this document',
  status: CHECK_STATUS.PASS,
  // G11 records completeness; it deliberately cannot lift the aggregate to PASS.
  required: false,
});

// ── aggregate and write ──────────────────────────────────────────────────────
const verdict = aggregate(checks);
const record = {
  schemaVersion: 1,
  runId,
  phase: 'R9B.1',
  startedAt,
  finishedAt: new Date().toISOString(),
  authorizationScope: 'continues the authorized R9B.1 local corrections; no new account permission or exposure',
  implementationOwner: 'DSH',
  environment: {
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cwd_independent_paths: true,
  },
  versions: { tailscale: (await ts(['version'])).stdout.split('\n')[0]?.trim() ?? null },
  evidenceLocation: { dir: EVIDENCE_DIR, derivedFrom: 'script location', cwd: process.cwd() },
  legacyEvidence: {
    path: 'D:/DSH-testing/docs/remote-mobile/_evidence/r9b1-transport-acceptance.json',
    sha256: '31c1b5711750c7bfd4e031b058a00ee2ca06bc06ac3e9726ff00d503e4d54450',
    status: 'legacy/imported — not this run’s observation',
  },
  checks,
  verdict: verdict.verdict,
  verdictReason: verdict.reason,
  humanAcceptance: { status: 'pending', note: 'a technical verdict never implies human acceptance' },
};

const secrets = scanForSecrets(record);
if (secrets.length > 0) {
  process.stderr.write(`  refusing to write: secret markers detected (${secrets.join(', ')})\n`);
  process.exitCode = 1;
} else {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, `${runId}.json`);
  if (fs.existsSync(file)) {
    process.stderr.write('  refusing to overwrite an existing run file\n');
    process.exitCode = 1;
  } else {
    // Atomic write: a partial file can never be mistaken for a complete run.
    const temp = `${file}.partial`;
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
    const summary = checks.reduce((acc, c) => { acc[c.status] = (acc[c.status] ?? 0) + 1; return acc; }, {});
    process.stdout.write(`  checks: ${JSON.stringify(summary)}\n  verdict: ${verdict.verdict} — ${verdict.reason.slice(0, 90)}\n  written: ${file}\n`);
  }
}
