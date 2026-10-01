/**
 * R9-RELAY-01 — identity policy.
 *
 * Prototypes the ADR-v3 client-identity model for the offline bridge:
 *
 *   * an **active enrollment allowlist**
 *   * an **issuer / key-id / serial denylist**
 *   * **certificate fingerprint binding**
 *   * a **monotonic policy generation**
 *
 * ## Fail closed
 *
 * A missing, unreadable, malformed, or internally inconsistent policy denies every client. Denial is
 * the default; the policy can only ever grant. A corrupt file must never be read as "no restrictions".
 *
 * ## No reconstruction from history
 *
 * The allowlist is never derived from certificates the bridge has previously seen. A client cannot
 * earn enrollment by connecting.
 *
 * ## Atomic activation
 *
 * An update is written to a temporary file and renamed into place, then the generation is incremented
 * and activated. A failed write leaves the previous generation authoritative — the bridge never
 * claims an update it did not commit.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The generation every decision carries, so a decision can be tied to the policy that made it. */
export const INITIAL_GENERATION = 1;

/**
 * Compute the stable fingerprint of a certificate.
 *
 * SHA-256 over the DER encoding, hex, lowercase. This is the binding used for allowlist entries and
 * for revocation, so it must be identical wherever it is computed.
 *
 * @param {Buffer|string} der - the DER bytes, or a PEM string.
 * @returns {string} the fingerprint.
 */
