/**
 * Fixture state: the twelve required screens, expressed as state over ONE component tree.
 *
 * There is deliberately no per-screen markup anywhere in this project. Each fixture is a
 * state object plus a transcript; `app.js` renders the same tree for all of them.
 *
 * The `#fixture=<name>` fragment selects one. The fragment never carries a credential 闁?the
 * only thing it may contain is a fixture name from this file.
 */

import { createUiState } from '../state/ui-state.js';
import { FIXTURE_SESSIONS, FIXTURE_STREAM_CHUNKS, CONTROLLED_STREAM_CHUNKS, messagesFor, sessionsFor } from '../fixtures/messages.js';

/**
 * The twelve required screens, keyed by fixture name.
 *
 * Each entry declares which contract screen it represents, its two axis values, and any
 * extra surface state the shell must show.
 *
 * @type {ReadonlyArray<object>}
 */
export const FIXTURES = Object.freeze([
  { name: 'ready', screen: 'S01', title: 'Ready Chat', domain: 'idle', connection: 'connected' },
  { name: 'streaming', screen: 'S02', title: 'Assistant Streaming', domain: 'running', connection: 'connected' },
  { name: 'queued', screen: 'S03', title: 'Message Queued', domain: 'queued', connection: 'connected' },
  { name: 'waitingInput', screen: 'S04', title: 'Waiting for Input', domain: 'waiting_input', connection: 'connected' },
  { name: 'reconnecting', screen: 'S05', title: 'Reconnecting', domain: 'disconnected', connection: 'reconnecting' },
  { name: 'resync', screen: 'S06', title: 'Resync Required', domain: 'disconnected', connection: 'resync_required' },
  { name: 'drawerOpen', screen: 'S07', title: 'Session Drawer Open', domain: 'idle', connection: 'connected', drawerOpen: true },
  { name: 'uploading', screen: 'S08', title: 'File Upload', domain: 'idle', connection: 'connected' },
  { name: 'authRequired', screen: 'S09', title: 'Phone Token Authentication', domain: 'idle', connection: 'auth_required', credentialDialogOpen: true },
  { name: 'gatewayUnavailable', screen: 'S10', title: 'Gateway Unavailable', domain: 'disconnected', connection: 'gateway_unavailable' },
  { name: 'empty', screen: 'S11', title: 'Empty Session', domain: 'idle', connection: 'connected' },
  { name: 'failed', screen: 'S12', title: 'Failed Message', domain: 'failed', connection: 'connected' },
  // Auxiliary compositions, not contract screens.
  { name: 'tabletReady', screen: 'T01', title: 'Tablet Ready Chat', domain: 'idle', connection: 'connected', auxiliary: true },
  { name: 'connecting', screen: '-', title: 'Connecting', domain: 'idle', connection: 'connecting', auxiliary: true },
  /*
   * R1.4.1: deterministic streaming. Same shell, same renderer, same `stepStreaming()` path as the
   * `streaming` fixture 闁?the only difference is that it is NOT put on the 350ms autoplay timer, so
   * a harness can advance it one chunk at a time and hold an intermediate state still for
   * inspection. See CONTROLLED_STREAM_CHUNKS.
   */
  { name: 'streamingControlled', screen: '-', title: 'Controlled Stream', domain: 'running', connection: 'connected', auxiliary: true, controlledStream: true },
  // R1.4.2: instrumented coverage for user-message fenced code.
  { name: 'userCode', screen: '-', title: 'User Code', domain: 'idle', connection: 'connected', auxiliary: true },
  /*
   * R1.4.2: a failed upload chip. Fixture data only -- the upload protocol and the real failure
   * handling are untouched. It exists so the failed-state accessibility can actually be inspected
   * rather than assumed, since the `uploading` fixture never reaches a terminal failure.
   */
  { name: 'uploadFailed', screen: '-', title: 'Upload Failed', domain: 'idle', connection: 'connected', auxiliary: true },
  // R1.5: session-level states -- a long list and an empty list. Fixture data only.
  { name: 'manySessions', screen: '-', title: 'Many Sessions', domain: 'idle', connection: 'connected', auxiliary: true },
  { name: 'noSessions', screen: '-', title: 'No Sessions', domain: 'idle', connection: 'connected', auxiliary: true },
  // R1.5.1 (T1): rows with neither title nor name, to prove the generic fallback.
  { name: 'untitledSessions', screen: '-', title: 'Untitled Sessions', domain: 'idle', connection: 'connected', auxiliary: true },
  // R1.5.2: the selected session's transcript is still loading -- the chat pane owns this.
  { name: 'sessionLoading', screen: '-', title: 'Session Loading', domain: 'idle', connection: 'connected', auxiliary: true, sessionLoading: true },
  // R1.5.2: session loading WHILE the link is reconnecting -- two independent concerns.
  { name: 'sessionLoadingReconnecting', screen: '-', title: 'Session Loading', domain: 'idle', connection: 'reconnecting', auxiliary: true, sessionLoading: true },
]);

