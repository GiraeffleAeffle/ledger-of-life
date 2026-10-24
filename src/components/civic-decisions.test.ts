import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { councilQualityMessage, selectCouncilRecords } from './civic-decisions.ts';
import type { CityFeature } from '../server/city-signals.ts';

const record = (id: string, kind: 'council_meeting' | 'council_paper', date: string | null): CityFeature => ({ type: 'Feature', geometry: null, properties: { id, kind, title: id, startDate: date, primarySource: { url: `https://council.example/bodies/42/${id}`, publisher: 'Council' } } } as CityFeature);

test('upcoming meetings use scheduled date, papers use publication date, never modified date', () => {
  const items = [record('past', 'council_meeting', '2026-09-30'), record('late', 'council_meeting', '2026-10-10'), record('next', 'council_meeting', '2026-10-01'), record('undated', 'council_meeting', null), record('older', 'council_paper', '2026-08-01'), record('newer', 'council_paper', '2026-09-20'), record('unknown', 'council_paper', null)];
  const selected = selectCouncilRecords(items, Date.parse('2026-10-01'), 2);
  assert.deepEqual(selected.meetings.map((item) => item.id), ['next', 'late']);
  assert.deepEqual(selected.papers.map((item) => item.id), ['newer', 'older']);
  assert.equal(selected.meetings[0].body, 'Council · body 42');
  const unsafe = record('unsafe', 'council_paper', '2026-10-01');
  if ('primarySource' in unsafe.properties) unsafe.properties.primarySource!.url = 'javascript:alert(1)';
  assert.deepEqual(selectCouncilRecords([unsafe], 0).papers, []);
});

test('quality holds are rendered with a count and source-grounded reason', () => {
  assert.equal(councilQualityMessage([
    { id: 'council:1', kind: 'council_meeting', reason: 'end_before_start' },
    { id: 'council:2', kind: 'council_meeting', reason: 'end_before_start' },
  ]), '2 meetings withheld for data quality: end before start in the source.');
});

test('published OParl cities expose selectable council records or a sourced quality disposition', async () => {
  const quality = JSON.parse(await readFile(new URL('../../stadtstack-data/out/quality-report.json', import.meta.url), 'utf8'));
  for (const city of ['koeln', 'muenster', 'wuppertal', 'castrop-rauxel', 'duesseldorf', 'dresden', 'freiburg']) {
    const snapshot = JSON.parse(await readFile(new URL(`../../stadtstack-data/out/cities/${city}/signals.min.geojson`, import.meta.url), 'utf8'));
    const selected = selectCouncilRecords(snapshot.features, Date.parse('2026-10-01'));
    const cityQuality = quality.cities.find((entry: { cityId: string }) => entry.cityId === city);
    const holds = [...(cityQuality?.quarantined ?? []), ...(cityQuality?.retainedQuarantines ?? [])]
      .filter((item: { id: string; kind?: string }) => item.kind === 'council_meeting' || item.kind === 'council_paper' || item.id.startsWith('council:'));
    const message = councilQualityMessage(holds);
    assert.ok(selected.papers.length || selected.meetings.length || holds.length > 0, `${city} has neither selectable council records nor a published quality disposition`);
    if (!selected.papers.length && !selected.meetings.length) assert.ok(message, `${city} has no selectable council records and no explicit quality reason`);
    for (const item of [...selected.meetings, ...selected.papers]) assert.ok(/^https?:\/\//.test(item.url), `${city}: unsafe official link`);
  }
});
