/**
 * Shared timestamp rules — Phase R2 §24, §25.
 *
 * Rules enforced here:
 *   - public domain objects emit **ISO 8601**;
 *   - internal math may use epoch milliseconds;
 *   - `Date.now()` must never masquerade as a source time;
 *   - receive time is distinguishable from source time, and is labelled.
 *
 * Two distinct concepts, never conflated:
 *
 *   source time    the DSH event's own `time`, or a DSH header timestamp
 *   observed time  when the Gateway saw it (always `Date.now()` at ingest)
 */

/**
 * Convert epoch milliseconds to an ISO 8601 string.
 *
 * @param {unknown} millis - candidate epoch milliseconds.
 * @returns {string|null} ISO string, or `null` when there is no usable source time.
 */
export function toIso(millis) {
  if (typeof millis !== 'number' || !Number.isFinite(millis)) return null;
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Parse an ISO 8601 string or epoch millis into epoch millis.
 *
 * @param {unknown} value - ISO string or number.
 * @returns {number|null} epoch milliseconds, or `null` when unparseable.
 */
export function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The Gateway's observation timestamp.
 *
 * Isolated behind a function so tests can inject a deterministic clock, and so
 * no other module can accidentally use `Date.now()` as a source time.
 *
 * @param {() => number} [clock] - injectable clock returning epoch millis.
 * @returns {string} ISO 8601 observation time.
 */
export function observedNow(clock = Date.now) {
  return new Date(clock()).toISOString();
}

/**
 * Build the paired timestamp block used by domain objects.
 *
 * `created_at` carries the **source** time and stays `null` when DSH gave none —
 * it is never back-filled from the observation clock (§24). `observed_at` always
 * carries the Gateway time and is what a caller uses for ordering its own view.
 *
 * @param {object} input - timestamp inputs.
 * @param {number|string|null} [input.source] - source epoch millis or ISO string.
 * @param {string} [input.observedAt] - ISO observation time.
 * @returns {{created_at: string|null, observed_at: string|null}} the pair.
 */
export function timestampPair(input = {}) {
  const sourceMillis = toMillis(input.source);
  return {
    created_at: sourceMillis === null ? null : toIso(sourceMillis),
    observed_at: input.observedAt ?? null,
  };
}

/**
 * Normalise a source time — epoch millis **or** ISO string — to ISO 8601.
 *
 * Needed because the two sides speak different shapes: DSH's own fields
 * (`SessionWireHeader.createdAt`, `SessionWireEvent.time`) are epoch millis,
 * while the R1 adapter already emits ISO strings for `created_at`/`updated_at`.
 * A domain model must accept both rather than silently dropping one.
 *
 * @param {unknown} value - epoch millis, ISO string, or nothing.
 * @returns {string|null} ISO string, or `null` when there is no usable source time.
 */
export function sourceTimeToIso(value) {
  return toIso(toMillis(value));
}

/**
 * Whether a value is a well-formed ISO 8601 instant.
 *
 * @param {unknown} value - candidate.
 * @returns {boolean} true for a parseable ISO string.
 */
export function isIsoInstant(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}
