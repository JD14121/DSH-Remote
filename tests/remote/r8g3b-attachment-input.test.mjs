/**
 * R8G.3B — attachment input wiring.
 *
 * The defect this closes: the composer's attach control was wired to `onUpload: () => {}` and the
 * application contained no `<input type="file">` at all. The Android harness's
 * `WebChromeClient.onShowFileChooser` was therefore unreachable — a WebView only raises it when the
 * page activates a real file input.
 *
 * These tests pin the wiring, the selection semantics, and the boundaries the phase must not cross.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createTestDocument } from './r8b-dom.mjs';
import { renderComposer } from '../../src/remote/ui/components/composer.js';
import { RealModeController } from '../../src/remote/ui/api/real-mode.js';
import { MAX_UPLOAD_BYTES } from '../../src/remote/ui/api/api-client.js';

const UI = path.join(process.cwd(), 'src', 'remote', 'ui');

/** A minimal File stand-in: only the members the contract allows anyone to read. */
function fakeFile(name, size, type = 'text/plain') {
  return { name, size, type };
}

/** Build a composer over a recording handler set. Extra handlers override individual recorders. */
function composerFor(extraState = {}, handlers = {}) {
  const doc = createTestDocument();
  const calls = { upload: [], selected: [], removed: [] };
  const region = renderComposer(
    { domain: 'idle', connection: 'connected', draft: '', queueDepth: 0, attachments: [], ...extraState },
    {
      doc,
      onUpload: (input) => { calls.upload.push(input); return true; },
      onFileSelected: (file) => calls.selected.push(file),
      onRemoveAttachment: (id) => calls.removed.push(id),
      ...handlers,
    },
  );
  return { doc, region, calls };
}

/** Build a composer whose `onUpload` records the call and answers `allow`. */
function composerAllowing(allow) {
  const doc = createTestDocument();
  const calls = { upload: [] };
  const region = renderComposer(
    { domain: 'idle', connection: 'connected', draft: '', queueDepth: 0, attachments: [] },
    {
      doc,
      onUpload: (input) => { calls.upload.push(input); return allow; },
      onFileSelected: () => {},
      onRemoveAttachment: () => {},
    },
  );
  return { doc, region, calls };
}

// ── §5 the input exists and is correctly hidden ──────────────────────────────

test('the composer renders a real hidden file input', () => {
  const { region } = composerFor();
  const input = region.querySelector('input[type=file]');

  assert.ok(input !== null, 'a real <input type="file"> must exist for the WebView to target');
  assert.equal(input.hidden, true, 'it must be hidden; the visible attach button is the control');
  assert.equal(input.getAttribute('aria-hidden'), 'true');
  assert.equal(input.tabIndex, -1, 'it must stay out of the tab order');
  assert.equal(input.multiple, false, 'one file per selection (§13)');
});

test('the file input is inside the document tree, not detached', () => {
  const { region } = composerFor();
  // A detached input cannot be activated by the WebView's chooser path.
  assert.ok(region.contains(region.querySelector('input[type=file]')), 'the input must be attached');
});

test('the visible attach button remains the accessible control', () => {
  const { region } = composerFor();
  const button = region.querySelector('.composer__attach');
  assert.ok(button !== null);
  assert.equal(button.tagName, 'BUTTON', 'the control is a real button, so it is keyboard activatable');
  assert.match(button.getAttribute('aria-label'), /attach/i);
  assert.equal(button.disabled, false);
});

// ── §6 the attach button opens the input in real mode ────────────────────────

test('activating attach activates the hidden file input', () => {
  const { region, calls } = composerAllowing(true);
  const input = region.querySelector('input[type=file]');

  // Record activation without invoking a native dialog. The stub DOM has no `HTMLInputElement.click`,
  // so the substitute is installed here and the button's handler calls it.
  let clicked = 0;
  input.click = () => { clicked += 1; };

  region.querySelector('.composer__attach').dispatch('click');
  assert.equal(clicked, 1, 'the attach button must activate the file input');
  assert.equal(calls.upload.length, 1, 'and must hand the input to the handler');
  assert.equal(calls.upload[0], input, 'the handler receives the very input the composer owns');
});

test('a handler that refuses activation does not open a chooser', () => {
  const { region } = composerAllowing(false);
  const input = region.querySelector('input[type=file]');
  let clicked = 0;
  input.click = () => { clicked += 1; };

  region.querySelector('.composer__attach').dispatch('click');
  assert.equal(clicked, 0, 'returning false must suppress activation (fixture mode relies on this)');
});

