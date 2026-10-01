/**
 * R8C — uploads: the 25 MiB pre-check, 413 handling and multipart credential safety.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiClient, MAX_UPLOAD_BYTES } from '../../src/remote/ui/api/api-client.js';
import { RealModeController } from '../../src/remote/ui/api/real-mode.js';
import { CredentialStore, createMemoryStorage } from '../../src/remote/ui/api/credential-store.js';
import { ERROR_KIND } from '../../src/remote/ui/api/errors.js';
import { normalizeUpload } from '../../src/remote/ui/api/normalizers.js';

/** A fake FormData recording what was appended. */
function makeFormData() {
  const entries = [];
  return {
    entries,
    append(name, value, filename) { entries.push({ name, value, filename }); },
  };
}

/** A client plus the calls it made. */
function makeClient(uploadStep) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const step = typeof uploadStep === 'function' ? await uploadStep(url, init) : uploadStep;
    if (step.throw !== undefined) throw step.throw;
    return { ok: step.status < 300, status: step.status, headers: { get: () => null }, json: async () => step.body };
  };
  return { client: new ApiClient({ fetchImpl: impl, credential: 'secret-token' }), calls };
}

test('the client pre-checks 25 MiB before sending anything', async () => {
  const { client, calls } = makeClient({ status: 200, body: {} });
  const tooBig = { name: 'huge.bin', size: MAX_UPLOAD_BYTES + 1 };

  await assert.rejects(
    () => client.upload('s-1', tooBig, { formDataFactory: makeFormData }),
    (error) => {
      assert.equal(error.kind, ERROR_KIND.TOO_LARGE);
      assert.equal(error.status, 413);
      return true;
    },
  );
  assert.equal(calls.length, 0, 'an oversized file must never reach the network');
});

test('exactly 25 MiB is accepted by the pre-check', async () => {
  const { client, calls } = makeClient({ status: 200, body: { id: 'f-1', name: 'at-limit.bin' } });
  const atLimit = { name: 'at-limit.bin', size: MAX_UPLOAD_BYTES };
  await client.upload('s-1', atLimit, { formDataFactory: makeFormData });
  assert.equal(calls.length, 1);
});

test('a server 413 is surfaced as too-large even when the client pre-check passed', async () => {
  // The server remains the authority; a client pass is not a guarantee.
  const { client } = makeClient({ status: 413, body: {} });
  await assert.rejects(
    () => client.upload('s-1', { name: 'x.bin', size: 1024 }, { formDataFactory: makeFormData }),
    (error) => {
      assert.equal(error.kind, ERROR_KIND.TOO_LARGE);
      assert.equal(error.clearsCredential(), false);
      return true;
    },
  );
});

test('a network failure during upload preserves the credential', async () => {
  const { client } = makeClient({ throw: new TypeError('Failed to fetch') });
  await assert.rejects(
    () => client.upload('s-1', { name: 'x.bin', size: 10 }, { formDataFactory: makeFormData }),
    (error) => {
      assert.equal(error.kind, ERROR_KIND.NETWORK);
      assert.equal(error.clearsCredential(), false);
      return true;
    },
  );
});

test('the token is never placed in the multipart body or the filename', async () => {
  const { client, calls } = makeClient({ status: 200, body: { id: 'f-1', name: 'diagram.png' } });
  const form = makeFormData();
  await client.upload('s-1', { name: 'diagram.png', size: 2048 }, { formDataFactory: () => form });

  // The credential travels in the header only.
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret-token');
  // And appears nowhere in the form.
  const serialized = JSON.stringify(form.entries);
  assert.equal(serialized.includes('secret-token'), false, 'the token leaked into the form body');
  assert.equal(form.entries.length, 1);
  assert.equal(form.entries[0].name, 'file');
  assert.equal(form.entries[0].filename, 'diagram.png');
  // Not in the URL either.
  assert.equal(calls[0].url.includes('secret-token'), false);
});

test('the request body is the FormData itself, so the browser sets the boundary', async () => {
  const { client, calls } = makeClient({ status: 200, body: {} });
  const form = makeFormData();
  await client.upload('s-1', { name: 'x.png', size: 1 }, { formDataFactory: () => form });
  assert.equal(calls[0].init.body, form);
  // The client must not write its own multipart content-type.
  assert.equal('content-type' in calls[0].init.headers, false);
});

test('the client reads only name and size from the File, never a path', async () => {
  const { client, calls } = makeClient({ status: 200, body: {} });

  // A File-like object carrying a non-standard path property. The browser File object has no
  // such property, so this proves the client does not go looking for one: only `name` and
  // `size` may be read, and only `name` may reach the wire as the filename.
  const reads = [];
  const file = {
    size: 8,
    get name() { reads.push('name'); return 'x.png'; },
    get path() { reads.push('path'); return 'C:\\Users\\secret\\x.png'; },
  };

  const form = makeFormData();
  await client.upload('s-1', file, { formDataFactory: () => form });

  assert.equal(reads.includes('path'), false, 'the client read a filesystem path off the File');
  assert.deepEqual([...new Set(reads)].sort(), ['name', 'size'].filter((k) => reads.includes(k)));

  // The filename sent is the File's own name, not a path.
  assert.equal(form.entries[0].filename, 'x.png');
  assert.equal(String(form.entries[0].filename).includes('\\'), false);
  assert.equal(calls[0].url.includes('C%3A'), false, 'a path reached the URL');
});

test('the controller tracks uploading then uploaded', async () => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (String(url).includes('/messages')) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ items: [] }) };
    if (String(url).endsWith('/uploads')) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 'f-9', name: 'diagram.png' }) };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 's-1', status: 'idle' }) };
  };

  const controller = new RealModeController({
    client: new ApiClient({ fetchImpl: impl, credential: 'tok' }),
    credentials: new CredentialStore({ storage: createMemoryStorage() }),
    formDataFactory: makeFormData,
  });
  await controller.selectSession('s-1');
  await controller.upload({ name: 'diagram.png', size: 100 });

  assert.equal(controller.state.attachments.length, 1);
  assert.equal(controller.state.attachments[0].state, 'uploaded');
  assert.equal(controller.state.attachments[0].id, 'f-9');
});

test('the controller marks a failed upload so it can be removed or re-selected', async () => {
  const impl = async (url) => {
    if (String(url).includes('/messages')) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ items: [] }) };
    if (String(url).endsWith('/uploads')) return { ok: false, status: 413, headers: { get: () => null }, json: async () => ({}) };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 's-1', status: 'idle' }) };
  };
  const controller = new RealModeController({
    client: new ApiClient({ fetchImpl: impl, credential: 'tok' }),
    credentials: new CredentialStore({ storage: createMemoryStorage() }),
    formDataFactory: makeFormData,
  });
  await controller.selectSession('s-1');
  await controller.upload({ name: 'big.bin', size: 100 });

  assert.equal(controller.state.attachments[0].state, 'failed');
  assert.equal(controller.state.error.kind, ERROR_KIND.TOO_LARGE);
});

test('upload normalization falls back safely when the server omits fields', () => {
  const result = normalizeUpload({}, { name: 'fallback.png', kind: 'image', bytes: 12 });
  assert.equal(result.name, 'fallback.png');
  assert.equal(result.kind, 'image');
  assert.equal(result.state, 'uploaded');
  assert.equal(result.bytes, 12);
});

test('the limit constant matches the contract value', () => {
  assert.equal(MAX_UPLOAD_BYTES, 25 * 1024 * 1024);
});
