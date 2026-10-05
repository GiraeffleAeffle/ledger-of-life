import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { AccountRole, address, appendTransactionMessageInstructions, blockhash, compileTransaction, createTransactionMessage, generateKeyPairSigner, getAddressEncoder, getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, getTransactionEncoder, partiallySignTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from '@solana/kit';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { houseAddresses, HOUSE_DISCRIMINATORS, pendingOwed, positionAddress, type HouseAccount, type PositionAccount } from '../finance/solana/house.ts';
import { SOLANA_DEVNET_MANIFEST, SOLANA_IDS, SOLANA_TEST_USDC_MINT } from '../finance/solana/manifest.ts';
import type { AccountObservation } from '../finance/solana/observations.ts';
import type { SolanaHouseManifest } from './solana-house-config.ts';
import { assertSolanaHouseOperation, buildSolanaHouseAction, houseActionQuote, prepareSolanaHouseAction, readSolanaBuildingPosition, readSolanaHouseSnapshot, reconcileSolanaHouseAction, solanaHouseReadModel, submitSolanaHouseAction, type HouseReadGateway, type SolanaHouseSnapshot } from './building-solana.ts';
import { BaseSolanaGateway } from './solana-rpc.ts';
import { LocalStore } from './store.ts';
import { SolanaServiceError } from './solana-service.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import type { ExpectedTokenDelta } from '../finance/solana/reconcile.ts';

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

/** Exercises the configured production journal with ephemeral keys and no network transport. */
async function lifecycleFixture(t: TestContext, overrides: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(overrides), store = new LocalStore(':memory:');
  t.after(() => store.close());
  const keys = generateKeyPairSync('ed25519');
  const sponsorBytes = Buffer.concat([keys.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32), keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]);
  const environment = { SOLANA_RPC_URL: 'http://127.0.0.1:1', SOLANA_HOUSE_MANIFEST: JSON.stringify(f.manifest), SOLANA_SPONSOR_KEYPAIR: JSON.stringify([...sponsorBytes]) };
  const identity: VerifiedIdentity = { subject: 'did:privy:house-claim', sessionId: 'fixture', expiresAt: 9999999999, passkeyCount: 1, wallets: [{ id: 'owner', chainType: 'solana', address: f.owner.address }] };
  const state = { now: 1_000_000_000, height: 10n, confirmedHeight: 10n, lastValidHeight: 100n, blockhash: SOLANA_IDS.system as string, slot: '50', simulationError: null as Error | null, broadcastError: false, receipt: 'unknown' as 'unknown' | 'finalized' | 'failed', reads: [] as string[][], simulations: [] as { bytes: Uint8Array; expectedDeltas: readonly ExpectedTokenDelta[] }[], broadcasts: [] as Uint8Array[] };
  t.mock.method(Date, 'now', () => state.now);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('A journal regression must not make a network request.'); });
  t.mock.method(BaseSolanaGateway.prototype, 'checkedGenesis', async () => f.manifest.genesisHash);
  t.mock.method(BaseSolanaGateway.prototype, 'multiple', async (requested: readonly string[]) => {
    state.reads.push([...requested]);
    return { slot: state.slot, accounts: requested.map(key => f.accounts.get(key) ?? null) };
  });
  t.mock.method(BaseSolanaGateway.prototype, 'lifetime', async () => ({ blockhash: state.blockhash, lastValidBlockHeight: state.lastValidHeight.toString(), blockHeight: state.height.toString() }));
  t.mock.method(BaseSolanaGateway.prototype, 'blockHeight', async (commitment: 'confirmed' | 'finalized') => (commitment === 'confirmed' ? state.confirmedHeight : state.height).toString());
  t.mock.method(BaseSolanaGateway.prototype, 'simulate', async (bytes: Uint8Array, _sponsor: string, _actor: string, expectedDeltas: readonly ExpectedTokenDelta[] = []) => {
    state.simulations.push({ bytes: Uint8Array.from(bytes), expectedDeltas });
    if (state.simulationError) throw state.simulationError;
    return { slot: state.slot, sponsorDebitCeilingLamports: '5000', networkFeeLamports: '5000' };
  });
  t.mock.method(BaseSolanaGateway.prototype, 'broadcast', async (bytes: Uint8Array) => {
    state.broadcasts.push(Uint8Array.from(bytes));
    if (state.broadcastError) throw new Error('Ambiguous broadcast timeout.');
    const transaction = getTransactionDecoder().decode(bytes), message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    return getBase58Decoder().decode(transaction.signatures[message.staticAccounts[0]]!);
  });
  t.mock.method(BaseSolanaGateway.prototype, 'reconcile', async (signature: string) => state.receipt === 'finalized'
    ? { status: 'finalized', signature, slot: state.slot, deltas: [] }
    : state.receipt === 'failed' ? { status: 'failed', reason: 'transaction-error' }
      : { status: 'unknown', reason: 'signature-not-observed-do-not-resubmit-new-intent' });
  const sign = async (transactionBase64: string) => Buffer.from(getTransactionEncoder().encode(await partiallySignTransaction([f.owner.keyPair], getTransactionDecoder().decode(Buffer.from(transactionBase64, 'base64'))))).toString('base64');
  const prepare = (requestId: string) => prepareSolanaHouseAction(store, identity, { operation: 'claim', requestId }, environment);
  const read = () => readSolanaBuildingPosition(store, identity, 'neighbourhood-homes', environment);
  return { ...f, store, environment, identity, state, sign, prepare, read };
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

