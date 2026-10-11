import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import { DistrictExtractionClaimsSchema, DistrictKnowledgeRecordSchema, QUOTE_NORMALIZATION_VERSION, assertSubscriptionSourcePolicy, knowledgeEvidenceHash, sha256, validateKnowledgeRelease, type DistrictKnowledgeRecord } from '../src/district-schema.ts';
import { canonicalWhitespace, dateOccursInQuote, deterministicChecks, documentChunks, extractionCacheKey, summaryNumbersSupported, NoCaseCacheSchema, rebindSourceReferences, restoreSourceQuotes, EXTRACTION_INSTRUCTIONS, JUDGE_INSTRUCTIONS, EXTRACTOR_VERSION, PROMPT_VERSION, JUDGE_PROMPT_VERSION, PROMPT_SHA256, JUDGE_PROMPT_SHA256, type ExtractionCacheBinding } from '../src/district-claims.ts';
import {stageEvidenceSupports} from '../src/district-stage-evidence.ts';
import { codexResponseSchema, inspectCodexEvents, subscriptionExecutionArgs } from '../src/district-model.ts';
import { extractDocumentText, htmlToDocumentText } from '../src/district-document.ts';
import { TOPIC_VOCABULARY, getTopic, topicAncestors } from '../src/topic-vocabulary.ts';
import { TOPICS } from '../regional/taxonomy.mjs';
import {groupCrawlDocuments,selectExtractionGroups} from '../src/district-corpus.ts';
import {PROVIDER_CONFIGS} from '../src/district-model-contract.ts';
import {normalizeGraphClaims} from '../src/district-graph-claims.ts';
import {ownerRobotsOverrideFor} from '../src/source-policy.ts';
import { DOCUMENT_ORIGIN_CLASSIFIER_VERSION } from '../src/document-origin-contract.ts'
import type {CivicPolicyOptions, ManagedSourceContext} from '../src/civic-opt-out.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
const EXTRACTION_MODEL=PROVIDER_CONFIGS['openai-subscription'].model;

test('Bounded extraction prioritizes grounded seeds, preserves same-byte references and gives municipalities fair turns',()=>{
  const documents=[
    {municipalityId:'one',sourceId:'website',url:'https://example.org/old',sha256:'old'},
    {municipalityId:'one',sourceId:'gazette',url:'https://example.org/seed',sha256:'seed'},
    {municipalityId:'one',sourceId:'website',url:'https://example.org/copy',sha256:'seed'},
    {municipalityId:'two',sourceId:'gazette',url:'https://example.org/two',sha256:'two'}
  ];
  const seeds=[{municipalityId:'one',sourceId:'gazette',url:'https://example.org/seed'}];
  const bounded=selectExtractionGroups(documents,seeds,1);
  assert.deepEqual(bounded.map(group=>group.map(document=>document.url)),[['https://example.org/seed','https://example.org/copy'],['https://example.org/two']]);
  const full=selectExtractionGroups(documents,seeds);
  assert.deepEqual(full.map(group=>group[0].municipalityId),['one','two','one']);
  assert.equal(full.flat().length,documents.length);
  assert.throws(()=>selectExtractionGroups(documents,seeds,0),/positive integer/);
  assert.throws(()=>selectExtractionGroups(documents,seeds,NaN),/positive integer/);
});
test('Summary dates allow exact calendar equivalence without borrowing date digits for other numbers',()=>{
  assert.equal(summaryNumbersSupported('Gültig am 1. Januar 2026.','Gültig am 01.01.2026.'),true);
  assert.equal(summaryNumbersSupported('Beginn 2026-10-09, Kosten 1.250,00 Euro.','Beginn am 9. Oktober 2026, Kosten 1.250,00 Euro.'),true);
  assert.equal(summaryNumbersSupported('Beginn 2026-10-10.','Beginn am 9. Oktober 2026.'),false);
  assert.equal(summaryNumbersSupported('Kosten 2026 Euro.','Beschlossen am 09.10.2026.'),false);
  assert.equal(summaryNumbersSupported('Kosten 1.251,00 Euro.','Kosten 1.250,00 Euro.'),false);
  assert.equal(summaryNumbersSupported('Bebauungsplan 67/22 liegt aus.','Der Entwurf liegt aus.'),false);
  assert.equal(summaryNumbersSupported('Beginn 2026-02-30.','Beginn am 28. Februar 2026.'),false);
  assert.equal(summaryNumbersSupported('Beginn 2026-10-09.','Beginn 09.10.26.'),false);
  assert.equal(summaryNumbersSupported('Die 1. Änderung wurde beschlossen.', 'Die Änderung wurde beschlossen.'), false);
});

test('shared extraction and judge instructions fit the native 8000-byte system bound', () => {
  assert.ok(Buffer.byteLength(EXTRACTION_INSTRUCTIONS, 'utf8') <= 8000);
  assert.ok(Buffer.byteLength(JUDGE_INSTRUCTIONS, 'utf8') <= 8000);
});

