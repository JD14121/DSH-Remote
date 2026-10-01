/**
 * EmptyState, LoadingState and FatalErrorState.
 *
 * A blank screen is never an acceptable empty state, and a fatal state names the condition in
 * operator language without offering any server-lifecycle control.
 */

/**
 * Build an empty state.
 *
 * @param {object} input - `variant`, `title`, `body`, `actionLabel`, `onAction`.
 * @param {object} [options] - `doc`.
 * @returns {HTMLElement} the block.
 */
export function renderEmptyState(input, options = {}) {
  const doc = options.doc ?? globalThis.document;

  const block = doc.createElement('div');
  block.className = 'state-block';
  block.dataset.variant = String(input.variant ?? 'no-messages');

  const title = doc.createElement('p');
  title.className = 'state-block__title';
  title.textContent = String(input.title ?? ''); // text node only

  const body = doc.createElement('p');
  body.className = 'state-block__body';
  body.textContent = String(input.body ?? '');

  block.append(title, body);

  if (input.actionLabel) {
    const action = doc.createElement('button');
    action.type = 'button';
    action.className = input.actionPrimary === true ? 'button button--primary' : 'button button--secondary';
    action.textContent = String(input.actionLabel);
    if (typeof input.onAction === 'function') action.addEventListener('click', () => input.onAction());
    block.append(action);
  }
  return block;
}

/**
 * Build a loading state with layout-stable skeletons.
 *
 * @param {object} [input] - `rows`.
 * @param {object} [options] - `doc`.
 * @returns {HTMLElement} the block.
 */
export function renderLoadingState(input = {}, options = {}) {
  const doc = options.doc ?? globalThis.document;
  const rows = Number.isInteger(input.rows) ? input.rows : 3;

  const block = doc.createElement('div');
  block.className = 'state-block';
  block.setAttribute('aria-busy', 'true');
  const label = doc.createElement('span');
  label.className = 'visually-hidden';
  label.textContent = 'Loading';
  block.append(label);
  for (let i = 0; i < rows; i += 1) {
    const skeleton = doc.createElement('div');
    skeleton.className = 'skeleton';
    skeleton.style.width = '100%';
    block.append(skeleton);
  }
  return block;
}

/** Operator-facing copy per fatal variant. Never contains a credential or a stack trace. */
const FATAL_COPY = Object.freeze({
  'gateway-unavailable': {
    title: 'Gateway unavailable',
    body: 'The operator must start the Gateway on the PC. This app cannot do it.',
  },
  'auth-failed': {
    title: 'Authentication failed',
    body: 'The Phone Access Token was not accepted. Enter it again to reconnect.',
  },
  'incompatible-server': {
    title: 'Incompatible server',
    body: 'The Gateway is reachable but its version does not match this client.',
  },
  'network-down': {
    title: 'Network unavailable',
    body: 'This device has no connection to the Gateway host.',
  },
});

/**
 * Build a fatal error state.
 *
 * @param {object} input - `variant`, `onRetry`.
 * @param {object} [options] - `doc`.
 * @returns {HTMLElement} the block.
 */
export function renderFatalErrorState(input, options = {}) {
  const doc = options.doc ?? globalThis.document;
  const copy = FATAL_COPY[input.variant] ?? { title: 'Something went wrong', body: 'The app cannot continue.' };

  const block = doc.createElement('div');
  block.className = 'state-block state-block--fatal';
  block.dataset.variant = String(input.variant ?? 'network-down');
  block.setAttribute('role', 'alert');

  const title = doc.createElement('p');
  title.className = 'state-block__title';
  title.textContent = copy.title;

  const body = doc.createElement('p');
  body.className = 'state-block__body';
  body.textContent = copy.body;

  block.append(title, body);

  if (typeof input.onRetry === 'function') {
    const retry = doc.createElement('button');
    retry.type = 'button';
    retry.className = 'button button--secondary';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => input.onRetry());
    block.append(retry);
  }
  return block;
}
