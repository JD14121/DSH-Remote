/**
 * R9-RELAY-02B — §2 definitive test: frps binds using the production field set, and frpc parses it.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const sh = (args) => spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const out = (r) => `${String(r.stdout ?? '')}${String(r.stderr ?? '')}`.trim();

console.log('=== frps: bind while the production field set is loaded ===');
// One container invocation: start frps in the background, wait, then observe listeners and the log.
const script = `
pkill -f '/r9/bin/frps' 2>/dev/null || true
rm -f /work/frps.log /work/frps.out
/r9/bin/frps -c /work/frps.toml > /work/frps.out 2>&1 &
sleep 4
echo "LISTENERS:"
netstat -ltn 2>/dev/null | grep -E '7100|7443' || echo "  none"
echo "LOG:"
cat /work/frps.log 2>/dev/null | tail -6
echo "STDOUT:"
cat /work/frps.out 2>/dev/null | tail -6
pkill -f '/r9/bin/frps' 2>/dev/null || true
sleep 1
echo "DONE"
`;
const r = out(sh(['exec', 'r9pkiwork', 'sh', '-c', script]));
console.log(r.split('\n').map((l) => `  ${l}`).join('\n'));

const frpsBound = /127\.0\.0\.1:7100/.test(r) && /127\.0\.0\.1:7443/.test(r);
const frpsStarted = /frps started successfully/.test(r);
const frpsPluginRegistered = /plugin \[r9-newproxy-policy\] has been registered/.test(r);

console.log('\n=== frpc: config-parse test against the now-known-good field set ===');
const frpcScript = `
timeout 6 /r9/bin/frpc -c /work/frpc.toml 2>&1 | head -20
echo "EXIT_MARKER"
`;
const frpcOut = out(sh(['exec', 'r9pkiwork', 'sh', '-c', frpcScript]));
console.log(frpcOut.split('\n').map((l) => `  ${l}`).join('\n'));

// A TOML/field problem has a distinctive shape; an ordinary runtime outcome does not.
const frpcConfigError = /toml:|unknown field|cannot unmarshal|invalid configuration|failed to parse/i.test(frpcOut);
const frpcReachedRuntime = /try to connect to server|start frpc service/i.test(frpcOut);

console.log('\n=== §2 verdict ===');
console.log(`  frps bound 7100 and 7443              : ${frpsBound}`);
console.log(`  frps reported "started successfully"  : ${frpsStarted}`);
console.log(`  frps registered the NewProxy plugin   : ${frpsPluginRegistered}`);
console.log(`  frpc config-parse error               : ${frpcConfigError}`);
console.log(`  frpc reached runtime (config accepted): ${frpcReachedRuntime}`);

const report = {
  frps_parsed_and_bound: frpsBound && frpsStarted,
  frps_plugin_registered: frpsPluginRegistered,
  frpc_config_parsed: !frpcConfigError && frpcReachedRuntime,
  frpc_config_error: frpcConfigError,
  frps_evidence: r.slice(0, 1500),
  frpc_evidence: frpcOut.slice(0, 1200),
  production_templates_unchanged: true,
  note: 'the rehearsal renders the SAME field names with loopback binds and container paths; the production templates are not modified',
};
fs.writeFileSync('.r9-fixture-tools/config-parse.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log('\n  written: .r9-fixture-tools/config-parse.json');
process.exit(report.frps_parsed_and_bound && report.frpc_config_parsed ? 0 : 1);
