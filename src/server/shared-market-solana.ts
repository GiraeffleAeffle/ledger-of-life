import { createHash, randomUUID } from 'node:crypto';
import { address, createNoopSigner, getAddressDecoder, type Instruction } from '@solana/kit';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token-2022';
import { formatUnits } from 'viem';
import { SOLANA_IDS } from '../finance/solana/manifest.ts';
import { decodeClassicTokenAccount, type AccountObservation } from '../finance/solana/observations.ts';
import type { ExpectedTokenDelta } from '../finance/solana/reconcile.ts';
import { buildLendingInstruction, decodePrice, decodePool, decodeLoanPosition, decodeFaucetBudget, decodeFaucetCooldown, faucetInstruction, faucetBudgetRemaining, faucetAvailableAt, faucetCooldownAddress, loanPositionAddress, isPriceFresh, priceMaxAge, quoteBorrowPosition, previewRepay, previewLiquidation, maxWithdraw, shareValue, quoteLendingMarket, verifySharesInitialization, SHARES_PRICE_AUTHORITY, FAUCET_AMOUNT, type SharesPool, type SharesPrice, type LoanPosition, type FaucetBudget, type FaucetCooldown, type LendingAction } from '../finance/solana/shares.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import { walletFor } from './agreements.ts';
import { createBaseSolanaGateway, type BaseSolanaGateway } from './solana-rpc.ts';
import { configuredSolanaOperations, type SolanaOperations, type PreparedSolanaOperation, type SolanaOperationResult } from './solana-operations.ts';
import { solanaSharesConfiguration, type SolanaSharesManifest } from './solana-shares-config.ts';
import { ensureSolanaSharesPrice, type SolanaPriceMirrorOptions } from './solana-price-mirror.ts';
import type { Store } from './store.ts';

