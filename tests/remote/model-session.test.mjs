/**
 * Session model tests — R2 §4, §5, §24, §25.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REQUIRED_SESSION_FIELDS,
  makeSession,
  sessionFromAdapterSummary,
  toMobileSession,
  validateSession,
} from '../../src/remote/model/session.mjs';
import { ALL_STATUSES } from '../../src/remote/model/status.mjs';

const SESSION_ID = 'session-00000000-0000-0000-0000-000000000001';

test('a session carries exactly the fields the mobile layer may depend on', () => {
  const session = makeSession({ id: SESSION_ID, createdAt: 1789600000000, updatedAt: 1789800000000 });

  for (const field of REQUIRED_SESSION_FIELDS) {
    assert.ok(field in session, `session must carry ${field}`);
  }
  assert.equal(session.id, SESSION_ID);
  assert.equal(session.status, 'idle');
  assert.equal(session.last_sequence, 0);
  assert.equal(session.running, false);
  assert.equal(session.created_at, new Date(1789600000000).toISOString());
  assert.equal(session.updated_at, new Date(1789800000000).toISOString());
});

test('id must be a real DSH session id and no second conversation id is minted', () => {
  assert.throws(() => makeSession({}), TypeError);
  assert.throws(() => makeSession({ id: '' }), TypeError);
  assert.throws(() => makeSession({ id: 42 }), TypeError);

  const session = makeSession({ id: SESSION_ID });
  // Exactly one identity field exists.
  const identityFields = Object.keys(session).filter((key) => key === 'id' || key.endsWith('_id'));
  assert.deepEqual(identityFields.sort(), ['id']);
});

test('title and created_at stay null without evidence and are never invented', () => {
  const session = makeSession({ id: SESSION_ID });
  assert.equal(session.title, null);
  assert.equal(session.created_at, null);
  assert.equal(session.updated_at, null);

  // An empty title is not a title.
  assert.equal(makeSession({ id: SESSION_ID, title: '' }).title, null);
});

test('an adapter summary maps onto a domain session without fabricating fields', () => {
  const session = sessionFromAdapterSummary(
    { id: SESSION_ID, title: null, status: 'running', created_at: null, updated_at: new Date(1789800000000).toISOString(), running: true },
    { status: 'running', lastSequence: 7 },
  );

  assert.equal(session.id, SESSION_ID);
  assert.equal(session.status, 'running');
  assert.equal(session.running, true);
  assert.equal(session.last_sequence, 7);
  assert.equal(session.title, null);
  assert.equal(session.created_at, null);
  assert.equal(session.updated_at, new Date(1789800000000).toISOString());
});

test('last_sequence is the Gateway sequence and defaults to zero, never a DSH cursor', () => {
  const session = makeSession({ id: SESSION_ID, lastSequence: 92 });
  assert.equal(session.last_sequence, 92);

  // No field named `sequence` or `cursor` exists on a session: the DSH cursor
  // lives on the store as `dsh_cursor`, deliberately elsewhere.
  assert.equal('sequence' in session, false);
  assert.equal('cursor' in session, false);
});

test('an illegal status or last_sequence fails closed', () => {
  assert.throws(() => makeSession({ id: SESSION_ID, status: 'ninth_state' }), TypeError);
  assert.throws(() => makeSession({ id: SESSION_ID, status: 'COMPLETED' }), TypeError);
  assert.throws(() => makeSession({ id: SESSION_ID, lastSequence: -1 }), TypeError);
  assert.throws(() => makeSession({ id: SESSION_ID, lastSequence: 1.5 }), TypeError);
  assert.throws(() => makeSession({ id: SESSION_ID, lastSequence: '3' }), TypeError);

  for (const status of ALL_STATUSES) {
    assert.doesNotThrow(() => makeSession({ id: SESSION_ID, status }));
  }
});

test('validateSession accepts a well-formed session and rejects each broken shape', () => {
  const session = makeSession({ id: SESSION_ID });
  assert.equal(validateSession(session).ok, true);

  assert.equal(validateSession(null).ok, false);
  assert.equal(validateSession({}).ok, false);
  assert.equal(validateSession({ ...session, id: '' }).ok, false);
  assert.equal(validateSession({ ...session, status: 'nope' }).ok, false);
  assert.equal(validateSession({ ...session, title: 5 }).ok, false);
  assert.equal(validateSession({ ...session, created_at: 5 }).ok, false);
  assert.equal(validateSession({ ...session, last_sequence: -1 }).ok, false);
  assert.equal(validateSession({ ...session, running: 'yes' }).ok, false);
});

test('metadata is optional and the mobile projection drops it', () => {
  const session = makeSession({
    id: SESSION_ID,
    metadata: { rawDsh: { isSeeded: false }, internal: 'value' },
  });
  assert.ok(session.metadata);

  const mobile = toMobileSession(session);
  assert.equal('metadata' in mobile, false, 'the mobile layer must not need metadata');
  assert.equal('observed_at' in mobile, false);
  for (const field of REQUIRED_SESSION_FIELDS) {
    assert.ok(field in mobile, `mobile projection must carry ${field}`);
  }
});

test('the mobile projection refuses an invalid session rather than emitting junk', () => {
  assert.throws(() => toMobileSession({ ...makeSession({ id: SESSION_ID }), status: 'nope' }), TypeError);
});
