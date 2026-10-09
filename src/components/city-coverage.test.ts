import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CityFeature, SignalCity } from '../server/city-signals.ts';
import { cityIdFor, homeCityId, consultationGroups, displayCityText, formatCityDate, formatCityEventDate, nearestCoveredCity, shortlistFeatures } from './city-coverage.ts';
import { oldPinsKey, pinsKey, readAccountPins } from './personal-map-storage.ts';

test('covered spellings resolve without treating arbitrary names as covered', () => {
  for (const spelling of ['Koln', 'Köln', 'Cologne']) assert.equal(cityIdFor(spelling), 'koeln');
  for (const spelling of ['Munster', 'Muenster', 'Münster']) assert.equal(cityIdFor(spelling), 'muenster');
  for (const spelling of ['Dusseldorf', 'Düsseldorf', 'Duesseldorf']) assert.equal(cityIdFor(spelling), 'duesseldorf');
  assert.equal(cityIdFor('asdf'), null);
  assert.equal(cityIdFor('Hamburg'), null);
});

test('home city inference accepts postcodes and districts without inventing coverage', () => {
  assert.equal(homeCityId('15344 Strausberg'), 'strausberg');
  assert.equal(homeCityId('Strausberg-Vorstadt'), 'strausberg');
  assert.equal(homeCityId('Strausberg, Vorstadt'), 'strausberg');
  assert.equal(homeCityId('Castrop-Rauxel'), 'castrop-rauxel');
  assert.equal(homeCityId('Munich-Sendling'), null);
});

const sample = (id: string, cityId: string, kind: CityFeature['properties']['kind'], startDate: string | null = null, endDate: string | null = null, longitude = 13.88): CityFeature => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [longitude, 52.58] },
  properties: { id, version: 1, cityId, kind, category: '', title: id, statement: '', status: '', startDate, endDate, nextStep: null,
    unknowns: [], scale: 'city', geometryPrecision: 'exact', sources: [], extraction: { method: 'structured' }, reviewState: 'candidate', asOf: '2026-09-28' },
});
const city: SignalCity = { id: 'strausberg', name: 'Strausberg', state: 'Brandenburg', center: [13.88, 52.58], bbox: [13.8, 52.5, 14, 52.7], sources: [] };

test('participation windows use the published as-of date and preserve recently closed items', () => {
  const features = [sample('open', 'strausberg', 'consultation', '2026-09-01', '2026-10-03'),
    sample('closed', 'strausberg', 'consultation', '2026-08-01', '2026-09-20'),
    sample('later', 'strausberg', 'consultation', '2026-10-01', '2026-10-20'),
    sample('other', 'koeln', 'consultation', '2026-09-01', '2026-10-03')];
  const grouped = consultationGroups(features, 'strausberg', '2026-09-28T12:00:00Z');
  assert.deepEqual(grouped.open.map((item) => item.properties.id), ['open']);
  assert.deepEqual(grouped.closed.map((item) => item.properties.id), ['closed']);
  assert.equal(formatCityDate('2026-09-28T12:00:00Z'), '28 Sep 2026');
});
test('source freshness uses one Berlin date and time across local midnight', () => {
  assert.equal(formatCityEventDate('2026-10-09T22:30:00Z'), '10 Oct 2026, 00:30');
});
test('source prose presents dates and the first OSM category without raw tags', () => {
  assert.equal(displayCityText('als martial_arts;taekwondo;boxing eingetragen 2026-09-28'), 'als Martial Arts eingetragen 28 Sep 2026');
});

test('city shortlist excludes motorway, another municipality, outside-city point and places', () => {
  const features = [sample('autobahn:A10', 'strausberg', 'roadworks'), sample('local', 'strausberg', 'planning'),
    sample('outside', 'strausberg', 'planning', null, null, 14.5), sample('foreign', 'koeln', 'planning'), sample('bakery', 'strausberg', 'place')];
  assert.deepEqual(shortlistFeatures(features, 'strausberg', city).map((item) => item.properties.id), ['local']);
});
test('nearest covered city uses published coordinates rather than a fixed default', () => {
  const elsewhere: SignalCity = { ...city, id: 'koeln', name: 'Köln', center: [6.96, 50.94] };
  assert.equal(nearestCoveredCity([city, elsewhere], [7, 51])?.id, 'koeln');
  assert.equal(nearestCoveredCity([city, elsewhere], [13.9, 52.6])?.id, 'strausberg');
});

test('legacy pin is claimed once and account pins remain isolated', () => {
  const records = new Map<string, string>([[oldPinsKey('strausberg'), '{"home":[13.88,52.58]}']]);
  const storage = {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value); },
    removeItem: (key: string) => { records.delete(key); },
  };
  assert.equal(readAccountPins(storage, 'strausberg', 'alice'), '{"home":[13.88,52.58]}');
  assert.equal(records.has(oldPinsKey('strausberg')), false);
  assert.equal(records.get(pinsKey('strausberg', 'alice')), '{"home":[13.88,52.58]}');
  assert.equal(readAccountPins(storage, 'strausberg', 'bob'), '');
  assert.notEqual(pinsKey('strausberg', 'alice'), pinsKey('strausberg', 'bob'));
});
