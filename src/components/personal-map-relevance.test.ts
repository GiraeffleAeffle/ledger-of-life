import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { SignalCollection } from '../server/city-signals.ts';
import { displayStatus, distanceToCorridor, distanceToGeometry, matchPersonalRings } from './personal-map-relevance.ts';

const home: [number, number] = [13.882, 52.579];
const work: [number, number] = [13.902, 52.579];
const fixture = JSON.parse(readFileSync('test/fixtures/city-signals/out/cities/strausberg/signals.geojson', 'utf8')) as SignalCollection;

test('point-to-line, polygon interiors, multipolygon and null geometry have honest distances', () => {
  assert.equal(distanceToGeometry(home, { type: 'Point', coordinates: home }), 0);
  assert.equal(distanceToGeometry(home, { type: 'LineString', coordinates: [[13.88, 52.579], [13.884, 52.579]] }), 0);
  const polygon = { type: 'Polygon' as const, coordinates: [[[13.88, 52.578], [13.884, 52.578], [13.884, 52.58], [13.88, 52.58], [13.88, 52.578]]] as [number, number][][] };
  assert.equal(distanceToGeometry(home, polygon), 0);
  assert.ok((distanceToGeometry([13.89, 52.579], polygon) ?? 0) > 300);
  assert.equal(distanceToGeometry(home, null), null);
  assert.equal(distanceToGeometry([13.8755, 52.5755], fixture.features.find((feature) => feature.properties.id === 'fictional-consultation')!.geometry), 0);
});

test('straight corridor intersects crossing roads but excludes far and beyond-end geometry', () => {
  assert.equal(distanceToCorridor({ type: 'LineString', coordinates: [[13.89, 52.576], [13.89, 52.582]] }, home, work), 0);
  assert.ok((distanceToCorridor({ type: 'Point', coordinates: [13.91, 52.579] }, home, work) ?? 0) > 400);
  assert.ok((distanceToCorridor({ type: 'Point', coordinates: [13.89, 52.585] }, home, work) ?? 0) > 400);
  assert.equal(distanceToCorridor(null, home, work), null);
});

test('near-home and commute corridor boundaries distinguish geometry just inside versus outside', () => {
  const near = { type: 'Point' as const, coordinates: [13.882, 52.5879] as [number, number] };
  const far = { type: 'Point' as const, coordinates: [13.882, 52.5881] as [number, number] };
  assert.ok((distanceToGeometry(home, near) ?? Infinity) < 1000);
  assert.ok((distanceToGeometry(home, far) ?? 0) > 1000);
  const inside = { type: 'Point' as const, coordinates: [13.89, 52.5825] as [number, number] };
  const outside = { type: 'Point' as const, coordinates: [13.89, 52.5827] as [number, number] };
  assert.ok((distanceToCorridor(inside, home, work) ?? Infinity) < 400);
  assert.ok((distanceToCorridor(outside, home, work) ?? 0) > 400);
});

test('citywide council/budget only appear in the city ring, nearby and commute include mapped geometry', () => {
  const rings = matchPersonalRings(fixture.features, { home, work }, '2026-09-26');
  assert.ok(rings.home.some((entry) => entry.feature.properties.id === 'fictional-plan'));
  assert.ok(rings.commute.some((entry) => entry.feature.properties.id === 'fictional-roadworks'));
  assert.ok(!rings.home.some((entry) => entry.feature.properties.id === 'fictional-budget'));
  assert.ok(!rings.commute.some((entry) => entry.feature.properties.id === 'fictional-council'));
  assert.equal(rings.city.length, fixture.features.length);
  assert.match(rings.city.find((entry) => entry.feature.properties.id === 'fictional-budget')!.explanation, /^Planned, not spent:/);
  assert.equal(matchPersonalRings(fixture.features, {}).home.length, 0);
});

test('expired consultation overrides stale source status and expired roadworks do not read as active', () => {
  const consultation = fixture.features.find((feature) => feature.properties.id === 'fictional-consultation')!;
  assert.match(displayStatus(consultation, '2026-09-26'), /^Consultation closed on 2026-09-20; next step:/);
  assert.equal(displayStatus(consultation, '2026-09-19'), 'closed');
  const works = fixture.features.find((feature) => feature.properties.id === 'fictional-roadworks')!;
  assert.match(displayStatus(works, '2026-10-12'), /^Roadworks ended on 2026-10-11/);
  const rings = matchPersonalRings(fixture.features, { home, work }, '2026-10-12');
  assert.match(rings.commute.find((entry) => entry.feature.properties.id === works.properties.id)!.explanation, /^Roadworks ended/);
});
