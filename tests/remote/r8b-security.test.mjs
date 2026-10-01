/**
 * R8B — security: no unsafe HTML sinks, no network, no credential in a URL, and no
 * server-lifecycle control anywhere in the UI.
 *
 * These assertions read the real source text, so they fail if someone reintroduces a sink.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createTestDocument } from './r8b-dom.mjs';
import { renderAppShell } from '../../src/remote/ui/components/app-shell.js';
import { renderAssistantContent } from '../../src/remote/ui/rendering/render-message.js';
import { buildFixture } from '../../src/remote/ui/state/fixture-state.js';

const UI = path.join(process.cwd(), 'src', 'remote', 'ui');

/** Every .js file under the UI tree, excluding the stylesheets. */
function uiSourceFiles(dir = UI, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) uiSourceFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('no unsafe HTML sink appears anywhere in the UI source', () => {
  const sinks = [
    { name: 'innerHTML', re: /\.innerHTML\s*=/ },
    { name: 'outerHTML', re: /\.outerHTML\s*=/ },
    { name: 'insertAdjacentHTML', re: /insertAdjacentHTML\s*\(/ },
    { name: 'document.write', re: /document\.write\s*\(/ },
    { name: 'eval', re: /[^.\w]eval\s*\(/ },
    { name: 'new Function', re: /new\s+Function\s*\(/ },
  ];
  const offenders = [];
  for (const file of uiSourceFiles()) {
    // Strip comments so a prose mention is not mistaken for a use.
    const text = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const sink of sinks) {
      if (sink.re.test(text)) offenders.push(`${path.relative(UI, file)}: ${sink.name}`);
    }
  }
  assert.deepEqual(offenders, [], `unsafe HTML sinks found:\n${offenders.join('\n')}`);
});

test('model content is inserted as text, never as markup', () => {
  const doc = createTestDocument();
  const host = doc.createElement('div');
  const hostile = '<img src=x onerror="globalThis.__pwned = true">';

  renderAssistantContent(host, hostile, { doc });

  // The markup must survive as literal text.
  assert.equal(host.textContent, hostile);
  assert.equal(host.querySelector('img'), null, 'an img element was created from model output');
  assert.equal(globalThis.__pwned, undefined, 'model output executed');
  // Nothing inside was turned into an element: only the paragraph wrapper exists.
  const elements = [...host.walk()].filter((n) => n.nodeType === 1 && n !== host);
  assert.deepEqual(elements.map((e) => e.tagName), ['P']);
});

test('a script tag in content does not become a script element', () => {
  const doc = createTestDocument();
  const host = doc.createElement('div');
  renderAssistantContent(host, '<script>globalThis.__ran = true<\/script>', { doc });
  assert.equal(host.querySelector('script'), null);
  assert.equal(globalThis.__ran, undefined);
  assert.match(host.textContent, /<script>/);
});

test('inline code and fenced blocks are built from DOM APIs', () => {
  const doc = createTestDocument();
  const host = doc.createElement('div');
  renderAssistantContent(host, 'Use `npm test` now.\n\n```bash\nnpm test\n```', { doc });

  const code = host.querySelector('code');
  assert.notEqual(code, null, 'inline code should be a code element');
  assert.equal(code.textContent, 'npm test');

  const block = host.querySelector('.code-block');
  assert.notEqual(block, null, 'a fenced block should render as a code block');
  assert.equal(block.querySelector('pre').textContent, 'npm test');
  assert.equal(block.querySelector('.code-block__lang').textContent, 'bash');
});

test('no network primitive appears anywhere in the UI source', () => {
  const network = [
    { name: 'fetch', re: /\bfetch\s*\(/ },
    { name: 'XMLHttpRequest', re: /\bnew\s+XMLHttpRequest\b/ },
    // Constructing a socket is the prohibited thing; naming the protocol in a comment is not.
    { name: 'new WebSocket', re: /\bnew\s+WebSocket\b/ },
    { name: 'new EventSource', re: /\bnew\s+EventSource\b/ },
    { name: 'sendBeacon', re: /\bsendBeacon\b/ },
  ];
  const offenders = [];
  for (const file of uiSourceFiles()) {
    const text = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const item of network) {
      if (item.re.test(text)) offenders.push(`${path.relative(UI, file)}: ${item.name}`);
    }
  }
  assert.deepEqual(offenders, [], `network primitives found:\n${offenders.join('\n')}`);
});

test('the page declares a deny-by-default content security policy', () => {
  const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  // R8C narrowed this from 'none' to 'self' so the same-origin loopback proxy is reachable.
  // It must still be a same-origin-only policy: no wildcard, no explicit origin, no socket.
  assert.match(html, /connect-src 'self'/);
  assert.equal(/connect-src \*/.test(html), false, 'a wildcard connect-src is forbidden');
  assert.equal(/\bwss?:/.test(html), false, 'ws/wss must not be permitted');
  assert.match(html, /default-src 'none'/);
});

test('no server-lifecycle control exists in the rendered shell', () => {
  const forbidden = [/restart\s*dsh/i, /stop\s*dsh/i, /start\s*dsh/i, /kill\s*dsh/i, /stop\s*gateway/i, /restart\s*gateway/i];
  for (const name of ['ready', 'drawerOpen', 'gatewayUnavailable', 'reconnecting']) {
    const doc = createTestDocument();
    const bundle = buildFixture(name);
    const shell = renderAppShell(
      { fixture: bundle.fixture, state: bundle.state, messages: bundle.messages, sessions: bundle.sessions },
      { doc },
    );
    const text = shell.textContent;
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${name} offers a lifecycle control`);
    }
  }
});

test('the connection badge offers exactly the six permitted variants', () => {
  const doc = createTestDocument();
  const bundle = buildFixture('ready');
  const variants = new Set();
  for (const connection of ['auth_required', 'connecting', 'connected', 'reconnecting', 'resync_required', 'gateway_unavailable']) {
    const shell = renderAppShell(
      { fixture: bundle.fixture, state: { ...bundle.state, connection }, messages: bundle.messages, sessions: bundle.sessions },
      { doc },
    );
    const badge = shell.querySelector('.connection-badge');
    variants.add(badge.getAttribute('data-connection'));
    assert.notEqual(badge.textContent.trim().length, 0, 'the badge must carry text, not colour alone');
  }
  assert.equal(variants.size, 6);
});

test('the credential value is not placed in the document URL or any attribute', () => {
  const doc = createTestDocument();
  const bundle = buildFixture('authRequired');
  const shell = renderAppShell(
    { fixture: bundle.fixture, state: bundle.state, messages: bundle.messages, sessions: bundle.sessions },
    { doc },
  );
  // The dialog must not carry the value in an attribute, nor link anywhere with it.
  const html = shell.outerHTML;
  assert.doesNotMatch(html, /\?token=/);
  assert.doesNotMatch(html, /\?ticket=/);
  assert.equal(shell.querySelector('form'), null, 'a form could submit the token');
  for (const el of shell.walk()) {
    if (el.nodeType !== 1) continue;
    for (const [name, value] of el.attributes.entries()) {
      if (name === 'type' || name === 'autocomplete') continue;
      assert.doesNotMatch(String(value), /token=|Bearer\s/i, `attribute ${name} carries a credential`);
    }
  }
});

test('the dialog is removed on connect, so the value cannot survive in the DOM', () => {
  const doc = createTestDocument();
  const root = doc.createElement('div');
  const bundle = buildFixture('authRequired');
  const shell = renderAppShell(
    { fixture: bundle.fixture, state: bundle.state, messages: bundle.messages, sessions: bundle.sessions },
    { doc },
  );
  root.append(shell);
  assert.notEqual(root.querySelector('#credential-dialog'), null);

  // Simulate the connected transition: the dialog is not rendered at all.
  const connected = renderAppShell(
    { fixture: bundle.fixture, state: { ...bundle.state, credentialDialogOpen: false, connection: 'connected' }, messages: bundle.messages, sessions: bundle.sessions },
    { doc },
  );
  root.replaceChildren(connected);
  assert.equal(root.querySelector('#credential-dialog'), null, 'the dialog must leave the DOM');
  assert.equal(root.querySelector('#credential-token'), null, 'the input must not remain');
});

test('the fixture token placeholder is not credential-shaped', () => {
  const source = fs.readFileSync(path.join(UI, 'fixtures', 'messages.js'), 'utf8');
  const match = /FIXTURE_TOKEN_PLACEHOLDER\s*=\s*'([^']+)'/.exec(source);
  assert.notEqual(match, null, 'the placeholder should be declared');
  const value = match[1];
  // A 43-character base64url string is the shape of a real token; the placeholder must not be.
  assert.doesNotMatch(value, /^[A-Za-z0-9_-]{43}$/, 'the placeholder must not look like a real credential');
  assert.match(value, /fixture|placeholder|not-a-real/i);
});
