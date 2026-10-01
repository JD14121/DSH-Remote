/**
 * Auth/persistence boundary tests — Phase R6 §44, §45, §58, §59, §87.
 *
 * §44 requires proof that no auth material can reach R5's durable state, and §45
 * requires the opposite proof for user content: real user text must still be there.
 * A test that only checked the first would pass trivially if the journal were empty,
 * so both directions are asserted.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SESSION,
  fs,
  path,
  makeTempStateRoot,
  scanTreeForSecrets,
  startAuthServer,
  startFixtureServer,
  request,
} from './r6-helpers.mjs';

/** Run `fn` for every regular file under a root. */
function walkFiles(root, fn) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else fn(full, fs.readFileSync(full, 'utf8'));
    }
  };
  if (fs.existsSync(root)) walk(root);
}

test('§87: an authenticated prompt is accepted, and journaled content carries no credential', async () => {
  const { root, cleanup } = makeTempStateRoot('r6-boundary');
  const h = await startAuthServer({ persistenceConfig: { root, segmentBytes: 65_536 } });
  try {
    const content = 'a durable user message that must survive';
    const res = await h.post(`/api/v1/sessions/${SESSION}/messages`, {
      content,
      client_message_id: 'cmid-boundary-1',
    });
    assert.equal(res.status, 202, 'the authenticated prompt is accepted');

    // A prompt is sent to DSH and reflected as a **status** event, so the message
    // body is not itself journaled. To make the durable check meaningful, emit an
    // event that does carry user content and confirm it is stored while the
    // credential is not.
    h.eventsService.emit({
      sessionId: SESSION,
      event: 'message.created',
      data: { content: { text: content } },
    });
    h.persistence.writeSnapshot(true);

    // Direction 1: the credential is nowhere in durable state.
    const secretScan = scanTreeForSecrets(root, [h.token]);
    assert.ok(secretScan.files > 0, 'the state root has files');
    assert.deepEqual(secretScan.leaked, [], 'no credential may reach durable state');

    // Direction 2: the user content really is there, so direction 1 was not vacuous.
    let sawContent = false;
    walkFiles(root, (_file, text) => {
      if (text.includes(content)) sawContent = true;
    });
    assert.equal(sawContent, true, 'the user content must actually be journaled');
  } finally {
    await h.close();
    cleanup();
  }
});

test('§44: a ticket never reaches the journal, snapshot or cursor file', async () => {
  const { root, cleanup } = makeTempStateRoot('r6-boundary-ticket');
  const h = await startAuthServer({ persistenceConfig: { root, segmentBytes: 65_536 } });
  try {
    const mint = await h.post('/api/v1/auth/ws-ticket', { session_id: SESSION });
    const ticket = mint.body.data.ticket;
    h.eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: { after: 'ticket' } });
    h.persistence.writeSnapshot(true);
    h.persistence.rememberCursor(SESSION, 42);

    const scan = scanTreeForSecrets(root, [ticket]);
    assert.deepEqual(scan.leaked, [], 'a ticket is ephemeral state (§25)');
  } finally {
    await h.close();
    cleanup();
  }
});

test('§59: a DSH-shaped cookie or launch token is not accepted as a Phone credential', async () => {
  const h = await startAuthServer();
  try {
    for (const value of [
      'dsh-auth-0123456789abcdefghijklmnop',
      'launch-token-0123456789abcdefghijkl',
      'cookie-value-0123456789abcdefghij',
    ]) {
      const res = await request(h.baseUrl, '/api/v1/sessions', {
        headers: { authorization: `Bearer ${value}` },
      });
      assert.equal(res.status, 401, `${value.slice(0, 10)}... must not authenticate`);
    }
  } finally {
    await h.close();
  }
});

