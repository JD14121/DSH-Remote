/**
 * UI-P0-F8 — message content normalization regression.
 *
 * Guards the P0 where real DSH messages normalized to an EMPTY string and the whole transcript
 * rendered as empty bubbles. The fixture data below uses the REAL structured payload shape audited
 * from the live Gateway, so this cannot regress while node-count assertions stay green.
 *
 * Audited contract (evidence/live-message-content-contract.json):
 *   assistant.content : { role, content: ARRAY, source, id }   blocks: text | reasoning | tool-call
 *   tool.content      : { name, arguments, ok, message }       no prose
 *   system.content    : { kind, eventType, data }              no prose
 *   user.content      : null
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeMessage } from '../../src/remote/ui/api/normalizers.js';
import { renderMessage } from '../../src/remote/ui/components/message.js';
import { createTestDocument } from './r8b-dom.mjs';

/** A real assistant message, exactly as the Gateway sends it. */
const assistantRaw = (blocks, id = 'm-1') => ({
  id,
  session_id: 's-1',
  role: 'assistant',
  type: 'message',
  content: { role: 'assistant', content: blocks, source: { kind: 'model', provider: 'p', model: 'm' }, id: 'inner-1' },
  created_at: '2026-01-01T00:00:00.000Z',
  source_sequence: 7,
});
const text = (t) => ({ type: 'text', text: t });
const reasoning = (t) => ({ type: 'reasoning', text: t });
const toolCall = (args = '{"secret":"ARGS"}') => ({ type: 'tool-call', id: 'tc-1', name: 'read_file', arguments: args });

/* ------------------------------------------------------------------ section 7 compatibility cases */

test('F8/A plain string content is unchanged', () => {
  assert.equal(normalizeMessage({ id: 'a', role: 'assistant', content: 'plain text' }).content, 'plain text');
});

test('F8/B one structured text block is extracted', () => {
  assert.equal(normalizeMessage(assistantRaw([text('one block')])).content, 'one block');
});

test('F8/C multiple text blocks preserve order', () => {
  assert.equal(normalizeMessage(assistantRaw([text('first'), text('second')])).content, 'firstsecond');
});

test('F8/D text then tool-call keeps only the text', () => {
  assert.equal(normalizeMessage(assistantRaw([text('answer'), toolCall()])).content, 'answer');
});

test('F8/E tool-call then text keeps only the text', () => {
  assert.equal(normalizeMessage(assistantRaw([toolCall(), text('after')])).content, 'after');
});

test('F8/F an unknown block is ignored safely and the text survives', () => {
  assert.equal(normalizeMessage(assistantRaw([{ type: 'weird', payload: 'X' }, text('kept')])).content, 'kept');
});

test('F8/G an empty block array yields empty content', () => {
  assert.equal(normalizeMessage(assistantRaw([])).content, '');
});

test('F8/H null content yields empty content', () => {
  assert.equal(normalizeMessage({ id: 'h', role: 'assistant', content: null }).content, '');
});

test('F8/I the observed tool shape yields empty content', () => {
  const tool = { id: 't', role: 'tool', type: 'tool_result', content: { name: 'read_file', arguments: '{"secret":"ARGS"}', ok: true, message: { nested: 1 } } };
  assert.equal(normalizeMessage(tool).content, '');
});

test('F8/J the observed system shape yields empty content', () => {
  const sys = { id: 's', role: 'system', type: 'unknown', content: { kind: 'event', eventType: 'tick', data: { nested: 2 } } };
  assert.equal(normalizeMessage(sys).content, '');
});

test('F8/K reasoning blocks are NOT displayed as prose', () => {
  assert.equal(normalizeMessage(assistantRaw([reasoning('internal thinking'), text('public answer')])).content, 'public answer');
});

/* ------------------------------------------------------ section 8 privacy / correctness guards */

test('F8/L tool arguments never reach the transcript', () => {
  const out = normalizeMessage(assistantRaw([toolCall('{"token":"SUPERSECRET"}'), text('ok')])).content;
  assert.equal(out, 'ok');
  assert.ok(!out.includes('SUPERSECRET'));
});

test('F8/M reasoning text never reaches the transcript', () => {
  const out = normalizeMessage(assistantRaw([reasoning('SUPERSECRET-REASONING')])).content;
  assert.equal(out, '');
});

test('F8/N no shape can produce "[object Object]" or raw object serialization', () => {
  const shapes = [
    assistantRaw([text('fine')]),
    { id: 'x', role: 'assistant', content: { notAnArray: true, secret: 'S' } },
    { id: 'y', role: 'tool', content: { arguments: 'S', message: { a: 1 } } },
    { id: 'z', role: 'system', content: { data: { a: 1 } } },
    { id: 'w', role: 'assistant', content: { content: 'a string, not an array' } },
    { id: 'v', role: 'assistant', content: [{ type: 'tool-result', result: { a: 1 } }] },
  ];
  for (const raw of shapes) {
    const out = normalizeMessage(raw).content;
    assert.ok(!out.includes('[object Object]'), `leaked object serialization: ${out}`);
    assert.ok(!out.includes('notAnArray') && !out.includes('"secret"'), `leaked structured metadata: ${out}`);
  }
});

/* ------------------------------------------- section 14 structured fixture through the renderer */

test('F8/O a raw structured payload reaches the production renderer as visible text', () => {
  const doc = createTestDocument();
  const raw = assistantRaw([reasoning('thinking'), text('Visible assistant prose.'), toolCall()]);

  // raw -> normalizer -> production renderer, the full path the live app takes
  const normalized = normalizeMessage(raw);
  assert.equal(normalized.content, 'Visible assistant prose.');

  const el = renderMessage({ ...normalized, kind: 'normal' }, { doc });
  const body = el.querySelector('.message__body');

  assert.ok(body, 'renderer produced a message body');
  assert.equal(body.textContent, 'Visible assistant prose.');
  assert.ok(body.textContent.length > 0, 'body is NOT empty — this is the exact P0 symptom');
});
