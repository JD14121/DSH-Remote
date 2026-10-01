/**
 * R9B.1 L1 — honest collection and judgement.
 *
 * ## Why this module exists
 *
 * The first baseline collector treated any process exit as usable. A command that failed, timed out,
 * or returned blank could therefore be read as "no Serve config" — turning an unknown into a PASS.
 * L1 requires the opposite: only a successful exit *with valid structure* may participate in a PASS,
 * and everything else must be FAIL, INCONCLUSIVE or unknown.
 *
 * The judgement logic is deliberately separated from real collection so it can be driven from
 * injected results offline. No test needs to break a real service to prove how a failure is read.
 *
 * Pure functions only: no CLI invocation, no network, no filesystem writes.
 */

/** The statuses a check may carry. */
export const CHECK_STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  BLOCKED: 'BLOCKED',
  NOT_RUN: 'NOT_RUN',
  INCONCLUSIVE: 'INCONCLUSIVE',
});

/**
 * Fixed aggregation rules (L4).
 *
 * Any FAIL makes the whole FAIL. With no FAIL, any non-PASS required check makes it BLOCKED. Only
 * when every required check passes may technical acceptance be recorded as PASS. Human acceptance is
 * tracked separately and is never implied by a technical PASS.
 *
 * @param {Array<{id: string, status: string, required?: boolean}>} checks - the checks.
 * @returns {{verdict: string, reason: string}} the aggregate.
 */
export function aggregate(checks) {
  const required = checks.filter((c) => c.required !== false);
  const failed = required.filter((c) => c.status === CHECK_STATUS.FAIL);
  if (failed.length > 0) {
    return { verdict: CHECK_STATUS.FAIL, reason: `required checks failed: ${failed.map((c) => c.id).join(', ')}` };
  }
  const notPassed = required.filter((c) => c.status !== CHECK_STATUS.PASS);
  if (notPassed.length > 0) {
    return {
      verdict: CHECK_STATUS.BLOCKED,
      reason: `required checks not established: ${notPassed.map((c) => `${c.id}=${c.status}`).join(', ')}`,
    };
  }
  return { verdict: CHECK_STATUS.PASS, reason: 'every required check passed' };
}

/**
 * Classify one command result.
 *
 * @param {object} result - `exitCode`, `timedOut`, `stdout`, `stderr`, `error`.
 * @returns {{usable: boolean, status: string, reason: string}} the classification.
 */
export function classifyCommandResult(result) {
  if (result?.timedOut === true) {
    return { usable: false, status: CHECK_STATUS.INCONCLUSIVE, reason: 'the command timed out; its output is not evidence' };
  }
  if (result?.error !== undefined && result?.exitCode === undefined) {
    return { usable: false, status: CHECK_STATUS.INCONCLUSIVE, reason: `the command could not be run: ${String(result.error).slice(0, 120)}` };
  }
  if (result?.exitCode !== 0) {
    // A non-zero exit disqualifies the result even when the attached output looks like valid JSON —
    // exactly the case the L1 table calls out.
    return {
      usable: false,
      status: CHECK_STATUS.FAIL,
      reason: `the command exited ${result?.exitCode}; its output cannot be treated as a successful reading`,
    };
  }
  const stdout = typeof result?.stdout === 'string' ? result.stdout.trim() : '';
  if (stdout.length === 0) {
    return { usable: false, status: CHECK_STATUS.INCONCLUSIVE, reason: 'the command succeeded but produced no output to interpret' };
  }
  return { usable: true, status: CHECK_STATUS.PASS, reason: 'the command exited 0 with output' };
}

/**
 * Parse JSON that a command was expected to produce.
 *
 * @param {object} result - as for {@link classifyCommandResult}.
 * @param {string[]} [requiredFields] - fields that must exist on the parsed object.
 * @returns {{usable: boolean, status: string, reason: string, value: object|null}} the parse outcome.
 */
export function parseJsonResult(result, requiredFields = []) {
  const classified = classifyCommandResult(result);
  if (!classified.usable) return { ...classified, value: null };

  let value;
  try {
    value = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  } catch (error) {
    return { usable: false, status: CHECK_STATUS.INCONCLUSIVE, reason: `output was not valid JSON: ${String(error?.message).slice(0, 80)}`, value: null };
  }
  if (value === null || typeof value !== 'object') {
    return { usable: false, status: CHECK_STATUS.INCONCLUSIVE, reason: 'output parsed but was not an object', value: null };
  }
  const missing = requiredFields.filter((field) => value[field] === undefined);
  if (missing.length > 0) {
    return { usable: false, status: CHECK_STATUS.INCONCLUSIVE, reason: `output was missing required fields: ${missing.join(', ')}`, value: null };
  }
  return { usable: true, status: CHECK_STATUS.PASS, reason: 'output parsed with the required fields', value };
}

/**
 * Interpret a Serve/Funnel status reading.
 *
 * A blank or unrecognised success is *not* "no configuration" (L1). Only an explicitly recognised
 * empty-configuration string may be read as absent; anything else is INCONCLUSIVE.
 *
 * @param {object} result - as for {@link classifyCommandResult}.
 * @param {RegExp} emptyPattern - the verified empty-configuration pattern for this CLI version.
 * @returns {{config_present: boolean|null, status: string, reason: string}} the reading.
 */
