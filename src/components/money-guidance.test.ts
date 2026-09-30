import assert from 'node:assert/strict';
import test from 'node:test';
import { needsTestFunds, priceFallBeforeLiquidation, missingRepaymentCash, stakeDisabledReason } from './money-guidance.ts';
import { visibleDepositActivity } from './deposit-activity.ts';

test('funding directions expand only after both wallet balances are known and empty', () => {
  assert.equal(needsTestFunds('0', '0'), true);
  assert.equal(needsTestFunds(null, '0'), false);
  assert.equal(needsTestFunds('5000000', '0'), false);
  assert.equal(needsTestFunds('0', '1000000'), false);
});

test('loan liquidation distance uses the 80% threshold, not the 50% borrowing cap', () => {
  assert.equal(priceFallBeforeLiquidation('100000000', '80000000'), 0);
  assert.equal(priceFallBeforeLiquidation('100000000', '50000000'), 37);
  assert.equal(priceFallBeforeLiquidation('100000000', '85000000'), 0);
  assert.equal(priceFallBeforeLiquidation('0', '50000000'), null);
  assert.equal(priceFallBeforeLiquidation('100000000', '0'), null);
  assert.equal(missingRepaymentCash('9900000', '10000000'), 101000n);
});

test('stake funding blockers distinguish cash, gas and server cap', () => {
  const initial = { amountAtomic: '5000000', cashAtomic: '5000000', nativeAtomic: '1', hasWallet: true };
  assert.equal(stakeDisabledReason(initial), '');
  assert.match(stakeDisabledReason({ ...initial, cashAtomic: '0' }), /more test USD/);
  assert.match(stakeDisabledReason({ ...initial, nativeAtomic: '0' }), /network-fee test ETH/);
  assert.match(stakeDisabledReason({ ...initial, cashAtomic: '0', nativeAtomic: '0' }), /both/);
  assert.match(stakeDisabledReason({ ...initial, amountAtomic: '100000001' }), /capped at 100/);
});

test('activity excludes another party’s action and unconfirmed preparation', () => {
  const entries = [
    { role: 'tenant', state: 'finalized', action: { kind: 'fund_and_supply' } },
    { role: 'landlord', state: 'finalized', action: { kind: 'propose_claim' } },
    { role: 'tenant', state: 'expired', action: { kind: 'payout' } },
    { role: 'tenant', state: 'failed', action: { kind: 'release_earnings' } },
  ];
  assert.deepEqual(visibleDepositActivity('tenant', entries), [entries[0], entries[3]]);
  assert.deepEqual(visibleDepositActivity('landlord', entries), [entries[1]]);
  assert.deepEqual(visibleDepositActivity('arbitrator', entries), []);
});
