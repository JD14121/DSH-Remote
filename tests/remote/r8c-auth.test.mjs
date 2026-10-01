/**
 * R8C — credential lifecycle, storage boundaries and the 401 / unreachable distinction.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  CREDENTIAL_KEY,
  CredentialStore,
  createMemoryStorage,
  redactCredential,
} from '../../src/remote/ui/api/credential-store.js';
import { RealModeController } from '../../src/remote/ui/api/real-mode.js';
import { ApiClient } from '../../src/remote/ui/api/api-client.js';

const UI = path.join(process.cwd(), 'src', 'remote', 'ui');

const HEALTH_OK = {
  status: 200,
  body: { auth: {}, dsh: {}, gateway: {}, persistence: {}, ready: true, status: 'ok' },
};
const SESSIONS_EMPTY = { status: 200, body: { items: [] } };

/** A scripted fake fetch that counts calls. */
function scriptedFetch(steps) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step.throw !== undefined) throw step.throw;
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      headers: { get: () => null },
      json: async () => step.body,
    };
  };
  return { impl, calls };
}

test('the credential lives under one sessionStorage key and nowhere else', () => {
  const storage = createMemoryStorage();
  const store = new CredentialStore({ storage });
  store.write('tok-1');
  assert.equal(storage.getItem(CREDENTIAL_KEY), 'tok-1');
  assert.equal(storage.length, 1, 'exactly one key may be written');
  assert.equal(store.read(), 'tok-1');
  store.clear();
  assert.equal(store.read(), null);
});

test('the store never reaches for localStorage or IndexedDB', () => {
  const source = fs.readFileSync(path.join(UI, 'api', 'credential-store.js'), 'utf8')
    // Strip block AND line comments anywhere in the line, so a prose mention of a forbidden
    // API is not mistaken for a use of it.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.equal(/localStorage/.test(source), false, 'localStorage must not appear in code');
  assert.equal(/indexedDB|IndexedDB/.test(source), false, 'IndexedDB must not appear in code');
  assert.match(source, /sessionStorage/);
});

test('no UI module writes to localStorage or IndexedDB', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js') && !entry.name.endsWith('.html')) continue;
      const text = fs.readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      if (/localStorage|indexedDB/.test(text)) offenders.push(path.relative(UI, full));
    }
  };
  walk(UI);
  assert.deepEqual(offenders, [], `durable storage used in:\n${offenders.join('\n')}`);
});

test('storage that throws does not break the app', () => {
  const hostile = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  };
  const store = new CredentialStore({ storage: hostile });
  assert.equal(store.read(), null);
  assert.equal(store.write('tok'), false);
  assert.equal(store.has(), false);
  assert.doesNotThrow(() => store.clear());
});

test('a credential is written only after health confirms it', async () => {
  const storage = createMemoryStorage();
  const { impl } = scriptedFetch([HEALTH_OK, SESSIONS_EMPTY]);
  const controller = new RealModeController({
    client: new ApiClient({ fetchImpl: impl }),
    credentials: new CredentialStore({ storage }),
  });

  await controller.submitCredential('good-token');
  assert.equal(storage.getItem(CREDENTIAL_KEY), 'good-token');
  assert.equal(controller.state.connection, 'connected');
});

test('a rejected credential is not persisted', async () => {
  const storage = createMemoryStorage();
  const { impl } = scriptedFetch([{ status: 401, body: {} }]);
  const controller = new RealModeController({
    client: new ApiClient({ fetchImpl: impl }),
    credentials: new CredentialStore({ storage }),
  });

  await controller.submitCredential('bad-token');
  assert.equal(storage.getItem(CREDENTIAL_KEY), null, 'a bad token must never be stored');
  assert.equal(controller.state.connection, 'auth_required');
  assert.equal(controller.state.credentialState, 'invalid');
});

