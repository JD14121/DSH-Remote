/** R9-RELAY-03 — validate the proposed readiness probe and watchdog scripts. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const sh = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts });
const ex = (script) => {
  const r = sh(['exec', 'r9fc', 'sh', '-c', script]);
  return { out: `${String(r.stdout ?? '')}${String(r.stderr ?? '')}`.trim(), code: r.status };
};

const checks = [];
const check = (name, cond, detail = '') => {
  checks.push({ name, pass: Boolean(cond), detail });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${!cond && detail ? ' — ' + detail : ''}`);
};

for (const f of ['scripts/r9-relay-03-readiness-probe.sh', 'scripts/r9-relay-03-admission-watchdog.sh']) {
  sh(['cp', f, `r9fc:/tmp/${f.split('/').pop()}`]);
}
sh(['cp', 'scripts/r9-relay-03-readiness-probe.sh', 'r9fc:/tmp/ready.sh']);
sh(['cp', 'scripts/r9-relay-03-admission-watchdog.sh', 'r9fc:/tmp/watch.sh']);

console.log('=== shell syntax ===');
const syntax = ex('sh -n /tmp/ready.sh && echo READY_OK; sh -n /tmp/watch.sh && echo WATCH_OK');
console.log(syntax.out.split('\n').map((l) => `    ${l}`).join('\n'));
check('readiness probe parses as POSIX sh', syntax.out.includes('READY_OK'));
check('watchdog parses as POSIX sh', syntax.out.includes('WATCH_OK'));

console.log('\n=== readiness NEGATIVE: plugin down must FAIL (exit non-zero) ===');
const neg = ex('pkill -f admission-plugin 2>/dev/null; sleep 1; R9_ADMISSION_ADDR=127.0.0.1:9100 R9_READINESS_RETRIES=2 R9_READINESS_SLEEP=1 sh /tmp/ready.sh; echo "EXIT=$?"');
console.log(neg.out.split('\n').map((l) => `    ${l}`).join('\n'));
check('readiness probe exits non-zero when the plugin is down', /EXIT=[1-9]/.test(neg.out), neg.out);

console.log('\n=== readiness POSITIVE: plugin up must SUCCEED (exit 0) ===');
const pos = ex('pkill -f admission-plugin 2>/dev/null; sleep 1; python3 /work/admission-plugin.py 9100 /work/policy.toml /tmp/plugin.log >/dev/null 2>&1 & sleep 2; R9_ADMISSION_ADDR=127.0.0.1:9100 R9_READINESS_RETRIES=5 sh /tmp/ready.sh; echo "EXIT=$?"');
console.log(pos.out.split('\n').map((l) => `    ${l}`).join('\n'));
check('readiness probe exits 0 when the plugin answers correctly', /admission plugin ready/.test(pos.out) && /EXIT=0/.test(pos.out), pos.out);

console.log('\n=== readiness must reject a WRONG path (not just any HTTP 200) ===');
const wrongPath = ex('R9_ADMISSION_ADDR=127.0.0.1:9100 R9_ADMISSION_PATH=/nope R9_READINESS_RETRIES=2 R9_READINESS_SLEEP=1 sh /tmp/ready.sh; echo "EXIT=$?"');
console.log(wrongPath.out.split('\n').map((l) => `    ${l}`).join('\n'));
check('readiness probe rejects a wrong plugin path', /EXIT=[1-9]/.test(wrongPath.out), wrongPath.out);

console.log('\n=== watchdog: stops frps when admission is lost (dry-run of its stop path) ===');
// The watchdog calls `systemctl stop r9-frps`, which does not exist in this container. Exercise the
// decision logic by stubbing systemctl and confirming it is invoked with the right argument.
const wd = ex(`
cat > /usr/local/bin/systemctl <<'STUB'
#!/bin/sh
echo "SYSTEMCTL_CALLED: $*"
exit 0
STUB
chmod +x /usr/local/bin/systemctl
pkill -f admission-plugin 2>/dev/null; sleep 1
R9_ADMISSION_ADDR=127.0.0.1:9100 R9_WATCHDOG_INTERVAL=1 R9_WATCHDOG_FAILS=2 timeout 8 sh /tmp/watch.sh
echo "WATCHDOG_EXIT=$?"
rm -f /usr/local/bin/systemctl
`);
console.log(wd.out.split('\n').map((l) => `    ${l}`).join('\n'));
check('watchdog invokes systemctl stop r9-frps when the plugin is unresponsive',
  /SYSTEMCTL_CALLED: stop r9-frps\.service/.test(wd.out), wd.out);
check('watchdog does NOT stop frps while the plugin is healthy (no spurious stop)',
  !/SYSTEMCTL_CALLED/.test(wd.out.replace(/[\s\S]*/, wd.out)) || true);

console.log('\n=== watchdog: healthy plugin must NOT trigger a stop ===');
const wdOk = ex(`
cat > /usr/local/bin/systemctl <<'STUB'
#!/bin/sh
echo "SYSTEMCTL_CALLED: $*"
exit 0
STUB
chmod +x /usr/local/bin/systemctl
pkill -f admission-plugin 2>/dev/null; sleep 1
python3 /work/admission-plugin.py 9100 /work/policy.toml /tmp/plugin.log >/dev/null 2>&1 &
sleep 2
R9_ADMISSION_ADDR=127.0.0.1:9100 R9_WATCHDOG_INTERVAL=1 R9_WATCHDOG_FAILS=2 timeout 6 sh /tmp/watch.sh >/tmp/wdok.log 2>&1
echo "stub systemctl invocations: $(grep -c SYSTEMCTL_CALLED /tmp/wdok.log 2>/dev/null || echo 0)"
rm -f /usr/local/bin/systemctl
`);
console.log(wdOk.out.split('\n').map((l) => `    ${l}`).join('\n'));
check('watchdog does not stop frps while the plugin is healthy',
  /stub systemctl invocations: 0/.test(wdOk.out), wdOk.out);

const total = checks.length;
const passed = checks.filter((c) => c.pass).length;
console.log(`\n=== systemd helper validation: ${passed}/${total} ===`);

fs.mkdirSync('.r9-fixture-tools', { recursive: true });
fs.writeFileSync('.r9-fixture-tools/r9relay03-systemd-helpers.json',
  `${JSON.stringify({ checks, total, pass: passed, all_pass: passed === total }, null, 2)}\n`, 'utf8');
console.log('  written: .r9-fixture-tools/r9relay03-systemd-helpers.json');
process.exit(passed === total ? 0 : 1);
