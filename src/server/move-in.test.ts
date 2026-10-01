import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundedLocation, moveInAvailable } from '../domain/home-location.ts';
import { handoverInput, updateHandover } from './move-in.ts';
import { listingNeighbourhood } from '../components/neighbourhood-logic.ts';
import type { SignalResult, CityFeedItem } from './city-signals.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import type { Agreement } from './agreements.ts';
import type { Store } from './store.ts';
import type { tenancyJourney } from './journey.ts';
import { createListing, publicListing, PRESET_PHOTOS } from './listings.ts';

const person = (subject: string): VerifiedIdentity => ({ subject, passkeyCount: 1, wallets: [{ id: subject, address: subject, chainType: 'solana' }] }) as VerifiedIdentity;
const tenant = person('tenant');
const landlord = person('landlord');
const arbitrator = person('arbitrator');
function fixture() {
  const values = new Map<string, unknown>();
  const agreement: Agreement = { id: 'move-in', network: 'solana', property: 'Sample flat', requiredSecurity: '1000000', releaseAllowed: false, createdAt: '2026-10-01T00:00:00Z', revision: 0, records: [], invitations: {}, accepted: {}, parties: Object.fromEntries([tenant, landlord, arbitrator].map((identity) => [identity.subject, { subject: identity.subject, wallet: identity.wallets[0] }])) };
  values.set('agreement:move-in', agreement);
  const store = { get: async (key: string) => values.get(key) ?? null,
    create: async (key: string, value: unknown) => { values.set(key, value); },
    update: async (key: string, change: (value: unknown) => unknown) => { const next = change(values.get(key)); values.set(key, next); return next; } } as unknown as Store;
  return { store, values };
}
// Partial journeys: the move-in rules read only stage and chain phase.
const secured = (async () => ({ stage: 'living', chain: { phase: 'active' } })) as unknown as typeof tenancyJourney;
const content = { readings: [{ meter: 'electricity', value: 1234.5, unit: 'kWh', date: '2026-10-01' }, { meter: 'water', value: 23, unit: 'm³', date: '2026-10-01' }], rooms: [{ room: 'Kitchen', note: 'Small scratch on worktop.' }] };

test('locations reject invalid numbers and are rounded before persistence and publication', async () => {
  for (const location of [null, [], { lat: NaN, lon: 13 }, { lat: 52, lon: Infinity }, { lat: '52', lon: 13 }, { lat: 86, lon: 13 }, { lat: 52, lon: -181 }]) assert.throws(() => roundedLocation(location));
  assert.deepEqual(roundedLocation({ lat: 52.581234, lon: 13.883789 }), { lat: 52.581, lon: 13.884 });
  assert.equal(roundedLocation(undefined), undefined);
  const { store, values } = fixture();
  const published = await createListing(store, landlord, { title: 'Sample flat', releaseAllowed: false, rentMonthly: '1000000', requiredSecurity: '3000000', location: { lat: 52.581234, lon: 13.883789 }, photos: [PRESET_PHOTOS[0]] });
  assert.deepEqual(published.location, { lat: 52.581, lon: 13.884 });
  const saved = values.get(`listing:${published.id}`) as Parameters<typeof publicListing>[0];
  assert.deepEqual(saved.location, published.location);
  saved.details.photos = ['https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=1200&q=70', 'https://elsewhere.example/photo.jpg'];
  assert.deepEqual(publicListing(saved, null).details.photos, [PRESET_PHOTOS[0]]);
});

test('handover binds both confirmations to a revision, rejects outsiders and stale edits, clears confirmations on changes', async () => {
  const { store } = fixture();
  let result = await updateHandover(store, 'move-in', tenant, { action: 'handover_save', ...content }, secured);
  assert.deepEqual(result.handover!.confirmed, {});
  result = await updateHandover(store, 'move-in', tenant, { action: 'handover_confirm', revision: result.handover!.revision }, secured);
  assert.ok(result.handover!.confirmed.tenant);
  assert.equal(result.handover!.confirmed.landlord, undefined);
  result = await updateHandover(store, 'move-in', landlord, { action: 'handover_confirm', revision: result.handover!.revision }, secured);
  assert.ok(result.handover!.confirmed.landlord);
  const previous = result.handover!.revision;
  await assert.rejects(updateHandover(store, 'move-in', arbitrator, { action: 'handover_confirm', revision: previous }, secured), /Only the tenant and landlord/);
  await assert.rejects(updateHandover(store, 'move-in', person('outsider'), { action: 'handover_confirm', revision: previous }, secured), /not a verified party/);
  result = await updateHandover(store, 'move-in', landlord, { action: 'handover_save', revision: previous, ...content, rooms: [{ room: 'Kitchen', note: 'Scratch noted together.' }] }, secured);
  assert.notEqual(result.handover!.revision, previous);
  assert.deepEqual(result.handover!.confirmed, {});
  await assert.rejects(updateHandover(store, 'move-in', tenant, { action: 'handover_confirm', revision: previous }, secured), /handover changed/);
});

