/**
 * Sessions service —Phase R2 §18.
 *
 * Responsibilities (§18):
 *   - initialise session views from `DshAdapter.listSessions()`
 *   - fetch a single session
 *   - convert an adapter summary into a domain session
 *   - maintain status through the state machine
 *
 * Hard constraints (§18, §21):
 *   - it must not know any DSH endpoint name;
 *   - it must not call `rpcClient`;
 *   - it must not import anything from `wire/`.
 *
 * The only DSH-adjacent thing it touches is the **adapter interface**, which is
 * exactly the boundary R1 built.
 */

import { isRecord } from './model/guards.mjs';
import { GATEWAY_EVENT } from './model/event.mjs';
import { MESSAGE_TYPE } from './model/message.mjs';
import { SIGNAL } from './model/signals.mjs';
import { observedNow } from './model/time.mjs';
import { makeSession, sessionFromAdapterSummary, toMobileSession } from './model/session.mjs';
import { SessionViewStore } from './state/session-view-store.mjs';

/**
 * Sessions service.
 */
export class SessionsService {
  /**
   * @param {object} options - service options.
   * @param {object} options.adapter - the R1 `DshAdapter` (or anything with the same contract).
   * @param {SessionViewStore} [options.store] - shared view store.
   * @param {() => number} [options.clock] - injectable clock.
   */
  constructor(options) {
    if (options?.adapter === undefined) throw new TypeError('SessionsService requires an adapter');
    this.adapter = options.adapter;
    this.clock = options.clock ?? Date.now;
    this.store = options.store ?? new SessionViewStore({ clock: this.clock });
    /**
     * The in-flight adapter enumeration, if any.
     *
     * Used by {@link SessionsService.listFresh} so concurrent identical list requests share one
     * enumeration instead of stampeding the adapter.
     *
     * @type {Promise<object[]>|null}
     */
    this.refreshInFlight = null;
  }

  /**
   * Initialise session views from the adapter's session list.
   *
   * Sessions are created in `idle`, then the adapter's own `running` flag is
   * applied through the state machine where it is meaningful, so status always
   * has an evidenced origin rather than being copied from a boolean.
   *
   * @param {object} [options] - list options.
   * @param {boolean} [options.emitEvents] - emit `session.status`/`message.created` events.
   * @returns {Promise<object[]>} the domain session views.
   */
  async refresh(options = {}) {
    const [allSummaries, archivedIds] = await Promise.all([
      this.adapter.listSessions(),
      typeof this.adapter.listArchivedSessionIds === 'function'
        ? this.adapter.listArchivedSessionIds()
        : [],
    ]);
    const archived = new Set(archivedIds);
    const summaries = allSummaries.filter((summary) => !isRecord(summary) || !archived.has(summary.id));
    if (!Array.isArray(summaries)) {
      throw new TypeError('the adapter returned a non-array session list');
    }

    const observedAt = observedNow(this.clock);
    const views = [];

    for (const summary of summaries) {
      if (!isRecord(summary) || typeof summary.id !== 'string') continue;

      const isNew = !this.store.has(summary.id);
      const session = sessionFromAdapterSummary(summary, {
        // DSH owns this title (through its title projection or explicit rename).
        // Carry it across the domain conversion so a fresh inventory pass does
        // not turn a titled row back into the generic "Untitled session" label.
        title: typeof summary.title === 'string' && summary.title.trim().length > 0
          ? summary.title
          : null,
        observedAt,
        lastSequence: this.store.get(summary.id)?.last_sequence ?? 0,
      });
      this.store.upsertSession(session);

      if (isNew) {
        this.store.applySignal(summary.id, {
          signal: SIGNAL.SESSION_DISCOVERED,
          sessionId: summary.id,
          evidence: { source: 'adapter.listSessions' },
        });
        if (options.emitEvents === true) {
          this.store.emitEvent({
            sessionId: summary.id,
            event: GATEWAY_EVENT.SESSION_STATUS,
            data: { status: this.store.get(summary.id)?.status ?? 'idle', reason: 'discovered' },
            sourceTime: summary.updated_at ?? null,
          });
        }
      }

      // The adapter's live flag is real evidence: a running Agent means running.
      if (summary.running === true && this.store.get(summary.id)?.status !== 'running') {
        this.store.applySignal(summary.id, {
          signal: SIGNAL.RUN_STARTED,
          sessionId: summary.id,
          evidence: { source: 'SessionSummary.running' },
        });
      }

      views.push(this.store.get(summary.id));
    }

    return views;
  }

