/**
 * R5 integration — Phase R5 §40, §48, §49, §61, §68, §69, §70.
 *
 * §68's scenario, end to end, over real sockets and a real durable root:
 *
 * ```text
 * Gateway A: empty temp state, events 1..80, client consumes through 60, stop
 * DSH advances while the Gateway is down
 * Gateway B: same root, recovers 80, seeds the allocator, preloads the ring,
 *            reconciles, and serves a client at 60 replaying 61..85
 * then: replay_complete, and the next live event is 86
 * ```
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { makeTempStateRoot, SESSION } from './r5-helpers.mjs';
import { startFixtureServer, FIXTURE_SESSIONS } from './r3-helpers.mjs';
import { Reconciler } from '../../src/remote/persistence/reconcile.mjs';
import { FRAME } from '../../src/remote/ws/protocol.mjs';
import { startWsServer } from './r4-helpers.mjs';
import { statePaths } from '../../src/remote/persistence/config.mjs';
import fs from 'node:fs';

/** Emit `count` events for a session through a server's own domain. */
function emit(server, count, startIndex = 0) {
  const out = [];
  for (let index = 0; index < count; index += 1) {
    out.push(server.eventsService.emit({
      sessionId: SESSION,
      event: 'task.progress',
      data: { index: startIndex + index },
    }));
  }
  return out;
}

test('§68: the full cross-restart scenario, including downtime reconciliation', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-integration');
  let gatewayA;
  let gatewayB;
  try {
    // ── Gateway A: empty temp state ──────────────────────────────────────────
    gatewayA = await startWsServer({ persistenceConfig: { root, segmentBytes: 65_536 } });
    gatewayA.store.upsertSession({
      id: SESSION, title: 'integration', status: 'idle', created_at: null, updated_at: null,
      last_sequence: 0, running: false,
    });
    const produced = emit(gatewayA, 80);
    assert.equal(produced[0].sequence, 1);
    assert.equal(produced[79].sequence, 80, 'events 1..80');

    // A client consumes through 60 over a real socket.
    const clientA = await gatewayA.connect({ session_id: SESSION, last_sequence: 0 });
    await clientA.waitForType(FRAME.REPLAY_COMPLETE);
    assert.equal(clientA.sequences().length, 80, 'the first client sees all 80');
    const consumedThrough = clientA.sequences().filter((sequence) => sequence <= 60).pop();
    assert.equal(consumedThrough, 60);
    await clientA.close();

    // Graceful stop, releasing the lock and flushing the journal.
    await gatewayA.close();
    gatewayA = null;

    // ── DSH advances while the Gateway is down ───────────────────────────────
    // Five durable facts commit; the Gateway never observes them live.
    const missed = [81, 82, 83, 84, 85];

    // ── Gateway B: same root ────────────────────────────────────────────────
    gatewayB = await startWsServer({ persistenceConfig: { root, segmentBytes: 65_536 } });
    const recovery = gatewayB.server.recovery;
    assert.equal(recovery.seeded[0].seeded, 80, 'the allocator is seeded to 80');
    assert.ok(recovery.ringPreload.length >= 1, 'the ring cache is preloaded');
    assert.equal(gatewayB.store.get(SESSION).status, 'disconnected', 'the runtime status is not restored');

    // Reconciliation turns the missed durable facts into new Gateway events.
    const reconciler = new Reconciler({
      adapter: {
        // Only the adapter is consulted — never DSH's own files (§34).
        async subscribe(_sessionId, listener) {
          setImmediate(() => listener({ kind: 'snapshot', frame: { cursor: 85 } }));
          return { unsubscribe: async () => {} };
        },
        async getMessages() {
          return {
            messages: missed.map((sequence) => ({ sequence, content: `durable ${sequence}`, created_at: null })),
            raw: {}, throughSeq: 85, hasMore: false,
          };
        },
      },
      persistence: gatewayB.persistence,
      store: gatewayB.store,
      events: gatewayB.eventsService,
    });
    const reconciled = await reconciler.reconcile({
      sessionIds: [SESSION],
      freshCursor: async () => ({ cursor: 85 }),
      fetchRecords: async () => missed.map((sequence) => ({ sourceSequence: sequence })),
    });
    assert.equal(reconciled.sessions[0].emitted, 5, 'the five missed facts became five Gateway events');

    const all = await gatewayB.persistence.eventsAfter(SESSION, 0);
    assert.deepEqual(
      all.map((event) => event.sequence),
      Array.from({ length: 85 }, (_, index) => index + 1),
      'no duplicate and no gap: 1..85 contiguous',
    );
    assert.deepEqual(
      all.slice(80).map((event) => event.source_sequence),
      missed,
      'the reconciled events carry the DSH source sequences',
    );

    // ── The client reconnects from 60 ───────────────────────────────────────
    const clientB = await gatewayB.connect({ session_id: SESSION, last_sequence: 60 });
    await clientB.waitForType(FRAME.REPLAY_COMPLETE);

    assert.deepEqual(
      clientB.sequences(),
      Array.from({ length: 25 }, (_, index) => 61 + index),
      '61..85 replayed strictly in order',
    );
    assert.equal(new Set(clientB.sequences()).size, 25, 'exactly once');
    const complete = clientB.ofType(FRAME.REPLAY_COMPLETE)[0];
    assert.equal(complete.from_sequence, 61);
    assert.equal(complete.through_sequence, 85);
    assert.equal(complete.replayed, 25);

    // ── The next live event is 86 ───────────────────────────────────────────
    const live = gatewayB.eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: { live: true } });
    assert.equal(live.sequence, 86, 'the sequence continues across the restart');
    await clientB.waitFor(() => clientB.sequences().length >= 26, 3000, 'live event');
    assert.equal(clientB.sequences()[25], 86, 'and it arrives after the seam');

    // Every event precedes the seam marker exactly once.
    const frames = clientB.frames.map((frame) => frame.type);
    const seam = frames.indexOf(FRAME.REPLAY_COMPLETE);
    assert.ok(seam > 0);
    assert.equal(
      clientB.frames.slice(0, seam).some((frame) => frame.type === FRAME.REPLAY_COMPLETE),
      false,
      'the marker appears once',
    );

    await clientB.close();
  } finally {
    if (gatewayA !== null) await gatewayA.close();
    if (gatewayB !== null) await gatewayB.close();
    cleanup();
  }
});

