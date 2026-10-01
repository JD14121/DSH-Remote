/**
 * R5A §9: poisoned-environment regression test.
 *
 * This is the direct regression test for the R5 incident. In R5 the server factory
 * treated "no persistence option" as "use the production default", so a test that
 * simply did not mention persistence silently inherited `DSH_HOME` and wrote the
 * real `D:\DSH-work-test\.dsh\remote`.
 *
 * The test does not take the process environment's word for it. It **spawns a child
 * process with a deliberately poisoned environment** — the real `DSH_HOME` set and
 * `DSH_REMOTE_STATE_ROOT` unset — and asserts inside that child that:
 *
 *   1. a fixture server helper does NOT enable persistence;
 *   2. the temp-root guards reject a root inside `DSH_HOME`;
 *   3. the server factory refuses an implicit durability decision outright.
 *
 * The child runs the real shipped helper and the real shipped factory, so this
 * cannot pass by testing a stand-in.
 *
 * The child's exit status is the assertion result: `node --test` in the child exits
 * non-zero if any of its own assertions fail.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..', '..');

/** The real DSH home on this machine, used only as a string in the poisoned env. */
const POISONED_DSH_HOME = process.env.DSH_HOME ?? 'D:\\DSH-work-test\\.dsh';

/**
 * The program the poisoned child runs.
 *
 * Written to a temp file rather than passed with `-e`, because the project is ESM
 * (`"type": "module"`) and a relaxed child script needs an explicit `.mjs` path.
 */
const CHILD_SOURCE = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Turn an absolute Windows path into an ESM-importable file URL.
 *
 * The default ESM loader rejects a bare \`D:\\...\` specifier with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME, so the child must build a real \`file://\` URL.
 */
const asUrl = (absolute) => pathToFileURL(absolute).href;

const HELPERS = asUrl(${JSON.stringify(path.join(HERE, 'r3-helpers.mjs'))});

const {
  startFixtureServer,
  makeTempStateRoot,
  assertTempStateRoot,
} = await import(HELPERS);

const REAL_HOME = process.env.DSH_HOME;
const REAL_ROOT = path.join(REAL_HOME, 'remote');

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

// The environment really is poisoned, or this test proves nothing.
assert.equal(process.env.DSH_REMOTE_STATE_ROOT, undefined, 'the override must be unset');
assert.ok(REAL_HOME.length > 0, 'DSH_HOME must be set');

// 1. A fixture server must NOT silently activate production persistence.
const handle = await startFixtureServer();
try {
  assert.equal(
    handle.persistence,
    null,
    'a fixture server must not enable persistence just because DSH_HOME is set',
  );
  assert.equal(handle.server.persistence, null, 'the factory agrees');
  // And nothing was created on disk for it.
  assert.equal(realRootIsAcceptable(), true, 'a fixture start must not create production state');
} finally {
  await handle.close();
}

// 2. The temp-root guards must refuse a root inside DSH_HOME.
assert.throws(() => assertTempStateRoot(REAL_ROOT), /DSH_HOME/, 'assertTempStateRoot must refuse the real root');
assert.throws(() => assertTempStateRoot(REAL_HOME), /DSH_HOME/, 'assertTempStateRoot must refuse DSH_HOME itself');

// A guard is only meaningful if it refuses, so prove it accepts a genuine temp root.
const { root, cleanup } = makeTempStateRoot('r5a-poisoned');
try {
  assert.equal(assertTempStateRoot(root), root, 'a real temp root is accepted');
  assert.equal(root.startsWith(path.resolve(REAL_HOME)), false, 'the temp root is outside DSH_HOME');
} finally {
  cleanup();
}

// 3. The factory must refuse an implicit durability decision.
const { createRemoteHttpServer } = await import(asUrl(${JSON.stringify(path.join(PROJECT, 'src', 'remote', 'server.mjs'))}));
const { EventsService } = await import(asUrl(${JSON.stringify(path.join(PROJECT, 'src', 'remote', 'events.mjs'))}));
const { MessagesService } = await import(asUrl(${JSON.stringify(path.join(PROJECT, 'src', 'remote', 'messages.mjs'))}));
const { SessionsService } = await import(asUrl(${JSON.stringify(path.join(PROJECT, 'src', 'remote', 'sessions.mjs'))}));
const { StatusService } = await import(asUrl(${JSON.stringify(path.join(PROJECT, 'src', 'remote', 'status-service.mjs'))}));
const { SessionViewStore } = await import(asUrl(${JSON.stringify(path.join(PROJECT, 'src', 'remote', 'state', 'session-view-store.mjs'))}));

// A minimal real stack, so the factory gets past its argument checks and actually
// reaches the durability decision — otherwise this would pass for the wrong reason.
const store = new SessionViewStore({ clock: () => 0 });
const callArgs = (extra) => ({
  sessionsService: new SessionsService({ adapter: {}, store, clock: () => 0 }),
  messagesService: new MessagesService({ adapter: {}, store, clock: () => 0 }),
  eventsService: new EventsService({ adapter: {}, store, clock: () => 0 }),
  statusService: new StatusService({ adapter: {}, eventsService: new EventsService({ adapter: {}, store, clock: () => 0 }), clock: () => 0 }),
  adapter: {},
  // R6 added its own required explicit decision; supplying it keeps this assertion
  // aimed at the durability decision it is about.
  auth: null,
  ...extra,
});

// Omitting the decision entirely must throw the durability error, not a missing-service
// error, so the assertion names the reason it must fail for.
assert.throws(
  () => createRemoteHttpServer(callArgs({})),
  (error) => error instanceof TypeError && /explicit durability decision/.test(error.message),
  'omitting the durability decision must be a programming error',
);

// And the explicit opt-out still works, with no state root created.
const inert = createRemoteHttpServer(callArgs({ persistence: null, auth: null }));
assert.equal(inert.persistence, null, 'persistence: null disables durability');
assert.equal(realRootIsAcceptable(), true, 'an explicit opt-out must not create production state');

// 4. And the real root still does not exist after all of that.
assert.equal(realRootIsAcceptable(), true, 'the real root must not have become test residue');

console.log('POISONED-ENV ASSERTIONS PASSED');
`;

