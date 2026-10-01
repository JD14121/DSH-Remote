/**
 * Real REST mode: the controller that turns ApiClient results into UI state.
 *
 * ## Two modes, never mixed
 *
 * `fixture` mode never touches the network (R8C §23). `real` mode boots against the Gateway
 * and, once bootstrapped, shows **only** server data — no fixtures leak in after a successful
 * bootstrap.
 *
 * ## What R8C's connection states can and cannot do
 *
 * Implemented for real: `auth_required`, `connecting`, `connected`, `gateway_unavailable`.
 * `reconnecting` and `resync_required` remain in the state model but are **placeholders**
 * until R8D's socket exists — REST has no way to detect a dropped live link.
 *
 * ## Snapshot, not a stream
 *
 * REST returns the *current* status. Without a socket, `running`/`queued`/`waiting_input` may
 * be visible at load time but will not advance. R8C does not fake that: it never invents
 * assistant streaming.
 */

import { ApiError, ERROR_KIND, connectionStateForError, errorFromThrow } from './errors.js';
import { createRequestId, MAX_UPLOAD_BYTES } from './api-client.js';
import { CredentialStore } from './credential-store.js';
import { RecoveryController } from '../recovery/recovery-controller.js';
// R1.5.1: per-session draft ownership lives in the state module so both modes share one contract.
import { selectSessionState, clearDraftFor } from '../state/ui-state.js';

const PROMPT_ECHO_STORAGE_KEY = 'dsh.remote.promptEchoes.v1';
const MAX_PERSISTED_PROMPT_ECHOES = 1000;
const MAX_PROMPT_ECHO_STORAGE_CHARS = 1_500_000;

function defaultPromptEchoStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function readPromptEchoes(storage) {
  const echoes = new Map();
  try {
    const raw = storage?.getItem(PROMPT_ECHO_STORAGE_KEY);
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PROMPT_ECHO_STORAGE_CHARS) return echoes;
    const saved = JSON.parse(raw);
    if (saved?.version !== 1 || saved.sessions === null || typeof saved.sessions !== 'object') return echoes;
    let total = 0;
    for (const [sessionId, items] of Object.entries(saved.sessions)) {
      if (typeof sessionId !== 'string' || !Array.isArray(items)) continue;
      const valid = items.filter((item) => item !== null
        && typeof item === 'object'
        && item.session_id === sessionId
        && item.role === 'user'
        && item.type === 'message'
        && typeof item.id === 'string'
        && typeof item.content === 'string'
        && typeof item.created_at === 'string');
      const remaining = Math.max(0, MAX_PERSISTED_PROMPT_ECHOES - total);
      const recent = remaining > 0 ? valid.slice(-remaining) : [];
      if (recent.length > 0) echoes.set(sessionId, recent);
      total += recent.length;
      if (total >= MAX_PERSISTED_PROMPT_ECHOES) break;
    }
  } catch { /* Storage may be blocked or contain stale/corrupt data. */ }
  return echoes;
}

function persistPromptEchoes(storage, echoes) {
  if (storage === null || typeof storage?.setItem !== 'function') return;
  try {
    const all = [...echoes.values()].flat().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    let recent = all.slice(-MAX_PERSISTED_PROMPT_ECHOES);
    let payload;
    do {
      const sessions = {};
      for (const message of recent) {
        (sessions[message.session_id] ??= []).push(message);
      }
      payload = JSON.stringify({ version: 1, sessions });
      if (payload.length <= MAX_PROMPT_ECHO_STORAGE_CHARS || recent.length === 0) break;
      recent = recent.slice(1);
    } while (true);
    storage.setItem(PROMPT_ECHO_STORAGE_KEY, payload);
  } catch { /* The live transcript remains usable if persistent storage is full/unavailable. */ }
}

function mergePromptEchoes(serverMessages, echoes) {
  // A DSH prompt's source.rpcId is the submitted requestId. Match identities,
  // never text: sending the same words twice must still produce two bubbles.
  const byRequest = new Map(), byId = new Map(), bySequence = new Map();
  for (const echo of echoes) {
    const requestId = echo.requestId ?? echo.id.split(':client:')[1];
    if (requestId) byRequest.set(requestId, echo);
    if (echo.serverMessageId) byId.set(echo.serverMessageId, echo);
    if (Number.isSafeInteger(echo.sourceSequence)) bySequence.set(echo.sourceSequence, echo);
    byId.set(echo.id, echo);
  }
  const match = message => message.role === 'user'
    ? byId.get(message.id) ?? byRequest.get(message.requestId) ?? bySequence.get(message.sourceSequence)
    : null;
  const candidates = mergeMessages(serverMessages, []), chosen = new Map(), matched = new Set();
  for (const message of candidates) {
    const echo = match(message);
    if (!echo) continue;
    const prior = chosen.get(echo.id);
    if (!prior || (prior.optimistic && !message.optimistic)) chosen.set(echo.id, message);
  }
  const reconciled = candidates.flatMap(candidate => {
    const echo = match(candidate);
    if (!echo) return [candidate];
    if (matched.has(echo.id)) return [];
    matched.add(echo.id);
    const message = chosen.get(echo.id);
    if (!message.optimistic) {
      echo.serverMessageId = message.id;
      if (Number.isSafeInteger(message.sourceSequence)) echo.sourceSequence = message.sourceSequence;
      if (Number.isSafeInteger(message.turn)) echo.turn = message.turn;
      if (message.createdAt) echo.serverCreatedAt = message.createdAt;
    }
    // REST can have the same durable user record with no text. Keep the accepted
    // text as presentation fallback without inventing an assistant response.
    return [message.content ? message : { ...message, content: echo.content }];
  });
  const remaining = echoes.filter(echo => !matched.has(echo.id)).map(echo => ({
    ...echo, sessionId: echo.session_id,
    ...(echo.serverMessageId ? { id: echo.serverMessageId, created_at: echo.serverCreatedAt ?? echo.created_at } : {}),
  }));
  return mergeMessages(reconciled, remaining)
    .map((message, index) => ({ message, index, time: Date.parse(message?.created_at ?? message?.createdAt ?? '') }))
    .sort((left, right) => Number.isFinite(left.time) && Number.isFinite(right.time)
      ? left.time - right.time || left.index - right.index
      : left.index - right.index)
    .map(({ message }) => message);
}

