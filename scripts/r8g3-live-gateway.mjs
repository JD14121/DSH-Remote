/**
 * R8G.3 — launch a live, operator-managed Gateway against a real DSH.
 *
 * ## What this does, and what it deliberately does not
 *
 * It starts the **Gateway only**. The R7 production Supervisor is never constructed: R7 still has
 * an open Windows lifecycle limitation, and §2 forbids starting the Supervisor merely to
 * manufacture a live stack.
 *
 * ## Why it spawns its own DSH instead of borrowing the operator's
 *
 * The runbook's preferred target is the operator's interactive DSH on `127.0.0.1:3080`. That DSH
 * cannot be used, for a reason that is structural rather than a matter of preference:
 *
 *   The DSH adapter authenticates with a `dsh-auth-<hash>` cookie, and that cookie can only be
 *   obtained by exchanging the **launch token** DSH prints to stdout when `dsh web` starts. The
 *   operator's DSH is already running, its launch token was consumed at startup, it is not
 *   persisted anywhere, and it is not visible in the process command line. So no cookie can be
 *   derived for it without restarting it — and restarting it would terminate the agent driving
 *   this phase, because that agent runs inside it.
 *
 *   The project says the same thing in its own words: `live-readonly-validation.mjs` returns
 *   `[DEFERRED] live listSessions — DEFERRED TO R7 — the supervisor owns credential bootstrap`.
 *
 * So this launcher starts a **second, independent DSH** with `--port 0` (the OS picks a free port)
 * and `--no-open`. That yields a genuine launch token with no restart, no interference with the
 * operator's DSH on 3080, and no Supervisor. Everything downstream is real: a real DSH, the real
 * `DshAdapter`, the real R3/R6 HTTP + WebSocket Gateway on `127.0.0.1:9445`.
 *
 * ## Isolation
 *
 * All Gateway state — persistence, logs, the phone credential — lives in an isolated root selected
 * by `DSH_REMOTE_DSH_HOME`, which is an existing supported configuration input, not a new
 * mechanism. The production root `D:\DSH-work-test\.dsh\remote` is never opened for writing.
 *
 * The child DSH uses the operator's `DSH_HOME` read-only-ish, so it serves the same session
 * inventory. That is the point: the acceptance exercises real DSH data.
 *
 * ## Credential handling
 *
 * The phone token is never printed. It is written to a file under the isolated root, and only the
 * path is reported.
 *
 * Usage:
 *   node scripts/r8g3-live-gateway.mjs                 # start and stay resident
 *   node scripts/r8g3-live-gateway.mjs --state-root <dir>
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { R7_ERROR, resolveProductionConfig, prepareProductionRoot, ProductionError } from '../src/remote/production/production-config.mjs';
import { CredentialStore, creationNotice } from '../src/remote/production/credential-store.mjs';
import { hardenAcl, verifyAcl } from '../src/remote/production/windows-acl.mjs';
import {
  ANNOUNCE_PREFIX,
  CookieAuthProvider,
  exchangeLaunchToken,
  firstTokenFrom,
  verifyCookie,
} from '../src/remote/production/dsh-bootstrap.mjs';
import { startProductionGateway } from '../src/remote/production/production-gateway.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DSH_BIN = 'C:\\Users\\YOURNAME\\AppData\\Local\\npm-cache\\_c40503fdf38a82ea\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
const DSH_BIN_REAL = 'C:\\Users\\YOURNAME\\AppData\\Local\\npm-cache\\_npx\\c40503fdf38a82ea\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
const OPERATOR_DSH_HOME = 'D:\\DSH-work-test\\.dsh';
const DEFAULT_STATE_ROOT = 'D:\\DSH-testing\\.dsh-r8g3';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const STATE_ROOT = path.resolve(flag('--state-root', DEFAULT_STATE_ROOT));
const BOOTSTRAP_TIMEOUT_MS = Number(flag('--timeout-ms', '60000'));

/** Collected, secret-free facts, written to the evidence file at the end. */
const evidence = {
  phase: 'R8G.3',
  owner: 'DSH',
  production_supervisor_started: false,
  gateway_bind: '127.0.0.1',
  gateway_port: 9445,
  isolated_state_root: STATE_ROOT,
  operator_dsh_home_used_by_child: OPERATOR_DSH_HOME,
  production_root_written: false,
  dsh_spawn: null,
  events: [],
};