export type SolanaMarketGateway = Pick<BaseSolanaGateway, 'checkedGenesis' | 'multiple' | 'rpc'>;
export type SolanaMarketOptions = { manifest?: SolanaSharesManifest | null; environment?: Record<string, string | undefined>; gateway?: SolanaMarketGateway; operations?: SolanaOperations; sponsorAddress?: string; now?: () => number; mirror?: SolanaPriceMirrorOptions };
export type SolanaMarketSnapshot = { pool: SharesPool; price: SharesPrice; budget: FaucetBudget; position: LoanPosition | null; cooldown: FaucetCooldown | null; walletCash: bigint; walletShares: bigint; cashVaultBalance: bigint; collateralVaultBalance: bigint; cashAccount: string; shareAccount: string; positionAddress: string; nowSeconds: bigint; slot: string; extraRows: (AccountObservation | null)[] };
export type SolanaMarketAction = 'lend' | 'unlend' | 'borrow' | 'repay' | 'deposit_collateral' | 'withdraw_collateral' | 'liquidate';
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
const MAX_U64 = (1n << 64n) - 1n;
const DAY = 86_400_000;
const DISCLAIMER = 'Solana devnet only. Test tUSDC and fictional tTSLA have no value and confer no stock, property or rental rights. Borrower-funded interest and lender losses are real test-chain accounting, not investment income. Deposit earnings belong to the tenant.';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const ownerKey = (identity: VerifiedIdentity) => sha(identity.subject);
function tokenBalance(row: AccountObservation | null, mint: string, owner: string, missingAllowed = false) {
  if (!row) { if (missingAllowed) return 0n; throw new Error('A required pool token account is missing.'); }
  const token = decodeClassicTokenAccount(row);
  if (token.mint !== mint || token.authority !== owner || !token.initialized || token.frozen) throw new Error('Pool token account mint, owner or state does not match.');
  return BigInt(token.amountAtomic);
}
function programState(row: AccountObservation | null, manifest: SolanaSharesManifest) {
  if (!row || row.owner !== manifest.programId || row.executable) throw new Error('A shares program account is unavailable or has the wrong owner.');
  return row.data;
}
async function manifestFor(options: SolanaMarketOptions) {
  const manifest = options.manifest === undefined ? await solanaSharesConfiguration(options.environment ?? process.env) : options.manifest;
  if (!manifest) throw new Error('Solana shares are not configured.');
  return manifest;
}
function readGateway(manifest: SolanaSharesManifest, environment: Record<string, string | undefined>) {
  if (!environment.SOLANA_RPC_URL) throw new Error('Solana shares RPC is not configured.');
  const url = new URL(environment.SOLANA_RPC_URL);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('RPC must use HTTPS or loopback.');
  return createBaseSolanaGateway({ rpcUrl: url.toString(), genesisHash: manifest.genesisHash, maximumSponsorLamports: '10000000' });
}
async function contextFor(store: Store, options: SolanaMarketOptions, signing = false) {
  const manifest = await manifestFor(options), environment = options.environment ?? process.env;
  const gateway = options.gateway ?? readGateway(manifest, environment);
  let operations = options.operations;
  let sponsorAddress = options.sponsorAddress ?? SHARES_PRICE_AUTHORITY;
  if (signing && !operations) { const configured = await configuredSolanaOperations(store, { cluster: 'devnet', genesisHash: manifest.genesisHash, maximumSponsorLamports: 10_000_000n }, environment); operations = configured.operations; sponsorAddress = configured.sponsor.address; }
  if (signing && sponsorAddress !== SHARES_PRICE_AUTHORITY) throw new Error('The hosted issuer must sponsor Solana shares operations.');
  return { manifest, gateway, operations, sponsorAddress };
}
/** All balances, debt and price are read from one finalized bank, including its own clock. */
export async function readSolanaMarketSnapshot(manifest: SolanaSharesManifest, owner: string, gateway: SolanaMarketGateway, extraKeys: string[] = []): Promise<SolanaMarketSnapshot> {
  if (await gateway.checkedGenesis() !== manifest.genesisHash) throw new Error('Shares RPC genesis mismatch.');
  const [cashAccount] = await findAssociatedTokenPda({ owner: address(owner), mint: address(manifest.cashMint), tokenProgram: address(SOLANA_IDS.token) });
  const [shareAccount] = await findAssociatedTokenPda({ owner: address(owner), mint: address(manifest.shareMint), tokenProgram: address(SOLANA_IDS.token) });
  const positionAddress = await loanPositionAddress(manifest.pool, owner), cooldownAddress = await faucetCooldownAddress(manifest.shareMint, owner);
  const keys = [manifest.programId, manifest.pool, manifest.price, manifest.faucetBudget, manifest.cashMint, manifest.shareMint, manifest.cashVault, manifest.collateralVault, cashAccount, shareAccount, positionAddress, cooldownAddress, ...extraKeys, CLOCK];
  const { accounts: rows, slot } = await gateway.multiple(keys);
  if (rows.length !== keys.length || !rows[0]?.executable || rows[0].owner !== 'BPFLoaderUpgradeab1e11111111111111111111111') throw new Error('Solana shares program is not deployed under the expected loader.');
  const clock = rows.at(-1);
  if (!clock || clock.owner !== 'Sysvar1111111111111111111111111111111111111' || clock.executable || clock.data.length !== 40) throw new Error('Finalized shares clock is unavailable.');
  const clockView = new DataView(clock.data.buffer, clock.data.byteOffset, clock.data.byteLength), nowSeconds = clockView.getBigInt64(32, true);
  if (nowSeconds <= 0n || nowSeconds > BigInt(Number.MAX_SAFE_INTEGER) || clockView.getBigUint64(0, true).toString() !== slot) throw new Error('Shares clock does not match its finalized bank.');
  const pool = decodePool(programState(rows[1], manifest)), price = decodePrice(programState(rows[2], manifest)), budget = decodeFaucetBudget(programState(rows[3], manifest));
  verifySharesInitialization(manifest, price, pool, budget);
  for (const [row, share] of [[rows[4], false], [rows[5], true]] as const) {
    if (!row || row.owner !== SOLANA_IDS.token || row.executable || row.data.length !== 82 || row.data[44] !== 6 || row.data[45] !== 1) throw new Error('Shares pool requires initialized classic six-decimal mints.');
    if (share && (new DataView(row.data.buffer, row.data.byteOffset).getUint32(0, true) !== 1 || getAddressDecoder().decode(row.data.subarray(4, 36)) !== manifest.shareMint || new DataView(row.data.buffer, row.data.byteOffset).getUint32(46, true) !== 0)) throw new Error('tTSLA mint authority or freeze policy mismatch.');
  }
  const cashVaultBalance = tokenBalance(rows[6], manifest.cashMint, manifest.pool), collateralVaultBalance = tokenBalance(rows[7], manifest.shareMint, manifest.pool);
  if (cashVaultBalance < pool.cash || collateralVaultBalance < pool.totalCollateral) throw new Error('Pool custody is below its accounted cash or collateral.');
  const position = rows[10] ? decodeLoanPosition(programState(rows[10], manifest)) : null;
  if (position && (position.pool !== manifest.pool || position.owner !== owner || position.balance > pool.totalSupply || position.borrowShares > pool.totalBorrowShares || position.collateral > pool.totalCollateral)) throw new Error('Loan position identity or totals do not match the pool.');
  const cooldown = rows[11] ? decodeFaucetCooldown(programState(rows[11], manifest)) : null;
  if (cooldown && cooldown.owner !== owner) throw new Error('Faucet cooldown belongs to another wallet.');
  return { pool, price, budget, position, cooldown, walletCash: tokenBalance(rows[8], manifest.cashMint, owner, true), walletShares: tokenBalance(rows[9], manifest.shareMint, owner, true), cashVaultBalance, collateralVaultBalance, cashAccount, shareAccount, positionAddress, nowSeconds, slot, extraRows: rows.slice(12, 12 + extraKeys.length) };
}
function emptyPosition(manifest: SolanaSharesManifest, owner: string): LoanPosition { return { pool: manifest.pool, owner, balance: 0n, netContributed: 0n, collateral: 0n, borrowShares: 0n, bump: 0 }; }
export function solanaMarketReadModel(manifest: SolanaSharesManifest, wallet: { id: string; address: string }, snapshot: SolanaMarketSnapshot) {
  const p = snapshot.position ?? emptyPosition(manifest, wallet.address), fresh = isPriceFresh(snapshot.price, snapshot.nowSeconds), loan = quoteBorrowPosition(snapshot.pool, p, snapshot.price, snapshot.nowSeconds), market = quoteLendingMarket(snapshot.pool, snapshot.price, snapshot.nowSeconds);
  const lenderValue = p.balance * (market.assets + 1n) / (snapshot.pool.totalSupply + 1_000_000_000_000n);
  return {
    enabled: true, network: 'solana-devnet', shareDecimals: 6, cashSymbol: 'tUSDC', stockSymbol: 'tTSLA', walletAddress: wallet.address, walletId: wallet.id, canRefreshPrice: true,
    deployment: { pool: manifest.pool, oracle: manifest.price, stock: manifest.shareMint, usd: manifest.cashMint }, disclaimer: DISCLAIMER,
    sharesRaw: snapshot.walletShares.toString(), testUsdAtomic: snapshot.walletCash.toString(), priceAtomic: fresh ? snapshot.price.priceUsdE6.toString() : null,
    walletValueAtomic: fresh ? shareValue(snapshot.walletShares, snapshot.price.priceUsdE6).toString() : snapshot.walletShares === 0n ? '0' : null,
    price: { sourceRoundId: '', sourceUpdatedAt: Number(snapshot.price.publishedAt), pushedAt: Number(snapshot.price.copiedAt), ageSeconds: Number(snapshot.nowSeconds > snapshot.price.publishedAt ? snapshot.nowSeconds - snapshot.price.publishedAt : 0n), stale: !fresh, weekendFreshnessWindow: priceMaxAge(snapshot.nowSeconds) === 74n * 3600n, sourceFeed: manifest.price, sourceChainId: 0 },
    loan: { sharesRaw: p.collateral.toString(), debtAtomic: loan.debt.toString(), valueAtomic: fresh ? loan.value.toString() : p.collateral === 0n ? '0' : null, ltvBps: loan.ltvBps === null ? Number.MAX_SAFE_INTEGER : Number(loan.ltvBps), availableAtomic: loan.borrowable.toString(), priceFresh: fresh },
    lender: { sharesRaw: p.balance.toString(), netContributedAtomic: p.netContributed.toString(), valueAtomic: lenderValue.toString(), earnedAtomic: (lenderValue - p.netContributed).toString(), maxWithdrawAtomic: maxWithdraw(snapshot.pool, p, snapshot.nowSeconds).toString() },
    pool: { cashAtomic: market.cash.toString(), totalAssetsAtomic: market.assets.toString(), borrowedAtomic: market.borrowed.toString(), utilizationBps: Number(market.utilizationBps), borrowAprBps: 500, effectiveBorrowApyBps: 513, supplyAprBps: Number(market.supplyAprBps), debtExposureCapAtomic: snapshot.pool.debtExposureCap.toString() },
    faucet: { availableAt: Number(faucetAvailableAt(snapshot.cooldown)), remainingTodayAtomic: faucetBudgetRemaining(snapshot.budget, snapshot.nowSeconds).toString() },
    suspended: false, suspensionReasons: [], observedSlot: snapshot.slot, observedAt: Number(snapshot.nowSeconds),
  };
}

