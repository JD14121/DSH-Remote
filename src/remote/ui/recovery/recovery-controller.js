import { ApiError, ERROR_KIND, errorFromThrow } from '../api/errors.js';
import { normalizeMessage, normalizeDurableFrame } from '../api/normalizers.js';
import { DOMAIN_STATES } from '../state/ui-state.js';
import { readReplacement } from './timeline-reconciler.js';

/** Browser recovery orchestration. REST transport and socket ownership stay in their layers. */
export class RecoveryController {
  constructor({ owner, live, timeoutMs = 15000 }) {
    this.owner = owner;
    this.live = live;
    this.timeoutMs = timeoutMs;
    this.generation = 0;
    this.pending = null;
    this.abort = null;
    this.timer = null;
    this.confirmationTimer = null;
    this.finishReplay = null;
    this.wasDisconnected = false;
    live.onConnectionChange = state => this.transportChanged(state);
    live.onResyncRequired = reason => this.requireResync(reason);
    live.onStreamChange = () => this.patch({});
    live.onDomainEvent = event => this.domainChanged(event);
  }

  patch(value) { this.owner.updateRecovery(value); }

  /** Invalidate REST, timers, socket callbacks and reconnect work before switching sessions. */
  cancel() {
    this.generation += 1;
    this.abort?.abort();
    this.abort = null;
    clearTimeout(this.timer);
    clearTimeout(this.confirmationTimer);
    this.finishReplay?.(false);
    this.finishReplay = null;
    this.pending = null;
    this.live.unbind();
    this.wasDisconnected = false;
  }

  dispose() { this.cancel(); }

  async connect(sessionId, lastSequence) {
    this.live.credential = this.owner.client.credential;
    await this.live.bind({ sessionId, lastSequence, requireStreamStart: true });
  }

  requireResync(input = {}) {
    if (!this.owner.state.activeSessionId) return;
    const messages = this.retireLive();
    this.patch({
      connection: 'resync_required',
      resync: this.pending ? 'reload_failed' : 'ready_to_reload',
      recoveryReason: ['gap', 'overflow', 'resync-required'].includes(input.reason) ? input.reason : 'resync-required',
      messages,
      fatal: null,
    });
    this.finishReplay?.(false);
    void this.reload();
  }

  /** Retiring a binding must retain partial presentation text until REST replaces it. */
  retireLive() {
    const partials = this.live.streamMessages.map(message => ({ ...message, streaming: false, interrupted: true }));
    const ids = new Set(this.owner.state.messages.map(message => message.id));
    this.live.unbind();
    const additions = partials.filter(message => !ids.has(message.id));
    return additions.length ? [...this.owner.state.messages, ...additions] : this.owner.state.messages;
  }

  /** Exactly one reload chain, including ticket/handshake, until success or failure. */
  reload() {
    if (this.pending) return this.pending;
    const sessionId = this.owner.state.activeSessionId;
    if (!sessionId || this.owner.state.connection === 'auth_required' || this.owner.state.sessionUnavailable) {
      return Promise.resolve(false);
    }
    const generation = ++this.generation;
    this.wasDisconnected = false;
    const abort = new AbortController();
    this.abort = abort;
    const current = () => generation === this.generation && sessionId === this.owner.state.activeSessionId;
    this.live.unbind();
    this.patch({ connection: 'resync_required', resync: 'loading', fatal: null, error: null });
    // Install single-flight before the first asynchronous operation or user callback can run.
    this.pending = Promise.resolve().then(async () => {
      let timedOut = false;
      const timeout = new Promise((_, reject) => {
        this.timer = setTimeout(() => { timedOut = true; abort.abort(); reject(new ApiError(ERROR_KIND.NETWORK)); }, this.timeoutMs);
      });
      try {
        const replacement = await Promise.race([readReplacement(this.owner.client, sessionId, abort.signal, () => current() && !abort.signal.aborted), timeout]);
        if (!current() || replacement === null) return false;
        this.patch({ ...replacement, connection: 'connecting', resync: 'loading', recoveryReason: null });
        const replay = new Promise(resolve => { this.finishReplay = resolve; });
        // Ticket transport is owned by the existing binding; every bind creates a fresh generation.
        void this.connect(sessionId, replacement.lastSequence).catch(error => {
          if (current()) this.fail(error);
        });
        return await Promise.race([replay, timeout]);
      } catch (error) {
        if (current()) this.fail(timedOut ? new ApiError(ERROR_KIND.NETWORK) : error);
        return false;
      } finally {
        if (current()) {
          clearTimeout(this.timer);
          this.abort = null;
          this.finishReplay = null;
          this.pending = null;
        }
      }
    });
    return this.pending;
  }

