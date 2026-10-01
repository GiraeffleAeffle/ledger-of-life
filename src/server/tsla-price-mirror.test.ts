import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, keccak256, parseAbi, parseTransaction, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { LocalStore } from './store.ts';
import { priceFreshnessSeconds, reconcileTslaPrice } from './tsla-price-mirror.ts';

const privateKey = `0x${'31'.repeat(32)}` as Hex;
const updater = privateKeyToAccount(privateKey);
const feed = '0x1111111111111111111111111111111111111111' as const;
const now = Date.parse('2026-09-30T12:00:00Z') / 1000;
const missing = () => { const error = new Error('not found'); error.name = 'TransactionReceiptNotFoundError'; return error; };
type FixtureState = { rawAnswer: bigint; sourceChain: number; testChain: number; previousAnswer: bigint; pushedAt: bigint; initialAnswer: bigint; round: bigint; mirrored: bigint; paused: boolean; oraclePaused: boolean; multiplier: bigint; testMultiplier: bigint; updatedAt: bigint; price: number; referenceStale: boolean; referenceMissing: boolean; pauseUnavailable: boolean; waitFailure: boolean; sends: Hex[] };
function fixture() {
  const state: FixtureState = { rawAnswer: 35_000_000_000n, sourceChain: 4663, testChain: 46630, previousAnswer: 34_000_000_000n, pushedAt: BigInt(now - 3600), initialAnswer: 35_000_000_000n, round: 2n, mirrored: 1n, paused: false, oraclePaused: false, multiplier: 10n ** 18n, testMultiplier: 10n ** 18n, updatedAt: BigInt(now - 60), price: 350, referenceStale: false, referenceMissing: false, pauseUnavailable: false, waitFailure: false, sends: [] };
  const readContract = async ({ address, functionName }: { address: string; functionName: string }) => {
    if (functionName === 'latestRoundData') {
      assert.equal(address.toLowerCase(), '0x4a1166a659a55625345e9515b32adecea5547c38');
      return [state.round, state.rawAnswer, state.updatedAt, state.updatedAt, state.round] as const;
    }
    assert.equal(address.toLowerCase(), '0x322f0929c4625ed5bad873c95208d54e1c003b2d', 'Only the Tesla token can supply multiplier and pause state.');
    if (functionName === 'uiMultiplier') return state.multiplier;
    if (functionName === 'paused') return state.paused;
    if (functionName === 'oraclePaused') { if (state.pauseUnavailable) throw new Error('pause RPC unavailable'); return state.oraclePaused; }
    throw new Error('unexpected read');
  };
  const rpc = {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'updater') return updater.address;
      if (functionName === 'uiMultiplier') return state.testMultiplier;
      if (functionName === 'initialAnswer') return state.initialAnswer;
      if (functionName === 'MAX_STEP_BPS') return 2000n;
      if (functionName === 'MIN_PUSH_INTERVAL') return 3600n;
      return [state.mirrored, state.previousAnswer, BigInt(now - 120), 10n ** 18n, state.pushedAt] as const;
    },
    getChainId: async () => state.testChain,
    getBlock: async () => ({ timestamp: BigInt(now) }),
    getTransactionCount: async () => 0,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 1n }),
    estimateGas: async () => 100_000n,
    getTransactionReceipt: async () => { throw missing(); },
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => { state.sends.push(serializedTransaction); return keccak256(serializedTransaction); },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => { if (state.waitFailure) throw new Error('unknown confirmation'); return { transactionHash: hash, status: 'success' }; },
  };
  const options = {
    environment: { ROBINHOOD_PRICE_UPDATER_PRIVATE_KEY: privateKey },
    loadManifest: async () => ({ chainId: 46630, feed }), now: () => now,
    mainnet: { readContract, getChainId: async () => state.sourceChain } as unknown as NonNullable<Parameters<typeof reconcileTslaPrice>[1]>['mainnet'],
    testnet: rpc as unknown as NonNullable<Parameters<typeof reconcileTslaPrice>[1]>['testnet'],
    reference: async () => { if (state.referenceMissing) throw new Error('Jupiter unavailable'); return { usdPrice: state.price, observedAt: new Date(now * 1000).toISOString(), stale: state.referenceStale }; },
  };
  return { state, options };
}

