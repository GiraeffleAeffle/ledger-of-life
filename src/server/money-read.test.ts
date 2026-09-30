import assert from 'node:assert/strict';
import test from 'node:test';
import { address, type Address as SolanaAddress, type Rpc, type SolanaRpcApi } from '@solana/kit';
import { AccountState, TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda, getMintEncoder, getTokenEncoder } from '@solana-program/token-2022';
import { getAddress, type Address } from 'viem';
import { readShareOverview } from './share-earnings.ts';
import { readShareWorkflows } from './share-workflows.ts';
import { readPortfolioPosition } from './portfolio.ts';
import { ROBINHOOD_TESTNET, robinhoodHoldings } from './robinhood-demo.ts';
import { LocalStore } from './store.ts';

const owner = getAddress('0x1111111111111111111111111111111111111111');
const fakeStock = getAddress('0x2222222222222222222222222222222222222222');
const oracle = getAddress('0x3333333333333333333333333333333333333333');
const pool = getAddress('0x4444444444444444444444444444444444444444');
const escrow = getAddress('0x5555555555555555555555555555555555555555');
const shareScale = 1_000_000_000_000_000_000n;

test('isolated fake wallet, pledged and borrowed balances use the oracle, without a dependency on the base desk', async () => {
  const store = new LocalStore(':memory:');
  try {
    await store.create(`share-workflows:${owner.toLowerCase()}`, {
      status: 'ready', owner, stock: fakeStock, oracle, pool, escrow, depositAtomic: '1000000000',
      desk: ROBINHOOD_TESTNET.desk, basePriceAtomic: '1', transactions: [],
    });
    const queried: string[] = [];
    const rpc = { readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      queried.push(`${address}:${functionName}`);
      if (functionName === 'balanceOf') return address === fakeStock ? 2n * shareScale : 400_000_000n;
      if (functionName === 'latestPrice') return [2_000_000_000n, 1n];
      if (functionName === 'position') return [3n * shareScale, 2_000_000_000n, 6_000_000_000n, 3333n, 24000n];
      const escrowValues: Record<string, bigint> = { state: 1n, stockHeld: shareScale, cashHeld: 500_000_000n, shortfallDeadline: 0n, claimAmount: 0n };
      if (address === escrow && functionName in escrowValues) return escrowValues[functionName];
      throw new Error(`Unexpected read ${functionName}`);
    } } as unknown as NonNullable<Parameters<typeof readShareWorkflows>[2]>;
    const result = await readShareOverview(store, owner, rpc);
    assert.equal(result.fakeStock?.walletRaw, (2n * shareScale).toString());
    assert.equal(result.sharesRaw, (2n * shareScale).toString());
    assert.equal(result.testUsdAtomic, '400000000');
    assert.equal(result.deposit?.valueAtomic, '2500000000');
    assert.equal(result.deposit?.bufferAtomic, '1250000000');
    assert.equal(result.loan?.sharesRaw, (3n * shareScale).toString());
    assert.equal(result.loan?.debtAtomic, '2000000000');
    assert.equal(result.loan?.availableAtomic, '1000000000');
    assert.equal(result.priceAtomic, '2000000000');
    assert.equal(result.earnings, null);
    assert.equal(result.earningsError, null);
    assert.ok(!queried.includes(`${ROBINHOOD_TESTNET.desk}:price`));
    assert.ok(!queried.includes(`${ROBINHOOD_TESTNET.tsla}:balanceOf`));
  } finally { await store.close(); }
});

test('older workflow contracts retain official test TSLA pledge and debt without inventing fake shares', async () => {
  const store = new LocalStore(':memory:');
  try {
    await store.create(`share-workflows:${owner.toLowerCase()}`, {
      status: 'ready', owner, oracle, pool, escrow, desk: ROBINHOOD_TESTNET.desk,
      depositAtomic: '1000000000', basePriceAtomic: '1000000000', transactions: [],
    });
    const rpc = { readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      if (functionName === 'balanceOf') return address === ROBINHOOD_TESTNET.tsla ? 5n * shareScale : 1_000_000n;
      if (functionName === 'latestPrice') return [1_000_000_000n, 1n];
      if (functionName === 'position') return [2n * shareScale, 500_000_000n, 2_000_000_000n, 2500n, 32000n];
      const deposited: Record<string, bigint> = { state: 1n, stockHeld: shareScale, cashHeld: 0n, shortfallDeadline: 0n, claimAmount: 0n };
      if (address === escrow && functionName in deposited) return deposited[functionName];
      throw new Error(`Unexpected read ${functionName}`);
    } } as unknown as NonNullable<Parameters<typeof readShareWorkflows>[2]>;
    const result = await readShareOverview(store, owner, rpc);
    assert.equal(result.stockSymbol, 'official test TSLA');
    assert.equal(result.fakeStock, null);
    assert.equal(result.sharesRaw, (5n * shareScale).toString());
    assert.equal(result.deposit?.sharesRaw, shareScale.toString());
    assert.equal(result.loan?.sharesRaw, (2n * shareScale).toString());
    assert.equal(result.loan?.debtAtomic, '500000000');
  } finally { await store.close(); }
});