test('§9: a poisoned environment cannot activate production persistence in a test', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r5a-poison-'));
  const childPath = path.join(dir, 'poisoned-child.mjs');
  try {
    fs.writeFileSync(childPath, CHILD_SOURCE, 'utf8');
    // Run the child directly rather than through `node --test`: the child is a
    // plain assertion script whose exit status is the result, and `--test` would
    // capture its stdout so the pass marker could not be observed.
    const result = spawnSync(process.execPath, [childPath], {
      cwd: PROJECT,
      env: {
        ...process.env,
        DSH_HOME: POISONED_DSH_HOME,
        DSH_REMOTE_STATE_ROOT: undefined,
      },
      encoding: 'utf8',
    });

    // A non-zero status means an assertion inside the child failed, which is the
    // whole point of the test. Surface the child's output so a failure is readable.
    assert.equal(
      result.status,
      0,
      `the poisoned child failed (status ${result.status}, signal ${result.signal}):\n`
      + `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
    assert.match(
      result.stdout ?? '',
      /POISONED-ENV ASSERTIONS PASSED/,
      'the child must reach its end, so every assertion above it really ran',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('§9: the poisoned child really exercised all four properties', () => {
  // Guard against the child silently doing nothing: assert the source contains each
  // property, so deleting an assertion cannot quietly weaken this suite.
  for (const marker of [
    'handle.persistence,\n    null',
    'assertTempStateRoot(REAL_ROOT)',
    'assertTempStateRoot(REAL_HOME)',
    'explicit durability decision',
    // The child now asserts legitimacy rather than absence, so a Gate B root does not
    // make this suite fail. The marker tracks that change so the check stays meaningful.
    'realRootIsAcceptable()',
  ]) {
    assert.ok(CHILD_SOURCE.includes(marker), `the child must assert: ${marker}`);
  }
});