test('action relation contract is versioned in shared extraction and faithfulness prompts', () => {
  assert.equal(EXTRACTOR_VERSION, 'district-extractor-v10-civic-policy-facts');
  assert.equal(PROMPT_VERSION, 'district-claims-v9-civic-policy-facts');
  assert.equal(JUDGE_PROMPT_VERSION, 'district-faithfulness-v8-civic-policy-facts');
  for (const instructions of [EXTRACTION_INSTRUCTIONS, JUDGE_INSTRUCTIONS]) {
    assert.ok(instructions.includes('Joint graph in this SAME response'));
    assert.ok(instructions.includes('predicateQuote copies the COMPLETE relation verb/phrase'));
    assert.ok(instructions.includes('plans/planned, never implements/planned or implements/implemented.'));
    assert.ok(instructions.includes('decides/decided or approves/decided, NOT construction'));
    assert.ok(instructions.includes('conditional/negated/historical qualifiers override factual modalities'));
    assert.ok(instructions.includes('not just lexical matches'));
  }
  assert.ok(JUDGE_INSTRUCTIONS.includes('criticalUnsupported=true and score below 0.8'));
});
// Synthetic unit-test material only; never a municipal record or production model evidence.
const text = 'Stadt Beispielstadt\nWärmeplanung\nDer Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.\nStand: 10.10.2026';
const now = '2026-10-10T12:00:00.000Z';
function claims() {
  return DistrictExtractionClaimsSchema.parse({
    title: 'Wärmeplanung', titleQuote: 'Wärmeplanung',
    summary: 'Der Entwurf der Wärmeplanung wurde veröffentlicht.', summaryQuote: 'Der Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.',
    municipalityQuote: 'Stadt Beispielstadt', caseKey: null, caseKeyType: 'source_document', caseQuote: null, caseType: 'planning',
    documentDate: '2026-10-10', documentDateQuote: 'Stand: 10.10.2026', documentDateReason: null,
    topics: [{ id: 'waermeplanung', parentId: 'energie', provenance: 'model', confidence: 0.9, quote: 'Wärmeplanung' }],
    stage: 'draft', stageDate: '2026-10-09', stageDateQuote: 'Der Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.', stageDateReason: null,
    originalStatus: 'Entwurf', stageQuote: 'Der Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.', stages: [],
    entities: [{ mentionId:'municipality', name: 'Beispielstadt', type: 'municipality', quote: 'Stadt Beispielstadt', identifiers:[] }], relations:[], locations: [],
  });
}
function record(): DistrictKnowledgeRecord {
  const sourceHash = sha256(text);
  const value = {
    ...claims(), ...normalizeGraphClaims(claims(),{municipalityId:'beispielstadt',sourceSha256:sourceHash,ags:'12064001'}), id: 'knowledge:unit-test', municipalityId: 'beispielstadt', ags: '12064001', districtId: 'unit-district', caseKey: `source_document:${sourceHash}`,
    sources: [{ id: 'unit-source', url: 'https://example.org/document', sha256: sourceHash, retrievedAt: now, locator: 'chars:0-160', mimeType: 'text/plain', sourceType: 'website', policy: { robots: { state: 'allowed', url: 'https://example.org/robots.txt' }, tdm: { state: 'not_declared', evidence: [] }, access: 'public', legalClassification: 'not_assessed', publication: 'facts_with_attribution_only' } }],
    extraction: { extractorVersion: 'unit-test', extractorSha256: sha256('extractor'), model: EXTRACTION_MODEL, provider: 'openai-subscription', tool: 'codex-cli', toolVersion: '0.162.1', modelIdentitySha256: sha256('synthetic configured model/tool identity'), modelIdentityBasis: 'configured-cli-model-and-tool-version', returnedModel: null, promptVersion: 'unit-test', promptSha256: PROMPT_SHA256, judgePromptVersion: 'unit-test', judgePromptSha256: JUDGE_PROMPT_SHA256, inputSha256: sourceHash, textSha256: sourceHash, responseSha256: sha256('synthetic extraction response'), ocrUsed: false, textMethod: 'text', cacheKey: sha256('unit cache'), extractedAt: now, chunk: { index: 0, count: 1, start: 0, end: text.length } },
    verification: { status: 'auto-verified', deterministic: deterministicChecks(claims(), text, 'Beispielstadt'), faithfulness: { score: 0.9, threshold: 0.8, model: EXTRACTION_MODEL, provider: 'openai-subscription', tool: 'codex-cli', toolVersion: '0.162.1', modelIdentitySha256: sha256('synthetic configured model/tool identity'), returnedModel: null, reason: 'Synthetic unit-test judge fixture, not actual model evidence', evaluatedAt: now, responseSha256: sha256('synthetic judge response'), sameModel: true, limitation: 'Same-model judgment is not independent verification.' }, evidenceHash: '' },
  };
  value.verification.evidenceHash = knowledgeEvidenceHash(value);
  return DistrictKnowledgeRecordSchema.parse(value);
}
const registry = { municipalities: [{ id: 'beispielstadt', name: 'Beispielstadt', ags: '12064001', districtId: 'unit-district', sources: [{ id: 'unit-source', kind: 'website', url: 'https://example.org', checkState: 'checked' }] }] };

function documentContext(authority: { managedRoot: string; decisionId: ManagedSourceContext['decisionId']; policy: CivicPolicyOptions }, bytes: Uint8Array): ManagedSourceContext {
  const url = 'https://example.org/synthetic-document', sourceSha256 = sha256(bytes), observationId = `synthetic-document:${sourceSha256}`;
  const receiptSha256 = sha256(JSON.stringify({ url, sourceSha256, observationId }));
  return { root: authority.managedRoot, kind: 'artifacts', decisionId: authority.decisionId, ...authority.policy, bindings: [{ kind: 'prepared_source', url, sourceSha256, observationId, receiptSha256 }] };
}

