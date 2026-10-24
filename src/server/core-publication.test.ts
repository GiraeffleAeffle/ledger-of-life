import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CORE_FACT_IDS, projectCorePublication, validateCorePublication, type PublishedSnapshot } from './core-publication.ts';
import { fullCityAiEvidence } from './civic-ai.ts';
import { projectAutoVerification, projectSourceAssertion, sourceAssertionLabel, sourceReviewLabel } from '../data/city-source-evidence.ts';
import type { CityCollection } from './city-signals.ts';

const paths = ['core/strausberg-facts.json', 'core/release-manifest.json', 'cities/strausberg/signals.geojson', 'cities/strausberg/signals.min.geojson'];
const published = await Promise.all(paths.map(async (path): Promise<PublishedSnapshot> => {
  const bytes = await readFile(new URL(`../../stadtstack-data/out/${path}`, import.meta.url), 'utf8');
  return { value: JSON.parse(bytes), sha256: createHash('sha256').update(bytes).digest('hex') };
}));
function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function firstFact(snapshot: PublishedSnapshot) { return record((record(snapshot.value).facts as unknown[])[0]); }
function firstCoreSignal(snapshot: PublishedSnapshot) {
  return (snapshot.value as CityCollection).features.find((feature) => feature.properties.id === CORE_FACT_IDS[0])!;
}
function check(snapshots = published) { return validateCorePublication(snapshots[0], snapshots[1], snapshots[2], snapshots[3]); }
function rehash(snapshot: PublishedSnapshot) { snapshot.sha256 = createHash('sha256').update(JSON.stringify(snapshot.value)).digest('hex'); }

test('actual committed core bundle admits three distinct date-aware source receipts', () => {
  const admission = check();
  assert.deepEqual([...admission.keys()], [...CORE_FACT_IDS]);
  const full = projectCorePublication(published[2].value as CityCollection, admission);
  const compact = projectCorePublication(published[3].value as CityCollection, admission);
  const lake = firstCoreSignal({ value: full, sha256: published[2].sha256 });
  assert.equal(lake.properties.kind, 'measurement');
  assert.equal(lake.properties.reviewState, 'auto_checked');
  assert.equal(lake.properties.asOf, '2026-10-05');
  assert.deepEqual(lake.properties.assertion, { date: '2026-09-14', value: -1.61, unit: 'm', reference: 'Normalstau' });
  assert.match(sourceReviewLabel(lake.properties.reviewState, lake.properties.verification), /^Auto-verified.*not human-reviewed/);
  assert.match(sourceAssertionLabel(lake.properties.assertion), /2026-09-14.*historical, not live/);
  for (const [index, year] of [2025, 2026].entries()) {
    const budget = admission.get(`budget:investment-outlays-${year}`)!;
    assert.deepEqual(budget.assertion, { year, value: [17941270, 12609320][index], unit: 'EUR' });
    assert.match(sourceAssertionLabel(budget.assertion), /planned, not spent/);
    assert.equal(budget.verification.score, 1);
    assert.equal(budget.verification.model, 'codex:gpt-6-luna');
  }
  assert.deepEqual(firstCoreSignal({ value: compact, sha256: published[3].sha256 }).properties.verification, lake.properties.verification);
  assert.equal(fullCityAiEvidence(full.features).filter((item) => CORE_FACT_IDS.includes(item.id as typeof CORE_FACT_IDS[number])).length, 3);
});

test('manifest fixes bundle and both corpus byte hashes, paths, policy and required fact set', () => {
  for (const index of [0, 2, 3]) {
    const snapshots = structuredClone(published); snapshots[index].sha256 = '0'.repeat(64);
    assert.throws(() => check(snapshots), /manifest mismatch/);
  }
  const patches: ((manifest: Record<string, unknown>) => void)[] = [
    (m) => { m.schemaVersion = 'other'; }, (m) => { m.cityId = 'koeln'; },
    (m) => { m.bundlePath = '../private'; }, (m) => { record(m.corpus).fullPath = '/tmp/source'; },
    (m) => { record(m.gates).required = false; }, (m) => { record(m.gates).faithfulnessThreshold = 0; },
    (m) => { record(m.gates).model = 'another-model'; }, (m) => { m.facts = []; },
    (m) => { const facts = m.facts as unknown[]; facts[1] = facts[0]; },
    (m) => { record((m.facts as unknown[])[0]).evidenceHash = '0'.repeat(64); },
  ];
  for (const patch of patches) { const snapshots = structuredClone(published); patch(record(snapshots[1].value)); assert.throws(() => check(snapshots)); }
});

