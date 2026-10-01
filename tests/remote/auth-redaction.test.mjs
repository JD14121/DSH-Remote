/**
 * Redaction tests — Phase R6 §24, §45, §47, §62, §86.
 *
 * Synthetic secrets only, and the sharpest requirement is §45: redaction applies to
 * headers, query credential fields, structured auth fields and logs. It must
 * **never** rewrite user message content. A user writing "my token budget is 1000"
 * is not leaking anything, and mangling that sentence would be data loss.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTH_ERROR,
  REDACTED,
  SESSION,
  findSecret,
  generateSyntheticToken,
  redactHeaders,
  redactRequestUrl,
  redactStructured,
  request,
  scanTreeForSecrets,
  makeTempStateRoot,
  startAuthServer,
} from './r6-helpers.mjs';

/** Deliberately distinctive synthetic values, so a leak is unambiguous. */
const PHONE_BEARER_SECRET_X = 'PHONE_BEARER_SECRET_X_0123456789abcdef';
const WS_TICKET_SECRET_Y = 'WS_TICKET_SECRET_Y_0123456789abcdefg'; // gitleaks:allow -- reviewed synthetic fixture, not a deployment credential
const DSH_COOKIE_SECRET_Z = 'DSH_COOKIE_SECRET_Z_0123456789abcdef';

test('§24: credential query parameters are redacted in a URL', () => {
  const url = '/api/v1/events?session_id=session-a&ticket=SECRET&last_sequence=3';
  const redacted = redactRequestUrl(url);
  assert.equal(redacted.includes('SECRET'), false);
  assert.equal(redacted.includes(`ticket=${REDACTED}`), true);
  // The rest of the URL stays readable, so a log line is still diagnosable.
  assert.equal(redacted.includes('session_id=session-a'), true);
  assert.equal(redacted.includes('last_sequence=3'), true);
});

test('§24: every credential name is redacted, even the ones R4 rejects', () => {
  for (const key of ['ticket', 'token', 'access_token', 'bearer', 'refresh_token', 'api_key', 'password', 'secret']) {
    const redacted = redactRequestUrl(`/x?${key}=LEAKME&keep=1`);
    assert.equal(redacted.includes('LEAKME'), false, `${key} must be redacted`);
    assert.equal(redacted.includes('keep=1'), true, `${key} must not disturb other parameters`);
  }
  // Case-insensitive, so an oddly-cased parameter cannot slip through.
  assert.equal(redactRequestUrl('/x?TICKET=LEAKME').includes('LEAKME'), false);
});

test('§24: a URL without a query is returned unchanged', () => {
  assert.equal(redactRequestUrl('/api/v1/sessions'), '/api/v1/sessions');
  assert.equal(redactRequestUrl(''), '');
  assert.equal(redactRequestUrl(undefined), '');
});

test('§62: credential headers are redacted', () => {
  const redacted = redactHeaders({
    authorization: `Bearer ${PHONE_BEARER_SECRET_X}`,
    cookie: DSH_COOKIE_SECRET_Z,
    'set-cookie': 'a=b',
    'content-type': 'application/json',
    host: '127.0.0.1:9445',
  });
  assert.equal(redacted.authorization, REDACTED);
  assert.equal(redacted.cookie, REDACTED);
  assert.equal(redacted['set-cookie'], REDACTED);
  // Non-credential headers survive, so a log stays useful.
  assert.equal(redacted['content-type'], 'application/json');
  assert.equal(redacted.host, '127.0.0.1:9445');
});

test('§62: structured diagnostics redact credential fields recursively', () => {
  const redacted = redactStructured({
    request: { headers: { authorization: `Bearer ${PHONE_BEARER_SECRET_X}` }, url: `/x?ticket=${WS_TICKET_SECRET_Y}` },
    nested: { deeper: { cookie: DSH_COOKIE_SECRET_Z } },
  });
  assert.equal(redacted.request.headers.authorization, REDACTED);
  assert.equal(redacted.nested.deeper.cookie, REDACTED);
  // A URL value is rewritten too, since that is where a ticket hides.
  assert.equal(redacted.request.url.includes(WS_TICKET_SECRET_Y), false);
  const text = JSON.stringify(redacted);
  for (const secret of [PHONE_BEARER_SECRET_X, WS_TICKET_SECRET_Y, DSH_COOKIE_SECRET_Z]) {
    assert.equal(findSecret(text, [secret]), null, `${secret} must not survive redaction`);
  }
});

test('§45: redaction does not touch a plain string that merely mentions a token', () => {
  const sentence = 'my token budget is 1000 and the cookie recipe is a secret';
  assert.equal(redactStructured(sentence), sentence, 'prose is returned unchanged');
  assert.equal(redactRequestUrl(sentence), sentence, 'prose is not a URL and is untouched');
});

