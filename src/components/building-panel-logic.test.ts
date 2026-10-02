import test from 'node:test';
import assert from 'node:assert/strict';
import { buildingActionState, estimateBuildingHeat, projectedBuildingEarnings } from './building-panel-logic.ts';

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
  assert.equal(buildingActionState({ ...ready, connected: false }), 'Connect your Robinhood wallet in Me');
  assert.equal(buildingActionState({ ...ready, configured: false }), 'Building distributor not configured');
  assert.equal(buildingActionState({ ...ready, busy: true }), 'Finish the current building action first');
});
test('any connected wallet may start a positive income stream without units or earned rewards', () => {
  const sync = { ...ready, operation: 'sync' as const, pendingRevenueRaw: '10400', quantityRaw: null, walletUnitsRaw: '0', stakedRaw: '0', earnedRaw: '0' };
  assert.equal(buildingActionState(sync), null);
  assert.equal(buildingActionState({ ...sync, pendingRevenueRaw: '0' }), 'No new income to start streaming');
  assert.equal(buildingActionState({ ...sync, pendingRevenueRaw: null }), 'Wait for verified new income');
  assert.equal(buildingActionState({ ...sync, connected: false }), 'Connect your Robinhood wallet in Me');
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
