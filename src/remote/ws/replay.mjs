/**
 * In-memory `last_sequence` replay 鈥?Phase R4 搂21-搂26, 搂36.
 *
 * The replay source is **only** the in-process Gateway event ring (搂21). This
 * module never reads zstd, never reads a disk journal, never fabricates a Gateway
 * event from DSH durable history, and never regenerates an old sequence.
 *
 * With `earliest` / `latest` the retained bounds and `requested` the client's
 * watermark, 搂23 defines exactly four cases. This function decides which one
 * applies; it does not send anything.
 */

import { REPLAY_MODE, RESYNC_REASON, RESYNC_ACTION } from './protocol.mjs';

/** What the replay decision resolved to. */
export const REPLAY_OUTCOME = Object.freeze({
  /** Already current: go straight to LIVE. */
  LIVE: 'live',
  /** Send every retained event after the watermark, then go LIVE. */
  REPLAY: 'replay',
  /** The gap is gone, or the watermark is from a previous process. */
  RESYNC: 'resync',
});

/**
 * Decide how to treat a client's `last_sequence`.
 *
 * @param {object} input - decision input.
 * @param {number|null} input.requested - the client's `last_sequence`, or `null`.
 * @param {number|null} input.earliest - the oldest retained Gateway sequence, or `null`.
 * @param {number|null} input.latest - the newest retained Gateway sequence, or `null`.
 * @param {number} [input.highWater] - the allocator's mark, when nothing is retained.
 * @returns {{outcome: string, mode: string, reason: string|null, action: string|null, from: number|null, through: number|null}}
 *   the decision.
 */
export function decideReplay(input) {
  const { requested } = input;
  const earliest = input.earliest ?? null;
  const latest = input.latest ?? null;
  const highWater = Number.isSafeInteger(input.highWater) ? input.highWater : 0;

  // No watermark: live only. 搂14's `live_only` mode.
  if (requested === null || requested === undefined) {
    return {
      outcome: REPLAY_OUTCOME.LIVE,
      mode: REPLAY_MODE.LIVE_ONLY,
      reason: null,
      action: null,
      from: null,
      through: null,
    };
  }

  // Nothing at all is retained for this session.
  if (earliest === null || latest === null) {
    if (requested === 0) {
      // A brand-new client that has seen nothing is not "behind"; there is simply
      // no history in this process yet.
      return {
        outcome: REPLAY_OUTCOME.LIVE,
        mode: REPLAY_MODE.LIVE_ONLY,
        reason: null,
        action: null,
        from: null,
        through: null,
      };
    }
    // 搂36: a watermark *above* the process high-water mark means the Gateway
    // restarted, or the client belongs to an older process. 搂49 requires an
    // explicit resync, never a silent "no events".
    if (requested > highWater) {
      return {
        outcome: REPLAY_OUTCOME.RESYNC,
        mode: REPLAY_MODE.RESYNC,
        reason: RESYNC_REASON.SEQUENCE_AHEAD_OF_SERVER,
        action: RESYNC_ACTION,
        from: null,
        through: null,
      };
    }
    // The watermark equals the high-water mark but the events themselves have been
    // evicted from the ring, so they cannot be re-sent. The client is not *ahead*
    // of the server, but the gap is genuinely unavailable 鈥?and reporting "no
    // events to replay" would be indistinguishable from being up to date.
    return {
      outcome: REPLAY_OUTCOME.RESYNC,
      mode: REPLAY_MODE.RESYNC,
      reason: RESYNC_REASON.GAP_NOT_AVAILABLE,
      action: RESYNC_ACTION,
      from: null,
      through: null,
    };
  }

  // Case D: the watermark is ahead of what this process has ever produced.
  if (requested > latest) {
    return {
      outcome: REPLAY_OUTCOME.RESYNC,
      mode: REPLAY_MODE.RESYNC,
      reason: RESYNC_REASON.SEQUENCE_AHEAD_OF_SERVER,
      action: RESYNC_ACTION,
      from: null,
      through: null,
    };
  }

  // Case A: already current.
  if (requested === latest) {
    return {
      outcome: REPLAY_OUTCOME.LIVE,
      mode: REPLAY_MODE.LIVE_ONLY,
      reason: null,
      action: null,
      from: null,
      through: null,
    };
  }

  // Case B: the whole gap is still retained. Note `requested === earliest - 1`
  // is replayable: the client holds everything up to just before the oldest
  // retained event, so the gap is exactly the ring.
  if (requested >= earliest - 1) {
    return {
      outcome: REPLAY_OUTCOME.REPLAY,
      mode: REPLAY_MODE.REPLAY,
      reason: null,
      action: null,
      from: requested + 1,
      through: latest,
    };
  }

  // Case C: the gap has been evicted from the ring.
  return {
    outcome: REPLAY_OUTCOME.RESYNC,
    mode: REPLAY_MODE.RESYNC,
    reason: RESYNC_REASON.GAP_NOT_AVAILABLE,
    action: RESYNC_ACTION,
    from: null,
    through: null,
  };
}

