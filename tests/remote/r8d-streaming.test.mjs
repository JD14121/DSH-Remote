/**
 * R8D — assistant streaming: one message per attempt, de-duplication, interruption.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { StreamAssembler, resetStreamIdentityCounter } from '../../src/remote/ui/ws/stream-assembler.js';
import { EventClient, SOCKET_STATE } from '../../src/remote/ui/ws/event-client.js';
import { resolveChunkText } from '../../src/remote/ui/ws/event-normalizer.js';
import { eventFrame, helloFrame, replayCompleteFrame, startWsFixture, waitFor } from './r8d-harness.mjs';

/** Build a normalized event the way the normalizer would. */
function normalized(input) {
  return {
    type: 'event',
    event: input.event,
    sequence: input.sequence ?? null,
    sessionId: input.sessionId ?? 's-1',
    data: input.data ?? {},
  };
}

test('start + two chunks + end produce exactly ONE message', () => {
  resetStreamIdentityCounter();
  const assembler = new StreamAssembler();
  const attempt = { attempt_id: 'att-1' };

  const started = assembler.start(normalized({ event: 'assistant.start', data: attempt }));
  assert.ok(started !== null);
  assert.equal(started.streaming, true);

  assembler.delta(normalized({ event: 'assistant.delta', data: { ...attempt, index: 0, chunk: { text: 'Hello' } } }));
  assembler.delta(normalized({ event: 'assistant.delta', data: { ...attempt, index: 1, chunk: { text: ' world' } } }));

  assert.equal(started.content, 'Hello world', 'both chunks must land in the SAME message');
  assert.equal(assembler.active().length, 1, 'one chunk must never become one message');

  const ended = assembler.end(normalized({ event: 'assistant.end', data: { ...attempt, outcome: { kind: 'ok' } } }));
  assert.equal(ended.id, started.id, 'the end must finalize the same message');
  assert.equal(ended.streaming, false);
  assert.equal(ended.content, 'Hello world');
  assert.equal(assembler.active().length, 0);
});

test('a replayed chunk does not duplicate the output', () => {
  resetStreamIdentityCounter();
  const assembler = new StreamAssembler();
  const attempt = { attempt_id: 'att-replay' };

  assembler.start(normalized({ event: 'assistant.start', data: attempt }));
  assembler.delta(normalized({ event: 'assistant.delta', data: { ...attempt, index: 0, chunk: { text: 'A' } } }));
  // The socket drops and the replay re-sends chunk 0.
  assembler.delta(normalized({ event: 'assistant.delta', data: { ...attempt, index: 0, chunk: { text: 'A' } } }));
  assembler.delta(normalized({ event: 'assistant.delta', data: { ...attempt, index: 1, chunk: { text: 'B' } } }));
  const ended = assembler.end(normalized({ event: 'assistant.end', data: attempt }));

  assert.equal(ended.content, 'AB', 'a replayed chunk must not duplicate');
  assert.notEqual(ended.content, 'AAB');
});

test('a stream without a server attempt_id still assembles into one message', () => {
  resetStreamIdentityCounter();
  const assembler = new StreamAssembler();

  const started = assembler.start(normalized({ event: 'assistant.start', data: {} }));
  assembler.delta(normalized({ event: 'assistant.delta', data: { index: 0, chunk: { text: 'x' } } }));
  assembler.delta(normalized({ event: 'assistant.delta', data: { index: 1, chunk: { text: 'y' } } }));
  const ended = assembler.end(normalized({ event: 'assistant.end', data: {} }));

  assert.equal(ended.id, started.id, 'the fallback identity must be stable across the attempt');
  assert.equal(ended.content, 'xy');
  assert.equal(assembler.active().length, 0);
});

test('a later attempt gets a new identity rather than reusing a finished one', () => {
  resetStreamIdentityCounter();
  const assembler = new StreamAssembler();

  const first = assembler.start(normalized({ event: 'assistant.start', data: {} }));
  assembler.end(normalized({ event: 'assistant.end', data: {} }));
  const second = assembler.start(normalized({ event: 'assistant.start', data: {} }));

  assert.notEqual(second.id, first.id, 'a new attempt is a new stream');
});

test('a delta before its start still creates the message rather than dropping text', () => {
  resetStreamIdentityCounter();
  const assembler = new StreamAssembler();
  const attempt = { attempt_id: 'att-mid' };
  // The replay began mid-stream, so no start was seen.
  const message = assembler.delta(normalized({ event: 'assistant.delta', data: { ...attempt, index: 0, chunk: { text: 'mid' } } }));
  assert.ok(message !== null);
  assert.equal(message.content, 'mid');
});

