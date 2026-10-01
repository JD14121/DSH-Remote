/**
 * UI state: the two independent state axes, plus the render inputs derived from them.
 *
 * ## Two axes, never merged
 *
 * Domain state is server-derived and fixed at eight values (R2). Connection state is
 * client-only and has six. They are separate on purpose: `running + reconnecting` is a legal,
 * meaningful combination, and a design that cannot express it is wrong.
 *
 * This module contains no network code and no storage. It is pure state.
 */

/**
 * Domain state 鈥?exactly eight. No ninth value may be added.
 *
 * @type {readonly string[]}
 */
export const DOMAIN_STATES = Object.freeze([
  'idle',
  'queued',
  'running',
  'waiting_input',
  'completed',
  'failed',
  'cancelled',
  'disconnected',
]);

/**
 * Connection state 鈥?exactly six, client-only.
 *
 * @type {readonly string[]}
 */
export const CONNECTION_STATES = Object.freeze([
  'auth_required',
  'connecting',
  'connected',
  'reconnecting',
  'resync_required',
  'gateway_unavailable',
]);

/**
 * The label each connection state shows in the badge.
 *
 * Kept beside the states so every consumer agrees on the wording.
 *
 * R1.3.1: `resync_required` MUST NOT reuse the `reconnecting` label. It previously read
 * 'Reconnecting', which made two of the six accepted connection states indistinguishable in the
 * badge -- the one surface that is always visible. It now names the user's actual next step. The
 * banner still carries the full sentence and the Reload action; the badge only states the state.
 *
 * Labels must stay mutually distinct: a duplicate here is a defect, not a wording preference.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const CONNECTION_LABELS = Object.freeze({
  auth_required: 'Auth Required',
  connecting: 'Connecting',
  connected: 'Ready',
  reconnecting: 'Reconnecting',
  resync_required: 'Reload Required',
  gateway_unavailable: 'Gateway Unavailable',
});

/**
 * Whether a connection state can carry traffic.
 *
 * Only `connected` sends. Everything else disables send while keeping the draft editable.
 *
 * @param {string} connection - the connection state.
 * @returns {boolean} true when sending is allowed.
 */
export function canSend(connection) {
  return connection === 'connected';
}

/**
 * The composer's primary-action label for a domain state.
 *
 * This is the binding queue/steer rule: the primary action never changes meaning silently.
 *
 * @param {string} domain - the domain state.
 * @returns {string} the label.
 */
export function primarySendLabel(domain) {
  // `queued` reads "Send later" because sending again queues another message behind the turn;
  // `waiting_input` reads "Send" because answering a pending request is neither queue nor steer.
  if (domain === 'running' || domain === 'queued') return 'Send later';
  return 'Send';
}

/**
 * Whether the steer action is offered for a domain state.
 *
 * Steer is always a separate, explicitly labelled action 鈥?never the hidden behaviour of the
 * primary button.
 *
 * @param {string} domain - the domain state.
 * @returns {boolean} true when steer is available.
 */
export function steerAvailable(domain) {
  return domain === 'running' || domain === 'queued';
}

/**
 * The intent a primary send action carries for a domain state.
 *
 * @param {string} domain - the domain state.
 * @returns {'send'|'queue'|'reply'} the intent.
 */
export function sendIntent(domain) {
  if (domain === 'running' || domain === 'queued') return 'queue';
  if (domain === 'waiting_input') return 'reply';
  return 'send';
}

/**
 * Build the initial UI state.
 *
 * @param {object} [overrides] - fields to override.
 * @returns {object} the state.
 */
export function createUiState(overrides = {}) {
  return {
    domain: 'idle',
    connection: 'connected',
    drawerOpen: false,
    credentialDialogOpen: false,
    attachments: [],
    queueDepth: 0,
    draft: '',
    streaming: null,
    resync: 'none', // none | required | reloading | reload-failed
    fatal: null,
    toasts: [],
    /*
     * R1.5.1: the authoritative selected session.
     *
     * This is the client selection state that both the tablet rail and the mobile drawer read. It is
     * never inferred from list order, running state, the URL or message content.
     */
    activeSessionId: null,
    /*
     * R1.5.1: unsent drafts are owned by SESSION ID, in client memory only.
     *
     * Deliberately NOT persisted to localStorage, sessionStorage, the backend, the URL or Android
     * native storage -- the contract is per-session in-memory ownership. An orphaned entry may be
     * dropped only when a successful authoritative session-list refresh confirms the session is
     * gone -- and R1.5.1A removed pruning entirely, because a list response may be partial.
     */
    draftsBySessionId: {},
    /*
     * R1.5.2: whether the selected session's transcript is still being fetched.
     *
     * This is not a new session-identity concept. `activeSessionId` is the selected session and
     * `messageListStatus` already tracked idle|loading|loaded|empty|error in real mode;
     * `sessionLoading` is the derived boolean the shell needs to prove the R1.5.2 invariant --
     * "never present an old transcript as the newly selected session" -- without adding a third
     * parallel session-id field.
     */
    messageListStatus: 'idle', // idle | loading | loaded | empty | error
    sessionLoading: false,
    ...overrides,
  };
}

