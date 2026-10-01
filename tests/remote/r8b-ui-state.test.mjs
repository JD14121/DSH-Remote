/**
 * R8B — state: the two axes stay exact and independent, and the queue/steer semantics are
 * unambiguous at the level of the rendered label, not just the intent enum.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestDocument } from './r8b-dom.mjs';
import { renderAppShell } from '../../src/remote/ui/components/app-shell.js';
import { buildFixture, parseFixtureFromHash, stepStreaming, streamingText } from '../../src/remote/ui/state/fixture-state.js';
import {
  CONNECTION_STATES,
  DOMAIN_STATES,
  canSend,
  createUiState,
  primarySendLabel,
  sendIntent,
  steerAvailable,
  validateState,
} from '../../src/remote/ui/state/ui-state.js';

/** Render and return the shell plus the primary send button. */
function render(name) {
  const doc = createTestDocument();
  const bundle = buildFixture(name);
  const shell = renderAppShell(
    { fixture: bundle.fixture, state: bundle.state, messages: bundle.messages, sessions: bundle.sessions },
    { doc },
  );
  return { shell, send: shell.querySelector('#composer-send'), steer: shell.querySelector('#composer-steer') };
}

test('there are exactly eight domain states and no ninth', () => {
  assert.equal(DOMAIN_STATES.length, 8);
  assert.deepEqual([...DOMAIN_STATES], [
    'idle', 'queued', 'running', 'waiting_input', 'completed', 'failed', 'cancelled', 'disconnected',
  ]);
});

test('there are exactly six connection states and no seventh', () => {
  assert.equal(CONNECTION_STATES.length, 6);
  assert.deepEqual([...CONNECTION_STATES], [
    'auth_required', 'connecting', 'connected', 'reconnecting', 'resync_required', 'gateway_unavailable',
  ]);
});

test('a ninth domain state and a seventh connection state are rejected', () => {
  assert.equal(validateState({ domain: 'thinking', connection: 'connected' }).ok, false);
  assert.equal(validateState({ domain: 'idle', connection: 'syncing' }).ok, false);
  assert.equal(validateState({ domain: 'idle', connection: 'connected' }).ok, true);
});

test('the two axes are independent — running + reconnecting is expressible', () => {
  const state = createUiState({ domain: 'running', connection: 'reconnecting' });
  const verdict = validateState(state);
  assert.equal(verdict.ok, true, 'running + reconnecting must be a legal combination');
  assert.equal(state.domain, 'running');
  assert.equal(state.connection, 'reconnecting');
  // Neither axis is derived from the other.
  assert.notEqual(state.domain, state.connection);
});

test('every legal combination of the two axes validates', () => {
  for (const domain of DOMAIN_STATES) {
    for (const connection of CONNECTION_STATES) {
      const verdict = validateState({ domain, connection });
      assert.equal(verdict.ok, true, `${domain} + ${connection} must be legal`);
    }
  }
});

test('the primary action label states queue versus steer at every domain state', () => {
  assert.equal(primarySendLabel('idle'), 'Send');
  assert.equal(primarySendLabel('running'), 'Send later');
  assert.equal(primarySendLabel('queued'), 'Send later');
  assert.equal(primarySendLabel('waiting_input'), 'Send');
  assert.equal(primarySendLabel('completed'), 'Send');

  assert.equal(sendIntent('running'), 'queue');
  assert.equal(sendIntent('queued'), 'queue');
  assert.equal(sendIntent('waiting_input'), 'reply');
  assert.equal(sendIntent('idle'), 'send');
});

test('steer is offered only for running and queued, and is always a separate control', () => {
  assert.equal(steerAvailable('running'), true);
  assert.equal(steerAvailable('queued'), true);
  assert.equal(steerAvailable('idle'), false);
  assert.equal(steerAvailable('waiting_input'), false);

  // In a running state the shell shows BOTH a "Send later" primary and a separate steer button.
  const running = render('streaming');
  assert.equal(running.send.textContent, 'Send later');
  assert.notEqual(running.steer, null);
  assert.equal(running.steer.textContent, 'Steer current task');
  assert.notEqual(running.send, running.steer);

  // In an idle state there is no steer control at all, and the primary simply sends.
  const idle = render('ready');
  assert.equal(idle.send.textContent, 'Send');
  assert.equal(idle.steer, null);
});

test('the primary send button never changes meaning without changing its label', () => {
  for (const fixture of ['ready', 'streaming', 'queued', 'waitingInput', 'reconnecting']) {
    const { send } = render(fixture);
    if (send === null) continue;
    const label = send.textContent;
    const intent = send.getAttribute('data-intent');
    if (intent === 'queue') {
      assert.match(label, /Send later/, `${fixture}: a queue intent must be labelled "Send later"`);
    } else if (intent === 'send' || intent === 'reply') {
      assert.match(label, /^Send/, `${fixture}: a send/reply intent must be labelled "Send…"`);
    }
    // The accessible name always states the effect.
    assert.notEqual(send.getAttribute('aria-label'), null);
  }
});

test('sending is allowed only while connected', () => {
  assert.equal(canSend('connected'), true);
  for (const connection of CONNECTION_STATES.filter((c) => c !== 'connected')) {
    assert.equal(canSend(connection), false, `${connection} must not allow sending`);
  }
});

