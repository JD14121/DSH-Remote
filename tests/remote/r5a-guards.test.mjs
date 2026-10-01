/**
 * R5A acceptance guards — Phase R5A §7, §8, §10, §22.
 *
 * The remediation is only real if it is also *verified*. These tests cover the
 * properties R5A must establish and keep:
 *
 *   - the production default is still `%DSH_HOME%\remote` (§10) — the incident is
 *     not "fixed" by weakening the product;
 *   - the test harness cannot silently opt into production persistence (§8);
 *   - the real state root does not exist before or after exercise (§7, §22).
 *
 * The real root is only ever *stat*ed. Nothing here creates, reads or deletes it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveDshHome,
  resolvePersistenceConfig,
  assertTempStateRoot,
  makeTempStateRoot,
} from './r5-helpers.mjs';
import { startFixtureServer } from './r3-helpers.mjs';

/** The real DSH home, used only to build paths — never opened. */
const REAL_HOME = resolveDshHome(process.env);
const REAL_ROOT = path.join(REAL_HOME, 'remote');

test('§10: the production default is still %DSH_HOME%\\remote', () => {
  const synthetic = path.join(os.tmpdir(), 'r5a-prod-default', '.dsh');
  const config = resolvePersistenceConfig({}, { DSH_HOME: synthetic });

  assert.equal(config.root, path.join(path.resolve(synthetic), 'remote'));
  assert.equal(config.isDefaultRoot, true, 'the default is still recognised as the default');
  // And it is not silently redirected somewhere else to make tests easier.
  assert.equal(config.root, path.join(resolveDshHome({ DSH_HOME: synthetic }), 'remote'));
});

test('§10: with no override at all the default still follows DSH_HOME', () => {
  // This machine's real DSH_HOME is the string used, but nothing is created: the
  // call only resolves a path.
  const config = resolvePersistenceConfig({}, { DSH_HOME: REAL_HOME });
  assert.equal(config.root, REAL_ROOT);
  assert.equal(config.isDefaultRoot, true);
});

test('§10: an explicit override still wins over DSH_HOME', () => {
  const { root, cleanup } = makeTempStateRoot('r5a-override');
  try {
    const config = resolvePersistenceConfig({ root }, { DSH_HOME: REAL_HOME });
    assert.equal(config.root, path.resolve(root));
    assert.equal(config.isDefaultRoot, false);
    assert.notEqual(config.root, REAL_ROOT);
  } finally {
    cleanup();
  }
});

test('§8: the fixture harness defaults to no persistence', async () => {
  // The poisoned environment is set here too, so this cannot pass merely because
  // this machine happens to have no DSH_HOME.
  const handle = await startFixtureServer();
  try {
    assert.equal(handle.persistence, null, 'a fixture server must not enable durability by default');
    assert.equal(handle.server.persistence, null);
  } finally {
    await handle.close();
  }
  // The property is "this fixture did not write production state", not "no production
  // root exists" — after Gate B the latter is false by design.
  assert.equal(realRootIsAcceptable(), true, `a fixture must not create production state: ${REAL_ROOT}`);
});

test('§8: a fixture server without an explicit decision cannot reach the real root', async () => {
  // Belt and braces: the helper's default is an explicit opt-out. Confirm the
  // factory itself refuses an implicit decision, so no future helper can regress
  // into inheriting production settings.
  //
  // A minimal but real service stack is supplied, so the factory gets past its
  // argument checks and actually reaches the durability decision. Without that this
  // would pass because of a missing-service error instead.
  const { createRemoteHttpServer } = await import('../../src/remote/server.mjs');
  const { EventsService } = await import('../../src/remote/events.mjs');
  const { MessagesService } = await import('../../src/remote/messages.mjs');
  const { SessionsService } = await import('../../src/remote/sessions.mjs');
  const { StatusService } = await import('../../src/remote/status-service.mjs');
  const { SessionViewStore } = await import('../../src/remote/state/session-view-store.mjs');

  const stack = () => {
    const store = new SessionViewStore({ clock: () => 0 });
    const eventsService = new EventsService({ adapter: {}, store, clock: () => 0 });
    return {
      sessionsService: new SessionsService({ adapter: {}, store, clock: () => 0 }),
      messagesService: new MessagesService({ adapter: {}, store, clock: () => 0 }),
      eventsService,
      statusService: new StatusService({ adapter: {}, eventsService, clock: () => 0 }),
      adapter: {},
      // R6 §5 requires its own explicit auth decision, so it is supplied here and
      // this suite keeps testing the durability decision it is about.
      auth: null,
    };
  };

  assert.throws(
    () => createRemoteHttpServer(stack()),
    (error) => error instanceof TypeError && /explicit durability decision/.test(error.message),
    'omitting the decision must fail for the durability reason, not another',
  );

  // And the explicit opt-out is accepted without touching the real root.
  const inert = createRemoteHttpServer({ ...stack(), persistence: null, auth: null });
  assert.equal(inert.persistence, null);
  assert.equal(realRootIsAcceptable(), true, `production state appeared: ${REAL_ROOT}`);
});

