/**
 * R9-RELAY-02B — local end-to-end rehearsal (§16-§27).
 *
 * Topology (all inside ONE container on an --internal Docker network, no published ports):
 *
 *   test TLS client -> frps HTTPS vhost (SNI routing) -> frpc -> synthetic TLS origin
 *
 * The synthetic origin stands in for the PC bridge at 127.0.0.1:9446. The PRODUCTION frpc template
 * still targets exactly 127.0.0.1:9446; only the rehearsal rendering substitutes a container port.
 *
 * Secrets are mounted read-only; nothing production is baked into an image layer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sh = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
const out = (r) => `${String(r.stdout ?? '')}${String(r.stderr ?? '')}`.trim();
const ex = (script) => out(sh(['exec', 'r9rehearse', 'sh', '-c', script]));

const WORK = '.r9-fixture-tools/rehearsal';
fs.mkdirSync(WORK, { recursive: true });

const C = {
  frpsCrt: '/pki/public/leaves/frps-server.crt',
  frpsKey: '/pki/keys/leaves/frps-server.key',
  clientCa: '/pki/public/client-ca/client-ca.crt',
  serverCa: '/pki/public/server-ca/server-ca.crt',
  frpcCrt: '/pki/public/leaves/frpc-client.crt',
  frpcKey: '/pki/keys/leaves/frpc-client.key',
  appToken: '/secrets/app-auth-token',
};

/** Render the production frps template: binds/paths substituted, field NAMES verbatim. */
function renderFrps(extra = {}) {
  let s = fs.readFileSync('config/r9/frps.production.toml', 'utf8')
    .replace(/^bindAddr = .*$/m, 'bindAddr = "127.0.0.1"')
    .replace(/^bindPort = .*$/m, 'bindPort = 7100')
    .replace(/^proxyBindAddr = .*$/m, 'proxyBindAddr = "127.0.0.1"')
    .replace(/^vhostHTTPSPort = .*$/m, 'vhostHTTPSPort = 7443')
    .replace(/^transport\.tls\.certFile = .*$/m, `transport.tls.certFile = "${C.frpsCrt}"`)
    .replace(/^transport\.tls\.keyFile = .*$/m, `transport.tls.keyFile = "${C.frpsKey}"`)
    .replace(/^transport\.tls\.trustedCaFile = .*$/m, `transport.tls.trustedCaFile = "${C.clientCa}"`)
    .replace(/^auth\.tokenSource\.file\.path = .*$/m, `auth.tokenSource.file.path = "${C.appToken}"`)
    .replace(/^addr = "127\.0\.0\.1:19100"$/m, 'addr = "127.0.0.1:9100"')
    .replace(/^log\.to = .*$/m, 'log.to = "/work/frps.log"');
  if (extra.pluginAddr) s = s.replace(/^addr = .*$/m, `addr = "${extra.pluginAddr}"`);
  if (extra.clientCa) s = s.replace(/^transport\.tls\.trustedCaFile = .*$/m, `transport.tls.trustedCaFile = "${extra.clientCa}"`);
  return s;
}

/** Render the production frpc template. */
function renderFrpc(extra = {}) {
  let s = fs.readFileSync('config/r9/frpc.production.toml', 'utf8')
    .replace(/^serverAddr = .*$/m, `serverAddr = "${extra.serverAddr ?? '127.0.0.1'}"`)
    .replace(/^serverPort = .*$/m, `serverPort = ${extra.serverPort ?? 7100}`)
    .replace(/^transport\.tls\.certFile = .*$/m, `transport.tls.certFile = "${extra.cert ?? C.frpcCrt}"`)
    .replace(/^transport\.tls\.keyFile = .*$/m, `transport.tls.keyFile = "${extra.key ?? C.frpcKey}"`)
    .replace(/^transport\.tls\.trustedCaFile = .*$/m, `transport.tls.trustedCaFile = "${extra.ca ?? C.serverCa}"`)
    .replace(/^auth\.tokenSource\.file\.path = .*$/m, `auth.tokenSource.file.path = "${extra.token ?? C.appToken}"`)
    .replace(/^localPort = 9446$/m, `localPort = ${extra.localPort ?? 9444}`)
    .replace(/^name = "r9-relay-https"$/m, `name = "${extra.name ?? 'r9-relay-https'}"`)
    .replace(/^type = "https"$/m, `type = "${extra.type ?? 'https'}"`)
    .replace(/^customDomains = .*$/m, `customDomains = [${(extra.domains ?? ['relay.drm-jd.com']).map((d) => `"${d}"`).join(', ')}]`);
  if (extra.serverName) s = s.replace(/^transport\.tls\.serverName = .*$/m, `transport.tls.serverName = "${extra.serverName}"`);
  if (extra.extraProxy) s += `\n[[proxies]]\nname = "r9-extra"\ntype = "https"\nlocalIP = "127.0.0.1"\nlocalPort = 9444\ncustomDomains = ["other.invalid"]\n`;
  return s;
}

