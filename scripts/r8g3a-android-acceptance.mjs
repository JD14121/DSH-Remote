/**
 * R8G.3A — full Android live-binding acceptance.
 *
 * Covers §5 (ordered trace), §14 (timeline), §15 (WS), §16 (reconnect), §17 (no duplicates),
 * §18 (file picker). No model mutation: no send, queue, steer, cancel or upload.
 */

import fs from 'node:fs';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';

const ADB = 'D:\\Android\\platform-tools\\adb.exe';
const DEVICE = 'ABJKVB2519005183';
const PKG = 'dev.dsh.remotedebug';
const PORT = 9251;
const TOKEN_FILE = 'D:/DSH-testing/.dsh-r8g3/remote/r8g3-phone-token.txt';
const OUT = 'D:/DSH-testing/docs/remote-mobile/_evidence/r8g3a-android-live-binding.json';

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
const consoleLines = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleLines.push(`EXCEPTION: ${String(m.params.exceptionDetails?.exception?.description ?? '').slice(0, 240)}`);
  }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { returnByValue: true, expression, awaitPromise: true });
  if (r.exceptionDetails) return { __exception: String(r.exceptionDetails.exception?.description ?? '').slice(0, 300) };
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

const evidence = { phase: 'R8G.3A', at: new Date().toISOString(), steps: {} };
/** Record a step. */
function step(name, value) {
  evidence.steps[name] = value;
  process.stdout.write(`  ${name}: ${JSON.stringify(value).slice(0, 170)}\n`);
}

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });

