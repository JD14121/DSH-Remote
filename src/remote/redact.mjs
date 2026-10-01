/**
 * Secret redaction — Phase R1 security requirement (§23).
 *
 * R1 never reads `$DSH_HOME/.credentials.yaml` and never authenticates against a
 * live DSH with a real cookie. This module exists so that the *shape* of
 * redaction is already enforced in R1, and so that every error path that could
 * conceivably carry credential material has a single audited place to clean up.
 *
 * Rules enforced here:
 *   - a secret value is never echoed, not even truncated;
 *   - redaction is total: an empty known-secret list still strips anything that
 *     looks like a bearer credential.
 */

/** Placeholder substituted for any redacted value. */
export const REDACTED = '[redacted]';

/**
 * Substrings that must never survive into a message or detail, matched
 * case-insensitively. These are protocol names, not values, so matching them is
 * safe and catches a secret that arrived without being registered.
 */
const SENSITIVE_MARKERS = Object.freeze([
  'dsh-auth-',
  'cookie',
  'authorization',
  'bearer ',
  'token=',
  'launch-token',
  'launchtoken',
]);

/**
 * Redact a string.
 *
 * @param {unknown} value - value to sanitise.
 * @param {readonly string[]} [knownSecrets] - exact secret values to remove.
 * @returns {string} a string safe to place in an error message or a log line.
 */
export function redactString(value, knownSecrets = []) {
  let text = typeof value === 'string' ? value : String(value ?? '');

  for (const secret of knownSecrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    text = text.split(secret).join(REDACTED);
  }

  // Strip `name=value` pairs whose name is sensitive, regardless of the value.
  text = text.replace(
    /\b(dsh-auth-[A-Za-z0-9_-]+|cookie|authorization|set-cookie)\s*[:=]\s*[^\s;,]+/gi,
    (match) => `${match.slice(0, match.search(/[:=]/))}=${REDACTED}`,
  );

  // Strip bare credential tokens that carry no name.
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`);
  text = text.replace(/\btoken=[A-Za-z0-9._~+/-]+=*/gi, `token=${REDACTED}`);

  return text;
}

/**
 * Redact a structured value, preserving plain JSON shape.
 *
 * Keys whose name is sensitive are replaced wholesale so that a nested secret
 * cannot survive by being stringified.
 *
 * @param {unknown} value - value to sanitise.
 * @param {readonly string[]} [knownSecrets] - exact secret values to remove.
 * @returns {unknown} a structurally equivalent, sanitised value.
 */
export function redactValue(value, knownSecrets = []) {
  if (typeof value === 'string') return redactString(value, knownSecrets);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, knownSecrets));

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactValue(item, knownSecrets);
  }
  return out;
}

/**
 * Whether a property name denotes credential material.
 *
 * @param {string} key - property name.
 * @returns {boolean} true when the value under this key must never be emitted.
 */
export function isSensitiveKey(key) {
  const lowered = String(key).toLowerCase();
  if (lowered.startsWith('dsh-auth-')) return true;
  return (
    lowered === 'cookie' ||
    lowered === 'set-cookie' ||
    lowered === 'authorization' ||
    lowered === 'token' ||
    lowered === 'accesstoken' ||
    lowered === 'access_token' ||
    lowered === 'secret' ||
    lowered === 'password' ||
    lowered === 'apikey' ||
    lowered === 'api_key' ||
    lowered === 'credentials'
  );
}

/**
 * Assert that a value contains none of the known secrets and no sensitive
 * marker. Used by tests to prove a code path leaked nothing.
 *
 * @param {unknown} value - value to inspect.
 * @param {readonly string[]} [knownSecrets] - exact secret values to look for.
 * @returns {{clean: boolean, reason?: string}} inspection result.
 */
export function assertNoSecrets(value, knownSecrets = []) {
  const text = typeof value === 'string' ? value : safeStringify(value);

  for (const secret of knownSecrets) {
    if (typeof secret === 'string' && secret.length > 0 && text.includes(secret)) {
      return { clean: false, reason: 'known secret value present' };
    }
  }

  if (/dsh-auth-[A-Za-z0-9_-]{4,}/.test(text)) {
    return { clean: false, reason: 'dsh-auth cookie name present' };
  }
  if (/\bBearer\s+\S+/i.test(text)) {
    return { clean: false, reason: 'bearer credential present' };
  }
  if (/\btoken=[A-Za-z0-9._~+/-]{8,}/i.test(text)) {
    return { clean: false, reason: 'launch token present' };
  }
  return { clean: true };
}

/**
 * JSON-stringify without throwing on cycles, bigints or exotic values.
 *
 * @param {unknown} value - value to stringify.
 * @returns {string} a best-effort string form.
 */
export function safeStringify(value) {
  try {
    return JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint' ? item.toString() : item,
    ) ?? String(value);
  } catch {
    return String(value);
  }
}
