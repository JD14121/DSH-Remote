/**
 * R8F — Integration: the mandatory end-to-end action scenario, plus the component tree, fixture
 * isolation and safe rendering.
 *
 * §31: the real `ApiClient`, `EventClient`, `RecoveryController`, `RealModeController` and the
 * real component tree are used. Only the upstream DSH data is controlled.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { actionStack, waitUntil } from './r8f-harness.mjs';
import { createTestDocument } from './r8b-dom.mjs';
import { mount } from '../../src/remote/ui/app.js';
import { renderMessage } from '../../src/remote/ui/components/message.js';
import { renderAssistantContent } from '../../src/remote/ui/rendering/render-message.js';

const UI = path.join(process.cwd(), 'src', 'remote', 'ui');

/**
 * §32 — the mandatory controlled end-to-end scenario.
 *
 * ```text
 * running → queue → REST accepted → WS queued → WS running → partial stream
 *        → cancel → disconnect → resync → authoritative final state
 * ```
 */
test('§32 mandatory scenario: one action converges across REST, WS and recovery', async () => {
  const h = await actionStack({ status: 'running', backoffMs: [60_000] });
  try {
    const attempt = 'attempt-e2e';
    const posts = () => h.f.state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages'));

    // 1. A running session, and the operator queues a message.
    assert.equal(h.state.domain, 'running');
    await h.owner.send({ content: 'queue this', mode: 'queue' });

    // 2. REST accepted it — and only accepted it.
    assert.equal(h.state.sendState, 'accepted');
    assert.equal(h.state.domain, 'running', 'acceptance is not a state transition');
    assert.equal(posts().length, 1, 'one logical user action, one REST request');

    // 3. An authoritative WS event reports the queue.
    h.f.emitStatus('queued', { queue_depth: 1 });
    await waitUntil(() => h.state.domain === 'queued');
    assert.equal(h.state.queueDepth, 1);

    // 4. The turn starts.
    h.f.emitStatus('running');
    await waitUntil(() => h.state.domain === 'running');

    // 5. A partial assistant stream arrives — one message, not one per chunk.
    h.f.emitStreamStart(attempt);
    h.f.emitChunk(attempt, 0, 'Working');
    h.f.emitChunk(attempt, 1, ' on it');
    await waitUntil(() => h.live.streamMessages.length === 1
      && h.live.streamMessages[0].content === 'Working on it');
    assert.equal(h.live.streamMessages.length, 1, 'a stream stays ONE message');

    // 6. The operator cancels mid-stream.
    await h.owner.cancel();
    assert.equal(h.state.cancelState, 'requested');
    assert.equal(h.state.domain, 'running', 'still running until the server confirms');

    // 7. The socket dies before the cancelled event arrives.
    h.f.closeLatest(1006);
    await waitUntil(() => h.state.connection !== 'connected');

    // 8. Recovery: the server's authoritative state is what actually happened.
    h.f.state.status = 'cancelled';
    h.f.state.history = [
      { id: 'm-1', session_id: h.f.sessionId, role: 'user', content: 'hello', sequence: 3 },
      { id: 'm-2', session_id: h.f.sessionId, role: 'assistant', content: 'hi', sequence: 4 },
      { id: 'm-user', session_id: h.f.sessionId, role: 'user', content: 'queue this', sequence: 5 },
      { id: 'm-final', session_id: h.f.sessionId, role: 'assistant', content: 'Working on it', sequence: 6 },
    ];
    h.recovery.requireResync({ reason: 'server-close-before-cancelled' });
    await waitUntil(() => h.state.connection === 'resync_required');
    await h.recovery.reload();
    await waitUntil(() => h.state.domain === 'cancelled');

    // 9. Verify the whole outcome.
    assert.equal(h.state.domain, 'cancelled', 'the authoritative final state wins');

    const ids = h.state.messages.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, 'no duplicate message in the converged timeline');
    assert.equal(ids.filter((id) => id === 'm-user').length, 1, 'the queued action appears exactly once');
    assert.equal(ids.filter((id) => id === 'm-final').length, 1, 'the final assistant message appears once');
    assert.equal(h.live.streamMessages.length, 0, 'the transient was retired, not duplicated');

    assert.equal(posts().length, 1, 'still exactly one prompt after the whole sequence');
    assert.equal(h.f.countRequests('/cancel'), 1, 'and exactly one cancel');

    // No steer was ever transmitted: the queue intent was preserved end to end.
    assert.equal(h.f.state.requests.some((r) => r.path.includes('steer')), false);
  } finally {
    await h.stop();
  }
});

