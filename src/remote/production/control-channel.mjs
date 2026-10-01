/**
 * Control channel — Phase R7 §20.
 *
 * Operator requests reach a running supervisor through this local file channel. The
 * obvious implementation — a TCP listener — is forbidden: R7 adds **no** port (§20),
 * and a second listener would also need its own auth story.
 *
 * So the channel is a directory. A file appearing in `state/control/` is the request;
 * the supervisor consumes it. The security property that matters is **instance
 * matching**: a request written for instance A must never stop instance B. Without
 * that check, a stale `stop` file left behind by a crashed run would kill the next
 * healthy supervisor the moment it started.
 *
 * Consumption is a rename, not a delete. Two supervisors racing on the same request
 * cannot both win a rename, so exactly one observes it.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { R7_ERROR, ProductionError } from './production-config.mjs';

/** The request schema version. */
export const CONTROL_VERSION = 1;

/** Operator actions accepted by the protected supervisor file channel. */
export const CONTROL_ACTION = Object.freeze({ STOP: 'stop', ISSUE_BROWSER_LOGIN: 'issue-browser-login' });

/** How long a consumed request is retained before cleanup. */
export const CONSUMED_RETENTION_MS = 60_000;

/**
 * Build a stop request.
 *
 * @param {object} options - request options.
 * @param {string} options.instanceId - the target supervisor instance.
 * @param {() => Date} [options.clock] - injectable clock.
 * @param {() => string} [options.uuid] - injectable id generator.
 * @returns {object} the request body.
 */
export function buildStopRequest(options) {
  const clock = options.clock ?? (() => new Date());
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  return {
    v: CONTROL_VERSION,
    instance_id: options.instanceId,
    request_id: uuid(),
    action: CONTROL_ACTION.STOP,
    created_at: clock().toISOString(),
  };
}

/** Build a secret-free request for a one-time local DSH browser login handoff. */
export function buildBrowserLoginRequest(options) {
  const clock = options.clock ?? (() => new Date());
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  return {
    v: CONTROL_VERSION,
    instance_id: options.instanceId,
    request_id: uuid(),
    action: CONTROL_ACTION.ISSUE_BROWSER_LOGIN,
    created_at: clock().toISOString(),
  };
}

/**
 * Validate a control request.
 *
 * @param {unknown} body - the parsed request.
 * @returns {{ok: true, request: object} | {ok: false, reason: string}} the decision.
 */
export function validateControlRequest(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: 'the request is not an object' };
  }
  if (body.v !== CONTROL_VERSION) {
    return { ok: false, reason: `unsupported control version ${JSON.stringify(body.v)}` };
  }
  if (typeof body.instance_id !== 'string' || body.instance_id.length === 0) {
    return { ok: false, reason: 'instance_id is required' };
  }
  if (typeof body.request_id !== 'string' || body.request_id.length === 0) {
    return { ok: false, reason: 'request_id is required' };
  }
  // The browser-login action only mints a bounded one-time local ticket; unknown actions
  // must not be silently interpreted as either supported operation.
  if (body.action !== CONTROL_ACTION.STOP && body.action !== CONTROL_ACTION.ISSUE_BROWSER_LOGIN) {
    return { ok: false, reason: `unsupported action ${JSON.stringify(body.action)}` };
  }
  if (body.action === CONTROL_ACTION.ISSUE_BROWSER_LOGIN && !/^[0-9a-f-]{36}$/i.test(body.request_id)) {
    return { ok: false, reason: 'browser-login request_id must be a UUID' };
  }
  return { ok: true, request: body };
}

/**
 * The file-based control channel.
 */
export class ControlChannel {
  /**
   * @param {object} options - channel options.
   * @param {object} options.paths - the resolved `paths` block.
   * @param {string} options.instanceId - this supervisor's instance.
   * @param {() => Date} [options.clock] - injectable clock.
   */
  constructor(options) {
    this.dir = options.paths.control;
    this.instanceId = options.instanceId;
    this.clock = options.clock ?? (() => new Date());
    this.counters = { accepted: 0, mismatched: 0, malformed: 0, observed: 0 };
  }

  /**
   * Ensure the control directory exists.
   *
   * @returns {string} the directory.
   */
  ensure() {
    fs.mkdirSync(this.dir, { recursive: true });
    return this.dir;
  }

  /**
   * Write a stop request for this instance.
   *
   * @param {object} [request] - an explicit request, otherwise one is built.
   * @returns {{file: string, request: object}} where it was written.
   */
  requestStop(request) {
    this.ensure();
    const body = request ?? buildStopRequest({ instanceId: this.instanceId, clock: this.clock });
    // A unique filename per request, so two concurrent stops cannot overwrite each
    // other and lose one.
    const file = path.join(this.dir, `stop-${body.request_id}.json`);
    fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8' });
    return { file, request: body };
  }

