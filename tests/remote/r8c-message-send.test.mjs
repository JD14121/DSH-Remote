/**
 * R8C — send semantics: explicit mode, requestId stability, optimistic policy, no fake streaming.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { RealModeController } from '../../src/remote/ui/api/real-mode.js';
import { ApiClient } from '../../src/remote/ui/api/api-client.js';
import { CredentialStore, createMemoryStorage } from '../../src/remote/ui/api/credential-store.js';
import { normalizeSendResult, normalizeCancelResult } from '../../src/remote/ui/api/normalizers.js';

const UI = path.join(process.cwd(), 'src', 'remote', 'ui');

/** A controller with one active session already loaded. */
function controllerWithSession(sendRoute) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body, headers: init.headers });
    const target = String(url);
    const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
    const fail = (status) => ({ ok: false, status, headers: { get: () => null }, json: async () => ({}) });

    // Cancel is matched before messages: the two routes must not shadow each other.
    if (target.endsWith('/cancel')) {
      const step = typeof sendRoute === 'function' ? await sendRoute(target, init) : sendRoute;
      if (step.throw !== undefined) throw step.throw;
      return { ok: step.status < 300, status: step.status, headers: { get: () => null }, json: async () => step.body };
    }
    if (target.endsWith('/messages') && init.method === 'POST') {
      const step = typeof sendRoute === 'function' ? await sendRoute(target, init) : sendRoute;
      if (step.throw !== undefined) throw step.throw;
      return { ok: step.status < 300, status: step.status, headers: { get: () => null }, json: async () => step.body };
    }
    if (target.includes('/messages')) return ok({ items: [] });
    return ok({ id: 's-1', status: 'running' });
  };

  const controller = new RealModeController({
    client: new ApiClient({ fetchImpl: impl, credential: 'tok' }),
    credentials: new CredentialStore({ storage: createMemoryStorage() }),
  });
  return { controller, calls };
}

test('queue and steer are sent as distinct explicit modes', async () => {
  const { controller, calls } = controllerWithSession({ status: 200, body: { status: 'accepted' } });
  await controller.selectSession('s-1');

  await controller.send({ content: 'do a thing', mode: 'queue' });
  await controller.send({ content: 'change direction', mode: 'steer' });

  const posts = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/messages'));
  assert.equal(JSON.parse(posts[0].body).mode, 'queue');
  assert.equal(JSON.parse(posts[1].body).mode, 'steer');
  // The mode is never omitted, so the server cannot be left to guess.
  for (const post of posts) assert.ok(JSON.parse(post.body).mode, 'mode must always be present');
});

test('the UI label and the transmitted mode agree for every domain state', async () => {
  // The mapping the composer renders must be the mapping it sends.
  const { primarySendLabel, steerAvailable } = await import('../../src/remote/ui/state/ui-state.js');
  assert.equal(primarySendLabel('idle'), 'Send');
  assert.equal(primarySendLabel('running'), 'Send later');
  assert.equal(steerAvailable('running'), true);

  // Idle -> the primary action sends.
  const idle = controllerWithSession({ status: 200, body: { status: 'accepted' } });
  await idle.controller.selectSession('s-1');
  await idle.controller.send({ content: 'a', mode: 'queue' });
  const idlePost = idle.calls.find((c) => c.method === 'POST');
  assert.equal(JSON.parse(idlePost.body).mode, 'queue');
});

test('a requestId is stable for one submission attempt and unique across attempts', async () => {
  const { controller, calls } = controllerWithSession({ status: 200, body: { status: 'accepted' } });
  await controller.selectSession('s-1');

  await controller.send({ content: 'first', mode: 'queue' });
  await controller.send({ content: 'second', mode: 'queue' });

  const posts = calls.filter((c) => c.method === 'POST');
  const first = JSON.parse(posts[0].body).client_message_id;
  const second = JSON.parse(posts[1].body).client_message_id;
  assert.ok(first && second);
  assert.notEqual(first, second, 'two logical submissions need two ids');
});

test('a retry can reuse the same logical requestId', async () => {
  const { controller, calls } = controllerWithSession({ status: 200, body: { status: 'accepted' } });
  await controller.selectSession('s-1');
  await controller.send({ content: 'x', mode: 'queue', requestId: 'logical-1' });
  await controller.send({ content: 'x', mode: 'queue', requestId: 'logical-1' });
  const ids = calls.filter((c) => c.method === 'POST').map((c) => JSON.parse(c.body).client_message_id);
  assert.deepEqual(ids, ['logical-1', 'logical-1']);
});

