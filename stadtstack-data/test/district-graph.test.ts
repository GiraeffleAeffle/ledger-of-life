import test from 'node:test';
import assert from 'node:assert/strict';
import { DistrictKnowledgeRecordSchema, KNOWLEDGE_SCHEMA_VERSION, REQUIRED_DETERMINISTIC_CHECKS, knowledgeEvidenceHash, sha256 } from '../src/district-schema.ts';
import { EntityMentionSchema, ENTITY_TYPE_PRECEDENCE, councilBodyIdentity, graphGroundingChecks, normalizeGraphClaims, normalizeRelationActions, relationPathEligible, relationTypeSchema, type GraphClaims } from '../src/district-graph-claims.ts';
import { buildKnowledgeGraph, validateKnowledgeGraph } from '../src/district-graph.ts';
import { GraphIndex, graphNeighborsSchema } from '../src/district-graph-query.ts';
import { PROVIDER_CONFIGS } from '../src/district-model-contract.ts';
import { readCursor, writeCursor, cursorBinding } from '../src/mcp-pagination.ts';
import { observation, semanticHash, type AdapterScope, type StructuredObservation } from '../src/district-adapter-contract.ts';
import { nativeStructuredIdentityGraph } from '../src/district-entity-resolution.ts';
import { StructuredKnowledgeRecordSchema, STRUCTURED_VERIFICATION_VERSION } from '../src/district-structured-record.ts';

import {createHash,generateKeyPairSync} from 'node:crypto';
import {signRevocations,verifyRevocations,revocationKeyId,compareRevocationTargets,type RevocationTarget} from '../src/civic-revocations.ts';
const now = '2026-10-10T12:00:00.000Z';
// Synthetic test source/gates only; never actual municipality or model evidence.
function mention(mentionId: string, name = `Test ${mentionId}`, type: GraphClaims['entities'][number]['type'] = 'organization'): GraphClaims['entities'][number] {
  return { mentionId, name, type, quote: name, identifiers: [] };
}
function relation(from: GraphClaims['entities'][number], to: GraphClaims['entities'][number], modality: GraphClaims['relations'][number]['modality'] = 'asserted'): GraphClaims['relations'][number] {
  const wording = modality === 'negated' ? 'betreibt nicht' : modality === 'planned' ? 'soll betreiben' : modality === 'proposed' ? 'Vorschlag: betreiben' : modality === 'conditional' ? 'betreibt, sofern genehmigt,' : 'betreibt';
  const quote = `${from.name} ${wording} ${to.name}${modality === 'historical' ? ' im Jahr 2020' : ''}.`;
  return { fromMention: from.mentionId, toMention: to.mentionId, type: 'operates', quote, predicateQuote: modality === 'planned' || modality === 'proposed' ? 'betreiben' : 'betreibt', modality, time: modality === 'historical' ? { text: '2020', quote: 'im Jahr 2020' } : null, conditions: modality === 'conditional' ? 'sofern genehmigt' : null };
}
function fixture(claims: GraphClaims, municipalityId = 'synthetic-town', id = 'synthetic-record') {
  const actionResult = normalizeRelationActions(claims);
  claims = actionResult.claims;
  const text = ['Synthetic town', ...claims.entities.flatMap(entity => [entity.quote, ...entity.identifiers.map(identifier => identifier.quote)]), ...claims.relations.map(relation => relation.quote)].join('\n');
  const sourceSha256 = sha256(text), config = PROVIDER_CONFIGS['openai-subscription'];
  const checks = [...REQUIRED_DETERMINISTIC_CHECKS.map(id => ({ id, passed: true, reason: 'Synthetic non-graph fixture gate; no model executed' })), ...graphGroundingChecks(claims, text)];
  assert.ok(checks.every(check => check.passed), JSON.stringify(checks.filter(check => !check.passed)));
  const record = {
    kind: 'text_model' as const,
    title: 'Synthetic town', titleQuote: 'Synthetic town', summary: 'Synthetic town', summaryQuote: 'Synthetic town', municipalityQuote: 'Synthetic town',
    caseKeyType: 'source_document', caseKey: `source_document:${sourceSha256}`, caseQuote: null, caseType: 'unknown',
    documentDate: null, documentDateQuote: null, documentDateReason: 'Synthetic source has no date', topics: [], stage: 'unknown', stageDate: null, stageDateQuote: null, stageDateReason: 'No event date', originalStatus: '', stageQuote: '', stages: [], locations: [],
    ...normalizeGraphClaims(claims, { municipalityId, sourceSha256, ags: '12064001' }), id, municipalityId, ags: '12064001', districtId: 'synthetic-district',
    sources: [{ id: 'synthetic-source', url: 'https://example.org/graph-source', sha256: sourceSha256, retrievedAt: now, locator: `chars:0-${text.length}`, mimeType: 'text/plain', sourceType: 'website', policy: { robots: { state: 'allowed', url: 'https://example.org/robots.txt' }, tdm: { state: 'not_declared', evidence: [] }, access: 'public', legalClassification: 'not_assessed', publication: 'facts_with_attribution_only' } }],
    extraction: { extractorVersion: 'synthetic', extractorSha256: sha256('synthetic extractor'), model: config.model, provider: 'openai-subscription', tool: config.tool, toolVersion: 'synthetic', modelIdentitySha256: sha256('synthetic model identity'), modelIdentityBasis: config.modelIdentityBasis, returnedModel: null, promptVersion: 'synthetic', promptSha256: sha256('synthetic prompt'), judgePromptVersion: 'synthetic', judgePromptSha256: sha256('synthetic judge prompt'), inputSha256: sourceSha256, textSha256: sourceSha256, responseSha256: sha256('synthetic response'), ocrUsed: false, textMethod: 'text', cacheKey: sha256('synthetic cache'), extractedAt: now, chunk: { index: 0, count: 1, start: 0, end: text.length } },
    verification: { kind: 'text_model' as const, status: 'auto-verified', deterministic: { passed: true, checks }, faithfulness: { score: 0.9, threshold: 0.8, model: config.model, provider: 'openai-subscription', tool: config.tool, toolVersion: 'synthetic', modelIdentitySha256: sha256('synthetic model identity'), returnedModel: null, reason: 'Synthetic fixture only; no actual model judgment', evaluatedAt: now, responseSha256: sha256('synthetic judge response'), sameModel: true, limitation: 'Same-model judgment is not independent verification.' }, evidenceHash: '' },
  };
  if (actionResult.normalization) Object.assign(record.extraction, { relationNormalization: { ...actionResult.normalization, sourceSha256, textSha256: sourceSha256, responseSha256: record.extraction.responseSha256 } });
  record.verification.evidenceHash = knowledgeEvidenceHash(record);
  return DistrictKnowledgeRecordSchema.parse(record);
}
function release(claims: GraphClaims, budgets: ConstructorParameters<typeof GraphIndex>[3] = {}) {
  const datedClaims = { ...claims, relations: claims.relations.map(edge => {
    if (edge.time || !['asserted', 'decided', 'implemented'].includes(edge.modality)) return edge;
    const text = ['implements', 'decides', 'approves', 'amends'].includes(edge.type) ? 'am 2026-10-01' : '2020-01-01 bis 2030-12-31';
    return { ...edge, quote: `${edge.quote} ${text}`, time: { text, quote: text } };
  }) };
  const record = fixture(datedClaims);
  const bytes = JSON.stringify({ schemaVersion: KNOWLEDGE_SCHEMA_VERSION, generatedAt: now, identityAssertions: [], identityAdmissions: [], records: [record] });
  const graph = buildKnowledgeGraph(bytes, { asOf: now.slice(0, 10) });
  return { record, bytes, graph, index: new GraphIndex('synthetic-release', graph, bytes, budgets) };
}
test('graph read views require a genuinely signed mask and preserve only unchanged visible knowledge records',()=>{
  const admitted=release({entities:[mention('a','Revoked organization'),mention('b','Revoked facility')],relations:[relation(mention('a','Revoked organization'),mention('b','Revoked facility'))]});
  const releaseId='a'.repeat(64),graph=new GraphIndex(releaseId,admitted.graph,admitted.bytes);
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),keyId=revocationKeyId(publicKey);
  const bytes=signRevocations({schemaVersion:'stadtstack-revocations-v1',releaseId,issuedAt:'2026-10-10T12:00:00Z',sequence:1,targets:[{type:'host',host:'example.org'}]},keyId,privateKey);
  const trust={schemaVersion:'stadtstack-revocation-trust-v1',releaseId,expectedArtifactSha256:createHash('sha256').update(bytes).digest('hex'),keys:[{keyId,publicKeySpki:publicKey.export({format:'der',type:'spki'}).toString('base64')}]};
  const mask=verifyRevocations(bytes,trust,releaseId),safeEnvelope={...JSON.parse(admitted.bytes),records:[]},safeBytes=JSON.stringify(safeEnvelope),safeGraph=buildKnowledgeGraph(safeBytes,{asOf:admitted.graph.asOf});
  const view=graph.withReadView(safeGraph,safeBytes,new Set(),mask);
  assert.equal(view.maskIdentity,mask.artifactSha256);
  assert.equal(view.releaseAsOf,graph.releaseAsOf);
  assert.equal(view.entitySearch({query:'Revoked'}).total,0);
  assert.equal(JSON.stringify(view.graphView()).includes('Revoked'),false);
  const tampered={...safeEnvelope,records:[{...admitted.record,title:'Changed after admission'}]},tamperedBytes=JSON.stringify(tampered);
  assert.throws(()=>graph.withReadView(buildKnowledgeGraph(tamperedBytes,{asOf:admitted.graph.asOf}),tamperedBytes,new Set([admitted.record.id]),mask),/unchanged visible record subset/);
});
test('graph cursors bind the verified mask identity even when a different mask yields identical records',()=>{
  const records=[
    fixture({entities:[mention('hidden','Hidden Entity')],relations:[]},'town','hidden-record'),
    fixture({entities:[mention('alpha','Visible Entity Alpha')],relations:[]},'town','visible-alpha'),
    fixture({entities:[mention('beta','Visible Entity Beta')],relations:[]},'town','visible-beta'),
  ];
  const bytes=JSON.stringify({schemaVersion:KNOWLEDGE_SCHEMA_VERSION,generatedAt:now,identityAssertions:[],identityAdmissions:[],records}),graphData=buildKnowledgeGraph(bytes,{asOf:now.slice(0,10)}),releaseId='b'.repeat(64),graph=new GraphIndex(releaseId,graphData,bytes),safeRecords=records.filter(record=>record.id!=='hidden-record'),safeBytes=JSON.stringify({schemaVersion:KNOWLEDGE_SCHEMA_VERSION,generatedAt:now,identityAssertions:[],identityAdmissions:[],records:safeRecords}),safeGraph=buildKnowledgeGraph(safeBytes,{asOf:now.slice(0,10)}),visibleIds=new Set(safeRecords.map(record=>record.id));
  const makeMask=(targets:RevocationTarget[])=>{
    const {privateKey,publicKey}=generateKeyPairSync('ed25519'),keyId=revocationKeyId(publicKey),sorted=[...targets].sort(compareRevocationTargets);
    const signed=signRevocations({schemaVersion:'stadtstack-revocations-v1',releaseId,issuedAt:'2026-10-10T12:00:00Z',sequence:1,targets:sorted},keyId,privateKey);
    return verifyRevocations(signed,{schemaVersion:'stadtstack-revocation-trust-v1',releaseId,expectedArtifactSha256:createHash('sha256').update(signed).digest('hex'),keys:[{keyId,publicKeySpki:publicKey.export({format:'der',type:'spki'}).toString('base64')}]},releaseId);
  };
  const firstMask=makeMask([{type:'record',recordId:'hidden-record'}]),first=graph.withReadView(safeGraph,safeBytes,visibleIds,firstMask),page=first.entitySearch({query:'Visible',limit:1});
  assert.ok(page.nextCursor);
  const sameContentDifferentMask=graph.withReadView(safeGraph,safeBytes,visibleIds,makeMask([{type:'record',recordId:'hidden-record'},{type:'record',recordId:'absent-record'}]));
  assert.throws(()=>sameContentDifferentMask.entitySearch({query:'Visible',limit:1,cursor:page.nextCursor!}),/mismatch/);
});