  /** Write an operator request for a short-lived browser-login URL. */
  requestBrowserLogin(request) {
    this.ensure();
    const body = request ?? buildBrowserLoginRequest({ instanceId: this.instanceId, clock: this.clock });
    if (body?.action !== CONTROL_ACTION.ISSUE_BROWSER_LOGIN || !/^[0-9a-f-]{36}$/i.test(body.request_id ?? '')) {
      throw new TypeError('browser-login request requires a UUID request id and the browser-login action');
    }
    const file = path.join(this.dir, `browser-login-request-${body.request_id}.json`);
    const handle = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeSync(handle, `${JSON.stringify(body, null, 2)}\n`, null, 'utf8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    return { file, request: body };
  }

  /** Write the one-time handoff outcome for the waiting local script. */
  respondBrowserLogin(request, outcome) {
    if (request?.action !== CONTROL_ACTION.ISSUE_BROWSER_LOGIN
      || !/^[0-9a-f-]{36}$/i.test(request.request_id ?? '')) {
      throw new TypeError('browser-login response requires a valid request');
    }
    this.ensure();
    const file = path.join(this.dir, `browser-login-response-${request.request_id}.json`);
    const handle = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeSync(handle, `${JSON.stringify({
        v: CONTROL_VERSION,
        request_id: request.request_id,
        ...outcome,
      }, null, 2)}\n`, null, 'utf8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    return file;
  }

  /**
   * Poll for an operator request addressed to this instance.
   *
   * @returns {{action: 'stop'|'issue-browser-login', request: object} | {action: 'none'} | {action: 'rejected', reason: string}} the result.
   */
  poll() {
    let entries;
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return { action: 'none' };
    }

    for (const entry of entries) {
      const stopRequest = entry.startsWith('stop-') && entry.endsWith('.json');
      const browserRequest = entry.startsWith('browser-login-request-') && entry.endsWith('.json');
      if ((!stopRequest && !browserRequest) || entry.includes('.consumed-')) continue;
      const full = path.join(this.dir, entry);

      // §20: claim by rename FIRST. If the rename fails, another poller won it and
      // this one must not also act on it.
      const claimed = `${full}.consumed-${process.pid}-${Date.now()}`;
      try {
        fs.renameSync(full, claimed);
      } catch {
        continue;
      }

      let body;
      try {
        body = JSON.parse(fs.readFileSync(claimed, 'utf8'));
      } catch {
        this.counters.malformed += 1;
        continue;
      }

      const decision = validateControlRequest(body);
      if (!decision.ok) {
        this.counters.malformed += 1;
        // A malformed request is consumed and ignored rather than retried forever.
        continue;
      }
      if ((stopRequest && decision.request.action !== CONTROL_ACTION.STOP)
        || (browserRequest && decision.request.action !== CONTROL_ACTION.ISSUE_BROWSER_LOGIN)) {
        this.counters.malformed += 1;
        continue;
      }

      this.counters.observed += 1;

      // §20: instance matching is the security property. A stale request from a
      // previous run must never stop this one.
      if (decision.request.instance_id !== this.instanceId) {
        this.counters.mismatched += 1;
        continue;
      }

      this.counters.accepted += 1;
      return { action: decision.request.action, request: decision.request };
    }

    return { action: 'none' };
  }

  /**
   * Remove consumed and stale request files.
   *
   * @returns {number} how many were removed.
   */
  cleanup() {
    let removed = 0;
    let entries;
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return 0;
    }
    const cutoff = this.clock().getTime() - CONSUMED_RETENTION_MS;
    for (const entry of entries) {
      if (entry.startsWith('browser-login-response-') && entry.endsWith('.json')) {
        const full = path.join(this.dir, entry);
        try {
          const outcome = JSON.parse(fs.readFileSync(full, 'utf8'));
          if (typeof outcome.expires_at === 'string' && Date.parse(outcome.expires_at) <= this.clock().getTime()) {
            fs.rmSync(full, { force: true });
            removed += 1;
          }
        } catch {
          // Invalid response artifacts carry no authority and are safe to remove.
          try { fs.rmSync(full, { force: true }); removed += 1; } catch { /* already gone */ }
        }
        continue;
      }
      if (!entry.includes('.consumed-')) continue;
      const full = path.join(this.dir, entry);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.rmSync(full, { force: true });
          removed += 1;
        }
      } catch {
        // A vanished file is already clean.
      }
    }
    return removed;
  }

  /**
   * A safe description.
   *
   * @returns {object} the summary.
   */
  describe() {
    return { dir: this.dir, instance_id: this.instanceId, ...this.counters };
  }
}

/**
 * Assert that a control request targets the expected instance.
 *
 * @param {object} request - the request.
 * @param {string} expected - the expected instance id.
 * @returns {void}
 * @throws {ProductionError} `R7_CONTROL_REQUEST_INVALID`.
 */
export function assertTargetsInstance(request, expected) {
  if (request?.instance_id !== expected) {
    throw new ProductionError(
      R7_ERROR.CONTROL_REQUEST_INVALID,
      'the control request targets a different supervisor instance',
    );
  }
}
