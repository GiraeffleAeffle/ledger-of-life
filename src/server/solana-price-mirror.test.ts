import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccountRole, address, getAddressEncoder } from '@solana/kit';
import { SOLANA_DEVNET_MANIFEST, SOLANA_TEST_USDC_MINT } from '../finance/solana/manifest.ts';
import { SHARES_INITIALIZER, SHARES_PRICE_AUTHORITY, SHARES_PROGRAM_ID, sharesAddresses, type SharesPrice } from '../finance/solana/shares.ts';
import { ensureSolanaSharesPrice } from './solana-price-mirror.ts';
import type { ExecuteSponsorInput, SolanaOperations, SolanaOperationResult } from './solana-operations.ts';
import type { BaseSolanaGateway } from './solana-rpc.ts';
import type { SolanaSharesManifest } from './solana-shares-config.ts';
import type { Store } from './store.ts';

// Monday after the expanded weekend window: the ordinary 26-hour cutoff applies.
const NOW = BigInt(Date.parse('2026-10-05T14:00:00Z') / 1000);
const INITIAL = NOW - 200_000n;
const records = new Map<string, unknown>();
const store: Store = {
  get: async <T>(key: string) => records.has(key) ? records.get(key) as T : null,
  create: async <T>(key: string, value: T) => {
    if (records.has(key)) throw new Error('Already exists');
    records.set(key, value);
  },
  update: async <T>(key: string, change: (value: T) => T) => {
    if (!records.has(key)) throw new Error('Missing record');
    const value = change(records.get(key) as T); records.set(key, value); return value;
  },
  scan: async () => { throw new Error('Unexpected scan'); },
  close: async () => { records.clear(); },
};
function encodePrice(price: SharesPrice) {
  const bytes = Buffer.alloc(113);
  bytes.set([50,107,127,61,83,36,39,75]);
  const encoder = getAddressEncoder();
  bytes.set(encoder.encode(address(price.authority)), 8);
  bytes.set(encoder.encode(address(price.shareMint)), 40);
  bytes.writeBigUInt64LE(price.priceUsdE6, 72);
  bytes.writeBigInt64LE(price.publishedAt, 80);
  bytes.writeBigInt64LE(price.copiedAt, 88);
  bytes.writeBigUInt64LE(price.initialPriceUsdE6, 96);
  bytes.writeBigInt64LE(price.initialPublishedAt, 104);
  bytes[112] = price.bump;
  return bytes;
}
async function fixture() {
  records.clear();
  const addresses = await sharesAddresses();
  const manifest: SolanaSharesManifest = { cluster: 'devnet', genesisHash: SOLANA_DEVNET_MANIFEST.genesisHash, programId: SHARES_PROGRAM_ID, cashMint: SOLANA_TEST_USDC_MINT, priceAuthority: SHARES_PRICE_AUTHORITY, initializer: SHARES_INITIALIZER, initialPriceUsdE6: '100000000', initialPricePublishedAt: INITIAL.toString(), dailyFaucetBudgetAtomic: '50000000', debtExposureCapAtomic: '2000000000', ...addresses };
  let price: SharesPrice = { authority: SHARES_PRICE_AUTHORITY, shareMint: addresses.shareMint, priceUsdE6: 100_000_000n, publishedAt: INITIAL, copiedAt: NOW - 4000n, initialPriceUsdE6: 100_000_000n, initialPublishedAt: INITIAL, bump: 1 };
  let source = { priceUsdE6: 110_000_000n, publishedAt: NOW - 60n, sourceLabel: 'test mirror' };
  let state: SolanaOperationResult['state'] = 'broadcast';
  let reconcileState: SolanaOperationResult['state'] = 'broadcast';
  let apply = false;
  let missing = false;
  let owner = SHARES_PROGRAM_ID;
  let executable = false;
  let genesis = manifest.genesisHash;
  let reads = 0, mirrorReads = 0;
  const calls: ExecuteSponsorInput[] = [], reconciles: string[] = [];
  const ids = new Map<string, string>();
  const gateway: Pick<BaseSolanaGateway, 'multiple' | 'checkedGenesis'> = {
    checkedGenesis: async () => genesis,
    multiple: async keys => {
      assert.deepEqual(keys, [manifest.price]); reads++;
      return { slot: '1', accounts: [missing ? null : { address: manifest.price, owner, executable, data: encodePrice(price), lamports: '1000' }] };
    },
  };
  const operations: SolanaOperations = {
    executeAsSponsor: async input => {
      calls.push(input);
      if (!ids.has(input.requestId)) ids.set(input.requestId, `durable-${ids.size}`);
      if (apply) price = { ...price, priceUsdE6: source.priceUsdE6, publishedAt: source.publishedAt, copiedAt: NOW };
      return { id: ids.get(input.requestId)!, state, signature: 'test-signature' };
    },
    reconcile: async input => { reconciles.push(input.id); return { id: input.id, state: reconcileState, signature: 'test-signature' }; },
    prepare: async () => { throw new Error('User signing forbidden'); },
    submit: async () => { throw new Error('User signing forbidden'); },
    cancel: async () => { throw new Error('Unexpected cancellation'); },
    get: async () => { throw new Error('Unexpected lookup'); },
  };
  const options = { gateway, operations, readMirror: async () => { mirrorReads++; return source; }, now: () => Number(NOW), environment: {} };
  return { manifest, options, calls, reconciles, ids, get reads() { return reads; }, get mirrorReads() { return mirrorReads; }, get price() { return price; }, set price(value) { price = value; }, get source() { return source; }, set source(value) { source = value; }, set state(value: SolanaOperationResult['state']) { state = value; }, set reconcileState(value: SolanaOperationResult['state']) { reconcileState = value; }, set apply(value: boolean) { apply = value; }, set missing(value: boolean) { missing = value; }, set owner(value: string) { owner = value; }, set executable(value: boolean) { executable = value; }, set genesis(value: string) { genesis = value; } };
}