test('hierarchy preserves all canonical regional leaves without duplicating vocabulary', () => {
  for (const topic of TOPICS) {
    assert.equal(getTopic(topic.id)?.label, topic.label);
    assert.equal(getTopic(topic.id)?.pattern, topic.pattern);
    assert.ok(getTopic(topic.id)?.parentId);
  }
  assert.equal(new Set(TOPIC_VOCABULARY.map(topic => topic.id)).size, TOPIC_VOCABULARY.length);
  assert.deepEqual(topicAncestors('solarpark'), ['energie']);
});
test('deterministic source evidence passes only exact municipality, quotations and numbers', () => {
  assert.equal(deterministicChecks(claims(), text, 'Beispielstadt').passed, true);
  const fabricated = claims();
  fabricated.summary = 'Der Entwurf kostet 500000 Euro.';
  assert.equal(deterministicChecks(fabricated, text, 'Beispielstadt').checks.find(check => check.id === 'summary_numbers')?.passed, false);
  fabricated.titleQuote = 'Nicht im Dokument';
  assert.equal(deterministicChecks(fabricated, text, 'Beispielstadt').checks.find(check => check.id === 'exact_quotes')?.passed, false);
  assert.equal(deterministicChecks(claims(), text, 'Andere Stadt').passed, false);
});
test('dates reject impossible days and retrieval-time substitution', () => {
  assert.equal(dateOccursInQuote('2026-10-09', '9. Oktober 2026'), true);
  assert.equal(dateOccursInQuote('2026-10-09', '09.10.2026'), true);
  assert.equal(dateOccursInQuote('2026-02-30', '30.02.2026'), false);
  assert.equal(dateOccursInQuote('2026-10-10', '09.10.2026'), false);
  const missing = claims();
  missing.documentDate = null; missing.documentDateQuote = null; missing.documentDateReason = 'Not stated';
  assert.equal(deterministicChecks(missing, text, 'Beispielstadt').passed, true);
});
test('stage labels, source identifiers and topic assignments fail closed', () => {
  const value = claims();
  value.originalStatus = 'in Kraft';
  assert.equal(deterministicChecks(value, text, 'Beispielstadt').passed, false);
  value.originalStatus = 'Entwurf'; value.caseKey = 'B-999'; value.caseKeyType = 'plan_number';
  assert.equal(deterministicChecks(value, text, 'Beispielstadt').passed, false);
  value.caseKey = null; value.caseKeyType = 'source_document'; value.topics[0].parentId = 'mobilitaet';
  assert.equal(deterministicChecks(value, text, 'Beispielstadt').passed, false);
});
test('source-only location geometry does not permit inferred pins', () => {
  const value = claims();
  value.locations = [{ label: 'Beispielstadt', quote: 'Stadt Beispielstadt', geometry: { type: 'Point', coordinates: [13.9, 52.5] }, precision: 'approximate' }];
  assert.equal(deterministicChecks(value, text, 'Beispielstadt').checks.find(check => check.id === 'geometry')?.passed, false);
  value.locations[0].geometry = null; value.locations[0].precision = 'none';
  assert.equal(deterministicChecks(value, text, 'Beispielstadt').passed, true);
});
test('release requires actual-shaped judge evidence, all deterministic checks and identity binding', () => {
  const good = record();
  const envelope = { schemaVersion: 'stadtstack-knowledge-v2', generatedAt: now, records: [good] };
  assert.equal(validateKnowledgeRelease(envelope, registry).records.length, 1);
  for (const score of [null, 0.79]) {
    const bad = structuredClone(good);
    bad.verification.faithfulness.score = score;
    bad.verification.evidenceHash = knowledgeEvidenceHash(bad);
    assert.throws(() => DistrictKnowledgeRecordSchema.parse(bad));
  }
  const fake = structuredClone(good);
  fake.verification.deterministic.checks = [{ id: 'schema', passed: true, reason: 'Missing all other gates' }];
  fake.verification.evidenceHash = knowledgeEvidenceHash(fake);
  assert.throws(() => DistrictKnowledgeRecordSchema.parse(fake));
  const candidate = structuredClone(good); candidate.verification.status = 'candidate';
  candidate.verification.evidenceHash = knowledgeEvidenceHash(candidate);
  assert.throws(() => validateKnowledgeRelease({ ...envelope, records: [candidate] }, registry), /Candidate/);
  assert.throws(() => validateKnowledgeRelease(envelope, { municipalities: [] }), /Unbound municipality/);
  good.title = 'Mutated after judging';
  assert.throws(() => DistrictKnowledgeRecordSchema.parse(good), /evidence hash/);
});
test('evidence hash is stable under JSON property order, but bound to all claims', () => {
  const value = record();
  const reordered = Object.fromEntries(Object.entries(value).reverse()) as DistrictKnowledgeRecord;
  assert.equal(knowledgeEvidenceHash(value), knowledgeEvidenceHash(reordered));
  reordered.summary = 'Different';
  assert.notEqual(knowledgeEvidenceHash(value), knowledgeEvidenceHash(reordered));
});
test('cache separates model, extractor, document, municipality and chunk', () => {
  const args:ExtractionCacheBinding={provider:'openai-subscription',documentHash:sha256('doc'),textHash:sha256('text'),extractorHash:sha256('extractor'),modelIdentitySha256:sha256('model'),chunk:{index:0,start:0,end:20},municipalityId:'beispielstadt',sourceBinding:'fixture'};
  const key=extractionCacheKey(args);
  assert.equal(key,extractionCacheKey(args));
  assert.notEqual(key,extractionCacheKey({...args,documentHash:sha256('other')}));
  assert.notEqual(key,extractionCacheKey({...args,extractorHash:sha256('new extractor')}));
  assert.notEqual(key,extractionCacheKey({...args,modelIdentitySha256:sha256('new model')}));
  assert.notEqual(key,extractionCacheKey({...args,municipalityId:'another'}));
  assert.notEqual(key,extractionCacheKey({...args,provider:'anthropic-subscription'}));
});
test('subscription runtime disables exposed execution features and uses only existing ChatGPT auth', () => {
  const args = subscriptionExecutionArgs('/tmp/unit', '/tmp/unit/schema.json', '/tmp/unit/answer.json', 'Synthetic extraction instructions');
  for (const argument of ['--ephemeral', '--ignore-user-config', '--ignore-rules', 'read-only', 'forced_login_method="chatgpt"', 'model_provider="openai"', 'shell_tool', 'unified_exec', 'browser_use', 'plugins']) assert.ok(args.includes(argument));
  assert.ok(args.includes(EXTRACTION_MODEL));
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
});
test('subscription JSONL rejects any tool attempt and wrong reported model', () => {
  const success = inspectCodexEvents(['{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}', '{"type":"turn.completed"}'].join('\n'));
  assert.equal(success.completed, true);
  assert.equal(success.toolAttempted, false);
  assert.equal(success.returnedModel, null);
  for (const type of ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list']) {
    assert.equal(inspectCodexEvents(JSON.stringify({ type: 'item.started', item: { type } })).toolAttempted, true);
  }
  assert.throws(() => inspectCodexEvents('{"type":"session.started","model":"another-model"}'), /different model/);
  assert.equal(inspectCodexEvents('{"type":"turn.failed","error":{"message":"429 rate limit"}}').rateLimited, true);
});
test('same-byte re-fetch reuses actual model evidence but rebinds current retrieval metadata', () => {
  const original = record();
  const next = rebindSourceReferences(original, [{ ...original.sources[0], retrievedAt: '2026-10-11T12:00:00.000Z' }]);
  assert.equal(next.extraction.cacheKey, original.extraction.cacheKey);
  assert.equal(next.extraction.responseSha256, original.extraction.responseSha256);
  assert.deepEqual(next.verification.faithfulness, original.verification.faithfulness);
  assert.equal(next.extraction.extractedAt, original.extraction.extractedAt);
  assert.notEqual(next.verification.evidenceHash, original.verification.evidenceHash);
  assert.equal(next.sources[0].retrievedAt, '2026-10-11T12:00:00.000Z');
  assert.throws(() => rebindSourceReferences(original, [{ ...original.sources[0], sha256: sha256('changed bytes') }]), /identical/);
});
test('chunking covers entire long sources with bounded overlap and no silent truncation', () => {
  const source = 'a'.repeat(40000);
  const chunks = documentChunks(source);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks.at(-1)!.end, source.length);
  assert.ok(chunks.every(chunk => chunk.text.length <= 12000 && source.slice(chunk.start, chunk.end) === chunk.text));
  for (let index = 1; index < chunks.length; index++) assert.ok(chunks[index].start < chunks[index - 1].end);
  assert.throws(() => documentChunks('x'.repeat(4800 * 81)), /chunk limit/);
  assert.equal(documentChunks('x'.repeat(320800)).at(-1)!.end,320800);
  assert.throws(() => documentChunks('x'.repeat(320801)), /chunk limit/);
});
test('contiguous context retains a distant printed document date and explicit correction without borrowed evidence',async()=>{
  const fixture=JSON.parse(await readFile(new URL('../reports/correction-solarpark-0.3.2.json',import.meta.url),'utf8'));
  // Synthetic placement reproduces the known span distance; this is not the actual PDF/text snapshot.
  const header='10. Änderung des Flächennutzungsplans\n7. August 2025\n';
  const source=header+'x'.repeat(10604-header.length)+fixture.replacementEvidence.quote+'y'.repeat(20000);
  const first=documentChunks(source)[0];
  assert.equal(first.text,source.slice(first.start,first.end));
  assert.ok(first.text.includes('7. August 2025'));
  assert.ok(first.text.includes(fixture.replacementEvidence.quote));
  assert.notEqual(sha256(source),fixture.replacementEvidence.expectedRetainedSourceSha256);
  assert.match(EXTRACTION_INSTRUCTIONS,/both values, units, approximations/);
  assert.match(JUDGE_INSTRUCTIONS,/proposed, conditional or denied change/);
  assert.equal(EXTRACTION_INSTRUCTIONS.includes('68,6'),false);
  assert.equal(EXTRACTION_INSTRUCTIONS.includes('41,5'),false);
});
test('HTML extraction removes active content and decodes source text', () => {
  assert.equal(htmlToDocumentText('<script>fake instructions</script><p>W&auml;rme &amp; &#246;ffentlich</p>'), 'Wärme & öffentlich');
});
test('PDF text layer precedes per-page OCR; sparse page uses German and English OCR', async t => {
  const authority = await createCivicPolicyTestContext(t), bytes = Buffer.from('%PDF-unit-test');
  const calls: Array<{ file: string; args: string[] }> = [];
  const result = await extractDocumentText(bytes, 'application/pdf', documentContext(authority, bytes), async (file, args) => {
    calls.push({ file, args });
    if (file === 'pdfinfo') return 'Pages: 2';
    if (file === 'pdftotext') { assert.equal(args.includes('-layout'),false); return `${text.repeat(2)}\f\f`; }
    if (file === 'pdftoppm') return '';
    if (file === 'tesseract') return 'Scanned municipal source text recovered by the test command seam.';
    throw Error('Unexpected command');
  });
  assert.equal(result.ocrUsed, true);
  assert.equal(result.method, 'pdf_ocr');
  assert.equal(calls.filter(call => call.file === 'pdftoppm').length, 1);
  assert.equal(calls.find(call => call.file === 'pdftoppm')!.args[1], '2');
  assert.ok(calls.find(call => call.file === 'tesseract')!.args.includes('deu+eng'));
  assert.match(result.text, /recovered/);
});
test('missing OCR and oversized page count are explicit failures, not fabricated text', async t => {
  const authority = await createCivicPolicyTestContext(t), bytes = Buffer.from('%PDF-test'), context = documentContext(authority, bytes);
  await assert.rejects(extractDocumentText(bytes, 'application/pdf', context, async file => {
    if (file === 'pdfinfo') return 'Pages: 1';
    if (file === 'pdftotext' || file === 'pdftoppm') return '';
    throw Error('Missing document prerequisite: tesseract');
  }), /Missing document prerequisite: tesseract/);
  await assert.rejects(extractDocumentText(bytes, 'application/pdf', context, async () => 'Pages: 81'), /80-page limit/);
});

