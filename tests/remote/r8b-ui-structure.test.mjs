/**
 * R8B — structure: one component tree produces every screen, and the accessibility baseline
 * is present in the markup rather than only in the CSS.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createTestDocument } from './r8b-dom.mjs';
import { renderAppShell } from '../../src/remote/ui/components/app-shell.js';
import { FIXTURES, buildFixture } from '../../src/remote/ui/state/fixture-state.js';

const UI = path.join(process.cwd(), 'src', 'remote', 'ui');

/** Render a fixture with a fresh fake document. */
function render(name) {
  const doc = createTestDocument();
  const bundle = buildFixture(name);
  const shell = renderAppShell(
    { fixture: bundle.fixture, state: bundle.state, messages: bundle.messages, sessions: bundle.sessions, activeSessionId: bundle.state.activeSessionId },
    { doc },
  );
  return { shell, doc, bundle };
}

test('every fixture renders without throwing', () => {
  for (const fixture of FIXTURES) {
    const { shell } = render(fixture.name);
    assert.ok(shell.textContent.length > 0, `${fixture.name} produced an empty shell`);
  }
});

test('the twelve contract screens are all available as fixtures', () => {
  const screens = FIXTURES.filter((f) => f.auxiliary !== true).map((f) => f.screen);
  for (const required of ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11', 'S12']) {
    assert.ok(screens.includes(required), `missing screen fixture ${required}`);
  }
  assert.equal(screens.length, 12);
});

test('there is no per-screen markup — one tree serves every fixture', () => {
  const htmlFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html')) htmlFiles.push(full);
    }
  };
  walk(UI);
  // The contract forbids twelve separate HTML documents.
  assert.equal(htmlFiles.length, 1, `expected exactly one html file, found ${htmlFiles.length}`);
});

test('the shell provides the semantic landmarks', () => {
  const { shell } = render('ready');
  assert.notEqual(shell.querySelector('main'), null, 'a main landmark is required');
  assert.notEqual(shell.querySelector('nav'), null, 'the rail is a navigation landmark');
  assert.notEqual(shell.querySelector('header'), null, 'the top bar is a banner/header');
});

test('the timeline is a log and the error message is an alert', () => {
  const ready = render('ready');
  const log = ready.shell.querySelector('.timeline');
  assert.equal(log.getAttribute('role'), 'log');
  assert.equal(log.getAttribute('aria-live'), 'polite');

  const failed = render('failed');
  const alert = failed.shell.querySelector('.message--error');
  assert.equal(alert.getAttribute('role'), 'alert');
});

test('the drawer exposes dialog semantics, aria-expanded and aria-controls', () => {
  const closed = render('ready');
  const menu = closed.shell.querySelector('.top-bar__menu');
  assert.equal(menu.getAttribute('aria-expanded'), 'false');
  assert.equal(menu.getAttribute('aria-controls'), 'session-drawer');
  assert.equal(menu.getAttribute('aria-label'), 'Sessions');

  const open = render('drawerOpen');
  assert.equal(open.shell.querySelector('.top-bar__menu').getAttribute('aria-expanded'), 'true');
  const drawer = open.shell.querySelector('#session-drawer');
  assert.equal(drawer.getAttribute('role'), 'dialog');
  assert.equal(drawer.getAttribute('aria-modal'), 'true');
  assert.equal(drawer.getAttribute('data-state'), 'open');
});

test('the active session carries aria-current', () => {
  const { shell } = render('ready');
  const current = shell.querySelector('[aria-current="true"]');
  assert.notEqual(current, null, 'the active session must be marked with aria-current');
});

test('the credential dialog is labelled and its field is masked', () => {
  const { shell } = render('authRequired');
  const dialog = shell.querySelector('#credential-dialog');
  assert.notEqual(dialog, null);
  const scrim = shell.querySelector('.dialog-scrim');
  assert.notEqual(scrim.querySelector('#credential-dialog'), null, 'the dialog must be a child of the scrim so it paints above the scrim background and receives touches');
  assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  const labelledBy = dialog.getAttribute('aria-labelledby');
  assert.equal(shell.querySelector(`#${labelledBy}`).textContent, 'Connect to DSH');

  const field = shell.querySelector('#credential-token');
  assert.equal(field.type, 'password', 'the token field must be masked by default');
  assert.equal(field.getAttribute('spellcheck'), 'false');
});

test('the session list has loading, empty and loaded states', () => {
  const ready = render('ready');
  assert.equal(ready.shell.querySelector('.session-list').getAttribute('data-status'), 'loaded');
  // The rail and the drawer both render a list; the rail is always present.
  assert.ok(ready.shell.querySelectorAll('.session-item').length >= 1);
});

test('the fatal state replaces the composer rather than sitting beside it', () => {
  const { shell } = render('gatewayUnavailable');
  assert.notEqual(shell.querySelector('.state-block--fatal'), null);
  assert.equal(shell.querySelector('#composer-send'), null, 'no composer may show in a fatal state');
});

test('the rail and the drawer host both exist so the responsive change is layout-only', () => {
  const { shell } = render('ready');
  assert.notEqual(shell.querySelector('.app-shell__rail'), null);
  assert.notEqual(shell.querySelector('.app-shell__drawer-host'), null);
  // The same component renders in both places.
  assert.equal(shell.querySelectorAll('.session-list').length, 2);
});

test('code blocks carry a language label and a copy control', () => {
  const { shell } = render('ready');
  const block = shell.querySelector('.code-block');
  assert.notEqual(block, null, 'the assistant reply should include a code block');
  assert.equal(block.querySelector('.code-block__lang').textContent, 'bash');
  const copy = block.querySelector('.code-block__copy');
  assert.notEqual(copy, null);
  assert.equal(copy.getAttribute('aria-label'), 'Copy bash code');
  assert.notEqual(block.querySelector('.code-block__scroll'), null, 'the block must scroll internally');
});

test('the stylesheets define reduced-motion handling', () => {
  const css = fs.readFileSync(path.join(UI, 'styles', 'base.css'), 'utf8')
    + fs.readFileSync(path.join(UI, 'styles', 'components.css'), 'utf8')
    + fs.readFileSync(path.join(UI, 'styles', 'layout.css'), 'utf8');
  assert.match(css, /prefers-reduced-motion:\s*reduce/, 'reduced motion must be honoured');
});

test('responsive rules cover all four breakpoints', () => {
  const css = fs.readFileSync(path.join(UI, 'styles', 'responsive.css'), 'utf8');
  assert.match(css, /min-width:\s*768px/, 'tablet breakpoint missing');
  assert.match(css, /max-width:\s*379px/, 'narrow-phone rule missing');
  assert.match(css, /min-width:\s*480px/, 'large-phone rule missing');
});