test('the hidden input is never activated unless the attach button is used', () => {
  const { region } = composerFor();
  const input = region.querySelector('input[type=file]');
  let clicked = 0;
  input.click = () => { clicked += 1; };
  // Rendering alone must not open a picker.
  assert.equal(clicked, 0);
});

// ── §14 selection is not upload ──────────────────────────────────────────────

test('a selected file becomes a local attachment and issues no request', () => {
  const calls = [];
  const controller = new RealModeController({
    client: {
      setCredential() {}, async health() { return { authenticated: true }; }, async listSessions() { return { sessions: [] }; },
      async getSession() { throw new Error('no request expected'); },
      async getMessages() { throw new Error('no request expected'); },
      async upload(...args) { calls.push(args); throw new Error('selection must not upload'); },
      credential: null,
    },
    credentials: { read: () => null, write() {}, clear() {} },
    onChange: () => {},
    live: null,
  });

  controller.addLocalAttachment(fakeFile('notes.txt', 128));
  const item = controller.state.attachments[0];

  assert.equal(item.name, 'notes.txt');
  assert.equal(item.size, 128);
  assert.equal(item.state, 'selected', 'selection records a local item, not an upload');
  assert.equal(calls.length, 0, 'selection must issue no upload request');
});

test('selection keeps the File so the existing upload path can consume it', () => {
  const controller = new RealModeController({
    client: { setCredential() {}, credential: null },
    credentials: { read: () => null, write() {}, clear() {} },
    onChange: () => {},
    live: null,
  });
  const file = fakeFile('a.bin', 10);
  controller.addLocalAttachment(file);
  assert.equal(controller.state.attachments[0].file, file, 'the File is carried, not copied');
});