  /**
   * Create a new session through the adapter and track it.
   *
   * ## Phone selection stays inside the DSH preset roster
   *
   * A mobile client may choose an Agent preset from DSH's live roster, and may
   * select an opaque workspace key already present in DSH's live inventory. The
   * adapter resolves that key to DSH-reported workspace data; the phone cannot
   * nominate a path or session id.
   *
   * The created session is upserted into the shared store immediately, before any
   * list refresh, so it is addressable (`get`) and appears in the inventory even
   * if DSH's list is briefly eventual. Refresh is additive and never deletes, so
   * this cannot remove anything.
   *
   * @param {object} [options] - optional validated Agent preset, workspace key, and cancellation signal.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @returns {Promise<object>} the created domain session view.
   * @throws {TypeError} when the adapter has no create capability or answers unusably.
   */
  async create(options = {}) {
    if (typeof this.adapter.createSession !== 'function') {
      throw new TypeError('the adapter has no createSession capability');
    }

    const created = await this.adapter.createSession({
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(typeof options.agentPreset === 'string' ? { agentPreset: options.agentPreset } : {}),
      ...(typeof options.workspaceKey === 'string' ? { workspaceKey: options.workspaceKey } : {}),
    });
    if (!isRecord(created) || typeof created.sessionId !== 'string' || created.sessionId.length === 0) {
      throw new TypeError('the adapter returned an unusable created session');
    }

    const observedAt = observedNow(this.clock);
    const existing = this.store.get(created.sessionId);
    const session = sessionFromAdapterSummary(
      {
        id: created.sessionId,
        updated_at: null,
        running: false,
        agent_preset: created.agentPreset ?? undefined,
        ...(typeof created.cwd === 'string' ? { cwd: created.cwd } : {}),
        ...(typeof created.workspaceId === 'string' ? { workspace_id: created.workspaceId } : {}),
        ...(typeof created.workspaceKey === 'string' ? { workspace_key: created.workspaceKey } : {}),
        ...(typeof created.workspaceName === 'string' ? { workspace_name: created.workspaceName } : {}),
      },
      { observedAt, lastSequence: existing?.last_sequence ?? 0 },
    );
    this.store.upsertSession(session);

    if (existing === null || existing === undefined) {
      this.store.applySignal(created.sessionId, {
        signal: SIGNAL.SESSION_DISCOVERED,
        sessionId: created.sessionId,
        evidence: { source: 'adapter.createSession' },
      });
    }

    return this.store.get(created.sessionId);
  }

  /**
   * Fetch one session, refreshing from the adapter when it is unknown.
   *
   * @param {string} sessionId - session identity.
   * @returns {Promise<object|null>} the domain session view, or `null` when absent.
   */
  async get(sessionId) {
    if (this.store.has(sessionId)) return this.store.get(sessionId);
    await this.refresh();
    return this.store.get(sessionId);
  }

  /**
   * Rename a DSH session and update the Gateway's current view with DSH's
   * accepted, normalized title.
   *
   * @param {string} sessionId - session identity.
   * @param {string} title - proposed title.
   * @returns {Promise<object>} updated session view.
   */
  async rename(sessionId, title) {
    if (typeof this.adapter.renameSession !== 'function') {
      throw new TypeError('the adapter has no renameSession capability');
    }
    const previous = await this.get(sessionId);
    if (previous === null || previous === undefined) return null;
    const accepted = await this.adapter.renameSession(sessionId, title);
    const session = makeSession({
      id: sessionId,
      title: accepted.title,
      status: previous.status,
      createdAt: previous.created_at,
      updatedAt: previous.updated_at,
      workspaceId: previous.workspace_id ?? null,
      cwd: previous.cwd ?? null,
      lastSequence: Math.max(previous.last_sequence, accepted.seq),
      running: previous.running,
    });
    this.store.upsertSession(session);
    return this.store.get(sessionId);
  }

  /** Archive a DSH session and remove its view from the current Gateway inventory. */
  async archive(sessionId) {
    if (typeof this.adapter.archiveSession !== 'function') {
      throw new TypeError('the adapter has no archiveSession capability');
    }
    const previous = await this.get(sessionId);
    if (previous === null || previous === undefined) return false;
    await this.adapter.archiveSession(sessionId);
    this.store.delete(sessionId);
    return true;
  }

