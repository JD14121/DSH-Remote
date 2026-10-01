/**
 * Sequence allocator tests — R2 §9, §10, §26.2.
 *
 * Required coverage: strict monotonicity, seed, per-session isolation,
 * concurrency, invalid seed, no duplicate, large sequence, snapshot/restore.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { GatewaySequenceAllocator } from '../../src/remote/model/sequence.mjs';

const A = 'session-00000000-0000-0000-0000-000000000001';
const B = 'session-00000000-0000-0000-0000-000000000002';

test('sequences are strictly monotonic within a session', () => {
  const allocator = new GatewaySequenceAllocator();
  let previous = 0;
  for (let index = 0; index < 1000; index += 1) {
    const value = allocator.next(A);
    assert.ok(value > previous, `allocation ${index} produced ${value} after ${previous}`);
    previous = value;
  }
  assert.equal(allocator.peek(A), 1000);
});

test('1000 consecutive allocations never duplicate', () => {
  const allocator = new GatewaySequenceAllocator();
  const seen = new Set();
  for (let index = 0; index < 1000; index += 1) {
    const value = allocator.next(A);
    assert.equal(seen.has(value), false, `duplicate sequence ${value}`);
    seen.add(value);
  }
  assert.equal(seen.size, 1000);
});

test('two sessions are fully independent', () => {
  const allocator = new GatewaySequenceAllocator();

  for (let index = 0; index < 5; index += 1) allocator.next(A);
  for (let index = 0; index < 3; index += 1) allocator.next(B);

  assert.equal(allocator.peek(A), 5);
  assert.equal(allocator.peek(B), 3);
  assert.equal(allocator.next(A), 6);
  assert.equal(allocator.next(B), 4);
});

test('an interleaved allocation across sessions stays independent and correct', () => {
  const allocator = new GatewaySequenceAllocator();
  const tags = [];
  for (let index = 0; index < 30; index += 1) {
    tags.push(allocator.next(index % 2 === 0 ? A : B));
  }
  assert.equal(allocator.peek(A), 15);
  assert.equal(allocator.peek(B), 15);
  assert.ok(tags.length === 30);
});

test('seed 100 makes the next allocation 101', () => {
  const allocator = new GatewaySequenceAllocator();
  assert.equal(allocator.seed(A, 100), 100);
  assert.equal(allocator.peek(A), 100);
  assert.equal(allocator.next(A), 101);
  assert.equal(allocator.isSeeded(A), true);
});

test('the first emitted sequence is always greater than the seed', () => {
  for (const seed of [0, 1, 7, 92, 100, 999_999]) {
    const allocator = new GatewaySequenceAllocator();
    allocator.seed(A, seed);
    assert.ok(allocator.next(A) > seed, `seed ${seed} must be exceeded`);
  }
});

test('seeding supports the R5 continue-after-restart seam', () => {
  // R5 will load persisted state, seed, and continue. Prove that works without
  // any disk access and that the counter does not restart at 1 (§10).
  const firstRun = new GatewaySequenceAllocator();
  for (let index = 0; index < 5; index += 1) firstRun.next(A);
  const persisted = firstRun.snapshot();

  const secondRun = new GatewaySequenceAllocator();
  secondRun.seed(A, persisted.sessions[A].last);
  assert.equal(secondRun.next(A), 6, 'must continue, not restart');
  assert.equal(secondRun.isSeeded(A), true);
});

test('an unseeded session starts at 1 and is not marked seeded', () => {
  const allocator = new GatewaySequenceAllocator();
  assert.equal(allocator.next(A), 1);
  assert.equal(allocator.isSeeded(A), false);
});

test('a backwards seed fails closed rather than re-issuing a sequence', () => {
  const allocator = new GatewaySequenceAllocator();
  allocator.seed(A, 100);
  allocator.next(A);
  assert.equal(allocator.peek(A), 101);

  assert.throws(() => allocator.seed(A, 50), TypeError);
  // The original mark is intact.
  assert.equal(allocator.peek(A), 101);
  assert.equal(allocator.next(A), 102);
});

test('a forward seed is accepted, because a restored snapshot supersedes', () => {
  const allocator = new GatewaySequenceAllocator();
  allocator.next(A);
  assert.equal(allocator.seed(A, 500), 500);
  assert.equal(allocator.next(A), 501);
});

test('an invalid seed fails closed', () => {
  const allocator = new GatewaySequenceAllocator();

  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined, {}]) {
    assert.throws(() => allocator.seed(A, bad), TypeError, `seed ${JSON.stringify(bad)} must be rejected`);
  }
  assert.throws(() => allocator.seed('', 1), TypeError);
  assert.throws(() => allocator.seed(42, 1), TypeError);
});

test('an invalid session id is rejected on every operation', () => {
  const allocator = new GatewaySequenceAllocator();
  for (const bad of ['', null, undefined, 42, {}]) {
    assert.throws(() => allocator.next(bad), TypeError);
    assert.throws(() => allocator.peek(bad), TypeError);
    assert.throws(() => allocator.seed(bad, 1), TypeError);
    assert.throws(() => allocator.reset(bad), TypeError);
  }
});

test('concurrent emission never duplicates', async () => {
  const allocator = new GatewaySequenceAllocator();
  // 200 concurrent async emitters, each allocating synchronously. Because the
  // allocation critical section contains no await, uniqueness must hold exactly.
  const tasks = Array.from({ length: 200 }, async (_, index) => {
    await Promise.resolve();
    return allocator.next(index % 2 === 0 ? A : B);
  });

  const values = await Promise.all(tasks);
  const forA = values.filter((_, index) => index % 2 === 0);
  const forB = values.filter((_, index) => index % 2 === 1);

  assert.equal(new Set(forA).size, forA.length, 'session A allocations must be unique');
  assert.equal(new Set(forB).size, forB.length, 'session B allocations must be unique');
  assert.equal(allocator.peek(A), 100);
  assert.equal(allocator.peek(B), 100);
});

test('a large sequence value is handled without loss', () => {
  const allocator = new GatewaySequenceAllocator();
  const big = Number.MAX_SAFE_INTEGER - 5;
  allocator.seed(A, big);
  assert.equal(allocator.next(A), big + 1);
  assert.equal(Number.isSafeInteger(allocator.peek(A)), true);
});

test('snapshot and restore round-trip the allocator state', () => {
  const allocator = new GatewaySequenceAllocator();
  allocator.seed(A, 92);
  allocator.next(A);
  allocator.next(B);
  allocator.next(B);

  const snapshot = allocator.snapshot();
  assert.equal(snapshot.sessions[A].last, 93);
  assert.equal(snapshot.sessions[B].last, 2);

  const restored = new GatewaySequenceAllocator();
  restored.restore(snapshot);

  assert.equal(restored.peek(A), 93);
  assert.equal(restored.peek(B), 2);
  assert.equal(restored.isSeeded(A), true);
  assert.equal(restored.next(A), 94);
  assert.equal(restored.next(B), 3);
});

test('a malformed snapshot fails closed', () => {
  const allocator = new GatewaySequenceAllocator();
  assert.throws(() => allocator.restore(null), TypeError);
  assert.throws(() => allocator.restore({ sessions: 'nope' }), TypeError);
  assert.throws(() => allocator.restore({ sessions: { [A]: 'nope' } }), TypeError);
  assert.throws(() => allocator.restore({ sessions: { [A]: { last: -1 } } }), TypeError);
  assert.throws(() => allocator.restore({ sessions: { [A]: { last: 1.5 } } }), TypeError);
});

test('reset forgets a session, rewind returns it to its baseline', () => {
  const allocator = new GatewaySequenceAllocator();
  allocator.next(A);
  allocator.next(A);
  assert.equal(allocator.peek(A), 2);

  assert.equal(allocator.rewind(A), 0);
  assert.equal(allocator.peek(A), 0);

  assert.equal(allocator.reset(A), true);
  assert.equal(allocator.reset(A), false, 'resetting twice is harmless');
  assert.equal(allocator.next(A), 1, 'a reset session starts clean');
});

test('snapshot output is plain JSON data, and holds no DSH cursor', () => {
  const allocator = new GatewaySequenceAllocator();
  allocator.next(A);
  const snapshot = allocator.snapshot();

  // Round-trips through JSON, so it can never carry a live object.
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
  assert.deepEqual(Object.keys(snapshot).sort(), ['initial', 'sessions']);
  assert.deepEqual(Object.keys(snapshot.sessions[A]).sort(), ['baseline', 'last', 'seeded']);
  // No DSH cursor is stored here; the two spaces stay separate (§8).
  assert.equal(JSON.stringify(snapshot).includes('cursor'), false);
});
