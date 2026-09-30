import assert from 'node:assert/strict';
import test from 'node:test';
import { address, type Address as SolanaAddress, type Rpc, type SolanaRpcApi } from '@solana/kit';
import { AccountState, TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda, getMintEncoder, getTokenEncoder } from '@solana-program/token-2022';
import { getAddress, type Address } from 'viem';
import { readPortfolioPosition } from './portfolio.ts';
import { ROBINHOOD_TESTNET, robinhoodHoldings } from './robinhood-demo.ts';

const owner = getAddress('0x1111111111111111111111111111111111111111');
const shareScale = 1_000_000_000_000_000_000n;

test('official balances survive an undeployed mirror without acquiring a false stock value', async () => {
  const rpc = {
    readContract: async ({ address }: { address: Address }) => address === ROBINHOOD_TESTNET.tsla ? 2n * shareScale : 875_000_000n,
    getBalance: async () => 2_000_000_000_000_000n,
  } as unknown as NonNullable<Parameters<typeof robinhoodHoldings>[1]>;
  const noMirror = (async () => ({ price: null, priceAtomic: null })) as unknown as Parameters<typeof robinhoodHoldings>[2];
  const holdings = await robinhoodHoldings(owner, rpc, noMirror);
  assert.equal(holdings.testUsdAtomic, '875000000');
  assert.equal(holdings.tslaRaw, (2n * shareScale).toString());
  assert.equal(holdings.tslaShares, 2);
  assert.ok('status' in holdings && holdings.status === 'price_unavailable');
  assert.ok(!('tslaValueUsd' in holdings));
});

test('official wallet shares use the copied token price and reject stale valuation', async () => {
  const rpc = {
    readContract: async ({ address }: { address: Address }) => address === ROBINHOOD_TESTNET.tsla ? 2n * shareScale : 875_000_000n,
    getBalance: async () => 2_000_000_000_000_000n,
  } as unknown as NonNullable<Parameters<typeof robinhoodHoldings>[1]>;
  const mirrored = (async () => ({ priceAtomic: '354385000', price: { sourceUpdatedAt: 1_790_000_000, stale: false } })) as unknown as Parameters<typeof robinhoodHoldings>[2];
  const holdings = await robinhoodHoldings(owner, rpc, mirrored);
  assert.ok(!('status' in holdings));
  if ('status' in holdings) throw new Error('Missing mirror valuation');
  assert.equal(holdings.tslaValueUsd, 708.77);
  assert.equal(holdings.referencePriceUsd, 354.385);
  const stale = (async () => ({ priceAtomic: '354385000', price: { sourceUpdatedAt: 1_790_000_000, stale: true } })) as unknown as Parameters<typeof robinhoodHoldings>[2];
  const unavailable = await robinhoodHoldings(owner, rpc, stale);
  assert.ok('status' in unavailable && unavailable.status === 'price_unavailable');
  assert.ok(!('tslaValueUsd' in unavailable));
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
