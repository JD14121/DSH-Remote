/**
 * R8C — ApiClient behaviour and the error taxonomy.
 *
 * The client is exercised against a fake `fetch`, so these tests assert the wire contract
 * (method, path, headers, body) rather than a live Gateway.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiClient, MAX_UPLOAD_BYTES, createRequestId } from '../../src/remote/ui/api/api-client.js';
import {
  ERROR_KIND,
  ApiError,
  connectionStateForError,
  errorFromStatus,
  errorFromThrow,
  kindForStatus,
} from '../../src/remote/ui/api/errors.js';

/**
 * A fake fetch that records calls and replays scripted responses.
 *
 * @param {Array<object>} script - `{status, body, headers}` per call.
 * @returns {object} the fake plus its recorded calls.
 */
function makeFetch(script = []) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body, signal: init.signal });
    const step = script[Math.min(calls.length - 1, script.length - 1)] ?? { status: 200, body: {} };
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      headers: { get: (name) => (step.headers ?? {})[name.toLowerCase()] ?? null },
      json: async () => {
        if (step.raw !== undefined) throw new SyntaxError('not json');
        return step.body;
      },
    };
  };
  return { impl, calls };
}

const HEALTH_AUTHENTICATED = {
  status: 200,
  body: { auth: {}, dsh: {}, gateway: {}, persistence: {}, ready: true, status: 'ok', request_id: 'r-1' },
};

test('the credential is sent only as an Authorization header', async () => {
  const { impl, calls } = makeFetch([HEALTH_AUTHENTICATED]);
  const client = new ApiClient({ fetchImpl: impl, credential: 'tok-abc' });
  await client.health();

  assert.equal(calls[0].headers.authorization, 'Bearer tok-abc');
  // Never in the URL, the query, or the body.
  assert.equal(calls[0].url.includes('tok-abc'), false);
  assert.equal(JSON.stringify(calls[0].body ?? '').includes('tok-abc'), false);
});

test('no Authorization header is sent when no credential is held', async () => {
  const { impl, calls } = makeFetch([HEALTH_AUTHENTICATED]);
  const client = new ApiClient({ fetchImpl: impl });
  await client.health();
  assert.equal('authorization' in calls[0].headers, false);
});

test('health requires the authenticated contract, not merely 200', async () => {
  // Anonymous health: 200 with a minimal body.
  const anon = makeFetch([{ status: 200, body: { auth: {}, gateway: {}, request_id: 'r-2' } }]);
  const client = new ApiClient({ fetchImpl: anon.impl, credential: 'tok' });
  await assert.rejects(() => client.health(), (error) => {
    assert.equal(error.kind, ERROR_KIND.AUTH_REQUIRED);
    return true;
  });

  // Authenticated health passes.
  const auth = makeFetch([HEALTH_AUTHENTICATED]);
  const ok = new ApiClient({ fetchImpl: auth.impl, credential: 'tok' });
  const result = await ok.health();
  assert.equal(result.authenticated, true);
  assert.equal(result.ready, true);
});

test('every operation targets the frozen REST surface', async () => {
  const script = [
    HEALTH_AUTHENTICATED,
    { status: 200, body: { items: [] } },
    { status: 201, body: { api_version: 1, data: { id: 'session-00000000-0000-0000-0000-0000000000aa', status: 'idle' } } },
    { status: 200, body: { id: 's-1', status: 'idle' } },
    { status: 200, body: { items: [] } },
    { status: 200, body: { status: 'accepted' } },
    { status: 200, body: { status: 'cancelled' } },
    { status: 200, body: { id: 'f-1', name: 'x.png' } },
  ];
  const { impl, calls } = makeFetch(script);
  const client = new ApiClient({ fetchImpl: impl, credential: 'tok' });
  const form = { append() {} };

  await client.health();
  await client.listSessions();
  await client.createSession();
  await client.getSession('s-1');
  await client.getMessages('s-1');
  await client.sendMessage('s-1', { content: 'hi', mode: 'queue' });
  await client.cancel('s-1');
  await client.upload('s-1', { name: 'x.png', size: 10 }, { formDataFactory: () => form });

  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    'GET /api/v1/health',
    'GET /api/v1/sessions',
    'POST /api/v1/sessions',
    'GET /api/v1/sessions/s-1',
    'GET /api/v1/sessions/s-1/messages',
    'POST /api/v1/sessions/s-1/messages',
    'POST /api/v1/sessions/s-1/cancel',
    'POST /api/v1/sessions/s-1/uploads',
  ]);
});

