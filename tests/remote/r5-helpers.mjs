/**
 * R5 persistence test harness.
 *
 * Every suite here uses an OS temp root (§61): the real `$DSH_HOME\remote` is never
 * touched, and `makeTempStateRoot` refuses a root inside DSH_HOME by construction.
 *
 * The harness builds the real stack — `SessionViewStore` → `PersistenceService` →
 * `EventsService` with the write-ahead sink → `attachEvents` — so tests exercise
 * the shipped wiring rather than a hand-assembled approximation.
 */

import fs from 'node:fs';
import path from 'node:path';

import { makeTempStateRoot, assertTempStateRoot, fixtureClock, FIXTURE_SESSIONS } from './r3-helpers.mjs';
import { PersistenceService, PERSISTENCE_STATUS } from '../../src/remote/persistence/persistence.mjs';
import { Reconciler } from '../../src/remote/persistence/reconcile.mjs';
import { EventsService } from '../../src/remote/events.mjs';
import { SessionViewStore } from '../../src/remote/state/session-view-store.mjs';
import { makeSession } from '../../src/remote/model/session.mjs';
import { PERSISTENCE_ERROR } from '../../src/remote/persistence/errors.mjs';
import { createFixtureAdapter } from '../../scripts/fixture-adapter.mjs';
import {
  assertSafeSegment,
  containedPath,
  parseSegmentFileName,
  resolveDshHome,
  resolvePersistenceConfig,
  segmentFileName,
  segmentPath,
  sessionDirectoryName,
  statePaths,
  PERSISTENCE_FORMAT_VERSION,
} from '../../src/remote/persistence/config.mjs';
import { recordChecksum } from '../../src/remote/persistence/record.mjs';

export {
  makeTempStateRoot,
  assertTempStateRoot,
  fixtureClock,
  FIXTURE_SESSIONS,
  PersistenceService,
  PERSISTENCE_STATUS,
  PERSISTENCE_ERROR,
  PERSISTENCE_FORMAT_VERSION,
  Reconciler,
  EventsService,
  SessionViewStore,
  makeSession,
  createFixtureAdapter,
  segmentPath,
  statePaths,
  recordChecksum,
  // config helpers, re-exported so suites import from one place
  assertSafeSegment,
  containedPath,
  parseSegmentFileName,
  resolveDshHome,
  resolvePersistenceConfig,
  segmentFileName,
  sessionDirectoryName,
};

/** A stable session id for persistence tests. */
export const SESSION = FIXTURE_SESSIONS.RUNNING;
export const OTHER_SESSION = FIXTURE_SESSIONS.IDLE;

/**
 * Build one "process" over a shared state root.
 *
 * Calling this twice with the same root models a Gateway restart: the first
 * instance must be shut down (releasing the lock) before the second initializes.
 *
 * @param {object} options - harness options.
 * @param {string} options.root - the state root.
 * @param {object} [options.adapter] - the adapter to use.
 * @param {object} [options.config] - extra persistence config.
 * @param {() => number} [options.clock] - injectable clock.
 * @param {object} [options.timers] - injectable timers.
 * @returns {object} the process bundle.
 */
export function processBundle(options) {
  const clock = options.clock ?? fixtureClock;
  const store = new SessionViewStore({ clock });
  const persistence = new PersistenceService({
    config: { root: options.root, ...(options.config ?? {}) },
    store,
    clock,
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    ...(options.probe === undefined ? {} : { probe: options.probe }),
  });
  const events = new EventsService({
    adapter: options.adapter ?? {},
    store,
    clock,
    // The ring is a cache after R5; its size must match what the persistence
    // config says, so a test that shrinks the ring actually shrinks it.
    ringSize: options.ringSize ?? options.config?.ringSize ?? 1000,
  });
  // §10: wire the write-ahead sink exactly as the server factory does.
  events.setSink((event) => persistence.append(event));
  persistence.attachEvents(events);

  return {
    store,
    persistence,
    events,
    /** Initialize and start, as `server.start()` does before binding. */
    boot() {
      const report = persistence.initialize();
      persistence.start();
      return report;
    },
    /** Shut persistence down, releasing the lock. */
    stop() {
      return persistence.shutdown();
    },
  };
}

