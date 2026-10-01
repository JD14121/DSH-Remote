/**
 * Wire envelope contract tests — R1 §6.1, §6.2, §18.1.
 *
 * Proves the client never treats "some JSON" as success, correlates responses by
 * rpcId, maps every transport failure onto an adapter code, and leaks no
 * credential into any error it produces.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ADAPTER_ERROR } from '../../src/remote/adapter-errors.mjs';
import { DshRpcClient, normalizeHttpStatus } from '../../src/remote/wire/dsh-rpc-client.mjs';
import {
  FixtureAuthProvider,
  StaticAuthProvider,
  UnavailableAuthProvider,
} from '../../src/remote/wire/dsh-auth.mjs';
import { unaryPath } from '../../src/remote/wire/dsh-routes.mjs';
import { validateSessionListValue } from '../../src/remote/wire/dsh-types.mjs';
import { assertNoSecrets } from '../../src/remote/redact.mjs';
import {
  FakeFetch,
  FakeWebSocket,
  FIXTURE_AUTHORITY,
  loadFixture,
  readFixtureText,
} from './helpers.mjs';

/** Build a client wired to a scripted fetch. */
function makeClient(routes, options = {}) {
  const fake = new FakeFetch(routes);
  const client = new DshRpcClient({
    authority: FIXTURE_AUTHORITY,
    authProvider: options.authProvider ?? new FixtureAuthProvider(),
    fetchImpl: fake.fetch,
    WebSocketImpl: FakeWebSocket,
    callTimeoutMs: options.callTimeoutMs ?? 5000,
  });
  return { client, fake };
}

/**
 * Route helper: echo the live `rpcId` back, as real DSH does.
 *
 * @param {object} spec - `{status, body}` or a function of the recorded call.
 * @returns {(record: object) => object} a FakeFetch route.
 */
function echoRpcId(spec) {
  return (record) => {
    const resolved = typeof spec === 'function' ? spec(record) : spec;
    if (resolved.body !== undefined && resolved.body !== null && typeof resolved.body === 'object') {
      return { ...resolved, body: { ...resolved.body, rpcId: record.body.rpcId } };
    }
    return resolved;
  };
}

test('a well-formed server-response is unwrapped to result.value', async () => {
  const fixture = loadFixture('session-list.response.json');
  const { client, fake } = makeClient({
    '/api/session/list': echoRpcId({ status: 200, body: fixture.response }),
  });

  const value = await client.call({ endpoint: 'session/list', args: { _request: {} } });

  assert.equal(value.items.length, 3);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.lastCall.method, 'POST');
  assert.equal(fake.lastCall.pathname, '/api/session/list');
});

test('the request envelope carries type, rpcId, method and an args payload', async () => {
  const fixture = loadFixture('session-list.response.json');
  const { client, fake } = makeClient({
    '/api/session/list': echoRpcId({ status: 200, body: fixture.response }),
  });

  await client.call({ endpoint: 'session/list', args: { _request: {} } });

  const sent = fake.lastCall.body;
  assert.equal(sent.type, 'client-request');
  assert.equal(sent.method, 'session/list');
  assert.equal(typeof sent.rpcId, 'string');
  assert.ok(sent.rpcId.length > 0);
  assert.deepEqual(sent.payload, { args: { _request: {} } });
  // The route echoed the live rpcId, and the client accepted it. A fixture
  // rpcId from a past capture would never match a freshly minted one, which is
  // exactly why the client must not accept a stale correlation id.
  assert.notEqual(sent.rpcId, fixture.response.rpcId);
});

test('an rpcId mismatch is rejected rather than accepted', async () => {
  const { client } = makeClient({
    '/api/session/list': {
      status: 200,
      body: {
        type: 'server-response',
        rpcId: 'a-different-rpc-id',
        result: { ok: true, value: { items: [] } },
      },
    },
  });

  await assert.rejects(
    () => client.call({ endpoint: 'session/list', args: {} }),
    (error) => {
      assert.equal(error.code, ADAPTER_ERROR.WIRE_PROTOCOL_ERROR);
      assert.match(error.message, /rpcId/);
      return true;
    },
  );
});

