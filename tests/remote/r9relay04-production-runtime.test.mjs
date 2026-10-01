import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createFixturePki } from '../../src/remote/r9/fixture-certs.mjs';
import { createR9ProductionBridge, validateR9ProductionConfig } from '../../src/remote/r9/production-runtime.mjs';
import { productionGatewayAuthConfig } from '../../src/remote/production/production-gateway.mjs';
import { OriginPolicy } from '../../src/remote/auth/origin-policy.mjs';

const HOST = 'relay.drm-jd.com';
const ORIGIN = `https://${HOST}`;

async function withSetup(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r9relay04-test-'));
  const pki = createFixturePki({ dir: path.join(dir, 'fixture-pki') });
  const serverIdentity = pki.makeIdentity('production-bridge-fixture', { san: `DNS:${HOST}`, eku: 'serverAuth' });
  const clientIdentity = pki.makeIdentity('android-client-fixture', { eku: 'clientAuth' });
  const otherClientIdentity = pki.makeIdentity('not-enrolled-client-fixture', { eku: 'clientAuth' });
  const uiRoot = path.join(dir, 'ui');
  fs.mkdirSync(path.join(uiRoot, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(uiRoot, 'api'), { recursive: true });
  fs.writeFileSync(path.join(uiRoot, 'index.html'), '<!doctype html><title>R9 UI fixture</title><script src="/assets/app.js"></script>');
  fs.writeFileSync(path.join(uiRoot, 'assets', 'app.js'), 'window.fixtureUi = true;');
  fs.writeFileSync(path.join(uiRoot, 'api', 'real-mode.js'), 'export const realMode = true;');
  const uiFiles = ['index.html', 'assets/app.js', 'api/real-mode.js'].map((relative) => {
    const data = fs.readFileSync(path.join(uiRoot, relative));
    return { path: relative, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  });
  const uiManifestPath = path.join(dir, 'ui-manifest.json');
  fs.writeFileSync(uiManifestPath, JSON.stringify({ version: 1, files: uiFiles }));

  const seen = [];
  const upstreamSockets = new Set();
  let wsUpgrades = 0;
  const usedTickets = new Set();
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url, host: req.headers.host, origin: req.headers.origin ?? null, authorization: req.headers.authorization ?? null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  upstream.on('connection', (socket) => { upstreamSockets.add(socket); socket.on('close', () => upstreamSockets.delete(socket)); });
  upstream.on('upgrade', (req, socket) => {
    seen.push({ method: req.method, path: req.url, host: req.headers.host, origin: req.headers.origin ?? null, authorization: req.headers.authorization ?? null, upgrade: true });
    const ticket = new URL(req.url, `http://${req.headers.host}`).searchParams.get('ticket');
    if (req.url !== '/api/v1/events?ticket=synthetic-one-time-ticket'
      || req.headers.origin !== ORIGIN
      || req.headers.host !== `127.0.0.1:${upstream.address().port}`
      || req.headers['sec-websocket-protocol'] !== 'dsh-remote-v1'
      || ticket === null || usedTickets.has(ticket)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    usedTickets.add(ticket);
    wsUpgrades += 1;
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Protocol: dsh-remote-v1\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const config = {
    listenHost: '127.0.0.1', listenPort: 9446, publicHostname: HOST,
    httpsCertPath: serverIdentity.crt, httpsKeyPath: serverIdentity.key,
    androidClientCaPath: pki.caCert, enrolledIdentityFingerprints: [pki.fingerprint(clientIdentity.crt)],
    uiRoot, uiManifestPath, gatewayUpstreamHost: '127.0.0.1', gatewayUpstreamPort: upstream.address().port,
    gatewayAllowedOrigins: [ORIGIN],
  };
  try { await run({ dir, pki, clientIdentity, otherClientIdentity, config, upstream, seen, get wsUpgrades() { return wsUpgrades; } }); }
  finally {
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
    pki.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('production config has the explicit public, TLS, identity, UI and fixed loopback upstream model', async () => {
  await withSetup(({ config }) => {
    config.gatewayUpstreamPort = 9445;
    const valid = validateR9ProductionConfig(config);
    assert.equal(valid.publicHostname, HOST);
    assert.equal(valid.listenHost, '127.0.0.1');
    assert.equal(valid.listenPort, 9446);
    assert.equal(valid.gatewayUpstreamHost, '127.0.0.1');
  });
});

test('production config refuses non-loopback listeners and upstreams, missing CA, missing TLS identity, and empty allowlists', async () => {
  await withSetup(({ config, dir }) => {
    for (const bad of [
      { ...config, listenHost: '0.0.0.0' },
      { ...config, gatewayUpstreamHost: '192.0.2.1' },
      { ...config, androidClientCaPath: path.join(dir, 'missing-ca.pem') },
      { ...config, httpsCertPath: path.join(dir, 'missing-cert.pem') },
      { ...config, httpsKeyPath: path.join(dir, 'missing-key.pem') },
      { ...config, enrolledIdentityFingerprints: [] },
      { ...config, gatewayAllowedOrigins: ['*'] },
    ]) assert.throws(() => validateR9ProductionConfig(bad));
    assert.throws(() => validateR9ProductionConfig({ ...config, gatewayUpstreamPort: 9445 }, { testMode: true }), /must not target accepted or production ports/);
  });
});

test('production Gateway OriginPolicy receives exactly the relay UI origin', () => {
  const authConfig = productionGatewayAuthConfig([ORIGIN]);
  assert.deepEqual(authConfig.allowedOrigins, [ORIGIN]);
  const policy = new OriginPolicy({ port: 9445, allowedOrigins: authConfig.allowedOrigins });
  assert.equal(policy.check(ORIGIN).allowed, true);
  assert.equal(policy.check('https://wrong.example').allowed, false);
  assert.throws(() => productionGatewayAuthConfig(['*']));
  assert.deepEqual(productionGatewayAuthConfig([]).allowedOrigins, []);
});

test('production launcher refuses the material-missing template before listening', () => {
  const configPath = fileURLToPath(new URL('../../config/r9/bridge.r9-04.production.example.json', import.meta.url));
  const launcher = fileURLToPath(new URL('../../scripts/r9-relay-04.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [launcher], {
    encoding: 'utf8',
    env: { ...process.env, R9_RELAY_04_CONFIG: configPath },
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /R9-04 startup refused: HTTPS server certificate is missing/);
  assert.doesNotMatch(result.stdout, /listening on/);
});

test('R9-04 serves same-origin UI and proxies only approved API routes with exact relay Host and Origin', async () => {
  await withSetup(async ({ config, clientIdentity, pki, seen }) => {
    const bridge = createR9ProductionBridge(config, { testMode: true });
    const port = await bridge.listen(0);
    try {
      const ui = await request(port, '/', clientIdentity, config);
      assert.equal(ui.status, 200);
      assert.match(ui.body, /R9 UI fixture/);
      assert.match(ui.headers['content-security-policy'], /default-src 'self'/);
      const asset = await request(port, '/assets/app.js', clientIdentity, config);
      assert.equal(asset.status, 200);
      assert.match(asset.body, /fixtureUi/);
      const appModule = await request(port, '/api/real-mode.js', clientIdentity, config);
      assert.equal(appModule.status, 200);
      assert.match(appModule.headers['content-type'], /javascript/);
      assert.match(appModule.body, /realMode/);
      const unlistedModule = await request(port, '/api/unlisted.js', clientIdentity, config);
      assert.equal(unlistedModule.status, 404);
      const head = await request(port, '/assets/app.js', clientIdentity, config, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.body, '');
      assert.equal(seen.length, 0, 'static UI and allowlisted /api/*.js modules must never reach the Gateway upstream');
      const api = await request(port, '/api/v1/health', clientIdentity, config, { headers: { Origin: ORIGIN, Authorization: 'Bearer synthetic-only' } });
      assert.equal(api.status, 200);
      assert.deepEqual(seen.at(-1), { method: 'GET', path: '/api/v1/health', host: '127.0.0.1:' + config.gatewayUpstreamPort, origin: ORIGIN, authorization: 'Bearer synthetic-only' });
      const ticket = await request(port, '/api/v1/auth/ws-ticket', clientIdentity, config, { method: 'POST', headers: { Origin: ORIGIN, Authorization: 'Bearer synthetic-only', 'Content-Length': '0' } });
      assert.equal(ticket.status, 200);
      assert.equal(seen.at(-1).origin, ORIGIN);
      assert.equal(seen.at(-1).authorization, 'Bearer synthetic-only');
      const rejected = await request(port, '/api/v1/unknown', clientIdentity, config, { headers: { Origin: ORIGIN } });
      assert.equal(rejected.status, 404);
      assert.equal(seen.length, 2);
    } finally { await bridge.stop(); }
  });
});

test('wrong production Origin is rejected before the synthetic upstream sees it', async () => {
  await withSetup(async ({ config, clientIdentity, seen }) => {
    const bridge = createR9ProductionBridge(config, { testMode: true });
    const port = await bridge.listen(0);
    try {
      const response = await request(port, '/api/v1/auth/ws-ticket', clientIdentity, config, { method: 'POST', headers: { Origin: 'https://wrong.example', 'Content-Length': '0' } });
      assert.equal(response.status, 403);
      assert.equal(seen.length, 0);
    } finally { await bridge.stop(); }
  });
});

test('wrong Host, wrong SNI, unlisted identity and missing client identity cannot reach upstream', async () => {
  await withSetup(async ({ config, clientIdentity, otherClientIdentity, seen }) => {
    const bridge = createR9ProductionBridge(config, { testMode: true });
    const port = await bridge.listen(0);
    try {
      const wrongHost = await request(port, '/api/v1/health', clientIdentity, config, { headers: { Host: 'relay.attacker.example' } });
      assert.equal(wrongHost.status, 400);
      await assert.rejects(request(port, '/api/v1/health', clientIdentity, config, { servername: 'wrong.example' }));
      await assert.rejects(request(port, '/api/v1/health', otherClientIdentity, config));
      await assert.rejects(request(port, '/api/v1/health', null, config));
      assert.equal(seen.length, 0);
    } finally { await bridge.stop(); }
  });
});

test('static traversal and unknown API routes never reach the Gateway upstream', async () => {
  await withSetup(async ({ config, clientIdentity, seen }) => {
    const bridge = createR9ProductionBridge(config, { testMode: true });
    const port = await bridge.listen(0);
    try {
      const traversal = await request(port, '/%2e%2e/package.json', clientIdentity, config);
      assert.notEqual(traversal.status, 200);
      const unknown = await request(port, '/api/v1/not-allowlisted', clientIdentity, config, { headers: { Origin: ORIGIN } });
      assert.equal(unknown.status, 404);
      assert.equal(seen.length, 0);
    } finally { await bridge.stop(); }
  });
});

test('valid WebSocket route preserves the exact relay Origin and makes one upstream upgrade', async () => {
  await withSetup(async (setup) => {
    const { config, clientIdentity, seen } = setup;
    const bridge = createR9ProductionBridge(config, { testMode: true });
    const port = await bridge.listen(0);
    try {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/api/v1/events?ticket=synthetic-one-time-ticket`, 'dsh-remote-v1', {
        ...tlsClientOptions(config, clientIdentity),
        headers: { Host: HOST, Origin: ORIGIN },
      });
      await waitForWebSocketOpen(ws, seen);
      assert.equal(setup.wsUpgrades, 1);
      assert.equal(seen.at(-1).origin, ORIGIN);
      assert.equal(seen.at(-1).host, `127.0.0.1:${config.gatewayUpstreamPort}`);
      assert.equal(seen.at(-1).path, '/api/v1/events?ticket=synthetic-one-time-ticket');
      ws.close();

      const replay = new WebSocket(`wss://127.0.0.1:${port}/api/v1/events?ticket=synthetic-one-time-ticket`, 'dsh-remote-v1', {
        ...tlsClientOptions(config, clientIdentity), headers: { Host: HOST, Origin: ORIGIN },
      });
      await waitForWebSocketError(replay);
      assert.equal(setup.wsUpgrades, 1, 'the synthetic one-time ticket must not be accepted twice');
    } finally { await bridge.stop(); }
  });
});

test('WebSocket with a wrong Origin cannot reach the synthetic Gateway upgrade handler', async () => {
  await withSetup(async ({ config, clientIdentity, seen, wsUpgrades }) => {
    const bridge = createR9ProductionBridge(config, { testMode: true });
    const port = await bridge.listen(0);
    try {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/api/v1/events?ticket=synthetic-one-time-ticket`, 'dsh-remote-v1', {
        ...tlsClientOptions(config, clientIdentity), headers: { Host: HOST, Origin: 'https://wrong.example' },
      });
      await waitForWebSocketError(ws);
      assert.equal(seen.length, 0);
      assert.equal(wsUpgrades, 0);
    } finally { await bridge.stop(); }
  });
});

test('a WebSocket upgrade on a static UI path is refused before upstream proxying', async () => {
  await withSetup(async ({ config, clientIdentity, seen }) => {
    const bridge = createR9ProductionBridge(config, { testMode: true });
    const port = await bridge.listen(0);
    try {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/index.html`, 'dsh-remote-v1', {
        ...tlsClientOptions(config, clientIdentity), headers: { Host: HOST, Origin: ORIGIN },
      });
      await waitForWebSocketError(ws);
      assert.equal(seen.length, 0, 'static resources cannot be an upstream WebSocket route');
    } finally { await bridge.stop(); }
  });
});

function tlsClientOptions(config, identity, servername = HOST) {
  return { ca: fs.readFileSync(config.androidClientCaPath), cert: identity ? fs.readFileSync(identity.crt) : undefined, key: identity ? fs.readFileSync(identity.key) : undefined, rejectUnauthorized: true, servername };
}

function request(port, route, identity, config, options = {}) {
  return new Promise((resolve, reject) => {
    const req = requireHttpRequest(`https://127.0.0.1:${port}${route}`, {
      ...tlsClientOptions(config, identity),
      servername: options.servername ?? HOST,
      method: options.method ?? 'GET',
      headers: { Host: HOST, ...(options.headers ?? {}) },
    }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end();
  });
}

function waitForWebSocketOpen(ws, seen) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`WebSocket acceptance timed out; upstream observations=${JSON.stringify(seen)}`)), 5_000);
    const onOpen = () => finish();
    const onError = (error) => finish(error);
    const finish = (error) => {
      clearTimeout(timer);
      ws.removeListener('open', onOpen);
      ws.removeListener('error', onError);
      if (error) reject(error); else resolve();
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
  });
}

function waitForWebSocketError(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('expected synthetic Gateway to reject the replayed ticket')), 5_000);
    const onError = () => finish();
    const onOpen = () => finish(new Error('replayed one-time ticket unexpectedly opened a WebSocket'));
    const finish = (error) => {
      clearTimeout(timer);
      ws.removeListener('open', onOpen);
      ws.removeListener('error', onError);
      if (error) reject(error); else resolve();
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
  });
}

import { request as requireHttpRequest } from 'node:https';