test('new primary round is journaled before broadcast with exact bounded testnet push', async () => {
  const store = new LocalStore(':memory:');
  try {
    const f = fixture();
    const result = await reconcileTslaPrice(store, f.options);
    assert.equal(result.status, 'pushed');
    assert.equal('crossCheck' in result && result.crossCheck, 'passed');
    assert.equal('sourceUpdatedAt' in result && result.sourceUpdatedAt, now - 60, 'the push reports the source round time for the job record');
    const tx = parseTransaction(f.state.sends[0]);
    assert.equal(tx.chainId, 46630);
    assert.equal(tx.to?.toLowerCase(), feed);
    assert.equal(tx.value ?? 0n, 0n);
    const call = decodeFunctionData({ abi: parseAbi(['function push(uint80,int256,uint256,uint256)']), data: tx.data! });
    assert.deepEqual(call.args, [2n, 35_000_000_000n, BigInt(now - 60), 10n ** 18n]);
    const journal = await store.get<{ state: string; step: { signed: Hex; hash: Hex } }>(`tsla-price-mirror:46630:${feed}`);
    assert.equal(journal?.state, 'done');
    assert.equal(journal?.step.signed, f.state.sends[0]);
    assert.equal(journal?.step.hash, keccak256(f.state.sends[0]));
  } finally { await store.close(); }
});

for (const [name, modify, reason] of [
  ['same round', (s: FixtureState) => { s.mirrored = s.round; }, 'same_or_older_round'],
  ['paused stock', (s: FixtureState) => { s.paused = true; }, 'source_paused'],
  ['paused oracle', (s: FixtureState) => { s.oraclePaused = true; }, 'source_paused'],
  ['invalid multiplier', (s: FixtureState) => { s.multiplier = 0n; }, 'invalid_multiplier'],
  ['stale source', (s: FixtureState) => { s.updatedAt = BigInt(now - 26 * 3600 - 1); }, 'stale_source_round'],
  ['fresh reference disagreement', (s: FixtureState) => { s.price = 300; }, 'reference_divergence'],
] as const) test(`skips ${name} without signing or broadcasting`, async () => {
  const store = new LocalStore(':memory:');
  try {
    const f = fixture(); modify(f.state);
    const result = await reconcileTslaPrice(store, f.options);
    assert.equal(result.status, 'skipped');
    assert.equal('reason' in result && result.reason, reason);
    assert.equal('sourceUpdatedAt' in result && result.sourceUpdatedAt, Number(f.state.updatedAt), 'a skip after reading the round reports which round it judged');
    assert.deepEqual(f.state.sends, []);
    assert.equal(await store.get(`tsla-price-mirror:46630:${feed}`), null);
  } finally { await store.close(); }
});

for (const crossCheck of ['stale', 'unavailable'] as const) test(`healthy primary fails closed when Jupiter is ${crossCheck}`, async () => {
  const store = new LocalStore(':memory:');
  try {
    const f = fixture(); f.state.referenceStale = crossCheck === 'stale'; f.state.referenceMissing = crossCheck === 'unavailable'; f.state.price = 1;
    const result = await reconcileTslaPrice(store, f.options);
    assert.equal(result.status, 'skipped');
    assert.equal('reason' in result && result.reason, `reference_${crossCheck}`);
    assert.deepEqual(f.state.sends, []);
    assert.equal(await store.get(`tsla-price-mirror:46630:${feed}`), null);
  } finally { await store.close(); }
});

test('missing key or manifest is unconfigured without any RPC call', async () => {
  const store = new LocalStore(':memory:');
  try {
    const f = fixture();
    f.options.testnet = { ...f.options.testnet!, readContract: async () => { throw new Error('must not read'); } };
    assert.equal((await reconcileTslaPrice(store, { ...f.options, environment: {} })).status, 'unconfigured');
    assert.equal((await reconcileTslaPrice(store, { ...f.options, loadManifest: async () => null })).status, 'unconfigured');
  } finally { await store.close(); }
});

test('unavailable pause check fails closed', async () => {
  const store = new LocalStore(':memory:');
  try {
    const f = fixture(); f.state.pauseUnavailable = true;
    const result = await reconcileTslaPrice(store, f.options);
    assert.equal(result.status, 'skipped');
    assert.equal('reason' in result && result.reason, 'source_read_unavailable');
    assert.deepEqual(f.state.sends, []);
  } finally { await store.close(); }
});

test('ambiguous confirmation recovers identical journaled bytes rather than a newer round', async () => {
  const store = new LocalStore(':memory:');
  try {
    const f = fixture(); f.state.waitFailure = true;
    await assert.rejects(reconcileTslaPrice(store, f.options), /unknown confirmation/);
    f.state.waitFailure = false; f.state.round = 3n;
    const result = await reconcileTslaPrice(store, f.options);
    assert.equal('sourceRoundId' in result && result.sourceRoundId, '2');
    assert.equal(f.state.sends[0], f.state.sends[1]);
  } finally { await store.close(); }
});

test('weekend freshness ends exactly Monday noon UTC', () => {
  assert.equal(priceFreshnessSeconds(Date.parse('2026-10-03T00:00:00Z') / 1000), 74 * 3600);
  assert.equal(priceFreshnessSeconds(Date.parse('2026-10-05T11:59:59Z') / 1000), 74 * 3600);
  assert.equal(priceFreshnessSeconds(Date.parse('2026-10-05T12:00:00Z') / 1000), 26 * 3600);
});

