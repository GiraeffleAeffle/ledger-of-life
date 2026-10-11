import test from 'node:test';
import assert from 'node:assert/strict';
import { DistrictKnowledgeRecordSchema, KNOWLEDGE_SCHEMA_VERSION, REQUIRED_DETERMINISTIC_CHECKS, knowledgeEvidenceHash, sha256 } from '../src/district-schema.ts';
import { EntityMentionSchema, graphGroundingChecks, normalizeGraphClaims, normalizeRelationActions, relationPathEligible, relationTypeSchema, type GraphClaims } from '../src/district-graph-claims.ts';
import { buildKnowledgeGraph, validateKnowledgeGraph } from '../src/district-graph.ts';
import { GraphIndex, graphNeighborsSchema } from '../src/district-graph-query.ts';
import { PROVIDER_CONFIGS } from '../src/district-model-contract.ts';
import { readCursor, writeCursor, cursorBinding } from '../src/mcp-pagination.ts';

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
    title: 'Synthetic town', titleQuote: 'Synthetic town', summary: 'Synthetic town', summaryQuote: 'Synthetic town', municipalityQuote: 'Synthetic town',
    caseKeyType: 'source_document', caseKey: `source_document:${sourceSha256}`, caseQuote: null, caseType: 'unknown',
    documentDate: null, documentDateQuote: null, documentDateReason: 'Synthetic source has no date', topics: [], stage: 'unknown', stageDate: null, stageDateQuote: null, stageDateReason: 'No event date', originalStatus: '', stageQuote: '', stages: [], locations: [],
    ...normalizeGraphClaims(claims, { municipalityId, sourceSha256 }), id, municipalityId, ags: '12064001', districtId: 'synthetic-district',
    sources: [{ id: 'synthetic-source', url: 'https://example.org/graph-source', sha256: sourceSha256, retrievedAt: now, locator: `chars:0-${text.length}`, mimeType: 'text/plain', sourceType: 'website', policy: { robots: { state: 'allowed', url: 'https://example.org/robots.txt' }, tdm: { state: 'not_declared', evidence: [] }, access: 'public', legalClassification: 'not_assessed', publication: 'facts_with_attribution_only' } }],
    extraction: { extractorVersion: 'synthetic', extractorSha256: sha256('synthetic extractor'), model: config.model, provider: 'openai-subscription', tool: config.tool, toolVersion: 'synthetic', modelIdentitySha256: sha256('synthetic model identity'), modelIdentityBasis: config.modelIdentityBasis, returnedModel: null, promptVersion: 'synthetic', promptSha256: sha256('synthetic prompt'), judgePromptVersion: 'synthetic', judgePromptSha256: sha256('synthetic judge prompt'), inputSha256: sourceSha256, textSha256: sourceSha256, responseSha256: sha256('synthetic response'), ocrUsed: false, textMethod: 'text', cacheKey: sha256('synthetic cache'), extractedAt: now, chunk: { index: 0, count: 1, start: 0, end: text.length } },
    verification: { status: 'auto-verified', deterministic: { passed: true, checks }, faithfulness: { score: 0.9, threshold: 0.8, model: config.model, provider: 'openai-subscription', tool: config.tool, toolVersion: 'synthetic', modelIdentitySha256: sha256('synthetic model identity'), returnedModel: null, reason: 'Synthetic fixture only; no actual model judgment', evaluatedAt: now, responseSha256: sha256('synthetic judge response'), sameModel: true, limitation: 'Same-model judgment is not independent verification.' }, evidenceHash: '' },
  };
  if (actionResult.normalization) Object.assign(record.extraction, { relationNormalization: { ...actionResult.normalization, sourceSha256, textSha256: sourceSha256, responseSha256: record.extraction.responseSha256 } });
  record.verification.evidenceHash = knowledgeEvidenceHash(record);
  return DistrictKnowledgeRecordSchema.parse(record);
}
function release(claims: GraphClaims, budgets: ConstructorParameters<typeof GraphIndex>[3] = {}) {
  const record = fixture(claims);
  const bytes = JSON.stringify({ schemaVersion: KNOWLEDGE_SCHEMA_VERSION, generatedAt: now, records: [record] });
  const graph = buildKnowledgeGraph(bytes);
  return { record, bytes, graph, index: new GraphIndex('synthetic-release', graph, bytes, budgets) };
}