test('§86: no synthetic secret appears in an HTTP error', async () => {
  const h = await startAuthServer();
  try {
    for (const header of [
      `Bearer ${PHONE_BEARER_SECRET_X}`,
      `Basic ${PHONE_BEARER_SECRET_X}`,
      `Bearer ${WS_TICKET_SECRET_Y}, Bearer ${PHONE_BEARER_SECRET_X}`,
    ]) {
      const res = await request(h.baseUrl, '/api/v1/sessions', { headers: { authorization: header } });
      const text = `${res.text}\n${JSON.stringify(res.headers)}`;
      assert.equal(findSecret(text, [PHONE_BEARER_SECRET_X, WS_TICKET_SECRET_Y]), null, `${header.slice(0, 6)} leaked`);
    }
  } finally {
    await h.close();
  }
});

test('§86: no synthetic secret appears in a WebSocket refusal', async () => {
  const h = await startAuthServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/events', {
      headers: { authorization: `Bearer ${PHONE_BEARER_SECRET_X}` },
    });
    const text = `${res.text}\n${JSON.stringify(res.headers)}`;
    assert.equal(findSecret(text, [PHONE_BEARER_SECRET_X]), null);
  } finally {
    await h.close();
  }
});

test('§86: a ticket in the upgrade URL never appears in the refusal body', async () => {
  const h = await startAuthServer();
  try {
    const res = await request(h.baseUrl, `/api/v1/events?session_id=${SESSION}&ticket=${WS_TICKET_SECRET_Y}`);
    const text = `${res.text}\n${JSON.stringify(res.headers)}`;
    assert.equal(findSecret(text, [WS_TICKET_SECRET_Y]), null, 'a refused ticket must not be echoed');
  } finally {
    await h.close();
  }
});

test('§86: no synthetic secret appears in the durable state', async () => {
  const { root, cleanup } = makeTempStateRoot('r6-redact-durable');
  const h = await startAuthServer({ persistenceConfig: { root, segmentBytes: 65_536 } });
  try {
    // Exercise the paths that write: an authenticated prompt and a minted ticket.
    await h.post(`/api/v1/sessions/${SESSION}/messages`, {
      content: 'hello from a redaction test',
      client_message_id: 'cmid-redact-1',
    });
    const mint = await h.post('/api/v1/auth/ws-ticket', { session_id: SESSION });
    h.persistence.writeSnapshot(true);

    const scan = scanTreeForSecrets(root, [
      PHONE_BEARER_SECRET_X,
      WS_TICKET_SECRET_Y,
      DSH_COOKIE_SECRET_Z,
      h.token,
      mint.body.data.ticket,
    ]);
    assert.ok(scan.files > 0, 'the state root has files to scan');
    assert.deepEqual(scan.leaked, [], 'no credential may reach durable state');
  } finally {
    await h.close();
    cleanup();
  }
});

test('§86: the ticket endpoint response carries the ticket but no state path', async () => {
  const h = await startAuthServer();
  try {
    const res = await h.post('/api/v1/auth/ws-ticket', { session_id: SESSION });
    assert.equal(res.status, 201);
    // The ticket is the intended payload; nothing else credential-shaped may appear.
    const headers = JSON.stringify(res.headers);
    assert.equal(headers.includes(h.token), false, 'the long-lived credential must not be echoed');
    assert.equal(headers.includes('.dsh'), false);
    assert.equal(headers.includes('DSH_REMOTE'), false);
  } finally {
    await h.close();
  }
});

test('§47: auth health and diagnostics never disclose a credential fact', async () => {
  const h = await startAuthServer();
  try {
    const stats = JSON.stringify(h.auth.stats());
    assert.equal(stats.includes(h.token), false, 'no credential');
    assert.equal(stats.includes(h.token.slice(0, 8)), false, 'no prefix');
    // A digest would be a fingerprint, so it must not appear either.
    assert.equal(/[0-9a-f]{64}/.test(stats), false, 'no digest');
    for (const forbidden of ['env', 'source', 'path', 'file']) {
      assert.equal(stats.toLowerCase().includes(forbidden), false, `stats must not mention ${forbidden}`);
    }
  } finally {
    await h.close();
  }
});

test('§86: the redaction helpers are pure and never mutate their input', () => {
  const headers = { authorization: 'Bearer secret' };
  const out = redactHeaders(headers);
  assert.notEqual(out, headers, 'a copy is returned');
  assert.equal(headers.authorization, 'Bearer secret', 'the input is untouched');

  const nested = { a: { cookie: 'x' } };
  const redacted = redactStructured(nested);
  assert.notEqual(redacted.a, nested.a);
  assert.equal(nested.a.cookie, 'x');
});

test('§24: a malformed percent-encoded parameter does not throw', () => {
  assert.doesNotThrow(() => redactRequestUrl('/x?ticket=%E0%A4%A=1'));
  assert.doesNotThrow(() => redactRequestUrl('/x?%ZZ=1'));
});