test('metadata cannot claim auto-verification with skipped, stale or altered gate evidence', () => {
  const patches: ((fact: Record<string, unknown>) => void)[] = [
    (f) => { record(record(f.verification).faithfulness).actual = false; },
    (f) => { record(record(f.verification).deterministic).passed = false; },
    (f) => { record(record(f.verification).policy).penalizeAmbiguousClaims = false; },
    (f) => { record(record(f.verification).faithfulness).score = 0.79; },
    (f) => { record(record(f.verification).faithfulness).score = 1.1; },
    (f) => { record(record(f.verification).faithfulness).model = 'stub'; },
    (f) => { record(record(f.verification).faithfulness).statementHash = '0'.repeat(64); },
    (f) => { record(f.verification).sourceSha256 = '0'.repeat(64); },
    (f) => { f.statement = 'A different claim'; },
    (f) => { record(f.assertion).date = '2026-10-05'; },
  ];
  for (const patch of patches) {
    const snapshots = structuredClone(published); patch(firstFact(snapshots[0])); rehash(snapshots[0]); record(snapshots[1].value).bundleSha256 = snapshots[0].sha256;
    assert.throws(() => check(snapshots));
  }
});

test('even rehashed corpus changes cannot alter a selected core source or conflate its dates', () => {
  for (const field of ['statement', 'kind', 'asOf', 'reviewState', 'version'] as const) {
    const snapshots = structuredClone(published);
    const p = firstCoreSignal(snapshots[2]).properties;
    Object.assign(p, { [field]: field === 'asOf' ? '2026-09-14' : 'changed' });
    rehash(snapshots[2]); record(record(snapshots[1].value).corpus).fullSha256 = snapshots[2].sha256;
    assert.throws(() => check(snapshots), /signal semantics mismatch/);
  }
  const snapshots = structuredClone(published);
  const full = snapshots[2].value as CityCollection;
  full.features.push(firstCoreSignal(snapshots[2]));
  rehash(snapshots[2]); record(record(snapshots[1].value).corpus).fullSha256 = snapshots[2].sha256;
  assert.throws(() => check(snapshots), /duplicated/);
});

test('failed publication leaves explicit unverified display and zero core AI admission', () => {
  const projected = projectCorePublication(published[2].value as CityCollection, new Map());
  const lake = firstCoreSignal({ value: projected, sha256: published[2].sha256 });
  assert.equal(lake.properties.verification?.status, 'unverified');
  assert.equal(lake.properties.assertion, undefined);
  assert.match(sourceReviewLabel(lake.properties.reviewState, lake.properties.verification), /^Unverified/);
  assert.equal(fullCityAiEvidence(projected.features).some((source) => CORE_FACT_IDS.includes(source.id as typeof CORE_FACT_IDS[number])), false);
  assert.doesNotMatch(sourceReviewLabel('auto_checked'), /Auto-verified/);
  assert.match(sourceReviewLabel('candidate'), /Candidate/);
});

test('public verification DTO is an allowlist, preserves evidence basis, and rejects invalid scores/dates', () => {
  const valid = check().get(CORE_FACT_IDS[0])!.verification;
  assert.deepEqual(projectAutoVerification({ ...valid, privatePrompt: 'PRIVATE-NOT-PUBLIC' }), valid);
  for (const patch of [{ score: NaN }, { score: 0.79 }, { score: 1.01 }, { threshold: 0 }, { sourceSha256: 'bad' }, { evaluatedAt: 'yesterday' }, { status: 'human-reviewed' }])
    assert.equal(projectAutoVerification({ ...valid, ...patch }), null);
  assert.equal(projectSourceAssertion({ date: '2026-02-30', value: -1.61, unit: 'm', reference: 'Normalstau' }), null);
  assert.equal(projectSourceAssertion({ year: 2026, value: Infinity, unit: 'EUR' }), null);
});