test('conservative identity preserves homonyms, legal forms, source-scoped projects and conflicting explicit identifiers', () => {
  const input = { entities: [mention('local', 'Stadtwerke', 'company'), mention('body', 'Stadtvertretung', 'authority'), mention('project', 'Schulneubau', 'project'), mention('law', 'Änderung 1', 'law')], relations: [] };
  const a = normalizeGraphClaims(input, { municipalityId: 'one', sourceSha256: sha256('a') });
  const b = normalizeGraphClaims(input, { municipalityId: 'two', sourceSha256: sha256('a') });
  for (let i = 0; i < a.entities.length; i++) assert.notEqual(a.entities[i].entityId, b.entities[i].entityId);
  const revised = normalizeGraphClaims(input, { municipalityId: 'one', sourceSha256: sha256('b') });
  assert.equal(a.entities[0].entityId, revised.entities[0].entityId);
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
  const bytes = JSON.stringify({ schemaVersion: KNOWLEDGE_SCHEMA_VERSION, generatedAt: now, records: [first, second] });
  const graph = buildKnowledgeGraph(bytes);
  assert.equal(graph.entities.length, 2);
  assert.ok(graph.entities.every(entity => entity.mentions.length === 2 && entity.identityBasis.kind === 'explicit_identifier'));
  const otherIssuer = normalizeGraphClaims({ entities: entities.map(entity => ({ ...entity, identifiers: entity.identifiers.map(id => ({ ...id, issuer: 'Other Issuer' })) })), relations: [] }, { municipalityId: 'two', sourceSha256: sha256('b') });
  assert.ok(otherIssuer.entities.every((entity, i) => entity.entityId !== first.entities[i].entityId));
  assert.match(graph.entities[0].identityBasis.ambiguity, /not independent/);
});

test('qualified names link across towns with explicit uncertainty while local projects link only within jurisdiction',()=>{
  const input={entities:[mention('operator','Klarer Netzbetrieb GmbH','company'),mention('programme','Förderprogramm Kommunale Wärmenetze','funding_programme'),mention('generic','Stadtwerke GmbH & Co. KG','company'),mention('school','Schulcampus Lindenallee','facility')],relations:[]};
  const a=normalizeGraphClaims(input,{municipalityId:'one',sourceSha256:sha256('first')});
  const b=normalizeGraphClaims(input,{municipalityId:'two',sourceSha256:sha256('second')});
  const later=normalizeGraphClaims(input,{municipalityId:'one',sourceSha256:sha256('later')});
  for(const index of [0,1]){assert.equal(a.entities[index].entityId,b.entities[index].entityId);assert.equal(a.entities[index].identityBasis.kind,'qualified_name_match');assert.match(a.entities[index].identityBasis.ambiguity,/not independent/);}
  assert.notEqual(a.entities[2].entityId,b.entities[2].entityId);
  assert.notEqual(a.entities[3].entityId,b.entities[3].entityId);
  assert.equal(a.entities[3].entityId,later.entities[3].entityId);
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
    assert.equal(entity.identityBasis.kind, 'municipality_scoped_name');
    assert.equal(entity.identityBasis.scope, 'one');
    assert.notEqual(entity.entityId, elsewhere.entities[index].entityId);
    assert.equal(entity.entityId, later.entities[index].entityId);
  });
});

test('ordinal amendment labels are source-scoped even within the same municipality', () => {
  const entities = ['1. Änderung', '18. Änderung', 'Erste Änderung', 'zweite Änderung der Hauptsatzung'].map((name, index) => mention(`amendment-${index}`, name, 'law'));
  const input = { entities, relations: [] };
  const first = normalizeGraphClaims(input, { municipalityId: 'one', sourceSha256: sha256('first') });
  const repeated = normalizeGraphClaims(input, { municipalityId: 'one', sourceSha256: sha256('first') });
  const later = normalizeGraphClaims(input, { municipalityId: 'one', sourceSha256: sha256('later') });
  first.entities.forEach((entity, index) => {
    assert.equal(entity.identityBasis.kind, 'source_scoped_name');
    assert.equal(entity.identityBasis.scope, `one:${sha256('first')}`);
    assert.equal(entity.entityId, repeated.entities[index].entityId);
    assert.notEqual(entity.entityId, later.entities[index].entityId);
  });
  assert.equal(new Set(first.entities.map(entity => entity.entityId)).size, entities.length);
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
  assert.throws(() => buildKnowledgeGraph(JSON.stringify({ schemaVersion: KNOWLEDGE_SCHEMA_VERSION, generatedAt: now, records: [candidate] })), /admitted/);
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
  assert.throws(() => new GraphIndex('synthetic-release', buildKnowledgeGraph(changedBytes), changedBytes).entitySearch({ query: 'Test', limit: 1, cursor: first.nextCursor }), /mismatch/);
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
    assert.equal(graph.edges[0].evidence.relationNormalization?.mappings[0].originalType, 'implements');
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
  assert.equal(graphNeighborsSchema.parse({ id: `entity:${sha256('entity')}`, relationTypes: relationTypeSchema.options }).relationTypes?.length, 10);
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
