/**
 * StatusService test harness — a scripted adapter that records subscriptions.
 *
 * Lets a test drive control frames and follow events by hand and then assert on
 * the resulting domain state, without any socket, DSH, or filesystem involved.
 */

import { EventsService } from '../../src/remote/events.mjs';
import { StatusService } from '../../src/remote/status-service.mjs';
import { SessionViewStore } from '../../src/remote/state/session-view-store.mjs';
import { makeSession } from '../../src/remote/model/session.mjs';

/** A session id that satisfies the audited grammar. */
export const HARNESS_SESSION = 'session-00000000-0000-0000-0000-000000000001';

/**
 * Build a StatusService over a scripted adapter.
 */
export class SignalServiceHarness {
  /**
   * @param {object} [options] - harness options.
   * @param {() => number} [options.clock] - injectable clock.
   * @param {number} [options.followIdleMs] - follow idle timeout.
   */
  constructor(options = {}) {
    this.clock = options.clock ?? (() => 1_789_800_000_000);

    const self = this;
    /** @type {Function[]} */
    this.controlListeners = [];
    this.controlSubscriptions = 0;
    this.controlUnsubscribed = false;
    /** @type {Map<string, Function>} */
    this.followListeners = new Map();
    /** @type {Map<string, number>} */
    this.followSubscriptions = new Map();
    /** @type {string[]} */
    this.releasedFollows = [];

    this.adapter = {
      async listSessions() { return []; },
      async getSession() { return null; },
      async getMessages() { return { messages: [], raw: {}, throughSeq: 0, hasMore: false }; },
      async sendMessage() { return { accepted: true, requestId: 'r' }; },
      async cancel(sessionId) { return { accepted: true, sessionId }; },
      async close() { self.adapterClosed = true; },

      async subscribeControl(listener) {
        self.controlSubscriptions += 1;
        self.controlListeners.push(listener);
        return {
          unsubscribe: async () => {
            self.controlUnsubscribed = true;
            self.controlListeners = self.controlListeners.filter((entry) => entry !== listener);
          },
        };
      },

      async subscribe(sessionId, listener) {
        self.followSubscriptions.set(sessionId, (self.followSubscriptions.get(sessionId) ?? 0) + 1);
        self.followListeners.set(sessionId, listener);
        return {
          unsubscribe: async () => {
            self.releasedFollows.push(sessionId);
            self.followListeners.delete(sessionId);
          },
        };
      },
    };

    this.store = new SessionViewStore({ clock: this.clock });
    this.store.upsertSession(makeSession({ id: HARNESS_SESSION, updatedAt: 1_789_700_000_000 }));

    this.events = new EventsService({ adapter: this.adapter, store: this.store, clock: this.clock });
    this.status = new StatusService({
      adapter: this.adapter,
      eventsService: this.events,
      clock: this.clock,
      ...(options.followIdleMs === undefined ? {} : { followIdleMs: options.followIdleMs }),
    });
  }

  /**
   * The number of follow streams the adapter believes are live.
   *
   * @returns {number} the count.
   */
  liveFollows() {
    return this.followListeners.size;
  }

  /**
   * Deliver a control frame to every control listener.
   *
   * @param {object} frame - the frame.
   * @returns {void}
   */
  emitControl(frame) {
    for (const listener of this.controlListeners) listener(frame);
  }

  /**
   * Deliver a control baseline.
   *
   * @param {object} value - `{ queues, jobs }`.
   * @returns {void}
   */
  emitBaseline(value) {
    this.emitControl({ kind: 'control:baseline', frame: { type: 'baseline', value } });
  }

  /**
   * Deliver a per-session queue replacement frame.
   *
   * @param {string} sessionId - the session.
   * @param {object[]} items - the queue rows.
   * @returns {void}
   */
  emitQueue(sessionId, items) {
    this.emitControl({ kind: 'control:queue', frame: { type: 'queue', sessionId, items } });
  }

  /**
   * Deliver a per-session jobs replacement frame.
   *
   * @param {string} sessionId - the session.
   * @param {object[]} jobs - the job rows.
   * @returns {void}
   */
  emitJobs(sessionId, jobs) {
    this.emitControl({ kind: 'control:jobs', frame: { type: 'jobs', sessionId, jobs } });
  }

  /**
   * Deliver a control-stream error.
   *
   * @param {object} error - the adapter error shape.
   * @returns {void}
   */
  emitControlError(error) {
    this.emitControl({ kind: 'error', error });
  }

  /**
   * Deliver a durable follow event for a session.
   *
   * @param {string} sessionId - the session.
   * @param {object} event - the wire event.
   * @returns {void}
   */
  emitFollowEvent(sessionId, event) {
    const listener = this.followListeners.get(sessionId);
    if (listener === undefined) throw new Error(`no follow listener for ${sessionId}`);
    listener({ kind: 'event', frame: { type: 'event', event } });
  }

  /**
   * Deliver an assistant streaming frame.
   *
   * @param {string} sessionId - the session.
   * @param {string} kind - `assistant-stream:start|chunk|end`.
   * @param {object} frame - the assistant frame.
   * @returns {void}
   */
  emitAssistant(sessionId, kind, frame) {
    const listener = this.followListeners.get(sessionId);
    if (listener === undefined) throw new Error(`no follow listener for ${sessionId}`);
    listener({ kind, frame: undefined, assistantFrame: frame });
  }
}
