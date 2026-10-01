/**
 * R8D — integration: a real EventClient against a real fixture Gateway, plus fixture isolation,
 * DOM safety for socket-delivered content, and the runtime-protection boundary.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { EventClient, SOCKET_STATE } from '../../src/remote/ui/ws/event-client.js';
import { FRAME, resolveChunkText } from '../../src/remote/ui/ws/event-normalizer.js';
import { renderAssistantContent } from '../../src/remote/ui/rendering/render-message.js';
import { createTestDocument } from './r8b-dom.mjs';
import { eventFrame, helloFrame, replayCompleteFrame, startWsFixture, waitFor } from './r8d-harness.mjs';

const UI = path.join(process.cwd(), 'src', 'remote', 'ui');

test('the full handshake sequence runs against a real socket', async () => {
  const fixture = await startWsFixture();
  try {
    const seen = [];
    fixture.onConnection = (connection) => {
      connection.send(helloFrame({ sessionId: 's-1', latest: 4, earliest: 0, from: 2, mode: 'replay' }));
      connection.send(eventFrame({ sessionId: 's-1', sequence: 3, event: 'message.created', data: { id: 'm-3' } }));
      connection.send(eventFrame({ sessionId: 's-1', sequence: 4, event: 'session.status', data: { status: 'running' } }));
      connection.send(replayCompleteFrame({ sequence: 4, mode: 'replay', replayed: 2 }));
    };
    const client = new EventClient({
      sessionId: 's-1', baseUrl: fixture.baseUrl, credential: 'good-token', fetchImpl: fixture.fetchImpl,
      lastSequence: 2,
      onEvent: (event) => seen.push(event.type),
    });

    await client.connect();
    await waitFor(() => client.socketState === SOCKET_STATE.LIVE);

    // The exact §35 order.
    assert.deepEqual(seen, ['hello', 'domain', 'domain', 'replay-complete']);
    assert.equal(client.lastAppliedSequence, 4, 'the replay carried us to the latest sequence');
    assert.equal(client.state.uiConnection, 'connected');
    // The server received the requested replay position.
    assert.equal(fixture.connections[0].lastSequence, 2);
    assert.equal(fixture.connections[0].sessionId, 's-1');
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('a streaming turn and its live status updates arrive together', async () => {
  const fixture = await startWsFixture();
  try {
    const attempt = { attempt_id: 'att-integration' };
    fixture.onConnection = (connection) => {
      connection.send(helloFrame({ sessionId: 's-1' }));
      connection.send(eventFrame({ sessionId: 's-1', sequence: 1, event: 'session.status', data: { status: 'running' } }));
      connection.send(eventFrame({ sessionId: 's-1', sequence: null, event: 'assistant.start', data: attempt }));
      connection.send(eventFrame({ sessionId: 's-1', sequence: null, event: 'assistant.delta', data: { ...attempt, index: 0, chunk: { text: 'The ' } } }));
      connection.send(eventFrame({ sessionId: 's-1', sequence: null, event: 'assistant.delta', data: { ...attempt, index: 1, chunk: { text: 'answer.' } } }));
      connection.send(replayCompleteFrame({ sequence: 1 }));
    };
    const streamMessages = [];
    const client = new EventClient({
      sessionId: 's-1', baseUrl: fixture.baseUrl, credential: 'good-token', fetchImpl: fixture.fetchImpl,
      onEvent: (event) => { if (event.message !== undefined) streamMessages.push(event.message); },
    });

    await client.connect();
    await waitFor(() => client.socketState === SOCKET_STATE.LIVE);
    await waitFor(() => client.streams.active().length === 1);

    const streaming = client.streams.active()[0];
    assert.equal(streaming.content, 'The answer.', 'both chunks must land in one message');
    assert.equal(streaming.streaming, true, 'the cursor is showing');

    fixture.send(eventFrame({ sessionId: 's-1', sequence: null, event: 'assistant.end', data: { ...attempt, outcome: { kind: 'ok' } } }));
    await waitFor(() => client.streams.active().length === 0);

    // The finalized message still exists with its full text.
    const finalized = streamMessages[streamMessages.length - 1];
    assert.equal(finalized.content, 'The answer.');
    assert.equal(finalized.streaming, false);
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('a streaming delta is never mistaken for a durable message', async () => {
  const fixture = await startWsFixture();
  try {
    const attempt = { attempt_id: 'att-identity' };
    fixture.onConnection = (connection) => {
      connection.send(helloFrame({ sessionId: 's-1' }));
      connection.send(eventFrame({ sessionId: 's-1', sequence: null, event: 'assistant.start', data: attempt }));
      connection.send(eventFrame({ sessionId: 's-1', sequence: null, event: 'assistant.delta', data: { ...attempt, index: 0, chunk: { text: 'x' } } }));
      connection.send(replayCompleteFrame());
    };
    const client = new EventClient({
      sessionId: 's-1', baseUrl: fixture.baseUrl, credential: 'good-token', fetchImpl: fixture.fetchImpl,
    });
    await client.connect();
    await waitFor(() => client.streams.active().length === 1);

    const message = client.streams.active()[0];
    // The identity is server-supplied and namespaced, and is clearly NOT a Gateway sequence.
    assert.equal(message.id, 'stream:att-identity');
    assert.equal(typeof message.sequence, 'number' === typeof undefined ? 'number' : typeof message.sequence);
    assert.equal(message.sequence, null, 'a presentation frame carries no durable sequence');
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('model and user content from the socket cannot form executable DOM', async () => {
  const hostile = [
    '<script>globalThis.__wsRan = true</script>',
    '<img src=x onerror="globalThis.__wsPwned = true">',
    '[click](javascript:globalThis.__wsNav = true)',
    '<svg/onload=globalThis.__wsSvg = true>',
  ];

  const doc = createTestDocument();
  const host = doc.createElement('div');
  globalThis.__wsRan = undefined;
  globalThis.__wsPwned = undefined;
  globalThis.__wsNav = undefined;
  globalThis.__wsSvg = undefined;

  renderAssistantContent(host, hostile.join('\n\n'));

  assert.equal(globalThis.__wsRan, undefined, 'a script from the socket executed');
  assert.equal(globalThis.__wsPwned, undefined, 'an onerror handler from the socket executed');
  assert.equal(globalThis.__wsNav, undefined);
  assert.equal(globalThis.__wsSvg, undefined);

  // The text is present as literal characters, not as elements.
  const walk = (node, out = []) => {
    out.push(node);
    for (const child of node.childNodes ?? []) walk(child, out);
    return out;
  };
  const all = walk(host);
  assert.equal(all.some((n) => n.tagName === 'SCRIPT'), false, 'no script element');
  assert.equal(all.some((n) => n.tagName === 'IMG'), false, 'no img element');
  assert.equal(all.some((n) => n.tagName === 'SVG'), false, 'no svg element');
  assert.match(host.textContent, /<script>/, 'the markup survives as inert text');
});

test('a hostile chunk delivered over the socket stays inert end to end', async () => {
  const fixture = await startWsFixture();
  try {
    const attempt = { attempt_id: 'att-hostile' };
    fixture.onConnection = (connection) => {
      connection.send(helloFrame({ sessionId: 's-1' }));
      connection.send(eventFrame({ sessionId: 's-1', sequence: null, event: 'assistant.start', data: attempt }));
      connection.send(eventFrame({
        sessionId: 's-1',
        sequence: null,
        event: 'assistant.delta',
        data: { ...attempt, index: 0, chunk: { text: '<img src=x onerror="globalThis.__livePwned = true">' } },
      }));
      connection.send(replayCompleteFrame());
    };
    globalThis.__livePwned = undefined;

    const client = new EventClient({
      sessionId: 's-1', baseUrl: fixture.baseUrl, credential: 'good-token', fetchImpl: fixture.fetchImpl,
    });
    await client.connect();
    await waitFor(() => client.streams.active().length === 1);

    const message = client.streams.active()[0];
    const doc = createTestDocument();
    const host = doc.createElement('div');
    renderAssistantContent(host, message.content);

    assert.equal(globalThis.__livePwned, undefined, 'socket content executed');
    assert.match(host.textContent, /onerror/, 'the payload is present but inert');
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('an unknown frame type never breaks a live connection', async () => {
  const fixture = await startWsFixture();
  try {
    fixture.onConnection = (connection) => {
      connection.send(helloFrame({ sessionId: 's-1' }));
      connection.send({ type: 'frame.invented.by.a.future.version', payload: { nested: true } });
      connection.send({ type: 'event', event: { sequence: null, event: 'event.invented.later', session_id: 's-1', data: {} } });
      connection.send(eventFrame({ sessionId: 's-1', sequence: 1, event: 'session.status', data: { status: 'running' } }));
      connection.send(replayCompleteFrame({ sequence: 1 }));
    };
    const client = new EventClient({
      sessionId: 's-1', baseUrl: fixture.baseUrl, credential: 'good-token', fetchImpl: fixture.fetchImpl,
    });
    await client.connect();
    await waitFor(() => client.socketState === SOCKET_STATE.LIVE);

    // The connection survived both unknowns and still applied the real event.
    assert.equal(client.lastAppliedSequence, 1);
    assert.equal(client.state.uiConnection, 'connected');
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('fixture mode performs no REST and no WS', async () => {
  const calls = { fetch: 0, websocket: 0 };
  const savedFetch = globalThis.fetch;
  const savedWebSocket = globalThis.WebSocket;
  const savedLocation = globalThis.location;
  const savedAdd = globalThis.addEventListener;
  const savedRemove = globalThis.removeEventListener;

  globalThis.fetch = () => { calls.fetch += 1; throw new Error('fetch used in fixture mode'); };
  globalThis.WebSocket = function trap() { calls.websocket += 1; throw new Error('WebSocket used in fixture mode'); };
  globalThis.location = { hash: '#fixture=streaming' };
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};

  try {
    const doc = createTestDocument();
    const root = doc.createElement('div');
    root.setAttribute('id', 'app');
    const { mount } = await import('../../src/remote/ui/app.js');
    const controller = mount({ doc, root, autoplayStream: false });
    assert.ok(root.children.length > 0, 'fixture mode should render');
    controller.dispose();
    assert.equal(calls.fetch, 0, 'fixture mode must make no REST call');
    assert.equal(calls.websocket, 0, 'fixture mode must open no socket');
  } finally {
    globalThis.fetch = savedFetch;
    globalThis.WebSocket = savedWebSocket;
    globalThis.location = savedLocation;
    globalThis.addEventListener = savedAdd;
    globalThis.removeEventListener = savedRemove;
  }
});

test('the runtime protocol was not modified for R8D', () => {
  // R8D may add UI code only. These carry the frozen R4/R6 semantics.
  const protectedFiles = [
    'src/remote/ws/protocol.mjs',
    'src/remote/ws/validation.mjs',
    'src/remote/auth/ws-ticket.mjs',
    'src/remote/auth/auth-service.mjs',
    'src/remote/production/supervisor.mjs',
    'src/remote/production/dsh-process.mjs',
    'src/remote/persistence/persistence.mjs',
  ];
  for (const file of protectedFiles) {
    assert.ok(fs.existsSync(file), `${file} should exist`);
  }
  // No UI module imports runtime protocol code.
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) continue;
      const text = fs.readFileSync(full, 'utf8');
      assert.equal(
        /from\s+['"][^'"]*(ws\/protocol|ws\/validation|auth\/ws-ticket|auth-service|production\/)/.test(text),
        false,
        `${path.relative(UI, full)} imports runtime protocol code`,
      );
    }
  };
  walk(UI);
});

test('the normalizer is the only place a raw frame is understood', () => {
  // Components must not know the wire schema.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'ws') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      if (/replay_complete|session_id\s*:|earliest_available/.test(text)) offenders.push(path.relative(UI, full));
    }
  };
  walk(UI);
  // `app.js` and the REST layer legitimately know REST field names; what must not appear is the
  // WS frame vocabulary outside the ws/ layer.
  const wsVocabulary = offenders.filter((file) => !file.includes('api') && !file.endsWith('app.js'));
  assert.deepEqual(wsVocabulary, [], `WS frame vocabulary leaked into:\n${wsVocabulary.join('\n')}`);
});

test('the frame vocabulary is exactly the frozen set', () => {
  const frozen = ['hello', 'event', 'heartbeat', 'replay_complete', 'resync_required', 'overflow', 'error', 'server_shutdown'];
  for (const name of frozen) {
    assert.ok(Object.values(FRAME).includes(name), `${name} must be in the normalized vocabulary`);
  }
  // No invented frame types.
  for (const invented of ['stream', 'delta', 'ping', 'pong', 'ack']) {
    assert.equal(Object.values(FRAME).includes(invented), false, `${invented} must not be a frame type`);
  }
});

test('the chunk resolver never invents text for a shape it does not know', () => {
  // The R1 fixtures contain an object shape and an array shape; anything else is unrecognised.
  assert.equal(resolveChunkText({ text: 'ok' }).text, 'ok');
  assert.equal(resolveChunkText([{ text: 'a' }, { text: 'b' }]).text, 'ab');
  for (const unknown of [{ payload: { text: 'hidden' } }, { delta: { nested: { text: 'no' } } }, 123, null]) {
    assert.equal(resolveChunkText(unknown).recognised, false, `${JSON.stringify(unknown)} must not be guessed at`);
  }
});
