import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchLoyaltyPlaces, LOYALTY_FEED, LOYALTY_ORIGIN, parseLoyaltyPlaces, loyaltyMapMerchants } from './loyalty-places.ts';

// Deliberately synthetic test fixture, never production merchant seed data.
const merchant = {
  id: 'test-fixture', city: 'strausberg', name: 'Synthetic test merchant', coordinates: [13.887, 52.58],
  source: 'https://stadtstack.eu/evidence/test-fixture', program: { id: '1', name: 'Synthetic test program' },
  network: 'sepolia', checkedAt: '2026-10-01',
};
const origin = LOYALTY_ORIGIN;
const today = '2026-10-09';

test('successful empty feed has no pins but keeps the owner service handoff', () => {
  const result = parseLoyaltyPlaces('strausberg', [], today);
  assert.equal(result.state, 'empty');
  assert.deepEqual(result.merchants, []);
  assert.equal(result.links.signup, `${origin}/profile`);
  for (const records of [undefined, '', {}, null, 'invalid json', 'https://stadtstack.eu/merchants.json', '/tmp/merchants.json']) {
    assert.throws(() => parseLoyaltyPlaces('strausberg', records, today), /Invalid merchant feed/);
  }
  assert.throws(() => parseLoyaltyPlaces('../strausberg', [], today), /Unknown civic city/);
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
    assert.throws(() => parseLoyaltyPlaces('strausberg', [merchant, { ...merchant, id: 'invalid-entry', ...patch }], today), /Invalid merchant evidence/, JSON.stringify(patch));
  }
  for (const key of Object.keys(merchant)) {
    const incomplete: Record<string, unknown> = { ...merchant }; delete incomplete[key];
    assert.throws(() => parseLoyaltyPlaces('strausberg', [incomplete], today), /Invalid merchant evidence/, key);
  }
});

test('bounded registry rejects duplicate IDs and oversize input rather than partially publishing', () => {
  for (const records of [[merchant, merchant], Array.from({ length: 201 }, (_, index) => ({ ...merchant, id: `shop-${index}` }))]) {
    assert.throws(() => parseLoyaltyPlaces('strausberg', records, today), /Invalid merchant/);
  }
});

test('valid records expose only exact native customer paths and city-scoped map merchants', () => {
  const records = [merchant, { ...merchant, id: 'other-city', city: 'hoppegarten' }];
  const result = parseLoyaltyPlaces('strausberg', records, today);
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.merchants, [merchant]);
  assert.deepEqual(result.links, { signup: `${origin}/profile`, collect: `${origin}/rewards`, exchange: `${origin}/exchange` });
  assert.deepEqual(loyaltyMapMerchants(result, 'strausberg', true), [merchant]);
  assert.deepEqual(loyaltyMapMerchants(result, 'hoppegarten', true), []);
  assert.deepEqual(loyaltyMapMerchants(result, 'strausberg', false), []);
  assert.deepEqual(loyaltyMapMerchants(null, 'strausberg', true), []);
  assert.deepEqual(loyaltyMapMerchants({ ...result, state: 'empty' }, 'strausberg', true), []);
  assert.equal(parseLoyaltyPlaces('koeln', records, today).state, 'empty');
  assert.equal(parseLoyaltyPlaces('hoppegarten', records, today).state, 'ready');
});

test('browser feed uses only the fixed public URL without credentials or city disclosure', async () => {
  const controller = new AbortController();
  let called = false;
  const result = await fetchLoyaltyPlaces('strausberg', controller.signal, async (url, init) => {
    called = true;
    assert.equal(url, LOYALTY_FEED);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.mode, 'cors');
    assert.equal(init?.referrerPolicy, 'no-referrer');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.headers, undefined);
    assert.equal(init?.body, undefined);
    assert.ok(init?.signal instanceof AbortSignal);
    return Response.json([]);
  });
  assert.equal(called, true);
  assert.equal(result.state, 'empty');
  await assert.rejects(fetchLoyaltyPlaces('unknown', controller.signal, async () => { throw new Error('Must not fetch'); }), /Unknown civic city/);
});

test('network, CORS, response and schema failures never become a successful empty feed', async () => {
  const responses = [
    new Response('[]', { status: 503, headers: { 'content-type': 'application/json' } }),
    new Response('[]', { headers: { 'content-type': 'text/html' } }),
    new Response('bad JSON', { headers: { 'content-type': 'application/json' } }),
    Response.json({ merchants: [] }),
    Response.json([{ ...merchant, source: 'javascript:alert(1)' }]),
  ];
  for (const response of responses) {
    await assert.rejects(fetchLoyaltyPlaces('strausberg', new AbortController().signal, async () => response));
  }
  await assert.rejects(fetchLoyaltyPlaces('strausberg', new AbortController().signal, async () => { throw new TypeError('Failed to fetch'); }));
});

test('stream bytes are bounded and pending reads carry cancellation', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(262145)); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(fetchLoyaltyPlaces('strausberg', new AbortController().signal, async () => response), /too large/);
  assert.equal(cancelled, true);
  const controller = new AbortController();
  const pending = fetchLoyaltyPlaces('strausberg', controller.signal, async (_url, init) => {
    const { promise, reject } = Promise.withResolvers<Response>();
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    return promise;
  });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
