/**
 * One-time WebSocket tickets — Phase R6 §1, §16-§22, §25, §26, §39, §57, §64.
 *
 * A browser cannot set `Authorization` on a WebSocket, and R4 correctly forbids a
 * long-lived credential in a URL. The ticket resolves that: a short-lived,
 * single-use, session-bound and origin-bound value that is worthless once used.
 *
 * Three properties matter and are each enforced structurally:
 *
 *   1. **The plaintext is never stored.** Only `SHA-256(ticket)` is kept, so a
 *      memory disclosure of the store does not yield a usable ticket (§17).
 *   2. **Consumption is atomic.** Lookup and delete happen with no `await` between
 *      them, so two concurrent upgrades cannot both succeed (§57).
 *   3. **Nothing is durable.** The store is memory-only; a restart invalidates every
 *      ticket, which is the correct semantic (§25, §64).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { AUTH_ERROR, authError } from './errors.mjs';

/** Ticket entropy: 32 random bytes, base64url (§16). */
export const TICKET_BYTES = 32;

/** Default and permitted TTLs (§18). */
export const DEFAULT_TICKET_TTL_SECONDS = 30;
export const MIN_TICKET_TTL_SECONDS = 10;
export const MAX_TICKET_TTL_SECONDS = 120;

/** Default cap on outstanding tickets (§26). */
export const DEFAULT_MAX_OUTSTANDING_TICKETS = 32;

/**
 * Generate a ticket.
 *
 * §16 requires real entropy: not a UUID, not a timestamp, not a counter, and not a
 * signed session id.
 *
 * @returns {string} a 32-byte base64url ticket.
 */
export function generateTicket() {
  return randomBytes(TICKET_BYTES).toString('base64url');
}

/**
 * The digest of a ticket, as hex.
 *
 * @param {string} ticket - the plaintext ticket.
 * @returns {string} a hex SHA-256 digest.
 */
export function ticketDigest(ticket) {
  return createHash('sha256').update(ticket, 'utf8').digest('hex');
}

/**
 * The in-memory ticket store.
 */
export class TicketStore {
  /**
   * @param {object} options - store options.
   * @param {() => number} [options.clock] - injectable clock (ms).
   * @param {number} [options.ttlSeconds] - ticket lifetime.
   * @param {number} [options.maxOutstanding] - cap on live tickets.
   */
  constructor(options = {}) {
    this.clock = options.clock ?? Date.now;
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TICKET_TTL_SECONDS;
    this.maxOutstanding = options.maxOutstanding ?? DEFAULT_MAX_OUTSTANDING_TICKETS;
    if (!Number.isSafeInteger(this.ttlSeconds)
      || this.ttlSeconds < MIN_TICKET_TTL_SECONDS
      || this.ttlSeconds > MAX_TICKET_TTL_SECONDS) {
      throw authError(AUTH_ERROR.CONFIG_INVALID, {
        message: `The WS ticket TTL must be between ${MIN_TICKET_TTL_SECONDS} and ${MAX_TICKET_TTL_SECONDS} seconds.`,
      });
    }
    if (!Number.isSafeInteger(this.maxOutstanding) || this.maxOutstanding < 1) {
      throw authError(AUTH_ERROR.CONFIG_INVALID, { message: 'The outstanding ticket cap must be a positive integer.' });
    }

    /** @type {Map<string, object>} digest hex → record. Never keyed by plaintext. */
    this.records = new Map();
    /** Server-side counters for tests and diagnostics; never exposed (§20). */
    this.counters = { minted: 0, consumed: 0, expired: 0, rejectedReuse: 0, rejectedUnknown: 0, evicted: 0 };
  }

  /**
   * The number of live tickets.
   *
   * @returns {number} the count.
   */
  get size() {
    return this.records.size;
  }

