import assert from 'node:assert/strict';
import test from 'node:test';
import { stakeDisabledReason, TEST_EXIT_NOTICE } from './money-guidance.ts';
import { IDEAS, LEDGER_ADAPTERS } from '../data/ledger-catalogue.ts';
import { TEST_CITY_INVESTMENTS } from '../data/local-investments.ts';
import { visibleDepositActivity } from './deposit-activity.ts';

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

test('local-stake disclosures distinguish fictional cash-limited sell-back from real rights or a permanent purchase', () => {
  const adapter = LEDGER_ADAPTERS.find((entry) => entry.id === 'local-capital')!;
  const idea = IDEAS.find((entry) => entry.id === 'local-investments')!;
  for (const disclosure of [TEST_EXIT_NOTICE, adapter.explain.brings, adapter.explain.disconnect, idea.enables]) {
    assert.match(disclosure, /fictional test units/i);
    assert.match(disclosure, /no value/i);
    assert.match(disclosure, /no rights/i);
    assert.doesNotMatch(disclosure, /cannot be sold|no sell|purchase is permanent/i);
  }
  assert.match(TEST_EXIT_NOTICE, /desk has enough test cash/i);
  assert.match(adapter.explain.disconnect, /enough tUSDG/i);
  assert.match(idea.needs!, /Verified issuers, legal rights/i);
  const housing = TEST_CITY_INVESTMENTS.find((entry) => entry.symbol === 'tHOME')!;
  const [longitude, latitude] = housing.location.coordinates;
  const oldProjectDistanceMetres = Math.hypot((longitude - 13.8822) * Math.cos(52.5801 * Math.PI / 180), latitude - 52.5801) * 111_000;
  assert.ok(oldProjectDistanceMetres > 1_000, 'illustrative housing pin must not sit next to the real Altstadt project');
});
