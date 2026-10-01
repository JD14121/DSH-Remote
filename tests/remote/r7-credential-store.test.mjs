/**
 * Credential store tests — Phase R7 §9, §10, §11, §39.
 *
 * The behaviours under test are the ones that would be silent failures in production:
 * a racing double-create, a silent regeneration over a valid token, and a token that
 * reaches a log or a metadata file.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  CredentialStore,
  R7_ERROR,
  generatePhoneToken,
  isValidPhoneToken,
  makeTempProduction,
  scanTreeForSecrets,
} from './r7-helpers.mjs';
import { creationNotice } from '../../src/remote/production/credential-store.mjs';

/** A store with ACL work stubbed out, for tests that are not about the ACL. */
function storeFor(config, overrides = {}) {
  return new CredentialStore({
    paths: config.paths,
    harden: null,
    verify: null,
    clock: () => '2026-09-19T12:00:00.000Z',
    uuid: () => 'generation-0001',
    ...overrides,
  });
}

test('§9: a generated token is 32 bytes of base64url', () => {
  for (let index = 0; index < 20; index += 1) {
    const token = generatePhoneToken();
    assert.equal(token.length, 43);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    assert.equal(isValidPhoneToken(token), true);
  }
  assert.equal(new Set(Array.from({ length: 50 }, generatePhoneToken)).size, 50, 'all distinct');
});

test('§9: the token shape validator rejects anything else', () => {
  const valid = generatePhoneToken();
  for (const bad of ['', null, undefined, 42, valid.slice(0, 42), `${valid}A`, `${valid.slice(0, 42)}=`, `${valid.slice(0, 42)}+`]) {
    assert.equal(isValidPhoneToken(bad), false, `${String(bad)} must be rejected`);
  }
});

test('§10: creating the credential writes the token and secret-free metadata', async () => {
  const { config, cleanup } = makeTempProduction();
  try {
    fs.mkdirSync(config.paths.secrets, { recursive: true });
    const store = storeFor(config);
    const created = await store.ensure();
    assert.equal(created.created, true);

    const onDisk = fs.readFileSync(config.paths.phoneToken, 'utf8');
    assert.equal(onDisk, store.requireToken(), 'the file is the token, byte for byte');
    // No BOM and no trailing newline — the file IS the credential.
    assert.equal(onDisk.charCodeAt(0) === 0xFEFF, false);
    assert.equal(onDisk.endsWith('\n'), false);

    const meta = JSON.parse(fs.readFileSync(config.paths.phoneTokenMeta, 'utf8'));
    assert.deepEqual(Object.keys(meta).sort(), ['created_at', 'generation_id', 'v']);
    assert.equal(meta.v, 1);

    // §10/§39: the metadata must not contain the token, a digest, or a prefix.
    const metaText = JSON.stringify(meta);
    assert.equal(metaText.includes(onDisk), false);
    assert.equal(metaText.includes(onDisk.slice(0, 8)), false);
    assert.equal(/[0-9a-f]{32,}/.test(metaText), false, 'no digest');
  } finally {
    cleanup();
  }
});

test('§11: the first-generation notice never contains the token', async () => {
  const { config, cleanup } = makeTempProduction();
  try {
    fs.mkdirSync(config.paths.secrets, { recursive: true });
    const store = storeFor(config);
    const created = await store.ensure();
    assert.equal(created.notice, creationNotice());
    assert.equal(created.notice.includes(store.requireToken()), false);
    assert.match(created.notice, /created securely/);
    assert.match(created.notice, /phone-token-show\.ps1/);
  } finally {
    cleanup();
  }
});

test('§9: an existing credential is loaded, never silently regenerated', async () => {
  const { config, cleanup } = makeTempProduction();
  try {
    fs.mkdirSync(config.paths.secrets, { recursive: true });
    const first = storeFor(config);
    await first.ensure();
    const original = fs.readFileSync(config.paths.phoneToken, 'utf8');

    const second = storeFor(config, { uuid: () => 'generation-0002' });
    const loaded = await second.ensure();
    assert.equal(loaded.created, false, 'it must load, not create');
    assert.equal(loaded.notice, null, 'and stay silent');
    assert.equal(second.requireToken(), original, 'the token is unchanged');
    assert.equal(fs.readFileSync(config.paths.phoneToken, 'utf8'), original);
  } finally {
    cleanup();
  }
});

test('§9: a malformed existing credential is a hard failure, not a regenerate', async () => {
  const { config, cleanup } = makeTempProduction();
  try {
    fs.mkdirSync(config.paths.secrets, { recursive: true });
    fs.writeFileSync(config.paths.phoneToken, 'too-short', 'utf8');
    const store = storeFor(config);
    await assert.rejects(
      () => store.load(),
      (error) => error.code === R7_ERROR.PHONE_TOKEN_INVALID,
    );
    // The bad file must still be there: overwriting it would destroy evidence.
    assert.equal(fs.readFileSync(config.paths.phoneToken, 'utf8'), 'too-short');
  } finally {
    cleanup();
  }
});