test('conservative identity preserves homonyms, legal forms, source-scoped projects and conflicting explicit identifiers', () => {
  const input = { entities: [mention('local', 'Stadtwerke', 'company'), mention('body', 'Stadtvertretung', 'authority'), mention('project', 'Schulneubau', 'project'), mention('law', 'Änderung 1', 'law')], relations: [] };
  const a = normalizeGraphClaims(input, { municipalityId: 'one', sourceSha256: sha256('a') });
  const b = normalizeGraphClaims(input, { municipalityId: 'two', sourceSha256: sha256('a') });
  for (let i = 0; i < a.entities.length; i++) assert.notEqual(a.entities[i].entityId, b.entities[i].entityId);
  const revised = normalizeGraphClaims(input, { municipalityId: 'one', sourceSha256: sha256('b') });
  assert.notEqual(a.entities[0].entityId, revised.entities[0].entityId);
  assert.notEqual(a.entities[2].entityId, revised.entities[2].entityId);
  assert.notEqual(a.entities[3].entityId, revised.entities[3].entityId);
  const legal = normalizeGraphClaims({ entities: [mention('gmbh', 'Test GmbH', 'company'), mention('ag', 'Test AG', 'company')], relations: [] }, { municipalityId: 'one', sourceSha256: sha256('a') });
  assert.notEqual(legal.entities[0].entityId, legal.entities[1].entityId);
  const identified = mention('id', 'Test GmbH', 'company');
  identified.identifiers = [{ value: '123', namespace: 'HRB', issuer: 'Amtsgericht Test', quote: 'Test GmbH HRB 123 Amtsgericht Test' }];
  const idA = normalizeGraphClaims({ entities: [identified], relations: [] }, { municipalityId: 'one', sourceSha256: sha256('a') });
  const idB = normalizeGraphClaims({ entities: [{ ...identified, identifiers: [{ ...identified.identifiers[0], value: '124' }] }], relations: [] }, { municipalityId: 'one', sourceSha256: sha256('a') });
  assert.notEqual(idA.entities[0].entityId, idB.entities[0].entityId);
  const conflicting = { ...identified, identifiers: [...identified.identifiers, { ...identified.identifiers[0], value: '124', quote: 'Test GmbH HRB 124 Amtsgericht Test' }] };
  assert.equal(graphGroundingChecks({ entities: [conflicting], relations: [] }, conflicting.identifiers.map(item => item.quote).join('\n')).find(check => check.id === 'graph_identifiers')?.passed, false);
});

test('identifier-based cross-town programme and operator identity requires the exact source identifier AND issuer', () => {
  const entities = [mention('programme', 'Förderprogramm Test', 'funding_programme'), mention('operator', 'Test Betrieb GmbH', 'company')];
  for (const entity of entities) entity.identifiers = [{ value: entity.mentionId, namespace: 'Register', issuer: 'Test Issuer', quote: `${entity.name} Register ${entity.mentionId} Test Issuer` }];
  const claims = { entities, relations: [] };
  const first = fixture(claims, 'one', 'record-one'), second = fixture(claims, 'two', 'record-two');
  const bytes = JSON.stringify({ schemaVersion: KNOWLEDGE_SCHEMA_VERSION, generatedAt: now, identityAssertions: [], identityAdmissions: [], records: [first, second] });
  const graph = buildKnowledgeGraph(bytes, { asOf: now.slice(0, 10) });
  assert.equal(graph.entities.length, 2);
  assert.ok(graph.entities.every(entity => entity.mentions.length === 2 && entity.identityBasis.kind === 'explicit_identifier'));
  const otherIssuer = normalizeGraphClaims({ entities: entities.map(entity => ({ ...entity, identifiers: entity.identifiers.map(id => ({ ...id, issuer: 'Other Issuer' })) })), relations: [] }, { municipalityId: 'two', sourceSha256: sha256('b') });
  assert.ok(otherIssuer.entities.every((entity, i) => entity.entityId !== first.entities[i].entityId));
  assert.match(graph.entities[0].identityBasis.ambiguity, /not independent/);
});

test('name-only identity never crosses municipality boundaries, including formerly qualified names', () => {
  const input = { entities: [mention('operator', 'Klarer Netzbetrieb GmbH', 'company'), mention('programme', 'Förderprogramm Kommunale Wärmenetze', 'funding_programme'), mention('generic', 'Stadtwerke GmbH & Co. KG', 'company'), mention('school', 'Schulcampus Lindenallee', 'facility')], relations: [] };
  const first = normalizeGraphClaims(input, { municipalityId: 'one', sourceSha256: sha256('first') });
  const elsewhere = normalizeGraphClaims(input, { municipalityId: 'two', sourceSha256: sha256('second') });
  const later = normalizeGraphClaims(input, { municipalityId: 'one', sourceSha256: sha256('later') });
  first.entities.forEach((entity, index) => {
    assert.notEqual(entity.entityId, elsewhere.entities[index].entityId);
    assert.notEqual(entity.entityId, later.entities[index].entityId);
    assert.equal(entity.identityBasis.kind, 'source_scoped_mention');
    assert.match(entity.identityBasis.ambiguity, /not independent/);
  });
});

test('names and heterogeneous mention types do not authorize a source identity merge', () => {
  const entities = ENTITY_TYPE_PRECEDENCE.map((type, index) => mention(`alias-${index}`, 'Synthetic Shared Label', type));
  const normalized = normalizeGraphClaims({ entities, relations: [] }, { municipalityId: 'one', sourceSha256: sha256('first') });
  assert.equal(new Set(normalized.entities.map(entity => entity.entityId)).size, entities.length);
  assert.deepEqual(normalized.entities.map(({ entityId, identityBasis, ...original }) => original), entities);
  const record = fixture({ entities, relations: [] });
  const bytes = JSON.stringify({ schemaVersion: KNOWLEDGE_SCHEMA_VERSION, generatedAt: now, identityAssertions: [], identityAdmissions: [], records: [record] });
  assert.equal(buildKnowledgeGraph(bytes, { asOf: now.slice(0, 10) }).entities.length, entities.length);
});

