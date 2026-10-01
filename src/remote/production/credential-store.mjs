/**
 * Production Phone credential — Phase R7 §9, §10, §11.
 *
 * The credential is the one piece of durable secret material in the whole stack, so
 * this module is deliberately narrow: generate once, load thereafter, never print,
 * never log, never regenerate silently.
 *
 * **§9's exclusive create is the important detail.** Two supervisors racing to start
 * for the first time must not each generate a credential — one would win the write
 * and the other would hold a token nobody ever stored, producing a Gateway whose
 * credential does not match its file. `wx` makes the create atomic, so the loser
 * sees `EEXIST` and loads the winner's credential instead.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { R7_ERROR, ProductionError } from './production-config.mjs';

/** Credential format version. */
export const CREDENTIAL_VERSION = 1;

/** Bytes of entropy in a Phone token (§9). */
export const TOKEN_BYTES = 32;

/** The exact shape a Phone token must have. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The metadata schema version. */
export const META_VERSION = 1;

/**
 * Generate a Phone token.
 *
 * @returns {string} 43 characters of base64url.
 */
export function generatePhoneToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Whether a value has the documented Phone-token shape.
 *
 * @param {unknown} value - the candidate.
 * @returns {boolean} true when valid.
 */
export function isValidPhoneToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/**
 * Instances that generated a credential in this process.
 *
 * §11 requires a one-line "created securely" notice on first generation and silence
 * thereafter. Tracking it here rather than returning a flag from `load` keeps the
 * notice out of every caller's control flow.
 */
const CREATED_IN_PROCESS = new Set();

/**
 * Whether this process generated a credential.
 *
 * @returns {boolean} true when a credential was created.
 */
export function credentialWasCreated() {
  return CREATED_IN_PROCESS.size > 0;
}

/**
 * The safe, secret-free first-generation notice (§11).
 *
 * @returns {string} the notice text.
 */
export function creationNotice() {
  return 'Phone credential created securely.\nUse phone-token-show.ps1 to reveal it explicitly.';
}

/**
 * The production credential store.
 */
export class CredentialStore {
  /**
   * @param {object} options - store options.
   * @param {object} options.paths - the resolved `paths` block.
   * @param {(target: string, options: object) => Promise<object>} [options.harden] - ACL hardener.
   * @param {(target: string, options: object) => Promise<object>} [options.verify] - ACL verifier.
   * @param {() => string} [options.clock] - injectable clock.
   * @param {() => string} [options.uuid] - injectable id generator.
   */
  constructor(options) {
    if (options?.paths === undefined) throw new TypeError('CredentialStore requires paths');
    this.paths = options.paths;
    this.harden = options.harden ?? null;
    this.verify = options.verify ?? null;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
    /** The loaded or generated token. Never logged, never serialized. */
    this.token = null;
    this.generationId = null;
    this.createdAt = null;
  }

  /**
   * Whether the credential file exists.
   *
   * @returns {boolean} true when present.
   */
  exists() {
    return fs.existsSync(this.paths.phoneToken);
  }

  /**
   * Create the credential if absent, otherwise load it.
   *
   * @returns {Promise<{created: boolean, generationId: string, notice: string|null}>} the outcome.
   * @throws {ProductionError} `R7_PHONE_TOKEN_INVALID` on a malformed existing token.
   */
  async ensure() {
    if (this.exists()) {
      const loaded = await this.load();
      return { created: false, generationId: loaded.generationId, notice: null };
    }

    const created = await this.create();
    return { created: true, generationId: created.generationId, notice: creationNotice() };
  }

