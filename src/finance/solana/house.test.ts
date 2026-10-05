import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AccountRole, getAddressEncoder, address } from '@solana/kit';
import { addressesForHouse, buyUnitsInstruction, claimInstruction, decodeHouse, decodePosition, depositRewardsInstruction, HOUSE_DISCRIMINATORS, houseAddresses, initializeHouseInstruction, pendingOwed, positionAddress, sellUnitsInstruction, stakeInstruction, unstakeInstruction } from './house.ts';
const programId = 'CWUN8LKoKNEBJ6SQAVAqDFrb3rDP7vbVXMcf2EoAqjQM';
const owner = 'HEZ9ERxb1W9WfBjUGE6A4jFZU3jUMJRSM1kyERgac38G';
const cashAccount = 'BCgqGAUvbGobqXrJtEDS437i8r1FffVSGcnwCsHcN2oE';
test('Anchor discriminators match Rust global instruction names', () => {
  for (const [name, bytes] of Object.entries(HOUSE_DISCRIMINATORS)) assert.deepEqual(bytes, [...createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)]);
});
test('PDA seeds and all instruction account orders match Anchor', async () => {
  const a = await houseAddresses('neighbourhood-homes', programId); assert.deepEqual(a, await addressesForHouse(a.house, programId));
  const common = { house: a.house, programId, cashAccount, unitAccount: a.unitMint, units: 123n, owner };
  const buy = await buyUnitsInstruction({ ...common, buyer: owner });
  const sell = await sellUnitsInstruction({ ...common, seller: owner });
  for (const ix of [buy, sell]) { assert.deepEqual(ix.accounts?.map(a => a.address), [owner, a.house, a.unitMint, cashAccount, a.unitMint, a.deskVault, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA']); assert.equal(new DataView(ix.data!.buffer, ix.data!.byteOffset).getBigUint64(8, true), 123n); assert.equal(ix.accounts?.[0].role, AccountRole.READONLY_SIGNER); }
  const stake = await stakeInstruction({ ...common, payer: cashAccount }); assert.equal(stake.accounts?.[1].role, AccountRole.WRITABLE_SIGNER); assert.equal(stake.accounts?.[3].address, await positionAddress(a.house, owner, programId));
  const unstake = await unstakeInstruction(common), claim = await claimInstruction(common), deposit = await depositRewardsInstruction({ ...common, authority: owner, source: cashAccount, amount: 7n, sourceKind: 1 });
  assert.equal(unstake.accounts?.[4].address, a.stakeVault); assert.equal(claim.accounts?.[4].address, a.rewardVault); assert.equal(deposit.accounts?.[3].address, a.rewardVault); assert.equal(deposit.data?.[16], 1);
  const init = await initializeHouseInstruction({ admin: owner, cashMint: cashAccount, id: 'workshop', priceCashPerUnit: 1_000_000n, sellCapUnits: 100_000_000n, programId });
  assert.equal(new DataView(init.data!.buffer, init.data!.byteOffset).getUint32(8, true), 8); assert.equal(Buffer.from(init.data!.slice(12, 20)).toString(), 'workshop');
  await assert.rejects(houseAddresses('é', programId)); await assert.rejects(buyUnitsInstruction({ ...common, buyer: owner, units: -1n })); await assert.rejects(depositRewardsInstruction({ ...common, authority: owner, source: cashAccount, amount: 1n, sourceKind: 4 }));
});
test('Rust House and Position Borsh layout decodes exactly', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../programs/house/tests/layout.json', import.meta.url), 'utf8'));
  const house = decodeHouse(Buffer.from(fixture.house, 'hex')), position = decodePosition(Buffer.from(fixture.position, 'hex'));
  assert.equal(house.admin, owner); assert.equal(house.id, 'workshop'); assert.equal(house.totalStaked, 4_000_000n); assert.equal(house.rewardPerUnitStored, 2_000_000_000_000n); assert.deepEqual(house.revenueBySource, [1n, 2n, 3n, 4n]); assert.equal(house.stakerCount, 2);
  assert.equal(house.rewardDuration, 604800n); assert.equal(house.rewardRate, 4_000_000_000_000n); assert.equal(house.periodFinish, 200n); assert.equal(house.lastUpdateTime, 100n); assert.equal(house.streamRemainingScaled, 400_000_000_000_000n); assert.equal(position.rewardFraction, 500_000_000_000n);
  assert.equal(position.staked, 1_000_000n); assert.equal(position.rewardDebt, 1_000_000_000_000n); assert.equal(pendingOwed(house, position, 100n), 1_000_007n);
  assert.equal(pendingOwed(house, position, 150n), 1_000_057n); assert.equal(pendingOwed(house, position, 999n), 1_000_107n);
  assert.equal(pendingOwed({ ...house, totalStaked: 0n }, position, 999n), 1_000_007n);
  assert.throws(() => decodeHouse(new Uint8Array(314))); assert.throws(() => decodePosition(new Uint8Array(128))); assert.throws(() => pendingOwed({ ...house, rewardPerUnitStored: 0n }, position, 100n));
  assert.throws(() => pendingOwed({ ...house, rewardPerUnitStored: (1n << 128n) - 1n }, { staked: 2n, rewardDebt: 0n, owed: 0n, rewardFraction: 0n }, 100n));
  assert.throws(() => pendingOwed({ ...house, rewardPerUnitStored: 1_000_000_000_000n }, { staked: 1n, rewardDebt: 0n, owed: (1n << 64n) - 1n, rewardFraction: 0n }, 100n));
  assert.equal(getAddressEncoder().encode(address(owner)).length, 32);
});
