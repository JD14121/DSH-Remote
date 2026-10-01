import { ApiError, ERROR_KIND } from '../api/errors.js';
import { DOMAIN_STATES } from '../state/ui-state.js';

/** Build a complete replacement before touching visible state. Never merge by text similarity. */
export function replacementFor(sessionId, session, messages) {
  if (session?.id !== sessionId || !DOMAIN_STATES.includes(session.status)
      || !Number.isSafeInteger(session.lastSequence) || session.lastSequence < 0
      || !Array.isArray(messages)) throw new ApiError(ERROR_KIND.SERVER);
  const identities = new Set();
  for (const message of messages) {
    if (!message?.id || identities.has(message.id)
        || (message.sessionId !== null && message.sessionId !== undefined && message.sessionId !== sessionId)) {
      throw new ApiError(ERROR_KIND.SERVER);
    }
    identities.add(message.id);
  }
  // REST does not expose requestId/attemptId correlation. Replacing the entire authoritative
  // timeline retires optimistic/interrupted entries without claiming that they completed.
  return {
    messages,
    messageListStatus: messages.length ? 'loaded' : 'empty',
    domain: session.status,
    queueDepth: session.queueDepth ?? 0,
    lastSequence: session.lastSequence,
    error: null,
    fatal: null,
    sessionUnavailable: false,
  };
}

/** Read all bounded history pages. DSH pagination cursors are never Gateway replay seeds. */
export async function readReplacement(client, sessionId, signal, isCurrent) {
  const session = await client.getSession(sessionId, { signal });
  if (!isCurrent()) return null;
  let messages = [];
  let beforeSequence;
  let throughSequence;
  const cursors = new Set();
  for (let pages = 0; pages < 100; pages += 1) {
    const page = await client.getMessages(sessionId, { signal, beforeSequence, throughSequence });
    if (!isCurrent()) return null;
    if (page.valid === false) throw new ApiError(ERROR_KIND.SERVER);
    messages = [...page.messages, ...messages];
    if (!page.hasMore) {
      const after = await client.getSession(sessionId, { signal });
      if (!isCurrent()) return null;
      // The two REST resources do not form a transactional snapshot. Refuse a moving Gateway
      // boundary rather than pairing newer history with an older replay watermark.
      if (after.lastSequence !== session.lastSequence || after.status !== session.status) throw new ApiError(ERROR_KIND.CONFLICT);
      return replacementFor(sessionId, after, messages);
    }
    const next = page.nextBeforeSequence;
    if (!Number.isSafeInteger(next) || next < 0 || cursors.has(next)
        || (beforeSequence !== undefined && next >= beforeSequence)) throw new ApiError(ERROR_KIND.SERVER);
    cursors.add(next);
    beforeSequence = next;
    if (throughSequence === undefined && page.throughSequence !== null) throughSequence = page.throughSequence;
  }
  throw new ApiError(ERROR_KIND.SERVER);
}