test('converts mainnet token basis to the test token basis, rounding down and recording provenance', async () => {
  const store = new LocalStore(':memory:');
  try {
    const f = fixture(); f.state.multiplier = 1_250_000_000_000_000_001n;
    f.state.previousAnswer = 28_000_000_000n; f.state.price = 280;
    const expected = 35_000_000_000n * 10n ** 18n / f.state.multiplier;
    const result = await reconcileTslaPrice(store, f.options);
    assert.equal(result.status, 'pushed');
    assert.equal('convertedAnswer' in result && result.convertedAnswer, expected.toString());
    assert.equal('rawMainnetAnswer' in result && result.rawMainnetAnswer, '35000000000');
    assert.equal('mainnetMultiplier' in result && result.mainnetMultiplier, f.state.multiplier.toString());
    assert.equal('testnetMultiplier' in result && result.testnetMultiplier, '1000000000000000000');
    const tx = parseTransaction(f.state.sends[0]);
    const call = decodeFunctionData({ abi: parseAbi(['function push(uint80,int256,uint256,uint256)']), data: tx.data! });
    assert.deepEqual(call.args, [2n, expected, BigInt(now - 60), 10n ** 18n]);
    const journal = await store.get<{ mainnetMultiplier: string; testnetMultiplier: string; rawMainnetAnswer: string }>(`tsla-price-mirror:46630:${feed}`);
    assert.equal(journal?.mainnetMultiplier, f.state.multiplier.toString());
    assert.equal(journal?.testnetMultiplier, '1000000000000000000');
    assert.equal(journal?.rawMainnetAnswer, '35000000000');
  } finally { await store.close(); }
});

test('test multiplier change during gas review skips before signing and releases the nonce lane', async () => {
  const store = new LocalStore(':memory:');
  try {
    const f = fixture();
    f.options.testnet!.estimateGas = async () => { f.state.testMultiplier = 2n * 10n ** 18n; return 100_000n; };
    const result = await reconcileTslaPrice(store, f.options);
    assert.equal(result.status, 'skipped');
    assert.equal('reason' in result && result.reason, 'testnet_multiplier_changed');
    assert.deepEqual(f.state.sends, []);
    const journal = await store.get<{ step: { signed?: string } }>(`tsla-price-mirror:46630:${feed}`);
    assert.equal(journal?.step.signed, undefined);
    const lane = await store.get<{ active: string | null }>(`operator-nonce-lane:46630:${updater.address.toLowerCase()}`);
    assert.equal(lane?.active, null);
  } finally { await store.close(); }
});

for (const [name, modify, reason] of [
  ['wrong source chain', (s: FixtureState) => { s.sourceChain = 1; }, 'source_chain_mismatch'],
  ['wrong target chain', (s: FixtureState) => { s.testChain = 4663; }, 'testnet_chain_mismatch'],
  ['push just before one-hour interval', (s: FixtureState) => { s.pushedAt = BigInt(now - 3599); }, 'push_interval'],
  ['movement one atomic unit outside hourly bound', (s: FixtureState) => { s.previousAnswer = 43_750_000_000n; s.rawAnswer = 34_999_999_999n; }, 'hourly_movement_bound'],
  ['movement after hour remains bounded', (s: FixtureState) => { s.pushedAt = BigInt(now - 7200); s.previousAnswer = 28_000_000_000n; }, 'hourly_movement_bound'],
  ['first push outside constructor bounds', (s: FixtureState) => { s.mirrored = 0n; s.initialAnswer = 28_000_000_000n; }, 'hourly_movement_bound'],
] as const) test(`skips ${name}`, async () => {
  const store = new LocalStore(':memory:');
  try {
    const f = fixture(); modify(f.state);
    const result = await reconcileTslaPrice(store, f.options);
    assert.equal(result.status, 'skipped');
    assert.equal('reason' in result && result.reason, reason);
    assert.deepEqual(f.state.sends, []);
  } finally { await store.close(); }
});

test('allows exact 20% movement after one hour', async () => {
  const store = new LocalStore(':memory:');
  try {
    const f = fixture(); f.state.previousAnswer = 43_750_000_000n; f.state.pushedAt = BigInt(now - 3600);
    assert.equal((await reconcileTslaPrice(store, f.options)).status, 'pushed');
  } finally { await store.close(); }
});

test('rechecks testnet chain after gas review before signing', async () => {
  const store = new LocalStore(':memory:');
  try {
    const f = fixture();
    f.options.testnet!.estimateGas = async () => { f.state.testChain = 1; return 100_000n; };
    const result = await reconcileTslaPrice(store, f.options);
    assert.equal(result.status, 'skipped');
    assert.equal('reason' in result && result.reason, 'testnet_chain_mismatch');
    assert.deepEqual(f.state.sends, []);
  } finally { await store.close(); }
});