test('cross-type grouping does not erase legal forms, amendments or conflicting complete identifier sets', () => {
  const identifier = { value: '123', namespace: 'HRB', issuer: 'Amtsgericht Test', quote: 'Test GmbH HRB 123 Amtsgericht Test' };
  const identified = { ...mention('company', 'Test GmbH', 'company'), identifiers: [identifier] };
  const claims = { entities: [
    identified,
    { ...identified, mentionId: 'organization', type: 'organization' as const },
    { ...identified, mentionId: 'other-value', identifiers: [{ ...identifier, value: '124' }] },
    { ...identified, mentionId: 'other-issuer', identifiers: [{ ...identifier, issuer: 'Other Issuer' }] },
    { ...identified, mentionId: 'other-namespace', identifiers: [{ ...identifier, namespace: 'Other Register' }] },
    { ...identified, mentionId: 'extra-identifier', identifiers: [identifier, { ...identifier, namespace: 'Other Register' }] },
    { ...identified, mentionId: 'other-legal-form', name: 'Test AG' },
    mention('unidentified', 'Test GmbH', 'organization'),
    mention('amendment-one', '1. Änderung Hauptsatzung Beispielstadt', 'law'),
    mention('amendment-two', '2. Änderung Hauptsatzung Beispielstadt', 'organization'),
  ], relations: [] };
  const normalized = normalizeGraphClaims(claims, { municipalityId: 'one', sourceSha256: sha256('first') });
  assert.equal(normalized.entities[0].entityId, normalized.entities[1].entityId);
  assert.equal(new Set(normalized.entities.map(entity => entity.entityId)).size, claims.entities.length - 2);
  const reordered = normalizeGraphClaims({ entities: [{ ...claims.entities[5], identifiers: [...claims.entities[5].identifiers].reverse() }], relations: [] }, { municipalityId: 'one', sourceSha256: sha256('second') });
  assert.equal(normalized.entities[5].entityId, reordered.entities[0].entityId);
});

test('strong company/organization aliases retain every source but unknown identity validity is not a current path', () => {
  const organization = mention('organization', 'Synthetic Utility GmbH', 'organization');
  const company = mention('company', 'Renamed Utility GmbH', 'company');
  for (const entity of [organization, company]) entity.identifiers = [{ namespace: 'HRB', issuer: 'Synthetic Court', value: '000123', quote: `${entity.name} HRB 000123 Synthetic Court` }];
  const council = mention('council', 'Synthetic Council', 'authority'), facility = mention('facility', 'Synthetic Facility', 'facility');
  const first = fixture({ entities: [council, organization], relations: [relation(council, organization)] }, 'one', 'record-a');
  const second = fixture({ entities: [company, facility], relations: [relation(company, facility)] }, 'two', 'record-b');
  second.sources.push({ ...second.sources[0], id: 'synthetic-source-alias', url: 'https://example.org/graph-source-alias' });
  second.verification.evidenceHash = knowledgeEvidenceHash(second);
  const bytes = JSON.stringify({ schemaVersion: KNOWLEDGE_SCHEMA_VERSION, generatedAt: now, identityAssertions: [], identityAdmissions: [], records: [first, second] });
  const graph = buildKnowledgeGraph(bytes, { asOf: now.slice(0, 10) }), index = new GraphIndex('synthetic-release', graph, bytes);
  const merged = graph.entities.find(entity => entity.names.includes(organization.name))!;
  assert.equal(merged.mentions.length, 2); assert.equal(merged.type, 'company');
  assert.equal(merged.identityAssertionIds.length, 1);
  assert.ok(merged.mentions.some(mention => mention.evidence.some(evidence => evidence.kind === 'text_model' && evidence.sources.length === 2)));
  const options = { fromId: first.entities[0].entityId, toId: second.entities[1].entityId, maxHops: 2 };
  assert.equal(index.path(options).status, 'not_found_within_hops');
  const path = index.path({ ...options, mode: 'historical' });
  assert.equal(path.status, 'found'); assert.equal(path.items[0].entities[1].id, merged.id);
  assert.equal(path.qualification, 'attributed_historical_claims_not_confirmed_current');
  const omitted = structuredClone(graph); omitted.entities.find(entity => entity.id === merged.id)!.mentions.pop();
  assert.throws(() => validateKnowledgeGraph(omitted, bytes), /does not match/);
});

test('multiword functional municipal bodies stay municipality-scoped rather than globally grouped', () => {
  const entities = [
    mention('committee', 'Ausschuss für Bildung und Soziales', 'authority'),
    mention('advisory', 'Beirat für nachhaltige Entwicklung', 'organization'),
    mention('council', 'Stadtvertretung der Stadt Beispielstadt', 'authority'),
  ];
  const input = { entities, relations: [] };
  const first = normalizeGraphClaims(input, { municipalityId: 'one', sourceSha256: sha256('first') });
  const elsewhere = normalizeGraphClaims(input, { municipalityId: 'two', sourceSha256: sha256('first') });
  const later = normalizeGraphClaims(input, { municipalityId: 'one', sourceSha256: sha256('later') });
  first.entities.forEach((entity, index) => {
    assert.equal(entity.identityBasis.kind, 'source_scoped_mention');
    assert.equal(entity.identityBasis.scope, `one:${sha256('first')}`);
    assert.notEqual(entity.entityId, elsewhere.entities[index].entityId);
    assert.notEqual(entity.entityId, later.entities[index].entityId);
  });
});

test('ordinal amendment labels are source-scoped even within the same municipality', () => {
  const entities = ['1. Änderung', '18. Änderung', 'Erste Änderung', 'zweite Änderung der Hauptsatzung'].map((name, index) => mention(`amendment-${index}`, name, 'law'));
  const input = { entities, relations: [] };
  const first = normalizeGraphClaims(input, { municipalityId: 'one', sourceSha256: sha256('first') });
  const repeated = normalizeGraphClaims(input, { municipalityId: 'one', sourceSha256: sha256('first') });
  const later = normalizeGraphClaims(input, { municipalityId: 'one', sourceSha256: sha256('later') });
  first.entities.forEach((entity, index) => {
    assert.equal(entity.identityBasis.kind, 'source_scoped_mention');
    assert.equal(entity.identityBasis.scope, `one:${sha256('first')}`);
    assert.equal(entity.entityId, repeated.entities[index].entityId);
    assert.notEqual(entity.entityId, later.entities[index].entityId);
  });
  assert.equal(new Set(first.entities.map(entity => entity.entityId)).size, entities.length);
});

test('anonymous object labels remain source-scoped without depending on their mention type', () => {
  for (const name of ['Projekt', 'Schule', 'Anlage', '1. Änderung']) {
    const entities = ENTITY_TYPE_PRECEDENCE.map((type, index) => mention(`alias-${index}`, name, type));
    const first = normalizeGraphClaims({ entities, relations: [] }, { municipalityId: 'one', sourceSha256: sha256('first') });
    const later = normalizeGraphClaims({ entities, relations: [] }, { municipalityId: 'one', sourceSha256: sha256('second') });
    assert.equal(new Set(first.entities.map(entity => entity.entityId)).size, entities.length);
    assert.ok(first.entities.every(entity => entity.identityBasis.kind === 'source_scoped_mention'));
    assert.notEqual(first.entities[0].entityId, later.entities[0].entityId);
  }
});

test('identity cutover migrates record IDs and endpoints together without relabelling generation or gate evidence', () => {
  const company = mention('company', 'Stadtwerke Strausberg', 'company');
  const facility = mention('facility', 'Hallenbad Lindenallee', 'facility');
  const current = fixture({ entities: [company, facility], relations: [relation(company, facility)] }, 'one');
  const legacy = structuredClone(current);
  for (const entity of legacy.entities) {
    const key = JSON.stringify([entity.type, entity.name.toLocaleLowerCase('de'), legacy.municipalityId]);
    entity.entityId = `entity:${sha256(key)}`;
    entity.identityBasis.key = key;
  }
  legacy.relations[0].fromId = legacy.entities[0].entityId;
  legacy.relations[0].toId = legacy.entities[1].entityId;
  legacy.verification.evidenceHash = knowledgeEvidenceHash(legacy);
  assert.throws(() => DistrictKnowledgeRecordSchema.parse(legacy), /identity mismatch/);
  const migrated = { ...legacy, ...normalizeGraphClaims(legacy, { municipalityId: legacy.municipalityId, sourceSha256: legacy.extraction.inputSha256 }), verification: { ...legacy.verification } };
  assert.throws(() => DistrictKnowledgeRecordSchema.parse(migrated), /[Ee]vidence hash/);
  migrated.verification.evidenceHash = knowledgeEvidenceHash(migrated);
  assert.deepEqual(DistrictKnowledgeRecordSchema.parse(migrated), current);
  assert.deepEqual(migrated.extraction, legacy.extraction);
  assert.deepEqual(migrated.verification.faithfulness, legacy.verification.faithfulness);
  assert.deepEqual(migrated.verification.deterministic, legacy.verification.deterministic);
  const bytes = JSON.stringify({ schemaVersion: KNOWLEDGE_SCHEMA_VERSION, generatedAt: now, identityAssertions: [], identityAdmissions: [], records: [migrated] });
  const index = new GraphIndex('migrated-release', buildKnowledgeGraph(bytes, { asOf: now.slice(0, 10) }), bytes);
  assert.throws(() => index.neighbors({ id: legacy.entities[0].entityId }), /Unknown graph entity/);
  assert.equal(index.neighbors({ id: migrated.entities[0].entityId }).items[0].to?.id, migrated.entities[1].entityId);
});

test('same-name company and organization mentions stay separate without a strong identifier', () => {
  const company = mention('company', 'Synthetic Utility', 'company'), organization = mention('organization', 'Synthetic Utility', 'organization');
  const { index, record, graph } = release({ entities: [company, organization], relations: [relation(company, organization)] });
  assert.equal(graph.entities.length, 2);
  assert.notEqual(graph.edges[0].fromId, graph.edges[0].toId);
  assert.equal(index.neighbors({ id: record.entities[0].entityId }).items.length, 1);
});

