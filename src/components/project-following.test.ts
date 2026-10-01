import { strict as assert } from 'node:assert';
import { test, type TestContext } from 'node:test';
import type { CityFeature, Signal } from '../server/city-signals.ts';
import { acknowledgeFollow, changesBetween, emptyFollowStore, follow, followKey, parseFollowStore, projectSnapshot, refreshFollow, targetForSignal, targetKey, unfollow, type FollowTarget } from './project-following.ts';
import { readCurrentProjectSnapshot } from './use-project-following.ts';
import { civicOutcomeEvidence } from '../data/civic-outcome-evidence.ts';

/** Keep multi-record invariants exercised even when published research uses one signal per case. */
function linkedCaseFixture(t: TestContext) {
  const item = civicOutcomeEvidence.find((entry) => entry.id === 'strausberg-kulturpark-phase-2')!;
  const original = item.signalIds;
  item.signalIds = ['atlas:kulturpark', 'fixture:kulturpark-phase-2'];
  t.after(() => { item.signalIds = original; });
  return { kind: 'case', cityId: item.cityId, id: item.id } satisfies FollowTarget;
}

const target: FollowTarget = { kind: 'signal', cityId: 'dresden', id: 'council:42' };
function signal(overrides: Partial<CityFeature['properties']> = {}): CityFeature {
  return { type: 'Feature', geometry: null, properties: {
    id: 'council:42', cityId: 'dresden', version: 'hash-one', kind: 'council_paper', category: 'transport',
    title: 'Tram plans', statement: 'Committee discussion', status: 'referred', startDate: '2026-08-01', endDate: null,
    nextStep: null, geometryPrecision: 'none', scale: 'city', reviewState: 'candidate', asOf: '2026-08-01', sourceCount: 1,
    primarySource: { url: 'https://stadt.example/paper', title: 'Committee paper', publisher: 'City', licence: 'public', reuse: 'official_work' }, ...overrides,
  } };
}
function snapshot(overrides: Partial<CityFeature['properties']> = {}) {
  return projectSnapshot(target, 'Dresden', [signal(overrides)])!;
}

test('first follow establishes a baseline; irrelevant source churn and copy do not invent decisions', () => {
  const first = snapshot({ nextStep: 'Read paper' });
  const original = follow(emptyFollowStore(), target, first);
  const reread = snapshot({ version: 'hash-two', asOf: '2026-09-01', title: 'Improved heading', statement: 'Copy edited', nextStep: 'View the paper' });
  const refreshed = refreshFollow(original, target, reread);
  assert.equal(original.entries[targetKey(target)].pending.length, 0);
  assert.equal(refreshed.entries[targetKey(target)].pending.length, 0);
  assert.equal(changesBetween(first, reread).length, 0);
});

test('meaningful stage, date, and review transitions preserve source context without inferring delivery or a deadline', () => {
  const first = follow(emptyFollowStore(), target, snapshot());
  const second = refreshFollow(first, target, snapshot({ status: 'decision recorded', endDate: '2027-01-01', reviewState: 'reviewed' }));
  const updates = second.entries[targetKey(target)].pending[0].changes;
  assert.deepEqual(new Set(updates.map((change) => change.key)),
    new Set(['signal:council:42:status', 'signal:council:42:end', 'signal:council:42:review']));
});

test('unseen updates survive other refreshes and older acknowledgments do not consume newer updates', () => {
  const first = follow(emptyFollowStore(), target, snapshot());
  const second = refreshFollow(first, target, snapshot({ status: 'decision pending' }));
  const third = refreshFollow(second, target, snapshot({ status: 'adopted' }));
  const untouched = refreshFollow(third, target, null);
  assert.equal(untouched, third);
  const olderRead = acknowledgeFollow(untouched, target, 1, first.entries[targetKey(target)].instance);
  assert.deepEqual(olderRead.entries[targetKey(target)].pending.map((item) => item.sequence), [2]);
  assert.equal(olderRead.entries[targetKey(target)].acknowledged.facts.find((fact) => fact.key.endsWith(':status'))?.value, 'decision pending');
  assert.equal(acknowledgeFollow(olderRead, target, 1, first.entries[targetKey(target)].instance), olderRead);
  const newerReadFirst = acknowledgeFollow(third, target, 2, first.entries[targetKey(target)].instance);
  assert.deepEqual(newerReadFirst.entries[targetKey(target)].pending.map((item) => item.sequence), [1]);
  const olderReadLast = acknowledgeFollow(newerReadFirst, target, 1, first.entries[targetKey(target)].instance);
  assert.equal(olderReadLast.entries[targetKey(target)].pending.length, 0);
  assert.equal(olderReadLast.entries[targetKey(target)].acknowledged.facts.find((fact) => fact.key.endsWith(':status'))?.value, 'adopted');
});

