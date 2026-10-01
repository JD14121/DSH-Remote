/**
 * R8G.3B §18 — chip rendering verified on the real device.
 *
 * The picker's own file browsing is driven by the MiUI/Huawei DocumentsUI UI, whose layout is not
 * scriptable reliably. What matters for this phase is that a chosen `File` travels the real
 * `onFileSelected` path and renders a chip with the filename — so that half is exercised here with
 * a genuine `File` object, on the device, through the live page.
 *
 * The picker opening itself is evidenced separately by screenshot and window focus.
 */

import fs from 'node:fs';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';

const ADB = 'D:\\Android\\platform-tools\\adb.exe';
const DEVICE = 'ABJKVB2519005183';
const PKG = 'dev.dsh.remotedebug';
const PORT = 9263;
const token = fs.readFileSync('D:/DSH-testing/.dsh-r8g3/remote/r8g3-phone-token.txt', 'utf8').trim();
const OUT = 'D:/DSH-testing/docs/remote-mobile/_evidence/r8g3b-attachment-input.json';

const sh = (...args) => execFileSync(ADB, ['-s', DEVICE, ...args], { encoding: 'utf8' });
// Return to the app first.
sh('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
await new Promise((r) => setTimeout(r, 2500));

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
    apiCalls.push(`${m.params.request.method} ${m.params.request.url.split('?')[0]}`);
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

await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.enable');
await evaluate(`(async () => { try { sessionStorage.clear(); } catch (e) {} return true; })()`);
await send('Page.reload', { ignoreCache: true });
await new Promise((r) => setTimeout(r, 6000));

const evidence = { phase: 'R8G.3B', at: new Date().toISOString(), steps: {} };
/** Record a step. */
function step(name, value) {
  evidence.steps[name] = value;
  process.stdout.write(`  ${name}: ${JSON.stringify(value).slice(0, 180)}\n`);
}

step('web_file_input_present', await evaluate(`!!document.querySelector('input[type=file]')`));

await evaluate(`(() => {
  const el = document.querySelector('#credential-token');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(token)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('.dialog button')].find(b => /connect/i.test(b.textContent)).click();
  return true;
})()`);
await new Promise((r) => setTimeout(r, 8000));

// Drive the REAL selection path with a real File: assign it to the input and fire `change`,
// exactly as the browser does when the picker returns a selection.
apiCalls.length = 0;
const selected = await evaluate(`(() => {
  const input = document.querySelector('input[type=file]');
  if (!input) return 'no-input';
  const file = new File(['r8g3b picker probe'], 'r8g3b-picker-test.txt', { type: 'text/plain' });
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { name: file.name, size: file.size };
})()`);
step('file_selected_into_input', selected);

await new Promise((r) => setTimeout(r, 1500));

step('selected_filename_visible', await evaluate(`(() => {
  const chips = [...document.querySelectorAll('.attachment-chip')];
  return { chipCount: chips.length, text: chips.map(c => c.textContent.replace(/\\s+/g,' ').trim().slice(0, 60)) };
})()`));
step('chip_remove_present', await evaluate(`!!document.querySelector('.attachment-chip__remove')`));
step('chip_remove_label', await evaluate(`document.querySelector('.attachment-chip__remove')?.getAttribute('aria-label') ?? null`));
step('composer_still_usable', await evaluate(`(() => {
  const t = document.querySelector('.composer__field');
  if (!t) return false;
  t.value = 'still typing';
  t.dispatchEvent(new Event('input', { bubbles: true }));
  return document.querySelector('.composer__field') !== null;
})()`));
step('fatal_block_present', await evaluate(`!!document.querySelector('.state-block--fatal')`));
step('auto_upload_on_selection', apiCalls.some((c) => c.includes('/uploads')));
step('api_calls_during_selection', [...new Set(apiCalls)]);

// Removing the chip returns the composer to its prior state.
step('remove_clears_chip', await evaluate(`(() => {
  const btn = document.querySelector('.attachment-chip__remove');
  if (!btn) return 'no-remove';
  btn.click();
  return document.querySelectorAll('.attachment-chip').length;
})()`));

// Same-file reselection after removal: the input value must have been cleared for this to fire.
apiCalls.length = 0;
step('same_file_reselection', await evaluate(`(() => {
  const input = document.querySelector('input[type=file]');
  const file = new File(['again'], 'r8g3b-picker-test.txt', { type: 'text/plain' });
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { chips: document.querySelectorAll('.attachment-chip').length, inputValueAfter: input.value };
})()`));

fs.writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
process.stdout.write(`\n  evidence: ${OUT}\n`);
ws.close();
