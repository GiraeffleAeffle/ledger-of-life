import test from 'node:test';
import assert from 'node:assert/strict';
import { projectFootprint, projectMapModel } from './project-map-model.ts';
import { TEST_CITY_INVESTMENTS } from '../data/local-investments.ts';

const center = [13.898445, 52.569168] as const;
const latitudeScale = 6378137 * Math.PI / 180;
const longitudeScale = latitudeScale * Math.cos(center[1] * Math.PI / 180);

test('footprint metre offsets, closed ring and geographic centre are preserved', () => {
  const ring = projectFootprint(center, 24, 12, 0).coordinates[0];
  const expected = [[-12, -6], [12, -6], [12, 6], [-12, 6], [-12, -6]];
  for (let i = 0; i < ring.length; i++) {
    assert.ok(Math.abs((ring[i][0] - center[0]) * longitudeScale - expected[i][0]) < 0.001);
    assert.ok(Math.abs((ring[i][1] - center[1]) * latitudeScale - expected[i][1]) < 0.001);
  }
  assert.deepEqual(ring[0], ring[4]);
});

test('rotation applies to footprint and equipment offset in the same local plane', () => {
  const ring = projectFootprint(center, 24, 12, 90, [2, 3]).coordinates[0];
  const expected = [[3, -10], [3, 14], [-9, 14], [-9, -10]];
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs((ring[i][0] - center[0]) * longitudeScale - expected[i][0]) < 0.001);
    assert.ok(Math.abs((ring[i][1] - center[1]) * latitudeScale - expected[i][1]) < 0.001);
  }
});

test('housing and tall workshop heights follow storeys and solar stays above the roof', () => {
  for (const project of TEST_CITY_INVESTMENTS) {
    const model = projectMapModel(project, { solar: true, heat: true, validator: false, gpu: false });
    const building = model.features.find(feature => feature.id === 'building')!;
    const solar = model.features.find(feature => feature.id === 'solar')!;
    const heat = model.features.find(feature => feature.id === 'heat')!;
    assert.equal(building.properties.height, project.kind === 'housing' ? 12 : 6);
    assert.equal(building.properties.base, 0);
    assert.ok(solar.properties.base > building.properties.height);
    assert.ok(solar.properties.height > solar.properties.base);
    assert.equal(heat.properties.height, 1.8);
    assert.equal(heat.properties.base, 0);
    assert.notDeepEqual(heat.geometry, building.geometry);
  }
});

test('system toggles remove optional geometry, with one shared annex for computing', () => {
  const project = TEST_CITY_INVESTMENTS[0];
  const disabled = { solar: false, heat: false, validator: false, gpu: false };
  assert.deepEqual(projectMapModel(project, disabled).features.map(feature => feature.id), ['building']);
  assert.deepEqual(projectMapModel(project, { ...disabled, solar: true }).features.map(feature => feature.id), ['building', 'solar']);
  assert.deepEqual(projectMapModel(project, { ...disabled, heat: true }).features.map(feature => feature.id), ['building', 'heat']);
  const validator = projectMapModel(project, { ...disabled, validator: true });
  const gpu = projectMapModel(project, { ...disabled, gpu: true });
  const both = projectMapModel(project, { ...disabled, validator: true, gpu: true });
  assert.deepEqual(validator.features.map(feature => feature.id), ['building', 'equipment']);
  assert.deepEqual(gpu, validator);
  assert.deepEqual(both, validator);
  assert.deepEqual(projectMapModel(project, disabled).features[0], validator.features[0]);
});