test('grounding rejects co-occurrence, unsupported roles/endpoints/identifiers and private-person types', () => {
  const a = mention('a'), b = mention('b');
  const unsupported = { ...relation(a, b), quote: `${a.name} und ${b.name}`, predicateQuote: 'und' };
  assert.equal(graphGroundingChecks({ entities: [a, b], relations: [unsupported] }, unsupported.quote).find(check => check.id === 'graph_relations')?.passed, false);
  const valid = relation(a, b);
  for (const changed of [{ ...valid, toMention: 'metadata-town' }, { ...valid, quote: `${a.name} betreibt eine Anlage.` }, { ...valid, predicateQuote: 'finanziert' }, { ...valid, time: { text: '2027', quote: '2027' } }]) {
    assert.equal(graphGroundingChecks({ entities: [a, b], relations: [changed] }, valid.quote).find(check => check.id === 'graph_relations')?.passed, false);
  }
  a.identifiers = [{ value: '123', namespace: 'HRB', issuer: 'Missing issuer', quote: `${a.name} HRB 123` }];
  assert.equal(graphGroundingChecks({ entities: [a], relations: [] }, a.identifiers[0].quote).find(check => check.id === 'graph_identifiers')?.passed, false);
  assert.equal(EntityMentionSchema.safeParse({ ...a, type: 'person' }).success, false);
  assert.throws(() => normalizeGraphClaims({ entities: [a, a], relations: [] }, { municipalityId: 'one', sourceSha256: sha256('a') }), /Duplicate/);
});

test('future, negated, conditional and historical edges retain evidence but never enter asserted paths', () => {
  for (const modality of ['planned', 'proposed', 'negated', 'conditional', 'historical'] as const) {
    const a = mention('a'), b = mention('b'), edge = relation(a, b, modality);
    const { index, record } = release({ entities: [a, b], relations: [edge] });
    const neighbors = index.neighbors({ id: record.entities[0].entityId, direction: 'out' });
    assert.equal(neighbors.items[0].edge.modality, modality);
    assert.equal(neighbors.items[0].pathEligible, false);
    const path = index.path({ fromId: record.entities[0].entityId, toId: record.entities[1].entityId, maxHops: 5 });
    assert.equal(path.status, 'not_found_within_hops'); assert.equal(path.truncated, false);
    if (modality !== 'historical') assert.equal(graphGroundingChecks({ entities: [a, b], relations: [{ ...edge, modality: 'asserted' }] }, edge.quote).find(check => check.id === 'graph_modality')?.passed, false);
  }
});

test('graph artifact and index bind exact admitted record bytes and all source evidence', () => {
  const a = mention('a'), b = mention('b');
  const { bytes, graph, record } = release({ entities: [a, b], relations: [relation(a, b)] });
  assert.equal(graph.recordsSha256, sha256(bytes));
  assert.deepEqual(validateKnowledgeGraph(graph, bytes), graph);
  assert.throws(() => validateKnowledgeGraph(graph, `${bytes}\n`), /byte binding/);
  const edited = structuredClone(graph); edited.edges[0].quote = 'Altered';
  assert.throws(() => validateKnowledgeGraph(edited, bytes), /does not match/);
  assert.throws(() => new GraphIndex('release', edited, bytes), /does not match/);
  const omitted = structuredClone(graph); omitted.edges = [];
  assert.throws(() => validateKnowledgeGraph(omitted, bytes), /does not match/);
  assert.equal(graph.edges[0].evidence.recordId, record.id);
  assert.equal(graph.edges[0].evidence.source.sha256, record.extraction.inputSha256);
  const candidate = structuredClone(record); candidate.verification.status = 'candidate'; candidate.verification.evidenceHash = knowledgeEvidenceHash(candidate);
  assert.throws(() => buildKnowledgeGraph(JSON.stringify({ schemaVersion: KNOWLEDGE_SCHEMA_VERSION, generatedAt: now, identityAssertions: [], identityAdmissions: [], records: [candidate] }), { asOf: now.slice(0, 10) }), /admitted/);
  const missingGate = structuredClone(record); missingGate.verification.deterministic.checks = missingGate.verification.deterministic.checks.filter(check => check.id !== 'graph_relations'); missingGate.verification.evidenceHash = knowledgeEvidenceHash(missingGate);
  assert.throws(() => DistrictKnowledgeRecordSchema.parse(missingGate), /graph grounding/);
});

test('graph cursors are signed and bound to release, tool, filters, limit and graph bytes', () => {
  const entities = [mention('a'), mention('b'), mention('c')];
  const { index, graph, bytes, record } = release({ entities, relations: [relation(entities[0], entities[1]), relation(entities[0], entities[2])] });
  const first = index.entitySearch({ query: 'Test', limit: 1 }); assert.ok(first.nextCursor);
  assert.notEqual(index.entitySearch({ query: 'Test', limit: 1, cursor: first.nextCursor }).items[0].id, first.items[0].id);
  for (const changed of [{ query: 'Test', limit: 2 }, { query: 'Other', limit: 1 }, { query: 'Test', limit: 1, type: 'company' }]) assert.throws(() => index.entitySearch({ ...changed, cursor: first.nextCursor }), /mismatch/);
  assert.throws(() => new GraphIndex('other-release', graph, bytes).entitySearch({ query: 'Test', limit: 1, cursor: first.nextCursor }), /mismatch/);
  const changedBytes = `${bytes}\n`;
  assert.throws(() => new GraphIndex('synthetic-release', buildKnowledgeGraph(changedBytes, { asOf: now.slice(0, 10) }), changedBytes).entitySearch({ query: 'Test', limit: 1, cursor: first.nextCursor }), /mismatch/);
  assert.throws(() => index.neighbors({ id: record.entities[0].entityId, limit: 1, cursor: first.nextCursor }), /mismatch/);
  const [payload, signature] = first.nextCursor.split('.');
  assert.throws(() => index.entitySearch({ query: 'Test', limit: 1, cursor: `${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}` }), /Invalid/);
  const neighbors = index.neighbors({ id: record.entities[0].entityId, direction: 'out', limit: 1 }); assert.ok(neighbors.nextCursor);
  assert.throws(() => index.neighbors({ id: record.entities[0].entityId, direction: 'in', limit: 1, cursor: neighbors.nextCursor }), /mismatch/);
  assert.throws(() => index.neighbors({ id: record.entities[0].entityId, direction: 'out', relationTypes: ['funds'], limit: 1, cursor: neighbors.nextCursor }), /mismatch/);
  const binding = cursorBinding({ tool: 'shared-test', filters: { limit: 1 } });
  assert.equal(readCursor(writeCursor('release', binding, 'after'), 'release', binding), 'after');
});

test('directed shortest paths enumerate alternatives and paginate without claiming longer paths or causality', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(id => mention(id));
  const { index, record } = release({ entities: [a, b, c, d], relations: [relation(a, b), relation(a, c), relation(b, d), relation(c, d), relation(d, a)] });
  const [fromId, , , toId] = record.entities.map(entity => entity.entityId);
  const first = index.path({ fromId, toId, maxHops: 5, limit: 1 });
  assert.equal(first.shortestHops, 2); assert.equal(first.total, 2); assert.equal(first.complete, true); assert.ok(first.nextCursor);
  assert.ok(first.items[0].edges.every(edge => edge.evidence.recordId === record.id));
  const second = index.path({ fromId, toId, maxHops: 5, limit: 1, cursor: first.nextCursor });
  assert.notEqual(first.items[0].id, second.items[0].id); assert.equal(second.nextCursor, null);
  assert.throws(() => index.path({ fromId, toId, maxHops: 4, limit: 1, cursor: first.nextCursor }), /mismatch/);
  assert.equal(index.path({ fromId, toId, maxHops: 1 }).status, 'not_found_within_hops');
  assert.equal(index.path({ fromId, toId: fromId, maxHops: 1 }).shortestHops, 0);
  assert.throws(() => index.path({ fromId, toId, maxHops: 6 }));
  assert.throws(() => index.entitySearch({ query: 'Test', limit: 51 }));
});

test('node, edge, enumeration and entity-search budgets distinguish incomplete from absent', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(id => mention(id));
  const claims = { entities: [a, b, c, d], relations: [relation(a, b), relation(a, c), relation(b, d), relation(c, d)] };
  for (const budgets of [{ visitedNodes: 1 }, { examinedEdges: 1 }, { paths: 1 }, { pathSteps: 1 }]) {
    const { index, record } = release(claims, budgets);
    const result = index.path({ fromId: record.entities[0].entityId, toId: record.entities[3].entityId, maxHops: 5 });
    assert.equal(result.truncated, true); assert.equal(result.complete, false); assert.equal(result.total, null);
    assert.notEqual(result.status, 'not_found_within_hops');
    assert.ok(result.visitedNodes <= (budgets.visitedNodes ?? 2000)); assert.ok(result.examinedEdges <= (budgets.examinedEdges ?? 10000)); assert.ok(result.pathSteps <= (budgets.pathSteps ?? 20000));
  }
  const { index, record } = release(claims, { searchNodes: 1, examinedEdges: 1 });
  const missing = index.entitySearch({ query: 'Definitely absent' });
  assert.equal(missing.status, 'incomplete'); assert.equal(missing.truncated, true); assert.equal(missing.total, null); assert.equal(missing.examinedNodes, 1);
  const neighbors = index.neighbors({ id: record.entities[0].entityId, direction: 'out' });
  assert.equal(neighbors.truncated, true); assert.equal(neighbors.examinedEdges, 1); assert.equal(neighbors.total, null);
  const nodeBounded = release(claims, { visitedNodes: 1 });
  const noNeighbors = nodeBounded.index.neighbors({ id: nodeBounded.record.entities[0].entityId, direction: 'out' });
  assert.equal(noNeighbors.status, 'incomplete'); assert.equal(noNeighbors.visitedNodes, 1); assert.equal(noNeighbors.items.length, 0);
});

