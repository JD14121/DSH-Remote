/**
 * SessionDrawer: the mobile overlay that hosts the session list.
 *
 * It exists only below 768px; at tablet width the SAME SessionList component is rendered into
 * the persistent rail instead, so the responsive change is layout-only.
 *
 * It contains no lifecycle control of any kind.
 */

import { renderSessionList } from './session-item.js';
import { renderEmptyState } from './empty-state.js';
import { renderBrandLockup, renderGearIcon, renderNewSessionIcon, renderPanelIcon } from './brand.js';

/**
 * Build the drawer.
 *
 * @param {object} input - `open`, `sessions`, `activeId`, `newSessionDisabled`.
 * @param {object} [options] - `doc`, `onClose`, `onSelect`, `onRename`, `onDelete`, `onNewSession`, `onCreateInWorkspace`, `onSettings`.
 * @returns {{scrim: HTMLElement|null, drawer: HTMLElement}} the drawer parts.
 */
export function renderSessionDrawer(input, options = {}) {
  const doc = options.doc ?? globalThis.document;

  const drawer = doc.createElement('aside');
  drawer.className = 'drawer';
  drawer.id = 'session-drawer';
  drawer.dataset.state = input.open === true ? 'open' : 'closed';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  drawer.setAttribute('aria-label', 'Sessions');

  const header = doc.createElement('div');
  header.className = 'top-bar';
  header.classList.add('drawer__brand-header');
  const brand = renderBrandLockup({ doc });
  const close = doc.createElement('button');
  close.type = 'button';
  close.className = 'touch-target drawer__close';
  close.setAttribute('aria-label', '关闭聊天列表');
  close.setAttribute('aria-expanded', 'true');
  close.setAttribute('aria-controls', 'session-drawer');
  close.append(renderPanelIcon({ doc }));
  if (typeof options.onClose === 'function') close.addEventListener('click', () => options.onClose());
  header.append(brand, close);

  /*
   * NewSessionButton: a real control.
   *
   * Session creation is implemented end to end now: the Gateway exposes an
   * authenticated `POST /api/v1/sessions` that invokes DSH `session/create`. A
   * workspace-row plus sends only its opaque inventory key; the Gateway resolves
   * that key to DSH-reported workspace data. The global control leaves workspace
   * selection to DSH. No phone-supplied path or session id is forwarded. The control
   * is therefore enabled and wired to `onNewSession`; it is disabled only while a
   * create is already in flight (`newSessionDisabled`), so a double press cannot
   * create two sessions.
   */
  const newSession = doc.createElement('button');
  newSession.type = 'button';
  newSession.className = 'session-item session-item--new';
  newSession.id = 'new-session';
  newSession.setAttribute('aria-label', '新会话');
  if (input.newSessionDisabled === true) {
    newSession.disabled = true;
    newSession.setAttribute('aria-disabled', 'true');
  }
  const newIcon = renderNewSessionIcon({ doc });
  const newLabel = doc.createElement('span');
  newLabel.className = 'session-item__title';
  newLabel.textContent = '新会话';
  newSession.append(newIcon, newLabel);
  if (typeof options.onNewSession === 'function') {
    newSession.addEventListener('click', () => options.onNewSession());
  }

  const listHost = doc.createElement('div');
  listHost.className = 'session-list-host';
  listHost.style.display = 'flex';
  listHost.style.flexDirection = 'column';
  listHost.style.minHeight = '0';
  listHost.style.flex = '1 1 auto';
  if (input.sessions.length === 0) {
    listHost.append(renderEmptyState({
      variant: 'no-sessions',
      title: 'No sessions yet',
      body: 'Sessions appear here once DSH has one.',
    }, { doc }));
  } else {
    listHost.append(renderSessionList(input.sessions, {
      doc,
      activeId: input.activeId,
      createInWorkspaceDisabled: input.newSessionDisabled === true,
      onSelect: options.onSelect,
      onRename: options.onRename,
      onDelete: options.onDelete,
      onArchiveWorkspace: options.onArchiveWorkspace,
      onCreateInWorkspace: options.onCreateInWorkspace,
    }));
  }

  const footer = doc.createElement('div');
  footer.className = 'drawer__footer';
  const settings = doc.createElement('button');
  settings.type = 'button';
  settings.className = 'session-item drawer__settings-entry';
  settings.setAttribute('aria-label', '设置');
  settings.addEventListener('click', () => options.onSettings?.());
  settings.append(renderGearIcon({ doc }));
  const settingsBody = doc.createElement('span');
  settingsBody.className = 'session-item__body';
  const settingsLabel = doc.createElement('span');
  settingsLabel.className = 'session-item__title';
  settingsLabel.textContent = '设置';
  settingsBody.append(settingsLabel);
  settings.append(settingsBody);
  footer.append(settings);

  drawer.append(header, newSession, listHost, footer);

  let scrim = null;
  if (input.open === true) {
    scrim = doc.createElement('div');
    scrim.className = 'drawer-scrim';
    scrim.setAttribute('aria-hidden', 'true');
    if (typeof options.onClose === 'function') {
      scrim.addEventListener('click', () => options.onClose());
    }
  }

  return { scrim, drawer };
}
