/**
 * Message endpoint tests — Phase R3 §16, §17, §38.
 *
 * History plus submission. The two things most worth protecting here:
 *
 *   - the sequence in a history page is a **DSH durable** cursor and must never
 *     be the Gateway realtime sequence;
 *   - a submit returns 202 immediately and never waits for the model.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { request, startFixtureServer, FIXTURE_SESSIONS } from './r3-helpers.mjs';
import { MESSAGE_TYPE } from '../../src/remote/model/message.mjs';

const SESSION = FIXTURE_SESSIONS.RUNNING;

test('history returns the source order with the exact DSH sequences', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`);
    assert.equal(res.status, 200);
    assert.equal(res.body.api_version, 1);
    assert.equal(res.body.data.length, 3);

    assert.deepEqual(res.body.data.map((message) => message.source_sequence), [40, 41, 42]);
    assert.deepEqual(res.body.data.map((message) => message.role), ['user', 'tool', 'assistant']);
  } finally {
    await h.close();
  }
});

test('a history page names its sequence space explicitly', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`);
    // The field name and the explicit `sequence_kind` both say the same thing, so
    // a client cannot read a Gateway realtime sequence into a history page (§16).
    assert.equal(res.body.page.sequence_kind, 'dsh_durable_source_sequence');
    assert.equal('last_sequence' in res.body.page, false);
    assert.equal(JSON.stringify(res.body.page).includes('gateway'), false);
  } finally {
    await h.close();
  }
});

test('message types are preserved distinctly, not flattened to "message"', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`);
    const types = res.body.data.map((message) => message.type);
    assert.deepEqual(types, [MESSAGE_TYPE.MESSAGE, MESSAGE_TYPE.TOOL_CALL, MESSAGE_TYPE.MESSAGE]);
    assert.ok(types.includes(MESSAGE_TYPE.TOOL_CALL), 'a tool call must not become a plain message');
  } finally {
    await h.close();
  }
});

test('message ids are deterministic across repeated reads', async () => {
  const h = await startFixtureServer();
  try {
    const first = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`);
    const second = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`);
    assert.deepEqual(
      first.body.data.map((message) => message.id),
      second.body.data.map((message) => message.id),
    );
    // The id embeds session + DSH seq + type, so it is reproducible.
    assert.equal(first.body.data[0].id, `${SESSION}:40:message`);
  } finally {
    await h.close();
  }
});

test('history pagination reports the DSH cursor and bounds the page', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages?limit=2`);
    assert.equal(res.status, 200);
    assert.equal(res.body.page.limit, 2);
    assert.equal(res.body.page.returned, 2);
    assert.equal(typeof res.body.page.through_seq, 'number');
    assert.equal(res.body.page.sequence_kind, 'dsh_durable_source_sequence');
  } finally {
    await h.close();
  }
});

test('history rejects a bad sequence cursor and a bad limit', async () => {
  const h = await startFixtureServer();
  try {
    for (const bad of ['-1', '1.5', 'abc', '99999999999999999999']) {
      const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages?through_seq=${bad}`);
      assert.equal(res.status, 400, `through_seq=${bad}`);
      assert.equal(res.body.error.code, 'INVALID_QUERY');
    }
    const badLimit = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages?limit=1000`);
    assert.equal(badLimit.status, 400);
  } finally {
    await h.close();
  }
});

test('history for an unknown session is a 404', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions/session-00000000-0000-0000-0000-0000000000ff/messages');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'SESSION_NOT_FOUND');
  } finally {
    await h.close();
  }
});

test('a prompt submit is accepted with 202 and the DSH requestId', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`, {
      method: 'POST',
      body: { content: 'hello from the phone', client_message_id: 'client-abc-1', mode: 'steer' },
    });

    assert.equal(res.status, 202, 'accepted, not completed');
    assert.equal(res.body.data.accepted, true);
    assert.equal(res.body.data.session_id, SESSION);
    assert.equal(res.body.data.mode, 'steer');
    // client_message_id IS the DSH requestId, one for one (R1 §10).
    assert.equal(res.body.data.request_id, 'client-abc-1');
  } finally {
    await h.close();
  }
});

test('the default prompt mode is steer and it is centralised in config', async () => {
  const h = await startFixtureServer();
  try {
    assert.equal(h.config.defaultPromptMode, 'steer');

    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`, {
      method: 'POST',
      body: { content: 'no mode given', client_message_id: 'client-default-1' },
    });
    assert.equal(res.status, 202);
    assert.equal(res.body.data.mode, 'steer', 'matches the DSH GUI busyEnter setting');
  } finally {
    await h.close();
  }
});

test('a client can still choose queue explicitly', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`, {
      method: 'POST',
      body: { content: 'queue this instead', client_message_id: 'client-queue-1', mode: 'queue' },
    });
    assert.equal(res.status, 202);
    assert.equal(res.body.data.mode, 'queue');
    assert.equal(h.adapter._state.sentMessages.at(-1).mode, 'queue');
  } finally {
    await h.close();
  }
});

test('an illegal mode is a 400 INVALID_PROMPT_MODE', async () => {
  const h = await startFixtureServer();
  try {
    for (const mode of ['interrupt', 'STEER', '', 1, null]) {
      const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`, {
        method: 'POST',
        body: { content: 'x', client_message_id: 'client-1', mode },
      });
      // `null` is treated as absent by design; everything else must fail.
      if (mode === null) {
        assert.equal(res.status, 202, 'null means "use the default"');
        continue;
      }
      assert.equal(res.status, 400, `mode=${JSON.stringify(mode)}`);
      assert.equal(res.body.error.code, 'INVALID_PROMPT_MODE');
    }
  } finally {
    await h.close();
  }
});

test('a missing client_message_id is a 400 CLIENT_MESSAGE_ID_REQUIRED', async () => {
  const h = await startFixtureServer();
  try {
    for (const id of [undefined, '', '   ', 42, {}, 'has spaces', 'bad/slash']) {
      const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`, {
        method: 'POST',
        body: { content: 'x', ...(id === undefined ? {} : { client_message_id: id }) },
      });
      assert.equal(res.status, 400, `client_message_id=${JSON.stringify(id)}`);
      assert.equal(res.body.error.code, 'CLIENT_MESSAGE_ID_REQUIRED');
    }
  } finally {
    await h.close();
  }
});

test('a non-UUID client_message_id is accepted', async () => {
  // §17.2 says a UUID is recommended, not required. R1 established no client
  // contract that would justify forcing one.
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`, {
      method: 'POST',
      body: { content: 'x', client_message_id: 'not-a-uuid-but-fine_1.2:3' },
    });
    assert.equal(res.status, 202);
    assert.equal(res.body.data.request_id, 'not-a-uuid-but-fine_1.2:3');
  } finally {
    await h.close();
  }
});

test('an invalid prompt body is a 400 with a specific code', async () => {
  const h = await startFixtureServer();
  try {
    const cases = [
      { content: '', client_message_id: 'c1' },
      { content: '   ', client_message_id: 'c1' },
      { content: 123, client_message_id: 'c1' },
      { content: [], client_message_id: 'c1' },
      { content: [{ type: 'nope' }], client_message_id: 'c1' },
      { content: [{ type: 'text' }], client_message_id: 'c1' },
      { content: [{ type: 'text', text: '   ' }], client_message_id: 'c1' },
      { client_message_id: 'c1' },
    ];
    for (const body of cases) {
      const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`, { method: 'POST', body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.ok(
        ['INVALID_PROMPT_CONTENT', 'CLIENT_MESSAGE_ID_REQUIRED'].includes(res.body.error.code),
        `unexpected code ${res.body.error.code} for ${JSON.stringify(body)}`,
      );
    }
  } finally {
    await h.close();
  }
});

test('a structured content array is accepted and preserved', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`, {
      method: 'POST',
      body: {
        content: [{ type: 'text', text: 'with an image' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }],
        client_message_id: 'client-array-1',
      },
    });
    assert.equal(res.status, 202);
    const sent = h.adapter._state.sentMessages.at(-1);
    assert.equal(sent.content.length, 2);
    assert.equal(sent.content[1].type, 'image');
  } finally {
    await h.close();
  }
});

test('an attachment part is translated to the DSH receipt part', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`, {
      method: 'POST',
      body: {
        content: [{ type: 'attachment', attachment_id: 'receipt-xyz' }],
        client_message_id: 'client-attach-1',
      },
    });
    assert.equal(res.status, 202);
    const sent = h.adapter._state.sentMessages.at(-1);
    // The Gateway's attachment_id IS the DSH receipt, so this is an identity map.
    assert.deepEqual(sent.content[0], { type: 'file', receiptId: 'receipt-xyz' });
  } finally {
    await h.close();
  }
});

test('a repeated client_message_id is forwarded unchanged, preserving idempotency', async () => {
  const h = await startFixtureServer();
  try {
    const body = { content: 'retry me', client_message_id: 'client-idem-1', mode: 'queue' };
    const first = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`, { method: 'POST', body });
    const second = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`, { method: 'POST', body });

    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal(first.body.data.request_id, second.body.data.request_id);

    const sent = h.adapter._state.sentMessages.filter((m) => m.client_message_id === 'client-idem-1');
    assert.equal(sent.length, 2, 'both attempts reach the adapter; DSH is the dedupe authority');
    assert.equal(new Set(sent.map((m) => m.client_message_id)).size, 1);
  } finally {
    await h.close();
  }
});

test('submitting to an unknown session is a 404', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions/session-00000000-0000-0000-0000-0000000000ff/messages', {
      method: 'POST',
      body: { content: 'x', client_message_id: 'c1' },
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'SESSION_NOT_FOUND');
  } finally {
    await h.close();
  }
});

test('the HTTP response does not wait for the model to finish', async () => {
  const h = await startFixtureServer();
  try {
    // The adapter resolves immediately and never produces an assistant message.
    // If the route waited for completion this would hang instead of returning 202.
    const started = Date.now();
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`, {
      method: 'POST',
      body: { content: 'do not wait for me', client_message_id: 'client-fast-1' },
    });
    assert.equal(res.status, 202);
    assert.ok(Date.now() - started < 2000, 'a prompt submit must be cheap');
    // No assistant output exists at all, proving the response is not derived from it.
    assert.equal(res.text.includes('assistant'), false);
  } finally {
    await h.close();
  }
});

test('an accepted prompt appears in the domain without waiting for DSH', async () => {
  const h = await startFixtureServer();
  try {
    const before = h.statusService.getSession(SESSION).status;
    await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`, {
      method: 'POST',
      body: { content: 'steer me', client_message_id: 'client-steer-1', mode: 'steer' },
    });
    assert.equal(h.statusService.getSession(SESSION).status, 'running');
    assert.notEqual(before, undefined);
  } finally {
    await h.close();
  }
});

test('a prompt submit requires a JSON content type', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`, {
      method: 'POST',
      rawBody: '{"content":"x","client_message_id":"c1"}',
      contentType: 'text/plain',
    });
    assert.equal(res.status, 415);
    assert.equal(res.body.error.code, 'UNSUPPORTED_MEDIA_TYPE');
  } finally {
    await h.close();
  }
});
