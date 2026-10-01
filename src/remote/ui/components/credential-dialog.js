/**
 * CredentialDialog: Phone Access Token entry.
 *
 * ## What this phase deliberately does NOT do
 *
 * It does not call `/api/v1/health` or place the token in a URL. The controller persists it
 * only after a successful health check, and only when the user opted in.
 *
 * The value is never written to the console, never echoed in an error, and — because the
 * dialog element is removed from the DOM on close rather than hidden — it cannot survive in
 * an HTML attribute or an input value after the dialog closes.
 *
 * A test asserts all of that.
 */

/**
 * Build the credential dialog.
 *
 * @param {object} input - `state`: 'entry' | 'invalid' | 'submitting'.
 * @param {object} [options] - `doc`, `onConnect`, `onCancel`.
 * @returns {{scrim: HTMLElement, dialog: HTMLElement}} the dialog parts.
 */
export function renderCredentialDialog(input = {}, options = {}) {
  const doc = options.doc ?? globalThis.document;
  const submitting = input.state === 'submitting';

  const scrim = doc.createElement('div');
  scrim.className = 'dialog-scrim';

  const dialog = doc.createElement('div');
  dialog.className = 'dialog';
  dialog.id = 'credential-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'credential-title');

  const title = doc.createElement('h2');
  title.className = 'dialog__title';
  title.id = 'credential-title';
  title.textContent = 'Connect to DSH';

  const label = doc.createElement('label');
  label.className = 'dialog__note';
  label.setAttribute('for', 'credential-token');
  label.textContent = 'Phone Access Token';

  const field = doc.createElement('div');
  field.className = 'dialog__field';

  const input_ = doc.createElement('input');
  input_.type = 'password';
  input_.id = 'credential-token';
  input_.autocomplete = 'off';
  input_.setAttribute('spellcheck', 'false');
  input_.setAttribute('aria-describedby', 'credential-note');

  const reveal = doc.createElement('button');
  reveal.type = 'button';
  reveal.className = 'touch-target';
  reveal.setAttribute('aria-label', 'Show token');
  reveal.setAttribute('aria-pressed', 'false');
  reveal.textContent = '\u{1F441}';
  reveal.addEventListener('click', () => {
    const shown = input_.type === 'text';
    input_.type = shown ? 'password' : 'text';
    reveal.setAttribute('aria-pressed', String(!shown));
    reveal.setAttribute('aria-label', shown ? 'Show token' : 'Hide token');
  });

  field.append(input_, reveal);

  const rememberLabel = doc.createElement('label');
  rememberLabel.className = 'remember-token';
  const remember = doc.createElement('input');
  remember.type = 'checkbox';
  remember.checked = input.remember === true;
  const rememberText = doc.createElement('span');
  rememberText.textContent = '在此设备保存 Phone Access Token';
  rememberLabel.append(remember, rememberText);

  const connect = doc.createElement('button');
  connect.type = 'button';
  connect.className = 'button button--primary';
  connect.id = 'credential-connect';
  connect.textContent = submitting ? 'Connecting\u2026' : 'Connect';
  connect.disabled = submitting;
  if (typeof options.onConnect === 'function') {
    connect.addEventListener('click', () => options.onConnect(input_.value, remember.checked));
  }

  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.className = 'button button--secondary';
  cancel.textContent = 'Cancel';
  if (typeof options.onCancel === 'function') cancel.addEventListener('click', () => options.onCancel());

  const note = doc.createElement('p');
  note.className = 'dialog__note';
  note.id = 'credential-note';
  note.textContent = '默认仅在本次会话使用；勾选后会在此设备保存。令牌不会放入 URL。';

  dialog.append(title, label, field, rememberLabel, connect, cancel, note);

  if (input.state === 'invalid') {
    const error = doc.createElement('p');
    error.className = 'dialog__error';
    error.setAttribute('role', 'alert');
    // Names the failure, never the value.
    error.textContent = 'Authentication failed. Check the token and try again.';
    dialog.append(error);
  }

  return { scrim, dialog };
}