test('all supported relation predicates require actual quoted roles, including German statute citations', () => {
  const a = mention('a'), b = mention('b');
  const predicates = { operates: 'betreibt', funds: 'finanziert', implements: 'realisiert', plans: 'plant den Ausbau', decides: 'beschließt', approves: 'genehmigt', amends: 'ändert', located_in: 'liegt', cooperates_with: 'kooperiert', cites: 'gemäß' } as const;
  for (const [type, predicateQuote] of Object.entries(predicates)) {
    const edge = { ...relation(a, b), type: type as GraphClaims['relations'][number]['type'], quote: `${a.name} ${predicateQuote} ${b.name}.`, predicateQuote };
    assert.ok(graphGroundingChecks(normalizeRelationActions({ entities: [a, b], relations: [edge] }).claims, edge.quote).every(check => check.passed), type);
    const wrongRole = { ...edge, predicateQuote: 'steht neben', quote: `${a.name} steht neben ${b.name}.` };
    assert.equal(graphGroundingChecks({ entities: [a, b], relations: [wrongRole] }, wrongRole.quote).find(check => check.id === 'graph_relations')?.passed, false);
  }
});

test('dated future operation and historical wording cannot be silently promoted, passive present can be asserted', () => {
  const a = mention('a'), b = mention('b'), base = relation(a, b);
  const future = { ...base, quote: `${a.name} betreibt ab 2030 ${b.name}.`, time: { text: '2030', quote: 'ab 2030' } };
  assert.equal(graphGroundingChecks({ entities: [a, b], relations: [future], documentDate: '2026-10-10' }, future.quote).find(check => check.id === 'graph_modality')?.passed, false);
  assert.equal(graphGroundingChecks({ entities: [a, b], relations: [{ ...future, modality: 'planned' }], documentDate: '2026-10-10' }, future.quote).find(check => check.id === 'graph_modality')?.passed, true);
  const historical = { ...base, quote: `${a.name} betrieb im Jahr 2020 ${b.name}.`, predicateQuote: 'betrieb', time: { text: '2020', quote: 'im Jahr 2020' } };
  assert.equal(graphGroundingChecks({ entities: [a, b], relations: [historical] }, historical.quote).find(check => check.id === 'graph_modality')?.passed, false);
  const passive = { ...base, quote: `${b.name} wird von ${a.name} betrieben.`, predicateQuote: 'betrieben' };
  assert.ok(graphGroundingChecks({ entities: [a, b], relations: [passive] }, passive.quote).every(check => check.passed));
  const futureVerb = { ...base, quote: `${a.name} wird ${b.name} betreiben.`, predicateQuote: 'betreiben' };
  assert.equal(graphGroundingChecks({ entities: [a, b], relations: [futureVerb] }, futureVerb.quote).find(check => check.id === 'graph_modality')?.passed, false);
});

test('explicit construction intent normalizes to plans without promoting future works', () => {
  const builder = mention('builder', 'Beispiel Bau GmbH', 'company'), project = mention('project', 'Beispielmarkt', 'project');
  const base = { ...relation(builder, project, 'planned'), type: 'implements' as const, predicateQuote: 'errichten' };
  // Synthetic analogue of a quarantined named-builder / named-project construction intent.
  const quote = `${builder.name} beabsichtigt, den ${project.name} zu errichten.`;
  const edge = { ...base, quote };
  const { index, record } = release({ entities: [builder, project], relations: [edge] });
  const canonical = normalizeRelationActions({ entities: [builder, project], relations: [edge] });
  assert.equal(canonical.claims.relations[0].type, 'plans');
  assert.equal(record.relations[0].type, 'plans');
  assert.equal(graphGroundingChecks({ entities: [builder, project], relations: [edge] }, quote).find(check => check.id === 'graph_modality')?.passed, false);
  assert.ok(graphGroundingChecks(canonical.claims, quote).every(check => check.passed));
  assert.equal(index.neighbors({ id: record.entities[0].entityId, direction: 'out' }).items[0].pathEligible, false);
  assert.equal(index.path({ fromId: record.entities[0].entityId, toId: record.entities[1].entityId, maxHops: 1 }).status, 'not_found_within_hops');
  for (const plannedQuote of [quote, `${builder.name} wird den ${project.name} errichten.`, `${project.name} soll von ${builder.name} errichtet werden.`]) {
    const candidate = { ...edge, quote: plannedQuote, predicateQuote: plannedQuote.includes('errichtet') ? 'errichtet' : 'errichten' };
    const normalized = normalizeRelationActions({ entities: [builder, project], relations: [candidate] });
    assert.equal(normalized.claims.relations[0].type, 'plans');
    assert.ok(graphGroundingChecks(normalized.claims, plannedQuote).every(check => check.passed));
    assert.equal(graphGroundingChecks({ entities: [builder, project], relations: [{ ...candidate, modality: 'asserted' }] }, plannedQuote).find(check => check.id === 'graph_modality')?.passed, false);
  }
});

test('construction wording still requires both exact named endpoints and a predicate inside the same source quote', () => {
  const builder = mention('builder', 'Beispiel Bau GmbH', 'company'), project = mention('project', 'Beispielmarkt', 'project');
  const quote = `${builder.name} beabsichtigt, den ${project.name} zu errichten.`;
  const base = { ...relation(builder, project, 'planned'), type: 'implements' as const, predicateQuote: 'errichten', quote };
  for (const changed of [
    { ...base, quote: 'Dieses Unternehmen beabsichtigt, den Beispielmarkt zu errichten.' },
    { ...base, quote: 'Beispiel Bau GmbH beabsichtigt, dieses Gebäude zu errichten.' },
    { ...base, quote: `${builder.name} und ${project.name}.` },
    { ...base, predicateQuote: 'beabsichtigt' },
  ]) {
    const source = `${quote}\n${changed.quote}`;
    assert.equal(graphGroundingChecks({ entities: [builder, project], relations: [changed] }, source).find(check => check.id === 'graph_relations')?.passed, false);
  }
  const fabricated = { ...base, quote: `${builder.name} wird den ${project.name} errichten.` };
  assert.equal(graphGroundingChecks({ entities: [builder, project], relations: [fabricated] }, quote).find(check => check.id === 'graph_relations')?.passed, false);
});

test('future bis endpoints retain asserted ongoing operation but never excuse a future start', () => {
  const a = mention('a'), b = mention('b'), base = relation(a, b);
  for (const interval of ['bis 2030', 'seit 2020 bis 2030']) {
    const edge = { ...base, quote: `${a.name} betreibt ${b.name} ${interval}.`, time: { text: interval, quote: interval } };
    const checks = graphGroundingChecks({ entities: [a, b], relations: [edge], documentDate: '2026-10-10' }, edge.quote);
    assert.ok(checks.every(check => check.passed), interval);
    assert.equal(graphGroundingChecks({ entities: [a, b], relations: [{ ...edge, time: null }], documentDate: '2026-10-10' }, edge.quote).find(check => check.id === 'graph_modality')?.passed, false);
  }
  const interval = 'ab 2029 bis 2030';
  const future = { ...base, quote: `${a.name} betreibt ${b.name} ${interval}.`, time: { text: interval, quote: interval } };
  assert.equal(graphGroundingChecks({ entities: [a, b], relations: [future], documentDate: '2026-10-10' }, future.quote).find(check => check.id === 'graph_modality')?.passed, false);
  assert.ok(graphGroundingChecks({ entities: [a, b], relations: [{ ...future, modality: 'planned' }], documentDate: '2026-10-10' }, future.quote).every(check => check.passed));
});

test('approval and award wording cannot be forced into graph predicates and can be omitted', () => {
  const a = mention('a'), b = mention('b'), base = relation(a, b);
  for (const [type, predicateQuote] of [
    ['operates', 'beschließt den Wirtschaftsplan'],
    ['implements', 'Erhalt des Zuschlages'],
    ['cites', 'als Satzung beschlossen'],
    ['located_in', 'der Stadt'],
  ] as const) {
    const edge = { ...base, type, predicateQuote, quote: `${a.name} ${predicateQuote} ${b.name}.` };
    assert.equal(graphGroundingChecks({ entities: [a, b], relations: [edge] }, edge.quote).find(check => check.id === 'graph_relations')?.passed, false);
    assert.ok(graphGroundingChecks({ entities: [a, b], relations: [] }, edge.quote).every(check => check.passed));
  }
});

