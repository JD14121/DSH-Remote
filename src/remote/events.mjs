/**
 * Events service —Phase R2 §20.
 *
 * ```text
 * adapter.subscribe()  ->  normalized signals  ->  state machine
 *                      ->  Gateway Events      ->  sequence allocator
 * ```
 *
 * R2 scope (§20): **in-memory event generation only**. It does not own a
 * WebSocket server, a disk JSONL log, replay, or a network heartbeat. Those are
 * R4 and R5.
 *
 * It reaches DSH only through the adapter contract, so it names no endpoint and
 * imports nothing from `wire/`.
 */

import { isRecord } from './model/guards.mjs';
import { GATEWAY_EVENT, gatewayEventForDshEvent } from './model/event.mjs';
import { SIGNAL, makeSignal } from './model/signals.mjs';
import { observedNow } from './model/time.mjs';
import { SessionViewStore } from './state/session-view-store.mjs';

/** Terminal turn outcomes mapped to signals, from the audited `TurnEndReasonMap`. */
const TURN_END_SIGNAL = Object.freeze({
  completed: SIGNAL.RUN_COMMITTED,
  aborted: SIGNAL.RUN_ABANDONED,
  error: SIGNAL.TASK_FAILED,
  // `blocked` and `max-tokens` are deliberately ABSENT: the status audit marked
  // them UNRESOLVED, and mapping them would be invention (see r2-status-evidence §7).
  interrupted: SIGNAL.TASK_FAILED,
});

/**
 * Map one DSH durable event onto a normalized domain signal.
 *
 * Returns `null` for an event with no status consequence —which is most of
 * them. Unknown event types produce no signal but are still forwarded as events,
 * so nothing is silently dropped.
 *
 * @param {object} event - a `SessionWireEvent`.
 * @returns {object|null} a `makeSignal` occurrence, or `null`.
 */
export function signalForDshEvent(event) {
  if (!isRecord(event)) return null;
  const evidence = { dshEvent: event.type, dshSeq: event.seq };

  switch (event.type) {
    case 'turn/start':
      return makeSignal({
        signal: SIGNAL.RUN_STARTED,
        sourceSequence: event.seq,
        sourceTime: event.time,
        evidence,
      });
    case 'turn/end': {
      const kind = isRecord(event.data) ? event.data.reason?.kind : undefined;
      const signal = TURN_END_SIGNAL[kind];
      if (signal === undefined) return null;
      return makeSignal({
        signal,
        sourceSequence: event.seq,
        sourceTime: event.time,
        evidence: { ...evidence, turnEndKind: kind, cancelCause: event.data?.reason?.reason ?? null },
      });
    }
    default:
      return null;
  }
}

/**
 * Events service.
 */
export class EventsService {
  /**
   * @param {object} options - service options.
   * @param {object} options.adapter - the R1 `DshAdapter`.
   * @param {SessionViewStore} [options.store] - shared view store.
   * @param {() => number} [options.clock] - injectable clock.
   * @param {number} [options.maxLogEntries] - diagnostic log capacity.
   * @param {number} [options.ringSize] - per-session replay ring capacity (R4 §54).
   */
  constructor(options) {
    if (options?.adapter === undefined) throw new TypeError('EventsService requires an adapter');
    this.adapter = options.adapter;
    this.clock = options.clock ?? Date.now;
    this.store = options.store ?? new SessionViewStore({ clock: this.clock });
    /** @type {object[]} */
    this.eventLog = [];
    this.maxLogEntries = options.maxLogEntries ?? 1000;

    // R4 §21/§54: replay reads a ring that must be *per session*. The diagnostic
    // `eventLog` above is a single global array, so a busy session could evict a
    // quiet session's events from it and a replay would then report a false gap.
    // This per-session ring is additive; nothing existing reads it.
    const ringSize = options.ringSize ?? 1000;
    if (!Number.isSafeInteger(ringSize) || ringSize < 1) {
      throw new TypeError(`ringSize must be a positive safe integer, received ${JSON.stringify(options.ringSize)}`);
    }
    this.ringSize = ringSize;
    /** @type {Map<string, object[]>} */
    this.rings = new Map();
    /** @type {Set<(event: object) => void>} */
    this.listeners = new Set();
    /**
     * The R5 write-ahead sink: called with every event after its sequence is
     * allocated and **before** any ring update or fan-out. `null` means R4
     * behaviour (no durable journal), which the earlier phases' tests rely on.
     *
     * @type {((event: object) => void)|null}
     */
    this.sink = options.sink ?? null;
    if (this.sink !== null && typeof this.sink !== 'function') {
      throw new TypeError('EventsService sink must be a function when provided');
    }
  }

