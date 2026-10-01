/**
 * WebSocket handshake tests — Phase R4 §8, §9, §10, §32, §46.
 *
 * Drives the upgrade with a **raw socket**, because the property under test is
 * specifically that a rejection happens *before* any 101. A WebSocket client
 * library hides that distinction.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { startWsServer, switchedProtocols, SESSION } from './r4-helpers.mjs';

test('a well-formed upgrade is accepted with 101', async () => {
  const h = await startWsServer();
  try {
    const res = await h.rawUpgrade({ subprotocol: 'dsh-remote-v1' });
    assert.equal(res.status, 101);
    assert.match(res.body, /sec-websocket-accept:/i);
    assert.match(res.body, /sec-websocket-protocol:\s*dsh-remote-v1/i);
  } finally {
    await h.close();
  }
});

test('an unacceptable Host is refused with 403 before the handshake', async () => {
  const h = await startWsServer();
  try {
    const res = await h.rawUpgrade({ host: 'evil.example', subprotocol: 'dsh-remote-v1' });
    assert.equal(res.status, 403, 'a bad Host must never reach 101');
    // Check the status line rather than the body: the echo includes the request
    // headers, and a loopback `Host` port can itself contain "101".
    assert.equal(switchedProtocols(res), false);
    assert.match(res.body, /FORBIDDEN_HOST/);
  } finally {
    await h.close();
  }
});

test('a loopback Host on the wrong port is refused', async () => {
  const h = await startWsServer();
  try {
    const res = await h.rawUpgrade({ host: '127.0.0.1:9', subprotocol: 'dsh-remote-v1' });
    assert.equal(res.status, 403);
  } finally {
    await h.close();
  }
});

test('an external Origin is refused with 403 before the handshake', async () => {
  const h = await startWsServer();
  try {
    for (const origin of ['https://evil.example', 'https://random-site.com', 'http://192.168.1.5:9445', 'null']) {
      const res = await h.rawUpgrade({ origin, subprotocol: 'dsh-remote-v1' });
      assert.equal(res.status, 403, `Origin ${origin} must be refused`);
      assert.equal(switchedProtocols(res), false);
    }
  } finally {
    await h.close();
  }
});

test('a loopback Origin on this port is accepted', async () => {
  const h = await startWsServer();
  try {
    for (const origin of [`http://127.0.0.1:${h.port}`, `http://localhost:${h.port}`, `http://[::1]:${h.port}`]) {
      const res = await h.rawUpgrade({ origin, subprotocol: 'dsh-remote-v1' });
      assert.equal(res.status, 101, `Origin ${origin} should be accepted`);
    }
  } finally {
    await h.close();
  }
});

test('an absent Origin is accepted, for native and diagnostic clients', async () => {
  const h = await startWsServer();
  try {
    const res = await h.rawUpgrade({ subprotocol: 'dsh-remote-v1' });
    assert.equal(res.status, 101);
  } finally {
    await h.close();
  }
});

test('a loopback Origin on the wrong port is refused', async () => {
  const h = await startWsServer();
  try {
    const res = await h.rawUpgrade({ origin: 'http://127.0.0.1:9', subprotocol: 'dsh-remote-v1' });
    assert.equal(res.status, 403);
  } finally {
    await h.close();
  }
});

test('a missing subprotocol is 426, never a silent downgrade', async () => {
  const h = await startWsServer();
  try {
    const res = await h.rawUpgrade({});
    assert.equal(res.status, 426);
    assert.equal(switchedProtocols(res), false);
    assert.match(res.body, /SUBPROTOCOL_REQUIRED/);
  } finally {
    await h.close();
  }
});

test('an unsupported subprotocol is 426 and names the supported one', async () => {
  const h = await startWsServer();
  try {
    const res = await h.rawUpgrade({ subprotocol: 'chat-v9' });
    assert.equal(res.status, 426);
    assert.match(res.body, /dsh-remote-v1/);
  } finally {
    await h.close();
  }
});

test('the supported subprotocol is accepted alongside others', async () => {
  const h = await startWsServer();
  try {
    const res = await h.rawUpgrade({ subprotocol: 'chat-v9, dsh-remote-v1' });
    assert.equal(res.status, 101);
    assert.match(res.body, /sec-websocket-protocol:\s*dsh-remote-v1/i);
  } finally {
    await h.close();
  }
});

test('a wrong path is 404', async () => {
  const h = await startWsServer();
  try {
    const res = await h.rawUpgrade({ path: `/api/v1/other?session_id=${SESSION}`, subprotocol: 'dsh-remote-v1' });
    assert.equal(res.status, 404);
  } finally {
    await h.close();
  }
});

test('a missing session_id is 400', async () => {
  const h = await startWsServer();
  try {
    const res = await h.rawUpgrade({ path: '/api/v1/events', subprotocol: 'dsh-remote-v1' });
    assert.equal(res.status, 400);
    assert.match(res.body, /SESSION_ID_REQUIRED/);
  } finally {
    await h.close();
  }
});

test('a malformed session_id is 400 before any session lookup', async () => {
  const h = await startWsServer();
  try {
    for (const bad of ['..%2Fetc', 'notasession', 'session-%00x', 'session-..%5C..']) {
      const res = await h.rawUpgrade({
        path: `/api/v1/events?session_id=${bad}`,
        subprotocol: 'dsh-remote-v1',
      });
      assert.equal(res.status, 400, `session_id ${bad} must be refused`);
      assert.match(res.body, /INVALID_SESSION_ID/);
    }
  } finally {
    await h.close();
  }
});

test('a token in the WebSocket URL is refused with a clear reason', async () => {
  const h = await startWsServer();
  try {
    for (const key of ['token', 'access_token', 'bearer']) {
      const res = await h.rawUpgrade({
        path: `/api/v1/events?session_id=${SESSION}&${key}=abc`,
        subprotocol: 'dsh-remote-v1',
      });
      assert.equal(res.status, 400, `${key} must be refused`);
      assert.match(res.body, /TOKEN_IN_URL_NOT_SUPPORTED/);
    }
  } finally {
    await h.close();
  }
});

test('an unknown query parameter is 400', async () => {
  const h = await startWsServer();
  try {
    const res = await h.rawUpgrade({
      path: `/api/v1/events?session_id=${SESSION}&colour=red`,
      subprotocol: 'dsh-remote-v1',
    });
    assert.equal(res.status, 400);
    assert.match(res.body, /INVALID_QUERY/);
  } finally {
    await h.close();
  }
});

test('a repeated query parameter is 400', async () => {
  const h = await startWsServer();
  try {
    const res = await h.rawUpgrade({
      path: `/api/v1/events?session_id=${SESSION}&session_id=${SESSION}`,
      subprotocol: 'dsh-remote-v1',
    });
    assert.equal(res.status, 400);
  } finally {
    await h.close();
  }
});

test('a non-numeric last_sequence is 400', async () => {
  const h = await startWsServer();
  try {
    const res = await h.rawUpgrade({
      path: `/api/v1/events?session_id=${SESSION}&last_sequence=abc`,
      subprotocol: 'dsh-remote-v1',
    });
    assert.equal(res.status, 400);
  } finally {
    await h.close();
  }
});

test('a plain HTTP GET on the events path is 426, not a REST route', async () => {
  // §41: the upgrade route must not be disguised as a REST GET.
  const h = await startWsServer();
  try {
    const res = await fetch(`http://127.0.0.1:${h.port}/api/v1/events?session_id=${SESSION}`);
    assert.equal(res.status, 426);
    const body = await res.json();
    assert.equal(body.error.code, 'UPGRADE_REQUIRED');
  } finally {
    await h.close();
  }
});

test('the Host fence still applies to an ordinary request to the events path', async () => {
  // Order matters: the Host check runs before the 426 branch, so a bad Host is
  // still a 403 and reveals nothing about the path.
  const h = await startWsServer();
  try {
    const res = await h.rawUpgrade({
      path: `/api/v1/events?session_id=${SESSION}`,
      host: 'evil.example',
      subprotocol: 'dsh-remote-v1',
    });
    assert.equal(res.status, 403);
  } finally {
    await h.close();
  }
});

test('a WebSocket version other than 13 is refused', async () => {
  const h = await startWsServer();
  try {
    const res = await h.rawUpgrade({ version: 8, subprotocol: 'dsh-remote-v1' });
    assert.equal(res.status, 426);
  } finally {
    await h.close();
  }
});

test('there is exactly one listener and one port', async () => {
  // §5: no second port for WebSocket.
  const h = await startWsServer();
  try {
    const rest = await fetch(`http://127.0.0.1:${h.port}/api/v1/health`);
    assert.equal(rest.status, 200, 'REST is on the same port');
    const res = await h.rawUpgrade({ subprotocol: 'dsh-remote-v1' });
    assert.equal(res.status, 101, 'WebSocket is on the same port');
    assert.equal(h.server.address().port, h.port);
  } finally {
    await h.close();
  }
});
