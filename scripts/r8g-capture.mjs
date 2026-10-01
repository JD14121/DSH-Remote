/**
 * R8G screenshot capture: the required viewports and fixture states, over a real browser.
 *
 * Each capture uses a fresh DevTools target and an explicit device-metrics override, so the
 * viewport is exact rather than whatever the window manager produced, and a cache-busted URL.
 *
 * Output: docs/remote-mobile/_evidence/screenshots/
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

const OUT_DIR = 'D:/DSH-testing/docs/remote-mobile/_evidence/screenshots';
fs.mkdirSync(OUT_DIR, { recursive: true });

const PORT = 9333;
const profile = path.join(os.tmpdir(), `r8g-shots-${Date.now()}`);
const child = spawn(EDGE, [
  '--headless', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', 'about:blank',
], { stdio: 'ignore' });

/** Wait for the DevTools endpoint. */
const page = await new Promise((resolve, reject) => {
  let tries = 0;
  const tick = () => {
    tries += 1;
    http.get({ host: '127.0.0.1', port: PORT, path: '/json/list' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const found = JSON.parse(body).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
          if (found) resolve(found); else retry();
        } catch { retry(); }
      });
    }).on('error', retry);
    function retry() {
      if (tries > 80) { reject(new Error('devtools never became ready')); return; }
      setTimeout(tick, 250);
    }
  };
  tick();
});

const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

let nextId = 1;
/** Send a CDP command and await its result. */
function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send('Page.enable');
await send('Runtime.enable');

const SHOTS = [
  { file: 'ready-mobile-390.png', w: 390, h: 844, fixture: 'ready' },
  { file: 'streaming-mobile-390.png', w: 390, h: 844, fixture: 'streaming' },
  { file: 'queued-mobile-390.png', w: 390, h: 844, fixture: 'queued' },
  { file: 'waiting-input-mobile-390.png', w: 390, h: 844, fixture: 'waitingInput' },
  { file: 'reconnect-mobile-390.png', w: 390, h: 844, fixture: 'reconnecting' },
  { file: 'resync-mobile-390.png', w: 390, h: 844, fixture: 'resync' },
  { file: 'drawer-open-mobile-390.png', w: 390, h: 844, fixture: 'drawerOpen' },
  { file: 'uploading-mobile-390.png', w: 390, h: 844, fixture: 'uploading' },
  { file: 'auth-required-mobile-390.png', w: 390, h: 844, fixture: 'authRequired' },
  { file: 'gateway-unavailable-mobile-390.png', w: 390, h: 844, fixture: 'gatewayUnavailable' },
  { file: 'empty-mobile-390.png', w: 390, h: 844, fixture: 'empty' },
  { file: 'failed-mobile-390.png', w: 390, h: 844, fixture: 'failed' },
  { file: 'ready-mobile-360.png', w: 360, h: 800, fixture: 'ready' },
  { file: 'ready-mobile-430.png', w: 430, h: 932, fixture: 'ready' },
  { file: 'tablet-ready-768.png', w: 768, h: 1024, fixture: 'ready' },
  { file: 'tablet-streaming-768.png', w: 768, h: 1024, fixture: 'streaming' },
];

const results = [];
for (const shot of SHOTS) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: shot.w, height: shot.h, deviceScaleFactor: 1, mobile: shot.w < 768,
  });
  const stamp = Date.now();
  await send('Page.navigate', { url: `http://127.0.0.1:8099/?cb=${stamp}#fixture=${shot.fixture}` });
  // Streaming autoplays; a short settle keeps the cursor in a representative place.
  await new Promise((r) => setTimeout(r, 2000));

  const capture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const bytes = Buffer.from(capture.data, 'base64');
  const target = path.join(OUT_DIR, shot.file);
  fs.writeFileSync(target, bytes);

  // Measure the page for overflow and touch targets in the same pass.
  const probe = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const small = [...document.querySelectorAll('button, a, textarea, input')]
        .map((el) => ({ id: el.id || el.className, h: Math.round(el.getBoundingClientRect().height) }))
        .filter((t) => t.h > 0 && t.h < 44);
      return {
        docScrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        under44: small,
        composerSend: !!document.querySelector('#composer-send'),
        shellH: Math.round(document.querySelector('.app-shell')?.getBoundingClientRect().height ?? 0),
        viewportH: window.innerHeight,
      };
    })()`,
  });

  results.push({ file: shot.file, w: shot.w, h: shot.h, fixture: shot.fixture, bytes: bytes.length, ...probe.result.value });
  console.log(`  ${shot.file.padEnd(36)} ${shot.w}x${shot.h} ${String(bytes.length).padStart(6)}b  overflow=${probe.result.value.overflow}  under44=${probe.result.value.under44.length}  shell=${probe.result.value.shellH}/${probe.result.value.viewportH}`);
}

fs.writeFileSync(path.join(OUT_DIR, 'capture-report.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
ws.close();
child.kill();
console.log(`\n  ${results.length} screenshots -> ${OUT_DIR}`);