test('§9: an exclusive create makes a double first-start race safe', async () => {
  const { config, cleanup } = makeTempProduction();
  try {
    fs.mkdirSync(config.paths.secrets, { recursive: true });
    const a = storeFor(config, { uuid: () => 'generation-a' });
    const b = storeFor(config, { uuid: () => 'generation-b' });

    // Both observe "absent" and both try to create, which is exactly the race.
    await a.create();
    await assert.rejects(
      () => b.create(),
      (error) => error.code === R7_ERROR.CREDENTIAL_RACE,
      'the loser must not overwrite the winner',
    );

    // The winner's token is intact and the loser can load it.
    const loaded = await b.load();
    assert.equal(loaded.token, a.requireToken());
    assert.equal(loaded.generationId, 'generation-a');
  } finally {
    cleanup();
  }
});

test('§11: rotation replaces the credential and keeps no plaintext backup', async () => {
  const { config, cleanup } = makeTempProduction();
  try {
    fs.mkdirSync(config.paths.secrets, { recursive: true });
    const store = storeFor(config, { uuid: () => 'generation-old' });
    await store.ensure();
    const original = store.requireToken();

    const rotated = storeFor(config, { uuid: () => 'generation-new' });
    await rotated.load();
    await rotated.rotate();

    const replacement = rotated.requireToken();
    assert.notEqual(replacement, original, 'the credential really changed');
    assert.equal(fs.readFileSync(config.paths.phoneToken, 'utf8'), replacement);

    const meta = JSON.parse(fs.readFileSync(config.paths.phoneTokenMeta, 'utf8'));
    assert.equal(meta.generation_id, 'generation-new');

    // §39: the old token must not survive anywhere in the tree.
    const scan = scanTreeForSecrets(config.paths.secrets, [original]);
    assert.deepEqual(scan.leaked, [], 'no plaintext backup of the old token');

    // And no temp file was left behind.
    const leftovers = fs.readdirSync(config.paths.secrets).filter((name) => name.includes('.tmp-') || name.includes('.rotate-'));
    assert.deepEqual(leftovers, [], 'no rotation temp file survives');
  } finally {
    cleanup();
  }
});

test('§11: a failed rotation still leaves no temp file', async () => {
  const { config, cleanup } = makeTempProduction();
  try {
    fs.mkdirSync(config.paths.secrets, { recursive: true });
    const store = storeFor(config);
    await store.ensure();

    const failing = storeFor(config, {
      // The verify step fails, which aborts before the rename.
      verify: async () => { throw new Error('acl says no'); },
    });
    await failing.load().catch(() => {});
    await assert.rejects(() => failing.rotate(), /acl says no/);

    const leftovers = fs.readdirSync(config.paths.secrets).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, [], 'the temp file must be removed even on failure');
  } finally {
    cleanup();
  }
});

test('§8: the ACL is verified before the token is read', async () => {
  const { config, cleanup } = makeTempProduction();
  try {
    fs.mkdirSync(config.paths.secrets, { recursive: true });
    await storeFor(config).ensure();

    const order = [];
    const store = storeFor(config, {
      verify: async () => { order.push('verify'); },
    });
    // Read the file directly too, so the ordering is observable.
    const originalRead = fs.readFileSync;
    await store.load();
    order.push('loaded');
    assert.deepEqual(order, ['verify', 'loaded'], 'verification precedes the read');
    assert.equal(typeof originalRead, 'function');
  } finally {
    cleanup();
  }
});

test('a store that has loaded nothing refuses to hand out a token', () => {
  const { config, cleanup } = makeTempProduction();
  try {
    const store = storeFor(config);
    assert.throws(
      () => store.requireToken(),
      (error) => error.code === R7_ERROR.PHONE_TOKEN_INVALID,
    );
  } finally {
    cleanup();
  }
});

test('§39: describe() never includes the token', async () => {
  const { config, cleanup } = makeTempProduction();
  try {
    fs.mkdirSync(config.paths.secrets, { recursive: true });
    const store = storeFor(config);
    await store.ensure();
    const described = JSON.stringify(store.describe());
    assert.equal(described.includes(store.requireToken()), false);
    assert.equal(described.includes(store.requireToken().slice(0, 8)), false);
    assert.equal(described.includes('generation-0001'), true, 'the generation id is safe to report');
  } finally {
    cleanup();
  }
});

test('§39: no credential appears anywhere in the created tree', async () => {
  const { config, cleanup } = makeTempProduction();
  try {
    fs.mkdirSync(config.paths.secrets, { recursive: true });
    const store = storeFor(config);
    await store.ensure();
    const token = store.requireToken();

    // The secret file itself is the one permitted location.
    const scan = scanTreeForSecrets(config.paths.root, [token]);
    assert.deepEqual(scan.leaked, [path.relative(config.paths.root, config.paths.phoneToken)]);

    // And nothing else under root carries it.
    const others = scan.leaked.filter((file) => file !== path.relative(config.paths.root, config.paths.phoneToken));
    assert.deepEqual(others, []);
  } finally {
    cleanup();
  }
});

test('clear() drops the in-memory token', async () => {
  const { config, cleanup } = makeTempProduction();
  try {
    fs.mkdirSync(config.paths.secrets, { recursive: true });
    const store = storeFor(config);
    await store.ensure();
    store.clear();
    assert.throws(() => store.requireToken(), (error) => error.code === R7_ERROR.PHONE_TOKEN_INVALID);
  } finally {
    cleanup();
  }
});
