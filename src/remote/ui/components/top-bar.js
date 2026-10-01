/**
 * TopBar and ConnectionBadge.
 *
 * The badge has exactly six variants and none of them names a server-lifecycle action — see
 * R7-KNOWN-LIMITATION-01. A test asserts that.
 */

import { CONNECTION_LABELS } from '../state/ui-state.js';
import { renderBrandLockup, renderDisconnectedIcon, renderPanelIcon, renderSyncIcon } from './brand.js';

/**
 * Build the connection badge.
 *
 * The dot and small icon carry visual state; the accessible name keeps the full
 * state description available to assistive technology.
 *
 * @param {{connection: string}} input - the connection state.
 * @param {object} [options] - `doc`.
 * @returns {HTMLElement} the badge.
 */
export function renderConnectionBadge(input, options = {}) {
  const doc = options.doc ?? globalThis.document;
  const state = input.connection;
  const label = CONNECTION_LABELS[state] ?? 'Unknown';

  const badge = doc.createElement('span');
  badge.className = 'connection-badge';
  badge.dataset.connection = state;
  badge.setAttribute('role', 'status');
  badge.setAttribute('aria-live', 'polite');
  badge.setAttribute('aria-label', `Connection: ${label}`);

  const dot = doc.createElement('span');
  dot.className = 'connection-badge__dot';
  dot.setAttribute('aria-hidden', 'true');

  badge.append(dot);
  if (state === 'connecting' || state === 'reconnecting') {
    badge.append(renderSyncIcon({ doc }));
  } else if (state === 'gateway_unavailable') {
    badge.append(renderDisconnectedIcon({ doc }));
  } else if (state !== 'connected') {
    const text = doc.createElement('span');
    text.className = 'connection-badge__label';
    text.textContent = label; // text node only
    badge.append(text);
  }
  return badge;
}

/**
 * Build the top bar.
 *
 * @param {object} input - `title`, `connection`, `drawerOpen`.
 * @param {object} [options] - `doc`, `onToggleDrawer`.
 * @returns {HTMLElement} the top bar.
 */
export function renderTopBar(input, options = {}) {
  const doc = options.doc ?? globalThis.document;

  const bar = doc.createElement('header');
  bar.className = 'top-bar';

  const menu = doc.createElement('button');
  menu.type = 'button';
  menu.className = 'touch-target top-bar__menu';
  menu.setAttribute('aria-label', '打开聊天列表');
  menu.setAttribute('aria-expanded', String(input.drawerOpen === true));
  menu.setAttribute('aria-controls', 'session-drawer');
  menu.append(renderPanelIcon({ doc }));
  if (typeof options.onToggleDrawer === 'function') {
    menu.addEventListener('click', () => options.onToggleDrawer());
  }

  const title = doc.createElement('h1');
  title.className = 'top-bar__brand';
  title.append(renderBrandLockup({ doc }));

  const spacer = doc.createElement('div');
  spacer.className = 'top-bar__spacer';

  bar.append(menu, title, spacer, renderConnectionBadge({ connection: input.connection }, { doc }));
  return bar;
}
