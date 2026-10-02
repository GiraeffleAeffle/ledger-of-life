import assert from 'node:assert/strict';
import test from 'node:test';
import { cashDepositStatus, stakeDisabledReason } from './money-guidance.ts';
import type { TenancyJourney } from '../server/journey.ts';
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

test('fictional housing example does not reuse the real Altstadt project pin', () => {
  const housing = TEST_CITY_INVESTMENTS.find((entry) => entry.symbol === 'tHOME')!;
  const [longitude, latitude] = housing.location.coordinates;
  const oldProjectDistanceMetres = Math.hypot((longitude - 13.8822) * Math.cos(52.5801 * Math.PI / 180), latitude - 52.5801) * 111_000;
  assert.ok(oldProjectDistanceMetres > 1_000, 'illustrative housing pin must not sit next to the real Altstadt project');
});

test('zero tenant entitlement distinguishes unfunded escrow, payout and an exhausted claim', () => {
  const chain = { phase: 'active', escrowAtomic: '0', lendingValueAtomic: '0', approvedClaimAtomic: '0' } as NonNullable<TenancyJourney['chain']>;
  assert.equal(cashDepositStatus({ role: 'tenant', chain }), 'unfunded');
  assert.equal(cashDepositStatus({ role: 'tenant', chain: { ...chain, escrowAtomic: '1000000' } }), 'secured');
  assert.equal(cashDepositStatus({ role: 'tenant', chain: { ...chain, escrowAtomic: '1000000', approvedClaimAtomic: '1000000' } }), 'no_entitlement');
  const settlement = { ...chain, phase: 'settling' as const, tenantOwedAtomic: '1000000', tenantPaidAtomic: '1000000' };
  assert.equal(cashDepositStatus({ role: 'tenant', chain: settlement }), 'paid_out');
  assert.equal(cashDepositStatus({ role: 'tenant', chain: { ...settlement, tenantPaidAtomic: '999999' } }), 'secured');
  assert.equal(cashDepositStatus({ role: 'tenant', chain: { ...settlement, phase: 'closed' } }), 'paid_out');
});

test('a landlord sees only their claim; an arbitrator never owns a deposit', () => {
  const chain = { phase: 'active', escrowAtomic: '2000000', lendingValueAtomic: '0', approvedClaimAtomic: '0' } as NonNullable<TenancyJourney['chain']>;
  assert.equal(cashDepositStatus({ role: 'landlord', chain }), 'held_for_tenant');
  assert.equal(cashDepositStatus({ role: 'landlord', chain: { ...chain, approvedClaimAtomic: '1' } }), 'claim_owed');
  assert.equal(cashDepositStatus({ role: 'arbitrator', chain: { ...chain, approvedClaimAtomic: '1' } }), 'not_owner');
});
