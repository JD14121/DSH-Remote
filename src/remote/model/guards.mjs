/**
 * Structural guard helpers — Phase R2 §2, §18, §21.
 *
 * These are the only shared primitives the domain layer needs. They live in
 * `model/` rather than `wire/` so that the domain services (`sessions.mjs`,
 * `messages.mjs`, `events.mjs`) can validate their inputs **without importing
 * `wire/`**, which R2 §18 and §21 forbid.
 *
 * The dependency direction is one-way: `wire/` may import `model/`, never the
 * reverse. `wire/dsh-types.mjs` re-exports these so existing callers keep working.
 */

/**
 * Whether a value is a non-null, non-array object.
 *
 * @param {unknown} value - value to test.
 * @returns {boolean} true for a plain-ish object.
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a value is JSON-representable (no functions, symbols, or cycles).
 *
 * Used to decide whether an opaque payload can cross a boundary untouched or
 * must be preserved as a string instead of being lost.
 *
 * @param {unknown} value - value to test.
 * @param {Set<unknown>} [seen] - cycle guard.
 * @returns {boolean} true when the value is JSON-safe.
 */
export function isJsonValue(value, seen = new Set()) {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value);
  if (type !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
  return Object.values(value).every((item) => isJsonValue(item, seen));
}

/**
 * Whether a value is a non-empty string.
 *
 * @param {unknown} value - value to test.
 * @returns {boolean} true for a non-empty string.
 */
export function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Whether a value is a non-negative safe integer.
 *
 * @param {unknown} value - value to test.
 * @returns {boolean} true for a usable sequence-like number.
 */
export function isSequenceNumber(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