test('XML/GML remains source text without expanding external entities', async t => {
  const authority = await createCivicPolicyTestContext(t);
  const xml = '<Plan><name>Beispielstadt Wärmeplanung</name><datum>2026-10-10</datum></Plan>';
  const bytes = Buffer.from(xml), result = await extractDocumentText(bytes, 'application/gml+xml', documentContext(authority, bytes));
  assert.equal(result.text, xml);
  assert.equal(result.method, 'xml');
});
test('bounded ZIP reads recognized XML/GML only and discloses uninterpreted members', async t => {
  const authority = await createCivicPolicyTestContext(t), bytes = Buffer.from('synthetic zip seam');
  const xml = '<Plan><name>Beispielstadt Wärmeplanung</name><datum>2026-10-10</datum></Plan>';
  const result = await extractDocumentText(bytes, 'application/zip', documentContext(authority, bytes), async (file, args) => {
    assert.equal(file, 'python3');
    assert.equal(args[0], '-c');
    assert.match(args[1], /archive\.read/);
    return JSON.stringify({ text: xml, skipped: 2 });
  });
  assert.equal(result.text, xml);
  assert.equal(result.method, 'zip_xml');
  assert.match(result.limitations![0], /2 other archive members/);
  const unsupported = Buffer.from('zip seam');
  await assert.rejects(extractDocumentText(unsupported, 'application/zip', documentContext(authority, unsupported), async () => JSON.stringify({ error: 'Unsupported document ZIP: no XML/GML member' })), /no XML\/GML/);
});

