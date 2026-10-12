import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, realpath, stat, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { provisionCivicPolicyAuthority, initializeManagedAcquisitionLane, withManagedSourceWrite, CIVIC_ACQUISITION_DECISION_ID } from '../src/civic-opt-out.ts';
import { sha256 } from '../src/district-schema.ts';
import { prepareDocument, verifyPreparedDocument, cachePreparedDocument, readPreparedDocument, assertPreparedSourcesActive, assertPreparedReferenceMembership, readAuthorizedSourceBytes, PREPARED_VM_ROOT, type PreparedSourceReference, type ManagedPreparationInput } from '../src/district-prepared-document.ts';
import { createWorkPlan, restoreWorkPlan, resumeWorkPlan, runWorkPlan, modelCacheKey, classifyWorkFailure, RemoteWorkFailure, type WorkGroup, type WorkPlan } from '../src/district-work-plan.ts';
import { PILOT_BASE_CORPUS_SHA256, PILOT_COMPLETION_CORPUS_SHA256, authorizedPilotCorpusSchema, loadFrozenCorpus, crawlDocumentSchema } from '../src/district-corpus.ts';
import { preparationPlanSchema } from '../src/district-preparation-run.ts';
import { readPinnedJson } from '../src/district-private-io.ts';
import { ownerRobotsOverrideFor, APPROVED_OWNER_ROBOTS_OVERRIDE } from '../src/source-policy.ts';
import { DOCUMENT_ORIGIN_CLASSIFIER_VERSION } from '../src/document-origin-contract.ts'
import { recordHostOptOut, assertCivicPolicyAuthority } from '../src/civic-opt-out.ts';
import { createCivicPolicyTestContext } from './fixtures/civic-policy.ts';
import { readBoundSourceObservation } from '../src/source-observation.ts';
const ordinaryFixture = await createCivicPolicyTestContext();
after(ordinaryFixture.dispose);
const sourceText = 'Die Stadt beschließt ein neues Wärmenetz. Quelle und Beschluss bleiben überprüfbar. 😀';
const bytes = Buffer.from(sourceText);
function reference(): PreparedSourceReference {
  return { id: 'public-source', url: 'https://example.org/document', sha256: sha256(bytes), retrievedAt: '2026-10-01T00:00:00.000Z', locator: 'document-sha256:' + sha256(bytes), mimeType: 'text/plain', sourceType: 'website', policy: { robots: { state: 'allowed', url: 'https://example.org/robots.txt' }, tdm: { state: 'not_declared', evidence: [] }, access: 'public', legalClassification: 'not_assessed', publication: 'facts_with_attribution_only' } };
}
// Explicitly synthetic parser identity for fixture receipts, never evidence of a reviewed worker run.
const fixtureToolVersions = { node: process.versions.node, parser_isolation: 'district-parser-isolation-v1', parser_image: 'sha256:' + sha256('synthetic fixture parser image; not reviewed'), parser_contract: sha256('synthetic fixture parser contract; no actual execution') };
const preparation = () => ({ bytes, municipalityId: 'strausberg', references: [reference()], mimeType: 'text/plain', extractorSha256: sha256('extractor'), toolVersions: fixtureToolVersions });
const fixtureCommand = async () => { throw Error('Pure synthetic text fixture must not execute parser commands'); };
const fixtureSourceBindings = [{ kind: 'http_observation' as const, url: reference().url, sourceSha256: sha256(bytes), observationId: 'synthetic-preparation-fixture', receiptSha256: sha256('synthetic preparation fixture receipt') }];
test('result references may change span locators but cannot replace prepared identity or policy', () => {
  const source = reference();
  assert.doesNotThrow(() => assertPreparedReferenceMembership([{ ...source, locator: 'text-sha256:' + sha256(sourceText) + ';chars:0-40' }], [source]));
  const changes: Partial<PreparedSourceReference>[] = [
    { id: 'another-source' }, { url: 'https://example.net/copy' }, { sha256: sha256('other source') },
    { retrievedAt: '2026-10-02T00:00:00.000Z' }, { mimeType: 'text/html' }, { sourceType: 'gazette' },
    { policy: { ...source.policy, tdm: { state: 'not_reserved', evidence: [] } } },
  ];
  for (const change of changes) assert.throws(() => assertPreparedReferenceMembership([{ ...source, ...change }], [source]), /authenticated prepared context/);
});
test('frozen index decoding preserves real observation fields and never invents legacy acquisition proof', async () => {
  const source = reference(), document = { id: 'synthetic-document', municipalityId: 'strausberg', ags: '12064472', districtId: 'maerkisch-oderland', sourceId: source.id, url: source.url, sha256: source.sha256, mimeType: source.mimeType, retrievedAt: source.retrievedAt, checkedAt: '2026-10-02T00:00:00.000Z', status: 200, observationPath: '/synthetic/raw/observations/fixture.json', documentDate: null, localPath: '/synthetic/raw/sha256/' + source.sha256, adapter: 'synthetic-fixture', metadata: {}, policy: source.policy };
  const parsed = crawlDocumentSchema.parse(document);
  assert.equal(parsed.observationPath, document.observationPath); assert.equal(parsed.checkedAt, document.checkedAt); assert.equal(parsed.status, document.status);
  const { observationPath: _observation, checkedAt: _checked, status: _status, ...legacy } = document;
  const original = crawlDocumentSchema.parse(legacy);
  assert.equal(original.observationPath, undefined); assert.equal(original.checkedAt, undefined); assert.equal(original.status, undefined);
  await assert.rejects(readBoundSourceObservation({ rawRoot: ordinaryFixture.managedRoot, document: original, policy: ordinaryFixture.policy }), /index binding is incomplete/);
});
test('prepared receipts bind bytes, policy, source references, tools, exact text and UTF16 offsets', async () => {
  const receipt = await prepareDocument(preparation(), fixtureCommand);
  const checked = verifyPreparedDocument(receipt, receipt, bytes);
  assert.equal(checked.text, sourceText);
  assert.equal(checked.textLength, sourceText.length);
  assert.equal(checked.offsetUnit, 'utf16_code_units');
  assert.throws(() => verifyPreparedDocument({ ...receipt, text: receipt.text + 'tamper' }, receipt), /hash/);
  assert.throws(() => verifyPreparedDocument(receipt, { ...receipt, sourceSha256: sha256('other bytes') }), /identity/);
  assert.throws(() => verifyPreparedDocument(receipt, receipt, Buffer.from('tampered source')), /source bytes/);
  assert.throws(() => verifyPreparedDocument(receipt, { ...receipt, toolVersions: { node: 'different' } }), /tool versions/);
  assert.throws(() => verifyPreparedDocument(receipt, { ...receipt, references: [{ ...reference(), retrievedAt: '2026-10-02T00:00:00.000Z' }] }), /references/);
  const rehashed = await prepareDocument({ ...preparation(), bytes: Buffer.from(sourceText + 'changed'), references: [{ ...reference(), sha256: sha256(sourceText + 'changed') }] }, fixtureCommand);
  assert.throws(() => verifyPreparedDocument(rehashed, receipt), /receipt hash/);
  await assert.rejects(prepareDocument({ ...preparation(), bytes: Buffer.from(sourceText + 'changed') }, fixtureCommand), /source reference/);
  await assert.rejects(prepareDocument({ ...preparation(), references: [{ ...reference(), policy: { ...reference().policy, access: 'captcha' } }] }, fixtureCommand), /blocks extraction/);
  await assert.rejects(prepareDocument({ ...preparation(), toolVersions: {} }, fixtureCommand), /tool version evidence/);
});
test('ordinary preparation requires authentic original source bindings before parser execution', async () => {
  const input: ManagedPreparationInput = { ...preparation(), managedRoot: '/unused-before-admission', policy: {}, sourceBindings: [] };
  await assert.rejects(prepareDocument(input), /authenticated managed source bindings/);
  const mismatch: ManagedPreparationInput = { ...input, sourceBindings: [{ kind: 'http_observation', url: 'https://example.org/unrelated-source', sourceSha256: sha256(bytes), observationId: 'synthetic-unrelated-source', receiptSha256: sha256('synthetic unrelated source receipt') }] };
  await assert.rejects(prepareDocument(mismatch, fixtureCommand), /bindings differ/);
});

