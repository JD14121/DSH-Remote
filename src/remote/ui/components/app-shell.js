/**
 * AppShell: owns the frame and composes every region from state.
 *
 * One tree serves all fixtures. Nothing here branches on a screen name 鈥?a screen is a state,
 * not a page.
 *
 * Layout note: the session list is rendered ONCE and placed either in the overlay drawer
 * (mobile) or in the persistent rail (tablet). Both hosts are always present in the DOM; CSS
 * decides which one is visible. That is what keeps the responsive change layout-only.
 */

import { buildFixture, streamingText } from '../state/fixture-state.js';
import { renderTopBar } from './top-bar.js';
import { renderSessionDrawer } from './session-drawer.js';
import { renderComposer } from './composer.js';
import { renderMessageTimeline, renderLoadOlderMessages } from './message.js';
import {
  renderReconnectBanner,
  renderResyncBanner,
  renderToast,
} from './banners.js';
import {
  renderEmptyState,
  renderFatalErrorState,
  renderLoadingState,
} from './empty-state.js';
import { renderCredentialDialog } from './credential-dialog.js';
import { renderSettingsDialog } from './settings-dialog.js';
import { renderSessionList } from './session-item.js';
import { renderBrandLockup } from './brand.js';

/**
 * Render the whole shell for a state.
 *
 * @param {object} input - `fixture`, `state`, `messages`, `sessions`.
 * @param {object} [options] - `doc`, handlers.
 * @returns {HTMLElement} the shell.
 */
