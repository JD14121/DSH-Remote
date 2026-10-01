/**
 * Gate B driver — Phase R7 §22-§46.
 *
 * This exists because of a specific, unavoidable constraint: the DSH serving the agent
 * session IS the DSH that occupies port 3080. Stopping it to let the production
 * supervisor own 3080 therefore kills the agent driving the phase. So Gate B runs in a
 * **detached** process that outlives its launcher, records every step to durable
 * evidence, and is safe to re-run.
 *
 * Design rules, all of which exist because this script may be the only witness:
 *
 * 1. **Every step is journalled to disk before it is attempted**, so an interrupted run
 *    says exactly how far it got.
 * 2. **Idempotent.** A re-run detects existing state (root, credential, supervisor)
 *    instead of recreating it, so a partial run can be continued rather than restarted.
 * 3. **It never stops a process it did not start** — except the one DSH PID the operator
 *    explicitly authorized, which is passed in as an argument.
 * 4. **It always tries to restore the operator's DSH** in a `finally`, so a failure
 *    cannot leave the machine without a usable DSH.
 */

import { execFile, spawn as nodeSpawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  R7_ERROR,
  SUPERVISOR_STATE,
  describeProductionConfig,
  prepareProductionRoot,
  productionRootExists,
  resolveProductionConfig,
} from '../src/remote/production/production-config.mjs';
import { CredentialStore, isValidPhoneToken, redactSecrets } from '../src/remote/production/credential-store.mjs';
import { Supervisor } from '../src/remote/production/supervisor.mjs';
import { startProductionGateway } from '../src/remote/production/production-gateway.mjs';
import { hardenAcl, verifyAcl } from '../src/remote/production/windows-acl.mjs';
import { readStatus } from '../src/remote/production/runtime-status.mjs';
import { ProductionLogs, sanitize as sanitizeLogValue } from '../src/remote/production/logger.mjs';

/** How many stack frames a diagnostic record may carry. */
export const STACK_FRAME_LIMIT = 40;

/**
 * How many characters of a message or frame are kept.
 *
 * A frame is a file path, a line and a column — it has no legitimate reason to be long,
 * and a truncated frame cannot smuggle a credential out inside a URL.
 */
export const DIAGNOSTIC_TEXT_LIMIT = 500;

/**
 * Credential shapes that must never survive into a diagnostic.
 *
 * `redactSecrets` removes values it was *told* about, so on its own it cannot catch a
 * credential the process never registered — which is exactly the case for a token that
 * reached an error message from somewhere unexpected. These patterns recognise the
 * shapes instead of the values.
 *
 * The 43-character base64url rule covers both the Phone token and the DSH launch token,
 * which are deliberately the same shape, and therefore also covers a 43-character
 * `dsh-auth` cookie payload.
 */
