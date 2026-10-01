/**
 * Upload tests — Phase R3 §24, §25, §26, §42.
 *
 * The wire audit (`docs/r3-upload-evidence.md`) resolved DSH's upload route, so
 * these tests exercise the implemented path rather than a 501 stub. They also
 * assert the *absence* of the 501, so a future regression that quietly disables
 * uploads fails here.
 *
 * §42 lists the required coverage: filename normalisation, traversal rejection,
 * max bytes, MIME validation, missing file, abort cleanup, synthetic receipt, no
 * raw filesystem path returned, and receipt mapping into a message attachment.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { multipartBody, request, startFixtureServer, FIXTURE_SESSIONS } from './r3-helpers.mjs';
import { normaliseFilename, parseMultipart, isMultipart, dispositionParam } from '../../src/remote/http/multipart.mjs';
import { normaliseUploadFilename, normaliseMediaType } from '../../src/remote/http/validation.mjs';
import { API_ERROR, HTTP_STATUS, apiError } from '../../src/remote/http/errors.mjs';
import { UploadService } from '../../src/remote/uploads.mjs';

const SESSION = FIXTURE_SESSIONS.RUNNING;

test('a multipart upload returns a synthetic receipt and file facts', async () => {
  const h = await startFixtureServer();
  try {
    const { body, contentType } = multipartBody({
      filename: 'holiday.png',
      data: 'synthetic-png-bytes',
      contentType: 'image/png',
    });

    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/uploads`, {
      method: 'POST',
      rawBody: body,
      contentType,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.api_version, 1);
    assert.equal(typeof res.body.data.attachment_id, 'string');
    assert.equal(res.body.data.name, 'holiday.png');
    assert.equal(res.body.data.size, Buffer.byteLength('synthetic-png-bytes'));
    assert.equal(res.body.data.media_type, 'image/png');
  } finally {
    await h.close();
  }
});

test('a raw octet-stream upload mirrors the DSH route shape', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/uploads?name=notes.txt`, {
      method: 'POST',
      rawBody: 'plain text body',
      contentType: 'application/octet-stream',
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.name, 'notes.txt');
    assert.equal(res.body.data.media_type, 'application/octet-stream');
    assert.equal(res.body.data.size, Buffer.byteLength('plain text body'));
  } finally {
    await h.close();
  }
});

test('the receipt is exactly what the adapter minted, and it is session-scoped', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/uploads`, {
      method: 'POST',
      rawBody: 'bytes',
      contentType: 'application/octet-stream',
    });

    // The Gateway invents no second identity: DSH's receipt IS the attachment id.
    assert.equal(res.body.data.attachment_id, 'receipt-fixture-0001');
    assert.equal(h.adapter._state.uploads.length, 1);
    assert.equal(h.adapter._state.uploads[0].sessionId, SESSION, 'the upload is addressed to the session');
  } finally {
    await h.close();
  }
});

test('filename traversal and separators are rejected, never silently stripped', async () => {
  const h = await startFixtureServer();
  try {
    for (const filename of ['../evil.txt', '..\\evil.txt', 'a/b.txt', 'a\\b.txt', '/etc/passwd', 'C:\\Windows\\x']) {
      const { body, contentType } = multipartBody({ filename, data: 'x' });
      const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/uploads`, {
        method: 'POST',
        rawBody: body,
        contentType,
      });
      assert.equal(res.status, 400, `filename ${filename} must be refused`);
      assert.equal(res.body.error.code, API_ERROR.UPLOAD_INVALID_FILENAME, `filename ${filename}`);
    }
    assert.equal(h.adapter._state.uploads.length, 0, 'nothing reached DSH');
  } finally {
    await h.close();
  }
});

test('a traversal filename in the raw query is also rejected', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/uploads?name=${encodeURIComponent('../x.txt')}`, {
      method: 'POST',
      rawBody: 'x',
      contentType: 'application/octet-stream',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, API_ERROR.UPLOAD_INVALID_FILENAME);
  } finally {
    await h.close();
  }
});

test('filename normalisation is a bare basename and bounded', () => {
  assert.equal(normaliseUploadFilename('photo.png'), 'photo.png');
  assert.equal(normaliseUploadFilename('  spaced.txt  '), 'spaced.txt');
  assert.equal(normaliseUploadFilename(''), 'upload');
  assert.equal(normaliseUploadFilename(undefined), 'upload');
  assert.equal(normaliseFilename('a/b/c.txt'), 'c.txt');
  assert.equal(normaliseFilename('..\\..\\c.txt'), 'c.txt');
  assert.equal(normaliseFilename('...hidden'), 'hidden');
  assert.equal(normaliseFilename('with\u0000nul'), 'withnul');
  assert.equal(normaliseFilename('x'.repeat(500)).length, 255);

  assert.throws(() => normaliseUploadFilename('../x'), /bare name/);
  assert.throws(() => normaliseUploadFilename('a/b'), /bare name/);
  assert.throws(() => normaliseUploadFilename('bad\u0000name'), /control/);
  assert.throws(() => normaliseUploadFilename('x'.repeat(300)), /too long/);
});

test('an over-large upload is refused with 413', async () => {
  const h = await startFixtureServer({ configOverrides: { maxUploadBytes: 64 } });
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/uploads`, {
      method: 'POST',
      rawBody: Buffer.alloc(200, 0x41),
      contentType: 'application/octet-stream',
    });
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, API_ERROR.PAYLOAD_TOO_LARGE);
    assert.equal(h.adapter._state.uploads.length, 0);
  } finally {
    await h.close();
  }
});

test('an upload at exactly the limit is accepted', async () => {
  const h = await startFixtureServer({ configOverrides: { maxUploadBytes: 64 } });
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/uploads`, {
      method: 'POST',
      rawBody: Buffer.alloc(64, 0x41),
      contentType: 'application/octet-stream',
    });
    assert.equal(res.status, 200, 'the ceiling is inclusive');
  } finally {
    await h.close();
  }
});

test('an empty upload is a 400 rather than an empty attachment', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/uploads`, {
      method: 'POST',
      rawBody: '',
      contentType: 'application/octet-stream',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, API_ERROR.UPLOAD_MISSING_FILE);
  } finally {
    await h.close();
  }
});

test('a multipart body with no file part is a 400', async () => {
  const h = await startFixtureServer();
  try {
    const boundary = '----noFilePart';
    const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n--${boundary}--\r\n`);
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/uploads`, {
      method: 'POST',
      rawBody: body,
      contentType: `multipart/form-data; boundary=${boundary}`,
    });
    assert.equal(res.status, 400);
    assert.ok([API_ERROR.UPLOAD_MISSING_FILE, API_ERROR.INVALID_REQUEST].includes(res.body.error.code));
  } finally {
    await h.close();
  }
});

test('an unsupported upload media type is a 415', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/uploads`, {
      method: 'POST',
      rawBody: 'x',
      contentType: 'application/x-www-form-urlencoded',
    });
    assert.equal(res.status, 415);
    assert.equal(res.body.error.code, API_ERROR.UNSUPPORTED_MEDIA_TYPE);
  } finally {
    await h.close();
  }
});

test('a multipart boundary is required and must be well formed', async () => {
  const h = await startFixtureServer();
  try {
    const missing = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/uploads`, {
      method: 'POST',
      rawBody: 'x',
      contentType: 'multipart/form-data',
    });
    assert.equal(missing.status, 400);

    const malformed = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/uploads`, {
      method: 'POST',
      rawBody: 'x',
      contentType: 'multipart/form-data; boundary="has quotes"',
    });
    assert.equal(malformed.status, 400);
  } finally {
    await h.close();
  }
});

test('MIME format validation rejects a nonsense type', () => {
  assert.equal(normaliseMediaType('IMAGE/PNG'), 'image/png');
  assert.equal(normaliseMediaType(undefined), 'application/octet-stream');
  assert.equal(normaliseMediaType('application/vnd.dsh+json'), 'application/vnd.dsh+json');
  assert.throws(() => normaliseMediaType('not a mime'), /valid MIME/);
  assert.throws(() => normaliseMediaType('image/'), /valid MIME/);
  assert.throws(() => normaliseMediaType('/png'), /valid MIME/);
  assert.throws(() => normaliseMediaType('image/png;charset=utf-8'), /valid MIME/);
});

test('uploading to an unknown session is a 404 before any bytes are sent', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, '/api/v1/sessions/session-00000000-0000-0000-0000-0000000000ff/uploads', {
      method: 'POST',
      rawBody: 'x',
      contentType: 'application/octet-stream',
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'SESSION_NOT_FOUND');
    assert.equal(h.adapter._state.uploads.length, 0);
  } finally {
    await h.close();
  }
});

test('no response exposes a filesystem path or a store location', async () => {
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/uploads`, {
      method: 'POST',
      rawBody: 'bytes',
      contentType: 'application/octet-stream',
    });
    for (const forbidden of ['attachments', 'DSH_HOME', 'dsh-work-test', 'C:\\', 'D:\\', '/home/', 'staging', 'objectPath']) {
      assert.equal(res.text.includes(forbidden), false, `upload response must not contain ${forbidden}`);
    }
  } finally {
    await h.close();
  }
});

test('the upload result maps into a message attachment part', async () => {
  const h = await startFixtureServer();
  try {
    const upload = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/uploads`, {
      method: 'POST',
      rawBody: 'bytes',
      contentType: 'application/octet-stream',
    });
    const attachmentId = upload.body.data.attachment_id;

    const prompt = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/messages`, {
      method: 'POST',
      body: {
        content: [{ type: 'text', text: 'here is the file' }, { type: 'attachment', attachment_id: attachmentId }],
        client_message_id: 'client-upload-1',
      },
    });

    assert.equal(prompt.status, 202);
    const sent = h.adapter._state.sentMessages.at(-1);
    assert.deepEqual(sent.content[1], { type: 'file', receiptId: attachmentId });
  } finally {
    await h.close();
  }
});

test('a DSH upload refusal is surfaced, not swallowed', async () => {
  const h = await startFixtureServer({
    adapterOptions: {
      errors: {
        uploadFile: Object.assign(apiError(409, API_ERROR.PROMPT_REJECTED, 'image is too large'), {
          code: 'PROMPT_REJECTED',
        }),
      },
    },
  });
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/uploads`, {
      method: 'POST',
      rawBody: 'bytes',
      contentType: 'application/octet-stream',
    });
    assert.ok(res.status >= 400, 'a refused upload must never return 200');
    assert.equal(res.body.error.request_id !== undefined, true);
  } finally {
    await h.close();
  }
});

test('an adapter without upload support fails visible with 501, never silently', async () => {
  // §42: if the wire were unresolved the endpoint must answer 501 rather than
  // accept and drop. This proves that guard still exists and is reachable.
  const adapterWithoutUpload = { listSessions: async () => [] };
  const service = new UploadService({ adapter: adapterWithoutUpload });
  assert.equal(service.available, false);

  await assert.rejects(
    () => service.receive({ headers: {} }, SESSION, { maxUploadBytes: 1024 }, new URLSearchParams()),
    (error) => {
      assert.equal(error.status, HTTP_STATUS.NOT_IMPLEMENTED);
      assert.equal(error.code, API_ERROR.UPLOAD_NOT_AVAILABLE);
      return true;
    },
  );
});

test('the upload endpoint is NOT a 501 in this build, because the wire was resolved', async () => {
  // The inverse of the test above: the audit succeeded, so uploads really work.
  const h = await startFixtureServer();
  try {
    const res = await request(h.baseUrl, `/api/v1/sessions/${SESSION}/uploads`, {
      method: 'POST',
      rawBody: 'bytes',
      contentType: 'application/octet-stream',
    });
    assert.notEqual(res.status, 501, 'R3_UPLOAD_WIRE_UNRESOLVED does not apply');
    assert.equal(res.status, 200);
  } finally {
    await h.close();
  }
});

test('the multipart parser handles a binary body with CRLF-like bytes inside', () => {
  // A naive line-based parser would corrupt binary payloads that contain CRLF.
  const payload = Buffer.from([0x0d, 0x0a, 0x2d, 0x2d, 0x41, 0x0d, 0x0a, 0x42]);
  const { body, contentType } = multipartBody({ filename: 'bin.dat', data: payload });
  const boundary = /boundary=([^;]+)/.exec(contentType)[1];

  const part = parseMultipart(body, boundary);
  assert.deepEqual(part.data, payload, 'the payload must survive byte for byte');
  assert.equal(part.filename, 'bin.dat');
});

test('content-disposition parsing handles quoted and unquoted parameters', () => {
  assert.equal(dispositionParam('form-data; name="file"; filename="a.txt"', 'filename'), 'a.txt');
  assert.equal(dispositionParam('form-data; name=file; filename=a.txt', 'filename'), 'a.txt');
  assert.equal(dispositionParam('form-data; name="file"', 'filename'), null);
  assert.equal(dispositionParam(undefined, 'filename'), null);
  assert.equal(dispositionParam('form-data; filename="a;b.txt"', 'filename'), 'a;b.txt');
});

test('isMultipart recognises the content type with and without parameters', () => {
  assert.equal(isMultipart('multipart/form-data; boundary=x'), true);
  assert.equal(isMultipart('MULTIPART/FORM-DATA; boundary=x'), true);
  assert.equal(isMultipart('application/octet-stream'), false);
  assert.equal(isMultipart(undefined), false);
});

test('the upload service holds no filesystem code', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../src/remote/uploads.mjs', import.meta.url), 'utf8');
  // Strip comments first: the module documents *why* it must not touch the
  // attachment store, and that prose legitimately names it.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['node:fs', 'fs.', 'writeFile', 'createWriteStream', 'appendFile', 'mkdir', 'unlink', 'attachments']) {
    assert.equal(code.includes(banned), false, `uploads.mjs must not reference ${banned} in code`);
  }
});
