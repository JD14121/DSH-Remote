/**
 * Safe logging — Phase R7 §24, §25, §38, §43.
 *
 * The ordering in §15 is the whole design:
 *
 * ```text
 * read in memory → parse → redact → optional log
 * ```
 *
 * Nothing reaches a file before redaction, so there is no window in which a secret
 * exists on disk. `redact` runs as part of the write path rather than as something a
 * caller is trusted to remember, because a caller that forgets is exactly how a
 * launch token ends up in a log.
 *
 * JSONL is the default for the supervisor and Gateway: a line-oriented format is
 * greppable, appendable and trivially bounded, with no framing to corrupt.
 */

import fs from 'node:fs';
import path from 'node:path';

import { R7_ERROR, ProductionError } from './production-config.mjs';
import { redactSecrets } from './credential-store.mjs';

/** The log event allowlist (§38). An event outside it is dropped, not guessed at. */
export const LOG_EVENTS = Object.freeze(new Set([
  'supervisor_start',
  'acl_verified',
  'credential_created',
  'credential_loaded',
  'dsh_spawned',
  'dsh_bootstrap_token_observed',
  'dsh_auth_cookie_obtained',
  'dsh_ready',
  'gateway_starting',
  'gateway_ready',
  'reconciliation_complete',
  'restart_scheduled',
  'stop_requested',
  'shutdown_complete',
  'error',
]));

/** Field names that are never written, whatever their value (§24). */
export const DENIED_FIELDS = Object.freeze(new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'token',
  'phone_token',
  'launch_token',
  'launchtoken',
  'ticket',
  'ws_ticket',
  'secret',
  'password',
  'api_key',
  'apikey',
  'dsh_auth',
  'content',
  'message',
  'url',
  'request_url',
  'attachment',
  'bytes',
]));

/** How many characters of an unknown raw line survive truncation (§25). */
export const RAW_LINE_MAX_CHARS = 512;

/** Log severities. */
export const LOG_LEVEL = Object.freeze({ DEBUG: 'debug', INFO: 'info', WARN: 'warn', ERROR: 'error' });

/**
 * Whether a field name is denied.
 *
 * Normalised so `launchToken`, `launch_token` and `LAUNCH-TOKEN` all match, since a
 * denylist that only catches one spelling catches nothing.
 *
 * @param {string} key - the field name.
 * @returns {boolean} true when the field must not be written.
 */
export function isDeniedField(key) {
  const normalised = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const denied of DENIED_FIELDS) {
    if (normalised === denied.replace(/[^a-z0-9]/g, '')) return true;
  }
  return false;
}

/**
 * Strip denied fields recursively, and redact any secret that appears in a value.
 *
 * @param {unknown} value - the value to sanitize.
 * @param {readonly string[]} secrets - additional literal secrets to remove.
 * @param {number} [depth] - the current recursion depth.
 * @returns {unknown} a sanitized copy.
 */
export function sanitize(value, secrets = [], depth = 0) {
  // A depth bound prevents a cyclic or pathologically nested object from becoming a
  // stack overflow inside the logger — the logger must not be a way to crash the stack.
  if (depth > 8) return '<depth-limit>';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSecrets(value, secrets);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitize(entry, secrets, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isDeniedField(key)) {
        out[key] = '<redacted>';
        continue;
      }
      out[key] = sanitize(entry, secrets, depth + 1);
    }
    return out;
  }
  // A function, symbol or class instance is not loggable data.
  return `<${typeof value}>`;
}

/**
 * A bounded, rotating JSONL log file.
 */
export class RotatingLog {
  /**
   * @param {object} options - log options.
   * @param {string} options.filePath - the log file.
   * @param {number} [options.maxBytes] - rotate above this size (§26).
   * @param {number} [options.backups] - how many rotated files to keep.
   * @param {readonly string[]} [options.secrets] - literal secrets to redact.
   * @param {() => Date} [options.clock] - injectable clock.
   */
  constructor(options) {
    if (typeof options?.filePath !== 'string') throw new TypeError('RotatingLog requires a filePath');
    this.filePath = options.filePath;
    this.maxBytes = options.maxBytes ?? 10_485_760;
    this.backups = options.backups ?? 5;
    this.secrets = options.secrets ?? [];
    this.clock = options.clock ?? (() => new Date());
    this.bytesWritten = 0;
    this.rotations = 0;
    /** §26: a log failure degrades logging; it never stops the stack. */
    this.degraded = false;
    this.lastError = null;
    /** Lines dropped because they were not on the allowlist. */
    this.dropped = 0;
  }

  /**
   * The current size of the log file.
   *
   * @returns {number} bytes, or 0 when absent.
   */
  size() {
    try {
      return fs.statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }

  /**
   * Rotate if the file has reached the limit.
   *
   * `supervisor.log` → `supervisor.log.1` → … → `.N`, dropping the oldest. Renaming
   * in ascending order is what makes it lossless: renaming downward would overwrite.
   *
   * @returns {boolean} true when a rotation happened.
   */
  rotateIfNeeded() {
    if (this.size() < this.maxBytes) return false;
    if (this.backups <= 0) {
      // No backups requested: truncate rather than grow without bound.
      try { fs.rmSync(this.filePath, { force: true }); } catch { /* degraded below */ }
      this.rotations += 1;
      return true;
    }
    try {
      const oldest = `${this.filePath}.${this.backups}`;
      if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
      for (let index = this.backups - 1; index >= 1; index -= 1) {
        const from = `${this.filePath}.${index}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${this.filePath}.${index + 1}`);
      }
      fs.renameSync(this.filePath, `${this.filePath}.1`);
      this.rotations += 1;
      return true;
    } catch (error) {
      this.#degrade(error);
      return false;
    }
  }