  /**
   * List the currently known session views.
   *
   * This is a **read of the store** and performs no adapter call. It is the right method for
   * callers that have already refreshed, or that deliberately want the tracked view.
   *
   * `GET /api/v1/sessions` does NOT use this — it uses {@link SessionsService.listFresh},
   * because that route's frozen meaning is "the current DSH session inventory", not "what this
   * Gateway happens to have tracked".
   *
   * @returns {object[]} the views.
   */
  list() {
    return this.store.list();
  }

  /**
   * Enumerate the DSH session inventory and return it as Gateway session views.
   *
   * ## Why this exists
   *
   * `GET /api/v1/sessions` is defined to return the session inventory **DSH** exposes, through
   * the Gateway. A plain {@link SessionsService.list} reports only sessions already tracked by
   * this process — those touched by a control stream, hydrated individually, or recovered from
   * a journal — which is a different set. The production observation that produced the R8C
   * finding was exactly that difference: `adapter.listSessions()` returned 37 while the route
   * reported 0, both with HTTP 200.
   *
   * ## Failure semantics (deliberate)
   *
   * If the adapter cannot be reached, this **propagates** the failure. It does **not** fall
   * back to the tracked set, because returning stale tracked sessions with `200` would present
   * them as the complete DSH inventory — the same semantic defect in a subtler form. The HTTP
   * layer maps the throw onto the standard Gateway error vocabulary.
   *
   * ## Additive, not destructive
   *
   * Refresh **never deletes**. Absence from `adapter.listSessions()` is not proven to mean
   * "deleted": the adapter contract does not distinguish deleted from archived, filtered or
   * temporarily unavailable. Removal would therefore be a guess, and a guess here would destroy
   * a tracked session's durable metadata. Existing Gateway-owned fields are preserved by the
   * store's enrich-never-erase merge; only DSH-authoritative fields are updated.
   *
   * ## Single-flight
   *
   * Concurrent identical calls share one adapter enumeration. A browser load issues one list
   * request; if several arrive together they must not each fan out to the adapter.
   *
   * @param {object} [options] - `emitEvents`, `force`.
   * @returns {Promise<object[]>} the refreshed views in DSH inventory order.
   */
  async listFresh(options = {}) {
    // A refresh already in flight is joined rather than duplicated.
    if (this.refreshInFlight !== null && options.force !== true) {
      return this.refreshInFlight;
    }

    // The marker and the adapter call must be established in ONE synchronous step, before this
    // function yields. Calling `refresh()` first and assigning the marker afterwards left a
    // window in which concurrent requests all observed `null` and each enumerated the adapter —
    // three requests produced three adapter calls. The Promise executor runs synchronously, so
    // doing both inside it closes that window.
    this.refreshInFlight = new Promise((resolve, reject) => {
      // Runs synchronously up to its first await, so the enumeration starts here.
      this.refresh(options).then(resolve, reject);
    });
    const gate = this.refreshInFlight;
    gate.then(
      () => { if (this.refreshInFlight === gate) this.refreshInFlight = null; },
      () => { if (this.refreshInFlight === gate) this.refreshInFlight = null; },
    );

    return gate;
  }

  /**
   * The mobile-safe projection of one session, with `metadata` removed.
   *
   * @param {string} sessionId - session identity.
   * @returns {object|null} the projection, or `null`.
   */
  getMobileView(sessionId) {
    const session = this.store.get(sessionId);
    if (session === null) return null;
    const { metadata, active_run, dsh_cursor, observed_at, ...mobile } = session;
    return mobile;
  }

