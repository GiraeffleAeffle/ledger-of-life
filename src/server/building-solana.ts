import { createHash } from 'node:crypto';
import { address, createNoopSigner, getAddressDecoder, type Instruction } from '@solana/kit';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { formatUnits } from 'viem';
import { buyUnitsInstruction, claimInstruction, decodeHouse, decodePosition, houseAddresses, HOUSE_SCALE, pendingOwed, positionAddress, sellUnitsInstruction, stakeInstruction, unstakeInstruction, type HouseAccount, type PositionAccount } from '../finance/solana/house.ts';
import { decodeClassicTokenAccount, type AccountObservation } from '../finance/solana/observations.ts';
import type { ExpectedTokenDelta } from '../finance/solana/reconcile.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { walletFor } from './agreements.ts';
import { createBaseSolanaGateway } from './solana-rpc.ts';
import { configuredSolanaOperations, type PreparedSolanaOperation, type SolanaOperationResult } from './solana-operations.ts';
import { loadSolanaHouseManifest, type SolanaHouseManifest } from './solana-house-config.ts';
import { SolanaServiceError } from './solana-service.ts';
import type { Store } from './store.ts';
import type { LocalInvestmentView } from './local-investments.ts';

export type SolanaHouseId = 'neighbourhood-homes' | 'workshop';
export type SolanaHouseAction = 'buy' | 'sell' | 'stake' | 'unstake' | 'claim' | 'reinvest';
export type HouseReadGateway = { checkedGenesis(): Promise<string>; multiple(keys: readonly string[]): Promise<{ slot: string; accounts: (AccountObservation | null)[] }> };
export type SolanaHouseSnapshot = { house: HouseAccount; position: PositionAccount | null; walletUnits: bigint; cash: bigint; deskCash: bigint; rewardCash: bigint; unitSupply: bigint; cashAccount: string | null; unitAccount: string | null; slot: string; nowSeconds: bigint };
export type HouseActionQuote = { operation: SolanaHouseAction; units: bigint; cash: bigint; claim: bigint };
export type SolanaHouseReview = { operation: SolanaHouseAction; houseId: SolanaHouseId; distributor: string; account: string; network: string; amount: string; asset: string; unitsRaw: string; cashRaw: string; claimRaw: string; description: string; cashAccount: string; unitAccount: string; deskVault: string; rewardVault: string; stakeVault: string };
export type SolanaHousePlan = PreparedSolanaOperation & { review: SolanaHouseReview };
type HouseJournal = { active: string | null; entries: { id: string; houseId: SolanaHouseId; operation: SolanaHouseAction; quantityRaw: string | null; review: SolanaHouseReview; request?: { id: string; quantity?: string; cashAtomic?: string } }[] };
const maxU64 = (1n << 64n) - 1n;
const clockAddress = 'SysvarC1ock11111111111111111111111111111111';
const sources = [
  { id: 'rent', name: 'Rent shares', meaning: 'The house share of Solana rent payments.' },
  { id: 'ai', name: 'AI answers', meaning: 'Paid AI answers assigned to this house.' },
  { id: 'solar', name: 'Solar', meaning: 'Explicitly assigned simulated solar income, not a real electricity sale.' },
  { id: 'other', name: 'Other', meaning: 'Other on-chain deposits into the house reward vault.' },
];
export function solanaHouseId(value: unknown): SolanaHouseId {
  if (value === undefined || value === null || value === 'neighbourhood-homes' || value === 'demo-neighbourhood-homes') return 'neighbourhood-homes';
  if (value === 'workshop' || value === 'demo-retrofit-workshop') return 'workshop';
  throw new Error('Unknown Solana house.');
}
function readGateway(manifest: SolanaHouseManifest, environment: Record<string, string | undefined>) {
  if (!environment.SOLANA_RPC_URL) throw new Error('Solana house RPC is not configured.');
  const url = new URL(environment.SOLANA_RPC_URL);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('RPC must use HTTPS or loopback.');
  return createBaseSolanaGateway({ rpcUrl: url.toString(), genesisHash: manifest.genesisHash, maximumSponsorLamports: '10000000' });
}
function tokenBalance(row: AccountObservation | null, mint: string, owner: string, missingAllowed = false): bigint {
  if (!row) { if (missingAllowed) return 0n; throw new Error('House token account is missing.'); }
  const token = decodeClassicTokenAccount(row);
  if (token.mint !== mint || token.authority !== owner || !token.initialized || token.frozen) throw new Error('House token owner or mint mismatch.');
  return BigInt(token.amountAtomic);
}

