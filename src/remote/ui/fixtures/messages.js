/**
 * Fixture data. No network, no storage, no credentials.
 *
 * The token value below is an obvious placeholder. It exists only so the credential dialog has
 * something to mask; it is never sent anywhere, never persisted, and never echoed.
 */

/** A deliberately non-secret placeholder, never a real token. */
export const FIXTURE_TOKEN_PLACEHOLDER = 'fixture-token-not-a-real-credential';

/** Sessions shown in the list and rail. */
export const FIXTURE_SESSIONS = Object.freeze([
  { id: 's-1', title: 'Refactor the supervisor stop path', status: 'running', updatedLabel: 'running 路 2 min ago' },
  { id: 's-2', title: 'Investigate the WebSocket replay ordering', status: 'completed', updatedLabel: 'completed 路 1 h ago' },
  { id: 's-3', title: 'Write the R8B static shell', status: 'running', updatedLabel: 'running 路 just now' },
  { id: 's-4', title: 'A session with a deliberately very long name that must wrap to two lines and then truncate cleanly', status: 'idle', updatedLabel: 'idle 路 yesterday' },
  { id: 's-5', title: 'Failed upload investigation', status: 'failed', updatedLabel: 'failed 路 2 d ago' },
  { id: 's-6', title: 'Journal rotation notes', status: 'completed', updatedLabel: 'completed 路 3 d ago' },
]);

/** Domain states cycled through the generated rows, so every state is represented in a long list. */
const LIST_STATES = ['running', 'completed', 'idle', 'failed', 'waiting_input', 'queued', 'cancelled', 'disconnected'];

/**
 * R1.5 -- a long session list. Fixture data only.
 *
 * Thirty rows is the minimum the R1.5 brief asks for when checking drawer scrolling, selected-row
 * visibility and that one very long title cannot dominate the drawer. Rows go through the SAME
 * production `renderSessionItem` renderer; nothing here is a parallel list implementation.
 */
export const FIXTURE_SESSIONS_MANY = Object.freeze(
  Array.from({ length: 30 }, (_, i) => {
    const status = LIST_STATES[i % LIST_STATES.length];
    // Row 7 carries the extreme title, so "one long title must not dominate" is testable in situ.
    const title = i === 7
      ? 'An extremely long session title that keeps going well past any reasonable single line and must be clamped to two lines with an ellipsis while the state dot and the recency line both stay visible'
      : `Session ${String(i + 1).padStart(2, '0')} 鈥?${status} task`;
    const ago = i === 0 ? 'just now' : i < 60 ? `${i} min ago` : `${Math.round(i / 60)} h ago`;
    return { id: `many-${i + 1}`, title, status, updatedLabel: `${status} 路 ${ago}` };
  }),
);

/** R1.5 -- no sessions at all, for the empty-list state. */
export const FIXTURE_SESSIONS_NONE = Object.freeze([]);

/**
 * The session list for a fixture.
 *
 * @param {string} name - the fixture name.
 * @returns {object[]} the sessions.
 */
/**
 * R1.5.1 (T1): rows proving the title fallback. The first has NEITHER title nor name, so it must
 * render the generic label; the second supplies only 
ame. Neither may render a raw id.
 */
export const FIXTURE_SESSIONS_UNTITLED = Object.freeze([
  { id: '9f2c41ab-77de-4c1e-9a30-0b7c5e8811aa', status: 'idle', updatedLabel: 'idle · 4 h ago' },
  { id: 'srv-name-only', name: 'Title supplied as name', status: 'running', updatedLabel: 'running · 12 min ago' },
  { id: 'srv-title-only', title: 'Title supplied directly', status: 'completed', updatedLabel: 'completed · 1 d ago' },
]);

export function sessionsFor(name) {
  if (name === 'untitledSessions') return FIXTURE_SESSIONS_UNTITLED;
  if (name === 'manySessions') return FIXTURE_SESSIONS_MANY;
  if (name === 'noSessions') return FIXTURE_SESSIONS_NONE;
  return FIXTURE_SESSIONS;
}

/** A short code sample used to prove code-block containment. */
export const FIXTURE_CODE = Object.freeze({
  language: 'bash',
  code: 'npm test -- --test-name-pattern "supervisor stop"\n# a deliberately long line to prove horizontal scrolling inside the block rather than page overflow',
});

/** R1.4.2: fenced-block samples for the user-message cases. Built from a constant, not inline
 *  backticks, so this file stays readable and the fence width is unambiguous. */
const FENCE = '```';

/** A short fenced bash block. */
export const FENCE_BASH_SHORT = `${FENCE}bash\nnpm test -- --test-name-pattern "supervisor stop"\n${FENCE}`;

/** A fenced block with a line long enough to require the horizontal overflow affordance. */
export const FENCE_BASH_LONG = `${FENCE}bash\nnpm test -- --test-name-pattern "supervisor stop"\n# a deliberately long line to prove horizontal scrolling inside the block rather than page overflow\n${FENCE}`;

/** An unterminated fence: the tokeniser must leave this as literal text and never guess a close. */
export const FENCE_UNTERMINATED = `${FENCE}bash\nnpm test -- --test-name-pattern "supervisor stop"`;

/** The assistant reply used across fixtures. */
export const FIXTURE_ASSISTANT_TEXT = 'The suite is green: 1068 tests, 0 failures.';

/** The streaming reply, revealed chunk by chunk. */
export const FIXTURE_STREAM_CHUNKS = Object.freeze([
  'Reading the supervisor stop path',
  ' and the ownership recorder',
  ' 鈥?the listener is a grandchild of the spawned wrapper,',
  ' so a tree kill can miss it once the wrapper exits.',
  ' The fix records the tree at spawn and proves the listener before READY.',
]);

