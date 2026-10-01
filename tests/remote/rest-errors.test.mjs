/**
 * Error-mapping and envelope tests — Phase R3 §10, §19, §29.
 *
 * §19 requires the adapter-to-HTTP mapping to live in one place and never be
 * scattered across routes, so most of this suite tests the table directly and
 * then confirms two routes actually use it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { request, startFixtureServer, FIXTURE_SESSIONS } from './r3-helpers.mjs';
import {
  API_ERROR,
  ApiError,
  HTTP_STATUS,
  apiError,
  mapAdapterCode,
  toApiError,
} from '../../src/remote/http/errors.mjs';
import { ADAPTER_ERROR, AdapterError } from '../../src/remote/adapter-errors.mjs';

const SESSION = FIXTURE_SESSIONS.RUNNING;

test('the adapter code table maps every code as §19 specifies', () => {
  const expectations = [
    [ADAPTER_ERROR.SESSION_NOT_FOUND, 404, API_ERROR.SESSION_NOT_FOUND],
    [ADAPTER_ERROR.SESSION_COLD, 409, API_ERROR.SESSION_COLD],
    [ADAPTER_ERROR.PROMPT_REJECTED, 409, API_ERROR.PROMPT_REJECTED],
    [ADAPTER_ERROR.CANCEL_UNSUPPORTED, 409, API_ERROR.CANCEL_UNSUPPORTED],
    [ADAPTER_ERROR.AUTH_UNAVAILABLE, 503, API_ERROR.AUTH_UNAVAILABLE],
    [ADAPTER_ERROR.AUTH_REJECTED, 502, API_ERROR.AUTH_REJECTED],
    [ADAPTER_ERROR.DSH_UNAVAILABLE, 503, API_ERROR.DSH_UNAVAILABLE],
    [ADAPTER_ERROR.WIRE_VERSION_MISMATCH, 503, API_ERROR.WIRE_VERSION_MISMATCH],
    [ADAPTER_ERROR.WIRE_PROTOCOL_ERROR, 502, API_ERROR.WIRE_PROTOCOL_ERROR],
    [ADAPTER_ERROR.STREAM_ABORTED, 409, API_ERROR.STREAM_ABORTED],
  ];
  for (const [adapterCode, status, code] of expectations) {
    const mapped = mapAdapterCode(adapterCode);
    assert.equal(mapped.status, status, `${adapterCode} status`);
    assert.equal(mapped.code, code, `${adapterCode} code`);
  }
});

test('an unknown adapter code becomes a generic 500 and never echoes itself', () => {
  const mapped = mapAdapterCode('SOMETHING_NEW_FROM_DSH');
  assert.equal(mapped.status, 500);
  assert.equal(mapped.code, API_ERROR.INTERNAL_ERROR);

  const error = toApiError(new AdapterError('SOMETHING_NEW_FROM_DSH', 'internal detail that must not leak'));
  assert.equal(error.status, 500);
  assert.equal(error.message, 'An internal error occurred.');
  assert.equal(error.message.includes('internal detail'), false);
});

test('no non-standard 499 is ever emitted', () => {
  // §19: externally use 409/503, never a bare 499.
  const mapped = mapAdapterCode(ADAPTER_ERROR.STREAM_ABORTED);
  assert.notEqual(mapped.status, 499);
  assert.ok(mapped.status >= 400 && mapped.status < 600);
  for (const code of Object.values(ADAPTER_ERROR)) {
    const { status } = mapAdapterCode(code);
    assert.notEqual(status, 499, `${code} must not map to 499`);
    assert.ok(status >= 200 && status <= 599);
  }
});

test('a prompt rejection is 422 for a content problem and 409 for a state conflict', () => {
  assert.equal(mapAdapterCode(ADAPTER_ERROR.PROMPT_REJECTED).status, 409);
  assert.equal(mapAdapterCode(ADAPTER_ERROR.PROMPT_REJECTED, { contentProblem: true }).status, 422);
});

test('a cancel-context not-found is a conflict, because the mapping is contextual', () => {
  // §18 keeps R1's established mapping: DSH cannot distinguish cold from absent
  // for a cancel, so both surface as SESSION_COLD.
  assert.equal(mapAdapterCode(ADAPTER_ERROR.SESSION_NOT_FOUND, { cancelOperation: true }).status, 409);
  assert.equal(mapAdapterCode(ADAPTER_ERROR.SESSION_NOT_FOUND).status, 404);
});

test('only retryable codes are marked retryable', () => {
  assert.equal(toApiError(new AdapterError(ADAPTER_ERROR.DSH_UNAVAILABLE, 'x')).retryable, true);
  assert.equal(toApiError(new AdapterError(ADAPTER_ERROR.STREAM_ABORTED, 'x')).retryable, true);
  assert.equal(toApiError(new AdapterError(ADAPTER_ERROR.SESSION_COLD, 'x')).retryable, false);
  assert.equal(toApiError(new AdapterError(ADAPTER_ERROR.AUTH_REJECTED, 'x')).retryable, false);
  assert.equal(toApiError(new AdapterError(ADAPTER_ERROR.WIRE_PROTOCOL_ERROR, 'x')).retryable, false);
});

test('an ApiError passes through unchanged so a precise code is not downgraded', () => {
  const original = apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_CURSOR, 'cursor is bad');
  const converted = toApiError(original);
  assert.equal(converted, original);
});

test('adapter details are filtered to a safe allowlist', () => {
  const error = toApiError({
    code: ADAPTER_ERROR.WIRE_PROTOCOL_ERROR,
    details: { endpoint: 'session/page', dshHome: 'D:\\secret', cookie: 'dsh-auth-xyz', internalPath: '/etc' },
  });
  assert.deepEqual(error.details, { endpoint: 'session/page' });
  assert.equal(JSON.stringify(error.toEnvelope('req-1')).includes('secret'), false);
});

test('the error envelope shape is stable and carries the request id', () => {
  const error = apiError(HTTP_STATUS.NOT_FOUND, API_ERROR.SESSION_NOT_FOUND, 'Session was not found.');
  const envelope = error.toEnvelope('request-abc');
  assert.deepEqual(envelope, {
    error: {
      code: 'SESSION_NOT_FOUND',
      message: 'Session was not found.',
      retryable: false,
      request_id: 'request-abc',
    },
  });
});

test('a 5xx from the adapter is surfaced with a safe message', async () => {
  const h = await startFixtureServer({
    adapterOptions: {
      errors: {
        getMessages: new AdapterError(ADAPTER_ERROR.DSH_UNAVAILABLE, 'connect ECONNREFUSED 127.0.0.1:3080'),
      },
    },
  });
  try {
    // The session is already in the domain store, so a detail read is served
    // locally and never touches the failing adapter — which is itself the point.
    const detail = await request(h.baseUrl, `/api/v1/sessions/${SESSION}`);
    assert.equal(detail.status, 200, 'a store-backed read is unaffected by a DSH outage');

    const messages = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`);
    assert.equal(messages.status, 503);
    assert.equal(messages.body.error.code, API_ERROR.DSH_UNAVAILABLE);
    assert.equal(messages.body.error.retryable, true);
    // The upstream message must not leak a socket detail.
    assert.equal(messages.text.includes('ECONNREFUSED'), false);
    assert.equal(messages.text.includes('3080'), false);
  } finally {
    await h.close();
  }
});

test('an auth failure is reported without any credential material', async () => {
  const h = await startFixtureServer({
    adapterOptions: { errors: { getMessages: new AdapterError(ADAPTER_ERROR.AUTH_UNAVAILABLE, 'no credential configured') } },
  });
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`);
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, API_ERROR.AUTH_UNAVAILABLE);
    for (const forbidden of ['cookie', 'dsh-auth', 'credentials.yaml', 'token']) {
      assert.equal(res.text.toLowerCase().includes(forbidden), false);
    }
  } finally {
    await h.close();
  }
});

test('every documented API error code maps to a non-2xx status', () => {
  // §9: never `200 { error }`. A code that defaulted to 200 would violate that.
  const seen = new Set();
  for (const code of Object.values(ADAPTER_ERROR)) {
    const { status } = mapAdapterCode(code);
    assert.ok(status >= 400, `${code} produced ${status}`);
    seen.add(status);
  }
  for (const error of [
    apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_REQUEST),
    apiError(HTTP_STATUS.FORBIDDEN, API_ERROR.FORBIDDEN_HOST),
    apiError(HTTP_STATUS.NOT_FOUND, API_ERROR.ROUTE_NOT_FOUND),
    apiError(HTTP_STATUS.METHOD_NOT_ALLOWED, API_ERROR.METHOD_NOT_ALLOWED),
    apiError(HTTP_STATUS.PAYLOAD_TOO_LARGE, API_ERROR.PAYLOAD_TOO_LARGE),
    apiError(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, API_ERROR.UNSUPPORTED_MEDIA_TYPE),
    apiError(HTTP_STATUS.NOT_IMPLEMENTED, API_ERROR.UPLOAD_NOT_AVAILABLE),
  ]) {
    assert.ok(error.status >= 400);
    assert.equal(error.toEnvelope('r').error.code, error.code);
  }
  assert.ok(seen.size >= 4);
});

test('an ApiError always carries a code, a message and retryable', () => {
  const error = new ApiError(400, 'SOMETHING', 'a message');
  assert.equal(error.name, 'ApiError');
  assert.equal(error.retryable, false, 'defaults to not retryable');
  assert.equal(error.details, undefined);
});

test('a thrown non-error value still produces a valid envelope', async () => {
  const h = await startFixtureServer();
  try {
    // Sabotage a service so an unexpected value is thrown, then confirm the
    // server still answers in the standard shape rather than crashing.
    const original = h.messagesService.list;
    h.messagesService.list = async () => {
      throw 'a bare string, not an Error';
    };

    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`);
    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, API_ERROR.INTERNAL_ERROR);
    assert.equal(res.body.error.request_id !== undefined, true);

    h.messagesService.list = original;
  } finally {
    await h.close();
  }
});

test('a large body is refused before any route logic runs', async () => {
  const h = await startFixtureServer({ configOverrides: { maxJsonBytes: 256 } });
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`, {
      method: 'POST',
      body: { content: 'z'.repeat(1000), client_message_id: 'c1' },
    });
    assert.equal(res.status, 413);
    assert.equal(h.adapter._state.sentMessages.length, 0, 'nothing reached the adapter');
  } finally {
    await h.close();
  }
});

test('the route table exposes every endpoint and no more', async () => {
  const h = await startFixtureServer();
  try {
    const routes = h.server.router.table().map((route) => `${route.method} ${route.path}`).sort();
    assert.deepEqual(routes, [
      'GET /api/v1/health',
      'GET /api/v1/sessions',
      'GET /api/v1/sessions/:sessionId',
      'GET /api/v1/sessions/:sessionId/messages',
      // R6 §14 adds exactly one route: the one-time WebSocket ticket mint. It is the
      // only REST addition in this phase.
      'POST /api/v1/auth/ws-ticket',
      'POST /api/v1/sessions/:sessionId/cancel',
      'POST /api/v1/sessions/:sessionId/messages',
      'POST /api/v1/sessions/:sessionId/uploads',
    ]);

    // The event stream stays off the REST router (§41). R6 added an auth route, not
    // a stream route, so the negative checks still hold.
    for (const route of routes) {
      assert.equal(route.includes('events'), false, 'no phone event stream on the REST router');
      assert.equal(route.includes('stream'), false);
    }
  } finally {
    await h.close();
  }
});
