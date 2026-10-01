import { updateMessageTimeline } from './components/message.js';
/**
 * Entry point. Mounts the shell and wires local interactions.
 *
 * ## Two modes, chosen by the fragment
 *
 * `#fixture=<known name>` → **fixture mode**: the component tree renders fixture state and
 * **no request is ever made**. Anything else, including a bare `/`, → **real REST mode**,
 * booted against the Gateway through the same-origin `/api` proxy.
 *
 * A malformed or hostile fragment cannot select fixture mode, and after a successful real
 * bootstrap no fixture data is mixed in.
 *
 * ## Network isolation in fixture mode
 *
 * Fixture mode does not construct an ApiClient and never imports one at runtime — the import
 * is dynamic and only reached in real mode.
 */

import { renderAppShell } from './components/app-shell.js';
import { applySavedTheme } from './components/settings-dialog.js';
import { buildFixture, parseFixtureFromHash, stepStreaming } from './state/fixture-state.js';
import { reduceState, selectSessionState, setDraft, clearDraftFor } from './state/ui-state.js';
import { FIXTURE_STREAM_CHUNKS } from './fixtures/messages.js';
import { FIXTURES } from './state/fixture-state.js';
import { isFixtureMode } from './api/real-mode.js';

/** The known fixture names, used to decide the mode. */
const FIXTURE_NAMES = FIXTURES.map((f) => f.name);

/**
 * Mount the UI.
 *
 * @param {object} [options] - `doc`, `root`, `autoplayStream`, `mode`, `realController`.
 * @returns {{render: Function, getState: Function, dispose: Function}} the controller.
 */
export function mount(options = {}) {
  const doc = options.doc ?? globalThis.document;
  const root = options.root ?? doc.getElementById('app');
  const hash = globalThis.location?.hash ?? '';
  applySavedTheme(doc);

  // Real mode unless an explicit, recognised fixture fragment says otherwise.
  const fixtureMode = options.mode === 'fixture'
    || (options.mode !== 'real' && isFixtureMode(hash, FIXTURE_NAMES));

  if (!fixtureMode) return mountRealMode(doc, root, options);
  return mountFixtureMode(doc, root, options);
}

/**
 * Fixture mode: state-driven rendering with no network.
 *
 * @param {object} doc - the document.
 * @param {HTMLElement} root - the mount point.
 * @param {object} options - mount options.
 * @returns {object} the controller.
 */
