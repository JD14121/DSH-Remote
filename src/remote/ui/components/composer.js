/**
 * Composer, ComposerTextArea, UploadButton, SendButton, SteerButton, CancelButton,
 * QueueIndicator and WaitingInputIndicator.
 *
 * The binding rule lives here: the primary action's LABEL states the queue/steer effect at all
 * times, and steer is a separate, explicitly labelled action. One button never changes meaning
 * silently.
 */

import {
  canSend,
  primarySendLabel,
  sendIntent,
  steerAvailable,
} from '../state/ui-state.js';
import { renderPaperclipIcon, renderSendIcon } from './brand.js';

/**
 * Build the composer.
 *
 * @param {object} input - `domain`, `connection`, `draft`, `queueDepth`, `attachments`.
 * @param {object} [options] - callbacks for composer actions and DSH configuration.
 * @returns {HTMLElement} the composer region.
 */
export function renderComposer(input, options = {}) {
  const doc = options.doc ?? globalThis.document;
  /*
   * R1.5.2: a session whose transcript has not arrived yet must not accept a send.
   *
   * The connection axis alone is not enough here. While session B is loading the link is usually
   * `connected`, so `canSend(connection)` is true and the composer would look ready for a session the
   * shell has not actually loaded. Folding `sessionLoading` into the same `sendable` gate disables
   * send AND attach through the paths that already exist, so no new disable logic is introduced.
   */
  const sessionLoading = input.sessionLoading === true;
  const sendable = canSend(input.connection) && !sessionLoading;
  const label = primarySendLabel(input.domain);
  const intent = sendIntent(input.domain);
  const canSteer = steerAvailable(input.domain) && !sessionLoading;

  const region = doc.createElement('div');
  region.className = 'composer-region';

  const composer = doc.createElement('div');
  composer.className = 'composer';
  composer.dataset.domain = String(input.domain);
  composer.dataset.connection = String(input.connection);

  const inner = doc.createElement('div');
  inner.className = 'composer__inner';

  // Indicators sit directly above the field.
  if (input.domain === 'waiting_input') {
    inner.append(renderWaitingInputIndicator({}, { doc }));
  }
  if (input.queueDepth > 0) {
    inner.append(renderQueueIndicator({ count: input.queueDepth }, { doc }));
  }

  // R8G polish: the composer is a single inline row — an attach control, the growing field, and
  // the submit controls at the inline end. It previously stacked the field above the buttons,
  // which at 390px produced a tall column with controls floating under the input.
  const fieldRow = doc.createElement('div');
  fieldRow.className = 'composer__field-row';
  const toolbar = doc.createElement('div');
  toolbar.className = 'composer__toolbar';
  const leading = doc.createElement('div');
  leading.className = 'composer__leading';

  const upload = doc.createElement('button');
  upload.type = 'button';
  upload.className = 'button button--secondary button--icon composer__attach';
  upload.setAttribute('aria-label', 'Attach an image or file, up to 25 MiB');
  upload.append(renderPaperclipIcon({ doc }));
  upload.disabled = !sendable;

  // The real browser file input. It is the mechanism the Android WebView needs: a WebView only
  // raises `WebChromeClient.onShowFileChooser` when the page actually activates an
  // `<input type="file">`, so without this the harness's chooser implementation is unreachable.
  //
  // It is `hidden` and `aria-hidden`, and the visible attach button remains the user-facing
  // control (§5). `value` is cleared after every change so the SAME file can be selected again
  // after removal — browsers suppress a `change` event when the value is unchanged (§17).
  const fileInput = doc.createElement('input');
  fileInput.type = 'file';
  fileInput.className = 'composer__file-input';
  fileInput.hidden = true;
  fileInput.setAttribute('aria-hidden', 'true');
  fileInput.tabIndex = -1;
  // One file per selection: the existing upload path takes a single file (§13).
  fileInput.multiple = false;
  fileInput.addEventListener('change', () => {
    const chosen = fileInput.files && fileInput.files.length > 0 ? fileInput.files[0] : null;
    // Clear first, so a later identical selection still fires `change`.
    fileInput.value = '';
    if (chosen === null) return; // A cancelled picker fires no change at all; nothing to do (§16).
    if (typeof options.onFileSelected === 'function') options.onFileSelected(chosen);
  });

  if (typeof options.onUpload === 'function') {
    upload.addEventListener('click', () => {
      // `onUpload` decides WHETHER a chooser may open; the composer only performs the activation.
      // Real mode returns true and the input is clicked, which is what raises the Android
      // WebView's file chooser. Fixture mode returns false, so no native picker can appear —
      // that decision belongs to the mode, not to this component.
      const allow = options.onUpload(fileInput);
      if (allow === false) return;
      if (fileInput && typeof fileInput.click === 'function') fileInput.click();
    });
  }

  // The input must be in the document for the WebView to accept it as the chooser target.
  toolbar.append(fileInput);

  const plus = doc.createElement('button');
  plus.type = 'button';
  plus.className = 'button button--secondary button--icon composer__plus';
  plus.textContent = '+';
  plus.setAttribute('aria-label', 'Agent、模型与推理设置');
  plus.setAttribute('aria-expanded', 'false');

  const settingsMenu = doc.createElement('div');
  settingsMenu.className = 'composer__settings-menu';
  settingsMenu.hidden = input.settingsMenuOpen !== true;
  settingsMenu.setAttribute('aria-label', 'DSH 会话设置');
  const menuTitle = doc.createElement('strong');
  menuTitle.className = 'composer__settings-title';
  menuTitle.textContent = 'DSH 会话设置';
  settingsMenu.append(menuTitle);

  const addField = (labelText, control) => {
    const row = doc.createElement('label');
    row.className = 'composer__settings-field';
    const label = doc.createElement('span');
    label.textContent = labelText;
    row.append(label, control);
    settingsMenu.append(row);
  };
  const actionButton = (label, action, disabled = false) => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'button button--secondary composer__settings-action';
    button.textContent = label;
    button.disabled = disabled;
    if (typeof action === 'function') button.addEventListener('click', action);
    settingsMenu.append(button);
    return button;
  };

  const roster = input.agentPresetRoster;
  const presetSelect = doc.createElement('select');
  presetSelect.className = 'composer__settings-select';
  presetSelect.setAttribute('aria-label', 'Agent 预设');
  const presetOptions = Array.isArray(roster?.presets) ? roster.presets : [];
  if (presetOptions.length === 0) {
    const option = doc.createElement('option');
    option.value = '';
    option.textContent = input.configurationLoading ? '正在读取预设…' : '暂无可用预设';
    presetSelect.append(option);
  }
  for (const preset of presetOptions) {
    const option = doc.createElement('option');
    option.value = preset.id;
    option.textContent = `${preset.name ?? preset.id}${preset.isDefault ? '（默认）' : ''}${preset.broken ? '（不可用）' : ''}`;
    option.disabled = preset.broken === true;
    if (input.selectedAgentPreset === preset.id || (input.selectedAgentPreset == null && preset.isDefault)) option.selected = true;
    presetSelect.append(option);
  }
  presetSelect.disabled = input.configurationLoading === true || input.activeSessionId == null || presetOptions.length === 0;
  addField('Agent 预设', presetSelect);
  actionButton(input.configurationAction === 'preset' ? '正在同步…' : '应用预设', () => {
    options.onSelectAgentPreset?.(presetSelect.value);
  }, presetSelect.disabled || input.configurationAction === 'preset');

  const catalog = input.modelCatalog;
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
  let selection = { ...(input.modelSelection ?? catalog?.default ?? {}) };
  if (!groups.some((group) => group.id === selection.provider)) {
    const firstGroup = groups[0];
    selection = { ...selection, provider: firstGroup?.id ?? '', model: firstGroup?.models?.[0]?.id ?? '' };
  }
  const providerSelect = doc.createElement('select');
  providerSelect.className = 'composer__settings-select';
  providerSelect.setAttribute('aria-label', '模型提供方');
  for (const group of groups) {
    const option = doc.createElement('option');
    option.value = group.id;
    option.textContent = group.name ?? group.id;
    option.selected = group.id === selection.provider;
    providerSelect.append(option);
  }
  const modelsForProvider = () => groups.find((group) => group.id === selection.provider)?.models ?? [];
  const modelSelect = doc.createElement('select');
  modelSelect.className = 'composer__settings-select';
  modelSelect.setAttribute('aria-label', '模型');
  const effortSelect = doc.createElement('select');
  effortSelect.className = 'composer__settings-select';
  effortSelect.setAttribute('aria-label', '推理强度');
  const refreshModelOptions = () => {
    const models = modelsForProvider();
    const selectedModel = models.find((model) => model.id === selection.model) ?? models[0];
    const allowedEfforts = selectedModel?.reasoning?.efforts ?? [];
    const reasoningEffort = allowedEfforts.some((effort) => effort.id === selection.reasoningEffort)
      ? selection.reasoningEffort
      : undefined;
    selection = { ...selection, model: selectedModel?.id ?? '', reasoningEffort };
    modelSelect.replaceChildren();
    for (const model of models) {
      const option = doc.createElement('option');
      option.value = model.id;
      option.textContent = model.name ?? model.id;
      option.selected = model.id === selection.model;
      modelSelect.append(option);
    }
    effortSelect.replaceChildren();
    const effortInfo = selectedModel?.reasoning;
    const defaultOption = doc.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = '默认强度';
    effortSelect.append(defaultOption);
    for (const effort of effortInfo?.efforts ?? []) {
      const option = doc.createElement('option');
      option.value = effort.id;
      option.textContent = effort.name ?? effort.id;
      option.selected = effort.id === selection.reasoningEffort;
      effortSelect.append(option);
    }
    effortSelect.disabled = !Array.isArray(effortInfo?.efforts) || effortInfo.efforts.length === 0;
  };
  providerSelect.addEventListener('change', () => {
    selection.provider = providerSelect.value;
    refreshModelOptions();
  });
  modelSelect.addEventListener('change', () => {
    selection.model = modelSelect.value;
    refreshModelOptions();
  });
  effortSelect.addEventListener('change', () => {
    selection.reasoningEffort = effortSelect.value || undefined;
  });
  refreshModelOptions();
  const controlsDisabled = input.configurationLoading === true || input.activeSessionId == null || groups.length === 0;
  providerSelect.disabled = controlsDisabled || groups.length === 0;
  modelSelect.disabled = controlsDisabled || modelSelect.options.length === 0;
  effortSelect.disabled = controlsDisabled || effortSelect.disabled;
  addField('模型提供方', providerSelect);
  addField('模型', modelSelect);
  addField('推理强度', effortSelect);
  actionButton(input.configurationAction === 'model' ? '正在同步…' : '同步到 DSH', () => {
    options.onSelectModel?.({
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    });
  }, controlsDisabled || input.configurationAction === 'model');

  if (input.configurationError) {
    const error = doc.createElement('p');
    error.className = 'composer__settings-error';
    error.setAttribute('role', 'alert');
    error.textContent = String(input.configurationError);
    settingsMenu.append(error);
  } else if (input.activeSessionId == null) {
    const note = doc.createElement('p');
    note.className = 'composer__settings-note';
    note.textContent = '先打开或创建会话，再同步设置。';
    settingsMenu.append(note);
  } else if (input.configurationLoading === true) {
    const note = doc.createElement('p');
    note.className = 'composer__settings-note';
    note.textContent = '正在读取 DSH 当前可用配置…';
    settingsMenu.append(note);
  }
  plus.addEventListener('click', () => {
    const open = settingsMenu.hidden;
    settingsMenu.hidden = !open;
    plus.setAttribute('aria-expanded', String(open));
    options.onToggleSettings?.(open);
  });
  toolbar.append(settingsMenu);

  const field = doc.createElement('textarea');
  field.className = 'composer__field';
  field.rows = 1;
  // A textarea defaults to `cols=20`, which is an intrinsic ~340px width. In a flex row that
  // made the field refuse to shrink, overflowing the row and pushing the Send button off-screen.
  // The width is owned by CSS (`flex: 1 1 auto; min-width: 0`), so the column hint is removed.
  field.cols = 1;
  field.value = String(input.draft ?? '');
  field.setAttribute('aria-label', 'Message');
  if (input.domain === 'waiting_input') field.setAttribute('aria-describedby', 'waiting-input-indicator');
  // The field stays editable when disconnected so a draft is never lost; only sending stops.
  field.disabled = false;
  /*
   * R1.5.2: while the selected session is still loading, the field is READ-ONLY rather than
   * disabled. Read-only keeps the text visible, selectable and copyable -- the draft is never hidden
   * or lost -- while making it clear the composer is not yet servicing this session. The draft is
   * already per-session (R1.5.1), so nothing can leak between sessions while loading.
   */
  field.readOnly = sessionLoading;
  if (typeof options.onDraft === 'function') {
    field.addEventListener('input', (event) => options.onDraft(event.target.value));
  }

  fieldRow.append(field);
  leading.append(plus, upload);
  toolbar.append(leading);
  inner.append(fieldRow, toolbar);

  /*
   * R1.2: auto-grow.
   *
   * The field used to be a fixed-height 1-row textarea, so a multi-line draft scrolled inside a
   * 48px box on the phone (measured: scrollHeight 156px, rendered 48px) and the user could not see
   * what they had written. It now grows with the content up to a cap, then scrolls internally.
   *
   * Height is driven by measurement rather than by counting newlines, so soft-wrapped lines grow
   * the field too. `height: auto` is set first so `scrollHeight` reports the CONTENT height rather
   * than the current box height -- without that reset the field can only ever grow, never shrink.
   *
   * The cap is read from CSS (`max-height`), so the layout system keeps ownership of the number and
   * this function holds none.
   */
  const MAX_FALLBACK = 196;
  const autoGrow = () => {
    if (typeof field.style !== 'object') return;
    const previous = field.style.height;
    field.style.height = 'auto';
    const content = field.scrollHeight;
    field.style.height = previous;
    const declared = Number.parseFloat(globalThis.getComputedStyle?.(field)?.maxHeight ?? '');
    const max = Number.isFinite(declared) && declared > 0 ? declared : MAX_FALLBACK;
    const next = Math.min(content, max);
    field.style.height = `${next}px`;
    // Only show a scrollbar once the field has actually hit the cap.
    field.style.overflowY = content > max ? 'auto' : 'hidden';
  };
  autoGrow();
  field.addEventListener('input', autoGrow);
  // A rotation or a font-size change alters wrapping, so the measurement is re-taken. The listener
  // self-removes once a re-render has orphaned this field, so repeated renders cannot accumulate
  // handlers that pin dead textareas in memory.
  if (typeof globalThis.addEventListener === 'function') {
    const onResize = () => {
      if (!field.isConnected) {
        globalThis.removeEventListener('resize', onResize);
        return;
      }
      autoGrow();
    };
    globalThis.addEventListener('resize', onResize);
  }

  const actions = doc.createElement('div');
  actions.className = 'composer__actions';

  // R8F §20: a submission in flight disables its own control rather than relying on the user
  // not double-clicking. The label also states what is happening, so the state is never silent.
  const sending = input.sendState === 'sending';
  const send = doc.createElement('button');
  send.type = 'button';
  send.className = 'button button--primary composer__send';
  send.id = 'composer-send';
  send.dataset.intent = intent;
  send.append(renderSendIcon({ doc }));
  send.setAttribute('aria-label', sending
    ? 'Sending — waiting for the Gateway to accept this message'
    : input.sendState === 'failed'
      ? 'Message was not accepted — retry sending this message'
      : (sendable
      ? (intent === 'queue' ? 'Send later — queues this message' : 'Send this message')
      : 'Send unavailable while disconnected'));
  send.disabled = !sendable || sending;
  if (typeof options.onSend === 'function') send.addEventListener('click', () => options.onSend(intent));

  if (input.sendState === 'failed') {
    const status = doc.createElement('p');
    status.className = 'composer__send-error';
    status.setAttribute('role', 'alert');
    status.textContent = `Message not sent. ${typeof input.sendError === 'string' ? input.sendError : 'Check the connection and retry.'}`;
    composer.append(status);
  }

  if (canSteer) {
    const steer = doc.createElement('button');
    steer.type = 'button';
    steer.className = 'button button--secondary';
    steer.id = 'composer-steer';
    steer.textContent = 'Steer current task';
    steer.setAttribute('aria-label', 'Steer current task — redirects the running turn');
    // Steer shares the submission guard: one message action at a time.
    steer.disabled = !sendable || sending;
    if (typeof options.onSteer === 'function') steer.addEventListener('click', () => options.onSteer());
    actions.append(steer);
  }

  if (input.domain === 'running' || input.domain === 'queued') {
    // §10: `cancelling` / `requested` are UI-local action substates, never a domain state. The
    // button stays visible so the operator can see what is happening, but is disabled while a
    // cancel is in flight so it cannot be submitted twice.
    const cancelState = input.cancelState ?? 'idle';
    const cancelling = cancelState === 'cancelling' || cancelState === 'requested';
    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.className = 'button button--danger';
    cancel.id = 'composer-cancel';
    cancel.dataset.cancelState = cancelState;
    cancel.textContent = cancelState === 'cancelling'
      ? 'Cancelling…'
      : (cancelState === 'requested' ? 'Cancellation requested' : 'Cancel run');
    cancel.setAttribute('aria-label', cancelling
      ? 'Cancellation requested — waiting for the Gateway to confirm the run ended'
      : 'Cancel run');
    cancel.disabled = cancelling;
    if (typeof options.onCancel === 'function') cancel.addEventListener('click', () => options.onCancel());
    actions.append(cancel);
  }

  // The submit controls sit in the lower tool row, like the DSH desktop composer.
  actions.append(send);
  toolbar.append(actions);

  composer.append(inner);

  if (input.attachments.length > 0) {
    composer.prepend(renderAttachmentStrip({ attachments: input.attachments }, {
      doc,
      onRemove: options.onRemoveAttachment,
    }));
  }

  region.append(composer);
  return region;
}

