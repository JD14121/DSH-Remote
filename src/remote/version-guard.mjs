/**
 * DSH version guard — Phase R1 §13.
 *
 * The adapter depends on a *browser-internal* wire. That coupling is the known
 * risk of Substrate A (R0 §13.2, R1 §0.1), so the guard must **fail closed**:
 * R1 §13 forbids "warn and continue". An unknown or unexpected version raises
 * `WIRE_VERSION_MISMATCH` and the adapter refuses to run.
 *
 * Verification inputs allowed by R1 §13:
 *   - an explicit observed version;
 *   - a fixture version.
 *
 * The observed version is typically taken from the DSH installation's
 * `package.json`, which the caller reads and passes in. This module never reads
 * the filesystem itself, so it stays testable and has no hidden I/O.
 */

import { AdapterError, ADAPTER_ERROR } from './adapter-errors.mjs';

/** Versions this build of the adapter is verified against. */
export const SUPPORTED_DSH_VERSIONS = Object.freeze(['0.1.5-rc.2']);

/** The primary version the R1 contract fixtures were derived from. */
export const TARGET_DSH_VERSION = '0.1.5-rc.2';

/**
 * Whether a value looks like a semantic version, optionally prerelease-tagged.
 *
 * @param {unknown} value - candidate version.
 * @returns {boolean} true when the value matches `major.minor.patch[-prerelease]`.
 */
export function isVersionLike(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

/**
 * Assert that an observed DSH version is supported, or throw.
 *
 * @param {unknown} observed - observed version, e.g. from the DSH package manifest.
 * @param {object} [options] - guard options.
 * @param {readonly string[]} [options.supported] - override the supported list.
 * @param {string} [options.source] - where the observation came from, for the error detail.
 * @returns {string} the accepted version.
 * @throws {AdapterError} `WIRE_VERSION_MISMATCH` when missing, malformed or unsupported.
 */
export function assertSupportedVersion(observed, options = {}) {
  const supported = options.supported ?? SUPPORTED_DSH_VERSIONS;
  const source = options.source;

  if (observed === undefined || observed === null || observed === '') {
    throw new AdapterError(
      ADAPTER_ERROR.WIRE_VERSION_MISMATCH,
      'no DSH version was observed; the adapter fails closed because it depends on a browser-internal wire',
      { details: { supported: [...supported], ...(source ? { source } : {}) }, retryable: false },
    );
  }

  if (!isVersionLike(observed)) {
    throw new AdapterError(
      ADAPTER_ERROR.WIRE_VERSION_MISMATCH,
      `observed DSH version is not a valid version string: ${JSON.stringify(observed)}`,
      { details: { supported: [...supported], ...(source ? { source } : {}) }, retryable: false },
    );
  }

  if (!supported.includes(observed)) {
    throw new AdapterError(
      ADAPTER_ERROR.WIRE_VERSION_MISMATCH,
      `DSH version ${observed} is not verified against this adapter`,
      {
        details: { observed, supported: [...supported], ...(source ? { source } : {}) },
        retryable: false,
      },
    );
  }

  return observed;
}

/**
 * Version guard used by `DshAdapter`.
 *
 * The guard is consulted lazily on first use so that constructing an adapter
 * performs no I/O (R1 §5.1).
 */
export class DshVersionGuard {
  /**
   * @param {object} options - guard settings.
   * @param {string} [options.observedVersion] - known version, when the caller has it.
   * @param {() => (string|Promise<string>)} [options.resolveObserved] - lazy version source.
   * @param {readonly string[]} [options.supported] - override the supported list.
   * @param {string} [options.source] - provenance label for error details.
   */
  constructor(options = {}) {
    if (options.observedVersion === undefined && options.resolveObserved === undefined) {
      throw new TypeError('DshVersionGuard requires observedVersion or resolveObserved');
    }
    this.observedVersion = options.observedVersion;
    this.resolveObserved = options.resolveObserved;
    this.supported = options.supported ?? SUPPORTED_DSH_VERSIONS;
    this.source = options.source;
    this.verified = undefined;
    /** @type {Promise<string> | undefined} */
    this.pending = undefined;
  }

  /**
   * Verify and cache the version.
   *
   * @returns {Promise<string>} the accepted version.
   * @throws {AdapterError} `WIRE_VERSION_MISMATCH` when the version is unacceptable.
   */
  async verify() {
    if (this.verified !== undefined) return this.verified;
    if (this.pending === undefined) {
      this.pending = (async () => {
        let observed = this.observedVersion;
        if (observed === undefined) {
          try {
            observed = await this.resolveObserved();
          } catch (error) {
            throw new AdapterError(
              ADAPTER_ERROR.WIRE_VERSION_MISMATCH,
              'could not determine the DSH version; the adapter fails closed',
              { cause: error, retryable: false },
            );
          }
        }
        const accepted = assertSupportedVersion(observed, {
          supported: this.supported,
          source: this.source,
        });
        this.verified = accepted;
        return accepted;
      })();
    }
    return this.pending;
  }

  /**
   * Whether verification has already succeeded.
   *
   * @returns {boolean} true once a version has been accepted.
   */
  get isVerified() {
    return this.verified !== undefined;
  }
}

/**
 * Build a guard from a fixed, observed version string.
 *
 * @param {string} observedVersion - the version to trust.
 * @returns {DshVersionGuard} a guard over that version.
 */
export function staticVersionGuard(observedVersion) {
  return new DshVersionGuard({ observedVersion, source: 'explicit' });
}
