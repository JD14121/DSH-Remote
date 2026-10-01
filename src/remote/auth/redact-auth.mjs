/**
 * Centralized auth redaction — Phase R6 §24, §45, §62, §86.
 *
 * Every credential that can appear in a request must be removable before anything is
 * logged, echoed or thrown: the `Authorization` header, the `ticket` query parameter,
 * `Cookie`, and the DSH `dsh-auth` family. §24 requires redaction even for
 * `token`, `access_token` and `bearer`, which R4 already *rejects* — a rejected
 * credential must not leak into a log on its way to the rejection.
 *
 * §45 draws the line that keeps this honest: redaction applies to **headers, query
 * credential fields, structured auth fields and logs**. It must never touch user
 * message content. A user writing "my token budget is 1000" is not leaking a secret,
 * and rewriting that sentence would be data loss.
 */

/** Query parameter names that are always redacted. */
export const REDACTED_QUERY_PARAMS = Object.freeze([
  'ticket',
  'token',
  'access_token',
  'bearer',
  'refresh_token',
  'api_key',
  'apikey',
  'password',
  'secret',
]);

/** Header names whose values are always redacted. */
export const REDACTED_HEADERS = Object.freeze([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-auth-token',
  'x-api-key',
]);

/** The replacement marker. */
export const REDACTED = '<redacted>';

/**
 * Redact credential-bearing query parameters from a URL.
 *
 * Preserves the URL's shape so a log line stays diagnosable: the parameter is still
 * visible, only its value is replaced.
 *
 * @param {unknown} url - the request URL or path.
 * @returns {string} the redacted URL.
 */
export function redactRequestUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return '';
  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) return url;

  const base = url.slice(0, queryIndex);
  const query = url.slice(queryIndex + 1);
  const hashIndex = query.indexOf('#');
  const fragment = hashIndex === -1 ? '' : query.slice(hashIndex);
  const search = hashIndex === -1 ? query : query.slice(0, hashIndex);

  const redacted = search.split('&').map((pair) => {
    if (pair.length === 0) return pair;
    const equals = pair.indexOf('=');
    if (equals === -1) return pair;
    const key = pair.slice(0, equals);
    const lower = decodeURIComponentSafe(key).toLowerCase();
    return REDACTED_QUERY_PARAMS.includes(lower) ? `${key}=${REDACTED}` : pair;
  }).join('&');

  return `${base}?${redacted}${fragment}`;
}

/**
 * Decode a URI component without throwing on malformed input.
 *
 * @param {string} value - the encoded value.
 * @returns {string} the decoded value, or the original when undecodable.
 */
function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Redact credential-bearing headers.
 *
 * @param {object|undefined} headers - a headers object.
 * @returns {object} a new object with credential values replaced.
 */
export function redactHeaders(headers) {
  if (headers === null || typeof headers !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (REDACTED_HEADERS.includes(key.toLowerCase())) {
      out[key] = REDACTED;
    } else if (Array.isArray(value)) {
      out[key] = [...value];
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Redact credential-shaped **fields** in a structured object.
 *
 * Walks the tree looking for credential field names, so a diagnostics object that
 * happens to carry an `authorization` key cannot leak it. String *values* are left
 * alone except where they look like a URL carrying a credential.
 *
 * @param {unknown} value - the value to redact.
 * @param {number} [depth] - recursion guard.
 * @returns {unknown} the redacted copy.
 */
export function redactStructured(value, depth = 0) {
  if (depth > 12) return REDACTED;
  if (value === null || typeof value !== 'object') {
    // A bare URL string is the one scalar worth rewriting, because that is where a
    // ticket query would hide.
    if (typeof value === 'string' && value.includes('?') && value.includes('=')) {
      return redactRequestUrl(value);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => redactStructured(entry, depth + 1));

  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (REDACTED_HEADERS.includes(lower) || REDACTED_QUERY_PARAMS.includes(lower)) {
      out[key] = REDACTED;
    } else {
      out[key] = redactStructured(entry, depth + 1);
    }
  }
  return out;
}

/**
 * Whether a string contains one of the supplied secrets.
 *
 * Used by tests to scan an artefact for a known synthetic credential. It is a test
 * aid, deliberately not wired into any production path.
 *
 * @param {unknown} haystack - the text to scan.
 * @param {readonly string[]} secrets - the values to look for.
 * @returns {string|null} the first secret found, or `null`.
 */
export function findSecret(haystack, secrets) {
  if (typeof haystack !== 'string') return null;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0 && haystack.includes(secret)) return secret;
  }
  return null;
}

/**
 * Build a redaction helper bound to the secrets this process actually holds.
 *
 * Anything derived from a real credential — a digest, a prefix, a length — is also
 * scrubbed, because §47 forbids disclosing even a fingerprint.
 *
 * @param {object} options - the secrets.
 * @param {string} [options.token] - the Phone bearer.
 * @param {string} [options.ticket] - a ticket to scrub.
 * @returns {{text: (value: unknown) => string}} the helper.
 */
export function createScrubber(options = {}) {
  const secrets = [options.token, options.ticket].filter(
    (entry) => typeof entry === 'string' && entry.length >= 8,
  );
  const prefixes = secrets.map((secret) => secret.slice(0, 8));

  return {
    /**
     * Replace every known secret in a value's string form.
     *
     * @param {unknown} value - the value.
     * @returns {string} the scrubbed text.
     */
    text(value) {
      let text = typeof value === 'string' ? value : JSON.stringify(redactStructured(value));
      if (typeof text !== 'string') return '';
      for (const secret of secrets) text = text.split(secret).join(REDACTED);
      for (const prefix of prefixes) text = text.split(prefix).join(REDACTED);
      return text;
    },
  };
}