test('fresh chain price does not read the mirror or require a sponsor', async () => {
  const f = await fixture(); f.price = { ...f.price, publishedAt: NOW - 26n * 3600n };
  const result = await ensureSolanaSharesPrice(store, f.manifest, { ...f.options, operations: undefined });
  assert.equal(result.fresh, true); assert.equal(result.updated, false);
  assert.equal(f.mirrorReads, 0); assert.equal(f.calls.length, 0);
});

test('pending copy stays unusable and repeated prepares recover the same request and operation', async () => {
  const f = await fixture();
  for (let i = 0; i < 2; i++) {
    const result = await ensureSolanaSharesPrice(store, f.manifest, f.options);
    assert.equal(result.fresh, false); assert.equal(result.updated, false);
    assert.equal(result.reason, 'price_update_pending'); assert.equal(result.signature, 'test-signature');
  }
  assert.equal(f.ids.size, 1); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.reconciles, ['durable-0', 'durable-0']); assert.equal(f.reads, 2);
  const instruction = f.calls[0].instructions[0];
  assert.equal(instruction.programAddress, SHARES_PROGRAM_ID);
  assert.deepEqual(instruction.accounts, [
    { address: SHARES_PRICE_AUTHORITY, role: AccountRole.READONLY_SIGNER },
    { address: f.manifest.price, role: AccountRole.WRITABLE },
    { address: f.manifest.shareMint, role: AccountRole.READONLY },
  ]);
  const expected = Buffer.alloc(24); expected.set([16,19,182,8,149,83,72,181]);
  expected.writeBigUInt64LE(f.source.priceUsdE6, 8); expected.writeBigInt64LE(f.source.publishedAt, 16);
  assert.deepEqual(Buffer.from(instruction.data!), expected);
  assert.equal(f.calls[0].review.authority, SHARES_PRICE_AUTHORITY);
});

for (const viaReconcile of [false, true]) test(`confirmed copy requires a fresh chain reread (${viaReconcile ? 'reconcile' : 'execute'})`, async () => {
  const f = await fixture(); f.apply = true;
  if (viaReconcile) f.reconcileState = 'confirmed'; else f.state = 'confirmed';
  const result = await ensureSolanaSharesPrice(store, f.manifest, f.options);
  assert.equal(result.fresh, true); assert.equal(result.updated, true); assert.equal(f.reads, 2);
  assert.equal(result.price.publishedAt, f.source.publishedAt);
});

test('confirmation without observed fresh price never permits price-sensitive prepare', async () => {
  const f = await fixture(); f.state = 'confirmed';
  const result = await ensureSolanaSharesPrice(store, f.manifest, f.options);
  assert.equal(result.fresh, false); assert.equal(result.updated, false); assert.equal(result.reason, 'price_update_not_observed'); assert.equal(f.reads, 2);
});

for (const state of ['failed', 'expired'] as const) test(`terminal ${state} copy stays closed`, async () => {
  const f = await fixture(); f.state = state;
  const result = await ensureSolanaSharesPrice(store, f.manifest, f.options);
  assert.equal(result.fresh, false); assert.equal(result.reason, `price_update_${state}`); assert.equal(f.reads, 1);
});

