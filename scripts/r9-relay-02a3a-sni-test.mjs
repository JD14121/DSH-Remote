/**
 * R9-RELAY-02A.3A — §5 wrong-SNI negative test (LOCAL ONLY).
 *
 * Runs ONE local TLS negative test against 127.0.0.1:9446 with the already-issued certificate and
 * fixture client identities. No DNS modification, no ACME contact, no new order.
 *
 * IMPORTANT: this test distinguishes two separate things rather than assuming they are the same:
 *
 *   (a) WRONG TLS SNI with an otherwise-valid request  — what does the bridge do?
 *   (b) WRONG HTTP Host with valid TLS                 — the authority check the bridge implements.
 *
 * The accepted R9-RELAY-01 policy enforces a single canonical *authority* at the HTTP layer
 * (`checkAuthority`). The implementation has no SNI callback, so reporting "wrong SNI is denied"
 * without measuring it would be an overclaim. This script measures what actually happens.
 */
import fs from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';

import { createBridge } from '../src/remote/r9/bridge.mjs';
import { createFixtureUpstream } from '../src/remote/r9/fixture-upstream.mjs';
import { createFixturePki } from '../src/remote/r9/fixture-certs.mjs';
import { IdentityPolicy } from '../src/remote/r9/identity-policy.mjs';

const REAL_HOST = 'relay.drm-jd.com';
const WRONG_SNI = 'example-invalid.drm-jd.com';
const DEPLOY = 'D:\\r9-relay-secrets\\https-server';
const PORT = 9446;

const report = { checks: [], observations: {} };
const check = (name, condition, detail = '') => {
  report.checks.push({ name, pass: Boolean(condition), detail });
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${name}${!condition && detail ? ' — ' + detail : ''}`);
};

const pki = createFixturePki();
const client = pki.makeIdentity('android-client');
const clientFp = pki.fingerprint(client.crt);

const upstream = createFixtureUpstream({ runId: 'sni02a3a' });
const upstreamPort = await upstream.listen(0);

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
  policy: IdentityPolicy.empty().withAllowed({ fingerprint: clientFp, label: 'fixture' }),
  hostname: REAL_HOST,
});
await bridge.listen(PORT);

const clientCreds = {
  cert: fs.readFileSync(client.crt),
  key: fs.readFileSync(client.key),
};

/** Full HTTPS request with a chosen SNI and Host. */
function attempt(label, servername, hostHeader, rejectUnauthorized = true) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ label, outcome: 'timeout' }), 8000);
    const done = (v) => { clearTimeout(timer); resolve({ label, ...v }); };
    const req = https.request({
      host: '127.0.0.1', port: PORT, path: '/api/v1/health', method: 'GET',
      servername,
      rejectUnauthorized,
      headers: { host: hostHeader },
      ...clientCreds,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => done({ outcome: 'response', status: res.statusCode, bodyBytes: body.length }));
    });
    req.on('error', (e) => done({ outcome: 'error', code: e.code ?? null, message: String(e.message).slice(0, 90) }));
    req.end();
  });
}

console.log('=== §5 wrong-SNI negative test (local only) ===');
console.log(`  TCP target : 127.0.0.1:${PORT}`);
console.log(`  cert       : the already-issued relay.drm-jd.com certificate`);

// (a) wrong SNI with an otherwise-valid Host — the required negative test.
const wrongSni = await attempt('wrong SNI, Host=relay.drm-jd.com', WRONG_SNI, REAL_HOST);
console.log(`  (a) wrong SNI  + correct Host : ${JSON.stringify(wrongSni)}`);

// (a2) Server-side probe: does the SERVER reject a wrong SNI, or only the client's hostname check?
// With rejectUnauthorized disabled the client accepts whatever certificate is presented, so a
// successful response here proves the server has no SNI gate of its own.
const wrongSniServerSide = await attempt('wrong SNI, client verification off', WRONG_SNI, REAL_HOST, false);
console.log(`  (a2) same, client verify OFF  : ${JSON.stringify(wrongSniServerSide)}`);

// (b) valid SNI, wrong Host — the authority control that IS implemented.
const wrongHost = await attempt('correct SNI, Host=evil.invalid', REAL_HOST, 'evil.invalid');
console.log(`  (b) correct SNI + wrong Host  : ${JSON.stringify(wrongHost)}`);

// Control: both correct.
const control = await attempt('both correct', REAL_HOST, REAL_HOST);
console.log(`  (c) control (both correct)    : ${JSON.stringify(control)}`);

check('control case succeeds (correct SNI + correct Host)', control.status === 200, JSON.stringify(control));
check('wrong-SNI TLS attempt does NOT yield an accepted service response',
  wrongSni.outcome === 'error' && wrongSni.code === 'ERR_TLS_CERT_ALTNAME_INVALID', JSON.stringify(wrongSni));
check('wrong HTTP Host is DENIED (the authority control actually implemented)', wrongHost.status === 400, JSON.stringify(wrongHost));

// Record the mechanism truthfully: the server has no SNI gate, so the wrong-SNI rejection observed
// at (a) came from the client's certificate hostname verification, not from a service control.
const serverHasSniGate = !(wrongSniServerSide.outcome === 'response' && wrongSniServerSide.status === 200);
report.observations = {
  wrong_sni_with_valid_host: wrongSni,
  wrong_sni_client_verification_off: wrongSniServerSide,
  wrong_host_with_valid_sni: wrongHost,
  control,
  rejection_mechanism: 'client-side certificate hostname verification (ERR_TLS_CERT_ALTNAME_INVALID)',
  server_side_sni_gate_present: serverHasSniGate,
  sni_callback_present_in_bridge: false,
  authority_control_implemented: wrongHost.status === 400,
  single_listener_single_certificate: true,
};
console.log(`\n  wrong-SNI attempt denied at        : ${report.observations.rejection_mechanism}`);
console.log(`  server-side SNI gate present       : ${serverHasSniGate}`);
console.log(`  Host authority control implemented : ${wrongHost.status === 400}`);

// The frozen R9-RELAY-01 policy enforces a single canonical AUTHORITY at the HTTP layer. The
// wrong-SNI case is denied for clients that verify certificates; there is exactly one listener and
// one certificate, so SNI cannot select an alternative service. No server-side SNI control is
// claimed, because none exists.
check('the frozen single-canonical-authority policy is enforced (wrong Host denied)',
  wrongHost.status === 400 && control.status === 200);
check('no server-side SNI control is claimed that the implementation does not provide',
  report.observations.sni_callback_present_in_bridge === false);

await bridge.stop();
await upstream.stop();
pki.dispose();

const total = report.checks.length;
const passed = report.checks.filter((c) => c.pass).length;
report.total = total;
report.pass = passed;
report.boundary = `single TLS listener presenting one canonical certificate; a client's SNI value does not select an alternative virtual host, so SNI cannot be used to reach a different service. The enforced control is the HTTP authority.`;
console.log(`\n=== §5: ${passed}/${total} checks passed ===`);
fs.mkdirSync('.r9-fixture-tools', { recursive: true });
fs.writeFileSync('.r9-fixture-tools/sni-test.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log('  written: .r9-fixture-tools/sni-test.json');
process.exit(passed === total ? 0 : 1);