test('actual catalogue reader gates compact and detail routes and fails closed after a publication disappears', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-core-publication-'));
  try {
    await mkdir(join(directory, 'cities', 'strausberg'), { recursive: true });
    for (const path of ['catalogue.json', 'cities/strausberg/signals.geojson', 'cities/strausberg/signals.min.geojson', 'cities/strausberg/changes.json'])
      await copyFile(new URL(`../../stadtstack-data/out/${path}`, import.meta.url), join(directory, path));
    const script = `
      import assert from 'node:assert/strict';
      import { readCitySignals, readCitySignal } from './src/server/city-signals.ts';
      const id = 'lake:straussee-level-2026-09-14';
      const compact = await readCitySignals('strausberg');
      const full = await readCitySignal('strausberg', id);
      assert.equal(compact.data.signals.features.find(f=>f.properties.id===id).properties.verification.status, 'auto-verified');
      assert.equal(full.properties.verification.status, 'auto-verified');
      assert.equal(full.properties.assertion.date, '2026-09-14');
      process.env.STADTSTACK_DATA_DIR = process.argv[1];
      const missing = await readCitySignals('strausberg', 'full');
      assert.equal(missing.data.signals.features.find(f=>f.properties.id===id).properties.verification.status, 'unverified');
      const missingDetail = await readCitySignal('strausberg', id);
      assert.equal(missingDetail.properties.verification.status, 'unverified');
      console.log('compact/detail publication gate and missing-manifest refusal passed');
    `;
    const result = execFileSync(process.execPath, ['--conditions=react-server', '--experimental-strip-types', '--input-type=module', '-e', script, directory], { encoding: 'utf8', timeout: 30000 });
    assert.match(result, /missing-manifest refusal passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('same-path same-length replacements with restored mtimes cannot reuse a trusted admission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-core-replacement-'));
  try {
    await mkdir(join(directory, 'cities', 'strausberg'), { recursive: true });
    await mkdir(join(directory, 'core'));
    for (const path of ['catalogue.json', 'cities/strausberg/changes.json', ...paths])
      await copyFile(new URL(`../../stadtstack-data/out/${path}`, import.meta.url), join(directory, path));
    const script = `
      import assert from 'node:assert/strict';
      import { readFile, writeFile, stat, utimes } from 'node:fs/promises';
      import { join } from 'node:path';
      import { readCitySignals } from './src/server/city-signals.ts';
      import { fullCityAiEvidence } from './src/server/civic-ai.ts';
      process.env.STADTSTACK_DATA_DIR = process.argv[1];
      const id = 'lake:straussee-level-2026-09-14';
      const fixed = new Date('2026-10-10T00:00:00.000Z');
      const manifestPath = join(process.argv[1], 'core/release-manifest.json');
      const corpusPath = join(process.argv[1], 'cities/strausberg/signals.geojson');
      await utimes(manifestPath, fixed, fixed); await utimes(corpusPath, fixed, fixed);
      const read = async () => (await readCitySignals('strausberg', 'full')).data.signals;
      const state = c => c.features.find(f=>f.properties.id===id).properties.verification.status;
      const manifest = await readFile(manifestPath, 'utf8'), corpus = await readFile(corpusPath, 'utf8');
      const original = await stat(manifestPath);
      assert.equal(state(await read()), 'auto-verified');
      const badManifest = manifest.replace(/(\"bundleSha256\": \")[a-f0-9]/, '$1z');
      assert.notEqual(badManifest, manifest); assert.equal(Buffer.byteLength(badManifest), original.size);
      await writeFile(manifestPath, badManifest); await utimes(manifestPath, fixed, fixed);
      assert.equal((await stat(manifestPath)).mtimeMs, original.mtimeMs);
      const revoked = await read(); assert.equal(state(revoked), 'unverified');
      assert.equal(fullCityAiEvidence(revoked.features).some(s=>s.id===id), false);
      await writeFile(manifestPath, manifest); await utimes(manifestPath, fixed, fixed);
      assert.equal(state(await read()), 'auto-verified');
      const before = await stat(corpusPath), changed = corpus.replace('1,61 m unter Normalstau', '1,62 m unter Normalstau');
      assert.notEqual(changed, corpus); assert.equal(Buffer.byteLength(changed), before.size);
      await writeFile(corpusPath, changed); await utimes(corpusPath, fixed, fixed);
      assert.equal((await stat(corpusPath)).mtimeMs, before.mtimeMs);
      const altered = await read(); assert.equal(state(altered), 'unverified');
      assert.equal(fullCityAiEvidence(altered.features).some(s=>s.id===id), false);
      console.log('same-metadata manifest/corpus replacement refused');
    `;
    const result = execFileSync(process.execPath, ['--conditions=react-server', '--experimental-strip-types', '--input-type=module', '-e', script, directory], { encoding: 'utf8', timeout: 30000 });
    assert.match(result, /same-metadata manifest\/corpus replacement refused/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
