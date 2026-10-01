/**
 * Journal record encoding — Phase R5 §6, §7, §54.
 *
 * One record per physical line, UTF-8, LF, no BOM, never pretty-printed. §6 pins
 * the checksum payload to a **fixed array** —
 * `JSON.stringify([v, sequence, event])` — precisely so a checksum never depends on
 * incidental object property order.
 *
 * §54 requires a structural secret guard on the way to disk. It blocks *internal
 * credential material*, and deliberately does **not** rewrite user text: a user
 * message containing the word "token" is not a secret, and mangling it would be a
 * data-loss bug.
 */

import { createHash } from 'node:crypto';

import { PERSISTENCE_ERROR, persistenceError } from './errors.mjs';
import { PERSISTENCE_FORMAT_VERSION } from './config.mjs';

/** Field names that indicate internal credential material, never user text. */
const FORBIDDEN_FIELD_NAMES = Object.freeze(new Set([
  'cookie',
  'authorization',
  'credentials',
  'credential',
  'password',
  'token',
  'apikey',
  'api_key',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'launchtoken',
  'launch_token',
  'sessiontoken',
  'session_token',
  'secret',
]));

/** A real credential value that must never reach disk. */
const CREDENTIAL_SHAPED = Object.freeze([
  /dsh-auth-[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i,
]);

/**
 * Serialise a value with **deterministic key order**.
 *
 * `JSON.stringify` emits object keys in insertion order, so two structurally
 * identical events built in different orders would produce different canonical
 * strings — and therefore different checksums for the same content. §6 warns about
 * exactly this ("do not rely on the incidental order of object property
 * enumeration"). Sorting keys recursively removes that dependency while leaving
 * array order untouched, which matters because array order is meaningful.
 *
 * @param {unknown} value - the value to serialise.
 * @returns {string} a canonical JSON string.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;

  const keys = Object.keys(value).sort();
  const parts = [];
  for (const key of keys) {
    const encoded = canonicalJson(value[key]);
    // `JSON.stringify` for the key handles escaping; an `undefined` value is
    // omitted exactly as `JSON.stringify` would omit it.
    if (encoded === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * Compute the canonical checksum for a record.
 *
 * The payload shape is §6's — `[v, sequence, event]` — but serialised canonically
 * so property order cannot influence the digest.
 *
 * @param {number} version - the record version.
 * @param {number} sequence - the Gateway sequence.
 * @param {object} event - the Gateway event.
 * @returns {string} `sha256:<hex>`.
 */
export function recordChecksum(version, sequence, event) {
  const canonical = canonicalJson([version, sequence, event]);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/**
 * Assert an event carries no internal credential material.
 *
 * Walks objects and arrays looking for forbidden *field names* and
 * credential-shaped strings. Plain string values are left untouched — §54 is
 * explicit that user content must not be rewritten.
 *
 * @param {unknown} value - the value to inspect.
 * @param {string} [pathLabel] - the current path, for the error detail.
 * @returns {void}
 * @throws {PersistenceError} `PERSISTENCE_WRITE_FAILED` on a forbidden field.
 */
export function assertNoCredentialMaterial(value, pathLabel = 'event') {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') {
      for (const pattern of CREDENTIAL_SHAPED) {
        if (pattern.test(value)) {
          throw persistenceError(PERSISTENCE_ERROR.WRITE_FAILED, {
            message: 'Refusing to persist credential-shaped material.',
            details: { field: pathLabel },
          });
        }
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      assertNoCredentialMaterial(entry, `${pathLabel}[${index}]`);
    }
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_FIELD_NAMES.has(key.toLowerCase())) {
      throw persistenceError(PERSISTENCE_ERROR.WRITE_FAILED, {
        message: 'Refusing to persist a credential-bearing field.',
        details: { field: `${pathLabel}.${key}` },
      });
    }
    assertNoCredentialMaterial(entry, `${pathLabel}.${key}`);
  }
}

/**
 * Encode one Gateway event as a journal line, without its trailing newline.
 *
 * @param {object} event - a Gateway event.
 * @returns {string} the encoded record.
 * @throws {PersistenceError} when the event is unusable or carries a secret.
 */
export function encodeRecord(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw persistenceError(PERSISTENCE_ERROR.JOURNAL_SEQUENCE_ERROR, {
      message: 'A journal record requires a Gateway event object.',
    });
  }
  const sequence = event.sequence;
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw persistenceError(PERSISTENCE_ERROR.JOURNAL_SEQUENCE_ERROR, {
      message: 'A journal record requires a positive integer sequence.',
      details: { sequence: Number.isSafeInteger(sequence) ? sequence : null },
    });
  }
  if (typeof event.session_id !== 'string' || event.session_id.length === 0) {
    throw persistenceError(PERSISTENCE_ERROR.JOURNAL_SEQUENCE_ERROR, {
      message: 'A journal record requires a session id.',
    });
  }

  assertNoCredentialMaterial(event, 'event');

  const version = PERSISTENCE_FORMAT_VERSION;
  const record = {
    v: version,
    sequence,
    event,
    checksum: recordChecksum(version, sequence, event),
  };
  // `JSON.stringify` escapes newlines inside content, so one record is always one
  // physical line (§7). A multi-line record is impossible by construction.
  return JSON.stringify(record);
}

/**
 * Parse and validate one journal line.
 *
 * @param {string} line - the line, without its terminator.
 * @param {object} context - validation context.
 * @param {string} context.sessionId - the session the directory belongs to.
 * @param {number} [context.expectedSequence] - the sequence this record must carry.
 * @returns {object} the parsed record.
 * @throws {PersistenceError} `JOURNAL_CORRUPT` on any structural failure.
 */
export function decodeRecord(line, context) {
  const corrupt = (message, details) => persistenceError(PERSISTENCE_ERROR.JOURNAL_CORRUPT, { message, details });

  if (typeof line !== 'string' || line.length === 0) throw corrupt('A journal line is empty.');

  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    // §21: a malformed line is never skipped and never reassembled from a partial.
    throw corrupt('A journal line is not valid JSON.');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw corrupt('A journal record must be a JSON object.');
  }
  if (parsed.v !== PERSISTENCE_FORMAT_VERSION) {
    throw corrupt('A journal record has an unknown version.', { version: parsed.v ?? null });
  }
  if (!Number.isSafeInteger(parsed.sequence) || parsed.sequence < 1) {
    throw corrupt('A journal record has an invalid sequence.');
  }
  const event = parsed.event;
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw corrupt('A journal record has no event object.');
  }
  if (event.sequence !== parsed.sequence) {
    // §6: `record.sequence == event.sequence` is required, not merely expected.
    throw corrupt('A journal record sequence does not match its event.');
  }
  if (event.session_id !== context.sessionId) {
    throw corrupt('A journal record belongs to a different session.');
  }
  if (context.expectedSequence !== undefined && parsed.sequence !== context.expectedSequence) {
    throw corrupt('A journal record is out of sequence.');
  }

  const expectedChecksum = recordChecksum(parsed.v, parsed.sequence, event);
  if (parsed.checksum !== expectedChecksum) {
    throw corrupt('A journal record failed its checksum.');
  }

  return { v: parsed.v, sequence: parsed.sequence, event, checksum: parsed.checksum };
}

export { PERSISTENCE_ERROR, PERSISTENCE_FORMAT_VERSION };