test('house and owner balances use one snapshot containing the canonical Clock', async () => {
  const f = await fixture(), requests: string[][] = [];
  const gateway: HouseReadGateway = { checkedGenesis: f.gateway.checkedGenesis, multiple: async keys => { requests.push([...keys]); return f.gateway.multiple(keys); } };
  const snapshot = await readSolanaHouseSnapshot(f.manifest, 'neighbourhood-homes', gateway, f.owner.address);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].includes(f.homes.house)); assert.ok(requests[0].includes(f.homes.rewardVault));
  assert.ok(requests[0].includes(f.positionKey)); assert.ok(requests[0].includes(f.snapshot.cashAccount!));
  assert.ok(requests[0].includes('SysvarC1ock11111111111111111111111111111111'));
  assert.equal(snapshot.slot, '50'); assert.equal(snapshot.nowSeconds, 1000n);
});

test('retrying a claim prepare recovers the exact reviewed minimum and bytes despite more streamed income', async t => {
  const rate = 10_000n * 1_000_000_000_000n;
  const f = await lifecycleFixture(t, { house: { totalStaked: 2_000_000n, rewardPerUnitStored: 0n, rewardRate: rate, lastUpdateTime: 1_000_000n, periodFinish: 1_000_600n, streamRemainingScaled: 600n * rate }, position: { staked: 1_000_000n, owed: 0n, rewardDebt: 0n }, nowSeconds: 1_000_010n });
  const first = await f.prepare('same-claim-request'), reads = f.state.reads.length, simulations = f.state.simulations.length;
  const clock = f.accounts.get('SysvarC1ock11111111111111111111111111111111')!;
  new DataView(clock.data.buffer).setBigUint64(0, 51n, true); new DataView(clock.data.buffer).setBigInt64(32, 1_000_020n, true); f.state.slot = '51';
  const second = await f.prepare('same-claim-request');
  assert.deepEqual(second.plan, { ...first.plan, state: 'prepared' }); assert.equal(second.plan.review.claimRaw, '50000');
  assert.equal(f.state.reads.length, reads, 'recovery must not re-quote current streaming accrual');
  assert.equal(f.state.simulations.length, simulations, 'recovery must not replace the reviewed transaction');
  assert.equal((await f.read()).earnedRaw, '100000');
  assert.deepEqual((await f.read()).plan, { ...first.plan, state: 'prepared' });
  await assert.rejects(prepareSolanaHouseAction(f.store, f.identity, { operation: 'reinvest', requestId: 'same-claim-request' }, f.environment), error => error instanceof SolanaServiceError && error.code === 'house_request_conflict');
  await assert.rejects(prepareSolanaHouseAction(f.store, f.identity, { operation: 'claim', requestId: 'same-claim-request', cashAtomic: '1' }, f.environment), /different house action/);
});

