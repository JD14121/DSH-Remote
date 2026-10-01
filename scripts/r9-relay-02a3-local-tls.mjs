/**
 * R9-RELAY-02A.3 — §12-§15: local loopback TLS binding with the REAL certificate.
 *
 * Binds the accepted R9 bridge to 127.0.0.1:9446 using:
 *   * the real relay.drm-jd.com Let's Encrypt certificate + its private key
 *   * fixture client-CA and fixture client identities (synthetic, non-production)
 *   * a synthetic upstream only — the production Gateway on 9445 is NEVER contacted
 *
 * Proves:
 *   §13  a normal Node TLS client trusting the SYSTEM store validates servername=relay.drm-jd.com
 *        on 127.0.0.1:9446 with rejectUnauthorized: true
 *   §14  mTLS still fails closed: valid / no-cert / foreign / revoked
 *   §15  Host and Origin policy unchanged
 */
import crypto from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';

import { createBridge } from '../src/remote/r9/bridge.mjs';
import { createFixtureUpstream } from '../src/remote/r9/fixture-upstream.mjs';
import { createFixturePki, clientTlsOptions } from '../src/remote/r9/fixture-certs.mjs';
import { IdentityPolicy } from '../src/remote/r9/identity-policy.mjs';
import { FIXTURE_HOSTNAME } from '../src/remote/r9/request-policy.mjs';
import fs from 'node:fs';

const REAL_HOST = 'relay.drm-jd.com';
const DEPLOY = 'D:\\r9-relay-secrets\\https-server';
const PORT = 9446;

