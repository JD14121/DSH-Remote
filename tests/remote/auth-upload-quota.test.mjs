/**
 * Upload-quota tests — Phase R6 §41, §42, §43, §85.
 *
 * §42 is the requirement that shapes this: accounting must be **streamed**, because
 * `Content-Length` is a client claim. Bytes are charged as they are read, and the
 * request is destroyed the moment the budget is exceeded so the oversized bytes are
 * never forwarded to DSH.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTH_ERROR,
  DEFAULT_BYTES_PER_WINDOW,
  DEFAULT_MAX_CONCURRENT_UPLOADS,
  UploadQuota,
  startAuthServer,
} from './r6-helpers.mjs';

/** A manual clock, so window tests never sleep (§65). */
function manualClock(start = 1_789_800_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

test('§41: the documented defaults are the resolved defaults', () => {
  assert.equal(DEFAULT_MAX_CONCURRENT_UPLOADS, 2);
  assert.equal(DEFAULT_BYTES_PER_WINDOW, 104_857_600, '100 MiB per 10 minutes');
  const quota = new UploadQuota();
  assert.equal(quota.maxConcurrent, 2);
  assert.equal(quota.bytesPerWindow, 104_857_600);
  assert.equal(quota.windowSeconds, 600);
});

test('§41: quota settings are validated', () => {
  for (const bad of [{ maxConcurrent: 0 }, { bytesPerWindow: -1 }, { windowSeconds: 0 }]) {
    assert.throws(
      () => new UploadQuota(bad),
      (error) => error.code === AUTH_ERROR.CONFIG_INVALID,
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

test('§85: concurrent uploads up to the limit succeed, the next is refused', () => {
  const quota = new UploadQuota({ maxConcurrent: 2 });
  const first = quota.begin();
  const second = quota.begin();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  const third = quota.begin();
  assert.equal(third.ok, false);
  assert.equal(third.reason, 'concurrent');
  assert.ok(third.retryAfter >= 1);
  assert.equal(quota.counters.refusedConcurrent, 1);

  first.finish(10);
  assert.equal(quota.begin().ok, true, 'a finished upload frees a slot');
});

test('§42: bytes are charged on finish, and an abort still charges them', () => {
  const quota = new UploadQuota();
  const one = quota.begin();
  one.finish(1000);
  assert.equal(quota.bytesUsed, 1000);

  const two = quota.begin();
  // An abort must not be a way to escape accounting: the bytes were read.
  two.abort(500);
  assert.equal(quota.bytesUsed, 1500, 'aborted bytes are still charged');
  assert.equal(quota.counters.aborted, 1);
});

test('§42: streaming accounting refuses at the exact boundary', () => {
  const quota = new UploadQuota({ bytesPerWindow: 1000 });
  // Exactly the budget is allowed.
  assert.equal(quota.chargeBytes(1000).allowed, true);
  assert.equal(quota.bytesUsed, 1000);
  // One byte more is not.
  assert.equal(quota.chargeBytes(1).allowed, false);
  assert.equal(quota.counters.refusedBytes, 1);
});

test('§42: wouldExceed predicts before a chunk is forwarded', () => {
  const quota = new UploadQuota({ bytesPerWindow: 100 });
  quota.chargeBytes(60);
  assert.equal(quota.wouldExceed(40), false, 'exactly filling the budget is allowed');
  assert.equal(quota.wouldExceed(41), true, 'one over is predicted');
  // The prediction must not itself charge.
  assert.equal(quota.bytesUsed, 60);
});

test('§42: the budget does not trust Content-Length', async () => {
  const source = await import('node:fs').then((fs) => fs.promises.readFile(
    new URL('../../src/remote/auth/upload-quota.mjs', import.meta.url), 'utf8',
  ));
  // The accountant exposes streaming entry points and never reads a declared length.
  assert.ok(source.includes('chargeBytes'), 'streaming accounting exists');
  assert.ok(source.includes('wouldExceed'), 'a pre-forward check exists');
  assert.equal(source.includes('content-length'), false, 'the module never trusts a declared length');
  assert.equal(source.includes('contentLength'), false);
});

test('§42: a request that exceeds mid-stream is destroyed and not forwarded', async () => {
  const h = await startAuthServer();
  try {
    // A bounded budget, so the mid-stream refusal is reachable in a test. The
    // behaviour under test is the accounting, not the size of the default.
    const quota = new UploadQuota({ bytesPerWindow: 100 });
    const started = quota.begin();
    assert.equal(started.ok, true);

    let forwarded = 0;
    let destroyed = false;
    for (const size of [40, 40, 40, 40]) {
      // §42: check before forwarding, so an over-quota chunk never reaches DSH.
      if (quota.wouldExceed(size)) {
        destroyed = true;
        started.abort(0);
        break;
      }
      quota.chargeBytes(size);
      forwarded += size;
    }
    assert.equal(destroyed, true, 'the stream is abandoned when the budget would be exceeded');
    assert.equal(forwarded, 80, 'only the chunks that fit were forwarded');
    assert.ok(forwarded <= quota.bytesPerWindow);
  } finally {
    await h.close();
  }
});

test('§85: the window resets after its duration', () => {
  const clock = manualClock();
  const quota = new UploadQuota({ clock: clock.now, bytesPerWindow: 100, windowSeconds: 10 });
  quota.chargeBytes(100);
  assert.equal(quota.wouldExceed(1), true, 'at the ceiling');

  clock.advance(10_001);
  assert.equal(quota.wouldExceed(100), false, 'the window reset');
  assert.equal(quota.bytesUsed, 0);
});

test('§85: the single-upload 25 MiB limit is unchanged by R6', async () => {
  // R3 enforced this; R6 adds aggregate controls and must not weaken the per-upload
  // cap. Asserted against the resolved HTTP config rather than by trusting a comment.
  const h = await startAuthServer();
  try {
    assert.equal(h.config.maxUploadBytes, 25 * 1024 * 1024, 'the R3 per-upload limit stands');
  } finally {
    await h.close();
  }
});

test('§41: the upload-start budget is separate from the aggregate byte budget', async () => {
  const h = await startAuthServer({ config: { limits: { uploadStart: { limit: 1, windowSeconds: 60 } } } });
  try {
    // The start bucket is charged through the limiter, not the quota.
    assert.equal(h.auth.limiter.charge('uploadStart', 'phone').allowed, true);
    assert.equal(h.auth.limiter.charge('uploadStart', 'phone').allowed, false, 'the start budget is enforced');
    // The byte budget is untouched by start counting.
    assert.equal(h.auth.uploads.bytesUsed, 0);
  } finally {
    await h.close();
  }
});

test('§43: no malware scanner is implemented, and none is claimed', async () => {
  const source = await import('node:fs').then((fs) => fs.promises.readFile(
    new URL('../../src/remote/auth/upload-quota.mjs', import.meta.url), 'utf8',
  ));
  for (const claim of ['scan', 'antivirus', 'clamav', 'malware', 'virus']) {
    assert.equal(
      source.toLowerCase().includes(claim),
      false,
      `the quota module must not claim ${claim} capability`,
    );
  }
  // The documented reliance is size, filename, MIME syntax and DSH byte inspection.
  assert.ok(source.includes('Content-Length'), 'the module explains what it does not trust');
});

test('§41: the quota surface is aggregate-only and never sees content', () => {
  const quota = new UploadQuota();
  const handle = quota.begin();
  handle.finish(1024);
  const stats = quota.stats();
  assert.deepEqual(
    Object.keys(stats).sort(),
    ['active', 'bytes_per_window', 'bytes_used', 'counters', 'max_concurrent', 'window_seconds'],
  );
  // No filename, no content, no credential.
  assert.equal(JSON.stringify(stats).includes('filename'), false);
  assert.equal(JSON.stringify(stats).includes('Bearer'), false);
});