/** The default fixture. */
export const DEFAULT_FIXTURE = 'ready';

/**
 * Look up a fixture by name.
 *
 * @param {string} name - the fixture name.
 * @returns {object} the fixture (falls back to the default).
 */
export function getFixture(name) {
  return FIXTURES.find((f) => f.name === name) ?? FIXTURES.find((f) => f.name === DEFAULT_FIXTURE);
}

/**
 * Build the complete fixture state for a named screen.
 *
 * @param {string} name - the fixture name.
 * @returns {{fixture: object, state: object, messages: object[]}} the fixture bundle.
 */
export function buildFixture(name) {
  const fixture = getFixture(name);
  const sessions = sessionsFor(fixture.name);
  /*
   * R1.5.1 (T3): seed the selection so the fixture path renders the same "selected session" shape
   * real mode does, and starts with THAT session's draft rather than a shared one.
   *
   * This is a starting value, not a derivation rule: the app only ever changes it through
   * selectSessionState(), so nothing re-derives selection from list order at render time.
   */
  const state = createUiState({
    activeSessionId: sessions[0]?.id ?? null,
    // R1.5.2: a fixture can declare a selected-session load in progress.
    sessionLoading: fixture.sessionLoading === true,
    messageListStatus: fixture.sessionLoading === true ? 'loading' : 'loaded',
    draftsBySessionId: {},
    domain: fixture.domain,
    connection: fixture.connection,
    drawerOpen: fixture.drawerOpen === true,
    credentialDialogOpen: fixture.credentialDialogOpen === true,
    queueDepth: fixture.name === 'queued' ? 2 : 0,
    resync: fixture.name === 'resync' ? 'required' : 'none',
    fatal: fixture.name === 'gatewayUnavailable' ? 'gateway-unavailable' : null,
    attachments:
      fixture.name === 'uploading'
        ? [
            { id: 'a-1', name: 'diagram.png', kind: 'image', state: 'uploaded' },
            { id: 'a-2', name: 'trace.log', kind: 'file', state: 'uploading', progress: 62 },
          ]
        : fixture.name === 'uploadFailed'
          ? [
              { id: 'f-1', name: 'diagram.png', kind: 'image', state: 'uploaded' },
              { id: 'f-2', name: 'trace.log', kind: 'file', state: 'uploading', progress: 62 },
              { id: 'f-3', name: 'records.csv', kind: 'file', state: 'failed' },
            ]
          : [],
  });

  const messages = messagesFor(fixture.name);
  if (fixture.name === 'streaming') {
    state.streaming = { messageId: 'm-2', chunks: [...FIXTURE_STREAM_CHUNKS], index: 0 };
  }
  // R1.4.1: same shape, same message id, same stepping path 闁?only the chunk source differs.
  if (fixture.name === 'streamingControlled') {
    state.streaming = { messageId: 'm-2', chunks: [...CONTROLLED_STREAM_CHUNKS], index: 0 };
  }

  return { fixture, state, messages, sessions };
}

/**
 * Parse the fixture name from a URL fragment.
 *
 * Only a known fixture name is accepted. Anything else 闁?a token, a path, junk 闁?yields the
 * default, so a credential can never arrive this way.
 *
 * @param {string} hash - the location hash, with or without the leading '#'.
 * @returns {string} a valid fixture name.
 */
export function parseFixtureFromHash(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  if (raw.length === 0) return DEFAULT_FIXTURE;
  const params = new URLSearchParams(raw);
  const requested = params.get('fixture') ?? raw;
  const known = FIXTURES.some((f) => f.name === requested);
  return known ? requested : DEFAULT_FIXTURE;
}

/**
 * Advance a streaming fixture by one chunk.
 *
 * This is the DOM-only stand-in for the WebSocket protocol: it appends to ONE assistant
 * message rather than creating a message per chunk. Returns a new state.
 *
 * When the last chunk lands the stream ends, and the accumulated text is carried in
 * `streamedText` so the finalized message still shows what was streamed 闁?the alternative
 * (dropping back to the fixture's empty content) would make the reply vanish on completion.
 *
 * @param {object} state - the current state.
 * @returns {object} the next state.
 */
export function stepStreaming(state) {
  if (state.streaming === null) return state;
  const { chunks, index } = state.streaming;
  const next = Math.min(index + 1, chunks.length);
  const text = chunks.slice(0, next).join('');
  if (next >= chunks.length) {
    return { ...state, domain: 'completed', streaming: null, streamedText: text };
  }
  return { ...state, domain: 'running', streaming: { ...state.streaming, index: next } };
}

/**
 * The visible streaming text so far, or the finalized text once the stream has ended.
 *
 * @param {object} state - the current state.
 * @returns {string} the text.
 */
export function streamingText(state) {
  if (state.streaming === null) return state.streamedText ?? '';
  return state.streaming.chunks.slice(0, state.streaming.index).join('');
}



