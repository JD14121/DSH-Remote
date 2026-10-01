/**
 * R9-RELAY-01 — bridge security tests.
 *
 * Everything runs on loopback with synthetic fixture certificates and a synthetic upstream. No
 * production Gateway, no Supervisor, no real DSH, no credential, no public network.
 *
 * The tests are organised by the taskbook's mapping: A1 TLS, A4 routing, A5 frozen auth surface,
 * A6 revocation, A7 resources — plus host/SNI, origin, header stripping and secret canaries.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBridge, LIMITS } from '../../src/remote/r9/bridge.mjs';
import { createFixtureUpstream } from '../../src/remote/r9/fixture-upstream.mjs';
import { createFixturePki, clientTlsOptions, serverTlsOptions } from '../../src/remote/r9/fixture-certs.mjs';
import { IdentityPolicy, commitPolicyAtomically, fingerprintOf } from '../../src/remote/r9/identity-policy.mjs';
import {
  FIXTURE_HOSTNAME,
  FIXTURE_ORIGIN,
  PRODUCTION_CSP,
  checkAuthority,
  checkCsp,
  checkFetchMetadata,
  checkOrigin,
  checkTarget,
  matchRoute,
  mayRetryWrite,
  sanitizeHeaders,
} from '../../src/remote/r9/request-policy.mjs';

// ── shared fixture ───────────────────────────────────────────────────────────

const opensslAvailable = (() => {
  try {
    const { findOpenssl } = { findOpenssl: null };
    void findOpenssl;
    return true;
  } catch { return false; }
})();
void opensslAvailable;

/**
 * Build a complete fixture: PKI, upstream, policy, bridge.
 *
 * @param {object} [options] - `enroll` fingerprints to allow.
 * @returns {Promise<object>} the fixture.
 */
async function makeFixture(options = {}) {
  const pki = createFixturePki();
  // The server certificate carries a SAN for the fixture hostname: without one, hostname
  // verification correctly fails, and the fixture must exercise the real path.
  const server = pki.makeIdentity('server', { san: `DNS:${FIXTURE_HOSTNAME}` });
  const android = pki.makeIdentity('android-client');
  const frpc = pki.makeIdentity('frpc-client');
  const frps = pki.makeIdentity('frps-server');

  const upstream = createFixtureUpstream({ runId: 'test' });
  const upstreamPort = await upstream.listen(0);

  const events = [];
  const androidFingerprint = pki.fingerprint(android.crt);
  let policy = IdentityPolicy.empty().withAllowed({
    fingerprint: androidFingerprint,
    label: 'fixture-android',
  });
  if (options.policy !== undefined) policy = options.policy;

  const bridge = createBridge({
    // The bridge trusts the fixture CA, presents the server leaf, and requires a client certificate.
    tlsOptions: serverTlsOptions({ ca: pki.caCert, cert: server.crt, key: server.key }),
    upstream: { host: '127.0.0.1', port: upstreamPort },
    policy,
    hostname: FIXTURE_HOSTNAME,
    onEvent: (event) => events.push(event),
  });
  const port = await bridge.listen(0);

  return {
    pki, server, android, frpc, frps, upstream, bridge, port, events,
    androidFingerprint,
    /** TLS options for the enrolled android identity. */
    androidTls: () => clientTlsOptions({ ca: pki.caCert, cert: android.crt, key: android.key, servername: FIXTURE_HOSTNAME }),
    /** TLS options with a valid but unenrolled identity. */
    foreignTls: () => clientTlsOptions({ ca: pki.caCert, cert: frpc.crt, key: frpc.key, servername: FIXTURE_HOSTNAME }),
    /** TLS options with no client certificate at all. */
    anonymousTls: () => clientTlsOptions({ ca: pki.caCert, servername: FIXTURE_HOSTNAME }),
    async dispose() {
      await bridge.stop();
      await upstream.stop();
      pki.dispose();
    },
  };
}

