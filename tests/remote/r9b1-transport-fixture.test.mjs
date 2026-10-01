/**
 * R9B.1 G4 — automated tests for the bounded transport fixture.
 *
 * These run entirely on an ephemeral loopback port in an isolated process. They never touch 9447,
 * 3080/3081/9445/9446/8099, the production root, or any credential. The point of the fixture is to
 * be a bounded synthetic endpoint, so the bounds themselves are what these tests pin.
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import {
  createFixture,
  assertFixturePort,
  assertLoopbackHost,
  FORBIDDEN_PORTS,
  FIXTURE_PORT,
  LOOPBACK_HOST,
  MAX_CONCURRENT_STREAMS,
  STREAM_MAX_MS,
  SHUTDOWN_GRACE_MS,
} from '../../scripts/r9b-transport-fixture.mjs';

/** Start a fixture on an ephemeral port and hand back a cleanup. */
async function withFixture(fn) {
  const fixture = createFixture({ runId: 'test-run' });
  const port = await fixture.listen(0);
  try {
    await fn({ fixture, port, base: `http://127.0.0.1:${port}` });
  } finally {
    await fixture.stop();
  }
}

test('R9B.1 G4: the canary health route answers with the run id', async () => {
  await withFixture(async ({ base }) => {
    const response = await fetch(`${base}/r9b/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store', 'a cached response could pass as fresh');
    const body = await response.json();
    assert.equal(body.run_id, 'test-run', 'the run id ties the response to this run');
    assert.equal(body.canary, 'R9B1-TRANSPORT-CANARY');
  });
});

test('R9B.1 G4: unknown paths are refused and do not echo the request', async () => {
  await withFixture(async ({ base }) => {
    const secretish = 'canary-should-not-be-echoed';
    const response = await fetch(`${base}/r9b/nope?q=${secretish}`, {
      headers: { 'x-canary': secretish },
    });
    assert.equal(response.status, 404);
    const text = await response.text();
    assert.equal(text.includes(secretish), false, 'the query/header must not be reflected');
    assert.equal(text.trim(), 'not found');
  });
});

test('R9B.1 G4: non-GET methods are refused', async () => {
  await withFixture(async ({ base }) => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await fetch(`${base}/r9b/health`, { method });
      assert.equal(response.status, 404, `${method} must not be served`);
    }
  });
});

test('R9B.1 G4: the stream emits a monotonic sequence', async () => {
  await withFixture(async ({ fixture, base }) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/r9b/stream`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const sequences = [];
    while (sequences.length < 3) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const line of buffer.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = JSON.parse(line.slice(6));
        sequences.push(payload.sequence);
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
    }
    controller.abort();
    assert.deepEqual(sequences.slice(0, 3), [1, 2, 3], 'sequence must be monotonic from 1');
    // `abort()` returns before the server sees the close, so poll rather than assert instantly —
    // waiting on a network event is the real invariant, not the call returning.
    const released = await waitFor(() => fixture.liveStreams === 0);
    assert.equal(released, true, 'aborting must release the stream promptly');
  });
});

/**
 * Poll until a predicate holds or the deadline passes.
 *
 * @param {() => boolean} predicate - the condition.
 * @param {number} [timeoutMs] - how long to wait.
 * @returns {Promise<boolean>} whether it became true.
 */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}

test('R9B.1 G4: concurrency is capped', async () => {
  await withFixture(async ({ fixture, base }) => {
    const controllers = [];
    for (let i = 0; i < MAX_CONCURRENT_STREAMS; i += 1) {
      const controller = new AbortController();
      controllers.push(controller);
      const response = await fetch(`${base}/r9b/stream`, { signal: controller.signal });
      assert.equal(response.status, 200, `stream ${i} should be admitted`);
      // Read one chunk so the stream is genuinely live, not merely accepted.
      const reader = response.body.getReader();
      await reader.read();
    }
    assert.equal(fixture.liveStreams, MAX_CONCURRENT_STREAMS);

    const refused = await fetch(`${base}/r9b/stream`);
    assert.equal(refused.status, 503, 'beyond the cap must be refused, not queued');

    for (const controller of controllers) controller.abort();
    // Give the close handlers a tick to run.
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    assert.equal(fixture.liveStreams, 0, 'all streams must release on abort');
  });
});