test('canonical case follows merge linked signals while other cases and cities remain isolated on unfollow', (t) => {
  linkedCaseFixture(t);
  const a = targetForSignal('strausberg', 'atlas:kulturpark');
  const b = targetForSignal('strausberg', 'fixture:kulturpark-phase-2');
  assert.equal(targetKey(a), targetKey(b));
  assert.notEqual(targetKey(a), targetKey({ ...a, cityId: 'dresden' }));
  const first = follow(emptyFollowStore(), target, snapshot());
  const withOther = follow(first, a, projectSnapshot(a, 'Strausberg', [
    signal({ id: 'atlas:kulturpark', cityId: 'strausberg' }),
    signal({ id: 'fixture:kulturpark-phase-2', cityId: 'strausberg' }),
  ])!);
  assert.equal(Object.keys(withOther.entries).length, 2);
  const removed = unfollow(withOther, target);
  assert.deepEqual(Object.keys(removed.entries), [targetKey(a)]);
});

test('account change never exposes or rewrites another account’s pending projects', () => {
  const onDevice = new Map<string, string>();
  const first = refreshFollow(follow(emptyFollowStore(), target, snapshot()), target, snapshot({ status: 'awaiting vote' }));
  onDevice.set(followKey('account-one'), JSON.stringify(first));
  const secondTarget: FollowTarget = { kind: 'case', cityId: 'muenster', id: 'muenster-bus-priority-2021' };
  const second = follow(emptyFollowStore(), secondTarget, projectSnapshot(secondTarget, 'Münster', [])!);
  onDevice.set(followKey('account-two'), JSON.stringify(second));
  const current = parseFollowStore(onDevice.get(followKey('account-two')) ?? null);
  assert.equal(current.entries[targetKey(target)], undefined);
  const other = parseFollowStore(onDevice.get(followKey('account-one')) ?? null);
  assert.equal(other.entries[targetKey(target)].pending.length, 1);
  assert.equal(Object.keys(current.entries).length, 1);
});

test('mapped case refuses a missing linked source instead of establishing a partial baseline', () => {
  const mapped = targetForSignal('strausberg', 'atlas:kulturpark');
  assert.equal(projectSnapshot(mapped, 'Strausberg', []), null);
});

test('budget figure correction is a sourced detail, not inferred actual spending', () => {
  const budget: FollowTarget = { kind: 'signal', cityId: 'dresden', id: 'council:42' };
  const old = projectSnapshot(budget, 'Dresden', [signal({ kind: 'budget', statement: 'Planned amount 17.941.270 EUR for 2025' })])!;
  const corrected = projectSnapshot(budget, 'Dresden', [signal({ kind: 'budget', statement: '2025 budget planned amount 18.000.000 EUR' })])!;
  const update = changesBetween(old, corrected);
  assert.equal(update.length, 1);
  assert.equal(update[0].key, 'signal:council:42:budget-figures');
  assert.ok(update[0].value.includes('17941270') && update[0].value.includes('18000000'));
});
test('budget grouping and sentence order do not create updates; an explicit basis change is reviewable', () => {
  const before = snapshot({ kind: 'budget', statement: 'Geplant: 17.941.270 EUR im Haushaltsjahr 2025' });
  const cosmetic = snapshot({ kind: 'budget', statement: 'Haushaltsjahr 2025; geplant 17 941 270 EUR' });
  assert.deepEqual(changesBetween(before, cosmetic), []);
  const changed = snapshot({ kind: 'budget', statement: 'Haushaltsjahr 2025; tatsächlich 17 941 270 EUR' });
  const updates = changesBetween(before, changed);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].key, 'signal:council:42:budget-basis');
});


