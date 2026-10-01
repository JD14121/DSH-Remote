/**
 * R5 fixture: durable journal, cross-restart replay and downtime reconciliation.
 *
 * A self-contained walkthrough that uses an OS temp directory for its state root,
 * so it never touches the real `$DSH_HOME\remote`. It prints an ASCII banner
 * because a Windows console decoding UTF-8 as a legacy code page renders an em dash
 * as mojibake even when the file is valid.
 *
 * Run with `npm run fixture:r5`.
 */

import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { EventsService } from '../src/remote/events.mjs';
import { SessionViewStore } from '../src/remote/state/session-view-store.mjs';
import { makeSession } from '../src/remote/model/session.mjs';
import { PersistenceService } from '../src/remote/persistence/persistence.mjs';
import { Reconciler } from '../src/remote/persistence/reconcile.mjs';
import { SessionJournal } from '../src/remote/persistence/journal.mjs';
import { resolvePersistenceConfig, statePaths } from '../src/remote/persistence/config.mjs';
import { recordChecksum } from '../src/remote/persistence/record.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION = 'session-00000000-0000-0000-0000-000000000099';
const CLOCK = () => 1_789_800_000_000;

/** Print a numbered step. */
function step(number, text) {
  console.log('');
  console.log(`--- STEP ${number}: ${text}`);
}

/**
 * Refuse to run against the real DSH state root.
 *
 * The script is a manual aid, so this is a hard stop rather than a warning.
 *
 * @param {string} root - the resolved state root.
 * @returns {void}
 */
function assertTempRoot(root) {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const normalized = path.resolve(home);
  const withSeparator = normalized.endsWith(path.sep) ? normalized : normalized + path.sep;
  if (path.resolve(root) === normalized || path.resolve(root).startsWith(withSeparator)) {
    throw new Error(`refusing to run the fixture against DSH_HOME: ${root}`);
  }
}

/**
 * Build one synthetic "process" over a state root.
 *
 * @param {string} root - the state root.
 * @returns {object} the process bundle.
 */
function boot(root) {
  const store = new SessionViewStore({ clock: CLOCK });
  const persistence = new PersistenceService({
    // A deliberately small retention budget, so the fixture can demonstrate
    // eviction and resync without generating half a megabyte of events.
    config: {
      root,
      // A small segment target so retention has whole closed segments to remove;
      // retention only ever deletes a complete closed segment, never part of one.
      segmentBytes: 900,
      maxEventsPerSession: 8,
      maxBytesPerSession: 1_000_000,
      snapshotIntervalMs: 60_000,
    },
    store,
    clock: CLOCK,
  });
  const events = new EventsService({ adapter: {}, store, clock: CLOCK, ringSize: 4 });
  events.setSink((event) => persistence.append(event));
  persistence.attachEvents(events);
  return { store, persistence, events };
}

/**
 * A synthetic DSH whose durable history the Gateway can miss while it is down.
 *
 * @param {number} cursor - the durable cursor DSH starts at.
 * @returns {object} the fixture.
 */
