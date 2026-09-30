import assert from 'node:assert/strict';
import { test } from 'node:test';
import { purged, textDue, textGraceMs } from './local-ai-retention.ts';

const now = Date.parse('2026-09-29T12:00:00.000Z');
const grace = 600_000;
const before = new Date(now - grace - 1).toISOString();
const boundary = new Date(now - grace).toISOString();
const later = new Date(now - grace + 1).toISOString();
function row(state: 'payment_required' | 'approval_required' | 'ready' | 'running' | 'settling' | 'completed' | 'failed' | 'expired' | 'interrupted', expiresAt = before) {
  return { request: { state, expiresAt, prompt: 'Private question', answer: 'Private answer' as string | null,
    purgedAt: null as string | null, payment: { state: 'none' } }, paymentJournal: null as object | null,
    completedAt: undefined as string | undefined, runningAt: undefined as number | undefined };
}

test('grace defaults, clamps and rejects invalid configuration', () => {
  assert.equal(textGraceMs({}), grace);
  assert.equal(textGraceMs({ LOCAL_AI_TEXT_GRACE_SECONDS: '0' }), 0);
  assert.equal(textGraceMs({ LOCAL_AI_TEXT_GRACE_SECONDS: '-3' }), 0);
  assert.equal(textGraceMs({ LOCAL_AI_TEXT_GRACE_SECONDS: '90000' }), 86_400_000);
  assert.equal(textGraceMs({ LOCAL_AI_TEXT_GRACE_SECONDS: '1.25' }), 1250);
  for (const invalid of ['', '   ', 'abc', 'Infinity', 'NaN'])
    assert.equal(textGraceMs({ LOCAL_AI_TEXT_GRACE_SECONDS: invalid }), grace);
});

test('abandoned unpaid quotes wait through expiry plus grace', () => {
  for (const state of ['payment_required', 'approval_required', 'ready'] as const) {
    const record = row(state, boundary);
    assert.equal(textDue(record, now - 1, grace), false);
    assert.equal(textDue(record, now, grace), true);
    record.paymentJournal = {};
    assert.equal(textDue(record, now, grace), false);
  }
});

test('running, settling and in-flight payments cannot lose text', () => {
  for (const state of ['running', 'settling'] as const)
    assert.equal(textDue(row(state), now, grace), false);
  for (const paymentState of ['authorized', 'pending']) {
    const inFlight = row('ready');
    inFlight.request.payment.state = paymentState;
    inFlight.paymentJournal = {};
    assert.equal(textDue(inFlight, now, grace), false);
    const quote = row('payment_required');
    quote.request.payment.state = paymentState;
    assert.equal(textDue(quote, now, grace), false);
  }
});

test('a failed or interrupted paid request does not keep its question because its payment stayed authorized', () => {
  for (const state of ['failed', 'interrupted'] as const) {
    const record = row(state, before);
    record.request.payment.state = 'authorized';
    record.paymentJournal = {};
    assert.equal(textDue(record, now, grace), true, `${state} is terminal`);
    assert.equal(textDue(record, Date.parse(before) + grace - 1, grace), false, `${state} still inside the grace period`);
  }
});

test('terminal text uses completion, interruption start, then expiry fallback', () => {
  for (const state of ['completed', 'failed', 'expired', 'interrupted'] as const) {
    const record = row(state, later);
    assert.equal(textDue(record, now, grace), false);
    record.completedAt = boundary;
    assert.equal(textDue(record, now, grace), true);
    record.completedAt = undefined;
    if (state === 'interrupted') {
      record.runningAt = Date.parse(boundary);
      assert.equal(textDue(record, now, grace), true);
      record.runningAt = Date.parse(later);
      assert.equal(textDue(record, now, grace), false);
    }
    record.request.expiresAt = before;
    if (state === 'interrupted') record.runningAt = undefined;
    assert.equal(textDue(record, now, grace), true);
  }
});

test('already purged records stay purged and scrubbing changes text only', () => {
  const record = { ...row('completed'), id: 'immutable-id', usage: { inputTokens: 17 }, fingerprint: 'digest',
    receipt: { transaction: 'receipt' }, paymentJournal: { signed: 'authorization' } };
  const cleaned = purged(record, now);
  assert.equal(cleaned.request.prompt, '');
  assert.equal(cleaned.request.answer, null);
  assert.equal(cleaned.request.purgedAt, new Date(now).toISOString());
  assert.equal(cleaned.request.state, 'completed');
  assert.equal(cleaned.request.payment.state, 'none');
  assert.equal(cleaned.paymentJournal, record.paymentJournal);
  assert.equal(cleaned.usage, record.usage);
  assert.equal(cleaned.receipt, record.receipt);
  assert.equal(cleaned.fingerprint, record.fingerprint);
  assert.equal(record.request.prompt, 'Private question');
  assert.equal(textDue(cleaned, now + grace, 0), false);
});