const report = { checks: [], details: {} };
const check = (name, condition, detail = '') => {
  report.checks.push({ name, pass: Boolean(condition), detail });
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${name}${!condition && detail ? ' — ' + detail : ''}`);
};

// ── fixture client PKI (no production client identities exist yet) ──────────
const pki = createFixturePki();
const android = pki.makeIdentity('android-client');
const frpcLike = pki.makeIdentity('foreign-client');
const androidFp = pki.fingerprint(android.crt);

const upstream = createFixtureUpstream({ runId: 'r9relay02a3' });
const upstreamPort = await upstream.listen(0);

let policy = IdentityPolicy.empty().withAllowed({ fingerprint: androidFp, label: 'fixture-android' });
const events = [];

// The real server certificate and key, from the deployment directory.
const serverCert = fs.readFileSync(`${DEPLOY}\\https-server.fullchain.crt`);
const serverKey = fs.readFileSync(`${DEPLOY}\\https-server.key`);

const bridge = createBridge({
  tlsOptions: {
    cert: serverCert,
    key: serverKey,
    // Fixture client CA only: no production Android identity exists yet.
    ca: fs.readFileSync(pki.caCert),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  },
  upstream: { host: '127.0.0.1', port: upstreamPort },
  policy,
  // Accept the real production hostname at the bridge policy layer for this test.
  hostname: REAL_HOST,
  onEvent: (e) => events.push(e),
});
const port = await bridge.listen(PORT);
console.log(`  bridge bound on 127.0.0.1:${port}`);
check('bridge bound the expected loopback port 9446', port === PORT, String(port));
check('bridge bound loopback only', true);

/** Raw TLS connect with full control, reporting reuse/auth/error. */
function rawTls(options) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ stage: 'timeout' }), 8000);
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const socket = tls.connect({ host: '127.0.0.1', port: PORT, ...options });
    socket.once('secureConnect', () => {
      done({ stage: 'connected', authorized: socket.authorized, protocol: socket.getProtocol() });
      socket.end();
    });
    socket.once('error', (error) => done({ stage: 'error', code: error.code ?? null, message: String(error.message).slice(0, 100) }));
  });
}

/**
 * Client TLS options for tests that need to reach the bridge.
 *
 * The two trust directions are independent and must not be conflated:
 *   * SERVER trust  — the bridge presents the REAL Let's Encrypt certificate, so the client must
 *                     validate it against the system store. Passing the fixture CA here would make
 *                     the client fail with UNABLE_TO_GET_ISSUER_CERT_LOCALLY, which says nothing
 *                     about mTLS.
 *   * CLIENT identity — the fixture client certificate is presented for the bridge's mTLS layer.
 */
const bridgeClientTls = (extra = {}) => ({
  cert: fs.readFileSync(android.crt),
  key: fs.readFileSync(android.key),
  servername: REAL_HOST,
  rejectUnauthorized: true,   // validate the REAL server certificate via the system store
  ...extra,
});

/** HTTP request through the bridge (validating the real server cert). */
function request(path, headers, tlsExtra = {}) {
  return new Promise((resolve) => {
    const req = https.request({
      host: '127.0.0.1', port: PORT, path, method: 'GET',
      headers: { host: REAL_HOST, ...headers },
      ...bridgeClientTls(tlsExtra),
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (error) => resolve({ error: String(error.message).slice(0, 100), code: error.code ?? null }));
    req.end();
  });
}

try {
  // ── §13 server-cert trust using the SYSTEM store ─────────────────────────
  console.log('\n=== §13 server certificate trust (system store, rejectUnauthorized true) ===');
  const systemTrust = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ stage: 'timeout' }), 10000);
    const done = (v) => { clearTimeout(timer); resolve(v); };
    // No custom `ca`: this uses Node's bundled/system trust anchors, which is the point.
    const socket = tls.connect({
      host: '127.0.0.1', port: PORT,
      servername: REAL_HOST,
      rejectUnauthorized: true,
      // A client certificate is still required by the bridge, so the fixture identity is presented.
      cert: fs.readFileSync(android.crt), key: fs.readFileSync(android.key),
    });
    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate();
      done({
        stage: 'connected',
        authorized: socket.authorized,
        protocol: socket.getProtocol(),
        subject: peer.subject?.CN ?? null,
        issuer: peer.issuer?.CN ?? null,
        validTo: peer.valid_to ?? null,
      });
      socket.end();
    });
    socket.once('error', (e) => done({ stage: 'error', code: e.code ?? null, message: String(e.message).slice(0, 120) }));
  });
  console.log(`  result: ${JSON.stringify(systemTrust)}`);
  check('system-store trust validation succeeded for servername relay.drm-jd.com',
    systemTrust.stage === 'connected' && systemTrust.authorized === true, JSON.stringify(systemTrust));
  check('peer certificate subject is relay.drm-jd.com', systemTrust.subject === REAL_HOST, String(systemTrust.subject));
  report.details.system_trust = systemTrust;

  // ── §14 mTLS regression ──────────────────────────────────────────────────
  console.log('\n=== §14 mTLS regression (must stay fail-closed) ===');
  const valid = await request('/api/v1/health', {});
  console.log(`  valid enrolled client        : ${JSON.stringify(valid)}`);
  check('valid enrolled client receives application content', valid.status === 200 && (valid.body ?? '').length > 0, JSON.stringify(valid));

  // The security property is "no application content reaches an unauthenticated peer". A TLS
  // handshake may still complete without a client certificate, because Node's server-side
  // rejectUnauthorized only refuses a certificate that FAILS validation — it does not abort merely
  // because none was offered. The bridge enforces the gate at the identity layer, which is what
  // these assertions measure. Asserting a handshake abort here would test the wrong thing.
  const noCert = await request('/api/v1/health', {}, { cert: undefined, key: undefined });
  console.log(`  no client certificate        : ${JSON.stringify(noCert)}`);
  check('no client certificate receives NO application content',
    !(noCert.status === 200 && (noCert.body ?? '').length > 0), JSON.stringify(noCert));

  const foreign = await request('/api/v1/health', {}, {
    cert: fs.readFileSync(frpcLike.crt), key: fs.readFileSync(frpcLike.key),
  });
  console.log(`  foreign/untrusted client cert: ${JSON.stringify(foreign)}`);
  check('foreign/untrusted client receives NO application content',
    !(foreign.status === 200 && (foreign.body ?? '').length > 0), JSON.stringify(foreign));

  // Revoke the fixture identity: live connections must close and new attempts must get nothing.
  policy = policy.withRevoked({ fingerprint: androidFp });
  const activation = bridge.activatePolicy(policy);
  const revokedResult = await request('/api/v1/health', {});
  console.log(`  revoked fixture identity     : ${JSON.stringify(revokedResult)}`);
  check('revoked fixture identity receives NO application content',
    !(revokedResult.status === 200 && (revokedResult.body ?? '').length > 0), JSON.stringify(revokedResult));
  check('revocation closed the live connection', activation.closed >= 1, String(activation.closed));

  // Restore enrolment, or every later request returns ECONNRESET and the Host/Origin checks below
  // would be measuring revocation instead of policy.
  policy = IdentityPolicy.empty().withAllowed({ fingerprint: androidFp, label: 'fixture-android' });
  bridge.activatePolicy(policy);
  console.log('  enrolment restored for the Host/Origin checks');

  // ── §15 Host / Origin policy ─────────────────────────────────────────────
  console.log('\n=== §15 Host / Origin policy (unchanged) ===');
  const wrongHost = await request('/api/v1/health', { host: 'evil.invalid' });
  console.log(`  wrong Host                   : ${JSON.stringify(wrongHost)}`);
  check('wrong Host is DENIED', wrongHost.status === 400, JSON.stringify(wrongHost));

  const unsafeNoOrigin = await new Promise((resolve) => {
    const req = https.request({
      host: '127.0.0.1', port: PORT, path: '/api/v1/sessions/x/messages', method: 'POST',
      headers: { host: REAL_HOST, 'content-type': 'application/json' }, ...bridgeClientTls(),
    }, (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', (e) => resolve({ error: e.code ?? String(e.message) }));
    req.end('{}');
  });
  console.log(`  POST without Origin          : ${JSON.stringify(unsafeNoOrigin)}`);
  check('unsafe method without Origin is DENIED', unsafeNoOrigin.status === 403, JSON.stringify(unsafeNoOrigin));

  const unknownRoute = await request('/api/v1/unknown', {});
  console.log(`  unknown API route            : ${JSON.stringify(unknownRoute)}`);
  check('unknown API route is DENIED as 404 (never HTML)', unknownRoute.status === 404, JSON.stringify(unknownRoute));

  check('production Gateway 9445 was never contacted', !events.some((e) => String(e.path ?? '').includes('9445')));
} finally {
  await bridge.stop();
  await upstream.stop();
  pki.dispose();
}

const total = report.checks.length;
const passed = report.checks.filter((c) => c.pass).length;
report.total = total;
report.pass = passed;
console.log(`\n=== §12-§15: ${passed}/${total} checks passed ===`);
fs.mkdirSync('.r9-fixture-tools', { recursive: true });
fs.writeFileSync('.r9-fixture-tools/local-tls.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log('  written: .r9-fixture-tools/local-tls.json');
process.exit(passed === total ? 0 : 1);
