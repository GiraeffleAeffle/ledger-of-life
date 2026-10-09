import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readLoyaltyPlaces } from './loyalty-places.ts';
import { loyaltyMapMerchants } from '../data/loyalty-places.ts';

// Deliberately synthetic test fixture, never production merchant seed data.
const merchant = {
  id: 'test-fixture', city: 'strausberg', name: 'Synthetic test merchant', coordinates: [13.887, 52.58],
  source: 'https://stadtstack.eu/evidence/test-fixture', program: { id: '1', name: 'Synthetic test program' },
  network: 'sepolia', checkedAt: '2026-10-01',
};
const origin = 'https://loyalty.stadtstack.eu';
const today = '2026-10-09';

test('no hosting or no evidence yields explicit states, no pins and no links', () => {
  assert.deepEqual(readLoyaltyPlaces('strausberg', {}, today), { state: 'needs_hosting', merchants: [], links: null });
  for (const merchants of [undefined, '', '[]', '{}', 'null', 'invalid json', 'https://stadtstack.eu/merchants.json', '/tmp/merchants.json']) {
    const result = readLoyaltyPlaces('strausberg', { origin, merchants }, today);
    assert.equal(result.state, 'no_verified_shops');
    assert.deepEqual(result.merchants, []); assert.equal(result.links, null);
  }
  assert.throws(() => readLoyaltyPlaces('../strausberg', {}, today), /Unknown civic city/);
});

test('handoff origin is exact, not a hostname suffix or arbitrary server fetch', () => {
  for (const unsafe of ['http://loyalty.stadtstack.eu', 'https://stadtstack.eu', 'https://evil.stadtstack.eu', 'https://loyalty.stadtstack.eu.evil.test', 'https://loyalty.stadtstack.eu@evil.test', 'https://user:secret@loyalty.stadtstack.eu', 'https://loyalty.stadtstack.eu:443', 'https://loyalty.stadtstack.eu:8443', 'https://loyalty.stadtstack.eu/path', 'https://loyalty.stadtstack.eu?next=https://evil.test', 'https://loyalty.stadtstack.eu#x', 'https://zkloyalty.vercel.app', 'https://127.0.0.1', 'https://loyalty.stadtstack.eu\\@evil.test', ' https://loyalty.stadtstack.eu']) {
    assert.equal(readLoyaltyPlaces('strausberg', { origin: unsafe, merchants: JSON.stringify([merchant]) }, today).state, 'needs_hosting', unsafe);
  }
});

test('registry rejects unsafe sources, unproven networks, IDs, dates and geometries atomically', () => {
  const patches: Record<string, unknown>[] = [
    ...['http://stadtstack.eu/evidence', 'javascript:alert(1)', 'data:text/html,test', 'https://127.0.0.1/evidence', 'https://stadtstack.eu.evil.test/evidence', 'https://other.stadtstack.eu/evidence', 'https://stadtstack.eu@evil.test/evidence', 'https://user:password@stadtstack.eu/evidence', 'https://stadtstack.eu:8443/evidence', 'https://stadtstack.eu/evidence?token=secret', 'https://stadtstack.eu/evidence#x', 'https://stadtstack.eu/', 'https://stadtstack.eu/%0a', 'https://stadtstack.eu/%2fsecret', 'https://stadtstack.eu/a/../evidence', 'https://zkloyalty.vercel.app/evidence'].map((source) => ({ source })),
    { network: 'mainnet' }, { city: 'roebel' }, { id: '../test' }, { id: '' }, { name: 'bad\nname' },
    { program: { id: '-1', name: 'Bad' } }, { program: { id: '9007199254740992', name: 'Bad' } }, { program: {} },
    { checkedAt: '2026-10-10' }, { checkedAt: '2026-02-30' }, { checkedAt: 'not-a-date' },
    { coordinates: null }, { coordinates: [13, '52'] }, { coordinates: [13, 52, 5] }, { coordinates: [181, 52] }, { coordinates: [13, 90] },
    { coordinates: [null, 52] }, { coordinates: { lat: 52, lon: 13 } }, { destination: 'https://evil.test' }, { wallet: 'private account data' },
  ];
  for (const patch of patches) {
    const result = readLoyaltyPlaces('strausberg', { origin, merchants: JSON.stringify([merchant, { ...merchant, id: 'invalid-entry', ...patch }]) }, today);
    assert.deepEqual(result, { state: 'no_verified_shops', merchants: [], links: null }, JSON.stringify(patch));
  }
  for (const key of Object.keys(merchant)) {
    const incomplete: Record<string, unknown> = { ...merchant }; delete incomplete[key];
    assert.equal(readLoyaltyPlaces('strausberg', { origin, merchants: JSON.stringify([incomplete]) }, today).state, 'no_verified_shops', key);
  }
});

test('bounded registry rejects duplicate IDs and oversize input rather than partially publishing', () => {
  for (const merchants of [JSON.stringify([merchant, merchant]), ' '.repeat(262145), JSON.stringify(Array.from({ length: 201 }, (_, index) => ({ ...merchant, id: `shop-${index}` })))]) {
    assert.equal(readLoyaltyPlaces('strausberg', { origin, merchants }, today).state, 'no_verified_shops');
  }
});

test('valid records expose only exact native customer paths and city-scoped map merchants', () => {
  const records = [merchant, { ...merchant, id: 'other-city', city: 'hoppegarten' }];
  const result = readLoyaltyPlaces('strausberg', { origin: `${origin}/`, merchants: JSON.stringify(records) }, today);
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.merchants, [merchant]);
  assert.deepEqual(result.links, { signup: `${origin}/profile`, collect: `${origin}/rewards`, exchange: `${origin}/exchange` });
  assert.deepEqual(loyaltyMapMerchants(result, 'strausberg', true), [merchant]);
  assert.deepEqual(loyaltyMapMerchants(result, 'hoppegarten', true), []);
  assert.deepEqual(loyaltyMapMerchants(result, 'strausberg', false), []);
  assert.deepEqual(loyaltyMapMerchants(null, 'strausberg', true), []);
  assert.deepEqual(loyaltyMapMerchants({ ...result, state: 'no_verified_shops' }, 'strausberg', true), []);
  assert.equal(readLoyaltyPlaces('koeln', { origin, merchants: JSON.stringify(records) }, today).state, 'no_verified_shops');
  assert.equal(readLoyaltyPlaces('hoppegarten', { origin, merchants: JSON.stringify(records) }, today).state, 'ready');
});