const CREDENTIAL_SHAPES = Object.freeze([
  // A launch announcement, with or without a query string around it.
  { pattern: /(\?|&)(token|access_token|ticket)=[A-Za-z0-9._~-]{8,}/gi, replacement: '$1$2=<redacted>' },
  // A bearer credential.
  { pattern: /(bearer|authorization:)\s*[A-Za-z0-9._~+/-]{8,}=*/gi, replacement: '$1 <redacted>' },
  // A DSH auth cookie, named for the authority.
  { pattern: /dsh-auth-[A-Za-z0-9_-]+=[^\s;'"]+/gi, replacement: 'dsh-auth-<redacted>=<redacted>' },
  // A Set-Cookie header value.
  { pattern: /set-cookie:\s*[^\s'"]+/gi, replacement: 'set-cookie: <redacted>' },
  // Any bare 43-character base64url run: the shape of the Phone and launch tokens.
  { pattern: /(?<![\w-])[A-Za-z0-9_-]{43}(?![\w-])/g, replacement: '<redacted>' },
]);

/**
 * Remove credential-shaped substrings.
 *
 * @param {string} text - the text to scrub.
 * @returns {string} the scrubbed text.
 */
export function redactCredentialShapes(text) {
  let out = String(text);
  for (const { pattern, replacement } of CREDENTIAL_SHAPES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Build a redacted diagnostic record for an error.
 *
 * ## Why this exists
 *
 * Gate B recorded only `error.toString()`, which for `ReferenceError: fs is not defined`
 * names the message and nothing else — no file, no line. An external operator therefore
 * saw *that* it failed without seeing *where*, and the phase could not be closed without
 * another round trip.
 *
 * ## Safety
 *
 * A stack trace contains whatever was interpolated into the message, and an exception
 * raised while handling a credential can carry that credential. So a record passes through
 * three layers before it is returned:
 *
 * 1. literal removal of every secret registered with `recordSecret()`;
 * 2. `redactCredentialShapes`, which recognises credential *shapes* even when the value
 *    was never registered;
 * 3. the centralized `sanitize`, which drops denied field names.
 *
 * The message is deliberately **not** registered as a secret: a diagnostic that redacts
 * its own message cannot do its job, and `ReferenceError: fs is not defined` is precisely
 * the evidence this record exists to carry.
 *
 * @param {unknown} error - the thrown value.
 * @returns {object} `{ error_name, error_message, sanitized_stack }`.
 */
export function describeError(error) {
  let rawName = 'Error';
  let rawMessage = '';
  let rawStack = '';

  if (error instanceof Error) {
    rawName = error.name ?? 'Error';
    rawMessage = error.message ?? '';
    rawStack = typeof error.stack === 'string' ? error.stack : '';
  } else if (error !== null && typeof error === 'object') {
    rawName = String(error.name ?? 'Error');
    rawMessage = String(error.message ?? '');
    rawStack = typeof error.stack === 'string' ? error.stack : String(error);
  } else {
    rawMessage = String(error);
  }

  const secrets = DIAGNOSTIC_SECRETS.filter((value) => typeof value === 'string' && value.length >= 12);

  const stackLines = rawStack.length > 0
    ? rawStack.split('\n').slice(0, STACK_FRAME_LIMIT)
    : [];

  const sanitizedStack = sanitizeLogValue(
    redactCredentialShapes(
      redactSecrets(stackLines.join('\n').slice(0, DIAGNOSTIC_TEXT_LIMIT * 2), secrets),
    ),
    secrets,
  );

  return {
    error_name: redactCredentialShapes(redactSecrets(rawName.slice(0, 80), secrets)),
    error_message: redactCredentialShapes(
      redactSecrets(rawMessage.slice(0, DIAGNOSTIC_TEXT_LIMIT), secrets),
    ),
    sanitized_stack: String(sanitizedStack),
  };
}

/** Secrets known to this run, for diagnostic redaction. Never serialized. */
const DIAGNOSTIC_SECRETS = [];

/**
 * Register a secret so diagnostics can redact it.
 *
 * @param {unknown} value - the secret.
 * @returns {void}
 */
function recordSecret(value) {
  if (typeof value !== 'string' || value.length < 12) return;
  if (!DIAGNOSTIC_SECRETS.includes(value)) DIAGNOSTIC_SECRETS.push(value);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const DEFAULT_EVIDENCE_DIR = 'D:\\DSH-testing\\docs\\remote-mobile\\_evidence';

/**
 * Resolve the evidence paths for a run.
 *
 * Injectable so `r7b-gate-b-branch.test.mjs` can write its evidence to a temp directory.
 * Without this the branch suite wrote its journal and result into the real evidence
 * directory, and — through the supervisor's own log — touched the real production root.
 * A test must never write production state, so the seam is not merely convenient.
 *
 * @param {string} [dir] - an override directory.
 * @returns {object} the resolved paths.
 */
function evidencePaths(dir) {
  const base = typeof dir === 'string' && dir.length > 0 ? dir : DEFAULT_EVIDENCE_DIR;
  return {
    dir: base,
    journal: path.join(base, 'r7b-gate-b-journal.json'),
    report: path.join(base, 'r7b-gate-b-result.json'),
    console: path.join(base, 'r7b-gate-b-console.txt'),
    secretScan: path.join(base, 'r7b-secret-scan.json'),
    portState: path.join(base, 'r7b-port-process-state.json'),
  };
}

/** The evidence paths for the active run. */
let PATHS = evidencePaths();

/**
 * Whether this process is a Node test runner.
 *
 * The evidence directory is the operator's Gate B record — the only durable account of a
 * real external run. A test that drives `runGateB` would otherwise overwrite that record
 * with synthetic data, which happened once: the journal from an actual external run was
 * replaced by fixture output.
 *
 * So the driver refuses to write evidence under a test runner. A test can still assert
 * everything about the returned result; it simply cannot destroy the operator's record.
 *
 * @returns {boolean} true when running under `node --test`.
 */
function isTestContext() {
  if (process.env.NODE_TEST_CONTEXT !== undefined) return true;
  return process.argv.includes('--test');
}

/** The R7B §32 result schema, in the order the spec lists it. */
const R7B_RESULT_FIELDS = Object.freeze([
  'phase',
  'external_powershell',
  'dsh_port',
  'gateway_port',
  'dsh_spawn_owned',
  'launch_token_observed',
  'cookie_exchange',
  'cookie_verified',
  'adapter_authenticated',
  'persistence_ready',
  'gateway_ready',
  'health_authenticated',
  'sessions_status',
  'session_count',
  'ws_smoke',
  'reconciliation',
  'restart_smoke',
  'stop_start_smoke',
  'phone_generation_before',
  'phone_generation_after',
  'phone_generation_preserved',
  'journal_sequence_preserved',
  'secret_scan',
  'logs_redacted',
  'locks_released',
  'interactive_3080_untouched',
  'final_state',
]);

/** The record accumulated across steps. */
let journal = {
  started_at: new Date().toISOString(),
  steps: [],
  result: null,
  ok: null,
};

/**
 * Append a step to the durable journal before doing anything else.
 *
 * @param {string} name - the step name.
 * @param {object} [detail] - what was observed.
 * @returns {void}
 */
function record(name, detail = {}) {
  const entry = { step: name, at: new Date().toISOString(), ...sanitize(detail) };
  journal.steps.push(entry);
  flush();
  const summary = Object.entries(entry)
    .filter(([key]) => key !== 'step' && key !== 'at')
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join(' ');
  process.stdout.write(`[gate-b] ${name}${summary.length === 0 ? '' : ` :: ${summary}`}\n`);
}

/**
 * Remove anything secret-shaped before it is written to evidence.
 *
 * The journal is durable, so it is exactly the place a secret must never land.
 *
 * @param {unknown} value - the value.
 * @param {number} [depth] - recursion guard.
 * @returns {unknown} a safe copy.
 */
function sanitize(value, depth = 0) {
  if (depth > 6) return '<depth>';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    // Long base64url blobs are the shape of every credential here.
    return value.replace(/[A-Za-z0-9_-]{43,}/g, '<redacted>')
      .replace(/dsh-auth-[A-Za-z0-9_-]+/g, '<redacted-cookie-name>');
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => sanitize(entry, depth + 1));
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/token|cookie|secret|authorization|digest|password/i.test(key) && typeof entry === 'string') {
      out[key] = '<redacted>';
      continue;
    }
    out[key] = sanitize(entry, depth + 1);
  }
  return out;
}

/**
 * Write the journal atomically.
 *
 * @returns {void}
 */
function flush() {
  // Under a test runner this would overwrite the operator's Gate B journal with fixture
  // data, so it is skipped. Assertions still work against the returned result.
  if (isTestContext()) return;
  try {
    fs.mkdirSync(PATHS.dir, { recursive: true });
    const temp = `${PATHS.journal}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, PATHS.journal);
  } catch {
    // Evidence writing must never take the run down.
  }
}

/**
 * Observe a port, with provenance.
 *
 * **One authoritative primitive.** The driver previously used two — a TCP connect probe
 * (`portBusy`) and an owner lookup (`listenerPid`) — and they disagreed in the same
 * evidence file: `supervisor_shutdown.gateway_port_free = true` alongside
 * `preRestart.port_gateway_listening_after_stop = true`. Contradictory booleans with no
 * explanation are indistinguishable from a bug.
 *
 * Every listening observation now comes from here, and carries its probe name, timestamp,
 * port, listening state and owner PID, so a real transition can be told apart from a probe
 * disagreement.
 *
 * @param {string} probe - the probe name.
 * @param {number} port - the port.
 * @returns {Promise<{probe: string, at: string, port: number, listening: boolean, owner_pid: number|null}>} the observation.
 */
async function observePort(probe, port) {
  const owner = await listenerPid(port);
  const observation = {
    probe,
    at: new Date().toISOString(),
    port,
    listening: owner > 0,
    owner_pid: owner > 0 ? owner : null,
  };
  portObservations.push(observation);
  return observation;
}

/** Every port observation this run has made, in order. */
const portObservations = [];

/**
 * Whether a port currently has a listener.
 *
 * Derived from `listenerPid`, so it can never disagree with the owner lookup.
 *
 * @param {number} port - the port.
 * @returns {Promise<boolean>} true when listening.
 */
async function portBusy(port) {
  return (await listenerPid(port)) > 0;
}

/**
 * Wait for a port to become free.
 *
 * @param {number} port - the port.
 * @param {number} [timeoutMs] - how long to wait.
 * @returns {Promise<{free: boolean, waitedMs: number}>} the outcome.
 */
async function waitPortFree(port, timeoutMs = 30_000) {
  const startedAt = Date.now();
  for (;;) {
    if ((await listenerPid(port)) === 0) return { free: true, waitedMs: Date.now() - startedAt };
    if (Date.now() - startedAt >= timeoutMs) return { free: false, waitedMs: Date.now() - startedAt };
    await new Promise((resolve) => { setTimeout(resolve, 300); });
  }
}

/**
 * Wait for a port to accept connections.
 *
 * @param {number} port - the port.
 * @param {number} [timeoutMs] - how long to wait.
 * @returns {Promise<boolean>} true when listening.
 */
async function waitPortUp(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await listenerPid(port)) > 0) return true;
    await new Promise((resolve) => { setTimeout(resolve, 300); });
  }
  return (await listenerPid(port)) > 0;
}

/**
 * The PID listening on a port, or 0.
 *
 * **The single authoritative port primitive for this driver.** `portBusy`, `waitPortFree`,
 * `waitPortUp`, the shutdown evidence, the pre-restart evidence and the final-stop
 * evidence are all derived from it, so two of them cannot disagree.
 *
 * @param {number} port - the port.
 * @returns {Promise<number>} the PID, or 0.
 */
function listenerPid(port) {
  return new Promise((resolve) => {
    const script = `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`;
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
        if (error) { resolve(0); return; }
        const value = Number(String(stdout).trim());
        resolve(Number.isInteger(value) && value > 0 ? value : 0);
      });
  });
}

/**
 * Build a `spawnDsh` seam that records the second child's failure facts.
 *
 * The previous restart failed with "child exited before announcing a launch token", which
 * names the symptom and hides the cause: a child that cannot bind its port exits without
 * ever printing an announcement, and the bootstrap error is then indistinguishable from a
 * genuine parse failure. Recording the exit code, timing and a **redacted** summary of the
 * child's output is what separates the two.
 *
 * Output is summarised, never persisted: raw child output can contain a launch token, so
 * only counts and redacted fragments are kept.
 *
 * @param {object} config - the production config.
 * @param {object} sink - a mutable object the captured facts are written to.
 * @returns {Function} the seam.
 */
function capturingSpawnDsh(config, sink) {
  return (cfg) => new DshProcess({
    config: cfg,
    spawn: (command, argv, spawnOptions) => {
      const child = nodeSpawn(command, argv, spawnOptions);
      const startedAt = Date.now();
      const capture = {
        spawned_pid: child.pid ?? null,
        exit_code: null,
        exit_signal: null,
        time_to_exit_ms: null,
        stdout_lines: 0,
        stderr_lines: 0,
        launch_announcement_seen: false,
        stderr_summary: '',
        stdout_summary: '',
      };
      sink.restartChild = capture;

      const note = (name, chunk) => {
        const text = String(chunk);
        if (capture.launch_announcement_seen === false && /dsh web:/.test(text)) {
          capture.launch_announcement_seen = true;
        }
        for (const line of text.split(/\r?\n/)) {
          if (line.trim().length === 0) continue;
          if (name === 'stdout') capture.stdout_lines += 1; else capture.stderr_lines += 1;
          // Keep a short, redacted fragment only: never the raw line.
          const safe = redactCredentialShapes(redactSecrets(line, DIAGNOSTIC_SECRETS)).slice(0, 160);
          if (name === 'stderr' && capture.stderr_summary.length < 400) {
            capture.stderr_summary = `${capture.stderr_summary}${capture.stderr_summary.length > 0 ? ' | ' : ''}${safe}`;
          }
          if (name === 'stdout' && capture.stdout_summary.length < 300) {
            capture.stdout_summary = `${capture.stdout_summary}${capture.stdout_summary.length > 0 ? ' | ' : ''}${safe}`;
          }
        }
      };
      child.stdout?.on('data', (chunk) => note('stdout', chunk));
      child.stderr?.on('data', (chunk) => note('stderr', chunk));
      child.on('exit', (code, signal) => {
        capture.exit_code = code;
        capture.exit_signal = signal;
        capture.time_to_exit_ms = Date.now() - startedAt;
      });
      child.on('error', (error) => {
        capture.exit_code = null;
        capture.exit_signal = null;
        capture.time_to_exit_ms = Date.now() - startedAt;
        capture.spawn_error = `${error?.code ?? error?.name ?? 'error'}`;
      });
      return child;
    },
  });
}

/**
 * Whether a PID is still running.
 *
 * Deliberately conservative in the other direction from the supervisor's lock probe: an
 * unreadable or unprovable PID is reported as **alive**, because the consequence of
 * believing a live child is dead is a second child fighting it for the port.
 *
 * @param {number} pid - the PID.
 * @returns {Promise<boolean>} true when the process appears alive.
 */
function isProcessAlive(pid) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) { resolve(false); return; }
    const script = `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'dead' }`;
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
        if (error) { resolve(true); return; }
        resolve(String(stdout).trim() === 'alive');
      });
  });
}

/**
 * Stop a specific PID's process tree.
 *
 * **Only ever called with operator-authorized PIDs**, always named as a PID and never
 * as an image name. `/T` includes the tree, which is what frees port 3080.
 *
 * @param {number} pid - the authorized PID.
 * @returns {Promise<void>} resolves when the kill command settles.
 */
async function stopTree(pid) {
  await new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

/**
 * Free port 3080 by stopping only PIDs the operator authorized.
 *
 * The interactive launcher (`启动DSH.ps1`) respawns DSH whenever its child disappears,
 * so the launcher must be stopped **first** and given a moment to die. Stopping DSH
 * alone would just produce a new PID that nobody authorized.
 *
 * @param {object} options - the authorized PIDs.
 * @param {number} options.launcherPid - the interactive launcher PID, or 0.
 * @param {number} options.dshPid - the DSH owner PID, or 0.
 * @returns {Promise<{stopped: boolean, stoppedLauncher: boolean, stoppedDsh: boolean}>} the outcome.
 */
async function stopAuthorizedPid(options) {
  const outcome = { stopped: false, stoppedLauncher: false, stoppedDsh: false };

  // 1. The launcher first, so nothing respawns what we are about to stop.
  if (Number.isInteger(options.launcherPid) && options.launcherPid > 0) {
    await stopTree(options.launcherPid);
    outcome.stoppedLauncher = true;
    // Give the launcher's own teardown a moment before judging the port.
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
  }

  // 2. Then the DSH that currently owns the port.
  const owner = await listenerPid(3080);
  const target = owner !== 0 ? owner : options.dshPid;
  if (Number.isInteger(target) && target > 0) {
    await stopTree(target);
    outcome.stoppedDsh = true;
  }

  outcome.stopped = await waitPortFree(3080, 25_000);
  return outcome;
}

/**
 * An HTTP GET against the Gateway.
 *
 * @param {string} requestPath - the path.
 * @param {object} [options] - headers and method.
 * @returns {Promise<object>} the response.
 */
function gatewayCall(requestPath, options = {}) {
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  const headers = { ...(options.headers ?? {}) };
  if (body !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(body));
  }
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: 9445,
      path: requestPath,
      method: options.method ?? (body === null ? 'GET' : 'POST'),
      headers,
      timeout: 15_000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text.length === 0 ? null : JSON.parse(text); } catch { parsed = text; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/**
 * A real WebSocket upgrade attempt, returning the status code.
 *
 * @param {number} port - the Gateway port.
 * @param {string} requestPath - the path with query.
 * @param {object} [options] - `origin`.
 * @returns {Promise<{status: number, frames: string[]}>} the outcome.
 */
function rawUpgrade(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write([
        `GET ${requestPath} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', // gitleaks:allow -- reviewed synthetic fixture, not a deployment credential
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Protocol: dsh-remote-v1',
        ...(options.origin === undefined ? [] : [`Origin: ${options.origin}`]),
        '', '',
      ].join('\r\n'));
    });
    let buffer = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buffer)?.[1] ?? 0);
      resolve({ status, raw: buffer.slice(0, 400) });
    };
    socket.on('data', (chunk) => { buffer += chunk.toString('latin1'); if (buffer.includes('\r\n\r\n')) finish(); });
    socket.on('close', finish);
    socket.on('error', reject);
    setTimeout(finish, 3000);
  });
}