/**
 * The controller state, in the UI's vocabulary.
 *
 * @param {object} [overrides] - initial fields.
 * @returns {object} the state.
 */
export function createRealState(overrides = {}) {
  return {
    mode: 'real',
    connection: 'connecting',
    credentialDialogOpen: false,
    credentialState: 'entry',
    settingsOpen: false,
    sessions: [],
    sessionListStatus: 'idle', // idle | loading | loaded | empty | error
    activeSessionId: null,
    messages: [],
    messageListStatus: 'idle',
    /**
     * Older-history paging for the selected session.
     *
     * `hasOlderMessages` is the server's `has_more`; `nextBeforeSequence` is the
     * DSH durable `next_before_seq` to pass back as `before_seq`. Both come from
     * the server and are never synthesised. `olderMessagesStatus` is a UI-local
     * substate only: `idle | loading | error | exhausted`.
     */
    hasOlderMessages: false,
    nextBeforeSequence: null,
    olderMessagesStatus: 'idle',
    domain: 'idle',
    draft: '',
    /*
     * R1.5.1: per-session unsent drafts, client memory only.
     *
     * `draft` stays the live composer value; this map is the per-session store behind it, so
     * switching sessions shows that session's own text and a successful send clears only the
     * sending session's entry. Never persisted to storage, the backend or the URL.
     */
    draftsBySessionId: {},
    attachments: [],
    agentPresetRoster: null,
    selectedAgentPreset: null,
    modelCatalog: null,
    modelSelection: null,
    settingsMenuOpen: false,
    configurationLoading: false,
    configurationAction: null,
    configurationError: null,
    sendState: 'idle', // idle | sending | accepted | failed
    /** UI-local create substate; never a domain state. */
    creatingSession: false,
    /** Safe, operator-visible detail from the latest failed session-create request. */
    newSessionError: null,
    /** The most recently created session id, for evidence and follow-up. */
    createdSessionId: null,
    /**
     * UI-local cancel substate. **Never** a domain state.
     *
     * `idle | cancelling | requested | failed`. `requested` means the Gateway accepted the
     * command; it does **not** mean the run is over. The domain only becomes `cancelled` from
     * authoritative evidence, matching the Gateway's own rule that admission is not the state
     * transition.
     */
    cancelState: 'idle',
    /** @type {import('./errors.js').ApiError|null} the most recent failure, for the UI to map. */
    error: null,
    fatal: null,
    ...overrides,
  };
}

/**
 * The real-mode controller.
 */
export class RealModeController {
  /**
   * @param {object} options - `client`, `credentials`, `onChange`, `now`.
   */
  constructor(options) {
    if (options?.client === undefined) throw new TypeError('RealModeController requires a client');
    this.client = options.client;
    this.credentials = options.credentials ?? new CredentialStore();
    this.onChange = options.onChange ?? (() => {});
    /**
     * FormData constructor for uploads.
     *
     * Browser `FormData` is used by default; the seam exists because a non-browser environment
     * has no such global, and because the multipart shape is worth asserting directly.
     */
    this.formDataFactory = options.formDataFactory ?? null;
    /**
     * The live socket binding, when R8D streaming is enabled.
     *
     * The socket is owned by `ws/live-session.js`, never by this controller and never by a
     * component — that separation is what keeps "one socket per active session" checkable.
     *
     * @type {object|null}
     */
    this.live = options.live ?? null;
    this.onLiveChange = typeof options.onLiveChange === 'function' ? options.onLiveChange : () => {};
    this.state = createRealState();
    /** @type {AbortController|null} in-flight session load, aborted when the selection changes. */
    this.sessionAbort = null;
    /**
     * In-flight action guards (R8F §20).
     *
     * Each action that must not run twice concurrently holds a token here. `null` means idle, so
     * a second invocation can be refused rather than issued. This is deliberate single-flight,
     * not a hope that users will not double-click.
     *
     * @type {{send: object|null, cancel: object|null, upload: Map<string, object>, create: object|null}}
     */
    this.inFlight = { send: null, cancel: null, upload: new Map(), create: null };
    /** In-flight older-history page, so a second press cannot issue a duplicate request. */
    this.olderInFlight = null;
    /** Monotonic sequence for locally selected attachments; see `addLocalAttachment`. */
    this.localAttachmentSeq = 0;
    /** Accepted prompt echoes fill a documented DSH history gap: its page API returns null for user text. */
    this.promptEchoStorage = options.promptEchoStorage ?? defaultPromptEchoStorage();
    this.localPromptEchoes = readPromptEchoes(this.promptEchoStorage);
    this.toastTimers = new Map();
    this.sendFailureTimer = null;
    this.lastRenameNotice = null;
    /** Keep one failed prompt's id in memory so retry is safe if DSH accepted before a link error. */
    this.failedSendAttempt = null;
    this.recovery = this.live === null ? null : new RecoveryController({ owner: this, live: this.live, timeoutMs: options.recoveryTimeoutMs });
  }

  /** Recovery commits one state patch; it never reaches into the component tree. */
  updateRecovery(patch) {
    if (Array.isArray(patch.messages)) {
      const messages = this.reconcileMessages(patch.messages);
      this.#set({ ...patch, messages, messageListStatus: messages.length ? 'loaded' : 'empty' });
    } else this.#set(patch);
  }

  /** All history replacements and live user arrivals share the accepted-prompt fallback. */
  reconcileMessages(messages, sessionId = this.state.activeSessionId) {
    const echoes = this.localPromptEchoes.get(sessionId) ?? [];
    const identities = echoes.map(echo => [echo.serverMessageId, echo.sourceSequence, echo.turn, echo.serverCreatedAt].join('|')).join('\n');
    const result = mergePromptEchoes(messages, echoes);
    const updated = echoes.map(echo => [echo.serverMessageId, echo.sourceSequence, echo.turn, echo.serverCreatedAt].join('|')).join('\n');
    if (updated !== identities) persistPromptEchoes(this.promptEchoStorage, this.localPromptEchoes);
    return result;
  }