test('identifiers and nested relation evidence cannot borrow fields from elsewhere in the source', () => {
  const a = mention('a'), b = mention('b');
  const id = { value: '23', namespace: 'Register', issuer: 'Stadt Beispielstadt', quote: `${a.name} Register 23 Stadt Beispielstadt` };
  for (const quote of [`Register 23 Stadt Beispielstadt`, `${a.name} 23 Stadt Beispielstadt`, `${a.name} Register 23`]) {
    const entity = { ...a, identifiers: [{ ...id, quote }] };
    assert.equal(graphGroundingChecks({ entities: [entity], relations: [] }, `${id.quote}\n${quote}`).find(check => check.id === 'graph_identifiers')?.passed, false);
  }
  assert.ok(graphGroundingChecks({ entities: [{ ...a, identifiers: [id] }], relations: [] }, id.quote).every(check => check.passed));
  const quote = `${a.name} betreibt ${b.name} seit 2020.`;
  const edge = { ...relation(a, b), quote, time: { text: '2020', quote: 'seit 2020' } };
  const source = `${quote}\nseit 2021\nvorbehaltlich Zustimmung`;
  for (const changed of [
    { ...edge, time: { text: '2021', quote: 'seit 2021' } },
    { ...edge, time: { text: a.name, quote: 'seit 2020' } },
    { ...edge, conditions: 'vorbehaltlich Zustimmung', modality: 'conditional' as const },
  ]) {
    assert.equal(graphGroundingChecks({ entities: [a, b], relations: [changed] }, source).find(check => check.id === 'graph_relations')?.passed, false);
  }
});

test('action normalization retains exact endpoints and quotes, is idempotent, and records original evidence', () => {
  const a = mention('a', 'Stadt Strausberg'), b = mention('b', 'Fernwärmenetz', 'facility');
  const edge = { ...relation(a, b, 'planned'), type: 'implements' as const, predicateQuote: 'plant den Ausbau', quote: 'Stadt Strausberg plant den Ausbau Fernwärmenetz.' };
  const original: GraphClaims = { entities: [a, b], relations: [edge] };
  const result = normalizeRelationActions(original);
  assert.equal(original.relations[0].type, 'implements');
  assert.deepEqual(result.claims.relations[0], { ...edge, type: 'plans' });
  assert.deepEqual(result.normalization?.mappings[0], { index: 0, originalType: 'implements', originalModality: 'planned', type: 'plans', modality: 'planned', rule: 'explicit-planning', quoteSha256: sha256(edge.quote), predicateQuoteSha256: sha256(edge.predicateQuote) });
  assert.equal(normalizeRelationActions(result.claims).normalization, null);
  assert.ok(graphGroundingChecks(result.claims, edge.quote).every(check => check.passed));
  const { index, record } = release(original);
  assert.equal(record.extraction.relationNormalization?.responseSha256, record.extraction.responseSha256);
  assert.equal(index.neighbors({ id: record.entities[0].entityId }).items[0].pathEligible, false);
  assert.equal(index.path({ fromId: record.entities[0].entityId, toId: record.entities[1].entityId, maxHops: 1 }).status, 'not_found_within_hops');
});

test('normalization does not repair missing names, absent predicates or ambiguous mixed actions', () => {
  const a = mention('a'), b = mention('b');
  for (const edge of [
    { ...relation(a, b, 'planned'), type: 'implements' as const, predicateQuote: 'plant den Ausbau', quote: `${a.name} plant den Ausbau.` },
    { ...relation(a, b, 'planned'), type: 'implements' as const, predicateQuote: 'plant den Ausbau', quote: `${a.name} und ${b.name}.` },
  ]) {
    const result = normalizeRelationActions({ entities: [a, b], relations: [edge] });
    assert.equal(graphGroundingChecks(result.claims, edge.quote).find(check => check.id === 'graph_relations')?.passed, false);
    assert.equal(result.claims.relations[0].quote, edge.quote);
  }
  for (const predicateQuote of ['steht neben', 'plant und beschließt']) {
    const claims: GraphClaims = { entities: [a, b], relations: [{ ...relation(a, b), predicateQuote, quote: `${a.name} ${predicateQuote} ${b.name}.` }] };
    assert.equal(normalizeRelationActions(claims).normalization, null);
  }
});

test('actual decision approval and implementation remain distinct in paths and record provenance', () => {
  const a = mention('a'), b = mention('b');
  for (const [predicateQuote, type, modality] of [['beschließt', 'decides', 'decided'], ['genehmigt', 'approves', 'decided'], ['umgesetzt', 'implements', 'implemented']] as const) {
    const edge = { ...relation(a, b), type: 'implements' as const, predicateQuote, quote: `${a.name} ${predicateQuote} ${b.name}.` };
    const { record, index, graph } = release({ entities: [a, b], relations: [edge] });
    assert.equal(record.relations[0].type, type); assert.equal(record.relations[0].modality, modality);
    const evidence = graph.edges[0].evidence;
    assert.equal(evidence.kind, 'text_model');
    assert.equal(evidence.kind === 'text_model' ? evidence.relationNormalization?.mappings[0].originalType : null, 'implements');
    const path = index.path({ fromId: record.entities[0].entityId, toId: record.entities[1].entityId, maxHops: 1 });
    assert.equal(path.status, 'found'); assert.deepEqual(path.modalities, [modality]);
    assert.deepEqual(path.pathEligibility.eligibleModalities, ['asserted', 'decided', 'implemented']);
    for (const field of ['sourceSha256', 'textSha256', 'responseSha256'] as const) {
      const tampered = structuredClone(record); tampered.extraction.relationNormalization![field] = sha256('tampered');
      tampered.verification.evidenceHash = knowledgeEvidenceHash(tampered);
      assert.throws(() => DistrictKnowledgeRecordSchema.parse(tampered), /normalization/);
    }
    const changed = structuredClone(record); changed.extraction.relationNormalization!.mappings[0].originalModality = 'planned';
    changed.verification.evidenceHash = knowledgeEvidenceHash(changed);
    assert.throws(() => DistrictKnowledgeRecordSchema.parse(changed), /normalization/);
  }
});

test('future proposal condition negation and history never become actual decisions or execution', () => {
  const a = mention('a'), b = mention('b');
  for (const modality of ['planned', 'proposed', 'conditional', 'negated', 'historical'] as const) {
    const prefix = modality === 'planned' ? 'soll ' : modality === 'proposed' ? 'Vorschlag: ' : modality === 'negated' ? 'nicht ' : '';
    const suffix = modality === 'conditional' ? ' sofern genehmigt' : modality === 'historical' ? ' im Jahr 2020' : '';
    const edge = { ...relation(a, b, modality), type: 'implements' as const, predicateQuote: 'beschlossen', quote: `${a.name} ${prefix}beschlossen ${b.name}${suffix}.` };
    const result = normalizeRelationActions({ entities: [a, b], relations: [edge] });
    assert.equal(result.claims.relations[0].type, 'decides');
    assert.equal(result.claims.relations[0].modality, modality);
    assert.equal(relationPathEligible(result.claims.relations[0]), false);
    assert.ok(graphGroundingChecks(result.claims, edge.quote).every(check => check.passed));
    assert.equal(graphGroundingChecks({ ...result.claims, relations: [{ ...result.claims.relations[0], modality: 'implemented' }] }, edge.quote).find(check => check.id === 'graph_modality')?.passed, false);
  }
  const future: GraphClaims = { entities: [a, b], relations: [{ ...relation(a, b), type: 'decides', modality: 'decided', predicateQuote: 'beschließen', quote: `${a.name} wird ${b.name} beschließen.` }] };
  assert.equal(graphGroundingChecks(future, future.relations[0].quote).find(check => check.id === 'graph_modality')?.passed, false);
  assert.equal(graphNeighborsSchema.parse({ id: `entity:${sha256('entity')}`, relationTypes: relationTypeSchema.options }).relationTypes?.length, 12);
  for (const type of ['plans', 'decides', 'approves'] as const) assert.equal(relationPathEligible({ type, modality: 'implemented' }), false);
});

test('frozen legacy action records remain readable without relabelling their generation contract', () => {
  const a = mention('a'), b = mention('b');
  const edge = { ...relation(a, b), type: 'implements' as const, predicateQuote: 'umgesetzt', quote: `${a.name} umgesetzt ${b.name}.` };
  const legacy = fixture({ entities: [a, b], relations: [edge] });
  legacy.relations[0].modality = 'asserted';
  delete legacy.extraction.relationNormalization;
  legacy.extraction.promptVersion = 'district-claims-v7-joint-graph';
  legacy.verification.evidenceHash = knowledgeEvidenceHash(legacy);
  assert.equal(DistrictKnowledgeRecordSchema.parse(legacy).relations[0].modality, 'asserted');
  assert.equal(relationPathEligible(legacy.relations[0]), false);
  legacy.extraction.promptVersion = 'district-claims-v8-action-relations';
  legacy.verification.evidenceHash = knowledgeEvidenceHash(legacy);
  assert.throws(() => DistrictKnowledgeRecordSchema.parse(legacy), /canonical/);
});

test('unknown ongoing validity stays historical despite a recent fetch and asserted modality', () => {
  const a = mention('a'), b = mention('b');
  const record = fixture({ entities: [a, b], relations: [relation(a, b)] });
  const bytes = JSON.stringify({ schemaVersion: KNOWLEDGE_SCHEMA_VERSION, generatedAt: now, identityAssertions: [], identityAdmissions: [], records: [record] });
  const graph = buildKnowledgeGraph(bytes, { asOf: '2026-10-10' }), index = new GraphIndex('temporal-release', graph, bytes);
  const options = { fromId: record.entities[0].entityId, toId: record.entities[1].entityId, maxHops: 1 };
  assert.equal(index.path(options).status, 'not_found_within_hops');
  assert.equal(index.path({ ...options, mode: 'historical' }).status, 'found');
  assert.equal(index.neighbors({ id: options.fromId }).items[0].pathEligible, false);
  assert.equal(graph.cases[0].identity.kind, 'document_bucket');
  assert.equal(graph.cases[0].identity.countedProject, false);
  assert.equal(graph.identitySha256.length, 64);
});

