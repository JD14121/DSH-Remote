/**
 * Production Gateway integration — Phase R7 §2, §18, §28, §31.
 *
 * Exercises the real R7 wiring end to end on a **temp root**: the credential from its
 * protected file, a real `AuthService`, the real R3/R6 HTTP + WebSocket server, and the
 * real R5 persistence initialisation. Only the DSH adapter is stubbed, because Gate A
 * must not contact a real DSH.
 *
 * This is the test that would have caught a mis-wired auth token: the earlier ad-hoc
 * check used a token unrelated to the store, so a `401` was the correct answer and the
 * check was meaningless.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  aclSupported,
  cookieNameForAuthority,
  currentUserSid,
  hardenAcl,
  makeTempProduction,
  prepareProductionRoot,
  verifyAcl,
} from './r7-helpers.mjs';

/**
 * Build the whole production gateway on a temp root.
 *
 * @param {object} [options] - overrides.
 * @returns {Promise<object>} the fixture.
 */
async function gatewayFixture(options = {}) {
  const { config, cleanup } = makeTempProduction({
    gatewayPort: options.gatewayPort ?? 49_700,
    ...(options.dshPort === undefined ? {} : { dshPort: options.dshPort }),
  });

  if (aclSupported()) {
    const sid = await currentUserSid();
    await prepareProductionRoot({ config, harden: (t) => hardenAcl(t, { sid }), verify: (t, o) => verifyAcl(t, { sid, ...o }) });
  } else {
    fs.mkdirSync(config.paths.root, { recursive: true });
    for (const sub of ['secrets', 'state', 'state/control', 'events', 'logs', 'quarantine']) {
      fs.mkdirSync(`${config.paths.root}/${sub}`, { recursive: true });
    }
  }

  const { CredentialStore } = await import('../../src/remote/production/credential-store.mjs');
  const credential = new CredentialStore({
    paths: config.paths,
    harden: aclSupported() ? hardenAcl : null,
    verify: aclSupported() ? verifyAcl : null,
  });
  await credential.ensure();

  const { CookieAuthProvider } = await import('../../src/remote/production/dsh-bootstrap.mjs');
  const cookieValue = crypto.randomBytes(32).toString('base64url');
  const authority = `${config.dshHost}:${config.dshPort}`;
  const authProvider = new CookieAuthProvider({
    cookie: cookieValue,
    cookieName: cookieNameForAuthority(authority),
    authority,
  });

  const calls = [];
  const adapter = {
    // The R1 contract is a plain array of summaries, not an envelope — the service
    // refuses anything else rather than guessing.
    listSessions: async () => { calls.push('listSessions'); return [{ id: 's-1' }]; },
    getSession: async (id) => { calls.push(`getSession:${id}`); return { id, status: 'idle' }; },
    listMessages: async () => { calls.push('listMessages'); return []; },
    sendMessage: async () => { calls.push('sendMessage'); return {}; },
    cancelOperation: async () => ({ cancelled: true }),
    uploadRaw: async () => ({}),
  };

  const { startProductionGateway } = await import('../../src/remote/production/production-gateway.mjs');
  const gateway = await startProductionGateway({ config, credential, authProvider, adapter });

  return {
    config,
    credential,
    token: credential.requireToken(),
    gateway,
    adapter,
    cookieValue,
    calls,
    baseUrl: `http://127.0.0.1:${config.gatewayPort}`,
    /**
     * Call the gateway.
     *
     * @param {string} requestPath - the path.
     * @param {object} [opts] - headers and method.
     * @returns {Promise<object>} the response.
     */
    async call(requestPath, opts = {}) {
      const headers = { ...(opts.headers ?? {}) };
      // A JSON body needs the matching content type, or the route correctly refuses it
      // with 415 rather than guessing.
      if (opts.body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`http://127.0.0.1:${config.gatewayPort}${requestPath}`, {
        method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
        headers,
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      });
      const text = await response.text();
      let body = null;
      try { body = text.length === 0 ? null : JSON.parse(text); } catch { body = text; }
      return { status: response.status, body, headers: Object.fromEntries(response.headers) };
    },
    /** The credential-bearing headers. */
    get authHeaders() { return { authorization: `Bearer ${credential.requireToken()}` }; },
    /**
     * Stop and clean up.
     *
     * @returns {Promise<void>} resolves when clean.
     */
    async cleanupAll() {
      try { await gateway.stop(); } catch { /* best effort */ }
      cleanup();
    },
  };
}

test('§2: the real gateway starts on loopback with the R5 root initialised', async () => {
  const fixture = await gatewayFixture();
  try {
    assert.equal(fixture.gateway.address.host, '127.0.0.1');
    assert.equal(fixture.gateway.address.port, fixture.config.gatewayPort);
    // §28: the R5 production root really was initialised.
    const recovery = fixture.gateway.server.recovery;
    assert.equal(recovery.lock, 'acquired');
    assert.ok(recovery.journals !== undefined);
    assert.equal(fs.existsSync(fixture.config.paths.format), true);
  } finally {
    await fixture.cleanupAll();
  }
});

test('§5: the credential from the protected file authenticates', async () => {
  const fixture = await gatewayFixture();
  try {
    const health = await fixture.call('/api/v1/health', { headers: fixture.authHeaders });
    assert.equal(health.status, 200, 'the stored credential must authenticate');
    assert.ok('dsh' in health.body.data, 'and unlock the full health view');
  } finally {
    await fixture.cleanupAll();
  }
});

