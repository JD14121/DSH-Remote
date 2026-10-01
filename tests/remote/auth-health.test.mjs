/**
 * Health auth-axis tests — Phase R6 §11, §46, §47, §78.
 *
 * §11 splits health into two shapes: an unauthenticated caller learns the process is
 * alive, and an authenticated one learns the operational detail. §47 is the sharper
 * rule — the auth block must not disclose the credential's source, length, prefix,
 * fingerprint or generation time.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { AUTH_SCHEME, generateSyntheticToken, request, startAuthServer } from './r6-helpers.mjs';

test('§11: unauthenticated health reveals only liveness and that auth is required', async () => {
  const h = await startAuthServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/health');
    assert.equal(res.status, 200, 'health must stay reachable without a credential');

    const data = res.body.data;
    assert.deepEqual(Object.keys(data).sort(), ['auth', 'gateway', 'request_id']);
    assert.equal(data.gateway, 'ready');
    assert.equal(data.auth.required, true);
  } finally {
    await h.close();
  }
});

test('§11: unauthenticated health withholds DSH and persistence detail', async () => {
  const h = await startAuthServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/health');
    const data = res.body.data;
    assert.equal(data.dsh, undefined, 'the DSH version and status are operational detail');
    assert.equal(data.persistence, undefined, 'the persistence format and failure code too');
    assert.equal(data.ready, undefined);
    assert.equal(data.status, undefined);
  } finally {
    await h.close();
  }
});

test('§11: authenticated health returns the full operational picture', async () => {
  const h = await startAuthServer();
  try {
    const res = await h.get('/api/v1/health');
    assert.equal(res.status, 200);
    const data = res.body.data;
    for (const field of ['gateway', 'ready', 'dsh', 'auth', 'request_id']) {
      assert.ok(field in data, `authenticated health must include ${field}`);
    }
    assert.equal(data.status, 'ok');
    assert.equal(data.auth.mode, AUTH_SCHEME);
  } finally {
    await h.close();
  }
});

test('§46: the auth axis reports the mode and TTL, never a credential fact', async () => {
  const h = await startAuthServer({ config: { ticketTtlSeconds: 45 } });
  try {
    const res = await h.get('/api/v1/health');
    const auth = res.body.data.auth;
    assert.equal(auth.status, 'ready');
    assert.equal(auth.mode, 'bearer+ws-ticket');
    assert.equal(auth.ticket_ttl_seconds, 45);
    // §47: nothing about the credential itself.
    for (const forbidden of ['token', 'hash', 'digest', 'prefix', 'length', 'fingerprint', 'source', 'path', 'created', 'generated']) {
      assert.equal(
        JSON.stringify(auth).toLowerCase().includes(forbidden),
        false,
        `the auth block must not mention ${forbidden}`,
      );
    }
  } finally {
    await h.close();
  }
});

test('§47: health never leaks the credential, its digest or the state root', async () => {
  const h = await startAuthServer();
  try {
    const res = await h.get('/api/v1/health');
    const text = `${res.text}\n${JSON.stringify(res.headers)}`;
    assert.equal(text.includes(h.token), false, 'the credential must never appear');
    assert.equal(text.includes(h.token.slice(0, 8)), false, 'nor a prefix of it');
    assert.equal(text.includes('DSH_REMOTE'), false, 'nor the environment variable name');
    assert.equal(text.includes('.credentials'), false);
    assert.equal(text.includes('.dsh'), false, 'nor any state path');
  } finally {
    await h.close();
  }
});

test('§78: a wrong credential on health yields the minimal view, not an error', async () => {
  const h = await startAuthServer();
  try {
    // Health is public, so a bad token is not an error — it simply earns no detail.
    // That also means health cannot be used to test whether a token is valid.
    const res = await request(h.baseUrl, '/api/v1/health', {
      headers: { authorization: `Bearer ${generateSyntheticToken()}` },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body.data).sort(), ['auth', 'gateway', 'request_id']);
  } finally {
    await h.close();
  }
});

test('§78: health is byte-identical for a bad credential and no credential', async () => {
  const h = await startAuthServer();
  try {
    const none = await request(h.baseUrl, '/api/v1/health');
    const bad = await request(h.baseUrl, '/api/v1/health', {
      headers: { authorization: `Bearer ${generateSyntheticToken()}` },
    });
    // `request_id` appears both at the envelope level and inside `data`, so both are
    // normalised before comparing.
    const normalise = (body) => JSON.parse(
      JSON.stringify(body).split(body.request_id).join('ID').split(body.data.request_id).join('ID'),
    );
    assert.deepEqual(
      normalise(none.body),
      normalise(bad.body),
      'a bad token must not change the public response at all',
    );
  } finally {
    await h.close();
  }
});

test('§14: persistence status is part of the authenticated view only', async () => {
  const { makeTempStateRoot } = await import('./r6-helpers.mjs');
  const { root, cleanup } = makeTempStateRoot('r6-health-persist');
  const h = await startAuthServer({ persistenceConfig: { root, segmentBytes: 65_536 } });
  try {
    const anon = await request(h.baseUrl, '/api/v1/health');
    assert.equal(anon.body.data.persistence, undefined);

    const auth = await h.get('/api/v1/health');
    assert.equal(auth.body.data.persistence.status, 'ready');
    assert.equal(auth.body.data.persistence.format_version, 1);
    // And still no path.
    assert.equal(auth.text.includes(root), false);
  } finally {
    await h.close();
    cleanup();
  }
});

test('§11: a fixture without auth reports no auth axis rather than pretending', async () => {
  const { makeTempStateRoot, startFixtureServer } = await import('./r6-helpers.mjs');
  const { root, cleanup } = makeTempStateRoot('r6-health-fixture');
  const h = await startFixtureServer({ persistenceConfig: { root } });
  try {
    const res = await request(h.baseUrl, '/api/v1/health');
    // No auth service means no auth axis; the response is the R5 shape.
    assert.equal(res.body.data.auth, undefined);
    assert.equal(res.body.data.dsh.status, 'ready');
  } finally {
    await h.close();
    cleanup();
  }
});
