/**
 * UI-P1-F9 — empty / structural message surface regression.
 *
 * Invariant: a message may create a visible transcript row ONLY if it has something user-visible to
 * render. Measured before the fix on one real session page: 222 of 250 rows were empty 30px bubbles.
 *
 * These cases assert the RENDERER contract, and they also assert that the same messages are still
 * present in the DATA — suppression is presentation-only.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { renderMessage, renderMessageTimeline } from '../../src/remote/ui/components/message.js';
import { normalizeMessage } from '../../src/remote/ui/api/normalizers.js';
import { createTestDocument } from './r8b-dom.mjs';

const doc = () => createTestDocument();

const assistantRaw = (blocks, id = 'm') => ({
  id, session_id: 's', role: 'assistant', type: 'message',
  content: { role: 'assistant', content: blocks, source: { kind: 'model', provider: 'p', model: 'm' }, id: 'in' },
  created_at: '2026-01-01T00:00:00.000Z', source_sequence: 1,
});
const text = (t) => ({ type: 'text', text: t });
const reasoning = (t) => ({ type: 'reasoning', text: t });
const toolCall = () => ({ type: 'tool-call', id: 'tc', name: 'read_file', arguments: '{"secret":"ARGS"}' });

/** render a normalized message and report whether a row was produced */
const row = (msg, options = {}) => renderMessage(msg, { doc: doc(), ...options });

/* ----------------------------------------------------------- section 5 / 13: assistant messages */

test('F9/1 assistant WITH displayable text still renders', () => {
  const el = row(normalizeMessage(assistantRaw([text('Visible prose.')])));
  assert.ok(el, 'row produced');
  assert.equal(el.querySelector('.message__body').textContent, 'Visible prose.');
});

test('F9/2 assistant with reasoning ONLY produces no visible row', () => {
  assert.equal(row(normalizeMessage(assistantRaw([reasoning('internal thinking')]))), null);
});

test('F9/3 assistant with tool-call ONLY produces no visible row', () => {
  assert.equal(row(normalizeMessage(assistantRaw([toolCall()]))), null);
});

test('F9/4 assistant with an unknown structural block only produces no visible row', () => {
  assert.equal(row(normalizeMessage(assistantRaw([{ type: 'weird', payload: 'X' }]))), null);
});

test('F9/5 reasoning-only assistant never exposes the reasoning text', () => {
  const el = row(normalizeMessage(assistantRaw([reasoning('SUPERSECRET-REASONING')])));
  assert.equal(el, null, 'no row at all is even better than a row without the text');
});

/* --------------------------------------------------------------- section 6: tool messages */

test('F9/6 a tool structural message produces no visible row and leaks nothing', () => {
  const tool = normalizeMessage({ id: 't', role: 'tool', type: 'tool_result', content: { name: 'read_file', arguments: '{"token":"SUPERSECRET"}', ok: true, message: { nested: 1 } } });
  assert.equal(tool.content, '');
  assert.equal(row(tool), null);
});

/* ------------------------------------------------------------- section 7: system messages */

test('F9/7 a STRUCTURAL system message produces no visible row', () => {
  const sys = normalizeMessage({ id: 's1', role: 'system', type: 'unknown', content: { kind: 'event', eventType: 'tick', data: { nested: 2 } } });
  assert.equal(sys.content, '');
  assert.equal(row(sys), null);
});

test('F9/8 an INTENTIONAL visible system notice is preserved', () => {
  const sys = normalizeMessage({ id: 's2', role: 'system', type: 'message', content: 'Session archived.' });
  assert.equal(sys.content, 'Session archived.');
  const el = row(sys);
  assert.ok(el, 'intentional notice must still render');
  assert.equal(el.querySelector('.message__body').textContent, 'Session archived.');
});

test('long user prompts collapse to a closed Prompt disclosure', () => {
  const prompt = 'x'.repeat(1400);
  const el = row({ id: 'long-user', role: 'user', content: prompt });
  const details = el.querySelector('details');
  assert.ok(details, 'long prompt has a disclosure');
  assert.equal(details.hasAttribute('open'), false, 'prompt starts collapsed');
  assert.equal(details.querySelector('summary').textContent, 'Prompt');
  assert.equal(details.querySelector('.message__body').textContent, prompt);
});

/* --------------------------------------------------- section 8: user messages with null content */