test('§58: the Phone Authorization header is never forwarded to the adapter', async () => {
  const { root, cleanup } = makeTempStateRoot('r6-boundary-adapter');
  const h = await startAuthServer({ persistenceConfig: { root, segmentBytes: 65_536 } });
  try {
    // Capture every argument the adapter is given, then assert no auth artefact
    // appears anywhere in it.
    const seen = [];
    const adapter = h.sessionsService.adapter;
    const originalSend = adapter.sendMessage.bind(adapter);
    adapter.sendMessage = async (...args) => {
      seen.push(JSON.stringify(args));
      return originalSend(...args);
    };

    const mint = await h.post('/api/v1/auth/ws-ticket', { session_id: SESSION });
    await h.post(`/api/v1/sessions/${SESSION}/messages`, {
      content: 'hello adapter',
      client_message_id: 'cmid-boundary-2',
    });

    assert.ok(seen.length > 0, 'the adapter really was called');
    const text = seen.join('\n');
    assert.equal(text.includes(h.token), false, 'the Phone credential must not reach the adapter');
    assert.equal(text.includes('Bearer'), false, 'nor an Authorization header');
    assert.equal(text.includes(mint.body.data.ticket), false, 'nor a ticket');
  } finally {
    await h.close();
    cleanup();
  }
});

test('§44: a credential-bearing field cannot be encoded into a journal record', async () => {
  const { assertNoCredentialMaterial } = await import('../../src/remote/persistence/record.mjs');

  for (const field of ['authorization', 'cookie', 'token', 'api_key', 'password', 'secret']) {
    assert.throws(
      () => assertNoCredentialMaterial({ [field]: 'x' }, 'event'),
      'a credential-bearing field must be refused on the way to disk',
    );
  }
  // And a credential-shaped value under an innocuous field name is refused too.
  assert.throws(() => assertNoCredentialMaterial({ note: 'Bearer abcdefghijklmnopqrstuvwxyz012345' }, 'event'));
});

test('§45: user text mentioning tokens is preserved byte-for-byte', async () => {
  const { root, cleanup } = makeTempStateRoot('r6-boundary-usertext');
  const h = await startAuthServer({ persistenceConfig: { root, segmentBytes: 65_536 } });
  try {
    const content = 'my token budget is 1000, the cookie recipe is secret, authorization is hard';
    // Emitted as a durable event, because that is what reaches the journal; a prompt
    // is dispatched to DSH and only its status is journaled locally.
    h.eventsService.emit({
      sessionId: SESSION,
      event: 'message.created',
      data: { content: { text: content } },
    });
    h.persistence.writeSnapshot(true);

    let found = null;
    walkFiles(root, (_file, text) => {
      if (text.includes('token budget is 1000')) found = text;
    });
    assert.ok(found !== null, 'the sentence must be journaled');
    assert.ok(found.includes(content), 'the user text must not be rewritten or partially redacted');
    assert.equal(found.includes('<redacted>'), false, 'no redaction marker may appear in user content');
  } finally {
    await h.close();
    cleanup();
  }
});

test('§44: the auth layer has no persistence handle at all', async () => {
  // A source-level check: the auth layer cannot write durable state because it never
  // imports the persistence layer.
  const fsModule = await import('node:fs');
  const dir = new URL('../../src/remote/auth/', import.meta.url);
  for (const name of fsModule.readdirSync(dir)) {
    const source = fsModule.readFileSync(new URL(name, dir), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const banned of ["persistence/", 'node:fs']) {
      assert.equal(code.includes(banned), false, `${name} must not reference ${banned}`);
    }
  }
});

test('§69: a fixture with auth disabled still writes only to a temp root', async () => {
  const { root, cleanup } = makeTempStateRoot('r6-boundary-fixture');
  const h = await startFixtureServer({ persistenceConfig: { root, segmentBytes: 65_536 } });
  try {
    assert.equal(h.server.auth, null);
    assert.equal(path.resolve(h.persistence.config.root), path.resolve(root));
  } finally {
    await h.close();
    cleanup();
  }
});
