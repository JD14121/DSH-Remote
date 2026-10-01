/**
 * R9-RELAY-01A — TLS resumption closure and connection-identity isolation.
 *
 * Two controls are proven here by active test rather than by configuration reading:
 *
 * 1. **Session resumption cannot bypass revocation.** A session is genuinely captured from a real
 *    handshake, then replayed after the identity is revoked. TLS 1.2 and TLS 1.3 are both attempted
 *    over raw `tls.connect`, so `getSession`/`setSession`/`isSessionReused` are exercised directly —
 *    reading `sessionTimeout: 0` would prove nothing about stateless TLS 1.3 tickets.
 * 2. **Identity state is per-connection, never keyed by source IP.** Two different identities connect
 *    concurrently from `127.0.0.1`; revoking one must not disturb the other.
 */

import assert from 'node:assert/strict';
import tls from 'node:tls';
import test from 'node:test';

import { createBridge, hardenTlsOptions, NO_TICKET_OPTION } from '../../src/remote/r9/bridge.mjs';
import { createFixtureUpstream } from '../../src/remote/r9/fixture-upstream.mjs';
import { createFixturePki, serverTlsOptions, clientTlsOptions } from '../../src/remote/r9/fixture-certs.mjs';
import { IdentityPolicy } from '../../src/remote/r9/identity-policy.mjs';

const HOST = 'relay-fixture.invalid';

/**
 * Build a two-identity fixture: PKI, upstream, bridge with A and B enrolled.
 *
 * @param {object} [options] - `minVersion`.
 * @returns {Promise<object>} the fixture.
 */
async function makeFixture(options = {}) {
  const pki = createFixturePki();
  const server = pki.makeIdentity('server', { san: `DNS:${HOST}` });
  const a = pki.makeIdentity('android-client');
  const b = pki.makeIdentity('frpc-client');

  const upstream = createFixtureUpstream({ runId: 'resumption' });
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
    hostname: HOST,
  });
  const port = await bridge.listen(0);

  return {
    pki, a, b, aFp, bFp, upstream, bridge, port,
    /** Revoke A and activate the new policy. */
    revokeA() {
      policy = policy.withRevoked({ fingerprint: aFp });
      return bridge.activatePolicy(policy);
    },
    tlsFor: (id, extra = {}) => ({
      ...clientTlsOptions({ ca: pki.caCert, cert: id.crt, key: id.key, servername: HOST }),
      ...extra,
    }),
    async dispose() {
      await bridge.stop();
      await upstream.stop();
      pki.dispose();
    },
  };
}

/**
 * Open a raw TLS connection, optionally seeding a session, and report what happened.
 *
 * @param {object} input - `port`, `tlsOptions`, `session`, `request`.
 * @returns {Promise<object>} the outcome.
 */
function rawTls(input) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ stage: 'timeout' }), 8000);
    const done = (value) => { clearTimeout(timer); resolve(value); };
    const socket = tls.connect({
      host: '127.0.0.1',
      port: input.port,
      ...input.tlsOptions,
      ...(input.session === undefined ? {} : { session: input.session }),
    });

    socket.once('secureConnect', () => {
      const result = {
        authorized: socket.authorized,
        reused: socket.isSessionReused(),
        protocol: socket.getProtocol(),
        session: socket.getSession(),
      };
      if (input.request === true) {
        socket.write(`GET /api/v1/health HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`);
        let body = '';
        socket.on('data', (chunk) => { body += chunk.toString('latin1'); });
        socket.on('end', () => done({ ...result, response: body.split('\r\n')[0] ?? '', body }));
        socket.on('close', () => done({ ...result, response: body.split('\r\n')[0] ?? '', body }));
      } else {
        socket.end();
        done(result);
      }
    });
    socket.once('error', (error) => done({ stage: 'error', code: error.code ?? null, message: String(error.message).slice(0, 90) }));
  });
}

// ── the control itself ──────────────────────────────────────────────────────

test('01A: SSL_OP_NO_TICKET is applied to the bridge TLS context', () => {
  // The mechanism is asserted, not just `sessionTimeout`.
  assert.equal(typeof NO_TICKET_OPTION, 'number');
  assert.ok(NO_TICKET_OPTION > 0, 'the OpenSSL option must be a real bit');
  const hardened = hardenTlsOptions({ cert: 'x', key: 'y' });
  assert.ok((hardened.secureOptions & NO_TICKET_OPTION) === NO_TICKET_OPTION,
    'the no-ticket option must be present in secureOptions');
  assert.equal(hardened.sessionTimeout, 0, 'sessionTimeout is retained as defence in depth only');
});

test('01A: a caller-supplied secureOptions is preserved, not overwritten', () => {
  const existing = 0b1000;
  const hardened = hardenTlsOptions({ secureOptions: existing });
  assert.ok((hardened.secureOptions & existing) === existing, 'other options must survive');
  assert.ok((hardened.secureOptions & NO_TICKET_OPTION) === NO_TICKET_OPTION);
});

