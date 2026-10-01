/**
 * WebSocket connection limits — Phase R6 §38, §39, §56.
 *
 * A per-principal cap on live event streams, so one authenticated client cannot
 * exhaust the server's sockets. §38 requires the accounting to be leak-free: a slot
 * is taken on a *successful* upgrade and released on close or abrupt termination.
 *
 * §56's ordering matters and is implemented here:
 *
 * ```text
 * validate the ticket  (non-binding)
 *   ↓
 * reserve a slot       (refuses when full, leaving the ticket unused)
 *   ↓
 * consume the ticket   (atomic)
 *   ↓
 * upgrade
 * ```
 *
 * Reserving before consuming means a connection-limit refusal does **not** burn the
 * ticket, and consuming last means the ticket is spent only once everything else has
 * succeeded. A failed upgrade still releases the reserved slot; the ticket stays
 * consumed, because §19 prefers security over convenience.
 */

import { AUTH_ERROR, authError } from './errors.mjs';

/** Default concurrent streams per principal (§38). */
export const DEFAULT_MAX_CONNECTIONS_PER_PRINCIPAL = 4;

/**
 * A per-principal connection limiter.
 */
export class ConnectionLimiter {
  /**
   * @param {object} [options] - limiter options.
   * @param {number} [options.maxPerPrincipal] - the cap.
   */
  constructor(options = {}) {
    this.maxPerPrincipal = options.maxPerPrincipal ?? DEFAULT_MAX_CONNECTIONS_PER_PRINCIPAL;
    if (!Number.isSafeInteger(this.maxPerPrincipal) || this.maxPerPrincipal < 1) {
      throw authError(AUTH_ERROR.CONFIG_INVALID, {
        message: 'The per-principal connection limit must be a positive integer.',
      });
    }
    /** @type {Map<string, number>} principalId → live count, including reservations. */
    this.counts = new Map();
    /** Counters for tests and diagnostics. */
    this.counters = { reserved: 0, released: 0, refused: 0, committed: 0 };
  }

  /**
   * The live count for a principal.
   *
   * @param {string} principalId - the principal.
   * @returns {number} the count.
   */
  countFor(principalId) {
    return this.counts.get(principalId) ?? 0;
  }

  /**
   * Reserve a slot.
   *
   * The reservation counts immediately, so two simultaneous upgrades cannot both
   * pass a limit of one.
   *
   * @param {string} principalId - the principal.
   * @returns {{ok: true, principalId: string} | {ok: false}} the result.
   */
  reserve(principalId) {
    const current = this.counts.get(principalId) ?? 0;
    if (current >= this.maxPerPrincipal) {
      this.counters.refused += 1;
      return { ok: false };
    }
    this.counts.set(principalId, current + 1);
    this.counters.reserved += 1;
    return { ok: true, principalId };
  }

  /**
   * Release a slot.
   *
   * Idempotent in effect: the count never goes below zero, so a double release from
   * a close handler firing twice cannot corrupt the accounting.
   *
   * @param {string} principalId - the principal.
   * @returns {boolean} true when a slot was actually released.
   */
  release(principalId) {
    const current = this.counts.get(principalId) ?? 0;
    if (current <= 0) return false;
    if (current === 1) this.counts.delete(principalId);
    else this.counts.set(principalId, current - 1);
    this.counters.released += 1;
    return true;
  }

  /**
   * Mark a reservation as a committed live connection.
   *
   * Kept as a separate step so the counters can distinguish "reserved" from
   * "actually serving", which is what a leak diagnosis needs.
   *
   * @returns {void}
   */
  commit() {
    this.counters.committed += 1;
  }

  /**
   * Assert capacity, throwing when full.
   *
   * @param {string} principalId - the principal.
   * @returns {void}
   * @throws {AuthError} `WS_CONNECTION_LIMIT`.
   */
  assertCapacity(principalId) {
    if (this.countFor(principalId) >= this.maxPerPrincipal) {
      this.counters.refused += 1;
      throw authError(AUTH_ERROR.WS_CONNECTION_LIMIT, { retryAfter: 1 });
    }
  }

  /**
   * Drop every reservation.
   *
   * @returns {number} how many principals were cleared.
   */
  clear() {
    const count = this.counts.size;
    this.counts.clear();
    return count;
  }

  /**
   * Diagnostics. Never includes a credential.
   *
   * @returns {object} the summary.
   */
  stats() {
    let total = 0;
    for (const value of this.counts.values()) total += value;
    return {
      max_per_principal: this.maxPerPrincipal,
      principals: this.counts.size,
      active: total,
      counters: { ...this.counters },
    };
  }
}