test('failed pre-broadcast simulation leaves the same claim review recoverable without a receipt', async t => {
  const f = await lifecycleFixture(t), first = await f.prepare('claim-simulation-failed'), signed = await f.sign(first.plan.transactionBase64);
  f.state.simulationError = new Error('Simulation bank changed; request a fresh review');
  await assert.rejects(submitSolanaHouseAction(f.store, f.identity, first.plan.id, signed, f.environment), /Simulation bank changed/);
  assert.equal(f.state.broadcasts.length, 0);
  const saved = await f.store.get<{ state: string; signature?: string; signedTransactionBase64?: string }>(`solana-operation:${first.plan.id}`);
  assert.equal(saved?.state, 'prepared'); assert.equal(saved?.signature, undefined); assert.equal(saved?.signedTransactionBase64, undefined);
  const position = await f.read();
  assert.deepEqual(position.plan, { ...first.plan, state: 'prepared' }); assert.deepEqual(position.receipts, []); assert.equal(position.earnedRaw, '6000000');
  assert.deepEqual((await f.prepare('claim-simulation-failed')).plan, { ...first.plan, state: 'prepared' });
  await assert.rejects(f.prepare('replacement-before-expiry'), error => error instanceof SolanaServiceError && error.code === 'house_review_pending');
  f.state.simulationError = null;
  const result = await submitSolanaHouseAction(f.store, f.identity, first.plan.id, signed, f.environment);
  assert.equal(result.status, 'pending'); assert.ok(result.signature);
  assert.ok(f.state.broadcasts.every(bytes => Buffer.from(bytes).equals(Buffer.from(f.state.broadcasts[0]))));
  const minimum = f.state.simulations.at(-1)!.expectedDeltas.find(delta => delta.account === f.snapshot.cashAccount)!;
  assert.equal(minimum.minimumAtomic, first.plan.review.claimRaw);
});

test('ambiguous signed claim stays fenced across reload and confirms only its original receipt', async t => {
  const f = await lifecycleFixture(t), first = await f.prepare('ambiguous-claim');
  f.state.broadcastError = true;
  const submitted = await submitSolanaHouseAction(f.store, f.identity, first.plan.id, await f.sign(first.plan.transactionBase64), f.environment);
  assert.equal(submitted.status, 'pending');
  const saved = await f.store.get<{ signedTransactionBase64: string; signature: string }>(`solana-operation:${first.plan.id}`);
  assert.ok(saved?.signedTransactionBase64); assert.equal(saved?.signature, submitted.signature);
  const position = await f.read();
  assert.equal(position.plan, null); assert.equal(position.receipts[0]?.status, 'pending'); assert.equal(position.receipts[0]?.hash, submitted.signature);
  await assert.rejects(f.prepare('another-claim'), error => error instanceof SolanaServiceError && error.code === 'house_review_pending');
  f.state.broadcastError = false;
  const retried = await submitSolanaHouseAction(f.store, f.identity, first.plan.id, await f.sign(first.plan.transactionBase64), f.environment);
  assert.equal(retried.signature, submitted.signature);
  assert.ok(f.state.broadcasts.every(bytes => Buffer.from(bytes).toString('base64') === saved!.signedTransactionBase64));
  f.state.receipt = 'finalized';
  const finalized = await f.read();
  assert.equal(finalized.plan, null); assert.equal(finalized.receipts[0]?.status, 'confirmed'); assert.equal(finalized.receipts[0]?.hash, submitted.signature);
  await assert.rejects(f.prepare('ambiguous-claim'), /already finished or expired/);
});