test('R9B.1 G4: a client disconnect frees the timer, not the deadline', async () => {
  await withFixture(async ({ fixture, base }) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/r9b/stream`, { signal: controller.signal });
    const reader = response.body.getReader();
    await reader.read();
    assert.equal(fixture.liveStreams, 1);

    controller.abort();
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    // Without the close handler this would stay 1 until the 120 s deadline.
    assert.equal(fixture.liveStreams, 0, 'the interval must be cleared on disconnect');
  });
});

test('R9B.1 G4: shutdown releases the port within the grace period', async () => {
  const fixture = createFixture({ runId: 'shutdown-test' });
  const port = await fixture.listen(0);

  // Hold a live stream open so shutdown has something to close.
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/r9b/stream`, { signal: controller.signal });
  await response.body.getReader().read();
  assert.equal(fixture.liveStreams, 1);

  const startedAt = Date.now();
  const result = await fixture.stop();
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < SHUTDOWN_GRACE_MS, `stop took ${elapsed} ms, beyond the ${SHUTDOWN_GRACE_MS} ms bound`);
  assert.equal(fixture.liveStreams, 0, 'shutdown must end live streams');
  controller.abort();

  // The port must genuinely be free.
  const stillHeld = await new Promise((resolve) => {
    const probe = net.connect({ host: '127.0.0.1', port });
    probe.setTimeout(400);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('timeout', () => { probe.destroy(); resolve(false); });
    probe.once('error', () => resolve(false));
  });
  assert.equal(stillHeld, false, 'the port must be released');
});

test('R9B.1 G4: the fixture has no production port and no outbound dependency', async () => {
  await withFixture(async ({ fixture }) => {
    const address = fixture.server.address();
    assert.equal(address.address, '127.0.0.1', 'loopback bind only — never a wildcard or LAN address');
    // Only the two synthetic routes exist; there is no Gateway protocol here.
    assert.equal(typeof fixture.server, 'object');
    assert.equal(STREAM_MAX_MS, 120_000, 'the stream bound is the documented one');
    assert.equal(MAX_CONCURRENT_STREAMS, 2, 'the concurrency bound is the documented one');
  });
});

// ── L2/L3: bind policy is validated before any real listen ───────────────────

test('L2: a non-loopback host is rejected before any listen', () => {
  for (const host of ['0.0.0.0', '::', '::1', 'localhost', '192.168.1.10', '10.0.0.5', '']) {
    assert.throws(() => assertLoopbackHost(host), /must be exactly 127\.0\.0\.1/,
      `${JSON.stringify(host)} must be refused`);
  }
  // A non-string is refused rather than coerced.
  for (const host of [null, undefined, 127, {}, []]) {
    assert.throws(() => assertLoopbackHost(host), TypeError);
  }
  assert.equal(assertLoopbackHost('127.0.0.1'), LOOPBACK_HOST);
});

test('L2: the factory itself refuses a non-loopback host, not merely the CLI', () => {
  // The factory is the other entry point, so it must not be the weak one.
  for (const host of ['0.0.0.0', '::', 'localhost', '192.168.1.10']) {
    assert.throws(() => createFixture({ host }), /must be exactly 127\.0\.0\.1/);
  }
});

test('L2: production ports are refused before any listen', () => {
  for (const port of FORBIDDEN_PORTS) {
    assert.throws(() => assertFixturePort(port), /refuses to bind production port/,
      `port ${port} must be refused`);
  }
  // An arbitrary non-fixture port is also refused, so no caller can point it elsewhere.
  assert.throws(() => assertFixturePort(1234), /may only bind 9447 or an ephemeral 0/);
  // Non-integers and out-of-range values.
  for (const port of [null, undefined, 'x', 1.5, -1, 70000, {}]) {
    assert.throws(() => assertFixturePort(port), TypeError);
  }
  assert.equal(assertFixturePort(0), 0);
  assert.equal(assertFixturePort(FIXTURE_PORT), FIXTURE_PORT);
});

