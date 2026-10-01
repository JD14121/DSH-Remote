import { createVectorNode, renderExitIcon } from './brand.js';

const THEME_KEY = 'dsh.remote.uiTheme';

const controls = [
  { key: 'radius', label: '圆角', type: 'range', min: 4, max: 28, unit: 'px', vars: ['--radius-r1', '--radius-r2', '--radius-r3', '--radius-r4'] },
  { key: 'userBubble', label: '用户气泡颜色', type: 'color', vars: ['--message-user'] },
  { key: 'background', label: '背景', type: 'color', vars: ['--bg-primary'] },
  { key: 'fontSize', label: '字体大小', type: 'range', min: 12, max: 24, unit: 'px', vars: ['--text-body-size'] },
  { key: 'messageWidth', label: '消息宽度', type: 'range', min: 45, max: 100, unit: '%', vars: ['--message-max-width'] },
  { key: 'iconSize', label: '图标大小', type: 'range', min: 16, max: 40, unit: 'px', vars: ['--play-icon-size'] },
  { key: 'spacing', label: '文本间距', type: 'range', min: 4, max: 32, unit: 'px', vars: ['--space-s3'] },
  { key: 'bubbleGap', label: '聊天气泡间距', type: 'range', min: 16, max: 40, step: 2, unit: 'px', vars: ['--message-gap'] },
];

const defaults = {
  radius: 16, userBubble: '#2A3B5C', background: '#141416',
  fontSize: 15, messageWidth: 85, iconSize: 24, spacing: 12, bubbleGap: 22,
};

function loadTheme(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(THEME_KEY) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return { ...defaults };
    const theme = { ...defaults, ...parsed };
    delete theme.assistantBubble;
    delete theme.inputHeight;
    delete theme.shadow;
    if (theme.background === '#0F1115') theme.background = defaults.background;
    return theme;
  } catch { return { ...defaults }; }
}

function applyTheme(theme, doc) {
  const root = doc.documentElement;
  if (typeof root?.style?.setProperty !== 'function') return;
  for (const control of controls) {
    const value = theme[control.key];
    if (control.key === 'radius') {
      control.vars.forEach((name, index) => root.style.setProperty(name, `${Math.max(4, Number(value) + (index - 2) * 4)}px`));
    } else {
      const cssValue = control.unit ? `${value}${control.unit}` : String(value);
      control.vars.forEach((name) => root.style.setProperty(name, cssValue));
    }
  }
}

function saveTheme(theme, storage) {
  try { storage?.setItem(THEME_KEY, JSON.stringify(theme)); } catch { /* visible preview remains active */ }
}

export function applySavedTheme(doc, storage = globalThis.localStorage ?? null) {
  applyTheme(loadTheme(storage), doc);
}

function renderPreview(doc) {
  const preview = doc.createElement('section');
  preview.className = 'theme-preview';
  preview.setAttribute('aria-label', '实时预览');
  const heading = doc.createElement('h3');
  heading.textContent = '实时预览';
  const surface = doc.createElement('div');
  surface.className = 'theme-preview__surface';
  const messages = doc.createElement('div');
  messages.className = 'theme-preview__messages';

  const assistant = doc.createElement('article');
  assistant.className = 'message message--assistant';
  const assistantBody = doc.createElement('div');
  assistantBody.className = 'message__body';
  assistantBody.textContent = '你好，我是助手。这里可以预览消息宽度、字体、颜色和阴影。';
  assistant.append(assistantBody);
  const user = doc.createElement('article');
  user.className = 'message message--user';
  const userBody = doc.createElement('div');
  userBody.className = 'message__body';
  userBody.textContent = '这是我的消息气泡。';
  user.append(userBody);
  messages.append(assistant, user);

  const composer = doc.createElement('div');
  composer.className = 'composer theme-preview__composer';
  const row = doc.createElement('div');
  row.className = 'composer__row';
  const attachment = doc.createElement('button');
  attachment.type = 'button';
  attachment.className = 'button button--secondary button--icon touch-target';
  attachment.textContent = '\u{1F4CE}';
  attachment.setAttribute('aria-label', '附件图标预览');
  const input = doc.createElement('div');
  input.className = 'composer__field theme-preview__input';
  input.textContent = '输入框预览';
  const send = doc.createElement('button');
  send.type = 'button';
  send.className = 'button button--primary button--icon touch-target';
  send.textContent = '↑';
  send.setAttribute('aria-label', '发送图标预览');
  row.append(attachment, input, send);
  composer.append(row);
  surface.append(messages, composer);
  preview.append(heading, surface);
  return preview;
}