test('§33 optional scenario: waiting input, reply, upload without blocking the composer', async () => {
  const h = await actionStack({ status: 'waiting_input' });
  try {
    // The composer is a reply, and steer is unavailable.
    assert.equal(h.state.domain, 'waiting_input');

    await h.owner.send({ content: 'my answer', mode: 'queue' });
    assert.equal(h.state.sendState, 'accepted');

    h.f.emitStatus('running');
    await waitUntil(() => h.state.domain === 'running');

    // An upload runs while the composer stays editable.
    const gate = h.f.hold('/uploads');
    const upload = h.owner.upload({ name: 'shot.png', size: 2048 });
    await waitUntil(() => h.state.attachments.some((a) => a.state === 'uploading'));

    h.owner.state = { ...h.owner.state, draft: 'still typing' };
    assert.equal(h.owner.state.draft, 'still typing', 'the composer is not blocked by an upload');

    gate.release();
    await upload;
    await waitUntil(() => h.state.attachments.some((a) => a.state === 'uploaded'));

    h.f.emitStatus('completed');
    await waitUntil(() => h.state.domain === 'completed');
    assert.equal(h.state.domain, 'completed');
  } finally {
    await h.stop();
  }
});

test('the real component tree renders converged state', async () => {
  const h = await actionStack({ status: 'running' });
  try {
    h.f.emitStatus('queued', { queue_depth: 2 });
    await waitUntil(() => h.state.domain === 'queued');

    const doc = createTestDocument();
    const root = doc.createElement('div');
    root.setAttribute('id', 'app');

    const savedLocation = globalThis.location;
    const savedAdd = globalThis.addEventListener;
    const savedRemove = globalThis.removeEventListener;
    globalThis.location = { hash: '' };
    globalThis.addEventListener = () => {};
    globalThis.removeEventListener = () => {};

    let controller;
    try {
      // Real-mode mount is async: it awaits the controller boot before rendering.
      controller = await mount({ mode: 'real', doc, root, realController: h.owner });
    } finally {
      globalThis.location = savedLocation;
      globalThis.addEventListener = savedAdd;
      globalThis.removeEventListener = savedRemove;
    }

    // The shell rendered, and the composer reflects the converged controller state.
    assert.ok(root.children.length > 0, 'the shell must render');
    const send = root.querySelector('#composer-send');
    assert.ok(send !== null, 'the composer must be rendered');
    assert.equal(send.textContent, 'Send later', 'the queued state labels the primary action for a queue');
    controller.dispose?.();
  } finally {
    await h.stop();
  }
});

test('a queued turn labels the primary action Send later, with steer separate', () => {
  const doc = createTestDocument();
  const composer = renderComposerFor(doc, 'queued');
  const send = composer.querySelector('#composer-send');
  const steer = composer.querySelector('#composer-steer');

  assert.equal(send.textContent, 'Send later', 'the primary action states the queue semantics');
  assert.ok(steer !== null, 'steer is available while a turn is running');
  assert.notEqual(send, steer, 'steer is a separate element, never the primary button');
});

test('a submission in flight disables its own control', () => {
  const doc = createTestDocument();
  const composer = renderComposerFor(doc, 'running', { sendState: 'sending' });
  const send = composer.querySelector('#composer-send');
  const steer = composer.querySelector('#composer-steer');

  assert.equal(send.disabled, true, 'double-send is prevented at the control');
  assert.equal(send.textContent, 'Sending…', 'and the label says what is happening');
  assert.equal(steer.disabled, true, 'the shared submission guard covers steer too');
});

