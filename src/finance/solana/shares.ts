import type { Address } from '@solana/kit';
import { AccountRole, address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type Instruction } from '@solana/kit';
import { SOLANA_IDS, SOLANA_TEST_USDC_MINT } from './manifest.ts';

export const SHARES_PROGRAM_ID = '97j5CWWKUALG2XRUBoZ1spqtN5YWJPVdTiRLNN5CWYkQ';
export const SHARES_PRICE_AUTHORITY = '3AoHstmog6FiCcBaVAh8jnB8iVc2v9oUvN2Pnn76YtbH';
export const SHARES_INITIALIZER = 'HEZ9ERxb1W9WfBjUGE6A4jFZU3jUMJRSM1kyERgac38G';
export const DAILY_FAUCET_BUDGET = 50_000_000n;
export const DEBT_EXPOSURE_CAP = 2_000_000_000n;
export const SHARE_DECIMALS = 6;
export const SHARE_SCALE = 1_000_000n;
export const FAUCET_AMOUNT = 5_000_000n;
export const FAUCET_COOLDOWN_SECONDS = 86_400n;
export const SHARE_VIRTUAL_OFFSET = 1_000_000_000_000n;
const RAY = 10n ** 27n;
const RENT = 'SysvarRent111111111111111111111111111111111';
const encoder = getAddressEncoder();
const keyBytes = (key: string) => new Uint8Array(encoder.encode(address(key)));
async function pda(seed: string, ...keys: Uint8Array[]) {
  return (await getProgramDerivedAddress({ programAddress: address(SHARES_PROGRAM_ID), seeds: [new TextEncoder().encode(seed), ...keys] }))[0];
}
export async function sharesAddresses() {
  const shareMint = await pda('share_mint');
  const [price, pool] = await Promise.all([pda('price', keyBytes(shareMint)), pda('pool', keyBytes(shareMint))]);
  const [cashVault, collateralVault, faucetBudget] = await Promise.all([pda('pool_cash', keyBytes(pool)), pda('pool_collateral', keyBytes(pool)), pda('faucet_budget', keyBytes(shareMint))]);
  return { shareMint, price, pool, cashVault, collateralVault, faucetBudget };
}
export async function loanPositionAddress(pool: string, owner: string) { return pda('loan', keyBytes(pool), keyBytes(owner)); }
export async function faucetCooldownAddress(shareMint: string, owner: string) { return pda('faucet', keyBytes(shareMint), keyBytes(owner)); }
export async function shareEscrowAddresses(landlord: string, agreementHash: Uint8Array) {
  hash32(agreementHash);
  const escrow = await pda('escrow', keyBytes(landlord), agreementHash);
  return { escrow, vault: await pda('escrow_vault', keyBytes(escrow)) };
}
function hash32(value: Uint8Array) { if (!(value instanceof Uint8Array) || value.length !== 32) throw new Error('Expected a 32-byte hash'); return value; }
export type Atomic = bigint | string;
function integer(value: Atomic, bits: number, signed = false): Uint8Array {
  if (typeof value === 'string' && !/^-?(0|[1-9][0-9]*)$/.test(value)) throw new Error('Invalid atomic integer');
  const n = BigInt(value), limit = 1n << BigInt(bits);
  if (n < (signed ? -(limit / 2n) : 0n) || n >= (signed ? limit / 2n : limit)) throw new Error('Integer out of range');
  let remaining = n < 0n ? limit + n : n;
  const bytes = new Uint8Array(bits / 8);
  for (let i = 0; i < bytes.length; i++) { bytes[i] = Number(remaining & 255n); remaining >>= 8n; }
  return bytes;
}
const u64 = (v: Atomic) => integer(v, 64);
const i64 = (v: Atomic) => integer(v, 64, true);
function concat(parts: readonly Uint8Array[]) { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let offset = 0; for (const p of parts) { out.set(p, offset); offset += p.length; } return out; }
const meta = (key: string, role: AccountRole = AccountRole.READONLY) => ({ address: address(key), role });
const W = AccountRole.WRITABLE, S = AccountRole.READONLY_SIGNER, WS = AccountRole.WRITABLE_SIGNER;
const discriminators = {
  initialize_shares: [225,114,231,212,162,16,154,247], faucet: [0,98,59,30,144,142,113,12], set_price: [16,19,182,8,149,83,72,181], initialize_pool: [95,180,10,172,84,174,232,40],
  lend: [89,34,75,168,122,47,185,45], withdraw_lending: [75,44,82,115,226,23,33,139], redeem_lending: [35,217,140,168,34,29,129,77], deposit_collateral: [156,131,142,116,146,247,162,120], withdraw_collateral: [115,135,168,106,139,214,138,150], borrow: [228,253,131,202,207,116,89,18], repay: [234,103,67,82,208,234,219,166], liquidate: [223,179,226,125,48,46,39,74], realize_bad_debt: [207,99,21,74,167,146,130,232], accrue: [23,76,128,149,229,247,72,228],
  initialize_escrow: [243,160,77,153,11,92,48,209], pledge: [235,47,156,254,0,88,212,142], activate: [194,203,35,100,151,55,170,82], withdraw: [183,18,70,156,148,109,161,34], propose_claim: [70,254,74,21,158,61,195,189], accept_claim: [139,66,180,182,209,194,173,87], contest_claim: [98,173,96,56,135,227,236,210], escalate_claim: [96,28,94,195,201,64,213,181], lower_claim: [121,244,31,150,171,47,239,72], request_return: [74,176,238,73,206,45,244,133], close_unclaimed: [135,84,89,188,21,253,76,199], close_unresolved: [188,151,187,234,237,137,152,197], resolve_claim: [63,99,216,44,183,52,190,140], payout: [149,140,194,236,174,189,6,239],
} as const;
function instruction(name: keyof typeof discriminators, accounts: { address: Address; role: AccountRole }[], args: Uint8Array[] = []): Instruction {
  return { programAddress: address(SHARES_PROGRAM_ID), accounts, data: concat([Uint8Array.from(discriminators[name]), ...args]) };
}
export async function initializeSharesInstruction(input: { payer: string; priceUsdE6: Atomic; publishedAt: Atomic }) {
  if (input.payer !== SHARES_INITIALIZER) throw new Error('Only the deployment initializer may create shares');
  const a = await sharesAddresses();
  return instruction('initialize_shares', [meta(input.payer, WS), meta(a.shareMint, W), meta(a.price, W), meta(a.faucetBudget, W), meta(SOLANA_IDS.token), meta(SOLANA_IDS.system), meta(RENT)], [u64(input.priceUsdE6), i64(input.publishedAt)]);
}
export async function faucetInstruction(input: { payer: string; owner: string; issuer: string; destination: string }) {
  if (input.issuer !== SHARES_PRICE_AUTHORITY) throw new Error('The hosted issuer must co-sign the share faucet');
  const a = await sharesAddresses();
  return instruction('faucet', [meta(input.payer, WS), meta(input.owner, S), meta(input.issuer, S), meta(a.shareMint, W), meta(await faucetCooldownAddress(a.shareMint, input.owner), W), meta(input.destination, W), meta(a.faucetBudget, W), meta(SOLANA_IDS.token), meta(SOLANA_IDS.system)]);
}
export async function setPriceInstruction(input: { authority: string; priceUsdE6: Atomic; publishedAt: Atomic }) {
  if (input.authority !== SHARES_PRICE_AUTHORITY) throw new Error('Wrong price authority');
  const a = await sharesAddresses();
  return instruction('set_price', [meta(input.authority, S), meta(a.price, W), meta(a.shareMint)], [u64(input.priceUsdE6), i64(input.publishedAt)]);
}
export async function initializePoolInstruction(input: { payer: string }) {
  if (input.payer !== SHARES_INITIALIZER) throw new Error('Only the deployment initializer may create the pool');
  const a = await sharesAddresses();
  return instruction('initialize_pool', [meta(input.payer, WS), meta(a.shareMint), meta(SOLANA_TEST_USDC_MINT), meta(a.pool, W), meta(a.cashVault, W), meta(a.collateralVault, W), meta(SOLANA_IDS.token), meta(SOLANA_IDS.system), meta(RENT)]);
}
export type LendingAccounts = { payer: string; owner: string; cashAccount: string; shareAccount: string; borrower?: string; receiver?: string };
export type LendingAction = { kind: 'lend' | 'withdraw_lending' | 'deposit_collateral' | 'withdraw_collateral' | 'borrow'; amount: Atomic } | { kind: 'redeem_lending'; shares: Atomic } | { kind: 'repay'; maxAmount: Atomic } | { kind: 'liquidate'; maxRepay: Atomic } | { kind: 'realize_bad_debt' };
export async function buildLendingInstruction(input: LendingAccounts & { action: LendingAction }): Promise<Instruction> {
  const a = await sharesAddresses(), action = input.action;
  if (input.borrower && action.kind !== 'liquidate' && action.kind !== 'realize_bad_debt' && input.borrower !== input.owner) throw new Error('Borrower override only allowed for liquidation or bad debt');
  if (input.receiver && action.kind !== 'lend') throw new Error('Position receiver only allowed for lending');
  if (input.receiver && input.borrower) throw new Error('Choose only one position receiver');
  const positionOwner = input.receiver ?? input.borrower ?? input.owner;
  const position = await loanPositionAddress(a.pool, positionOwner);
  const args = 'amount' in action ? [u64(action.amount)] : action.kind === 'redeem_lending' ? [integer(action.shares, 128)] : action.kind === 'repay' ? [u64(action.maxAmount)] : action.kind === 'liquidate' ? [u64(action.maxRepay)] : [];
  return instruction(action.kind, [meta(input.payer, WS), meta(input.owner, S), meta(a.pool, W), meta(position, W), meta(positionOwner), meta(input.cashAccount, W), meta(input.shareAccount, W), meta(a.cashVault, W), meta(a.collateralVault, W), meta(a.price), meta(SOLANA_IDS.token), meta(SOLANA_IDS.system)], args);
}
export const lendInstruction = (i: LendingAccounts & { amount: Atomic }) => buildLendingInstruction({ ...i, action: { kind: 'lend', amount: i.amount } });
export const withdrawLendingInstruction = (i: LendingAccounts & { amount: Atomic }) => buildLendingInstruction({ ...i, action: { kind: 'withdraw_lending', amount: i.amount } });
export const redeemLendingInstruction = (i: LendingAccounts & { shares: Atomic }) => buildLendingInstruction({ ...i, action: { kind: 'redeem_lending', shares: i.shares } });
export const depositCollateralInstruction = (i: LendingAccounts & { amount: Atomic }) => buildLendingInstruction({ ...i, action: { kind: 'deposit_collateral', amount: i.amount } });
export const withdrawCollateralInstruction = (i: LendingAccounts & { amount: Atomic }) => buildLendingInstruction({ ...i, action: { kind: 'withdraw_collateral', amount: i.amount } });
export const borrowInstruction = (i: LendingAccounts & { amount: Atomic }) => buildLendingInstruction({ ...i, action: { kind: 'borrow', amount: i.amount } });
export const repayInstruction = (i: LendingAccounts & { maxAmount: Atomic }) => buildLendingInstruction({ ...i, action: { kind: 'repay', maxAmount: i.maxAmount } });
export const liquidateInstruction = (i: LendingAccounts & { borrower: string; maxRepay: Atomic }) => buildLendingInstruction({ ...i, action: { kind: 'liquidate', maxRepay: i.maxRepay } });
export const realizeBadDebtInstruction = (i: LendingAccounts & { borrower: string }) => buildLendingInstruction({ ...i, action: { kind: 'realize_bad_debt' } });
export async function accrueInstruction() { return instruction('accrue', [meta((await sharesAddresses()).pool, W)]); }

