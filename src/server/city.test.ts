import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseCity, readCity } from './city.ts';
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