function renderTuningIcon(doc) {
  const icon = createVectorNode(doc, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.classList.add('settings-option__icon');
  icon.setAttribute('aria-hidden', 'true');
  const path = createVectorNode(doc, 'path');
  path.setAttribute('d', 'M4 7h9m4 0h3M4 17h3m4 0h9M13 4v6M9 14v6');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.7');
  path.setAttribute('stroke-linecap', 'round');
  icon.append(path);
  return icon;
}

function renderChevron(doc) {
  const chevron = doc.createElement('span');
  chevron.className = 'settings-option__chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '›';
  return chevron;
}

/** Render the concise settings page and the separate live theme editor. */
export function renderSettingsDialog(input = {}, options = {}) {
  const doc = options.doc ?? globalThis.document;
  const storage = options.storage ?? globalThis.localStorage ?? null;
  const savedTheme = loadTheme(storage);
  const theme = { ...savedTheme };
  applyTheme(savedTheme, doc);

  const scrim = doc.createElement('div');
  scrim.className = 'dialog-scrim settings-scrim';
  const dialog = doc.createElement('section');
  dialog.className = 'dialog settings-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'settings-title');

  const settingsPage = doc.createElement('section');
  settingsPage.className = 'settings-page';
  const settingsHeader = doc.createElement('header');
  settingsHeader.className = 'settings-header';
  const settingsTitle = doc.createElement('h2');
  settingsTitle.className = 'dialog__title visually-hidden';
  settingsTitle.id = 'settings-title';
  settingsTitle.textContent = '设置';
  const exit = doc.createElement('button');
  exit.type = 'button';
  exit.className = 'button button--secondary touch-target settings-icon-button';
  exit.setAttribute('aria-label', '返回对话');
  exit.title = '返回对话';
  exit.append(renderExitIcon({ doc }));
  exit.addEventListener('click', () => {
    applyTheme(savedTheme, doc);
    options.onClose?.();
  });
  settingsHeader.append(settingsTitle, exit);

  const appearanceEntry = doc.createElement('button');
  appearanceEntry.type = 'button';
  appearanceEntry.className = 'settings-option';
  appearanceEntry.setAttribute('aria-label', '打开外观设置');
  appearanceEntry.append(renderTuningIcon(doc));
  const appearanceCopy = doc.createElement('span');
  appearanceCopy.className = 'settings-option__copy';
  const appearanceLabel = doc.createElement('span');
  appearanceLabel.className = 'settings-option__title';
  appearanceLabel.textContent = '外观';
  const appearanceNote = doc.createElement('span');
  appearanceNote.className = 'settings-option__note';
  appearanceNote.textContent = '实时预览并自定义主题';
  appearanceCopy.append(appearanceLabel, appearanceNote);
  appearanceEntry.append(appearanceCopy, renderChevron(doc));

  const authSection = doc.createElement('section');
  authSection.className = 'settings-auth';
  const authTitle = doc.createElement('h3');
  authTitle.textContent = 'Authentication';
  const rememberLabel = doc.createElement('label');
  rememberLabel.className = 'remember-token';
  const remember = doc.createElement('input');
  remember.type = 'checkbox';
  remember.checked = input.remember === true;
  remember.addEventListener('change', () => options.onRemember?.(remember.checked));
  const rememberText = doc.createElement('span');
  rememberText.textContent = '在此设备保存 Phone Access Token';
  rememberLabel.append(remember, rememberText);
  const authNote = doc.createElement('p');
  authNote.className = 'dialog__note';
  authNote.textContent = '默认关闭。开启后令牌会保存在此 WebView 的本机浏览器存储中，直到取消此选项或退出登录。';
  const changeToken = doc.createElement('button');
  changeToken.type = 'button';
  changeToken.className = 'button button--secondary settings-token-action';
  changeToken.textContent = '更换 Phone Access Token';
  changeToken.addEventListener('click', () => options.onChangeToken?.());
  authSection.append(authTitle, rememberLabel, authNote, changeToken);

  settingsPage.append(settingsHeader, appearanceEntry, authSection);

  const appearancePage = doc.createElement('section');
  appearancePage.className = 'settings-page settings-page--appearance';
  appearancePage.hidden = true;
  const appearanceHeader = doc.createElement('header');
  appearanceHeader.className = 'settings-header';
  const appearanceBack = doc.createElement('button');
  appearanceBack.type = 'button';
  appearanceBack.className = 'button button--secondary touch-target settings-icon-button settings-back-button';
  appearanceBack.setAttribute('aria-label', '返回设置');
  appearanceBack.title = '返回设置';
  appearanceBack.textContent = '‹';
  const appearanceTitle = doc.createElement('h2');
  appearanceTitle.className = 'dialog__title';
  appearanceTitle.id = 'appearance-title';
  appearanceTitle.textContent = '外观';
  appearanceHeader.append(appearanceBack, appearanceTitle);

  const appearanceIntro = doc.createElement('p');
  appearanceIntro.className = 'dialog__note';
  appearanceIntro.textContent = '调整后即时预览；保存后会在此设备保留。';
  const preview = renderPreview(doc);
  const grid = doc.createElement('div');
  grid.className = 'playground-controls';
  for (const control of controls) {
    const label = doc.createElement('label');
    label.className = 'playground-control';
    const caption = doc.createElement('span');
    caption.textContent = control.label;
    const field = doc.createElement('input');
    field.type = control.type;
    if (control.min !== undefined) field.min = String(control.min);
    if (control.max !== undefined) field.max = String(control.max);
    if (control.step !== undefined) field.step = String(control.step);
    field.value = String(theme[control.key]);
    field.setAttribute('aria-label', control.label);
    field.addEventListener('input', () => {
      theme[control.key] = control.type === 'color' ? field.value : Number(field.value);
      applyTheme(theme, doc);
    });
    label.append(caption, field);
    grid.append(label);
  }

  const appearanceActions = doc.createElement('div');
  appearanceActions.className = 'settings-actions';
  const reset = doc.createElement('button');
  reset.type = 'button';
  reset.className = 'button button--secondary';
  reset.textContent = '重置主题';
  reset.addEventListener('click', () => {
    Object.assign(theme, defaults);
    applyTheme(theme, doc);
    [...grid.querySelectorAll('input')].forEach((field, index) => { field.value = String(theme[controls[index].key]); });
  });
  const save = doc.createElement('button');
  save.type = 'button';
  save.className = 'button button--primary';
  save.textContent = '保存主题';
  save.addEventListener('click', () => {
    saveTheme(theme, storage);
    Object.assign(savedTheme, theme);
    showAppearance(false);
  });
  appearanceActions.append(reset, save);
  appearancePage.append(appearanceHeader, appearanceIntro, preview, grid, appearanceActions);

  function showAppearance(open) {
    settingsPage.hidden = open;
    appearancePage.hidden = !open;
    dialog.setAttribute('aria-labelledby', open ? 'appearance-title' : 'settings-title');
  }
  appearanceEntry.addEventListener('click', () => showAppearance(true));
  appearanceBack.addEventListener('click', () => showAppearance(false));

  dialog.append(settingsPage, appearancePage);
  return { scrim, dialog };
}
