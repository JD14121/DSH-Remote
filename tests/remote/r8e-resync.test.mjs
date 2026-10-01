import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryFixture, deferred } from './r8e-harness.mjs';
import { waitFor } from './r8d-harness.mjs';
import { createTestDocument } from './r8b-dom.mjs';
import { mount } from '../../src/remote/ui/app.js';

test('mounted Reload action keeps transcript and composer visible through REST and handshake', async () => {
  const h = await recoveryFixture();
  let app;
  try {
    const doc = createTestDocument();
    const root = doc.createElement('div');
    app = await mount({ doc, root, mode: 'real', realController: h.owner });
    h.recovery.requireResync({ reason: 'gap' });
    h.f.hold = deferred();
    root.querySelector('#resync-banner').querySelector('button').click();
    await waitFor(() => h.owner.state.resync === 'loading');
    assert.match(root.textContent, /old partial/);
    assert.equal(root.querySelector('textarea').value, 'unsent draft');
    assert.equal(root.querySelector('#resync-banner').querySelector('button').disabled, true);
    h.f.hold.resolve();
    await h.recovery.pending;
    assert.match(root.textContent, /server final/);
    assert.equal(root.querySelector('textarea').value, 'unsent draft');
    assert.match(root.textContent, /Reconnected/);
  } finally { app?.dispose(); await h.stop(); }
});

test('reload validates all history before replacement and bounds repeated pagination cursors', async () => {
  const h = await recoveryFixture();
  try {
    h.f.page = { has_more: true, next_before_seq: 900, through_seq: 900 };
    assert.equal(await h.recovery.reload(), false);
    assert.equal(h.owner.state.messages[0].id, 'partial');
    assert.equal(h.f.ticketsIssued, 0);
    assert.equal(h.f.requests.filter(r => r.path.endsWith('/messages')).length, 2);
  } finally { await h.stop(); }
});

test('malformed successful history cannot erase the visible transcript', async () => {
  const h = await recoveryFixture();
  try {
    h.client.fetchImpl = async url => ({ ok: true, status: 200, json: async () => url.endsWith('/messages')
      ? { api_version: 1, unexpected: [] }
      : { api_version: 1, data: { id: 's', status: 'completed', last_sequence: 40 } } });
    assert.equal(await h.recovery.reload(), false);
    assert.equal(h.owner.state.messages[0].id, 'partial');
  } finally { await h.stop(); }
});

test('a changing REST boundary fails closed rather than replaying against mismatched history', async () => {
  const h = await recoveryFixture();
  try {
    const original = h.client.getMessages.bind(h.client);
    h.client.getMessages = async (...args) => {
      const page = await original(...args);
      h.f.seed++;
      return page;
    };
    assert.equal(await h.recovery.reload(), false);
    assert.equal(h.owner.state.messages[0].id, 'partial');
    assert.equal(h.f.ticketsIssued, 0);
  } finally { await h.stop(); }
});

test('all history pages commit once in server order using source cursors only for pagination', async () => {
  const h = await recoveryFixture();
  try {
    const requests = [];
    h.client.fetchImpl = async url => {
      requests.push(url);
      const older = url.includes('before_seq=900');
      return { ok: true, status: 200, json: async () => url.includes('/messages')
        ? { api_version: 1, data: [{ id: older ? 'older' : 'newest', session_id: 's', role: 'user', content: older ? 'old' : 'new', source_sequence: older ? 899 : 900 }],
          page: { has_more: !older, through_seq: 900, next_before_seq: older ? 899 : 900 } }
        : { api_version: 1, data: { id: 's', status: 'completed', last_sequence: 40 } } };
    };
    const replacements = [];
    h.owner.onChange = state => { if (state.messages !== replacements.at(-1)) replacements.push(state.messages); };
    assert.equal(await h.recovery.reload(), true);
    assert.deepEqual(h.owner.state.messages.map(m => m.id), ['older', 'newest']);
    assert.equal(replacements.length, 2, 'only old and complete new timelines are observable');
    assert.ok(requests.some(url => url.includes('before_seq=900') && url.includes('through_seq=900')));
    assert.equal(h.f.connections[0].lastSequence, 40);
  } finally { await h.stop(); }
});

test('resync preserves scrolled-up position and composer focus through replacement', async () => {
  const h = await recoveryFixture();
  let app;
  try {
    const doc = createTestDocument();
    const root = doc.createElement('div');
    app = await mount({ mode: 'real', doc, root, realController: h.owner });
    const timeline = root.querySelector('.timeline');
    timeline.scrollTop = 123;
    timeline.scrollHeight = 1000;
    timeline.clientHeight = 300;
    root.querySelector('textarea').focus();
    await h.recovery.reload();
    assert.equal(root.querySelector('.timeline').scrollTop, 123);
    assert.equal(doc.activeElement, root.querySelector('textarea'));
  } finally { app?.dispose(); await h.stop(); }
});

test('mobile session navigation remains usable after a missing-session reload', async () => {
  const h = await recoveryFixture();
  let app;
  try {
    const doc = createTestDocument();
    const root = doc.createElement('div');
    app = await mount({ mode: 'real', doc, root, realController: h.owner });
    h.f.restStatus = 404;
    await h.recovery.reload();
    const menu = [...root.walk()].find(el => el.tagName === 'BUTTON' && el.getAttribute?.('aria-label') === 'Sessions');
    menu.click();
    assert.equal(h.owner.state.drawerOpen, true);
  } finally { app?.dispose(); await h.stop(); }
});
