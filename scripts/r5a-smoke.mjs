/**
 * R5A §20, §21: two temp-root smoke checks.
 *
 * They exist to prove the remediation did not disturb R5's core durability
 * semantics. Each uses its **own** OS temp root, and the real `$DSH_HOME\remote` is
 * never touched — asserted before and after, not merely intended.
 *
 * Run with `npm run smoke:r5a`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EventsService } from '../src/remote/events.mjs';
import { SessionViewStore } from '../src/remote/state/session-view-store.mjs';
import { makeSession } from '../src/remote/model/session.mjs';
import { PersistenceService } from '../src/remote/persistence/persistence.mjs';
import { resolvePersistenceConfig, resolveDshHome } from '../src/remote/persistence/config.mjs';
import { beginReplay, REPLAY_OUTCOME } from '../src/remote/ws/replay.mjs';

const SESSION = 'session-00000000-0000-0000-0000-0000000000aa';
const CLOCK = () => 1_789_800_000_000;

const REAL_HOME = resolveDshHome(process.env);
const REAL_ROOT = path.join(REAL_HOME, 'remote');

/**
 * Refuse to run if the real state root exists.
 *
 * @param {string} when - a label for the failure.
 * @returns {void}
 */
function assertRealRootAbsent(when) {
  if (fs.existsSync(REAL_ROOT)) {
    throw new Error(`R5A_REAL_STATE_ROOT_TOUCHED (${when}): ${REAL_ROOT}`);
  }
}

/**
 * Build one "process" over a state root.
 *
 * @param {string} root - the state root.
 * @param {object} [config] - extra persistence config.
 * @returns {object} the bundle.
 */
function boot(root, config = {}) {
  const store = new SessionViewStore({ clock: CLOCK });
  const persistence = new PersistenceService({
    config: { root, segmentBytes: 65_536, ...config },
    store,
    clock: CLOCK,
  });
  const events = new EventsService({ adapter: {}, store, clock: CLOCK, ringSize: config.ringSize ?? 1000 });
  events.setSink((event) => persistence.append(event));
  persistence.attachEvents(events);
  return { store, persistence, events };
}

/** Run `fn`, always reporting whether the real root appeared. */
async function smoke(name, fn) {
  assertRealRootAbsent(`before ${name}`);
  const { root, cleanup } = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'r5a-smoke-')), cleanup: null };
  // A temp root must never be inside DSH_HOME; if it were, the smoke itself is unsafe.
  assert.equal(root.startsWith(path.resolve(REAL_HOME) + path.sep), false);

  try {
    const detail = await fn(root);
    console.log(`PASS  ${name}`);
    if (detail !== undefined) console.log(`      ${detail}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assertRealRootAbsent(`after ${name}`);
}

console.log('R5A SMOKE CHECKS');
console.log(`temp roots only; real root is ${REAL_ROOT}`);
console.log('');
assertRealRootAbsent('startup');

// ── §20: durable restart smoke ───────────────────────────────────────────────
await smoke('durable restart: 1..5, stop, recover highWater=5, next event 6', async (root) => {
  let finalRecorded = 0;
  {
    const a = boot(root);
    a.persistence.initialize();
    a.persistence.start();
    a.store.upsertSession(makeSession({ id: SESSION }));
    for (let index = 1; index <= 5; index += 1) {
      a.events.emit({ sessionId: SESSION, event: 'task.progress', data: { index } });
    }
    finalRecorded = a.persistence.journals.get(SESSION).highWater;
    a.persistence.shutdown();
    assert.equal(finalRecorded, 5, 'the journal should hold 1..5');
  }
  {
    const b = boot(root);
    const report = b.persistence.initialize();
    b.persistence.start();

    assert.equal(report.journals.records, 5, 'all five records recovered');
    assert.equal(report.seeded[0].seeded, 5, 'the allocator was seeded to 5');

    const next = b.events.emit({ sessionId: SESSION, event: 'task.progress', data: { next: true } });
    assert.equal(next.sequence, 6, 'the next live event must be 6, not 1');
    b.persistence.shutdown();
    return `highWater recovered = ${report.seeded[0].seeded}, next live sequence = ${next.sequence}`;
  }
});

// ── §21: journal-vs-ring smoke ───────────────────────────────────────────────
await smoke('journal-over-ring: journal 1..20, ring 16..20, request 10 -> replay 11..20', async (root) => {
  const bundle = boot(root, { ringSize: 5 });
  bundle.persistence.initialize();
  bundle.persistence.start();
  bundle.store.upsertSession(makeSession({ id: SESSION }));
  for (let index = 1; index <= 20; index += 1) {
    bundle.events.emit({ sessionId: SESSION, event: 'task.progress', data: { index } });
  }

  const ringBounds = bundle.events.sequenceBounds(SESSION);
  assert.equal(bundle.events.ringDepth(SESSION), 5, 'the ring is a cache of five');
  assert.equal(ringBounds.earliest, 16, 'the ring holds 16..20');

  const durable = await bundle.persistence.bounds(SESSION);
  assert.equal(durable.earliest, 1, 'the journal still holds 1..20');

  const replay = await beginReplay({
    events: bundle.events,
    store: bundle.persistence,
    sessionId: SESSION,
    requested: 10,
  });

  assert.equal(replay.decision.outcome, REPLAY_OUTCOME.REPLAY, 'this must replay, not resync');
  const sequences = replay.historical.map((event) => event.sequence);
  assert.deepEqual(
    sequences,
    Array.from({ length: 10 }, (_, index) => 11 + index),
    'exactly 11..20',
  );
  replay.handle.stop();
  bundle.persistence.shutdown();
  return `ring ${ringBounds.earliest}..${ringBounds.latest}, journal ${durable.earliest}..${durable.latest}, replayed ${sequences[0]}..${sequences[sequences.length - 1]}`;
});

// ── Additional: the false-gap proof still holds after remediation ────────────
await smoke('journal authority: the ring alone would report a false gap', async (root) => {
  const bundle = boot(root, { ringSize: 5 });
  bundle.persistence.initialize();
  bundle.persistence.start();
  bundle.store.upsertSession(makeSession({ id: SESSION }));
  for (let index = 1; index <= 20; index += 1) {
    bundle.events.emit({ sessionId: SESSION, event: 'task.progress', data: { index } });
  }

  const ringOnly = await beginReplay({ events: bundle.events, sessionId: SESSION, requested: 10 });
  assert.notEqual(ringOnly.decision.outcome, REPLAY_OUTCOME.REPLAY, 'the ring alone cannot serve it');
  ringOnly.handle.stop();

  const viaStore = await beginReplay({
    events: bundle.events, store: bundle.persistence, sessionId: SESSION, requested: 10,
  });
  assert.equal(viaStore.decision.outcome, REPLAY_OUTCOME.REPLAY, 'the journal can');
  viaStore.handle.stop();
  bundle.persistence.shutdown();
  return `ring alone = ${ringOnly.decision.outcome}, with journal = ${viaStore.decision.outcome}`;
});

assertRealRootAbsent('end');
console.log('');
console.log('R5A SMOKE CHECKS: PASS');
console.log(`real_state_root_exists: ${fs.existsSync(REAL_ROOT)}`);