  /**
   * Emit a Gateway event for a session and record it in the in-memory log.
   *
   * @param {object} input - event input.
   * @param {string} input.sessionId - session identity.
   * @param {string} input.event - a `GATEWAY_EVENT` value.
   * @param {unknown} [input.data] - payload.
   * @param {number|string|null} [input.sourceTime] - DSH source time.
   * @param {number|null} [input.sourceSequence] - DSH durable seq, when one exists.
   * @returns {object} the emitted Gateway event.
   */
  emit(input) {
    const event = this.store.emitEvent({ ...input, observedAt: observedNow(this.clock) });

    // R5 §10: write-ahead. The durable append must complete before ANY fan-out, so
    // a client can never receive a sequence the journal does not hold. The sink is
    // synchronous precisely so this ordering cannot be interleaved — there is no
    // await point between "allocated" and "on disk".
    if (this.sink !== null) {
      // A throw here propagates to the caller and NOTHING is published. That is
      // §13's fail-closed rule, not an error-handling gap.
      this.sink(event);
    }

    this.eventLog.push(event);
    if (this.eventLog.length > this.maxLogEntries) this.eventLog.shift();

    const ring = this.#ringFor(event.session_id);
    ring.push(event);
    if (ring.length > this.ringSize) ring.shift();

    // Fan-out to R4 subscribers. A throwing listener must not break emission or
    // its siblings, so each is isolated.
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A subscriber is responsible for its own failures; the domain is not.
      }
    }

    return event;
  }

  /**
   * Replace the write-ahead sink.
   *
   * @param {((event: object) => void)|null} sink - the durable append, or `null` to detach.
   * @returns {void}
   * @throws {TypeError} when the sink is neither a function nor `null`.
   */
  setSink(sink) {
    if (sink !== null && typeof sink !== 'function') {
      throw new TypeError('the write-ahead sink must be a function or null');
    }
    this.sink = sink;
  }

  /**
   * Replace a session's ring contents with a recovered tail (R5 §28).
   *
   * Used at startup to preload the hot cache from the journal. The ring is a cache
   * after R5 — its eviction no longer decides `earliest_available`.
   *
   * @param {string} sessionId - the session.
   * @param {object[]} events - the retained events, oldest first.
   * @returns {number} how many were loaded.
   * @throws {TypeError} when the arguments are unusable.
   */
  loadRing(sessionId, events) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TypeError('loadRing requires a session id');
    }
    if (!Array.isArray(events)) throw new TypeError('loadRing requires an array of events');
    const trimmed = events.slice(-this.ringSize);
    this.rings.set(sessionId, [...trimmed]);
    return trimmed.length;
  }

  /**
   * Register a listener called for every newly emitted Gateway event (R4 §20).
   *
   * Additive: R2/R3 code paths are unchanged and no second event log is created.
   *
   * Named `onEvent` rather than `subscribe` because this class already had a
   * `subscribe(sessionId, options)` method that opens a DSH adapter subscription.
   * A second `subscribe` would be shadowed by the later definition — silently —
   * so the R4 listener seam gets its own unambiguous name.
   *
   * @param {(event: object) => void} listener - the callback.
   * @returns {() => void} an idempotent unsubscribe function.
   * @throws {TypeError} when the listener is not a function.
   */
  onEvent(listener) {
    if (typeof listener !== 'function') throw new TypeError('onEvent requires a listener function');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The per-session ring, created on demand.
   *
   * @param {string} sessionId - session identity.
   * @returns {object[]} the ring array.
   */
  #ringFor(sessionId) {
    let ring = this.rings.get(sessionId);
    if (ring === undefined) {
      ring = [];
      this.rings.set(sessionId, ring);
    }
    return ring;
  }

  /**
   * The retained events for one session, oldest first.
   *
   * @param {string} sessionId - session identity.
   * @returns {object[]} a copy of the ring.
   */
  ringFor(sessionId) {
    return [...(this.rings.get(sessionId) ?? [])];
  }

  /**
   * The lowest and highest Gateway sequence still retained for a session.
   *
   * This is the replay boundary (R4 §23). `null` bounds mean nothing is retained.
   *
   * @param {string} sessionId - session identity.
   * @returns {{earliest: number|null, latest: number|null, count: number}} the bounds.
   */
  sequenceBounds(sessionId) {
    const ring = this.rings.get(sessionId);
    if (ring === undefined || ring.length === 0) {
      // Nothing retained, but the allocator may still know a high-water mark.
      const session = this.store.get(sessionId);
      return { earliest: null, latest: null, count: 0, highWater: session?.last_sequence ?? 0 };
    }
    return {
      earliest: ring[0].sequence,
      latest: ring[ring.length - 1].sequence,
      count: ring.length,
      highWater: this.store.get(sessionId)?.last_sequence ?? ring[ring.length - 1].sequence,
    };
  }

  /**
   * Alias for `sequenceBounds`, matching the R4 spec's naming.
   *
   * @param {string} sessionId - session identity.
   * @returns {{earliest: number|null, latest: number|null, count: number}} the bounds.
   */
  bounds(sessionId) {
    return this.sequenceBounds(sessionId);
  }

  /**
   * Every retained event for a session with `sequence > after`.
   *
   * Strictly ascending by construction, because the ring preserves emission order
   * and Gateway sequences are allocated monotonically per session.
   *
   * @param {string} sessionId - session identity.
   * @param {number} after - the client's last-seen Gateway sequence.
   * @returns {object[]} the retained events after that sequence.
   * @throws {TypeError} when `after` is not a safe integer.
   */
  eventsAfter(sessionId, after) {
    if (!Number.isSafeInteger(after)) {
      throw new TypeError(`eventsAfter requires an integer sequence, received ${JSON.stringify(after)}`);
    }
    return this.ringFor(sessionId).filter((event) => event.sequence > after);
  }

  /**
   * The current diagnostic-log depth for one session.
   *
   * @param {string} sessionId - session identity.
   * @returns {number} the retained count.
   */
  ringDepth(sessionId) {
    return this.rings.get(sessionId)?.length ?? 0;
  }

  /**
   * Apply a normalized signal and emit any Gateway event it implies.
   *
   * @param {string} sessionId - session identity.
   * @param {object|string} signal - a signal name or occurrence.
   * @returns {object[]} the events emitted as a result (possibly empty).
   */
  applySignal(sessionId, signal) {
    const name = typeof signal === 'string' ? signal : signal?.signal;
    const transition = this.store.applySignal(sessionId, signal);
    const emitted = [];

    if (transition.outcome === 'applied') {
      emitted.push(this.emit({
        sessionId,
        event: GATEWAY_EVENT.SESSION_STATUS,
        data: { status: transition.status, previous: transition.previous, signal: name },
        sourceTime: typeof signal === 'object' ? signal?.sourceTime ?? null : null,
      }));
      // A settled run outcome also completes/cancels/fails the task.
      if (name === SIGNAL.RUN_COMMITTED) {
        emitted.push(this.emit({ sessionId, event: GATEWAY_EVENT.TASK_COMPLETED, data: { status: transition.status } }));
      } else if (name === SIGNAL.RUN_ABANDONED) {
        emitted.push(this.emit({ sessionId, event: GATEWAY_EVENT.TASK_CANCELLED, data: { status: transition.status } }));
      } else if (name === SIGNAL.TASK_FAILED) {
        emitted.push(this.emit({ sessionId, event: GATEWAY_EVENT.TASK_FAILED, data: { status: transition.status } }));
      }
    }

    return emitted;
  }

  /**
   * Ingest one adapter subscription frame.
   *
   * Every frame produces zero or more Gateway events; nothing is dropped. An
   * unrecognised frame or event becomes an `unknown` Gateway event that keeps its
   * source sequence (§6.2, §7).
   *
   * @param {string} sessionId - session identity.
   * @param {object} subscriptionFrame - `{ kind, frame, assistantFrame? }` from R1.
   * @returns {object[]} the Gateway events produced.
   * @throws {TypeError} when the frame is unusable.
   */
  ingest(sessionId, subscriptionFrame) {
    if (!isRecord(subscriptionFrame)) throw new TypeError('ingest requires a subscription frame');
    const { kind } = subscriptionFrame;
    const emitted = [];

    if (kind === 'snapshot') {
      const header = subscriptionFrame.frame?.header;
      if (isRecord(header) && typeof header.createdAt === 'number') {
        this.store.applySignal(sessionId, {
          signal: SIGNAL.SESSION_DISCOVERED,
          sessionId,
          evidence: { source: 'follow snapshot header' },
        });
        // Learn created_at and the DSH cursor from the snapshot —both are real
        // DSH facts, neither is invented (§4, §5, §8).
        const session = this.store.get(sessionId);
        if (session !== null) {
          this.store.upsertSession({
            ...session,
            created_at: session.created_at ?? new Date(header.createdAt).toISOString(),
          });
        }
        if (typeof subscriptionFrame.frame?.cursor === 'number') {
          this.store.rememberDshCursor(sessionId, subscriptionFrame.frame.cursor);
        }
      }
      return emitted;
    }

    if (kind === 'event') {
      // The adapter wraps a durable event as `{ type: 'event', event }`. Accept a
      // bare wire event too, so a caller cannot silently lose an event by passing
      // the inner object — which is exactly the failure this guard prevents.
      const wrapped = subscriptionFrame.frame;
      const event = isRecord(wrapped?.event) ? wrapped.event : wrapped;
      if (!isRecord(event)) return emitted;

      const signal = signalForDshEvent(event);
      if (signal !== null) {
        emitted.push(...this.applySignal(sessionId, { ...signal, sessionId }));
      }

      const eventKind = gatewayEventForDshEvent(event.type);
      emitted.push(this.emit({
        sessionId,
        event: eventKind,
        data: {
          dsh_event: event.type,
          payload: isRecord(event.data) ? event.data : null,
        },
        sourceTime: event.time ?? null,
        sourceSequence: typeof event.seq === 'number' ? event.seq : null,
      }));

      if (eventKind === GATEWAY_EVENT.UNKNOWN) {
        // Explicitly re-affirm that an unknown event is a KEPT event.
        emitted[emitted.length - 1].data.kept = true;
      }
      return emitted;
    }

    if (kind === 'assistant-stream:start') {
      emitted.push(this.emit({
        sessionId,
        event: GATEWAY_EVENT.ASSISTANT_START,
        data: {
          attempt_id: subscriptionFrame.assistantFrame?.attemptId ?? null,
          turn: subscriptionFrame.assistantFrame?.turn ?? null,
          step: subscriptionFrame.assistantFrame?.step ?? null,
        },
        sourceTime: subscriptionFrame.assistantFrame?.time ?? null,
      }));
      return emitted;
    }

    if (kind === 'assistant-stream:chunk') {
      emitted.push(this.emit({
        sessionId,
        event: GATEWAY_EVENT.ASSISTANT_DELTA,
        // The chunk is opaque and passed through untouched (R1 §8, R2 §6).
        data: {
          attempt_id: subscriptionFrame.assistantFrame?.attemptId ?? null,
          index: subscriptionFrame.assistantFrame?.index ?? null,
          chunk: subscriptionFrame.assistantFrame?.chunk ?? null,
        },
        sourceTime: subscriptionFrame.assistantFrame?.time ?? null,
      }));
      return emitted;
    }

    if (kind === 'assistant-stream:end') {
      const outcome = subscriptionFrame.assistantFrame?.outcome;
      emitted.push(this.emit({
        sessionId,
        event: GATEWAY_EVENT.ASSISTANT_END,
        data: {
          attempt_id: subscriptionFrame.assistantFrame?.attemptId ?? null,
          index: subscriptionFrame.assistantFrame?.index ?? null,
          outcome: isRecord(outcome) ? outcome : null,
        },
      }));
      return emitted;
    }

    if (kind === 'error') {
      const error = subscriptionFrame.error;
      const isTransport = error?.code === 'DSH_UNAVAILABLE';
      if (isTransport) {
        emitted.push(...this.applySignal(sessionId, {
          signal: SIGNAL.TRANSPORT_LOST,
          sessionId,
          evidence: { source: 'adapter subscription error', code: error.code },
        }));
      } else {
        emitted.push(this.emit({
          sessionId,
          event: GATEWAY_EVENT.UNKNOWN,
          data: { kind: 'adapter_error', code: error?.code ?? null, retryable: error?.retryable ?? null },
        }));
      }
      return emitted;
    }

    // An unrecognised subscription frame kind is kept, not discarded.
    emitted.push(this.emit({
      sessionId,
      event: GATEWAY_EVENT.UNKNOWN,
      data: { kind: 'unknown_subscription_frame', subscription_kind: kind ?? null },
    }));
    return emitted;
  }

  /**
   * Subscribe to a session through the adapter and pump frames into the domain.
   *
   * @param {string} sessionId - session identity.
   * @param {object} [options] - subscription options.
   * @param {AbortSignal} [options.signal] - external cancellation.
   * @param {(events: object[]) => void} [options.onEvents] - called per frame with the events produced.
   * @returns {Promise<{unsubscribe: () => Promise<void>}>} the subscription handle.
   */
  async subscribe(sessionId, options = {}) {
    const handle = await this.adapter.subscribe(
      sessionId,
      (frame) => {
        let events;
        try {
          events = this.ingest(sessionId, frame);
        } catch (error) {
          events = [this.emit({
            sessionId,
            event: GATEWAY_EVENT.UNKNOWN,
            data: { kind: 'ingest_failure', message: error?.message ?? 'ingest failed' },
          })];
        }
        if (events.length > 0 && typeof options.onEvents === 'function') options.onEvents(events);
      },
      { signal: options.signal },
    );
    return { unsubscribe: async () => { await handle.unsubscribe(); } };
  }

  /**
   * Note that the Gateway observed the DSH transport disappear.
   *
   * This is the ONLY source of `disconnected` (§15). A phone-to-Gateway
   * disconnect must never call this.
   *
   * @param {string} sessionId - session identity.
   * @returns {object[]} the events emitted.
   */
  noteTransportLost(sessionId) {
    return this.applySignal(sessionId, {
      signal: SIGNAL.TRANSPORT_LOST,
      sessionId,
      evidence: { source: 'gateway transport observation' },
    });
  }

  /**
   * Note that the Gateway can reach DSH again.
   *
   * @param {string} sessionId - session identity.
   * @returns {object[]} the events emitted.
   */
  noteTransportRestored(sessionId) {
    return this.applySignal(sessionId, {
      signal: SIGNAL.TRANSPORT_RESTORED,
      sessionId,
      evidence: { source: 'gateway transport observation' },
    });
  }

  /**
   * The in-memory event log for one session, oldest first.
   *
   * @param {string} [sessionId] - filter by session, or omit for every session.
   * @returns {object[]} the recorded events.
   */
  log(sessionId) {
    if (sessionId === undefined) return [...this.eventLog];
    return this.eventLog.filter((event) => event.session_id === sessionId);
  }

  /**
   * Verify that a session's Gateway sequences are strictly increasing.
   *
   * @param {string} sessionId - session identity.
   * @returns {{monotonic: boolean, reason: string|null}} the check result.
   */
  verifyMonotonic(sessionId) {
    const events = this.log(sessionId);
    let previous = null;
    for (const event of events) {
      if (previous !== null && event.sequence <= previous) {
        return { monotonic: false, reason: `sequence ${event.sequence} did not exceed ${previous}` };
      }
      previous = event.sequence;
    }
    return { monotonic: true, reason: null };
  }
}
