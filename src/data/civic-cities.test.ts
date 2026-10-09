import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { CIVIC_CITIES, isCivicCity } from './civic-cities.ts';

test('discussion scopes retain all eight published cities without inventing map coverage', async () => {
  const catalogue = JSON.parse(await readFile(new URL('../../stadtstack-data/out/catalogue.json', import.meta.url), 'utf8')) as { cities: { id: string }[] };
  assert.equal(catalogue.cities.length, 8);
  assert.deepEqual(CIVIC_CITIES.filter((city) => city.mapCoverage === 'published_snapshot').map((city) => city.id).sort(), catalogue.cities.map((city) => city.id).sort());
  assert.equal(CIVIC_CITIES.length, 14);
  assert.equal(new Set(CIVIC_CITIES.map((city) => city.id)).size, 14);
  assert.equal(CIVIC_CITIES.find((city) => city.id === 'strausberg')?.councilCoverage, 'not_published');
});

test('neighbour discussion IDs are backed by the regional official-registry snapshot', async () => {
  const regional = JSON.parse(await readFile(new URL('../../stadtstack-data/out/regions/brandenburg-mol/topics.json', import.meta.url), 'utf8')) as { asOf: string; municipalities: { id: string; name: string }[] };
  const neighbours = CIVIC_CITIES.filter((city) => city.mapCoverage === 'not_published');
  assert.deepEqual(neighbours.map((city) => city.id), ['altlandsberg', 'petershagen-eggersdorf', 'rehfelde', 'ruedersdorf-bei-berlin', 'hoppegarten', 'neuenhagen-bei-berlin']);
  for (const city of neighbours) {
    assert.ok(regional.municipalities.some((entry) => entry.id === city.id && entry.name === city.name));
    assert.equal(city.checkedAt, regional.asOf);
    assert.equal(city.councilCoverage, city.id === 'hoppegarten' ? 'regional_agenda_sample' : 'not_published');
  }
});

test('city acceptance is exact and source links remain dated public HTTPS context', () => {
  for (const city of CIVIC_CITIES) {
    assert.ok(isCivicCity(city.id));
    assert.ok(city.contextLinks.length);
    for (const source of city.contextLinks) {
      assert.equal(new URL(source.url).protocol, 'https:');
      assert.match(source.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
    }
  }
  for (const value of [null, undefined, {}, 1, 'Strausberg', 'strausberg ', '../strausberg', '__proto__', 'roebel', 'toString']) assert.equal(isCivicCity(value), false);
});