type MarketEntry = { id: string; requestId: string; operation: string; quantity: string; borrower?: string };
type MarketJournal = { active: string | null; entries: MarketEntry[] };
const marketKey = (identity: VerifiedIdentity) => `solana-shares-market:${ownerKey(identity)}`;
async function journal(store: Store, identity: VerifiedIdentity) {
  const key = marketKey(identity); try { await store.create<MarketJournal>(key, { active: null, entries: [] }); } catch (error) { if (!await store.get(key)) throw error; }
  return (await store.get<MarketJournal>(key))!;
}
async function marketOperation(store: Store, identity: VerifiedIdentity, id: string, operations: SolanaOperations) {
  const lane = await journal(store, identity), entry = lane.entries.find(entry => entry.id === id);
  if (!entry) throw new Error('That transaction is not a reviewed Solana lending action.');
  const op = await operations.get(id, identity);
  if (op.kind !== `solana-shares:market:${entry.operation}`) throw new Error('Solana lending operation kind mismatch.');
  return { lane, entry, op };
}
export async function readSolanaSharedMarket(store: Store, identity: VerifiedIdentity, options: SolanaMarketOptions = {}) {
  const context = await contextFor(store, options), wallet = walletFor(identity, 'solana'), snapshot = await readSolanaMarketSnapshot(context.manifest, wallet.address, context.gateway), lane = await journal(store, identity);
  const receipts: { id: string; operation: string; state: string; signature: string; explorerUrl: string }[] = [];
  let activeOperation: (SolanaOperationResult & Partial<PreparedSolanaOperation> & { network: 'solana-devnet' }) | null = null;
  if (lane.entries.length) {
    const { operations } = await contextFor(store, options, true);
    for (const entry of lane.entries.slice(-20)) {
      await marketOperation(store, identity, entry.id, operations!);
      const result = await operations!.reconcile({ identity, id: entry.id });
      if (result.signature) receipts.push({ id: entry.id, operation: entry.operation, state: result.state, signature: result.signature, explorerUrl: `https://explorer.solana.com/tx/${result.signature}?cluster=devnet` });
      if (entry.id === lane.active && ['prepared', 'broadcast'].includes(result.state)) activeOperation = { ...(result.state === 'prepared' ? await operations!.get(entry.id, identity) : {}), ...result, network: 'solana-devnet' };
    }
  }
  const limits = await faucetLimits(store, identity, snapshot, options);
  return { ...solanaMarketReadModel(context.manifest, wallet, snapshot), faucet: limits, activeOperation, receipts };
}
function amount(input: unknown): bigint { if (typeof input !== 'string' || !/^[1-9][0-9]*$/.test(input)) throw new Error('Enter a positive canonical atomic amount.'); const n = BigInt(input); if (n > MAX_U64) throw new Error('Amount exceeds the token limit.'); return n; }
function action(input: unknown): SolanaMarketAction { if (!['lend', 'unlend', 'borrow', 'repay', 'deposit_collateral', 'withdraw_collateral', 'liquidate'].includes(String(input))) throw new Error('Unknown Solana lending action.'); return input as SolanaMarketAction; }
function requestId(input: unknown) { const id = input === undefined ? randomUUID() : input; if (typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(id)) throw new Error('A durable request ID is required.'); return id; }

