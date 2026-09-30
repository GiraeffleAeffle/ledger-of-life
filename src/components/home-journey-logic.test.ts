import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimAmount, confirmationStalled, invitationKey, invitationPayload, invitationStatus, pollingPaused, settlementSplit } from './home-journey-logic.ts';

test('claim respects the full deposit and six-decimal atomic precision', () => {
  assert.equal(claimAmount('0,50', '1000001'), '500000');
  assert.equal(claimAmount('1.000001', '1000001'), '1000001');
  assert.equal(claimAmount('0', '1000001'), '0');
  assert.throws(() => claimAmount('1.000002', '1000001'), /maximum/);
  assert.throws(() => claimAmount('0.0000001', '1000001'), /six decimal/);
});

test('settlement preview preserves the deposit including a zero claim', () => {
  assert.deepEqual(settlementSplit('1000001', '500001'), { tenantAtomic: '500000', landlordAtomic: '500001' });
  assert.deepEqual(settlementSplit('1000001', '0'), { tenantAtomic: '1000001', landlordAtomic: '0' });
  assert.throws(() => settlementSplit('1000001', '1000002'), /deposit/);
});

test('invitation is scoped to account and agreement and expires at exactly 24 hours', () => {
  assert.notEqual(invitationKey('alice', 'home'), invitationKey('bob', 'home'));
  assert.notEqual(invitationKey('alice', 'home'), invitationKey('alice', 'other'));
  assert.equal(invitationStatus(1000, 1000 + 86_400_000 - 1), 'valid');
  assert.equal(invitationStatus(1000, 1000 + 86_400_000), 'expired');
  assert.equal(invitationPayload('{'), null);
  assert.deepEqual(invitationPayload(JSON.stringify({ id: 'home', role: 'arbitrator', token: 'a'.repeat(64) })),
    { id: 'home', role: 'arbitrator', token: 'a'.repeat(64) });
});

test('waiting thresholds surface persistent failures and stalled confirmation', () => {
  assert.equal(pollingPaused(2), false);
  assert.equal(pollingPaused(3), true);
  assert.equal(confirmationStalled(0, 89_999), false);
  assert.equal(confirmationStalled(0, 90_000), true);
});