function mountFixtureMode(doc, root, options) {
  let fixtureName = parseFixtureFromHash(globalThis.location?.hash ?? '');
  let state = buildFixture(fixtureName).state;
  let streamTimer = null;

  const clearStreamTimer = () => {
    if (streamTimer !== null) {
      globalThis.clearTimeout?.(streamTimer);
      streamTimer = null;
    }
  };

  const handlers = {
    onToggleDrawer: () => { state = reduceState(state, { drawerOpen: !state.drawerOpen }); render(); },
    // R1.5.1: selecting records the ACTUAL session id and swaps in that session's own draft, so a
    // draft written for one session can never appear while another is selected.
    onSelectSession: (session) => {
      state = selectSessionState(state, session?.id ?? null);
      state = reduceState(state, { drawerOpen: false });
      /*
       * R1.5.2 (fixture mode only): simulate the real transition, which is asynchronous.
       *
       * Real mode clears the transcript and sets messageListStatus='loading' while GET /sessions/:id
       * and /messages are in flight. Fixture mode has no request, so without this it jumped straight
       * from A's transcript to B's with no loading window -- which would have made the loading
       * surface, the composer gating and the rotation-during-load check impossible to observe here.
       *
       * This is a HARNESS simulation of the existing production transition, not a second code path:
       * it sets the same two fields the controller sets. `render()` is driven through the same path.
       */
      if (fixtureName !== null && fixtureName !== 'real') {
        state = reduceState(state, { sessionLoading: true, messageListStatus: 'loading' });
        render();
        globalThis.setTimeout?.(() => {
          state = reduceState(state, { sessionLoading: false, messageListStatus: 'loaded' });
          render();
        }, 1500);
        return;
      }
      render();
    },
    onDraft: (value) => { state = setDraft(state, value); },
    onSend: (intent) => {
      // Only the sending session's draft is cleared; other sessions keep theirs.
      state = clearDraftFor(state, state.activeSessionId);
      state = reduceState(state, {
        toasts: [{ tone: 'success', message: intent === 'queue' ? 'Message queued' : 'Message sent' }],
        queueDepth: intent === 'queue' ? state.queueDepth + 1 : state.queueDepth,
      });
      render();
    },
    onSteer: () => {
      state = clearDraftFor(state, state.activeSessionId);
      state = reduceState(state, { toasts: [{ tone: 'success', message: 'Steered the current task' }] });
      render();
    },
    onCancel: () => { state = reduceState(state, { domain: 'cancelled', toasts: [{ tone: 'info', message: 'Run cancelled' }] }); render(); },
    // Fixture mode refuses activation and simulates the result locally, so no system picker can
    // open and no network call can occur (§6, §21).
    onUpload: () => {
      state = reduceState(state, {
        attachments: [...state.attachments, { id: `a-${state.attachments.length + 1}`, name: 'diagram.png', kind: 'image', state: 'uploaded' }],
      });
      render();
      return false;
    },
    onRemoveAttachment: (attachmentId) => {
      state = reduceState(state, { attachments: state.attachments.filter((a) => a.id !== attachmentId) });
      render();
    },
    onResyncReload: () => {
      state = reduceState(state, { resync: 'reloading' });
      render();
      globalThis.setTimeout?.(() => {
        state = reduceState(state, { resync: 'none', connection: 'connected', domain: 'idle' });
        render();
      }, 400);
    },
    onCredentialConnect: () => { state = reduceState(state, { credentialDialogOpen: false, connection: 'connected' }); render(); },
    onCredentialCancel: () => { state = reduceState(state, { credentialDialogOpen: false }); render(); },
    onSettings: () => { state = reduceState(state, { drawerOpen: false, settingsOpen: true }); render(); },
    onSettingsClose: () => { state = reduceState(state, { settingsOpen: false }); render(); },
    onRememberCredential: () => {},
    onChangeToken: () => { state = reduceState(state, { settingsOpen: false, credentialDialogOpen: true, credentialState: 'entry' }); render(); },
    onRetry: () => { state = reduceState(state, { fatal: null, connection: 'connecting' }); render(); },
  };

  function render() {
    /*
     * R1.4.2: the fixture path now mirrors the real-mode scroll contract below (mountRealMode).
     *
     * It previously lacked it entirely. The timeline kept its old scrollTop while new content grew
     * below the fold, so a genuinely scrollable fixture failed a near-bottom-follow test that real
     * mode passes -- the harness was measuring itself, not the product.
     *
     * Same threshold (< 32) and same behaviour: follow while the viewer is at the bottom, and leave
     * the position untouched when they have deliberately scrolled away.
     */
    const oldTimeline = root.querySelector('.timeline');
    const scrollTop = oldTimeline?.scrollTop ?? 0;
    const atBottom = oldTimeline ? oldTimeline.scrollHeight - oldTimeline.clientHeight - scrollTop < 32 : true;

    const bundle = buildFixture(fixtureName);
    const shell = renderAppShell(
      {
        fixture: bundle.fixture,
        state,
        messages: bundle.messages,
        sessions: bundle.sessions,
        // R1.5.1 (T3): the real selection, so the rail and drawer highlight the selected session.
        activeSessionId: state.activeSessionId,
      },
      { doc, ...handlers },
    );
    root.replaceChildren(shell);

    const timeline = root.querySelector('.timeline');
    if (timeline) timeline.scrollTop = atBottom ? timeline.scrollHeight : scrollTop;
    return shell;
  }

  function step() {
    state = stepStreaming(state);
    render();
    return state;
  }

  function onHashChange() {
    fixtureName = parseFixtureFromHash(globalThis.location?.hash ?? '');
    clearStreamTimer();
    state = buildFixture(fixtureName).state;
    render();
    if (fixtureName === 'streaming' && options.autoplayStream !== false) startStream();
  }

  function startStream() {
    clearStreamTimer();
    let remaining = FIXTURE_STREAM_CHUNKS.length;
    const tick = () => {
      if (remaining <= 0) { clearStreamTimer(); return; }
      remaining -= 1;
      step();
      streamTimer = globalThis.setTimeout?.(tick, 350) ?? null;
    };
    streamTimer = globalThis.setTimeout?.(tick, 350) ?? null;
  }

  globalThis.addEventListener?.('hashchange', onHashChange);
  render();
  if (fixtureName === 'streaming' && options.autoplayStream !== false) startStream();

  /*
   * R1.4.1 -- fixture-only deterministic stream control.
   *
   * `streamingControlled` is deliberately NOT autoplayed: a harness needs to hold an intermediate
   * state (a half-formed code fence, the caret at the stream head) still long enough to inspect it,
   * which a 350ms timer makes impossible.
   *
   * This hook advances the SAME state through the SAME `step()` used by the autoplay path, so the
   * controlled fixture exercises the production streaming renderer rather than a parallel one. It is
   * only defined in fixture mode; real mode never reaches this code.
   */
  globalThis.__dshFixtureStep = () => {
    const before = state.streaming?.index ?? 0;
    step();
    return { index: state.streaming?.index ?? before, domain: state.domain, done: state.streaming === null };
  };

  return {
    mode: 'fixture',
    render,
    step,
    getState: () => state,
    getFixtureName: () => fixtureName,
    dispose: () => {
      clearStreamTimer();
      globalThis.removeEventListener?.('hashchange', onHashChange);
      delete globalThis.__dshFixtureStep;
    },
  };
}

