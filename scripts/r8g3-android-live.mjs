/**
 * R8G.3 — Android live acceptance (§14-§21).
 *
 * Drives the installed debug harness against the live Gateway and records non-secret facts only.
 * The Phone token is typed into the credential dialog through the page; it never appears on a
 * command line and never enters the evidence.
 */

import fs from 'node:fs';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';

const ADB = 'D:\\Android\\platform-tools\\adb.exe';
const DEVICE = 'ABJKVB2519005183';
const PKG = 'dev.dsh.remotedebug';
const PORT = 9235;
const TOKEN_FILE = 'D:/DSH-testing/.dsh-r8g3/remote/r8g3-phone-token.txt';
const OUT = 'D:/DSH-testing/docs/remote-mobile/_evidence/r8g3-android-live.json';

const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
const pid = execFileSync(ADB, ['-s', DEVICE, 'shell', 'pidof', PKG], { encoding: 'utf8' }).trim();
spawn(ADB, ['-s', DEVICE, 'forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));

const targets = await new Promise((resolve, reject) => {
  let tries = 0;
  const tick = () => {
    tries += 1;
    http.get({ host: '127.0.0.1', port: PORT, path: '/json/list' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { const l = JSON.parse(body); if (l.length) resolve(l); else retry(); } catch { retry(); } });
    }).on('error', retry);
    function retry() { if (tries > 40) { reject(new Error('no target')); return; } setTimeout(tick, 250); }
  };
  tick();
});

