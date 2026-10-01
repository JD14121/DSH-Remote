import { groupRunMessages } from '../activity/run-activity.js';
import { renderRunActivity } from './run-activity.js';
export { renderRunActivity } from './run-activity.js';
/**
 * Messages: UserMessage, AssistantMessage, SystemMessage, ErrorMessage, MessageTimeline.
 *
 * All content goes through the safe renderer. Nothing here inserts markup.
 */

import { renderAssistantContent } from '../rendering/render-message.js';
import { renderBranchIcon, renderClockIcon, renderCopyIcon, renderDisclosureIcon, renderUsageIcon } from './brand.js';

const PROMPT_COLLAPSE_THRESHOLD = 1200;

/**
 * Build a single message.
 *
 * @param {object} message - `id`, `role`, `kind`, `content`, `code`.
 * @param {object} [options] - `doc`, `streamingText`, `streaming`.
 * @returns {HTMLElement} the message element.
 */
export function renderMessage(message, options = {}) {
  const doc = options.doc ?? globalThis.document;
  const role = message.role;

  const element = doc.createElement('article');
  const base = role === 'user' ? 'message message--user'
    : role === 'system' ? 'message message--system'
      : role === 'error' ? 'message message--error'
        : 'message message--assistant';
  element.className = message.kind === 'streaming' ? `${base} message--streaming`
    : message.kind === 'queued' ? `${base} message--queued`
      : message.kind === 'failed' ? `${base} message--failed`
        : message.kind === 'cancelled' ? `${base} message--cancelled`
          : base;
  element.dataset.role = role;
  element.dataset.kind = String(message.kind ?? 'normal');

  // Suppress empty structural records, while allowing the explicit run activity surface.
  const visibleElement = (el) => {
    const bodies = el.querySelectorAll('.message__body');
    const hasText = Array.from(bodies).some((b) => String(b.textContent ?? '').trim().length > 0);
    /*
     * Deliberately four SIMPLE selectors rather than one comma-separated list: the test DOM stub in
     * tests/remote/r8b-dom.mjs does not implement selector lists (a list returns null there while
     * working in a real browser), which would make this guard behave differently under test than in
     * production -- exactly the kind of divergence that hid F8.
     */
    const hasStructured =
      el.querySelector('.code-block') !== null
      || el.querySelector('.attachment-chip') !== null
      || el.querySelector('.stream-cursor') !== null
      || el.querySelector('img') !== null
      || el.querySelector('.message-activity') !== null;
    return (hasText || hasStructured) ? el : null;
  };

  if (role === 'user') {
    element.setAttribute('aria-label', 'Your message');
    const body = doc.createElement('div');
    body.className = 'message__body';
    const text = String(message.content ?? '');
    if (text.length >= PROMPT_COLLAPSE_THRESHOLD) {
      const disclosure = doc.createElement('details');
      disclosure.className = 'message__prompt-disclosure';
      const summary = doc.createElement('summary');
      summary.textContent = 'Prompt';
      const fullPrompt = doc.createElement('div');
      fullPrompt.className = 'message__body';
      renderAssistantContent(fullPrompt, text, { doc });
      disclosure.append(summary, fullPrompt);
      body.append(disclosure);
      element.append(body);
      return visibleElement(element);
    }
    renderAssistantContent(body, text, { doc });
    element.append(body);
    return visibleElement(element);
  }

  // System notices stay literal text: they are operator-facing chrome, not content.
  if (role === 'system') {
    element.setAttribute('aria-label', 'System notice');
    const body = doc.createElement('div');
    body.className = 'message__body';
    const text = String(message.content ?? '');
    if (text.length >= PROMPT_COLLAPSE_THRESHOLD) {
      const disclosure = doc.createElement('details');
      disclosure.className = 'message__prompt-disclosure';
      const summary = doc.createElement('summary');
      summary.textContent = 'Prompt';
      const fullPrompt = doc.createElement('div');
      fullPrompt.className = 'message__body';
      fullPrompt.textContent = text;
      disclosure.append(summary, fullPrompt);
      body.append(disclosure);
    } else {
      body.textContent = text; // text node only
    }
    element.append(body);
    return visibleElement(element);
  }

  if (role === 'error') {
    element.setAttribute('role', 'alert');
    const body = doc.createElement('div');
    body.className = 'message__body';
    const title = doc.createElement('p');
    title.textContent = 'Message not sent';
    const detail = doc.createElement('p');
    detail.textContent = String(message.content ?? '');
    body.append(title, detail);
    element.append(body);
    return visibleElement(element);
  }

  // Assistant: markdown-subset rendered through the safe boundary.
  const isStreaming = message.streaming === true || (message.kind === 'streaming' && options.streamingActive === true);
  if (isStreaming) element.setAttribute('aria-busy', 'true');

  const body = doc.createElement('div');
  body.className = 'message__body';
  const text = message.kind === 'streaming'
    ? String(options.streamingText ?? '')
    : String(message.content ?? '');
  renderAssistantContent(body, text, { doc, code: message.kind === 'streaming' ? null : message.code,
    markdownRequested: message.markdownRequested === true });

  const activity = renderRunActivity(message, { doc });
  if (activity) element.append(activity);
  element.append(body);

  if (!isStreaming && message.kind !== 'cancelled' && message.interrupted !== true
      && typeof message.content === 'string' && message.content.trim().length > 0) {
    const actions = doc.createElement('section');
    actions.className = 'message-actions';

    const controls = doc.createElement('div');
    controls.className = 'message-actions__controls';

    const copy = doc.createElement('button');
    copy.type = 'button';
    copy.className = 'message-actions__button';
    copy.append(renderCopyIcon({ doc }));
    copy.setAttribute('aria-label', '复制回复');
    copy.addEventListener('click', async () => {
      let copied = false;
      try {
        const clipboard = doc.defaultView?.navigator?.clipboard ?? globalThis.navigator?.clipboard;
        if (typeof clipboard?.writeText === 'function') {
          await clipboard.writeText(message.content);
          copied = true;
        }
      } catch { /* Some embedded WebViews deny clipboard access even on HTTPS. */ }
      if (!copied && typeof doc.execCommand === 'function') {
        const temporary = doc.createElement('textarea');
        temporary.value = message.content;
        temporary.setAttribute('readonly', '');
        temporary.style.position = 'fixed';
        temporary.style.opacity = '0';
        doc.body?.append(temporary);
        temporary.select();
        try { copied = doc.execCommand('copy'); } catch { /* Clipboard fallback is unavailable. */ }
        temporary.remove();
      }
      if (copied) {
        copy.textContent = '✓';
        copy.setAttribute('aria-label', '已复制回复');
        globalThis.setTimeout?.(() => {
          copy.replaceChildren(renderCopyIcon({ doc }));
          copy.setAttribute('aria-label', '复制回复');
        }, 1400);
      }
    });

    const branch = doc.createElement('button');
    branch.type = 'button';
    branch.className = 'message-actions__button message-actions__button--unavailable';
    branch.append(renderBranchIcon({ doc }));
    branch.disabled = true;
    branch.setAttribute('aria-label', '分支功能尚未由 Gateway 提供');
    branch.title = '当前 Gateway 尚未提供消息分支接口';

    const disclosure = doc.createElement('button');
    disclosure.type = 'button';
    disclosure.className = 'message-actions__toggle';
    disclosure.append(renderDisclosureIcon({ doc }));
    disclosure.setAttribute('aria-label', '展开消息操作');
    disclosure.setAttribute('aria-expanded', 'false');

    const panel = doc.createElement('div');
    panel.className = 'message-actions__panel';
    panel.hidden = true;

    const usage = doc.createElement('span');
    usage.className = 'message-actions__meta message-actions__meta-label';
    usage.append(renderUsageIcon({ doc }));
    const usageText = doc.createElement('span');
    usageText.textContent = `用量 ${formatUsage(message)}`;
    usage.append(usageText);
    const usageRow = doc.createElement('div');
    usageRow.className = 'message-actions__row';
    usageRow.append(usage);

    const secondaryRow = doc.createElement('div');
    secondaryRow.className = 'message-actions__row message-actions__row--meta';
    const elapsed = doc.createElement('span');
    elapsed.className = 'message-actions__meta message-actions__meta-label';
    elapsed.append(renderClockIcon({ doc }));
    const elapsedText = doc.createElement('span');
    elapsedText.textContent = `用时 ${formatElapsed(message)}`;
    elapsed.append(elapsedText);
    const completed = doc.createElement('time');
    completed.className = 'message-actions__meta';
    const timestamp = message.created_at ?? message.createdAt;
    const parsed = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
    if (Number.isFinite(parsed)) completed.dateTime = new Date(parsed).toISOString();
    completed.textContent = `完成时间 ${formatCompletionTime(timestamp)}`;
    secondaryRow.append(elapsed, completed);

    controls.append(copy, branch, disclosure);
    panel.append(usageRow, secondaryRow);
    disclosure.addEventListener('click', () => {
      const expanded = disclosure.getAttribute('aria-expanded') === 'true';
      disclosure.setAttribute('aria-expanded', String(!expanded));
      disclosure.setAttribute('aria-label', expanded ? '展开消息操作' : '收起消息操作');
      panel.hidden = expanded;
    });
    actions.append(controls, panel);
    element.append(actions);
  }

  if (isStreaming) {
    // A caret marks the stream head on the SAME message; chunks never become new messages.
    const cursor = doc.createElement('span');
    cursor.className = 'stream-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    body.append(cursor);
  }

  if (message.kind === 'cancelled') {
    const marker = doc.createElement('p');
    marker.className = 'message__body';
    marker.textContent = 'Cancelled';
    element.append(marker);
  }

  if (message.interrupted === true) {
    const marker = doc.createElement('p');
    marker.className = 'message__body';
    marker.textContent = 'Interrupted';
    element.append(marker);
  }

  return visibleElement(element);
}

