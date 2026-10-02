import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, parseAbi, type TransactionReceipt } from 'viem';
import { advanceReinvest, readBuildingReinvest, startBuildingReinvest, type ReinvestRecord } from './building-revenue-reinvest.ts';
import { claimedBuildingAmount } from './building-revenue-claims.ts';
import { LocalStore } from './store.ts';
import type { LocalInvestmentOrder } from './local-investments.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';

const account = '0x1111111111111111111111111111111111111111';
const distributor = '0x2222222222222222222222222222222222222222';
const initial: ReinvestRecord = { id: 'flow', account, phase: 'claim', claimId: 'claim', approveId: 'approve', stakeId: 'stake', buyRequestId: 'buy', orderId: null, claimedRaw: null, unitsRaw: null, error: null };
const claimed = { planId: 'claim', operation: 'claim', status: 'confirmed', claimedRaw: '10400', hash: 'claimhash' };
const purchase: LocalInvestmentOrder = { id: 'order', projectId: 'demo-neighbourhood-homes', direction: 'buy', state: 'completed', cashAtomic: '10400', minimumUnitsRaw: '10400000000000000', expiresAt: '2026-10-02T00:00:00Z', steps: [], error: null };

test('reinvest resumes only after confirmed own steps and buys the actual claimed amount', () => {
  assert.equal(advanceReinvest(initial, [{ ...claimed, status: 'pending' }], null).phase, 'claim');
  assert.equal(advanceReinvest(initial, [{ ...claimed, planId: 'someone-else' }], null).phase, 'claim');
  let flow = advanceReinvest(initial, [claimed], null);
  assert.equal(flow.phase, 'buy'); assert.equal(flow.claimedRaw, '10400');
  flow = { ...flow, orderId: purchase.id };
  assert.equal(advanceReinvest(flow, [claimed], { ...purchase, state: 'pending' }).phase, 'buy');
  flow = advanceReinvest(flow, [claimed], purchase);
  assert.equal(flow.phase, 'approve'); assert.equal(flow.unitsRaw, purchase.minimumUnitsRaw);
  flow = advanceReinvest(flow, [{ ...claimed, planId: 'approve', operation: 'approve' }], purchase);
  assert.equal(flow.phase, 'stake');
  flow = advanceReinvest(flow, [{ ...claimed, planId: 'stake', operation: 'stake' }], purchase);
  assert.equal(flow.phase, 'completed');
});
test('failed, unverified and out-of-cap claims never spend other wallet cash', () => {
  for (const claimedRaw of [null, '0', '999', '100000001']) assert.equal(advanceReinvest(initial, [{ ...claimed, claimedRaw }], null).phase, 'stopped');
  for (const claimedRaw of ['1000', '100000000']) assert.equal(advanceReinvest(initial, [{ ...claimed, claimedRaw }], null).phase, 'buy');
  assert.equal(advanceReinvest(initial, [{ ...claimed, status: 'failed' }], null).phase, 'stopped');
  const flow = { ...initial, phase: 'buy' as const, claimedRaw: '10400', orderId: purchase.id };
  assert.throws(() => advanceReinvest(flow, [], { ...purchase, cashAtomic: '10401' }), /differs/);
  assert.throws(() => advanceReinvest(flow, [], { ...purchase, direction: 'sell' }), /differs/);
  assert.equal(advanceReinvest(flow, [], { ...purchase, id: 'foreign' }).phase, 'buy');
  assert.equal(advanceReinvest(flow, [], { ...purchase, state: 'failed' }).phase, 'stopped');
});
test('confirmed claim amount ignores foreign contract and foreign account events', () => {
  const abi = parseAbi(['event Claimed(address indexed account,uint256 amount)']);
  const log = (address: string, owner: string, amount: bigint) => ({ address, topics: encodeEventTopics({ abi, eventName: 'Claimed', args: { account: owner as `0x${string}` } }), data: encodeAbiParameters([{ type: 'uint256' }], [amount]) });
  const logs = [log(distributor, account, 10400n), log(account, account, 999999n), log(distributor, distributor, 555n)];
  assert.equal(claimedBuildingAmount({ logs } as Pick<TransactionReceipt, 'logs'>, distributor, account), '10400');
});
test('reinvest cannot be read or started without a verified own EVM wallet', async () => {
  const store = new LocalStore(':memory:');
  try {
    const identity = { subject: 'no-wallet', wallets: [] } as unknown as VerifiedIdentity;
    await assert.rejects(readBuildingReinvest(store, identity), /no Robinhood wallet/);
    await assert.rejects(startBuildingReinvest(store, identity), /no Robinhood wallet/);
    const other = { subject: 'other', wallets: [{ id: 'other', chainType: 'ethereum', address: distributor }] } as unknown as VerifiedIdentity;
    await store.create(`building-revenue:reinvest:${account}`, initial);
    assert.equal(await readBuildingReinvest(store, other), null);
  } finally { await store.close(); }
});