function fixtureDsh(cursor) {
  const state = { cursor, records: [] };
  return {
    state,
    commit(content) {
      state.cursor += 1;
      state.records.push({ sequence: state.cursor, content, created_at: null });
      return state.cursor;
    },
    adapter: {
      async getMessages() {
        return { messages: state.records.map((record) => ({ ...record })), raw: {}, throughSeq: state.cursor, hasMore: false };
      },
      async subscribe(_sessionId, listener) {
        setImmediate(() => listener({ kind: 'snapshot', frame: { cursor: state.cursor } }));
        return { unsubscribe: async () => {} };
      },
    },
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-r5-fixture-'));

try {
  assertTempRoot(root);
  console.log('SYNTHETIC R5 FIXTURE - no DSH connection, no credential, no real DSH_HOME');
  console.log(`state root: ${root}`);
  console.log(`session:    ${SESSION}`);

  // ── STEP 1 ────────────────────────────────────────────────────────────────
  step(1, 'Process A: emit 10 durable events and journal them');
  const dsh = fixtureDsh(100);
  const a = boot(root);
  const reportA = a.persistence.initialize();
  a.persistence.start();
  a.store.upsertSession(makeSession({ id: SESSION }));
  console.log(`  lock: ${reportA.lock}, journals: ${reportA.journals.sessions}`);
  for (let index = 0; index < 10; index += 1) {
    a.events.emit({ sessionId: SESSION, event: 'task.progress', data: { index } });
  }
  const config = resolvePersistenceConfig({ root, segmentBytes: 900 }, {});
  const journalDir = path.dirname(statePaths(config).formatFile);
  const segmentFiles = fs.readdirSync(path.join(journalDir, 'events', SESSION));
  console.log(`  highWater: ${a.persistence.journals.get(SESSION).highWater}`);
  console.log(`  segments:  ${segmentFiles.length} (${segmentFiles.join(', ')})`);
  console.log(`  ring cache holds only the last 4 sequences: ${a.events.ringDepth(SESSION)}`);
  a.persistence.shutdown();
  console.log('  process A stopped gracefully; the lock was released');

  // ── STEP 2 ────────────────────────────────────────────────────────────────
  step(2, 'DSH advances while the Gateway is down');
  for (let index = 0; index < 3; index += 1) dsh.commit(`durable fact ${101 + index}`);
  console.log(`  DSH durable cursor is now ${dsh.state.cursor} (was 100)`);
  console.log('  the Gateway cannot have observed these: it was not running');

  // ── STEP 3 ────────────────────────────────────────────────────────────────
  step(3, 'Process B: recover the journal and seed the allocator');
  const b = boot(root);
  const reportB = b.persistence.initialize();
  b.persistence.start();
  console.log(`  recovered: ${reportB.journals.records} records, highWater ${reportB.seeded[0].seeded}`);
  console.log(`  ring preloaded from the journal tail: ${JSON.stringify(reportB.ringPreload)}`);
  const recovered = b.store.get(SESSION);
  console.log(`  recovered status: ${recovered.status} (never a stale running/waiting_input)`);
  console.log(`  next live sequence will be ${b.events.sequenceBounds(SESSION).highWater + 1}`);

  // ── STEP 4 ────────────────────────────────────────────────────────────────
  step(4, 'Reconcile the downtime gap into NEW Gateway events');
  const reconciler = new Reconciler({
    adapter: dsh.adapter,
    persistence: b.persistence,
    store: b.store,
    events: b.events,
  });
  const reconciled = await reconciler.reconcile({ sessionIds: [SESSION] });
  const result = reconciled.sessions[0];
  console.log(`  outcome: ${result.outcome}, emitted: ${result.emitted}, checkpoint: ${result.cursor}`);
  const all = await b.persistence.eventsAfter(SESSION, 0);
  console.log('  sequence -> source_sequence:');
  for (const event of all) {
    console.log(`    ${String(event.sequence).padStart(3)} -> ${event.source_sequence ?? '-'}`);
  }
  console.log('  note: the reconciled events reuse NO old Gateway sequence');

  // ── STEP 5 ────────────────────────────────────────────────────────────────
  step(5, 'A client replays past the ring, straight from the durable journal');
  // The ring holds only the last 4 sequences, so a request older than that can
  // only be served from disk. This is the §49 acceptance property.
  const ringBounds = b.events.sequenceBounds(SESSION);
  const durableBounds = await b.persistence.bounds(SESSION);
  console.log(`  ring earliest: ${ringBounds.earliest}; journal earliest: ${durableBounds.earliest}`);
  const { beginReplay } = await import('../src/remote/ws/replay.mjs');
  const fromJournal = await beginReplay({
    events: b.events,
    store: b.persistence,
    sessionId: SESSION,
    requested: Math.max(durableBounds.earliest - 1, 0),
  });
  console.log(`  outcome: ${fromJournal.decision.outcome}`);
  console.log(`  replayed: ${fromJournal.historical.map((event) => event.sequence).join(', ')}`);
  console.log('  every one of those came from the journal, not the ring cache');
  fromJournal.handle.stop();

  // ── STEP 6 ────────────────────────────────────────────────────────────────
  step(6, 'A client older than retention resyncs instead of silently losing data');
  console.log(`  retained range: ${durableBounds.earliest}..${durableBounds.latest} (contiguous)`);
  console.log('  retention had already evicted the leading segments while appending');
  // The retained range is still contiguous, so a client just inside it replays.
  const atBoundary = await beginReplay({
    events: b.events,
    store: b.persistence,
    sessionId: SESSION,
    requested: durableBounds.earliest - 1,
  });
  console.log(`  client at ${durableBounds.earliest - 1} -> ${atBoundary.decision.outcome} (served)`);
  atBoundary.handle.stop();
  // One below that is genuinely out of range, and is told so rather than being
  // handed a partial replay it could not detect.
  const stale = await beginReplay({
    events: b.events,
    store: b.persistence,
    sessionId: SESSION,
    requested: Math.max(durableBounds.earliest - 2, 0),
  });
  console.log(`  client at ${Math.max(durableBounds.earliest - 2, 0)} -> ${stale.decision.outcome} (${stale.decision.reason ?? 'no reason'})`);
  console.log(`  high-water mark is still ${(await b.persistence.bounds(SESSION)).latest}, so the sequence continues upward`);
  stale.handle.stop();

  // ── STEP 7 ────────────────────────────────────────────────────────────────
  step(7, 'Checksums and corruption fail closed');
  const journal = new SessionJournal({ config, sessionId: SESSION });
  journal.load();
  const index = journal.index();
  console.log(`  segments: ${index.length}, total records: ${index.reduce((sum, s) => sum + s.count, 0)}`);
  const sample = journal.eventsAfter(0)[0];
  console.log(`  checksum of sequence ${sample.sequence}: ${recordChecksum(1, sample.sequence, sample).slice(0, 24)}...`);
  console.log('  a bad checksum, a mid-file malformed line or a sequence gap would all');
  console.log('  refuse to load, so the server would never bind');
  journal.close();

  // ── STEP 8 ────────────────────────────────────────────────────────────────
  step(8, 'Shutdown flushes and releases the lock');
  const shutdown = b.persistence.shutdown();
  console.log(`  flushed sessions: ${shutdown.flushed.length}, lock released: ${shutdown.lockReleased}`);
  console.log(`  final snapshot generation: ${shutdown.snapshot?.generation ?? 'none'}`);
  const lockPath = statePaths(config).lockFile;
  console.log(`  lock file still present: ${fs.existsSync(lockPath)} (expected false)`);

  console.log('');
  console.log('DONE - every step above used a temporary root, now being removed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`cleaned up: ${!fs.existsSync(root)}`);
}