const ws = new globalThis.WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
let nextId = 1;
const pending = new Map();
const net = [];
const exceptions = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent' && m.params.request.url.includes('/api/v1/')) {
    net.push(`REQ ${m.params.request.method} ${m.params.request.url.replace(/ticket=[^&]*/, 'ticket=<redacted>').slice(0, 70)}`);
  }
  if (m.method === 'Network.responseReceived' && m.params.response.url.includes('/api/v1/')) {
    net.push(`RES ${m.params.response.status}`);
  }
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(String(m.params.exceptionDetails?.exception?.description ?? '').slice(0, 160));
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
/** Evaluate in the page. */
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { returnByValue: true, expression, awaitPromise: true });
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description?.slice(0, 240) };
  return r.result?.value;
};
/** Poll until a condition holds. */
async function waitFor(expression, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

const evidence = { phase: 'R8G.3', android_apk_used: true, at: new Date().toISOString(), steps: {} };
/** Record a step. */
function step(name, value) {
  evidence.steps[name] = value;
  process.stdout.write(`  ${name}: ${JSON.stringify(value).slice(0, 180)}\n`);
}

await send('Runtime.enable');
await send('Network.enable');
await send('Page.enable');
// Disable caching and clear the stored credential before reloading, so the run always starts from
// an unauthenticated state. Without this the test inherited a credential from a previous run, the
// dialog never appeared, the submit click hit nothing, and the results were non-deterministic.
await send('Network.setCacheDisabled', { cacheDisabled: true });
await evaluate(`(async () => { try { sessionStorage.clear(); } catch {} return true; })()`);
await send('Page.reload', { ignoreCache: true });
await new Promise((r) => setTimeout(r, 6000));
net.length = 0;

const dialogVisible = await evaluate(`!!document.querySelector('#credential-token')`);
step('credential_dialog_visible', dialogVisible);
step('viewport', await evaluate(`({ w: window.innerWidth, h: window.innerHeight })`));
if (!dialogVisible) {
  step('aborted', 'the credential dialog did not appear, so the run would be measuring stale state');
  fs.mkdirSync('D:/DSH-testing/docs/remote-mobile/_evidence', { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.exit(1);
}

// §14: authenticate through the credential dialog.
await evaluate(`(() => {
  const el = document.querySelector('#credential-token');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(token)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  const connect = [...document.querySelectorAll('.dialog button')].find(b => /connect/i.test(b.textContent));
  connect.click();
  return true;
})()`);

const closed = await waitFor(`!document.querySelector('#credential-token')`, 25000);
step('authenticated_health_accepted', closed);

// When the dialog does not close, record WHY rather than guessing. The transport is read at call
// time now, so its type at this moment is the decisive fact.
if (!closed) {
  step('diagnosis', await evaluate(`(async () => {
    const clientMod = await import('./api/api-client.js');
    const client = new clientMod.ApiClient({});
    const out = {
      ambientFetch: typeof globalThis.fetch,
      clientFetchImpl: typeof client.fetchImpl,
      sourceHasLazyGetter: String(Object.getOwnPropertyDescriptor(clientMod.ApiClient.prototype, 'fetchImpl')?.get ?? '').includes('globalThis.fetch'),
      normalizerUnwraps: String((await import('./api/normalizers.js')).normalizeHealth).includes("pick(body, 'data')"),
      badge: document.querySelector('.connection-badge')?.textContent.trim() ?? null,
    };
    client.setCredential(${JSON.stringify(token)});
    try { const h = await client.health(); out.health = h; }
    catch (e) { out.healthError = { kind: e && e.kind, message: String(e && e.message).slice(0, 120) }; }
    return out;
  })()`));
}

// §8: the credential must be in sessionStorage and nowhere else.
step('credential_storage', await evaluate(`(() => {
  const keys = Object.keys(sessionStorage);
  const raw = sessionStorage.getItem('dsh.remote.phoneCredential');
  return { sessionStorageKeys: keys, credentialStored: raw !== null, shape: raw === null ? null : { length: raw.length }, localStorageKeys: Object.keys(localStorage), urlHasToken: /token|credential/i.test(location.search) };
})()`));

await waitFor(`document.querySelectorAll('.session-item').length > 1`, 25000);
step('session_list', await evaluate(`(() => {
  const items = [...document.querySelectorAll('.session-item')];
  return {
    count: items.length,
    withStatus: items.filter(i => i.dataset.status).length,
    rendered: items.slice(0, 3).map(i => i.textContent.replace(/\\s+/g,' ').trim().slice(0, 44)),
  };
})()`));

step('connection_badge', await evaluate(`(() => {
  const b = document.querySelector('.connection-badge');
  return b ? { text: b.textContent.trim().slice(0, 30), state: b.dataset.connection } : null;
})()`));

// §16: open a real session and read its history.
const clickResult = await evaluate(`(() => {
  const f = document.querySelector('.session-item');
  if (!f) return 'no-item';
  f.click();
  return { tag: f.tagName, role: f.getAttribute('role'), text: f.textContent.replace(/\\s+/g,' ').trim().slice(0, 40) };
})()`);
step('session_clicked', clickResult);
net.length = 0;
const historyReady = await waitFor(`document.querySelectorAll('.message').length > 0`, 30000);
step('message_history_rendered', historyReady);
step('after_click_api_calls', [...new Set(net)].slice(0, 12));
step('after_click_dom', await evaluate(`(() => ({
  messages: document.querySelectorAll('.message').length,
  timelineText: (document.querySelector('.timeline')?.textContent ?? '').replace(/\\s+/g,' ').trim().slice(0, 80),
  emptyState: !!document.querySelector('.empty-state'),
  ariaCurrent: document.querySelector('.session-item[aria-current]')?.textContent.replace(/\\s+/g,' ').trim().slice(0, 34) ?? null,
  banner: (document.querySelector('.app-shell__banners')?.textContent ?? '').replace(/\\s+/g,' ').trim().slice(0, 80) || null,
}))()`));
step('message_history', await evaluate(`(() => {
  const msgs = [...document.querySelectorAll('.message')];
  const pres = [...document.querySelectorAll('pre')];
  return {
    messageCount: msgs.length,
    codeBlocks: pres.length,
    codeBlocksContained: pres.length === 0 ? null : pres.every(p => getComputedStyle(p).overflowX !== 'visible'),
    pageOverflowX: document.documentElement.scrollWidth > window.innerWidth,
    injectedScriptTags: document.querySelectorAll('script').length,
    bodyHasExecutedPayload: typeof window.__r8gPwned !== 'undefined',
  };
})()`));

// §17: the live WebSocket went through ticket -> hello -> replay -> replay_complete.
step('api_calls', [...new Set(net)].slice(0, 18));
step('ticket_requested', net.some((n) => n.includes('/auth/ws-ticket')));
step('exceptions', exceptions.slice(0, 4));

// §18: reconnect by reloading the WebView only. DSH and the Gateway stay untouched.
//
// The reload drops the in-memory session selection, so the test re-selects the same session — that
// is what "reconnect without a duplicated timeline" means. The credential must survive the reload,
// which is the §20 `sessionStorage` question.
const before = await evaluate(`document.querySelectorAll('.message').length`);
const sessionBefore = await evaluate(`document.querySelector('.session-item')?.textContent.replace(/\\s+/g,' ').trim().slice(0, 40) ?? null`);
await send('Page.reload', { ignoreCache: false });
await new Promise((r) => setTimeout(r, 8000));
const credentialSurvived = await evaluate(`sessionStorage.getItem('dsh.remote.phoneCredential') !== null`);
await waitFor(`document.querySelectorAll('.session-item').length > 1`, 25000);
await evaluate(`(() => { const f = document.querySelector('.session-item'); if (f) f.click(); return !!f; })()`);
const historyRestored = await waitFor(`document.querySelectorAll('.message').length > 0`, 30000);
const afterCount = await evaluate(`document.querySelectorAll('.message').length`);
step('reconnect_after_reload', {
  credentialSurvivedReload: credentialSurvived,
  dialogReappeared: await evaluate(`!!document.querySelector('#credential-token')`),
  historyRestored,
  messagesBefore: before,
  messagesAfter: afterCount,
  // A duplicated timeline is the failure this measures: no more messages than the snapshot holds.
  duplicatedTimeline: afterCount > before,
  sessionLabelBefore: sessionBefore,
});

fs.mkdirSync('D:/DSH-testing/docs/remote-mobile/_evidence', { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
process.stdout.write(`\n  evidence: ${OUT}\n`);
ws.close();
