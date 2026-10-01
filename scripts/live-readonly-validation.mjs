/**
 * R1 live manual validation — read-only, opt-in, no credential file access.
 *
 * R1 §19 allows one manual live verification after the fixture tests pass:
 *   list sessions, page one session, follow one session.
 * Prompt/cancel may be recorded as `DEFERRED TO R7` when auth cannot be obtained
 * safely, and R1 must not implement R7 early to force a live pass.
 *
 * Security rules enforced here (R1 §3, §23):
 *   - `.credentials.yaml` is never read, copied or referenced;
 *   - the desktop console is never scraped for a launch token;
 *   - the DSH launcher is never modified;
 *   - no token or cookie value is written anywhere or printed.
 *
 * Two modes:
 *
 *   default            Auth-free. Reads the installed DSH version from the
 *                      package manifest (a normal file read, not a credential)
 *                      and proves the version guard accepts it. Proves the auth
 *                      path is closed by exercising the real server with no
 *                      credential and expecting AUTH_REJECTED. No cookie needed.
 *
 *   --cookie-stdin     Live read-only calls. The operator supplies the internal
 *                      cookie on stdin. The value is held in memory only, never
 *                      written, never logged, and never echoed.
 *
 * Usage:
 *   node scripts/live-readonly-validation.mjs
 *   Get-Content .\cookie.txt -Raw | node scripts/live-readonly-validation.mjs --cookie-stdin
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { ADAPTER_ERROR, isAdapterError } from '../src/remote/adapter-errors.mjs';
import { DshAdapter } from '../src/remote/dsh-adapter.mjs';
import { DshVersionGuard } from '../src/remote/version-guard.mjs';
import { DshRpcClient } from '../src/remote/wire/dsh-rpc-client.mjs';
import {
  StaticAuthProvider,
  UnavailableAuthProvider,
} from '../src/remote/wire/dsh-auth.mjs';

/** Explicit paths. R1 §22 forbids inferring these from the working directory. */
const EXPECTED_DSH_HOME = 'D:\\DSH-work-test\\.dsh';
const EXPECTED_AUTHORITY = '127.0.0.1:3080';
const DSH_PACKAGE_MANIFEST =
  'C:\\Users\\YOURNAME\\AppData\\Local\\npm-cache\\_npx\\c40503fdf38a82ea\\node_modules\\@deepseek-ai\\dsh\\package.json';

/** Collected results, printed as a report at the end. */
const results = [];

/**
 * Record one check.
 *
 * @param {string} name - check name.
 * @param {'PASS'|'FAIL'|'DEFERRED'|'INFO'} status - outcome.
 * @param {string} detail - redacted detail.
 */
function record(name, status, detail) {
  results.push({ name, status, detail });
  console.log(`[${status}] ${name} — ${detail}`);
}

/**
 * Read the installed DSH version from its package manifest.
 *
 * @returns {string} the version string.
 */
function readInstalledDshVersion() {
  const manifest = JSON.parse(fs.readFileSync(DSH_PACKAGE_MANIFEST, 'utf8'));
  return manifest.version;
}

/**
 * Read the cookie from stdin when the operator opts in.
 *
 * @returns {Promise<string>} the trimmed cookie value.
 */
async function readCookieFromStdin() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const value = line.trim();
    if (value.length > 0) {
      rl.close();
      return value;
    }
  }
  throw new Error('no cookie was supplied on stdin');
}

/**
 * Probe the real HTTP endpoint with no credential at all.
 *
 * This is the strongest evidence available without a cookie: DSH's Host/Origin
 * fence and browser-auth check run BEFORE endpoint resolution, so a wrong path
 * and a right path are indistinguishable once authenticated. They are *not*
 * indistinguishable unauthenticated, because an unrouted path would still be
 * reached only by the `/api` prefix route. What this pins down is the
 * observable status contract the adapter maps: 401 for a missing credential.
 *
 * @param {string} endpoint - endpoint name, e.g. `session/list`.
 * @returns {Promise<{status: number, body: string}>} the raw response summary.
 */
