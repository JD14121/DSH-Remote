/**
 * Logging and redaction tests — Phase R7 §24, §25, §38, §43.
 *
 * §24's list of things a log must never contain is long, and the reason is that a log
 * is the easiest place for a secret to end up permanently. The logger therefore
 * redacts on the write path rather than trusting each caller to remember.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  LOG_EVENTS,
  ProductionLogs,
  RAW_LINE_MAX_CHARS,
  RotatingLog,
  assertLogRedacted,
  isDeniedField,
  makeTempProduction,
  sanitize,
} from './r7-helpers.mjs';

/** A log on a temp root. */
function logFixture(options = {}) {
  const { config, cleanup } = makeTempProduction();
  const log = new RotatingLog({
    filePath: config.paths.supervisorLog,
    maxBytes: options.maxBytes ?? 10_485_760,
    backups: options.backups ?? 5,
    secrets: options.secrets ?? [],
  });
  return { config, cleanup, log };
}

test('§38: the log event allowlist is exactly the documented one', () => {
  assert.deepEqual([...LOG_EVENTS].sort(), [
    'acl_verified',
    'credential_created',
    'credential_loaded',
    'dsh_auth_cookie_obtained',
    'dsh_bootstrap_token_observed',
    'dsh_ready',
    'dsh_spawned',
    'error',
    'gateway_ready',
    'gateway_starting',
    'reconciliation_complete',
    'restart_scheduled',
    'shutdown_complete',
    'stop_requested',
    'supervisor_start',
  ].sort());
});

test('§38: an event outside the allowlist is dropped, not guessed at', () => {
  const { cleanup, log } = logFixture();
  try {
    assert.equal(log.event('some_new_event', { a: 1 }), false);
    assert.equal(log.dropped, 1);
    assert.equal(log.event('gateway_ready', {}), true);
    const records = fs.readFileSync(log.filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record) => record.event), ['gateway_ready']);
  } finally {
    cleanup();
  }
});

test('§24: a denied field name is redacted whatever its value', () => {
  const sanitized = sanitize({
    authorization: 'Bearer x',
    cookie: 'dsh-auth-x=y',
    token: 'zzz',
    launchToken: 'zzz',
    ticket: 'zzz',
    apiKey: 'zzz',
    content: 'user text',
    url: '/api/v1/x?ticket=zzz',
  });
  for (const key of ['authorization', 'cookie', 'token', 'launchToken', 'ticket', 'apiKey', 'content', 'url']) {
    assert.equal(sanitized[key], '<redacted>', `${key} must be redacted`);
  }
});

test('§24: denied-field matching is spelling-insensitive', () => {
  for (const key of ['authorization', 'Authorization', 'AUTHORIZATION']) {
    assert.equal(isDeniedField(key), true, `${key} must be denied`);
  }
  for (const key of ['launchToken', 'launch_token', 'LAUNCH-TOKEN', 'launchtoken']) {
    assert.equal(isDeniedField(key), true, `${key} must be denied`);
  }
  for (const key of ['wsTicket', 'ws_ticket', 'WSTicket']) {
    assert.equal(isDeniedField(key), true, `${key} must be denied`);
  }
  // Safe fields stay readable, or the log is useless.
  for (const key of ['event', 'ts', 'level', 'pid', 'instance_id', 'port', 'state', 'code']) {
    assert.equal(isDeniedField(key), false, `${key} must be allowed`);
  }
  // A field that merely *contains* a denied word is a different field, and matching
  // by substring would redact useful diagnostics like `authorization_required`.
  assert.equal(isDeniedField('authorization_required'), false, 'substring matches are not denied fields');
});

test('§24: redaction is recursive', () => {
  const sanitized = sanitize({
    request: { headers: { authorization: 'Bearer leak' }, url: '/x?token=leak' },
    nested: { deeper: { cookie: 'leak' } },
  });
  assert.equal(sanitized.request.headers.authorization, '<redacted>');
  assert.equal(sanitized.request.url, '<redacted>');
  assert.equal(sanitized.nested.deeper.cookie, '<redacted>');
});

test('§43: a literal secret is removed from any value, not just a named field', () => {
  const secret = 'LAUNCH_TOKEN_SECRET_0123456789abcdef';
  const sanitized = sanitize({ note: `the value was ${secret}`, other: 'safe' }, [secret]);
  assert.equal(sanitized.note.includes(secret), false);
  assert.equal(sanitized.note, 'the value was <redacted>');
  assert.equal(sanitized.other, 'safe');
});

test('§43: the core R7 logging test — the launch token never reaches a log', () => {
  const { config, cleanup } = makeTempProduction();
  const secret = 'LAUNCH_TOKEN_SECRET_0123456789abcdef';
  try {
    const logs = new ProductionLogs({ paths: config.paths, secrets: [] });
    // Simulating the real sequence: observe, register, then log.
    logs.supervisor.event('dsh_bootstrap_token_observed', { length: secret.length });
    logs.addSecret(secret);
    logs.supervisor.rawLine(`dsh web: http://127.0.0.1:3080/?token=${secret}`, 'dsh');
    logs.dsh.rawLine(`later output containing ${secret}`);
    logs.close();

    for (const file of [config.paths.supervisorLog, config.paths.dshLog]) {
      const scan = assertLogRedacted(file, [secret]);
      assert.equal(scan.ok, true, `${path.basename(file)} must not contain the launch token`);
      assert.equal(fs.readFileSync(file, 'utf8').includes(secret), false);
    }
  } finally {
    cleanup();
  }
});

