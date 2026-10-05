import test from 'node:test';
import assert from 'node:assert/strict';
import { buildingActionState, estimateBuildingHeat, projectedBuildingEarnings, solanaHouseActionState, solanaHouseBlockhashStatus, solanaHouseSigningBlocker } from './building-panel-logic.ts';

test('measured token energy takes precedence over nominal runtime', () => {
  assert.deepEqual(estimateBuildingHeat({ tokens: 1000, measuredWhPerToken: 0.2, runtimeMs: 3_600_000, nominalWatts: 300 }), { kwh: 0.2, assumption: '1000 served tokens × 0.2 measured Wh/token', method: 'tokens' });
});
test('nominal runtime heat converts milliseconds and watts to kWh', () => {
  const value = estimateBuildingHeat({ tokens: 10, runtimeMs: 7_200_000, nominalWatts: 300 });
  assert.equal(value?.kwh, 0.6);
  assert.equal(value?.method, 'runtime');
});
test('missing or invalid telemetry does not invent zero heat', () => {
  assert.equal(estimateBuildingHeat({ tokens: 100 }), null);
  assert.equal(estimateBuildingHeat({ tokens: 100, runtimeMs: -1, nominalWatts: 300 }), null);
  assert.equal(estimateBuildingHeat({ tokens: 100, measuredWhPerToken: NaN }), null);
  assert.equal(estimateBuildingHeat({ tokens: 0, measuredWhPerToken: 0.1 })?.kwh, 0);
});
const ready = { operation: 'stake' as const, quantityRaw: '1000000000000000000', walletUnitsRaw: '2000000000000000000', stakedRaw: '1000000000000000000', earnedRaw: '10400', connected: true, configured: true, busy: false };
test('stake and unstake cannot exceed their separate verified balances', () => {
  assert.equal(buildingActionState(ready), null);
  assert.equal(buildingActionState({ ...ready, operation: 'unstake' }), null);
  assert.equal(buildingActionState({ ...ready, quantityRaw: '2000000000000000000' }), null);
  assert.equal(buildingActionState({ ...ready, operation: 'unstake', quantityRaw: '2000000000000000000' }), 'Not enough staked tHOME units');
  assert.equal(buildingActionState({ ...ready, quantityRaw: '2000000000000000001' }), 'Not enough wallet tHOME units');
  assert.equal(buildingActionState({ ...ready, walletUnitsRaw: null }), 'Wait for verified unit balances');
  assert.equal(buildingActionState({ ...ready, quantityRaw: '0' }), 'Enter a positive tHOME amount');
  assert.equal(buildingActionState({ ...ready, quantityRaw: null }), 'Enter a positive tHOME amount');
});
test('claims require known positive earnings but no stake input or remaining stake', () => {
  const claim = { ...ready, operation: 'claim' as const, quantityRaw: null, stakedRaw: '0' };
  assert.equal(buildingActionState(claim), null);
  assert.equal(buildingActionState({ ...claim, earnedRaw: '0' }), 'No claimable test dollars');
  assert.equal(buildingActionState({ ...claim, earnedRaw: null }), 'Wait for verified earnings');
});
test('disconnected, unconfigured and in-flight actions cannot be prepared', () => {
  assert.equal(buildingActionState({ ...ready, connected: false }), 'Connect your Shares wallet in Me');
  assert.equal(buildingActionState({ ...ready, configured: false }), 'Building distributor not configured');
  assert.equal(buildingActionState({ ...ready, busy: true }), 'Finish the current building action first');
});
test('any connected wallet may start a positive income stream without units or earned rewards', () => {
  const sync = { ...ready, operation: 'sync' as const, pendingRevenueRaw: '10400', quantityRaw: null, walletUnitsRaw: '0', stakedRaw: '0', earnedRaw: '0' };
  assert.equal(buildingActionState(sync), null);
  assert.equal(buildingActionState({ ...sync, pendingRevenueRaw: '0' }), 'No new income to start streaming');
  assert.equal(buildingActionState({ ...sync, pendingRevenueRaw: null }), 'Wait for verified new income');
  assert.equal(buildingActionState({ ...sync, connected: false }), 'Connect your Shares wallet in Me');
  assert.equal(buildingActionState({ ...sync, busy: true }), 'Finish the current building action first');
});

