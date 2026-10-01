/**
 * Rate-limit tests — Phase R6 §34, §35, §36, §63, §83.
 *
 * §34's constraint shapes everything: the remote IP must **not** be the principal,
 * because behind an SSH or Tailscale tunnel every caller looks like `127.0.0.1`. The
 * authenticated key is `principal_id`; the unauthenticated key is the remote socket
 * identity plus a global backstop.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTH_ERROR,
  DEFAULT_LIMITS,
  RateLimiter,
  SESSION,
  generateSyntheticToken,
  remoteIdentity,
  request,
  resolveLimits,
  startAuthServer,
} from './r6-helpers.mjs';

/** A manual clock, so window tests never sleep (§65). */
function manualClock(start = 1_789_800_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

test('§35: the documented defaults are the resolved defaults', () => {
  const limits = resolveLimits();
  assert.equal(limits.read.limit, 120);
  assert.equal(limits.read.windowSeconds, 60);
  assert.equal(limits.mutation.limit, 30);
  assert.equal(limits.ticket.limit, 20);
  assert.equal(limits.failedAuth.limit, 10);
  assert.equal(limits.failedAuthGlobal.limit, 100);
  assert.equal(limits.uploadStart.limit, 10);
});

test('§35: limits are validated and bounded', () => {
  for (const bad of [{ read: { limit: 0 } }, { read: { limit: -1 } }, { read: { limit: 1.5 } }, { read: { windowSeconds: 0 } }]) {
    assert.throws(
      () => resolveLimits(bad),
      (error) => error.code === AUTH_ERROR.CONFIG_INVALID,
      `${JSON.stringify(bad)} must be refused`,
    );
  }
  assert.throws(() => resolveLimits({ notABucket: { limit: 1 } }), (error) => error.code === AUTH_ERROR.CONFIG_INVALID);
});

test('§83: a bucket charges, refuses past its limit, and reports Retry-After', () => {
  const clock = manualClock();
  const limiter = new RateLimiter({ clock: clock.now, limits: { read: { limit: 3, windowSeconds: 60 } } });

  for (let index = 0; index < 3; index += 1) {
    assert.equal(limiter.charge('read', 'phone').allowed, true, `request ${index} allowed`);
  }
  const refused = limiter.charge('read', 'phone');
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfter >= 1 && refused.retryAfter <= 60, 'a Retry-After within the window');

  // §83: a window reset restores the budget.
  clock.advance(60_001);
  assert.equal(limiter.charge('read', 'phone').allowed, true, 'the window reset');
});

test('§35: read and mutation budgets are independent', () => {
  const clock = manualClock();
  const limiter = new RateLimiter({
    clock: clock.now,
    limits: { read: { limit: 2, windowSeconds: 60 }, mutation: { limit: 1, windowSeconds: 60 } },
  });
  assert.equal(limiter.charge('read', 'phone').allowed, true);
  assert.equal(limiter.charge('read', 'phone').allowed, true);
  assert.equal(limiter.charge('read', 'phone').allowed, false, 'reads are exhausted');
  // A burst of reads must not consume the mutation allowance.
  assert.equal(limiter.charge('mutation', 'phone').allowed, true, 'the mutation budget is untouched');
  assert.equal(limiter.charge('mutation', 'phone').allowed, false);
});

test('§83: principals are isolated, and the key is never the credential', () => {
  const clock = manualClock();
  const limiter = new RateLimiter({
    clock: clock.now,
    limits: { read: { limit: 1, windowSeconds: 60 }, failedAuth: { limit: 1, windowSeconds: 60 } },
  });
  assert.equal(limiter.charge('read', 'phone').allowed, true);
  assert.equal(limiter.charge('read', 'phone').allowed, false);
  // Another identity has its own budget.
  assert.equal(limiter.charge('read', 'other-principal').allowed, true, 'principals are isolated');

  // §83: the implementation must not use the token as a Map key.
  const keys = [...limiter.windows.keys()];
  assert.equal(keys.every((key) => !key.includes('Bearer')), true);
  assert.equal(keys.every((key) => key.includes('\u0000')), true, 'keys are bucket\u0000identity');
});

test('§34: the remote identity is derived from the socket, not the credential', () => {
  assert.equal(remoteIdentity({ remoteAddress: '127.0.0.1', remotePort: 51000 }), '127.0.0.1:51000');
  assert.equal(remoteIdentity({ remoteAddress: '127.0.0.1' }), '127.0.0.1');
  assert.equal(remoteIdentity(undefined), 'unknown');
  // Two loopback callers are not collapsed into one bucket, which would let a single
  // abuser exhaust everyone's budget.
  assert.notEqual(
    remoteIdentity({ remoteAddress: '127.0.0.1', remotePort: 1 }),
    remoteIdentity({ remoteAddress: '127.0.0.1', remotePort: 2 }),
  );
});

test('§36: exceeding a limit is 429 RATE_LIMITED with Retry-After', async () => {
  const h = await startAuthServer({
    config: { limits: { read: { limit: 2, windowSeconds: 60 } } },
  });
  try {
    assert.equal((await h.get('/api/v1/sessions')).status, 200);
    assert.equal((await h.get('/api/v1/sessions')).status, 200);

    const refused = await h.get('/api/v1/sessions');
    assert.equal(refused.status, 429);
    assert.equal(refused.body.error.code, AUTH_ERROR.RATE_LIMITED);
    assert.ok(Number(refused.headers['retry-after']) >= 1, 'Retry-After is present');
  } finally {
    await h.close();
  }
});

