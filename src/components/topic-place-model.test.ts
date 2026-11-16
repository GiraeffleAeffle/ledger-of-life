import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLACE_CASE_ID, PLACE_COMPENSATION, PLACE_DOCUMENT, PLACE_GEOMETRY_NOTICE, PLACE_LANDMARKS, PLACE_MAP_ASSET, PLACE_ORIENTATION_POINTS } from '../data/topic-place.ts';
import { buildingWalls, isPlaceArea, orderPlaceFeatures, placePath, projectPlace, selectPlaceLandmark, togglePlaceView, type PlaceFeature, type PlaceView } from './topic-place-model.ts';

const capture = JSON.parse(readFileSync(new URL('../../public/topic-b70/osm-surroundings.json', import.meta.url), 'utf8')) as {
  schemaVersion: number;
  bounds: number[];
  features: PlaceFeature[];
  provenance: { provider: string; licence: string; licenceUrl: string; dataTimestamp: string; query: string; landmarkQuery: string; endpoint: string; processing: string; boundaryRelationId: number };
};
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} ≠ ${expected}`);

test('local map retains real OSM identifiers, georeferenced features and reusable licence provenance', () => {
  assert.equal(capture.schemaVersion, 1);
  assert.equal(PLACE_MAP_ASSET, '/topic-b70/osm-surroundings.json');
  assert.equal(capture.provenance.provider, 'OpenStreetMap contributors');
  assert.equal(capture.provenance.licence, 'ODbL-1.0');
  assert.equal(capture.provenance.licenceUrl, 'https://www.openstreetmap.org/copyright');
  assert.equal(capture.provenance.endpoint, 'https://overpass-api.de/api/interpreter');
  assert.match(capture.provenance.dataTimestamp, /^2026-11-16T/);
  assert.match(capture.provenance.query, /out geom/);
  assert.match(capture.provenance.landmarkQuery, /Müssen/);
  assert.match(capture.provenance.processing, /No cadastral, plan or proposed building geometry/);
  assert.ok(capture.features.length > 500);
  assert.equal(new Set(capture.features.map((feature) => feature.id)).size, capture.features.length);
  for (const kind of ['road', 'railway', 'building', 'farmland', 'forest', 'farmyard']) assert.ok(capture.features.some((feature) => feature.kind === kind));
  for (const feature of capture.features) {
    assert.ok(Number.isInteger(feature.id) && feature.id > 0);
    assert.ok(feature.coordinates.length >= 2);
    for (const [longitude, latitude] of feature.coordinates) {
      assert.ok(Number.isFinite(longitude) && longitude > 10 && longitude < 11);
      assert.ok(Number.isFinite(latitude) && latitude > 53 && latitude < 54);
    }
  }
  for (const landmark of PLACE_LANDMARKS.filter((entry) => entry.osm?.type === 'way')) {
    assert.ok(capture.features.some((feature) => feature.id === landmark.osm!.id), landmark.label);
  }
  assert.equal(capture.provenance.boundaryRelationId, 1467719);
  assert.ok(capture.features.some((feature) => feature.muessenBoundary));
});

test('north-up projection preserves real distances, east-west ordering and path closure', () => {
  const center = projectPlace([10.577, 53.49475], 'flat');
  close(center.x, 330);
  close(center.y, 235);
  const north = projectPlace([10.577, 53.49575], 'flat');
  const east = projectPlace([10.578, 53.49475], 'flat');
  assert.ok(north.y < center.y);
  assert.ok(east.x > center.x);
  close(center.y - north.y, 111.32 * 0.208);
  close(east.y, center.y);
  assert.equal(placePath([], 'flat', true), '');
  const coordinates = [[10.58, 53.495], [10.581, 53.496]] as const;
  assert.ok(placePath(coordinates, 'flat', true).endsWith(' Z'));
  assert.ok(!placePath(coordinates, 'flat', false).endsWith(' Z'));
  for (const view of ['raised', 'flat'] as const) {
    for (const feature of capture.features) {
      const path = placePath(feature.coordinates, view, isPlaceArea(feature.kind));
      assert.ok(!/NaN|Infinity|undefined/.test(path));
    }
  }
});

test('2.5D tilts actual geography without moving landmark identity or inventing measured heights', () => {
  const landmark = PLACE_LANDMARKS.find((entry) => entry.id === 'farm')!;
  assert.notDeepEqual(projectPlace(landmark.coordinate, 'raised'), projectPlace(landmark.coordinate, 'flat'));
  const footprint = capture.features.find((feature) => feature.kind === 'building')!;
  assert.equal(buildingWalls(footprint.coordinates, 'flat'), '');
  assert.ok(buildingWalls(footprint.coordinates, 'raised').includes(' Z'));
  const ground = placePath(footprint.coordinates, 'raised', true);
  const roof = placePath(footprint.coordinates, 'raised', true, 4);
  assert.notEqual(ground, roof);
  const before = capture.features.map((feature) => feature.id);
  const ordered = orderPlaceFeatures(capture.features);
  assert.deepEqual(capture.features.map((feature) => feature.id), before);
  assert.equal(ordered.at(-1)!.kind, 'building');
  assert.ok(ordered.findIndex((feature) => feature.kind === 'railway') > ordered.findIndex((feature) => feature.kind === 'road'));
});

test('orientation is explicitly approximate and lies beidseits the actual railway, west of the road and south of the farm', () => {
  assert.equal(PLACE_CASE_ID, 'case:032e2ba5ba8566598bdd0e335406fcf2');
  assert.match(PLACE_GEOMETRY_NOTICE, /Ungefähre Orientierung/);
  assert.match(PLACE_GEOMETRY_NOTICE, /keine amtliche oder katastergenaue Plangrenze/);
  assert.match(PLACE_DOCUMENT.mainQuote, /nordöstlich der Gemeindegrenze/);
  assert.match(PLACE_DOCUMENT.decision, /kein finaler Satzungsbeschluss/);
  const [north, south] = PLACE_ORIENTATION_POINTS;
  assert.ok(north && south);
  const crossing = capture.features.filter((feature) => feature.kind === 'railway').flatMap((feature) => feature.coordinates.slice(1).flatMap((b, index) => {
    const a = feature.coordinates[index]!;
    if (a[0] === b[0] || Math.min(a[0], b[0]) > north[0] || Math.max(a[0], b[0]) < north[0]) return [];
    return [a[1] + (b[1] - a[1]) * (north[0] - a[0]) / (b[0] - a[0])];
  }));
  assert.ok(crossing.length > 0);
  for (const latitude of crossing) assert.ok(north[1] > latitude && south[1] < latitude);
  for (const point of PLACE_ORIENTATION_POINTS) {
    assert.ok(point[0] < PLACE_LANDMARKS.find((entry) => entry.id === 'road')!.coordinate[0]);
    assert.ok(point[1] < PLACE_LANDMARKS.find((entry) => entry.id === 'farm')!.coordinate[1]);
  }
  assert.equal(PLACE_COMPENSATION.geometry, null);
  assert.match(PLACE_COMPENSATION.reason, /kein Kartenpunkt/);
  assert.match(PLACE_DOCUMENT.compensationQuote, /Steinkrüger Koppel/);
});

test('landmark activation and view toggle have deterministic reset behavior', () => {
  assert.equal(selectPlaceLandmark('not-a-landmark'), 'plan');
  for (const landmark of PLACE_LANDMARKS) assert.equal(selectPlaceLandmark(landmark.id), landmark.id);
  let view: PlaceView = 'raised';
  view = togglePlaceView(view);
  assert.equal(view, 'flat');
  assert.equal(togglePlaceView(view), 'raised');
});

test('component exposes keyboard activation, selection state, local data, visible attribution and expandable provenance', () => {
  const component = readFileSync(new URL('./topic-place.tsx', import.meta.url), 'utf8');
  assert.match(component, /export function TopicPlace\(\)/);
  assert.match(component, /aria-pressed=\{view === 'flat'\}/);
  assert.match(component, /aria-pressed=\{selected === entry.id\}/);
  assert.match(component, /event.key === 'Enter' \|\| event.key === ' '/);
  assert.match(component, /aria-live="polite"/);
  assert.match(component, /<details className="b70-place-details">/);
  assert.match(component, /© OpenStreetMap-Mitwirkende · ODbL/);
  assert.match(component, /osm-surroundings.json/);
  assert.doesNotMatch(component, /\bfetch\(|https:\/\/.*(?:tile|overpass-api)/);
});