/** Exact token amounts are reviewed; repayment/liquidation are explicit maximum debits. */
export async function buildSolanaMarketAction(manifest: SolanaSharesManifest, owner: string, payer: string, operation: SolanaMarketAction, quantity: bigint, snapshot: SolanaMarketSnapshot, borrower?: string, target?: LoanPosition) {
  const position = snapshot.position ?? emptyPosition(manifest, owner);
  let selected: LendingAction, maximumDebit = 0n, estimatedShares = 0n;
  const fresh = isPriceFresh(snapshot.price, snapshot.nowSeconds);
  if (operation === 'lend') { if (quantity > snapshot.walletCash) throw new Error('Your wallet needs more site tUSDC before lending.'); selected = { kind: 'lend', amount: quantity }; maximumDebit = quantity; }
  else if (operation === 'unlend') { if (quantity > maxWithdraw(snapshot.pool, position, snapshot.nowSeconds)) throw new Error('Withdrawal exceeds your lender value or the pool cash available.'); selected = { kind: 'withdraw_lending', amount: quantity }; }
  else if (operation === 'deposit_collateral') { if (quantity > snapshot.walletShares) throw new Error('Get enough centrally issued test TSLA before adding collateral.'); selected = { kind: 'deposit_collateral', amount: quantity }; maximumDebit = quantity; }
  else if (operation === 'withdraw_collateral') {
    if (quantity > position.collateral) throw new Error('You cannot withdraw more test shares than you locked.');
    if (position.borrowShares !== 0n) {
      if (!fresh) throw new Error('A fresh mirrored TSLA price is required while debt remains.');
      const remaining = { ...position, collateral: position.collateral - quantity };
      const quote = quoteBorrowPosition(snapshot.pool, remaining, snapshot.price, snapshot.nowSeconds);
      if (quote.debt > quote.value / 2n) throw new Error('That withdrawal would exceed fifty percent loan-to-value.');
    }
    selected = { kind: 'withdraw_collateral', amount: quantity };
  } else if (operation === 'borrow') {
    if (!fresh) throw new Error('A fresh mirrored TSLA price is required to borrow.');
    if (quantity < 1_000_000n) throw new Error('Borrow at least one test tUSDC.');
    const quote = quoteBorrowPosition(snapshot.pool, position, snapshot.price, snapshot.nowSeconds);
    if (quantity > quote.borrowable) throw new Error('Borrowing exceeds collateral, available pool cash, utilization or the aggregate two-thousand-tUSDC exposure cap.');
    selected = { kind: 'borrow', amount: quantity };
  } else if (operation === 'repay') {
    const quote = previewRepay(snapshot.pool, position.borrowShares, quantity, snapshot.nowSeconds);
    if (quote.assets > snapshot.walletCash) throw new Error('Your wallet needs more site tUSDC to repay this debt.');
    selected = { kind: 'repay', maxAmount: quantity }; maximumDebit = quantity;
  } else {
    if (!fresh || !borrower || !target || target.owner !== borrower || target.pool !== manifest.pool) throw new Error('A fresh price and an observed borrower position are required for liquidation.');
    const quote = previewLiquidation(snapshot.pool, target, quantity, snapshot.price, snapshot.nowSeconds);
    if (quote.assets > snapshot.walletCash) throw new Error('Your wallet needs enough site tUSDC for the liquidation repayment.');
    selected = { kind: 'liquidate', maxRepay: quantity }; maximumDebit = quantity; estimatedShares = quote.seized;
  }
  const instructions: Instruction[] = [
    getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(address(payer)), ata: address(snapshot.cashAccount), owner: address(owner), mint: address(manifest.cashMint), tokenProgram: address(SOLANA_IDS.token) }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(address(payer)), ata: address(snapshot.shareAccount), owner: address(owner), mint: address(manifest.shareMint), tokenProgram: address(SOLANA_IDS.token) }),
    await buildLendingInstruction({ payer, owner, cashAccount: snapshot.cashAccount, shareAccount: snapshot.shareAccount, ...(operation === 'liquidate' ? { borrower } : {}), action: selected }),
  ];
  const expectedDeltas: ExpectedTokenDelta[] = [];
  const delta = (account: string, mint: string, authority: string, direction: 'credit' | 'debit', minimum: bigint, maximum = minimum, allowCreated = false) => expectedDeltas.push({ account, mint, owner: authority, direction, minimumAtomic: minimum.toString(), maximumAtomic: maximum.toString(), allowCreated });
  if (operation === 'lend') { delta(snapshot.cashAccount, manifest.cashMint, owner, 'debit', quantity); delta(manifest.cashVault, manifest.cashMint, manifest.pool, 'credit', quantity); }
  if (operation === 'unlend' || operation === 'borrow') { delta(snapshot.cashAccount, manifest.cashMint, owner, 'credit', quantity, quantity, true); delta(manifest.cashVault, manifest.cashMint, manifest.pool, 'debit', quantity); }
  if (operation === 'deposit_collateral') { delta(snapshot.shareAccount, manifest.shareMint, owner, 'debit', quantity); delta(manifest.collateralVault, manifest.shareMint, manifest.pool, 'credit', quantity); }
  if (operation === 'withdraw_collateral') { delta(snapshot.shareAccount, manifest.shareMint, owner, 'credit', quantity, quantity, true); delta(manifest.collateralVault, manifest.shareMint, manifest.pool, 'debit', quantity); }
  if (operation === 'repay' || operation === 'liquidate') { delta(snapshot.cashAccount, manifest.cashMint, owner, 'debit', operation === 'repay' ? 1n : 0n, maximumDebit); delta(manifest.cashVault, manifest.cashMint, manifest.pool, 'credit', operation === 'repay' ? 1n : 0n, maximumDebit); }
  if (operation === 'liquidate') { delta(snapshot.shareAccount, manifest.shareMint, owner, 'credit', 0n, target!.collateral, true); delta(manifest.collateralVault, manifest.shareMint, manifest.pool, 'debit', 0n, target!.collateral); }
  const collateral = operation === 'deposit_collateral' || operation === 'withdraw_collateral', symbol = collateral ? 'tTSLA' : 'tUSDC', human = formatUnits(quantity, 6);
  const recipient = operation === 'lend' || operation === 'repay' || operation === 'liquidate' ? manifest.cashVault : operation === 'deposit_collateral' ? manifest.collateralVault : collateral ? snapshot.shareAccount : snapshot.cashAccount;
  const description = operation === 'lend' ? `Lend exactly ${human} tUSDC to the shared pool and receive a lender share entitlement. Withdrawals are limited by pool cash; borrower bad debt can reduce your lender value.`
    : operation === 'unlend' ? `Withdraw exactly ${human} tUSDC from your lender entitlement to your own wallet. Pool shares are burned at the execution-time pool conversion; borrower bad debt can change that conversion.`
    : operation === 'borrow' ? `Borrow exactly ${human} tUSDC from the pool to your own wallet against locked tTSLA. Debt accrues continuously at five percent nominal annually; liquidation starts at eighty percent loan-to-value.`
    : operation === 'repay' ? `Repay up to ${human} tUSDC from your own wallet. Only outstanding debt is paid, rounded in the pool's favor; interest continues until the transaction executes. The remaining cap stays in your wallet.`
    : operation === 'deposit_collateral' ? `Lock exactly ${human} fictional tTSLA in the shared pool as collateral. These shares can be seized if the loan becomes liquidatable.`
    : operation === 'withdraw_collateral' ? `Return exactly ${human} locked fictional tTSLA to your own wallet, in kind. Nothing is sold. Any remaining debt must stay within fifty percent loan-to-value.`
    : `Repay up to ${human} tUSDC against borrower ${borrower}. At the observed price the estimated seizure is ${formatUnits(estimatedShares, 6)} tTSLA, in kind, with a ten percent liquidation bonus and half-debt close factor; actual repayment and seizure use execution-time debt and price.`;
  return { instructions, expectedDeltas, review: { operation, network: 'Solana devnet', account: owner, asset: symbol, amount: human, amountAtomic: quantity.toString(), maximumDebitAtomic: maximumDebit.toString(), amountIsMaximum: operation === 'repay' || operation === 'liquidate', recipient, pool: manifest.pool, cashAccount: snapshot.cashAccount, shareAccount: snapshot.shareAccount, cashVault: manifest.cashVault, collateralVault: manifest.collateralVault, ...(borrower ? { borrower } : {}), ...(operation === 'liquidate' ? { estimatedSeizedSharesAtomic: estimatedShares.toString() } : {}), priceUsdE6: snapshot.price.priceUsdE6.toString(), pricePublishedAt: snapshot.price.publishedAt.toString(), debtExposureCapAtomic: snapshot.pool.debtExposureCap.toString(), description: `${description} Sponsored network fees and account rent. ${DISCLAIMER}` } };
}
export async function prepareSolanaMarketAction(store: Store, identity: VerifiedIdentity, input: { operation?: unknown; quantity?: unknown; borrower?: unknown; requestId?: unknown }, options: SolanaMarketOptions = {}) {
  const { manifest, gateway, operations, sponsorAddress } = await contextFor(store, options, true), wallet = walletFor(identity, 'solana'), operation = action(input.operation), quantity = amount(input.quantity), intent = requestId(input.requestId), lane = await journal(store, identity);
  const borrower = operation === 'liquidate' && typeof input.borrower === 'string' ? String(address(input.borrower)) : undefined;
  if (operation === 'liquidate' && !borrower) throw new Error('Select the observed borrower you intend to liquidate.');
  if (operation !== 'liquidate' && input.borrower !== undefined) throw new Error('Borrower overrides are allowed only for liquidation.');
  const previous = lane.entries.find(entry => entry.requestId === intent);
  if (previous) {
    if (previous.operation !== operation || previous.quantity !== quantity.toString() || previous.borrower !== borrower) throw new Error('This request ID already reviews a different lending action.');
    const { op } = await marketOperation(store, identity, previous.id, operations!); return { ...op, network: 'solana-devnet' as const };
  }
  if (lane.active) {
    await marketOperation(store, identity, lane.active, operations!);
    const current = await operations!.reconcile({ identity, id: lane.active });
    if (current.state === 'prepared' || current.state === 'broadcast') throw new Error('Finish or cancel the current Solana lending review before another action.');
  }
  let snapshot = await readSolanaMarketSnapshot(manifest, wallet.address, gateway);
  const needsPrice = operation === 'borrow' || operation === 'liquidate' || (operation === 'withdraw_collateral' && (snapshot.position?.borrowShares ?? 0n) !== 0n);
  if (needsPrice && !isPriceFresh(snapshot.price, snapshot.nowSeconds)) {
    const copied = await ensureSolanaSharesPrice(store, manifest, { ...options.mirror, gateway, operations, environment: options.environment, now: options.mirror?.now ?? (() => Number(snapshot.nowSeconds)) });
    if (!copied.fresh) throw new Error(`A fresh mirrored TSLA price is required. ${copied.reason ?? 'Price update unavailable.'}${copied.signature ? ` Price-copy receipt: ${copied.signature}.` : ''}`);
    snapshot = await readSolanaMarketSnapshot(manifest, wallet.address, gateway);
  }
  let target: LoanPosition | undefined;
  if (borrower) {
    const targetKey = await loanPositionAddress(manifest.pool, borrower);
    snapshot = await readSolanaMarketSnapshot(manifest, wallet.address, gateway, [targetKey]);
    target = decodeLoanPosition(programState(snapshot.extraRows[0], manifest));
    if (target.pool !== manifest.pool || target.owner !== borrower || target.borrowShares > snapshot.pool.totalBorrowShares || target.collateral > snapshot.pool.totalCollateral) throw new Error('Borrower position does not match the observed pool.');
  }
  const built = await buildSolanaMarketAction(manifest, wallet.address, sponsorAddress, operation, quantity, snapshot, borrower, target);
  const prepared = await operations!.prepare({ identity, kind: `solana-shares:market:${operation}`, requestId: intent, actor: address(wallet.address), walletId: wallet.id, instructions: built.instructions, review: built.review, expectedDeltas: built.expectedDeltas });
  await store.update<MarketJournal>(marketKey(identity), current => {
    if (current.active !== lane.active && current.active !== prepared.id) throw new Error('Another lending action was prepared; recover its exact review.');
    return { active: prepared.id, entries: [...current.entries, { id: prepared.id, requestId: intent, operation, quantity: quantity.toString(), ...(borrower ? { borrower } : {}) }] };
  });
  return { ...prepared, state: 'prepared' as const, network: 'solana-devnet' as const };
}
export async function submitSolanaMarketAction(store: Store, identity: VerifiedIdentity, id: string, signedTransactionBase64: string, options: SolanaMarketOptions = {}) {
  const { operations } = await contextFor(store, options, true), { lane } = await marketOperation(store, identity, id, operations!);
  if (lane.active !== id) throw new Error('Only the active exact lending review may be submitted.');
  return { ...await operations!.submit({ identity, id, signedTransactionBase64 }), network: 'solana-devnet' as const };
}
export async function reconcileSolanaMarketAction(store: Store, identity: VerifiedIdentity, id: string, options: SolanaMarketOptions = {}) {
  const { operations } = await contextFor(store, options, true); await marketOperation(store, identity, id, operations!);
  return { ...await operations!.reconcile({ identity, id }), network: 'solana-devnet' as const };
}
export async function cancelSolanaMarketAction(store: Store, identity: VerifiedIdentity, id: string, options: SolanaMarketOptions = {}) {
  const { operations } = await contextFor(store, options, true), { lane } = await marketOperation(store, identity, id, operations!);
  if (lane.active !== id) throw new Error('Only the active unsigned lending review may be cancelled.');
  const result = await operations!.cancel({ identity, id });
  await store.update<MarketJournal>(marketKey(identity), current => current.active === id ? { ...current, active: null } : current);
  return { ...result, network: 'solana-devnet' as const };
}