/**
 * R1.4.1 鈥?a DETERMINISTIC chunk sequence for the controlled streaming fixture.
 *
 * The `streaming` fixture reveals its text on a fixed 350ms timer, which makes the intermediate
 * states (a half-formed code fence, the caret at the stream head) impossible to hold still and
 * inspect. This sequence exists so those states can be driven one chunk at a time.
 *
 * It is fixture data only. It does not change the streaming path: the controlled fixture is stepped
 * through the SAME `stepStreaming()` + `render()` production path as an ordinary stream. No parallel
 * renderer exists for it.
 *
 * The sequence deliberately opens a fenced block mid-stream (` ```bash `) and closes it two chunks
 * later, so the partially formed fence is exercised rather than assumed.
 */
export const CONTROLLED_STREAM_CHUNKS = Object.freeze([
  'Starting answer\n',
  '```bash\n',
  'echo hello',
  '\n```',
  '\nDone.',
]);

/**
 * A minimal message record.
 *
 * @param {object} fields - the message fields.
 * @returns {object} the message.
 */
function message(fields) {
  return {
    id: fields.id,
    role: fields.role,
    kind: fields.kind ?? 'normal',
    content: fields.content ?? '',
    code: fields.code ?? null,
  };
}

/**
 * The transcript for a given fixture.
 *
 * @param {string} name - the fixture name.
 * @returns {object[]} the messages.
 */
export function messagesFor(name) {
  const userAsk = message({ id: 'm-1', role: 'user', content: 'Summarise the failing test output.' });
  const assistantReply = message({ id: 'm-2', role: 'assistant', content: FIXTURE_ASSISTANT_TEXT, code: FIXTURE_CODE });
  const userAsk2 = message({ id: 'm-3', role: 'user', content: 'And the supervisor stop path?' });

  switch (name) {
    case 'empty':
    case 'authRequired':
      return [];
    case 'failed':
      return [
        userAsk,
        message({ id: 'm-f', role: 'user', kind: 'failed', content: 'Summarise the failing test output.' }),
        message({
          id: 'm-err',
          role: 'error',
          content: 'Message not sent. The connection dropped. Your draft is saved.',
        }),
      ];
    case 'streaming':
      return [userAsk, message({ id: 'm-2', role: 'assistant', kind: 'streaming', content: '' })];
    // R1.4.2: user-message fenced-code coverage. Every case the closure must prove is present here,
    // including an unterminated fence, so the device evidence exercises real content rather than one
    // happy path.
    case 'userCode':
      return [
        message({ id: 'uc-1', role: 'user', content: 'Plain user message with no code at all.' }),
        message({ id: 'uc-2', role: 'user', content: 'Short fence follows:\n' + FENCE_BASH_SHORT }),
        message({ id: 'uc-3', role: 'user', content: 'Long fence follows:\n' + FENCE_BASH_LONG }),
        message({ id: 'uc-4', role: 'user', content: 'Text before.\n' + FENCE_BASH_SHORT + '\nText after the fence.' }),
        message({ id: 'uc-5', role: 'user', content: FENCE_BASH_SHORT + '\nBetween the two fences.\n' + FENCE_BASH_SHORT }),
        message({ id: 'uc-6', role: 'user', content: 'Unterminated fence, must stay literal:\n' + FENCE_UNTERMINATED }),
      ];
    // R1.4.1: identical shape to `streaming` 鈥?the controlled fixture differs only in how it is
    // advanced, never in what it renders.
    //
    // R1.4.2: the transcript is deliberately TALLER than the viewport so the timeline genuinely
    // scrolls. The previous two-message transcript could not scroll at all, which made the
    // near-bottom follow result meaningless ("dist 0 -> 0" on an unscrollable list). Filler ids are
    // unique; only the live stream keeps id 'm-2', which is what the fixture state targets.
    case 'streamingControlled':
      return [
        userAsk,
        assistantReply,
        message({ id: 'sc-2', role: 'user', content: 'And the supervisor stop path?' }),
        message({ id: 'sc-3', role: 'assistant', content: FIXTURE_ASSISTANT_TEXT, code: FIXTURE_CODE }),
        message({ id: 'sc-4', role: 'user', content: 'Summarise the failing test output.' }),
        message({ id: 'sc-5', role: 'assistant', content: FIXTURE_ASSISTANT_TEXT, code: FIXTURE_CODE }),
        message({ id: 'sc-6', role: 'user', content: 'And the supervisor stop path?' }),
        message({ id: 'sc-7', role: 'assistant', content: FIXTURE_ASSISTANT_TEXT, code: FIXTURE_CODE }),
        message({ id: 'm-2', role: 'assistant', kind: 'streaming', content: '' }),
      ];
    case 'queued':
      return [
        userAsk,
        assistantReply,
        message({ id: 'm-4', role: 'user', kind: 'queued', content: 'Also check the restart gate.' }),
      ];
    case 'waitingInput':
      return [assistantReply];
    case 'uploading':
      return [userAsk, assistantReply];
    // R1.4.2: same transcript as `uploading`; only the attachment list differs, so the failed chip
    // is rendered by the SAME composer strip renderer.
    case 'uploadFailed':
      return [userAsk, assistantReply];
    case 'reconnecting':
    case 'resync':
      return [userAsk, assistantReply];
    case 'tabletReady':
    case 'ready':
    default:
      return [userAsk, assistantReply, userAsk2, assistantReply];
  }
}

