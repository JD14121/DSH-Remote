/** Session rows shared by the mobile drawer and tablet rail. */

import { renderMoreIcon, renderWorkspaceIcon, renderWorkspacePlusIcon } from './brand.js';

const ACTION_WIDTH = 176;

export function renderSessionItem(session, options = {}) {
  const doc = options.doc ?? globalThis.document;
  const item = doc.createElement('li');
  item.className = 'session-list__item';
  item.dataset.sessionId = String(session.id ?? '');

  const track = doc.createElement('div');
  track.className = 'session-item__track';
  const actions = doc.createElement('div');
  actions.className = 'session-item__actions';

  const rename = doc.createElement('button');
  rename.type = 'button';
  rename.className = 'session-item__rename';
  rename.textContent = 'Rename';
  rename.disabled = typeof options.onRename !== 'function';

  const remove = doc.createElement('button');
  remove.type = 'button';
  remove.className = 'session-item__delete';
  remove.textContent = 'Delete';
  remove.disabled = typeof options.onDelete !== 'function';
  const rawTitle = String(session.title ?? '').trim();
  remove.setAttribute('aria-label', `Delete ${rawTitle || 'session'}`);
  actions.append(rename, remove);

  const confirmation = doc.createElement('div');
  confirmation.className = 'session-delete-confirm';
  confirmation.hidden = true;
  confirmation.setAttribute('role', 'alertdialog');
  confirmation.setAttribute('aria-modal', 'true');
  confirmation.setAttribute('aria-label', 'Confirm session deletion');
  const confirmationPanel = doc.createElement('div');
  confirmationPanel.className = 'session-delete-confirm__panel';
  const confirmationText = doc.createElement('p');
  confirmationText.textContent = `从列表删除“${rawTitle || 'Untitled session'}”？DSH 会将此会话归档，历史记录仍会保留。`;
  const confirmationButtons = doc.createElement('div');
  confirmationButtons.className = 'session-delete-confirm__actions';
  const cancelDelete = doc.createElement('button');
  cancelDelete.type = 'button';
  cancelDelete.textContent = 'Cancel';
  const confirmDelete = doc.createElement('button');
  confirmDelete.type = 'button';
  confirmDelete.className = 'session-delete-confirm__delete';
  confirmDelete.textContent = 'Delete';
  confirmationButtons.append(cancelDelete, confirmDelete);
  confirmationPanel.append(confirmationText, confirmationButtons);
  confirmation.append(confirmationPanel);

  const surface = doc.createElement('div');
  surface.className = 'session-item__surface';
  const row = doc.createElement('button');
  row.type = 'button';
  row.className = 'session-item';
  row.setAttribute('aria-current', options.active === true ? 'true' : 'false');

  const body = doc.createElement('span');
  body.className = 'session-item__body';
  const title = doc.createElement('span');
  title.className = 'session-item__title';
  title.textContent = rawTitle || 'Untitled session';
  const meta = doc.createElement('span');
  meta.className = 'session-item__meta';
  meta.textContent = String(session.updatedLabel ?? '');
  body.append(title, meta);
  row.append(body);
  if (typeof options.onSelect === 'function') row.addEventListener('click', () => options.onSelect(session));

  const editor = doc.createElement('form');
  editor.className = 'session-item__editor';
  editor.hidden = true;
  const field = doc.createElement('input');
  field.type = 'text';
  field.value = rawTitle;
  field.maxLength = 256;
  field.setAttribute('aria-label', 'Session name');
  const save = doc.createElement('button');
  save.type = 'submit';
  save.textContent = 'Save';
  const error = doc.createElement('span');
  error.className = 'session-item__edit-error';
  error.setAttribute('role', 'status');
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => { editor.hidden = true; row.hidden = false; });
  editor.append(field, save, cancel, error);

  let offset = 0;
  let pointerStart = null;
  let suppressClick = false;
  const setOffset = (value, animate = true) => {
    offset = Math.max(0, Math.min(ACTION_WIDTH, value));
    surface.classList.toggle('is-open', offset > 0);
    surface.style.transition = animate ? '' : 'none';
    surface.style.transform = `translateX(${offset}px)`;
    const open = offset >= ACTION_WIDTH / 2;
    rename.tabIndex = open ? 0 : -1;
    remove.tabIndex = open ? 0 : -1;
    track.dataset.actions = open ? 'open' : 'closed';
  };
  setOffset(0);
  row.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') { event.preventDefault(); setOffset(ACTION_WIDTH); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); setOffset(0); }
  });
  row.addEventListener('pointerdown', (event) => {
    pointerStart = { x: event.clientX, offset };
    try { row.setPointerCapture?.(event.pointerId); } catch { /* capture is optional */ }
  });
  row.addEventListener('pointermove', (event) => {
    if (!pointerStart) return;
    const delta = event.clientX - pointerStart.x;
    if (Math.abs(delta) > 8) suppressClick = true;
    if (suppressClick) {
      event.preventDefault();
      setOffset(pointerStart.offset + delta, false);
    }
  });
  const finishSwipe = () => {
    if (!pointerStart) return;
    pointerStart = null;
    setOffset(offset >= ACTION_WIDTH / 2 ? ACTION_WIDTH : 0);
    if (suppressClick) setTimeout(() => { suppressClick = false; }, 0);
  };
  row.addEventListener('pointerup', finishSwipe);
  row.addEventListener('pointercancel', finishSwipe);
  row.addEventListener('click', (event) => {
    if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);

  rename.addEventListener('click', () => {
    setOffset(0);
    row.hidden = true;
    editor.hidden = false;
    field.focus?.();
    field.select?.();
  });
  editor.addEventListener('submit', async (event) => {
    event.preventDefault();
    const proposed = field.value.trim();
    if (!proposed || typeof options.onRename !== 'function') return;
    save.disabled = true;
    error.textContent = '';
    try {
      const result = await options.onRename(session, proposed);
      if (result?.error) {
        const currentItem = [...doc.querySelectorAll('.session-list__item')]
          .find((candidate) => candidate.dataset.sessionId === String(session.id)) ?? item;
        const currentEditor = currentItem.querySelector('.session-item__editor');
        const currentError = currentEditor?.querySelector('.session-item__edit-error');
        if (currentError) {
          currentEditor.hidden = false;
          const currentRow = currentItem.querySelector('.session-item');
          if (currentRow) currentRow.hidden = true;
          currentError.textContent = result.error.message || 'Rename failed. Check the connection and title.';
        } else {
          error.textContent = result.error.message || 'Rename failed. Check the connection and title.';
        }
        return;
      }
      editor.hidden = true;
      row.hidden = false;
    } finally {
      save.disabled = false;
    }
  });

  remove.addEventListener('click', () => {
    if (typeof options.onDelete !== 'function') return;
    confirmation.hidden = false;
    confirmDelete.focus?.();
  });
  cancelDelete.addEventListener('click', () => { confirmation.hidden = true; remove.focus?.(); });
  confirmation.addEventListener('click', (event) => {
    if (event.target === confirmation) confirmation.hidden = true;
  });
  confirmDelete.addEventListener('click', async () => {
    if (typeof options.onDelete !== 'function') return;
    confirmDelete.disabled = true;
    confirmationText.textContent = '正在归档会话…';
    const result = await options.onDelete(session);
    confirmDelete.disabled = false;
    if (!result?.error) return;
    confirmationText.textContent = result.error.message || 'Delete failed. Check the connection and try again.';
    confirmDelete.textContent = 'Retry';
    confirmation.hidden = false;
    return;
  });

  surface.append(row, editor);
  track.append(actions, surface);
  item.append(track, confirmation);
  return item;
}