test('missing, reserved or blocked source policy prevents subscription transmission and release', () => {
  assert.throws(() => assertSubscriptionSourcePolicy(undefined), /recollect/);
  const allowed = record().sources[0].policy;
  assert.equal(assertSubscriptionSourcePolicy(allowed).tdm.state, 'not_declared');
  for (const blocked of [
    { ...allowed, robots: { ...allowed.robots, state: 'blocked' } },
    { ...allowed, tdm: { ...allowed.tdm, state: 'reserved' } },
    { ...allowed, tdm: { ...allowed.tdm, state: 'unavailable' } },
    { ...allowed, access: 'captcha' },
  ]) assert.throws(() => assertSubscriptionSourcePolicy(blocked), /ask_municipality/);
  const cached = record();
  assert.throws(() => rebindSourceReferences(cached, [{ ...cached.sources[0], policy: { ...cached.sources[0].policy, access: 'captcha' } }]), /ask_municipality/);
});
test('record and cache source rebinding retain the blocked owner decision without weakening other release gates', () => {
  const original = record(), url = 'https://strausberg.allris.cloud/public/si010';
  const source: DistrictKnowledgeRecord['sources'][number] = {
    ...original.sources[0], id: 'strausberg-council', url, sourceType: 'council',
    policy: { ...original.sources[0].policy, robots: { state: 'blocked', url: new URL('/robots.txt', url).href, sha256: sha256('synthetic robots denial'), checkedAt: '2026-10-11T12:00:00.000Z' }, ownerRobotsOverride: ownerRobotsOverrideFor(url)!, robotsStatus: 'disallowed', override: 'owner-approved 2026-10-11', documentOrigin: { classification: 'official_work', method: 'rules', classifierVersion: DOCUMENT_ORIGIN_CLASSIFIER_VERSION, url, sha256: original.sources[0].sha256, classifiedAt: '2026-10-11T12:00:00.000Z', evidence: [{ locator: 'synthetic fixture', value: 'administrative authorship and formal work fixture' }] } },
  };
  const rebound = rebindSourceReferences(original, [source]);
  const retained = DistrictKnowledgeRecordSchema.parse(rebound).sources.find(item => item.id === source.id)!;
  assert.deepEqual(retained.policy, source.policy);
  assert.equal(retained.policy.robots.state, 'blocked');
  assert.notEqual(rebound.verification.evidenceHash, original.verification.evidenceHash);
  for (const mutate of [
    (item: typeof source) => { item.url = 'https://other.allris.cloud/public/si010'; },
    (item: typeof source) => { delete item.policy.ownerRobotsOverride; },
    (item: typeof source) => { item.policy.robots.state = 'unavailable'; },
    (item: typeof source) => { item.policy.access = 'captcha'; },
    (item: typeof source) => { item.policy.tdm.state = 'reserved'; },
    (item: typeof source) => { item.mimeType = 'application/pdf'; },
  ]) {
    const changed = structuredClone(rebound);
    mutate(changed.sources.find(item => item.id === source.id)!);
    changed.verification.evidenceHash = knowledgeEvidenceHash(changed);
    assert.equal(DistrictKnowledgeRecordSchema.safeParse(changed).success, false);
  }
  const failedGates = structuredClone(rebound);
  failedGates.verification.faithfulness.score = 0;
  failedGates.verification.evidenceHash = knowledgeEvidenceHash(failedGates);
  assert.equal(DistrictKnowledgeRecordSchema.safeParse(failedGates).success, false);
});

test('source-category duplicates group once per municipality and bytes, without merging municipalities', () => {
  const docs = [
    { municipalityId: 'one', sha256: sha256('same bytes'), sourceId: 'website', url: 'https://example.org/file.pdf' },
    { municipalityId: 'one', sha256: sha256('same bytes'), sourceId: 'gazette', url: 'https://example.org/file.pdf' },
    { municipalityId: 'one', sha256: sha256('same bytes'), sourceId: 'council', url: 'https://example.org/archive-copy.pdf' },
    { municipalityId: 'two', sha256: sha256('same bytes'), sourceId: 'website', url: 'https://example.org/file.pdf' },
    { municipalityId: 'one', sha256: sha256('different bytes'), sourceId: 'website', url: 'https://example.org/new.pdf' },
  ];
  const groups = groupCrawlDocuments(docs);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups[0].map(document => document.sourceId), ['website', 'gazette', 'council']);
  assert.equal(groups[1][0].municipalityId, 'two');
});
test('identical document claims retain every current bound source without claiming corroboration', () => {
  const original = record();
  const primary = original.sources[0];
  const second = { ...primary, id: 'gazette-source', sourceType: 'gazette' as const };
  const latest = { ...primary, retrievedAt: '2026-10-11T12:00:00.000Z' };
  const rebound = rebindSourceReferences(original, [primary, second, latest]);
  assert.equal(rebound.id, original.id);
  assert.equal(rebound.sources.length, 2);
  assert.equal(rebound.sources[0].retrievedAt, latest.retrievedAt);
  assert.equal(rebound.sources[1].id, 'gazette-source');
  assert.deepEqual(rebound.verification.faithfulness, original.verification.faithfulness);
  assert.match(rebound.extraction.documentLimitations!.join(' '), /not independent corroboration/);
  const reboundRegistry = structuredClone(registry);
  reboundRegistry.municipalities[0].sources.push({ id: 'gazette-source', kind: 'gazette', url: 'https://example.org', checkState: 'checked' });
  assert.equal(validateKnowledgeRelease({ schemaVersion: 'stadtstack-knowledge-v2', generatedAt: now, records: [rebound] }, reboundRegistry).records.length, 1);
});

test('cached actual no-case responses retain evidence without manufacturing a record or judge score', () => {
  const value = { kind: 'no_supported_case', cacheKey: sha256('key'), inputSha256: sha256('bytes'), textSha256: sha256('text'), responseSha256: sha256('actual response fixture'), modelIdentitySha256: sha256('model/tool identity'), extractedAt: now };
  assert.equal(NoCaseCacheSchema.parse(value).kind, 'no_supported_case');
  assert.equal(NoCaseCacheSchema.safeParse({ ...value, responseSha256: undefined }).success, false);
  assert.equal(NoCaseCacheSchema.safeParse({ ...value, score: 1 }).success, false);
});

