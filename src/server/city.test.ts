import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseCity, readCity } from './city.ts';
import type * as CityModule from './city.ts';
import type { Store } from './store.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';

const identity = { subject: 'places-check' } as VerifiedIdentity;

test('an unknown name is not saved as a city, while atlas outage keeps the covered city', async () => {
  const originalFetch = globalThis.fetch;
  const values = new Map<string, unknown>();
  const store = {
    get: async (key: string) => values.get(key) ?? null,
    update: async (key: string, modify: () => unknown) => { values.set(key, modify()); },
    create: async (key: string, value: unknown) => { values.set(key, value); },
  } as unknown as Store;
  try {
    globalThis.fetch = async (input) => {
      if (String(input).startsWith('https://nominatim.openstreetmap.org/')) return Response.json([]);
      throw new Error('atlas is offline');
    };
    await assert.rejects(chooseCity(store, identity, 'asdf'), /could not find that place/);
    assert.equal(values.size, 0);
    await chooseCity(store, identity, 'Cologne');
    const city = await readCity(store, identity);
    assert.equal(city.name, 'Köln');
    assert.equal(city.cityId, 'koeln');
    assert.equal(city.available, false);
    globalThis.fetch = async (input) => String(input).startsWith('https://nominatim.openstreetmap.org/')
      ? Response.json([{ lat: '53.55', lon: '10.00' }]) : Promise.reject(new Error('atlas is offline'));
    await chooseCity(store, identity, 'Hamburg');
    const outside = await readCity(store, identity);
    assert.equal(outside.available, false);
    assert.equal(outside.name, 'Hamburg');
    assert.equal(outside.cityId, undefined);
    assert.equal(!outside.available && outside.explicitlyUncovered, true);
    values.set('city:places-check', { name: 'asdf' });
    const legacy = await readCity(store, identity);
    assert.equal(!legacy.available && legacy.explicitlyUncovered, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an atlas that is absent or does not cover the city is not reported as an outage', async () => {
  const originalFetch = globalThis.fetch;
  const originalAtlas = process.env.STADTSTACK_ATLAS_URL;
  const store = { get: async () => ({ name: 'Strausberg' }) } as unknown as Store;
  const requested: string[] = [];
  try {
    globalThis.fetch = async (input) => { requested.push(String(input)); return new Response('not found', { status: 404 }); };
    const notCovered = await readCity(store, identity);
    assert.equal(!notCovered.available && notCovered.reason, 'not_in_atlas');
    globalThis.fetch = async () => { throw new Error('atlas is offline'); };
    const offline = await readCity(store, identity);
    assert.equal(!offline.available && offline.reason, 'atlas_unavailable');
    // The hosted demo sets the variable to an empty value: no atlas, and no request for one. The module reads the
    // address once, when it loads, so this case needs a fresh instance; a static import cannot provide one.
    process.env.STADTSTACK_ATLAS_URL = '';
    const withoutAtlas = await import(new URL('./city.ts?deployment-without-atlas', import.meta.url).href) as typeof CityModule;
    requested.length = 0;
    globalThis.fetch = async (input) => { requested.push(String(input)); throw new Error('no request expected'); };
    const hosted = await withoutAtlas.readCity(store, identity);
    assert.equal(!hosted.available && hosted.reason, 'no_atlas');
    assert.equal(hosted.cityId, 'strausberg');
    assert.deepEqual(requested, []);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAtlas === undefined) delete process.env.STADTSTACK_ATLAS_URL;
    else process.env.STADTSTACK_ATLAS_URL = originalAtlas;
  }
});