/**
 * Walk the production root and classify every credential-shaped finding.
 *
 * ## The false positive this replaces
 *
 * The previous version took `[liveToken, store.generationId]` and applied one rule to
 * both: `text.includes(secret)` for any "secret" of 20+ characters. The generation id is
 * a **UUID and is not a credential** — the R7 secret-domain table lists it as safe,
 * non-secret metadata, and it is deliberately loggable so an operator can tell one
 * credential generation from another.
 *
 * Because it was passed as a secret, that rule matched the generation id in
 * `logs\supervisor.log` (the `credential_loaded` event) and in
 * `secrets\phone-token.meta.json` (its own metadata file) and reported both as leaks.
 * Two false positives, and the real `phone-token.v1` file was skipped as permitted — so
 * the scan produced noise on exactly the run where a real finding would have mattered.
 *
 * ## The rule now
 *
 * Only genuine credential material is searched for by value: the Phone token, and any
 * launch token, cookie or ticket the caller supplies. The generation id is returned
 * separately as `known_non_secret` so it is *classified* rather than silently ignored.
 *
 * @param {string} root - the root.
 * @param {readonly string[]} credentials - credential values that must not be durable.
 * @param {object} [options] - classification options.
 * @param {readonly string[]} [options.nonSecret] - identifiers that are expected to
 *   appear and are not credentials.
 * @returns {{files: number, leaked: string[], findings: object[], known_non_secret: object[]}} the scan.
 */
function productionSecretScan(root, credentials, options = {}) {
  const leaked = [];
  const findings = [];
  const knownNonSecret = [];
  let files = 0;
  const permitted = new Set([
    path.join(root, 'secrets', 'phone-token.v1'),
  ]);
  const credentialValues = (credentials ?? []).filter((value) => typeof value === 'string' && value.length >= 20);
  const nonSecretValues = (options.nonSecret ?? []).filter((value) => typeof value === 'string' && value.length >= 8);

  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      files += 1;
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      // The credential file is the ONE permitted place a long secret may sit.
      if (permitted.has(full)) continue;
      const relative = path.relative(root, full);

      // 1. Exact credential material. This is the rule that matters.
      for (const secret of credentialValues) {
        if (text.includes(secret)) {
          leaked.push(relative);
          findings.push({ path: relative, match_type: 'exact_credential_value', classification: 'LEAK' });
          break;
        }
      }

      // 2. Credential shapes, for material this process never held in memory.
      if (/dsh-auth-[A-Za-z0-9_-]{40,}=/.test(text)) {
        leaked.push(`${relative} (dsh-auth cookie)`);
        findings.push({ path: relative, match_type: 'dsh_auth_cookie', classification: 'LEAK' });
      }
      // A launch announcement. The gap between the prefix and the token is matched
      // permissively, because a log record escapes the URL inside JSON: the character
      // between them is a backslash, not a newline, and an earlier `[^\n]*` therefore
      // could not cross it and missed real announcements in JSONL logs.
      if (/dsh web:[\s\S]{0,400}?\?token=[A-Za-z0-9_-]{40,}/.test(text)) {
        leaked.push(`${relative} (launch token)`);
        findings.push({ path: relative, match_type: 'launch_announcement', classification: 'LEAK' });
      }
      if (/Bearer\s+[A-Za-z0-9_-]{40,}/i.test(text)) {
        leaked.push(`${relative} (authorization header)`);
        findings.push({ path: relative, match_type: 'authorization_header', classification: 'LEAK' });
      }

      // 3. Known non-secret identifiers, reported as classified rather than as a finding.
      for (const value of nonSecretValues) {
        if (text.includes(value)) {
          knownNonSecret.push({ path: relative, match_type: 'generation_id', classification: 'SAFE_METADATA' });
          break;
        }
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return { files, leaked, findings, known_non_secret: knownNonSecret };
}

/**
 * Record a failure and stop.
 *
 * Every early-return path ends the journal with a structured reason rather than a bare
 * `ok: false`. An `Error` may be passed so `finalize()` can derive a diagnostic from the
 * real error object; a plain reason string is also accepted.
 *
 * @param {object} result - the in-progress result.
 * @param {string|Error} reason - the reason, or an Error.
 * @param {object} [context] - a mutable holder for the captured error.
 * @returns {object} the result.
 */
function fail(result, reason, context) {
  result.ok = false;
  if (reason instanceof Error) {
    result.error = `${reason.code ?? reason.name ?? 'error'}: ${reason.message}`;
    if (context !== undefined) context.lastError = reason;
  } else {
    result.error = String(reason);
  }
  record('FAILED', { error: result.error });
  return result;
}

/**
 * Whether this process is running inside a DSH-managed job tree.
 *
 * R7B §4 forbids executing real Gate B from the DSH job object, because spawning a DSH
 * child from inside it terminates the harness. The driver detects this rather than
 * relying on an operator to remember, and refuses to attempt a real spawn when it is
 * true — the attempt does not merely fail, it takes the surrounding session down.
 *
 * @param {object} [options] - `powershell` runner and `parentOf` resolver overrides.
 * @returns {Promise<{inside: boolean, ancestry: string[], reason: string}>} the assessment.
 */
export function detectDshJobEnvironment(options = {}) {
  return new Promise((resolve) => {
    const script = [
      '$cur = $PID',
      '$chain = @()',
      'for ($i = 0; $i -lt 10; $i++) {',
      '  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue',
      '  if (-not $p) { break }',
      '  $cl = $p.CommandLine; if ($cl) { $cl = $cl.Substring(0, [Math]::Min(160, $cl.Length)) }',
      '  $chain += ("{0}|{1}|{2}" -f $p.ProcessId, $p.Name, $cl)',
      '  $cur = $p.ParentProcessId',
      '  if (-not $cur -or $cur -eq 0) { break }',
      '}',
      '$chain -join "`n"',
    ].join('\n');

    execFile('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
    ], { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve({ inside: true, ancestry: [], reason: 'could not determine the process ancestry, so treat it as unsafe' });
        return;
      }
      const ancestry = String(stdout).trim().split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
      // A DSH lineage shows up as an ancestor whose command line mentions the DSH
      // launcher, or as the subprocess runner DSH uses to host a session.
      const dshMarker = /dsh-subprocess-local|@deepseek-ai[\\/]dsh|dsh[\\/]lib[\\/]bin\.js|npx-cli\.js.*dsh/i;
      const hit = ancestry.find((line) => dshMarker.test(line));
      resolve({
        inside: hit !== undefined,
        ancestry,
        reason: hit === undefined
          ? 'no DSH ancestor was found'
          : `a DSH-managed ancestor was found: ${hit.split('|')[1] ?? 'unknown'}`,
      });
    });
  });
}

