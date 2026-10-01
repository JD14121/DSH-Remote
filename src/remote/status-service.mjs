/**
 * StatusService — Phase R3 §20, §21, §22.
 *
 * The one place where live DSH telemetry becomes domain state:
 *
 * ```text
 * adapter.subscribeControl()             (1 Host-wide stream)
 *        + adapter.subscribe(sessionId)  (per-session, on demand)
 *        ↓
 * control baseline / queue / jobs + follow events
 *        ↓
 * normalized domain signals              (via EventsService / R2 signals)
 *        ↓
 * SessionStateMachine → SessionViewStore
 * ```
 *
 * Hard boundaries (§2):
 *   - it must not import `src/remote/wire/*`;
 *   - it must not name a DSH endpoint;
 *   - it must not invent a raw mapping beyond `docs/r2-status-evidence.md`.
 *
 * Follow lifecycle (§22): R3 does **not** hold a follow stream for every known
 * session. One Host-wide control stream covers queue/job state for all sessions;
 * a per-session follow is opened only while that session is interesting, is
 * deduplicated to at most one per session, and is released on an idle timeout or
 * on `stop()`. R3 may resubscribe after a transport error, but it must never
 * claim to have recovered events missed while the transport was down — that is
 * R5's durable replay.
 */

import { SIGNAL } from './model/signals.mjs';
import { GATEWAY_EVENT } from './model/event.mjs';
import { SESSION_STATUS } from './model/status.mjs';
import { observedNow } from './model/time.mjs';
import { EventsService } from './events.mjs';

/** Control frame kinds, mirrored from the adapter's `CONTROL_FRAME` (no import). */
const CONTROL_KIND = Object.freeze({
  BASELINE: 'control:baseline',
  QUEUE: 'control:queue',
  JOBS: 'control:jobs',
  PROJECTION: 'control:projection',
  ERROR: 'error',
});

/**
 * Job statuses that mean work is in flight, from the audited `SessionJob` shape.
 * `stopping` still counts as active: the work has not finished.
 */
const ACTIVE_JOB_STATUSES = Object.freeze(new Set(['running', 'stopping']));

/**
 * Map one `SessionJob.status` onto a domain signal (§21).
 *
 * Exactly the five audited transitions. R3 invents nothing here: any status not
 * listed produces no signal, which is the documented behaviour for an
 * unmapped raw value.
 *
 * @param {string} status - a DSH `SessionJob.status`.
 * @returns {string|null} a `SIGNAL` value, or `null` when unmapped.
 */
export function signalForJobStatus(status) {
  switch (status) {
    case 'running':
    case 'stopping':
      return SIGNAL.RUN_STARTED;
    case 'failed':
      return SIGNAL.TASK_FAILED;
    case 'killed':
      return SIGNAL.RUN_ABANDONED;
    case 'completed':
      // A completed *job* is not a completed *run*: `turn/end` decides that.
      // Mapping it to RUN_COMMITTED would fabricate completion evidence.
      return null;
    default:
      return null;
  }
}

/**
 * Whether a queued-item placement counts as pending work.
 *
 * `'context'` is injected context, not work waiting to run.
 *
 * @param {object} item - a `SessionQueuedItem`.
 * @returns {boolean} true when the item is pending work.
 */
export function isPendingQueueItem(item) {
  const placement = item?.placement;
  return placement === 'queued' || placement === 'steering';
}

/**
 * Live status wiring between DSH telemetry and the R2 domain.
 */
export class StatusService {
  /**
   * @param {object} options - service options.
   * @param {object} options.adapter - the `DshAdapter`.
   * @param {EventsService} [options.eventsService] - R2 events service.
   * @param {() => number} [options.clock] - injectable clock.
   * @param {number} [options.followIdleMs] - how long a follow idles before release.
   * @param {boolean} [options.autoFollow] - open follows on demand (default true).
   */
  constructor(options) {
    if (options?.adapter === undefined) throw new TypeError('StatusService requires an adapter');
    this.adapter = options.adapter;
    this.clock = options.clock ?? Date.now;
    this.followIdleMs = options.followIdleMs ?? 5 * 60_000;
    this.autoFollow = options.autoFollow !== false;

    this.events = options.eventsService ?? new EventsService({
      adapter: this.adapter,
      clock: this.clock,
    });
    this.store = this.events.store;

    /** @type {Map<string, {handle: object, lastUsedAt: number}>} */
    this.follows = new Map();
    /** @type {{unsubscribe: () => Promise<void>}|null} */
    this.controlHandle = null;
    /** @type {object|null} */
    this.controlBaseline = null;
    /** @type {Map<string, Set<string>>} job ids currently active per session. */
    this.activeJobs = new Map();
    this.started = false;
    this.stopped = false;
    this.lastControlAt = null;
    this.lastControlError = null;
  }

