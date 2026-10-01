/**
 * R8G.3B §18 — Android picker acceptance using a REAL touch, not a programmatic click.
 *
 * The Chrome/WebView file chooser requires transient user activation. A scripted `input.click()`
 * has none, which is why the earlier probe saw the click land but no chooser appear. A genuine
 * `input tap` dispatches a trusted event, so this is the test that actually exercises the path.
 */

import fs from 'node:fs';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';

const ADB = 'D:\\Android\\platform-tools\\adb.exe';
const DEVICE = 'ABJKVB2519005183';
const PKG = 'dev.dsh.remotedebug';
const PORT = 9262;
const TOKEN_FILE = 'D:/DSH-testing/.dsh-r8g3/remote/r8g3-phone-token.txt';
const OUT = 'D:/DSH-testing/docs/remote-mobile/_evidence/r8g3b-attachment-input.json';
const PICK_FILE = 'r8g3b-picker-test.txt';

const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
const sh = (...args) => execFileSync(ADB, ['-s', DEVICE, ...args], { encoding: 'utf8' });

const pid = sh('shell', 'pidof', PKG).trim();
spawn(ADB, ['-s', DEVICE, 'forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1600));

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
const apiCalls = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent' && m.params.request.url.includes('/api/v1/')) {
    apiCalls.push(m.params.request.method + ' ' + m.params.request.url.split('?')[0]);
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
/** Focused window class name. */
const focusName = () => {
  const line = sh('shell', 'dumpsys', 'window', 'windows').split('\n').find((l) => l.includes('mCurrentFocus')) ?? '';
  return line.trim().replace(/Window\{[^}]*\}\s*/, '').replace(/\s+/g, ' ').slice(0, 80);
};

const evidence = { phase: 'R8G.3B', at: new Date().toISOString(), steps: {} };
/** Record a step. */
function step(name, value) {
  evidence.steps[name] = value;
  process.stdout.write(`  ${name}: ${JSON.stringify(value).slice(0, 180)}\n`);
}

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await evaluate(`(async () => { try { sessionStorage.clear(); } catch (e) {} return true; })()`);
await send('Page.reload', { ignoreCache: true });
await new Promise((r) => setTimeout(r, 6000));

await evaluate(`(() => {
  const el = document.querySelector('#credential-token');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(token)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('.dialog button')].find(b => /connect/i.test(b.textContent)).click();
  return true;
})()`);
await new Promise((r) => setTimeout(r, 8000));

step('web_file_input_present', await evaluate(`!!document.querySelector('input[type=file]')`));
step('attach_button_wired', await evaluate(`!!document.querySelector('.composer__attach')`));

// The button's centre in CSS pixels, converted to device pixels.
const rect = await evaluate(`(() => {
  const b = document.querySelector('.composer__attach').getBoundingClientRect();
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), dpr: window.devicePixelRatio, w: Math.round(b.width), h: Math.round(b.height) };
})()`);
step('attach_rect_css', rect);
const tapX = Math.round(rect.x * rect.dpr);
const tapY = Math.round(rect.y * rect.dpr);
step('tap_device_px', { x: tapX, y: tapY });

sh('logcat', '-c');
apiCalls.length = 0;
step('focus_before_tap', focusName());

// A genuine touch.
sh('shell', 'input', 'tap', String(tapX), String(tapY));
await new Promise((r) => setTimeout(r, 4000));

const focusAfter = focusName();
step('focus_after_tap', focusAfter);
const pickerOpened = /documentsui|com\.android\.documentsui|media|picker|chooser|files/i.test(focusAfter);
step('android_picker_opened', pickerOpened);

const chooserLog = sh('logcat', '-d', '-t', '200').split('\n')
  .filter((l) => /FileChooser|onShowFileChooser|ACTION_GET_CONTENT|documentsui|DocumentsUI/i.test(l));
step('chooser_log_lines', chooserLog.slice(0, 5).map((l) => l.trim().slice(0, 120)));

step('auto_upload_on_selection', apiCalls.some((c) => c.includes('/uploads')));
step('api_calls_during_tap', [...new Set(apiCalls)]);

fs.writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
process.stdout.write(`\n  evidence: ${OUT}\n`);
ws.close();
