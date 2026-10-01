/**
 * Production configuration tests — Phase R7 §5, §12, §13, §36, §48.
 *
 * The two properties worth defending here are that a LAN bind is impossible to
 * configure, and that the credential never travels through the environment.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import {
  DSH_PACKAGE,
  DSH_VERSION,
  OPERATOR_DSH_PORT,
  R7_ERROR,
  assertRealProductionRootAbsent,
  describeProductionConfig,
  dshLaunchArgv,
  isLoopbackHost,
  makeTempProduction,
  resolveProductionConfig,
} from './r7-helpers.mjs';

test('§13: the DSH version is pinned and never @latest', () => {
  assert.equal(DSH_VERSION, '0.1.5-rc.2');
  assert.equal(DSH_PACKAGE, '@deepseek-ai/dsh@0.1.5-rc.2');
  assert.equal(DSH_PACKAGE.includes('@latest'), false);
});

test('§13: the launcher argv matches the audited rc.2 contract', () => {
  const { config, cleanup } = makeTempProduction();
  try {
    const argv = dshLaunchArgv(config);
    assert.deepEqual(argv, ['-y', '@deepseek-ai/dsh@0.1.5-rc.2', 'web', '--no-open']);
    // The flag exists in rc.2; asserting it here means a future removal shows up as a
    // test failure rather than as a startup that silently opens a browser.
    assert.equal(argv.includes('--no-open'), true);
    // No competing bind definition: the composed profile owns host and port.
    assert.equal(argv.includes('--host'), false);
    assert.equal(argv.includes('--port'), false);
  } finally {
    cleanup();
  }
});

test('§12: a non-loopback Gateway bind is refused at configuration time', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.5', '10.0.0.1', 'example.com', '*']) {
    assert.throws(
      () => resolveProductionConfig({ gatewayHost: host, dshHome: 'C:\\temp\\r7-x' }),
      (error) => error.code === R7_ERROR.PRODUCTION_ROOT_UNEXPECTED,
      `${host} must be refused`,
    );
  }
});

test('§12: loopback hosts are accepted', () => {
  for (const host of ['127.0.0.1', '127.0.0.53', 'localhost', '::1', '[::1]']) {
    assert.equal(isLoopbackHost(host), true, `${host} must be loopback`);
  }
  for (const host of ['0.0.0.0', '::', '192.168.1.1', '127.999.0.1', '', null, undefined]) {
    assert.equal(isLoopbackHost(host), false, `${host} must not be loopback`);
  }
});

test('§12: the composed defaults are the documented ones', () => {
  const config = resolveProductionConfig({ dshHome: 'C:\\temp\\r7-defaults' });
  assert.equal(config.dshHome, 'C:\\temp\\r7-defaults');
  assert.equal(config.gatewayHost, '127.0.0.1');
  assert.equal(config.gatewayPort, 9445);
  assert.equal(config.dshHost, '127.0.0.1');
  // R7D froze the supervised production port at 3081, deliberately distinct from the operator's
  // 3080 so the Supervisor never manages a process the operator is using interactively.
  assert.equal(config.dshPort, 3081);
  assert.notEqual(config.dshPort, OPERATOR_DSH_PORT, 'production must not target the operator port');
  assert.equal(OPERATOR_DSH_PORT, 3080);
  assert.equal(config.workspace, 'D:\\DSH-testing');
});

test('§5: the production root layout is exactly the documented one', () => {
  const { config, cleanup } = makeTempProduction();
  try {
    assert.equal(config.paths.root, path.join(config.dshHome, 'remote'));
    assert.equal(path.basename(config.paths.phoneToken), 'phone-token.v1');
    assert.equal(path.basename(config.paths.phoneTokenMeta), 'phone-token.meta.json');
    assert.equal(path.basename(config.paths.supervisorLock), 'supervisor.lock');
    assert.equal(path.basename(config.paths.gatewayLock), 'gateway.lock');
    assert.equal(path.basename(config.paths.supervisorJson), 'supervisor.json');
    assert.equal(path.basename(config.paths.supervisorLog), 'supervisor.log');
    assert.equal(path.basename(config.paths.dshLog), 'dsh.log');
    // R5's format version is untouched.
    assert.equal(config.paths.format, path.join(config.paths.root, 'format.json'));
  } finally {
    cleanup();
  }
});

test('§48: the credential never comes from the environment', async () => {
  const source = await import('node:fs').then((fs) => fs.promises.readFile(
    new URL('../../src/remote/production/production-config.mjs', import.meta.url), 'utf8',
  ));
  // Path overrides may come from the environment; a *credential* must not. The
  // distinction matters: `DSH_REMOTE_DSH_HOME` only relocates a directory, while a
  // credential in the environment is readable by every process of the same user.
  const reads = [...source.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((match) => match[1]);
  assert.ok(reads.length > 0, 'the config does read some environment variables');
  for (const name of reads) {
    assert.equal(
      /TOKEN|SECRET|CREDENTIAL|PASSWORD|COOKIE|AUTH/.test(name),
      false,
      `process.env.${name} looks like a credential source`,
    );
  }
  // The *code* names for credential errors naturally contain PHONE_TOKEN; what must
  // not exist is a *read* of such a variable, which the loop above establishes.
  assert.equal(/process\.env\.[A-Z_]*PHONE/.test(source), false);
});

test('§12: a description is safe to print', () => {
  const { config, cleanup } = makeTempProduction();
  try {
    const described = describeProductionConfig(config);
    assert.equal(described.dsh_version, '0.1.5-rc.2');
    assert.equal(described.root, config.root);
    // A path is not a secret, and an operator needs it.
    assert.equal(typeof described.root, 'string');
    // But no credential field exists at all.
    for (const key of Object.keys(described)) {
      assert.equal(/token|cookie|secret|digest/i.test(key), false, `${key} must not be a credential field`);
    }
  } finally {
    cleanup();
  }
});

test('§26/§30: rotation and timeout defaults are the documented values', () => {
  const { config, cleanup } = makeTempProduction();
  try {
    assert.equal(config.logMaxBytes, 10_485_760);
    assert.equal(config.logBackups, 5);
    // Accepted production cold-npx startup budget; stability remains 60 s.
    assert.equal(config.startTimeoutMs, 180_000);
    assert.equal(config.maxRestarts, 3);
    assert.deepEqual([...config.restartBackoffMs], [1000, 2000, 4000]);
    assert.equal(config.stabilityMs, 60_000);
  } finally {
    cleanup();
  }
});

test('a temp fixture never lands inside the real DSH_HOME', () => {
  const { root, config, cleanup } = makeTempProduction();
  try {
    // This test is about the **fixture**, not about the production root's existence:
    // after Gate B that root is expected to be there. Asserting its absence here would
    // conflate "the fixture is correctly sandboxed" with "production has not started".
    assert.equal(root.startsWith('D:\\DSH-work-test\\.dsh'), false);
    assert.equal(config.root.startsWith('D:\\DSH-work-test\\.dsh'), false);
    assert.equal(config.dshHome.startsWith('D:\\DSH-work-test\\.dsh'), false);
    assert.notEqual(config.root, 'D:\\DSH-work-test\\.dsh\\remote');
  } finally {
    cleanup();
  }
});

test('an invalid gateway port is refused', () => {
  // `null`/`undefined` mean "not provided" and correctly fall back to the default;
  // a *provided but wrong* value is what must be refused.
  for (const port of [0.5, -1, 70_000, 0, 'abc', {}, []]) {
    assert.throws(
      () => resolveProductionConfig({ gatewayPort: port, dshHome: 'C:\\temp\\r7-port' }),
      TypeError,
      `${String(port)} must be refused`,
    );
  }
  // Port 0 is refused deliberately: "let the OS choose" would leave the operator
  // unable to say which port the Gateway is on.
  assert.throws(() => resolveProductionConfig({ gatewayPort: 0, dshHome: 'C:\\temp\\r7-port' }), TypeError);
  // An omitted value uses the documented default.
  assert.equal(resolveProductionConfig({ dshHome: 'C:\\temp\\r7-port' }).gatewayPort, 9445);
  assert.equal(resolveProductionConfig({ gatewayPort: null, dshHome: 'C:\\temp\\r7-port' }).gatewayPort, 9445);
});