test('earnings projection ticks by stake share and never past the stream end or through an idle pool', () => {
  const stream = { earnedRaw: '10400', stakedRaw: '5', totalStakedRaw: '10', rewardRateRaw: (2n * 10n ** 36n).toString(), rewardScaleRaw: (10n ** 36n).toString(), periodFinish: 200, observedAt: 100, now: 101 };
  assert.equal(projectedBuildingEarnings(stream), '10401');
  assert.equal(projectedBuildingEarnings({ ...stream, now: 1000 }), '10500');
  assert.equal(projectedBuildingEarnings({ ...stream, now: 99 }), '10400');
  assert.equal(projectedBuildingEarnings({ ...stream, totalStakedRaw: '0' }), '10400');
  assert.equal(projectedBuildingEarnings({ ...stream, stakedRaw: '0' }), '10400');
});

const solanaReady = { operation: 'buy' as const, connected: true, configured: true, busy: false, quantityRaw: '5000000', cashAtomic: '10000000', walletUnitsRaw: '5000000', stakedRaw: '3000000', earnedRaw: '2000000', priceAtomic: '1000000', sellCapUnitsRaw: '100000000', deskCashAtomic: '10000000' };
test('Solana buys need verified cash but no native fee balance; atomic limits are enforced', () => {
  assert.equal(solanaHouseActionState(solanaReady), null);
  assert.equal(solanaHouseActionState({ ...solanaReady, cashAtomic: null }), 'Wait for your verified tUSDC balance');
  assert.equal(solanaHouseActionState({ ...solanaReady, cashAtomic: '4999999' }), 'Get more test USDC in Me');
  assert.equal(solanaHouseActionState({ ...solanaReady, quantityRaw: '999' }), 'Buy between 0.001 and 100 tUSDC');
  assert.equal(solanaHouseActionState({ ...solanaReady, quantityRaw: '100000001' }), 'Buy between 0.001 and 100 tUSDC');
  for (const quantityRaw of [null, '0', '-1', '1.1', '18446744073709551616']) assert.equal(solanaHouseActionState({ ...solanaReady, quantityRaw }), 'Enter a positive six-decimal amount');
});
test('Solana sell and unstake respect separate wallet/stake balances, desk liquidity and caps', () => {
  assert.equal(solanaHouseActionState({ ...solanaReady, operation: 'sell' }), null);
  assert.equal(solanaHouseActionState({ ...solanaReady, operation: 'sell', deskCashAtomic: '4999999' }), 'The house desk needs more test USDC');
  assert.equal(solanaHouseActionState({ ...solanaReady, operation: 'sell', sellCapUnitsRaw: '4999999' }), 'Sell-back exceeds the house unit cap');
  assert.equal(solanaHouseActionState({ ...solanaReady, operation: 'stake', quantityRaw: '5000001' }), 'Not enough wallet units; unstake before selling');
  assert.equal(solanaHouseActionState({ ...solanaReady, operation: 'unstake', quantityRaw: '3000001' }), 'Not enough of your own staked units');
  assert.equal(solanaHouseActionState({ ...solanaReady, operation: 'unstake', quantityRaw: '3000000' }), null);
});
test('Solana claim and one-signature reinvest need verified income, never approval or gas', () => {
  assert.equal(solanaHouseActionState({ ...solanaReady, operation: 'claim', quantityRaw: null, stakedRaw: '0' }), null);
  assert.equal(solanaHouseActionState({ ...solanaReady, operation: 'reinvest', quantityRaw: null }), null);
  assert.equal(solanaHouseActionState({ ...solanaReady, operation: 'claim', earnedRaw: null }), 'Wait for verified claimable income');
  assert.equal(solanaHouseActionState({ ...solanaReady, operation: 'claim', earnedRaw: '0' }), 'No claimable test USDC');
  assert.equal(solanaHouseActionState({ ...solanaReady, operation: 'reinvest', earnedRaw: '100000001' }), 'One reinvest is capped at 100 tUSDC');
  assert.equal(solanaHouseActionState({ ...solanaReady, operation: 'reinvest', earnedRaw: '1', priceAtomic: '2000000' }), 'Income is too small to buy an atomic unit');
  assert.equal(solanaHouseActionState({ ...solanaReady, connected: false }), 'Connect your Solana wallet in Me');
  assert.equal(solanaHouseActionState({ ...solanaReady, configured: false }), 'Wait for the verified Solana house');
  assert.equal(solanaHouseActionState({ ...solanaReady, busy: true }), 'Finish the current house review or transaction first');
});

