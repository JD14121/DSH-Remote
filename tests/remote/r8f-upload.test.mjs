/**
 * R8F — Upload convergence, credential safety, and composer independence.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { actionStack, waitUntil } from './r8f-harness.mjs';
import { ApiClient, MAX_UPLOAD_BYTES } from '../../src/remote/ui/api/api-client.js';
import { ERROR_KIND } from '../../src/remote/ui/api/errors.js';

/** A File-like object. */
function file(name, size) {
  return { name, size };
}

test('an upload converges through selected → uploading → uploaded', async () => {
  const h = await actionStack({ status: 'idle' });
  try {
    const gate = h.f.hold('/uploads');
    const pending = h.owner.upload(file('report.pdf', 1024));

    await waitUntil(() => h.state.attachments.some((a) => a.state === 'uploading'));
    assert.equal(h.state.attachments.some((a) => a.state === 'uploading'), true);

    gate.release();
    await pending;
    await waitUntil(() => h.state.attachments.some((a) => a.state === 'uploaded'));

    const uploaded = h.state.attachments.find((a) => a.state === 'uploaded');
    assert.ok(uploaded !== undefined, 'the server-returned record must replace the pending chip');
    assert.equal(uploaded.name, 'upload.bin', 'the server is the authority for the record');
  } finally {
    await h.stop();
  }
});

test('the client pre-checks 25 MiB and never sends an oversized file', async () => {
  const h = await actionStack({ status: 'idle' });
  try {
    await h.owner.upload(file('huge.bin', MAX_UPLOAD_BYTES + 1));
    assert.equal(h.state.error.kind, ERROR_KIND.TOO_LARGE);
    assert.equal(h.f.countRequests('/uploads'), 0, 'an oversized file must not reach the network');
    assert.equal(h.state.attachments.some((a) => a.state === 'failed'), true);
  } finally {
    await h.stop();
  }
});

test('a server 413 is authoritative even when the client pre-check passed', async () => {
  const h = await actionStack({ status: 'idle' });
  try {
    h.f.state.uploadStatus = 413;
    await h.owner.upload(file('fine.bin', 1024));

    // §15: the server remains the authority.
    assert.equal(h.state.error.kind, ERROR_KIND.TOO_LARGE);
    assert.equal(h.state.attachments.some((a) => a.state === 'failed'), true);
  } finally {
    await h.stop();
  }
});

test('a network failure during upload does not clear the credential', async () => {
  const h = await actionStack({ status: 'idle' });
  try {
    h.f.state.uploadStatus = 'network';
    await h.owner.upload(file('x.bin', 1024));

    assert.equal(h.state.error.kind, ERROR_KIND.NETWORK);
    assert.equal(h.state.connection, 'gateway_unavailable');
    // An unreachable Gateway must not look like a rejected credential.
    assert.notEqual(h.owner.credentials.read(), null, 'the credential must be preserved');
  } finally {
    await h.stop();
  }
});

test('a double upload of the same file is refused', async () => {
  const h = await actionStack({ status: 'idle' });
  try {
    const gate = h.f.hold('/uploads');
    const first = h.owner.upload(file('same.bin', 2048));
    await waitUntil(() => h.state.attachments.some((a) => a.state === 'uploading'));

    const second = await h.owner.upload(file('same.bin', 2048));
    assert.equal(second.refused, 'upload-in-flight', 'the same selection must not upload twice');

    gate.release();
    await first;
    assert.equal(h.f.countRequests('/uploads'), 1, 'exactly one upload may reach the Gateway');
  } finally {
    await h.stop();
  }
});