export function interpretServeStatus(result, emptyPattern) {
  const classified = classifyCommandResult(result);
  if (!classified.usable) {
    // Unknown, never "absent".
    return { config_present: null, status: classified.status, reason: classified.reason };
  }
  const text = result.stdout.trim();
  if (emptyPattern.test(text)) {
    return { config_present: false, status: CHECK_STATUS.PASS, reason: 'the command reported an explicitly verified empty configuration' };
  }
  if (text.length === 0) {
    return { config_present: null, status: CHECK_STATUS.INCONCLUSIVE, reason: 'empty output is not evidence of an empty configuration' };
  }
  // Some configuration text exists, but this collector does not parse its shape, so presence is
  // asserted without claiming to understand the contents.
  return { config_present: true, status: CHECK_STATUS.INCONCLUSIVE, reason: 'output was neither the verified empty form nor parseable here; ownership must be resolved manually' };
}

/**
 * Count peers from a Tailscale status object.
 *
 * Uses the JSON mapping, because a PowerShell array of zero results wraps into a single empty element
 * and reports 1. `Peer` may be an object or an array depending on version.
 *
 * @param {object} statusValue - the parsed status.
 * @returns {{count: number|null, status: string, reason: string}} the count.
 */
export function countPeers(statusValue) {
  if (statusValue === null || typeof statusValue !== 'object') {
    return { count: null, status: CHECK_STATUS.INCONCLUSIVE, reason: 'the status value was not an object' };
  }
  const peer = statusValue.Peer;
  // Go omits an empty map from JSON, so a valid status object with no `Peer` key means zero peers —
  // not an unreadable value. The surrounding payload must still be recognisably a status object, or
  // a truncated response would be misread as "no peers".
  if (peer === undefined) {
    const looksLikeStatus = typeof statusValue.BackendState === 'string'
      || statusValue.Self !== undefined
      || statusValue.CurrentTailnet !== undefined;
    if (!looksLikeStatus) {
      return { count: null, status: CHECK_STATUS.INCONCLUSIVE, reason: 'the status object had no Peer field and no other status fields to corroborate it' };
    }
    return { count: 0, status: CHECK_STATUS.PASS, reason: 'no Peer field on a corroborated status object, which an empty Go map produces' };
  }
  if (Array.isArray(peer)) return { count: peer.length, status: CHECK_STATUS.PASS, reason: 'peer array length' };
  if (peer === null) return { count: 0, status: CHECK_STATUS.PASS, reason: 'a null Peer field means no peers' };
  if (typeof peer === 'object') return { count: Object.keys(peer).length, status: CHECK_STATUS.PASS, reason: 'peer mapping key count' };
  return { count: null, status: CHECK_STATUS.INCONCLUSIVE, reason: 'the Peer field was neither an object nor an array' };
}

/** Ports this phase must account for. */
export const RELEVANT_PORTS = Object.freeze([3080, 3081, 9445, 9446, 9447, 8099]);

/** Ports that must be free for this phase's baseline to pass. */
export const MUST_BE_FREE = Object.freeze([3081, 9445, 9446, 9447, 8099]);

/** Ports whose ownership is recorded but whose absence is not a failure. */
export const OBSERVED_ONLY = Object.freeze([3080]);

/**
 * Judge a listener inventory.
 *
 * Never probes 3080/3081/9445 over TCP or HTTP: the inventory is read from the local passive table.
 * An unknown owner on a must-be-free port is a blocking condition, not something to terminate.
 *
 * @param {object} inventory - `{port: {listening: boolean, address: string|null, pid: number|null, owner_known: boolean}}`.
 * @returns {{status: string, reason: string, blockers: string[]}} the judgement.
 */
export function judgeListeners(inventory) {
  const blockers = [];
  if (inventory === null || typeof inventory !== 'object') {
    return { status: CHECK_STATUS.INCONCLUSIVE, reason: 'the listener inventory could not be collected; absence of a listener must not be inferred', blockers };
  }

  for (const port of MUST_BE_FREE) {
    const entry = inventory[port];
    if (entry === undefined) {
      blockers.push(`port ${port} was not sampled`);
      continue;
    }
    if (entry.listening === true) {
      blockers.push(entry.owner_known === true
        ? `port ${port} is held by pid ${entry.pid}`
        : `port ${port} is held by an unknown owner`);
    }
    // An IPv6 wildcard listener is an exposure even on an otherwise free port.
    if (entry.address === '::' || entry.address === '0.0.0.0') {
      blockers.push(`port ${port} is bound to a wildcard address ${entry.address}`);
    }
  }

  // The operator port is observed only.
  const operatorNote = inventory[3080]?.listening === true
    ? 'operator 3080 observed listening (not a failure)'
    : 'operator 3080 not observed listening (not a failure)';

  if (blockers.length > 0) {
    return { status: CHECK_STATUS.BLOCKED, reason: `${blockers.join('; ')}; ${operatorNote}`, blockers };
  }
  return { status: CHECK_STATUS.PASS, reason: `all must-be-free ports are free; ${operatorNote}`, blockers };
}

/**
 * Encrypted blob detection for evidence hygiene, so a secret cannot be written unnoticed.
 *
 * @param {unknown} value - the value to scan.
 * @returns {string[]} the names of any suspicious markers found.
 */
export function scanForSecrets(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const markers = ['tskey-', 'BEGIN PRIVATE KEY', 'BEGIN CERTIFICATE', 'Bearer ', 'nodekey:', 'authKey', 'AuthKey'];
  return markers.filter((marker) => text.includes(marker));
}