  /**
   * Enrich one session with `created_at` from a real DSH source.
   *
   * Source: `SessionWireHeader.createdAt`, which arrives in a `follow` opening
   * snapshot (audited in `docs/r2-status-evidence.md` §4). The subscription is
   * released as soon as the snapshot arrives, so this costs one short-lived
   * logical stream and reads no history.
   *
   * @param {string} sessionId - session identity.
   * @param {object} [options] - hydrate options.
   * @param {number} [options.timeoutMs] - how long to wait for the snapshot.
   * @returns {Promise<{hydrated: boolean, createdAt: string|null, reason: string|null}>} outcome.
   */
  async hydrateCreatedAt(sessionId, options = {}) {
    const session = this.store.get(sessionId);
    if (session === null) return { hydrated: false, createdAt: null, reason: 'unknown session' };
    if (session.created_at !== null) {
      return { hydrated: false, createdAt: session.created_at, reason: 'already known' };
    }
    if (typeof this.adapter.subscribe !== 'function') {
      return { hydrated: false, createdAt: null, reason: 'adapter has no subscribe capability' };
    }

    const timeoutMs = options.timeoutMs ?? 4000;
    const controller = new AbortController();
    let timer = null;

    try {
      const result = await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        timer = setTimeout(() => finish({ hydrated: false, reason: 'timed out waiting for a snapshot' }), timeoutMs);

        this.adapter
          .subscribe(
            sessionId,
            (frame) => {
              if (frame?.kind !== 'snapshot') return;
              const createdAt = frame.frame?.header?.createdAt;
              if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
                finish({ hydrated: false, reason: 'snapshot carried no usable createdAt' });
                return;
              }
              finish({ hydrated: true, createdAt });
            },
            { signal: controller.signal, maxMessages: 1 },
          )
          .then((handle) => {
            // Release as soon as the caller aborts; `unsubscribe` is idempotent.
            controller.signal.addEventListener('abort', () => {
              Promise.resolve(handle?.unsubscribe?.()).catch(() => {});
            }, { once: true });
          })
          .catch((error) => finish({ hydrated: false, reason: `subscribe failed: ${error?.code ?? 'error'}` }));
      });

      if (timer !== null) clearTimeout(timer);
      controller.abort();

      if (result.hydrated !== true) {
        return { hydrated: false, createdAt: null, reason: result.reason ?? 'not hydrated' };
      }

      const previous = this.store.get(sessionId);
      this.store.upsertSession(makeSession({
        id: sessionId,
        title: previous.title,
        status: previous.status,
        createdAt: result.createdAt,
        updatedAt: previous.updated_at,
        workspaceId: previous.workspace_id ?? null,
        cwd: previous.cwd ?? null,
        lastSequence: previous.last_sequence,
        running: previous.running,
      }));
      return { hydrated: true, createdAt: this.store.get(sessionId).created_at, reason: null };
    } catch (error) {
      if (timer !== null) clearTimeout(timer);
      controller.abort();
      return { hydrated: false, createdAt: null, reason: `hydrate failed: ${error?.message ?? 'error'}` };
    }
  }

  /**
   * Read a session's title from a real DSH source.
   *
   * Source: the folded `session/title` durable event (audited in
   * `docs/r2-status-evidence.md` §4). The title is taken only from events that
   * appear in the page the caller asked for —R2 does not scan history
   * opportunistically, and never infers a title from the first prompt (§5).
   *
   * @param {string} sessionId - session identity.
   * @param {object} [options] - title options.
   * @param {number} [options.throughSeq] - page cursor.
   * @param {number} [options.maxMessages] - page size.
   * @returns {Promise<{title: string|null, found: boolean, reason: string|null}>} outcome.
   */
  async readTitle(sessionId, options = {}) {
    if (typeof this.adapter.getMessages !== 'function') {
      return { title: null, found: false, reason: 'adapter has no getMessages capability' };
    }
    let page;
    try {
      page = await this.adapter.getMessages(sessionId, {
        ...(options.throughSeq === undefined ? {} : { throughSeq: options.throughSeq }),
        maxMessages: options.maxMessages ?? 200,
      });
    } catch (error) {
      return { title: null, found: false, reason: `history read failed: ${error?.code ?? 'error'}` };
    }

    const messages = Array.isArray(page?.messages) ? page.messages : [];
    let latest = null;
    for (const message of messages) {
      if (message?.type !== MESSAGE_TYPE.MESSAGE) continue;
      const eventType = message?.content?.eventType;
      // `toDomainMessage` keeps the raw event type only on unknown events, so a
      // title is recognised by its own shape: a folded { title, source } payload.
      if (isRecord(message.content) && typeof message.content.title === 'string') latest = message;
      else if (eventType === 'session/title' && typeof message.content?.data?.title === 'string') latest = message;
    }

    const title = typeof latest?.content?.title === 'string' && latest.content.title.length > 0
      ? latest.content.title
      : null;

    if (title === null) return { title: null, found: false, reason: 'no session/title event in this page' };

    const previous = this.store.get(sessionId);
    if (previous !== null) {
      this.store.upsertSession(makeSession({
        id: sessionId,
        title,
        status: previous.status,
        createdAt: previous.created_at,
        updatedAt: previous.updated_at,
        workspaceId: previous.workspace_id ?? null,
        cwd: previous.cwd ?? null,
        lastSequence: previous.last_sequence,
        running: previous.running,
      }));
    }
    return { title, found: true, reason: null };
  }

  /**
   * Export the store snapshot (in memory only).
   *
   * @returns {object} the snapshot.
   */
  snapshot() {
    return this.store.snapshot();
  }
}

export { toMobileSession };