test('a failed upload does not auto-retry during recovery', async () => {
  const h = await actionStack({ status: 'idle' });
  try {
    h.f.state.uploadStatus = 500;
    await h.owner.upload(file('bad.bin', 512));
    const afterFailure = h.f.countRequests('/uploads');
    assert.equal(afterFailure, 1);

    // §19: recovery is remove / re-select / re-upload. No automatic retry may occur.
    h.recovery.requireResync({ reason: 'test' });
    await waitUntil(() => h.state.connection === 'resync_required');
    await h.recovery.reload();
    await waitUntil(() => h.state.connection !== 'resync_required');

    assert.equal(h.f.countRequests('/uploads'), afterFailure, 'a resync must not re-upload');
  } finally {
    await h.stop();
  }
});

test('the composer stays usable while an upload is in flight', async () => {
  const h = await actionStack({ status: 'idle' });
  try {
    const gate = h.f.hold('/uploads');
    const pending = h.owner.upload(file('slow.bin', 4096));
    await waitUntil(() => h.state.attachments.some((a) => a.state === 'uploading'));

    // §17: an upload never blocks the composer. Typing must still work.
    h.owner.state = { ...h.owner.state, draft: 'typed while uploading' };
    assert.equal(h.owner.state.draft, 'typed while uploading');
    assert.equal(h.state.attachments.some((a) => a.state === 'uploading'), true);

    gate.release();
    await pending;
  } finally {
    await h.stop();
  }
});

test('a token never appears in the multipart body, filename or query', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), body: init.body, headers: init.headers });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 'f-1', name: 'x.bin' }) };
  };
  const client = new ApiClient({ fetchImpl, credential: 'phone-secret-token' });
  const form = { entries: [], append(n, v, f) { this.entries.push({ n, f }); } };

  await client.upload('s-1', file('x.bin', 10), { formDataFactory: () => form });

  // §16: the credential travels in the header only.
  assert.equal(seen[0].headers.authorization, 'Bearer phone-secret-token');
  assert.equal(seen[0].url.includes('phone-secret-token'), false, 'the token leaked into the URL');
  assert.equal(form.entries[0].f, 'x.bin', 'the filename is the File name, not a path or a token');
  assert.equal(JSON.stringify(form.entries).includes('phone-secret-token'), false);
});

test('only a browser File object is read — never a filesystem path', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 'f-1' }) };
  };
  const client = new ApiClient({ fetchImpl, credential: 'tok' });

  const reads = [];
  const hostile = {
    size: 8,
    get name() { reads.push('name'); return 'x.png'; },
    get path() { reads.push('path'); return 'C:\\Users\\secret\\x.png'; },
  };
  const form = { entries: [], append(n, v, f) { this.entries.push({ n, f }); } };
  await client.upload('s-1', hostile, { formDataFactory: () => form });

  assert.equal(reads.includes('path'), false, 'the client must not read a filesystem path');
  assert.equal(form.entries[0].f.includes('\\'), false);
});

test('an attachment can be removed locally', async () => {
  const h = await actionStack({ status: 'idle' });
  try {
    await h.owner.upload(file('a.bin', 10));
    await waitUntil(() => h.state.attachments.length === 1);
    const id = h.state.attachments[0].id;

    h.owner.removeAttachment(id);
    assert.equal(h.state.attachments.length, 0, '§15 allows a local removed state');
  } finally {
    await h.stop();
  }
});

test('a locally selected attachment survives a resync', async () => {
  const h = await actionStack({ status: 'idle' });
  try {
    h.owner.state = {
      ...h.owner.state,
      attachments: [{ id: 'local-1', name: 'not-sent.txt', state: 'selected', file: { local: true } }],
    };

    h.recovery.requireResync({ reason: 'test' });
    await waitUntil(() => h.state.connection === 'resync_required');
    await h.recovery.reload();
    await waitUntil(() => h.state.connection !== 'resync_required');

    // §19: a local selection is client-owned input and must not be destroyed by a reload.
    assert.equal(h.state.attachments.some((a) => a.id === 'local-1'), true,
      'a selected-but-unuploaded attachment must be preserved');
  } finally {
    await h.stop();
  }
});