test('earnings read failure preserves wallet and contract positions but does not claim earnings are absent', async () => {
  const store = new LocalStore(':memory:');
  try {
    await store.create(`share-earnings:${owner.toLowerCase()}`, { status: 'ready', escrow, transactionHashes: [] });
    const rpc = { readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      if (address === ROBINHOOD_TESTNET.tsla && functionName === 'balanceOf') return 3n * shareScale;
      if (address === ROBINHOOD_TESTNET.usd && functionName === 'balanceOf') return 123_000_000n;
      if (functionName === 'price') return 200_000_000n;
      throw new Error('Unexpected contract read');
    } } as unknown as NonNullable<Parameters<typeof readShareWorkflows>[2]>;
    const earningsRpc = { readContract: async () => { throw new Error('Earnings escrow RPC unavailable'); } } as unknown as NonNullable<Parameters<typeof readShareOverview>[3]>;
    const workflow = await readShareOverview(store, owner, rpc, earningsRpc);
    assert.equal(workflow.sharesRaw, (3n * shareScale).toString());
    assert.equal(workflow.testUsdAtomic, '123000000');
    assert.equal(workflow.earnings, null);
    assert.equal(workflow.earningsError, 'Earnings escrow RPC unavailable');
  } finally { await store.close(); }
});

test('failed workflow RPC read rejects instead of displaying a zero share holding', async () => {
  const store = new LocalStore(':memory:');
  try {
    const rpc = { readContract: async () => { throw new Error('RPC quota exceeded'); } } as unknown as NonNullable<Parameters<typeof readShareWorkflows>[2]>;
    await assert.rejects(readShareOverview(store, owner, rpc), /RPC quota exceeded/);
  } finally { await store.close(); }
});

test('Robinhood official balances remain available without a Jupiter quote, but never acquire a false stock value', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('Rate limit', { status: 429 });
  try {
    const rpc = {
      readContract: async ({ address }: { address: Address }) => address === ROBINHOOD_TESTNET.tsla ? 2n * shareScale : 875_000_000n,
      getBalance: async () => 2_000_000_000_000_000n,
    } as unknown as NonNullable<Parameters<typeof robinhoodHoldings>[1]>;
    const holdings = await robinhoodHoldings(owner, rpc);
    assert.equal(holdings.testUsdAtomic, '875000000');
    assert.equal(holdings.tslaRaw, (2n * shareScale).toString());
    assert.equal(holdings.tslaShares, 2);
    assert.ok('status' in holdings && holdings.status === 'price_unavailable');
    assert.ok(!('tslaValueUsd' in holdings));
  } finally { globalThis.fetch = original; }
});

const solOwner = address('11111111111111111111111111111111');
const stockMint = address('So11111111111111111111111111111111111111112');
const testUsdc = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const classic = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

async function solanaFixture(stockAmount: bigint, missingCash = false, failCash = false) {
  const [cashAta] = await findAssociatedTokenPda({ owner: solOwner, mint: testUsdc, tokenProgram: classic });
  const [stockAta] = await findAssociatedTokenPda({ owner: solOwner, mint: stockMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const token = (mint: SolanaAddress, amount: bigint) => getTokenEncoder().encode({
    mint, owner: solOwner, amount, delegate: null, state: AccountState.Initialized,
    isNative: null, delegatedAmount: 0n, closeAuthority: null, extensions: null,
  });
  const mint = getMintEncoder().encode({ mintAuthority: null, supply: stockAmount, decimals: 8,
    isInitialized: true, freezeAuthority: null, extensions: null });
  const rpc = { getAccountInfo: (account: typeof cashAta) => ({ send: async () => {
    if (account === cashAta && failCash) throw new Error('Devnet RPC quota exceeded');
    if (account === cashAta && missingCash) return { value: null };
    const data = account === cashAta ? token(testUsdc, 750_000_000n)
      : account === stockAta ? token(stockMint, stockAmount) : mint;
    return { value: { data: [Buffer.from(data).toString('base64'), 'base64'], executable: false,
      lamports: 1n, owner: account === cashAta ? classic : TOKEN_2022_PROGRAM_ADDRESS, space: data.length } };
  } }) } as unknown as Rpc<SolanaRpcApi>;
  return rpc;
}

test('a cold Jupiter outage retains actual Solana cash and share amounts without valuation', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('Rate limit', { status: 429 });
  try {
    const result = await readPortfolioPosition(await solanaFixture(250_000_000n), solOwner, stockMint);
    assert.equal(result.testUsdcAtomic, '750000000');
    assert.equal(result.rawAtomic, '250000000');
    assert.equal(result.shares, 2.5);
    assert.equal(result.valueUsd, null);
    assert.equal(result.referencePriceUsd, null);
    assert.ok('status' in result && result.status === 'price_unavailable');
    const noShares = await readPortfolioPosition(await solanaFixture(0n, true), solOwner, stockMint);
    assert.equal(noShares.testUsdcAtomic, '0');
    assert.equal(noShares.shares, 0);
    assert.equal(noShares.valueUsd, null);
    await assert.rejects(readPortfolioPosition(await solanaFixture(0n, false, true), solOwner, stockMint), /Devnet RPC quota exceeded/);
  } finally { globalThis.fetch = original; }
});