  /**
   * Start the Host-wide control stream and reconcile known sessions.
   *
   * Idempotent: calling it twice does not open a second control stream.
   *
   * @param {object} [options] - start options.
   * @param {boolean} [options.subscribeControl] - set false to skip the control stream.
   * @returns {Promise<void>} resolves once started.
   */
  async start(options = {}) {
    if (this.started) return;
    this.started = true;

    if (options.subscribeControl !== false && typeof this.adapter.subscribeControl === 'function') {
      this.controlHandle = await this.adapter.subscribeControl((frame) => this.ingestControlFrame(frame));
    }

    // Reconcile whatever the domain already knows, so a session that was running
    // before the Gateway started is followed.
    for (const session of this.store.list()) {
      if (session.status === SESSION_STATUS.RUNNING || session.status === SESSION_STATUS.QUEUED) {
        this.ensureFollow(session.id).catch(() => {});
      }
    }
  }

  /**
   * Stop every subscription and release the adapter.
   *
   * Order per §31: unsubscribes happen here; the caller closes the adapter.
   *
   * @returns {Promise<void>} resolves once every stream is released.
   */
  async stop() {
    this.started = false;
    // A stopped service must not silently reopen a stream; without this flag a
    // request arriving during shutdown would resurrect the control/follow wiring.
    this.stopped = true;
    const handles = [...this.follows.values()];
    this.follows.clear();

    if (this.controlHandle !== null) {
      const handle = this.controlHandle;
      this.controlHandle = null;
      try {
        await handle.unsubscribe();
      } catch {
        // A stream already torn down by a transport failure is not an error.
      }
    }

    for (const entry of handles) {
      try {
        await entry.handle.unsubscribe();
      } catch {
        // Same: releasing an already-dead stream must not fail shutdown.
      }
    }
  }

  /**
   * Ingest one control frame (§21).
   *
   * @param {object} frame - `{ kind, frame }` or `{ kind, error }` from the adapter.
   * @returns {object[]} the Gateway events emitted.
   */
  ingestControlFrame(frame) {
    if (frame === null || typeof frame !== 'object') return [];
    this.lastControlAt = observedNow(this.clock);

    if (frame.kind === CONTROL_KIND.ERROR) {
      this.lastControlError = frame.error?.code ?? 'UNKNOWN';
      return this.#onTransportError(frame.error);
    }

    if (frame.kind === CONTROL_KIND.BASELINE) {
      const baseline = frame.frame?.value;
      if (baseline === null || typeof baseline !== 'object') return [];
      this.controlBaseline = baseline;

      const emitted = [];
      const sessionIds = new Set([
        ...Object.keys(baseline.queues ?? {}),
        ...Object.keys(baseline.jobs ?? {}),
      ]);
      for (const sessionId of sessionIds) {
        // The baseline is a complete picture: apply it as a replacement, not a delta.
        emitted.push(...this.#applyQueueState(sessionId, baseline.queues?.[sessionId] ?? []));
        emitted.push(...this.#applyJobState(sessionId, baseline.jobs?.[sessionId] ?? []));
      }
      return emitted;
    }

    if (frame.kind === CONTROL_KIND.QUEUE) {
      const sessionId = frame.frame?.sessionId;
      if (typeof sessionId !== 'string') return [];
      return this.#applyQueueState(sessionId, frame.frame?.items ?? []);
    }

    if (frame.kind === CONTROL_KIND.JOBS) {
      const sessionId = frame.frame?.sessionId;
      if (typeof sessionId !== 'string') return [];
      return this.#applyJobState(sessionId, frame.frame?.jobs ?? []);
    }

    // A projection frame carries no status information R3 can act on.
    return [];
  }

  /**
   * Apply a session's queue rows.
   *
   * A non-empty pending queue is `queued` evidence. An empty queue with no
   * running job is `QUEUE_EMPTY`, which is the only audited path back to idle.
   *
   * @param {string} sessionId - session identity.
   * @param {readonly object[]} items - queued items.
   * @returns {object[]} emitted events.
   */
  #applyQueueState(sessionId, items) {
    if (!this.store.has(sessionId)) {
      // Control reports sessions the domain may not have listed yet. Create a
      // view so the signal has somewhere to land, but change no status.
      this.#ensureSession(sessionId);
    }

    const pending = Array.isArray(items) ? items.filter(isPendingQueueItem) : [];
    const emitted = [];

    if (pending.length > 0) {
      emitted.push(...this.events.applySignal(sessionId, {
        signal: SIGNAL.PROMPT_ACCEPTED_QUEUE,
        sessionId,
        evidence: { source: 'control queues', pending: pending.length },
      }));
      return emitted;
    }

    const jobs = this.activeJobs.get(sessionId);
    const hasActiveJob = jobs !== undefined && jobs.size > 0;
    if (!hasActiveJob) {
      emitted.push(...this.events.applySignal(sessionId, {
        signal: SIGNAL.QUEUE_EMPTY,
        sessionId,
        evidence: { source: 'control queues', pending: 0 },
      }));
    }
    return emitted;
  }

  /**
   * Apply a session's job rows.
   *
   * @param {string} sessionId - session identity.
   * @param {readonly object[]} jobs - job rows.
   * @returns {object[]} emitted events.
   */
  #applyJobState(sessionId, jobs) {
    if (!this.store.has(sessionId)) this.#ensureSession(sessionId);

    const emitted = [];
    const active = new Set();
    const previouslyActive = this.activeJobs.get(sessionId) ?? new Set();
    let sawActiveJob = false;

    for (const job of Array.isArray(jobs) ? jobs : []) {
      const status = job?.status;
      if (typeof status !== 'string') continue;
      if (ACTIVE_JOB_STATUSES.has(status) && typeof job.id === 'string') {
        active.add(job.id);
        sawActiveJob = true;
      }

      const signal = signalForJobStatus(status);
      if (signal === null) continue;

      // Only emit RUN_STARTED for a job newly active, so a repeated `running`
      // frame does not spam signals on every control tick.
      if (signal === SIGNAL.RUN_STARTED && typeof job.id === 'string' && previouslyActive.has(job.id)) {
        continue;
      }

      emitted.push(...this.events.applySignal(sessionId, {
        signal,
        sessionId,
        evidence: { source: 'control jobs', jobId: job.id ?? null, status },
      }));
    }

    this.activeJobs.set(sessionId, active);

    // The last in-flight job just finished. If the queue is also empty, the
    // audited idle transition applies — but only when a job actually ran down,
    // so a control tick with no jobs at all cannot move a running session to idle.
    if (!sawActiveJob && previouslyActive.size > 0) {
      const queued = this.#pendingQueueCount(sessionId);
      if (queued === 0) {
        emitted.push(...this.events.applySignal(sessionId, {
          signal: SIGNAL.QUEUE_EMPTY,
          sessionId,
          evidence: { source: 'control jobs drained', pending: 0 },
        }));
      }
    }

    return emitted;
  }