/**
 * Real REST mode: boot against the Gateway and render server data only.
 *
 * @param {object} doc - the document.
 * @param {HTMLElement} root - the mount point.
 * @param {object} options - mount options; `realController` injects a preconfigured controller.
 * @returns {Promise<object>} the controller.
 */
async function mountRealMode(doc, root, options) {
  const [{ ApiClient }, { CredentialStore }, { RealModeController }, { LiveSessionBinding }] =
    await Promise.all([
      import('./api/api-client.js'),
      import('./api/credential-store.js'),
      import('./api/real-mode.js'),
      import('./ws/live-session.js'),
    ]);

  const controller = options.realController ?? (() => {
    // The socket binding owns the EventClient; the controller only drives session selection.
    const binding = new LiveSessionBinding();

    return new RealModeController({
      client: new ApiClient({}),
      credentials: new CredentialStore({}),
      live: binding,
      onChange: () => { render(); },
    });
  })();
  const previousOnChange = controller.onChange;
  const messageCache = new Map();
  let renderTimer = null, disposed = false, previousChrome = null;
  const renderStats = { notifications: 0, fullRenders: 0, timelineUpdates: 0, renderMs: 0, maxRenderMs: 0 };
  function scheduleRender() {
    if (disposed) return;
    renderStats.notifications += 1;
    // Apply every protocol event immediately; coalesce only its presentation.
    const terminal = ['completed','failed','cancelled'].includes(controller.state.domain);
    if (renderTimer !== null && !terminal) return;
    if (renderTimer !== null) globalThis.clearTimeout(renderTimer);
    renderTimer = globalThis.setTimeout(() => { renderTimer = null; render(); }, terminal ? 0 : 80);
  }
  controller.onChange = scheduleRender;

  /** Render the shell from real controller state. */
  function render() {
    if (disposed) return null;
    const started = globalThis.performance?.now() ?? Date.now();
    const finishRender = () => {
      const elapsed = (globalThis.performance?.now() ?? Date.now()) - started;
      renderStats.renderMs += elapsed;
      renderStats.maxRenderMs = Math.max(renderStats.maxRenderMs, elapsed);
    };
    const oldTimeline = root.querySelector('.timeline');
    const scrollTop = oldTimeline?.scrollTop ?? 0;
    const atBottom = oldTimeline ? oldTimeline.scrollHeight - oldTimeline.clientHeight - scrollTop < 32 : true;
    const oldField = root.querySelector('textarea');
    const fieldFocused = doc.activeElement === oldField && oldField !== null;
    const selection = fieldFocused ? [oldField.selectionStart, oldField.selectionEnd] : null;
    const state = controller.state;
    // Map real-mode state onto the same component props the fixture path uses, so one tree
    // serves both modes and the semantics cannot diverge.
    const fixture = { name: 'real', screen: 'live', title: 'DeepSeek Harness', auxiliary: true };
    // The transcript is the REST snapshot plus any transient streaming message. A streaming
    // message is appended, never substituted for the snapshot.
    const streaming = controller.live?.streamMessages ?? [];
    const messages = [...state.messages, ...streaming];

    // The live socket owns the connection axis once it exists; REST owns it before that.
    const connection = controller.recovery ? state.connection : (controller.live?.uiConnection() ?? state.connection);

    const chrome = { ...state, connection };
    delete chrome.messages;
    delete chrome.draft;
    delete chrome.draftsBySessionId;
    const sameChrome = previousChrome
      && Object.keys(chrome).length === Object.keys(previousChrome).length
      && Object.keys(chrome).every(key => chrome[key] === previousChrome[key]);
    if (sameChrome && state.settingsOpen === true && !oldTimeline) {
      // Incoming tokens must not recreate sliders or steal focus in the settings screen.
      finishRender();
      return root.firstChild;
    }
    if (sameChrome && oldTimeline && (!oldField || oldField.value === state.draft)) {
      updateMessageTimeline(oldTimeline, messages, { doc, messageCache });
      oldTimeline.scrollTop = atBottom ? oldTimeline.scrollHeight : scrollTop;
      renderStats.timelineUpdates += 1;
      finishRender();
      return root.firstChild;
    }
    previousChrome = chrome;
    renderStats.fullRenders += 1;
    const shell = renderAppShell(
      {
        fixture,
        state: {
          domain: state.domain,
          connection,
          drawerOpen: state.drawerOpen ?? false,
          credentialDialogOpen: state.credentialDialogOpen,
          credentialState: state.credentialState,
          rememberCredential: controller.credentials.isRemembered(),
          settingsOpen: state.settingsOpen === true,
          draft: state.draft,
          queueDepth: state.queueDepth ?? 0,
          attachments: state.attachments,
          agentPresetRoster: state.agentPresetRoster,
          selectedAgentPreset: state.selectedAgentPreset,
          modelCatalog: state.modelCatalog,
          modelSelection: state.modelSelection,
          settingsMenuOpen: state.settingsMenuOpen === true,
          configurationLoading: state.configurationLoading === true,
          configurationAction: state.configurationAction ?? null,
          configurationError: state.configurationError ?? null,
          // Action substates, never domain states (R8F §24). They describe what the user just
          // asked for; `domain` continues to describe what the server reported.
          sendState: state.sendState ?? 'idle',
          error: state.error,
          cancelState: state.cancelState ?? 'idle',
          resync: state.resync ?? (connection === 'resync_required' ? 'ready_to_reload' : 'none'),
          sessionUnavailable: state.sessionUnavailable,
          streaming: null,
          retainTimeline: state.activeSessionId !== null,
          // R1.5.2: the chat pane owns session loading; the connection badge keeps owning connection.
          sessionLoading: state.messageListStatus === 'loading',
          // Older-history paging is controller state, exactly as in fixture mode. Without these the
          // shell can never render the affordance the onLoadOlder handler below is wired to.
          hasOlderMessages: state.hasOlderMessages === true,
          olderMessagesStatus: state.olderMessagesStatus ?? 'idle',
          // The create-in-flight guard the New session control disables itself on.
          creatingSession: state.creatingSession === true,
          fatal: state.fatal,
          newSessionError: state.newSessionError ?? null,
          toasts: state.toasts ?? [],
        },
        messages,
        sessions: state.sessions,
        // R1.5.1 (T3): real mode already tracked the selection; it is now actually rendered.
        activeSessionId: state.activeSessionId,
      },
      {
        doc,
        messageCache,
        onToggleDrawer: () => { controller.updateRecovery({ drawerOpen: !controller.state.drawerOpen }); },
        onSelectSession: (session) => { void controller.selectSession(session.id); },
        onRenameSession: (session, title) => controller.renameSession(session, title),
        onDeleteSession: (session) => controller.deleteSession(session),
        onArchiveWorkspace: (workspaceKey) => controller.archiveWorkspace(workspaceKey),
        // R9: "New session" creates through the Gateway and opens it. The controller is async and
        // drives rendering through onChange, so the click is fire-and-forget here.
        onNewSession: () => { void controller.newSession(); },
        onCreateSessionInWorkspace: (workspaceKey) => { void controller.newSession({ workspaceKey }); },
        // Older-history paging is likewise a controller round trip; it re-renders via onChange.
        onLoadOlder: () => { void controller.loadOlderMessages(); },
        // R1.5.1: record the draft against the selected session, not against a single global slot.
        onDraft: (value) => {
          controller.state = setDraft(controller.state, value);
          if (controller.state.sendState === 'failed') controller.updateRecovery({ sendState: 'idle', error: null });
        },
        onSend: (intent) => {
          void controller.send({
            content: controller.state.draft,
            // The intent the button expressed becomes the mode that is transmitted.
            mode: intent === 'steer' ? 'steer' : 'queue',
          });
        },
        onSteer: () => {
          void controller.send({ content: controller.state.draft, mode: 'steer' });
        },
        onCancel: () => { void controller.cancel(); },
        onToggleSettings: (open) => { void controller.toggleConfigurationPanel(open); },
        onSelectAgentPreset: (agentPreset) => { void controller.applyAgentPreset(agentPreset); },
        onSelectModel: (selection) => { void controller.applyModelSelection(selection); },
        // Real mode: allow the composer to activate the hidden file input, which is what makes the
        // Android WebView raise its file chooser. Selection only records a local attachment — it
        // never uploads.
        onUpload: () => true,
        onFileSelected: (file) => { controller.addLocalAttachment(file); render(); },
        onRemoveAttachment: (attachmentId) => { controller.removeAttachment(attachmentId); render(); },
        onSettings: () => { controller.updateRecovery({ drawerOpen: false, settingsOpen: true }); },
        onSettingsClose: () => { controller.updateRecovery({ settingsOpen: false }); },
        onRememberCredential: (remember) => {
          if (controller.setRememberCredential(remember)) render();
        },
        onChangeToken: () => {
          controller.updateRecovery({ settingsOpen: false });
          controller.signOut();
        },
        onResyncReload: () => { void controller.recovery?.reload(); },
        onCredentialConnect: (token, remember) => {
          controller.setRememberCredential(remember === true);
          void controller.submitCredential(token);
        },
        onCredentialCancel: () => {},
        onRetry: () => { void controller.boot(); },
      },
    );
    root.replaceChildren(shell);
    const timeline = root.querySelector('.timeline');
    if (timeline) timeline.scrollTop = atBottom ? timeline.scrollHeight : scrollTop;
    if (fieldFocused) {
      const field = root.querySelector('textarea');
      field?.focus();
      field?.setSelectionRange?.(...selection);
    }
    finishRender();
    return shell;
  }

  await controller.boot();
  render();

  return {
    mode: 'real',
    render,
    getState: () => controller.state,
    getRenderStats: () => ({ ...renderStats }),
    controller,
    dispose: () => {
      disposed = true;
      if (renderTimer !== null) globalThis.clearTimeout(renderTimer);
      messageCache.clear();
      controller.dispose();
      controller.sessionAbort = null;
      controller.onChange = previousOnChange;
    },
  };
}

// Auto-mount in a browser; tests import `mount` directly and pass their own document.
if (typeof globalThis.document !== 'undefined' && globalThis.document.getElementById?.('app')) {
  void mount();
}