/** One finalized bank for the house, vaults and user's balances. Missing ATAs are genuinely zero. */
export async function readSolanaHouseSnapshot(manifest: SolanaHouseManifest, id: SolanaHouseId, gateway: HouseReadGateway, owner?: string): Promise<SolanaHouseSnapshot> {
  if (await gateway.checkedGenesis() !== manifest.genesisHash) throw new Error('House RPC genesis mismatch.');
  const configured = manifest.houses[id], derived = await houseAddresses(id, manifest.programId);
  for (const field of ['house', 'unitMint', 'deskVault', 'rewardVault', 'stakeVault'] as const) if (configured[field] !== derived[field]) throw new Error('House deployment PDA mismatch.');
  const cashAccount = owner ? (await findAssociatedTokenPda({ owner: address(owner), mint: address(manifest.cashMint), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0] : null;
  const unitAccount = owner ? (await findAssociatedTokenPda({ owner: address(owner), mint: address(configured.unitMint), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0] : null;
  const positionKey = owner ? await positionAddress(configured.house, owner, manifest.programId) : null;
  const keys = [manifest.programId, configured.house, configured.unitMint, manifest.cashMint, configured.deskVault, configured.rewardVault, configured.stakeVault, ...(owner ? [positionKey!, cashAccount!, unitAccount!] : []), clockAddress];
  const observed = await gateway.multiple(keys), rows = observed.accounts;
  if (rows.length !== keys.length || !rows[0]?.executable || !rows[1] || rows[1].executable || rows[1].owner !== manifest.programId) throw new Error('Solana house program or account is unavailable.');
  const clock = rows.at(-1);
  if (!clock || clock.owner !== 'Sysvar1111111111111111111111111111111111111' || clock.executable || clock.data.length !== 40) throw new Error('Finalized house clock is unavailable.');
  const clockView = new DataView(clock.data.buffer, clock.data.byteOffset, clock.data.byteLength);
  const nowSeconds = clockView.getBigInt64(32, true);
  if (nowSeconds < 0n || nowSeconds > BigInt(Number.MAX_SAFE_INTEGER) || clockView.getBigUint64(0, true).toString() !== observed.slot) throw new Error('House clock does not match its finalized bank.');
  const house = decodeHouse(rows[1].data);
  if (house.id !== id || house.cashMint !== manifest.cashMint || house.unitMint !== configured.unitMint || house.priceCashPerUnit <= 0n || house.revenueBySource.reduce((total, amount) => total + amount, 0n) !== house.revenueTotal) throw new Error('House account differs from its reviewed deployment.');
  if (house.rewardDuration !== 604_800n) throw new Error('House rewards require the reviewed seven-day stream.');
  for (const [row, unit] of [[rows[2], true], [rows[3], false]] as const) {
    if (!row || row.owner !== TOKEN_PROGRAM_ADDRESS || row.executable || row.data.length !== 82 || row.data[44] !== 6 || row.data[45] !== 1) throw new Error('House requires initialized classic six-decimal token mints.');
    if (unit && (new DataView(row.data.buffer, row.data.byteOffset).getUint32(0, true) !== 1 || getAddressDecoder().decode(row.data.subarray(4, 36)) !== configured.house)) throw new Error('House unit mint authority mismatch.');
  }
  const deskCash = tokenBalance(rows[4], manifest.cashMint, configured.house), rewardCash = tokenBalance(rows[5], manifest.cashMint, configured.house);
  if (tokenBalance(rows[6], configured.unitMint, configured.house) < house.totalStaked) throw new Error('House stake vault is below accounted units.');
  let position: PositionAccount | null = null;
  if (owner && rows[7]) {
    if (rows[7].owner !== manifest.programId || rows[7].executable) throw new Error('House position program owner mismatch.');
    position = decodePosition(rows[7].data);
    if (position.house !== configured.house || position.owner !== owner || position.staked > house.totalStaked) throw new Error('House position identity mismatch.');
    if (pendingOwed(house, position, nowSeconds) > rewardCash) throw new Error('House reward vault is below the claimable balance.');
  }
  return { house, position, walletUnits: owner ? tokenBalance(rows[9], configured.unitMint, owner, true) : 0n, cash: owner ? tokenBalance(rows[8], manifest.cashMint, owner, true) : 0n, deskCash, rewardCash, unitSupply: new DataView(rows[2]!.data.buffer, rows[2]!.data.byteOffset).getBigUint64(36, true), cashAccount, unitAccount, slot: observed.slot, nowSeconds };
}

export function solanaHouseReadModel(manifest: SolanaHouseManifest, id: SolanaHouseId, snapshot: SolanaHouseSnapshot) {
  const house = snapshot.house;
  return {
    configured: true, status: 'configured', reason: null, network: `solana-${manifest.cluster}`, chainId: `solana-${manifest.cluster}`,
    unitDecimals: 6, cashSymbol: 'tUSDC', houseId: id, distributor: manifest.houses[id].house, explorerUrl: 'https://explorer.solana.com',
    shareToken: house.unitMint, assetToken: house.cashMint, priceAtomic: house.priceCashPerUnit.toString(), sellCapUnitsRaw: house.sellCapUnits.toString(), deskCashAtomic: snapshot.deskCash.toString(),
    revenueRaw: house.revenueTotal.toString(), revenue: formatUnits(house.revenueTotal, 6),
    totalStakedRaw: house.totalStaked.toString(), totalStaked: formatUnits(house.totalStaked, 6), stakerCount: house.stakerCount,
    rewardPerUnitRaw: house.rewardPerUnitStored.toString(), rewardScaleRaw: HOUSE_SCALE.toString(),
    pendingRevenueRaw: (house.undistributedScaled / HOUSE_SCALE).toString(), undistributedScaledRaw: house.undistributedScaled.toString(),
    rewardRateRaw: house.rewardRate.toString(), rewardDuration: Number(house.rewardDuration), periodFinish: Number(house.periodFinish), lastUpdateTime: Number(house.lastUpdateTime),
    streamRemainingScaledRaw: house.streamRemainingScaled.toString(), rewardRemainderScaledRaw: house.rewardRemainderScaled.toString(),
    incomeSources: sources.map((source, index) => ({ ...source, amountRaw: house.revenueBySource[index].toString() })),
    revenueTransactions: [], payingDevices: [], paidAnswers: 0, gpuTokensServed: 0, validator: null, heat: null,
    observedSlot: snapshot.slot, observedChainTimestampRaw: snapshot.nowSeconds.toString(),
  };
}
export async function readSolanaBuilding(id: SolanaHouseId = 'neighbourhood-homes', environment: Record<string, string | undefined> = process.env) {
  const manifest = loadSolanaHouseManifest(environment); if (!manifest) throw new Error('Solana house is not configured.');
  return solanaHouseReadModel(manifest, id, await readSolanaHouseSnapshot(manifest, id, readGateway(manifest, environment)));
}

/** All displayed actions derive from verified atomic balances; no browser quote authorizes money. */
export function houseActionQuote(operation: unknown, input: { quantity?: unknown; cashAtomic?: unknown }, snapshot: SolanaHouseSnapshot): HouseActionQuote {
  if (!['buy', 'sell', 'stake', 'unstake', 'claim', 'reinvest'].includes(String(operation))) throw new Error('Unknown Solana house action.');
  const kind = operation as SolanaHouseAction, claim = snapshot.position ? pendingOwed(snapshot.house, snapshot.position, snapshot.nowSeconds) : 0n;
  const positive = (value: unknown) => { if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > maxU64) throw new Error('Choose a positive atomic amount.'); return BigInt(value); };
  let units = 0n, cash = 0n;
  if (kind === 'claim' || kind === 'reinvest') {
    if (input.quantity !== undefined || input.cashAtomic !== undefined) throw new Error('Claim and reinvest claim your own full accrued rewards, without an amount or recipient.');
    if (claim <= 0n) throw new Error('No claimable test USDC.');
    if (kind === 'reinvest') { if (claim > 100_000_000n) throw new Error('One reinvest is capped at 100 tUSDC.'); units = claim * 1_000_000n / snapshot.house.priceCashPerUnit; }
  } else if (kind === 'buy') {
    if (input.quantity !== undefined) throw new Error('Buy accepts only a test USDC budget.');
    const budget = positive(input.cashAtomic);
    if (budget < 1000n || budget > 100_000_000n) throw new Error('Buy between 0.001 and 100 tUSDC.');
    units = budget * 1_000_000n / snapshot.house.priceCashPerUnit;
  } else {
    if (input.cashAtomic !== undefined) throw new Error('This action accepts only an atomic unit amount.');
    units = positive(input.quantity);
  }
  if (kind !== 'claim' && units <= 0n) throw new Error('This amount buys no whole atomic unit.');
  if (kind === 'buy' || kind === 'reinvest') cash = (units * snapshot.house.priceCashPerUnit + 999_999n) / 1_000_000n;
  if (kind === 'sell') cash = units * snapshot.house.priceCashPerUnit / 1_000_000n;
  if (kind === 'buy' && cash > snapshot.cash) throw new Error('You need more test USDC for this purchase.');
  if (kind === 'sell' && (units > snapshot.house.sellCapUnits || units > 100_000_000n)) throw new Error('Sell-back exceeds the house per-transaction unit cap.');
  if ((kind === 'sell' || kind === 'stake') && units > snapshot.walletUnits) throw new Error('Not enough wallet units; unstake before selling.');
  if (kind === 'unstake' && units > (snapshot.position?.staked ?? 0n)) throw new Error('Not enough of your own staked units.');
  if (kind === 'sell' && (cash <= 0n || cash > snapshot.deskCash)) throw new Error('The house desk has insufficient test cash for this sell-back.');
  return { operation: kind, units, cash, claim: kind === 'claim' || kind === 'reinvest' ? claim : 0n };
}

export async function buildSolanaHouseAction(manifest: SolanaHouseManifest, id: SolanaHouseId, owner: string, payer: string, quote: HouseActionQuote, snapshot: SolanaHouseSnapshot): Promise<{ instructions: Instruction[]; expectedDeltas: ExpectedTokenDelta[]; review: SolanaHouseReview }> {
  if (!snapshot.cashAccount || !snapshot.unitAccount) throw new Error('A reviewed house wallet is required.');
  const configured = manifest.houses[id], base = { house: configured.house, programId: manifest.programId }, cashAccount = snapshot.cashAccount, unitAccount = snapshot.unitAccount, symbol = id === 'workshop' ? 'tWORK' : 'tHOME';
  const instructions: Instruction[] = [];
  const ensureAta = (mint: string, ata: string) => getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(address(payer)), owner: address(owner), mint: address(mint), ata: address(ata), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  if (['sell', 'claim', 'reinvest'].includes(quote.operation)) instructions.push(ensureAta(manifest.cashMint, cashAccount));
  if (['buy', 'unstake', 'reinvest'].includes(quote.operation)) instructions.push(ensureAta(configured.unitMint, unitAccount));
  if (quote.operation === 'claim' || quote.operation === 'reinvest') instructions.push(await claimInstruction({ ...base, owner, cashAccount }));
  if (quote.operation === 'buy' || quote.operation === 'reinvest') instructions.push(await buyUnitsInstruction({ ...base, buyer: owner, cashAccount, unitAccount, units: quote.units }));
  if (quote.operation === 'sell') instructions.push(await sellUnitsInstruction({ ...base, seller: owner, cashAccount, unitAccount, units: quote.units }));
  if (quote.operation === 'stake' || quote.operation === 'reinvest') instructions.push(await stakeInstruction({ ...base, owner, payer, unitAccount, units: quote.units }));
  if (quote.operation === 'unstake') instructions.push(await unstakeInstruction({ ...base, owner, unitAccount, units: quote.units }));
  const expectedDeltas: ExpectedTokenDelta[] = [];
  const delta = (account: string, mint: string, authority: string, direction: ExpectedTokenDelta['direction'], minimum: bigint, maximum = minimum, allowCreated = false) => expectedDeltas.push({ account, mint, owner: authority, direction, minimumAtomic: minimum.toString(), maximumAtomic: maximum.toString(), ...(allowCreated ? { allowCreated: true } : {}) });
  if (quote.operation === 'buy') { delta(cashAccount, manifest.cashMint, owner, 'debit', quote.cash); delta(configured.deskVault, manifest.cashMint, configured.house, 'credit', quote.cash); delta(unitAccount, configured.unitMint, owner, 'credit', quote.units, quote.units, true); }
  if (quote.operation === 'sell') { delta(unitAccount, configured.unitMint, owner, 'debit', quote.units); delta(configured.deskVault, manifest.cashMint, configured.house, 'debit', quote.cash); delta(cashAccount, manifest.cashMint, owner, 'credit', quote.cash, quote.cash, true); }
  if (quote.operation === 'stake' || quote.operation === 'unstake') { delta(unitAccount, configured.unitMint, owner, quote.operation === 'stake' ? 'debit' : 'credit', quote.units, quote.units, quote.operation === 'unstake'); delta(configured.stakeVault, configured.unitMint, configured.house, quote.operation === 'stake' ? 'credit' : 'debit', quote.units); }
  if (quote.operation === 'claim' || quote.operation === 'reinvest') {
    delta(configured.rewardVault, manifest.cashMint, configured.house, 'debit', quote.claim, maxU64);
    delta(cashAccount, manifest.cashMint, owner, 'credit', quote.claim - quote.cash, maxU64 - quote.cash, true);
    if (quote.operation === 'reinvest') { delta(configured.deskVault, manifest.cashMint, configured.house, 'credit', quote.cash); delta(unitAccount, configured.unitMint, owner, 'unchanged', 0n, 0n, true); delta(configured.stakeVault, configured.unitMint, configured.house, 'credit', quote.units); }
  }
  const description = quote.operation === 'reinvest' ? `In one transaction and one wallet signature: claim all accrued tUSDC (at least $${formatUnits(quote.claim, 6)} in test dollars; earnings keep streaming until the transaction lands), buy exactly ${formatUnits(quote.units, 6)} ${symbol} for exactly ${formatUnits(quote.cash, 6)} tUSDC from the house desk, then stake those exact units. Any leftover or extra accrual stays in your own cash account.` : quote.operation === 'claim' ? `Claim all your accrued tUSDC to your own cash account: at least $${formatUnits(quote.claim, 6)} in test dollars (earnings keep streaming until the transaction lands).` : quote.operation === 'buy' ? `Pay exactly ${formatUnits(quote.cash, 6)} tUSDC to the house desk and receive ${formatUnits(quote.units, 6)} ${symbol} in your wallet.` : quote.operation === 'sell' ? `Burn exactly ${formatUnits(quote.units, 6)} wallet ${symbol}; receive ${formatUnits(quote.cash, 6)} tUSDC from the house desk.` : `${quote.operation === 'stake' ? 'Stake' : 'Unstake'} exactly ${formatUnits(quote.units, 6)} ${symbol} ${quote.operation === 'stake' ? 'from your wallet into the house stake vault' : 'from the house stake vault into your own wallet'}.`;
  return { instructions, expectedDeltas, review: { operation: quote.operation, houseId: id, distributor: configured.house, account: owner, network: `Solana ${manifest.cluster}`, amount: quote.operation === 'claim' ? `at least $${formatUnits(quote.claim, 6)}` : formatUnits(quote.units, 6), asset: quote.operation === 'claim' ? 'tUSDC' : symbol, unitsRaw: quote.units.toString(), cashRaw: quote.cash.toString(), claimRaw: quote.claim.toString(), cashAccount, unitAccount, deskVault: configured.deskVault, rewardVault: configured.rewardVault, stakeVault: configured.stakeVault, description: `${description} Income is streamed to stakers over 7 days; new revenue extends the remaining stream. Sponsored network fees and account rent. Test networks only, no value; fictional units carry no rights. Deposit earnings belong to the tenant.` } };
}

function journalKey(identity: VerifiedIdentity) { return `building-solana:wallet:${createHash('sha256').update(identity.subject).digest('hex')}`; }
async function journal(store: Store, identity: VerifiedIdentity): Promise<HouseJournal> {
  const key = journalKey(identity), existing = await store.get<HouseJournal>(key); if (existing) return existing;
  try { await store.create<HouseJournal>(key, { active: null, entries: [] }); } catch (error) { if (!await store.get(key)) throw error; }
  return (await store.get<HouseJournal>(key))!;
}
async function actionContext(store: Store, environment: Record<string, string | undefined>) {
  const manifest = loadSolanaHouseManifest(environment); if (!manifest) throw new Error('Solana house is not configured.');
  return { manifest, ...await configuredSolanaOperations(store, { cluster: manifest.cluster, genesisHash: manifest.genesisHash, maximumSponsorLamports: 10_000_000n }, environment) };
}

/** A wallet signature is not permission to submit another feature's reviewed operation here. */
export function assertSolanaHouseOperation(operation: Pick<PreparedSolanaOperation, 'id' | 'kind'>, entry: { id: string; houseId: SolanaHouseId; operation: SolanaHouseAction } | undefined) {
  if (!entry || operation.id !== entry.id || operation.kind !== `house:${entry.houseId}:${entry.operation}`)
    throw new Error('This operation is not bound to the reviewed house action.');
}
export async function prepareSolanaHouseAction(store: Store, identity: VerifiedIdentity, input: { houseId?: unknown; operation?: unknown; quantity?: unknown; cashAtomic?: unknown; requestId?: unknown }, environment: Record<string, string | undefined> = process.env): Promise<{ plan: SolanaHousePlan }> {
  const context = await actionContext(store, environment), id = solanaHouseId(input.houseId), wallet = walletFor(identity, 'solana'), lane = await journal(store, identity);
  if (typeof input.requestId !== 'string') throw new Error('A durable request ID is required.');
  const request = { id: input.requestId, ...(typeof input.quantity === 'string' ? { quantity: input.quantity } : {}), ...(typeof input.cashAtomic === 'string' ? { cashAtomic: input.cashAtomic } : {}) };
  const existing = lane.entries.find(entry => entry.request?.id === input.requestId);
  if (existing) {
    if (existing.houseId !== id || existing.operation !== input.operation || existing.request?.quantity !== input.quantity || existing.request?.cashAtomic !== input.cashAtomic)
      throw new SolanaServiceError(409, 'house_request_conflict', 'This request ID already reviews a different house action.');
    const prepared = await context.operations.get(existing.id, identity);
    assertSolanaHouseOperation(prepared, existing);
    const previous = await context.operations.reconcile({ identity, id: existing.id });
    if (previous.state !== 'prepared' || lane.active !== existing.id)
      throw new SolanaServiceError(409, 'house_review_finished', 'This house request already finished or expired; recover its receipt or prepare a fresh request ID.');
    // Streaming accrual must not replace the minimum or bytes that were already reviewed.
    return { plan: { ...prepared, review: existing.review } };
  }
  if (lane.active) {
    assertSolanaHouseOperation(await context.operations.get(lane.active, identity), lane.entries.find(entry => entry.id === lane.active));
    const previous = await context.operations.reconcile({ identity, id: lane.active });
    if (previous.state === 'broadcast' || previous.state === 'prepared') throw new SolanaServiceError(409, 'house_review_pending', 'Finish or cancel the current house review before another action.');
  }
  const snapshot = await readSolanaHouseSnapshot(context.manifest, id, context.gateway, wallet.address), quote = houseActionQuote(input.operation, input, snapshot);
  const built = await buildSolanaHouseAction(context.manifest, id, wallet.address, context.sponsor.address, quote, snapshot);
  const prepared = await context.operations.prepare({ identity, kind: `house:${id}:${quote.operation}`, requestId: input.requestId, actor: address(wallet.address), walletId: wallet.id, instructions: built.instructions, review: built.review, expectedDeltas: built.expectedDeltas });
  await store.update<HouseJournal>(journalKey(identity), current => {
    if (current.active !== lane.active && current.active !== prepared.id) throw new Error('Another house action was prepared.');
    return { active: prepared.id, entries: current.entries.some(entry => entry.id === prepared.id) ? current.entries : [...current.entries, { id: prepared.id, houseId: id, operation: quote.operation, quantityRaw: quote.operation === 'claim' ? null : quote.units.toString(), review: built.review, request }] };
  });
  return { plan: { ...prepared, review: built.review } };
}
export async function submitSolanaHouseAction(store: Store, identity: VerifiedIdentity, id: string, signedTransactionBase64: string, environment: Record<string, string | undefined> = process.env) {
  const { operations } = await actionContext(store, environment), lane = await journal(store, identity);
  if (lane.active !== id) throw new Error('Only the active reviewed house transaction may be submitted.');
  assertSolanaHouseOperation(await operations.get(id, identity), lane.entries.find(entry => entry.id === id));
  const result = await operations.submit({ identity, id, signedTransactionBase64 });
  return { ...result, hash: result.signature, status: result.state === 'confirmed' ? 'confirmed' as const : result.state === 'failed' || result.state === 'expired' ? 'failed' as const : 'pending' as const, explorerUrl: `https://explorer.solana.com/tx/${result.signature}?cluster=devnet` };
}
export async function cancelSolanaHouseReview(store: Store, identity: VerifiedIdentity, id: string, environment: Record<string, string | undefined> = process.env) {
  const { operations } = await actionContext(store, environment), lane = await journal(store, identity);
  assertSolanaHouseOperation(await operations.get(id, identity), lane.entries.find(entry => entry.id === id));
  await operations.cancel({ identity, id });
  await store.update<HouseJournal>(journalKey(identity), current => current.active === id ? { ...current, active: null } : current);
  return { cancelled: true };
}
export async function readSolanaBuildingPosition(store: Store, identity: VerifiedIdentity, id: SolanaHouseId = 'neighbourhood-homes', environment: Record<string, string | undefined> = process.env) {
  const manifest = loadSolanaHouseManifest(environment); if (!manifest) throw new Error('Solana house is not configured.');
  const wallet = walletFor(identity, 'solana'), snapshot = await readSolanaHouseSnapshot(manifest, id, readGateway(manifest, environment), wallet.address), lane = await journal(store, identity);
  const receipts: { planId: string; operation: string; quantityRaw: string | null; claimedRaw: string | null; hash: string; status: 'pending' | 'confirmed' | 'failed'; explorerUrl: string }[] = [];
  let plan: SolanaHousePlan | null = null;
  let activeOperation: (SolanaOperationResult & { operation: SolanaHouseAction }) | null = null;
  if (lane.entries.length) {
    const { operations } = await actionContext(store, environment);
    for (const entry of lane.entries.filter(entry => entry.houseId === id)) {
      const prepared = await operations.get(entry.id, identity);
      assertSolanaHouseOperation(prepared, entry);
      const result = await operations.reconcile({ identity, id: entry.id });
      if (entry.id === lane.active) activeOperation = { ...result, operation: entry.operation };
      if (entry.id === lane.active && result.state === 'prepared') plan = { ...prepared, review: entry.review };
      if (result.signature) receipts.push({ planId: entry.id, operation: entry.operation, quantityRaw: entry.quantityRaw, claimedRaw: null, hash: result.signature, status: result.state === 'confirmed' ? 'confirmed' : result.state === 'failed' || result.state === 'expired' ? 'failed' : 'pending', explorerUrl: `https://explorer.solana.com/tx/${result.signature}?cluster=devnet` });
    }
  }
  const earned = snapshot.position ? pendingOwed(snapshot.house, snapshot.position, snapshot.nowSeconds) : 0n;
  return { configured: true, network: `solana-${manifest.cluster}`, unitDecimals: 6, houseId: id, account: wallet.address, distributor: manifest.houses[id].house, walletUnitsRaw: snapshot.walletUnits.toString(), walletUnits: formatUnits(snapshot.walletUnits, 6), stakedRaw: (snapshot.position?.staked ?? 0n).toString(), staked: formatUnits(snapshot.position?.staked ?? 0n, 6), earnedRaw: earned.toString(), earned: formatUnits(earned, 6), cashAtomic: snapshot.cash.toString(), allowanceRaw: '0', pendingRevenueRaw: (snapshot.house.undistributedScaled / HOUSE_SCALE).toString(), receipts, plan, activeOperation, observedAt: Number(snapshot.nowSeconds), observedSlot: snapshot.slot, observedChainTimestampRaw: snapshot.nowSeconds.toString() };
}
export async function readSolanaLocalInvestments(identity: VerifiedIdentity, environment: Record<string, string | undefined> = process.env): Promise<LocalInvestmentView> {
  const manifest = loadSolanaHouseManifest(environment); if (!manifest) throw new Error('Solana house is not configured.');
  const wallet = walletFor(identity, 'solana'), gateway = readGateway(manifest, environment);
  const snapshots = await Promise.all((['neighbourhood-homes', 'workshop'] as const).map(id => readSolanaHouseSnapshot(manifest, id, gateway, wallet.address)));
  return { state: 'ready', network: { chainId: 'solana-devnet', name: 'Solana devnet', explorerUrl: 'https://explorer.solana.com' }, owner: wallet.address, cashAddress: manifest.cashMint, cashAtomic: snapshots[0].cash.toString(), nativeAtomic: null, assets: snapshots.map((snapshot, index) => ({ projectId: index === 0 ? 'demo-neighbourhood-homes' : 'demo-retrofit-workshop', unitAddress: snapshot.house.unitMint, marketAddress: manifest.houses[index === 0 ? 'neighbourhood-homes' : 'workshop'].house, unitDecimals: 6, priceAtomic: snapshot.house.priceCashPerUnit.toString(), holdingRaw: snapshot.walletUnits.toString(), stakedRaw: (snapshot.position?.staked ?? 0n).toString(), totalSupplyRaw: snapshot.unitSupply.toString(), availableUnitsRaw: null, error: null })), order: null, error: null };
}

export async function reconcileSolanaHouseAction(store: Store, identity: VerifiedIdentity, id: string, environment: Record<string, string | undefined> = process.env) {
  const { operations } = await actionContext(store, environment), lane = await journal(store, identity);
  assertSolanaHouseOperation(await operations.get(id, identity), lane.entries.find(entry => entry.id === id));
  const result = await operations.reconcile({ identity, id });
  return { ...result, hash: result.signature ?? null, status: result.state === 'confirmed' ? 'confirmed' : result.state === 'failed' || result.state === 'expired' ? 'failed' : result.state === 'prepared' ? 'review' : 'pending' };
}