function formatUsage(message) {
  const usage = message.usage ?? message.tokenUsage ?? null;
  if (typeof usage === 'number' && Number.isFinite(usage)) return `${compactTokenCount(usage)} tok`;
  const total = usage?.totalTokens ?? usage?.total_tokens ?? message.totalTokens ?? message.total_tokens;
  return typeof total === 'number' && Number.isFinite(total) ? `${compactTokenCount(total)} tok` : '—';
}

function compactTokenCount(value) {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatElapsed(message) {
  const raw = message.durationMs ?? message.duration_ms ?? message.elapsedMs ?? message.elapsed_ms;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return '—';
  const seconds = Math.floor(raw / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}分${seconds % 60}秒` : `${seconds}秒`;
}

function formatCompletionTime(value) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(timestamp);
}

/**
 * Build the timeline.
 *
 * @param {object[]} messages - the transcript.
 * @param {object} [options] - `doc`, `streamingText`, `showStreaming`.
 * @returns {HTMLElement} the timeline.
 */
export function renderMessageTimeline(messages, options = {}) {
  const doc = options.doc ?? globalThis.document;

  const timeline = doc.createElement('div');
  timeline.className = 'timeline';
  timeline.setAttribute('role', 'log');
  timeline.setAttribute('aria-live', 'polite');
  timeline.setAttribute('aria-label', 'Conversation');

  const inner = doc.createElement('div');
  inner.className = 'timeline__inner';

  timeline.append(inner);
  updateMessageTimeline(timeline, messages, options);
  return timeline;
}

const MESSAGE_RENDER_FIELDS = ['id','role','kind','content','code','streaming','interrupted',
  'runComplete','durationMs','createdAt','created_at','usage','markdownRequested'];

/** Reuse settled rows and reconcile the live tail without replacing the composer. */
export function updateMessageTimeline(timeline, messages, options = {}) {
  const doc = options.doc ?? timeline.ownerDocument;
  const inner = timeline.querySelector('.timeline__inner');
  const cache = options.messageCache;
  const seenSystemPrompts = new Set(), rows = [], retained = new Set();
  for (const message of groupRunMessages(messages)) {
    const content = typeof message?.content === 'string' ? message.content : '';
    const injectedPrompt = message?.role === 'system'
      || (message?.role === 'user' && message.sourceKind && message.sourceKind !== 'user');
    if (injectedPrompt && content.length >= PROMPT_COLLAPSE_THRESHOLD) {
      if (seenSystemPrompts.has(content)) continue;
      seenSystemPrompts.add(content);
    }
    retained.add(message.id);
    const sources = message.activitySources ?? [message];
    const versions = sources.map(m => m.revision ?? 0);
    const values = MESSAGE_RENDER_FIELDS.map(key => message[key]);
    const prior = cache?.get(message.id);
    const reusable = prior && message.kind !== 'streaming'
      && values.every((value,i) => value === prior.values[i])
      && sources.length === prior.sources.length
      && sources.every((source,i) => source === prior.sources[i] && versions[i] === prior.versions[i]);
    const row = reusable ? prior.row : renderMessage(message, {
      doc, streamingText: options.streamingText, streamingActive: options.streamingActive === true,
    });
    if (cache && !reusable) cache.set(message.id, {row, values, sources: [...sources], versions});
    if (row !== null) rows.push(row);
  }
  if (cache) for (const key of cache.keys()) if (!retained.has(key)) cache.delete(key);
  const desired = new Set(rows);
  for (const child of [...inner.children]) if (!desired.has(child)) child.remove();
  rows.forEach((row,index) => {
    const current = inner.children[index] ?? null;
    if (current !== row) inner.insertBefore(row,current);
  });
  return timeline;
}

/**
 * Build the accessible "Load older messages" control.
 *
 * It sits above the timeline and exists only while the server says older pages
 * remain (`has_more`). While a page is in flight the button is disabled and
 * marked `aria-busy`, so a double press cannot issue two requests and assistive
 * technology is told the control is working rather than inert.
 *
 * @param {object} [input] - `loading`.
 * @param {object} [options] - `doc`, `onLoadOlder`.
 * @returns {HTMLElement} the wrapper containing the button.
 */
export function renderLoadOlderMessages(input = {}, options = {}) {
  const doc = options.doc ?? globalThis.document;
  const loading = input.loading === true;

  const wrapper = doc.createElement('div');
  wrapper.className = 'timeline__load-older';

  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'timeline__load-older-button';
  button.id = 'load-older-messages';
  button.textContent = loading ? 'Loading older messages' : 'Load older messages';
  if (loading) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  }
  if (typeof options.onLoadOlder === 'function') {
    button.addEventListener('click', () => options.onLoadOlder());
  }

  wrapper.append(button);
  return wrapper;
}