export function fingerprintOf(der) {
  const buffer = Buffer.isBuffer(der) ? der : Buffer.from(String(der));
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** The result of a policy decision. */
export const DECISION = Object.freeze({
  ALLOW: 'allow',
  DENY: 'deny',
});

/**
 * An immutable identity policy snapshot.
 *
 * Constructed only through {@link IdentityPolicy.empty} or {@link IdentityPolicy.fromObject}, both of
 * which fail closed on bad input.
 */
export class IdentityPolicy {
  /**
   * @param {object} fields - `generation`, `allow`, `deny`, `source`.
   */
  constructor(fields) {
    this.generation = fields.generation;
    this.allow = fields.allow;
    this.deny = fields.deny;
    this.source = fields.source;
    Object.freeze(this);
  }

  /**
   * The empty policy: valid, but grants nothing.
   *
   * @returns {IdentityPolicy} the policy.
   */
  static empty() {
    return new IdentityPolicy({ generation: INITIAL_GENERATION, allow: new Map(), deny: new Set(), source: 'empty' });
  }

  /**
   * Build a policy from a parsed object, failing closed on anything unexpected.
   *
   * @param {unknown} value - the parsed policy.
   * @param {string} [source] - where it came from, for diagnostics.
   * @returns {{ok: true, policy: IdentityPolicy}|{ok: false, reason: string}} the outcome.
   */
  static fromObject(value, source = 'inline') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: 'policy was not an object' };
    }
    const generation = value.generation;
    if (!Number.isInteger(generation) || generation < 1) {
      return { ok: false, reason: 'policy generation must be a positive integer' };
    }
    if (!Array.isArray(value.allow)) {
      return { ok: false, reason: 'policy allow list must be an array' };
    }
    const deny = value.deny === undefined ? [] : value.deny;
    if (!Array.isArray(deny)) {
      return { ok: false, reason: 'policy deny list must be an array' };
    }

    const allow = new Map();
    for (const entry of value.allow) {
      if (entry === null || typeof entry !== 'object') {
        return { ok: false, reason: 'an allow entry was not an object' };
      }
      const { fingerprint, label } = entry;
      if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
        return { ok: false, reason: 'an allow entry had no valid SHA-256 fingerprint' };
      }
      if (label !== undefined && typeof label !== 'string') {
        return { ok: false, reason: 'an allow entry label was not a string' };
      }
      if (allow.has(fingerprint)) {
        return { ok: false, reason: 'an allow entry was duplicated' };
      }
      allow.set(fingerprint, { label: label ?? null });
    }

    const denySet = new Set();
    for (const entry of deny) {
      if (entry === null || typeof entry !== 'object') {
        return { ok: false, reason: 'a deny entry was not an object' };
      }
      // A deny entry matches on any one of these; each is optional but at least one is required so a
      // deny rule can never be vacuously empty and silently match nothing.
      const { fingerprint, serial, issuer, key_id: keyId } = entry;
      const present = [fingerprint, serial, issuer, keyId].filter((v) => v !== undefined);
      if (present.length === 0) {
        return { ok: false, reason: 'a deny entry specified no matching field' };
      }
      for (const v of present) {
        if (typeof v !== 'string' || v.length === 0) {
          return { ok: false, reason: 'a deny entry field was not a non-empty string' };
        }
      }
      denySet.add(JSON.stringify({ fingerprint: fingerprint ?? null, serial: serial ?? null, issuer: issuer ?? null, key_id: keyId ?? null }));
    }

    // An identity that is both allowed and denied is a contradiction; refuse rather than guess.
    for (const fingerprint of allow.keys()) {
      for (const rule of denySet) {
        const parsed = JSON.parse(rule);
        if (parsed.fingerprint === fingerprint) {
          return { ok: false, reason: 'an identity appeared in both the allow and deny lists' };
        }
      }
    }

    return { ok: true, policy: new IdentityPolicy({ generation, allow, deny: denySet, source }) };
  }

  /**
   * Load a policy from disk.
   *
   * A missing file yields the empty policy, which grants nothing. An unreadable or malformed file is
   * a hard failure, never an empty policy — those are different situations and must not be conflated.
   *
   * @param {string} file - the policy path.
   * @returns {{ok: true, policy: IdentityPolicy}|{ok: false, reason: string}} the outcome.
   */
  static load(file) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: true, policy: IdentityPolicy.empty() };
      return { ok: false, reason: `policy could not be read: ${error?.code ?? 'unknown'}` };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'policy was not valid JSON' };
    }
    return IdentityPolicy.fromObject(parsed, file);
  }

  /**
   * Decide one client identity.
   *
   * @param {object} identity - `{fingerprint, serial, issuer, key_id}`.
   * @returns {{decision: string, reason: string, generation: number, label: string|null}} the verdict.
   */
  decide(identity) {
    const generation = this.generation;
    if (identity === null || typeof identity !== 'object') {
      return { decision: DECISION.DENY, reason: 'no client identity was presented', generation, label: null };
    }
    if (typeof identity.fingerprint !== 'string' || identity.fingerprint.length === 0) {
      return { decision: DECISION.DENY, reason: 'the client certificate had no fingerprint', generation, label: null };
    }

    // The denylist is checked first, so a revocation cannot be defeated by a stale allow entry.
    for (const rule of this.deny) {
      const parsed = JSON.parse(rule);
      if (parsed.fingerprint !== null && parsed.fingerprint === identity.fingerprint) {
        return { decision: DECISION.DENY, reason: 'the identity fingerprint is revoked', generation, label: null };
      }
      if (parsed.serial !== null && parsed.serial === identity.serial) {
        return { decision: DECISION.DENY, reason: 'the certificate serial is revoked', generation, label: null };
      }
      if (parsed.issuer !== null && parsed.issuer === identity.issuer) {
        return { decision: DECISION.DENY, reason: 'the issuing CA is revoked', generation, label: null };
      }
      if (parsed.key_id !== null && parsed.key_id === identity.key_id) {
        return { decision: DECISION.DENY, reason: 'the key id is revoked', generation, label: null };
      }
    }

    const entry = this.allow.get(identity.fingerprint);
    if (entry === undefined) {
      return { decision: DECISION.DENY, reason: 'the identity is not in the active enrollment allowlist', generation, label: null };
    }
    return { decision: DECISION.ALLOW, reason: 'the identity fingerprint is actively enrolled', generation, label: entry.label };
  }

  /**
   * Produce the next policy with one more allowed identity.
   *
   * @param {object} entry - `{fingerprint, label}`.
   * @returns {IdentityPolicy} the new policy (the receiver is unchanged).
   */
  withAllowed(entry) {
    const allow = new Map(this.allow);
    allow.set(entry.fingerprint, { label: entry.label ?? null });
    return new IdentityPolicy({ generation: this.generation + 1, allow, deny: this.deny, source: 'derived' });
  }

  /**
   * Produce the next policy with one identity revoked.
   *
   * @param {object} entry - `{fingerprint}`.
   * @returns {IdentityPolicy} the new policy.
   */
  withRevoked(entry) {
    const allow = new Map(this.allow);
    allow.delete(entry.fingerprint);
    const deny = new Set(this.deny);
    deny.add(JSON.stringify({ fingerprint: entry.fingerprint, serial: null, issuer: null, key_id: null }));
    return new IdentityPolicy({ generation: this.generation + 1, allow, deny, source: 'derived' });
  }

  /**
   * Serialise for writing.
   *
   * @returns {object} the plain object form.
   */
  toObject() {
    return {
      generation: this.generation,
      allow: [...this.allow.entries()].map(([fingerprint, meta]) => ({ fingerprint, label: meta.label })),
      deny: [...this.deny].map((rule) => JSON.parse(rule)),
    };
  }
}

/**
 * Commit a policy atomically, then activate it.
 *
 * The write goes to a temporary file which is renamed into place, so a partial write can never be
 * observed. Only after the rename succeeds is the new generation activated. If anything fails, the
 * previous policy stays authoritative and the failure is reported — never masked as a success.
 *
 * @param {object} options - `file`, `next`, `active`, `onActivate`.
 * @returns {{activated: boolean, generation: number, reason: string}} the outcome.
 */
export function commitPolicyAtomically(options) {
  const { file, next, active, onActivate } = options;
  if (active !== undefined && next.generation <= active.generation) {
    return {
      activated: false,
      generation: active.generation,
      reason: `generation ${next.generation} is not greater than the active ${active.generation}`,
    };
  }

  const temp = `${file}.${process.pid}.partial`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(next.toObject(), null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
  } catch (error) {
    // Clean up a stray temp file, then leave the active generation untouched.
    try { fs.unlinkSync(temp); } catch { /* already gone */ }
    return {
      activated: false,
      generation: active?.generation ?? null,
      reason: `the policy write failed: ${error?.code ?? 'unknown'}`,
    };
  }

  if (typeof onActivate === 'function') onActivate(next);
  return { activated: true, generation: next.generation, reason: 'committed and activated' };
}