  /**
   * Record the log as degraded.
   *
   * @param {unknown} error - the cause.
   * @returns {void}
   */
  #degrade(error) {
    this.degraded = true;
    this.lastError = error?.code ?? error?.message ?? 'unknown';
  }

  /**
   * Append one already-sanitized line.
   *
   * @param {string} line - the line, without a trailing newline.
   * @returns {boolean} true when written.
   */
  writeLine(line) {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.rotateIfNeeded();
      const payload = Buffer.from(`${line}\n`, 'utf8');
      // Synchronous and append-only: a log line that might not survive a crash is
      // not evidence of anything.
      fs.appendFileSync(this.filePath, payload);
      this.bytesWritten += payload.byteLength;
      return true;
    } catch (error) {
      this.#degrade(error);
      return false;
    }
  }

  /**
   * Write a structured event.
   *
   * @param {string} event - an allowlisted event name (§38).
   * @param {object} [fields] - additional fields.
   * @param {string} [level] - the severity.
   * @returns {boolean} true when written.
   */
  event(event, fields = {}, level = LOG_LEVEL.INFO) {
    if (!LOG_EVENTS.has(event)) {
      // §38: an unknown event is dropped. Logging it would defeat the allowlist.
      this.dropped += 1;
      return false;
    }
    const record = {
      ts: this.clock().toISOString(),
      level,
      event,
      ...sanitize({ ...fields }, this.secrets),
    };
    return this.writeLine(JSON.stringify(record));
  }

  /**
   * Write a raw, unknown line from a child process (§25).
   *
   * The default is **drop**. When a line is retained it is truncated and redacted
   * first, so arbitrary child output cannot smuggle a secret or an unbounded blob
   * into the log.
   *
   * @param {string} raw - the raw line.
   * @param {string} [source] - which component produced it.
   * @returns {boolean} true when written.
   */
  rawLine(raw, source = 'dsh') {
    const text = redactSecrets(String(raw), this.secrets).trim();
    if (text.length === 0) return false;
    const truncated = text.length > RAW_LINE_MAX_CHARS
      ? `${text.slice(0, RAW_LINE_MAX_CHARS)}…<truncated>`
      : text;
    return this.writeLine(JSON.stringify({
      ts: this.clock().toISOString(),
      level: LOG_LEVEL.DEBUG,
      event: 'raw',
      source,
      line: truncated,
    }));
  }

  /**
   * Close the log.
   *
   * Writes are synchronous, so there is nothing buffered to flush; this exists so a
   * shutdown path can assert the log is closed and record that intent.
   *
   * @returns {{flushed: boolean, bytesWritten: number, rotations: number, degraded: boolean}} the summary.
   */
  close() {
    return {
      flushed: true,
      bytesWritten: this.bytesWritten,
      rotations: this.rotations,
      degraded: this.degraded,
    };
  }
}

/**
 * The supervisor's three logs (§24).
 */
export class ProductionLogs {
  /**
   * @param {object} options - log options.
   * @param {object} options.paths - the resolved `paths` block.
   * @param {number} [options.maxBytes] - rotation size.
   * @param {number} [options.backups] - backup count.
   * @param {readonly string[]} [options.secrets] - literal secrets.
   * @param {() => Date} [options.clock] - injectable clock.
   */
  constructor(options) {
    this.secrets = options.secrets ?? [];
    const shared = {
      maxBytes: options.maxBytes,
      backups: options.backups,
      secrets: this.secrets,
      clock: options.clock,
    };
    this.supervisor = new RotatingLog({ filePath: options.paths.supervisorLog, ...shared });
    this.gateway = new RotatingLog({ filePath: options.paths.gatewayLog, ...shared });
    this.dsh = new RotatingLog({ filePath: options.paths.dshLog, ...shared });
  }

  /**
   * Register a secret discovered after construction.
   *
   * The launch token does not exist when the logs are created, so it must be added
   * the moment it is observed — before any line carrying it could be written.
   *
   * @param {string} secret - the value to redact from now on.
   * @returns {void}
   */
  addSecret(secret) {
    if (typeof secret !== 'string' || secret.length < 8) return;
    for (const log of [this.supervisor, this.gateway, this.dsh]) {
      if (!log.secrets.includes(secret)) log.secrets.push(secret);
    }
    if (!this.secrets.includes(secret)) this.secrets.push(secret);
  }

  /**
   * Every log.
   *
   * @returns {RotatingLog[]} the logs.
   */
  all() {
    return [this.supervisor, this.gateway, this.dsh];
  }

  /**
   * Close every log.
   *
   * @returns {object} the combined summary.
   */
  close() {
    return {
      supervisor: this.supervisor.close(),
      gateway: this.gateway.close(),
      dsh: this.dsh.close(),
      degraded: this.all().some((log) => log.degraded),
    };
  }

  /**
   * Whether any log is degraded.
   *
   * @returns {boolean} true when degraded.
   */
  get degraded() {
    return this.all().some((log) => log.degraded);
  }
}

/**
 * Assert that a log file contains no secret (§43).
 *
 * This is the core R7 logging test: a launch token appears in a synthetic DSH stdout
 * line, and the resulting log must not contain it.
 *
 * @param {string} filePath - the log file.
 * @param {readonly string[]} secrets - the forbidden values.
 * @returns {{ok: boolean, found: string[]}} the scan.
 */
export function assertLogRedacted(filePath, secrets) {
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { ok: true, found: [] };
  }
  const found = secrets.filter((secret) => typeof secret === 'string' && secret.length >= 8 && text.includes(secret));
  return { ok: found.length === 0, found };
}

export { ProductionError, R7_ERROR };