/**
 * Build the queue indicator. The count is text, never a bare number badge.
 *
 * @param {{count: number}} input - the queue depth.
 * @param {object} [options] - `doc`.
 * @returns {HTMLElement} the indicator.
 */
export function renderQueueIndicator(input, options = {}) {
  const doc = options.doc ?? globalThis.document;
  const el = doc.createElement('span');
  el.className = 'indicator';
  el.id = 'queue-indicator';
  el.textContent = `${input.count} queued`; // text form, not a bare badge
  return el;
}

/**
 * Build the waiting-input indicator.
 *
 * @param {object} [input] - unused; present for a uniform call shape.
 * @param {object} [options] - `doc`.
 * @returns {HTMLElement} the indicator.
 */
export function renderWaitingInputIndicator(input = {}, options = {}) {
  const doc = options.doc ?? globalThis.document;
  const el = doc.createElement('div');
  el.className = 'indicator indicator--waiting';
  el.id = 'waiting-input-indicator';
  el.setAttribute('role', 'status');
  el.textContent = 'DSH is waiting for your answer';
  return el;
}

/**
 * Build the attachment strip: AttachmentChip and UploadProgressChip.
 *
 * @param {object} input - `attachments`.
 * @param {object} [options] - `doc`, `onRemove`.
 * @returns {HTMLElement} the strip.
 */
