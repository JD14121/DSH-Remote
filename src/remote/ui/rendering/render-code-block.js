/**
 * Code block renderer: language label, copy button, internal horizontal scrolling.
 *
 * The block scrolls inside its own container so a long line never widens the page, and the copy
 * control keeps a 44px target even though its glyph is smaller.
 *
 * Content reaches the DOM as a text node only.
 *
 * R1.4: the scroll container was already correct -- a long line is *reachable*, never truncated --
 * but it was **undiscoverable**. On a real 360px phone a 99-character line left 480px of code
 * off-screen with no visible scrollbar (Android WebView only paints overlay scrollbars while
 * actively scrolling), no fade and no hint, so the line appeared to simply stop mid-token.
 *
 * The fix is an affordance, not a layout change:
 *   - a right-edge fade while more content exists to the right, removed once the end is reached;
 *   - the scroll container is focusable and labelled, so it is keyboard-scrollable and announced.
 *
 * The header (language + Copy) sits OUTSIDE both the scroll area and the fade, so it stays visible
 * at every scroll position.
 */

/** How long the Copy control confirms before reverting. */
const COPY_FEEDBACK_MS = 1500;

/**
 * Build a code block element.
 *
 * @param {{language?: string, code?: string}} input - the block content.
 * @param {object} [options] - `doc`.
 * @returns {HTMLElement} the block.
 */
export function renderCodeBlock(input, options = {}) {
  const doc = options.doc ?? globalThis.document;
  const language = input.language && input.language.length > 0 ? input.language : 'text';
  const code = String(input.code ?? '');

  const block = doc.createElement('div');
  block.className = 'code-block';
  block.dataset.language = language;

  const head = doc.createElement('div');
  head.className = 'code-block__head';

  const label = doc.createElement('span');
  label.className = 'code-block__lang';
  label.textContent = language; // text node only

  const copy = doc.createElement('button');
  copy.type = 'button';
  copy.className = 'code-block__copy';
  copy.textContent = 'Copy';
  copy.setAttribute('aria-label', `Copy ${language} code`);
  // The label swap is the only confirmation, so it must be announced, not just seen.
  copy.setAttribute('aria-live', 'polite');
  copy.addEventListener('click', () => {
    copy.textContent = 'Copied';
    copy.setAttribute('aria-label', `Copied ${language} code`);
    // The clipboard is a browser capability, not a network call. Failure is non-fatal.
    try {
      void globalThis.navigator?.clipboard?.writeText?.(code);
    } catch {
      /* clipboard unavailable in this context - the label still confirms the intent */
    }
    globalThis.setTimeout?.(() => {
      copy.textContent = 'Copy';
      copy.setAttribute('aria-label', `Copy ${language} code`);
    }, COPY_FEEDBACK_MS);
  });

  head.append(label, copy);

  // The viewport exists so the fade can be pinned to the visible edge. The scroll container cannot
  // carry it itself: a pseudo-element inside a scroller scrolls away with the content.
  const viewport = doc.createElement('div');
  viewport.className = 'code-block__viewport';

  const scroll = doc.createElement('div');
  scroll.className = 'code-block__scroll';
  // Keyboard-scrollable and announced: the overflow must be reachable without touch too.
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', `${language} code, scrollable horizontally`);

  const pre = doc.createElement('pre');
  pre.textContent = code; // text node only - never markup

  scroll.append(pre);
  viewport.append(scroll);
  block.append(head, viewport);

  /*
   * Track whether content remains off-screen so CSS can show the fade at the right moment and drop
   * it once the reader reaches the end. `data-overflow` is the only state involved; nothing about
   * the layout changes.
   */
  const syncOverflow = () => {
    const remaining = scroll.scrollWidth - scroll.clientWidth - scroll.scrollLeft;
    block.dataset.overflow = scroll.scrollWidth > scroll.clientWidth + 1
      ? (remaining > 1 ? 'more' : 'end')
      : 'none';
  };
  scroll.addEventListener('scroll', syncOverflow, { passive: true });
  // Measured after layout, and re-measured when a rotation changes the wrapping.
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(syncOverflow);
  } else {
    syncOverflow();
  }
  if (typeof globalThis.addEventListener === 'function') {
    const onResize = () => {
      if (!block.isConnected) { globalThis.removeEventListener('resize', onResize); return; }
      syncOverflow();
    };
    globalThis.addEventListener('resize', onResize);
  }

  return block;
}