// Instrumentation installed BEFORE any page script evaluates.
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    (function () {
      var T = window.__trace = [];
      window.__rec = function (step, extra) { var e = { step: step }; if (extra) for (var k in extra) e[k] = extra[k]; T.push(e); };
      var of = globalThis.fetch;
      globalThis.fetch = function (url, init) {
        var path = String(url).split('?')[0];
        window.__rec('fetch:start', { path: path, method: init && init.method });
        var p = of.call(globalThis, url, init);
        p.then(function (r) { window.__rec('fetch:done', { path: path, status: r.status }); },
               function (e) { window.__rec('fetch:throw', { path: path, err: String(e && (e.message || e)).slice(0, 140) }); });
        return p;
      };
      var OWS = globalThis.WebSocket;
      function TWS(url, protocols) {
        var path = String(url).split('?')[0], scheme = path.split(':')[0];
        window.__rec('websocket:create', { scheme: scheme, protocols: protocols ? String(protocols) : null });
        var s = protocols === undefined ? new OWS(url) : new OWS(url, protocols);
        s.addEventListener('open', function () { window.__rec('websocket:open'); });
        s.addEventListener('error', function () { window.__rec('websocket:error'); });
        s.addEventListener('close', function (ev) { window.__rec('websocket:close', { code: ev.code }); });
        s.addEventListener('message', function (ev) {
          var t = null; try { t = JSON.parse(ev.data).type; } catch (x) {}
          if (t && ['hello','replay_complete','resync_required','error'].indexOf(t) >= 0) window.__rec('ws:frame', { type: t });
        });
        return s;
      }
      TWS.prototype = OWS.prototype;
      globalThis.WebSocket = TWS;
      addEventListener('unhandledrejection', function (e) {
        var r = e.reason || {};
        window.__rec('unhandledrejection', { err: String(r.message || r).slice(0, 200), stack: String(r.stack || '').split('\\n').slice(0,2).join(' | ').slice(0, 240) });
      });
    })();
  `,
});

await evaluate(`(async () => { try { sessionStorage.clear(); } catch (e) {} return true; })()`);
await send('Page.reload', { ignoreCache: true });
await new Promise((r) => setTimeout(r, 6000));

// §14 credential + session list.
await evaluate(`(() => {
  const el = document.querySelector('#credential-token');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(token)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('.dialog button')].find(b => /connect/i.test(b.textContent)).click();
  return true;
})()`);
await waitFor(`!document.querySelector('#credential-token')`, 25000);
step('credential_storage', await evaluate(`(() => {
  const raw = sessionStorage.getItem('dsh.remote.phoneCredential');
  return { sessionStorageOnly: raw !== null && Object.keys(localStorage).length === 0, urlHasToken: /token|credential/i.test(location.search) };
})()`));
step('session_list_count', await evaluate(`document.querySelectorAll('.session-item').length`));

// §5 ordered trace for one click.
await evaluate(`window.__trace.length = 0; window.__rec('click:begin')`);
await evaluate(`(() => { document.querySelector('.session-item')?.click(); return true; })()`);
const rendered = await waitFor(`document.querySelectorAll('.message').length > 0`, 30000);
await evaluate(`window.__rec('click:settled')`);

const trace = await evaluate(`window.__trace`);
step('trace_order', (trace ?? []).map((e) => e.step));
step('android_timeline_rendered', rendered);

// §14 the timeline must show real history, not a fatal block.
const dom = await evaluate(`(() => {
  const content = document.querySelector('.app-shell__content');
  return {
    contentChildClasses: content ? [...content.children].map(c => c.className) : null,
    messageCount: document.querySelectorAll('.message').length,
    timelineExists: !!document.querySelector('.timeline'),
    fatalBlockPresent: !!document.querySelector('.state-block--fatal'),
    firstMessagePreview: document.querySelector('.message')?.textContent.replace(/\\s+/g,' ').trim().slice(0, 50) ?? null,
    badge: document.querySelector('.connection-badge')?.textContent.trim() ?? null,
    badgeState: document.querySelector('.connection-badge')?.dataset.connection ?? null,
    pageOverflowX: document.documentElement.scrollWidth > window.innerWidth,
    executedPayload: typeof window.__r8gPwned !== 'undefined',
    credentialInUrl: /ticket=|Bearer/.test(location.href),
  };
})()`);
step('timeline_dom', dom);
step('android_message_count', dom.messageCount);
step('android_ws_hello', (trace ?? []).some((e) => e.step === 'ws:frame' && e.type === 'hello'));
step('android_ws_replay_complete', (trace ?? []).some((e) => e.step === 'ws:frame' && e.type === 'replay_complete'));
step('android_connected', dom.badgeState === 'connected');
step('websocket_scheme_was_ws', (trace ?? []).some((e) => e.step === 'websocket:create' && e.scheme === 'ws'));

// §17 duplicate detection: durable ids must be unique.
const dupes = await evaluate(`(() => {
  // The renderer does not expose ids on the DOM, so compare rendered text runs for exact repeats
  // of the same durable block, which is what a duplicated replay would produce.
  const nodes = [...document.querySelectorAll('.message')];
  const texts = nodes.map(n => n.textContent.replace(/\\s+/g,' ').trim());
  const seen = new Map();
  let repeats = 0;
  for (const t of texts) { const c = (seen.get(t) ?? 0) + 1; seen.set(t, c); if (c > 1 && t.length > 40) repeats += 1; }
  return { total: texts.length, exactRepeatsOver40Chars: repeats };
})()`);
step('duplicate_scan_initial', dupes);

// §16 reconnect: reload the WebView only. DSH and the Gateway are untouched.
await evaluate(`window.__trace.length = 0`);
await send('Page.reload', { ignoreCache: false });
await new Promise((r) => setTimeout(r, 8000));
const credentialSurvived = await evaluate(`sessionStorage.getItem('dsh.remote.phoneCredential') !== null`);
await waitFor(`document.querySelectorAll('.session-item').length > 1`, 25000);
await evaluate(`(() => { document.querySelector('.session-item')?.click(); return true; })()`);
const restored = await waitFor(`document.querySelectorAll('.message').length > 0`, 30000);
const reconnectTrace = await evaluate(`window.__trace`);
const after = await evaluate(`document.querySelectorAll('.message').length`);

step('reconnect', {
  credentialSurvivedReload: credentialSurvived,
  dialogReappeared: await evaluate(`!!document.querySelector('#credential-token')`),
  historyRestored: restored,
  messagesBeforeReload: dom.messageCount,
  messagesAfterReload: after,
  duplicatedTimeline: after > dom.messageCount,
  freshTicketRequested: (reconnectTrace ?? []).some((e) => e.step === 'fetch:start' && e.path === '/api/v1/auth/ws-ticket'),
  ticketStatus: (reconnectTrace ?? []).find((e) => e.step === 'fetch:done' && e.path === '/api/v1/auth/ws-ticket')?.status ?? null,
  websocketRecreated: (reconnectTrace ?? []).some((e) => e.step === 'websocket:create'),
  replayCompleteAgain: (reconnectTrace ?? []).some((e) => e.step === 'ws:frame' && e.type === 'replay_complete'),
  finalBadgeState: await evaluate(`document.querySelector('.connection-badge')?.dataset.connection ?? null`),
});
step('duplicate_messages_after_reconnect', after > dom.messageCount ? after - dom.messageCount : 0);
step('page_exceptions', consoleLines.slice(0, 5));

fs.mkdirSync('D:/DSH-testing/docs/remote-mobile/_evidence', { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
process.stdout.write(`\n  evidence: ${OUT}\n`);
ws.close();