  /**
   * The last known pending queue length for a session.
   *
   * @param {string} sessionId - session identity.
   * @returns {number|null} the pending count, or `null` when no baseline was seen.
   */
  #pendingQueueCount(sessionId) {
    const items = this.controlBaseline?.queues?.[sessionId];
    if (!Array.isArray(items)) return null;
    return items.filter(isPendingQueueItem).length;
  }

  /**
   * Ensure a domain view exists for a session the control stream mentioned.
   *
   * @param {string} sessionId - session identity.
   */
  #ensureSession(sessionId) {
    try {
      this.store.upsertSession({
        id: sessionId,
        title: null,
        status: SESSION_STATUS.IDLE,
        created_at: null,
        updated_at: null,
        last_sequence: this.store.get(sessionId)?.last_sequence ?? 0,
        running: false,
      });
      this.store.applySignal(sessionId, {
        signal: SIGNAL.SESSION_DISCOVERED,
        sessionId,
        evidence: { source: 'control stream' },
      });
    } catch {
      // A malformed id from the Host is ignored rather than crashing the pump.
    }
  }

  /**
   * Handle a control-stream transport error.
   *
   * Every known session becomes `disconnected`, because the Gateway has lost its
   * view of DSH (§15). This is a Gateway observation, never a phone disconnect.
   *
   * @param {object} [error] - the adapter error.
   * @returns {object[]} emitted events.
   */
  #onTransportError(error) {
    const emitted = [];
    for (const session of this.store.list()) {
      if (session.status === SESSION_STATUS.DISCONNECTED) continue;
      emitted.push(...this.events.applySignal(session.id, {
        signal: SIGNAL.TRANSPORT_LOST,
        sessionId: session.id,
        evidence: { source: 'control stream error', code: error?.code ?? null },
      }));
    }
    return emitted;
  }

  /**
   * Note that the Gateway has regained DSH.
   *
   * Restores each session to the status it held before the loss. It does **not**
   * restore `waiting_input` (§23): a pending question is live-only, so after a
   * loss the status resumes from the last durable evidence, never from a guess.
   *
   * @returns {object[]} emitted events.
   */
  noteTransportRestored() {
    const emitted = [];
    for (const session of this.store.list()) {
      if (session.status !== SESSION_STATUS.DISCONNECTED) continue;
      emitted.push(...this.events.applySignal(session.id, {
        signal: SIGNAL.TRANSPORT_RESTORED,
        sessionId: session.id,
        evidence: { source: 'gateway transport observation' },
      }));
    }
    return emitted;
  }

  /**
   * Ensure exactly one follow stream exists for a session (§22).
   *
   * Deduplicated: a second call for the same session is a no-op. Marks the
   * session as recently used so the idle sweep keeps it alive.
   *
   * @param {string} sessionId - session identity.
   * @returns {Promise<boolean>} true when a new follow was opened.
   */
  async ensureFollow(sessionId) {
    if (!this.autoFollow) return false;
    if (this.stopped) return false;
    if (typeof this.adapter.subscribe !== 'function') return false;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false;

    const existing = this.follows.get(sessionId);
    if (existing !== undefined) {
      existing.lastUsedAt = this.clock();
      return false;
    }

    // Register a placeholder synchronously so two concurrent callers cannot both
    // open a stream for the same session.
    const entry = { handle: null, lastUsedAt: this.clock() };
    this.follows.set(sessionId, entry);

    try {
      const handle = await this.adapter.subscribe(
        sessionId,
        (frame) => {
          const current = this.follows.get(sessionId);
          if (current !== undefined) current.lastUsedAt = this.clock();
          this.events.ingest(sessionId, frame);
        },
      );
      entry.handle = handle;
      return true;
    } catch {
      this.follows.delete(sessionId);
      return false;
    }
  }

  /**
   * Release a session's follow stream, if any.
   *
   * @param {string} sessionId - session identity.
   * @returns {Promise<boolean>} true when a stream was released.
   */
  async releaseFollow(sessionId) {
    const entry = this.follows.get(sessionId);
    if (entry === undefined) return false;
    this.follows.delete(sessionId);
    try {
      await entry.handle?.unsubscribe?.();
    } catch {
      // Releasing a dead stream is not an error.
    }
    return true;
  }

  /**
   * Release follows that have been idle longer than the timeout.
   *
   * @returns {Promise<string[]>} the session ids released.
   */
  async sweepIdleFollows() {
    const now = this.clock();
    const expired = [];
    for (const [sessionId, entry] of this.follows) {
      if (now - entry.lastUsedAt >= this.followIdleMs) expired.push(sessionId);
    }
    for (const sessionId of expired) await this.releaseFollow(sessionId);
    return expired;
  }

  /**
   * Number of active follow streams, for diagnostics and tests.
   *
   * @returns {number} the count.
   */
  get followCount() {
    return this.follows.size;
  }

  /**
   * Whether a follow exists for a session.
   *
   * @param {string} sessionId - session identity.
   * @returns {boolean} true when a follow is active.
   */
  hasFollow(sessionId) {
    return this.follows.has(sessionId);
  }

  /**
   * Health facts for the `/health` endpoint (§12).
   *
   * Distinguishes "HTTP gateway is up" from "DSH is reachable and authenticated":
   * a boolean cannot express both, so they are reported separately.
   *
   * @param {object} [options] - health options.
   * @param {string} [options.dshVersion] - observed DSH version.
   * @param {string|null} [options.downstreamStatus] - `ready`|`degraded`|`unavailable`.
   * @param {string|null} [options.reasonCode] - an adapter code, e.g. `AUTH_UNAVAILABLE`.
   * @returns {{gateway: string, ready: boolean, dsh: object}} health facts.
   */
  healthFacts(options = {}) {
    const downstream = options.downstreamStatus ?? this.#deriveDownstreamStatus();
    return {
      gateway: 'ready',
      ready: downstream === 'ready',
      dsh: {
        status: downstream,
        version: options.dshVersion ?? null,
        ...(options.reasonCode === undefined || options.reasonCode === null
          ? {}
          : { reason_code: options.reasonCode }),
      },
    };
  }

  /**
   * Derive a downstream status from observed telemetry.
   *
   * @returns {string} `ready`, `degraded` or `unavailable`.
   */
  #deriveDownstreamStatus() {
    if (this.lastControlError !== null) return 'degraded';
    if (this.controlBaseline !== null) return 'ready';
    return 'unavailable';
  }

  /**
   * The current session views, for a REST layer.
   *
   * @returns {object[]} the views.
   */
  listSessions() {
    return this.store.list();
  }

  /**
   * One session view.
   *
   * @param {string} sessionId - session identity.
   * @returns {object|null} the view, or `null`.
   */
  getSession(sessionId) {
    return this.store.get(sessionId);
  }
}