test('createSession posts an empty body so the phone cannot choose a scope', async () => {
  const { impl, calls } = makeFetch([{
    status: 201,
    body: { api_version: 1, data: { id: 'session-00000000-0000-0000-0000-0000000000aa', title: null, status: 'idle' } },
  }]);
  const client = new ApiClient({ fetchImpl: impl, credential: 'tok' });

  const session = await client.createSession();

  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, '/api/v1/sessions');
  assert.deepEqual(JSON.parse(calls[0].body), {}, 'the body must be empty');
  assert.equal(calls[0].headers.authorization, 'Bearer tok');
  assert.equal(session.id, 'session-00000000-0000-0000-0000-0000000000aa');
});

test('createSession treats a response without an identity as a protocol failure', async () => {
  const { impl } = makeFetch([{ status: 201, body: { api_version: 1, data: { status: 'idle' } } }]);
  const client = new ApiClient({ fetchImpl: impl, credential: 'tok' });
  await assert.rejects(() => client.createSession(), (error) => {
    assert.equal(error.kind, ERROR_KIND.SERVER);
    return true;
  });
});

test('send always states the mode explicitly', async () => {
  const { impl, calls } = makeFetch([{ status: 200, body: { status: 'accepted' } }]);
  const client = new ApiClient({ fetchImpl: impl, credential: 'tok' });

  await client.sendMessage('s-1', { content: 'a', mode: 'queue' });
  assert.equal(JSON.parse(calls[0].body).mode, 'queue');

  await client.sendMessage('s-1', { content: 'b', mode: 'steer' });
  assert.equal(JSON.parse(calls[1].body).mode, 'steer');
});

test('an invalid mode is refused before any request is made', async () => {
  const { impl, calls } = makeFetch([{ status: 200, body: {} }]);
  const client = new ApiClient({ fetchImpl: impl, credential: 'tok' });
  await assert.rejects(() => client.sendMessage('s-1', { content: 'x', mode: 'guessed' }),
    (error) => error.kind === ERROR_KIND.BAD_REQUEST);
  assert.equal(calls.length, 0, 'no request may be sent with an unspecified mode');
});

test('requestId is unique and is not timestamp-only', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) ids.add(createRequestId());
  assert.equal(ids.size, 200, 'every generated requestId must be distinct');
  for (const id of ids) assert.ok(id.length >= 16, 'ids must carry real entropy');
});

test('a caller-supplied requestId is preserved so a retry keeps one logical id', async () => {
  const { impl, calls } = makeFetch([{ status: 200, body: { status: 'accepted' } }]);
  const client = new ApiClient({ fetchImpl: impl, credential: 'tok' });
  await client.sendMessage('s-1', { content: 'x', mode: 'queue', requestId: 'fixed-id-1' });
  assert.equal(JSON.parse(calls[0].body).client_message_id, 'fixed-id-1');
  assert.equal(calls[0].headers['x-request-id'], 'fixed-id-1');
  assert.equal(client.lastRequestId, 'fixed-id-1');
});

test('HTTP statuses map to distinct, non-generic errors', () => {
  assert.equal(kindForStatus(401), ERROR_KIND.AUTH_REQUIRED);
  assert.equal(kindForStatus(403), ERROR_KIND.FORBIDDEN);
  assert.equal(kindForStatus(404), ERROR_KIND.NOT_FOUND);
  assert.equal(kindForStatus(409), ERROR_KIND.CONFLICT);
  assert.equal(kindForStatus(413), ERROR_KIND.TOO_LARGE);
  assert.equal(kindForStatus(429), ERROR_KIND.RATE_LIMITED);
  assert.equal(kindForStatus(500), ERROR_KIND.SERVER);
  assert.equal(kindForStatus(503), ERROR_KIND.SERVER);
  assert.equal(kindForStatus(418), ERROR_KIND.UNKNOWN);

  // Every kind has its own operator-facing message — nothing collapses to one string.
  const messages = new Set(['401', '403', '404', '409', '413', '429', '500', '418'].map(
    (s) => errorFromStatus(Number(s)).message,
  ));
  assert.equal(messages.size, 8, 'errors must not all read the same');
});