const invalidSources = [
  ['mirror_invalid', 0n, NOW - 1n], ['mirror_invalid', 1_000_000_000_001n, NOW - 1n],
  ['mirror_invalid', 100_000_000n, 0n], ['mirror_future', 100_000_000n, NOW + 1n],
  ['mirror_stale', 100_000_000n, NOW - 26n * 3600n - 1n],
  ['mirror_out_of_band', 120_000_001n, NOW - 1n], ['mirror_out_of_band', 79_999_999n, NOW - 1n],
] as const;
for (const [reason, value, time] of invalidSources) test(`rejects ${reason} ${value}/${time}`, async () => {
  const f = await fixture(); f.source = { ...f.source, priceUsdE6: value, publishedAt: time };
  const result = await ensureSolanaSharesPrice(store, f.manifest, f.options);
  assert.equal(result.reason, reason); assert.equal(result.fresh, false); assert.equal(f.calls.length, 0);
});

for (const value of [80_000_000n, 120_000_000n]) test(`accepts exact 20% step boundary ${value}`, async () => {
  const f = await fixture(); f.source = { ...f.source, priceUsdE6: value }; f.price = { ...f.price, copiedAt: NOW - 3600n };
  const result = await ensureSolanaSharesPrice(store, f.manifest, f.options);
  assert.equal(result.reason, 'price_update_pending'); assert.equal(f.calls.length, 1);
});

test('rejects updates copied less than one hour ago', async () => {
  const f = await fixture(); f.price = { ...f.price, copiedAt: NOW - 3599n };
  assert.equal((await ensureSolanaSharesPrice(store, f.manifest, f.options)).reason, 'price_update_too_early'); assert.equal(f.calls.length, 0);
});

test('source failures and missing hosted sponsor do not submit', async () => {
  const f = await fixture();
  assert.equal((await ensureSolanaSharesPrice(store, f.manifest, { ...f.options, readMirror: async () => { throw new Error('offline'); } })).reason, 'mirror_unavailable');
  assert.equal((await ensureSolanaSharesPrice(store, f.manifest, { ...f.options, operations: undefined })).reason, 'price_sponsor_unavailable');
  assert.equal(f.calls.length, 0);
});

for (const field of ['publishedAt', 'copiedAt'] as const) test(`future chain ${field} fails closed without mirror reads`, async () => {
  const f = await fixture(); f.price = { ...f.price, [field]: NOW + 1n };
  assert.equal((await ensureSolanaSharesPrice(store, f.manifest, f.options)).reason, 'price_future'); assert.equal(f.mirrorReads, 0);
});

for (const fault of ['missing', 'owner', 'executable', 'genesis', 'authority', 'mint', 'initial', 'zero', 'manifest'] as const) test(`rejects invalid chain binding ${fault}`, async () => {
  const f = await fixture();
  if (fault === 'missing') f.missing = true;
  if (fault === 'owner') f.owner = SOLANA_TEST_USDC_MINT;
  if (fault === 'executable') f.executable = true;
  if (fault === 'genesis') f.genesis = 'wrong';
  if (fault === 'authority') f.price = { ...f.price, authority: SHARES_INITIALIZER };
  if (fault === 'mint') f.price = { ...f.price, shareMint: SOLANA_TEST_USDC_MINT };
  if (fault === 'initial') f.price = { ...f.price, initialPriceUsdE6: 1n };
  if (fault === 'zero') f.price = { ...f.price, priceUsdE6: 0n };
  if (fault === 'manifest') f.manifest.priceAuthority = SHARES_INITIALIZER;
  await assert.rejects(ensureSolanaSharesPrice(store, f.manifest, f.options)); assert.equal(f.calls.length, 0); assert.equal(f.mirrorReads, 0);
});

for (const timestamp of ['2026-10-03T00:00:00Z', '2026-10-04T14:00:00Z', '2026-10-05T11:59:59Z']) test(`weekend 74-hour freshness window ${timestamp}`, async () => {
  const f = await fixture(); const now = BigInt(Date.parse(timestamp) / 1000);
  f.price = { ...f.price, publishedAt: now - 74n * 3600n, copiedAt: now - 3600n };
  const result = await ensureSolanaSharesPrice(store, f.manifest, { ...f.options, now: () => Number(now) });
  assert.equal(result.fresh, true); assert.equal(f.mirrorReads, 0);
});

test('prepared operation reconciles without treating preparation as confirmation', async () => {
  const f = await fixture(); f.state = 'prepared';
  const result = await ensureSolanaSharesPrice(store, f.manifest, f.options);
  assert.equal(result.reason, 'price_update_pending'); assert.equal(result.fresh, false);
  assert.deepEqual(f.reconciles, ['durable-0']);
});

test('fresh source exactly at weekday cutoff is eligible for copying', async () => {
  const f = await fixture(); f.source = { ...f.source, publishedAt: NOW - 26n * 3600n };
  const result = await ensureSolanaSharesPrice(store, f.manifest, f.options);
  assert.equal(result.reason, 'price_update_pending'); assert.equal(f.calls.length, 1);
});