/** Record a timestamped, secret-free event. */
function note(event, fields = {}) {
  const entry = { at: new Date().toISOString(), event, ...fields };
  evidence.events.push(entry);
  const detail = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ');
  process.stdout.write(`[${entry.at}] ${event}${detail ? ` — ${detail}` : ''}\n`);
}

/**
 * Wait for the DSH child to announce its authority and launch token.
 *
 * The announcement is a stdout line beginning `dsh web:`, optionally followed by a LAN line. The
 * token is read from the URL exactly once and is never logged.
 *
 * @param {import('node:child_process').ChildProcess} child - the DSH process.
 * @returns {Promise<{port: number, launchToken: string}>} the parsed announcement.
 */
function awaitAnnouncement(child) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(new Error(`DSH did not announce within ${BOOTSTRAP_TIMEOUT_MS} ms`));
    }, BOOTSTRAP_TIMEOUT_MS);

    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      // Process complete lines only; the announcement is newline-terminated.
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line.startsWith(ANNOUNCE_PREFIX)) continue;
        const token = firstTokenFrom(line.slice(ANNOUNCE_PREFIX.length));
        // Parse the URL rather than pattern-match the port. An earlier `[^\s/]+(?::(\d+))?`
        // never captured the group: the character class already consumes the colon, so the port
        // came back `undefined` and became `NaN`. `new URL` cannot make that mistake.
        let parsed = null;
        try {
          parsed = new URL(/https?:\/\/\S+/.exec(line)?.[0] ?? '');
        } catch {
          parsed = null;
        }
        const port = parsed === null ? Number.NaN : Number(parsed.port);
        if (token === null || !Number.isInteger(port) || port <= 0) continue;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve({ port, launchToken: token });
        return;
      }
    };

    child.stdout.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`DSH exited with code ${code} before announcing`));
    });
  });
}

/** Stop a child process and wait for it to actually exit. */
async function stopChild(child) {
  if (child === null || child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    // Only this verified, owned PID is signalled. No `taskkill /IM node.exe`, ever.
    child.kill();
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000);
  });
}

// ── 1. isolate the state root ────────────────────────────────────────────────
// `DSH_REMOTE_DSH_HOME` is the existing configuration input for the root; `resolveProductionConfig`
// joins `remote` onto it. Nothing about the production root is touched.
const config = resolveProductionConfig({ dshHome: STATE_ROOT });
if (path.resolve(config.paths.root) === path.resolve('D:\\DSH-work-test\\.dsh\\remote')) {
  throw new Error('refusing to run: the resolved root is the production root');
}
process.stdout.write(`  isolated root : ${config.paths.root}\n`);
process.stdout.write(`  gateway       : ${config.gatewayHost}:${config.gatewayPort}\n`);

if (!fs.existsSync(config.paths.format)) {
  const created = await prepareProductionRoot({ config, harden: hardenAcl, verify: verifyAcl });
  note('state_root_created', { acl_verified: created.aclVerified === true });
} else {
  note('state_root_reused');
}

// ── 2. phone credential ──────────────────────────────────────────────────────
const store = new CredentialStore({ paths: config.paths, harden: hardenAcl, verify: verifyAcl });
// `ensure()` creates the credential on first use and is idempotent afterwards; `requireToken()`
// alone would throw, because it expects an already-loaded credential. The value is held in memory
// and written only to the protected file — never printed, never placed in the evidence.
const ensured = await store.ensure();
const phoneToken = store.requireToken();
const tokenHandoff = path.join(config.paths.root, 'r8g3-phone-token.txt');
fs.writeFileSync(tokenHandoff, `${phoneToken}\n`, { encoding: 'utf8', mode: 0o600 });
note('phone_credential_ready', {
  created: ensured.created === true,
  generation_id: ensured.generationId ?? null,
  handoff_file: tokenHandoff,
});
void creationNotice;

// ── 3. spawn an isolated DSH and bootstrap its cookie ────────────────────────
const dshBin = fs.existsSync(DSH_BIN_REAL) ? DSH_BIN_REAL : DSH_BIN;
note('dsh_spawn', { bin: dshBin, port: 0, no_open: true, note: 'a second, independent DSH; the operator DSH on 3080 is untouched' });