test('§11: unauthenticated health is minimal but data access is refused', async () => {
  const fixture = await gatewayFixture();
  try {
    const health = await fixture.call('/api/v1/health');
    assert.equal(health.status, 200);
    assert.deepEqual(Object.keys(health.body.data).sort(), ['auth', 'gateway', 'request_id']);

    const sessions = await fixture.call('/api/v1/sessions');
    assert.equal(sessions.status, 401);
    assert.equal(sessions.body.error.code, 'AUTH_REQUIRED');
  } finally {
    await fixture.cleanupAll();
  }
});

test('§18: an authenticated request is served, and the adapter is reached through refresh', async () => {
  const fixture = await gatewayFixture();
  try {
    // The list route reads the in-memory view store, so asserting the route works
    // proves the auth boundary was crossed and a well-formed envelope came back.
    const response = await fixture.call('/api/v1/sessions', { headers: fixture.authHeaders });
    assert.equal(response.status, 200);
    assert.equal(response.body.api_version, 1);
    assert.ok(Array.isArray(response.body.data), 'the list is an array');

    // The adapter is the real consumer of the DSH cookie. A refresh is the integration
    // point that reaches it, and it is idempotent, so this is safe to call directly.
    await fixture.gateway.services.sessionsService.refresh();
    assert.ok(
      fixture.calls.includes('listSessions'),
      `the adapter must be called by refresh, saw: ${fixture.calls.join(',') || 'nothing'}`,
    );

    const afterRefresh = await fixture.call('/api/v1/sessions', { headers: fixture.authHeaders });
    assert.equal(afterRefresh.status, 200);
    assert.equal(afterRefresh.body.data.length, 1, 'the session is listed');
    assert.equal(afterRefresh.body.data[0].id, 's-1');
  } finally {
    await fixture.cleanupAll();
  }
});

test('§18: the DSH cookie never appears in a response', async () => {
  const fixture = await gatewayFixture();
  try {
    for (const requestPath of ['/api/v1/health', '/api/v1/sessions']) {
      const response = await fixture.call(requestPath, { headers: fixture.authHeaders });
      const text = `${JSON.stringify(response.body)}\n${JSON.stringify(response.headers)}`;
      assert.equal(text.includes(fixture.cookieValue), false, `${requestPath} must not echo the DSH cookie`);
      assert.equal(text.includes(fixture.token), false, `${requestPath} must not echo the Phone token`);
    }
  } finally {
    await fixture.cleanupAll();
  }
});

test('§32: a real ticket can be minted and a real WebSocket connects', async () => {
  const fixture = await gatewayFixture();
  try {
    const mint = await fixture.call('/api/v1/auth/ws-ticket', {
      method: 'POST',
      headers: fixture.authHeaders,
      body: { session_id: 'session-00000000-0000-0000-0000-000000000001' },
    });
    assert.equal(mint.status, 201, 'a ticket is minted on the real stack');
    const ticket = mint.body.data.ticket;

    // A raw upgrade proves the ticket is accepted at the handshake, which is the only
    // place the WebSocket credential is ever checked.
    const net = await import('node:net');
    const status = await new Promise((resolve, reject) => {
      const socket = net.connect(fixture.config.gatewayPort, '127.0.0.1', () => {
        socket.write([
          `GET /api/v1/events?session_id=session-00000000-0000-0000-0000-000000000001&ticket=${ticket} HTTP/1.1`,
          `Host: 127.0.0.1:${fixture.config.gatewayPort}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', // gitleaks:allow -- reviewed synthetic fixture, not a deployment credential
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Protocol: dsh-remote-v1',
          '', '',
        ].join('\r\n'));
      });
      let buffer = '';
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(buffer)?.[1] ?? 0));
      };
      socket.on('data', (chunk) => { buffer += chunk.toString('utf8'); if (buffer.includes('\r\n\r\n')) finish(); });
      socket.on('error', reject);
      setTimeout(finish, 2000);
    });
    assert.equal(status, 101, 'the ticket is accepted by the real upgrade path');
  } finally {
    await fixture.cleanupAll();
  }
});

test('§31: shutdown releases the gateway and its persistence lock', async () => {
  const fixture = await gatewayFixture();
  try {
    await fixture.call('/api/v1/health', { headers: fixture.authHeaders });
    const stopped = await fixture.gateway.stop();
    assert.ok(stopped !== undefined);

    // A second gateway on the same root must be able to acquire the lock, which proves
    // the first released it.
    const { startProductionGateway } = await import('../../src/remote/production/production-gateway.mjs');
    const second = await startProductionGateway({
      config: fixture.config,
      credential: fixture.credential,
      authProvider: { getAuth: async () => ({ cookie: 'x', authority: 'a' }) },
      adapter: fixture.adapter,
    });
    assert.equal(second.server.recovery.lock, 'acquired');
    await second.stop();
  } finally {
    await fixture.cleanupAll();
  }
});

test('§39: the gateway run leaves no credential in the durable root', async () => {
  const fixture = await gatewayFixture();
  try {
    await fixture.call('/api/v1/sessions', { headers: fixture.authHeaders });
    await fixture.gateway.stop();

    const { scanTreeForSecrets } = await import('./r7-helpers.mjs');
    const scan = scanTreeForSecrets(fixture.config.paths.root, [fixture.cookieValue]);
    assert.deepEqual(scan.leaked, [], 'the DSH cookie is memory-only');

    const tokenFiles = scanTreeForSecrets(fixture.config.paths.root, [fixture.token]).leaked
      .filter((file) => !file.endsWith('phone-token.v1'));
    assert.deepEqual(tokenFiles, [], 'the Phone token is only in its own file');
  } finally {
    await fixture.cleanupAll();
  }
});