  fail(cause) {
    const error = errorFromThrow(cause);
    const messages = this.retireLive();
    if (error.kind === ERROR_KIND.AUTH_REQUIRED) {
      this.owner.credentials.clear();
      this.owner.client.setCredential(null);
      this.live.credential = null;
      this.patch({ messages, connection: 'auth_required', credentialDialogOpen: true, credentialState: 'invalid', resync: 'reload_failed', error, fatal: null });
    } else {
      this.patch({ messages, connection: 'resync_required', resync: 'reload_failed', error, fatal: null,
        sessionUnavailable: error.kind === ERROR_KIND.NOT_FOUND });
      if (error.kind === ERROR_KIND.NOT_FOUND) void this.refreshMissingSession();
    }
    this.finishReplay?.(false);
  }

  async refreshMissingSession() {
    const generation = this.generation;
    try {
      const page = await this.owner.client.listSessions();
      if (generation !== this.generation) return;
      this.patch({ sessions: page.sessions, sessionListStatus: page.sessions.length ? 'loaded' : 'empty' });
    } catch (error) {
      if (generation !== this.generation) return;
      if (error?.kind === ERROR_KIND.AUTH_REQUIRED) this.fail(error);
      else this.patch({ sessionListStatus: 'error' });
    }
  }

  transportChanged(state) {
    if (state.resyncRequired) return; // the binding reports the explicit recovery trigger next
    if (state.uiConnection === 'auth_required') { this.fail(new ApiError(ERROR_KIND.AUTH_REQUIRED)); return; }
    if (state.exhausted) {
      const messages = this.retireLive();
      this.patch({ messages, connection: 'gateway_unavailable', resync: 'reload_failed', fatal: null });
      this.finishReplay?.(false);
      return;
    }
    if (state.uiConnection === 'reconnecting') this.wasDisconnected = true;
    if (state.uiConnection === 'connected') {
      const recovered = this.pending !== null || this.wasDisconnected;
      const refreshAfterReconnect = recovered && this.pending === null;
      this.patch({ connection: 'connected', resync: recovered ? 'reconnected' : 'none', error: null, fatal: null });
      this.finishReplay?.(true);
      if (recovered) {
        const generation = this.generation;
        clearTimeout(this.confirmationTimer);
        this.confirmationTimer = setTimeout(() => {
          if (generation === this.generation && this.owner.state.resync === 'reconnected') this.patch({ resync: 'none' });
        }, 1800);
      }
      this.wasDisconnected = false;
      if (refreshAfterReconnect) {
        void Promise.allSettled([this.owner.loadSessions(), this.reload()]);
      }
    } else {
      this.patch({ connection: this.wasDisconnected && state.uiConnection === 'connecting' ? 'reconnecting' : state.uiConnection });
    }
  }

  domainChanged(event) {
    if (event.kind === 'stream-end') {
      const message = event.message;
      if (Number.isSafeInteger(message.turn) && this.owner.state.messages.some(m =>
        m.role === 'assistant' && !m.id?.startsWith('stream:') && m.turn === message.turn && m.step === message.step)) return;
      this.patch({ messages: [...this.owner.state.messages.filter(m => m.id !== message.id), message] });
      return;
    }
    if (event.kind !== 'domain') { this.patch({}); return; }
    const frame = event.frame;
    if (frame.event === 'session.status' && DOMAIN_STATES.includes(frame.data?.status)) {
      const queueDepth = frame.data.queue_depth;
      this.patch({ domain: frame.data.status,
        queueDepth: Number.isSafeInteger(queueDepth) && queueDepth >= 0 ? queueDepth : this.owner.state.queueDepth });
    }
    if (frame.event === 'unknown' && frame.data?.dsh_event === 'session/title') {
      const title = frame.data.payload?.title;
      const sessionId = frame.session_id;
      if (typeof title === 'string' && typeof sessionId === 'string') {
        const existing = this.owner.state.sessions.find((session) => session.id === sessionId);
        this.patch({ sessions: this.owner.state.sessions.map((session) => session.id === sessionId ? { ...session, title } : session) });
        if (existing && existing.title !== title) this.owner.notifySessionRenamed?.(title);
      }
      return;
    }
    const terminal = { 'task.failed': 'failed', 'task.cancelled': 'cancelled', 'task.completed': 'completed' }[frame.event];
    if (terminal) this.patch({ domain: terminal });
    if (['message.created','tool.started','tool.completed','task.progress','session.status'].includes(frame.event)) {
      const raw = frame.data?.message ?? frame.data;
      if (raw?.event_type === 'session/title') {
        const title = raw.content?.title;
        if (typeof title === 'string') {
          const existing = this.owner.state.sessions.find((session) => session.id === raw.session_id);
          const sessions = this.owner.state.sessions.map((session) => session.id === raw.session_id ? { ...session, title } : session);
          this.patch({ sessions });
          if (existing && existing.title !== title) this.owner.notifySessionRenamed?.(title);
        }
        return;
      }
      const message = normalizeDurableFrame(frame) ?? normalizeMessage(raw);
      if (message && !this.owner.state.messages.some(m => m.id === message.id)) {
        this.patch({ messages: [...this.owner.state.messages.filter(m => !(m.id?.startsWith('stream:')
          && Number.isSafeInteger(message.turn) && m.turn === message.turn && m.step === message.step
          && message.role === 'assistant')), message] });
      }
    }
  }
}