/**
 * Switch the selected session and show that session's own draft.
 *
 * R1.5.1: selecting a session must never show another session's unsent text.
 *
 * @param {object} state - the current state.
 * @param {string|null} sessionId - the session to select.
 * @returns {object} the next state.
 */
export function selectSessionState(state, sessionId) {
  if (sessionId === null) return reduceState(state, { activeSessionId: null, draft: '' });
  return reduceState(state, {
    activeSessionId: sessionId,
    draft: state.draftsBySessionId?.[sessionId] ?? '',
  });
}

/**
 * Record the composer's current text against the SELECTED session.
 *
 * The composer reads `state.draft`, so that field stays the live value; `draftsBySessionId` is the
 * per-session store behind it. With no session selected the text is kept as a session-less draft
 * rather than being written into another session's slot.
 *
 * @param {object} state - the current state.
 * @param {string} value - the composer text.
 * @returns {object} the next state.
 */
export function setDraft(state, value) {
  const id = state.activeSessionId;
  if (id === null || id === undefined) return reduceState(state, { draft: value });
  return reduceState(state, {
    draft: value,
    draftsBySessionId: { ...state.draftsBySessionId, [id]: value },
  });
}

/**
 * Clear the draft of one session only, leaving every other session's draft intact.
 *
 * Used on a successful send: the sent session's text goes, the rest must survive.
 *
 * @param {object} state - the current state.
 * @param {string|null} sessionId - the session whose draft to clear.
 * @returns {object} the next state.
 */
export function clearDraftFor(state, sessionId) {
  if (sessionId === null || sessionId === undefined) return reduceState(state, { draft: '' });
  const next = { ...state.draftsBySessionId, [sessionId]: '' };
  return reduceState(state, {
    draftsBySessionId: next,
    draft: state.activeSessionId === sessionId ? '' : state.draft,
  });
}

/*
 * R1.5.1A -- DRAFT PRUNING IS DELIBERATELY NOT IMPLEMENTED.
 *
 * R1.5.1 had a pruneDrafts(state, liveSessionIds) helper and called it from loadSessions(). It was
 * removed because its premise was unsound: `listSessions()` accepts `limit` and `cursor`, and
 * `normalizeSessionList()` returns `{ sessions, nextCursor }`, so a SUCCESSFUL response may be one
 * page of many -- and loadSessions() discards nextCursor, so it cannot tell.
 *
 * INVARIANT: an unsent draft must not be deleted merely because its session id is absent from a
 * session-list response, unless that response is PROVEN complete. Silently retaining an unused
 * in-memory draft is preferable to silently losing operator text.
 *
 * Draft pruning may be reintroduced only when one of these exists:
 *
 *   A. an explicit successful session-delete / archive acknowledgement;
 *   B. an explicit server event, e.g. session_deleted(sessionId);
 *   C. a session-list response carrying an authoritative COMPLETENESS contract that proves it
 *      represents the full session universe.
 *
 * A paginated page by itself is NOT sufficient, and fields such as page / cursor / next / count must
 * not be read as "complete" unless the API contract explicitly says so. No completeness flag is
 * invented in this pass.
 *
 * Until then the only guaranteed cleanup mechanism is process/page lifecycle: drafts live in memory
 * only, so they disappear naturally when the app is destroyed.
 */

/**
 * Apply a partial update, returning a NEW state object.
 *
 * State is replaced rather than mutated so a render can be derived from a snapshot and the
 * previous value stays intact for comparison.
 *
 * @param {object} state - the current state.
 * @param {object} patch - the fields to change.
 * @returns {object} the next state.
 */
export function reduceState(state, patch) {
  return { ...state, ...patch };
}

/**
 * Validate a candidate state, so a fixture cannot introduce a ninth domain value.
 *
 * @param {object} state - the state to check.
 * @returns {{ok: boolean, errors: string[]}} the verdict.
 */
export function validateState(state) {
  const errors = [];
  if (!DOMAIN_STATES.includes(state.domain)) errors.push(`unknown domain state: ${String(state.domain)}`);
  if (!CONNECTION_STATES.includes(state.connection)) errors.push(`unknown connection state: ${String(state.connection)}`);
  return { ok: errors.length === 0, errors };
}