test('a 401 on reload clears the stored credential and re-prompts', async () => {
  const storage = createMemoryStorage();
  storage.setItem(CREDENTIAL_KEY, 'stale-token');

  // First boot succeeds; the next health call returns 401.
  const steps = [HEALTH_OK, SESSIONS_EMPTY, { status: 401, body: {} }];
  const { impl } = scriptedFetch(steps);
  const controller = new RealModeController({
    client: new ApiClient({ fetchImpl: impl }),
    credentials: new CredentialStore({ storage }),
  });

  await controller.boot();
  assert.equal(controller.state.connection, 'connected');

  // A later reload with the credential now rejected.
  await controller.boot();
  assert.equal(controller.state.connection, 'auth_required');
  assert.equal(storage.getItem(CREDENTIAL_KEY), null, '401 must clear the credential');
  assert.equal(controller.state.credentialDialogOpen, true);
});

test('an unreachable Gateway preserves the credential', async () => {
  const storage = createMemoryStorage();
  storage.setItem(CREDENTIAL_KEY, 'valid-token');
  const { impl } = scriptedFetch([{ throw: new TypeError('Failed to fetch') }]);
  const controller = new RealModeController({
    client: new ApiClient({ fetchImpl: impl }),
    credentials: new CredentialStore({ storage }),
  });

  await controller.boot();
  assert.equal(controller.state.connection, 'gateway_unavailable');
  assert.equal(
    storage.getItem(CREDENTIAL_KEY),
    'valid-token',
    'an unreachable Gateway must NOT discard a possibly-valid credential',
  );
  assert.equal(controller.state.credentialDialogOpen, false, 'and must not demand a new one');
});

test('401 and gateway-unavailable are genuinely distinguishable', async () => {
  const storage = createMemoryStorage();
  const bad = scriptedFetch([{ status: 401, body: {} }]);
  const down = scriptedFetch([{ throw: new TypeError('Failed to fetch') }]);

  const a = new RealModeController({ client: new ApiClient({ fetchImpl: bad.impl }), credentials: new CredentialStore({ storage: createMemoryStorage() }) });
  const b = new RealModeController({ client: new ApiClient({ fetchImpl: down.impl }), credentials: new CredentialStore({ storage: createMemoryStorage() }) });

  await a.submitCredential('t');
  await b.submitCredential('t');

  assert.equal(a.state.connection, 'auth_required');
  assert.equal(b.state.connection, 'gateway_unavailable');
  assert.notEqual(a.state.connection, b.state.connection);
  assert.equal(a.state.credentialDialogOpen, true);
  assert.equal(b.state.credentialDialogOpen, false);
});

test('an empty token is refused locally without any request', async () => {
  const { impl, calls } = scriptedFetch([HEALTH_OK]);
  const controller = new RealModeController({
    client: new ApiClient({ fetchImpl: impl }),
    credentials: new CredentialStore({ storage: createMemoryStorage() }),
  });
  await controller.submitCredential('   ');
  assert.equal(calls.length, 0, 'no request may be made for an empty token');
  assert.equal(controller.state.credentialState, 'invalid');
});

test('sign-out clears the credential and returns to the dialog', async () => {
  const storage = createMemoryStorage();
  storage.setItem(CREDENTIAL_KEY, 'tok');
  const { impl } = scriptedFetch([HEALTH_OK, SESSIONS_EMPTY]);
  const controller = new RealModeController({
    client: new ApiClient({ fetchImpl: impl, credential: 'tok' }),
    credentials: new CredentialStore({ storage }),
  });
  controller.signOut();
  assert.equal(storage.getItem(CREDENTIAL_KEY), null);
  assert.equal(controller.state.connection, 'auth_required');
});

test('redactCredential never returns any part of the value', () => {
  assert.equal(redactCredential('super-secret-token'), '[redacted]');
  assert.equal(redactCredential(''), '[absent]');
  assert.equal(redactCredential(undefined), '[absent]');
  assert.equal(redactCredential('super-secret-token').includes('super'), false);
});