  async toggleConfigurationPanel(open) {
    if (open !== true) {
      this.#set({ settingsMenuOpen: false, configurationError: null });
      return this.state;
    }
    this.#set({ settingsMenuOpen: true, configurationError: null });
    if (this.state.agentPresetRoster !== null && this.state.modelCatalog !== null) {
      const session = this.state.sessions.find((entry) => entry.id === this.state.activeSessionId);
      this.#set({
        selectedAgentPreset: session?.agentPreset
          ?? this.state.agentPresetRoster.presets?.find((preset) => preset.isDefault)?.id
          ?? null,
        modelSelection: session?.modelSelection ?? this.state.modelCatalog.default ?? null,
      });
      return this.state;
    }
    this.#set({ configurationLoading: true });
    try {
      const [agentPresetRoster, modelCatalog] = await Promise.all([
        this.client.getAgentPresets(),
        this.client.getModelCatalog(),
      ]);
      this.#set({
        agentPresetRoster,
        modelCatalog,
        selectedAgentPreset: this.state.sessions.find((session) => session.id === this.state.activeSessionId)?.agentPreset
          ?? agentPresetRoster.presets?.find((preset) => preset.isDefault)?.id
          ?? null,
        modelSelection: this.state.sessions.find((session) => session.id === this.state.activeSessionId)?.modelSelection
          ?? modelCatalog?.default
          ?? null,
        configurationLoading: false,
      });
    } catch (error) {
      this.#set({ configurationLoading: false, configurationError: errorFromThrow(error).message });
    }
    return this.state;
  }

  async applyAgentPreset(agentPreset) {
    const sessionId = this.state.activeSessionId;
    if (sessionId === null || typeof agentPreset !== 'string' || agentPreset.length === 0) return this.state;
    this.#set({ configurationAction: 'preset', configurationError: null });
    try {
      const selected = await this.client.selectAgentPreset(sessionId, agentPreset);
      const selectedPreset = selected?.agentPreset ?? agentPreset;
      this.#set({
        selectedAgentPreset: selectedPreset,
        sessions: this.state.sessions.map((session) => session.id === sessionId ? { ...session, agentPreset: selectedPreset } : session),
        configurationAction: null,
      });
      this.#notify(`Agent 预设已同步：${selected?.agentPreset ?? agentPreset}`, 'success');
    } catch (error) {
      this.#set({ configurationAction: null, configurationError: errorFromThrow(error).message });
    }
    return this.state;
  }

  async applyModelSelection(selection) {
    const sessionId = this.state.activeSessionId;
    if (sessionId === null || typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') return this.state;
    this.#set({ configurationAction: 'model', configurationError: null });
    try {
      const selected = await this.client.selectModel(sessionId, selection);
      const modelSelection = {
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoning_effort === undefined ? {} : { reasoningEffort: selected.reasoning_effort }),
      };
      this.#set({
        modelSelection,
        sessions: this.state.sessions.map((session) => session.id === sessionId ? { ...session, modelSelection } : session),
        configurationAction: null,
      });
      this.#notify('模型与推理强度已同步到 DSH', 'success');
    } catch (error) {
      this.#set({ configurationAction: null, configurationError: errorFromThrow(error).message });
    }
    return this.state;
  }

  #notify(message, tone = 'info', duration = 3500) {
    const id = `${Date.now()}-${Math.random()}`;
    const toasts = [...(this.state.toasts ?? []), { id, tone, message }].slice(-2);
    this.#set({ toasts });
    const timer = setTimeout(() => {
      this.toastTimers.delete(id);
      this.#set({ toasts: (this.state.toasts ?? []).filter((toast) => toast.id !== id) });
    }, duration);
    this.toastTimers.set(id, timer);
  }

  notifySessionRenamed(title) {
    const now = Date.now();
    if (this.lastRenameNotice?.title === title && now - this.lastRenameNotice.at < 5500) return;
    this.lastRenameNotice = { title, at: now };
    this.#notify(`重命名为：${title}`, 'success', 5000);
  }

  /** Push state to the view. */
  #emit() {
    this.onChange(this.state);
  }

  /**
   * Apply a patch and notify.
   *
   * @param {object} patch - the fields to change.
   * @returns {void}
   */
  #set(patch) {
    this.state = { ...this.state, ...patch };
    this.#emit();
  }

  /**
   * Translate a failure into state, distinguishing 401 from unreachable.
   *
   * This is the distinction R8C §9 exists for: a bad credential is discarded, an unreachable
   * Gateway is not.
   *
   * @param {ApiError} error - the failure.
   * @returns {void}
   */
  #applyFailure(cause) {
    // Coerce anything that is not already an ApiError. The client converts transport failures
    // itself, but a defect upstream (or an injected test double) must not turn a recoverable
    // failure into a crash — and must never be mistaken for a rejected credential.
    const error = cause instanceof ApiError ? cause : errorFromThrow(cause);
    const connection = connectionStateForError(error);
    if (error.clearsCredential()) {
      // The credential is wrong: discard it and ask again.
      this.credentials.clear();
      this.client.setCredential(null);
      this.#set({ connection: 'auth_required', credentialDialogOpen: true, credentialState: 'invalid', error });
      return;
    }
    if (connection === 'gateway_unavailable') {
      // Reachability failed. The credential is NOT touched.
      this.#set({ connection: 'gateway_unavailable', fatal: 'gateway-unavailable', error });
      return;
    }
    this.#set({ connection: 'connected', error });
  }

  /**
   * Boot: use a stored credential if present, otherwise ask for one.
   *
   * @param {object} [options] - `autostartCredentials` (test seam).
   * @returns {Promise<object>} the resulting state.
   */
  async boot(options = {}) {
    const existing = this.credentials.read();
    if (existing === null) {
      this.#set({ connection: 'auth_required', credentialDialogOpen: true, credentialState: 'entry' });
      return this.state;
    }
    this.client.setCredential(existing);
    this.#set({ connection: 'connecting', credentialDialogOpen: false });
    await this.#verifyAndLoad();
    return this.state;
  }

  /**
   * Submit a credential from the dialog.
   *
   * @param {string} token - the Phone Access Token.
   * @returns {Promise<object>} the resulting state.
   */
  async submitCredential(token) {
    if (typeof token !== 'string' || token.trim().length === 0) {
      this.#set({ credentialState: 'invalid', error: new ApiError(ERROR_KIND.AUTH_REQUIRED) });
      return this.state;
    }
    this.client.setCredential(token.trim());
    this.#set({ connection: 'connecting', credentialState: 'submitting' });
    await this.#verifyAndLoad();
    return this.state;
  }

  setRememberCredential(remember) {
    if (!this.credentials.setRemember(remember)) return false;
    if (this.client.credential !== null) {
      this.credentials.write(this.client.credential, { remember: remember === true });
    }
    return true;
  }

  /**
   * Verify the credential with an authenticated health check, then load sessions.
   *
   * The credential is written to sessionStorage **only after** health confirms it, so a typo
   * is never persisted.
   *
   * @returns {Promise<void>} when done.
   */
  async #verifyAndLoad() {
    try {
      await this.client.health();
    } catch (error) {
      // Only a rejected credential is discarded here. A network failure must leave the stored
      // credential untouched — the token may be perfectly valid and the Gateway merely down.
      if (error instanceof ApiError && error.clearsCredential()) this.credentials.clear();
      this.#applyFailure(error);
      return;
    }

    // Health passed: now it is safe to remember the credential.
    if (this.client.credential !== null) {
      this.credentials.write(this.client.credential, { remember: this.credentials.isRemembered() });
    }
    this.#set({
      connection: 'connected',
      credentialDialogOpen: false,
      credentialState: 'entry',
      error: null,
      fatal: null,
    });
    await this.loadSessions();
  }

  /**
   * Load the session list, following the server's opaque `nextCursor` to completion.
   *
   * R8C read one page and discarded `nextCursor`, so a phone saw only the first
   * slice of the DSH inventory. This walks every page now. Two safety rules make
   * that bounded and deterministic:
   *
   *   - a cursor already seen terminates the walk, so a server (or a defect) that
   *     repeats a cursor cannot loop forever;
   *   - sessions are de-duplicated by id, so a window that shifts between pages
   *     cannot render the same session twice.
   *
   * Cancellation/error semantics are unchanged: a failure maps through
   * `#applyFailure` and marks the list `error`. Drafts are never pruned here — a
   * paginated response is still not proof of deletion (R1.5.1A).
   *
   * @returns {Promise<object>} the resulting state.
   */
  async loadSessions() {
    this.#set({ sessionListStatus: 'loading' });
    try {
      const sessions = [];
      const seenIds = new Set();
      const seenCursors = new Set();
      let cursor;

      for (;;) {
        const page = await this.client.listSessions(cursor === undefined ? {} : { cursor });
        for (const session of page.sessions) {
          if (seenIds.has(session.id)) continue;
          seenIds.add(session.id);
          sessions.push(session);
        }

        const nextCursor = page.nextCursor;
        if (typeof nextCursor !== 'string' || nextCursor.length === 0) break;
        // Duplicate/loop protection: a repeated cursor cannot advance, so stop
        // rather than re-requesting it forever.
        if (nextCursor === cursor || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      // An empty list is a legitimate answer, not an error — see the discovery finding.
      const next = {
        sessions,
        sessionListStatus: sessions.length === 0 ? 'empty' : 'loaded',
        error: null,
      };
      // A successful call also proves the Gateway is reachable, so the connection axis is
      // promoted to `connected` — otherwise a fixture-driven render would leave it at the
      // seeded `connecting` and misreport a working link.
      if (this.state.connection === 'connecting' || this.state.connection === 'gateway_unavailable') {
        next.connection = 'connected';
        next.fatal = null;
      }
      /*
       * R1.5.1A: an ordinary list refresh MUST NOT prune drafts.
       *
       * R1.5.1 pruned here, treating absence from a successful response as proof the session was
       * gone. That assumption is unsound: `listSessions()` accepts `limit` and `cursor`, and
       * `normalizeSessionList()` returns `{ sessions, nextCursor }` -- so a successful response may
       * be a point-in-time slice. Following every page makes it complete at one moment, but a
       * completed walk is still an inventory, not a deletion acknowledgement.
       *
       * An absent session is therefore not evidence of deletion, and silently retaining
       * an unused in-memory draft is strictly preferable to silently losing operator text.
       *
       * Pruning may return only with a real deletion signal -- see the draft-pruning contract in
       * state/ui-state.js. The catch branch below has always been safe by comparison: a failed
       * request, a reconnect, an unavailable list or an active resync_required are not evidence of
       * deletion either.
       */
      this.#set(next);
    } catch (error) {
      this.#applyFailure(error);
      this.#set({ sessionListStatus: 'error' });
    }
    return this.state;
  }

  /**
   * Select a session and load its transcript.
   *
   * Any in-flight load is aborted first, so a slow response for session A can never overwrite
   * session B's view.
   *
   * @param {string} sessionId - the session id.
   * @returns {Promise<object>} the resulting state.
   */
  async selectSession(sessionId) {
    this.recovery?.cancel();
    this.live?.unbind();
    if (this.sessionAbort !== null) this.sessionAbort.abort();
    const controller = new AbortController();
    this.sessionAbort = controller;
    // A superseded older-page request must not be able to write into the new session.
    this.olderInFlight = null;

    /*
     * R1.5.1: switching sessions swaps in THAT session's own unsent draft, so a draft written for
     * one session can never be shown while another is selected.
     */
    const switched = selectSessionState(this.state, sessionId);
    this.#set({
      activeSessionId: sessionId,
      draft: switched.draft,
      messageListStatus: 'loading',
      messages: [],
      hasOlderMessages: false,
      nextBeforeSequence: null,
      olderMessagesStatus: 'idle',
      domain: 'idle',
      queueDepth: 0,
      resync: 'none',
      drawerOpen: false,
      sessionUnavailable: false,
    });

    try {
      const [session, page] = await Promise.all([
        this.client.getSession(sessionId, { signal: controller.signal }),
        this.client.getMessages(sessionId, { signal: controller.signal }),
      ]);

      // A superseded request must not write state, even if it resolved first.
      if (this.sessionAbort !== controller) return this.state;

      // The initial page is the LATEST page. Local prompt echoes (which DSH's page
      // API cannot return as user text) are merged back in without duplicating any
      // message the server already delivered.
      const messages = this.reconcileMessages(page.messages, sessionId);
      const hasMore = page.hasMore === true && typeof page.nextBeforeSequence === 'number';

      this.#set({
        messages,
        messageListStatus: messages.length === 0 ? 'empty' : 'loaded',
        hasOlderMessages: hasMore,
        nextBeforeSequence: hasMore ? page.nextBeforeSequence : null,
        olderMessagesStatus: hasMore ? 'idle' : 'exhausted',
        domain: session.status ?? 'idle',
        error: null,
      });

      // R8D: once the REST snapshot is in hand, open the live socket for this session, seeded
      // with the snapshot's sequence so replay resumes rather than restarting. The binding
      // closes any previous socket first, so the switch cannot leave two open.
      if (this.live !== null) {
        this.live.credential = this.client.credential;
        await this.live.bind({
          sessionId,
          lastSequence: lastSequenceFrom(page.messages, session),
        });
      }
    } catch (error) {
      if (error instanceof ApiError && error.kind === ERROR_KIND.ABORTED) return this.state;
      if (this.sessionAbort !== controller) return this.state;
      this.#set({ messageListStatus: 'error' });
      this.#applyFailure(error);
    }
    return this.state;
  }

  /** Rename a session, refresh the phone view, and announce the accepted title outside history. */
  async renameSession(session, title) {
    if (!session || typeof session.id !== 'string' || typeof title !== 'string') return this.state;
    try {
      const updated = await this.client.renameSession(session.id, title);
      await this.loadSessions();
      const sessions = this.state.sessions.map((item) => item.id === updated.id ? { ...item, ...updated } : item);
      if (!sessions.some((item) => item.id === updated.id)) sessions.push(updated);
      this.#set({ sessions, sessionListStatus: sessions.length ? 'loaded' : 'empty', error: null });
      this.notifySessionRenamed(updated.title);
      if (this.state.activeSessionId && this.recovery) void this.recovery.reload();
    } catch (error) {
      this.#applyFailure(error);
    }
    return this.state;
  }

  /** Archive one session from the DSH inventory and select a valid remaining conversation. */
  async deleteSession(session) {
    if (!session || typeof session.id !== 'string') return this.state;
    try {
      await this.client.archiveSession(session.id);
      await this.loadSessions();
      const sessions = this.state.sessions.filter((item) => item.id !== session.id);
      this.#set({ sessions, sessionListStatus: sessions.length ? 'loaded' : 'empty', error: null });
      if (this.state.activeSessionId === session.id) {
        const next = sessions[0];
        if (next) await this.selectSession(next.id);
        else {
          this.recovery?.cancel();
          this.live?.unbind();
          this.sessionAbort?.abort();
          this.sessionAbort = null;
          this.#set({ activeSessionId: null, messages: [], draft: '', messageListStatus: 'empty', domain: 'idle', sendState: 'idle' });
        }
      }
      this.#notify('会话已从列表删除并归档；历史记录仍保留。', 'success');
      return this.state;
    } catch (error) {
      this.#applyFailure(error);
      return { ...this.state, error: this.state.error ?? errorFromThrow(error) };
    }
  }

  /** Archive a workspace group's sessions while preserving its PC folder and files. */
  async archiveWorkspace(workspaceKey) {
    if (typeof workspaceKey !== 'string' || workspaceKey.length === 0) return this.state;
    try {
      const result = await this.client.archiveWorkspace(workspaceKey);
      const archivedIds = new Set(Array.isArray(result?.archived_session_ids) ? result.archived_session_ids : []);
      await this.loadSessions();
      const sessions = this.state.sessions.filter((item) => !archivedIds.has(item.id));
      this.#set({ sessions, sessionListStatus: sessions.length ? 'loaded' : 'empty', error: null });
      if (archivedIds.has(this.state.activeSessionId)) {
        const next = sessions[0];
        if (next) await this.selectSession(next.id);
        else {
          this.recovery?.cancel();
          this.live?.unbind();
          this.sessionAbort?.abort();
          this.sessionAbort = null;
          this.#set({ activeSessionId: null, messages: [], draft: '', messageListStatus: 'empty', domain: 'idle', sendState: 'idle' });
        }
      }
      this.#notify(
        result?.partial === true
          ? `已归档 ${Number(result?.archived_count ?? archivedIds.size)} 个会话，另有 ${Number(result?.failed_count ?? 0)} 个未完成；请刷新后重试。电脑上的工作区文件夹和文件已保留。`
          : `已归档 ${Number(result?.archived_count ?? archivedIds.size)} 个会话；电脑上的工作区文件夹和文件已保留。`,
        result?.partial === true ? 'warning' : 'success',
        result?.partial === true ? 6500 : 3500,
      );
      return { ...this.state, archivedSessionIds: [...archivedIds], partial: result?.partial === true };
    } catch (error) {
      this.#applyFailure(error);
      return { ...this.state, error: this.state.error ?? errorFromThrow(error) };
    }
  }

  /**
   * Load the next older page of the selected session's history.
   *
   * The initial `selectSession` page is the newest slice. This walks backwards
   * through DSH durable sequence space with the server-provided `next_before_seq`
   * as the `before_seq` of the next request, merging each page in front of the
   * transcript without duplicating a message that is already present. Local
   * prompt echoes and the live/streaming binding are untouched: paging history is
   * never allowed to drop operator-visible or in-flight content.
   *
   * @returns {Promise<object>} the resulting state.
   */
  async loadOlderMessages() {
    const sessionId = this.state.activeSessionId;
    if (sessionId === null) return this.state;
    if (this.state.hasOlderMessages !== true) return this.state;

    const beforeSequence = this.state.nextBeforeSequence;
    if (typeof beforeSequence !== 'number') return this.state;

    // Single-flight: a double press must not issue two identical page requests.
    if (this.olderInFlight !== null) return { ...this.state, refused: 'history-in-flight' };
    const controller = this.sessionAbort;
    const token = { sessionId, beforeSequence };
    this.olderInFlight = token;

    this.#set({ olderMessagesStatus: 'loading' });
    try {
      const page = await this.client.getMessages(sessionId, {
        beforeSequence,
        ...(controller === null ? {} : { signal: controller.signal }),
      });

      if (sessionId !== this.state.activeSessionId || this.olderInFlight !== token) return this.state;

      // Older messages go in FRONT of the existing transcript; de-duplication
      // covers the overlap a shifting window can produce.
      const messages = this.reconcileMessages(mergeMessages(page.messages, this.state.messages), sessionId);
      const nextBefore = page.nextBeforeSequence;
      // Progress must be real: `has_more` with a non-advancing cursor would loop.
      const progressed = typeof nextBefore === 'number' && nextBefore !== beforeSequence;
      const hasMore = page.hasMore === true && progressed;

      this.#set({
        messages,
        hasOlderMessages: hasMore,
        nextBeforeSequence: hasMore ? nextBefore : null,
        olderMessagesStatus: hasMore ? 'idle' : 'exhausted',
        error: null,
      });
    } catch (error) {
      if (error instanceof ApiError && error.kind === ERROR_KIND.ABORTED) return this.state;
      if (sessionId !== this.state.activeSessionId || this.olderInFlight !== token) return this.state;
      // The transcript already on screen is preserved; only the paging substate fails.
      this.#set({ olderMessagesStatus: 'error' });
      this.#applyFailure(error);
    } finally {
      if (this.olderInFlight === token) this.olderInFlight = null;
    }
    return this.state;
  }

  /**
   * Create a new session and open it.
   *
   * The phone may optionally send an opaque workspace key from the current DSH
   * inventory. It never sends a path, DSH workspace id, or session id. After the
   * Gateway returns a safe identity the inventory is refreshed and the new
   * session is selected, so its composer can send the first prompt through the
   * existing prompt route.
   *
   * @param {object} [options] - `requestId`, `signal`, and optional `workspaceKey`.
   * @returns {Promise<object>} the resulting state.
   */
  async newSession(options = {}) {
    // Single-flight: a double press must not create two sessions.
    if (this.inFlight.create !== null) return { ...this.state, refused: 'create-in-flight' };
    const token = {};
    this.inFlight.create = token;
    // Switch away from the historical transcript as soon as the user taps.
    // Keeping it visible while POST /sessions waits made a slow create look like
    // a dead button. Restore this view only if creation itself fails.
    const previousView = {
      activeSessionId: this.state.activeSessionId,
      draft: this.state.draft,
      messages: this.state.messages,
      messageListStatus: this.state.messageListStatus,
      hasOlderMessages: this.state.hasOlderMessages,
      nextBeforeSequence: this.state.nextBeforeSequence,
      olderMessagesStatus: this.state.olderMessagesStatus,
      domain: this.state.domain,
      queueDepth: this.state.queueDepth,
      resync: this.state.resync,
      sessionUnavailable: this.state.sessionUnavailable,
    };
    this.#set({
      creatingSession: true,
      error: null,
      newSessionError: null,
      drawerOpen: false,
      activeSessionId: null,
      draft: '',
      messages: [],
      messageListStatus: 'loading',
      hasOlderMessages: false,
      nextBeforeSequence: null,
      olderMessagesStatus: 'idle',
      domain: 'idle',
      queueDepth: 0,
      resync: 'none',
      sessionUnavailable: false,
    });
    const restorePreviousView = () => this.#set({ ...previousView, creatingSession: false });
    const reportCreateFailure = (cause) => {
      const failure = cause instanceof ApiError ? cause : errorFromThrow(cause);
      restorePreviousView();
      this.#set({ newSessionError: failure.message });
      this.#applyFailure(failure);
    };

    try {
      const created = await this.client.createSession(options);
      const createdId = typeof created?.id === 'string' && created.id.length > 0 ? created.id : null;
      if (createdId === null) {
        // A create with no usable identity is a protocol failure, never a
        // successful empty result.
        reportCreateFailure(new ApiError(ERROR_KIND.SERVER, { status: 502 }));
        return this.state;
      }

      this.#set({ creatingSession: false, createdSessionId: createdId });

      // Refresh first, so the new session is in the inventory the drawer renders,
      // then open it. Both calls contain their own failure handling; a list
      // failure must not lose the identity we already hold.
      await this.loadSessions();
      await this.selectSession(createdId);
      return this.state;
    } catch (error) {
      if (this.inFlight.create !== token) return this.state;
      reportCreateFailure(error);
      return this.state;
    } finally {
      if (this.inFlight.create === token) this.inFlight.create = null;
    }
  }

  /**
   * Alias for {@link RealModeController#newSession}.
   *
   * The drawer affordance is "New session"; this spelling keeps the intent
   * explicit at call sites that think in terms of creating a session.
   *
   * @param {object} [options] - `requestId`, `signal`.
   * @returns {Promise<object>} the resulting state.
   */
  async createSession(options = {}) {
    return this.newSession(options);
  }

  /**
   * Send the current draft.
   *
   * `mode` is passed through explicitly from the caller's intent — never inferred here.
   *
   * @param {object} request - `content`, `mode`, `requestId`.
   * @returns {Promise<object>} the resulting state.
   */
  async send(request) {
    const sessionId = this.state.activeSessionId;
    if (sessionId === null) return this.state;
    const recoveryGeneration = this.recovery?.generation;

    // §20: a second submission while one is in flight is refused outright. The stable
    // `requestId` gives server-side idempotency, but relying on it alone would still issue a
    // duplicate request; the guard stops the request, and the id makes a retry safe.
    if (this.inFlight.send !== null) {
      return { ...this.state, refused: 'send-in-flight' };
    }
    const retry = this.failedSendAttempt;
    const canReuseFailedId = retry?.sessionId === sessionId
      && retry.content === request.content
      && retry.mode === request.mode;
    const sendRequest = {
      ...request,
      requestId: request.requestId ?? (canReuseFailedId ? retry.requestId : createRequestId()),
    };
    const token = { sessionId, requestId: sendRequest.requestId, createdAt: new Date().toISOString() };
    this.inFlight.send = token;

    this.#set({ sendState: 'sending' });
    try {
      const result = await this.client.sendMessage(sessionId, sendRequest);
      this.failedSendAttempt = null;
      // Acceptance only. The domain is NOT advanced here: `queued`/`running` arrive as
      // authoritative Gateway events, and an assistant reply is never implied.
      //
      // R1.5.1: clear ONLY the sending session's draft. Every other session keeps its unsent text.
      const afterSend = clearDraftFor(this.state, sessionId);
      const echoContent = typeof sendRequest.content === 'string'
        ? sendRequest.content
        : Array.isArray(sendRequest.content)
          ? sendRequest.content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n')
          : '';
      const echo = echoContent.length > 0 ? {
        id: `${sessionId}:client:${sendRequest.requestId}`,
        requestId: sendRequest.requestId,
        session_id: sessionId,
        sessionId,
        role: 'user',
        type: 'message',
        content: echoContent,
        created_at: token.createdAt,
        source_sequence: null,
        optimistic: true,
      } : null;
      const echoes = this.localPromptEchoes.get(sessionId) ?? [];
      const nextEchoes = echo !== null && !echoes.some((message) => message.id === echo.id)
        ? [...echoes, echo]
        : echoes;
      if (echo !== null) {
        this.localPromptEchoes.set(sessionId, nextEchoes);
        persistPromptEchoes(this.promptEchoStorage, this.localPromptEchoes);
      }
      // A recovery may have advanced while acceptance was in flight. Preserve
      // accepted text anyway; only another session must not receive this patch.
      if (sessionId !== this.state.activeSessionId) return this.state;
      this.#set({
        messages: this.reconcileMessages(this.state.messages, sessionId),
        sendState: 'accepted',
        draft: afterSend.draft,
        draftsBySessionId: afterSend.draftsBySessionId,
        error: null,
      });
      return { ...this.state, sendResult: result };
    } catch (error) {
      // The draft is preserved so the operator can retry.
      if (sessionId !== this.state.activeSessionId || recoveryGeneration !== this.recovery?.generation) return this.state;
      this.failedSendAttempt = { sessionId, requestId: sendRequest.requestId, content: request.content, mode: request.mode };
      this.#set({ sendState: 'failed' });
      this.#applyFailure(error);
      clearTimeout(this.sendFailureTimer);
      this.sendFailureTimer = setTimeout(() => {
        if (this.state.activeSessionId !== sessionId || this.state.sendState !== 'failed') return;
        this.#set({ sendState: 'idle', error: null });
        if (this.recovery) {
          void Promise.allSettled([this.loadSessions(), this.recovery.reload()]);
        } else {
          void this.loadSessions();
          void this.selectSession(sessionId);
        }
      }, 5000);
      return this.state;
    } finally {
      if (this.inFlight.send === token) this.inFlight.send = null;
    }
  }

  /**
   * Request cancellation of the running turn.
   *
   * ## Admission is not the state transition
   *
   * The Gateway's own cancel route returns `202 Accepted` and deliberately does **not** set the
   * session to `cancelled` — that requires observed `RUN_ABANDONED` evidence. The UI must mirror
   * that rule exactly, so this records `cancelState: 'requested'` and leaves the domain alone.
   *
   * Setting `domain: 'cancelled'` from a REST `2xx` would be the mirror image of optimistically
   * declaring completion: it would permanently force a terminal state the server never
   * confirmed, and a disconnect before the authoritative event would leave the UI stuck on it.
   *
   * @param {object} [options] - `requestId`.
   * @returns {Promise<object>} the resulting state.
   */
  async cancel(options = {}) {
    const sessionId = this.state.activeSessionId;
    if (sessionId === null) return this.state;
    const recoveryGeneration = this.recovery?.generation;

    // §10: repeated cancel submissions are disabled while one is in flight.
    if (this.inFlight.cancel !== null) {
      return { ...this.state, refused: 'cancel-in-flight' };
    }
    const token = { sessionId };
    this.inFlight.cancel = token;

    this.#set({ cancelState: 'cancelling' });
    try {
      const result = await this.client.cancel(sessionId, options);
      if (sessionId !== this.state.activeSessionId || recoveryGeneration !== this.recovery?.generation) return this.state;
      // Requested, not cancelled. The authoritative event decides the domain.
      this.#set({ cancelState: 'requested', error: null });
      return { ...this.state, cancelResult: result };
    } catch (error) {
      if (sessionId !== this.state.activeSessionId || recoveryGeneration !== this.recovery?.generation) return this.state;
      this.#set({ cancelState: 'failed' });
      // §12: a conflict proves the Gateway is reachable and the action is inapplicable. The
      // failure mapper keeps the connection `connected` for anything that is not 401/network,
      // so a 409 can never masquerade as `gateway_unavailable`.
      this.#applyFailure(error);
      return this.state;
    } finally {
      if (this.inFlight.cancel === token) this.inFlight.cancel = null;
    }
  }

  /**
   * Upload a file.
   *
   * @param {File|object} file - the browser File.
   * @returns {Promise<object>} the resulting state.
   */
  async upload(file) {
    const sessionId = this.state.activeSessionId;
    if (sessionId === null) return this.state;
    const recoveryGeneration = this.recovery?.generation;

    // §20: the same file cannot be uploaded twice concurrently. Keyed by name+size so a genuine
    // second file is still allowed, while a double-click on one selection is refused.
    const key = `${typeof file?.name === 'string' ? file.name : 'upload'}:${typeof file?.size === 'number' ? file.size : 0}`;
    if (this.inFlight.upload.has(key)) {
      return { ...this.state, refused: 'upload-in-flight' };
    }
    const pending = {
      id: `pending-${this.state.attachments.length + 1}-${this.inFlight.upload.size}`,
      name: typeof file?.name === 'string' ? file.name : 'upload',
      kind: 'file',
      state: 'uploading',
      progress: 0,
    };
    this.inFlight.upload.set(key, pending);

    this.#set({ attachments: [...this.state.attachments, pending] });

    try {
      const attachment = await this.client.upload(sessionId, file, this.formDataFactory === null
        ? {}
        : { formDataFactory: this.formDataFactory });
      if (sessionId !== this.state.activeSessionId || recoveryGeneration !== this.recovery?.generation) return this.state;
      this.#set({
        attachments: this.state.attachments.map((a) => (a.id === pending.id ? attachment : a)),
        error: null,
      });
    } catch (error) {
      if (sessionId !== this.state.activeSessionId || recoveryGeneration !== this.recovery?.generation) return this.state;
      // §18: recovery is remove / re-select / re-upload. There is no assumed retry endpoint and
      // §19 forbids auto-retrying during a resync.
      this.#set({
        attachments: this.state.attachments.map((a) => (a.id === pending.id ? { ...a, state: 'failed' } : a)),
      });
      this.#applyFailure(error);
    } finally {
      if (this.inFlight.upload.get(key) === pending) this.inFlight.upload.delete(key);
    }
    return this.state;
  }

  /**
   * Record a picked file as a local attachment. **Selection is not upload.**
   *
   * §14 draws this distinction explicitly: choosing a file creates a local item and nothing else.
   * No request is issued here, so cancelling a picker cannot produce one either, and the file is
   * only sent when the operator submits through the existing product workflow.
   *
   * The browser `File` is kept on the item so the existing upload path can consume it unchanged.
   * Only `name`, `size` and `type` are read from it — never a local path, which the browser does
   * not expose and the product does not want (§10).
   *
   * §9: the 25 MiB check here is advisory. The server stays the authority and its limit semantics
   * are untouched; this only avoids sending a file the server is certain to refuse.
   *
   * @param {File|object} file - the picked file.
   * @returns {object} the resulting state.
   */
  addLocalAttachment(file) {
    const name = typeof file?.name === 'string' && file.name.length > 0 ? file.name : 'attachment';
    const size = typeof file?.size === 'number' && Number.isFinite(file.size) ? file.size : null;
    const type = typeof file?.type === 'string' && file.type.length > 0 ? file.type : null;
    // A monotonic counter, not `Date.now()` plus the current list length. Deriving the id from the
    // attachment count collides whenever an item is removed between two selections: remove the
    // first, add another, and both compute the same index. Selecting the same file again after
    // removing it is the normal way to reach that, so the ids have to be unique independently of
    // the list's size.
    this.localAttachmentSeq += 1;
    const local = {
      id: `local-${this.localAttachmentSeq}`,
      name,
      kind: 'file',
      state: size !== null && size > MAX_UPLOAD_BYTES ? 'failed' : 'selected',
      size,
      type,
      file,
    };
    this.#set({ attachments: [...this.state.attachments, local] });
    return this.state;
  }

  /**
   * Remove an attachment locally.
   *
   * §15 allows a `removed` state; there is no delete endpoint, so removal is a local
   * presentation change and never claims the server forgot the file.
   *
   * @param {string} attachmentId - the attachment to drop.
   * @returns {object} the resulting state.
   */
  removeAttachment(attachmentId) {
    this.#set({ attachments: this.state.attachments.filter((a) => a.id !== attachmentId) });
    return this.state;
  }

  /**
   * Discard the stored credential and return to the credential dialog.
   *
   * @returns {object} the resulting state.
   */
  signOut() {
    clearTimeout(this.sendFailureTimer);
    for (const timer of this.toastTimers.values()) clearTimeout(timer);
    this.toastTimers.clear();
    this.recovery?.cancel();
    this.sessionAbort?.abort();
    this.sessionAbort = null;
    this.credentials.clear();
    this.client.setCredential(null);
    this.#set({ connection: 'auth_required', credentialDialogOpen: true, credentialState: 'entry' });
    return this.state;
  }

  dispose() {
    this.recovery?.dispose();
    this.live?.unbind();
    this.sessionAbort?.abort();
    clearTimeout(this.sendFailureTimer);
    for (const timer of this.toastTimers.values()) clearTimeout(timer);
    this.toastTimers.clear();
  }
}