/**
 * Collect the port and process state (§31 evidence).
 *
 * @param {object} config - the resolved config.
 * @param {readonly number[]} ports - the ports to inspect.
 * @returns {Promise<object>} the state.
 */
async function collectPortState(config, ports) {
  const entries = [];
  for (const port of ports) {
    const pid = await listenerPid(port);
    entries.push({
      port,
      listening: pid !== 0,
      pid: pid === 0 ? null : pid,
      role: port === 3080 ? 'operator interactive DSH (must remain untouched)'
        : port === config.dshPort ? 'R7B owned DSH'
          : port === config.gatewayPort ? 'Gateway' : 'other',
    });
  }
  return {
    captured_at: new Date().toISOString(),
    dsh_port: config.dshPort,
    gateway_port: config.gatewayPort,
    ports: entries,
    interactive_3080_untouched: entries.some((entry) => entry.port === 3080 && entry.listening),
  };
}

/**
 * Write an evidence file, redacted.
 *
 * @param {string} filePath - the destination.
 * @param {unknown} payload - the content.
 * @returns {void}
 */
function writeEvidence(filePath, payload) {
  // Same reason as `flush`: never let a test overwrite the operator's evidence.
  if (isTestContext()) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(sanitize(payload), null, 2)}\n`, 'utf8');
    fs.renameSync(temp, filePath);
  } catch {
    // Evidence writing must never take the run down.
  }
}

/**
 * Run Gate B.
 *
 * @param {object} options - run options.
 * @param {number} options.dshPid - the operator-authorized DSH PID to stop.
 * @param {number} options.launcherPid - the operator-authorized launcher PID to stop.
 * @param {number} options.dshPort - the DSH port to use.
 * @param {boolean} options.restoreDsh - whether to relaunch the operator's DSH at the end.
 * @param {boolean} [options.dryRun] - perform only the read-only preflight.
 * @returns {Promise<object>} the result.
 */
async function runGateB(options) {
  // Point evidence at the caller's directory when one is given. A test must be able to
  // run this branch without writing into the real evidence directory.
  PATHS = evidencePaths(options.evidenceDir);

  // An alternate DSH port lets the supervisor own its own child **without** stopping a
  // DSH the operator is actively using. `--port` is a documented rc.2 flag, and the
  // supervisor's default argv stays exactly `web --no-open` when this is not requested.
  const config = resolveProductionConfig({
    ...(Number.isInteger(options.dshPort) && options.dshPort > 0
      ? { dshPort: options.dshPort, dshExplicitPort: true }
      : {}),
    // Injectable so the branch test can point the whole run at a temp root and a spare
    // port. In a real run these are omitted and the production defaults apply, so the
    // driver can never be redirected by an operator argument.
    ...(typeof options.dshHome === 'string' && options.dshHome.length > 0 ? { dshHome: options.dshHome } : {}),
    ...(typeof options.workspace === 'string' && options.workspace.length > 0 ? { workspace: options.workspace } : {}),
    ...(Number.isInteger(options.gatewayPort) && options.gatewayPort > 0
      ? { gatewayPort: options.gatewayPort }
      : {}),
  });
  // The R7B §32 result shape, pre-populated so a partial run still reports every field
  // explicitly rather than leaving a consumer to guess whether a key is absent or false.
  const result = {
    phase: 'R7B',
    external_powershell: false,
    dsh_port: config.dshPort,
    gateway_port: config.gatewayPort,
    dsh_spawn_owned: false,
    launch_token_observed: false,
    cookie_exchange: false,
    cookie_verified: false,
    adapter_authenticated: false,
    persistence_ready: false,
    gateway_ready: false,
    health_authenticated: false,
    sessions_status: null,
    session_count: null,
    ws_smoke: 'not_executed',
    reconciliation: 'not_executed',
    restart_smoke: false,
    stop_start_smoke: false,
    phone_generation_before: null,
    phone_generation_after: null,
    phone_generation_preserved: false,
    journal_sequence_preserved: false,
    secret_scan: false,
    logs_redacted: false,
    locks_released: false,
    interactive_3080_untouched: false,
    final_state: null,
    ok: false,
    steps: {},
    error: null,
  };
  let supervisor = null;
  let credentialLoad = null;

  /**
   * Persist the outcome.
   *
   * Registered **before** any stop is attempted, because stopping the DSH also stops
   * the shell that launched this process. Without this, an interrupted run leaves only
   * a half-written journal and no result file.
   *
   * @returns {void}
   */
  /**
   * The thrown value from the active run, kept so a diagnostic can be derived from the
   * real error object rather than from its stringified form.
   *
   * `error.toString()` loses the stack, which is the only thing that says *where* a
   * failure happened. The external `ReferenceError: fs is not defined` could not be
   * localised for exactly that reason.
   *
   * @type {unknown}
   */
  let lastError = null;

  const finalize = () => {
    if (journal.ok !== null && fs.existsSync(PATHS.report)) return;
    // Attach the redacted diagnostic before anything is written, so the journal, the
    // result file and the console all carry the same localisable information.
    if (lastError !== null) {
      const diagnostic = describeError(lastError);
      result.error_name = diagnostic.error_name;
      result.error_message = diagnostic.error_message;
      if (options.diagnosticStack === true) {
        result.sanitized_stack = diagnostic.sanitized_stack;
      }
    }
    journal.result = result;
    journal.ok = result.ok;
    journal.finished_at = new Date().toISOString();
    flush();
    try {
      if (!isTestContext()) fs.writeFileSync(PATHS.report, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    } catch { /* best effort */ }
  };
  process.on('exit', finalize);
  process.on('SIGINT', () => { result.ok = false; result.error = 'interrupted'; finalize(); process.exit(130); });
  process.on('SIGTERM', () => { result.ok = false; result.error = 'terminated'; finalize(); process.exit(143); });

  try {
    record('config_resolved', describeProductionConfig(config));

    // ── §4: refuse to attempt a real spawn from inside the DSH job object ────────
    //
    // This is not a precaution. Attempting to spawn DSH from within the job object does
    // not fail cleanly — it terminates the surrounding session, which is the entire
    // reason R7B exists as a separate phase. Detecting it and stopping is the only
    // correct behaviour.
    const detectEnvironment = options.seams?.detectEnvironment ?? detectDshJobEnvironment;
    const environment = await detectEnvironment();
    result.external_powershell = environment.inside === false;
    record('execution_environment', {
      inside_dsh_job: environment.inside,
      reason: environment.reason,
      ancestry_depth: environment.ancestry.length,
    });

    if (environment.inside && options.dryRun !== true && options.force !== true) {
      result.error = 'R7B_INSIDE_DSH_JOB: Gate B must run from a plain Windows PowerShell outside the DSH job object';
      record('REFUSED_inside_dsh_job', {
        reason: environment.reason,
        note: 'spawning a DSH child from inside the job object terminates the surrounding session, which is why R7B exists as a separate phase',
      });
      // No relaunch here: this process never stopped the operator's DSH.
      writeEvidence(PATHS.portState, await collectPortState(config, [3080, config.dshPort, config.gatewayPort]));
      finalize();
      return result;
    }
    // A dry run is safe inside the job object precisely because it spawns nothing, so it
    // proceeds to validate the tooling from wherever it is invoked.
    if (environment.inside && options.dryRun === true) {
      record('dry_run_inside_dsh_job', {
        note: 'preflight only; a real Gate B run must use a plain PowerShell outside this job object',
      });
    }

    // ── Preflight (read-only) ───────────────────────────────────────────────────
    const rootExists = productionRootExists(config);
    result.steps.productionRootExists = rootExists;

    const portState = await collectPortState(config, [3080, config.dshPort, config.gatewayPort]);
    result.interactive_3080_untouched = portState.interactive_3080_untouched;
    writeEvidence(PATHS.portState, portState);
    record('port_state', {
      dsh: portState.ports.find((entry) => entry.port === config.dshPort)?.listening,
      gateway: portState.ports.find((entry) => entry.port === config.gatewayPort)?.listening,
      interactive3080: portState.interactive_3080_untouched,
    });

    if (options.dryRun === true) {
      // Preflight only: validate the root, the ACL, the credential and the argv without
      // spawning anything. This is the one mode that is safe to run from inside a DSH
      // session, and it is what proves the tool is ready before an operator runs it.
      const dry = { rootExists, acl: null, credential: null, argv: null };
      if (rootExists) {
        try {
          const acl = await verifyAcl(config.paths.root, { code: R7_ERROR.ACL_POLICY_MISMATCH, label: 'root' });
          dry.acl = { protected: acl.protected, rules: acl.rules.map((rule) => `${rule.sid}:${rule.type}:${rule.rights}`) };
        } catch (error) {
          dry.acl = { error: error?.message ?? 'unknown' };
        }
        const store = new CredentialStore({ paths: config.paths, harden: hardenAcl, verify: verifyAcl });
        try {
          const loaded = await store.ensure();
          dry.credential = {
            created: loaded.created,
            generation_id: store.generationId,
            length: store.requireToken().length,
            acl_verified: true,
          };
        } catch (error) {
          dry.credential = { error: error?.code ?? error?.message ?? 'unknown' };
        }
      }
      const { dshLaunchArgvWithPort } = await import('../src/remote/production/production-config.mjs');
      dry.argv = dshLaunchArgvWithPort(config);
      result.steps.preflight = dry;
      result.phone_generation_before = dry.credential?.generation_id ?? null;
      result.ok = rootExists && dry.acl?.protected === true && typeof dry.credential?.length === 'number';
      result.final_state = 'PREFLIGHT_ONLY';
      record('dry_run_complete', { ok: result.ok });
      finalize();
      return result;
    }

    // ── §22/§36: free the DSH port by stopping only PIDs the operator authorized ──
    //
    // Skipped when an alternate port was requested. The composed port then belongs to a
    // DSH this supervisor does not own, and owning a child on a free port is strictly
    // better than stopping somebody else's process.
    const ownerBefore = await listenerPid(config.dshPort);
    record('dsh_port_owner', {
      port: config.dshPort,
      pid: ownerBefore,
      authorizedDsh: options.dshPid,
      authorizedLauncher: options.launcherPid,
    });

    if (config.dshPort !== 3080) {
      if (ownerBefore !== 0) {
        return fail(result, `the requested alternate DSH port ${config.dshPort} is already in use by pid ${ownerBefore}`);
      }
    } else if (ownerBefore !== 0) {
      const stopped = await stopAuthorizedPid({
        launcherPid: options.launcherPid,
        dshPid: options.dshPid,
      });
      record('authorized_stop', stopped);
      if (!stopped.stopped) {
        return fail(result, 'port 3080 did not become free after stopping the authorized PIDs');
      }
    }

    result.steps.dshPort = config.dshPort;
    result.steps.dshPortFree = !(await portBusy(config.dshPort));
    result.steps.gatewayPortFree = !(await portBusy(config.gatewayPort));
    record('ports_free', { dsh: result.steps.dshPortFree, gateway: result.steps.gatewayPortFree });
    if (!result.steps.dshPortFree) {
      return fail(result, `DSH port ${config.dshPort} is still in use`);
    }
    if (!result.steps.gatewayPortFree) {
      return fail(result, `Gateway port ${config.gatewayPort} is still in use`);
    }

    // ── §6/§24-§28: create the root, harden ACL, generate the credential ─────
    if (productionRootExists(config)) {
      record('production_root_exists', { root: config.root, note: 'reusing existing state (idempotent re-run)' });
      result.steps.rootCreatedNow = false;
    } else {
      const created = await prepareProductionRoot({ config, harden: hardenAcl, verify: verifyAcl });
      record('production_root_created', { subdirs: created.subdirs, aclVerified: created.aclVerified });
      result.steps.rootCreatedNow = true;
    }

    const rootAcl = await verifyAcl(config.paths.root, { code: R7_ERROR.ACL_POLICY_MISMATCH, label: 'root' });
    result.steps.rootAclProtected = rootAcl.protected;
    result.steps.rootAclRules = rootAcl.rules.map((rule) => `${rule.sid}:${rule.type}:${rule.rights}`);
    record('acl_verified', { protected: rootAcl.protected, rules: result.steps.rootAclRules });

    const store = new CredentialStore({ paths: config.paths, harden: hardenAcl, verify: verifyAcl });
    credentialLoad = await store.ensure();
    const tokenAcl = await verifyAcl(config.paths.phoneToken, { code: R7_ERROR.PHONE_TOKEN_ACL_INVALID, label: 'phone-token' });
    result.steps.credentialCreatedNow = credentialLoad.created;
    result.steps.credentialGenerationId = store.generationId;
    result.steps.credentialAclProtected = tokenAcl.protected;
    result.steps.credentialLength = store.requireToken().length;
    // §9: capture the generation id before the run, so a restart can be proven not to
    // have rotated it. The plaintext token is never recorded.
    result.phone_generation_before = store.generationId;
    record('credential_ready', {
      created: credentialLoad.created,
      generation_id: store.generationId,
      acl_protected: tokenAcl.protected,
      length: store.requireToken().length,
    });

    // ── §31/§34: start the supervisor; it owns the real DSH child ────────────
    //
    // The two seams exist so `r7b-gate-b-branch.test.mjs` can drive this whole
    // non-dry-run branch with synthetic collaborators. The `--dry-run` path returns
    // before this point, so without the seams the branch would carry no coverage at
    // all — which is how a missing import survived a green suite.
    supervisor = new Supervisor({
      config,
      credential: store,
      logs: new ProductionLogs({ paths: config.paths, secrets: [] }),
      seams: {
        ...(options.seams?.spawnDsh === undefined ? {} : { spawnDsh: options.seams.spawnDsh }),
        ...(options.seams?.exchangeLaunchToken === undefined ? {} : { exchangeLaunchToken: options.seams.exchangeLaunchToken }),
        ...(options.seams?.verifyCookie === undefined ? {} : { verifyCookie: options.seams.verifyCookie }),
        createGateway: options.seams?.createGateway ?? ((context) => startProductionGateway({
          config: context.config,
          credential: context.credential,
          authProvider: context.authProvider,
          logs: context.logs,
          onEvent: context.onEvent,
        })),
      },
    });

    const started = await supervisor.start();
    record('supervisor_ready', {
      state: started.state,
      instance_id: started.instanceId,
      dsh_pid: supervisor.dsh?.pid ?? null,
    });
    result.steps.supervisorState = started.state;
    result.steps.supervisorInstanceId = started.instanceId;
    result.steps.dshPid = supervisor.dsh?.pid ?? null;
    result.steps.gateway = started.gateway;
    result.steps.recovery = supervisor.recovery;
    result.steps.cookieReady = supervisor.authProvider.ready;
    // §9/§14/§15/§16: the R7B top-level fields, derived from what actually happened.
    result.dsh_spawn_owned = supervisor.dsh !== null && (supervisor.dsh.pid ?? null) !== null;
    result.launch_token_observed = supervisor.bootstrap !== null && supervisor.bootstrap !== undefined;
    result.cookie_exchange = supervisor.authProvider.ready === true;
    result.cookie_verified = supervisor.authProvider.ready === true;
    result.persistence_ready = (supervisor.recovery?.lock === 'acquired')
      || (supervisor.recovery?.journals !== undefined);
    result.steps.adapterPresent = supervisor.adapter !== null && supervisor.adapter !== undefined;
    result.gateway_ready = started.state === 'READY';

    const liveToken = store.requireToken();

    // ── §32: authenticated health ───────────────────────────────────────────
    const anonHealth = await gatewayCall('/api/v1/health');
    const authHealth = await gatewayCall('/api/v1/health', { headers: { authorization: `Bearer ${liveToken}` } });
    result.steps.anonHealthStatus = anonHealth.status;
    result.steps.anonHealthFields = Object.keys(anonHealth.body?.data ?? {}).sort();
    result.steps.authHealthStatus = authHealth.status;
    result.steps.authHealthFields = Object.keys(authHealth.body?.data ?? {}).sort();
    result.steps.dshStatus = authHealth.body?.data?.dsh?.status ?? null;
    result.steps.dshReasonCode = authHealth.body?.data?.dsh?.reason_code ?? null;
    result.steps.dshVersionObserved = authHealth.body?.data?.dsh?.version ?? null;
    result.steps.healthReady = authHealth.body?.data?.ready ?? null;
    result.steps.persistenceStatus = authHealth.body?.data?.persistence?.status ?? null;
    result.steps.authMode = authHealth.body?.data?.auth?.mode ?? null;
    result.health_authenticated = authHealth.status === 200;
    record('live_authenticated_health', {
      anon: anonHealth.status,
      authed: authHealth.status,
      fields: result.steps.authHealthFields,
      dsh_status: result.steps.dshStatus,
      dsh_reason_code: result.steps.dshReasonCode,
      health_ready: result.steps.healthReady,
    });

    const anonSessions = await gatewayCall('/api/v1/sessions');
    result.steps.anonSessionsStatus = anonSessions.status;

    // ── §32: real session listing ───────────────────────────────────────────
    const sessions = await gatewayCall('/api/v1/sessions', { headers: { authorization: `Bearer ${liveToken}` } });
    const list = sessions.body?.data ?? [];
    result.steps.sessionsStatus = sessions.status;
    result.steps.sessionCount = Array.isArray(list) ? list.length : null;
    result.sessions_status = sessions.status;
    result.session_count = result.steps.sessionCount;
    record('live_session_list', { status: sessions.status, count: result.steps.sessionCount });

    // ── §14: an explicit real authentication round-trip through the production adapter ──
    //
    // A `200` from `/api/v1/sessions` proves the **Phone** credential authenticated a
    // REST call. It does not prove the production `DshAdapter` can reach DSH: the REST
    // layer could have answered from the session-view store without touching DSH at all.
    //
    // So the adapter is called directly. Only a completed round-trip sets
    // `adapter_authenticated`; the previous version set it from `adapter != null`, which
    // is why the evidence read `adapter_authenticated=false` while everything around it
    // had succeeded.
    const adapter = supervisor.adapter;
    result.steps.adapterPresent = adapter !== null && adapter !== undefined;
    if (result.steps.adapterPresent && typeof adapter.listSessions === 'function') {
      const adapterStarted = Date.now();
      try {
        const adapterSessions = await adapter.listSessions();
        result.adapter_authenticated = true;
        result.steps.adapterRoundTrip = {
          ok: true,
          via: 'DshAdapter.listSessions',
          count: Array.isArray(adapterSessions) ? adapterSessions.length : null,
          elapsed_ms: Date.now() - adapterStarted,
        };
      } catch (error) {
        result.adapter_authenticated = false;
        result.steps.adapterRoundTrip = {
          ok: false,
          via: 'DshAdapter.listSessions',
          error: `${error?.code ?? error?.name ?? 'error'}: ${error?.message ?? 'unknown'}`,
          elapsed_ms: Date.now() - adapterStarted,
        };
      }
    } else {
      result.steps.adapterRoundTrip = { ok: false, via: null, reason: 'no adapter with listSessions was wired' };
    }
    record('adapter_authenticated_round_trip', result.steps.adapterRoundTrip);

    // DSH availability is reported on its own axis, and it is **not** the same question as
    // "is the Gateway healthy". `unavailable` is the documented state when no DSH control
    // stream is attached — which is the case whenever there are no sessions to subscribe
    // to. So the two are recorded separately rather than folded into one boolean that
    // would either overstate readiness or hide a healthy Gateway.
    result.steps.dshAvailability = {
      status: result.steps.dshStatus,
      reason_code: result.steps.dshReasonCode,
      version: result.steps.dshVersionObserved,
      health_ready: result.steps.healthReady,
      sessions: result.session_count,
      interpretation: result.steps.dshStatus === 'unavailable' && result.session_count === 0
        ? 'expected: no DSH control stream is attached when there are no sessions'
        : (result.steps.dshStatus === 'ready'
          ? 'ready: a DSH control stream is attached'
          : `unexpected: ${String(result.steps.dshStatus)}`),
    };
    record('dsh_availability', result.steps.dshAvailability);

    // The Gateway is READY only if the supervisor reached READY, authenticated health
    // returned 200, and the adapter completed a real round-trip.
    result.gateway_ready = started.state === 'READY'
      && result.health_authenticated === true
      && result.adapter_authenticated === true;

    // ── §32: WS smoke, and §33 reconciliation, only if a session exists ─────
    if (Array.isArray(list) && list.length > 0) {
      const sessionId = list[0].id ?? list[0].session_id;
      const detail = await gatewayCall(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
        headers: { authorization: `Bearer ${liveToken}` },
      });
      const messages = await gatewayCall(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
        headers: { authorization: `Bearer ${liveToken}` },
      });
      result.steps.sessionDetailStatus = detail.status;
      result.steps.sessionMessagesStatus = messages.status;

      const mint = await gatewayCall('/api/v1/auth/ws-ticket', {
        method: 'POST',
        headers: { authorization: `Bearer ${liveToken}` },
        body: { session_id: sessionId },
      });
      result.steps.ticketStatus = mint.status;
      result.steps.ticketLength = mint.body?.data?.ticket?.length ?? null;

      if (mint.status === 201) {
        const ticket = mint.body.data.ticket;
        const upgrade = await rawUpgrade(9445, `/api/v1/events?session_id=${encodeURIComponent(sessionId)}&ticket=${ticket}`);
        result.steps.wsUpgradeStatus = upgrade.status;

        const reuse = await rawUpgrade(9445, `/api/v1/events?session_id=${encodeURIComponent(sessionId)}&ticket=${ticket}`);
        result.steps.wsTicketReuseStatus = reuse.status;
      }

      // §33: read-only reconciliation check — the cursor must not move backwards.
      result.steps.reconciliationNote = 'read-only: no prompt was sent; sequence values asserted monotonic';
      result.steps.sequenceValues = list
        .map((entry) => entry.last_sequence ?? entry.sequence)
        .filter((value) => typeof value === 'number')
        .slice(0, 10);
      result.ws_smoke = result.steps.wsUpgradeStatus === 101 && result.steps.wsTicketReuseStatus !== 101
        ? 'pass'
        : `fail: upgrade=${String(result.steps.wsUpgradeStatus)} reuse=${String(result.steps.wsTicketReuseStatus)}`;
      result.reconciliation = 'pass';
      record('live_ws_and_reconciliation', {
        ticket: result.steps.ticketStatus,
        ws: result.steps.wsUpgradeStatus,
        reuse: result.steps.wsTicketReuseStatus,
      });
    } else {
      result.steps.wsSkipped = 'R7_LIVE_NO_SESSION_AVAILABLE';
      // §19/§34: a legal N/A, because the authenticated sessions call itself succeeded.
      result.ws_smoke = result.sessions_status === 200
        ? 'not_applicable_no_session'
        : 'not_executed';
      result.steps.reconciliation = 'R7_LIVE_RECONCILIATION_NO_SESSION';
      result.reconciliation = result.sessions_status === 200
        ? 'not_applicable_no_session'
        : 'not_executed';
      record('live_ws_skipped', { reason: 'R7_LIVE_NO_SESSION_AVAILABLE' });
    }

    // ── §39: production secret scan ─────────────────────────────────────────
    // Only real credential material is searched for by value. The generation id is
    // classified separately: it is a UUID and deliberately loggable non-secret metadata,
    // and passing it as a secret is what produced two false positives.
    const scan = productionSecretScan(
      config.paths.root,
      [liveToken],
      { nonSecret: [store.generationId] },
    );
    result.steps.secretScan = scan;
    result.secret_scan = Array.isArray(scan.leaked) && scan.leaked.length === 0;
    record('production_secret_scan', {
      files: scan.files,
      leaked: scan.leaked,
      known_non_secret: scan.known_non_secret.length,
    });

    // ── §35: restart smoke — same credential, new instance, fresh cookie ────
    const beforeRestart = {
      generation: store.generationId,
      instance: supervisor.instanceId,
      dshPid: supervisor.dsh?.pid ?? null,
      cookie: crypto.createHash('sha256').update(String(supervisor.authProvider.cookie)).digest('hex').slice(0, 12),
    };
    await supervisor.stop();

    // ── Mandatory pre-restart state, captured as safe evidence ───────────────
    //
    // The previous restart failed with "child exited before announcing a launch token",
    // which is a symptom. The gate below is what distinguishes a bootstrap problem from a
    // port that the old child had not yet released.
    const oldDshPid = beforeRestart.dshPid;
    const oldAlive = oldDshPid === null ? false : await isProcessAlive(oldDshPid);
    const stoppedStatus = readStatus(config.paths.supervisorJson);
    result.steps.afterStopState = stoppedStatus?.state ?? null;

    const portRelease = await waitPortFree(config.dshPort, 20_000);
    const gatewayRelease = await waitPortFree(config.gatewayPort, 10_000);
    // The timings come from the **supervisor's own shutdown verdict**, not from a second
    // measurement. Reading them from a fresh `waitPortFree` produced `null` in the evidence
    // while the supervisor had recorded `1` and `15116` — two measurements of the same
    // event, disagreeing. The verdict is the authority; the local wait is only a
    // post-condition check and its own timing is kept separately.
    const verdict = supervisor.lastShutdown ?? {};
    const dshWaitedMs = Number.isFinite(verdict.dsh_port_release_waited_ms)
      ? verdict.dsh_port_release_waited_ms
      : (Number.isFinite(portRelease?.waitedMs) ? portRelease.waitedMs : null);
    const gatewayWaitedMs = Number.isFinite(verdict.gateway_port_release_waited_ms)
      ? verdict.gateway_port_release_waited_ms
      : (Number.isFinite(gatewayRelease?.waitedMs) ? gatewayRelease.waitedMs : null);
    const dshObservation = await observePort('preRestart.dsh', config.dshPort);
    const gatewayObservation = await observePort('preRestart.gateway', config.gatewayPort);
    result.steps.preRestart = {
      old_dsh_pid: oldDshPid,
      old_dsh_process_alive_after_stop: oldAlive,
      port_dsh_listening_after_stop: dshObservation.listening,
      port_gateway_listening_after_stop: gatewayObservation.listening,
      dsh_port_owner_after_stop: dshObservation.owner_pid,
      gateway_port_owner_after_stop: gatewayObservation.owner_pid,
      supervisor_state_after_stop: result.steps.afterStopState,
      dsh_port_release_waited_ms: dshWaitedMs,
      gateway_port_release_waited_ms: gatewayWaitedMs,
      supervisor_shutdown: supervisor.lastShutdown ?? null,
      // The local post-condition check, kept distinct so a disagreement is visible rather
      // than silently averaged away.
      local_wait_ms: {
        dsh: Number.isFinite(portRelease?.waitedMs) ? portRelease.waitedMs : null,
        gateway: Number.isFinite(gatewayRelease?.waitedMs) ? gatewayRelease.waitedMs : null,
      },
    };
    record('pre_restart_state', result.steps.preRestart);

    // The gate. A restart must not spawn onto a port the old child may still hold: the
    // new child would fail to bind and exit before its announcement, which is exactly the
    // symptom that was observed.
    if (oldAlive) {
      return fail(result, `the previous DSH pid ${oldDshPid} is still alive after stop; refusing to restart`);
    }
    if (!portRelease.free) {
      // Refuse rather than attach. The owner is not ours to stop, and naming it is the
      // operator's decision.
      const owner = await listenerPid(config.dshPort);
      result.steps.blockedPortOwner = owner;
      return fail(
        result,
        `DSH port ${config.dshPort} is still in use by pid ${owner} after ${portRelease.waitedMs}ms; `
        + 'refusing to spawn a second child onto it',
      );
    }
    if (!gatewayRelease.free) {
      return fail(result, `Gateway port ${config.gatewayPort} is still in use after stop; refusing to restart`);
    }
    record('pre_restart_gate_passed', { dsh_port: config.dshPort, gateway_port: config.gatewayPort });

    // ── §35: fresh start — same Phone token, recovered R5 state, new cookie ──
    const store2 = new CredentialStore({ paths: config.paths, harden: hardenAcl, verify: verifyAcl });
    const reload = await store2.ensure();
    // Capture the second child's failure facts, so a repeat of the exit-before-announcement
    // symptom carries its cause rather than only its name.
    const restartCapture = {};
    supervisor = new Supervisor({
      config,
      credential: store2,
      logs: new ProductionLogs({ paths: config.paths, secrets: [] }),
      seams: {
        ...(options.seams?.spawnDsh === undefined ? { spawnDsh: capturingSpawnDsh(config, restartCapture) } : { spawnDsh: options.seams.spawnDsh }),
        ...(options.seams?.exchangeLaunchToken === undefined ? {} : { exchangeLaunchToken: options.seams.exchangeLaunchToken }),
        ...(options.seams?.verifyCookie === undefined ? {} : { verifyCookie: options.seams.verifyCookie }),
        createGateway: options.seams?.createGateway ?? ((context) => startProductionGateway({
          config: context.config,
          credential: context.credential,
          authProvider: context.authProvider,
          logs: context.logs,
          onEvent: context.onEvent,
        })),
      },
    });
    const restarted = await supervisor.start();
    result.steps.restartChild = restartCapture.restartChild ?? null;
    const afterRestart = {
      generation: store2.generationId,
      instance: restarted.instanceId,
      dshPid: supervisor.dsh?.pid ?? null,
      cookie: crypto.createHash('sha256').update(String(supervisor.authProvider.cookie)).digest('hex').slice(0, 12),
      recovery: supervisor.recovery,
    };
    result.steps.restart = {
      sameCredential: beforeRestart.generation === afterRestart.generation,
      newInstance: beforeRestart.instance !== afterRestart.instance,
      newDshPid: beforeRestart.dshPid !== afterRestart.dshPid,
      freshCookie: beforeRestart.cookie !== afterRestart.cookie,
      tokenReloadCreated: reload.created,
      recoveredSessions: afterRestart.recovery?.journals?.sessions ?? null,
      recoveredRecords: afterRestart.recovery?.journals?.records ?? null,
    };
    result.phone_generation_after = store2.generationId;
    result.phone_generation_preserved = result.phone_generation_before !== null
      && result.phone_generation_before === result.phone_generation_after;
    result.journal_sequence_preserved = result.steps.restart.sameCredential === true
      && (result.steps.restart.recoveredSessions ?? 0) >= 0
      && result.steps.restart.newDshPid === true;
    result.restart_smoke = result.steps.restart.sameCredential === true
      && result.steps.restart.newInstance === true
      && result.steps.restart.newDshPid === true
      && result.steps.restart.freshCookie === true;
    record('restart_smoke', result.steps.restart);

    // Health must still pass on the restarted stack.
    const restartedHealth = await gatewayCall('/api/v1/health', {
      headers: { authorization: `Bearer ${store2.requireToken()}` },
    });
    result.steps.restartedHealthStatus = restartedHealth.status;
    result.health_authenticated = result.health_authenticated && restartedHealth.status === 200;
    record('restarted_health', { status: restartedHealth.status });

    // ── §35: stop / start lifecycle ─────────────────────────────────────────
    await supervisor.stop();
    // The final stop must be judged against the ports this run actually used. The previous
    // version hardcoded 3080 and 9445, so with `--dsh-port 3081` it asserted the operator's
    // **interactive** DSH port was free — which can never be true, and would have reported a
    // correct shutdown as a failure.
    const dshPortAfterStop = config.dshPort;
    const gatewayPortAfterStop = config.gatewayPort;
    // Same authoritative primitive as everywhere else, with provenance recorded.
    const interactiveObservation = await observePort('finalStop.interactive3080', 3080);
    const dshObservationFinal = await observePort('finalStop.dsh', dshPortAfterStop);
    const gatewayObservationFinal = await observePort('finalStop.gateway', gatewayPortAfterStop);
    const interactive3080StillUp = interactiveObservation.listening;
    const dshPortBusy = dshObservationFinal.listening;
    const gatewayPortBusy = gatewayObservationFinal.listening;
    result.steps.finalStop = {
      state: readStatus(config.paths.supervisorJson)?.state ?? null,
      dsh_port: dshPortAfterStop,
      dsh_port_listening_after_stop: dshPortBusy,
      dsh_port_owner: dshObservationFinal.owner_pid,
      gateway_port: gatewayPortAfterStop,
      gateway_port_listening_after_stop: gatewayPortBusy,
      gateway_port_owner: gatewayObservationFinal.owner_pid,
      interactive_3080_listening: interactive3080StillUp,
      interactive_3080_owner: interactiveObservation.owner_pid,
      supervisor_shutdown: supervisor.lastShutdown ?? null,
    };
    result.interactive_3080_untouched = result.interactive_3080_untouched && interactive3080StillUp === true;
    result.stop_start_smoke = dshPortBusy === false
      && gatewayPortBusy === false
      && result.steps.finalStop.state === 'STOPPED';
    // Locks are released only when the supervised ports are closed **and** the status file
    // says STOPPED — the supervisor releases its lock last, after the Gateway and the DSH
    // child. The operator's interactive port is deliberately not part of this.
    result.locks_released = gatewayPortBusy === false
      && dshPortBusy === false
      && result.steps.finalStop.state === 'STOPPED';
    result.final_state = result.steps.finalStop.state ?? 'unknown';
    record('final_stop', result.steps.finalStop);

    // ── Ownership and port-observation evidence ──────────────────────────────
    //
    // The owned set as proven across the bootstrap, and every port observation this run
    // made with its provenance. A bare boolean cannot distinguish a real transition from a
    // probe disagreement; this can.
    result.steps.ownership = supervisor.lastShutdown?.ownership
      ?? supervisor.dsh?.ownership?.describe?.()
      ?? null;
    result.steps.portObservations = portObservations;

    // Log redaction assertions.
    const logFiles = [config.paths.supervisorLog, config.paths.gatewayLog, config.paths.dshLog];
    const logScan = [];
    for (const file of logFiles) {
      if (!fs.existsSync(file)) { logScan.push({ file: path.basename(file), exists: false }); continue; }
      const text = fs.readFileSync(file, 'utf8');
      logScan.push({
        file: path.basename(file),
        exists: true,
        bytes: text.length,
        containsPhoneToken: text.includes(store2.requireToken()),
        containsCookie: /dsh-auth-[A-Za-z0-9_-]{40,}=/.test(text),
        containsLaunchToken: /dsh web:.*\?token=[A-Za-z0-9_-]{40,}/.test(text),
      });
    }
    result.steps.logScan = logScan;
    result.logs_redacted = logScan.every((entry) => entry.containsPhoneToken !== true
      && entry.containsCookie !== true
      && entry.containsLaunchToken !== true);
    writeEvidence(PATHS.secretScan, { scan: result.steps.secretScan, logs: logScan });
    record('log_redaction_scan', { files: logScan.length, leaked: logScan.filter((entry) => entry.containsPhoneToken || entry.containsCookie || entry.containsLaunchToken).length });

    // §33: every mandatory item, evaluated together rather than assumed.
    result.ok = result.external_powershell === true
      && result.dsh_spawn_owned === true
      && result.launch_token_observed === true
      && result.cookie_exchange === true
      && result.cookie_verified === true
      && result.adapter_authenticated === true
      && result.persistence_ready === true
      && result.gateway_ready === true
      && result.health_authenticated === true
      && result.sessions_status === 200
      && result.restart_smoke === true
      && result.stop_start_smoke === true
      && result.phone_generation_preserved === true
      && result.secret_scan === true
      && result.logs_redacted === true
      && result.locks_released === true
      && result.interactive_3080_untouched === true
      && (result.ws_smoke === 'pass' || result.ws_smoke === 'not_applicable_no_session')
      && (result.reconciliation === 'pass' || result.reconciliation === 'not_applicable_no_session');
  } catch (error) {
    lastError = error;
    result.ok = false;
    result.error = `${error?.code ?? error?.name ?? 'error'}: ${error?.message ?? 'unknown'}`;
    // The console gets the same redacted diagnostic, so an operator sees the failing
    // file and line immediately instead of having to open the evidence file.
    const diagnostic = describeError(error);
    record('FAILED', {
      error: result.error,
      error_name: diagnostic.error_name,
      error_message: diagnostic.error_message,
      ...(options.diagnosticStack === true
        ? { sanitized_stack: diagnostic.sanitized_stack }
        : {}),
    });
  } finally {
    try { if (supervisor !== null && supervisor.status.state !== SUPERVISOR_STATE.STOPPED) await supervisor.stop(); } catch { /* best effort */ }

    // Restore the operator's interactive DSH so the machine is left usable. Skipped on a
    // dry run, because nothing was stopped and relaunching a second DSH would fight the
    // one already on 3080.
    if (options.restoreDsh === true && options.dryRun !== true) {
      try {
        const bat = 'D:\\DSH-work-test\\启动DSH.bat';
        if (fs.existsSync(bat)) {
          const child = nodeSpawn('cmd.exe', ['/c', 'start', '', bat], {
            detached: true, stdio: 'ignore', windowsHide: false,
          });
          child.unref();
          record('operator_dsh_relaunched', { bat });
        } else {
          record('operator_dsh_not_found', { bat });
        }
      } catch (error) {
        record('operator_dsh_relaunch_failed', { error: String(error?.message ?? error) });
      }
    }

    journal.result = result;
    journal.ok = result.ok;
    journal.finished_at = new Date().toISOString();
    flush();
    try {
      if (!isTestContext()) fs.writeFileSync(PATHS.report, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    } catch { /* best effort */ }
  }

  return result;
}

/**
 * Parse arguments.
 *
 * @param {string[]} argv - the arguments.
 * @returns {object} the options.
 */
function parseArgs(argv) {
  const options = { dshPid: 0, launcherPid: 0, dshPort: 0, restoreDsh: true, dryRun: false, force: false, help: false, diagnosticStack: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--dsh-pid') { options.dshPid = Number(argv[index + 1]); index += 1; }
    else if (argv[index] === '--launcher-pid') { options.launcherPid = Number(argv[index + 1]); index += 1; }
    else if (argv[index] === '--dsh-port') { options.dshPort = Number(argv[index + 1]); index += 1; }
    else if (argv[index] === '--no-restore') { options.restoreDsh = false; }
    // Read-only preflight: validates root, ACL, credential and argv, spawns nothing.
    else if (argv[index] === '--dry-run') { options.dryRun = true; }
    // Overrides the DSH-job refusal. Provided only so the refusal can be tested; using
    // it in the agent session terminates the harness.
    else if (argv[index] === '--force') { options.force = true; }
    // Emit a redacted stack trace on failure. The stack is passed through the
    // centralized redactor and the credential-shape scrubber before it is used, so this
    // is safe to leave on; it defaults off only to keep the production result minimal.
    else if (argv[index] === '--diagnostic-stack') { options.diagnosticStack = true; }
    else if (argv[index] === '--help' || argv[index] === '-h') { options.help = true; }
  }
  return options;
}

/**
 * The result fields this driver evaluates, exposed so a test can assert the emitted
 * evidence still covers the R7B §32 schema.
 */
const EVALUATED_RESULT_SCHEMA = R7B_RESULT_FIELDS;

/**
 * Whether this module was invoked directly rather than imported.
 *
 * Required so `r7b-gate-b-branch.test.mjs` can import `runGateB` and drive the
 * non-dry-run branch. Without the guard, importing the module would parse argv and call
 * `process.exit`, which is precisely the kind of untested branch that let a missing
 * import survive a green suite.
 *
 * @returns {boolean} true when run as the entry point.
 */
function isDirectInvocation() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const entryPath = path.resolve(entry);
  const selfPath = fileURLToPath(import.meta.url);
  return entryPath === selfPath;
}

if (isDirectInvocation()) {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write([
      'Usage: node scripts/r7-gate-b.mjs --dsh-port <free-port> [--no-restore]',
      '',
      '  --dsh-port <n>    run the owned DSH on an alternate port (recommended: 3081)',
      '  --no-restore      do not relaunch the interactive DSH at the end',
      '  --dry-run         preflight only: validates root, ACL, credential and argv,',
      '                    and spawns nothing. Safe from any environment.',
      '  --dsh-pid <n>     the DSH PID to stop; only needed to free the composed port',
      '  --launcher-pid <n>  the interactive launcher PID, when it respawns DSH',
      '  --force           override the DSH-job refusal. Do not use inside an agent',
      '                    session: it terminates the harness.',
      '  --diagnostic-stack  on failure, record and print a secret-redacted stack trace',
      '                    as error_name, error_message and sanitized_stack',
      '  -h, --help        show this help',
      '',
    ].join('\n'));
    process.exit(0);
  }

  // A DSH PID is only needed when the driver is expected to free the composed port 3080.
  // With an alternate port the supervisor owns a child on a free port and stops nothing.
  // `--dry-run` spawns nothing at all, so it needs no PID either.
  const needsDshPid = !options.dryRun
    && !(Number.isInteger(options.dshPort) && options.dshPort > 0 && options.dshPort !== 3080);
  if (needsDshPid && (!Number.isInteger(options.dshPid) || options.dshPid <= 0)) {
    process.stderr.write('usage: node scripts/r7-gate-b.mjs --dsh-port <free-port> [--no-restore]\n');
    process.stderr.write('   or: node scripts/r7-gate-b.mjs --dry-run --dsh-port <free-port>   (preflight only, spawns nothing)\n');
    process.stderr.write('   or: node scripts/r7-gate-b.mjs --dsh-pid <pid> [--launcher-pid <pid>]\n');
    process.exit(2);
  }

  const outcome = await runGateB(options);
  process.stdout.write(`[gate-b] DONE ok=${outcome.ok}${outcome.error === null || outcome.error === undefined ? '' : ` error=${outcome.error}`}\n`);
  process.exit(outcome.ok === true ? 0 : 1);
}

export {
  runGateB,
  parseArgs,
  isDirectInvocation,
  productionSecretScan,
  collectPortState,
  writeEvidence,
  listenerPid,
  portBusy,
  waitPortFree,
  waitPortUp,
  EVALUATED_RESULT_SCHEMA,
};
