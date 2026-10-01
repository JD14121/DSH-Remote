/**
 * Safe rendering boundary for assistant and user content.
 *
 * ## The rule
 *
 * Model and user content is **never** interpreted as markup. It reaches the DOM as text
 * DOMPurify sanitizes Markdown and KaTeX output before either is attached as a
 * DocumentFragment. Untrusted source text is never inserted as raw markup.
 *
 * Markdown is parsed locally, sanitized before it enters the DOM, and code/math
 * surfaces are converted to the app's accessible components. Remote content is
 * never trusted as HTML.
 */

import { renderCodeBlock } from './render-code-block.js';
import { marked } from '../vendor/marked/marked.esm.js';
import katex from '../vendor/katex/katex.js';
import DOMPurify from '../vendor/dompurify/purify.es.js';

/**
 * Tokenise plain content into paragraphs, breaks and inline code.
 *
 * Recognised, and nothing else:
 *   ```...```   fenced code block (must start a line)
 *   `...`       inline code
 *   blank line  paragraph break
 *
 * Everything unrecognised stays literal text.
 *
 * @param {string} text - the raw content.
 * @returns {object[]} tokens: `{type:'paragraph'|'code', ...}`.
 */
export function tokenise(text) {
  const source = String(text ?? '');
  const blocks = [];
  const lines = source.split('\n');
  let buffer = [];
  let fence = null;

  const flushParagraph = () => {
    if (buffer.length > 0) {
      blocks.push({ type: 'paragraph', text: buffer.join('\n') });
      buffer = [];
    }
  };

  for (const line of lines) {
    const fenceMatch = /^```(\w*)\s*$/.exec(line);
    if (fenceMatch !== null) {
      if (fence === null) {
        flushParagraph();
        fence = { language: fenceMatch[1] || 'text', lines: [] };
      } else {
        blocks.push({ type: 'code', language: fence.language, code: fence.lines.join('\n') });
        fence = null;
      }
      continue;
    }
    if (fence !== null) {
      fence.lines.push(line);
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    buffer.push(line);
  }

  if (fence !== null) {
    // An unterminated fence is treated as literal text rather than swallowing the rest.
    blocks.push({ type: 'paragraph', text: `\`\`\`${fence.language}\n${fence.lines.join('\n')}` });
  }
  flushParagraph();
  return blocks;
}

/**
 * Append a paragraph, honouring inline code and hard line breaks.
 *
 * @param {HTMLElement} parent - where to append.
 * @param {string} text - the paragraph text.
 * @param {Document} doc - the document to create nodes with.
 * @returns {void}
 */