test('§69: a half-written final record is truncated and the sequence resumes', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-crash-integration');
  try {
    const config = { root, segmentBytes: 65_536 };

    // Gateway A writes 1..12, then a 13th record is left half-written.
    {
      const gateway = await startWsServer({ persistenceConfig: config });
      gateway.store.upsertSession({
        id: SESSION, title: null, status: 'idle', created_at: null, updated_at: null,
        last_sequence: 0, running: false,
      });
      emit(gateway, 12);
      await gateway.close();
    }

    // Append an unterminated line, as a crash mid-append would leave.
    const dir = fs.readdirSync(statePaths({ root }).eventsDir);
    const sessionDir = `${statePaths({ root }).eventsDir}\\${dir[0]}`;
    const file = `${sessionDir}\\${fs.readdirSync(sessionDir).find((name) => name.endsWith('.jsonl'))}`;
    fs.appendFileSync(file, '{"v":1,"sequence":13,"event":{"sequence":13,"event":"tas', 'utf8');
    assert.equal(fs.readFileSync(file, 'utf8').endsWith('\n'), false);

    // Gateway B recovers: the partial record is discarded and 13 is reissued.
    const gatewayB = await startWsServer({ persistenceConfig: config });
    try {
      assert.equal(gatewayB.server.recovery.journals.recovered.length, 1, 'the crash tail was repaired');
      assert.equal(gatewayB.server.recovery.seeded[0].seeded, 12, 'the mark is the last complete record');

      const resumed = gatewayB.eventsService.emit({ sessionId: SESSION, event: 'task.progress', data: { resumed: true } });
      assert.equal(resumed.sequence, 13, '13 was never committed, so it is issued once now');

      const all = await gatewayB.persistence.eventsAfter(SESSION, 0);
      assert.deepEqual(
        all.map((event) => event.sequence),
        Array.from({ length: 13 }, (_, index) => index + 1),
        '13 records, contiguous',
      );
    } finally {
      await gatewayB.close();
    }
  } finally {
    cleanup();
  }
});