test('§36: a rate-limit response never echoes the credential or a fingerprint', async () => {
  const h = await startAuthServer({ config: { limits: { read: { limit: 1, windowSeconds: 60 } } } });
  try {
    await h.get('/api/v1/sessions');
    const refused = await h.get('/api/v1/sessions');
    const text = `${refused.text}\n${JSON.stringify(refused.headers)}`;
    assert.equal(text.includes(h.token), false, 'the token must not appear');
    assert.equal(text.includes(h.token.slice(0, 8)), false, 'nor a prefix');
  } finally {
    await h.close();
  }
});

test('§37: failed authentication is charged, and an exhausted budget reports 429', async () => {
  const h = await startAuthServer({
    config: { limits: { failedAuth: { limit: 3, windowSeconds: 60 }, failedAuthGlobal: { limit: 100, windowSeconds: 60 } } },
  });
  try {
    const bad = { authorization: `Bearer ${generateSyntheticToken()}` };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const res = await request(h.baseUrl, '/api/v1/sessions', { headers: bad });
      assert.equal(res.status, 401, `attempt ${attempt} is a plain 401 while budget remains`);
    }
    // Past the budget the answer changes to 429, so a brute-force loop is throttled
    // rather than being told "wrong" indefinitely.
    const exhausted = await request(h.baseUrl, '/api/v1/sessions', { headers: bad });
    assert.equal(exhausted.status, 429);
    assert.equal(exhausted.body.error.code, AUTH_ERROR.RATE_LIMITED);
  } finally {
    await h.close();
  }
});

test('§34: the global failed-auth backstop catches a caller changing source port', async () => {
  const h = await startAuthServer({
    config: {
      limits: {
        // A generous per-identity budget so the global one is what trips.
        failedAuth: { limit: 1000, windowSeconds: 60 },
        failedAuthGlobal: { limit: 4, windowSeconds: 60 },
      },
    },
  });
  try {
    const bad = { authorization: `Bearer ${generateSyntheticToken()}` };
    const statuses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push((await request(h.baseUrl, '/api/v1/sessions', { headers: bad })).status);
    }
    assert.ok(statuses.includes(429), `the global bucket must trip, saw ${statuses.join(',')}`);
  } finally {
    await h.close();
  }
});

test('§35: the ticket-mint budget is separate from reads', async () => {
  const h = await startAuthServer({ config: { limits: { ticket: { limit: 2, windowSeconds: 60 }, read: { limit: 100, windowSeconds: 60 } } } });
  try {
    assert.equal((await h.post('/api/v1/auth/ws-ticket', { session_id: SESSION })).status, 201);
    assert.equal((await h.post('/api/v1/auth/ws-ticket', { session_id: SESSION })).status, 201);
    const refused = await h.post('/api/v1/auth/ws-ticket', { session_id: SESSION });
    assert.equal(refused.status, 429);
    // Reads still work: the ticket bucket is independent.
    assert.equal((await h.get('/api/v1/sessions')).status, 200);
  } finally {
    await h.close();
  }
});

test('§63: rate-limit state is memory-only and a restart resets it', async () => {
  const first = await startAuthServer({ config: { limits: { read: { limit: 1, windowSeconds: 60 } } } });
  const token = first.token;
  try {
    assert.equal((await first.get('/api/v1/sessions')).status, 200);
    assert.equal((await first.get('/api/v1/sessions')).status, 429, 'exhausted');
  } finally {
    await first.close();
  }

  // A new process with the same credential starts with a fresh budget.
  const second = await startAuthServer({ token, config: { limits: { read: { limit: 1, windowSeconds: 60 } } } });
  try {
    assert.equal((await second.get('/api/v1/sessions')).status, 200, 'limits reset on restart');
  } finally {
    await second.close();
  }
});

test('§63: the limiter never writes to the durable journal', async () => {
  const source = await import('node:fs').then((fs) => fs.promises.readFile(
    new URL('../../src/remote/auth/rate-limit.mjs', import.meta.url), 'utf8',
  ));
  for (const banned of ['node:fs', 'writeFile', 'appendFile', 'persistence', 'journal']) {
    assert.equal(source.includes(banned), false, `the limiter must not touch ${banned}`);
  }
});

test('§83: cleanup drops expired windows so the map cannot grow unbounded', () => {
  const clock = manualClock();
  const limiter = new RateLimiter({ clock: clock.now, limits: { read: { limit: 1, windowSeconds: 10 } } });
  for (let index = 0; index < 50; index += 1) limiter.charge('read', `identity-${index}`);
  assert.equal(limiter.windows.size, 50);
  clock.advance(10_001);
  assert.equal(limiter.cleanup(), 50);
  assert.equal(limiter.windows.size, 0);
});

test('every documented bucket exists', () => {
  assert.deepEqual(
    Object.keys(DEFAULT_LIMITS).sort(),
    ['failedAuth', 'failedAuthGlobal', 'mutation', 'read', 'ticket', 'uploadStart'],
  );
});
