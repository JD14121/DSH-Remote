/**
 * R9-RELAY-03 — pre-exposure reachability baseline.
 *
 * Establishes what is reachable BEFORE any firewall change, so that a later "it works" result cannot be
 * confused with "it was already open". Contacts only TCP; no application data, no SSH.
 *
 * Also determines which of the two recorded addresses is the DNS target: the Droplet's public IPv4 or
 * the Reserved IPv4 (anchor). Those are DIFFERENT values here, and picking the wrong one would point
 * DNS at the wrong place.
 */
import net from 'node:net';

const DROPLET = { name: 'r9-relay-01', region: 'sgp1', publicIpv4: '68.183.180.39', reservedIpv4: '146.190.192.173' };
const PORTS = [22, 80, 443, 7000, 19100];

/** TCP connect with a hard timeout. Returns whether the connection was established. */
function probeTcp(host, port, timeout = 6000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const done = (state, extra = {}) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ port, state, ms: Date.now() - start, ...extra });
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done('open'));
    socket.once('timeout', () => done('filtered'));
    socket.once('error', (err) => done('closed', { code: err.code ?? null }));
    socket.connect(port, host);
  });
}

const results = {};
for (const [label, host] of [['droplet_public_ipv4', DROPLET.publicIpv4], ['reserved_ipv4', DROPLET.reservedIpv4]]) {
  console.log(`\n=== ${label} (${host}) — pre-exposure baseline ===`);
  const rows = [];
  for (const port of PORTS) {
    const r = await probeTcp(host, port);
    rows.push(r);
    const mark = r.state === 'open' ? 'OPEN' : r.state.toUpperCase();
    console.log(`  TCP ${String(port).padEnd(6)} ${mark.padEnd(9)} ${r.ms}ms${r.code ? '  (' + r.code + ')' : ''}`);
  }
  results[label] = { host, rows, anyOpen: rows.some((r) => r.state === 'open') };
}

console.log('\n=== interpretation ===');
const pub = results.droplet_public_ipv4;
const res = results.reserved_ipv4;
console.log(`  Droplet public IPv4 reachable on any probed port : ${pub.anyOpen}`);
console.log(`  Reserved IPv4 reachable on any probed port       : ${res.anyOpen}`);
if (pub.anyOpen && !res.anyOpen) {
  console.log('  -> the Reserved IPv4 is NOT currently serving traffic');
} else if (!pub.anyOpen && !res.anyOpen) {
  console.log('  -> both addresses are closed, as expected with Cloud Firewall inbound NONE');
}

// Which address is the DNS target? The cloud firewall and the droplet both apply to the Reserved IP
// only if it is actually assigned as the droplet's public address. Both must be characterised.
console.log('\n  DNS target determination (needs operator confirmation in Gate 3):');
console.log(`    Reserved IPv4 (anchor) : ${DROPLET.reservedIpv4}`);
console.log(`    Droplet public IPv4    : ${DROPLET.publicIpv4}`);
console.log('    The A record must point at the address that actually forwards to this Droplet once the');
console.log('    firewall opens. The console metadata check (anchor_ipv4) resolves this definitively.');

const report = {
  phase: 'R9-RELAY-03',
  stage: 'pre-exposure reachability baseline',
  observedAt: new Date().toISOString(),
  droplet: DROPLET,
  ports_probed: PORTS,
  results,
  ssh_used: false,
  application_data_sent: false,
  firewall_changed: false,
  dns_modified: false,
  any_port_open_before_change: pub.anyOpen || res.anyOpen,
};
import fs from 'node:fs';
fs.mkdirSync('.r9-fixture-tools', { recursive: true });
fs.writeFileSync('.r9-fixture-tools/r9relay03-baseline.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log('\n  written: .r9-fixture-tools/r9relay03-baseline.json');