test('PDF extraction and cache reuse require parsed, document-bound XMP policy evidence', () => {
  const original = record();
  const source = { ...original.sources[0], mimeType: 'application/pdf' };
  assert.throws(() => assertSubscriptionSourcePolicy(source.policy, source), /parsed metadata evidence/);
  const evidence = { url: source.url, locator: 'PDF.js 6.3.289 XMP metadata (pdf-tdm-v2)', value: 'no_tdm_reservation_field', sha256: source.sha256, checkedAt: now };
  const allowed = { ...source.policy, tdm: { ...source.policy.tdm, evidence: [evidence] } };
  assert.equal(assertSubscriptionSourcePolicy(allowed, source).tdm.state, 'not_declared');
  for (const invalid of [
    { ...evidence, locator: 'Raw PDF metadata regex' },
    { ...evidence, locator: 'PDF.js 6.3.289 XMP metadata (pdf-tdm-v1)' },
    { ...evidence, sha256: sha256('different PDF') },
    { ...evidence, url: 'https://example.org/another.pdf' },
    { ...evidence, checkedAt: undefined },
    { ...evidence, value: 'metadata_parse_failed' },
  ]) assert.throws(() => assertSubscriptionSourcePolicy({ ...allowed, tdm: { ...allowed.tdm, evidence: [invalid] } }, source), /parsed metadata evidence/);
  const reserved = { ...allowed, tdm: { ...allowed.tdm, evidence: [evidence, { ...evidence, value: '1' }] } };
  assert.throws(() => assertSubscriptionSourcePolicy(reserved, source), /reserves TDM/);
  assert.throws(() => rebindSourceReferences(original, [source]), /parsed metadata evidence/);
  const rebound = rebindSourceReferences(original, [{ ...source, policy: allowed }]);
  assert.equal(rebound.sources[0].policy.tdm.evidence[0].sha256, source.sha256);
  const invalidRelease = structuredClone(rebound);
  invalidRelease.sources[0].policy.tdm.evidence = [];
  invalidRelease.verification.evidenceHash = knowledgeEvidenceHash(invalidRelease);
  assert.throws(() => DistrictKnowledgeRecordSchema.parse(invalidRelease), /Source policy/);
});

test('Codex nonfatal error items retain evidence but cannot manufacture completion', () => {
  const evidence = inspectCodexEvents(JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'Invalid schema for response_format' } }));
  assert.equal(evidence.toolAttempted, false);
  assert.equal(evidence.completed, false);
  assert.equal(evidence.failureCategory, null);
  assert.match(evidence.runtimeWarnings[0], /structured_schema_rejected/);
  assert.equal(inspectCodexEvents(JSON.stringify({ type: 'turn.failed', error: { message: 'Invalid schema for response_format' } })).failureCategory, 'structured_schema_rejected');
  assert.deepEqual(evidence.attemptedToolTypes, []);
});

test('Codex wire schema adapts tuple encoding while keeping strict post-generation coordinate validation', () => {
  const wire = codexResponseSchema({ type: 'array', items: [{ type: 'number', minimum: -180, maximum: 180 }, { type: 'number', minimum: -90, maximum: 90 }], additionalItems: false });
  assert.deepEqual(wire, { type: 'array', items: { anyOf: [{ type: 'number', minimum: -180, maximum: 180 }, { type: 'number', minimum: -90, maximum: 90 }] }, minItems: 2, maxItems: 2 });
  const invalid = claims();
  invalid.locations = [{ label: 'Beispielstadt', quote: 'Beispielstadt', geometry: { type: 'Point', coordinates: [13, 100] }, precision: 'exact' }];
  assert.equal(DistrictExtractionClaimsSchema.safeParse(invalid).success, false);
});

test('Codex wire schema uses permitted anyOf for disjoint geometry variants', () => {
  const variants = [{ type: 'object', properties: { type: { const: 'Point' } } }, { type: 'object', properties: { type: { const: 'Polygon' } } }];
  assert.deepEqual(codexResponseSchema({ oneOf: variants }), { anyOf: variants });
});

test('Codex startup feature advisory remains warning evidence and cannot manufacture completion', () => {
  const warning = JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'Under-development features enabled: skip_host_skill_discovery.' } });
  const partial = inspectCodexEvents(warning);
  assert.equal(partial.completed, false);
  assert.equal(partial.failureCategory, null);
  assert.equal(partial.runtimeWarnings.length, 1);
  const complete = inspectCodexEvents(warning + '\n' + JSON.stringify({ type: 'turn.completed' }));
  assert.equal(complete.completed, true);
  assert.equal(complete.toolAttempted, false);
  assert.equal(complete.runtimeWarnings.length, 1);
});