async function probeEndpoint(endpoint) {
  const response = await fetch(`http://${EXPECTED_AUTHORITY}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'r1-live-probe',
      method: endpoint,
      payload: { args: { _request: {} } },
    }),
  });
  return { status: response.status, body: (await response.text()).slice(0, 40) };
}

/** Run the auth-free validation mode. */
async function runAuthFree() {
  record('DSH_HOME', 'INFO', EXPECTED_DSH_HOME);
  record('authority', 'INFO', EXPECTED_AUTHORITY);

  const observed = readInstalledDshVersion();
  record('observed DSH version', 'INFO', observed);

  const guard = new DshVersionGuard({ observedVersion: observed, source: 'package manifest' });
  try {
    const accepted = await guard.verify();
    record('version guard', 'PASS', `accepted ${accepted}`);
  } catch (error) {
    record('version guard', 'FAIL', error.message);
    return;
  }

  // Probe the real route unauthenticated. The response body is the channel text
  // (`unauthorized`), never a credential.
  try {
    const probe = await probeEndpoint('session/list');
    if (probe.status === 401) {
      record('unauthenticated POST /api/session/list', 'PASS', `HTTP 401 "${probe.body}" — route reachable, credential required`);
    } else if (probe.status === 404) {
      record('unauthenticated POST /api/session/list', 'FAIL', 'HTTP 404 — the endpoint path is wrong');
    } else {
      record('unauthenticated POST /api/session/list', 'FAIL', `unexpected HTTP ${probe.status}`);
    }
  } catch (error) {
    record('unauthenticated POST /api/session/list', 'INFO', `DSH is not reachable: ${redactForReport(error?.code ?? error?.name ?? 'error')}`);
  }

  // Prove the auth path is genuinely closed without a credential. A failure to
  // reach the server is reported distinctly from a rejection.
  const client = new DshRpcClient({
    authority: EXPECTED_AUTHORITY,
    authProvider: new UnavailableAuthProvider('auth-free mode supplies no credential'),
  });
  const adapter = new DshAdapter({
    rpcClient: client,
    versionGuard: guard,
    authProvider: new UnavailableAuthProvider('auth-free mode supplies no credential'),
  });

  try {
    await adapter.listSessions();
    record('adapter without credential', 'FAIL', 'the call unexpectedly succeeded without a credential');
  } catch (error) {
    if (isAdapterError(error) && error.code === ADAPTER_ERROR.AUTH_UNAVAILABLE) {
      record('adapter without credential', 'PASS', 'refused locally with AUTH_UNAVAILABLE before any network call');
    } else if (isAdapterError(error) && error.code === ADAPTER_ERROR.AUTH_REJECTED) {
      record('adapter without credential', 'PASS', 'refused by DSH with AUTH_REJECTED (401)');
    } else if (isAdapterError(error) && error.code === ADAPTER_ERROR.DSH_UNAVAILABLE) {
      record('adapter without credential', 'INFO', 'DSH is not reachable right now; skipped');
    } else {
      record('adapter without credential', 'FAIL', redactForReport(error?.code ?? String(error)));
    }
  }

  record('live listSessions', 'DEFERRED', 'DEFERRED TO R7 — the supervisor owns credential bootstrap');
  record('live session/page', 'DEFERRED', 'DEFERRED TO R7');
  record('live session/follow', 'DEFERRED', 'DEFERRED TO R7');
  record('live prompt', 'DEFERRED', 'DEFERRED TO R7');
  record('live cancel', 'DEFERRED', 'DEFERRED TO R7');
  await client.close();
}

/**
 * Reduce an error to a code-only string for the report.
 *
 * @param {string} value - raw value.
 * @returns {string} a value safe to print.
 */
function redactForReport(value) {
  return String(value).replace(/dsh-auth-[A-Za-z0-9_-]+/g, 'dsh-auth-[redacted]');
}

/**
 * Run the operator-supplied-cookie read-only mode.
 *
 * @param {string} cookie - cookie value held in memory only.
 */
async function runWithCookie(cookie) {
  const observed = readInstalledDshVersion();
  const guard = new DshVersionGuard({ observedVersion: observed, source: 'package manifest' });
  const authProvider = new StaticAuthProvider({ cookie, authority: EXPECTED_AUTHORITY });
  const client = new DshRpcClient({
    authority: EXPECTED_AUTHORITY,
    authProvider,
    callTimeoutMs: 15_000,
  });
  const adapter = new DshAdapter({
    rpcClient: client,
    versionGuard: guard,
    authProvider,
  });

  try {
    const sessions = await adapter.listSessions();
    record('live listSessions', 'PASS', `${sessions.length} session(s) visible, none mutated`);

    if (sessions.length > 0) {
      const target = sessions[0];
      record('live session id', 'INFO', target.id);

      try {
        const page = await adapter.getMessages(target.id, { maxMessages: 5 });
        record('live session/page', 'PASS', `${page.messages.length} message(s), hasMore=${page.hasMore}`);
      } catch (error) {
        record('live session/page', 'FAIL', redactForReport(error?.code ?? String(error)));
      }

      // Follow only long enough to observe the opening snapshot, then abort.
      try {
        const controller = new AbortController();
        const seen = [];
        let opened = false;
        await adapter.subscribe(
          target.id,
          (frame) => {
            seen.push(frame.kind);
            if (!opened) {
              opened = true;
              controller.abort();
            }
          },
          { signal: controller.signal },
        );
        await new Promise((resolve) => setTimeout(resolve, 2500));
        controller.abort();
        record(
          'live session/follow',
          seen.length > 0 ? 'PASS' : 'FAIL',
          `frames observed: ${seen.join(',') || 'none'}`,
        );
      } catch (error) {
        record('live session/follow', 'FAIL', redactForReport(error?.code ?? String(error)));
      }
    } else {
      record('live session/page', 'DEFERRED', 'no session available to page');
      record('live session/follow', 'DEFERRED', 'no session available to follow');
    }

    record('live prompt', 'DEFERRED', 'DEFERRED TO R7 — R1 does not mutate a real session');
    record('live cancel', 'DEFERRED', 'DEFERRED TO R7 — requires a live running task to cancel');
  } finally {
    await client.close();
  }
}

/** Entry point. */
async function main() {
  const cookieMode = process.argv.includes('--cookie-stdin');
  console.log('=== R1 live manual validation (read-only) ===');
  console.log(`mode: ${cookieMode ? 'operator-supplied cookie' : 'auth-free'}`);
  console.log('.credentials.yaml is never read by this script.');
  console.log('');

  if (cookieMode) {
    let cookie;
    try {
      cookie = await readCookieFromStdin();
    } catch (error) {
      record('read cookie', 'FAIL', error.message);
      summarize();
      process.exitCode = 1;
      return;
    }
    await runWithCookie(cookie);
  } else {
    await runAuthFree();
  }

  summarize();
}

/** Print the summary and set the exit code. */
function summarize() {
  console.log('');
  console.log('=== summary ===');
  for (const result of results) {
    console.log(`${result.status.padEnd(9)} ${result.name}`);
  }
  const failed = results.filter((result) => result.status === 'FAIL');
  const deferred = results.filter((result) => result.status === 'DEFERRED');
  console.log('');
  console.log(`pass=${results.filter((r) => r.status === 'PASS').length} fail=${failed.length} deferred=${deferred.length}`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