test('unfollow then refollow rejects an in-flight response from the old instance', () => {
  const first = follow(emptyFollowStore(), target, snapshot());
  const instance = first.entries[targetKey(target)].instance;
  const replacement = follow(unfollow(first, target), target, snapshot({ status: 'recent source baseline' }));
  const stale = refreshFollow(replacement, target, snapshot({ status: 'old in-flight result' }), instance);
  assert.equal(stale, replacement);
  assert.equal(stale.entries[targetKey(target)].pending.length, 0);
  const fresh = refreshFollow(replacement, target, snapshot({ status: 'newly confirmed' }), replacement.entries[targetKey(target)].instance);
  assert.equal(fresh.entries[targetKey(target)].pending.length, 1);
});
test('stale read from an unfollowed incarnation cannot acknowledge a refollowed update', () => {
  const old = refreshFollow(follow(emptyFollowStore(), target, snapshot()), target, snapshot({ status: 'old update' }));
  const oldInstance = old.entries[targetKey(target)].instance;
  const fresh = refreshFollow(follow(unfollow(old, target), target, snapshot()), target, snapshot({ status: 'new update' }));
  assert.equal(fresh.entries[targetKey(target)].pending[0].sequence, 1);
  assert.equal(acknowledgeFollow(fresh, target, 1, oldInstance), fresh);
  assert.equal(fresh.entries[targetKey(target)].pending.length, 1);
});


test('published next-step category changes are neutral notes; cosmetic rewording stays quiet', () => {
  const before = snapshot({ nextStep: 'Read the agenda' });
  assert.equal(changesBetween(before, snapshot({ nextStep: 'View agenda' })).length, 0);
  const after = snapshot({ nextStep: 'Council decision expected 2026-12-01' });
  const changes = changesBetween(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].key, 'signal:council:42:next-step');
  assert.ok(changes[0].value.includes('2026-12-01'));
});

test('removing a published measurement records lost evidence without implying cancellation or zero', () => {
  const caseTarget: FollowTarget = { kind: 'case', cityId: 'muenster', id: 'muenster-bus-priority-2021' };
  const before = projectSnapshot(caseTarget, 'Münster', [])!;
  const after = { ...before, facts: before.facts.filter((fact) => fact.key !== 'indicator:during') };
  const followed = follow(emptyFollowStore(), caseTarget, before);
  const revised = refreshFollow(followed, caseTarget, after).entries[targetKey(caseTarget)];
  assert.equal(revised.latest.facts.some((fact) => fact.key === 'indicator:during'), false);
  assert.deepEqual(revised.pending[0].changes.map((change) => change.key), ['indicator:during']);
  assert.equal(revised.pending.length, 1);
});

test('reordered structured outputs retain identity and equal labels from two signal records do not collide', (t) => {
  const caseTarget = linkedCaseFixture(t);
  const caseSnapshot = projectSnapshot(caseTarget, 'Strausberg', [
    signal({ cityId: 'strausberg', id: 'atlas:kulturpark' }),
    signal({ cityId: 'strausberg', id: 'fixture:kulturpark-phase-2' }),
  ])!;
  assert.equal(changesBetween(caseSnapshot, { ...caseSnapshot, facts: caseSnapshot.facts.toReversed() }).length, 0);
  const before = projectSnapshot(caseTarget, 'Strausberg', [
    signal({ cityId: 'strausberg', id: 'atlas:kulturpark', title: 'Kulturpark', status: 'planned' }),
    signal({ cityId: 'strausberg', id: 'fixture:kulturpark-phase-2', title: 'Kulturpark', status: 'planned' }),
  ])!;
  const changed = projectSnapshot(caseTarget, 'Strausberg', [
    signal({ cityId: 'strausberg', id: 'atlas:kulturpark', title: 'Kulturpark', status: 'revised phase one' }),
    signal({ cityId: 'strausberg', id: 'fixture:kulturpark-phase-2', title: 'Kulturpark', status: 'revised phase two' }),
  ])!;
  const updates = changesBetween(before, changed);
  assert.deepEqual(new Set(updates.map((change) => change.key)),
    new Set(['signal:atlas:kulturpark:status', 'signal:fixture:kulturpark-phase-2:status']));
});