test('weekend source uses the expanded cutoff, not the weekday cutoff', async () => {
  const f = await fixture(); const now = BigInt(Date.parse('2026-10-04T14:00:00Z') / 1000);
  f.price = { ...f.price, publishedAt: now - 300_000n, copiedAt: now - 3600n };
  f.source = { ...f.source, publishedAt: now - 74n * 3600n };
  const options = { ...f.options, now: () => Number(now) };
  assert.equal((await ensureSolanaSharesPrice(store, f.manifest, options)).reason, 'price_update_pending');
  f.source = { ...f.source, publishedAt: now - 74n * 3600n - 1n };
  f.price = { ...f.price, copiedAt: f.price.copiedAt - 1n };
  assert.equal((await ensureSolanaSharesPrice(store, f.manifest, options)).reason, 'mirror_stale');
  assert.equal(f.calls.length, 1);
});

test('confirmed operation rereads and rejects changed account bindings', async () => {
  const f = await fixture(); f.state = 'confirmed';
  const operations: SolanaOperations = { ...f.options.operations, executeAsSponsor: async input => {
    const result = await f.options.operations.executeAsSponsor(input);
    f.owner = SOLANA_TEST_USDC_MINT;
    return result;
  } };
  await assert.rejects(ensureSolanaSharesPrice(store, f.manifest, { ...f.options, operations }));
  assert.equal(f.reads, 2);
});

test('invalid clocks and missing read RPC fail closed', async () => {
  const f = await fixture();
  await assert.rejects(ensureSolanaSharesPrice(store, f.manifest, { ...f.options, now: () => Number.NaN }));
  await assert.rejects(ensureSolanaSharesPrice(store, f.manifest, { ...f.options, gateway: undefined }));
  assert.equal(f.calls.length, 0);
});

test('upstream source advancing while a copy is pending does not create another operation', async () => {
  const f = await fixture();
  await ensureSolanaSharesPrice(store, f.manifest, f.options);
  f.source = { ...f.source, publishedAt: NOW - 1n, priceUsdE6: 115_000_000n, sourceLabel: 'changed label' };
  const result = await ensureSolanaSharesPrice(store, f.manifest, f.options);
  assert.equal(result.reason, 'price_update_pending');
  assert.equal(f.ids.size, 1); assert.equal(f.mirrorReads, 1);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.reconciles, ['durable-0', 'durable-0']);
});

test('recovery reconciles the pinned operation even after its source becomes stale', async () => {
  const f = await fixture();
  await ensureSolanaSharesPrice(store, f.manifest, f.options);
  const result = await ensureSolanaSharesPrice(store, f.manifest, { ...f.options, now: () => Number(NOW + 100_000n) });
  assert.equal(result.reason, 'price_update_pending'); assert.equal(result.signature, 'test-signature');
  assert.equal(f.calls.length, 1); assert.equal(f.mirrorReads, 1);
});

for (const state of ['confirmed', 'failed', 'expired'] as const) test(`durable recovery handles ${state}`, async () => {
  const f = await fixture();
  await ensureSolanaSharesPrice(store, f.manifest, f.options);
  f.reconcileState = state;
  if (state === 'confirmed') f.price = { ...f.price, publishedAt: f.source.publishedAt, priceUsdE6: f.source.priceUsdE6, copiedAt: NOW };
  // Use the old finalized snapshot for this recovery read, then expose the new
  // chain state only after reconciliation, as happens when a pending tx lands.
  const updated = f.price;
  if (state === 'confirmed') f.price = { ...updated, publishedAt: INITIAL, priceUsdE6: 100_000_000n, copiedAt: NOW - 4000n };
  const operations: SolanaOperations = { ...f.options.operations, reconcile: async input => {
    const result = await f.options.operations.reconcile(input);
    if (state === 'confirmed') f.price = updated;
    return result;
  } };
  const result = await ensureSolanaSharesPrice(store, f.manifest, { ...f.options, operations });
  assert.equal(result.fresh, state === 'confirmed');
  assert.equal(result.updated, state === 'confirmed');
  if (state !== 'confirmed') assert.equal(result.reason, `price_update_${state}`);
  assert.equal(f.calls.length, 1);
});

test('recovery without a hosted sponsor preserves the pending signature', async () => {
  const f = await fixture();
  await ensureSolanaSharesPrice(store, f.manifest, f.options);
  const result = await ensureSolanaSharesPrice(store, f.manifest, { ...f.options, operations: undefined });
  assert.equal(result.reason, 'price_sponsor_unavailable'); assert.equal(result.signature, 'test-signature'); assert.equal(result.fresh, false);
});
