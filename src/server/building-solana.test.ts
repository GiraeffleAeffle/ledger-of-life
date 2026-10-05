import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountRole, address, appendTransactionMessageInstructions, blockhash, compileTransaction, createTransactionMessage, generateKeyPairSigner, getAddressEncoder, getCompiledTransactionMessageDecoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from '@solana/kit';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { houseAddresses, HOUSE_DISCRIMINATORS, pendingOwed, positionAddress, type HouseAccount, type PositionAccount } from '../finance/solana/house.ts';
import { SOLANA_DEVNET_MANIFEST, SOLANA_IDS, SOLANA_TEST_USDC_MINT } from '../finance/solana/manifest.ts';
import type { AccountObservation } from '../finance/solana/observations.ts';
import type { SolanaHouseManifest } from './solana-house-config.ts';
import { assertSolanaHouseOperation, buildSolanaHouseAction, houseActionQuote, readSolanaHouseSnapshot, solanaHouseReadModel, type HouseReadGateway, type SolanaHouseSnapshot } from './building-solana.ts';

async function fixture(overrides: { house?: Partial<HouseAccount>; position?: Partial<PositionAccount>; nowSeconds?: bigint } = {}) {
  const [program, owner, payer, admin] = await Promise.all(Array.from({ length: 4 }, () => generateKeyPairSigner()));
  const homes = await houseAddresses('neighbourhood-homes', program.address), workshop = await houseAddresses('workshop', program.address);
  const manifest: SolanaHouseManifest = { cluster: 'devnet', genesisHash: SOLANA_DEVNET_MANIFEST.genesisHash, programId: program.address, cashMint: SOLANA_TEST_USDC_MINT, houses: { 'neighbourhood-homes': homes, workshop } };
  const [cashAccount] = await findAssociatedTokenPda({ owner: owner.address, mint: address(manifest.cashMint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [unitAccount] = await findAssociatedTokenPda({ owner: owner.address, mint: address(homes.unitMint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const house: HouseAccount = { admin: admin.address, cashMint: manifest.cashMint, unitMint: homes.unitMint, id: 'neighbourhood-homes', bump: 1, unitMintBump: 2, deskVaultBump: 3, rewardVaultBump: 4, stakeVaultBump: 5, priceCashPerUnit: 1_000_000n, sellCapUnits: 100_000_000n, totalStaked: 5_000_000n, rewardPerUnitStored: 1_000_000_000_000n, revenueTotal: 10_000_000n, revenueBySource: [4_000_000n, 3_000_000n, 2_000_000n, 1_000_000n], stakerCount: 2, rewardDuration: 604_800n, rewardRate: 0n, periodFinish: 0n, lastUpdateTime: 1000n, streamRemainingScaled: 0n, undistributedScaled: 0n, rewardRemainderScaled: 0n, ...overrides.house };
  const position: PositionAccount = { house: homes.house, owner: owner.address, staked: 4_000_000n, rewardDebt: 0n, owed: 2_000_000n, claimedTotal: 0n, bump: 6, rewardFraction: 0n, ...overrides.position };
  const snapshot: SolanaHouseSnapshot = { house, position, walletUnits: 10_000_000n, cash: 20_000_000n, deskCash: 100_000_000n, rewardCash: 30_000_000n, unitSupply: 100_000_000n, cashAccount, unitAccount, slot: '50', nowSeconds: overrides.nowSeconds ?? 1000n };
  const encoder = getAddressEncoder();
  const mint = (key: string, authority: string | null) => {
    const data = new Uint8Array(82), view = new DataView(data.buffer);
    if (authority) { view.setUint32(0, 1, true); data.set(encoder.encode(address(authority)), 4); }
    view.setBigUint64(36, 100_000_000n, true); data[44] = 6; data[45] = 1;
    return { address: key, owner: TOKEN_PROGRAM_ADDRESS, executable: false, data };
  };
  const token = (key: string, mintKey: string, authority: string, balance: bigint) => {
    const data = new Uint8Array(165); data.set(encoder.encode(address(mintKey)), 0); data.set(encoder.encode(address(authority)), 32); new DataView(data.buffer).setBigUint64(64, balance, true); data[108] = 1;
    return { address: key, owner: TOKEN_PROGRAM_ADDRESS, executable: false, data };
  };
  const houseData = new Uint8Array(314); houseData.set([21,145,94,109,254,199,210,151]);
  let offset = 8;
  for (const key of [house.admin, house.cashMint, house.unitMint]) { houseData.set(encoder.encode(address(key)), offset); offset += 32; }
  const id = new TextEncoder().encode(house.id); houseData.set(id, offset); offset += 32; houseData[offset++] = id.length; houseData.set([1,2,3,4,5], offset); offset += 5;
  const houseView = new DataView(houseData.buffer);
  const putU64 = (amount: bigint) => { houseView.setBigUint64(offset, amount, true); offset += 8; };
  const putU128 = (amount: bigint) => { houseView.setBigUint64(offset, amount & ((1n << 64n) - 1n), true); houseView.setBigUint64(offset + 8, amount >> 64n, true); offset += 16; };
  for (const amount of [house.priceCashPerUnit, house.sellCapUnits, house.totalStaked]) putU64(amount);
  putU128(house.rewardPerUnitStored);
  for (const amount of [house.revenueTotal, ...house.revenueBySource]) putU64(amount);
  houseView.setUint32(offset, house.stakerCount, true); offset += 4;
  putU64(house.rewardDuration); putU128(house.rewardRate);
  houseView.setBigInt64(offset, house.periodFinish, true); offset += 8;
  houseView.setBigInt64(offset, house.lastUpdateTime, true); offset += 8;
  for (const amount of [house.streamRemainingScaled, house.undistributedScaled, house.rewardRemainderScaled]) putU128(amount);
  assert.equal(offset, houseData.length);
  const positionData = new Uint8Array(129); positionData.set([170,188,143,228,122,64,247,208]); positionData.set(encoder.encode(address(position.house)), 8); positionData.set(encoder.encode(address(position.owner)), 40);
  const positionView = new DataView(positionData.buffer); positionView.setBigUint64(72, position.staked, true); positionView.setBigUint64(80, position.rewardDebt & ((1n << 64n) - 1n), true); positionView.setBigUint64(88, position.rewardDebt >> 64n, true); positionView.setBigUint64(96, position.owed, true); positionView.setBigUint64(104, position.claimedTotal, true); positionData[112] = 6;
  positionView.setBigUint64(113, position.rewardFraction & ((1n << 64n) - 1n), true); positionView.setBigUint64(121, position.rewardFraction >> 64n, true);
  const clockData = new Uint8Array(40); new DataView(clockData.buffer).setBigUint64(0, 50n, true); new DataView(clockData.buffer).setBigInt64(32, snapshot.nowSeconds, true);
  const positionKey = await positionAddress(homes.house, owner.address, program.address);
  const accounts = new Map<string, AccountObservation>([
    [program.address, { address: program.address, owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable: true, data: new Uint8Array(36) }],
    [homes.house, { address: homes.house, owner: program.address, executable: false, data: houseData }],
    [homes.unitMint, mint(homes.unitMint, homes.house)], [manifest.cashMint, mint(manifest.cashMint, null)],
    [homes.deskVault, token(homes.deskVault, manifest.cashMint, homes.house, snapshot.deskCash)], [homes.rewardVault, token(homes.rewardVault, manifest.cashMint, homes.house, snapshot.rewardCash)],
    [homes.stakeVault, token(homes.stakeVault, homes.unitMint, homes.house, house.totalStaked)],
    [positionKey, { address: positionKey, owner: program.address, executable: false, data: positionData }],
    [cashAccount, token(cashAccount, manifest.cashMint, owner.address, snapshot.cash)], [unitAccount, token(unitAccount, homes.unitMint, owner.address, snapshot.walletUnits)],
    ['SysvarC1ock11111111111111111111111111111111', { address: 'SysvarC1ock11111111111111111111111111111111', owner: 'Sysvar1111111111111111111111111111111111111', executable: false, data: clockData }],
  ]);
  const gateway: HouseReadGateway = { checkedGenesis: async () => manifest.genesisHash, multiple: async keys => ({ slot: '50', accounts: keys.map(key => accounts.get(key) ?? null) }) };
  return { manifest, owner, payer, snapshot, accounts, gateway, homes, positionKey };
}

test('house finalized read uses on-chain revenue sources, total stake, staker count and pendingOwed', async () => {
  const f = await fixture(), snapshot = await readSolanaHouseSnapshot(f.manifest, 'neighbourhood-homes', f.gateway, f.owner.address);
  assert.equal(snapshot.walletUnits, 10_000_000n); assert.equal(snapshot.cash, 20_000_000n); assert.equal(pendingOwed(snapshot.house, snapshot.position!, snapshot.nowSeconds), 6_000_000n);
  const model = solanaHouseReadModel(f.manifest, 'neighbourhood-homes', snapshot);
  assert.equal(model.revenueRaw, '10000000'); assert.equal(model.totalStakedRaw, '5000000'); assert.equal(model.stakerCount, 2); assert.equal(model.unitDecimals, 6);
  assert.deepEqual(model.incomeSources.map(source => [source.id, source.amountRaw]), [['rent','4000000'],['ai','3000000'],['solar','2000000'],['other','1000000']]);
  assert.equal(model.rewardRateRaw, '0'); assert.equal(model.rewardDuration, 604800); assert.equal(model.observedChainTimestampRaw, '1000');
});

test('missing wallet ATAs and position are zero; wrong program, PDA, mint and owner are refused', async () => {
  const f = await fixture(); f.accounts.delete(f.snapshot.cashAccount!); f.accounts.delete(f.snapshot.unitAccount!); f.accounts.delete(f.positionKey);
  const empty = await readSolanaHouseSnapshot(f.manifest, 'neighbourhood-homes', f.gateway, f.owner.address);
  assert.equal(empty.walletUnits, 0n); assert.equal(empty.cash, 0n); assert.equal(empty.position, null);
  const wrong = { ...f.manifest, houses: { ...f.manifest.houses, 'neighbourhood-homes': { ...f.homes, deskVault: f.owner.address } } };
  await assert.rejects(readSolanaHouseSnapshot(wrong, 'neighbourhood-homes', f.gateway), /PDA mismatch/);
  const house = f.accounts.get(f.homes.house)!; f.accounts.set(f.homes.house, { ...house, owner: f.owner.address });
  await assert.rejects(readSolanaHouseSnapshot(f.manifest, 'neighbourhood-homes', f.gateway), /program or account/); f.accounts.set(f.homes.house, house);
  const vault = f.accounts.get(f.homes.rewardVault)!, data = new Uint8Array(vault.data); data.set(getAddressEncoder().encode(f.owner.address)); f.accounts.set(f.homes.rewardVault, { ...vault, data });
  await assert.rejects(readSolanaHouseSnapshot(f.manifest, 'neighbourhood-homes', f.gateway), /owner or mint mismatch/);
});

test('buy/sell quotes apply six-decimal ceil/floor prices and verified blockers', async () => {
  const f = await fixture(), snapshot = { ...f.snapshot, house: { ...f.snapshot.house, priceCashPerUnit: 3_000_000n } };
  assert.deepEqual(houseActionQuote('buy', { cashAtomic: '5000000' }, snapshot), { operation: 'buy', units: 1_666_666n, cash: 4_999_998n, claim: 0n });
  assert.equal(houseActionQuote('sell', { quantity: '1234567' }, snapshot).cash, 3_703_701n);
  assert.throws(() => houseActionQuote('buy', { cashAtomic: '100000001' }, snapshot), /between/);
  assert.throws(() => houseActionQuote('buy', { cashAtomic: '5000000' }, { ...snapshot, cash: 1n }), /more test USDC/);
  assert.throws(() => houseActionQuote('sell', { quantity: '10000001' }, snapshot), /Not enough wallet/);
  assert.throws(() => houseActionQuote('sell', { quantity: '1000000' }, { ...snapshot, deskCash: 0n }), /insufficient/);
  assert.throws(() => houseActionQuote('unstake', { quantity: '4000001' }, snapshot), /own staked/);
  assert.throws(() => houseActionQuote('stake', { quantity: '18446744073709551616' }, snapshot), /positive atomic/);
  assert.throws(() => houseActionQuote('claim', {}, { ...snapshot, position: null }), /No claimable/);
  assert.throws(() => houseActionQuote('reinvest', { quantity: '1' }, snapshot), /without an amount/);
});

test('buy, sell, stake, unstake and claim instructions pin accounts, signer and atomic amount', async () => {
  const f = await fixture();
  for (const operation of ['buy', 'sell', 'stake', 'unstake', 'claim'] as const) {
    const quote = houseActionQuote(operation, operation === 'buy' ? { cashAtomic: '1000000' } : operation === 'claim' ? {} : { quantity: '1000000' }, f.snapshot);
    const built = await buildSolanaHouseAction(f.manifest, 'neighbourhood-homes', f.owner.address, f.payer.address, quote, f.snapshot);
    const programInstructions = built.instructions.filter(ix => ix.programAddress === f.manifest.programId);
    assert.equal(programInstructions.length, 1);
    const ix = programInstructions[0], name = operation === 'buy' ? 'buy_units' : operation === 'sell' ? 'sell_units' : operation;
    assert.deepEqual([...ix.data!.slice(0, 8)], [...HOUSE_DISCRIMINATORS[name]]);
    assert.equal(ix.accounts![0].address, f.owner.address); assert.equal(ix.accounts![0].role, AccountRole.READONLY_SIGNER);
    assert.ok(ix.accounts!.some(meta => meta.address === f.homes.house));
    assert.ok(ix.accounts!.some(meta => meta.address === TOKEN_PROGRAM_ADDRESS));
    if (operation !== 'claim') assert.equal(new DataView(ix.data!.buffer, ix.data!.byteOffset).getBigUint64(8, true), 1_000_000n);
    if (operation === 'stake') { assert.equal(ix.accounts![1].address, f.payer.address); assert.equal(ix.accounts![1].role, AccountRole.WRITABLE_SIGNER); assert.equal(ix.accounts![3].address, f.positionKey); }
    if (operation === 'claim') { assert.equal(ix.accounts![3].address, f.snapshot.cashAccount); assert.equal(ix.accounts![4].address, f.homes.rewardVault); }
    assert.ok(built.expectedDeltas.length >= 2);
    for (const ata of built.instructions.filter(ix => ix.programAddress === ASSOCIATED_TOKEN_PROGRAM_ADDRESS)) { assert.equal(ata.accounts![0].address, f.payer.address); assert.deepEqual([...ata.data!], [1]); }
  }
});

test('reinvest is atomic claim then exact buy then stake with only sponsor and user signers', async () => {
  const f = await fixture(), quote = houseActionQuote('reinvest', {}, f.snapshot);
  const built = await buildSolanaHouseAction(f.manifest, 'neighbourhood-homes', f.owner.address, f.payer.address, quote, f.snapshot);
  const program = built.instructions.filter(ix => ix.programAddress === f.manifest.programId);
  assert.deepEqual(program.map(ix => [...ix.data!.slice(0, 8)]), [HOUSE_DISCRIMINATORS.claim, HOUSE_DISCRIMINATORS.buy_units, HOUSE_DISCRIMINATORS.stake].map(bytes => [...bytes]));
  for (const ix of program.slice(1)) assert.equal(new DataView(ix.data!.buffer, ix.data!.byteOffset).getBigUint64(8, true), 6_000_000n);
  const message = pipe(createTransactionMessage({ version: 0 }), msg => setTransactionMessageFeePayer(f.payer.address, msg), msg => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(SOLANA_IDS.system), lastValidBlockHeight: 100n }, msg), msg => appendTransactionMessageInstructions(built.instructions, msg));
  const decoded = getCompiledTransactionMessageDecoder().decode(compileTransaction(message).messageBytes);
  assert.equal(decoded.header.numSignerAccounts, 2); assert.equal(decoded.staticAccounts[0], f.payer.address); assert.equal(decoded.staticAccounts[1], f.owner.address);
  assert.match(built.review.description, /one wallet signature/);
  assert.equal(built.expectedDeltas.find(delta => delta.account === f.snapshot.unitAccount)?.direction, 'unchanged');
  assert.equal(built.expectedDeltas.find(delta => delta.account === f.homes.stakeVault)?.minimumAtomic, '6000000');
});

test('workshop uses its own house mint and vaults with the same program and actions', async () => {
  const f = await fixture(), home = f.manifest.houses.workshop;
  const [unitAccount] = await findAssociatedTokenPda({ owner: f.owner.address, mint: address(home.unitMint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const snapshot = { ...f.snapshot, unitAccount, house: { ...f.snapshot.house, id: 'workshop', unitMint: home.unitMint } };
  const built = await buildSolanaHouseAction(f.manifest, 'workshop', f.owner.address, f.payer.address, houseActionQuote('buy', { cashAtomic: '1000000' }, snapshot), snapshot);
  const buy = built.instructions.find(ix => ix.programAddress === f.manifest.programId)!;
  assert.equal(buy.accounts![1].address, home.house); assert.equal(buy.accounts![2].address, home.unitMint); assert.equal(buy.accounts![5].address, home.deskVault); assert.equal(built.review.asset, 'tWORK');
});

test('streaming reads and claim minimums use the finalized bank clock, not server wall time', async () => {
  const rate = 10_000n * 1_000_000_000_000n;
  const f = await fixture({
    house: { totalStaked: 2_000_000n, rewardPerUnitStored: 0n, rewardRate: rate, lastUpdateTime: 1_000_000n, periodFinish: 1_000_600n, streamRemainingScaled: 600n * rate, undistributedScaled: 2_000_000_000_001n, rewardRemainderScaled: 0n },
    position: { staked: 1_000_000n, owed: 0n, rewardDebt: 0n }, nowSeconds: 1_000_010n,
  });
  const snapshot = await readSolanaHouseSnapshot(f.manifest, 'neighbourhood-homes', f.gateway, f.owner.address);
  const quote = houseActionQuote('claim', {}, snapshot);
  assert.equal(snapshot.nowSeconds, 1_000_010n); assert.equal(quote.claim, 50_000n);
  assert.equal(pendingOwed(snapshot.house, snapshot.position!, 1_000_020n), 100_000n);
  const model = solanaHouseReadModel(f.manifest, 'neighbourhood-homes', snapshot);
  assert.equal(model.rewardRateRaw, rate.toString()); assert.equal(model.rewardDuration, 604800);
  assert.equal(model.periodFinish, 1_000_600); assert.equal(model.lastUpdateTime, 1_000_000);
  assert.equal(model.streamRemainingScaledRaw, (600n * rate).toString()); assert.equal(model.undistributedScaledRaw, '2000000000001'); assert.equal(model.pendingRevenueRaw, '2');
  const built = await buildSolanaHouseAction(f.manifest, 'neighbourhood-homes', f.owner.address, f.payer.address, quote, snapshot);
  const cash = built.expectedDeltas.find(delta => delta.account === snapshot.cashAccount)!;
  assert.equal(cash.minimumAtomic, '50000'); assert.ok(BigInt(cash.maximumAtomic) > 100_000n);
  assert.equal(built.review.amount, 'at least $0.05'); assert.match(built.review.description, /earnings keep streaming until the transaction lands/);
});

test('reinvest fixes prepared units and cost while allowing extra streamed accrual to stay in cash', async () => {
  const rate = 10_000n * 1_000_000_000_000n;
  const f = await fixture({ house: { totalStaked: 2_000_000n, rewardPerUnitStored: 0n, rewardRate: rate, lastUpdateTime: 1_000_000n, periodFinish: 1_000_600n, streamRemainingScaled: 600n * rate }, position: { staked: 1_000_000n, owed: 0n, rewardDebt: 0n }, nowSeconds: 1_000_010n });
  const quote = houseActionQuote('reinvest', {}, f.snapshot);
  assert.equal(quote.claim, 50_000n); assert.equal(quote.units, 50_000n); assert.equal(quote.cash, 50_000n);
  const built = await buildSolanaHouseAction(f.manifest, 'neighbourhood-homes', f.owner.address, f.payer.address, quote, f.snapshot);
  for (const ix of built.instructions.filter(ix => ix.programAddress === f.manifest.programId).slice(1)) assert.equal(new DataView(ix.data!.buffer, ix.data!.byteOffset).getBigUint64(8, true), 50_000n);
  const laterClaim = pendingOwed(f.snapshot.house, f.snapshot.position!, 1_000_020n);
  assert.equal(laterClaim - quote.cash, 50_000n);
  const cash = built.expectedDeltas.find(delta => delta.account === f.snapshot.cashAccount)!;
  assert.equal(cash.minimumAtomic, '0'); assert.ok(BigInt(cash.maximumAtomic) > laterClaim - quote.cash);
  assert.match(built.review.description, /buy exactly 0.05 tHOME for exactly 0.05 tUSDC/);
  assert.match(built.review.description, /extra accrual stays in your own cash account/);
  assert.match(built.review.description, /streamed to stakers over 7 days/);
});

test('streaming reads refuse a missing clock or clock from a different bank', async () => {
  const f = await fixture(), clockAddress = 'SysvarC1ock11111111111111111111111111111111', original = f.accounts.get(clockAddress)!;
  f.accounts.delete(clockAddress);
  await assert.rejects(readSolanaHouseSnapshot(f.manifest, 'neighbourhood-homes', f.gateway), /clock is unavailable/);
  const data = new Uint8Array(original.data); new DataView(data.buffer).setBigUint64(0, 49n, true);
  f.accounts.set(clockAddress, { ...original, data });
  await assert.rejects(readSolanaHouseSnapshot(f.manifest, 'neighbourhood-homes', f.gateway), /does not match its finalized bank/);
});

test('position fractional remainder survives decoding and contributes to the claim minimum', async () => {
  const f = await fixture({ house: { totalStaked: 1n, rewardPerUnitStored: 1n }, position: { staked: 1n, owed: 0n, rewardDebt: 0n, rewardFraction: 999_999_999_999n } });
  const snapshot = await readSolanaHouseSnapshot(f.manifest, 'neighbourhood-homes', f.gateway, f.owner.address);
  assert.equal(snapshot.position!.rewardFraction, 999_999_999_999n);
  assert.equal(houseActionQuote('claim', {}, snapshot).claim, 1n);
});

test('house routes bind exact journal kind and refuse cross-domain operations from the same wallet', () => {
  const entry = { id: 'reviewed-house-operation', houseId: 'neighbourhood-homes' as const, operation: 'buy' as const };
  assert.doesNotThrow(() => assertSolanaHouseOperation({ id: entry.id, kind: 'house:neighbourhood-homes:buy' }, entry));
  for (const kind of ['shares:faucet', 'shares-market:buy', 'rent:pay', 'local-ai:approve', 'house:workshop:buy', 'house:neighbourhood-homes:sell']) {
    assert.throws(() => assertSolanaHouseOperation({ id: entry.id, kind }, entry), /not bound to the reviewed house action/);
  }
  assert.throws(() => assertSolanaHouseOperation({ id: 'another-id', kind: 'house:neighbourhood-homes:buy' }, entry), /not bound/);
  assert.throws(() => assertSolanaHouseOperation({ id: entry.id, kind: 'house:neighbourhood-homes:buy' }, undefined), /not bound/);
});