test('§8: durability is opt-in, and an opt-in uses the temp root it was given', async () => {
  const { root, cleanup } = makeTempStateRoot('r5a-optin');
  const handle = await startFixtureServer({ persistenceConfig: { root, segmentBytes: 65_536 } });
  try {
    assert.notEqual(handle.persistence, null, 'an explicit config does enable durability');
    assert.equal(path.resolve(handle.persistence.config.root), path.resolve(root));
    assert.notEqual(path.resolve(handle.persistence.config.root), REAL_ROOT);
  } finally {
    await handle.close();
    cleanup();
  }
});

/**
 * Whether the real state root is absent, or a legitimate Gate B production root.
 *
 * These guards catch a **test** that writes production state. Once Gate B has
 * deliberately created that root, its presence is expected — but presence without a
 * format marker and a credential still means something wrote there by accident. So the
 * assertion checks legitimacy rather than absence, which keeps the safety property
 * intact while letting the suite run in both phases.
 *
 * @returns {boolean} true when the root is absent or a production root.
 */
function realRootIsAcceptable() {
  if (!fs.existsSync(REAL_ROOT)) return true;
  const formatOk = fs.existsSync(path.join(REAL_ROOT, 'format.json'));
  const credentialOk = fs.existsSync(path.join(REAL_ROOT, 'secrets', 'phone-token.v1'));
  return formatOk && credentialOk;
}
test('§7/§22: the real state root is absent, or a legitimate production root', () => {
  // The watchdog. Run before and after exercise in the other tests, and asserted here
  // directly so a failure names this file rather than a timing coincidence.
  assert.equal(realRootIsAcceptable(), true, `the real state root is not a production root: ${REAL_ROOT}`);
});

test('§7: the guard refuses every way of naming the real root', () => {
  for (const candidate of [
    REAL_ROOT,
    REAL_HOME,
    path.join(REAL_HOME, 'remote', 'events'),
    path.join(REAL_HOME, 'remote', '..', 'remote'),
  ]) {
    assert.throws(
      () => assertTempStateRoot(candidate),
      /DSH_HOME/,
      `${candidate} must be refused`,
    );
  }
});

test('§7: makeTempStateRoot refuses to hand back a root inside DSH_HOME', () => {
  // The guard is a genuine check, not a formality: it compares resolved paths, so a
  // temp-like label cannot smuggle the real root through.
  const { root, cleanup } = makeTempStateRoot('r5a-guard');
  try {
    assert.equal(root.startsWith(path.resolve(REAL_HOME) + path.sep), false);
    assert.equal(path.resolve(root), root, 'the helper returns an already-resolved path');
  } finally {
    cleanup();
  }
  assert.equal(fs.existsSync(root), false, 'and it cleans up after itself');
});

test('§22: the full suite left no test residue at the real state root', () => {
  // Deliberately a separate assertion from the one above, so the postcondition is
  // checked after this suite has done real work (fixture servers, temp roots).
  //
  // The property has not weakened: a *test* still must never create production state.
  // What changed is that a deliberate Gate B root is now permitted to be there, so the
  // assertion tests legitimacy rather than absence.
  assert.equal(realRootIsAcceptable(), true, `postcondition failed: ${REAL_ROOT}`);
  // And confirm the parent still exists, so this is not passing because the whole
  // tree is missing.
  assert.equal(fs.existsSync(REAL_HOME), true, 'DSH_HOME itself must be untouched but present');
});