test('preparatory resolutions and consultation cannot establish final adoption or implementation', () => {
  for (const quote of ['Der Aufstellungsbeschluss wurde gefasst.', 'Entwurfsbeschluss und Beginn der öffentlichen Auslegung.', 'Die Beteiligung wurde abgeschlossen.']) {
    assert.equal(stageEvidenceSupports('adopted', quote), false);
    assert.equal(stageEvidenceSupports('in_force', quote), false);
    assert.equal(stageEvidenceSupports('implemented', quote), false);
  }
  assert.equal(stageEvidenceSupports('adopted', 'Der Bebauungsplan wurde als Satzung beschlossen.'), true);
  assert.equal(stageEvidenceSupports('in_force', 'Die Satzung ist in Kraft getreten.'), true);
  assert.equal(stageEvidenceSupports('implemented', 'Die Bauarbeiten wurden abgeschlossen.'), true);
  assert.equal(stageEvidenceSupports('implemented', 'Die Bauarbeiten sollen am 01.11.2026 abgeschlossen werden.'), false);
  assert.equal(stageEvidenceSupports('adopted', 'Der Satzungsbeschluss soll gefasst werden.'), false);
});
test('notice date and gazette date cannot replace the quoted preparatory resolution date', () => {
  const value = claims();
  const quote = 'Aufstellungsbeschluss vom 11.12.2025; Bekanntmachung vom 08.07.2026; Amtsblatt vom 24.07.2026; Auslegung vom 07.08.2026 bis 07.09.2026.';
  value.stage = 'decision'; value.stageDate = '2025-12-11'; value.stageDateQuote = 'Aufstellungsbeschluss vom 11.12.2025';
  value.originalStatus = 'Aufstellungsbeschluss'; value.stageQuote = value.stageDateQuote;
  value.documentDate = '2026-07-08'; value.documentDateQuote = 'Bekanntmachung vom 08.07.2026';
  assert.equal(deterministicChecks(value, text + '\\n' + quote, 'Beispielstadt').passed, true);
  value.stage = 'adopted';
  assert.equal(deterministicChecks(value, text + '\\n' + quote, 'Beispielstadt').checks.find(check => check.id === 'critical_stage_promotion')?.passed, false);
  value.stage = 'decision'; value.stageDate = '2026-07-24';
  assert.equal(deterministicChecks(value, text + '\\n' + quote, 'Beispielstadt').checks.find(check => check.id === 'stage_date')?.passed, false);
});
test('planned budget is not actual spending and future work is not completed work', () => {
  const value = claims();
  value.summaryQuote = 'Für die Bauarbeiten sind im Haushaltsplan 100000 Euro veranschlagt.';
  value.summary = 'Für die Bauarbeiten wurden 100000 Euro ausgegeben.';
  assert.equal(deterministicChecks(value, text + value.summaryQuote, 'Beispielstadt').checks.find(check => check.id === 'critical_budget_spending')?.passed, false);
  value.summary = 'Für die Bauarbeiten sind 100000 Euro vorgesehen.';
  assert.equal(deterministicChecks(value, text + value.summaryQuote, 'Beispielstadt').checks.find(check => check.id === 'critical_budget_spending')?.passed, true);
  value.stage = 'implemented'; value.stageQuote = 'Die Bauarbeiten werden voraussichtlich im Herbst abgeschlossen.';
  value.originalStatus = 'abgeschlossen';
  assert.equal(deterministicChecks(value, text + value.stageQuote, 'Beispielstadt').checks.find(check => check.id === 'critical_stage_promotion')?.passed, false);
});
test('quoted paper references are vendor-neutral and never imply OParl protocol', () => {
  const value = claims();
  value.caseKey = '2025/0662'; value.caseKeyType = 'paper_reference'; value.caseQuote = 'Beschluss 2025/0662';
  assert.equal(deterministicChecks(value, text + value.caseQuote, 'Beispielstadt').checks.find(check => check.id === 'case_identity')?.passed, true);
  assert.equal(DistrictExtractionClaimsSchema.safeParse({ ...value, caseKeyType: 'oparl_reference' }).success, false);
});

test('stage and history status bind exact event wording including source typos', () => {
  const value = claims();
  const quote = 'Die frühzeitige Beteilgung der Öffentlichkeit ist vorgesehen.';
  const source = `${text}\n${quote}\nBeteiligung der Öffentlichkeit`;
  value.stage = 'consultation'; value.originalStatus = 'Beteiligung der Öffentlichkeit'; value.stageQuote = quote;
  value.stageDate = null; value.stageDateQuote = null; value.stageDateReason = 'Kein vollständiges Datum im Ereignistext.';
  value.stages = [{ stage: 'consultation', originalStatus: value.originalStatus, quote, date: null, dateQuote: null }];
  const rejected = deterministicChecks(value, source, 'Beispielstadt');
  assert.equal(rejected.checks.find(check => check.id === 'stage')?.passed, false);
  assert.equal(rejected.checks.find(check => check.id === 'stage_history')?.passed, false);
  value.originalStatus = 'Beteilgung der Öffentlichkeit';
  value.stages[0].originalStatus = value.originalStatus;
  assert.equal(deterministicChecks(value, source, 'Beispielstadt').passed, true);
});

test('operative clauses and economic-plan votes do not establish final legal effect or adoption', () => {
  for (const quote of ['Der Bebauungsplan tritt mit Ablauf des Tages dieser Bekanntmachung in Kraft.', 'Die Stadtverordnetenversammlung beschließt den Wirtschaftsplan 2026.']) {
    const value = claims();
    value.stage = quote.includes('tritt') ? 'in_force' : 'adopted';
    value.stageQuote = quote; value.originalStatus = quote;
    value.stageDate = null; value.stageDateQuote = null; value.stageDateReason = 'Kein vollständiges Datum im Ereignistext.';
    assert.equal(deterministicChecks(value, `${text}\n${quote}`, 'Beispielstadt').checks.find(check => check.id === 'critical_stage_promotion')?.passed, false);
    if (quote.includes('Wirtschaftsplan')) {
      value.stage = 'decision';
      assert.equal(deterministicChecks(value, `${text}\n${quote}`, 'Beispielstadt').passed, true);
    }
  }
});