test('F9/9 a user message with null content produces no visible row and fabricates nothing', () => {
  const user = normalizeMessage({ id: 'u', role: 'user', type: 'message', content: null });
  assert.equal(user.content, '');
  const el = row(user);
  assert.equal(el, null);
});

test('F9/10 a user message WITH text still renders (no over-suppression)', () => {
  const el = row(normalizeMessage({ id: 'u2', role: 'user', type: 'message', content: 'my question' }));
  assert.ok(el);
  assert.equal(el.querySelector('.message__body').textContent, 'my question');
});

/* -------------------------------------------------- intentional state markers must survive */

test('F9/11 the streaming caret keeps an otherwise-empty streaming row visible', () => {
  const el = row({ id: 'st', role: 'assistant', kind: 'streaming', content: '' }, { streamingActive: true, streamingText: '' });
  assert.ok(el, 'an empty streaming message still needs its caret');
  assert.ok(el.querySelector('.stream-cursor'));
});

test('F9/12 a cancelled marker still renders', () => {
  const el = row({ id: 'c', role: 'assistant', kind: 'cancelled', content: '' });
  assert.ok(el);
});

test('F9/13 an error message still renders', () => {
  const el = row({ id: 'e', role: 'error', content: 'Message not sent.' });
  assert.ok(el);
});

/* ------------------------------------------------------------ timeline assembly + data purity */

test('F9/14 the timeline omits empty rows but keeps every message in the data', () => {
  const messages = [
    normalizeMessage(assistantRaw([text('first')], 'a1')),
    normalizeMessage(assistantRaw([toolCall()], 'a2')),
    normalizeMessage({ id: 't1', role: 'tool', content: { name: 'n', arguments: '{}' } }),
    normalizeMessage(assistantRaw([reasoning('think')], 'a3')),
    normalizeMessage(assistantRaw([text('last')], 'a4')),
  ];
  const timeline = renderMessageTimeline(messages, { doc: doc() });
  const rows = timeline.querySelectorAll('.message');

  assert.equal(rows.length, 2, 'only the two text-bearing messages create rows');
  assert.equal(rows[0].querySelector('.message__body').textContent, 'first');
  assert.equal(rows[1].querySelector('.message__body').textContent, 'last');

  // suppression is PRESENTATION only -- the data list is untouched
  assert.equal(messages.length, 5);
  assert.deepEqual(messages.map((m) => m.id), ['a1', 'a2', 't1', 'a3', 'a4']);
});

test('F9/15 no empty .message__body survives into the transcript', () => {
  const messages = [
    normalizeMessage(assistantRaw([toolCall()], 'x1')),
    normalizeMessage({ id: 'x2', role: 'system', content: { kind: 'k', eventType: 'e', data: {} } }),
    normalizeMessage({ id: 'x3', role: 'user', content: null }),
    normalizeMessage(assistantRaw([text('only me')], 'x4')),
  ];
  const timeline = renderMessageTimeline(messages, { doc: doc() });
  const bodies = Array.from(timeline.querySelectorAll('.message__body'));
  assert.equal(bodies.length, 1);
  for (const b of bodies) assert.ok(b.textContent.trim().length > 0, 'no empty body may remain');
});

test('F9/16 no internal metadata is exposed as prose anywhere in the tree', () => {
  const messages = [
    normalizeMessage(assistantRaw([reasoning('SUPERSECRET-REASONING'), toolCall()], 'y1')),
    normalizeMessage({ id: 'y2', role: 'tool', content: { name: 'n', arguments: '{"token":"SUPERSECRET"}', ok: false, error: { code: 'SUPERSECRET' } } }),
    normalizeMessage({ id: 'y3', role: 'system', content: { kind: 'SUPERSECRET', eventType: 'SUPERSECRET', data: { a: 'SUPERSECRET' } } }),
  ];
  const timeline = renderMessageTimeline(messages, { doc: doc() });
  // NOTE: the test DOM stub does not implement innerHTML, so the whole subtree text is inspected.
  const allText = timeline.textContent + Array.from(timeline.querySelectorAll('*')).map((n) => n.textContent || '').join('');
  assert.ok(!allText.includes('SUPERSECRET'), 'no internal metadata may reach the DOM');
  assert.ok(!allText.includes('[object Object]'));
  assert.equal(timeline.querySelectorAll('.message').length, 0, 'no rows for nothing visible');
});