test('the controller exposes no way to read a local filesystem path', () => {
  const controller = new RealModeController({
    client: { setCredential() {}, credential: null },
    credentials: { read: () => null, write() {}, clear() {} },
    onChange: () => {},
    live: null,
  });
  controller.addLocalAttachment(fakeFile('x.txt', 1));
  const item = controller.state.attachments[0];
  const serialized = JSON.stringify({ ...item, file: undefined });
  assert.equal(/[A-Za-z]:\\\\|\/home\/|\/Users\//.test(serialized), false, 'no absolute path may appear');
  assert.deepEqual(Object.keys(item).filter((k) => k !== 'file').sort(),
    ['id', 'kind', 'name', 'size', 'state', 'type'], 'only name/size/type are read from the File');
});

// ── §9 the 25 MiB pre-check is advisory and preserved ────────────────────────

test('a file over 25 MiB is marked failed locally without a request', () => {
  const controller = new RealModeController({
    client: { setCredential() {}, credential: null },
    credentials: { read: () => null, write() {}, clear() {} },
    onChange: () => {},
    live: null,
  });
  controller.addLocalAttachment(fakeFile('huge.bin', MAX_UPLOAD_BYTES + 1));
  assert.equal(controller.state.attachments[0].state, 'failed', 'the local guard marks it, the server stays authoritative');
});

test('a file exactly at 25 MiB is accepted locally', () => {
  const controller = new RealModeController({
    client: { setCredential() {}, credential: null },
    credentials: { read: () => null, write() {}, clear() {} },
    onChange: () => {},
    live: null,
  });
  controller.addLocalAttachment(fakeFile('edge.bin', MAX_UPLOAD_BYTES));
  assert.equal(controller.state.attachments[0].state, 'selected');
  assert.equal(MAX_UPLOAD_BYTES, 25 * 1024 * 1024, 'the product limit is unchanged');
});

// ── §16 cancel is harmless ───────────────────────────────────────────────────

test('a cancelled picker produces no attachment and no request', () => {
  const { doc, region, calls } = composerFor();
  const input = region.querySelector('input[type=file]');
  // A cancelled chooser fires no `change` event at all.
  input.dispatch('change');
  assert.equal(calls.selected.length, 0, 'no selection may be recorded');
});

test('a change event with no files is ignored', () => {
  const { doc, region, calls } = composerFor();
  const input = region.querySelector('input[type=file]');
  input.files = [];
  input.dispatch('change');
  assert.equal(calls.selected.length, 0);
});

// ── §17 same-file reselection ────────────────────────────────────────────────

test('the input value is cleared after a change so the same file can be chosen again', () => {
  const { doc, region, calls } = composerFor();
  const input = region.querySelector('input[type=file]');
  input.files = [fakeFile('same.txt', 5)];
  input.value = 'C:\\fakepath\\same.txt';
  input.dispatch('change');

  assert.equal(calls.selected.length, 1);
  assert.equal(input.value, '', 'the value must be reset or the browser suppresses the next change');
});

test('selecting the same filename twice yields two separate local items', () => {
  const controller = new RealModeController({
    client: { setCredential() {}, credential: null },
    credentials: { read: () => null, write() {}, clear() {} },
    onChange: () => {},
    live: null,
  });
  controller.addLocalAttachment(fakeFile('same.txt', 5));
  const first = controller.state.attachments[0].id;
  controller.removeAttachment(first);
  controller.addLocalAttachment(fakeFile('same.txt', 5));

  assert.equal(controller.state.attachments.length, 1);
  assert.notEqual(controller.state.attachments[0].id, first, 'a reselection must be a distinct item');
});

// ── §7 chip rendering and remove ─────────────────────────────────────────────

test('a selected attachment renders its filename as inert text', () => {
  const { region } = composerFor({
    attachments: [{ id: 'a1', name: 'report.pdf', kind: 'file', state: 'selected', size: 10 }],
  });
  const chip = region.querySelector('.attachment-chip');
  assert.ok(chip !== null, 'the existing chip component must be used, not a second implementation');
  assert.equal(chip.dataset.state, 'selected');
  assert.match(chip.textContent, /report\.pdf/);
});

test('the remove control is wired and reports the attachment id', () => {
  const { doc, region, calls } = composerFor({
    attachments: [{ id: 'a1', name: 'report.pdf', kind: 'file', state: 'selected' }],
  });
  const remove = region.querySelector('.attachment-chip__remove');
  assert.ok(remove !== null);
  assert.match(remove.getAttribute('aria-label'), /report\.pdf/, 'the label names the file (§23)');
  remove.dispatch('click');
  assert.deepEqual(calls.removed, ['a1'], 'removal was previously an unconnected button');
});

test('removing an attachment drops it from state', () => {
  const controller = new RealModeController({
    client: { setCredential() {}, credential: null },
    credentials: { read: () => null, write() {}, clear() {} },
    onChange: () => {},
    live: null,
  });
  controller.addLocalAttachment(fakeFile('a.txt', 1));
  const id = controller.state.attachments[0].id;
  controller.removeAttachment(id);
  assert.equal(controller.state.attachments.length, 0);
});

// ── §8 touch target ──────────────────────────────────────────────────────────

test('the remove control keeps the 44px touch floor', () => {
  const css = fs.readFileSync(path.join(UI, 'styles', 'components.css'), 'utf8');
  const block = /\.attachment-chip__remove\s*\{([^}]*)\}/.exec(css);
  assert.ok(block !== null, 'the remove rule must exist');
  assert.match(block[1], /min-width:\s*var\(--touch-min-width\)/, 'R8G fixed this; it must not regress');
  assert.match(block[1], /min-height:\s*var\(--touch-min-height\)/);
  assert.equal(/min-(width|height):\s*\d+px/.test(block[1]), false, 'no hard-coded sub-44 value');
});

test('the hidden input contributes no layout box', () => {
  const css = fs.readFileSync(path.join(UI, 'styles', 'components.css'), 'utf8');
  const block = /\.composer__file-input\s*\{([^}]*)\}/.exec(css);
  assert.ok(block !== null, 'the input needs an explicit rule so it cannot affect row geometry');
  assert.match(block[1], /display:\s*none/);
});

// ── §22 hostile filenames ────────────────────────────────────────────────────

test('hostile filenames render as inert text', () => {
  const hostile = [
    '<img src=x onerror=globalThis.__pwn=1>.txt',
    '<script>globalThis.__pwn=1</script>.txt',
    '"><svg onload=globalThis.__pwn=1>.txt',
  ];
  for (const name of hostile) {
    globalThis.__pwn = undefined;
    const { region } = composerFor({
      attachments: [{ id: `h-${name.length}`, name, kind: 'file', state: 'selected' }],
    });
    const chip = region.querySelector('.attachment-chip');
    assert.equal(globalThis.__pwn, undefined, `${name} must not execute`);
    assert.equal(chip.querySelector('img'), null, 'no element may be created from a filename');
    assert.equal(chip.querySelector('script'), null);
    assert.equal(chip.querySelector('svg'), null);
    assert.ok(chip.textContent.includes(name), 'the payload survives as text');
    delete globalThis.__pwn;
  }
});