// ── the synthetic TLS origin + a test client, both written into the container ─
const ORIGIN_PY = `
import ssl, http.server, socketserver, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"origin":"SYNTHETIC-ORIGIN-9446-STANDIN","path":"' + self.path.encode() + b'"}\\n'
        self.send_response(200); self.send_header('Content-Type','application/json')
        self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
class S(socketserver.TCPServer): allow_reuse_address = True
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
# The origin presents the SYNTHETIC identity, NOT an frps certificate: this is the TLS endpoint.
ctx.load_cert_chain('/origin/origin.crt', '/origin/origin.key')
srv = S(('127.0.0.1', 9444), H)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
`;

const CLIENT_PY = `
import ssl, socket, sys, json
mode = sys.argv[1]           # sni value or '' for no SNI
port = int(sys.argv[2])      # frps vhost port
sni  = sys.argv[3] if sys.argv[3] != 'NONE' else None
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE   # the origin is synthetic; we are testing ROUTING not chain validity
try:
    raw = socket.create_connection(('127.0.0.1', port), timeout=8)
    s = ctx.wrap_socket(raw, server_hostname=sni)
    peer = s.getpeercert(binary_form=True)
    import hashlib
    fp = hashlib.sha256(peer).hexdigest() if peer else None
    s.sendall(b'GET /api/v1/health HTTP/1.1\\r\\nHost: ' + (sni or 'none').encode() + b'\\r\\nConnection: close\\r\\n\\r\\n')
    data = b''
    s.settimeout(6)
    try:
        while True:
            chunk = s.recv(4096)
            if not chunk: break
            data += chunk
    except Exception: pass
    s.close()
    body = data.decode('latin1', 'replace')
    print(json.dumps({'mode': mode, 'connected': True, 'peer_cert_sha256': fp,
                      'got_origin_response': 'SYNTHETIC-ORIGIN' in body,
                      'status_line': body.split('\\r\\n')[0] if body else None}))
except Exception as e:
    print(json.dumps({'mode': mode, 'connected': False, 'error': type(e).__name__ + ': ' + str(e)[:70]}))
`;

fs.writeFileSync(path.join(WORK, 'origin.py'), ORIGIN_PY.trim(), 'utf8');
fs.writeFileSync(path.join(WORK, 'client.py'), CLIENT_PY.trim(), 'utf8');
fs.writeFileSync(path.join(WORK, 'frps.toml'), renderFrps(), 'utf8');
fs.writeFileSync(path.join(WORK, 'frpc.toml'), renderFrpc(), 'utf8');
fs.copyFileSync('scripts/r9-relay-01c-admission-plugin.py', path.join(WORK, 'admission-plugin.py'));

console.log('=== populating the rehearsal container ===');
for (const f of ['origin.py', 'client.py', 'frps.toml', 'frpc.toml', 'admission-plugin.py']) {
  sh(['cp', path.join(WORK, f), `r9rehearse:/work/${f}`]);
}
// A dedicated synthetic origin identity, generated inside the container.
console.log(ex(`
mkdir -p /origin /work
openssl req -x509 -newkey rsa:2048 -nodes -keyout /origin/origin.key -out /origin/origin.crt \
  -days 30 -subj "/CN=SYNTHETIC-ORIGIN-STANDIN" \
  -addext "subjectAltName=DNS:relay.drm-jd.com" 2>/dev/null
openssl x509 -in /origin/origin.crt -noout -subject
echo "ORIGIN_CERT_SHA256=$(openssl x509 -in /origin/origin.crt -outform DER | openssl dgst -sha256 -r | cut -d' ' -f1)"
`));