test('expired and disjoint operator intervals cannot form a contemporaneous path', () => {
  const [a, b, c] = ['a', 'b', 'c'].map(id => mention(id));
  const during = (from: GraphClaims['entities'][number], to: GraphClaims['entities'][number], start: string, end: string) => {
    const text = `${start} bis ${end}`, base = relation(from, to);
    return { ...base, quote: `${base.quote} ${text}`, time: { text, quote: text } };
  };
  const { index, record } = release({ entities: [a, b, c], relations: [during(a, b, '2020-01-01', '2023-12-31'), during(b, c, '2024-01-01', '2027-12-31')] });
  const options = { fromId: record.entities[0].entityId, toId: record.entities[2].entityId, maxHops: 2 };
  for (const asOf of ['2022-01-01', '2025-01-01']) assert.equal(index.path({ ...options, asOf }).status, 'not_found_within_hops');
  assert.equal(index.path({ ...options, mode: 'historical' }).status, 'found');
});

test('pinned asOf and explicit override are returned and bound into all graph cursors', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(id => mention(id));
  const { index, record, bytes } = release({ entities: [a, b, c, d], relations: [relation(a, b), relation(a, c), relation(b, d), relation(c, d)] });
  const first = index.entitySearch({ query: 'Test', limit: 1 });
  assert.equal(first.releaseAsOf, '2026-10-10'); assert.equal(first.asOf, '2026-10-10');
  assert.throws(() => index.entitySearch({ query: 'Test', limit: 1, asOf: '2026-10-09', cursor: first.nextCursor }), /mismatch/);
  const options = { fromId: record.entities[0].entityId, toId: record.entities[3].entityId, maxHops: 3, limit: 1 };
  const path = index.path(options); assert.ok(path.nextCursor);
  assert.throws(() => index.path({ ...options, asOf: '2026-10-09', cursor: path.nextCursor }), /mismatch/);
  assert.throws(() => index.path({ ...options, mode: 'historical', cursor: path.nextCursor }), /mismatch/);
  assert.equal(index.path({ ...options, asOf: '2026-10-09' }).asOf, '2026-10-09');
  assert.deepEqual(buildKnowledgeGraph(bytes, { asOf: '2026-10-10' }), buildKnowledgeGraph(bytes, { asOf: '2026-10-10' }));
  assert.notDeepEqual(buildKnowledgeGraph(bytes, { asOf: '2026-10-10' }), buildKnowledgeGraph(bytes, { asOf: '2026-10-09' }));
});

test('legal events preserve chronological dates rather than requiring simultaneous approval and execution', () => {
  const [a, b, c] = ['authority', 'case', 'execution'].map(id => mention(id));
  const approval = { ...relation(a, b), type: 'approves' as const, modality: 'decided' as const, quote: `${a.name} genehmigt ${b.name} am 2023-06-01.`, predicateQuote: 'genehmigt', time: { text: 'am 2023-06-01', quote: 'am 2023-06-01' } };
  const implementation = { ...relation(b, c), type: 'implements' as const, modality: 'implemented' as const, quote: `${b.name} realisiert ${c.name} am 2025-06-01.`, predicateQuote: 'realisiert', time: { text: 'am 2025-06-01', quote: 'am 2025-06-01' } };
  const { index, record, graph } = release({ entities: [a, b, c], relations: [approval, implementation] });
  const options = { fromId: record.entities[0].entityId, toId: record.entities[2].entityId, maxHops: 2, mode: 'chronological' };
  const result = index.path(options);
  assert.equal(result.status, 'found');
  assert.deepEqual(result.items[0].edges.map(edge => edge.temporal.eventDate), ['2023-06-01', '2025-06-01']);
  assert.deepEqual(graph.edges.map(edge => edge.id).sort(), [...new Set(graph.edges.map(edge => edge.id))].sort());
  assert.equal(index.path({ ...options, asOf: '2024-01-01' }).status, 'not_found_within_hops');
});

test('root identity assertion retraction is manifest-bound and reverses the actual graph merge', () => {
  const a = mention('a', 'Synthetic Utility GmbH', 'company'), b = mention('b', 'Renamed Utility GmbH', 'organization');
  for (const entity of [a, b]) entity.identifiers = [{ namespace: 'HRB', issuer: 'Synthetic Court', value: '000123', quote: `${entity.name} HRB 000123 Synthetic Court` }];
  const records = [fixture({ entities: [a], relations: [] }, 'one', 'record-a'), fixture({ entities: [b], relations: [] }, 'two', 'record-b')];
  const envelope = { schemaVersion: KNOWLEDGE_SCHEMA_VERSION, generatedAt: now, identityAssertions: [], identityAdmissions: [], records };
  const first = buildKnowledgeGraph(JSON.stringify(envelope), { asOf: '2026-10-10' });
  assert.equal(first.entities.length, 1);
  const accepted = first.identity.assertions[0], retracted = { ...accepted, version: 2, status: 'retracted' as const };
  const bytes = JSON.stringify({ ...envelope, identityAssertions: [accepted, retracted] });
  const corrected = buildKnowledgeGraph(bytes, { asOf: '2026-10-10' });
  assert.equal(corrected.entities.length, 2);
  assert.equal(corrected.identity.assertions[0].status, 'retracted');
  assert.notEqual(corrected.identitySha256, first.identitySha256);
  assert.deepEqual(corrected.identity.mentions.map(mention => mention.id), first.identity.mentions.map(mention => mention.id));
  const forged = structuredClone(corrected); forged.identity.assertions[0].status = 'accepted';
  assert.throws(() => validateKnowledgeGraph(forged, bytes), /does not match/);
});

test('corporate succession is a dated relation, never erasure of predecessor identity', () => {
  const successor = mention('successor', 'Synthetic Successor GmbH', 'company'), predecessor = mention('predecessor', 'Synthetic Predecessor GmbH', 'company');
  for (const [entity, value] of [[successor, '200'], [predecessor, '100']] as const) entity.identifiers = [{ namespace: 'HRB', issuer: 'Synthetic Court', value, quote: `${entity.name} HRB ${value} Synthetic Court` }];
  const quote = `${successor.name} ist Rechtsnachfolger von ${predecessor.name} am 2025-01-01.`;
  const edge = { ...relation(successor, predecessor), type: 'succeeds' as const, quote, predicateQuote: 'ist Rechtsnachfolger von', time: { text: 'am 2025-01-01', quote: 'am 2025-01-01' } };
  const { graph, index, record } = release({ entities: [successor, predecessor], relations: [edge] });
  assert.equal(graph.entities.length, 2);
  assert.notEqual(graph.edges[0].fromId, graph.edges[0].toId);
  assert.equal(graph.edges[0].temporal.eventDateRole, 'succeeds');
  assert.equal(index.path({ fromId: record.entities[0].entityId, toId: record.entities[1].entityId, maxHops: 1, mode: 'chronological' }).status, 'found');
  assert.equal(graphGroundingChecks({ entities: [successor, predecessor], relations: [{ ...edge, time: null }] }, quote).find(check => check.id === 'graph_relations')?.passed, false);
  predecessor.identifiers = [{ ...predecessor.identifiers[0], value: '200', quote: `${predecessor.name} HRB 200 Synthetic Court` }];
  const conflicted = release({ entities: [successor, predecessor], relations: [edge] });
  assert.equal(conflicted.graph.entities.length, 2);
  assert.ok(conflicted.graph.identity.assertions.some(assertion => assertion.status === 'contested'));
});

test('canonical council aliases reuse the exact AGS body helper without inventing native identifiers', () => {
  const short = mention('short', 'Stadtvertretung Parchim', 'authority'), full = mention('full', 'Stadtvertretung der Stadt Parchim', 'organization');
  const basis = councilBodyIdentity(short.name, '13076108')!;
  assert.deepEqual(basis, councilBodyIdentity(full.name, '13076108'));
  assert.equal(councilBodyIdentity(full.name, '13076'), null);
  const claims = { entities: [short, full], relations: [] };
  const normalized = normalizeGraphClaims(claims, { municipalityId: 'parchim', sourceSha256: sha256('synthetic body source'), ags: '13076108' });
  assert.equal(normalized.entities[0].entityId, `entity:${sha256(basis.key)}`);
  assert.equal(normalized.entities[0].entityId, normalized.entities[1].entityId);
  assert.ok(normalized.entities.every(value => value.identifiers.length === 0 && value.identityBasis.kind === 'ags_scoped_council_body'));
  assert.notEqual(normalized.entities[0].entityId, normalizeGraphClaims(claims, { municipalityId: 'other', sourceSha256: sha256('other body source'), ags: '13076090' }).entities[0].entityId);
});

test('member_of preserves canonical source direction, planned/passive semantics and temporal current gates', () => {
  const member = mention('member', 'Synthetic Municipality', 'municipality'), association = mention('association', 'Synthetic Association', 'organization');
  const quote = `${member.name} ist Mitglied des ${association.name} von 1. Januar 2020 bis 31. Dezember 2030.`;
  const edge = { ...relation(member, association), type: 'member_of' as const, predicateQuote: 'ist Mitglied des', quote, time: { text: 'von 1. Januar 2020 bis 31. Dezember 2030', quote: 'von 1. Januar 2020 bis 31. Dezember 2030' } };
  const { index, record } = release({ entities: [member, association], relations: [edge] });
  assert.equal(index.path({ fromId: record.entities[0].entityId, toId: record.entities[1].entityId, maxHops: 1 }).status, 'found');
  const planned = { ...edge, quote: `${member.name} wird Mitglied des ${association.name}.`, time: null };
  assert.equal(graphGroundingChecks({ entities: [member, association], relations: [planned] }, planned.quote).find(value => value.id === 'graph_modality')?.passed, false);
  const passive = { ...edge, quote: `${member.name} wird als Mitglied des ${association.name} geführt.`, predicateQuote: 'Mitglied des', time: null };
  assert.equal(graphGroundingChecks({ entities: [member, association], relations: [passive] }, passive.quote).find(value => value.id === 'graph_modality')?.passed, true);
});

