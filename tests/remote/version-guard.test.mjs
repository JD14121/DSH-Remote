/**
 * Version guard tests — R1 §13, §18.4.
 *
 * Required matrix:
 *   0.1.5-rc.2      -> PASS
 *   different version -> FAIL
 *   missing version   -> FAIL
 *   invalid version   -> FAIL
 *
 * "Fail" means throw `WIRE_VERSION_MISMATCH`. R1 §13 forbids warn-and-continue,
 * because Substrate A depends on a browser-internal wire.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ADAPTER_ERROR } from '../../src/remote/adapter-errors.mjs';
import {
  DshVersionGuard,
  SUPPORTED_DSH_VERSIONS,
  TARGET_DSH_VERSION,
  assertSupportedVersion,
  isVersionLike,
  staticVersionGuard,
} from '../../src/remote/version-guard.mjs';
import { loadFixture } from './helpers.mjs';

test('the target version is the one R1 was verified against', () => {
  assert.equal(TARGET_DSH_VERSION, '0.1.5-rc.2');
  assert.deepEqual([...SUPPORTED_DSH_VERSIONS], ['0.1.5-rc.2']);
});

test('the observed version from the fixture passes', async () => {
  const fixture = loadFixture('version.json');
  assert.equal(fixture.dsh.version, TARGET_DSH_VERSION);

  assert.equal(assertSupportedVersion(fixture.dsh.version), TARGET_DSH_VERSION);
  assert.equal(await staticVersionGuard(fixture.dsh.version).verify(), TARGET_DSH_VERSION);
});

test('a different version fails closed', () => {
  for (const other of ['0.1.4', '0.1.5', '0.1.5-rc.3', '0.2.0', '1.0.0']) {
    assert.throws(
      () => assertSupportedVersion(other),
      (error) => {
        assert.equal(error.code, ADAPTER_ERROR.WIRE_VERSION_MISMATCH);
        assert.equal(error.retryable, false);
        return true;
      },
      `${other} must be rejected`,
    );
  }
});

test('a missing version fails closed', () => {
  for (const missing of [undefined, null, '']) {
    assert.throws(
      () => assertSupportedVersion(missing),
      (error) => error.code === ADAPTER_ERROR.WIRE_VERSION_MISMATCH,
      `${JSON.stringify(missing)} must be rejected`,
    );
  }
});

test('an invalid version string fails closed', () => {
  for (const invalid of ['latest', 'v0.1.5-rc.2', '0.1', '0.1.5.6', ' 0.1.5-rc.2 ', 42, {}]) {
    assert.throws(
      () => assertSupportedVersion(invalid),
      (error) => error.code === ADAPTER_ERROR.WIRE_VERSION_MISMATCH,
      `${JSON.stringify(invalid)} must be rejected`,
    );
  }
});

test('isVersionLike accepts the shapes DSH publishes', () => {
  assert.equal(isVersionLike('0.1.5-rc.2'), true);
  assert.equal(isVersionLike('1.2.3'), true);
  assert.equal(isVersionLike('0.1.5-beta.1'), true);
  assert.equal(isVersionLike('0.1'), false);
  assert.equal(isVersionLike('rc.2'), false);
  assert.equal(isVersionLike(''), false);
  assert.equal(isVersionLike(undefined), false);
});

test('the guard verifies once and caches the accepted version', async () => {
  let calls = 0;
  const guard = new DshVersionGuard({
    resolveObserved: async () => {
      calls += 1;
      return TARGET_DSH_VERSION;
    },
    source: 'fixture',
  });

  assert.equal(guard.isVerified, false);
  const first = await guard.verify();
  const second = await guard.verify();

  assert.equal(first, TARGET_DSH_VERSION);
  assert.equal(second, TARGET_DSH_VERSION);
  assert.equal(calls, 1, 'the version source must not be re-read on every call');
  assert.equal(guard.isVerified, true);
});

test('a rejecting version source fails closed rather than proceeding', async () => {
  const guard = new DshVersionGuard({
    resolveObserved: async () => {
      throw new Error('package.json unreadable');
    },
  });

  await assert.rejects(
    () => guard.verify(),
    (error) => error.code === ADAPTER_ERROR.WIRE_VERSION_MISMATCH,
  );
});

test('a guard with no observation source cannot be constructed', () => {
  assert.throws(() => new DshVersionGuard({}), TypeError);
});

test('an unsupported version leaves the guard unverified', async () => {
  const guard = new DshVersionGuard({ observedVersion: '9.9.9' });

  await assert.rejects(
    () => guard.verify(),
    (error) => error.code === ADAPTER_ERROR.WIRE_VERSION_MISMATCH,
  );
  assert.equal(guard.isVerified, false);
});

test('the supported list can be widened explicitly and is then honoured', () => {
  assert.equal(
    assertSupportedVersion('0.1.5-rc.3', { supported: ['0.1.5-rc.2', '0.1.5-rc.3'] }),
    '0.1.5-rc.3',
  );
});

test('the mismatch error names the observed and supported versions but no secret', () => {
  try {
    assertSupportedVersion('0.1.4', { source: 'fixture-version' });
    assert.fail('expected a throw');
  } catch (error) {
    assert.equal(error.code, ADAPTER_ERROR.WIRE_VERSION_MISMATCH);
    assert.equal(error.details.observed, '0.1.4');
    assert.deepEqual(error.details.supported, ['0.1.5-rc.2']);
    assert.equal(error.details.source, 'fixture-version');
    assert.equal(JSON.stringify(error.toJSON()).includes('cookie'), false);
  }
});