export async function initializeShareEscrowInstruction(input: { payer: string; landlord: string; tenant: string; arbitrator: string; agreementHash: Uint8Array; depositValue: Atomic; responseWindow: Atomic; returnWindow: Atomic; arbitrationWindow: Atomic }) {
  const a = await sharesAddresses(), e = await shareEscrowAddresses(input.landlord, input.agreementHash);
  return instruction('initialize_escrow', [meta(input.payer, WS), meta(input.landlord, S), meta(a.shareMint), meta(e.escrow, W), meta(e.vault, W), meta(SOLANA_IDS.token), meta(SOLANA_IDS.system), meta(RENT)], [hash32(input.agreementHash), keyBytes(input.tenant), keyBytes(input.arbitrator), u64(input.depositValue), i64(input.responseWindow), i64(input.returnWindow), i64(input.arbitrationWindow)]);
}
export type ShareEscrowAccounts = { authority: string; landlord: string; agreementHash: Uint8Array; shareAccount: string };
export type ShareEscrowAction = { kind: 'pledge' | 'withdraw'; amount: Atomic } | { kind: 'propose_claim'; usd6: Atomic; evidenceHash: Uint8Array } | { kind: 'accept_claim'; maxShares: Atomic } | { kind: 'lower_claim'; usd6: Atomic } | { kind: 'resolve_claim'; shares: Atomic } | { kind: 'payout'; toLandlord: boolean } | { kind: 'activate' | 'contest_claim' | 'escalate_claim' | 'request_return' | 'close_unclaimed' | 'close_unresolved' };
export async function buildShareEscrowInstruction(input: ShareEscrowAccounts & { action: ShareEscrowAction }) {
  const a = await sharesAddresses(), e = await shareEscrowAddresses(input.landlord, input.agreementHash), action = input.action;
  const args = 'amount' in action ? [u64(action.amount)] : action.kind === 'propose_claim' ? [u64(action.usd6), hash32(action.evidenceHash)] : action.kind === 'accept_claim' ? [u64(action.maxShares)] : action.kind === 'lower_claim' ? [u64(action.usd6)] : action.kind === 'resolve_claim' ? [u64(action.shares)] : action.kind === 'payout' ? [Uint8Array.of(action.toLandlord ? 1 : 0)] : [];
  return instruction(action.kind, [meta(input.authority, S), meta(e.escrow, W), meta(a.shareMint), meta(e.vault, W), meta(input.shareAccount, W), meta(a.price), meta(SOLANA_IDS.token)], args);
}
export const pledgeInstruction = (i: ShareEscrowAccounts & { amount: Atomic }) => buildShareEscrowInstruction({ ...i, action: { kind: 'pledge', amount: i.amount } });
export const activateInstruction = (i: ShareEscrowAccounts) => buildShareEscrowInstruction({ ...i, action: { kind: 'activate' } });
export const withdrawInstruction = (i: ShareEscrowAccounts & { amount: Atomic }) => buildShareEscrowInstruction({ ...i, action: { kind: 'withdraw', amount: i.amount } });
export const proposeClaimInstruction = (i: ShareEscrowAccounts & { usd6: Atomic; evidenceHash: Uint8Array }) => buildShareEscrowInstruction({ ...i, action: { kind: 'propose_claim', usd6: i.usd6, evidenceHash: i.evidenceHash } });
export const acceptClaimInstruction = (i: ShareEscrowAccounts & { maxShares: Atomic }) => buildShareEscrowInstruction({ ...i, action: { kind: 'accept_claim', maxShares: i.maxShares } });
export const contestClaimInstruction = (i: ShareEscrowAccounts) => buildShareEscrowInstruction({ ...i, action: { kind: 'contest_claim' } });
export const escalateClaimInstruction = (i: ShareEscrowAccounts) => buildShareEscrowInstruction({ ...i, action: { kind: 'escalate_claim' } });
export const lowerClaimInstruction = (i: ShareEscrowAccounts & { usd6: Atomic }) => buildShareEscrowInstruction({ ...i, action: { kind: 'lower_claim', usd6: i.usd6 } });
export const requestReturnInstruction = (i: ShareEscrowAccounts) => buildShareEscrowInstruction({ ...i, action: { kind: 'request_return' } });
export const closeUnclaimedInstruction = (i: ShareEscrowAccounts) => buildShareEscrowInstruction({ ...i, action: { kind: 'close_unclaimed' } });
export const closeUnresolvedInstruction = (i: ShareEscrowAccounts) => buildShareEscrowInstruction({ ...i, action: { kind: 'close_unresolved' } });
export const resolveClaimInstruction = (i: ShareEscrowAccounts & { shares: Atomic }) => buildShareEscrowInstruction({ ...i, action: { kind: 'resolve_claim', shares: i.shares } });
export const payoutInstruction = (i: ShareEscrowAccounts & { toLandlord: boolean }) => buildShareEscrowInstruction({ ...i, action: { kind: 'payout', toLandlord: i.toLandlord } });