/**
 * Merge message lists without duplicating any message identity.
 *
 * Order is preserved: `first` keeps its order, then any of `second` not already
 * present is appended. This is the single merge used for both "server page plus
 * local prompt echoes" and "older page in front of the current transcript", so a
 * shifting server window or a repeated message id can never render twice.
 *
 * @param {object[]} first - the leading messages.
 * @param {object[]} second - messages to append when not already present.
 * @returns {object[]} the merged list.
 */
export function mergeMessages(first, second) {
  const seen = new Set();
  const out = [];
  for (const message of [...(first ?? []), ...(second ?? [])]) {
    const key = typeof message?.id === 'string' && message.id.length > 0
      ? `id:${message.id}`
      : `anon:${out.length}:${JSON.stringify(message ?? null)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(message);
  }
  return out;
}

/**
 * Derive the replay seed from the REST snapshot.
 *
 * The watermark is the **Gateway sequence** carried by the loaded messages, never a message
 * count, an index or a timestamp. When the snapshot carries no sequenced message, `null` is
 * returned so the client asks for live-only rather than inventing a position.
 *
 * @param {object[]} messages - the loaded messages.
 * @param {object} session - the session view.
 * @returns {number|null} the seed.
 */
export function lastSequenceFrom(messages, session) {
  // A session-level watermark is authoritative when present.
  const fromSession = session?.last_sequence ?? session?.lastSequence;
  if (typeof fromSession === 'number' && Number.isSafeInteger(fromSession) && fromSession >= 0) {
    return fromSession;
  }
  let highest = null;
  for (const message of messages ?? []) {
    const sequence = message?.sequence;
    if (typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence >= 0) {
      if (highest === null || sequence > highest) highest = sequence;
    }
  }
  return highest;
}

/**
 * Whether a location hash selects fixture mode.
 *
 * Rule: fixture mode requires an explicit `#fixture=<known name>`. A bare fragment, an
 * unknown name, or a credential-looking value all fall through to **real** mode — so a
 * malformed or hostile fragment can never make the UI show fake data while pretending to be
 * a live connection.
 *
 * @param {string} hash - the location hash.
 * @param {readonly string[]} knownFixtures - the accepted fixture names.
 * @returns {boolean} true when fixture mode should be used.
 */
export function isFixtureMode(hash, knownFixtures) {
  const raw = String(hash ?? '').replace(/^#/, '');
  if (raw.length === 0) return false;
  const params = new URLSearchParams(raw);
  const requested = params.get('fixture');
  if (requested === null) return false;
  return knownFixtures.includes(requested);
}