type FaucetClaim = { wallet: string; walletId: string; requestId: string; at: number; lease: string; busyUntil: number; id?: string; state: 'available' | 'reserving' | 'prepared' | 'broadcast' | 'confirmed' | 'failed' | 'expired'; confirmedAt?: number };
const faucetKey = (identity: VerifiedIdentity) => `solana-shares-faucet:${ownerKey(identity)}`;
async function faucetClaim(store: Store, identity: VerifiedIdentity) {
  const key = faucetKey(identity); try { await store.create<FaucetClaim>(key, { wallet: '', walletId: '', requestId: '', at: 0, lease: '', busyUntil: 0, state: 'available' }); } catch (error) { if (!await store.get(key)) throw error; }
  return (await store.get<FaucetClaim>(key))!;
}
async function updateClaimResult(store: Store, identity: VerifiedIdentity, result: SolanaOperationResult, at: number) {
  return store.update<FaucetClaim>(faucetKey(identity), current => {
    if (current.id !== result.id) throw new Error('Faucet reservation changed.');
    return { ...current, state: result.state, busyUntil: 0, ...(result.state === 'confirmed' && current.confirmedAt === undefined ? { confirmedAt: at } : {}) };
  });
}
async function faucetOperation(store: Store, identity: VerifiedIdentity, id: string, operations: SolanaOperations, requireCurrentWallet = true) {
  const claim = await faucetClaim(store, identity);
  if (claim.id !== id) throw new Error('That transaction is not this account’s current faucet claim.');
  // The private verified-subject claim binds history; signing still requires the current verified wallet.
  const op = await operations.get(id, requireCurrentWallet ? identity : undefined);
  if (op.kind !== 'solana-shares:faucet' || op.walletId !== claim.walletId) throw new Error('Faucet operation kind or wallet mismatch.');
  return { claim, op };
}
async function faucetLimits(store: Store, identity: VerifiedIdentity, snapshot: SolanaMarketSnapshot, options: SolanaMarketOptions) {
  const claim = await faucetClaim(store, identity);
  return { availableAt: Math.max(Number(faucetAvailableAt(snapshot.cooldown)), claim.confirmedAt === undefined ? 0 : Math.ceil((claim.confirmedAt + DAY) / 1000)), remainingTodayAtomic: faucetBudgetRemaining(snapshot.budget, snapshot.nowSeconds).toString(), accountLimit: 'one claim per verified account per 24 hours', dailyBudgetShares: '50', pending: claim.state === 'reserving' || claim.state === 'prepared' || claim.state === 'broadcast', now: Math.floor((options.now ?? Date.now)() / 1000) };
}
export async function readSolanaSharesFaucet(store: Store, identity: VerifiedIdentity, options: SolanaMarketOptions = {}) {
  const context = await contextFor(store, options), wallet = walletFor(identity, 'solana'), snapshot = await readSolanaMarketSnapshot(context.manifest, wallet.address, context.gateway), claim = await faucetClaim(store, identity);
  let activeOperation: (SolanaOperationResult & Partial<PreparedSolanaOperation> & { network: 'solana-devnet' }) | null = null;
  const receipts: { id: string; operation: string; state: string; signature: string; explorerUrl: string }[] = [];
  if (claim.id) {
    const { operations } = await contextFor(store, options, true); await faucetOperation(store, identity, claim.id, operations!, false);
    const result = await operations!.reconcile({ id: claim.id });
    await updateClaimResult(store, identity, result, (options.now ?? Date.now)());
    if (result.state === 'prepared' || result.state === 'broadcast') activeOperation = { ...(result.state === 'prepared' ? await operations!.get(claim.id) : {}), ...result, network: 'solana-devnet' };
    if (result.signature) receipts.push({ id: claim.id, operation: 'faucet', state: result.state, signature: result.signature, explorerUrl: `https://explorer.solana.com/tx/${result.signature}?cluster=devnet` });
  }
  return { configured: true, network: 'solana-devnet', amountAtomic: FAUCET_AMOUNT.toString(), walletAddress: wallet.address, shareMint: context.manifest.shareMint, ...await faucetLimits(store, identity, snapshot, options), activeOperation, receipts };
}
export async function prepareSolanaSharesFaucet(store: Store, identity: VerifiedIdentity, input: { requestId?: unknown }, options: SolanaMarketOptions = {}) {
  const { manifest, gateway, operations, sponsorAddress } = await contextFor(store, options, true), wallet = walletFor(identity, 'solana'), intent = requestId(input.requestId), at = (options.now ?? Date.now)(), lease = randomUUID();
  let claim = await faucetClaim(store, identity);
  if (claim.id) {
    await faucetOperation(store, identity, claim.id, operations!, false);
    const result = await operations!.reconcile({ id: claim.id }); claim = await updateClaimResult(store, identity, result, at);
    if (result.state === 'prepared' || result.state === 'broadcast') {
      if (claim.wallet !== wallet.address || claim.walletId !== wallet.id) throw new Error('Recover the pending test TSLA claim with its original verified wallet.');
      return { ...await operations!.get(claim.id!, identity), network: 'solana-devnet' as const };
    }
  }
  const snapshot = await readSolanaMarketSnapshot(manifest, wallet.address, gateway);
  if (claim.confirmedAt !== undefined && claim.confirmedAt + DAY > at) throw new Error('Test TSLA is limited to one claim per verified account per 24 hours, including wallet changes.');
  if (faucetAvailableAt(snapshot.cooldown) > snapshot.nowSeconds) throw new Error('This wallet’s on-chain twenty-four-hour test TSLA cooldown has not elapsed.');
  if (faucetBudgetRemaining(snapshot.budget, snapshot.nowSeconds) < FAUCET_AMOUNT) throw new Error('The global fifty-test-TSLA daily budget is exhausted. Try the next UTC day.');
  const previous = claim;
  claim = await store.update<FaucetClaim>(faucetKey(identity), current => {
    if (current.busyUntil > at) throw new Error('A test TSLA review is already being prepared. Recover it before another claim.');
    if (current.confirmedAt !== undefined && current.confirmedAt + DAY > at) throw new Error('Test TSLA is limited to one claim per verified account per 24 hours.');
    if (current.id && (current.state === 'prepared' || current.state === 'broadcast')) throw new Error('Recover the current faucet review first.');
    if (current.state === 'reserving' && current.wallet !== wallet.address) throw new Error('Recover the pending test TSLA claim with its original wallet.');
    const retainedIntent = current.state === 'reserving' ? current.requestId : intent;
    if (current.id && current.requestId === retainedIntent) throw new Error('This faucet review already finished or expired; use a fresh request ID.');
    return { wallet: wallet.address, walletId: wallet.id, requestId: retainedIntent, at, lease, busyUntil: at + 60_000, state: 'reserving' };
  });
  try {
    const instructions = [
      getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(address(sponsorAddress)), ata: address(snapshot.shareAccount), owner: address(wallet.address), mint: address(manifest.shareMint), tokenProgram: address(SOLANA_IDS.token) }),
      await faucetInstruction({ payer: sponsorAddress, owner: wallet.address, issuer: sponsorAddress, destination: snapshot.shareAccount }),
    ];
    const review = { operation: 'faucet', network: 'Solana devnet', account: wallet.address, recipient: snapshot.shareAccount, asset: 'tTSLA', amount: '5', amountAtomic: FAUCET_AMOUNT.toString(), issuer: sponsorAddress, shareMint: manifest.shareMint, dailyBudgetAtomic: manifest.dailyFaucetBudgetAtomic, description: 'Receive exactly five centrally issued fictional tTSLA on Solana devnet to your own wallet. One claim per verified account and wallet per twenty-four hours; fifty test shares globally per UTC day. The hosted issuer co-signs and pays capped network fees/account rent. These test shares have no value and confer no stock, property or rental rights.' };
    const prepared = await operations!.prepare({ identity, kind: 'solana-shares:faucet', requestId: claim.requestId, actor: address(wallet.address), walletId: wallet.id, instructions, review, expectedDeltas: [{ account: snapshot.shareAccount, mint: manifest.shareMint, owner: wallet.address, direction: 'credit', minimumAtomic: FAUCET_AMOUNT.toString(), maximumAtomic: FAUCET_AMOUNT.toString(), allowCreated: true }] });
    const state = await operations!.reconcile({ identity, id: prepared.id });
    await store.update<FaucetClaim>(faucetKey(identity), current => { if (current.lease !== lease) throw new Error('Faucet review lease changed; recover the exact existing claim.'); return { ...current, id: prepared.id, state: state.state, busyUntil: 0 }; });
    if (state.state !== 'prepared') throw new Error('This unsigned faucet review expired; prepare a fresh review.');
    return { ...prepared, state: 'prepared' as const, network: 'solana-devnet' as const };
  } catch (error) {
    await store.update<FaucetClaim>(faucetKey(identity), current => current.lease === lease && !current.id ? { ...previous, busyUntil: 0 } : current);
    throw error;
  }
}
export async function submitSolanaSharesFaucet(store: Store, identity: VerifiedIdentity, id: string, signedTransactionBase64: string, options: SolanaMarketOptions = {}) {
  const { operations } = await contextFor(store, options, true); await faucetOperation(store, identity, id, operations!);
  const result = await operations!.submit({ identity, id, signedTransactionBase64 });
  await updateClaimResult(store, identity, result, (options.now ?? Date.now)());
  return { ...result, network: 'solana-devnet' as const };
}
export async function reconcileSolanaSharesFaucet(store: Store, identity: VerifiedIdentity, id: string, options: SolanaMarketOptions = {}) {
  const { operations } = await contextFor(store, options, true); await faucetOperation(store, identity, id, operations!, false);
  const result = await operations!.reconcile({ id }); await updateClaimResult(store, identity, result, (options.now ?? Date.now)());
  return { ...result, network: 'solana-devnet' as const };
}
export async function cancelSolanaSharesFaucet(store: Store, identity: VerifiedIdentity, id: string, options: SolanaMarketOptions = {}) {
  const { operations } = await contextFor(store, options, true); await faucetOperation(store, identity, id, operations!);
  const result = await operations!.cancel({ identity, id }); await updateClaimResult(store, identity, result, (options.now ?? Date.now)());
  return { ...result, network: 'solana-devnet' as const };
}

