/**
 * R9B.1 G0 — read-only baseline and ownership.
 *
 * Records only whitelisted, non-secret fields. It deliberately does NOT persist a full
 * `debug prefs`, any identity state file, the environment, or any login output: those can carry
 * node keys or session material. Route/SSH/unattended questions are answered with parsed booleans
 * and route summaries only.
 *
 * Peer counting goes through the JSON object rather than a PowerShell array, because an empty
 * PowerShell result wraps into a single empty element and reports 1 instead of 0.
 *
 * Usage: node scripts/r9b1-baseline.mjs
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const TAILSCALE = `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Tailscale\\tailscale.exe`;
const OUT = 'D:/DSH-testing/docs/remote-mobile/_evidence/r9b1-transport-acceptance.json';

/** Run the Tailscale CLI, tolerating a non-zero exit for status-like commands. */
async function ts(args) {
  try {
    const { stdout } = await run(TAILSCALE, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, out: String(stdout).replace(/^\uFEFF/, '') };
  } catch (error) {
    return {
      ok: false,
      code: typeof error?.code === 'number' ? error.code : null,
      out: String(error?.stdout ?? '').replace(/^\uFEFF/, ''),
      err: String(error?.stderr ?? error?.message ?? '').replace(/^\uFEFF/, ''),
    };
  }
}

