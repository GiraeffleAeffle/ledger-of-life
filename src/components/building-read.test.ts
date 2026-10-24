import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILDING_READ_TIMEOUT_MS, BUILDING_RPC_UNAVAILABLE, boundedBuildingRead, buildingCacheState, readBuilding } from './building-read.ts';

test('public freshness expires by elapsed receipt time, independently of the wall clock', () => {
  const cache = { state: 'fresh' as const, checkedAt: '2099-01-01T00:00:00.000Z', ageMs: 10_000 };
  assert.equal(buildingCacheState(cache, 1000, 50_999), 'fresh');
  assert.equal(buildingCacheState(cache, 1000, 51_000), 'stale');
  assert.equal(buildingCacheState(cache, 1000, 890_999), 'stale');
  assert.equal(buildingCacheState(cache, 1000, 891_000), 'expired');
  assert.equal(buildingCacheState({ ...cache, state: 'stale' }, 1000, 1000), 'stale');
  assert.equal(buildingCacheState(cache, 1000, 1_000_000), 'expired', 'Reactivating after a long pause cannot revive saved freshness');
});

for (const network of ['solana-devnet', 'solana-localnet', 'robinhood-testnet']) {
  test(`503 retains configured ${network} routing without inventing a building`, async context => {
    context.mock.method(globalThis, 'fetch', async () => Response.json({ building: null, network, code: 'rpc_unavailable', error: BUILDING_RPC_UNAVAILABLE }, { status: 503 }));
    assert.deepEqual(await readBuilding('/api/building'), { network, building: null, cache: null });
  });
}

test('healthy reads retain the real building without requiring nested network metadata', async context => {
  const building = { revenueRaw: '1500000', configured: true };
  const cache = { state: 'fresh', checkedAt: '2026-10-12T12:00:00.000Z', ageMs: 0 };
  context.mock.method(globalThis, 'fetch', async (_path: unknown, options?: RequestInit) => {
    assert.equal(options?.cache, 'no-store');
    assert.ok(options?.signal instanceof AbortSignal);
    return Response.json({ network: 'solana-devnet', building, cache });
  });
  assert.deepEqual(await readBuilding('/api/building'), { network: 'solana-devnet', building, cache });
});

test('stale public snapshots retain their original values and explicit freshness metadata', async context => {
  const building = { revenueRaw: '1500000', observedSlot: '1234' };
  const cache = { state: 'stale', checkedAt: '2026-10-12T12:00:00.000Z', ageMs: 120_000 };
  context.mock.method(globalThis, 'fetch', async () => Response.json({ network: 'solana-devnet', building, cache }));
  assert.deepEqual(await readBuilding('/api/building'), { network: 'solana-devnet', building, cache });
});

test('missing or malformed freshness is never upgraded to fresh', async context => {
  for (const cache of [undefined, { state: 'fresh' }, { state: 'fresh', checkedAt: 'not-a-date', ageMs: 0 }]) {
    const mocked = context.mock.method(globalThis, 'fetch', async () => Response.json({ network: 'solana-devnet', building: { revenueRaw: '1500000' }, cache }));
    const result = await readBuilding('/api/building');
    assert.equal(result.cache, null);
    assert.equal(result.building, null, 'An unaged monetary snapshot is not displayed indefinitely');
    mocked.mock.restore();
  }
});

test('missing or unsupported routing never silently selects another chain', async context => {
  for (const network of [undefined, 'solana-mainnet', 'unexpected']) {
    const mocked = context.mock.method(globalThis, 'fetch', async () => Response.json({ network, building: { network: 'solana-devnet', revenueRaw: '0' } }));
    assert.deepEqual(await readBuilding('/api/building'), { network: null, building: null, cache: null });
    mocked.mock.restore();
  }
});

test('never-resolving browser reads abort at the deadline without blocking healthy independent content', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const observed: { signal?: AbortSignal } = {};
  const fetchMock = context.mock.method(globalThis, 'fetch', (_path: unknown, options?: RequestInit) => {
    observed.signal = options?.signal ?? undefined;
    return Promise.withResolvers<Response>().promise;
  });
  const building = readBuilding('/api/building');
  const failure = assert.rejects(building, { message: BUILDING_RPC_UNAVAILABLE });
  const healthy = await boundedBuildingRead(async () => ({ listings: ['A healthy home'], receipts: [{ hash: 'saved-signed-transaction', status: 'pending' }] }));
  assert.equal(healthy.listings[0], 'A healthy home');
  assert.equal(healthy.receipts[0].status, 'pending');
  assert.equal(observed.signal?.aborted, false);
  context.mock.timers.tick(BUILDING_READ_TIMEOUT_MS);
  await failure;
  assert.equal(observed.signal?.aborted, true);
  assert.equal(fetchMock.mock.callCount(), 1, 'A failed read does not retry a request or transaction');
});

test('a hanging response body is bounded as well as the initial fetch', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  context.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream()));
  const failure = assert.rejects(readBuilding('/api/building'), { message: BUILDING_RPC_UNAVAILABLE });
  context.mock.timers.tick(BUILDING_READ_TIMEOUT_MS);
  await failure;
});
test('leaving the screen aborts its initial browser read', async context => {
  const controller = new AbortController();
  const observed: { signal?: AbortSignal } = {};
  context.mock.method(globalThis, 'fetch', (_path: unknown, options?: RequestInit) => {
    observed.signal = options?.signal ?? undefined;
    return Promise.withResolvers<Response>().promise;
  });
  const failure = assert.rejects(readBuilding('/api/building', controller.signal), { message: BUILDING_RPC_UNAVAILABLE });
  controller.abort();
  await failure;
  assert.equal(observed.signal?.aborted, true);
});