test('house wallet prompts are blocked by canonical terminal or ambiguous states, not inferred from balances', () => {
  assert.match(solanaHouseSigningBlocker({ state: 'prepared' })!, /validity could not be verified.*No wallet prompt/);
  assert.match(solanaHouseSigningBlocker({ state: 'prepared', blockhashValid: false })!, /validity could not be verified/);
  assert.equal(solanaHouseSigningBlocker({ state: 'prepared', blockhashValid: true }), null);
  assert.match(solanaHouseSigningBlocker({ state: 'expired', blockhashValid: false })!, /network blockhash expired/);
  assert.match(solanaHouseSigningBlocker({ state: 'expired', blockhashValid: false })!, /No transaction was sent.*Prepare a fresh review/);
  const policyEnded = solanaHouseSigningBlocker({ state: 'expired', blockhashValid: true })!;
  assert.match(policyEnded, /server review-policy deadline ended/); assert.doesNotMatch(policyEnded, /network blockhash expired/);
  assert.match(solanaHouseSigningBlocker({ state: 'expired', signature: 'original-signed-transaction' })!, /did not land before expiry/);
  assert.match(solanaHouseSigningBlocker({ state: 'broadcast', signature: 'original-signed-transaction' })!, /Continue checking.*instead of signing a replacement/);
  assert.match(solanaHouseSigningBlocker({ state: 'failed', signature: 'original-signed-transaction' })!, /no successful payout receipt.*Prepare a fresh review/);
  assert.match(solanaHouseSigningBlocker({ state: 'confirmed', signature: 'original-signed-transaction' })!, /verified finalized receipt.*do not sign it again/);
});

test('house network countdown uses observed confirmed heights and includes the last valid height', () => {
  assert.match(solanaHouseBlockhashStatus({ lastValidBlockHeight: '100', blockHeight: '90', blockhashValid: true }), /11 valid block heights remaining/);
  const lastValid = solanaHouseBlockhashStatus({ lastValidBlockHeight: '100', blockHeight: '100', blockhashValid: true });
  assert.match(lastValid, /valid at confirmed height 100.*1 valid block heights remaining/);
  assert.doesNotMatch(lastValid, /seconds|minutes|120/);
  assert.match(solanaHouseBlockhashStatus({ lastValidBlockHeight: '100', blockHeight: '101', blockhashValid: false }), /expired.*height 101.*last valid height 100/);
});

test('missing canonical height or validity never invents a blockchain expiry time', () => {
  for (const input of [{ lastValidBlockHeight: '100' }, { lastValidBlockHeight: '100', blockHeight: '90' }, { lastValidBlockHeight: '100', blockHeight: 'invalid', blockhashValid: true }])
    assert.match(solanaHouseBlockhashStatus(input), /has not been verified yet.*before a wallet prompt/);
});