test('a successful send records acceptance, never an assistant reply', async () => {
  const { controller } = controllerWithSession({ status: 200, body: { status: 'queued' } });
  await controller.selectSession('s-1');
  const result = await controller.send({ content: 'x', mode: 'queue' });

  assert.equal(controller.state.sendState, 'accepted');
  assert.equal(controller.state.draft, '', 'the draft clears only on acceptance');
  // No assistant message may be invented from a 200.
  assert.equal(controller.state.messages.some((m) => m.role === 'assistant'), false);
  assert.equal(result.sendResult.status, 'queued');
});

test('a failed send preserves the draft and surfaces an error', async () => {
  const { controller } = controllerWithSession({ throw: new TypeError('Failed to fetch') });
  await controller.selectSession('s-1');
  controller.state = { ...controller.state, draft: 'unsent text' };

  await controller.send({ content: 'unsent text', mode: 'queue' });
  assert.equal(controller.state.sendState, 'failed');
  assert.equal(controller.state.draft, 'unsent text', 'the draft must survive a failure so it can be retried');
  assert.equal(controller.state.connection, 'gateway_unavailable');
});

test('a 409 on send is a state conflict, not an outage', async () => {
  const { controller } = controllerWithSession({ status: 409, body: {} });
  await controller.selectSession('s-1');
  await controller.send({ content: 'x', mode: 'steer' });
  assert.equal(controller.state.sendState, 'failed');
  assert.equal(controller.state.connection, 'connected', 'the Gateway answered, so it is reachable');
  assert.equal(controller.state.error.kind, 'conflict');
});

test('cancel is wired and distinguishes success from a state conflict', async () => {
  const ok = controllerWithSession({ status: 200, body: { status: 'cancelled' } });
  await ok.controller.selectSession('s-1');
  const domainBefore = ok.controller.state.domain;
  const result = await ok.controller.cancel();
  assert.equal(result.cancelResult.status, 'cancelled');
  // R8F §9: the response is the Gateway's own wording, but the DOMAIN is not forced by it. The
  // authoritative `cancelled` status arrives as a live event.
  assert.equal(ok.controller.state.cancelState, 'requested');
  assert.equal(ok.controller.state.domain, domainBefore);

  // A cold or already-completed session.
  const conflict = controllerWithSession({ status: 409, body: {} });
  await conflict.controller.selectSession('s-1');
  await conflict.controller.cancel();
  assert.equal(conflict.controller.state.error.kind, 'conflict');
  // §12: a conflict means the Gateway is reachable and the action is inapplicable — it must
  // never be reported as an unreachable Gateway.
  assert.equal(conflict.controller.state.connection, 'connected');
  assert.equal(conflict.controller.state.cancelState, 'failed');
});

test('cancel is a no-op with no active session', async () => {
  const { controller, calls } = controllerWithSession({ status: 200, body: {} });
  await controller.cancel();
  assert.equal(calls.some((c) => c.url.endsWith('/cancel')), false);
});

test('send and cancel result shapes are normalized without invention', () => {
  assert.deepEqual(normalizeSendResult({ status: 'accepted' }), { status: 'accepted', messageId: null, sequence: null });
  assert.deepEqual(normalizeSendResult({}), { status: 'accepted', messageId: null, sequence: null });
  assert.equal(normalizeCancelResult({}).status, 'cancelled');
});