function appendParagraph(parent, text, doc) {
  const paragraph = doc.createElement('p');
  // Split on inline code spans; the odd indices are code.
  const parts = String(text).split(/`([^`]*)`/);
  parts.forEach((part, index) => {
    if (part === '') return;
    if (index % 2 === 1) {
      const code = doc.createElement('code');
      code.textContent = part; // text node only
      paragraph.append(code);
      return;
    }
    const segments = part.split('\n');
    segments.forEach((segment, segmentIndex) => {
      if (segmentIndex > 0) paragraph.append(doc.createElement('br'));
      if (segment !== '') paragraph.append(doc.createTextNode(segment));
    });
  });
  parent.append(paragraph);
}

/**
 * Render untrusted content into a container, safely.
 *
 * @param {HTMLElement} container - the element to fill. Its children are replaced.
 * @param {string} content - the raw content.
 * @param {object} [options] - `doc`, `code` ({language, code}) appended after the text.
 * @returns {HTMLElement} the container.
 */
export function renderAssistantContent(container, content, options = {}) {
  const doc = options.doc ?? container.ownerDocument;
  container.replaceChildren();

  const source = String(content ?? '');
  const html = marked.parse(source, { gfm: true, breaks: true, async: false });
  const fragment = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true });
  container.append(fragment);

  // Replace generated fenced blocks with the existing mobile code surface. Its
  // text is read from sanitized DOM and reinserted only through textContent.
  for (const pre of [...container.querySelectorAll('pre')]) {
    const code = pre.querySelector('code');
    const languageClass = [...(code?.classList ?? [])].find((name) => name.startsWith('language-'));
    const language = languageClass?.slice('language-'.length) || 'text';
    pre.replaceWith(renderCodeBlock({ language, code: code?.textContent ?? pre.textContent }, { doc }));
  }

  renderMathText(container, doc);

  if (options.markdownRequested === true && source.trim().length > 0) {
    const label = doc.createElement('span');
    label.className = 'message__format-label';
    label.textContent = 'Markdown';
    container.insertBefore(label, container.firstChild);
  }

  if (options.code) {
    container.append(renderCodeBlock(options.code, { doc }));
  }
  return container;
}

/**
 * Render common inline and display LaTeX delimiters in text nodes. Code and
 * links are excluded. KaTeX runs with trust disabled and its HTML/MathML is
 * sanitized before it is attached.
 */
function renderMathText(container, doc) {
  if (typeof doc.createTreeWalker !== 'function') return;
  const showText = globalThis.NodeFilter?.SHOW_TEXT ?? 4;
  const walker = doc.createTreeWalker(container, showText);
  const textNodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('code, pre, a, .katex')) continue;
    textNodes.push(node);
  }
  const pattern = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^\n$]+?)\$/g;
  for (const node of textNodes) {
    const text = node.nodeValue ?? '';
    pattern.lastIndex = 0;
    const matches = [...text.matchAll(pattern)];
    if (matches.length === 0) continue;
    const parent = node.parentNode;
    let cursor = 0;
    for (const match of matches) {
      if (match.index > cursor) parent.insertBefore(doc.createTextNode(text.slice(cursor, match.index)), node);
      const formula = match[1] ?? match[2] ?? match[3] ?? match[4];
      const displayMode = match[1] !== undefined || match[2] !== undefined;
      const surface = doc.createElement(displayMode ? 'div' : 'span');
      surface.className = displayMode ? 'math-block' : 'math-inline';
      const label = doc.createElement('span');
      label.className = 'message__format-label';
      label.textContent = 'LaTeX';
      surface.append(label);
      try {
        const rendered = katex.renderToString(formula, {
          displayMode,
          throwOnError: false,
          trust: false,
          output: 'htmlAndMathml',
          strict: 'ignore',
        });
        surface.append(DOMPurify.sanitize(rendered, { RETURN_DOM_FRAGMENT: true }));
      } catch {
        surface.textContent = match[0];
      }
      parent.insertBefore(surface, node);
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) parent.insertBefore(doc.createTextNode(text.slice(cursor)), node);
    node.remove();
  }
}

/**
 * Render content as PLAIN TEXT blocks plus fenced code blocks.
 *
 * R1.4.2: deliberately NARROWER than renderAssistantContent(). It lifts out fenced code only —
 * there are no inline-code spans and no other markup — so enabling it for user messages cannot
 * switch on rich Markdown as a side effect.
 *
 * The code path is shared, not duplicated: it uses the same `tokenise()` and the same
 * `renderCodeBlock()` (and therefore the same `.code-block` DOM, Copy control and horizontal
 * overflow affordance) as an assistant message.
 *
 * @param {HTMLElement} container - the element to fill. Its children are replaced.
 * @param {string} content - the raw content.
 * @param {object} [options] - `doc`.
 * @returns {HTMLElement} the container.
 */
export function renderPlainTextWithCode(container, content, options = {}) {
  const doc = options.doc ?? container.ownerDocument;
  container.replaceChildren();

  for (const block of tokenise(content)) {
    if (block.type === 'code') {
      container.append(renderCodeBlock({ language: block.language, code: block.code }, { doc }));
    } else {
      const paragraph = doc.createElement('p');
      paragraph.textContent = String(block.text ?? ''); // text node only
      container.append(paragraph);
    }
  }
  return container;
}

/**
 * Render a short single-line string (a label, a title) as text.
 *
 * @param {HTMLElement} element - the target element.
 * @param {string} text - the text.
 * @returns {HTMLElement} the element.
 */
export function renderText(element, text) {
  element.textContent = String(text ?? '');
  return element;
}