test('whitespace-equivalent proposals restore exact contiguous source spans with hashes and offsets', () => {
  const value = claims();
  value.title = 'Wärmeplanung\n Beispielstadt'; value.titleQuote = 'Wärmeplanung Beispielstadt';
  value.entities.push({ mentionId:'authority', name: 'Amt\nBeispielstadt', type: 'authority', quote: 'Amt Beispielstadt', identifiers:[] });
  value.locations = [{ label: 'Straße A', quote: 'Straße A', geometry: null, precision: 'none' }];
  const source = text + '\nWärmeplanung\n    Beispielstadt\nAmt \t Beispielstadt\nStraße\n  A';
  const result = restoreSourceQuotes(value, source, 100);
  assert.equal(result.claims.title, 'Wärmeplanung Beispielstadt');
  assert.equal(result.claims.titleQuote, 'Wärmeplanung\n    Beispielstadt');
  assert.equal(result.claims.entities[1].name, 'Amt Beispielstadt');
  assert.equal(result.claims.locations[0].quote, 'Straße\n  A');
  assert.equal(result.normalization.version, QUOTE_NORMALIZATION_VERSION);
  assert.ok(result.normalization.displayFields.includes('title'));
  for (const restored of result.normalization.restorations) {
    assert.equal(sha256(source.slice(restored.start - 100, restored.end - 100)), restored.restoredSha256);
    assert.ok(restored.start >= 100);
  }
  assert.equal(deterministicChecks(result.claims, source, 'Beispielstadt').passed, true);
  assert.equal(value.titleQuote, 'Wärmeplanung Beispielstadt');
});
test('whitespace restoration cannot stitch missing words, change case or invent location labels', () => {
  const value = claims();
  value.summaryQuote = 'Der Entwurf wurde veröffentlicht.';
  value.locations = [{ label: 'Straße A Nord', quote: 'Straße A', geometry: null, precision: 'none' }];
  const source = text + '\nStraße\n A';
  const result = restoreSourceQuotes(value, source);
  assert.equal(result.claims.summaryQuote, value.summaryQuote);
  assert.equal(result.normalization.restorations.some(item => item.field === 'summaryQuote'), false);
  const gates = deterministicChecks(result.claims, source, 'Beispielstadt');
  assert.equal(gates.checks.find(check => check.id === 'exact_quotes')?.passed, false);
  assert.equal(gates.checks.find(check => check.id === 'location_labels')?.passed, false);
  value.titleQuote = 'wärmeplanung';
  assert.equal(restoreSourceQuotes(value, source).claims.titleQuote, 'wärmeplanung');
  assert.equal(canonicalWhitespace('A \t\n B'), 'A B');
});
test('release binds quote restoration hashes and source chunk offsets', () => {
  const value = record();
  const start = text.indexOf(value.titleQuote);
  value.extraction.quoteNormalization = { version: QUOTE_NORMALIZATION_VERSION, offsetUnit: 'utf16_code_units', restorations: [{ field: 'titleQuote', proposedSha256: sha256(value.titleQuote), restoredSha256: sha256(value.titleQuote), start, end: start + value.titleQuote.length }], displayFields: [] };
  value.verification.evidenceHash = knowledgeEvidenceHash(value);
  assert.equal(DistrictKnowledgeRecordSchema.parse(value).extraction.responseSha256, value.extraction.responseSha256);
  value.extraction.quoteNormalization.restorations[0].restoredSha256 = sha256('not the quote');
  value.verification.evidenceHash = knowledgeEvidenceHash(value);
  assert.throws(() => DistrictKnowledgeRecordSchema.parse(value), /restoration hash/);
  value.extraction.quoteNormalization.restorations[0].restoredSha256 = sha256(value.titleQuote);
  value.extraction.quoteNormalization.restorations[0].end = text.length + 1;
  value.verification.evidenceHash = knowledgeEvidenceHash(value);
  assert.throws(() => DistrictKnowledgeRecordSchema.parse(value), /escapes source chunk/);
});

test('nested graph time restoration offsets stay inside the relation even when its date repeats earlier', () => {
  const value = claims();
  const timeQuote = 'seit 1.\n Januar 2020';
  const relationQuote = `Netzbetrieb Beispiel GmbH betreibt Wärmenetz Beispiel ${timeQuote}.`;
  const source = `${text}\nFrüherer Hinweis: ${timeQuote}.\n${relationQuote}`;
  value.entities = [
    { mentionId: 'operator', name: 'Netzbetrieb Beispiel GmbH', type: 'company', quote: relationQuote, identifiers: [] },
    { mentionId: 'network', name: 'Wärmenetz Beispiel', type: 'facility', quote: relationQuote, identifiers: [] },
  ];
  value.relations = [{ fromMention: 'operator', toMention: 'network', type: 'operates', quote: relationQuote, predicateQuote: 'betreibt', modality: 'asserted', time: { text: '1. Januar 2020', quote: 'seit 1. Januar 2020' }, conditions: null }];
  const sourceOffset = 500;
  const restored = restoreSourceQuotes(value, source, sourceOffset);
  assert.equal(restored.claims.relations[0].time?.text, '1.\n Januar 2020');
  assert.equal(restored.claims.relations[0].time?.quote, timeQuote);
  const relationStart = sourceOffset + source.indexOf(relationQuote);
  for (const field of ['relations[0].time.quote', 'relations[0].time.text']) {
    const entry = restored.normalization.restorations.find(item => item.field === field);
    assert.ok(entry);
    const span = field.endsWith('.text') ? '1.\n Januar 2020' : timeQuote;
    assert.equal(entry.start, relationStart + relationQuote.indexOf(span));
    assert.equal(entry.end, entry.start + span.length);
    assert.ok(entry.end <= relationStart + relationQuote.length);
    assert.equal(entry.proposedSha256, sha256(field.endsWith('.text') ? '1. Januar 2020' : 'seit 1. Januar 2020'));
    assert.equal(entry.restoredSha256, sha256(source.slice(entry.start - sourceOffset, entry.end - sourceOffset)));
  }
  assert.equal(deterministicChecks(restored.claims, source, 'Beispielstadt').passed, true);
  const unsupported = structuredClone(value);
  unsupported.relations[0].time = { text: '2. Januar 2020', quote: 'seit 2.\n Januar 2020' };
  const outsideSource = `${source}\nseit 2.\n Januar 2020`;
  const rejected = restoreSourceQuotes(unsupported, outsideSource, sourceOffset);
  assert.equal(rejected.claims.relations[0].time?.text, '2. Januar 2020');
  assert.equal(rejected.normalization.restorations.some(item => item.field === 'relations[0].time.text'), false);
  assert.equal(deterministicChecks(rejected.claims, outsideSource, 'Beispielstadt').checks.find(check => check.id === 'graph_relations')?.passed, false);
});

test('contact details inside an optional relation quote still fail the privacy gate', () => {
  const value = claims();
  const quote = 'Netzbetrieb Beispiel GmbH betreibt Wärmenetz Beispiel. Kontakt: info@example.org';
  const source = `${text}\n${quote}`;
  value.entities = [
    { mentionId: 'operator', name: 'Netzbetrieb Beispiel GmbH', type: 'company', quote: 'Netzbetrieb Beispiel GmbH', identifiers: [] },
    { mentionId: 'network', name: 'Wärmenetz Beispiel', type: 'facility', quote: 'Wärmenetz Beispiel', identifiers: [] },
  ];
  value.relations = [{ fromMention: 'operator', toMention: 'network', type: 'operates', quote, predicateQuote: 'betreibt', modality: 'asserted', time: null, conditions: null }];
  assert.equal(deterministicChecks(value, source, 'Beispielstadt').checks.find(check => check.id === 'no_contacts')?.passed, false);
  value.relations[0].quote = 'Netzbetrieb Beispiel GmbH betreibt Wärmenetz Beispiel.';
  assert.equal(deterministicChecks(value, source, 'Beispielstadt').passed, true);
  value.relations = [];
  assert.equal(deterministicChecks(value, source, 'Beispielstadt').passed, true);
});
