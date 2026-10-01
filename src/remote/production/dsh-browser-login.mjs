/**
 * One-time, loopback-only handoff of the already verified DSH Web cookie.
 *
 * The cookie stays in memory. A local operator asks the supervisor for a short-lived
 * ticket over the existing file control channel; the browser redeems it on the existing
 * loopback Gateway listener, receives an HttpOnly session cookie, then lands on DSH Web.
 */

import crypto from 'node:crypto';

import { isLoopbackHost } from './production-config.mjs';

export const DSH_BROWSER_HANDOFF_PATH = '/_local/dsh-browser-login';
export const DSH_BROWSER_TICKET_TTL_MS = 120_000;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function peerIsLoopback(req) {
  const address = req?.socket?.remoteAddress;
  if (typeof address !== 'string') return false;
  return isLoopbackHost(address.startsWith('::ffff:') ? address.slice(7) : address);
}

function cookiePair(authProvider) {
  if (authProvider?.ready !== true || typeof authProvider.header !== 'function') return null;
  const value = authProvider.header();
  if (typeof value !== 'string') return null;
  const at = value.indexOf('=');
  if (at < 1) return null;
  const name = value.slice(0, at);
  const cookie = value.slice(at + 1);
  if (!/^dsh-auth-[A-Za-z0-9_-]+$/.test(name) || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cookie)) return null;
  return { name, value: cookie };
}

/** A single outstanding ticket is held in memory and stored only as a digest. */
export class DshBrowserLoginService {
  constructor(options) {
    if (options?.config === undefined) throw new TypeError('DshBrowserLoginService requires config');
    if (options?.authProvider === undefined) throw new TypeError('DshBrowserLoginService requires authProvider');
    this.config = options.config;
    this.authProvider = options.authProvider;
    this.clock = options.clock ?? (() => Date.now());
    this.randomBytes = options.randomBytes ?? crypto.randomBytes;
    this.ttlMs = options.ttlMs ?? DSH_BROWSER_TICKET_TTL_MS;
    this.active = null;
  }

  nowMs() {
    const value = this.clock();
    return value instanceof Date ? value.getTime() : Number(value);
  }

  /**
   * Mint an operator handoff ticket. The caller is the authenticated file-channel
   * supervisor, never a network API route.
   */
  issue() {
    const pair = cookiePair(this.authProvider);
    if (pair === null || this.authProvider.authority !== `${this.config.dshHost}:${this.config.dshPort}`) {
      return { ok: false, code: 'DSH_AUTH_UNAVAILABLE' };
    }
    const ticket = this.randomBytes(32).toString('base64url');
    if (!TICKET_PATTERN.test(ticket)) return { ok: false, code: 'DSH_BROWSER_TICKET_INVALID' };
    const expiresAt = this.nowMs() + this.ttlMs;
    this.active = {
      digest: crypto.createHash('sha256').update(ticket).digest('base64url'),
      expiresAt,
      cookie: `${pair.name}=${pair.value}`,
    };
    const url = new URL(DSH_BROWSER_HANDOFF_PATH, `http://${this.config.gatewayHost}:${this.config.gatewayPort}`);
    url.searchParams.set('ticket', ticket);
    return { ok: true, url: url.href, expiresAt, expiresInSeconds: Math.floor(this.ttlMs / 1000) };
  }

  /**
   * Handle only the fixed local handoff route. Invalid requests get the same 404 and
   * consume no DSH credential. The caller already applied the Gateway Host fence.
   */
  handleRequest(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${this.config.gatewayHost}:${this.config.gatewayPort}`);
    } catch {
      return false;
    }
    if (url.pathname !== DSH_BROWSER_HANDOFF_PATH) return false;

    const gatewayAuthority = `${this.config.gatewayHost}:${this.config.gatewayPort}`;
    const dshAuthority = `${this.config.dshHost}:${this.config.dshPort}`;
    const tickets = url.searchParams.getAll('ticket');
    const ticket = tickets.length === 1 ? tickets[0] : '';
    const digest = TICKET_PATTERN.test(ticket)
      ? crypto.createHash('sha256').update(ticket).digest('base64url')
      : '';
    const origin = req.headers.origin;
    const originAllowed = origin === undefined || origin === `http://${gatewayAuthority}`;
    const candidate = this.active;
    const valid = req.method === 'GET'
      && req.headers.host === gatewayAuthority
      && peerIsLoopback(req)
      && originAllowed
      && url.searchParams.size === 1
      && candidate !== null
      && candidate.expiresAt > this.nowMs()
      && digest !== ''
      && crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(candidate.digest));

    const commonHeaders = {
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    };
    if (!valid) {
      res.writeHead(404, { ...commonHeaders, 'content-type': 'text/plain; charset=utf-8' });
      res.end();
      return true;
    }

    // Consume before writing so concurrent/replayed requests cannot both succeed.
    this.active = null;
    const dshUrl = `http://${dshAuthority}/`;
    res.writeHead(303, {
      ...commonHeaders,
      location: dshUrl,
      // Host-only cookie: it is accepted by 127.0.0.1:3081 and cannot be sent to
      // relay.drm-jd.com. The browser keeps it session-only; DSH enforces its own expiry.
      'set-cookie': `${candidate.cookie}; Path=/; HttpOnly; SameSite=Strict`,
    });
    res.end();
    return true;
  }

  clear() {
    this.active = null;
  }
}
