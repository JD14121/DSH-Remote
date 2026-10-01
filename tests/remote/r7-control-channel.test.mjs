/**
 * Control channel tests — Phase R7 §20.
 *
 * The property under test is instance matching. A control directory shared across runs
 * means a `stop` request left behind by a crashed supervisor is still sitting there
 * when the next one starts — and a channel that acted on it would kill the healthy
 * replacement within milliseconds of it becoming ready.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  CONTROL_ACTION,
  CONTROL_VERSION,
  ControlChannel,
  R7_ERROR,
  buildStopRequest,
  makeTempProduction,
  validateControlRequest,
} from './r7-helpers.mjs';

/** Two channels on one root, to exercise instance matching. */
function twoInstances() {
  const { config, cleanup } = makeTempProduction();
  const a = new ControlChannel({ paths: config.paths, instanceId: 'instance-A' });
  const b = new ControlChannel({ paths: config.paths, instanceId: 'instance-B' });
  a.ensure();
  return { config, cleanup, a, b };
}

test('§20: a stop request has the documented shape', () => {
  const request = buildStopRequest({
    instanceId: 'instance-A',
    clock: () => new Date('2026-09-19T12:00:00.000Z'),
    uuid: () => 'request-1',
  });
  assert.deepEqual(request, {
    v: 1,
    instance_id: 'instance-A',
    request_id: 'request-1',
    action: 'stop',
    created_at: '2026-09-19T12:00:00.000Z',
  });
  assert.equal(CONTROL_VERSION, 1);
  assert.equal(CONTROL_ACTION.STOP, 'stop');
});

test('§20: the control channel adds no TCP port', async () => {
  const source = await fs.promises.readFile(
    new URL('../../src/remote/production/control-channel.mjs', import.meta.url), 'utf8',
  );
  for (const banned of ['node:net', 'node:http', 'node:dgram', 'createServer', '.listen(']) {
    assert.equal(source.includes(banned), false, `the control channel must not use ${banned}`);
  }
});

test('§20: a request addressed to this instance stops it', () => {
  const { cleanup, a, b } = twoInstances();
  try {
    a.requestStop();
    const result = a.poll();
    assert.equal(result.action, 'stop');
    assert.equal(result.request.instance_id, 'instance-A');
    // B must not see A's request.
    assert.equal(b.poll().action, 'none');
  } finally {
    cleanup();
  }
});

test('§20: a stale request for a previous instance does NOT stop the new one', () => {
  const { cleanup, a, b } = twoInstances();
  try {
    // Instance A asks to stop, then A dies without consuming it.
    a.requestStop();

    // Instance B starts up on the same root and polls.
    const result = b.poll();
    assert.equal(result.action, 'none', 'B must not be stopped by A\'s request');
    assert.equal(b.counters.mismatched, 1);
    assert.equal(b.counters.accepted, 0);
  } finally {
    cleanup();
  }
});

test('§20: a mismatched request is consumed, not retried forever', () => {
  const { config, cleanup, a, b } = twoInstances();
  try {
    a.requestStop();
    b.poll();
    // The file is claimed (renamed) even though it was refused, so it cannot be seen
    // again by a later poll.
    const remaining = fs.readdirSync(config.paths.control).filter((name) => name.startsWith('stop-') && !name.includes('.consumed-'));
    assert.deepEqual(remaining, []);
    assert.equal(b.poll().action, 'none');
    assert.equal(b.counters.mismatched, 1, 'not counted twice');
  } finally {
    cleanup();
  }
});

test('§20: exactly one poller observes a request', () => {
  const { cleanup, a } = twoInstances();
  try {
    a.requestStop();
    // Two channels for the SAME instance, racing. The rename claim means one wins.
    const twin = new ControlChannel({ paths: a.dir, instanceId: 'instance-A' });
    const first = a.poll();
    const second = twin.poll();
    assert.equal(first.action, 'stop');
    assert.equal(second.action, 'none', 'the loser must not also act');
  } finally {
    cleanup();
  }
});

test('§20: only matching instance plus stop is accepted', () => {
  assert.equal(validateControlRequest({ v: 1, instance_id: 'i', request_id: 'r', action: 'stop' }).ok, true);

  for (const [why, body] of [
    ['wrong version', { v: 2, instance_id: 'i', request_id: 'r', action: 'stop' }],
    ['unknown action', { v: 1, instance_id: 'i', request_id: 'r', action: 'restart' }],
    ['action as a command', { v: 1, instance_id: 'i', request_id: 'r', action: 'exec' }],
    ['missing instance', { v: 1, request_id: 'r', action: 'stop' }],
    ['missing request id', { v: 1, instance_id: 'i', action: 'stop' }],
    ['not an object', 'stop'],
    ['null', null],
    ['array', []],
  ]) {
    const decision = validateControlRequest(body);
    assert.equal(decision.ok, false, `${why} must be refused`);
  }
});