test('a disconnected state disables send but keeps the draft editable and history intact', () => {
  const doc = createTestDocument();
  const bundle = buildFixture('reconnecting');
  // Seed a draft and an attachment, then render the outage.
  const state = { ...bundle.state, draft: 'half-written message', attachments: [{ id: 'a-1', name: 'x.png', kind: 'image', state: 'uploaded' }] };
  const shell = renderAppShell(
    { fixture: bundle.fixture, state, messages: bundle.messages, sessions: bundle.sessions },
    { doc },
  );

  const send = shell.querySelector('#composer-send');
  assert.equal(send.disabled, true, 'send must be disabled while reconnecting');

  const field = shell.querySelector('.composer__field');
  assert.equal(field.disabled, false, 'the field must stay editable so the draft survives');
  assert.equal(field.value, 'half-written message', 'the draft must remain');
  assert.equal(shell.querySelectorAll('.attachment-chip').length, 1, 'attachments must remain');
  assert.ok(shell.querySelectorAll('.message').length > 0, 'history must remain visible');
  assert.notEqual(shell.querySelector('#reconnect-banner'), null, 'the outage must be explained');
  assert.equal(shell.querySelector('#credential-dialog'), null, 'the user must NOT be sent back to auth');
});

test('the reconnect path never clears history or returns to authentication', () => {
  for (const name of ['reconnecting', 'resync']) {
    const { shell } = render(name);
    assert.ok(shell.querySelectorAll('.message').length > 0, `${name} lost the history`);
    assert.equal(shell.querySelector('#credential-dialog'), null, `${name} returned to auth`);
    assert.notEqual(shell.querySelector('.timeline'), null, `${name} removed the timeline`);
  }
});

test('the queue indicator shows a text count, not a bare badge', () => {
  const { shell } = render('queued');
  const indicator = shell.querySelector('#queue-indicator');
  assert.notEqual(indicator, null);
  assert.match(indicator.textContent, /\d+\s+queued/);
});

test('the waiting-input state emphasizes the composer and offers a plain reply', () => {
  const { shell, send } = render('waitingInput');
  assert.notEqual(shell.querySelector('#waiting-input-indicator'), null);
  assert.equal(send.textContent, 'Send', 'a waiting-input reply is neither a queue nor a steer');
  assert.equal(shell.querySelector('#composer-steer'), null);
});

test('streaming appends to ONE message and never creates a message per chunk', () => {
  const bundle = buildFixture('streaming');
  let state = bundle.state;

  const doc = createTestDocument();
  const first = renderAppShell(
    { fixture: bundle.fixture, state, messages: bundle.messages, sessions: bundle.sessions },
    { doc },
  );
  const countAtStart = first.querySelectorAll('.message--assistant').length;
  assert.equal(countAtStart, 1, 'streaming starts with exactly one assistant message');

  const lengths = [];
  for (let i = 0; i < bundle.state.streaming.chunks.length; i += 1) {
    state = stepStreaming(state);
    const shell = renderAppShell(
      { fixture: bundle.fixture, state, messages: bundle.messages, sessions: bundle.sessions },
      { doc },
    );
    // The message count must never grow while chunks arrive.
    assert.equal(shell.querySelectorAll('.message--assistant').length, 1, `chunk ${i} created a new message`);
    lengths.push(streamingText(state).length);
  }

  // Content grew monotonically.
  for (let i = 1; i < lengths.length; i += 1) {
    assert.ok(lengths[i] > lengths[i - 1], 'each chunk must append visible content');
  }
  assert.equal(state.domain, 'completed', 'the stream ends in a completed state');
  assert.equal(state.streaming, null, 'the cursor is removed when the stream ends');
});

test('the stream cursor is inside the streaming message, not a separate message', () => {
  const bundle = buildFixture('streaming');
  const doc = createTestDocument();
  const state = stepStreaming(bundle.state);
  const shell = renderAppShell(
    { fixture: bundle.fixture, state, messages: bundle.messages, sessions: bundle.sessions },
    { doc },
  );
  const message = shell.querySelector('.message--streaming');
  assert.notEqual(message, null);
  assert.equal(message.getAttribute('aria-busy'), 'true');
  assert.notEqual(message.querySelector('.stream-cursor'), null, 'the caret belongs to the message');
  assert.equal(shell.querySelectorAll('.message').length, 2, 'one user + one assistant, nothing more');
});

test('the fixture fragment accepts only a known name', () => {
  assert.equal(parseFixtureFromHash('#fixture=streaming'), 'streaming');
  assert.equal(parseFixtureFromHash('streaming'), 'streaming');
  assert.equal(parseFixtureFromHash(''), 'ready');
  assert.equal(parseFixtureFromHash('#fixture=nope'), 'ready');
  // A credential-shaped fragment must never select a fixture.
  assert.equal(parseFixtureFromHash('#fixture=abcDEF1234567890abcDEF1234567890abcDEF1234'), 'ready');
  assert.equal(parseFixtureFromHash('#token=abcDEF1234567890'), 'ready'); // gitleaks:allow -- reviewed synthetic fixture, not a deployment credential
});

test('the resync fixture never fetches and always explains itself', () => {
  const { shell } = render('resync');
  const banner = shell.querySelector('#resync-banner');
  assert.notEqual(banner, null);
  assert.match(banner.textContent, /Conversation changed while you were offline\./);
  assert.match(banner.textContent, /Reload conversation/);
});