test('every invalid envelope in error.invalid-envelope.json fails visibly', async () => {
  const fixture = loadFixture('error.invalid-envelope.json');
  const cases = fixture._fixture.cases;
  assert.ok(cases.length >= 8, 'expected the full negative matrix');

  for (const testCase of cases) {
    const { client } = makeClient({
      '/api/session/list':
        testCase.name === 'not-json'
          ? { status: 200, body: testCase.body, invalidJson: true }
          : testCase.name === 'rpcId-mismatch'
            // This case must NOT be re-keyed: the stale rpcId is the point.
            ? { status: 200, body: testCase.body }
            : echoRpcId({ status: 200, body: testCase.body }),
    });

    if (testCase.name === 'list-missing-required-summary-field') {
      // This case IS a well-formed envelope, so the envelope layer legitimately
      // accepts it; the payload validator is what must reject it. Proving that
      // separation is the point of keeping the case in the matrix.
      const value = await client.call({ endpoint: 'session/list', args: {} });
      const payload = validateSessionListValue(value);
      assert.equal(payload.ok, false, 'a SessionListValue missing required fields must fail validation');
      assert.match(payload.reason, /updatedAt|running/);
      continue;
    }

    await assert.rejects(
      () => client.call({ endpoint: 'session/list', args: {} }),
      (error) => {
        assert.equal(
          error.code,
          testCase.expectedAdapterCode,
          `case "${testCase.name}" should raise ${testCase.expectedAdapterCode}, raised ${error.code}`,
        );
        return true;
      },
      `case "${testCase.name}" must not be treated as success`,
    );
  }
});

test('HTTP status codes map onto adapter codes', () => {
  assert.equal(normalizeHttpStatus(400, 'e').code, ADAPTER_ERROR.WIRE_PROTOCOL_ERROR);
  assert.equal(normalizeHttpStatus(401, 'e').code, ADAPTER_ERROR.AUTH_REJECTED);
  assert.equal(normalizeHttpStatus(403, 'e').code, ADAPTER_ERROR.AUTH_REJECTED);
  assert.equal(normalizeHttpStatus(404, 'e').code, ADAPTER_ERROR.WIRE_PROTOCOL_ERROR);
  assert.equal(normalizeHttpStatus(405, 'e').code, ADAPTER_ERROR.WIRE_PROTOCOL_ERROR);
  assert.equal(normalizeHttpStatus(415, 'e').code, ADAPTER_ERROR.WIRE_PROTOCOL_ERROR);
  assert.equal(normalizeHttpStatus(500, 'e').code, ADAPTER_ERROR.DSH_UNAVAILABLE);
  assert.equal(normalizeHttpStatus(503, 'e').code, ADAPTER_ERROR.DSH_UNAVAILABLE);
  assert.equal(normalizeHttpStatus(418, 'e').code, ADAPTER_ERROR.WIRE_PROTOCOL_ERROR);
});

test('the observed 401 body is rejected as AUTH_REJECTED and carries no credential', async () => {
  const fixture = loadFixture('error.401.json');
  const { client } = makeClient({
    '/api/session/list': { status: fixture.response.status, body: fixture.response.body, rawBody: true },
  });

  await assert.rejects(
    () => client.call({ endpoint: 'session/list', args: {} }),
    (error) => {
      assert.equal(error.code, ADAPTER_ERROR.AUTH_REJECTED);
      assert.equal(assertNoSecrets(error).clean, true);
      return true;
    },
  );
});

test('the observed 403 body is rejected as AUTH_REJECTED', async () => {
  const fixture = loadFixture('error.403.json');
  const { client } = makeClient({
    '/api/session/list': { status: fixture.response.status, body: fixture.response.body, rawBody: true },
  });

  await assert.rejects(
    () => client.call({ endpoint: 'session/list', args: {} }),
    (error) => error.code === ADAPTER_ERROR.AUTH_REJECTED,
  );
});