test('a hostile filename in the remove label stays an attribute value', () => {
  globalThis.__pwn = undefined;
  const hostile = '"><img src=x onerror=globalThis.__pwn=1>.txt';
  const { region } = composerFor({
    attachments: [{ id: 'h1', name: hostile, kind: 'file', state: 'selected' }],
  });
  const remove = region.querySelector('.attachment-chip__remove');
  assert.equal(globalThis.__pwn, undefined);
  assert.equal(region.querySelector('img'), null);
  assert.equal(remove.getAttribute('aria-label'), `Remove ${hostile}`, 'the label is a value, not markup');
});

test('no unsafe HTML sink was introduced by this phase', () => {
  let sinks = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      if (/innerHTML|outerHTML|insertAdjacentHTML|document\.write\(|eval\(|new Function\(/.test(text)) sinks += 1;
    }
  };
  walk(UI);
  assert.equal(sinks, 0);
});

// ── §6/§21 fixture isolation ─────────────────────────────────────────────────

test('fixture mode never activates the file input', async () => {
  const { mount } = await import('../../src/remote/ui/app.js');
  const doc = createTestDocument();
  const root = doc.createElement('div');
  root.setAttribute('id', 'app');

  const saved = {
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket,
    location: globalThis.location,
    add: globalThis.addEventListener,
    remove: globalThis.removeEventListener,
  };
  let network = 0;
  globalThis.fetch = () => { network += 1; throw new Error('fixture must not fetch'); };
  globalThis.WebSocket = function trap() { network += 1; throw new Error('fixture must not open a socket'); };
  globalThis.location = { hash: '#fixture=ready' };
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};

  try {
    const controller = mount({ doc, root, autoplayStream: false });
    const input = root.querySelector('input[type=file]');
    assert.ok(input !== null, 'the input exists in fixture mode too');

    let activated = false;
    input.click = () => { activated = true; };

    // Fixture upload is simulated locally and must not touch the native picker.
    root.querySelector('.composer__attach').dispatch('click');
    assert.equal(activated, false, 'fixture mode must never open a system picker');
    assert.match(root.textContent, /diagram\.png/, 'fixture simulates the chip locally');

    assert.equal(network, 0, 'fixture mode must stay network-free');
    controller.dispose();
  } finally {
    globalThis.fetch = saved.fetch;
    globalThis.WebSocket = saved.WebSocket;
    globalThis.location = saved.location;
    globalThis.addEventListener = saved.add;
    globalThis.removeEventListener = saved.remove;
  }
});

// ── §2 the existing upload transport is reused, not duplicated ───────────────

test('exactly one upload transport exists, and this phase added no route', () => {
  // The client is the only place that knows the upload endpoint.
  const client = fs.readFileSync(path.join(UI, 'api', 'api-client.js'), 'utf8');
  assert.match(client, /uploads/, 'the existing upload path is present');

  for (const file of ['components/composer.js', 'app.js']) {
    const text = fs.readFileSync(path.join(UI, file), 'utf8');
    assert.equal(/\/api\/v1\/sessions\/[^'`]*\/uploads/.test(text), false,
      `${file} must not build an upload URL; the ApiClient owns that path`);
    assert.equal(/FormData/.test(text), false, `${file} must not construct multipart itself`);
  }

  // The endpoint is not hand-built anywhere in the UI outside the client.
  let builders = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs)$/.test(entry.name)) continue;
      if (entry.name === 'api-client.js') continue;
      if (/['"`][^'"`]*\/uploads['"`]/.test(fs.readFileSync(full, 'utf8'))) builders += 1;
    }
  };
  walk(UI);
  assert.equal(builders, 0, 'no second upload transport may exist');
});

test('the controller still has exactly one upload method', () => {
  const source = fs.readFileSync(path.join(UI, 'api', 'real-mode.js'), 'utf8');
  const uploads = source.match(/async upload\(/g) ?? [];
  assert.equal(uploads.length, 1, 'one upload path, reused unchanged');
  assert.match(source, /addLocalAttachment\(/, 'selection is a separate, non-uploading step');
});

// ── §11 Android permissions unchanged ────────────────────────────────────────

test('the Android manifest still requests INTERNET only', () => {
  const manifest = fs.readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
  const permissions = [...manifest.matchAll(/uses-permission[^>]*android:name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(permissions, ['android.permission.INTERNET'], 'no storage permission may be added');
  for (const forbidden of ['READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE', 'MANAGE_EXTERNAL_STORAGE']) {
    assert.equal(manifest.includes(forbidden), false, `${forbidden} must not appear`);
  }
});