export function renderSessionList(sessions, options = {}) {
  const doc = options.doc ?? globalThis.document;
  const status = options.status ?? (sessions.length === 0 ? 'empty' : 'loaded');
  const list = doc.createElement('ul');
  list.className = 'session-list';
  list.dataset.status = status;
  list.setAttribute('role', 'list');
  list.setAttribute('aria-label', 'Sessions');
  if (status === 'loading') {
    list.setAttribute('aria-busy', 'true');
    for (let i = 0; i < 4; i += 1) {
      const item = doc.createElement('li');
      const skeleton = doc.createElement('div');
      skeleton.className = 'skeleton';
      item.append(skeleton);
      list.append(item);
    }
    return list;
  }
  const groups = new Map();
  for (const session of sessions) {
    const key = session.workspaceKey ?? '__unassigned__';
    const group = groups.get(key) ?? {
      key,
      label: session.workspaceKey === null || session.workspaceKey === undefined
        ? '未分组'
        : (session.workspaceLabel || '未命名工作区'),
      sessions: [],
    };
    group.sessions.push(session);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const groupItem = doc.createElement('li');
    groupItem.className = 'workspace-group';
    groupItem.dataset.workspaceKey = group.key;
    const groupKey = `dsh-remote.workspace-expanded.${group.key}`;
    const aliasKey = `dsh-remote.workspace-label.${group.key}`;
    const storage = options.storage ?? (() => {
      try { return globalThis.localStorage ?? null; } catch { return null; }
    })();
    let displayLabel = group.label;
    try {
      const savedAlias = storage?.getItem(aliasKey)?.trim();
      if (savedAlias) displayLabel = savedAlias;
    } catch { /* phone-only alias is an optional local preference */ }
    const containsActive = group.sessions.some((session) => session.id === options.activeId);
    let expanded = containsActive;
    try {
      const saved = storage?.getItem(groupKey);
      if (!containsActive && (saved === 'true' || saved === 'false')) expanded = saved === 'true';
    } catch { /* storage can be unavailable in private WebViews */ }

    const heading = doc.createElement('div');
    heading.className = 'workspace-group__heading';
    const toggle = doc.createElement('button');
    toggle.type = 'button';
    toggle.className = 'workspace-group__toggle';
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.setAttribute('aria-label', `${expanded ? '收起' : '展开'}工作区 ${displayLabel}`);
    const iconState = expanded ? (containsActive ? 'active' : 'open') : 'closed';
    toggle.append(renderWorkspaceIcon(iconState, { doc }));
    const label = doc.createElement('span');
    label.className = 'workspace-group__label';
    label.textContent = displayLabel;
    toggle.append(label);

    const actions = doc.createElement('div');
    actions.className = 'workspace-group__actions';
    const more = doc.createElement('button');
    more.type = 'button';
    more.className = 'workspace-group__action';
    more.setAttribute('aria-label', `工作区 ${group.label} 更多操作`);
    more.setAttribute('aria-expanded', 'false');
    more.append(renderMoreIcon({ doc }));
    const menu = doc.createElement('div');
    menu.className = 'workspace-group__menu';
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    const renameWorkspace = doc.createElement('button');
    renameWorkspace.type = 'button';
    renameWorkspace.textContent = '重命名工作区';
    renameWorkspace.setAttribute('role', 'menuitem');
    const deleteWorkspace = doc.createElement('button');
    deleteWorkspace.type = 'button';
    deleteWorkspace.disabled = typeof options.onArchiveWorkspace !== 'function' || group.key === '__unassigned__';
    deleteWorkspace.textContent = '归档并移除分组';
    deleteWorkspace.setAttribute('role', 'menuitem');
    renameWorkspace.disabled = group.key === '__unassigned__';
    menu.append(renameWorkspace, deleteWorkspace);
    more.addEventListener('click', () => {
      menu.hidden = !menu.hidden;
      more.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true');
    });
    const create = doc.createElement('button');
    create.type = 'button';
    create.className = 'workspace-group__action';
    create.disabled = typeof options.onCreateInWorkspace !== 'function' || options.createInWorkspaceDisabled === true;
    create.setAttribute('aria-label', `在工作区 ${group.label} 新建对话`);
    create.title = `在 ${group.label} 中创建新会话`;
    create.append(renderWorkspacePlusIcon({ doc }));
    if (typeof options.onCreateInWorkspace === 'function') {
      create.addEventListener('click', () => options.onCreateInWorkspace(group.key));
    }
    actions.append(more, create);
    heading.append(menu);
    heading.append(toggle, actions);

    const renameDialog = doc.createElement('div');
    renameDialog.className = 'session-delete-confirm workspace-group__dialog';
    renameDialog.hidden = true;
    renameDialog.setAttribute('role', 'dialog');
    renameDialog.setAttribute('aria-modal', 'true');
    renameDialog.setAttribute('aria-label', '重命名手机端分组');
    const renamePanel = doc.createElement('div');
    renamePanel.className = 'session-delete-confirm__panel';
    const renameTitle = doc.createElement('p');
    renameTitle.textContent = '仅修改手机端显示名称；电脑端工作区名称和路径不会改变。';
    const renameForm = doc.createElement('form');
    renameForm.className = 'workspace-group__rename-form';
    const renameField = doc.createElement('input');
    renameField.type = 'text';
    renameField.maxLength = 80;
    renameField.value = displayLabel;
    renameField.setAttribute('aria-label', '手机端分组名称');
    const renameError = doc.createElement('span');
    renameError.className = 'session-item__edit-error';
    renameError.setAttribute('role', 'status');
    const renameButtons = doc.createElement('div');
    renameButtons.className = 'session-delete-confirm__actions';
    const cancelRename = doc.createElement('button');
    cancelRename.type = 'button';
    cancelRename.textContent = '取消';
    const saveRename = doc.createElement('button');
    saveRename.type = 'submit';
    saveRename.textContent = '保存别名';
    renameButtons.append(cancelRename, saveRename);
    renameForm.append(renameField, renameError, renameButtons);
    renamePanel.append(renameTitle, renameForm);
    renameDialog.append(renamePanel);

    const archiveDialog = doc.createElement('div');
    archiveDialog.className = 'session-delete-confirm workspace-group__dialog';
    archiveDialog.hidden = true;
    archiveDialog.setAttribute('role', 'alertdialog');
    archiveDialog.setAttribute('aria-modal', 'true');
    archiveDialog.setAttribute('aria-label', '确认归档工作区会话');
    const archivePanel = doc.createElement('div');
    archivePanel.className = 'session-delete-confirm__panel';
    const archiveText = doc.createElement('p');
    archiveText.textContent = `将归档“${displayLabel}”分组中的 ${group.sessions.length} 个会话，并从手机列表移除该分组。电脑上的工作区文件夹和文件会保留。`;
    const archiveError = doc.createElement('span');
    archiveError.className = 'session-item__edit-error';
    archiveError.setAttribute('role', 'status');
    const archiveButtons = doc.createElement('div');
    archiveButtons.className = 'session-delete-confirm__actions';
    const cancelArchive = doc.createElement('button');
    cancelArchive.type = 'button';
    cancelArchive.textContent = '取消';
    const confirmArchive = doc.createElement('button');
    confirmArchive.type = 'button';
    confirmArchive.className = 'session-delete-confirm__delete';
    confirmArchive.textContent = '归档会话';
    archiveButtons.append(cancelArchive, confirmArchive);
    archivePanel.append(archiveText, archiveError, archiveButtons);
    archiveDialog.append(archivePanel);

    renameWorkspace.addEventListener('click', () => {
      menu.hidden = true;
      more.setAttribute('aria-expanded', 'false');
      renameError.textContent = '';
      renameField.value = displayLabel;
      renameDialog.hidden = false;
      renameField.focus?.();
      renameField.select?.();
    });
    cancelRename.addEventListener('click', () => { renameDialog.hidden = true; more.focus?.(); });
    renameDialog.addEventListener('click', (event) => { if (event.target === renameDialog) renameDialog.hidden = true; });
    renameForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const nextLabel = renameField.value.trim();
      if (!nextLabel) { renameError.textContent = '名称不能为空。'; return; }
      try {
        if (typeof storage?.setItem !== 'function') throw new Error('local storage unavailable');
        storage?.setItem(aliasKey, nextLabel);
        displayLabel = nextLabel;
        for (const candidate of doc.querySelectorAll('.workspace-group')) {
          if (candidate.dataset.workspaceKey !== group.key) continue;
          const candidateLabel = candidate.querySelector('.workspace-group__label');
          if (candidateLabel) candidateLabel.textContent = nextLabel;
          const candidateToggle = candidate.querySelector('.workspace-group__toggle');
          if (candidateToggle) {
            candidateToggle.setAttribute('aria-label', `${expanded ? '收起' : '展开'}工作区 ${nextLabel}`);
            candidateToggle.title = nextLabel;
          }
          const candidateMore = candidate.querySelector('.workspace-group__action[aria-label*="更多操作"]');
          candidateMore?.setAttribute('aria-label', `工作区 ${nextLabel} 更多操作`);
          const candidateCreate = candidate.querySelector('.workspace-group__action[aria-label*="新建对话"]');
          candidateCreate?.setAttribute('aria-label', `在工作区 ${nextLabel} 新建对话`);
          if (candidateCreate) candidateCreate.title = `在 ${nextLabel} 中创建新会话`;
        }
      } catch {
        renameError.textContent = '无法保存手机端别名，请检查本机存储空间。';
        return;
      }
      renameDialog.hidden = true;
    });
    deleteWorkspace.addEventListener('click', () => {
      if (typeof options.onArchiveWorkspace !== 'function') return;
      menu.hidden = true;
      more.setAttribute('aria-expanded', 'false');
      archiveError.textContent = '';
      archiveDialog.hidden = false;
      confirmArchive.focus?.();
    });
    cancelArchive.addEventListener('click', () => { archiveDialog.hidden = true; more.focus?.(); });
    archiveDialog.addEventListener('click', (event) => { if (event.target === archiveDialog) archiveDialog.hidden = true; });
    confirmArchive.addEventListener('click', async () => {
      if (typeof options.onArchiveWorkspace !== 'function') return;
      confirmArchive.disabled = true;
      archiveError.textContent = '正在归档会话…';
      try {
        const result = await options.onArchiveWorkspace(group.key);
        if (result?.error) {
          archiveError.textContent = result.error.message || '归档失败；刷新后可重试。';
          return;
        }
        if (result?.partial === true) {
          archiveError.textContent = '部分会话已归档。列表已刷新；请确认剩余会话后再次操作。';
          return;
        }
        if (result?.archivedSessionIds?.length > 0) {
          try { storage?.removeItem(aliasKey); } catch { /* alias cleanup is optional */ }
        }
        archiveDialog.hidden = true;
      } finally {
        confirmArchive.disabled = false;
        if (!archiveDialog.hidden && archiveError.textContent === '正在归档会话…') archiveError.textContent = '归档未完成，请刷新后重试。';
      }
    });

    const children = doc.createElement('ul');
    children.className = 'workspace-group__sessions';
    children.hidden = !expanded;
    children.setAttribute('aria-label', `${group.label} 中的会话`);
    for (const session of group.sessions) {
      children.append(renderSessionItem(session, {
        doc,
        active: session.id === options.activeId,
        onSelect: options.onSelect,
        onRename: options.onRename,
        onDelete: options.onDelete,
      }));
    }
    const updateExpanded = (next) => {
      expanded = next;
      children.hidden = !expanded;
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggle.setAttribute('aria-label', `${expanded ? '收起' : '展开'}工作区 ${displayLabel}`);
      toggle.replaceChildren(renderWorkspaceIcon(expanded ? (containsActive ? 'active' : 'open') : 'closed', { doc }), label);
      try { storage?.setItem(groupKey, expanded ? 'true' : 'false'); } catch { /* optional preference */ }
    };
    toggle.addEventListener('click', () => updateExpanded(!expanded));
    groupItem.append(heading, renameDialog, archiveDialog, children);
    list.append(groupItem);
  }
  return list;
}