export function renderAppShell(input, options = {}) {
  const doc = options.doc ?? globalThis.document;
  const { state, fixture } = input;

  /*
   * R1.5.1 (T3): the selected session comes from the CLIENT SELECTION STATE, not from list order.
   *
   * Both list instances below previously received `input.sessions[0]?.id`, so the highlighted row
   * was permanently the first session no matter what the operator selected. This is the single
   * authoritative id, and the tablet rail and the mobile drawer are given the SAME value so they
   * cannot disagree.
   *
   * It is deliberately NOT derived from list order, running state, a clicked DOM node, the URL or
   * message content.
   */
  const activeSessionId = input.activeSessionId ?? null;

  const shell = doc.createElement('div');
  shell.className = 'app-shell';
  shell.dataset.fixture = fixture.name;
  shell.dataset.screen = fixture.screen;
  shell.dataset.domain = state.domain;
  shell.dataset.connection = state.connection;

  // ---- Rail (tablet) ------------------------------------------------------
  const rail = doc.createElement('nav');
  rail.className = 'app-shell__rail';
  rail.setAttribute('aria-label', 'Sessions');
  const railHeader = doc.createElement('div');
  railHeader.className = 'top-bar';
  railHeader.classList.add('app-shell__brand-header');
  railHeader.append(renderBrandLockup({ doc }));
  rail.append(railHeader);
  rail.append(renderSessionList(input.sessions, {
    doc,
    activeId: activeSessionId,
    createInWorkspaceDisabled: state.creatingSession === true,
    onSelect: options.onSelectSession,
    onRename: options.onRenameSession,
    onDelete: options.onDeleteSession,
    onArchiveWorkspace: options.onArchiveWorkspace,
    onCreateInWorkspace: options.onCreateSessionInWorkspace,
  }));

  // ---- Main column --------------------------------------------------------
  const main = doc.createElement('main');
  main.className = 'app-shell__main';
  main.id = 'main';

  main.append(renderTopBar({
    title: fixture.title,
    connection: state.connection,
    drawerOpen: state.drawerOpen,
  }, { doc, onToggleDrawer: options.onToggleDrawer }));

  // Banner slot: history is never cleared to show a banner.
  const banners = doc.createElement('div');
  banners.className = 'app-shell__banners';
  if (state.resync === 'reconnected') {
    banners.append(renderReconnectBanner({ phase: 'reconnected' }, { doc }));
  } else if (state.resync !== 'none') {
    banners.append(renderResyncBanner({ phase: state.resync, unavailable: state.sessionUnavailable }, { doc, onReload: options.onResyncReload }));
  }
  if (typeof state.newSessionError === 'string' && state.newSessionError.length > 0) {
    const failure = doc.createElement('div');
    failure.className = 'banner';
    failure.dataset.kind = 'new-session-error';
    failure.setAttribute('role', 'alert');
    const message = doc.createElement('span');
    message.className = 'banner__text';
    message.textContent = `New session could not be created. ${state.newSessionError}`;
    failure.append(message);
    banners.append(failure);
  }
  main.append(banners);

  // ---- Content ------------------------------------------------------------
  const content = doc.createElement('div');
  content.className = 'app-shell__content';

  if (state.fatal !== null) {
    // A fatal state replaces the chat surface; the composer is not shown.
    content.append(renderFatalErrorState({
      variant: state.fatal,
      onRetry: options.onRetry,
    }, { doc }));
  } else if (state.connection === 'connecting' && !state.retainTimeline) {
    content.append(renderLoadingState({ rows: 3 }, { doc }));
  } else {
    /*
     * R1.5.2: the SELECTED SESSION may still be loading.
     *
     * Before this, control fell through to the empty state below and announced "No messages yet --
     * Send the first message to start this session." while session B's transcript was still in
     * flight. That misrepresented a loading session as an empty one: the shell asserted something
     * about B it did not yet know.
     *
     * The loading surface is deliberately the SAME lightweight `renderLoadingState` already used for
     * `connecting`: it carries aria-busy and ONE visually-hidden "Loading" label, so the skeleton rows
     * are never announced individually. No new component, and no connection wording -- session
     * loading is not a connection-state transition, so Gateway unavailable / Connecting /
     * Reconnecting / Resync are never shown for it.
     *
     * Only the chat pane changes. The top bar, connection badge and shell stay stable, and the
     * COMPOSER STILL RENDERS below with send/steer/attach gated -- so the operator keeps sight of
     * their own draft instead of the whole composer vanishing mid-transition.
     */
    if (state.sessionLoading === true) {
      content.append(renderLoadingState({ rows: 3 }, { doc }));
    } else {
      const hasMessages = input.messages.length > 0;
      /*
       * Older history is a forward-only affordance ABOVE the transcript, so the
       * reader can pull in earlier pages without the live/optimistic tail moving.
       * It is rendered only when the server said older pages remain, and never
       * replaces or clears the transcript.
       */
      if (state.hasOlderMessages === true) {
        content.append(renderLoadOlderMessages(
          { loading: state.olderMessagesStatus === 'loading' },
          { doc, onLoadOlder: options.onLoadOlder },
        ));
      }
      if (!hasMessages) {
        content.append(renderEmptyState({
          variant: state.connection === 'auth_required' ? 'auth-required' : 'no-messages',
          title: 'No messages yet',
          body: 'Send the first message to start this session.',
        }, { doc }));
      } else {
        content.append(renderMessageTimeline(input.messages, {
          doc,
          messageCache: options.messageCache,
          streamingText: streamingText(state),
          streamingActive: state.streaming !== null,
        }));
      }
    }

    content.append(renderComposer({
      domain: state.domain,
      connection: state.connection,
      draft: state.draft,
      queueDepth: state.queueDepth,
      attachments: state.attachments,
      activeSessionId: input.activeSessionId,
      agentPresetRoster: state.agentPresetRoster,
      selectedAgentPreset: state.selectedAgentPreset,
      modelCatalog: state.modelCatalog,
      modelSelection: state.modelSelection,
      settingsMenuOpen: state.settingsMenuOpen,
      configurationLoading: state.configurationLoading,
      configurationAction: state.configurationAction,
      configurationError: state.configurationError,
      // R8F: action substates. These are deliberately NOT domain states — they describe what the
      // user just asked for, while `domain` continues to describe what the server reported.
      sendState: state.sendState,
      sendError: state.error?.message ?? null,
      cancelState: state.cancelState,
      // R1.5.2: send/steer/attach are gated while the selected session's transcript is in flight,
      // so a send can never target a session the shell has not loaded. The draft stays visible.
      sessionLoading: state.sessionLoading === true,
    }, {
      doc,
      onDraft: options.onDraft,
      onSend: options.onSend,
      onSteer: options.onSteer,
      onCancel: options.onCancel,
      onUpload: options.onUpload,
      onFileSelected: options.onFileSelected,
      // The attachment strip's remove control had no handler wired, so the chip rendered a button
      // that did nothing. It is now connected to the controller's local removal (搂15).
      onRemoveAttachment: options.onRemoveAttachment,
      onToggleSettings: options.onToggleSettings,
      onSelectAgentPreset: options.onSelectAgentPreset,
      onSelectModel: options.onSelectModel,
    }));
  }

  main.append(content);
  shell.append(rail, main);

  // ---- Drawer -------------------------------------------------------------
  const drawerHost = doc.createElement('div');
  drawerHost.className = 'app-shell__drawer-host';
  const { scrim, drawer } = renderSessionDrawer({
    open: state.drawerOpen,
    sessions: input.sessions,
    activeId: activeSessionId,
      createInWorkspaceDisabled: state.creatingSession === true,
    // R9: disabled only while a create is already in flight; otherwise it is a
    // real control wired to the create flow.
    newSessionDisabled: state.creatingSession === true,
  }, {
    doc,
    onClose: options.onToggleDrawer,
      onSelect: options.onSelectSession,
      onRename: options.onRenameSession,
      onDelete: options.onDeleteSession,
      onArchiveWorkspace: options.onArchiveWorkspace,
      onCreateInWorkspace: options.onCreateSessionInWorkspace,
    onSettings: options.onSettings,
    onNewSession: options.onNewSession,
  });
  if (scrim !== null) drawerHost.append(scrim);
  drawerHost.append(drawer);
  shell.append(drawerHost);

  // ---- Dialog -------------------------------------------------------------
  if (state.credentialDialogOpen === true) {
    const { scrim: dialogScrim, dialog } = renderCredentialDialog(
      { state: state.credentialState ?? 'entry', remember: state.rememberCredential },
      { doc, onConnect: options.onCredentialConnect, onCancel: options.onCredentialCancel },
    );
    // Keep the dialog above its backdrop in the stacking tree. A positioned backdrop has
    // its own z-index; as siblings it can cover the static dialog and intercept every touch.
    dialogScrim.append(dialog);
    shell.append(dialogScrim);
  }

  if (state.settingsOpen === true) {
    const { scrim: settingsScrim, dialog } = renderSettingsDialog({ remember: state.rememberCredential }, {
      doc,
      onClose: options.onSettingsClose,
      onRemember: options.onRememberCredential,
      onChangeToken: options.onChangeToken,
    });
    settingsScrim.append(dialog);
    shell.append(settingsScrim);
  }

  // ---- Toasts -------------------------------------------------------------
  if (state.toasts.length > 0) {
    const region = doc.createElement('div');
    region.className = 'toast-region';
    for (const toast of state.toasts) region.append(renderToast(toast, { doc }));
    shell.append(region);
  }

  return shell;
}

/**
 * Build a fixture bundle ready for rendering. Convenience for tests and the entry point.
 *
 * @param {string} name - the fixture name.
 * @returns {object} the bundle.
 */
export function shellInputFor(name) {
  return buildFixture(name);
}