const accountDiscriminators = { Price: [50,107,127,61,83,36,39,75], Pool: [241,154,109,4,17,177,109,188], LoanPosition: [45,172,28,194,82,206,243,190], FaucetCooldown: [58,136,209,19,147,153,46,41], FaucetBudget: [233,200,88,46,53,124,156,42], Escrow: [31,213,123,187,186,22,218,155] } as const;
function reader(bytes: Uint8Array, kind: keyof typeof accountDiscriminators, size: number) {
  if (bytes.length !== size || !accountDiscriminators[kind].every((n, i) => bytes[i] === n)) throw new Error(`Invalid ${kind} account`);
  let offset = 8;
  const take = (n: number) => { const b = bytes.slice(offset, offset + n); offset += n; return b; };
  const number = (bits: number, signed = false) => { const b = take(bits / 8); let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return signed && (b[b.length - 1] & 128) !== 0 ? n - (1n << BigInt(bits)) : n; };
  return { key: () => getAddressDecoder().decode(take(32)), hash: () => take(32), u64: () => number(64), i64: () => number(64, true), u128: () => number(128), i128: () => number(128, true), byte: () => take(1)[0], bool: () => { const b = take(1)[0]; if (b > 1) throw new Error('Invalid boolean'); return b === 1; } };
}
export function decodePrice(bytes: Uint8Array) { const r = reader(bytes, 'Price', 113); return { authority: r.key(), shareMint: r.key(), priceUsdE6: r.u64(), publishedAt: r.i64(), copiedAt: r.i64(), initialPriceUsdE6: r.u64(), initialPublishedAt: r.i64(), bump: r.byte() }; }
export function decodePool(bytes: Uint8Array): SharesPool { const r = reader(bytes, 'Pool', 161); return { shareMint: r.key(), cashMint: r.key(), cash: r.u64(), totalSupply: r.u128(), totalBorrowAssets: r.u64(), totalBorrowShares: r.u128(), totalCollateral: r.u64(), lastAccrual: r.i64(), interestRemainder: r.u128(), debtExposureCap: r.u64(), bump: r.byte() }; }
export function decodeLoanPosition(bytes: Uint8Array) { const r = reader(bytes, 'LoanPosition', 129); return { pool: r.key(), owner: r.key(), balance: r.u128(), netContributed: r.i128(), collateral: r.u64(), borrowShares: r.u128(), bump: r.byte() }; }
export function decodeFaucetCooldown(bytes: Uint8Array) { const r = reader(bytes, 'FaucetCooldown', 49); return { owner: r.key(), lastClaim: r.i64(), bump: r.byte() }; }
export function decodeFaucetBudget(bytes: Uint8Array) { const r = reader(bytes, 'FaucetBudget', 73); return { shareMint: r.key(), day: r.i64(), mintedToday: r.u64(), totalMinted: r.u64(), dailyLimit: r.u64(), bump: r.byte() }; }
export const SHARE_ESCROW_STATES = ['awaiting-lock', 'active', 'claim-pending', 'claim-contested', 'closed'] as const;
export function decodeShareEscrow(bytes: Uint8Array) {
  const r = reader(bytes, 'Escrow', 308);
  const tenant = r.key(), landlord = r.key(), arbitrator = r.key(), shareMint = r.key(), agreementHash = r.hash(), depositValue = r.u64();
  const responseWindow = r.i64(), returnWindow = r.i64(), arbitrationWindow = r.i64(), responseDeadline = r.i64(), returnDeadline = r.i64(), arbitrationStartedAt = r.i64(), arbitrationAuthorized = r.bool(), stateIndex = r.byte();
  const state = SHARE_ESCROW_STATES[stateIndex]; if (!state) throw new Error('Invalid escrow state');
  return { tenant, landlord, arbitrator, shareMint, agreementHash, depositValue, responseWindow, returnWindow, arbitrationWindow, responseDeadline, returnDeadline, arbitrationStartedAt, arbitrationAuthorized, state, trackedBalance: r.u64(), landlordOwed: r.u64(), claimUsd6: r.u64(), claimShares: r.u64(), claimEvidenceHash: r.hash(), claimPrice6: r.u64(), claimSourceTime: r.i64(), bump: r.byte(), vaultBump: r.byte() };
}
export type SharesPrice = { authority: string; shareMint: string; priceUsdE6: bigint; publishedAt: bigint; copiedAt: bigint; initialPriceUsdE6: bigint; initialPublishedAt: bigint; bump: number };
export type SharesPool = { shareMint: string; cashMint: string; cash: bigint; totalSupply: bigint; totalBorrowAssets: bigint; totalBorrowShares: bigint; totalCollateral: bigint; lastAccrual: bigint; interestRemainder: bigint; debtExposureCap: bigint; bump: number };
export type LoanPosition = { pool: string; owner: string; balance: bigint; netContributed: bigint; collateral: bigint; borrowShares: bigint; bump: number };
export type FaucetCooldown = { owner: string; lastClaim: bigint; bump: number };
export type FaucetBudget = { shareMint: string; day: bigint; mintedToday: bigint; totalMinted: bigint; dailyLimit: bigint; bump: number };
export type SharesInitialization = { shareMint: string; cashMint: string; priceAuthority: string; initialPriceUsdE6: string; initialPricePublishedAt: string; dailyFaucetBudgetAtomic: string; debtExposureCapAtomic: string };
export function verifySharesInitialization(manifest: SharesInitialization, price: SharesPrice, pool: SharesPool, budget: FaucetBudget) {
  if (price.authority !== SHARES_PRICE_AUTHORITY || price.authority !== manifest.priceAuthority || price.shareMint !== manifest.shareMint || pool.shareMint !== manifest.shareMint || pool.cashMint !== manifest.cashMint || budget.shareMint !== manifest.shareMint) throw new Error('Shares initialization identities do not match the manifest');
  if (price.initialPriceUsdE6 !== BigInt(manifest.initialPriceUsdE6) || price.initialPublishedAt !== BigInt(manifest.initialPricePublishedAt)) throw new Error('Stored initial price does not match the manifest');
  if (budget.dailyLimit !== DAILY_FAUCET_BUDGET || budget.dailyLimit !== BigInt(manifest.dailyFaucetBudgetAtomic) || pool.debtExposureCap !== DEBT_EXPOSURE_CAP || pool.debtExposureCap !== BigInt(manifest.debtExposureCapAtomic)) throw new Error('Shares issuance or exposure limit does not match the manifest');
}
export function faucetBudgetRemaining(budget: FaucetBudget, now: bigint) {
  if (now < 0n) throw new Error('Invalid timestamp');
  return budget.day !== now / 86_400n ? budget.dailyLimit : budget.mintedToday >= budget.dailyLimit ? 0n : budget.dailyLimit - budget.mintedToday;
}
export type ShareEscrow = { tenant: string; landlord: string; arbitrator: string; shareMint: string; agreementHash: Uint8Array; depositValue: bigint; responseWindow: bigint; returnWindow: bigint; arbitrationWindow: bigint; responseDeadline: bigint; returnDeadline: bigint; arbitrationStartedAt: bigint; arbitrationAuthorized: boolean; state: typeof SHARE_ESCROW_STATES[number]; trackedBalance: bigint; landlordOwed: bigint; claimUsd6: bigint; claimShares: bigint; claimEvidenceHash: Uint8Array; claimPrice6: bigint; claimSourceTime: bigint; bump: number; vaultBump: number };
export function mulDiv(a: bigint, b: bigint, d: bigint) { if (a < 0n || b < 0n || d <= 0n) throw new Error('Invalid quote operands'); return a * b / d; }
export function mulDivUp(a: bigint, b: bigint, d: bigint) { const floor = mulDiv(a, b, d); return floor + (a * b % d === 0n ? 0n : 1n); }
export function shareValue(amount: bigint, priceUsdE6: bigint) { return mulDiv(amount, priceUsdE6, SHARE_SCALE); }
export function claimShares(usd6: bigint, priceUsdE6: bigint) { return mulDivUp(usd6, SHARE_SCALE, priceUsdE6); }
export function quoteClaimShares(usd6: bigint, priceUsdE6: bigint, vaultBalance: bigint) { return min(claimShares(usd6, priceUsdE6), vaultBalance); }
export function lowerClaimShares(usd6: bigint, storedPriceUsdE6: bigint, previousShares: bigint) { return min(mulDiv(usd6, SHARE_SCALE, storedPriceUsdE6), previousShares); }
export function requiredCoverShares(usd6: bigint, priceUsdE6: bigint) { return mulDivUp(usd6, 15_000n * SHARE_SCALE, priceUsdE6 * 10_000n); }
export function priceMaxAge(now: bigint) { if (now < 0n) throw new Error('Invalid timestamp'); const weekday = (now / 86_400n + 4n) % 7n; return weekday === 6n || weekday === 0n || (weekday === 1n && now % 86_400n < 43_200n) ? 74n * 3600n : 26n * 3600n; }
export function isPriceFresh(price: SharesPrice, now: bigint) { return price.priceUsdE6 > 0n && price.publishedAt > 0n && price.publishedAt <= now && now - price.publishedAt <= priceMaxAge(now); }
export function faucetAvailableAt(cooldown: FaucetCooldown | null) { return cooldown ? cooldown.lastClaim + FAUCET_COOLDOWN_SECONDS : 0n; }
export function compoundedGrowth(elapsed: bigint) {
  if (elapsed < 0n) throw new Error('Accrual timestamp precedes pool');
  let exponent = mulDiv(elapsed, 500n * RAY, 365n * 86_400n * 10_000n), squares = 0;
  while (exponent > RAY / 2n) { exponent /= 2n; squares++; }
  let term = RAY, sum = RAY;
  for (let i = 1n; i <= 28n; i++) { term = mulDiv(term, exponent, RAY * i); if (term === 0n) break; sum += term; }
  for (let i = 0; i < squares; i++) sum = mulDiv(sum, sum, RAY);
  return sum - RAY;
}
export function pendingDebt(pool: SharesPool, now: bigint) {
  const elapsed = now - pool.lastAccrual; if (elapsed < 0n) throw new Error('Accrual timestamp precedes pool');
  if (pool.totalBorrowAssets === 0n) return { assets: 0n, remainder: 0n };
  if (elapsed === 0n) return { assets: pool.totalBorrowAssets, remainder: pool.interestRemainder };
  const growth = compoundedGrowth(elapsed), interest = mulDiv(pool.totalBorrowAssets, growth, RAY), fraction = pool.totalBorrowAssets * growth % RAY + mulDiv(pool.interestRemainder, RAY + growth, RAY);
  return { assets: pool.totalBorrowAssets + interest + fraction / RAY, remainder: fraction % RAY };
}
export function totalAssets(pool: SharesPool, now: bigint) { return pool.cash + pendingDebt(pool, now).assets; }
export function previewDeposit(pool: SharesPool, assets: bigint, now: bigint) { return mulDiv(assets, pool.totalSupply + SHARE_VIRTUAL_OFFSET, totalAssets(pool, now) + 1n); }
export function previewRedeem(pool: SharesPool, shares: bigint, now: bigint) { return mulDiv(shares, totalAssets(pool, now) + 1n, pool.totalSupply + SHARE_VIRTUAL_OFFSET); }
export function previewWithdraw(pool: SharesPool, assets: bigint, now: bigint) { return mulDivUp(assets, pool.totalSupply + SHARE_VIRTUAL_OFFSET, totalAssets(pool, now) + 1n); }
export function maxWithdraw(pool: SharesPool, position: LoanPosition, now: bigint) { return min(pool.cash, previewRedeem(pool, position.balance, now)); }
const min = (...values: bigint[]) => values.reduce((a, b) => a < b ? a : b);
export function borrowerDebt(pool: SharesPool, shares: bigint, now: bigint) { return shares === 0n ? 0n : mulDivUp(shares, pendingDebt(pool, now).assets, pool.totalBorrowShares); }
export function previewBorrow(pool: SharesPool, amount: bigint, now: bigint) { return pool.totalBorrowShares === 0n ? amount * SHARE_VIRTUAL_OFFSET : mulDivUp(amount, pool.totalBorrowShares, pendingDebt(pool, now).assets); }
export function previewRepay(pool: SharesPool, owned: bigint, cap: bigint, now: bigint) {
  const assets = pendingDebt(pool, now).assets, debt = borrowerDebt(pool, owned, now);
  if (owned === 0n || cap <= 0n) throw new Error('Invalid repayment');
  const shares = cap >= debt ? owned : mulDiv(cap, pool.totalBorrowShares, assets);
  if (shares === 0n) throw new Error('Repayment rounds to zero shares');
  return { shares, assets: mulDivUp(shares, assets, pool.totalBorrowShares), removed: mulDiv(shares, assets, pool.totalBorrowShares) };
}
export function quoteBorrowPosition(pool: SharesPool, position: LoanPosition, price: SharesPrice, now: bigint) {
  const borrowed = pendingDebt(pool, now).assets, debt = borrowerDebt(pool, position.borrowShares, now), value = shareValue(position.collateral, price.priceUsdE6), priceFresh = isPriceFresh(price, now), limit = mulDiv(value, 5000n, 10_000n), utilizationLimit = mulDiv(pool.cash + borrowed, 9000n, 10_000n);
  return { collateral: position.collateral, debt, value, ltvBps: value === 0n ? (debt === 0n ? 0n : null) : mulDivUp(debt, 10_000n, value), priceFresh, borrowable: priceFresh && limit > debt && utilizationLimit > borrowed && pool.debtExposureCap > borrowed ? min(limit - debt, pool.cash, utilizationLimit - borrowed, pool.debtExposureCap - borrowed) : 0n };
}
export function previewLiquidation(pool: SharesPool, position: LoanPosition, maxRepay: bigint, price: SharesPrice, now: bigint) {
  if (!isPriceFresh(price, now) || maxRepay <= 0n) throw new Error('Invalid liquidation price or amount');
  const debt = borrowerDebt(pool, position.borrowShares, now), value = shareValue(position.collateral, price.priceUsdE6);
  if (debt === 0n || debt < mulDivUp(value, 8000n, 10_000n)) throw new Error('Position is not liquidatable');
  const collateralCap = mulDiv(value, 10_000n, 11_000n), cap = min(maxRepay, debt / 2n, collateralCap);
  const repayment = collateralCap === 0n ? { shares: 0n, assets: 0n, removed: 0n } : previewRepay(pool, position.borrowShares, cap, now);
  let seized = min(position.collateral, mulDivUp(repayment.assets, 11_000n * SHARE_SCALE, price.priceUsdE6 * 10_000n));
  if (cap === collateralCap && maxRepay >= collateralCap && debt / 2n >= collateralCap) seized = position.collateral;
  return { ...repayment, seized, realizesBadDebt: seized === position.collateral };
}

export function quoteShareCover(escrow: ShareEscrow, price: SharesPrice, now: bigint) {
  const value = shareValue(escrow.trackedBalance, price.priceUsdE6);
  const requiredShares = requiredCoverShares(escrow.depositValue, price.priceUsdE6);
  return { value, requiredShares, topUpShares: requiredShares > escrow.trackedBalance ? requiredShares - escrow.trackedBalance : 0n, belowTopUpThreshold: value * 10_000n < escrow.depositValue * 12_500n, priceFresh: isPriceFresh(price, now) };
}

export function quoteLendingMarket(pool: SharesPool, price: SharesPrice, now: bigint) {
  const borrowed = pendingDebt(pool, now).assets, assets = pool.cash + borrowed;
  return { cash: pool.cash, assets, borrowed, utilizationBps: assets === 0n ? 0n : mulDiv(borrowed, 10_000n, assets), borrowAprBps: 500n, supplyAprBps: assets === 0n ? 0n : mulDiv(500n, borrowed, assets), effectiveBorrowApyBps: 513n, price: price.priceUsdE6, priceUpdatedAt: price.publishedAt, priceFresh: isPriceFresh(price, now) };
}
