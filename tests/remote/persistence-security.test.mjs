/**
 * Persistence security tests — Phase R5 §54, §55, §56, §62, §65.
 *
 * The journal legitimately contains user session data; that is the point of the
 * feature. What it must never contain is Gateway or DSH credential material. §54 is
 * equally clear that user text must **not** be rewritten — a message containing the
 * word "token" is not a secret.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  makeTempStateRoot,
  processBundle,
  seedSession,
  emitEvents,
  readSegments,
  SESSION,
  PERSISTENCE_ERROR,
  resolvePersistenceConfig,
  containedPath,
  segmentPath,
} from './r5-helpers.mjs';
import { SessionJournal } from '../../src/remote/persistence/journal.mjs';
import { statePaths } from '../../src/remote/persistence/config.mjs';

/** Walk every file under a root and return its text. */
function readAll(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push({ path: full, text: fs.readFileSync(full, 'utf8') });
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

/**
 * Whether a value was refused as credential-bearing.
 *
 * Two independent guards can catch it: R2's event validator rejects a secret-like
 * field before persistence is reached, and the journal's own structural guard
 * rejects it again on the way to disk. Either is a pass — the property under test
 * is that it is refused, not which layer refused it.
 *
 * @param {unknown} error - the thrown value.
 * @returns {boolean} true when it was a credential refusal.
 */
function isCredentialRefusal(error) {
  if (error?.code === PERSISTENCE_ERROR.WRITE_FAILED) return true;
  return error instanceof TypeError && /secret-like|forbidden field/.test(error.message);
}

test('§54: a credential-bearing field is refused before it reaches disk', () => {
  const { root, cleanup } = makeTempStateRoot('r5-sec-field');
  try {
    const bundle = processBundle({ root });
    bundle.boot();
    seedSession(bundle);
    emitEvents(bundle, 2);

    for (const field of ['authorization', 'cookie', 'token', 'api_key', 'password', 'secret']) {
      assert.throws(
        () => bundle.events.emit({ sessionId: SESSION, event: 'unknown', data: { [field]: 'value' } }),
        isCredentialRefusal,
        `field ${field} must be refused`,
      );
    }

    // Nothing partial was written for the refusals.
    const journal = bundle.persistence.journals.get(SESSION);
    assert.equal(journal.highWater, 2, 'a refused event does not advance the journal');
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('§54: user text mentioning secrets is preserved verbatim, not scrubbed', () => {
  const { root, cleanup } = makeTempStateRoot('r5-sec-text');
  try {
    const bundle = processBundle({ root });
    bundle.boot();
    seedSession(bundle);

    const text = 'Please rotate my token, the cookie recipe is a secret, and authorization is hard.';
    bundle.events.emit({ sessionId: SESSION, event: 'message.created', data: { content: { text } } });
    bundle.stop();

    const segments = readSegments(bundle.persistence.config, SESSION);
    const record = JSON.parse(segments[0].text.split('\n')[0]);
    assert.equal(
      record.event.data.content.text,
      text,
      'user content must survive byte-for-byte — rewriting it would be data loss',
    );
  } finally {
    cleanup();
  }
});

test('§62: no credential file is ever read, and no credential reaches the root', () => {
  const { root, cleanup } = makeTempStateRoot('r5-sec-creds');
  try {
    const bundle = processBundle({ root });
    bundle.boot();
    seedSession(bundle);
    emitEvents(bundle, 5);
    bundle.persistence.writeSnapshot(true);
    bundle.stop();

    for (const file of readAll(root)) {
      // A launch token has a recognizable shape; none may appear anywhere.
      assert.equal(/dsh-auth-[A-Za-z0-9_-]{8,}/.test(file.text), false, `a token appeared in ${file.path}`);
      assert.equal(file.text.includes('.credentials.yaml'), false, `a credential path appeared in ${file.path}`);
      assert.equal(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(file.text), false, `a private key appeared in ${file.path}`);
    }
  } finally {
    cleanup();
  }
});

test('§54: the environment is not copied into the state root', () => {
  const { root, cleanup } = makeTempStateRoot('r5-sec-env');
  try {
    const bundle = processBundle({ root });
    bundle.boot();
    seedSession(bundle);

    // An env-shaped bag of secrets must not be persistable.
    assert.throws(
      () => bundle.events.emit({
        sessionId: SESSION,
        event: 'unknown',
        data: { env: { DSH_TOKEN: 'x', authorization: 'y' } },
      }),
      isCredentialRefusal,
    );
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('§56: a session id can never become an arbitrary path', () => {
  const { root, cleanup } = makeTempStateRoot('r5-sec-path');
  try {
    const config = resolvePersistenceConfig({ root }, {});
    for (const evil of ['../../etc', '..', 'a/b', 'a\\b', 'C:', 'x\u0000y', 'session-a/../b']) {
      assert.throws(
        () => segmentPath(config, evil, 1),
        (error) => error.code === PERSISTENCE_ERROR.PATH_INVALID,
        `session id ${JSON.stringify(evil)} must be refused`,
      );
      assert.throws(() => containedPath(root, 'events', evil));
    }

    // And a journal cannot be constructed for one either.
    assert.throws(() => new SessionJournal({ config, sessionId: '../escape' }));
  } finally {
    cleanup();
  }
});

test('§55: directories are created 0700 and files 0600 where the platform honours it', () => {
  const { root, cleanup } = makeTempStateRoot('r5-sec-mode');
  try {
    const bundle = processBundle({ root });
    bundle.boot();
    seedSession(bundle);
    emitEvents(bundle, 3);
    bundle.persistence.writeSnapshot(true);

    const paths = statePaths(bundle.persistence.config);
    if (process.platform !== 'win32') {
      // On POSIX the mode is a real boundary, so assert it.
      for (const dir of [paths.root, paths.stateDir, paths.eventsDir]) {
        assert.equal(fs.statSync(dir).mode & 0o777, 0o700, `${dir} must be 0700`);
      }
      const lock = fs.statSync(paths.lockFile);
      assert.equal(lock.mode & 0o777, 0o600, 'the lock must be 0600');
    } else {
      // On Windows the mode is not an ACL, which the report states explicitly.
      // What is assertable is that the files exist and the code requested a mode.
      assert.ok(fs.existsSync(paths.stateDir));
      const source = fs.readFileSync(
        new URL('../../src/remote/persistence/persistence.mjs', import.meta.url), 'utf8',
      );
      assert.ok(source.includes('0o700'), 'directory modes are requested');
      assert.ok(source.includes('0o600'), 'file modes are requested');
    }
    bundle.stop();
  } finally {
    cleanup();
  }
});

test('§55: R5 never invokes an ACL tool', async () => {
  const { readFile } = await import('node:fs/promises');
  const files = ['persistence.mjs', 'journal.mjs', 'lock.mjs', 'snapshot.mjs', 'config.mjs', 'cursor.mjs', 'reconcile.mjs'];
  for (const name of files) {
    const raw = await readFile(new URL(`../../src/remote/persistence/${name}`, import.meta.url), 'utf8');
    // Strip comments: the lock documents that it never spawns a process, and a
    // prose mention must not read as a use.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const banned of ['icacls', 'chmod', 'chown', 'child_process', 'execSync']) {
      assert.equal(code.includes(banned), false, `${name} must not use ${banned}`);
    }
  }
});

test('§65: the persistence layer opens no listener and no port', async () => {
  const { readFile } = await import('node:fs/promises');
  const files = ['persistence.mjs', 'journal.mjs', 'lock.mjs', 'snapshot.mjs', 'config.mjs', 'cursor.mjs', 'reconcile.mjs', 'record.mjs'];
  for (const name of files) {
    const source = await readFile(new URL(`../../src/remote/persistence/${name}`, import.meta.url), 'utf8');
    for (const banned of ['node:net', 'createServer', '.listen(', 'node:tls', 'https.createServer']) {
      assert.equal(source.includes(banned), false, `${name} must not open a listener (${banned})`);
    }
  }
});

test('§66: persistence adds no runtime dependency beyond Node built-ins', async () => {
  const { readFile } = await import('node:fs/promises');
  const files = ['persistence.mjs', 'journal.mjs', 'lock.mjs', 'snapshot.mjs', 'config.mjs', 'cursor.mjs', 'reconcile.mjs', 'record.mjs', 'errors.mjs'];
  for (const name of files) {
    const source = await readFile(new URL(`../../src/remote/persistence/${name}`, import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import .*? from '([^']+)'/gm)].map((match) => match[1]);
    for (const specifier of imports) {
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
        `${name} imports an unexpected package: ${specifier}`,
      );
    }
  }

  // And package.json still declares exactly one runtime dependency.
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['ws'], 'only ws remains');
  assert.equal(pkg.dependencies.ws, '8.21.3', 'still pinned exactly');
});

test('the state root is never DSH_HOME itself, and no child escapes it', () => {
  const { root, cleanup } = makeTempStateRoot('r5-sec-root');
  try {
    const config = resolvePersistenceConfig({ root }, {});
    const paths = statePaths(config);
    assert.notEqual(paths.root, config.dshHome);
    for (const [name, value] of Object.entries(paths)) {
      if (name === 'snapshotSlots') {
        for (const slot of value) assert.ok(slot.startsWith(paths.root));
        continue;
      }
      assert.ok(value.startsWith(paths.root), `${name} must stay inside the root`);
    }
  } finally {
    cleanup();
  }
});

test('§61: the test guard refuses a root inside DSH_HOME', async () => {
  const { assertTempStateRoot } = await import('./r3-helpers.mjs');
  const dshHome = process.env.DSH_HOME;
  if (typeof dshHome !== 'string' || dshHome.length === 0) {
    // Without DSH_HOME there is no real root to collide with; the guard is a no-op.
    return;
  }
  assert.throws(() => assertTempStateRoot(path.join(dshHome, 'remote')), /DSH_HOME/);
  assert.throws(() => assertTempStateRoot(dshHome), /DSH_HOME/);
  // A genuine temp root passes.
  const { root, cleanup } = makeTempStateRoot('r5-guard');
  try {
    assert.equal(assertTempStateRoot(root), root);
  } finally {
    cleanup();
  }
});