test('expired unsigned claim stops being a signable plan and a fresh request can claim again', async t => {
  const f = await lifecycleFixture(t), first = await f.prepare('unsigned-expired');
  f.state.now += 120_001;
  const expired = await f.read();
  assert.equal(expired.plan, null); assert.deepEqual(expired.receipts, []); assert.equal(f.state.broadcasts.length, 0);
  assert.equal(expired.activeOperation?.id, first.plan.id); assert.equal(expired.activeOperation?.state, 'expired');
  await assert.rejects(f.prepare('unsigned-expired'), /already finished or expired/);
  const next = await f.prepare('fresh-after-expiry');
  assert.notEqual(next.plan.id, first.plan.id); assert.equal(next.plan.review.claimRaw, first.plan.review.claimRaw);
});

test('unsigned claim expires only after its original confirmed last-valid height without waiting for wall time', async t => {
  const f = await lifecycleFixture(t), first = await f.prepare('block-height-expired');
  f.state.height = 100n; f.state.confirmedHeight = 101n; f.state.lastValidHeight = 200n; f.state.blockhash = f.owner.address;
  const expired = await f.read();
  assert.equal(expired.plan, null); assert.deepEqual(expired.receipts, []); assert.equal(f.state.broadcasts.length, 0);
  assert.equal(expired.activeOperation?.state, 'expired'); assert.equal(expired.activeOperation?.blockHeight, '101'); assert.equal(expired.activeOperation?.blockhashValid, false);
  await assert.rejects(f.prepare('block-height-expired'), /already finished or expired/);
  const next = await f.prepare('fresh-height-review');
  assert.notEqual(next.plan.id, first.plan.id); assert.notEqual(next.plan.transactionBase64, first.plan.transactionBase64);
});

test('failed landed claim preserves its failed receipt and permits a separately reviewed replacement', async t => {
  const f = await lifecycleFixture(t), first = await f.prepare('landed-failed');
  const submitted = await submitSolanaHouseAction(f.store, f.identity, first.plan.id, await f.sign(first.plan.transactionBase64), f.environment);
  f.state.receipt = 'failed';
  const failed = await f.read();
  assert.equal(failed.plan, null); assert.equal(failed.receipts[0]?.status, 'failed'); assert.equal(failed.receipts[0]?.hash, submitted.signature);
  const next = await f.prepare('separate-reviewed-claim');
  assert.notEqual(next.plan.id, first.plan.id); assert.equal(next.plan.review.claimRaw, first.plan.review.claimRaw);
  const original = await f.store.get<{ state: string; signature: string }>(`solana-operation:${first.plan.id}`);
  assert.equal(original?.state, 'failed'); assert.equal(original?.signature, submitted.signature);
});

test('house pre-sign recovery reports actual inclusive blockhash validity without signing or changing the review', async t => {
  const f = await lifecycleFixture(t), first = await f.prepare('pre-sign-check'), simulations = f.state.simulations.length;
  assert.equal(first.plan.lastValidBlockHeight, '100');
  f.state.confirmedHeight = 100n;
  const valid = await reconcileSolanaHouseAction(f.store, f.identity, first.plan.id, f.environment);
  assert.equal(valid.state, 'prepared'); assert.equal(valid.status, 'review'); assert.equal(valid.blockHeight, '100'); assert.equal(valid.blockhashValid, true);
  assert.equal(f.state.simulations.length, simulations); assert.equal(f.state.broadcasts.length, 0);
  f.state.confirmedHeight = 101n;
  const expired = await reconcileSolanaHouseAction(f.store, f.identity, first.plan.id, f.environment);
  assert.equal(expired.state, 'expired'); assert.equal(expired.blockhashValid, false); assert.equal(expired.signature, undefined);
  assert.equal(f.state.simulations.length, simulations); assert.equal(f.state.broadcasts.length, 0);
  const saved = await f.store.get<{ transactionBase64: string; review: unknown }>(`solana-operation:${first.plan.id}`);
  assert.equal(saved?.transactionBase64, first.plan.transactionBase64); assert.deepEqual(saved?.review, first.plan.review);
});