test('a transport failure maps to DSH_UNAVAILABLE', async () => {
  const { client } = makeClient({ '/api/session/list': 'throw' });

  await assert.rejects(
    () => client.call({ endpoint: 'session/list', args: {} }),
    (error) => {
      assert.equal(error.code, ADAPTER_ERROR.DSH_UNAVAILABLE);
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test('an already-aborted signal raises STREAM_ABORTED without calling fetch', async () => {
  const { client, fake } = makeClient({
    '/api/session/list': { status: 200, body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: {} } } },
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => client.call({ endpoint: 'session/list', args: {}, signal: controller.signal }),
    (error) => error.code === ADAPTER_ERROR.STREAM_ABORTED,
  );
  assert.equal(fake.calls.length, 0, 'an aborted call must not reach the network');
});

test('a call timeout maps to DSH_UNAVAILABLE', async () => {
  const { client } = makeClient({
    '/api/session/list': async (record) => {
      // Model a server that accepts the request and never answers, then let the
      // signal abort resolve it as a fetch AbortError.
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (record) {
        // no-op: the abort is signalled through the fetch options
      }
      return { status: 200, body: {} };
    },
  }, { callTimeoutMs: 5 });

  await assert.rejects(
    () => client.call({ endpoint: 'session/list', args: {} }),
    (error) => {
      assert.equal(error.code, ADAPTER_ERROR.DSH_UNAVAILABLE);
      assert.match(error.message, /timed out/);
      return true;
    },
  );
});

test('an rpc error envelope maps through the remote code table', async () => {
  const cases = [
    ['session/not-found', ADAPTER_ERROR.SESSION_NOT_FOUND],
    ['session/agent-busy', ADAPTER_ERROR.PROMPT_REJECTED],
    ['session/conflict', ADAPTER_ERROR.PROMPT_REJECTED],
    ['session/invalid-time-zone', ADAPTER_ERROR.PROMPT_REJECTED],
    ['gateway/arguments-invalid', ADAPTER_ERROR.WIRE_PROTOCOL_ERROR],
    ['gateway/cancelled', ADAPTER_ERROR.STREAM_ABORTED],
    ['gateway/internal', ADAPTER_ERROR.DSH_UNAVAILABLE],
    ['something/unexpected', ADAPTER_ERROR.DSH_UNAVAILABLE],
  ];

  for (const [remoteCode, expected] of cases) {
    const { client } = makeClient({
      '/api/session/list': echoRpcId({
        status: 200,
        body: {
          type: 'server-response',
          result: { ok: false, error: { code: remoteCode, message: 'synthetic', details: {} } },
        },
      }),
    });

    await assert.rejects(
      () => client.call({ endpoint: 'session/list', args: {} }),
      (error) => {
        assert.equal(error.code, expected, `${remoteCode} should map to ${expected}`);
        assert.equal(error.details?.remoteCode, remoteCode);
        return true;
      },
    );
    await client.close();
  }
});

test('AUTH_UNAVAILABLE is raised when no credential can be produced', async () => {
  const { client } = makeClient(
    { '/api/session/list': { status: 200, body: {} } },
    { authProvider: new UnavailableAuthProvider('no credential configured') },
  );

  await assert.rejects(
    () => client.call({ endpoint: 'session/list', args: {} }),
    (error) => error.code === ADAPTER_ERROR.AUTH_UNAVAILABLE,
  );
});

test('the credential is sent as a cookie header and never echoed by an error', async () => {
  const cookie = 'dsh-auth-abcdefghijklmnop=synthetic-value';
  const { client, fake } = makeClient(
    { '/api/session/list': { status: 401, body: 'unauthorized', rawBody: true } },
    { authProvider: new StaticAuthProvider({ cookie, authority: FIXTURE_AUTHORITY }) },
  );

  await assert.rejects(
    () => client.call({ endpoint: 'session/list', args: {} }),
    (error) => {
      const inspection = assertNoSecrets(error, [cookie]);
      assert.equal(inspection.clean, true, `error leaked a credential: ${inspection.reason}`);
      assert.equal(error.message.includes(cookie), false);
      assert.equal(JSON.stringify(error.toJSON()).includes(cookie), false);
      return true;
    },
  );

  // The header is present on the wire, which is where it belongs.
  assert.equal(fake.lastCall.headers.cookie, cookie);
  assert.equal(fake.lastCall.headers.host, FIXTURE_AUTHORITY);
});

test('unaryPath builds the single-prefix endpoint path and rejects junk', () => {
  assert.equal(unaryPath('session/list'), '/api/session/list');
  assert.equal(unaryPath('session/updateQueue'), '/api/session/updateQueue');
  assert.throws(() => unaryPath('session'), TypeError);
  assert.throws(() => unaryPath('/session/list'), TypeError);
  assert.throws(() => unaryPath(''), TypeError);
  assert.throws(() => unaryPath(undefined), TypeError);
});

test('fixture files contain no credential material', () => {
  const files = [
    'version.json',
    'session-list.response.json',
    'session-page.response.json',
    'prompt.accepted.response.json',
    'cancel.success.response.json',
    'cancel.cold.response.json',
    'follow.snapshot.json',
    'follow.event.json',
    'follow.assistant-start.json',
    'follow.assistant-chunk.json',
    'follow.assistant-end.json',
    'error.401.json',
    'error.403.json',
    'error.invalid-envelope.json',
  ];

  for (const name of files) {
    const text = readFixtureText(name);
    const inspection = assertNoSecrets(text);
    assert.equal(inspection.clean, true, `${name} contains ${inspection.reason}`);
    assert.equal(/v\d+\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(text), false, `${name} looks like a signed cookie`);
    assert.equal(/sk-[A-Za-z0-9]{10,}/.test(text), false, `${name} looks like an API key`);
  }
});

test('FixtureAuthProvider refuses a cookie that looks like a real one', () => {
  assert.throws(
    () =>
      new FixtureAuthProvider({
        cookie: 'dsh-auth-realhash=v1.eyJhIjoxfQ.c2lnbmF0dXJl', // gitleaks:allow -- reviewed synthetic fixture, not a deployment credential
      }),
    (error) => error.code === ADAPTER_ERROR.AUTH_REJECTED,
  );
  // A synthetic one is fine.
  assert.doesNotThrow(() => new FixtureAuthProvider({ cookie: 'dsh-auth-fixture=synthetic-test-cookie' }));
});