test('invalid saved data is reported rather than treated as an empty follow list', () => {
  const current = follow(emptyFollowStore(), target, snapshot());
  const corrupted = structuredClone(current);
  corrupted.entries[targetKey(target)].pending = [{ sequence: 1, snapshot: snapshot(), changes: [] }];
  assert.throws(() => parseFollowStore(JSON.stringify(corrupted)));
  assert.throws(() => parseFollowStore('{bad'));
  assert.throws(() => parseFollowStore(''));
  assert.equal(Object.keys(parseFollowStore(null).entries).length, 0);
});

test('first follow reads every current linked full record before baselining; partial read cannot follow', async (t) => {
  const project = linkedCaseFixture(t);
  const record = (id: string, status: string): Signal => ({
    ...signal({ id, cityId: 'strausberg', kind: 'budget', status }),
    properties: {
      ...signal({ id, cityId: 'strausberg', kind: 'budget', status }).properties,
      sources: [{ url: 'https://stadt.example/budget', title: 'Budget', publisher: 'City', locator: '§1',
        retrievedAt: '2026-09-01', sha256: null, licence: 'official work', reuse: 'official_work' }],
      unknowns: [], extraction: { method: 'structured' },
    },
  } as Signal);
  const source = new Map([
    ['atlas:kulturpark', record('atlas:kulturpark', 'source-era plan')],
    ['fixture:kulturpark-phase-2', record('fixture:kulturpark-phase-2', 'current phase two decision')],
  ]);
  const request = async <T>(path: string): Promise<T> => ({ feature: source.get(new URL(path, 'https://example.test').searchParams.get('id')!) } as T);
  const olderCompact = projectSnapshot(project, 'Strausberg', [
    record('atlas:kulturpark', 'source-era plan'),
    record('fixture:kulturpark-phase-2', 'source-era plan'),
  ])!;
  const { snapshot: current } = await readCurrentProjectSnapshot(request, project, 'Strausberg');
  assert.equal(changesBetween(olderCompact, current).length, 1);
  const saved = follow(emptyFollowStore(), project, current);
  assert.equal(refreshFollow(saved, project, (await readCurrentProjectSnapshot(request, project, 'Strausberg')).snapshot).entries[targetKey(project)].pending.length, 0);
  source.set('fixture:kulturpark-phase-2', record('fixture:kulturpark-phase-2', 'later phase two delivery report'));
  const later = refreshFollow(saved, project, (await readCurrentProjectSnapshot(request, project, 'Strausberg')).snapshot);
  assert.equal(later.entries[targetKey(project)].pending.length, 1);
  source.delete('atlas:kulturpark');
  await assert.rejects(readCurrentProjectSnapshot(request, project, 'Strausberg'), /linked public record/);
  assert.equal(later.entries[targetKey(project)].pending.length, 1);
});

test('citywide budget establishes an evidence baseline without requesting removed signals', async () => {
  const budget: FollowTarget = { kind: 'case', cityId: 'strausberg', id: 'strausberg-investment-budget-2025-2026' };
  const request = async <T>(): Promise<T> => { throw new Error('Citywide research must not fetch a linked signal.'); };
  const { snapshot: current, records } = await readCurrentProjectSnapshot(request, budget, 'Strausberg');
  assert.deepEqual(records, []);
  assert.equal(current.facts.find((fact) => fact.key === 'metric:budget-investment-2025')?.value, 'planned: 17941270 EUR · 2025 fiscal year');
  assert.equal(current.facts.find((fact) => fact.key === 'metric:budget-investment-2026')?.value, 'planned: 12609320 EUR · 2026 fiscal year');
  const saved = follow(emptyFollowStore(), budget, current);
  assert.equal(refreshFollow(saved, budget, (await readCurrentProjectSnapshot(request, budget, 'Strausberg')).snapshot).entries[targetKey(budget)].pending.length, 0);
});
