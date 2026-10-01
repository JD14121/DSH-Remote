/**
 * R8G.3A §18 — Android file picker.
 *
 * Taps the composer's attachment control through the page, then observes whether the Android
 * system picker actually opens as a separate window/task. Nothing is uploaded.
 */

import fs from 'node:fs';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';

const ADB = 'D:\\Android\\platform-tools\\adb.exe';
const DEVICE = 'ABJKVB2519005183';
const PKG = 'dev.dsh.remotedebug';
const PORT = 9252;

/** Run adb and return trimmed stdout. */
const sh = (...args) => execFileSync(ADB, ['-s', DEVICE, ...args], { encoding: 'utf8' }).trim();

// A harmless synthetic file for the picker to select.
const pickFile = 'r8g3a-picker-test.txt';
const pickDir = 'D:/DSH-testing/docs/remote-mobile/_evidence';
fs.mkdirSync(pickDir, { recursive: true });
fs.writeFileSync(`${pickDir}/${pickFile}`, 'R8G.3A file-picker acceptance probe. Not uploaded.\n', 'utf8');
sh('push', `${pickDir}/${pickFile}`, `/sdcard/Download/${pickFile}`);
console.log(`  pushed /sdcard/Download/${pickFile}`);

const pid = sh('shell', 'pidof', PKG);
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
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { returnByValue: true, expression, awaitPromise: true });
  if (r.exceptionDetails) return { __exception: String(r.exceptionDetails.exception?.description ?? '').slice(0, 240) };
  return r.result?.value;
};
await send('Runtime.enable');

// Record the focused window before, so the picker opening is an observable change.
const before = sh('shell', 'dumpsys', 'window', 'windows').split('\n')
  .filter((l) => l.includes('mCurrentFocus') || l.includes('mFocusedApp')).join(' | ').slice(0, 200);
console.log('  focus before:', before);

// Tap the attachment control.
const tapped = await evaluate(`(() => {
  const btn = document.querySelector('.composer__attach') ?? [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('attach'));
  if (!btn) return 'no-attach-button';
  btn.click();
  return { label: (btn.getAttribute('aria-label') || '').slice(0, 40), disabled: btn.disabled };
})()`);
console.log('  tapped:', JSON.stringify(tapped));

await new Promise((r) => setTimeout(r, 3500));

const after = sh('shell', 'dumpsys', 'window', 'windows').split('\n')
  .filter((l) => l.includes('mCurrentFocus') || l.includes('mFocusedApp')).join(' | ').slice(0, 200);
console.log('  focus after :', after);

// A picker is a different package in focus (DocumentsUI / Files / MediaStore).
const pickerOpened = /documentsui|com\.android\.documentsui|files|media|picker|chooser/i.test(after);
const changed = before !== after;
console.log(`  picker opened: ${pickerOpened}  (focus changed: ${changed})`);

const evidence = {
  phase: 'R8G.3A',
  android_file_picker_opened: pickerOpened,
  focus_before: before,
  focus_after: after,
  focus_changed: changed,
  attach_button: tapped,
  uploaded: false,
};
fs.writeFileSync('D:/DSH-testing/docs/remote-mobile/_evidence/r8g3a-file-picker.json', `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log('  evidence: docs/remote-mobile/_evidence/r8g3a-file-picker.json');
ws.close();
