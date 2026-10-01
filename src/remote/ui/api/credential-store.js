/**
 * Phone credential storage.
 *
 * Session-only is the default. Persistent storage is used only after an explicit opt-in.
 * Credentials are never placed in a URL, cookie, console or DOM after the dialog closes.
 *
 * The storage object is injected so tests can drive a fake, and so the module never reaches
 * for a global that may not exist.
 */

/** The single key this application owns. */
export const CREDENTIAL_KEY = 'dsh.remote.phoneCredential';
export const PERSISTENT_CREDENTIAL_KEY = 'dsh.remote.phoneCredential.persistent';
export const REMEMBER_PREFERENCE_KEY = 'dsh.remote.phoneCredential.remember';

/**
 * A credential store over an injected `sessionStorage`-like object.
 */
export class CredentialStore {
  /**
   * @param {object} [options] - session `storage` and opt-in `persistentStorage`.
   */
  constructor(options = {}) {
    this.storage = options.storage ?? globalThis.sessionStorage ?? null;
    this.persistentStorage = options.persistentStorage ?? globalThis.localStorage ?? null;
  }

  /**
   * Whether storage is usable at all.
   *
   * Private browsing and some embedded views throw on access; the UI degrades to
   * "not remembered" rather than failing.
   *
   * @returns {boolean} true when storage can be used.
   */
  get available() {
    try {
      return this.storage !== null && typeof this.storage.getItem === 'function';
    } catch {
      return false;
    }
  }

  /**
   * Read the stored credential.
   *
   * @returns {string|null} the credential, or null.
   */
  read() {
    const persistent = this.#readPersistent(PERSISTENT_CREDENTIAL_KEY);
    if (persistent !== null) return persistent;
    if (!this.available) return null;
    try {
      const value = this.storage.getItem(CREDENTIAL_KEY);
      return typeof value === 'string' && value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * Store the credential.
   *
   * @param {string} value - the Phone Access Token.
   * @returns {boolean} true when it was stored.
   */
  write(value, options = {}) {
    if (typeof value !== 'string' || value.length === 0) return false;
    if (options.remember === true) {
      try {
        if (this.persistentStorage === null) return false;
        this.persistentStorage.setItem(PERSISTENT_CREDENTIAL_KEY, value);
        if (this.available) this.storage.removeItem(CREDENTIAL_KEY);
        return true;
      } catch { return false; }
    }
    if (!this.available) return false;
    try {
      this.storage.setItem(CREDENTIAL_KEY, value);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Remove the credential.
   *
   * Called on `401` and on explicit sign-out. **Never** on a network failure — the token may
   * still be perfectly valid and the Gateway merely unreachable.
   *
   * @returns {void}
   */
  clear() {
    try { this.storage?.removeItem(CREDENTIAL_KEY); } catch { /* inaccessible */ }
    try { this.persistentStorage?.removeItem(PERSISTENT_CREDENTIAL_KEY); } catch { /* inaccessible */ }
  }

  /**
   * Whether a credential is present, without revealing it.
   *
   * @returns {boolean} true when one is stored.
   */
  has() {
    return this.read() !== null;
  }

  isRemembered() {
    try { return this.persistentStorage?.getItem(REMEMBER_PREFERENCE_KEY) === 'true'; }
    catch { return false; }
  }

  setRemember(remember) {
    try {
      if (this.persistentStorage === null) return false;
      this.persistentStorage.setItem(REMEMBER_PREFERENCE_KEY, remember ? 'true' : 'false');
      if (!remember) this.persistentStorage.removeItem(PERSISTENT_CREDENTIAL_KEY);
      return true;
    } catch { return false; }
  }

  #readPersistent(key) {
    try {
      const value = this.persistentStorage?.getItem(key);
      return typeof value === 'string' && value.length > 0 ? value : null;
    } catch { return null; }
  }
}

/**
 * Build a minimal in-memory storage with the `sessionStorage` shape.
 *
 * Used by tests, and as the fallback when a browser denies storage.
 *
 * @returns {object} the storage.
 */
export function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    clear: () => map.clear(),
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
  };
}

/**
 * Redact a credential for any diagnostic string.
 *
 * Returns a fixed placeholder rather than a partial value: even a prefix is a leak.
 *
 * @param {unknown} value - anything.
 * @returns {string} a safe description.
 */
export function redactCredential(value) {
  return typeof value === 'string' && value.length > 0 ? '[redacted]' : '[absent]';
}