test('role-level negation and explicitly ended history block current paths, not historical evidence', () => {
  const a = mention('operator'), b = mention('facility', 'Synthetic Facility', 'facility');
  const interval = '2020-01-01 bis 2030-12-31', base = relation(a, b);
  const active = { ...base, quote: `${base.quote} ${interval}`, time: { text: interval, quote: interval } };
  const negative = { ...base, quote: `${a.name} betreibt nicht ${b.name} 2024-01-01 bis 2028-12-31.`, modality: 'negated' as const, time: { text: '2024-01-01 bis 2028-12-31', quote: '2024-01-01 bis 2028-12-31' } };
  const { index, record } = release({ entities: [a, b], relations: [active, negative] });
  const options = { fromId: record.entities[0].entityId, toId: record.entities[1].entityId, maxHops: 1 };
  assert.equal(index.path(options).status, 'not_found_within_hops');
  assert.equal(index.path({ ...options, asOf: '2022-01-01' }).status, 'found');
  assert.equal(index.path({ ...options, mode: 'historical' }).status, 'found');
  assert.ok(index.neighbors({ id: options.fromId }).items.some(item => item.blockingEvidence.length === 1 && !item.pathEligible));
  const untimed = { ...negative, quote: `${a.name} betreibt nicht ${b.name}.`, time: null };
  const unknown = release({ entities: [a, b], relations: [active, untimed] });
  assert.equal(unknown.index.path({ fromId: unknown.record.entities[0].entityId, toId: unknown.record.entities[1].entityId, maxHops: 1 }).status, 'not_found_within_hops');
  const ended = { ...base, quote: `${a.name} betrieb früher ${b.name} bis 2023-12-31.`, predicateQuote: 'betrieb', modality: 'historical' as const, time: { text: 'bis 2023-12-31', quote: 'bis 2023-12-31' } };
  const historical = release({ entities: [a, b], relations: [active, ended] });
  const historicalOptions = { fromId: historical.record.entities[0].entityId, toId: historical.record.entities[1].entityId, maxHops: 1 };
  assert.equal(historical.index.path(historicalOptions).status, 'not_found_within_hops');
  const restartText = '2024-01-01 bis 2030-12-31';
  const restarted = release({ entities: [a, b], relations: [{ ...active, quote: `${base.quote} ${restartText}`, time: { text: restartText, quote: restartText } }, ended] });
  assert.equal(restarted.index.path({ fromId: restarted.record.entities[0].entityId, toId: restarted.record.entities[1].entityId, maxHops: 1 }).status, 'found');
});

// Entirely synthetic admission inputs: no actual source policy, parser, model or assessment is asserted by this fixture.
function nativeGraphRecord(native: StructuredObservation, scope: AdapterScope) {
  const sourceSha256 = native.evidence[0].sourceSha256, policyReceiptSha256 = sha256('synthetic policy receipt');
  const claims = { kind: 'structured' as const, id: `structured:${native.id}`, municipalityId: scope.municipalityId, ags: scope.ags, districtId: 'synthetic-district', scope, observation: native,
    source: { id: scope.sourceId, url: 'https://example.org/native', sha256: sourceSha256, mimeType: 'application/json', retrievedAt: now, policyReceiptSha256 }, supportingSources: [], graph: nativeStructuredIdentityGraph(native, scope) };
  const gates = { kind: 'structured' as const, status: 'auto-verified' as const, version: STRUCTURED_VERIFICATION_VERSION, adapterId: 'synthetic-native', mappingVersion: 'procurement-native-v1', adapterContractSha256: sha256('synthetic mapping contract'),
    sourceSha256, policyReceiptSha256, scopeSha256: semanticHash(scope), locators: native.evidence, deterministic: { passed: true as const, checks: [{ id: 'synthetic_fixture', passed: true as const, reason: 'Synthetic admitted input only; no actual verification was run.' }] } };
  return StructuredKnowledgeRecordSchema.parse({ ...claims, verification: { ...gates, evidenceHash: semanticHash({ ...claims, verification: gates }) } });
}

test('native procurement action dates join only exact subject/version/source/scope and expose actual date evidence', () => {
  const scope: AdapterScope = { publisherId: 'synthetic', sourceId: 'procurement-bkms-opendata', municipalityId: 'synthetic-town', ags: '12064001', tenant: null, observationWindow: '2026-10-10' };
  const sourceSha256 = sha256('synthetic native procurement input'), subject = 'procurement:synthetic:ocid-1:award:award-1';
  const emit = (predicate: string, value: string, options: { subject?: string; version?: string; source?: string; date?: string; role?: string } = {}) => observation({
    publisherId: scope.publisherId, sourceId: scope.sourceId, nativeId: 'ocid-1', nativeVersion: options.version ?? 'release-1', kind: 'Award', subject: options.subject ?? subject, predicate, value, unit: null,
    date: options.date ?? null, dateRole: options.role ?? null, financialRole: 'none', geography: { ags: scope.ags, basis: 'source_explicit', role: 'project_location' }, sourceReferenceDate: '2026-10-10', publishedAt: now, retrievedAt: now,
    evidence: [{ sourceSha256: options.source ?? sourceSha256, format: 'json', nativeId: 'ocid-1', path: `/awards/0/${predicate}`, sheet: null, rowKey: 'award-1', cells: [], rawValue: value, schemaHash: sha256('synthetic schema'), mappingVersion: 'procurement-native-v1' }], limitations: ['Synthetic fixture only.'],
  });
  const award = emit('awarded_to', 'procurement:synthetic:ocid-1:party:party-1'), date = emit('decision_date', '2023-06-01', { date: '2023-06-01', role: 'award_decision' });
  const build = (dates: StructuredObservation[]) => {
    const records = [award, ...dates].map(value => nativeGraphRecord(value, scope));
    const bytes = JSON.stringify({ schemaVersion: KNOWLEDGE_SCHEMA_VERSION, generatedAt: now, records, identityAssertions: [], identityAdmissions: [] });
    return { bytes, graph: buildKnowledgeGraph(bytes, { asOf: '2026-10-10' }) };
  };
  const matched = build([date]);
  assert.equal(matched.graph.edges[0].temporal.eventDate, '2023-06-01');
  assert.equal(matched.graph.edges[0].temporal.eventDateRole, 'award_decision');
  assert.equal(matched.graph.edges[0].eventEvidence[0].recordId, `structured:${date.id}`);
  assert.equal(matched.graph.edges[0].quote, null);
  assert.equal(new GraphIndex('native-release', matched.graph, matched.bytes).path({ fromId: matched.graph.edges[0].fromId, toId: matched.graph.edges[0].toId, maxHops: 1, mode: 'chronological' }).status, 'found');
  for (const unrelated of [
    emit('decision_date', '2023-06-01', { date: '2023-06-01', role: 'award_decision', version: 'release-2' }),
    emit('decision_date', '2023-06-01', { date: '2023-06-01', role: 'award_decision', subject: 'procurement:synthetic:ocid-1:award:award-2' }),
    emit('decision_date', '2023-06-01', { date: '2023-06-01', role: 'award_decision', source: sha256('different source bytes') }),
    emit('published_at', '2023-06-01', { date: '2023-06-01', role: 'publication' }),
  ]) assert.equal(build([unrelated]).graph.edges[0].temporal.eventDate, null);
  const conflicted = build([date, emit('decision_date', '2023-06-02', { date: '2023-06-02', role: 'award_decision' })]);
  assert.equal(conflicted.graph.edges[0].temporal.unresolvedContradiction, true);
});

test('canonical council alias assertions retract reversibly while retaining original scope and source mentions', () => {
  const short = mention('short', 'Stadtvertretung Parchim', 'authority'), full = mention('full', 'Stadtvertretung der Stadt Parchim', 'organization');
  const records = [fixture({ entities: [short], relations: [] }, 'synthetic-town', 'short-record'), fixture({ entities: [full], relations: [] }, 'synthetic-town', 'full-record')];
  const envelope = { schemaVersion: KNOWLEDGE_SCHEMA_VERSION, generatedAt: now, records, identityAssertions: [], identityAdmissions: [] };
  const original = buildKnowledgeGraph(JSON.stringify(envelope), { asOf: '2026-10-10' });
  assert.equal(original.entities.length, 1);
  const assertion = original.identity.assertions.find(value => value.method === 'council_body_alias')!;
  assert.ok(assertion); assert.equal(original.entities[0].identityBasis.kind, 'ags_scoped_council_body');
  const corrected = buildKnowledgeGraph(JSON.stringify({ ...envelope, identityAssertions: [{ ...assertion, version: 2, status: 'retracted' }] }), { asOf: '2026-10-10' });
  assert.equal(corrected.entities.length, 2);
  assert.deepEqual(corrected.identity.mentions.map(value => value.name), original.identity.mentions.map(value => value.name));
  assert.ok(corrected.identity.mentions.every(value => value.identifiers.length === 0));
});