const results = { checks: [], steps: [] };
const check = (name, cond, detail = '') => {
  results.checks.push({ name, pass: Boolean(cond), detail });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${!cond && detail ? ' — ' + detail : ''}`);
};

// ── start the admission plugin + synthetic origin + frps + frpc ─────────────
console.log('\n=== starting the rehearsal topology ===');
console.log(ex(`
pkill -f 'admission-plugin' 2>/dev/null; pkill -f '/r9/bin/frps' 2>/dev/null; pkill -f '/r9/bin/frpc' 2>/dev/null; pkill -f origin.py 2>/dev/null
sleep 1
rm -f /work/plugin.log /work/frps.log
python3 /work/admission-plugin.py 9100 policy /work/plugin.log > /work/plugin.out 2>&1 &
sleep 2
python3 /work/origin.py > /work/origin.out 2>&1 &
sleep 1
/r9/bin/frps -c /work/frps.toml > /work/frps.out 2>&1 &
sleep 4
echo "LISTENERS:"; netstat -ltn 2>/dev/null | grep -E '7100|7443|9100|9444' || echo "  none"
echo "FRPS LOG:"; tail -4 /work/frps.log 2>/dev/null || echo "  no log"
`));

// ── control-channel mTLS matrix (§19) ───────────────────────────────────────
console.log('\n=== §19 control-channel mTLS matrix ===');
const runFrpc = (label, cfg) => {
  sh(['cp', cfg, 'r9rehearse:/work/probe.toml']);
  const r = ex('cd /work && timeout 10 /r9/bin/frpc -c /work/probe.toml 2>&1 | head -20');
  const loginOk = /login to server success/.test(r);
  const registered = /start proxy success/.test(r);
  const denied = /login to the server failed|authentication failed|tls:|x509:|connection refused|certificate/i.test(r);
  console.log(`  ${label.padEnd(34)} login=${loginOk} registered=${registered}`);
  results.steps.push({ test: label, login: loginOk, registered, raw: r.slice(0, 500) });
  return { loginOk, registered, denied, raw: r };
};

fs.writeFileSync(path.join(WORK, 'c-valid.toml'), renderFrpc(), 'utf8');
const valid = runFrpc('valid mTLS + correct token', path.join(WORK, 'c-valid.toml'));
check('valid frpc certificate + correct trust + correct app auth CONNECTS', valid.loginOk, valid.raw.slice(0, 200));

// Wrong app-auth secret: a different file with a different value.
fs.writeFileSync(path.join(WORK, 'wrong-token'), 'deadbeef'.repeat(8), 'utf8');
sh(['cp', path.join(WORK, 'wrong-token'), 'r9rehearse:/work/wrong-token']);
fs.writeFileSync(path.join(WORK, 'c-wrongtoken.toml'), renderFrpc({ token: '/work/wrong-token' }), 'utf8');
const wrongToken = runFrpc('valid mTLS + WRONG app auth', path.join(WORK, 'c-wrongtoken.toml'));
check('valid mTLS but wrong app-auth secret is DENIED', !wrongToken.loginOk, wrongToken.raw.slice(0, 200));

// No client certificate.
fs.writeFileSync(path.join(WORK, 'c-nocert.toml'),
  renderFrpc().replace(/^transport\.tls\.certFile = .*$/m, '').replace(/^transport\.tls\.keyFile = .*$/m, ''), 'utf8');
const noCert = runFrpc('no client certificate', path.join(WORK, 'c-nocert.toml'));
check('no client certificate is DENIED', !noCert.registered, noCert.raw.slice(0, 200));

// Foreign client certificate (the synthetic origin key is not in the FRP client CA).
fs.writeFileSync(path.join(WORK, 'c-foreign.toml'), renderFrpc({
  cert: '/origin/origin.crt', key: '/origin/origin.key',
}), 'utf8');
const foreign = runFrpc('foreign client certificate', path.join(WORK, 'c-foreign.toml'));
check('foreign client certificate is DENIED', !foreign.registered, foreign.raw.slice(0, 200));

// Wrong transport server name: trust the server CA but expect a different name.
fs.writeFileSync(path.join(WORK, 'c-wrongname.toml'), renderFrpc({ serverName: 'wrong-name.internal' }), 'utf8');
const wrongName = runFrpc('wrong transport server name', path.join(WORK, 'c-wrongname.toml'));
check('wrong transport server name is DENIED', !wrongName.loginOk, wrongName.raw.slice(0, 200));

// Untrusted server CA: trust the CLIENT CA instead, so the frps leaf does not chain to it.
fs.writeFileSync(path.join(WORK, 'c-wrongca.toml'), renderFrpc({ ca: C.clientCa }), 'utf8');
const wrongCa = runFrpc('untrusted server CA', path.join(WORK, 'c-wrongca.toml'));
check('frps certificate signed by an untrusted CA is DENIED by frpc', !wrongCa.loginOk, wrongCa.raw.slice(0, 200));

fs.writeFileSync('.r9-fixture-tools/rehearsal-mtls.json', `${JSON.stringify({ checks: results.checks, steps: results.steps }, null, 2)}\n`, 'utf8');
console.log('\n  written: .r9-fixture-tools/rehearsal-mtls.json');
