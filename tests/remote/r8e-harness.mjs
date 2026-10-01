import { ApiClient } from '../../src/remote/ui/api/api-client.js';
import { RealModeController } from '../../src/remote/ui/api/real-mode.js';
import { CredentialStore, createMemoryStorage } from '../../src/remote/ui/api/credential-store.js';
import { LiveSessionBinding } from '../../src/remote/ui/ws/live-session.js';
import { startWsFixture, helloFrame, replayCompleteFrame } from './r8d-harness.mjs';

export function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

/** Real HTTP/WS transports; only the upstream session/history data is controlled. */
export async function recoveryFixture(options = {}) {
  const f = await startWsFixture();
  f.requests = [];
  f.restStatus = 200;
  f.hold = null;
  f.seed = 40;
  f.status = 'completed';
  f.history = [{ id: 'final', session_id: 's', role: 'assistant', content: 'server final', source_sequence: 900 }];
  f.page = { has_more: false, through_seq: 900, next_before_seq: null };
  const ticketHandler = f.server.listeners('request')[0];
  f.server.removeAllListeners('request');
  f.server.on('request', async (req, res) => {
    const url = new URL(req.url, f.baseUrl);
    f.requests.push({ path: url.pathname, search: url.search });
    if (url.pathname.endsWith('/ws-ticket')) {
      if (f.ticketStatus) { res.writeHead(f.ticketStatus); res.end('{}'); return; }
      ticketHandler(req, res); return;
    }
    if (req.headers.authorization !== 'Bearer good-token') { res.writeHead(401); res.end('{}'); return; }
    if (url.pathname.endsWith('/health')) {
      res.end(JSON.stringify({ auth: {}, dsh: {}, persistence: {}, ready: true })); return;
    }
    if (url.pathname === '/api/v1/sessions') {
      res.end(JSON.stringify({ api_version: 1, data: [{ id: 's', status: f.status, last_sequence: f.seed }], page: {} })); return;
    }
    const id = decodeURIComponent(url.pathname.split('/')[4]);
    const messages = url.pathname.endsWith('/messages');
    if (messages && f.hold) await f.hold.promise;
    if (f.restStatus === 'network') { req.socket.destroy(); return; }
    if (f.restStatus !== 200) { res.writeHead(f.restStatus); res.end('{}'); return; }
    const body = messages
      ? { api_version: 1, data: f.history.map(m => ({ ...m, session_id: id })), page: f.page }
      : { api_version: 1, data: { id, status: f.status, last_sequence: f.seed } };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  f.onConnection = c => { c.send(helloFrame({ sessionId: c.sessionId })); c.send(replayCompleteFrame({ sequence: f.seed })); };
  const client = new ApiClient({ baseUrl: f.baseUrl, credential: 'good-token' });
  const credentials = new CredentialStore({ storage: createMemoryStorage() });
  credentials.write('good-token');
  const live = new LiveSessionBinding({ baseUrl: f.baseUrl, credential: 'good-token', backoffMs: [10] });
  const owner = new RealModeController({ client, live, credentials, recoveryTimeoutMs: options.timeoutMs ?? 1000 });
  owner.state = { ...owner.state, activeSessionId: 's', connection: 'resync_required', domain: 'running',
    draft: 'unsent draft', attachments: [{ id: 'local', name: 'file.txt', state: 'selected', file: { local: true } }],
    messages: [{ id: 'partial', role: 'assistant', content: 'old partial', interrupted: true }] };
  owner.recovery.requireResync({ reason: 'gap' });
  return { f, owner, recovery: owner.recovery, live, client, credentials,
    async stop() { f.hold?.resolve(); owner.recovery.dispose(); await f.stop(); } };
}
