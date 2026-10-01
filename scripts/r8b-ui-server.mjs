/**
 * Development/test-only static server for the R8B/R8C UI shell.
 *
 * ## Why this is a separate process
 *
 * The production Gateway contract is frozen, and R8B/R8C are explicitly forbidden from
 * changing it — so no static route is added to `src/remote/server.mjs`. This server exists
 * only to look at the shell in a browser during development and testing. It is not imported by
 * any runtime module and is never started by production code.
 *
 * It binds to loopback only and serves nothing outside `src/remote/ui`.
 *
 * ## R8C: same-origin REST proxy
 *
 * From R8C the shell needs real data from the Gateway at `127.0.0.1:9445`, a different origin.
 * Rather than relax the Gateway's CORS policy, `/api/...` is proxied here so the browser stays
 * same-origin. The proxy is fixed-target, allowlisted and never logs headers or bodies — see
 * `src/remote/ui/api/dev-proxy.mjs`.
 *
 * Usage: node scripts/r8b-ui-server.mjs [--port 8099] [--no-proxy]
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleProxyRequest, handleProxyUpgrade } from '../src/remote/ui/api/dev-proxy.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_ROOT = path.join(ROOT, 'src', 'remote', 'ui');
const HOST = '127.0.0.1';

/** Extension → content type. Only the types this shell actually serves. */
const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
});

/**
 * The Gateway's backend namespace.
 *
 * Only paths under `/api/v1/` are Gateway API traffic. This is deliberately NOT `/api/`, because
 * the UI's own browser modules live under `src/remote/ui/api/` and are therefore served at
 * `/api/*.js` — `/api/real-mode.js`, `/api/api-client.js`, `/api/errors.js` and so on.
 *
 * Matching on `/api/` treated those ES modules as API calls and forwarded them to the Gateway,
 * which correctly answered `403 path_not_allowed`. Real mode then failed to load its own
 * `real-mode.js` — on a phone over ADB reverse this looked like a mobile-only bug, but it was
 * simply the wrong prefix.
 *
 * The boundary is exact: `/api/v1` and `/api/v1/...` are backend; `/api/anything-else` is a
 * static asset.
 */
const BACKEND_PREFIX = '/api/v1';

/**
 * Whether a request URL belongs to the Gateway backend namespace.
 *
 * @param {string} requestUrl - the raw request URL, query string included.
 * @returns {boolean} true when it should be proxied rather than served as a file.
 */
export function isBackendRequest(requestUrl) {
  const pathname = String(requestUrl ?? '').split('?')[0];
  return pathname === BACKEND_PREFIX || pathname.startsWith(`${BACKEND_PREFIX}/`);
}

/**
 * Resolve a request path to a file inside the UI root, refusing traversal.
 *
 * @param {string} urlPath - the decoded request path.
 * @returns {string|null} an absolute path, or null when it escapes the root.
 */
export function resolveUiPath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const relative = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const resolved = path.resolve(UI_ROOT, relative);
  // Containment check: the resolved path must stay under the UI root.
  if (resolved !== UI_ROOT && !resolved.startsWith(UI_ROOT + path.sep)) return null;
  return resolved;
}

/**
 * Build the server without starting it, so tests can drive it.
 *
 * @param {object} [options] - `proxy` (default true), `targetPort`.
 * @returns {http.Server} the server.
 */
export function createUiServer(options = {}) {
  const proxyEnabled = options.proxy !== false;
  const target = options.targetPort === undefined ? {} : { targetPort: options.targetPort };

  const server = http.createServer((req, res) => {
    // Only the `/api/v1/*` backend namespace is proxied to the fixed loopback Gateway. Everything
    // else under `/api/` is an ordinary static browser module and is served from disk.
    if (proxyEnabled && isBackendRequest(req.url)) {
      handleProxyRequest(req, res, target);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('method not allowed');
      return;
    }

    const file = resolveUiPath(req.url ?? '/');
    if (file === null) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
      return;
    }

    fs.readFile(file, (error, data) => {
      if (error) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        // The shell is static; no caching prevents stale CSS during development.
        'cache-control': 'no-store',
        // `connect-src 'self'` permits the same-origin /api/ proxy and nothing else: no
        // external origin, no arbitrary http(s), and no ws/wss.
        'content-security-policy': "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'",
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });

  // The WS upgrade is registered separately so only the exact events path is ever upgraded.
  if (proxyEnabled) {
    server.on('upgrade', (req, socket, head) => {
      handleProxyUpgrade(req, socket, head, target);
    });
  }

  return server;
}

const isDirect = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirect) {
  const portArg = process.argv.indexOf('--port');
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 8099;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error('invalid --port');
    process.exit(2);
  }
  const proxy = !process.argv.includes('--no-proxy');
  const server = createUiServer({ proxy });
  // Loopback only. This must never become a LAN server.
  server.listen(port, HOST, () => {
    console.log(`R8B/R8C UI shell (dev/test only): http://${HOST}:${port}/`);
    console.log(`fixture mode (no network): http://${HOST}:${port}/#fixture=streaming`);
    console.log(proxy
      ? `real mode: http://${HOST}:${port}/  ->  proxying /api/* to ${HOST}:9445`
      : 'real mode proxy disabled (--no-proxy)');
  });
}
