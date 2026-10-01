/**
 * R8B — contract conformance: the shell must match the frozen R8 contracts and must not
 * invent a runtime dependency.
 *
 * R9 update: session creation is no longer deferred. The New session control is an enabled,
 * wired action, and `POST /api/v1/sessions` is reached only through the API layer. The tests
 * that asserted a disabled placeholder were obsolete and now assert the implemented contract.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createTestDocument, createTestWindow } from './r8b-dom.mjs';
import { renderAppShell } from '../../src/remote/ui/components/app-shell.js';
import { FIXTURES, buildFixture } from '../../src/remote/ui/state/fixture-state.js';

const ROOT = process.cwd();
const UI = path.join(ROOT, 'src', 'remote', 'ui');

function uiSourceFiles(dir = UI, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) uiSourceFiles(full, out);
    else if (!entry.name.endsWith('.css')) out.push(full);
  }
  return out;
}

test('NewSessionButton is rendered, enabled and wired', () => {
  const doc = createTestDocument();
  const bundle = buildFixture('drawerOpen');
  let created = 0;
  const shell = renderAppShell(
    { fixture: bundle.fixture, state: bundle.state, messages: bundle.messages, sessions: bundle.sessions },
    { doc, onNewSession: () => { created += 1; } },
  );

  const button = [...shell.walk()].find(
    (el) => el.nodeType === 1 && el.tagName === 'BUTTON' && /New session/.test(el.textContent),
  );
  assert.notEqual(button, undefined, 'the New session control must be present');
  assert.equal(button.disabled, false, 'it must be an enabled control now that creation is implemented');
  assert.notEqual(button.getAttribute('aria-disabled'), 'true');
  assert.equal(button.getAttribute('aria-label'), 'New session');
  button.click();
  assert.equal(created, 1, 'the control must be wired to the create handler');
});

test('NewSessionButton is disabled only while a create is in flight', () => {
  const doc = createTestDocument();
  const bundle = buildFixture('drawerOpen');
  const shell = renderAppShell(
    {
      fixture: bundle.fixture,
      state: { ...bundle.state, creatingSession: true },
      messages: bundle.messages,
      sessions: bundle.sessions,
    },
    { doc, onNewSession: () => {} },
  );
  const button = [...shell.walk()].find(
    (el) => el.nodeType === 1 && el.tagName === 'BUTTON' && /New session/.test(el.textContent),
  );
  assert.equal(button.disabled, true, 'a second create must not be dispatchable');
  assert.equal(button.getAttribute('aria-disabled'), 'true');
});

test('session-create failures are announced with the safe Gateway diagnostic', () => {
  const doc = createTestDocument();
  const bundle = buildFixture('ready');
  const shell = renderAppShell(
    {
      fixture: bundle.fixture,
      state: { ...bundle.state, newSessionError: 'The Gateway reported a failure. (UPSTREAM_FAILURE; request req-test)' },
      messages: bundle.messages,
      sessions: bundle.sessions,
    },
    { doc },
  );

  const failure = shell.querySelector('[data-kind="new-session-error"]');
  assert.notEqual(failure, null, 'the create failure must not disappear into the composer-only send error path');
  assert.equal(failure.getAttribute('role'), 'alert');
  assert.match(failure.textContent, /UPSTREAM_FAILURE; request req-test/);
});

test('Load older messages is an enabled, wired control when older pages exist', () => {
  const doc = createTestDocument();
  const bundle = buildFixture('ready');
  let loads = 0;
  const shell = renderAppShell(
    {
      fixture: bundle.fixture,
      state: { ...bundle.state, hasOlderMessages: true, olderMessagesStatus: 'idle' },
      messages: bundle.messages,
      sessions: bundle.sessions,
    },
    { doc, onLoadOlder: () => { loads += 1; } },
  );

  const button = shell.querySelector('#load-older-messages');
  assert.notEqual(button, null, 'the older-history control must be present');
  assert.equal(button.textContent, 'Load older messages');
  assert.equal(button.disabled, false);
  button.click();
  assert.equal(loads, 1, 'the control must be wired to the paging handler');
});

test('Load older messages is absent without older pages and busy while loading', () => {
  const doc = createTestDocument();
  const bundle = buildFixture('ready');

  const hidden = renderAppShell(
    {
      fixture: bundle.fixture,
      state: { ...bundle.state, hasOlderMessages: false },
      messages: bundle.messages,
      sessions: bundle.sessions,
    },
    { doc },
  );
  assert.equal(hidden.querySelector('#load-older-messages'), null, 'no affordance when history is complete');

  const busy = renderAppShell(
    {
      fixture: bundle.fixture,
      state: { ...bundle.state, hasOlderMessages: true, olderMessagesStatus: 'loading' },
      messages: bundle.messages,
      sessions: bundle.sessions,
    },
    { doc, onLoadOlder: () => {} },
  );
  const button = busy.querySelector('#load-older-messages');
  assert.equal(button.disabled, true, 'a second page request must not be dispatchable');
  assert.equal(button.getAttribute('aria-busy'), 'true');
});

test('the session-create call is confined to the API layer', () => {
  const offenders = [];
  for (const file of uiSourceFiles()) {
    const relative = path.relative(UI, file).split(path.sep).join('/');
    if (relative.startsWith('api/')) continue;
    const text = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    if (/createSession\s*\(/.test(text)) offenders.push(relative);
  }
  assert.deepEqual(offenders, [], `session-create leaked outside the API layer:\n${offenders.join('\n')}`);
});

test('only the API and ticket layers know REST endpoint paths', () => {
  // R8B originally asserted the UI referenced NO endpoint at all, because it made no requests.
  // R8C and R8D deliberately changed that: the shell now talks to the Gateway. The property
  // worth guarding is therefore narrower but stronger — endpoint knowledge must be confined to
  // `api/` (REST) and `ws/ticket-client.js` (the one-time ticket), never spread into components
  // or the render layer.
  const endpoints = ['/api/v1/health', '/api/v1/sessions', '/api/v1/auth/ws-ticket'];
  const permitted = (file) => {
    const relative = path.relative(UI, file).split(path.sep).join('/');
    return relative.startsWith('api/') || relative === 'ws/ticket-client.js';
  };

  const offenders = [];
  for (const file of uiSourceFiles()) {
    if (permitted(file)) continue;
    const text = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const endpoint of endpoints) {
      if (text.includes(endpoint)) offenders.push(`${path.relative(UI, file)} → ${endpoint}`);
    }
  }
  assert.deepEqual(offenders, [], `endpoint knowledge leaked outside the API layer:\n${offenders.join('\n')}`);
});

test('session-create is implemented and referenced only by the API layer', () => {
  // R9: `POST /api/v1/sessions` exists now. The property worth guarding is no
  // longer "nobody references it" but "only the API layer references it".
  const referenced = [];
  for (const file of uiSourceFiles()) {
    const relative = path.relative(UI, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    if (/createSession\s*\(/.test(text)) referenced.push(relative);
  }
  assert.deepEqual(referenced.sort(), ['api/api-client.js', 'api/real-mode.js']);
});

test('the CSS provides every required touch target from the token contract', () => {
  const css = fs.readFileSync(path.join(UI, 'styles', 'components.css'), 'utf8')
    + fs.readFileSync(path.join(UI, 'styles', 'base.css'), 'utf8');
  // Values come from tokens, so assert the token references rather than literals.
  assert.match(css, /--touch-min-height/, 'the 44px touch target must be applied');
  assert.match(css, /--touch-code-copy-button/, 'the copy button must keep a 44px target');
  assert.match(css, /--touch-list-row/, 'session rows must keep their height');
});

test('the generated token CSS matches the design tokens exactly', () => {
  const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'design', 'design-tokens.json'), 'utf8'));
  const css = fs.readFileSync(path.join(UI, 'styles', 'tokens.css'), 'utf8');
  // Spot-check one value from each group; the generator is the authority.
  assert.match(css, new RegExp(`--bg-primary:\\s*${tokens.color.bg.primary}`));
  assert.match(css, new RegExp(`--surface-primary:\\s*${tokens.color.surface.primary}`));
  assert.match(css, new RegExp(`--accent-primary:\\s*${tokens.color.accent.primary}`));
  assert.match(css, new RegExp(`--space-s4:\\s*${tokens.spacing.s4}px`));
  assert.match(css, new RegExp(`--radius-r3:\\s*${tokens.radius.r3}px`));
  assert.match(css, new RegExp(`--touch-min-height:\\s*${tokens.touchTarget.minHeight}px`));
  assert.match(css, new RegExp(`--font-sans:\\s*${tokens.typography.families.sans.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('no component hard-codes a design colour', () => {
  const allowed = new Set(['tokens.css', 'index.html']);
  const colourLiteral = /#[0-9A-Fa-f]{3,8}\b/;
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (allowed.has(entry.name)) continue;
      if (/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(UI, full));
      else if (colourLiteral.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(UI, full));
    }
  };
  walk(UI);
  assert.deepEqual(offenders, [], `design colours hard-coded in:\n${offenders.join('\n')}`);
});

test('the package gains no new runtime dependency', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies ?? {});
  assert.deepEqual(deps, ['ws'], `unexpected runtime dependencies: ${deps.join(', ')}`);
  for (const forbidden of ['react', 'vue', 'svelte', 'angular', '@angular/core', 'next']) {
    assert.equal(deps.includes(forbidden), false, `${forbidden} must not be a dependency`);
  }
});

test('no frontend framework or bundler config exists', () => {
  for (const name of ['vite.config.js', 'vite.config.mjs', 'webpack.config.js', 'rollup.config.js', 'next.config.js', 'svelte.config.js']) {
    assert.equal(fs.existsSync(path.join(ROOT, name)), false, `${name} must not exist`);
  }
});

test('the UI source contains no TypeScript or JSX', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|jsx|vue|svelte)$/.test(entry.name)) offenders.push(path.relative(UI, full));
    }
  };
  walk(UI);
  assert.deepEqual(offenders, [], `non-plain-JS files found:\n${offenders.join('\n')}`);
});

test('the twelve contract screens map onto exactly the required fixtures', () => {
  const byName = new Map(FIXTURES.map((f) => [f.name, f]));
  for (const [name, screen] of Object.entries({
    ready: 'S01',
    streaming: 'S02',
    queued: 'S03',
    waitingInput: 'S04',
    reconnecting: 'S05',
    resync: 'S06',
    drawerOpen: 'S07',
    uploading: 'S08',
    authRequired: 'S09',
    gatewayUnavailable: 'S10',
    empty: 'S11',
    failed: 'S12',
  })) {
    assert.equal(byName.get(name)?.screen, screen, `${name} should be ${screen}`);
  }
});

test('a tablet composition exists and reuses the same components', () => {
  const doc = createTestDocument();
  const bundle = buildFixture('tabletReady');
  const shell = renderAppShell(
    { fixture: bundle.fixture, state: bundle.state, messages: bundle.messages, sessions: bundle.sessions },
    { doc },
  );
  // The tablet path is the same tree; the rail is present and carries real session rows.
  const rail = shell.querySelector('.app-shell__rail');
  assert.notEqual(rail, null);
  assert.ok(rail.querySelectorAll('.session-item').length > 0, 'the rail must list sessions');
  assert.notEqual(shell.querySelector('.timeline'), null);
  assert.notEqual(shell.querySelector('#composer-send'), null);
  // Identical semantics: the send label is derived the same way as on mobile.
  assert.equal(shell.querySelector('#composer-send').textContent, 'Send');
});

test('runtime protocol modules are not imported by the UI', () => {
  for (const file of uiSourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const moduleName of ['dsh-adapter', 'supervisor', 'dsh-process', 'persistence', 'auth-service', 'production-gateway']) {
      assert.equal(
        new RegExp(`from\\s+['"][^'"]*${moduleName}`).test(text),
        false,
        `${path.relative(UI, file)} imports runtime module ${moduleName}`,
      );
    }
  }
});

test('mounting the UI performs no network activity and opens no socket', async () => {
  const doc = createTestDocument();
  const root = doc.createElement('div');
  root.setAttribute('id', 'app');

  // Trap any host that could carry a request, then mount every fixture.
  const calls = [];
  const traps = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'];
  const saved = new Map();
  for (const name of traps) {
    saved.set(name, globalThis[name]);
    globalThis[name] = function trap(...args) {
      calls.push({ name, args });
      throw new Error(`network primitive used: ${name}`);
    };
  }

  try {
    const { mount } = await import('../../src/remote/ui/app.js');
    for (const fixture of FIXTURES) {
      doc.body.replaceChildren(root);
      root.replaceChildren();
      const window = createTestWindow({ hash: `#fixture=${fixture.name}`, timers: false });
      const controller = mount({ doc, root, autoplayStream: false });
      assert.ok(root.children.length > 0, `${fixture.name} produced no DOM`);
      controller.dispose();
      window.restore();
    }
  } finally {
    for (const [name, value] of saved) globalThis[name] = value;
  }

  assert.deepEqual(calls, [], `network activity during mount:\n${JSON.stringify(calls)}`);
  assert.equal(globalThis.document, undefined, 'the UI must not define a global document');
});
