/**
 * R7C.1 §8 — deterministic ControlChannel coverage.
 *
 * R7C found that a written stop request sat unconsumed for 90 s. The cause was outside this class
 * (the launcher never polled), but that was only provable because the channel itself behaves
 * correctly in isolation. These tests pin that behaviour so the next failure is attributable.
 *
 * All of it runs under an isolated temporary root; the production root is never touched.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ControlChannel, CONTROL_ACTION, buildStopRequest } from '../../src/remote/production/control-channel.mjs';
import { makeTempProduction } from './r7-helpers.mjs';

/** A control channel over an isolated root. */
function channel(config, instanceId = 'inst-A') {
  return new ControlChannel({ paths: config.paths, instanceId });
}

test('R7C.1: a valid stop request is written, consumed once, and dispatched', async () => {
  const { config, cleanup } = makeTempProduction();
  try {
    const control = channel(config);
    control.ensure();

    const written = control.requestStop();
    assert.ok(written !== null && written !== undefined, 'requestStop must report the request');

    const first = control.poll();
    assert.equal(first.action, CONTROL_ACTION.STOP, 'the request is dispatched as a stop');

    // Consumption is a rename, so a second poll cannot see it again.
    const second = control.poll();
    assert.equal(second.action, 'none', 'a consumed request is not replayed');
  } finally { cleanup(); }
});

test('R7C.1: a second supervisor on the same directory cannot double-consume', async () => {
  const { config, cleanup } = makeTempProduction();
  try {
    const a = channel(config, 'inst-A');
    const b = channel(config, 'inst-A');
    a.ensure();
    a.requestStop();

    // The rename claim means exactly one poll wins.
    const results = [a.poll().action, b.poll().action].sort();
    assert.deepEqual(results, ['none', 'stop'], 'exactly one consumer observes the request');
  } finally { cleanup(); }
});

test('R7C.1: a request for another instance is ignored', async () => {
  const { config, cleanup } = makeTempProduction();
  try {
    const a = channel(config, 'inst-A');
    a.ensure();
    // Written by B, for B.
    const b = channel(config, 'inst-B');
    b.requestStop();

    const result = a.poll();
    assert.equal(result.action, 'none', 'instance A must not act on instance B\'s request');
  } finally { cleanup(); }
});

test('R7C.1: a malformed request is consumed and rejected, not retried forever', async () => {
  const { config, cleanup } = makeTempProduction();
  try {
    const control = channel(config);
    control.ensure();
    fs.writeFileSync(path.join(config.paths.control, 'stop-broken.json'), '{ not json', 'utf8');

    const result = control.poll();
    assert.equal(result.action, 'none', 'a malformed request produces no action');
    // It must be gone, or it would be re-read on every poll.
    const remaining = fs.readdirSync(config.paths.control)
      .filter((entry) => !entry.includes('.consumed-'));
    assert.deepEqual(remaining, [], 'the malformed request was consumed');
  } finally { cleanup(); }
});

test('R7C.1: a duplicate request is harmless — the extra one is not replayed', async () => {
  const { config, cleanup } = makeTempProduction();
  try {
    const control = channel(config);
    control.ensure();
    control.requestStop();
    control.requestStop();

    const actions = [control.poll().action, control.poll().action, control.poll().action];
    assert.deepEqual(actions, ['stop', 'stop', 'none'], 'each real request is dispatched at most once');
  } finally { cleanup(); }
});

test('R7C.1: a consumed request is retained, not replayed as a new stop', async () => {
  const { config, cleanup } = makeTempProduction();
  try {
    const control = channel(config);
    control.ensure();
    control.requestStop();
    assert.equal(control.poll().action, 'stop');

    // The consumed file stays for a while (CONSUMED_RETENTION_MS) so it can be audited, but the
    // presence of a `.consumed-` file must never produce another stop.
    const consumed = fs.readdirSync(config.paths.control).filter((e) => e.includes('.consumed-'));
    assert.ok(consumed.length > 0, 'the consumed request is retained for audit');
    assert.equal(control.poll().action, 'none', 'retention must not cause a replay');
  } finally { cleanup(); }
});

test('R7C.1: buildStopRequest targets the instance it names', () => {
  const request = buildStopRequest({ instanceId: 'inst-A' });
  assert.equal(request.action, CONTROL_ACTION.STOP);
  assert.equal(request.instance_id, 'inst-A');
  // A stop request must never carry credential material.
  const serialized = JSON.stringify(request);
  for (const forbidden of ['token', 'cookie', 'authorization', 'ticket']) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false, `${forbidden} must not appear`);
  }
});

test('R7C.1: the control channel never touches the production root in tests', () => {
  // Guard: these tests use makeTempProduction, and the production root must be untouched.
  const productionRoot = 'D:\\DSH-work-test\\.dsh\\remote\\state\\control';
  const { config, cleanup } = makeTempProduction();
  try {
    assert.notEqual(path.resolve(config.paths.control), path.resolve(productionRoot),
      'the control directory must be the isolated temp root');
  } finally { cleanup(); }
});