  /**
   * Remove every expired ticket.
   *
   * Called lazily on mint and consume (§26). Lazy cleanup keeps the store bounded
   * without a timer that could keep the process alive.
   *
   * @returns {number} how many were removed.
   */
  cleanup() {
    const now = this.clock();
    let removed = 0;
    for (const [digest, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(digest);
        this.counters.expired += 1;
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Mint a ticket bound to a session and an origin.
   *
   * @param {object} input - the binding.
   * @param {string} input.sessionId - the session the ticket is valid for.
   * @param {string} input.principalId - the authenticated principal.
   * @param {string|null} [input.origin] - the normalised issuing origin, or `null`.
   * @returns {{ticket: string, expiresAt: number, expiresInSeconds: number, sessionId: string}} the ticket.
   * @throws {AuthError} `AUTH_TICKET_LIMIT` when the cap is reached.
   */
  mint(input) {
    this.cleanup();
    if (this.records.size >= this.maxOutstanding) {
      // §26: a cap exists so an authenticated caller cannot exhaust memory. The
      // oldest is *not* silently evicted — that would invalidate a ticket a client
      // is about to use, which is worse than refusing a new one.
      throw authError(AUTH_ERROR.TICKET_LIMIT, { retryAfter: 1 });
    }

    const ticket = generateTicket();
    const digest = ticketDigest(ticket);
    const issuedAt = this.clock();
    const expiresAt = issuedAt + this.ttlSeconds * 1000;

    this.records.set(digest, {
      digest,
      principalId: input.principalId,
      sessionId: input.sessionId,
      issuedAt,
      expiresAt,
      // §22: a browser-issued ticket is pinned to the issuing origin; a native
      // client's ticket pins to "no origin" and may only be used without one.
      originBinding: input.origin ?? null,
      consumed: false,
    });
    this.counters.minted += 1;

    return {
      ticket,
      expiresAt,
      expiresInSeconds: this.ttlSeconds,
      sessionId: input.sessionId,
    };
  }

  /**
   * Look up a ticket without consuming it.
   *
   * Used for a **non-binding** pre-check so a refusal does not burn a ticket the
   * client could still legitimately use. The authoritative single-use guarantee is
   * `consume`, which is atomic.
   *
   * @param {string} ticket - the plaintext ticket.
   * @returns {{ok: true, record: object} | {ok: false, code: string, internalReason: string}} the result.
   */
  inspect(ticket) {
    const record = this.#lookup(ticket);
    if (record === null) {
      return { ok: false, code: AUTH_ERROR.WS_TICKET_INVALID, internalReason: 'unknown ticket' };
    }
    if (record.expiresAt <= this.clock()) {
      return { ok: false, code: AUTH_ERROR.WS_TICKET_EXPIRED, internalReason: 'expired' };
    }
    if (record.consumed) {
      return { ok: false, code: AUTH_ERROR.WS_TICKET_INVALID, internalReason: 'already consumed' };
    }
    return { ok: true, record };
  }

  /**
   * Consume a ticket atomically.
   *
   * §57: in Node's single-threaded model, lookup and delete with **no await between
   * them** is atomic, so two upgrades racing on one ticket produce exactly one
   * success. This function deliberately contains no asynchronous step.
   *
   * @param {string} ticket - the plaintext ticket.
   * @returns {{ok: true, record: object} | {ok: false, code: string, internalReason: string}} the result.
   */
  consume(ticket) {
    const record = this.#lookup(ticket);
    if (record === null) {
      this.counters.rejectedUnknown += 1;
      return { ok: false, code: AUTH_ERROR.WS_TICKET_INVALID, internalReason: 'unknown ticket' };
    }
    if (record.expiresAt <= this.clock()) {
      this.records.delete(record.digest);
      this.counters.expired += 1;
      return { ok: false, code: AUTH_ERROR.WS_TICKET_EXPIRED, internalReason: 'expired' };
    }
    if (record.consumed) {
      this.counters.rejectedReuse += 1;
      return { ok: false, code: AUTH_ERROR.WS_TICKET_INVALID, internalReason: 'already consumed' };
    }

    // The atomic step: mark and remove, synchronously.
    record.consumed = true;
    this.records.delete(record.digest);
    this.counters.consumed += 1;
    return { ok: true, record };
  }

  /**
   * Find a record by digest.
   *
   * The supplied ticket is hashed and compared against stored digests. Because a
   * digest is looked up rather than compared, there is no plaintext comparison to
   * make constant-time; a digest mismatch simply finds nothing.
   *
   * @param {unknown} ticket - the plaintext ticket.
   * @returns {object|null} the record, or `null`.
   */
  #lookup(ticket) {
    if (typeof ticket !== 'string' || ticket.length === 0) return null;
    if (ticket.length > 512) return null; // a ticket is 43 chars; refuse absurd input early
    const digest = ticketDigest(ticket);
    const record = this.records.get(digest);
    if (record === undefined) return null;
    // Defensive: confirm the stored digest really matches, using a constant-time
    // compare, so a Map collision or tampering cannot pass.
    const stored = Buffer.from(record.digest, 'hex');
    const computed = Buffer.from(digest, 'hex');
    if (stored.length !== computed.length || !timingSafeEqual(stored, computed)) return null;
    return record;
  }

  /**
   * Drop every ticket.
   *
   * @returns {number} how many were dropped.
   */
  clear() {
    const count = this.records.size;
    this.records.clear();
    return count;
  }

  /**
   * Diagnostics. Never includes a ticket or a digest.
   *
   * @returns {object} the summary.
   */
  stats() {
    return {
      outstanding: this.records.size,
      ttl_seconds: this.ttlSeconds,
      max_outstanding: this.maxOutstanding,
      counters: { ...this.counters },
    };
  }
}