/**
 * Capture the replay boundary and arm the live queue 鈥?搂26.
 *
 * The order is the whole point:
 *
 * ```text
 * register the live listener first
 *   鈫? * read the boundary
 * ```
 *
 * If it were the other way round, an event emitted between reading `latest` and
 * registering the listener would be lost forever. Here, any event delivered while
 * `replaying` is true is captured in `pending` and flushed afterwards; the
 * boundary read is only used to know which already-retained events to send.
 *
 * @param {object} input - capture input.
 * @param {object} input.events - the `EventsService`.
 * @param {string} input.sessionId - the subscribed session.
 * @param {number|null} input.requested - the client's watermark.
 * @returns {{handle: object, decision: object}} the live handoff handle and decision.
 */
export async function beginReplay(input) {
  const { events, sessionId, requested } = input;
  const store = input.store ?? null;

  /** @type {object[]} */
  const pending = [];
  let replaying = true;
  let boundary = null;

  // 1. Register first.
  const off = events.onEvent((event) => {
    if (event.session_id !== sessionId) return;
    if (!replaying) return; // the handoff is done; the pump is live
    pending.push(event);
  });

  // 2. Then read the boundary 鈥?from the durable source when one is supplied.
  //
  // Phase R5: with a durable source this is asynchronous. The `await` sits between
  // the listener registration above and this read, which is exactly why the
  // listener is registered first: an event emitted during the await is captured
  // rather than missed. The WS layer never learns whether the source is RAM or disk.
  const bounds = store !== null
    ? await store.bounds(sessionId)
    : events.sequenceBounds(sessionId);

  const decision = decideReplay({
    requested: requested ?? null,
    earliest: bounds.earliest,
    latest: bounds.latest,
    highWater: bounds.highWater,
  });

  let historical = [];
  if (decision.outcome === REPLAY_OUTCOME.REPLAY) {
    // Every retained event after the watermark, strictly ascending. The boundary
    // was captured *before* this read, so anything above it is a live event the
    // listener already holds. Filtering keeps the two phases disjoint, and
    // therefore exactly-once.
    boundary = bounds.latest;
    const all = store !== null
      ? await store.eventsAfter(sessionId, requested)
      : events.eventsAfter(sessionId, requested);
    historical = all.filter((event) => boundary === null || event.sequence <= boundary);
  }

  return {
    decision,
    boundary,
    historical,
    handle: {
      /** The events that arrived during replay, waiting to be flushed. */
      get pending() {
        return pending;
      },
      /** The captured boundary. */
      get boundary() {
        return boundary;
      },
      /**
       * Finish the handoff: everything captured while replaying becomes live,
       * and any event whose sequence is at or below the boundary is discarded
       * because it was already sent as history.
       *
       * @returns {object[]} the events to send now, strictly ascending.
       */
      flush() {
        replaying = false;
        const toSend = pending
          .filter((event) => boundary === null || event.sequence > boundary)
          .sort((left, right) => left.sequence - right.sequence);
        pending.length = 0;
        return toSend;
      },
      /** Detach the live listener. */
      stop() {
        replaying = false;
        off();
      },
      /** Whether the handoff has completed. */
      get live() {
        return !replaying;
      },
    },
  };
}

/**
 * Assert that a sequence of events is gap-free and strictly ascending.
 *
 * Used by tests and by the integration path to prove 搂22's guarantee rather than
 * merely claim it.
 *
 * @param {readonly object[]} events - the events in delivery order.
 * @returns {{ok: boolean, reason: string|null}} the check result.
 */
export function verifyStrictOrder(events) {
  let previous = null;
  for (const event of events) {
    const sequence = event?.sequence;
    if (!Number.isSafeInteger(sequence)) return { ok: false, reason: 'an event has no integer sequence' };
    if (previous !== null) {
      if (sequence === previous) return { ok: false, reason: `duplicate sequence ${sequence}` };
      if (sequence < previous) return { ok: false, reason: `sequence ${sequence} went backwards after ${previous}` };
      if (sequence !== previous + 1) return { ok: false, reason: `gap: ${previous} -> ${sequence}` };
    }
    previous = sequence;
  }
  return { ok: true, reason: null };
}
