import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryFixture } from './r8e-harness.mjs';
import { createTestDocument } from './r8b-dom.mjs';
import { mount } from '../../src/remote/ui/app.js';

test('hostile REST recovery content stays text in the real mounted component tree', async () => {
  const h = await recoveryFixture();
  let app;
  try {
    const hostile = '<script>globalThis.pwned=true</script><img onerror=alert(1)>javascript:alert(1)';
    h.f.history[0].content = hostile;
    const doc = createTestDocument();
    const root = doc.createElement('div');
    app = await mount({ mode: 'real', doc, root, realController: h.owner });
    await h.recovery.reload();
    assert.ok(root.textContent.includes(hostile));
    assert.equal(root.querySelectorAll('script').length, 0);
    assert.equal(root.querySelectorAll('img').length, 0);
    assert.equal(root.querySelectorAll('a').length, 0);
    assert.equal(root.textContent.includes('good-token'), false);
    assert.equal(root.textContent.includes('ticket='), false);
  } finally { app?.dispose(); await h.stop(); }
});

test('recovery fixture Reload remains zero-network', async () => {
  const savedFetch = globalThis.fetch;
  const savedWs = globalThis.WebSocket;
  const savedLocation = globalThis.location;
  let calls = 0;
  let app;
  try {
    globalThis.fetch = () => { calls++; throw new Error('unexpected request'); };
    globalThis.WebSocket = class { constructor() { calls++; throw new Error('unexpected socket'); } };
    globalThis.location = { hash: '#fixture=resync' };
    const doc = createTestDocument();
    const root = doc.createElement('div');
    app = mount({ mode: 'fixture', doc, root });
    root.querySelector('#resync-banner').querySelector('button').click();
    assert.equal(calls, 0);
    assert.equal(app.getState().resync, 'reloading');
  } finally {
    app?.dispose();
    globalThis.fetch = savedFetch;
    globalThis.WebSocket = savedWs;
    globalThis.location = savedLocation;
  }
});
