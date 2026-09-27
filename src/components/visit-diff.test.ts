import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { CityFeature, CityFeed } from '../server/city-signals.ts';
import { meaningfulFeedChanges, meaningfulVisitChanges, snapshotCityFeed, snapshotCitySignals } from './visit-diff.ts';

function cityItem(overrides: Partial<CityFeature['properties']> = {}): CityFeature {
  return {
    type: 'Feature', geometry: { type: 'Point', coordinates: [13.9, 52.5] },
    properties: {
      id: 'council:42', version: 'evidence-a', cityId: 'strausberg', kind: 'council_paper',
      category: 'transport', title: 'Rail crossing paper', statement: 'The committee will discuss the crossing.',
      status: 'discussion scheduled', startDate: '2026-09-20', endDate: null,
      nextStep: 'Read the agenda', scale: 'city', geometryPrecision: 'approximate',
      reviewState: 'candidate', asOf: '2026-09-20', sourceCount: 1,
      ...overrides,
    },
  };
}
function feedItem(kind: 'news' | 'event' = 'news'): CityFeed['items'][number] {
  return {
    id: `${kind}:42`, kind, title: 'City notice', url: 'https://city.example/notice',
    publisher: 'City Hall', publishedAt: '2026-09-20T10:00:00Z', eventStart: null,
    sourceId: 'press', reuse: 'facts_with_attribution', retrievedAt: '2026-09-21T10:00:00Z',
    reviewState: 'auto_checked',
  };
}
function feed(items: CityFeed['items']): CityFeed {
  return { schemaVersion: 'stadtstack-feed-v1', cityId: 'strausberg', generatedAt: '2026-09-21T10:00:00Z', sources: [], items };
}

test('first visit is a baseline; hash-only churn is not a new city proposal', () => {
  const first = snapshotCitySignals([cityItem()]);
  const reread = snapshotCitySignals([cityItem({ version: 'different-source-batch', asOf: '2026-09-21' })]);
  assert.deepEqual(meaningfulVisitChanges(null, first, new Set(['council:42'])), []);
  assert.deepEqual(meaningfulVisitChanges(first, reread, new Set(['council:42'])), []);
});

test('review-only and factual corrections are visible even with the same public version', () => {
  const previous = snapshotCitySignals([cityItem()]);
  const reviewed = snapshotCitySignals([cityItem({ reviewState: 'auto_checked' })]);
  assert.equal(meaningfulVisitChanges(previous, reviewed, new Set(['council:42']))[0].description, 'Review updated');
  const corrected = snapshotCitySignals([cityItem({ statement: 'The committee discussed the crossing.' })]);
  assert.equal(meaningfulVisitChanges(previous, corrected, new Set(['council:42']))[0].description, 'Details corrected');
});

test('newly imported old papers are available, not new decisions; missing IDs are not withdrawals', () => {
  const previous = snapshotCitySignals([]);
  const current = snapshotCitySignals([cityItem({ startDate: '2018-01-01' })]);
  const news = meaningfulVisitChanges(previous, current, new Set(['council:42']));
  assert.deepEqual(news.map(({ description }) => description), ['Newly available in city sources']);
  assert.deepEqual(meaningfulVisitChanges(current, previous, new Set(['council:42'])), []);
});

test('a new pin only re-ranks public history without storing coordinates as a visit fact', () => {
  const snapshot = snapshotCitySignals([cityItem()]);
  assert.equal(JSON.stringify(snapshot).includes('13.9'), false);
  assert.deepEqual(meaningfulVisitChanges(snapshot, snapshot, new Set(['council:42'])), []);
  assert.deepEqual(meaningfulVisitChanges(snapshot, snapshot, new Set()), []);
});

test('first feed visit and a retrieval-only refresh do not invent new city news', () => {
  const first = snapshotCityFeed(feed([feedItem()]));
  const rechecked = snapshotCityFeed(feed([{ ...feedItem(), retrievedAt: '2026-09-22T10:00:00Z' }]));
  assert.deepEqual(meaningfulFeedChanges(null, first), []);
  assert.deepEqual(meaningfulFeedChanges(first, rechecked), []);
});

test('published feed additions and corrected event dates are distinct from publisher rechecks', () => {
  const old = snapshotCityFeed(feed([feedItem()]));
  const incoming = snapshotCityFeed(feed([feedItem(), feedItem('event')]));
  assert.deepEqual(meaningfulFeedChanges(old, incoming).map(({ description }) => description), ['Newly available city event']);
  const corrected = snapshotCityFeed(feed([feedItem(), { ...feedItem('event'), eventStart: '2026-10-03T12:00:00Z' }]));
  assert.deepEqual(meaningfulFeedChanges(incoming, corrected).map(({ description }) => description), ['Date corrected']);
  assert.deepEqual(meaningfulFeedChanges(incoming, old), []);
});
