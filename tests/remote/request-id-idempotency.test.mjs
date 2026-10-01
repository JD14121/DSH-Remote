/**
 * Idempotency identity tests — R1 §10, §18.2.
 *
 * The requirement is narrow and strict: the adapter must pass the caller's
 * `client_message_id` through as the DSH `requestId`, and must never mint a
 * second idempotency key. R1 keeps no duplicate registry of its own — DSH is
 * the dedupe authority.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ADAPTER_ERROR } from '../../src/remote/adapter-errors.mjs';
import { DshAdapter } from '../../src/remote/dsh-adapter.mjs';
import { buildPromptRequest } from '../../src/remote/translate/from-prompt.mjs';
import { DshRpcClient } from '../../src/remote/wire/dsh-rpc-client.mjs';
import { FixtureAuthProvider } from '../../src/remote/wire/dsh-auth.mjs';
import { staticVersionGuard } from '../../src/remote/version-guard.mjs';
import { FakeFetch, FakeWebSocket, FIXTURE_AUTHORITY, FIXTURE_SESSION, loadFixture } from './helpers.mjs';

const PATH = { PROMPT: '/api/session/prompt' };

/** Build an adapter whose prompt route records every request. */
function makeAdapter(responseBody) {
  const fake = new FakeFetch({
    [PATH.PROMPT]: (record) => ({
      status: 200,
      body: { ...responseBody, rpcId: record.body.rpcId },
    }),
  });
  const rpcClient = new DshRpcClient({
    authority: FIXTURE_AUTHORITY,
    authProvider: new FixtureAuthProvider(),
    fetchImpl: fake.fetch,
    WebSocketImpl: FakeWebSocket,
    callTimeoutMs: 5000,
  });
  const adapter = new DshAdapter({
    rpcClient,
    versionGuard: staticVersionGuard('0.1.5-rc.2'),
    authProvider: new FixtureAuthProvider(),
  });
  return { adapter, fake };
}

test('client_message_id becomes requestId verbatim', () => {
  const request = buildPromptRequest({
    sessionId: FIXTURE_SESSION.RUNNING,
    client_message_id: 'client-message-id-fixture-1',
    content: 'text',
    mode: 'queue',
  });

  assert.equal(request.requestId, 'client-message-id-fixture-1');
  // Exactly one identity field exists on the wire request. `sessionId` names the
  // target session; `requestId` is the single idempotency identity.
  assert.deepEqual(
    Object.keys(request).filter((key) => /(^|[a-z])Id$/.test(key) && key !== 'sessionId').sort(),
    ['requestId'],
  );
});

test('two submissions of the same client_message_id send the same requestId twice', async () => {
  const fixture = loadFixture('prompt.accepted.response.json');
  const { adapter, fake } = makeAdapter(fixture.response);

  const first = await adapter.sendMessage(FIXTURE_SESSION.RUNNING, {
    client_message_id: 'client-message-id-fixture-1',
    content: 'first submission',
    mode: 'queue',
  });
  const second = await adapter.sendMessage(FIXTURE_SESSION.RUNNING, {
    client_message_id: 'client-message-id-fixture-1',
    content: 'first submission',
    mode: 'queue',
  });

  assert.equal(first.requestId, 'client-message-id-fixture-1');
  assert.equal(second.requestId, 'client-message-id-fixture-1');

  assert.equal(fake.calls.length, 2, 'a retry must still reach DSH to be deduped there');
  const [callOne, callTwo] = fake.calls.map((call) => call.body.payload.args.request);
  assert.equal(callOne.requestId, 'client-message-id-fixture-1');
  assert.equal(callTwo.requestId, 'client-message-id-fixture-1');

  // The rpcId differs per call (transport correlation) but the requestId,
  // which is the idempotency identity, does not.
  assert.notEqual(fake.calls[0].body.rpcId, fake.calls[1].body.rpcId);
  assert.equal(callOne.requestId, callTwo.requestId);
});

test('two different client_message_ids produce two different requestIds', () => {
  const a = buildPromptRequest({
    sessionId: 'session-1',
    client_message_id: 'id-a',
    content: 'a',
    mode: 'queue',
  });
  const b = buildPromptRequest({
    sessionId: 'session-1',
    client_message_id: 'id-b',
    content: 'b',
    mode: 'steer',
  });

  assert.notEqual(a.requestId, b.requestId);
});

test('a missing client_message_id is rejected rather than auto-minted', async () => {
  const fixture = loadFixture('prompt.accepted.response.json');
  const { adapter, fake } = makeAdapter(fixture.response);

  await assert.rejects(
    () => adapter.sendMessage(FIXTURE_SESSION.RUNNING, { content: 'no id', mode: 'queue' }),
    (error) => {
      assert.equal(error.code, ADAPTER_ERROR.PROMPT_REJECTED);
      assert.match(error.message, /client_message_id/);
      return true;
    },
  );
  assert.equal(fake.calls.length, 0, 'the adapter must not invent an id and send it');
});

test('an empty or non-string client_message_id is rejected', () => {
  for (const bad of ['', null, undefined, 42, {}]) {
    assert.throws(
      () =>
        buildPromptRequest({
          sessionId: 'session-1',
          client_message_id: bad,
          content: 'text',
          mode: 'queue',
        }),
      (error) => error.code === ADAPTER_ERROR.PROMPT_REJECTED,
      `client_message_id ${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test('the adapter holds no duplicate registry of its own', async () => {
  const fixture = loadFixture('prompt.accepted.response.json');
  const { adapter, fake } = makeAdapter(fixture.response);

  const before = Object.keys(adapter).sort();

  await adapter.sendMessage(FIXTURE_SESSION.RUNNING, {
    client_message_id: 'repeat-me',
    content: 'x',
    mode: 'queue',
  });
  await adapter.sendMessage(FIXTURE_SESSION.RUNNING, {
    client_message_id: 'repeat-me',
    content: 'x',
    mode: 'queue',
  });

  const after = Object.keys(adapter).sort();
  assert.deepEqual(after, before, 'the adapter must not accumulate dedupe state');
  // And both attempts reached the wire, because only DSH may decide duplication.
  assert.equal(fake.calls.length, 2);
});

test('an explicit mode is required and is forwarded unchanged', () => {
  for (const mode of ['queue', 'steer']) {
    const request = buildPromptRequest({
      sessionId: 'session-1',
      client_message_id: 'id',
      content: 'text',
      mode,
    });
    assert.equal(request.mode, mode);
  }
});

test('clientTimeZone is forwarded only when supplied', () => {
  const without = buildPromptRequest({
    sessionId: 'session-1',
    client_message_id: 'id',
    content: 'text',
    mode: 'queue',
  });
  const withZone = buildPromptRequest({
    sessionId: 'session-1',
    client_message_id: 'id',
    content: 'text',
    mode: 'queue',
    clientTimeZone: 'Asia/Shanghai',
  });

  assert.equal('clientTimeZone' in without, false);
  assert.equal(withZone.clientTimeZone, 'Asia/Shanghai');
});