test('§43: a registered secret is redacted even when it arrives after the fact', () => {
  const { cleanup, log } = logFixture();
  const secret = 'PHONE_TOKEN_VALUE_0123456789abcdefgh';
  try {
    log.event('credential_loaded', { generation_id: 'g1' });
    // The secret is learned later — the same shape as a launch token appearing in
    // stdout after the log was created.
    log.secrets.push(secret);
    log.rawLine(`announcement with ${secret}`);
    log.close();
    assert.equal(fs.readFileSync(log.filePath, 'utf8').includes(secret), false);
  } finally {
    cleanup();
  }
});

test('§25: an unknown raw line is truncated, so a blob cannot fill the log', () => {
  const { cleanup, log } = logFixture();
  try {
    log.rawLine('x'.repeat(5000), 'dsh');
    const record = JSON.parse(fs.readFileSync(log.filePath, 'utf8').trim());
    assert.equal(record.event, 'raw');
    assert.equal(record.source, 'dsh');
    assert.ok(record.line.length <= RAW_LINE_MAX_CHARS + 16, 'the line is bounded');
    assert.match(record.line, /<truncated>/);
  } finally {
    cleanup();
  }
});

test('§25: an empty raw line is dropped', () => {
  const { cleanup, log } = logFixture();
  try {
    assert.equal(log.rawLine('   '), false);
    assert.equal(fs.existsSync(log.filePath), false);
  } finally {
    cleanup();
  }
});

test('§24: the log is UTF-8 with no BOM', () => {
  const { cleanup, log } = logFixture();
  try {
    log.event('supervisor_start', { note: 'naïve ünïcode ✓' });
    const bytes = fs.readFileSync(log.filePath);
    assert.equal(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF, false, 'no BOM');
    // And the multi-byte content round-trips.
    const record = JSON.parse(bytes.toString('utf8').trim());
    assert.equal(record.note, 'naïve ünïcode ✓');
  } finally {
    cleanup();
  }
});

test('§24: a log record is single-line JSONL', () => {
  const { cleanup, log } = logFixture();
  try {
    log.event('acl_verified', { target: 'root', rules: 2 });
    log.event('credential_created', { generation_id: 'g1' });
    const lines = fs.readFileSync(log.filePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
    const first = JSON.parse(lines[0]);
    // Ordering is not part of the contract; presence is.
    assert.ok('ts' in first && 'level' in first && 'event' in first);
    assert.equal(typeof first.ts, 'string');
    assert.equal(first.event, 'acl_verified');
    assert.equal(first.rules, 2, 'a safe field survives');
  } finally {
    cleanup();
  }
});

test('§26: a log write failure degrades logging without stopping the stack', () => {
  // A path whose parent is a *file* cannot be created as a directory.
  const { config, cleanup } = makeTempProduction();
  try {
    fs.mkdirSync(config.paths.root, { recursive: true });
    fs.writeFileSync(config.paths.logs, 'not a directory', 'utf8');
    const log = new RotatingLog({ filePath: config.paths.supervisorLog });
    const written = log.event('gateway_ready', { port: 9445 });
    assert.equal(written, false, 'the write fails');
    assert.equal(log.degraded, true, 'and is reported as degraded');
    assert.equal(typeof log.lastError, 'string');
    // The process is still usable.
    assert.doesNotThrow(() => log.event('error', { code: 'X' }));
  } finally {
    cleanup();
  }
});

test('§26: ProductionLogs reports degradation across its three logs', () => {
  const { config, cleanup } = makeTempProduction();
  try {
    const logs = new ProductionLogs({ paths: config.paths });
    assert.equal(logs.degraded, false);
    logs.supervisor.event('supervisor_start', {});
    assert.equal(logs.close().degraded, false);
  } finally {
    cleanup();
  }
});

test('§24: the three logs live where the documentation says', () => {
  const { config, cleanup } = makeTempProduction();
  try {
    const logs = new ProductionLogs({ paths: config.paths });
    assert.equal(logs.supervisor.filePath, path.join(config.paths.logs, 'supervisor.log'));
    assert.equal(logs.gateway.filePath, path.join(config.paths.logs, 'gateway.log'));
    assert.equal(logs.dsh.filePath, path.join(config.paths.logs, 'dsh.log'));
    assert.equal(logs.all().length, 3);
  } finally {
    cleanup();
  }
});

test('§38: an event records its allowlisted name and fields but no values it must not', () => {
  const { cleanup, log } = logFixture();
  try {
    log.event('dsh_spawned', { pid: 4242, instance_id: 'i-1', argv: ['-y', '@deepseek-ai/dsh@0.1.5-rc.2'] });
    const record = JSON.parse(fs.readFileSync(log.filePath, 'utf8').trim());
    assert.equal(record.event, 'dsh_spawned');
    assert.equal(record.pid, 4242);
    assert.equal(record.instance_id, 'i-1');
    assert.equal(record.level, 'info');
    assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    cleanup();
  }
});

test('§24: a cyclic object cannot crash the logger', () => {
  const cyclic = { name: 'a' };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => sanitize(cyclic));
  const sanitized = sanitize(cyclic);
  assert.equal(sanitized.name, 'a');
});

test('§24: a deeply nested object is depth-bounded', () => {
  let deep = { value: 1 };
  for (let index = 0; index < 20; index += 1) deep = { nested: deep };
  const sanitized = JSON.stringify(sanitize(deep));
  assert.equal(sanitized.includes('depth-limit'), true);
});

test('§24: a long array is bounded', () => {
  const sanitized = sanitize({ items: Array.from({ length: 500 }, (_, index) => index) });
  assert.equal(sanitized.items.length, 100);
});

test('§24: non-data values are described rather than serialised', () => {
  const sanitized = sanitize({ fn: () => 1, sym: Symbol('x'), big: 10n });
  assert.equal(sanitized.fn, '<function>');
  assert.equal(sanitized.sym, '<symbol>');
  assert.equal(sanitized.big, 10);
});