  /**
   * Generate a fresh credential with an exclusive create.
   *
   * @returns {Promise<{generationId: string}>} the new credential's metadata.
   * @throws {ProductionError} `R7_CREDENTIAL_RACE` if another process won.
   */
  async create() {
    const token = generatePhoneToken();
    const meta = {
      v: META_VERSION,
      created_at: this.clock(),
      generation_id: this.uuid(),
    };

    // The secret must exist before anything else can be created inside secrets/.
    fs.mkdirSync(this.paths.secrets, { recursive: true });

    // §9: exclusive create. `wx` fails with EEXIST rather than truncating, so a
    // racing supervisor cannot overwrite a credential that already exists.
    let handle;
    try {
      handle = fs.openSync(this.paths.phoneToken, 'wx', 0o600);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new ProductionError(
          R7_ERROR.CREDENTIAL_RACE,
          'another process created the Phone credential first; load it instead of regenerating',
        );
      }
      throw error;
    }
    try {
      // No BOM, no trailing newline: the file is the token, byte for byte (§10).
      fs.writeSync(handle, token, null, 'utf8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }

    // ACL before the metadata file, so the directory is protected first (§6).
    if (this.harden !== null) await this.harden(this.paths.phoneToken, { label: 'phone-token' });
    if (this.verify !== null) await this.verify(this.paths.phoneToken, { code: R7_ERROR.PHONE_TOKEN_ACL_INVALID, label: 'phone-token' });

    // §10: metadata carries no token, hash, prefix or fingerprint.
    fs.writeFileSync(this.paths.phoneTokenMeta, `${JSON.stringify(meta, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

    this.token = token;
    this.generationId = meta.generation_id;
    this.createdAt = meta.created_at;
    CREATED_IN_PROCESS.add(this.paths.phoneToken);
    return { generationId: meta.generation_id };
  }

  /**
   * Load and validate the existing credential.
   *
   * Never regenerates silently (§9): a malformed file is a hard failure, because
   * regenerating would silently invalidate whatever the phone already holds.
   *
   * @returns {Promise<{token: string, generationId: string}>} the credential.
   * @throws {ProductionError} `R7_PHONE_TOKEN_INVALID` or `R7_PHONE_TOKEN_ACL_INVALID`.
   */
  async load() {
    // §8: the ACL is verified **before** the secret is read. Reading first would put
    // a secret into memory from a file that may be world-readable.
    if (this.verify !== null) {
      await this.verify(this.paths.phoneToken, { code: R7_ERROR.PHONE_TOKEN_ACL_INVALID, label: 'phone-token' });
    }

    let token;
    try {
      token = fs.readFileSync(this.paths.phoneToken, 'utf8');
    } catch (error) {
      throw new ProductionError(R7_ERROR.PHONE_TOKEN_INVALID, `cannot read the Phone credential: ${error.code ?? 'unknown'}`);
    }

    if (!isValidPhoneToken(token)) {
      // Deliberately does not echo the value or its length.
      throw new ProductionError(
        R7_ERROR.PHONE_TOKEN_INVALID,
        'the Phone credential does not match the required 32-byte base64url format',
      );
    }

    let generationId = null;
    try {
      const meta = JSON.parse(fs.readFileSync(this.paths.phoneTokenMeta, 'utf8'));
      if (meta?.v !== META_VERSION) {
        throw new ProductionError(R7_ERROR.PHONE_TOKEN_INVALID, 'the credential metadata has an unsupported version');
      }
      generationId = typeof meta.generation_id === 'string' ? meta.generation_id : null;
      this.createdAt = typeof meta.created_at === 'string' ? meta.created_at : null;
    } catch (error) {
      if (error instanceof ProductionError) throw error;
      throw new ProductionError(R7_ERROR.PHONE_TOKEN_INVALID, 'the credential metadata is unreadable');
    }

    this.token = token;
    this.generationId = generationId;
    return { token, generationId };
  }

  /**
   * The token for constructing an `AuthService`.
   *
   * @returns {string} the token.
   * @throws {ProductionError} when no credential has been loaded yet.
   */
  requireToken() {
    if (!isValidPhoneToken(this.token)) {
      throw new ProductionError(R7_ERROR.PHONE_TOKEN_INVALID, 'no Phone credential has been loaded');
    }
    return this.token;
  }

  /**
   * A safe description for status output and logs.
   *
   * Deliberately omits the token, any digest, and any prefix. The generation id is
   * an opaque identifier, not derived from the secret, and it is what lets an
   * operator confirm a restart did **not** rotate the credential (§35).
   *
   * @returns {object} the safe summary.
   */
  describe() {
    return {
      present: this.exists(),
      loaded: isValidPhoneToken(this.token),
      generation_id: this.generationId,
      created_at: this.createdAt,
    };
  }

  /**
   * Atomically replace the credential (§11).
   *
   * The caller must have stopped the supervisor first. The new token is written to a
   * temporary file, ACL-hardened, validated, and only then renamed over the old one,
   * so a crash mid-rotation cannot leave a half-written credential. **No plaintext
   * backup of the old token is kept** — recovering the old value is not a goal.
   *
   * @returns {Promise<{generationId: string}>} the new metadata.
   */
  async rotate() {
    const token = generatePhoneToken();
    const meta = { v: META_VERSION, created_at: this.clock(), generation_id: this.uuid() };
    const tempPath = `${this.paths.phoneToken}.tmp-${process.pid}`;

    try {
      fs.writeFileSync(tempPath, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      if (this.harden !== null) await this.harden(tempPath, { label: 'phone-token-temp' });
      if (this.verify !== null) {
        await this.verify(tempPath, { code: R7_ERROR.PHONE_TOKEN_ACL_INVALID, label: 'phone-token-temp' });
      }

      // Atomic replace on the same volume.
      fs.renameSync(tempPath, this.paths.phoneToken);
      if (this.harden !== null) await this.harden(this.paths.phoneToken, { label: 'phone-token' });
      fs.writeFileSync(this.paths.phoneTokenMeta, `${JSON.stringify(meta, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    } finally {
      // The temp file must never survive, successfully or not.
      try { fs.rmSync(tempPath, { force: true }); } catch { /* best effort */ }
    }

    this.token = token;
    this.generationId = meta.generation_id;
    this.createdAt = meta.created_at;
    return { generationId: meta.generation_id };
  }

  /**
   * Drop the in-memory token.
   *
   * JavaScript cannot guarantee erasure (§9 of the R6 security model), so this drops
   * the reference and says so rather than claiming zeroisation.
   *
   * @returns {void}
   */
  clear() {
    this.token = null;
    this.generationId = null;
  }
}

/**
 * Redact a token wherever it might appear.
 *
 * @param {string} text - the text to scrub.
 * @param {readonly string[]} secrets - the values to remove.
 * @param {string} [replacement] - what to substitute.
 * @returns {string} the scrubbed text.
 */
export function redactSecrets(text, secrets, replacement = '<redacted>') {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue;
    out = out.split(secret).join(replacement);
  }
  return out;
}

/**
 * Assert that no secret appears in a value (§39).
 *
 * @param {unknown} value - the value to check.
 * @param {readonly string[]} secrets - the forbidden values.
 * @param {string} where - a label for the error.
 * @returns {void}
 * @throws {ProductionError} when a secret is present.
 */
export function assertNoSecrets(value, secrets, where) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue;
    if (text.includes(secret)) {
      throw new ProductionError(R7_ERROR.PRODUCTION_SMOKE_FAILED, `a secret reached ${where}`);
    }
  }
}

/**
 * The default production path for the credential, for messages.
 *
 * @param {object} config - a resolved production config.
 * @returns {string} the path.
 */
export function credentialPath(config) {
  return path.join(config.paths.secrets, 'phone-token.v1');
}
