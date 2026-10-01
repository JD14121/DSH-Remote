/**
 * DSH bootstrap tests — Phase R7 §15, §16, §17, §18, §43, §59.
 *
 * §43 names this the core R7 logging test: a launch token appears in a synthetic DSH
 * stdout line, and the resulting console and log must not contain it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  CookieAuthProvider,
  LAUNCH_TOKEN_PATTERN,
  LaunchTokenParser,
  R7_ERROR,
  cookieNameForAuthority,
  exchangeLaunchToken,
  firstTokenFrom,
  readSetCookie,
  syntheticResponse,
  verifyCookie,
} from './r7-helpers.mjs';

const token = () => crypto.randomBytes(32).toString('base64url');
const announce = (value, lan) => `dsh web: http://127.0.0.1:3080/?token=${value}`
  + (lan === undefined ? '' : ` (LAN: http://192.168.1.5:3080/?token=${lan})`);

test('§16: a launch token has the documented shape', () => {
  const value = token();
  assert.equal(value.length, 43);
  assert.match(value, LAUNCH_TOKEN_PATTERN);
  assert.equal(LAUNCH_TOKEN_PATTERN.test('short'), false);
  assert.equal(LAUNCH_TOKEN_PATTERN.test(`${value}=`), false, 'padding is not base64url');
});

test('§16: the announcement is parsed and its token extracted', () => {
  const value = token();
  const parser = new LaunchTokenParser();
  const result = parser.push(announce(value));
  assert.equal(result.matched, true);
  assert.equal(result.token, value);
  assert.deepEqual(parser.resolve(), { ok: true, token: value });
});

test('§16: a LAN suffix carries the SAME token and is not a second observation', () => {
  const value = token();
  const parser = new LaunchTokenParser();
  parser.push(announce(value, value));
  // The real announcement appends ` (LAN: …?token=…)` with the same token. Reading
  // both would make one launch look like two and trip the distinct-token rule.
  assert.equal(parser.observed.size, 1);
  assert.equal(parser.resolve().ok, true);
});

test('§16: zero announcements is unresolved, not a guess', () => {
  const parser = new LaunchTokenParser();
  parser.push('some unrelated output');
  parser.push('more chatter');
  const decision = parser.resolve();
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /no launch-token announcement/);
});

test('§16: an announcement with no usable token reports the actual problem', () => {
  // The fail-closed path an operator is most likely to hit after a DSH upgrade: the
  // line is still there, but its shape changed. The message should say so rather than
  // claiming nothing was observed.
  const parser = new LaunchTokenParser();
  parser.push('dsh web: opening the default browser; pass --no-open to disable');
  const decision = parser.resolve();
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /no valid launch token was found/);
});

test('§16: two distinct tokens in one launch is unresolved', () => {
  const parser = new LaunchTokenParser();
  parser.push(announce(token()));
  parser.push(announce(token()));
  const decision = parser.resolve();
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /2 distinct launch tokens/);
});

test('§16: a malformed announcement fails closed', () => {
  for (const line of [
    'dsh web: http://127.0.0.1:3080/?token=too-short',
    'dsh web: http://127.0.0.1:3080/?token=',
    'dsh web: not-a-url?token=' + token(),
    'dsh web: http://127.0.0.1:3080/?token=a&token=b',
    'dsh web: http://127.0.0.1:3080/',
  ]) {
    const parser = new LaunchTokenParser();
    parser.push(line);
    assert.equal(parser.resolve().ok, false, `${line} must not resolve`);
  }
});

test('§16: the parser is anchored, so an unrelated 43-char value is ignored', () => {
  const decoy = token();
  const parser = new LaunchTokenParser();
  // Same shape as a launch token, but not in an announcement position.
  parser.push(`some log line mentioning ${decoy} in passing`);
  assert.equal(parser.observed.size, 0);
  assert.equal(parser.resolve().ok, false);
});

test('§16: require() raises the documented unresolved code', () => {
  const parser = new LaunchTokenParser();
  assert.throws(
    () => parser.require(),
    (error) => error.code === R7_ERROR.DSH_BOOTSTRAP_TOKEN_UNRESOLVED,
  );
});

test('§16: the timeout is observable through the injected clock', () => {
  let now = 0;
  const parser = new LaunchTokenParser({ timeoutMs: 1000, clock: () => now });
  assert.equal(parser.expired(), false);
  now = 1001;
  assert.equal(parser.expired(), true);
});

test('§16: firstTokenFrom returns only the first URL token', () => {
  const a = token();
  const b = token();
  assert.equal(firstTokenFrom(`http://127.0.0.1:3080/?token=${a} (LAN: http://x:3080/?token=${b})`), a);
  assert.equal(firstTokenFrom('no url here'), null);
  assert.equal(firstTokenFrom('http://x/?other=1'), null);
});

test('§17: the cookie name is derived from the request authority', () => {
  const name = cookieNameForAuthority('127.0.0.1:3080');
  assert.match(name, /^dsh-auth-[A-Za-z0-9_-]{43}$/);
  // DSH binds the cookie to the authority, so a different authority yields a
  // different name — and a cookie minted for one is not the cookie for the other.
  assert.notEqual(cookieNameForAuthority('localhost:3080'), name);
  assert.notEqual(cookieNameForAuthority('127.0.0.1:3081'), name);
  assert.equal(cookieNameForAuthority('127.0.0.1:3080'), name, 'deterministic');
});

test('§17: readSetCookie finds the exact cookie among several', () => {
  const name = cookieNameForAuthority('127.0.0.1:3080');
  const headers = [`other=1; Path=/`, `${name}=VALUE; Path=/; HttpOnly; SameSite=Strict`];
  assert.equal(readSetCookie(headers, name), 'VALUE');
  assert.equal(readSetCookie([`nope=2`], name), null);
  assert.equal(readSetCookie(undefined, name), null);
  // A prefix-only match must not be accepted.
  assert.equal(readSetCookie([`${name}-extra=VALUE`], name), null);
});

test('§17: a successful exchange returns 303 with the authority cookie', async () => {
  const name = cookieNameForAuthority('127.0.0.1:3080');
  const result = await exchangeLaunchToken({
    launchToken: token(),
    authority: '127.0.0.1:3080',
    port: 3080,
    request: syntheticResponse(303, { 'set-cookie': [`${name}=COOKIEVALUE; Path=/; HttpOnly`] }),
  });
  assert.equal(result.status, 303);
  assert.equal(result.cookie, 'COOKIEVALUE');
  assert.equal(result.cookieName, name);
});

test('§17: a 401 refusal fails with the documented code', async () => {
  await assert.rejects(
    () => exchangeLaunchToken({
      launchToken: token(),
      authority: '127.0.0.1:3080',
      port: 3080,
      request: syntheticResponse(401, {}),
    }),
    (error) => error.code === R7_ERROR.DSH_AUTH_BOOTSTRAP_FAILED,
  );
});

test('§17: a 303 with no cookie is NOT success', async () => {
  // DSH also returns 303 to a caller that already holds a valid cookie, without
  // issuing a new one. Accepting the status alone would report success having
  // obtained nothing.
  await assert.rejects(
    () => exchangeLaunchToken({
      launchToken: token(),
      authority: '127.0.0.1:3080',
      port: 3080,
      request: syntheticResponse(303, {}),
    }),
    (error) => {
      assert.equal(error.code, R7_ERROR.DSH_AUTH_BOOTSTRAP_FAILED);
      assert.match(error.message, /issued no dsh-auth cookie/);
      return true;
    },
  );
});

test('§17: a 303 with a cookie for the WRONG authority is refused', async () => {
  await assert.rejects(
    () => exchangeLaunchToken({
      launchToken: token(),
      authority: '127.0.0.1:3080',
      port: 3080,
      // A cookie named for a different authority is not this authority's cookie.
      request: syntheticResponse(303, { 'set-cookie': [`${cookieNameForAuthority('evil:1')}=X; Path=/`] }),
    }),
    (error) => error.code === R7_ERROR.DSH_AUTH_BOOTSTRAP_FAILED,
  );
});

test('§17: cookie verification proves acceptance by use', async () => {
  const ok = await verifyCookie({
    cookie: 'VALUE',
    cookieName: 'dsh-auth-x',
    port: 3080,
    request: syntheticResponse(200, {}),
  });
  assert.equal(ok.ok, true);

  await assert.rejects(
    () => verifyCookie({
      cookie: 'VALUE',
      cookieName: 'dsh-auth-x',
      port: 3080,
      request: syntheticResponse(401, {}),
    }),
    (error) => error.code === R7_ERROR.DSH_AUTH_BOOTSTRAP_FAILED,
  );
});

test('§18: the auth provider exposes the cookie only through the adapter boundary', () => {
  const provider = new CookieAuthProvider({ cookie: 'SECRET_COOKIE_VALUE', cookieName: 'dsh-auth-x' });
  assert.equal(provider.ready, true);
  assert.equal(provider.header(), 'dsh-auth-x=SECRET_COOKIE_VALUE');

  const headers = {};
  provider.apply(headers);
  assert.equal(headers.cookie, 'dsh-auth-x=SECRET_COOKIE_VALUE');

  // describe() must not leak the value.
  const described = JSON.stringify(provider.describe());
  assert.equal(described.includes('SECRET_COOKIE_VALUE'), false);
  assert.equal(described.includes('dsh-auth-x'), true, 'the name is safe');
});

test('§17: clearing the provider drops the cookie entirely', () => {
  const provider = new CookieAuthProvider({ cookie: 'V', cookieName: 'n' });
  provider.clear();
  assert.equal(provider.ready, false);
  assert.equal(provider.header(), null);
  assert.deepEqual(provider.apply({}), {}, 'nothing is applied when cleared');
});

test('§43: a launch token in synthetic stdout never reaches a log', async () => {
  const { ProductionLogs, makeTempProduction } = await import('./r7-helpers.mjs');
  const { cleanup, config } = makeTempProduction();
  try {
    const logs = new ProductionLogs({ paths: config.paths, secrets: [] });
    const secret = token();

    // Simulate the §15 ordering: read in memory, observe, register for redaction,
    // THEN log.
    logs.supervisor.event('dsh_bootstrap_token_observed', { length: secret.length });
    logs.addSecret(secret);
    logs.supervisor.rawLine(`dsh web: http://127.0.0.1:3080/?token=${secret}`, 'dsh');
    logs.dsh.rawLine(`some later line that happens to contain ${secret}`);
    logs.close();

    for (const file of [config.paths.supervisorLog, config.paths.dshLog]) {
      const text = fs.readFileSync(file, 'utf8');
      assert.equal(text.includes(secret), false, `${file} must not contain the launch token`);
      assert.equal(text.includes('<redacted>'), true, 'and the redaction must be visible');
    }
  } finally {
    cleanup();
  }
});

test('§43: the launch token also never reaches console-style output', async () => {
  const { ProductionLogs, makeTempProduction } = await import('./r7-helpers.mjs');
  const { cleanup, config } = makeTempProduction();
  const written = [];
  const original = process.stdout.write.bind(process.stdout);
  try {
    const logs = new ProductionLogs({ paths: config.paths, secrets: [] });
    const secret = token();
    logs.addSecret(secret);

    // Anything the supervisor would print goes through sanitize first.
    const { sanitize } = await import('../../src/remote/production/logger.mjs');
    process.stdout.write = (chunk, ...rest) => { written.push(String(chunk)); return original(chunk, ...rest); };
    process.stdout.write(JSON.stringify(sanitize({ line: `dsh web: ?token=${secret}` }, [secret])));
    process.stdout.write = original;

    assert.equal(written.join('').includes(secret), false);
  } finally {
    process.stdout.write = original;
    cleanup();
  }
});

test('the parser and provider never write to disk', async () => {
  const bootstrap = await fs.promises.readFile(
    new URL('../../src/remote/production/dsh-bootstrap.mjs', import.meta.url), 'utf8',
  );
  const code = bootstrap.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(code.includes('node:fs'), false, 'the bootstrap module must not touch the filesystem');
  assert.equal(code.includes('writeFile'), false);
});

test('the bootstrap module exports the token pattern for reuse', () => {
  // The supervisor and the parser must agree on the shape without duplicating it.
  assert.equal(typeof LAUNCH_TOKEN_PATTERN.test, 'function');
  assert.equal(LAUNCH_TOKEN_PATTERN.test(token()), true);
});
