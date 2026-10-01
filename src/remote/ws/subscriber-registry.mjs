/**
 * Gateway-event subscriber registry — Phase R4 §19.
 *
 * `sessionId → client sessions`. Deliberately tiny, because all of its
 * requirements are isolation requirements:
 *
 *   - per-session isolation, no cross-session leak;
 *   - one event reaching every subscriber of the same session;
 *   - one subscriber's failure never affecting a sibling;
 *   - idempotent unsubscribe;
 *   - `closeAll()` empties it on shutdown.
 *
 * It holds **no** event state. The ring lives in `EventsService`; a second log
 * here would violate §20.
 */

/**
 * A registry of live WebSocket client sessions, keyed by DSH session.
 */
export class SubscriberRegistry {
  constructor() {
    /** @type {Map<string, Set<object>>} */
    this.bySession = new Map();
    this.publishFailures = 0;
  }

  /**
   * Register a client for a session.
   *
   * @param {string} sessionId - the DSH session.
   * @param {object} client - the client session (must expose `deliver(event)`).
   * @returns {void}
   * @throws {TypeError} when the arguments are unusable.
   */
  subscribe(sessionId, client) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TypeError('subscribe requires a session id');
    }
    if (client === null || typeof client !== 'object') {
      throw new TypeError('subscribe requires a client session object');
    }
    let subscribers = this.bySession.get(sessionId);
    if (subscribers === undefined) {
      subscribers = new Set();
      this.bySession.set(sessionId, subscribers);
    }
    subscribers.add(client);
  }

  /**
   * Remove a client from a session.
   *
   * Idempotent: unsubscribing twice, or unsubscribing a never-registered client,
   * is not an error.
   *
   * @param {string} sessionId - the DSH session.
   * @param {object} client - the client session.
   * @returns {boolean} true when a registration was removed.
   */
  unsubscribe(sessionId, client) {
    const subscribers = this.bySession.get(sessionId);
    if (subscribers === undefined) return false;
    const removed = subscribers.delete(client);
    if (subscribers.size === 0) this.bySession.delete(sessionId);
    return removed;
  }

  /**
   * Remove a client from every session it registered for.
   *
   * @param {object} client - the client session.
   * @returns {number} how many registrations were removed.
   */
  unsubscribeAll(client) {
    let removed = 0;
    for (const [sessionId, subscribers] of [...this.bySession]) {
      if (subscribers.delete(client)) {
        removed += 1;
        if (subscribers.size === 0) this.bySession.delete(sessionId);
      }
    }
    return removed;
  }

  /**
   * Deliver an event to every subscriber of its session.
   *
   * A throwing subscriber is counted and skipped; its siblings still receive the
   * event, and the caller is not interrupted (§19).
   *
   * @param {object} event - a Gateway event.
   * @returns {number} how many clients accepted the event.
   */
  publish(event) {
    const sessionId = event?.session_id;
    if (typeof sessionId !== 'string') return 0;
    const subscribers = this.bySession.get(sessionId);
    if (subscribers === undefined || subscribers.size === 0) return 0;

    let delivered = 0;
    // Iterate a copy: a delivery failure may unsubscribe synchronously.
    for (const client of [...subscribers]) {
      try {
        if (client.deliver(event) === true) delivered += 1;
      } catch {
        this.publishFailures += 1;
      }
    }
    return delivered;
  }

  /**
   * How many clients are registered for a session.
   *
   * @param {string} sessionId - the DSH session.
   * @returns {number} the subscriber count.
   */
  count(sessionId) {
    return this.bySession.get(sessionId)?.size ?? 0;
  }

  /**
   * Every subscribed session id.
   *
   * @returns {string[]} the session ids.
   */
  sessions() {
    return [...this.bySession.keys()];
  }

  /**
   * The total number of registrations across all sessions.
   *
   * @returns {number} the registration count.
   */
  get size() {
    let total = 0;
    for (const subscribers of this.bySession.values()) total += subscribers.size;
    return total;
  }

  /**
   * Whether the registry is empty.
   *
   * @returns {boolean} true when nothing is registered.
   */
  get isEmpty() {
    return this.bySession.size === 0;
  }

  /**
   * Empty the registry and close every client.
   *
   * @param {string} [reason] - forwarded to each client's `close`.
   * @returns {Promise<number>} how many clients were closed.
   */
  async closeAll(reason) {
    const clients = new Set();
    for (const subscribers of this.bySession.values()) {
      for (const client of subscribers) clients.add(client);
    }
    this.bySession.clear();

    let closed = 0;
    for (const client of clients) {
      try {
        await client.close(reason);
        closed += 1;
      } catch {
        // A client that fails to close is already gone; the registry is empty
        // either way, which is what shutdown needs.
      }
    }
    return closed;
  }
}