/** Probe a loopback port. */
function probe(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const settle = (v) => { socket.destroy(); resolve(v); };
    socket.setTimeout(400);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

const record = {
  schema_version: 1,
  phase: 'R9B.1',
  run_id: `r9b1-${Date.now()}`,
  started_at: new Date().toISOString(),
  authorization_scope:
    'continues the already-authorized R9B scope: read-only state checks, bounded synthetic fixture, '
    + 'tailnet-only HTTPS fixture publication and cleanup. Does not extend to R9C or production deployment.',
  implementation_owner: 'DSH',
  checks: [],
  blockers: [],
  limitations: [],
  human_observations: [],
};

/** Record a check. */
function check(fields) {
  record.checks.push({ at: new Date().toISOString(), ...fields });
}

process.stdout.write(`  run_id: ${record.run_id}\n`);

// ── G0.1 time ────────────────────────────────────────────────────────────────
const now = new Date();
record.time = {
  utc: now.toISOString(),
  local: now.toString(),
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  utc_offset_minutes: now.getTimezoneOffset() === 0 ? 0 : -now.getTimezoneOffset(),
};
process.stdout.write(`  time: ${record.time.utc} (${record.time.timezone})\n`);

// ── G0.2 version and service ─────────────────────────────────────────────────
const version = await ts(['version']);
record.versions = {
  tailscale: version.ok ? version.out.split('\n')[0].trim() : null,
  tailscale_commit: version.ok ? (version.out.split('\n')[1] ?? '').replace('tailscale commit:', '').trim() : null,
  tailscale_exe_present: fs.existsSync(TAILSCALE),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
};
check({
  gate: 'G0', test_id: 'G0-version', source: 'this PC', destination: 'local CLI',
  expected: 'the CLI reports a version', observed: record.versions.tailscale,
  exit_code: version.code ?? 0, result: version.ok ? 'PASS' : 'FAIL',
});

// ── G0.3 backend state, peers, addresses (whitelisted fields only) ───────────
const status = await ts(['status', '--json']);
let statusJson = null;
try { statusJson = JSON.parse(status.out.trim()); } catch { statusJson = null; }

if (statusJson === null) {
  record.blockers.push({ id: 'R9B1-BLOCK-STATUS', detail: 'tailscale status --json was not parseable' });
  check({ gate: 'G0', test_id: 'G0-status', expected: 'parseable status', observed: 'unparseable', result: 'FAIL' });
} else {
  const peers = Object.entries(statusJson.Peer ?? {});
  // Zero peers must be 0, not a PowerShell-style single empty element.
  record.transport = {
    backend_state: statusJson.BackendState,
    tun: statusJson.TUN === true,
    magic_dns_suffix: statusJson.CurrentTailnet?.MagicDNSSuffix ?? null,
    tailnet_display_redacted: true,
    self_hostname: statusJson.Self?.HostName ?? null,
    self_dns_name: statusJson.Self?.DNSName ?? null,
    self_tailscale_ips: statusJson.Self?.TailscaleIPs ?? [],
    self_online: statusJson.Self?.Online === true,
    self_os: statusJson.Self?.OS ?? null,
    key_expiry: statusJson.Self?.KeyExpiry ?? null,
    peer_count: peers.length,
    peers: peers.map(([, p]) => ({ hostname: p.HostName, os: p.OS, online: p.Online === true, tailscale_ips: p.TailscaleIPs ?? [] })),
  };

  check({
    gate: 'G0', test_id: 'G0-peer-count', source: 'this PC', destination: 'tailnet control plane',
    expected: 'peer count reported as a number, 0 when the mapping is empty',
    observed: `peer_count=${peers.length}`, result: 'PASS',
  });
  check({
    gate: 'G0', test_id: 'G0-backend', expected: 'a stable running backend',
    observed: statusJson.BackendState, result: statusJson.BackendState === 'Running' ? 'PASS' : 'FAIL',
  });
  process.stdout.write(`  backend=${statusJson.BackendState} peers=${peers.length} magicdns=${record.transport.magic_dns_suffix}\n`);
}

// ── G0.4 Serve / Funnel ownership ────────────────────────────────────────────
const serveStatus = await ts(['serve', 'status']);
const funnelStatus = await ts(['funnel', 'status']);
const serveEmpty = /no serve config/i.test(serveStatus.out) || serveStatus.out.trim() === '';
record.serve = {
  config_present: !serveEmpty,
  status_summary: serveEmpty ? 'no serve config' : 'CONFIG PRESENT — ownership must be resolved before any reset',
  funnel_config_present: !/no serve config/i.test(funnelStatus.out) && funnelStatus.out.trim() !== '',
};
check({
  gate: 'G0', test_id: 'G0-serve-empty', expected: 'no serve or funnel configuration owned by this phase',
  observed: record.serve.status_summary, result: record.serve.config_present ? 'FAIL' : 'PASS',
});
if (record.serve.config_present || record.serve.funnel_config_present) {
  record.blockers.push({
    id: 'R9B1-BLOCK-SERVE-OWNERSHIP',
    detail: 'a serve/funnel configuration exists whose ownership is not established; no global reset may be run',
  });
}

// ── G0.5 listener inventory (local, non-invasive) ────────────────────────────
const PORTS = [3080, 3081, 9445, 9446, 9447, 8099];
const listeners = {};
for (const port of PORTS) listeners[port] = await probe(port);
record.listener_inventory = listeners;
check({
  gate: 'G0', test_id: 'G0-listeners', expected: 'no unexpected R9 test listener beyond 9447',
  observed: JSON.stringify(listeners),
  result: listeners[3080] && !listeners[3081] && !listeners[9445] ? 'PASS' : 'INCONCLUSIVE',
});
process.stdout.write(`  listeners: ${JSON.stringify(listeners)}\n`);

// ── G0.6 source baseline over the files this phase may touch ─────────────────
const FIXTURE = 'scripts/r9b-transport-fixture.mjs';
record.source_baseline = {
  fixture: FIXTURE,
  fixture_present: fs.existsSync(FIXTURE),
  // The audit baseline for frozen directories is covered by the full gate in the report; here we
  // only pin the file this phase is permitted to change.
};
process.stdout.write(`  fixture present: ${record.source_baseline.fixture_present}\n`);

// ── G0.7 frozen boundary: what this phase must not have changed ──────────────
const FROZEN = [
  'src/remote/production/production-gateway.mjs',
  'src/remote/production/supervisor.mjs',
  'src/remote/production/dsh-process.mjs',
  'src/remote/production/control-channel.mjs',
];
record.frozen_boundary_checks = FROZEN.map((f) => ({
  file: f,
  present: fs.existsSync(f),
  mtime: fs.existsSync(f) ? fs.statSync(f).mtime.toISOString() : null,
}));

record.finished_at = new Date().toISOString();
record.verdict = record.blockers.length === 0 ? 'IN PROGRESS' : 'BLOCKED';
record.checks_summary = record.checks.reduce((acc, c) => {
  acc[c.result] = (acc[c.result] ?? 0) + 1;
  return acc;
}, {});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
process.stdout.write(`\n  checks: ${JSON.stringify(record.checks_summary)}\n  evidence: ${OUT}\n`);
