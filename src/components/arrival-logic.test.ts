import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArrivalGroup, ArrivalStep } from '../data/arrival/types.ts';
import type { CityFeedItem } from '../server/city-signals.ts';
import { feedMatches, filterGroups, orderSteps, parseProfile, selectFeed, serializeProfile, stepMatches } from './arrival-logic.ts';
import { interestOptions } from '../data/interests.ts';
import { interestMatchesText, interestWordList } from './personal-map-relevance.ts';

const source = { label: 'City', url: 'https://example.org', checkedOn: '2026-09-29' };
const step = (id: string, situations?: ArrivalStep['situations'], interests?: ArrivalStep['interests']): ArrivalStep =>
  ({ id, phase: 'first-month', title: id, why: 'Reason', whatToDo: 'Action', source, official: true, situations, interests });
const group = (name: string, interests: ArrivalGroup['interests'], summary = 'Meet people'): ArrivalGroup =>
  ({ id: name, name, kind: 'club', summary, interests, source });
const feed = (id: string, kind: CityFeedItem['kind'], title: string, eventStart: string | null, publishedAt = '2026-09-20T12:00:00Z'): CityFeedItem =>
  ({ id, kind, title, eventStart, publishedAt, url: `https://example.org/${id}`, publisher: 'City' }) as CityFeedItem;

test('unknown, malformed and duplicate stored situations are ignored; interests never persist in the welcome key', () => {
  assert.deepEqual(parseProfile('{broken'), { situations: [], interests: [] });
  assert.deepEqual(parseProfile(JSON.stringify({ situations: ['retired', 'unknown', 'retired'], interests: ['sport'] })), { situations: ['retired'], interests: [] });
  assert.equal(serializeProfile({ situations: ['retired'], interests: ['sport'] }), '{"situations":["retired"]}');
  assert.deepEqual(parseProfile(serializeProfile({ situations: ['from-abroad'], interests: ['kids'] })).situations, ['from-abroad']);
});

test('all steps remain visible, matching steps lead stably within a phase', () => {
  const steps = [step('first'), step('sport', undefined, ['sport']), step('family', ['with-children']), step('last'), step('swim', undefined, ['sport'])];
  const profile = { situations: ['with-children'] as const, interests: ['sport'] as const };
  const result = orderSteps(steps, { situations: [...profile.situations], interests: [...profile.interests] });
  assert.deepEqual(result.map((item) => item.id), ['sport', 'family', 'swim', 'first', 'last']);
  assert.equal(result.length, steps.length);
  assert.deepEqual(orderSteps(steps, { situations: [], interests: [] }).map((item) => item.id), steps.map((item) => item.id));
  assert.equal(stepMatches(steps[0], { situations: [], interests: [] }), false);
});

test('groups stay visible in stable interest-first order until explicitly filtered; search still narrows', () => {
  const groups = [group('Lake Library', ['culture'], 'Books by the lake'), group('Swimming Club', ['sport']), group('Sports Hall', ['sport']), group('Town Garden', ['nature'])];
  assert.deepEqual(filterGroups(groups, [], '').map((item) => item.name), groups.map((item) => item.name));
  assert.deepEqual(filterGroups(groups, ['sport'], '').map((item) => item.name), ['Swimming Club', 'Sports Hall', 'Lake Library', 'Town Garden']);
  assert.deepEqual(filterGroups(groups, ['sport'], '', true).map((item) => item.name), ['Swimming Club', 'Sports Hall']);
  assert.deepEqual(filterGroups(groups, [], '', true), []);
  assert.deepEqual(filterGroups(groups, ['sport'], 'LAKE').map((item) => item.name), ['Lake Library']);
  assert.deepEqual(filterGroups(groups, ['sport'], 'SWIM', true).map((item) => item.name), ['Swimming Club']);
  assert.deepEqual(filterGroups(groups, ['culture'], 'garden').map((item) => item.name), ['Town Garden']);
  assert.deepEqual(filterGroups(groups, ['culture'], 'garden', true), []);
});

test('every displayed interest word is recognized by the shared Places matcher', () => {
  for (const interest of interestOptions) {
    for (const word of interestWordList(interest)) {
      const literal = word.replace(/ \\(whole word\\)$/, '');
      assert.equal(interestMatchesText(literal, interest), true, `${interest}: ${word}`);
    }
  }
});

test('dated events stay inside 21 days including endpoint; past and undated events never appear', () => {
  const now = new Date('2026-09-29T12:00:00Z');
  const items = [feed('past', 'event', 'Sport', '2026-09-29T11:59:59Z'), feed('now', 'event', 'Reading', now.toISOString()),
    feed('end', 'event', 'Sport', '2026-10-20T12:00:00Z'), feed('later', 'event', 'Nature', '2026-10-20T12:00:01Z'),
    feed('unknown', 'event', 'Festival', null), feed('invalid', 'event', 'Event', 'not-a-date')];
  assert.deepEqual(selectFeed(items, now, []).events.map((item) => item.id), ['now', 'end']);
  assert.deepEqual(selectFeed(items, now, ['sport']).events.map((item) => item.id), ['end', 'now']);
});

test('latest three news are selected before interest ordering; Places title matcher tags only matches', () => {
  const items = [feed('older', 'news', 'Sport tomorrow', null, '2026-09-10T12:00:00Z'),
    feed('latest', 'news', 'Notice', null, '2026-09-29T12:00:00Z'),
    feed('second', 'news', 'Schwimmkurs', null, '2026-09-28T12:00:00Z'),
    feed('third', 'news', 'Library', null, '2026-09-27T12:00:00Z')];
  assert.deepEqual(selectFeed(items, new Date('2026-09-29T12:00:00Z'), ['sport']).news.map((item) => item.id), ['second', 'latest', 'third']);
  assert.deepEqual(feedMatches(items[2], ['sport', 'nature']), ['sport']);
});