test('prepared text keeps source-bound blocked robots exception and rejects transferred approval', async () => {
  const url = 'https://strausberg.allris.cloud/public/si010';
  const source: PreparedSourceReference = {
    ...reference(), id: 'strausberg-council', sourceType: 'council', url,
    policy: { ...reference().policy, robots: { state: 'blocked', url: new URL('/robots.txt', url).href, sha256: sha256('synthetic denied robots'), checkedAt: '2026-10-11T12:00:00.000Z' }, ownerRobotsOverride: ownerRobotsOverrideFor(url)!, robotsStatus: 'disallowed', override: 'owner-approved 2026-10-11', documentOrigin: { classification: 'official_work', method: 'rules', classifierVersion: DOCUMENT_ORIGIN_CLASSIFIER_VERSION, url, sha256: sha256(bytes), classifiedAt: '2026-10-11T12:00:00.000Z', evidence: [{ locator: 'synthetic fixture', value: 'administrative authorship and formal work fixture' }] } },
  };
  const receipt = await prepareDocument({ ...preparation(), references: [source] }, fixtureCommand);
  const checked = verifyPreparedDocument(receipt, receipt, bytes);
  assert.deepEqual(checked.references[0].policy, source.policy);
  assert.equal(checked.references[0].policy.robots.state, 'blocked');
  assert.equal(checked.text, sourceText);
  for (const changed of [
    { ...source, url: 'https://other.allris.cloud/public/si010' },
    { ...source, policy: { ...source.policy, robots: { ...source.policy.robots, state: 'unavailable' as const } } },
    { ...source, policy: { ...source.policy, access: 'authentication' as const } },
    { ...source, policy: { ...source.policy, tdm: { state: 'reserved' as const, evidence: [] } } },
  ]) await assert.rejects(prepareDocument({ ...preparation(), references: [changed] }, fixtureCommand));
  const pdf = { ...source, mimeType: 'application/pdf' };
  let calls = 0;
  await assert.rejects(prepareDocument({ ...preparation(), references: [pdf], mimeType: pdf.mimeType }, async () => { calls++; throw Error('must not run'); }), /parsed metadata evidence/);
  assert.equal(calls, 0);
});
test('PDF preparation policy requires byte-bound parsed metadata before invoking tools', async () => {
  let calls = 0;
  const input = preparation();
  await assert.rejects(prepareDocument({ ...input, mimeType: 'application/pdf', references: [{ ...reference(), mimeType: 'application/pdf' }], toolVersions: { node: '24', pdfinfo: '1', pdftotext: '1', pdftoppm: '1', tesseract: '1' } }, async () => { calls++; throw Error('must not run'); }), /parsed metadata evidence/);
  assert.equal(calls, 0);
});
test('private prepared cache rejects tampering and raw reads enforce containment and hashes', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'district-prepared-test-'))), root = join(base, 'prepared');
  try {
    const stateDir = join(base, 'policy-state');
    const authority = await provisionCivicPolicyAuthority({ stateDir, authorityId: 'fixture:' + randomUUID() });
    const options = { stateDir, authorityId: authority.authorityId, authoritySha256: authority.authoritySha256, decisionId: CIVIC_ACQUISITION_DECISION_ID, kind: 'prepared' as const };
    const receipt = await prepareDocument(preparation(), fixtureCommand);
    const path = await cachePreparedDocument(root, receipt, options);
    assert.equal(await cachePreparedDocument(root, receipt, options), path);
    await writeFile(path, JSON.stringify({ ...receipt, textSha256: sha256('tamper') }));
    await assert.rejects(cachePreparedDocument(root, receipt, options), /hash|policy state requires operator review/i);
    const rawRoot = join(base, 'raw-artifacts'), raw = join(rawRoot, 'source.txt');
    await initializeManagedAcquisitionLane(rawRoot, { ...options, kind: 'artifacts' });
    await withManagedSourceWrite(rawRoot, [{ kind: 'http_observation', relativePath: 'source.txt', contentSha256: sha256(bytes), sourceSha256: sha256(bytes), url: reference().url, observationId: 'synthetic-raw-fixture', receiptSha256: sha256('synthetic raw fixture receipt'), independentAllowed: true }], () => writeFile(raw, bytes, { mode: 0o600 }), options);
    assert.deepEqual(await readAuthorizedSourceBytes(rawRoot, raw, sha256(bytes), options), bytes);
    await assert.rejects(readAuthorizedSourceBytes(rawRoot, raw, sha256('wrong'), options), /frozen index/);
    await assert.rejects(readAuthorizedSourceBytes(raw, raw, sha256(bytes), options), /escapes/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
test('recorded host objection stops prepared cache, extraction and transfer before native commands', async () => {
  const fixture = await createCivicPolicyTestContext(), { root, policy } = fixture, cacheRoot = join(root, 'prepared');
  try {
    const receipt = await prepareDocument({ ...preparation(), managedRoot: cacheRoot, policy, sourceBindings: fixtureSourceBindings }, fixtureCommand);
    const path = await cachePreparedDocument(cacheRoot, receipt, { decisionId: APPROVED_OWNER_ROBOTS_OVERRIDE.id, ...policy });
    const objection = await recordHostOptOut({ host: 'example.org', reason: 'municipality_objection', reference: 'synthetic-preparation-test' }, policy);
    assert.equal(objection.purge.status, 'purged');
    await assert.rejects(stat(path), { code: 'ENOENT' });
    await assert.rejects(assertPreparedSourcesActive(receipt.references, policy), /objection/);
    await assert.rejects(cachePreparedDocument(cacheRoot, receipt, { decisionId: APPROVED_OWNER_ROBOTS_OVERRIDE.id, ...policy }), /objection/);
    await assert.rejects(readPreparedDocument(receipt, policy), /objection/);
    let commands = 0;
    await assert.rejects(prepareDocument({ ...preparation(), managedRoot: cacheRoot, policy, sourceBindings: fixtureSourceBindings }, async () => { commands++; throw Error('must not run'); }), /objection/);
    assert.equal(commands, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
function groups(count: number): WorkGroup[] {
  return Array.from({ length: count }, (_, index) => ({ municipalityId: index % 2 ? 'strausberg' : 'hoppegarten', sourceSha256: sha256(`source-${index}`), preparedSha256: sha256(`prepared-${index}`) }));
}
const contract = { promptSha256: sha256('joint extraction prompt'), schemaSha256: sha256('joint schema'), extractorSha256: sha256('joint extractor') };
test('frozen group plan is deterministic, balanced and samples identical prepared inputs', () => {
  const input = groups(1822);
  const plan = createWorkPlan(input, contract);
  assert.deepEqual(plan, createWorkPlan([...input].reverse().concat(input[0]), contract));
  const primary = plan.tasks.filter(task => task.purpose === 'production');
  const sample = plan.tasks.filter(task => task.purpose === 'agreement');
  assert.equal(primary.length, 1822);
  assert.ok(Math.abs(primary.filter(task => task.provider === 'openai-subscription').length-911)<100);
  assert.ok(sample.length>50&&sample.length<140);
  const subset=createWorkPlan(input.slice(0,500),contract);
  for(const task of subset.tasks)assert.ok(plan.tasks.some(full=>full.id===task.id&&full.provider===task.provider&&full.purpose===task.purpose));
  for (const task of sample) {
    const assigned = primary.find(primary => primary.groupId === task.groupId)!;
    assert.notEqual(task.provider, assigned.provider);
    assert.deepEqual(task.group, assigned.group);
    assert.notEqual(task.id, assigned.id);
  }
  assert.deepEqual(restoreWorkPlan(plan), plan);
  assert.equal(plan.extractorSha256,contract.extractorSha256);
  assert.deepEqual(restoreWorkPlan(JSON.parse(JSON.stringify(plan))),plan);
  assert.throws(()=>restoreWorkPlan({...plan,id:sha256('forged plan identity')}),/identity mismatch/);
  const broadContract={...contract,id:sha256('must not shadow derived identity'),unrelated:'must not leak'};
  assert.deepEqual(createWorkPlan(input,broadContract),plan);
  assert.throws(() => createWorkPlan([{ ...input[0], municipalityId: 'berlin' }], contract));
  assert.throws(() => createWorkPlan([input[0], { ...input[0], preparedSha256: sha256('other') }], contract), /conflicting/);
  const tampered = structuredClone(plan); tampered.tasks[0].provider = tampered.tasks[0].provider === 'openai-subscription' ? 'anthropic-subscription' : 'openai-subscription';
  assert.throws(() => restoreWorkPlan(tampered), /assignment/);
});

test('explicit Codex-only authorization is distinct from balanced assignment and never invokes a fallback',()=>{
  const input=groups(200),balanced=createWorkPlan(input,contract),only=createWorkPlan(input,contract,'codex-only');
  assert.notEqual(only.id,balanced.id);
  assert.equal(only.assignmentMode,'codex-only');
  assert.equal(only.tasks.length,input.length);
  assert.ok(only.tasks.every(task=>task.provider==='openai-subscription'&&task.purpose==='production'));
  for(const task of balanced.tasks.filter(task=>task.provider==='openai-subscription'&&task.purpose==='production'))assert.ok(only.tasks.some(other=>other.id===task.id));
  assert.deepEqual(restoreWorkPlan(JSON.parse(JSON.stringify(only))),only);
  assert.throws(()=>restoreWorkPlan({...only,assignmentMode:'balanced'}),/identity mismatch/);
});
test('provider/cache identity and every input contract component separate cached answers', () => {
  const input = { provider: 'openai-subscription' as const, modelIdentitySha256: sha256('model'), preparedSha256: sha256('prepared'), inputSha256: sha256('input'), promptSha256: contract.promptSha256, schemaSha256: contract.schemaSha256, extractorSha256: sha256('extractor'), purpose: 'extraction' as const };
  const original = modelCacheKey(input);
  assert.notEqual(original, modelCacheKey({ ...input, provider: 'anthropic-subscription' }));
  assert.notEqual(original, modelCacheKey({ ...input, purpose: 'judge' }));
  for (const field of ['modelIdentitySha256', 'preparedSha256', 'inputSha256', 'promptSha256', 'schemaSha256', 'extractorSha256'] as const) assert.notEqual(original, modelCacheKey({ ...input, [field]: sha256('changed') }));
});
test('parallel lanes bound each provider to one call and retain failures and pending work without reroute', async () => {
  const plan = createWorkPlan(groups(40), contract);
  const snapshots: WorkPlan[] = [];
  const active = { 'openai-subscription': 0, 'anthropic-subscription': 0 };
  const initialOverlap = Promise.withResolvers<void>();
  let simultaneouslyActive = false;
  let failOpenai = true;
  await runWorkPlan(plan, async (task, current) => {
    active[task.provider]++;
    assert.equal(active[task.provider], 1);
    simultaneouslyActive ||= Object.values(active).every(value => value === 1);
    if (simultaneouslyActive) initialOverlap.resolve();
    await initialOverlap.promise;
    active[task.provider]--;
    if (task.provider === 'openai-subscription' && failOpenai) { failOpenai = false; throw Error('quota'); }
    return { resultSha256: sha256(task.id), preparedSha256: task.group.preparedSha256, ...current };
  }, async snapshot => { snapshots.push(snapshot); }, async () => false);
  assert.equal(simultaneouslyActive, true);
  assert.equal(plan.providers['openai-subscription'], 'paused');
  assert.equal(plan.tasks.filter(task => task.state === 'failed').length, 1);
  assert.ok(plan.tasks.some(task => task.provider === 'openai-subscription' && task.state === 'pending'));
  assert.ok(plan.tasks.filter(task => task.provider === 'anthropic-subscription').every(task => task.state === 'completed'));
  assert.ok(snapshots.some(snapshot => snapshot.tasks.some(task => task.state === 'running')));
  const failed = plan.tasks.find(task => task.state === 'failed')!;
  assert.equal(failed.failureCategory, 'quota');
  assert.equal(failed.errorMessageSha256, sha256('quota'));
  assert.equal(restoreWorkPlan(plan).tasks.find(task => task.id === failed.id)!.failureCategory, 'quota');
  resumeWorkPlan(plan, 'openai-subscription');
  assert.equal(failed.failureCategory, null);
  assert.equal(failed.errorMessageSha256, null);
  await runWorkPlan(plan, async (task, current) => ({ resultSha256: sha256(task.id), preparedSha256: task.group.preparedSha256, ...current }), async () => {}, async () => false);
  assert.ok(plan.tasks.every(task => task.state === 'completed'));
});
test('interrupted plans require explicit provider resume; operator pause starts no calls', async () => {
  const plan = createWorkPlan(groups(20), contract);
  plan.tasks[0].state = 'running'; plan.tasks[0].attempts = 1;
  const recovered = restoreWorkPlan(plan);
  assert.equal(recovered.tasks[0].state, 'failed');
  assert.equal(recovered.tasks[0].failure, 'interrupted');
  assert.equal(recovered.providers[plan.tasks[0].provider], 'paused');
  let calls = 0;
  await runWorkPlan(recovered, async () => { calls++; throw Error('must not run'); }, async () => {}, async () => true);
  assert.equal(calls, 0);
});

test('pilot authorization rejects an internally correct substituted index and pinned preparation plan', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'district-corpus-authorization-'));
  try {
    assert.equal(authorizedPilotCorpusSchema.parse(PILOT_BASE_CORPUS_SHA256), PILOT_BASE_CORPUS_SHA256);
    assert.equal(authorizedPilotCorpusSchema.parse(PILOT_COMPLETION_CORPUS_SHA256), PILOT_COMPLETION_CORPUS_SHA256);
    const index = JSON.stringify({ schemaVersion: 'stadtstack-crawl-index-v1', documents: [], laterCrawlDocuments: 7623 });
    const path = join(directory, 'index.json');
    await writeFile(path, index);
    await assert.rejects(loadFrozenCorpus(path, sha256(index)), /Invalid option/);
    await assert.rejects(loadFrozenCorpus(path, PILOT_BASE_CORPUS_SHA256), /hash mismatch/);
    const plan = { schemaVersion: 'stadtstack-preparation-plan-v1', generatedAt: '2026-10-01T00:00:00.000Z', corpusSha256: PILOT_BASE_CORPUS_SHA256, registrySha256: sha256('registry'), extractorSha256: sha256('extractor'), maxDocumentsPerMunicipality: null, availableDocumentGroups: 0, selectedDocumentGroups: 0, selectedRepresentations: 0, municipalities: [], groups: [], quarantine: [] };
    assert.equal(preparationPlanSchema.parse(plan).corpusSha256, PILOT_BASE_CORPUS_SHA256);
    const substituted = JSON.stringify({ ...plan, corpusSha256: sha256(index) }), planPath = join(directory, 'plan.json');
    await writeFile(planPath, substituted);
    // Mac coordinator and VM worker both apply this schema after transport pinning.
    const correctlyPinned = await readPinnedJson(planPath, sha256(substituted));
    assert.throws(() => preparationPlanSchema.parse(correctlyPinned), /Invalid option/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('provider failures persist only allowlisted categories and message digests across local and remote lanes', async () => {
  for (const [supplied, expected] of [
    ['subscription_authentication', 'authentication'], ['tool_attempt', 'tool'], ['process_failure', 'transport'],
    ['model_identity_mismatch', 'integrity'], ['model_identity_missing', 'integrity'], ['rate_limit', 'quota'],
    ['generation_error', 'model'], ['invalid_structured_output', 'model'], ['operator_pause', 'operator_pause'],
    ['unknown-private-category', 'provider_failed'], ['toString', 'provider_failed'],
  ]) {
    const message = 'private-source-and-account-details';
    const classified = classifyWorkFailure(Object.assign(Error(message), { failureCategory: supplied }));
    assert.deepEqual(classified, { failureCategory: expected, errorMessageSha256: sha256(message) });
    assert.deepEqual(classifyWorkFailure(new RemoteWorkFailure(classified)), classified);
    assert.doesNotMatch(JSON.stringify(classified), /private-source|private-category/);
  }
  for (const [message, expected] of [['Subscription existing authentication unavailable', 'authentication'], ['Source cache integrity mismatch', 'integrity'], ['Authenticated extraction worker timed out', 'transport'], ['quota', 'quota']]) {
    assert.equal(classifyWorkFailure(Error(message)).failureCategory, expected);
  }
  assert.throws(() => new RemoteWorkFailure({ failureCategory: 'raw-private-category', errorMessageSha256: sha256('message') }));
  assert.throws(() => new RemoteWorkFailure({ failureCategory: 'tool', errorMessageSha256: sha256('message'), stderr: 'private' }));
  const plan = createWorkPlan(groups(8), contract);
  const failure = classifyWorkFailure(Object.assign(Error('private-source-payload'), { failureCategory: 'tool_attempt' }));
  await runWorkPlan(plan, async () => { throw new RemoteWorkFailure(failure); }, async snapshot => {
    assert.doesNotMatch(JSON.stringify(snapshot), /private-source-payload/);
  }, async () => false);
  for (const task of restoreWorkPlan(plan).tasks.filter(task => task.state === 'failed')) {
    assert.equal(task.failureCategory, 'tool'); assert.equal(task.errorMessageSha256, sha256('private-source-payload'));
  }
  assert.ok(plan.tasks.some(task => task.state === 'pending'));
});

test('global owner-policy preparation and model defaults do not enroll historical frozen roots', () => {
  assert.equal(PREPARED_VM_ROOT, '/home/max/civic-knowledge-slice/stadtstack-data/cache/districts/owner-policy-2026-10-11/prepared');
});

test('a dated directory name cannot authorize a populated unmarked prepared cache', async () => {
  const fixture = await createCivicPolicyTestContext(), { root, policy } = fixture, cacheRoot = join(root, 'owner-policy-2026-10-11', 'prepared');
  try {
    const receipt = await prepareDocument({ ...preparation(), managedRoot: join(root, 'preparation'), policy, sourceBindings: fixtureSourceBindings }, fixtureCommand), body = JSON.stringify(receipt) + '\n';
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const path = join(cacheRoot, receipt.receiptSha256 + '.json');
    await writeFile(path, body, { mode: 0o600 });
    const authorityPath = join(policy.stateDir!, 'authority.json'), inventoryPath = join(policy.stateDir!, 'inventory.json');
    const authorityBefore = await readFile(authorityPath), inventoryBefore = await readFile(inventoryPath);
    await assert.rejects(cachePreparedDocument(cacheRoot, receipt, { decisionId: APPROVED_OWNER_ROBOTS_OVERRIDE.id, ...policy }), /policy state/);
    assert.equal(await readFile(path, 'utf8'), body);
    await assert.rejects(stat(join(cacheRoot, '.civic-acquisition-lane.json')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(authorityPath), authorityBefore);
    assert.deepEqual(await readFile(inventoryPath), inventoryBefore);
    assert.equal((await assertCivicPolicyAuthority(policy)).authoritySha256, policy.authoritySha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing or divergent authority cannot authorize prepared source processing', async () => {
  const fixture = await createCivicPolicyTestContext();
  try {
    for (const policy of [
      { ...fixture.policy, stateDir: join(fixture.root, 'missing-authority') },
      { ...fixture.policy, authoritySha256: sha256('different authority') },
      { stateDir: fixture.policy.stateDir },
    ]) await assert.rejects(prepareDocument({ ...preparation(), managedRoot: fixture.managedRoot, policy, sourceBindings: fixtureSourceBindings }, fixtureCommand), /policy state/);
    await assert.rejects(stat(fixture.managedRoot), { code: 'ENOENT' });
  } finally { await fixture.dispose(); }
});