// ── TLS 1.2 resumption attempt ──────────────────────────────────────────────

test('01A TLS1.2: a captured session is not resumed after revocation', async () => {
  const fx = await makeFixture();
  try {
    // 1. establish a valid connection and capture whatever session state exists
    const first = await rawTls({ port: fx.port, tlsOptions: fx.tlsFor(fx.a, { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' }) });
    assert.equal(first.authorized, true, `the first handshake must succeed: ${JSON.stringify(first)}`);
    assert.equal(first.reused, false, 'a first connection cannot be a resumption');
    const captured = first.session;
    assert.ok(captured !== undefined && captured !== null, 'the client should hold session state to replay');

    // 2. revoke A
    fx.revokeA();

    // 3. explicitly attempt to resume with the saved session
    const resumed = await rawTls({
      port: fx.port,
      tlsOptions: fx.tlsFor(fx.a, { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' }),
      session: captured,
      request: true,
    });

    // 4. the session must not be reused, and no application content may be delivered
    if (resumed.stage === 'error') {
      assert.ok(true, 'a refused handshake is an acceptable outcome');
    } else {
      assert.equal(resumed.reused, false, 'the session must NOT be resumed after revocation');
      assert.ok(!String(resumed.response ?? '').includes('200'), 'no application content may be served');
    }
    // Regardless of the TLS outcome, the identity gate must have blocked the upstream.
    assert.equal(fx.upstream.requests.length, 0, 'no request from the revoked identity may reach the upstream');
  } finally { await fx.dispose(); }
});

test('01A TLS1.2: an enrolled identity can still connect normally', async () => {
  const fx = await makeFixture();
  try {
    const result = await rawTls({
      port: fx.port,
      tlsOptions: fx.tlsFor(fx.b, { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' }),
      request: true,
    });
    assert.equal(result.authorized, true);
    assert.ok(String(result.response).includes('200'), `B must still get 200, saw ${result.response}`);
    assert.equal(fx.upstream.requests.length, 1);
  } finally { await fx.dispose(); }
});

// ── TLS 1.3 resumption attempt ──────────────────────────────────────────────

test('01A TLS1.3: an old ticket cannot regain access after revocation', async () => {
  const fx = await makeFixture();
  try {
    const first = await rawTls({ port: fx.port, tlsOptions: fx.tlsFor(fx.a, { minVersion: 'TLSv1.3' }) });
    assert.equal(first.authorized, true, `the TLS1.3 handshake must succeed: ${JSON.stringify(first)}`);
    assert.equal(first.protocol, 'TLSv1.3', 'the protocol must actually be TLS 1.3');
    const ticket = first.session;

    fx.revokeA();

    const outcome = ticket === undefined || ticket === null
      // No ticket issued at all is itself the required proof for this branch.
      ? { reused: false, noTicket: true }
      : await rawTls({
        port: fx.port,
        tlsOptions: fx.tlsFor(fx.a, { minVersion: 'TLSv1.3' }),
        session: ticket,
        request: true,
      });

    if (outcome.noTicket === true) {
      assert.ok(true, 'TLS 1.3 issued no ticket suitable for resumption, which is the required proof');
    } else if (outcome.stage === 'error') {
      assert.ok(true, 'a refused handshake is an acceptable outcome');
    } else {
      assert.equal(outcome.reused, false, 'the TLS 1.3 ticket must NOT be reused after revocation');
      assert.ok(!String(outcome.response ?? '').includes('200'), 'no application content may be served');
    }
    assert.equal(fx.upstream.requests.length, 0, 'no request from the revoked identity may reach the upstream');
  } finally { await fx.dispose(); }
});

test('01A TLS1.3: the client reports whether a session was Reused or New', async () => {
  // The taskbook requires recording New vs Reused rather than inferring from configuration.
  const fx = await makeFixture();
  try {
    const first = await rawTls({ port: fx.port, tlsOptions: fx.tlsFor(fx.b, { minVersion: 'TLSv1.3' }) });
    const reusedAfterFirst = first.reused;
    const second = await rawTls({
      port: fx.port,
      tlsOptions: fx.tlsFor(fx.b, { minVersion: 'TLSv1.3' }),
      session: first.session,
    });
    // With tickets disabled, the server must not accept a resumption; the client reports New.
    assert.equal(reusedAfterFirst, false, 'the first connection is always New');
    assert.equal(second.reused, false, 'the second connection must also be New, never Reused');
  } finally { await fx.dispose(); }
});

// ── revocation retest ───────────────────────────────────────────────────────

test('01A: revocation with A and B live closes only A, and A cannot reach the upstream', async () => {
  const fx = await makeFixture();
  try {
    // Establish A's keep-alive connection.
    const aSocket = await new Promise((resolve, reject) => {
      const socket = tls.connect({ host: '127.0.0.1', port: fx.port, ...fx.tlsFor(fx.a) });
      socket.once('secureConnect', () => {
        socket.write(`GET /api/v1/health HTTP/1.1\r\nHost: ${HOST}\r\nConnection: keep-alive\r\n\r\n`);
        resolve(socket);
      });
      socket.once('error', reject);
    });
    await new Promise((r) => setTimeout(r, 150));

    const startedAt = Date.now();
    const activation = fx.revokeA();
    const elapsed = Date.now() - startedAt;
    assert.ok(activation.closed >= 1, `A's live connection must be closed (closed=${activation.closed})`);
    assert.ok(elapsed <= 5000, `revocation must complete within 5 s, took ${elapsed} ms`);

    // The bridge must report the connection gone. The client-side close event is asynchronous and
    // depends on the OS scheduler, so the authoritative observation is the bridge's own state.
    const drained = await new Promise((resolve) => {
      const check = setInterval(() => {
        if (fx.bridge.connections === 0) { clearInterval(check); resolve(true); }
      }, 50);
      setTimeout(() => { clearInterval(check); resolve(fx.bridge.connections === 0); }, 3000);
    });
    assert.equal(drained, true, 'the bridge must have released A\'s connection');

    // A's revoked-closure count must be recorded, proving the closure was attributable to revocation.
    assert.ok(fx.bridge.stats.revokedCloses >= 1, 'revocation must record the closed connection');

    const before = fx.upstream.requests.length;
    // A fresh A connection must fail admission and produce no upstream request.
    await rawTls({ port: fx.port, tlsOptions: fx.tlsFor(fx.a), request: true }).catch(() => {});
    assert.equal(fx.upstream.requests.length, before, 'no request from revoked A may reach the upstream');

    // B must remain usable.
    const bResult = await rawTls({ port: fx.port, tlsOptions: fx.tlsFor(fx.b), request: true });
    assert.equal(bResult.authorized, true, 'B must remain connected');
    assert.ok(String(bResult.response).includes('200'), `B must still reach the upstream, saw ${bResult.response}`);
  } finally { await fx.dispose(); }
});

// ── same-IP concurrent identity isolation ───────────────────────────────────

test('01A: two identities on the same IP keep separate identity and revocation state', async () => {
  const fx = await makeFixture();
  try {
    // Both clients necessarily originate from 127.0.0.1; only the source port differs.
    const aSocket = await new Promise((resolve, reject) => {
      const socket = tls.connect({ host: '127.0.0.1', port: fx.port, ...fx.tlsFor(fx.a) });
      socket.once('secureConnect', () => resolve(socket));
      socket.once('error', reject);
    });
    const bSocket = await new Promise((resolve, reject) => {
      const socket = tls.connect({ host: '127.0.0.1', port: fx.port, ...fx.tlsFor(fx.b) });
      socket.once('secureConnect', () => resolve(socket));
      socket.once('error', reject);
    });

    assert.equal(aSocket.remoteAddress, bSocket.remoteAddress, 'both clients share one source IP');
    assert.notEqual(aSocket.localPort, bSocket.localPort, 'their source ports differ, which is the discriminator');

    const before = fx.upstream.requests.length;
    // Revoke A while both are live.
    fx.revokeA();
    await new Promise((r) => setTimeout(r, 150));

    // A must be gone; B must survive.
    const aGone = await new Promise((resolve) => {
      if (aSocket.destroyed) { resolve(true); return; }
      const timer = setTimeout(() => resolve(false), 2000);
      aSocket.once('close', () => { clearTimeout(timer); resolve(true); });
    });
    assert.equal(aGone, true, "A's socket must close despite sharing B's IP");

    const bResult = await rawTls({ port: fx.port, tlsOptions: fx.tlsFor(fx.b), request: true });
    assert.equal(bResult.authorized, true, 'B must still be authorised');
    assert.ok(String(bResult.response).includes('200'), `B must still reach the upstream, saw ${bResult.response}`);
    assert.ok(fx.upstream.requests.length > before, 'B produced the only upstream request');

    aSocket.destroy();
    bSocket.destroy();
  } finally { await fx.dispose(); }
});

test('01A: revocation state does not leak to a different identity sharing the IP', async () => {
  const fx = await makeFixture();
  try {
    // Revoke A, then confirm B (same IP) is unaffected and A remains denied.
    fx.revokeA();
    const bResult = await rawTls({ port: fx.port, tlsOptions: fx.tlsFor(fx.b), request: true });
    assert.ok(String(bResult.response).includes('200'), 'B must not inherit A\'s revocation');

    const before = fx.upstream.requests.length;
    const aResult = await rawTls({ port: fx.port, tlsOptions: fx.tlsFor(fx.a), request: true });
    assert.ok(!String(aResult.response ?? '').includes('200'), 'A must remain denied');
    assert.equal(fx.upstream.requests.length, before, 'A must not reach the upstream');
  } finally { await fx.dispose(); }
});