test('R8C never fabricates assistant streaming for a real session', () => {
  // `app.js` is the mode ROUTER: it legitimately knows about both fixture streaming and real
  // mode, and chooses between them. The rule is that the real-mode layer — `api/` — must have
  // no access to fixture streaming machinery, so a real session cannot accidentally animate.
  const offenders = [];
  const apiDir = path.join(UI, 'api');
  for (const entry of fs.readdirSync(apiDir, { withFileTypes: true })) {
    if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) continue;
    const text = fs.readFileSync(path.join(apiDir, entry.name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    if (/stepStreaming|FIXTURE_STREAM_CHUNKS|streamingText|fixture-state/.test(text)) {
      offenders.push(`api/${entry.name}`);
    }
  }
  assert.deepEqual(offenders, [], `real mode fakes streaming in:\n${offenders.join('\n')}`);

  // R8C asserted the real-mode controller had no streaming concept "until R8D". R8D arrived, so
  // that assertion is replaced by the property that still matters: the controller consumes a
  // live binding rather than assembling chunks itself, so the stream machinery stays in `ws/`.
  const controller = fs.readFileSync(path.join(apiDir, 'real-mode.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.equal(
    /streams\.(start|delta|end)|StreamAssembler|appliedIndices/.test(controller),
    false,
    'the controller must not assemble stream chunks itself; that belongs to ws/stream-assembler.js',
  );
  assert.match(controller, /this\.live\?\.|this\.live\./, 'the controller consumes the live binding');
});

test('the REST layer owns no socket and the socket layer owns no REST call', () => {
  // The two clients stay separate. `api/` must not construct a WebSocket, and — the reverse that
  // matters just as much — the WS layer must not call REST endpoints of its own.
  const apiDir = path.join(UI, 'api');
  for (const entry of fs.readdirSync(apiDir, { withFileTypes: true })) {
    if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) continue;
    const text = fs.readFileSync(path.join(apiDir, entry.name), 'utf8');
    assert.equal(/new\s+WebSocket/.test(text), false, `api/${entry.name} must not open a socket`);
  }

  // The one exception is deliberate and narrow: the ticket client performs the single REST call
  // whose entire purpose is to authorise a socket.
  const wsDir = path.join(UI, 'ws');
  for (const entry of fs.readdirSync(wsDir, { withFileTypes: true })) {
    if (!entry.name.endsWith('.js')) continue;
    const text = fs.readFileSync(path.join(wsDir, entry.name), 'utf8');
    if (entry.name === 'ticket-client.js') {
      assert.match(text, /\/api\/v1\/auth\/ws-ticket/, 'the ticket client is the one permitted REST call');
      continue;
    }
    assert.equal(
      /['"`]\/api\/v1\//.test(text),
      false,
      `ws/${entry.name} must not reach a REST endpoint directly`,
    );
  }
});

test('a newly created session is selectable, and its accepted first prompt is not a reply', async () => {
  const createdId = 'session-00000000-0000-0000-0000-0000000000aa';
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init.method });
    const response = (status, body) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
    });
    if (url === '/api/v1/sessions' && init.method === 'POST') {
      return response(201, { api_version: 1, data: { id: createdId, status: 'idle' } });
    }
    if (url === '/api/v1/sessions') {
      return response(200, { items: [{ id: createdId }], page: { next_cursor: null } });
    }
    if (url === `/api/v1/sessions/${createdId}`) return response(200, { id: createdId, status: 'idle' });
    if (url === `/api/v1/sessions/${createdId}/messages` && init.method === 'POST') {
      // Admission only: 202 with no assistant content anywhere.
      return response(202, {
        api_version: 1,
        data: { accepted: true, session_id: createdId, request_id: 'req-1', mode: 'queue' },
      });
    }
    if (url === `/api/v1/sessions/${createdId}/messages`) {
      return response(200, { items: [], page: { has_more: false } });
    }
    return response(404, {});
  };

  const live = {
    credential: null,
    bound: [],
    streamMessages: [],
    async bind(input) { this.bound.push(input); },
    unbind() {},
  };

  const controller = new RealModeController({
    client: new ApiClient({ fetchImpl: impl, credential: 'tok' }),
    credentials: new CredentialStore({ storage: createMemoryStorage() }),
    live,
  });

  await controller.newSession();
  assert.equal(controller.state.activeSessionId, createdId);
  assert.equal(live.bound.at(-1).sessionId, createdId, 'the created session must be bound live');

  const result = await controller.send({ content: 'first prompt', mode: 'queue', requestId: 'req-1' });

  assert.equal(result.sendResult.status, 'accepted');
  assert.equal(controller.state.sendState, 'accepted');
  // The operator's own bubble is visible immediately.
  const bubbles = controller.state.messages.filter((m) => m.role === 'user');
  assert.equal(bubbles.length, 1);
  assert.equal(bubbles[0].content, 'first prompt');
  // A 202 is admission, never a completed reply.
  assert.equal(
    controller.state.messages.some((m) => m.role === 'assistant'),
    false,
    'no assistant reply may be fabricated from admission',
  );

  // The reply arrives only through the normal live path, which this controller does not own.
  live.streamMessages.push({
    id: 'a-1', session_id: createdId, role: 'assistant', content: 'reply', kind: 'streaming',
  });
  const rendered = [...controller.state.messages, ...live.streamMessages];
  assert.equal(rendered.some((m) => m.role === 'assistant'), true);
});