test('§20: an unknown action is not silently treated as a stop', () => {
  const { config, cleanup, a } = twoInstances();
  try {
    // A hand-written request with an unsupported action.
    const file = path.join(config.paths.control, 'stop-manual.json');
    fs.writeFileSync(file, JSON.stringify({ v: 1, instance_id: 'instance-A', request_id: 'x', action: 'shutdown' }), 'utf8');
    assert.equal(a.poll().action, 'none');
    assert.equal(a.counters.malformed, 1);
  } finally {
    cleanup();
  }
});

test('§20: a malformed request file is consumed and ignored', () => {
  const { config, cleanup, a } = twoInstances();
  try {
    fs.writeFileSync(path.join(config.paths.control, 'stop-bad.json'), 'not json at all', 'utf8');
    assert.equal(a.poll().action, 'none');
    assert.equal(a.counters.malformed, 1);
    // And it is gone, so it does not retry on every poll.
    assert.equal(a.poll().action, 'none');
    assert.equal(a.counters.malformed, 1);
  } finally {
    cleanup();
  }
});

test('§20: unrelated files in the control directory are ignored', () => {
  const { config, cleanup, a } = twoInstances();
  try {
    fs.writeFileSync(path.join(config.paths.control, 'notes.txt'), 'hello', 'utf8');
    fs.writeFileSync(path.join(config.paths.control, 'stop-notjson.txt'), 'hello', 'utf8');
    assert.equal(a.poll().action, 'none');
    assert.equal(fs.existsSync(path.join(config.paths.control, 'notes.txt')), true, 'unrelated files stay');
  } finally {
    cleanup();
  }
});

test('§20: two concurrent stop requests both survive as separate files', () => {
  const { config, cleanup, a } = twoInstances();
  try {
    const one = a.requestStop();
    const two = a.requestStop();
    assert.notEqual(one.file, two.file, 'a unique filename per request');
    const files = fs.readdirSync(config.paths.control).filter((name) => name.startsWith('stop-'));
    assert.equal(files.length, 2, 'neither request overwrote the other');
    // The first poll accepts one and claims it; the second is claimed too but the
    // action is still `stop` for the first caller.
    assert.equal(a.poll().action, 'stop');
  } finally {
    cleanup();
  }
});

test('§20: cleanup removes consumed files past their retention', () => {
  const { config, cleanup, a } = twoInstances();
  try {
    a.requestStop();
    a.poll();
    // No removal yet: the retention window has not elapsed.
    assert.equal(a.cleanup(), 0);

    // Age the consumed file past the window.
    const consumed = fs.readdirSync(config.paths.control).filter((name) => name.includes('.consumed-'));
    assert.equal(consumed.length, 1);
    const full = path.join(config.paths.control, consumed[0]);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(full, old, old);

    assert.equal(a.cleanup(), 1);
    assert.equal(fs.existsSync(full), false);
  } finally {
    cleanup();
  }
});

test('§20: poll on a missing directory is a no-op, not a crash', () => {
  const { config, cleanup } = makeTempProduction();
  try {
    const channel = new ControlChannel({ paths: config.paths, instanceId: 'x' });
    assert.equal(channel.poll().action, 'none');
    assert.equal(channel.cleanup(), 0);
  } finally {
    cleanup();
  }
});

test('§20: the channel description carries no secret', () => {
  const { cleanup, a } = twoInstances();
  try {
    const described = JSON.stringify(a.describe());
    assert.equal(described.includes('token'), false);
    assert.equal(described.includes('cookie'), false);
    assert.equal(described.includes('instance-A'), true);
  } finally {
    cleanup();
  }
});

test('§20: the documented invalid-request code exists for a caller to raise', () => {
  assert.equal(R7_ERROR.CONTROL_REQUEST_INVALID, 'R7_CONTROL_REQUEST_INVALID');
  // The assertion helper is exported for the supervisor's own use.
  return import('../../src/remote/production/control-channel.mjs').then(({ assertTargetsInstance }) => {
    assert.doesNotThrow(() => assertTargetsInstance({ instance_id: 'a' }, 'a'));
    assert.throws(
      () => assertTargetsInstance({ instance_id: 'a' }, 'b'),
      (error) => error.code === R7_ERROR.CONTROL_REQUEST_INVALID,
    );
  });
});