test('an unreadable opaque chunk contributes no text and never throws', () => {
  resetStreamIdentityCounter();
  const assembler = new StreamAssembler();
  const attempt = { attempt_id: 'att-opaque' };
  assembler.start(normalized({ event: 'assistant.start', data: attempt }));

  // Shapes the normalizer deliberately does not claim to understand.
  for (const chunk of [null, 42, { unknown_field: 'x' }, { nesting: { deep: { text: 'nope' } } }]) {
    assert.doesNotThrow(() => assembler.delta(normalized({ event: 'assistant.delta', data: { ...attempt, index: Math.random(), chunk } })));
  }
  const ended = assembler.end(normalized({ event: 'assistant.end', data: attempt }));
  assert.equal(ended.content, '', 'an unreadable chunk must not be guessed at');
  assert.ok(ended.opaqueChunks > 0, 'it should be counted, not silently ignored');
});

test('the chunk resolver accepts the documented shapes and rejects the rest', () => {
  // String, and the flat text-bearing fields.
  assert.deepEqual(resolveChunkText('hello'), { text: 'hello', recognised: true });
  assert.deepEqual(resolveChunkText({ text: 'a' }), { text: 'a', recognised: true });
  assert.deepEqual(resolveChunkText({ delta: 'b' }), { text: 'b', recognised: true });
  assert.deepEqual(resolveChunkText({ content: 'c' }), { text: 'c', recognised: true });
  // A content-block array — one of the two shapes the R1 fixtures actually contain.
  assert.deepEqual(resolveChunkText([{ text: 'x' }, { text: 'y' }]), { text: 'xy', recognised: true });
  assert.deepEqual(resolveChunkText({ content: [{ text: 'z' }] }), { text: 'z', recognised: true });
  assert.deepEqual(resolveChunkText({ type: 'text', text: 'q' }), { text: 'q', recognised: true });

  // Everything else is unrecognised, with no text invented.
  for (const chunk of [null, undefined, 7, true, {}, { foo: 'bar' }, { text: 5 }]) {
    assert.equal(resolveChunkText(chunk).recognised, false, `${JSON.stringify(chunk)} should be unrecognised`);
    assert.equal(resolveChunkText(chunk).text, '');
  }
});

test('a mid-stream disconnect preserves the partial text and invents nothing', async () => {
  const fixture = await startWsFixture();
  try {
    const streamEvents = [];
    const client = new EventClient({
      sessionId: 's-1', baseUrl: fixture.baseUrl, credential: 'good-token', fetchImpl: fixture.fetchImpl,
      onEvent: (event) => { if (String(event.type).startsWith('stream')) streamEvents.push(event); },
    });

    const attempt = { attempt_id: 'att-cut' };
    fixture.onConnection = (connection) => {
      connection.send(helloFrame({ sessionId: 's-1' }));
      connection.send(eventFrame({ sessionId: 's-1', sequence: 1, event: 'assistant.start', data: attempt }));
      connection.send(eventFrame({ sessionId: 's-1', sequence: 2, event: 'assistant.delta', data: { ...attempt, index: 0, chunk: { text: 'partial text' } } }));
      connection.send(replayCompleteFrame({ sequence: 2 }));
    };
    await client.connect();
    await waitFor(() => client.socketState === SOCKET_STATE.LIVE);
    await waitFor(() => client.streams.active().length === 1);
    assert.equal(client.streams.active()[0].content, 'partial text');

    // The socket dies mid-stream.
    fixture.closeLatest(1006);
    await waitFor(() => client.socketState === SOCKET_STATE.DISCONNECTED);

    const interrupted = streamEvents.find((e) => e.type === 'stream-interrupted');
    assert.ok(interrupted !== undefined, 'the interruption should be reported');
    const message = interrupted.messages[0];

    assert.equal(message.content, 'partial text', 'the partial text must survive');
    assert.equal(message.streaming, false, 'the cursor stops');
    assert.equal(message.interrupted, true, 'but it is NOT marked completed');
    assert.equal(message.outcome, undefined, 'no end event may be invented');
    // No end event was fabricated.
    assert.equal(streamEvents.some((e) => e.type === 'stream-end'), false);
    client.close();
  } finally {
    await fixture.stop();
  }
});

test('streaming never advances the Gateway sequence on its own', async () => {
  const fixture = await startWsFixture();
  try {
    const client = new EventClient({
      sessionId: 's-1', baseUrl: fixture.baseUrl, credential: 'good-token', fetchImpl: fixture.fetchImpl,
      lastSequence: 10,
    });
    const attempt = { attempt_id: 'att-seq' };
    fixture.onConnection = (connection) => {
      connection.send(helloFrame({ sessionId: 's-1' }));
      connection.send(replayCompleteFrame({ sequence: 10 }));
      // Deltas carry `sequence: null`: presentation frames with no durable sequence.
      connection.send(eventFrame({ sessionId: 's-1', sequence: null, event: 'assistant.start', data: attempt }));
      connection.send(eventFrame({ sessionId: 's-1', sequence: null, event: 'assistant.delta', data: { ...attempt, index: 0, chunk: { text: 'x' } } }));
    };
    await client.connect();
    await waitFor(() => client.streams.active().length === 1);

    assert.equal(client.lastAppliedSequence, 10, 'an unsequenced delta must not move the watermark');
    client.close();
  } finally {
    await fixture.stop();
  }
});