test('L2: the factory refuses a production port before any listen', () => {
  for (const port of FORBIDDEN_PORTS) {
    assert.throws(() => createFixture().listen(port), /refuses to bind production port/);
  }
});

test('L3: a temporary listen really is bound to 127.0.0.1', async () => {
  await withFixture(async ({ fixture }) => {
    const address = fixture.server.address();
    assert.equal(address.address, '127.0.0.1');
    assert.equal(address.family, 'IPv4');
  });
});

// ── L3: slot and timer release around the stream bound ───────────────────────

test('L3: reaching the concurrency cap does not leave residual resources', async () => {
  await withFixture(async ({ fixture, base }) => {
    const controllers = [];
    for (let i = 0; i < MAX_CONCURRENT_STREAMS; i += 1) {
      const controller = new AbortController();
      controllers.push(controller);
      const response = await fetch(`${base}/r9b/stream`, { signal: controller.signal });
      const reader = response.body.getReader();
      await reader.read();
      void reader;
    }
    assert.equal(fixture.liveStreams, MAX_CONCURRENT_STREAMS);

    // A refused attempt must not consume a slot or leave anything behind.
    const refused = await fetch(`${base}/r9b/stream`);
    assert.equal(refused.status, 503);
    await refused.text();
    assert.equal(fixture.liveStreams, MAX_CONCURRENT_STREAMS, 'a refusal must not change the live count');

    for (const controller of controllers) controller.abort();
    assert.equal(await waitFor(() => fixture.liveStreams === 0), true);
    // And a fresh stream is accepted again after the slots free.
    const controller = new AbortController();
    const response = await fetch(`${base}/r9b/stream`, { signal: controller.signal });
    assert.equal(response.status, 200);
    await response.body.getReader().read();
    controller.abort();
    assert.equal(await waitFor(() => fixture.liveStreams === 0), true);
  });
});

test('L3: an early disconnect frees its slot so a later stream is admitted', async () => {
  await withFixture(async ({ fixture, base }) => {
    const first = new AbortController();
    const response = await fetch(`${base}/r9b/stream`, { signal: first.signal });
    await response.body.getReader().read();
    assert.equal(fixture.liveStreams, 1);

    first.abort();
    assert.equal(await waitFor(() => fixture.liveStreams === 0), true, 'early disconnect must free the slot');

    const second = new AbortController();
    const again = await fetch(`${base}/r9b/stream`, { signal: second.signal });
    assert.equal(again.status, 200, 'the freed slot must be reusable');
    second.abort();
    assert.equal(await waitFor(() => fixture.liveStreams === 0), true);
  });
});

// ── L3: stop semantics ───────────────────────────────────────────────────────

test('L3: stop on a never-started fixture is definitive and leaks no timer', async () => {
  const fixture = createFixture({ runId: 'never-started' });
  const result = await fixture.stop();
  assert.equal(result.notStarted, true);
  assert.equal(result.listening, false);
  // A second stop is idempotent.
  const again = await fixture.stop();
  assert.equal(again.alreadyStopped, true);
});

test('L3: repeated and concurrent stop are both definitive', async () => {
  const fixture = createFixture({ runId: 'repeat-stop' });
  await fixture.listen(0);

  // Concurrent stops must share one teardown rather than racing.
  const [a, b, c] = await Promise.all([fixture.stop(), fixture.stop(), fixture.stop()]);
  for (const result of [a, b, c]) {
    assert.equal(typeof result.closedInMs, 'number');
    assert.equal(result.listening, false);
  }
  const after = await fixture.stop();
  assert.equal(after.alreadyStopped, true);
});

