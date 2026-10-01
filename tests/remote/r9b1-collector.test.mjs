/**
 * R9B.1 L1/L4 — offline tests for collection judgement and evidence aggregation.
 *
 * Every case here is driven from an injected result. Nothing touches a real service, a real port, or
 * the production root: the point is to prove how failures are *read*, not to manufacture failures.
 *
 * The table in L1 is transcribed directly into the cases below.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHECK_STATUS,
  aggregate,
  classifyCommandResult,
  countPeers,
  interpretServeStatus,
  judgeListeners,
  parseJsonResult,
  scanForSecrets,
} from '../../scripts/lib/r9b1-collector.mjs';

const EMPTY_SERVE = /^no serve config$/im;

// ── L1 table, row 1: non-zero exit with empty stdout, even with JSON-looking output ──

test('L1: a non-zero exit is never usable, even when the output looks like valid JSON', () => {
  const result = { exitCode: 1, stdout: '{"BackendState":"Running"}', timedOut: false };
  const classified = classifyCommandResult(result);
  assert.equal(classified.usable, false);
  assert.equal(classified.status, CHECK_STATUS.FAIL);
  assert.match(classified.reason, /exited 1/);

  // And it must not pass through the JSON path either.
  const parsed = parseJsonResult(result, ['BackendState']);
  assert.equal(parsed.usable, false);
  assert.equal(parsed.value, null);
});

// ── L1 table, row 2: timeout, denial, corrupt JSON, missing fields ────────────

test('L1: a timeout is INCONCLUSIVE, not an empty reading', () => {
  const classified = classifyCommandResult({ exitCode: null, timedOut: true, stdout: '' });
  assert.equal(classified.usable, false);
  assert.equal(classified.status, CHECK_STATUS.INCONCLUSIVE);
  assert.match(classified.reason, /timed out/);
});

test('L1: a command that never ran is INCONCLUSIVE', () => {
  const classified = classifyCommandResult({ error: 'ENOENT', stdout: '' });
  assert.equal(classified.usable, false);
  assert.equal(classified.status, CHECK_STATUS.INCONCLUSIVE);
});

test('L1: corrupt JSON is INCONCLUSIVE with a reason', () => {
  const parsed = parseJsonResult({ exitCode: 0, stdout: '{ not json', timedOut: false });
  assert.equal(parsed.usable, false);
  assert.equal(parsed.status, CHECK_STATUS.INCONCLUSIVE);
  assert.match(parsed.reason, /not valid JSON/);
});

test('L1: JSON missing a required field is INCONCLUSIVE', () => {
  const parsed = parseJsonResult({ exitCode: 0, stdout: '{"BackendState":"Running"}', timedOut: false }, ['Self']);
  assert.equal(parsed.usable, false);
  assert.equal(parsed.status, CHECK_STATUS.INCONCLUSIVE);
  assert.match(parsed.reason, /missing required fields: Self/);
});

// ── L1 table, row 3: a genuine, verified empty configuration ─────────────────

test('L1: a verified empty-configuration string is read as absent', () => {
  const reading = interpretServeStatus({ exitCode: 0, stdout: 'No serve config\n', timedOut: false }, EMPTY_SERVE);
  assert.equal(reading.config_present, false);
  assert.equal(reading.status, CHECK_STATUS.PASS);
});

test('L1: a successful but blank Serve reading is NOT "no configuration"', () => {
  const reading = interpretServeStatus({ exitCode: 0, stdout: '   \n', timedOut: false }, EMPTY_SERVE);
  assert.equal(reading.config_present, null, 'unknown, never absent');
  assert.equal(reading.status, CHECK_STATUS.INCONCLUSIVE);
});

test('L1: a failed Serve command is never read as "no configuration"', () => {
  const reading = interpretServeStatus({ exitCode: 1, stdout: '', timedOut: false }, EMPTY_SERVE);
  assert.equal(reading.config_present, null);
  assert.equal(reading.status, CHECK_STATUS.FAIL);
});

test('L1: unrecognised Serve output asserts presence without claiming to parse it', () => {
  const reading = interpretServeStatus(
    { exitCode: 0, stdout: 'https://host/\n|-- / proxy http://127.0.0.1:9447\n', timedOut: false },
    EMPTY_SERVE,
  );
  assert.equal(reading.config_present, true);
  assert.equal(reading.status, CHECK_STATUS.INCONCLUSIVE);
});

// ── L1 table, row 4: unknown occupancy or IPv6 wildcard must not pass ─────────

test('L1: an unknown occupation of a must-be-free port blocks the baseline', () => {
  const verdict = judgeListeners({
    3080: { listening: true, address: '127.0.0.1', pid: 100, owner_known: true },
    3081: { listening: false, address: null, pid: null, owner_known: true },
    9445: { listening: false, address: null, pid: null, owner_known: true },
    9446: { listening: true, address: '127.0.0.1', pid: 200, owner_known: false },
    9447: { listening: false, address: null, pid: null, owner_known: true },
    8099: { listening: false, address: null, pid: null, owner_known: true },
  });
  assert.equal(verdict.status, CHECK_STATUS.BLOCKED);
  assert.match(verdict.reason, /unknown owner/);
});

test('L1: an IPv6 wildcard bind blocks even though the port is otherwise free', () => {
  const verdict = judgeListeners({
    3080: { listening: false, address: null, pid: null, owner_known: true },
    3081: { listening: false, address: null, pid: null, owner_known: true },
    9445: { listening: false, address: null, pid: null, owner_known: true },
    9446: { listening: false, address: '::', pid: null, owner_known: true },
    9447: { listening: false, address: null, pid: null, owner_known: true },
    8099: { listening: false, address: null, pid: null, owner_known: true },
  });
  assert.equal(verdict.status, CHECK_STATUS.BLOCKED);
  assert.match(verdict.reason, /wildcard/);
});

// ── L1 table, row 5: collection failure means unknown ────────────────────────

test('L1: a failed listener collection is unknown, not an inference of no listener', () => {
  const verdict = judgeListeners(null);
  assert.equal(verdict.status, CHECK_STATUS.INCONCLUSIVE);
  assert.match(verdict.reason, /must not be inferred/);
});

// ── L1 table, row 6: the operator's absence is not a failure ────────────────

test('L1: the operator port not running does not fail the baseline', () => {
  const verdict = judgeListeners({
    3080: { listening: false, address: null, pid: null, owner_known: true },
    3081: { listening: false, address: null, pid: null, owner_known: true },
    9445: { listening: false, address: null, pid: null, owner_known: true },
    9446: { listening: false, address: null, pid: null, owner_known: true },
    9447: { listening: false, address: null, pid: null, owner_known: true },
    8099: { listening: false, address: null, pid: null, owner_known: true },
  });
  assert.equal(verdict.status, CHECK_STATUS.PASS);
  assert.match(verdict.reason, /not observed listening \(not a failure\)/);
});

// ── L1 table, row 7: any required FAIL stops a top-level PASS ────────────────

test('L4: a single required FAIL makes the whole verdict FAIL even when everything else passes', () => {
  const verdict = aggregate([
    { id: 'G0', status: CHECK_STATUS.PASS },
    { id: 'G1', status: CHECK_STATUS.PASS },
    { id: 'G5', status: CHECK_STATUS.FAIL },
    { id: 'G6', status: CHECK_STATUS.PASS },
  ]);
  assert.equal(verdict.verdict, CHECK_STATUS.FAIL);
  assert.match(verdict.reason, /G5/);
});

test('L4: no FAIL but a required non-PASS yields BLOCKED, never PASS', () => {
  const verdict = aggregate([
    { id: 'G0', status: CHECK_STATUS.PASS },
    { id: 'G1', status: CHECK_STATUS.BLOCKED },
    { id: 'G6', status: CHECK_STATUS.NOT_RUN },
  ]);
  assert.equal(verdict.verdict, CHECK_STATUS.BLOCKED);
  assert.match(verdict.reason, /G1=BLOCKED/);
});

test('L4: technical PASS requires every required check to pass', () => {
  const verdict = aggregate([
    { id: 'G0', status: CHECK_STATUS.PASS },
    { id: 'G4', status: CHECK_STATUS.PASS },
  ]);
  assert.equal(verdict.verdict, CHECK_STATUS.PASS);
});

test('L4: a non-required check cannot block a PASS', () => {
  const verdict = aggregate([
    { id: 'G0', status: CHECK_STATUS.PASS },
    { id: 'G8', status: CHECK_STATUS.NOT_RUN, required: false },
  ]);
  assert.equal(verdict.verdict, CHECK_STATUS.PASS);
});

// ── L1 table, row 8: peer counting from JSON ────────────────────────────────

test('L1: zero peers from an empty mapping is 0, not 1', () => {
  const counted = countPeers({ Peer: {} });
  assert.equal(counted.count, 0, 'an empty mapping must not wrap into one element');
  assert.equal(counted.status, CHECK_STATUS.PASS);
});

test('L1: an array-form peer list counts by length', () => {
  assert.equal(countPeers({ Peer: [{}, {}] }).count, 2);
  assert.equal(countPeers({ Peer: [] }).count, 0);
});

test('L1: an absent Peer field on a corroborated status object means zero peers', () => {
  // Go omits an empty map, so this is the real zero-peer case, not an unreadable one.
  const counted = countPeers({ BackendState: 'Running', Self: { HostName: 'pc' } });
  assert.equal(counted.count, 0);
  assert.equal(counted.status, CHECK_STATUS.PASS);
});

test('L1: an absent Peer field with nothing to corroborate it stays INCONCLUSIVE', () => {
  // A truncated response must not be misread as "no peers".
  const counted = countPeers({});
  assert.equal(counted.count, null);
  assert.equal(counted.status, CHECK_STATUS.INCONCLUSIVE);
});

test('L1: a non-object status value is INCONCLUSIVE', () => {
  assert.equal(countPeers(null).status, CHECK_STATUS.INCONCLUSIVE);
  assert.equal(countPeers('nope').status, CHECK_STATUS.INCONCLUSIVE);
});

test('L1: a non-object Peer field is INCONCLUSIVE', () => {
  assert.equal(countPeers({ Peer: 'none' }).status, CHECK_STATUS.INCONCLUSIVE);
});

// ── evidence hygiene ────────────────────────────────────────────────────────

test('L4: secret markers are detected before evidence is written', () => {
  assert.deepEqual(scanForSecrets({ note: 'fine' }), []);
  assert.ok(scanForSecrets({ leak: 'tskey-auth-abc' }).includes('tskey-'));
  assert.ok(scanForSecrets({ leak: 'Authorization: Bearer xyz' }).includes('Bearer '));
});