test('pending funding cannot unlock move-in; completed deposit can', async () => {
  for (const stage of ['agreement', 'space', 'deposit']) assert.equal(moveInAvailable(stage, 'awaiting-funding'), false);
  assert.equal(moveInAvailable('living', 'awaiting-funding'), false);
  assert.equal(moveInAvailable('living'), false);
  assert.equal(moveInAvailable('living', 'active'), true);
  assert.equal(moveInAvailable('paid', 'closed'), true);
  const { store } = fixture();
  const pending = (async () => ({ stage: 'deposit', chain: { phase: 'awaiting-funding' } })) as unknown as typeof tenancyJourney;
  await assert.rejects(updateHandover(store, 'move-in', tenant, { action: 'handover_save', ...content }, pending), /Secure the deposit/);
});

test('meter values, real dates, units and duplicate meters are validated', () => {
  assert.deepEqual(handoverInput(content), content);
  for (const row of [{ ...content.readings[0], value: -1 }, { ...content.readings[0], value: NaN }, { ...content.readings[0], unit: 'm³' }, { ...content.readings[0], date: '2026-02-30' }]) assert.throws(() => handoverInput({ ...content, readings: [row] }));
  assert.throws(() => handoverInput({ ...content, readings: [content.readings[0], content.readings[0]] }), /only once/);
  assert.throws(() => handoverInput({ readings: [], rooms: [] }), /Add a meter/);
});

test('neighbourhood requires covered city bounds and located nearby data; past or unlocated events stay out', () => {
  const unavailable: SignalResult = { state: 'not_covered', city: 'unknown', coveredCities: [], generatedAt: '2026-10-01' };
  assert.equal(listingNeighbourhood(unavailable, { lat: 52.581, lon: 13.883 }, []), null);
  const snapshot = { state: 'covered', data: { catalogue: { id: 'strausberg', bbox: [13.8, 52.5, 14, 52.7] }, generatedAt: '2026-10-01', signals: { features: [
    { geometry: { type: 'Point', coordinates: [13.883, 52.581] }, properties: { id: 'library', kind: 'place', asOf: '2026-10-01' } },
    { geometry: { type: 'Point', coordinates: [13.9, 52.581] }, properties: { id: 'works', kind: 'construction', asOf: '2026-10-01' } },
    { geometry: { type: 'Point', coordinates: [13.98, 52.581] }, properties: { id: 'far', kind: 'place', asOf: '2026-10-01' } },
    { geometry: null, properties: { id: 'unlocated', kind: 'place', asOf: '2026-10-01' } },
  ] } } } as SignalResult;
  assert.equal(listingNeighbourhood(snapshot, { lat: 48.1, lon: 11.5 }, []), null);
  const events = [
    { id: 'upcoming', kind: 'event', geometry: { type: 'Point', coordinates: [13.883, 52.581] }, eventStart: '2026-10-02' },
    { id: 'past', kind: 'event', geometry: { type: 'Point', coordinates: [13.883, 52.581] }, eventStart: '2026-09-30' },
    { id: 'unlocated', kind: 'event', geometry: null, eventStart: '2026-10-02' },
  ] as CityFeedItem[];
  const nearby = listingNeighbourhood(snapshot, { lat: 52.581, lon: 13.883 }, events, new Date('2026-10-01'))!;
  assert.deepEqual(nearby.places.map((row) => row.feature.properties.id), ['library']);
  assert.deepEqual(nearby.projects.map((row) => row.feature.properties.id), ['works']);
  assert.deepEqual(nearby.events.map((row) => row.item.id), ['upcoming']);
});
