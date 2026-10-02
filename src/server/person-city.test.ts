import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chooseCity } from './city.ts';
import type { Store } from './store.ts';
import type { Agreement } from './agreements.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';

const wallet = { id: 'city-wallet', address: 'city-address', chainType: 'solana' as const };
const identity = { subject: 'city-tenant', wallets: [wallet] } as unknown as VerifiedIdentity;
test('tenant home wins over EU city, explicit choice overrides it, and clearing restores the home', async () => {
  if (!process.execArgv.includes('--conditions=react-server')) {
    const result = spawnSync(process.execPath, ['--conditions=react-server', '--experimental-strip-types', '--test', fileURLToPath(import.meta.url)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return;
  }
  // Exercise the actual server-only catalogue loading boundary in a server-conditioned worker.
  const { personCity } = await import('./person-city.ts');
  const values = new Map<string, unknown>();
  const agreement = { id: 'home', network: 'solana', property: 'Garden flat', createdAt: '2026-10-01', home: { city: '15344 Strausberg-Vorstadt', location: { lat: 52.58, lon: 13.884 } }, parties: { tenant: { subject: identity.subject, wallet } } } as Agreement;
  values.set('agreement:home', agreement);
  values.set(`eudi:${identity.subject}`, { statement: { city: 'Köln' } });
  const store = {
    get: async (key: string) => values.get(key) ?? null,
    scan: async (prefix: string) => [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    update: async (key: string, modify: () => unknown) => { values.set(key, modify()); },
    create: async (key: string, value: unknown) => { values.set(key, value); },
  } as unknown as Store;
  const original = globalThis.fetch;
  const originalData = process.env.STADTSTACK_DATA_DIR;
  process.env.STADTSTACK_DATA_DIR = 'test/fixtures/city-signals/out';
  globalThis.fetch = async () => new Response('', { status: 404 });
  try {
    const home = await personCity(store, identity);
    assert.equal(home.source, 'home'); assert.equal(home.cityId, 'strausberg');
    assert.deepEqual(home.home, { title: 'Garden flat', location: agreement.home!.location });
    agreement.home = { city: 'Unrecognised district label', location: { lat: 52.58, lon: 13.884 } };
    assert.equal((await personCity(store, identity)).cityId, 'strausberg');
    await chooseCity(store, identity, 'Köln');
    assert.equal((await personCity(store, identity)).source, 'chosen');
    await chooseCity(store, identity, null);
    assert.equal((await personCity(store, identity)).source, 'home');
    agreement.parties = { landlord: { subject: identity.subject, wallet } } as Agreement['parties'];
    assert.equal((await personCity(store, identity)).source, 'identity');
    agreement.parties = { arbitrator: { subject: identity.subject, wallet } } as Agreement['parties'];
    assert.equal((await personCity(store, identity)).cityId, 'koeln');
    agreement.parties = { tenant: { subject: identity.subject, wallet } } as Agreement['parties'];
    agreement.home = { city: 'Munich-Sendling' };
    const outside = await personCity(store, identity);
    assert.equal(outside.name, 'Munich-Sendling'); assert.equal(outside.cityId, undefined);
    assert.equal(outside.source, 'home'); assert.equal(outside.available, false);
    agreement.cancelled = { by: 'tenant', at: '2026-10-02' };
    const applied = { title: 'Applied home', createdAt: '2026-10-02', status: 'open', landlord: { subject: 'other' }, details: { city: 'Dresden' }, applications: [{ id: 'a', subject: identity.subject }], chosenApplicationId: null };
    const chosen = { ...applied, title: 'Chosen home', createdAt: '2026-10-01', details: { city: 'Strausberg' }, chosenApplicationId: 'a' };
    values.set('listing:applied', applied); values.set('listing:chosen', chosen);
    assert.equal((await personCity(store, identity)).home?.title, 'Chosen home');
    values.set('listing:chosen', { ...chosen, status: 'closed' });
    assert.equal((await personCity(store, identity)).cityId, 'dresden');
    values.set('listing:applied', { ...applied, status: 'closed' });
    assert.equal((await personCity(store, identity)).source, 'identity');
    // Newer legacy candidates must not mask a usable chosen or applied home.
    values.set('listing:legacy-chosen', { ...chosen, createdAt: '2026-10-04', details: null });
    const legacyApplied = { ...applied, details: undefined };
    values.set('listing:legacy-applied', { ...legacyApplied, createdAt: '2026-10-03' });
    assert.equal((await personCity(store, identity)).source, 'identity');
    assert.equal((await personCity(store, identity)).cityId, 'koeln');
    values.set('listing:applied', applied);
    assert.equal((await personCity(store, identity)).home?.title, 'Applied home');
    values.set('listing:chosen', chosen);
    assert.equal((await personCity(store, identity)).home?.title, 'Chosen home');

    agreement.cancelled = undefined;
    agreement.parties = { tenant: { subject: identity.subject, wallet: { ...wallet, id: 'stale-wallet' } } };
    assert.equal((await personCity(store, identity)).home?.title, 'Chosen home');
    values.set('agreement:missing-wallet', { ...agreement, createdAt: '2026-10-04', parties: { tenant: { subject: identity.subject } } });
    values.set('agreement:missing-parties', { ...agreement, createdAt: '2026-10-05', parties: null });
    values.set('agreement:valid', { ...agreement, createdAt: '2026-09-30', property: 'Verified home', home: { city: 'Strausberg' }, parties: { tenant: { subject: identity.subject, wallet } } });
    assert.equal((await personCity(store, identity)).home?.title, 'Verified home');
    values.delete('agreement:valid');
    values.set('listing:chosen', { ...chosen, status: 'closed' });
    values.set('listing:applied', { ...applied, status: 'closed' });
    assert.equal((await personCity(store, identity)).cityId, 'koeln');
    assert.equal((await personCity(store, identity)).source, 'identity');
  } finally {
    globalThis.fetch = original;
    if (originalData === undefined) delete process.env.STADTSTACK_DATA_DIR;
    else process.env.STADTSTACK_DATA_DIR = originalData;
  }
});
