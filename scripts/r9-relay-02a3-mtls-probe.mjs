/**
 * R9-RELAY-02A.3 — probe: does the bridge deliver ANY application content to an unauthenticated peer?
 *
 * This distinguishes two different questions that must not be conflated:
 *   (a) does the TLS handshake complete?   Node's server-side rejectUnauthorized only refuses a
 *       client cert that FAILS validation; it does not abort merely because none was presented.
 *   (b) does the peer receive application content?   This is the security property that matters,
 *       and it must be NO regardless of (a).
 */
import fs from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';

import { createBridge } from '../src/remote/r9/bridge.mjs';
import { createFixtureUpstream } from '../src/remote/r9/fixture-upstream.mjs';
import { createFixturePki } from '../src/remote/r9/fixture-certs.mjs';
import { IdentityPolicy } from '../src/remote/r9/identity-policy.mjs';

const REAL_HOST = 'relay.drm-jd.com';
const DEPLOY = 'D:\\r9-relay-secrets\\https-server';
const PORT = 9446;

const pki = createFixturePki();
const android = pki.makeIdentity('android-client');
const foreign = pki.makeIdentity('foreign-client');
const androidFp = pki.fingerprint(android.crt);

const upstream = createFixtureUpstream({ runId: 'probe02a3' });
const upstreamPort = await upstream.listen(0);
let policy = IdentityPolicy.empty().withAllowed({ fingerprint: androidFp, label: 'a' });

const bridge = createBridge({
  tlsOptions: {
    cert: fs.readFileSync(`${DEPLOY}\\https-server.fullchain.crt`),
    key: fs.readFileSync(`${DEPLOY}\\https-server.key`),
    ca: fs.readFileSync(pki.caCert),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  },
  upstream: { host: '127.0.0.1', port: upstreamPort },
  policy, hostname: REAL_HOST,
});
await bridge.listen(PORT);

/** Attempt a full HTTPS request and report what the peer actually received. */
function attempt(label, tlsExtra) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ label, outcome: 'timeout' }), 8000);
    const done = (v) => { clearTimeout(timer); resolve({ label, ...v }); };
    const req = https.request({
      host: '127.0.0.1', port: PORT, path: '/api/v1/health', method: 'GET',
      headers: { host: REAL_HOST },
      servername: REAL_HOST, rejectUnauthorized: true, ...tlsExtra,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => done({ outcome: 'response', status: res.statusCode, bodyBytes: body.length, body }));
    });
    req.on('error', (e) => done({ outcome: 'error', code: e.code ?? null }));
    req.end();
  });
}

const cases = [
  ['valid enrolled client', { cert: fs.readFileSync(android.crt), key: fs.readFileSync(android.key) }],
  ['NO client certificate', {}],
  ['foreign/untrusted client', { cert: fs.readFileSync(foreign.crt), key: fs.readFileSync(foreign.key) }],
];

console.log('=== does any unauthenticated peer receive application content? ===');
const results = [];
for (const [label, extra] of cases) {
  const r = await attempt(label, extra);
  const gotContent = r.outcome === 'response' && r.status === 200 && r.bodyBytes > 0;
  console.log(`  ${label.padEnd(26)} outcome=${r.outcome} status=${r.status ?? '-'} bytes=${r.bodyBytes ?? 0} content=${gotContent}`);
  results.push({ label, outcome: r.outcome, status: r.status ?? null, body_bytes: r.bodyBytes ?? 0, received_content: gotContent });
}

// Now revoke and retry the valid identity.
policy = policy.withRevoked({ fingerprint: androidFp });
bridge.activatePolicy(policy);
const revoked = await attempt('revoked identity', { cert: fs.readFileSync(android.crt), key: fs.readFileSync(android.key) });
const revokedContent = revoked.outcome === 'response' && revoked.status === 200 && revoked.bodyBytes > 0;
console.log(`  ${'revoked identity'.padEnd(26)} outcome=${revoked.outcome} status=${revoked.status ?? '-'} bytes=${revoked.bodyBytes ?? 0} content=${revokedContent}`);
results.push({ label: 'revoked identity', outcome: revoked.outcome, status: revoked.status ?? null, body_bytes: revoked.bodyBytes ?? 0, received_content: revokedContent });

console.log(`\n  upstream requests received: ${upstream.requests.length}`);
console.log(`  bridge stats: ${JSON.stringify(bridge.stats)}`);

// The enrolled identity MUST receive content; every UNAUTHENTICATED peer must not. Including the
// valid case in a blanket "nobody got content" check would make the verdict meaningless.
const unauthenticated = results.filter((r) => r.label !== 'valid enrolled client');
const enrolledGotContent = results.find((r) => r.label === 'valid enrolled client')?.received_content === true;
const safe = unauthenticated.every((r) => !r.received_content) && enrolledGotContent;
console.log(`\n  enrolled identity received content : ${enrolledGotContent}`);
console.log(`  unauthenticated peers received none: ${unauthenticated.every((r) => !r.received_content)}`);
console.log(`  SECURITY PROPERTY (mTLS remains fail-closed for unauthenticated peers): ${safe ? 'HOLDS' : 'VIOLATED'}`);

await bridge.stop();
await upstream.stop();
pki.dispose();
fs.mkdirSync('.r9-fixture-tools', { recursive: true });
fs.writeFileSync('.r9-fixture-tools/mtls-probe.json', `${JSON.stringify({ results, upstream_requests: upstream.requests.length, safe }, null, 2)}\n`, 'utf8');
process.exit(safe ? 0 : 1);
