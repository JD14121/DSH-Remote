import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditR9UiDependencyClosure } from '../../scripts/r9-relay-04-build-ui.mjs';

test('current UI dependency closure accounts for every browser file and excludes only the dev server module', () => {
  const root = path.resolve('src/remote/ui');
  const audit = auditR9UiDependencyClosure({ sourceRoot: root });
  assert.equal(audit.sourceFiles.length, 35);
  assert.equal(audit.reachableFiles.length, 34);
  assert.deepEqual(audit.excludedFiles, [{
    path: 'api/dev-proxy.mjs',
    reason: 'Node-only development HTTP/WebSocket server; no HTML, module, or stylesheet in the browser entrypoint closure imports it.',
  }]);
  assert.ok(audit.reachableFiles.includes('index.html'));
  assert.ok(audit.reachableFiles.includes('api/real-mode.js'));
  assert.ok(audit.reachableFiles.includes('api/api-client.js'));
  assert.ok(!audit.reachableFiles.includes('api/dev-proxy.mjs'));
});

test('UI closure audit fails when a reachable module is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r9relay04-ui-missing-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<script type="module" src="./app.js"></script>');
  fs.writeFileSync(path.join(root, 'app.js'), "import './missing.js';");
  try { assert.throws(() => auditR9UiDependencyClosure({ sourceRoot: root }), /missing browser dependency/); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('UI closure audit fails when an import escapes the approved root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r9relay04-ui-escape-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<script type="module" src="./app.js"></script>');
  fs.writeFileSync(path.join(root, 'app.js'), "import '../outside.js';");
  try { assert.throws(() => auditR9UiDependencyClosure({ sourceRoot: root }), /escapes the approved UI root/); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('UI closure follows static and dynamic imports, CSS imports, and CSS URL assets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r9relay04-ui-graph-'));
  fs.mkdirSync(path.join(root, 'styles', 'parts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'img'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<link rel="stylesheet" href="./styles/main.css"><script type="module" src="./app.js"></script>');
  fs.writeFileSync(path.join(root, 'app.js'), "import './static.js'; void import('./lazy.js');");
  fs.writeFileSync(path.join(root, 'static.js'), 'export const ready = true;');
  fs.writeFileSync(path.join(root, 'lazy.js'), 'export const lazy = true;');
  fs.writeFileSync(path.join(root, 'styles', 'main.css'), '@import "./parts/extra.css"; .x{background:url("../img/pixel.svg")}');
  fs.writeFileSync(path.join(root, 'styles', 'parts', 'extra.css'), '.x{display:block}');
  fs.writeFileSync(path.join(root, 'img', 'pixel.svg'), '<svg/>');
  try {
    const audit = auditR9UiDependencyClosure({ sourceRoot: root });
    assert.deepEqual([...audit.reachableFiles].sort(), ['app.js', 'img/pixel.svg', 'index.html', 'lazy.js', 'static.js', 'styles/main.css', 'styles/parts/extra.css']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