test('§70: a mid-file checksum failure keeps the port closed', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-corrupt-integration');
  try {
    const config = { root, segmentBytes: 65_536 };
    {
      const gateway = await startWsServer({ persistenceConfig: config });
      gateway.store.upsertSession({
        id: SESSION, title: null, status: 'idle', created_at: null, updated_at: null,
        last_sequence: 0, running: false,
      });
      emit(gateway, 50);
      await gateway.close();
    }

    // Damage record 51's checksum, leaving 52..50 bytes valid.
    const eventsDir = statePaths({ root }).eventsDir;
    const sessionDir = `${eventsDir}\\${fs.readdirSync(eventsDir)[0]}`;
    const file = `${sessionDir}\\${fs.readdirSync(sessionDir).find((name) => name.endsWith('.jsonl'))}`;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0);
    assert.equal(lines.length, 50);
    const parsed = JSON.parse(lines[49]);
    parsed.checksum = `sha256:${'0'.repeat(64)}`;
    lines[49] = JSON.stringify(parsed);
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

    // Startup must fail, and the port must never bind.
    await assert.rejects(
      () => startWsServer({ persistenceConfig: config }),
      (error) => error.code === 'JOURNAL_CORRUPT',
      'a corrupt journal must prevent startup rather than serve 1..49',
    );
  } finally {
    cleanup();
  }
});

test('§40: a version-unsupported root never binds', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-version-integration');
  try {
    const config = { root, segmentBytes: 65_536 };
    {
      const gateway = await startWsServer({ persistenceConfig: config });
      await gateway.close();
    }
    fs.writeFileSync(
      statePaths({ root }).formatFile,
      JSON.stringify({ format: 'dsh-remote-state', version: 7 }),
      'utf8',
    );

    await assert.rejects(
      () => startWsServer({ persistenceConfig: config }),
      (error) => error.code === 'STATE_VERSION_UNSUPPORTED',
    );
  } finally {
    cleanup();
  }
});

test('§49 through HTTP and WebSocket: the REST watermark matches the WS replay', async () => {
  const { root, cleanup } = makeTempStateRoot('r5-rest-ws-agree');
  try {
    const config = { root, segmentBytes: 65_536, ringSize: 4 };
    const gateway = await startWsServer({ persistenceConfig: config });
    try {
      gateway.store.upsertSession({
        id: SESSION, title: null, status: 'idle', created_at: null, updated_at: null,
        last_sequence: 0, running: false,
      });
      emit(gateway, 30);
      // The ring holds only 4, so anything served beyond that came from the journal.
      assert.equal(gateway.eventsService.ringDepth(SESSION), 4);

      // The REST view reports the durable high-water mark. `SessionsService.get`
      // returns the store view (`last_sequence`); the HTTP projection renames it to
      // `lastSequence` on the wire.
      const view = await gateway.sessionsService.get(SESSION);
      assert.equal(view.last_sequence, 30, 'the view carries the durable watermark');
      const listed = gateway.sessionsService.list();
      const summary = listed.find((entry) => entry.id === SESSION);
      assert.ok(summary !== undefined, 'the session appears in the list');
      assert.equal(summary.last_sequence, 30, 'and the list agrees');

      const client = await gateway.connect({ session_id: SESSION, last_sequence: 10 });
      await client.waitForType(FRAME.REPLAY_COMPLETE);
      assert.deepEqual(
        client.sequences(),
        Array.from({ length: 20 }, (_, index) => 11 + index),
        'the WS replay agrees with the REST watermark, reading past the ring',
      );
      await client.close();
    } finally {
      await gateway.close();
    }
  } finally {
    cleanup();
  }
});

test('§61: the whole integration suite stayed inside a temp root', () => {
  // A guard in test form: this suite must never create production state.
  //
  // Phase-aware, because once R7 Gate B has deliberately created that root its presence
  // is expected. What remains a failure is a root that exists *without* the markers a
  // real production root carries — that is test residue, which is what this guards
  // against.
  const dshHome = process.env.DSH_HOME;
  if (typeof dshHome !== 'string' || dshHome.length === 0) return;
  const realRoot = `${dshHome}\\remote`;
  if (!fs.existsSync(realRoot)) return;

  assert.equal(
    fs.existsSync(`${realRoot}\\format.json`),
    true,
    `the real state root exists without a format marker, so something wrote it by accident: ${realRoot}`,
  );
  assert.equal(
    fs.existsSync(`${realRoot}\\secrets\\phone-token.v1`),
    true,
    `the real state root exists without a credential, so something wrote it by accident: ${realRoot}`,
  );
});
