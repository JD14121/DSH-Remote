import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildR9UiArtifact } from '../../scripts/r9-relay-04-build-ui.mjs';
import { verifyR9UiArtifact } from '../../src/remote/r9/production-runtime.mjs';

test('UI artifact build emits an exact SHA-256 manifest and excludes the development proxy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r9relay04-ui-build-'));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'artifact');
  fs.mkdirSync(path.join(source, 'api'), { recursive: true });
  fs.mkdirSync(path.join(source, 'styles'), { recursive: true });
  fs.writeFileSync(path.join(source, 'index.html'), '<link rel="stylesheet" href="./styles/site.css"><main>synthetic UI</main>');
  fs.writeFileSync(path.join(source, 'api', 'dev-proxy.mjs'), 'development only');
  fs.writeFileSync(path.join(source, 'styles', 'site.css'), 'body{}');
  try {
    const built = buildR9UiArtifact({ sourceRoot: source, outputRoot: output });
    assert.deepEqual(built.files.map((f) => f.path).sort(), ['index.html', 'styles/site.css']);
    assert.equal(fs.existsSync(path.join(output, 'ui', 'api', 'dev-proxy.mjs')), false);
    assert.deepEqual([...verifyR9UiArtifact(built.uiRoot, built.manifestPath)].sort(), ['index.html', 'styles/site.css']);
    fs.writeFileSync(path.join(built.uiRoot, 'index.html'), 'tampered');
    assert.throws(() => verifyR9UiArtifact(built.uiRoot, built.manifestPath), /integrity mismatch/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UI artifact builder refuses to overwrite an existing output directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r9relay04-ui-existing-'));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'artifact');
  fs.mkdirSync(source);
  fs.mkdirSync(output);
  try { assert.throws(() => buildR9UiArtifact({ sourceRoot: source, outputRoot: output }), /already exists/); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