export function renderAttachmentStrip(input, options = {}) {
  const doc = options.doc ?? globalThis.document;
  const strip = doc.createElement('div');
  strip.className = 'attachment-strip';

  for (const attachment of input.attachments) {
    const chip = doc.createElement('span');
    chip.className = 'attachment-chip';
    chip.dataset.state = String(attachment.state ?? 'selected');
    chip.dataset.kind = String(attachment.kind ?? 'file');

    const name = doc.createElement('span');
    name.textContent = String(attachment.name ?? ''); // text node only

    chip.append(name);

    if (attachment.state === 'uploading') {
      const progress = doc.createElement('span');
      progress.setAttribute('role', 'progressbar');
      progress.setAttribute('aria-valuenow', String(attachment.progress ?? 0));
      progress.setAttribute('aria-valuemin', '0');
      progress.setAttribute('aria-valuemax', '100');
      progress.textContent = `${attachment.progress ?? 0}%`;
      chip.append(progress);
    }

    if (attachment.state === 'failed') {
      const failed = doc.createElement('span');
      failed.textContent = 'failed';
      chip.append(failed);
    }

    if (attachment.state !== 'uploading') {
      const remove = doc.createElement('button');
      remove.type = 'button';
      remove.className = 'attachment-chip__remove';
      remove.setAttribute('aria-label', `Remove ${String(attachment.name ?? 'attachment')}`);
      remove.textContent = '\u2715';
      if (typeof options.onRemove === 'function') {
        remove.addEventListener('click', () => options.onRemove(attachment.id));
      }
      chip.append(remove);
    }

    strip.append(chip);
  }
  return strip;
}
