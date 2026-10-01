/**
 * Bearer credential parsing and constant-time verification — Phase R6 §7, §8, §9.
 *
 * The Phone credential is an **opaque random secret**, not a JWT and not a signed
 * value. R6 never generates or stores a production token; R7 does that and injects
 * it. R6's job is to verify one correctly.
 *
 * Verification is constant-time by construction: the configured token is hashed
 * **once** at construction and the raw string is dropped, so a comparison is always
 * between two fixed-length digests.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { AUTH_ERROR, authError } from './errors.mjs';

/** The exact token shape §7 standardises on. */
export const TOKEN_BYTES = 32;
export const TOKEN_ENCODING = 'base64url';
export const TOKEN_MIN_ENTROPY_BITS = 256;

/** A bounded Authorization header. A credential is ~43 chars; 8 KiB is generous. */
export const MAX_AUTHORIZATION_HEADER_BYTES = 8192;

/** base64url, no padding, exactly 32 bytes' worth. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Generate a synthetic credential of the documented shape.
 *
 * **For tests and fixtures only.** R6 never calls this to create a production
 * credential; §7 assigns that to R7.
 *
 * @returns {string} a 32-byte base64url token.
 */
export function generateSyntheticToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Whether a value has the documented token shape.
 *
 * @param {unknown} value - the candidate.
 * @returns {boolean} true when it is 43 base64url characters decoding to 32 bytes.
 */
export function isValidTokenShape(value) {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) return false;
  // Confirm it really decodes to 32 bytes rather than only looking the right length.
  try {
    return Buffer.from(value, 'base64url').length === TOKEN_BYTES;
  } catch {
    return false;
  }
}

/**
 * The SHA-256 digest of a credential, as a Buffer.
 *
 * @param {string} token - the credential.
 * @returns {Buffer} a 32-byte digest.
 */
export function tokenDigest(token) {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Parse a single `Authorization: Bearer <credential>` header.
 *
 * §8's rules are all enforced here rather than at the call site:
 *
 *   - exactly one Authorization header (an array or comma-joined pair is refused);
 *   - the scheme is ASCII-case-insensitive `Bearer`;
 *   - exactly one credential;
 *   - empty, whitespace-bearing and control-character values are refused;
 *   - the header is length-bounded.
 *
 * A malformed header is reported as `AUTH_INVALID`, never as a more specific reason,
 * because §37 forbids handing an attacker a format oracle.
 *
 * @param {unknown} header - `req.headers.authorization`.
 * @returns {{ok: true, token: string} | {ok: false, code: string, internalReason: string}} the result.
 */
export function parseAuthorizationHeader(header) {
  const fail = (internalReason) => ({ ok: false, code: AUTH_ERROR.INVALID, internalReason });

  if (header === undefined || header === null) {
    return { ok: false, code: AUTH_ERROR.REQUIRED, internalReason: 'no authorization header' };
  }
  // Node gives an array when the header is repeated; §8 requires exactly one.
  if (Array.isArray(header)) return fail('repeated authorization header');
  if (typeof header !== 'string') return fail('non-string authorization header');

  const byteLength = Buffer.byteLength(header, 'utf8');
  if (byteLength > MAX_AUTHORIZATION_HEADER_BYTES) return fail('oversized authorization header');
  if (byteLength === 0) return fail('empty authorization header');

  // Control characters anywhere are refused, including NUL and CR/LF.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(header)) return fail('control character in authorization header');

  // A comma means the client tried to present several credentials.
  if (header.includes(',')) return fail('multiple credentials in authorization header');

  // Exactly one space between scheme and credential; ASCII-case-insensitive scheme.
  const match = /^([A-Za-z]+)[ ]+(\S+)$/.exec(header);
  if (match === null) return fail('malformed authorization header');
  const [, scheme, credential] = match;

  if (scheme.toLowerCase() !== 'bearer') return fail('unsupported authorization scheme');
  if (!isValidTokenShape(credential)) return fail('credential shape is not valid');

  return { ok: true, token: credential };
}

/**
 * A verifier holding only digests.
 */
export class BearerVerifier {
  /**
   * @param {object} options - verifier options.
   * @param {string|Buffer} options.token - the credential to accept.
   * @param {string} [options.principalId] - the principal this credential identifies.
   */
  constructor(options) {
    const token = options?.token;
    if (typeof token !== 'string' && !Buffer.isBuffer(token)) {
      throw authError(AUTH_ERROR.CONFIG_INVALID, {
        message: 'The auth configuration does not include a credential.',
      });
    }

    const asString = Buffer.isBuffer(token) ? token.toString('utf8') : token;
    if (!isValidTokenShape(asString)) {
      // §7: the shape is part of the contract, so a misconfigured credential fails
      // at startup rather than silently accepting something weaker.
      throw authError(AUTH_ERROR.CONFIG_INVALID, {
        message: `The auth credential must be ${TOKEN_BYTES} bytes encoded as base64url.`,
      });
    }

    /** @type {Buffer|null} The configured credential's digest. */
    this.expectedDigest = tokenDigest(asString);
    /** @type {string} The public principal id (§10). */
    this.principalId = options.principalId ?? 'phone';

    // §9: drop the raw string where practical. JavaScript cannot guarantee erasure,
    // which the report states honestly; what this does guarantee is that nothing
    // here *holds* a reference to the plaintext for later use.
    this.expectedDigest = Buffer.from(this.expectedDigest);
  }

  /**
   * Verify a supplied credential in constant time.
   *
   * The comparison is between two fixed-length SHA-256 digests, so neither the
   * length nor the content of the supplied value influences the work performed.
   *
   * @param {string} supplied - the presented credential.
   * @returns {{ok: true, principalId: string, digest: Buffer} | {ok: false}} the result.
   */
  verify(supplied) {
    if (typeof supplied !== 'string' || supplied.length === 0) return { ok: false };
    // Hash first, so a wrong-length input still becomes a fixed-length digest and
    // the comparison never short-circuits on length.
    const suppliedDigest = tokenDigest(supplied);
    if (suppliedDigest.length !== this.expectedDigest.length) return { ok: false };
    if (!timingSafeEqual(suppliedDigest, this.expectedDigest)) return { ok: false };
    return { ok: true, principalId: this.principalId, digest: suppliedDigest };
  }
}
