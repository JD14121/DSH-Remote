/**
 * Persistence configuration and path containment — Phase R5 §3, §56.
 *
 * The state root defaults to `%DSH_HOME%/remote`, matching DSH's own convention
 * (DSH resolves its home from `DSH_HOME`, else `~/.dsh`). A test must never write
 * the real root, so every path produced here is validated rather than trusted:
 *
 *   - the default must sit under the current `DSH_HOME`;
 *   - an override must be absolute;
 *   - the root may not be `DSH_HOME` itself;
 *   - no child may escape the root with `..`, a separator, a NUL, a drive colon or
 *     an alternate-separator trick.
 *
 * §56 requires `path.resolve(root, child)` followed by an explicit containment
 * check. This module is the only place that builds a filesystem path.
 */

import { homedir } from 'node:os';
import path from 'node:path';

import { PERSISTENCE_ERROR, persistenceError } from './errors.mjs';

/** The on-disk format this build reads and writes (§5). */
export const PERSISTENCE_FORMAT_VERSION = 1;

/** The marker written to `format.json`. */
export const PERSISTENCE_FORMAT_NAME = 'dsh-remote-state';

/** Directory names inside the root (§4). */
export const STATE_DIR = 'state';
export const EVENTS_DIR = 'events';
export const QUARANTINE_DIR = 'quarantine';
export const FORMAT_FILE = 'format.json';
export const LOCK_FILE = 'gateway.lock';
export const SNAPSHOT_SLOTS = Object.freeze(['session-views.a.json', 'session-views.b.json']);

/**
 * Resolve the DSH home the way DSH itself does.
 *
 * @param {NodeJS.ProcessEnv} [env] - environment source.
 * @returns {string} the absolute DSH home.
 */
export function resolveDshHome(env = process.env) {
  const configured = env.DSH_HOME;
  if (typeof configured === 'string' && configured.length > 0) return path.resolve(configured);
  return path.join(homedir(), '.dsh');
}

/**
 * Whether a path is absolute in a platform-aware sense.
 *
 * @param {unknown} value - candidate.
 * @returns {boolean} true when absolute.
 */
function isAbsolute(value) {
  return typeof value === 'string' && value.length > 0 && path.isAbsolute(value);
}

/**
 * Reject a path fragment that could escape or confuse the layout.
 *
 * §56 lists the cases: `..`, `/`, `\`, NUL, a drive colon, and alternate
 * separators. A session id has already passed the REST grammar check by this
 * point; this is the second, structural gate.
 *
 * @param {unknown} segment - the fragment.
 * @param {string} label - for the error.
 * @returns {string} the validated fragment.
 * @throws {PersistenceError} `STATE_PATH_INVALID`.
 */
export function assertSafeSegment(segment, label) {
  if (typeof segment !== 'string' || segment.length === 0) {
    throw persistenceError(PERSISTENCE_ERROR.PATH_INVALID, { message: `${label} must be a non-empty string.` });
  }
  if (segment === '.' || segment === '..') {
    throw persistenceError(PERSISTENCE_ERROR.PATH_INVALID, { message: `${label} may not be a relative segment.` });
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(segment)) {
    throw persistenceError(PERSISTENCE_ERROR.PATH_INVALID, { message: `${label} contains a control character.` });
  }
  if (/[/\\]/.test(segment)) {
    throw persistenceError(PERSISTENCE_ERROR.PATH_INVALID, { message: `${label} contains a path separator.` });
  }
  if (segment.includes(':')) {
    throw persistenceError(PERSISTENCE_ERROR.PATH_INVALID, { message: `${label} contains a drive separator.` });
  }
  if (segment.includes('..')) {
    throw persistenceError(PERSISTENCE_ERROR.PATH_INVALID, { message: `${label} contains a traversal sequence.` });
  }
  return segment;
}

/**
 * Join child segments onto the root and prove the result stays inside it.
 *
 * @param {string} root - the resolved state root.
 * @param {...string} segments - child segments, each validated.
 * @returns {string} the contained absolute path.
 * @throws {PersistenceError} `STATE_PATH_INVALID` on escape or an unsafe segment.
 */
export function containedPath(root, ...segments) {
  let resolved = path.resolve(root);
  for (const [index, segment] of segments.entries()) {
    const safe = assertSafeSegment(segment, `path segment ${index + 1}`);
    resolved = path.resolve(resolved, safe);
  }

  const normalizedRoot = path.resolve(root);
  const withSeparator = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
  // `startsWith` on the root plus a separator is the containment check §56 asks
  // for; a bare prefix match would accept a sibling like `<root>-backup`.
  if (resolved !== normalizedRoot && !resolved.startsWith(withSeparator)) {
    throw persistenceError(PERSISTENCE_ERROR.PATH_INVALID, {
      message: 'The resolved path escapes the state root.',
    });
  }
  return resolved;
}

/**
 * Build the journal directory name for a session.
 *
 * The session id has already passed the REST grammar, so this only needs the
 * structural gate.
 *
 * @param {string} sessionId - a validated DSH session id.
 * @returns {string} the directory name.
 */
export function sessionDirectoryName(sessionId) {
  return assertSafeSegment(sessionId, 'session id');
}

/**
 * Format a segment start sequence as a filename (§8).
 *
 * @param {number} startSequence - the first sequence in the segment.
 * @returns {string} a zero-padded decimal filename.
 * @throws {PersistenceError} when the sequence is not a positive safe integer.
 */
