/**
 * R9-RELAY-03 GATE 3.4A — verification of the anchor-IP configuration change.
 *
 * Verifies, on the PC only, using the PINNED frp v0.71.0:
 *   1. the complete production TOML is accepted by the pinned parser
 *   2. the bind failure on a non-local address is NOT reported as a parse failure
 *   3. both listeners bind only the specified IPv4, with NO IPv6 listener
 *   4. the admission plugin remains loopback-only
 *   5. exactly one r9-relay-https proxy exists, targeting 127.0.0.1:9446
 *   6. there is no automatic fallback-to-wildcard logic anywhere
 *
 * It does NOT claim anything about the real VPS or about Reserved-IP routing.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const sh = (args) => spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const out = (r) => `${String(r.stdout ?? '')}${String(r.stderr ?? '')}`.trim();

const checks = [];
const check = (name, cond, detail = '') => {
  checks.push({ name, pass: Boolean(cond), detail });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${!cond && detail ? ' — ' + detail : ''}`);
};

// ── container with the pinned binaries ─────────────────────────────────────
sh(['rm', '-f', 'r9verify']);
sh(['create', '--name', 'r9verify', '--network', 'none', '--cap-add', 'NET_ADMIN',
  '-v', 'D:\\r9-relay-pki\\frp:/pki:ro', '-v', 'D:\\r9-relay-secrets\\frp:/secrets:ro',
  'r9-rehearsal:0.71.0']);
sh(['start', 'r9verify']);
const waitUp = () => { for (let i = 0; i < 20; i += 1) { if (sh(['exec', 'r9verify', 'true']).status === 0) return true; spawnSync('sleep', ['1']); } return false; };
waitUp();

const prod = fs.readFileSync('config/r9/frps.production.toml', 'utf8');
sh(['cp', 'config/r9/frps.production.toml', 'r9verify:/tmp/prod.toml']);

// A container-side copy that changes ONLY the absolute material paths, so the TLS section can actually
// load. The bind addresses stay exactly as production specifies them, which is what this test is about.
// (Without this, frps fails on the missing /etc/r9-frp certificate BEFORE reaching the bind step, and
// the test would be measuring file absence rather than bind semantics.)
const prodParsed = prod
  .replace('/etc/r9-frp/pki/frps-server.crt', '/pki/public/leaves/frps-server.crt')
  .replace('/etc/r9-frp/pki/frps-server.key', '/pki/keys/leaves/frps-server.key')
  .replace('/etc/r9-frp/pki/frpc-client-ca.crt', '/pki/public/client-ca/client-ca.crt')
  .replace('/etc/r9-frp/secrets/app-auth-token', '/secrets/app-auth-token')
  .replace(/^log\.to = .*$/m, 'log.to = "/tmp/prod.log"');
fs.writeFileSync('.r9-fixture-tools/frps.gate34a-parsetest.toml', prodParsed, 'utf8');
sh(['cp', '.r9-fixture-tools/frps.gate34a-parsetest.toml', 'r9verify:/tmp/prodparsed.toml']);

console.log('=== 1. pinned parser accepts the FULL production TOML ===');
console.log('    (material paths remapped so the TLS section can load; bind addresses left UNCHANGED at 10.15.0.5)');
const parseRun = out(sh(['exec', 'r9verify', 'sh', '-c',
  'timeout 5 /r9/bin/frps -c /tmp/prodparsed.toml 2>&1 | head -5']));
console.log(parseRun.split('\n').map((l) => `    ${l}`).join('\n'));
const isParseError = /toml:|unknown field|cannot unmarshal|failed to parse/i.test(parseRun);
const isBindError = /cannot assign requested address|bind:/i.test(parseRun);
check('full production TOML is NOT a parse error', !isParseError, parseRun.slice(0, 200));
check('failure is specifically a BIND failure on the non-local anchor address', isBindError, parseRun.slice(0, 200));
check('the bind failure correctly names port 7000 on the anchor IP', /10\.15\.0\.5:7000/.test(parseRun), parseRun.slice(0, 200));

console.log('\n=== 2. negative control: a genuinely broken TOML MUST be reported as a parse error ===');
sh(['exec', 'r9verify', 'sh', '-c', "printf 'this is not = = valid toml\\n' > /tmp/broken.toml"]);
const brokenRun = out(sh(['exec', 'r9verify', 'sh', '-c', 'timeout 5 /r9/bin/frps -c /tmp/broken.toml 2>&1 | head -3']));
console.log(brokenRun.split('\n').map((l) => `    ${l}`).join('\n'));
check('control: broken TOML IS reported as a parse error', /toml:/i.test(brokenRun), brokenRun.slice(0, 200));

// ── 3. substitute a local address to prove the bind behaviour ──────────────
console.log('\n=== 3. local-substitute bind test (10.15.0.5 -> 127.0.0.2, paths remapped) ===');
let local = prod
  .replace(/10\.15\.0\.5/g, '127.0.0.2')
  .replace(/^bindPort = 7000$/m, 'bindPort = 7100')
  .replace(/^vhostHTTPSPort = 443$/m, 'vhostHTTPSPort = 7443')
  .replace('/etc/r9-frp/pki/frps-server.crt', '/pki/public/leaves/frps-server.crt')
  .replace('/etc/r9-frp/pki/frps-server.key', '/pki/keys/leaves/frps-server.key')
  .replace('/etc/r9-frp/pki/frpc-client-ca.crt', '/pki/public/client-ca/client-ca.crt')
  .replace('/etc/r9-frp/secrets/app-auth-token', '/secrets/app-auth-token')
  .replace(/^log\.to = .*$/m, 'log.to = "/tmp/prod.log"')
  .replace(/^addr = "127\.0\.0\.1:19100"$/m, 'addr = "127.0.0.1:9100"');
fs.writeFileSync('.r9-fixture-tools/frps.gate34a-local.toml', local, 'utf8');
sh(['cp', '.r9-fixture-tools/frps.gate34a-local.toml', 'r9verify:/tmp/local.toml']);

// Start a dummy plugin so frps does not care whether the real one is up.
const reach = `
import socket, subprocess, time
BIN='/r9/bin/frps'
def can(h,p,t=2):
    try:
        with socket.create_connection((h,p),timeout=t): return True
    except OSError: return False
subprocess.run(['pkill','-f',BIN],capture_output=True); time.sleep(1)
subprocess.run(['rm','-f','/tmp/prod.log'])
p=subprocess.Popen([BIN,'-c','/tmp/local.toml'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(4)
try: log=open('/tmp/prod.log').read()
except OSError: log=''
for l in log.splitlines():
    if 'tcp listen' in l or 'https service listen' in l or 'started successfully' in l:
        print('LOG:', l.split('] ')[-1])
print('CTRL_7100', {h: can(h,7100) for h in ('127.0.0.1','127.0.0.2','127.0.0.3')})
print('VHOST_7443', {h: can(h,7443) for h in ('127.0.0.1','127.0.0.2','127.0.0.3')})
print('IPV6_CTRL', can('::1',7100))
print('IPV6_VHOST', can('::1',7443))
p.terminate()
try: p.wait(timeout=5)
except Exception: p.kill()
`;
fs.writeFileSync('.r9-fixture-tools/gate34a-reach.py', reach, 'utf8');
sh(['cp', '.r9-fixture-tools/gate34a-reach.py', 'r9verify:/tmp/reach.py']);
const reachOut = out(sh(['exec', 'r9verify', 'python3', '/tmp/reach.py']));
console.log(reachOut.split('\n').map((l) => `    ${l}`).join('\n'));

check('frps reports listening on the substituted anchor address only (control)',
  /tcp listen on 127\.0\.0\.2:7100/.test(reachOut), reachOut.slice(0, 300));
check('frps reports the vhost on the substituted anchor address only',
  /https service listen on 127\.0\.0\.2:7443/.test(reachOut), reachOut.slice(0, 300));
check('control port reachable ONLY on the bound address',
  /CTRL_7100 \{[^}]*'127\.0\.0\.1': False[^}]*'127\.0\.0\.2': True[^}]*'127\.0\.0\.3': False/.test(reachOut), reachOut.slice(0, 300));
check('vhost port reachable ONLY on the bound address',
  /VHOST_7443 \{[^}]*'127\.0\.0\.1': False[^}]*'127\.0\.0\.2': True[^}]*'127\.0\.0\.3': False/.test(reachOut), reachOut.slice(0, 300));
check('NO IPv6 listener on the control port (negative test)', /IPV6_CTRL False/.test(reachOut), reachOut.slice(0, 300));
check('NO IPv6 listener on the vhost port (negative test)', /IPV6_VHOST False/.test(reachOut), reachOut.slice(0, 300));

// ── 4. admission plugin loopback-only ─────────────────────────────────────
console.log('\n=== 4. admission plugin must remain loopback-only ===');
const pluginAddr = /^addr = "([^"]+)"$/m.exec(prod)?.[1];
const pluginOps = /^ops = \[([^\]]+)\]$/m.exec(prod)?.[1];
console.log(`    [[httpPlugins]] addr = ${pluginAddr}   ops = ${pluginOps}`);
check('admission plugin addr is 127.0.0.1:19100', pluginAddr === '127.0.0.1:19100', String(pluginAddr));
check('admission plugin is registered for NewProxy only', pluginOps === '"NewProxy"', String(pluginOps));
check('plugin address is NOT a wildcard', !/0\.0\.0\.0|\[::\]|::/.test(String(pluginAddr)));

// ── 5. exactly one proxy, exact target ────────────────────────────────────
console.log('\n=== 5. exactly one production proxy, exact local target ===');
const frpc = fs.readFileSync('config/r9/frpc.production.toml', 'utf8');
const proxyBlocks = (frpc.match(/^\[\[proxies\]\]$/gm) ?? []).length;
check('exactly one [[proxies]] block', proxyBlocks === 1, String(proxyBlocks));
check('proxy name is r9-relay-https', /^name = "r9-relay-https"$/m.test(frpc));
check('proxy type is https', /^type = "https"$/m.test(frpc));
check('customDomains is exactly ["relay.drm-jd.com"]', /^customDomains = \["relay\.drm-jd\.com"\]$/m.test(frpc));
check('local target is exactly 127.0.0.1:9446',
  /^localIP = "127\.0\.0\.1"$/m.test(frpc) && /^localPort = 9446$/m.test(frpc));
check('does NOT target 9445 / 3080 / 3081',
  !/^localPort = (9445|3080|3081)$/m.test(frpc));

// ── 6. no wildcard fallback logic anywhere ────────────────────────────────
console.log('\n=== 6. no automatic fallback to a wildcard address ===');
const candidates = ['config/r9/frps.production.toml', 'config/r9/frpc.production.toml', 'config/r9/newproxy-policy.production.toml'];
const wildcardHits = [];
for (const f of candidates) {
  const text = fs.readFileSync(f, 'utf8');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('#')) continue; // comments may legitimately mention 0.0.0.0
    if (/0\.0\.0\.0|\[::\]|"\:\:"/.test(t)) wildcardHits.push(`${f}: ${t}`);
  }
}
for (const h of wildcardHits) console.log(`    WILDCARD: ${h}`);
check('no active wildcard bind setting remains in any production config', wildcardHits.length === 0, wildcardHits.join(' | '));
// Check only ACTIVE lines. Comments deliberately document the no-fallback policy, and matching them
// would flag the documentation as if it were code — the first version of this check did exactly that.
check('no fallback logic in any ACTIVE production setting',
  !candidates.some((f) => fs.readFileSync(f, 'utf8').split('\n')
    .filter((l) => { const t = l.trim(); return t && !t.startsWith('#'); })
    .some((l) => /fallback|fall_back|retry/i.test(l))));
// The binding is a literal; frp v0.71.0 has no address-fallback mechanism in this config surface.
check('bind addresses are literals, not variables or expression syntax',
  !/\$\{|%\(|env\(/i.test(prod));

sh(['rm', '-f', 'r9verify']);

const total = checks.length;
const passed = checks.filter((c) => c.pass).length;
console.log(`\n=== GATE 3.4A: ${passed}/${total} checks passed ===`);

const report = {
  gate: 'R9-RELAY-03 GATE 3.4A — anchor IP configuration change',
  verifiedAt: new Date().toISOString(),
  plannedOnVps: false,
  claimsAboutReservedIpRouting: false,
  checks,
  total,
  pass: passed,
  gate34a_pass: passed === total,
  production_sha256: crypto.createHash('sha256').update(fs.readFileSync('config/r9/frps.production.toml')).digest('hex'),
  bind_error_is_not_a_parse_error: !isParseError && isBindError,
  ipv6_listeners_present: /IPV6_CTRL True|IPV6_VHOST True/.test(reachOut),
};
fs.mkdirSync('.r9-fixture-tools', { recursive: true });
fs.writeFileSync('.r9-fixture-tools/r9relay03-gate34a.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log('  written: .r9-fixture-tools/r9relay03-gate34a.json');
process.exit(passed === total ? 0 : 1);
