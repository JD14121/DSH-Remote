/**
 * ReconnectBanner, ResyncBanner and Toast.
 *
 * The reconnect banner never clears history and never returns the user to the credential
 * screen — the composer, timeline and attachments all stay mounted underneath it.
 *
 * The resync action is a fixture action only: it never fetches.
 */

/**
 * Build the reconnect banner.
 *
 * @param {object} input - `phase`: 'reconnecting' | 'reconnected'.
 * @param {object} [options] - `doc`.
 * @returns {HTMLElement} the banner.
 */
export function renderReconnectBanner(input, options = {}) {
  const doc = options.doc ?? globalThis.document;
  const banner = doc.createElement('div');
  banner.className = 'banner';
  banner.id = 'reconnect-banner';
  banner.dataset.phase = String(input.phase ?? 'reconnecting');
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');

  const text = doc.createElement('span');
  text.className = 'banner__text';
  text.textContent = input.phase === 'reconnected'
    ? 'Reconnected'
    : 'Reconnecting\u2026 your history is safe'; // text node only

  banner.append(text);
  return banner;
}

/**
 * Build the resync banner.
 *
 * @param {object} input - `phase`: 'required' | 'reloading' | 'reload-failed'.
 * @param {object} [options] - `doc`, `onReload` (fixture action only — never a fetch).
 * @returns {HTMLElement} the banner.
 */
export function renderResyncBanner(input, options = {}) {
  const doc = options.doc ?? globalThis.document;
  const banner = doc.createElement('div');
  banner.className = 'banner';
  banner.id = 'resync-banner';
  banner.dataset.phase = String(input.phase ?? 'required');
  banner.setAttribute('role', 'alert');

  const text = doc.createElement('span');
  text.className = 'banner__text';
  text.textContent = input.unavailable
    ? 'This conversation is unavailable. Choose another session.'
    : input.phase === 'reload-failed' || input.phase === 'reload_failed'
    ? 'Recovery failed. Your visible history is retained. Try reloading again.'
    : 'Conversation changed while you were offline.';

  banner.append(text);

  const reload = doc.createElement('button');
  reload.type = 'button';
  reload.className = 'button button--secondary';
  const loading = input.phase === 'reloading' || input.phase === 'loading';
  reload.textContent = loading ? 'Reloading\u2026' : 'Reload conversation';
  reload.disabled = loading || input.unavailable === true;
  if (typeof options.onReload === 'function') reload.addEventListener('click', () => options.onReload());
  banner.append(reload);

  return banner;
}

/**
 * Build a toast.
 *
 * @param {object} input - `tone`, `message`.
 * @param {object} [options] - `doc`.
 * @returns {HTMLElement} the toast.
 */
export function renderToast(input, options = {}) {
  const doc = options.doc ?? globalThis.document;
  const toast = doc.createElement('div');
  toast.className = 'toast';
  toast.dataset.tone = String(input.tone ?? 'info');
  toast.setAttribute('role', input.tone === 'danger' ? 'alert' : 'status');
  toast.textContent = String(input.message ?? ''); // text node only
  return toast;
}