export function segmentFileName(startSequence) {
  if (!Number.isSafeInteger(startSequence) || startSequence < 1) {
    throw persistenceError(PERSISTENCE_ERROR.PATH_INVALID, {
      message: 'A journal segment start must be a positive safe integer.',
    });
  }
  return `${String(startSequence).padStart(20, '0')}.jsonl`;
}

/**
 * Parse a segment filename back to its start sequence.
 *
 * @param {string} fileName - the filename, without a directory.
 * @returns {number|null} the start sequence, or `null` when the name is not one.
 */
export function parseSegmentFileName(fileName) {
  const match = /^(\d{20})\.jsonl$/.exec(fileName);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/**
 * Resolve the effective persistence configuration.
 *
 * @param {object} [overrides] - explicit settings, taking precedence over the environment.
 * @param {NodeJS.ProcessEnv} [env] - environment source.
 * @returns {object} the resolved configuration.
 * @throws {PersistenceError} on an unusable root.
 */
export function resolvePersistenceConfig(overrides = {}, env = process.env) {
  const dshHome = resolveDshHome(env);
  const defaultRoot = path.join(dshHome, 'remote');

  const configured = overrides.root ?? env.DSH_REMOTE_STATE_ROOT;
  let root;
  if (configured === undefined || configured === null || configured === '') {
    root = defaultRoot;
  } else {
    if (!isAbsolute(configured)) {
      // §3: an override must be absolute. A relative one would depend on the
      // process working directory, which is not a stable identity for state.
      throw persistenceError(PERSISTENCE_ERROR.PATH_INVALID, {
        message: 'DSH_REMOTE_STATE_ROOT must be an absolute path.',
      });
    }
    root = path.resolve(configured);
  }

  // §3: the root may not be DSH_HOME itself — state must live in its own subtree.
  if (root === dshHome) {
    throw persistenceError(PERSISTENCE_ERROR.PATH_INVALID, {
      message: 'The state root may not be the DSH home itself.',
    });
  }

  // §3: the production default must sit under DSH_HOME. An explicit override is
  // exempt so tests can use an OS temp directory.
  if (configured === undefined || configured === null || configured === '') {
    const withSeparator = dshHome.endsWith(path.sep) ? dshHome : dshHome + path.sep;
    if (!root.startsWith(withSeparator)) {
      throw persistenceError(PERSISTENCE_ERROR.PATH_INVALID, {
        message: 'The default state root must live under the DSH home.',
      });
    }
  }

  return {
    root,
    dshHome,
    isDefaultRoot: configured === undefined || configured === null || configured === '',
    formatVersion: PERSISTENCE_FORMAT_VERSION,
    segmentBytes: overrides.segmentBytes ?? readPositiveInt(env.DSH_REMOTE_JOURNAL_SEGMENT_BYTES, 4_194_304),
    maxEventsPerSession: overrides.maxEventsPerSession
      ?? readPositiveInt(env.DSH_REMOTE_JOURNAL_MAX_EVENTS_PER_SESSION, 50_000),
    maxBytesPerSession: overrides.maxBytesPerSession
      ?? readPositiveInt(env.DSH_REMOTE_JOURNAL_MAX_BYTES_PER_SESSION, 67_108_864),
    snapshotIntervalMs: overrides.snapshotIntervalMs ?? 2_000,
    snapshotEveryEvents: overrides.snapshotEveryEvents ?? 200,
    ringSize: overrides.ringSize ?? 1000,
  };
}

/**
 * Read a positive integer from the environment, falling back when absent.
 *
 * @param {unknown} value - the raw value.
 * @param {number} fallback - the default.
 * @returns {number} the resolved value.
 * @throws {PersistenceError} when present but not a positive safe integer.
 */
function readPositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw persistenceError(PERSISTENCE_ERROR.PATH_INVALID, {
      message: 'A journal limit must be a positive safe integer.',
    });
  }
  return parsed;
}

/**
 * The full path set for a configuration, all containment-checked.
 *
 * @param {object} config - a resolved config.
 * @returns {object} the absolute paths.
 */
export function statePaths(config) {
  const root = path.resolve(config.root);
  return {
    root,
    formatFile: containedPath(root, FORMAT_FILE),
    stateDir: containedPath(root, STATE_DIR),
    eventsDir: containedPath(root, EVENTS_DIR),
    quarantineDir: containedPath(root, QUARANTINE_DIR),
    staleLocksDir: containedPath(root, QUARANTINE_DIR, 'stale-locks'),
    recoveryDir: containedPath(root, QUARANTINE_DIR, 'recovery'),
    lockFile: containedPath(root, STATE_DIR, LOCK_FILE),
    snapshotSlots: SNAPSHOT_SLOTS.map((name) => containedPath(root, STATE_DIR, name)),
  };
}

/**
 * The journal directory for one session.
 *
 * @param {object} config - a resolved config.
 * @param {string} sessionId - a validated session id.
 * @returns {string} the absolute directory.
 */
export function sessionJournalDir(config, sessionId) {
  return containedPath(config.root, EVENTS_DIR, sessionDirectoryName(sessionId));
}

/**
 * The journal file for one session segment.
 *
 * @param {object} config - a resolved config.
 * @param {string} sessionId - a validated session id.
 * @param {number} startSequence - the segment's first sequence.
 * @returns {string} the absolute file path.
 */
export function segmentPath(config, sessionId, startSequence) {
  return containedPath(config.root, EVENTS_DIR, sessionDirectoryName(sessionId), segmentFileName(startSequence));
}