/** The advanced view fetches only a bounded page of position data, never other users' private records. */
export async function readSolanaUnhealthyLoans(store: Store, identity: VerifiedIdentity, cursor = '0', pageSize = 20, options: SolanaMarketOptions = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || !/^(0|[1-9][0-9]*)$/.test(cursor)) throw new Error('Invalid liquidation page.');
  const { manifest, gateway } = await contextFor(store, options), wallet = walletFor(identity, 'solana');
  await gateway.checkedGenesis();
  const raw: unknown = await gateway.rpc('getProgramAccounts', [manifest.programId, { commitment: 'finalized', encoding: 'base64', dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: 129 }, { memcmp: { offset: 8, bytes: manifest.pool } }] }]);
  if (!Array.isArray(raw) || raw.length > 10_000 || raw.some(row => !row || typeof row.pubkey !== 'string')) throw new Error('Public borrower registry unavailable or too large to assess safely.');
  const keys = raw.map(row => String(address(row.pubkey))).sort(), start = Number(cursor);
  if (!Number.isSafeInteger(start) || start > keys.length) throw new Error('Invalid liquidation cursor.');
  const selected = keys.slice(start, start + pageSize), snapshot = await readSolanaMarketSnapshot(manifest, wallet.address, gateway, selected), fresh = isPriceFresh(snapshot.price, snapshot.nowSeconds);
  const loans: { borrower: string; debtAtomic: string; sharesRaw: string; ltvBps: number }[] = [];
  for (let i = 0; i < snapshot.extraRows.length; i++) {
    const row = snapshot.extraRows[i]; if (!row) continue;
    const position = decodeLoanPosition(programState(row, manifest));
    if (position.pool !== manifest.pool || await loanPositionAddress(manifest.pool, position.owner) !== selected[i] || position.borrowShares > snapshot.pool.totalBorrowShares) throw new Error('Public loan identity mismatch.');
    const quote = quoteBorrowPosition(snapshot.pool, position, snapshot.price, snapshot.nowSeconds);
    if (quote.debt !== 0n && (quote.ltvBps === null || quote.ltvBps >= 8000n)) loans.push({ borrower: position.owner, debtAtomic: quote.debt.toString(), sharesRaw: position.collateral.toString(), ltvBps: quote.ltvBps === null ? Number.MAX_SAFE_INTEGER : Number(quote.ltvBps) });
  }
  return { loans, nextCursor: start + selected.length < keys.length ? String(start + selected.length) : null, scanned: selected.length, observedAt: Number(snapshot.nowSeconds), suspended: !fresh, suspensionReasons: fresh ? [] : ['A fresh mirrored TSLA price is required before liquidating.'], network: 'solana-devnet' };
}