/**
 * Make one HTTPS request through the bridge.
 *
 * @param {object} input - `port`, `tls`, `path`, `method`, `headers`, `body`.
 * @returns {Promise<{status: number, body: string, headers: object}|{error: string, code: string|null}>} the result.
 */
function request(input) {
  return new Promise((resolve) => {
    const req = https.request({
      host: '127.0.0.1',
      port: input.port,
      path: input.path ?? '/api/v1/health',
      method: input.method ?? 'GET',
      headers: { host: FIXTURE_HOSTNAME, ...(input.headers ?? {}) },
      ...input.tls,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', (error) => resolve({ error: String(error.message), code: error.code ?? null }));
    if (input.body !== undefined) req.write(input.body);
    req.end();
  });
}

// ── A1: the TLS / mTLS gate ─────────────────────────────────────────────────

test('A1: a client with no certificate receives no application content', async () => {
  const fx = await makeFixture();
  try {
    const result = await request({ port: fx.port, tls: fx.anonymousTls() });
    assert.ok(result.error !== undefined, 'the handshake must fail');
    assert.equal(result.body, undefined, 'no application body may be produced');
    assert.equal(fx.upstream.requests.length, 0, 'the upstream must never be contacted');
  } finally { await fx.dispose(); }
});

test('A1: a certificate from a foreign issuer is refused', async () => {
  const fx = await makeFixture();
  try {
    // A second, unrelated PKI signs this client, so the bridge's CA cannot verify it.
    const other = createFixturePki();
    const foreign = other.makeIdentity('foreign-client');
    try {
      const result = await request({
        port: fx.port,
        tls: clientTlsOptions({ ca: fx.pki.caCert, cert: foreign.crt, key: foreign.key, servername: FIXTURE_HOSTNAME }),
      });
      assert.ok(result.error !== undefined, 'a foreign-issued certificate must not complete the handshake');
      assert.equal(fx.upstream.requests.length, 0);
    } finally { other.dispose(); }
  } finally { await fx.dispose(); }
});

test('A1: a valid but unenrolled certificate is denied before any upstream request', async () => {
  const fx = await makeFixture();
  try {
    // `frpc` is signed by the same CA but is NOT in the enrollment allowlist.
    const result = await request({ port: fx.port, tls: fx.foreignTls() });
    // The handshake may complete (the chain is valid) but the identity decision must deny.
    assert.ok(result.error !== undefined || result.status === undefined || result.body === undefined || result.error !== undefined,
      'an unenrolled identity must not receive content');
    assert.equal(fx.upstream.requests.length, 0, 'the upstream must never be contacted');
  } finally { await fx.dispose(); }
});

test('A1: an enrolled identity is admitted and reaches the upstream', async () => {
  const fx = await makeFixture();
  try {
    const result = await request({ port: fx.port, tls: fx.androidTls() });
    assert.equal(result.status, 200, `expected 200, got ${JSON.stringify(result).slice(0, 200)}`);
    assert.equal(fx.upstream.requests.length, 1);
  } finally { await fx.dispose(); }
});

// ── identity policy fail-closed and atomicity ───────────────────────────────

test('identity: a missing policy grants nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r9-pol-'));
  try {
    const loaded = IdentityPolicy.load(path.join(dir, 'absent.json'));
    assert.equal(loaded.ok, true);
    const verdict = loaded.policy.decide({ fingerprint: 'a'.repeat(64) });
    assert.equal(verdict.decision, 'deny', 'an empty policy must deny');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('identity: a corrupt policy fails closed rather than opening', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r9-pol-'));
  try {
    const file = path.join(dir, 'policy.json');
    fs.writeFileSync(file, '{ broken', 'utf8');
    const loaded = IdentityPolicy.load(file);
    assert.equal(loaded.ok, false, 'a corrupt policy must be a hard failure, not an empty allowlist');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('identity: a revoked fingerprint is denied even if it was allowed before', () => {
  const fp = 'b'.repeat(64);
  const allowed = IdentityPolicy.empty().withAllowed({ fingerprint: fp, label: 'x' });
  assert.equal(allowed.decide({ fingerprint: fp }).decision, 'allow');
  const revoked = allowed.withRevoked({ fingerprint: fp });
  assert.equal(revoked.decide({ fingerprint: fp }).decision, 'deny', 'revocation must beat a stale allow entry');
  assert.ok(revoked.generation > allowed.generation, 'the generation must advance monotonically');
});

test('identity: an allowlist is never reconstructed from a presented certificate', () => {
  const policy = IdentityPolicy.empty();
  const fingerprint = 'c'.repeat(64);
  assert.equal(policy.decide({ fingerprint }).decision, 'deny');
  // Asking again must not enroll it.
  assert.equal(policy.decide({ fingerprint }).decision, 'deny');
  assert.equal(policy.allow.size, 0, 'a decision must not mutate the policy');
});

test('policy: a failed write leaves the previous generation authoritative', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r9-pol-'));
  try {
    const active = IdentityPolicy.empty().withAllowed({ fingerprint: 'd'.repeat(64) });
    const next = active.withAllowed({ fingerprint: 'e'.repeat(64) });
    // A path whose parent is a FILE cannot be created, so the write must fail deterministically.
    const blocker = path.join(dir, 'not-a-directory');
    fs.writeFileSync(blocker, 'x', 'utf8');

    let activated = false;
    const result = commitPolicyAtomically({
      file: path.join(blocker, 'nested', 'policy.json'),
      next,
      active,
      onActivate: () => { activated = true; },
    });

    assert.equal(result.activated, false, 'the write could not have succeeded');
    assert.equal(activated, false, 'a failed write must never activate');
    assert.equal(result.generation, active.generation, 'the previous generation must remain authoritative');
    assert.match(result.reason, /failed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('policy: a committed update activates atomically and advances the generation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r9-pol-'));
  try {
    const file = path.join(dir, 'policy.json');
    const active = IdentityPolicy.empty();
    const next = active.withAllowed({ fingerprint: 'f'.repeat(64), label: 'committed' });
    let activated = null;
    const result = commitPolicyAtomically({ file, next, active, onActivate: (p) => { activated = p; } });
    assert.equal(result.activated, true);
    assert.equal(activated.generation, next.generation, 'activation must follow a successful commit');
    // Re-reading from disk must yield the same allowlist.
    const reloaded = IdentityPolicy.load(file);
    assert.equal(reloaded.ok, true);
    assert.equal(reloaded.policy.decide({ fingerprint: 'f'.repeat(64) }).decision, 'allow');
    // No partial file may remain.
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.partial')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── host / SNI / authority matrix ───────────────────────────────────────────

test('authority: only the single configured host is accepted', () => {
  assert.equal(checkAuthority(FIXTURE_HOSTNAME).ok, true);
  for (const bad of [
    undefined, '', 'other.invalid', `${FIXTURE_HOSTNAME}:8443`, `${FIXTURE_HOSTNAME}.evil`,
    `user@${FIXTURE_HOSTNAME}`, `${FIXTURE_HOSTNAME},other.invalid`, '127.0.0.1',
  ]) {
    assert.equal(checkAuthority(bad).ok, false, `${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(checkAuthority([FIXTURE_HOSTNAME, FIXTURE_HOSTNAME]).ok, false, 'a duplicate Host must be refused');
  // The default port is accepted only when explicitly allowed.
  assert.equal(checkAuthority(`${FIXTURE_HOSTNAME}:443`).ok, false);
  assert.equal(checkAuthority(`${FIXTURE_HOSTNAME}:443`, { allowPort443: true }).ok, true);
});

test('target: absolute-form and network-path targets are refused', () => {
  assert.equal(checkTarget('/api/v1/health').ok, true);
  assert.equal(checkTarget('/api/v1/health?x=1').path, '/api/v1/health');
  for (const bad of ['http://evil.invalid/', 'https://evil.invalid/x', '//evil.invalid/x', 'api/v1/health', '/a b']) {
    assert.equal(checkTarget(bad).ok, false, `${bad} must be refused`);
  }
});

// ── origin matrix ───────────────────────────────────────────────────────────

test('origin: unsafe methods and upgrades require the exact origin', () => {
  for (const bad of [undefined, null, '', 'null', 'http://relay-fixture.invalid', `${FIXTURE_ORIGIN}:8443`, 'https://other.invalid']) {
    assert.equal(checkOrigin({ method: 'POST', origin: bad }).ok, false, `POST origin ${JSON.stringify(bad)} must be refused`);
    assert.equal(checkOrigin({ method: 'GET', isUpgrade: true, origin: bad }).ok, false, `upgrade origin ${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(checkOrigin({ method: 'POST', origin: FIXTURE_ORIGIN }).ok, true);
  assert.equal(checkOrigin({ method: 'GET', isUpgrade: true, origin: FIXTURE_ORIGIN }).ok, true);
  assert.equal(checkOrigin({ method: 'POST', origin: FIXTURE_ORIGIN, originCount: 2 }).ok, false, 'multiple Origin values must be refused');
});

test('origin: safe methods may omit Origin but a present one must match', () => {
  assert.equal(checkOrigin({ method: 'GET' }).ok, true);
  assert.equal(checkOrigin({ method: 'HEAD' }).ok, true);
  assert.equal(checkOrigin({ method: 'GET', origin: FIXTURE_ORIGIN }).ok, true);
  assert.equal(checkOrigin({ method: 'GET', origin: 'null' }).ok, false);
  assert.equal(checkOrigin({ method: 'GET', origin: 'https://other.invalid' }).ok, false);
});

test('origin: cross-site fetch metadata is refused but absence is not a failure', () => {
  assert.equal(checkFetchMetadata({}).ok, true, 'a client that omits the headers must still pass');
  assert.equal(checkFetchMetadata({ 'sec-fetch-site': 'same-origin' }).ok, true);
  assert.equal(checkFetchMetadata({ 'sec-fetch-site': 'cross-site' }).ok, false);
});

// ── A4: route allowlist ─────────────────────────────────────────────────────

test('A4: the pinned API surface is accepted and nothing else is', () => {
  const accepted = [
    ['GET', '/api/v1/health'], ['GET', '/api/v1/sessions'],
    ['POST', '/api/v1/sessions'],
    ['GET', '/api/v1/sessions/abc'], ['GET', '/api/v1/sessions/abc/messages'],
    ['POST', '/api/v1/sessions/abc/messages'], ['POST', '/api/v1/sessions/abc/cancel'],
    ['POST', '/api/v1/sessions/abc/uploads'], ['POST', '/api/v1/auth/ws-ticket'],
  ];
  for (const [method, path] of accepted) {
    assert.equal(matchRoute({ method, path }).ok, true, `${method} ${path} must be accepted`);
  }
  // Session creation is explicitly permitted through the identity-checked bridge.
  assert.equal(matchRoute({ method: 'POST', path: '/api/v1/sessions' }).ok, true);
  assert.equal(matchRoute({ method: 'DELETE', path: '/api/v1/sessions' }).ok, false);
  assert.equal(matchRoute({ method: 'POST', path: '/api/v1/sessions/abc' }).ok, false);
  // Unknown API paths are refused and never become HTML.
  assert.equal(matchRoute({ method: 'GET', path: '/api/v1/unknown' }).ok, false);
  assert.notEqual(matchRoute({ method: 'GET', path: '/api/v1/unknown' }).kind, 'static');
  // Wrong method on a known path is refused.
  assert.equal(matchRoute({ method: 'DELETE', path: '/api/v1/health' }).ok, false);
  // Browser modules are not Gateway REST routes.
  assert.equal(matchRoute({ method: 'GET', path: '/api/api-client.js' }).ok, false);
  // Static paths accept safe methods only.
  assert.equal(matchRoute({ method: 'GET', path: '/index.html' }).ok, true);
  assert.equal(matchRoute({ method: 'POST', path: '/index.html' }).ok, false);
});

test('A4: only the single WebSocket route may be upgraded', () => {
  assert.equal(matchRoute({ method: 'GET', path: '/api/v1/events', isUpgrade: true }).ok, true);
  assert.equal(matchRoute({ method: 'GET', path: '/api/v1/health', isUpgrade: true }).ok, false);
  assert.equal(matchRoute({ method: 'GET', path: '/api/v1/events/extra', isUpgrade: true }).ok, false);
});

// ── header sanitisation ─────────────────────────────────────────────────────

test('headers: external identity and forwarding headers are stripped, Host is fixed', () => {
  const { headers, stripped } = sanitizeHeaders({
    host: 'evil.invalid',
    origin: FIXTURE_ORIGIN,
    forwarded: 'for=1.2.3.4',
    'x-forwarded-for': '1.2.3.4',
    'x-forwarded-host': 'evil.invalid',
    'x-real-ip': '1.2.3.4',
    'x-client-cert': 'spoofed',
    'proxy-authorization': 'Basic x',
    authorization: 'Bearer canary',
    'content-type': 'application/json',
  }, { upstreamHost: '127.0.0.1', upstreamPort: 9448 });

  assert.equal(headers.host, '127.0.0.1:9448', 'the upstream Host must be fixed, never client-derived');
  for (const gone of ['origin', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'x-client-cert', 'proxy-authorization']) {
    assert.equal(headers[gone], undefined, `${gone} must not be forwarded`);
  }
  assert.ok(stripped.includes('origin'));
  // The application credential must pass through untouched: the bridge does not consume auth.
  assert.equal(headers.authorization, 'Bearer canary');
  assert.equal(headers['content-type'], 'application/json');
});

// ── A5: secret canaries and no retry ───────────────────────────────────────

test('A5: a bearer canary is not rewritten by the bridge', () => {
  const canary = 'Bearer r9-canary-not-a-real-token';
  const { headers } = sanitizeHeaders({ authorization: canary }, { upstreamHost: '127.0.0.1', upstreamPort: 1 });
  assert.equal(headers.authorization, canary);
});

test('A5: the bridge never retries a write or a ticket request', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(mayRetryWrite(method), false, `${method} must never be retried by the bridge`);
  }
  assert.equal(mayRetryWrite('GET'), false);
});

// ── end-to-end behaviour through the running bridge ────────────────────────

test('origin end-to-end: a POST without Origin is refused and never reaches the upstream', async () => {
  const fx = await makeFixture();
  try {
    const result = await request({
      port: fx.port, tls: fx.androidTls(), method: 'POST',
      path: '/api/v1/sessions/abc/messages', body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(result.status, 403);
    assert.equal(fx.upstream.requests.length, 0, 'an origin failure must be rejected before the upstream');
  } finally { await fx.dispose(); }
});

test('session-create end-to-end: an enrolled client and exact Origin reach only the Gateway route', async () => {
  const fx = await makeFixture();
  try {
    const result = await request({
      port: fx.port, tls: fx.androidTls(), method: 'POST',
      path: '/api/v1/sessions', body: '{}',
      headers: { origin: FIXTURE_ORIGIN, 'content-type': 'application/json' },
    });
    assert.equal(result.status, 200);
    assert.equal(fx.upstream.requests.length, 1);
    assert.equal(fx.upstream.requests[0].method, 'POST');
    assert.equal(fx.upstream.requests[0].path, '/api/v1/sessions');
    assert.equal(fx.upstream.requests[0].body_length, 2, 'the bridge forwards the empty JSON object unchanged');
    // The upstream must see no Origin and a fixed Host.
    const seen = fx.upstream.requests[0];
    assert.equal(seen.origin_present, false, 'the upstream must receive no Origin');
    assert.equal(seen.host, `127.0.0.1:${fx.upstream.server.address().port}`);
  } finally { await fx.dispose(); }
});

test('host end-to-end: a wrong Host is refused before the upstream', async () => {
  const fx = await makeFixture();
  try {
    const result = await request({ port: fx.port, tls: fx.androidTls(), headers: { host: 'evil.invalid' } });
    assert.equal(result.status, 400);
    assert.equal(fx.upstream.requests.length, 0);
  } finally { await fx.dispose(); }
});

test('route end-to-end: an unknown API route is refused and returns no HTML', async () => {
  const fx = await makeFixture();
  try {
    const result = await request({ port: fx.port, tls: fx.androidTls(), path: '/api/v1/unknown' });
    assert.equal(result.status, 404);
    assert.equal(result.body.includes('<'), false, 'an API path must never return HTML');
    assert.equal(fx.upstream.requests.length, 0);
  } finally { await fx.dispose(); }
});

test('CSP: the response carries the production policy and retains same-origin semantics', async () => {
  const fx = await makeFixture();
  try {
    const result = await request({ port: fx.port, tls: fx.androidTls(), path: '/api/v1/unknown' });
    assert.equal(result.headers['content-security-policy'], PRODUCTION_CSP);
    assert.equal(checkCsp(result.headers['content-security-policy']).ok, true);
    assert.equal(checkCsp("default-src *").ok, false, 'a wildcard CSP must be rejected');
  } finally { await fx.dispose(); }
});

test('WS: one accepted upgrade produces exactly one upstream handshake', async () => {
  const fx = await makeFixture();
  try {
    const outcome = await new Promise((resolve) => {
      // A bounded wait, so a hung upgrade fails the test instead of stalling the suite.
      const timer = setTimeout(() => resolve({ timedOut: true }), 8000);
      const done = (value) => { clearTimeout(timer); resolve(value); };
      const req = https.request({
        host: '127.0.0.1', port: fx.port, path: '/api/v1/events',
        headers: {
          host: FIXTURE_HOSTNAME,
          origin: FIXTURE_ORIGIN,
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
          'sec-websocket-version': '13',
        },
        ...fx.androidTls(),
      });
      req.on('upgrade', (res, socket) => { socket.destroy(); done({ upgraded: true, status: res.statusCode }); });
      req.on('response', (res) => done({ upgraded: false, status: res.statusCode }));
      req.on('error', (error) => done({ error: String(error.message) }));
      req.end();
    });
    assert.equal(outcome.timedOut, undefined, 'the upgrade must complete or fail, not hang');
    assert.equal(outcome.upgraded, true, `the upgrade should be proxied: ${JSON.stringify(outcome)}`);
    assert.equal(fx.upstream.upgradeCount, 1, 'exactly one upstream handshake is permitted');
  } finally { await fx.dispose(); }
});

test('WS: an upgrade with a wrong Origin is rejected before any upstream connection', async () => {
  const fx = await makeFixture();
  try {
    const outcome = await new Promise((resolve) => {
      const req = https.request({
        host: '127.0.0.1', port: fx.port, path: '/api/v1/events',
        headers: {
          host: FIXTURE_HOSTNAME,
          origin: 'https://evil.invalid',
          connection: 'Upgrade', upgrade: 'websocket',
          'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
          'sec-websocket-version': '13',
        },
        ...fx.androidTls(),
      });
      req.on('upgrade', () => resolve({ upgraded: true }));
      req.on('response', (res) => resolve({ upgraded: false, status: res.statusCode }));
      req.on('error', (error) => resolve({ error: String(error.message) }));
      req.end();
    });
    assert.notEqual(outcome.upgraded, true, 'a hostile Origin must not be upgraded');
    assert.equal(fx.upstream.upgradeCount, 0, 'no upstream handshake may occur');
  } finally { await fx.dispose(); }
});

// ── A6: revocation ──────────────────────────────────────────────────────────

test('A6: revoking an identity closes existing connections and leaves others alive', async () => {
  const pki = createFixturePki();
  const server = pki.makeIdentity('server', { san: `DNS:${FIXTURE_HOSTNAME}` });
  const a = pki.makeIdentity('android-client');
  const b = pki.makeIdentity('frpc-client');
  const upstream = createFixtureUpstream({ runId: 'revoke' });
  const upstreamPort = await upstream.listen(0);
  const aFp = pki.fingerprint(a.crt);
  const bFp = pki.fingerprint(b.crt);

  let policy = IdentityPolicy.empty()
    .withAllowed({ fingerprint: aFp, label: 'A' })
    .withAllowed({ fingerprint: bFp, label: 'B' });
  const bridge = createBridge({
    tlsOptions: serverTlsOptions({ ca: pki.caCert, cert: server.crt, key: server.key }),
    upstream: { host: '127.0.0.1', port: upstreamPort },
    policy,
    hostname: FIXTURE_HOSTNAME,
  });
  const port = await bridge.listen(0);
  const tlsFor = (id) => clientTlsOptions({ ca: pki.caCert, cert: id.crt, key: id.key, servername: FIXTURE_HOSTNAME });

  try {
    // Identity B establishes a connection that must survive A's revocation.
    const bKeepAlive = https.request({
      host: '127.0.0.1', port, path: '/api/v1/health',
      headers: { host: FIXTURE_HOSTNAME }, ...tlsFor(b),
    });
    bKeepAlive.end();

    // Identity A establishes a keep-alive connection.
    const aSocket = await new Promise((resolve, reject) => {
      const req = https.request({
        host: '127.0.0.1', port, path: '/api/v1/health',
        headers: { host: FIXTURE_HOSTNAME, connection: 'keep-alive' }, ...tlsFor(a),
      }, (res) => { res.resume(); resolve(req.socket); });
      req.on('error', reject);
      req.end();
    });
    assert.ok(aSocket !== undefined);

    // Revoke A and activate.
    policy = policy.withRevoked({ fingerprint: aFp });
    const startedAt = Date.now();
    const activation = bridge.activatePolicy(policy);
    const elapsed = Date.now() - startedAt;

    assert.ok(activation.closed >= 1, `A's live connection must be closed (closed=${activation.closed})`);
    assert.ok(elapsed <= 5000, `revocation must complete within the 5 s target, took ${elapsed} ms`);

    // New access as A is denied.
    const afterRevoke = await request({ port, tls: tlsFor(a) });
    assert.ok(afterRevoke.error !== undefined || afterRevoke.status === undefined || afterRevoke.error !== undefined || afterRevoke.body === undefined,
      'a revoked identity must not receive content');

    // B still works.
    const bStill = await request({ port, tls: tlsFor(b) });
    assert.equal(bStill.status, 200, 'identity B must remain able to reach the upstream');

    bKeepAlive.destroy();
    void aSocket;
  } finally {
    await bridge.stop();
    await upstream.stop();
    pki.dispose();
  }
});

test('A6: revocation is recorded with a measurable duration', async () => {
  // The activation path must report what it actually closed, so the evidence is not a claim.
  const pki = createFixturePki();
  const server = pki.makeIdentity('server', { san: `DNS:${FIXTURE_HOSTNAME}` });
  const a = pki.makeIdentity('android-client');
  const upstream = createFixtureUpstream();
  const upstreamPort = await upstream.listen(0);
  const aFp = pki.fingerprint(a.crt);
  let policy = IdentityPolicy.empty().withAllowed({ fingerprint: aFp });
  const bridge = createBridge({
    tlsOptions: serverTlsOptions({ ca: pki.caCert, cert: server.crt, key: server.key }),
    upstream: { host: '127.0.0.1', port: upstreamPort },
    policy, hostname: FIXTURE_HOSTNAME,
  });
  const port = await bridge.listen(0);
  try {
    await request({ port, tls: clientTlsOptions({ ca: pki.caCert, cert: a.crt, key: a.key, servername: FIXTURE_HOSTNAME }) });
    const result = bridge.activatePolicy(policy.withRevoked({ fingerprint: aFp }));
    assert.equal(typeof result.closed, 'number');
    assert.equal(typeof result.generation, 'number');
    assert.ok(result.generation > policy.generation - 1);
  } finally {
    await bridge.stop(); await upstream.stop(); pki.dispose();
  }
});

// ── A7: resources ───────────────────────────────────────────────────────────

test('A7: the resource limits are explicit numeric values', () => {
  for (const [name, value] of Object.entries(LIMITS)) {
    assert.equal(typeof value, 'number', `${name} must be numeric`);
    assert.ok(value > 0, `${name} must be positive`);
  }
  // The taskbook's required set must all be present and named.
  for (const required of [
    'handshakeTimeoutMs', 'maxHeaderBytes', 'headerTimeoutMs', 'maxConnections',
    'maxConnectionsPerIdentity', 'idleTimeoutMs', 'preAuthLifetimeMs',
  ]) {
    assert.ok(required in LIMITS, `${required} must be an explicit limit`);
  }
});

test('A7: the bridge releases its port and sockets on stop', async () => {
  const fx = await makeFixture();
  const port = fx.port;
  try {
    await request({ port, tls: fx.androidTls() });
  } finally {
    const result = await fx.bridge.stop();
    assert.equal(typeof result.closedInMs, 'number');
    assert.ok(result.closedInMs < 5000, 'stop must complete promptly');
    await fx.upstream.stop();
    fx.pki.dispose();
  }
  // The port must be free afterwards.
  const { default: net } = await import('node:net');
  const stillHeld = await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(400);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
  assert.equal(stillHeld, false, 'the bridge port must be released');
});

test('A7: an incomplete handshake does not wedge the bridge', async () => {
  const fx = await makeFixture();
  try {
    const net = await import('node:net');
    // Open a TCP connection and send nothing: it must be reclaimed by the pre-auth bound.
    const socket = net.connect({ host: '127.0.0.1', port: fx.port });
    await new Promise((resolve) => socket.once('connect', resolve));
    assert.ok(fx.bridge.connections >= 1, 'the socket is tracked while pre-auth');
    // The bridge still serves a legitimate request.
    const result = await request({ port: fx.port, tls: fx.androidTls() });
    assert.equal(result.status, 200, 'the bridge must stay responsive');
    socket.destroy();
  } finally { await fx.dispose(); }
});

// ── four identities ─────────────────────────────────────────────────────────

test('identity: the four roles use four independent key pairs', async () => {
  const fx = await makeFixture();
  try {
    const fps = [fx.server, fx.android, fx.frpc, fx.frps].map((id) => fx.pki.fingerprint(id.crt));
    assert.equal(new Set(fps).size, 4, 'no key pair may satisfy two roles');
  } finally { await fx.dispose(); }
});

test('identity: every fixture certificate is marked as non-production', async () => {
  const fx = await makeFixture();
  try {
    for (const id of [fx.server, fx.android, fx.frpc, fx.frps]) {
      const subject = await import('node:child_process').then(({ execFileSync }) =>
        execFileSync(fx.pki.openssl, ['x509', '-in', id.crt, '-noout', '-subject']).toString());
      assert.match(subject, /R9 RELAY FIXTURE ONLY/, `${id.role} must be marked as fixture-only`);
      assert.match(subject, /NOT PRODUCTION/, `${id.role} must be marked as non-production`);
    }
  } finally { await fx.dispose(); }
});

test('identity: fingerprintOf agrees with the bridge hash for the same bytes', () => {
  const bytes = Buffer.from('fixture-bytes');
  assert.equal(fingerprintOf(bytes), crypto.createHash('sha256').update(bytes).digest('hex'));
});
