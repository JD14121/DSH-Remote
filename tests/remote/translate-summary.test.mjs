/**
 * Session summary translation tests — R1 §12.
 *
 * R1 must not implement the nine-state machine, but it must expose the seam R2
 * replaces and must not report a status it cannot justify.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  R1_DERIVABLE_STATUSES,
  R2_STATUSES,
  SESSION_STATUS,
  deriveR1Status,
  toSummaries,
  toSummary,
} from '../../src/remote/translate/to-summary.mjs';
import { loadFixture } from './helpers.mjs';

test('the target summary shape is exactly the R1 §12 contract', () => {
  const summary = toSummary(
    { sessionId: 'session-1', updatedAt: 1789800000000, running: false, blank: false },
  );

  assert.deepEqual(Object.keys(summary).sort(), ['created_at', 'id', 'status', 'title', 'updated_at']);
  assert.equal(summary.id, 'session-1');
  assert.equal(summary.status, SESSION_STATUS.IDLE);
  assert.equal(summary.updated_at, new Date(1789800000000).toISOString());
  // R1 does not fabricate what SessionSummary does not carry.
  assert.equal(summary.title, null);
  assert.equal(summary.created_at, null);
});

test('the full nine-status vocabulary is declared for R2 without being guessed at', () => {
  const all = Object.values(SESSION_STATUS).sort();
  assert.deepEqual(all, [
    'cancelled',
    'completed',
    'disconnected',
    'failed',
    'idle',
    'queued',
    'running',
    'waiting_input',
  ]);

  // R1 reports only what a boolean `running` flag can justify.
  assert.deepEqual([...R1_DERIVABLE_STATUSES].sort(), ['disconnected', 'idle', 'running']);
  assert.deepEqual([...R2_STATUSES].sort(), [
    'cancelled',
    'completed',
    'failed',
    'queued',
    'waiting_input',
  ]);

  // The two sets must partition the vocabulary, with no overlap and no gap.
  const union = [...R1_DERIVABLE_STATUSES, ...R2_STATUSES].sort();
  assert.deepEqual(union, all);
});

test('R1 never reports completed, failed or cancelled', () => {
  const unreachable = [SESSION_STATUS.COMPLETED, SESSION_STATUS.FAILED, SESSION_STATUS.CANCELLED];

  for (const running of [true, false]) {
    for (const blank of [true, false]) {
      const status = deriveR1Status({ sessionId: 's', updatedAt: 1, running, blank });
      assert.equal(
        unreachable.includes(status),
        false,
        `a SessionSummary cannot justify status ${status}`,
      );
    }
  }
});

test('running is derived from the running flag', () => {
  assert.equal(deriveR1Status({ running: true }), SESSION_STATUS.RUNNING);
  assert.equal(deriveR1Status({ running: false }), SESSION_STATUS.IDLE);
});

test('a known transport outage reports disconnected', () => {
  assert.equal(
    deriveR1Status({ running: true }, { transportDown: true }),
    SESSION_STATUS.DISCONNECTED,
  );
});

test('a blank session is idle, not a fabricated completed state', () => {
  assert.equal(deriveR1Status({ sessionId: 's', running: false, blank: true }), SESSION_STATUS.IDLE);
});

test('the list fixture maps onto mobile summaries preserving order', () => {
  const items = loadFixture('session-list.response.json').response.result.value.items;
  const summaries = toSummaries({ items });

  assert.equal(summaries.length, 3);
  assert.deepEqual(summaries.map((s) => s.status), [
    SESSION_STATUS.RUNNING,
    SESSION_STATUS.IDLE,
    SESSION_STATUS.IDLE,
  ]);
  assert.equal(summaries[0].id, items[0].sessionId);
});

test('the R2 status seam is honoured when supplied', () => {
  const items = [{ sessionId: 'session-1', updatedAt: 1, running: false, blank: false }];
  const summaries = toSummaries(
    { items },
    { deriveStatus: () => SESSION_STATUS.WAITING_INPUT },
  );

  assert.equal(summaries[0].status, SESSION_STATUS.WAITING_INPUT);
});

test('a supplied title is used and an absent one stays null', () => {
  const withTitle = toSummary(
    { sessionId: 'session-1', updatedAt: 1, running: false },
    { title: 'a conversation' },
  );
  const withoutTitle = toSummary({ sessionId: 'session-1', updatedAt: 1, running: false });

  assert.equal(withTitle.title, 'a conversation');
  assert.equal(withoutTitle.title, null);
});

test('a summary without identity is rejected rather than silently keyed wrong', () => {
  assert.throws(() => toSummary({ updatedAt: 1, running: false }), TypeError);
  assert.throws(() => toSummary({ sessionId: '', updatedAt: 1 }), TypeError);
  assert.throws(() => toSummaries({ items: 'nope' }), TypeError);
  assert.throws(() => toSummaries(null), TypeError);
});