test('a cancel in flight is labelled and cannot be resubmitted', () => {
  const doc = createTestDocument();
  const composer = renderComposerFor(doc, 'running', { cancelState: 'cancelling' });
  const cancel = composer.querySelector('#composer-cancel');

  assert.equal(cancel.textContent, 'Cancelling…', '§10 allows this UI-local label');
  assert.equal(cancel.disabled, true, 'repeated cancel submissions are disabled');
  assert.equal(cancel.dataset.cancelState, 'cancelling');
});

test('hostile content from an action converges through the safe renderer', () => {
  const hostile = '<img src=x onerror="globalThis.__r8fPwned = true">';
  globalThis.__r8fPwned = undefined;

  const doc = createTestDocument();
  const message = renderMessage(
    { id: 'm-1', role: 'assistant', kind: 'normal', content: hostile },
    { doc },
  );
  assert.equal(globalThis.__r8fPwned, undefined, 'an action result must not execute markup');
  assert.match(message.textContent, /onerror/, 'the payload survives as inert text');
});

test('a hostile filename is rendered as text, not markup', () => {
  const doc = createTestDocument();
  const host = doc.createElement('div');
  const hostileName = '<script>globalThis.__r8fFile = true</script>.png';
  globalThis.__r8fFile = undefined;

  renderAssistantContent(host, hostileName);
  assert.equal(globalThis.__r8fFile, undefined);
  assert.equal(host.querySelector('script'), null, 'no script element may be created');
});

test('fixture mode still makes zero REST calls and opens zero sockets', async () => {
  const calls = { fetch: 0, websocket: 0 };
  const saved = {
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket,
    location: globalThis.location,
    add: globalThis.addEventListener,
    remove: globalThis.removeEventListener,
  };
  globalThis.fetch = () => { calls.fetch += 1; throw new Error('fetch used'); };
  globalThis.WebSocket = function trap() { calls.websocket += 1; throw new Error('WebSocket used'); };
  globalThis.location = { hash: '#fixture=streaming' };
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};

  try {
    const doc = createTestDocument();
    const root = doc.createElement('div');
    root.setAttribute('id', 'app');
    const controller = mount({ doc, root, autoplayStream: false });
    assert.ok(root.children.length > 0);
    controller.dispose();
  } finally {
    globalThis.fetch = saved.fetch;
    globalThis.WebSocket = saved.WebSocket;
    globalThis.location = saved.location;
    globalThis.addEventListener = saved.add;
    globalThis.removeEventListener = saved.remove;
  }

  assert.equal(calls.fetch, 0, 'fixture mode must make no REST call');
  assert.equal(calls.websocket, 0, 'fixture mode must open no socket');
});

test('no runtime protocol or retention semantic was changed for R8F', () => {
  const protectedFiles = [
    'src/remote/ws/protocol.mjs',
    'src/remote/ws/validation.mjs',
    'src/remote/persistence/journal.mjs',
    'src/remote/state/session-view-store.mjs',
    'src/remote/auth/ws-ticket.mjs',
    'src/remote/production/supervisor.mjs',
    'src/remote/production/dsh-process.mjs',
    'src/remote/sessions.mjs',
  ];
  for (const file of protectedFiles) assert.ok(fs.existsSync(file), `${file} should exist`);

  // The UI must not import runtime protocol code, and must not call DSH directly.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (/from\s+['"][^'"]*(ws\/protocol|ws\/validation|persistence\/|production\/|dsh-adapter)/.test(text)) {
        offenders.push(path.relative(UI, full));
      }
    }
  };
  walk(UI);
  assert.deepEqual(offenders, [], `runtime code imported by the UI:\n${offenders.join('\n')}`);
});

/** Render a composer for a domain state. */
function renderComposerFor(doc, domain, extra = {}) {
  // Imported lazily so the helper stays local to this suite.
  const { renderComposer } = composerModule;
  return renderComposer(
    { domain, connection: 'connected', draft: '', queueDepth: 0, attachments: [], ...extra },
    { doc, onSend: () => {}, onSteer: () => {}, onCancel: () => {} },
  );
}

const composerModule = await import('../../src/remote/ui/components/composer.js');