/**
 * Seed a session with a view so events have somewhere to land.
 *
 * @param {object} bundle - a process bundle.
 * @param {string} [sessionId] - the session.
 * @returns {object} the session view.
 */
export function seedSession(bundle, sessionId = SESSION) {
  bundle.store.upsertSession(makeSession({ id: sessionId, updatedAt: 1_789_700_000_000 }));
  return bundle.store.get(sessionId);
}

/**
 * Emit `count` durable events for a session.
 *
 * @param {object} bundle - a process bundle.
 * @param {number} count - how many.
 * @param {string} [sessionId] - the session.
 * @param {object} [data] - static payload merged into each event.
 * @returns {object[]} the emitted events.
 */
export function emitEvents(bundle, count, sessionId = SESSION, data = {}) {
  const out = [];
  for (let index = 0; index < count; index += 1) {
    out.push(bundle.events.emit({ sessionId, event: 'task.progress', data: { index, ...data } }));
  }
  return out;
}

/**
 * Read every journal segment file for a session, in order.
 *
 * @param {object} config - a resolved persistence config.
 * @param {string} sessionId - the session.
 * @returns {Array<{name: string, text: string, bytes: number}>} the segments.
 */
export function readSegments(config, sessionId) {
  const dir = path.dirname(segmentPath(config, sessionId, 1));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => {
      const full = path.join(dir, name);
      const buf = fs.readFileSync(full);
      return { name, text: buf.toString('utf8'), bytes: buf.length };
    });
}

/**
 * Corrupt one line of one segment, in place.
 *
 * @param {object} config - a resolved persistence config.
 * @param {string} sessionId - the session.
 * @param {number} lineIndex - which physical line.
 * @param {(line: string) => string} mutate - the corruption.
 * @param {number} [segmentIndex] - which segment, default the first.
 * @returns {void}
 */
export function corruptLine(config, sessionId, lineIndex, mutate, segmentIndex = 0) {
  const segments = readSegments(config, sessionId);
  const target = segments[segmentIndex];
  if (target === undefined) throw new Error('no segment to corrupt');
  const dir = path.dirname(segmentPath(config, sessionId, 1));
  const lines = target.text.split('\n');
  const hadTrailingNewline = lines[lines.length - 1] === '';
  if (hadTrailingNewline) lines.pop();
  lines[lineIndex] = mutate(lines[lineIndex]);
  fs.writeFileSync(
    path.join(dir, target.name),
    lines.join('\n') + (hadTrailingNewline ? '\n' : ''),
    'utf8',
  );
}

/**
 * Append raw bytes to a segment, to model a half-written line.
 *
 * @param {object} config - a resolved persistence config.
 * @param {string} sessionId - the session.
 * @param {string} raw - the bytes to append.
 * @param {number} [segmentIndex] - which segment, default the last.
 * @returns {void}
 */
export function appendRaw(config, sessionId, raw, segmentIndex = -1) {
  const segments = readSegments(config, sessionId);
  const target = segmentIndex < 0 ? segments[segments.length - 1] : segments[segmentIndex];
  if (target === undefined) throw new Error('no segment to append to');
  const dir = path.dirname(segmentPath(config, sessionId, 1));
  fs.appendFileSync(path.join(dir, target.name), raw, 'utf8');
}

/**
 * Delete every segment except the newest, so the journal cannot serve the range.
 *
 * @param {object} config - a resolved persistence config.
 * @param {string} sessionId - the session.
 * @returns {string[]} the removed filenames.
 */
export function dropOldSegments(config, sessionId) {
  const segments = readSegments(config, sessionId);
  const dir = path.dirname(segmentPath(config, sessionId, 1));
  const removed = [];
  for (const segment of segments.slice(0, -1)) {
    fs.unlinkSync(path.join(dir, segment.name));
    removed.push(segment.name);
  }
  return removed;
}