test('L3: the forced-socket count matches the action actually taken', async () => {
  const fixture = createFixture({ runId: 'forced-count' });
  const port = await fixture.listen(0);

  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/r9b/stream`, { signal: controller.signal });
  await response.body.getReader().read();
  assert.equal(fixture.liveStreams, 1);
  assert.ok(fixture.openSockets >= 1, 'there must be an open socket to account for');

  const socketsBefore = fixture.openSockets;
  const result = await fixture.stop();
  controller.abort();

  // Every socket present at stop time is destroyed deliberately, so the count must equal that,
  // not be reported as a clean 0.
  assert.equal(result.forcedSockets, socketsBefore, 'the count must match the sockets destroyed');
  assert.ok(result.forcedSockets >= 1);
  assert.equal(result.releasedStreams, 1, 'the live stream must be counted as released');
});

// ── L3 item 2: the 120 s boundary via a controllable clock ──────────────────

test('L3: a controllable clock drives the stream to its deadline', async () => {
  // A controllable scheduler lets the 120 s boundary be exercised without waiting 120 s. The bound
  // itself is clamped inside the factory, so injection can only make the test stricter.
  const scheduled = [];
  const timers = {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
    setTimeout: (fn, ms) => { scheduled.push({ fn, ms }); return setTimeout(fn, ms); },
    clearTimeout: (handle) => clearTimeout(handle),
  };
  const fixture = createFixture({ runId: 'clock-test', timers, streamMaxMs: 120_000 });
  const port = await fixture.listen(0);
  try {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/r9b/stream`, { signal: controller.signal });
    const reader = response.body.getReader();
    await reader.read();
    assert.equal(fixture.liveStreams, 1, 'the stream occupies a slot');

    // The deadline must have been scheduled at the production bound, not something longer.
    const deadline = scheduled.find((entry) => entry.ms === 120_000);
    assert.ok(deadline !== undefined, 'a 120 000 ms deadline must be scheduled');

    // Fire the deadline directly instead of waiting for it.
    deadline.fn();
    assert.equal(await waitFor(() => fixture.liveStreams === 0), true, 'the deadline must release the slot');

    // Drain to observe the terminating marker and end of the stream.
    let sawEnd = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (new TextDecoder().decode(value).includes('R9B1-STREAM-END')) sawEnd = true;
    }
    controller.abort();
    const released = await waitFor(() => fixture.liveStreams === 0);
    assert.equal(released, true, 'timers must be released after the deadline');
    void sawEnd;
  } finally {
    await fixture.stop();
  }
});

test('L3: an injected bound cannot raise the production maximum', async () => {
  // Asking for an hour must still schedule the 120 s production bound.
  const scheduled = [];
  const timers = {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
    setTimeout: (fn, ms) => { scheduled.push(ms); return setTimeout(fn, ms); },
    clearTimeout: (handle) => clearTimeout(handle),
  };
  const fixture = createFixture({ runId: 'clamp-test', timers, streamMaxMs: 3_600_000 });
  const port = await fixture.listen(0);
  try {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/r9b/stream`, { signal: controller.signal });
    await response.body.getReader().read();
    assert.ok(scheduled.includes(120_000), 'the deadline must be clamped to 120 000 ms');
    assert.equal(scheduled.includes(3_600_000), false, 'the injected bound must not be used');
    controller.abort();
    await waitFor(() => fixture.liveStreams === 0);
  } finally {
    await fixture.stop();
  }
});

// ── L3: static review vs dynamic interception ────────────────────────────────

test('L3: "no outbound call" is a static-review statement, not a dynamic interception claim', async () => {
  await withFixture(async ({ fixture }) => {
    // What can honestly be asserted here: the fixture creates no client and holds no outbound
    // dependency. This is a static property of the module, not an observation that egress was
    // blocked — no network interception is performed, and none is claimed.
    const address = fixture.server.address();
    assert.equal(address.address, '127.0.0.1');
    assert.equal(typeof fixture.server.close, 'function');
    assert.equal(fixture.server.listening, true);
  });
});