const dshChild = spawn(process.execPath, [dshBin, 'web', '--port', '0', '--no-open'], {
  cwd: ROOT,
  env: { ...process.env, DSH_HOME: OPERATOR_DSH_HOME },
  stdio: ['ignore', 'pipe', 'pipe'],
});
// DSH's own stderr can carry the launch token in some failure paths; it is dropped rather than
// captured. Nothing from this stream is logged.
dshChild.stderr.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  // Only genuine crash lines are surfaced, with any token-shaped value redacted.
  if (/error|throw|EADDRINUSE/i.test(text)) {
    process.stderr.write(`  dsh stderr: ${text.replace(/[A-Za-z0-9_-]{43}/g, '<redacted>').trim().slice(0, 200)}\n`);
  }
});

let announcement;
try {
  announcement = await awaitAnnouncement(dshChild);
} catch (error) {
  await stopChild(dshChild);
  process.stderr.write(`\n  R8G.3 BLOCKED — SAFE LIVE GATEWAY LAUNCH PATH NOT AVAILABLE\n  ${error.message}\n`);
  process.exit(2);
}

note('dsh_announced', { port: announcement.port, launch_token_shape_valid: true });

const bootstrap = await exchangeLaunchToken({
  port: announcement.port,
  launchToken: announcement.launchToken,
  host: '127.0.0.1',
});
const verified = await verifyCookie({
  cookie: bootstrap.cookie,
  cookieName: bootstrap.cookieName,
  port: announcement.port,
  host: '127.0.0.1',
});
if (!verified.ok) {
  await stopChild(dshChild);
  throw new ProductionError(R7_ERROR.DSH_AUTH_BOOTSTRAP_FAILED, `cookie verification returned ${verified.status}`);
}
note('cookie_bootstrapped', { exchange_status: bootstrap.status, verify_status: verified.status });

const authProvider = new CookieAuthProvider({
  cookie: bootstrap.cookie,
  cookieName: bootstrap.cookieName,
  authority: `127.0.0.1:${announcement.port}`,
  obtainedAt: new Date().toISOString(),
});
evidence.dsh_spawn = { port: announcement.port, host: '127.0.0.1', pid: dshChild.pid };

// The Gateway must talk to the DSH this launcher spawned, not the configured production port.
// `createProductionAdapter` builds its authority as `${config.dshHost}:${config.dshPort}`, so the
// child's announced port is threaded through that single field.
const configForAdapter = { ...config, dshHost: '127.0.0.1', dshPort: announcement.port };

// ── 4. start the Gateway (no Supervisor) ─────────────────────────────────────
const gateway = await startProductionGateway({
  config: configForAdapter,
  credential: store,
  authProvider,
  onEvent: (event, fields) => {
    if (evidence.events.length < 200) evidence.events.push({ at: new Date().toISOString(), event, ...(fields ?? {}) });
  },
});
const address = gateway.address ?? {};
note('gateway_started', { host: address.host ?? config.gatewayHost, port: address.port ?? config.gatewayPort, pid: process.pid });
evidence.manual_gateway = true;
evidence.gateway_pid = process.pid;
evidence.real_dsh = true;
evidence.real_dsh_adapter = true;
evidence.dsh_version = config.dshVersion;

process.stdout.write('\n  live stack is up — the Gateway is ready for the read-only preflight\n');
process.stdout.write('  press Ctrl-C to stop\n\n');

// ── 5. orderly shutdown ──────────────────────────────────────────────────────
let stopping = false;
/** Stop the Gateway, then the child DSH, in that order. */
async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  note('shutdown_begin', { reason });
  try {
    const summary = await gateway.stop();
    note('gateway_stopped', {
      port_free: summary?.gateway_port_free === true,
      waited_ms: summary?.gateway_port_release_waited_ms ?? null,
    });
    evidence.gateway_stopped = true;
    evidence.gateway_port_free = summary?.gateway_port_free === true;
  } catch (error) {
    note('gateway_stop_failed', { message: error.message.slice(0, 120) });
  }
  await stopChild(dshChild);
  note('dsh_stopped', { pid: dshChild.pid });
  try { fs.rmSync(tokenHandoff, { force: true }); } catch { /* best effort */ }
  const evidencePath = 'D:/DSH-testing/docs/remote-mobile/_evidence/r8g3-launch.json';
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  evidence.finished_at = new Date().toISOString();
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`\n  evidence: ${evidencePath}\n`);
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
void os;