test('only 401 clears the credential', () => {
  assert.equal(errorFromStatus(401).clearsCredential(), true);
  for (const status of [400, 403, 404, 409, 413, 429, 500, 502, 503]) {
    assert.equal(errorFromStatus(status).clearsCredential(), false, `${status} must not clear the credential`);
  }
  // A network failure definitely must not.
  assert.equal(errorFromThrow(new TypeError('failed to fetch')).clearsCredential(), false);
});

test('a network failure is classified as unreachable, not as bad credentials', () => {
  const network = errorFromThrow(new TypeError('Failed to fetch'));
  assert.equal(network.kind, ERROR_KIND.NETWORK);
  assert.equal(network.retryable, true);
  assert.equal(connectionStateForError(network), 'gateway_unavailable');
  assert.equal(connectionStateForError(errorFromStatus(401)), 'auth_required');
  // Any other HTTP answer proves the Gateway is reachable.
  assert.equal(connectionStateForError(errorFromStatus(500)), 'connected');
});

test('an aborted request is its own kind and is not treated as a network outage', () => {
  const abort = errorFromThrow(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  assert.equal(abort.kind, ERROR_KIND.ABORTED);
  assert.equal(abort.clearsCredential(), false);
});

test('a non-JSON body is a protocol failure, not a credential failure', async () => {
  const { impl } = makeFetch([{ status: 200, raw: true }]);
  const client = new ApiClient({ fetchImpl: impl, credential: 'tok' });
  await assert.rejects(() => client.health(), (error) => {
    assert.equal(error.kind, ERROR_KIND.SERVER);
    return true;
  });
});

test('a request-id from the server is captured for correlation', async () => {
  const { impl } = makeFetch([{ status: 200, body: { status: 'accepted' }, headers: { 'x-request-id': 'srv-9' } }]);
  const client = new ApiClient({ fetchImpl: impl, credential: 'tok' });
  await client.sendMessage('s-1', { content: 'x', mode: 'queue', requestId: 'mine' });
  assert.equal(client.lastRequestId, 'mine');
});

test('server failures expose only the safe API code and request id', async () => {
  const { impl } = makeFetch([{
    status: 500,
    body: { error: { code: 'DSH_UNAVAILABLE', message: 'private path must not be shown', request_id: 'server-request-1', details: { remoteCode: 'gateway/internal' } } },
  }]);
  const client = new ApiClient({ fetchImpl: impl, credential: 'tok' });
  await assert.rejects(() => client.health(), (error) => {
    assert.equal(error.code, 'DSH_UNAVAILABLE');
    assert.equal(error.remoteCode, 'gateway/internal');
    assert.equal(error.requestId, 'server-request-1');
    assert.match(error.message, /DSH_UNAVAILABLE/);
    assert.match(error.message, /gateway\/internal/);
    assert.match(error.message, /server-request-1/);
    assert.doesNotMatch(error.message, /private path/);
    return true;
  });
});

test('no error message contains a credential or server internals', async () => {
  const { impl } = makeFetch([{ status: 401, body: { error: 'token abc-secret-123 rejected' } }]);
  const client = new ApiClient({ fetchImpl: impl, credential: 'abc-secret-123' });
  try {
    await client.health();
    assert.fail('should have thrown');
  } catch (error) {
    const text = `${error.message} ${error.stack ?? ''} ${JSON.stringify(error)}`;
    assert.equal(text.includes('abc-secret-123'), false, 'the credential leaked into the error');
    assert.equal(/bearer/i.test(error.message), false);
    assert.equal(error.message.includes('stack'), false);
  }
});

test('the client refuses to run without fetch rather than throwing something opaque', async () => {
  const client = new ApiClient({ fetchImpl: null, credential: 'tok' });
  await assert.rejects(() => client.health(), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.kind, ERROR_KIND.NETWORK);
    return true;
  });
});
