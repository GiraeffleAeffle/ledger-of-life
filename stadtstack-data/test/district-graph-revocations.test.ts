import test from 'node:test';
import assert from 'node:assert/strict';
import { DistrictKnowledgeRecordSchema, KNOWLEDGE_SCHEMA_VERSION, REQUIRED_DETERMINISTIC_CHECKS, knowledgeEvidenceHash, sha256, type DistrictKnowledgeRecord } from '../src/district-schema.ts';
import { graphGroundingChecks, normalizeGraphClaims, normalizeRelationActions, type GraphClaims } from '../src/district-graph-claims.ts';
import { buildKnowledgeGraph } from '../src/district-graph.ts';
import { GraphIndex, GRAPH_QUERY_BUDGETS, type GraphQueryBudgets } from '../src/district-graph-query.ts';
import { PROVIDER_CONFIGS } from '../src/district-model-contract.ts';
import { knowledgeSourceDescriptors } from '../src/mcp-source-identity.ts';
import { revocationViewIdentity } from '../src/mcp-revocation-view.ts';
import type { RevocationTarget, VerifiedRevocations } from '../src/civic-revocations.ts';
import { verifiedMask } from './fixtures/revocations.ts';

const now = '2026-10-10T12:00:00.000Z';
const releaseId = 'synthetic-graph-revocation-release';
const registrySourceId = ' Registry Ä / blocked ';

function mention(mentionId: string, name: string, type: GraphClaims['entities'][number]['type'] = 'organization'): GraphClaims['entities'][number] {
  return { mentionId, name, type, quote: name, identifiers: [] };
}
function relation(from: GraphClaims['entities'][number], to: GraphClaims['entities'][number], modality: 'asserted' | 'historical' | 'planned' = 'asserted'): GraphClaims['relations'][number] {
  const quote = `${from.name} ${modality === 'planned' ? 'soll betreiben' : 'betreibt'} ${to.name}${modality === 'historical' ? ' im Jahr 2020' : ''}.`;
  return { fromMention: from.mentionId, toMention: to.mentionId, type: 'operates', quote, predicateQuote: modality === 'planned' ? 'betreiben' : 'betreibt', modality, time: modality === 'historical' ? { text: '2020', quote: 'im Jahr 2020' } : null, conditions: null };
}

// Synthetic source and gate receipts only; these tests never invoke a model or publish data.
function recordFixture(claims: GraphClaims, id: string, sources = [{ id: 'visible-source', url: 'https://visible.example/source' }], municipalityId = 'synthetic-town'): DistrictKnowledgeRecord {
  const actionResult = normalizeRelationActions(claims);
  claims = actionResult.claims;
  const text = ['Synthetic town', ...claims.entities.flatMap(entity => [entity.quote, ...entity.identifiers.map(identifier => identifier.quote)]), ...claims.relations.map(relation => relation.quote)].join('\n');
  const sourceSha256 = sha256(text), config = PROVIDER_CONFIGS['openai-subscription'];
  const checks = [...REQUIRED_DETERMINISTIC_CHECKS.map(id => ({ id, passed: true, reason: 'Synthetic fixture gate; no model executed' })), ...graphGroundingChecks(claims, text)];
  assert.ok(checks.every(check => check.passed), JSON.stringify(checks.filter(check => !check.passed)));
  const record = {
    title: 'Synthetic town', titleQuote: 'Synthetic town', summary: 'Synthetic town', summaryQuote: 'Synthetic town', municipalityQuote: 'Synthetic town',
    caseKeyType: 'source_document', caseKey: `source_document:${sourceSha256}`, caseQuote: null, caseType: 'unknown',
    documentDate: null, documentDateQuote: null, documentDateReason: 'Synthetic source has no date', topics: [], stage: 'unknown', stageDate: null, stageDateQuote: null, stageDateReason: 'No event date', originalStatus: '', stageQuote: '', stages: [], locations: [],
    ...normalizeGraphClaims(claims, { municipalityId, sourceSha256, ags: '12064001' }), id, municipalityId, ags: '12064001', districtId: 'synthetic-district',
    sources: sources.map(source => ({ ...source, sha256: sourceSha256, retrievedAt: now, locator: `chars:0-${text.length}`, mimeType: 'text/plain', sourceType: 'website', policy: { robots: { state: 'allowed', url: new URL('/robots.txt', source.url).href }, tdm: { state: 'not_declared', evidence: [] }, access: 'public', legalClassification: 'not_assessed', publication: 'facts_with_attribution_only' } })),
    extraction: { extractorVersion: 'synthetic', extractorSha256: sha256('synthetic extractor'), model: config.model, provider: 'openai-subscription', tool: config.tool, toolVersion: 'synthetic', modelIdentitySha256: sha256('synthetic model identity'), modelIdentityBasis: config.modelIdentityBasis, returnedModel: null, promptVersion: 'synthetic', promptSha256: sha256('synthetic prompt'), judgePromptVersion: 'synthetic', judgePromptSha256: sha256('synthetic judge prompt'), inputSha256: sourceSha256, textSha256: sourceSha256, responseSha256: sha256('synthetic response'), ocrUsed: false, textMethod: 'text', cacheKey: sha256('synthetic cache'), extractedAt: now, chunk: { index: 0, count: 1, start: 0, end: text.length } },
    verification: { status: 'auto-verified', deterministic: { passed: true, checks }, faithfulness: { score: 0.9, threshold: 0.8, model: config.model, provider: 'openai-subscription', tool: config.tool, toolVersion: 'synthetic', modelIdentitySha256: sha256('synthetic model identity'), returnedModel: null, reason: 'Synthetic fixture only; no actual model judgment', evaluatedAt: now, responseSha256: sha256('synthetic judge response'), sameModel: true, limitation: 'Same-model judgment is not independent verification.' }, evidenceHash: '' },
  };
  if (actionResult.normalization) Object.assign(record.extraction, { relationNormalization: { ...actionResult.normalization, sourceSha256, textSha256: sourceSha256, responseSha256: record.extraction.responseSha256 } });
  record.verification.evidenceHash = knowledgeEvidenceHash(record);
  return DistrictKnowledgeRecordSchema.parse(record);
}
function publication(records: DistrictKnowledgeRecord[]) {
  // Non-canonical whitespace exercises the original sealed byte binding, not just JSON content.
  const bytes = `${JSON.stringify({ schemaVersion: KNOWLEDGE_SCHEMA_VERSION, generatedAt: now, records }, null, 2)}\n`;
  return { bytes, graph: buildKnowledgeGraph(bytes) };
}
function graphFixture() {
  const root = mention('root', 'Graph Start');
  const shared = mention('shared', 'Stadtvertretung Beispielstadt');
  const end = mention('end', 'Graph Ziel');
  const alias = mention('alias', 'Stadtvertretung der Stadt Beispielstadt', 'authority');
  const secret = mention('secret', 'Verborgener Betrieb', 'company');
  secret.identifiers = [{ namespace: 'Synthetic register', issuer: 'Synthetic issuer', value: 'SECRET-ID-0042', quote: 'Verborgener Betrieb Synthetic register Synthetic issuer SECRET-ID-0042' }];
  const visible = recordFixture({ entities: [root, shared, end], relations: [relation(root, shared), relation(shared, end), relation(root, end, 'historical'), relation(root, end, 'planned')] }, 'visible-record');
  const blocked = recordFixture({ entities: [alias, secret, end], relations: [relation(alias, secret), relation(secret, end)] }, ' blocked:Ä /2026 ', [
    { id: 'unblocked-primary', url: 'https://primary.example/blocked-record' },
    { id: registrySourceId, url: 'https://blocked.example/contributor' },
  ]);
  const other = recordFixture({ entities: [mention('other', 'Graph OtherTown')], relations: [] }, 'other-record', [{ id: registrySourceId, url: 'https://other.example/source' }], 'other-town');
  const records = [visible, blocked, other];
  return { ...publication(records), records, visible, blocked, other, rootId: visible.entities[0].entityId, sharedId: visible.entities[1].entityId, endId: visible.entities[2].entityId, secretId: blocked.entities[1].entityId };
}
function withoutAdministrativeView<T extends { administrativeView: unknown }>(result: T) {
  const { administrativeView: _administrativeView, ...content } = result;
  return content;
}
function projectionContent<T extends { administrativeView: unknown; recordsSha256: string }>(result: T) {
  const { administrativeView: _administrativeView, recordsSha256: _recordsSha256, ...content } = result;
  return content;
}
function targetFor(type: RevocationTarget['type'], blocked: DistrictKnowledgeRecord): RevocationTarget {
  const contributor = knowledgeSourceDescriptors(blocked)[1];
  switch (type) {
    case 'record': return { type, recordId: blocked.id };
    case 'host': return { type, host: 'blocked.example' };
    case 'mcp_source': return { type, mcpSourceId: contributor.mcpSourceId! };
    case 'registry_source': return { type, municipalityId: blocked.municipalityId, registrySourceId: contributor.registrySourceId! };
  }
}

for (const type of ['record', 'host', 'mcp_source', 'registry_source'] as const) {
  test(`signed ${type} mask rebuilds all graph surfaces from whole visible records`, () => {
    const fixture = graphFixture();
    const { graph, bytes, visible, blocked, other, rootId, sharedId, endId, secretId } = fixture;
    assert.equal(sharedId, blocked.entities[0].entityId);
    assert.equal(graph.entities.find(entity => entity.id === sharedId)!.type, 'authority');
    const originalGraph = structuredClone(graph), originalRecords = structuredClone(fixture.records);
    const mask = verifiedMask(releaseId, [targetFor(type, blocked)]);
    const index = new GraphIndex(releaseId, graph, bytes, {}, mask);
    const projection = publication([visible, other]);
    const expected = new GraphIndex(releaseId, projection.graph, projection.bytes);
    assert.equal(index.releaseId, releaseId);
    assert.equal(index.recordsSha256, sha256(bytes));
    assert.equal(index.administrativeView?.viewId, revocationViewIdentity(releaseId, mask));
    assert.equal(index.administrativeView?.releaseId, releaseId);
    assert.equal(index.administrativeView?.kind, 'signed_administrative_revocation');
    assert.match(index.administrativeView!.meaning, /not a civic withdrawal/);

    const shared = index.entitySearch({ query: 'Stadtvertretung' });
    assert.deepEqual(shared.items[0].names, ['Stadtvertretung Beispielstadt']);
    assert.equal(shared.items[0].type, 'organization');
    assert.deepEqual(shared.items[0].mentions.map(mention => mention.evidence.recordId), [visible.id]);
    assert.equal(index.entitySearch({ query: 'der Stadt' }).total, 0);
    assert.equal(index.entitySearch({ query: 'Stadtvertretung', type: 'authority' }).total, 0);
    assert.equal(index.entitySearch({ query: 'Verborgener' }).total, 0);
    assert.equal(index.entitySearch({ query: 'SECRET-ID-0042' }).total, 0);
    assert.equal(index.entitySearch({ query: 'Graph OtherTown' }).total, 1);
    for (const query of ['Graph', 'Stadtvertretung', 'Verborgener', 'SECRET-ID-0042']) {
      assert.deepEqual(projectionContent(index.entitySearch({ query })), projectionContent(expected.entitySearch({ query })));
    }
    const responses: unknown[] = [shared];
    for (const direction of ['in', 'out', 'both'] as const) {
      const neighbors = index.neighbors({ id: sharedId, direction });
      assert.deepEqual(projectionContent(neighbors), projectionContent(expected.neighbors({ id: sharedId, direction })));
      assert.deepEqual(neighbors.administrativeView, index.administrativeView);
      responses.push(neighbors);
    }
    const path = index.path({ fromId: rootId, toId: endId, maxHops: 3 });
    assert.equal(path.shortestHops, 2);
    assert.deepEqual(projectionContent(path), projectionContent(expected.path({ fromId: rootId, toId: endId, maxHops: 3 })));
    const self = index.path({ fromId: sharedId, toId: sharedId, maxHops: 1 });
    assert.equal(self.shortestHops, 0);
    assert.deepEqual(projectionContent(self), projectionContent(expected.path({ fromId: sharedId, toId: sharedId, maxHops: 1 })));
    assert.deepEqual(path.administrativeView, index.administrativeView);
    assert.deepEqual(self.administrativeView, index.administrativeView);
    responses.push(path, self);
    assert.throws(() => index.neighbors({ id: secretId }), /Unknown graph entity/);
    assert.throws(() => index.path({ fromId: rootId, toId: secretId, maxHops: 3 }), /Unknown graph entity/);
    assert.throws(() => index.path({ fromId: secretId, toId: endId, maxHops: 3 }), /Unknown graph entity/);
    assert.throws(() => index.path({ fromId: secretId, toId: secretId, maxHops: 1 }), /Unknown graph entity/);
    const wire = JSON.stringify(responses);
    for (const removed of [blocked.id, 'Verborgener Betrieb', 'SECRET-ID-0042', 'Stadtvertretung der Stadt Beispielstadt', ...blocked.sources.map(source => source.url)]) assert.ok(!wire.includes(removed), removed);
    // Rebuilding must retain exact legal/source receipts, temporal modalities and gate hashes.
    assert.deepEqual(index.neighbors({ id: rootId, direction: 'out' }).items.map(item => item.edge), projection.graph.edges.filter(edge => edge.fromId === rootId));
    assert.deepEqual(graph, originalGraph);
    assert.deepEqual(fixture.records, originalRecords);
  });
}

test('record and registry source targets preserve exact opaque spelling and municipality scope', () => {
  const { graph, bytes, blocked } = graphFixture();
  const mask = verifiedMask(releaseId, [
    { type: 'record', recordId: blocked.id.trim() },
    { type: 'record', recordId: blocked.id.toLocaleLowerCase('de') },
    { type: 'registry_source', municipalityId: blocked.municipalityId, registrySourceId: registrySourceId.trim() },
    { type: 'registry_source', municipalityId: 'wrong-town', registrySourceId },
  ]);
  const index = new GraphIndex(releaseId, graph, bytes, {}, mask);
  const original = new GraphIndex(releaseId, graph, bytes);
  for (const query of ['Graph', 'Stadtvertretung', 'SECRET-ID-0042']) assert.deepEqual(withoutAdministrativeView(index.entitySearch({ query })), withoutAdministrativeView(original.entitySearch({ query })));
});

test('empty verified mask preserves all graph content, original evidence and sealed byte identities', () => {
  const { graph, bytes, rootId, sharedId, endId } = graphFixture();
  const mask = verifiedMask(releaseId);
  const original = new GraphIndex(releaseId, graph, bytes);
  const index = new GraphIndex(releaseId, graph, new TextEncoder().encode(bytes), {}, mask);
  assert.equal(original.administrativeView, null);
  assert.equal(index.recordsSha256, original.recordsSha256);
  assert.equal(index.releaseId, original.releaseId);
  assert.notEqual(index.administrativeView?.viewId, releaseId);
  for (const query of ['Graph', 'Stadtvertretung', 'SECRET-ID-0042']) assert.deepEqual(withoutAdministrativeView(index.entitySearch({ query })), withoutAdministrativeView(original.entitySearch({ query })));
  assert.deepEqual(withoutAdministrativeView(index.neighbors({ id: sharedId })), withoutAdministrativeView(original.neighbors({ id: sharedId })));
  for (const toId of [endId, rootId]) assert.deepEqual(withoutAdministrativeView(index.path({ fromId: rootId, toId, maxHops: 3 })), withoutAdministrativeView(original.path({ fromId: rootId, toId, maxHops: 3 })));
});

test('a verified mask withholding every record leaves no entities, endpoints or self paths', () => {
  const { records, graph, bytes, rootId } = graphFixture();
  const mask = verifiedMask(releaseId, records.map(record => ({ type: 'record', recordId: record.id })));
  const index = new GraphIndex(releaseId, graph, bytes, {}, mask);
  const result = index.entitySearch({ query: 'Graph' });
  assert.equal(result.total, 0);
  assert.equal(result.examinedNodes, 0);
  assert.equal(result.truncated, false);
  assert.equal(result.complete, true);
  assert.equal(result.status, 'not_found');
  assert.deepEqual(result.items, []);
  assert.throws(() => index.neighbors({ id: rootId }), /Unknown graph entity/);
  assert.throws(() => index.path({ fromId: rootId, toId: rootId, maxHops: 1 }), /Unknown graph entity/);
});

test('withholding relation evidence disconnects surviving endpoints without leaking it through self paths', () => {
  const from = mention('from', 'Graph Surviving Start'), to = mention('to', 'Graph Surviving End');
  const visible = recordFixture({ entities: [from, to], relations: [] }, 'surviving-mentions');
  const blocked = recordFixture({ entities: [from, to], relations: [relation(from, to)] }, 'removed-connection');
  const { graph, bytes } = publication([visible, blocked]);
  const fromId = visible.entities[0].entityId, toId = visible.entities[1].entityId;
  assert.equal(new GraphIndex(releaseId, graph, bytes).path({ fromId, toId, maxHops: 1 }).status, 'found');
  const index = new GraphIndex(releaseId, graph, bytes, {}, verifiedMask(releaseId, [{ type: 'record', recordId: blocked.id }]));
  assert.equal(index.entitySearch({ query: 'Graph Surviving' }).total, 2);
  for (const id of [fromId, toId]) {
    assert.deepEqual(index.neighbors({ id }).items, []);
    const self = index.path({ fromId: id, toId: id, maxHops: 1 });
    assert.equal(self.shortestHops, 0);
    assert.deepEqual(self.items[0].edges, []);
    assert.deepEqual(self.items[0].entities[0].mentions.map(mention => mention.evidence.recordId), [visible.id]);
  }
  const path = index.path({ fromId, toId, maxHops: 5 });
  assert.equal(path.status, 'not_found_within_hops');
  assert.equal(path.complete, true);
  assert.equal(path.total, 0);
  assert.equal(path.shortestHops, null);
  assert.deepEqual(path.items, []);
});

test('graph masks require the verified runtime brand and exact sealed release identity', () => {
  const { graph, bytes } = graphFixture();
  const verified = verifiedMask(releaseId);
  for (const mask of [null, {}, [], { ...verified }, { ...verified, targets: [] }, { ...verified, releaseId: 'other-release' }]) {
    assert.throws(() => new GraphIndex(releaseId, graph, bytes, {}, mask as unknown as VerifiedRevocations), /Expected verified revocation state/);
  }
  assert.throws(() => new GraphIndex(releaseId, graph, bytes, {}, verifiedMask('other-release')), /release mismatch/);
  const empty = publication([]);
  assert.throws(() => new GraphIndex(releaseId, empty.graph, empty.bytes, {}, {} as VerifiedRevocations), /Expected verified revocation state/);
  assert.throws(() => new GraphIndex(releaseId, empty.graph, empty.bytes, {}, verifiedMask('other-release')), /release mismatch/);
});

test('original sealed graph and record validation runs before masked corruption can disappear', () => {
  const { records, graph, bytes, blocked, sharedId } = graphFixture();
  const mask = verifiedMask(releaseId, [{ type: 'record', recordId: blocked.id }]);
  const edited = structuredClone(graph);
  edited.edges.find(edge => edge.evidence.recordId === blocked.id)!.quote = 'Corrupted masked evidence';
  const omitted = structuredClone(graph);
  omitted.edges = omitted.edges.filter(edge => edge.evidence.recordId !== blocked.id);
  const relabelled = structuredClone(graph);
  relabelled.entities.find(entity => entity.id === sharedId)!.names.push('Corrupted masked alias');
  for (const corrupt of [edited, omitted, relabelled]) assert.throws(() => new GraphIndex(releaseId, corrupt, bytes, {}, mask), /does not match admitted record evidence/);
  assert.throws(() => new GraphIndex(releaseId, graph, `${bytes}\n`, {}, mask), /byte binding mismatch/);
  // Even invalid mask input cannot bypass original graph integrity validation.
  assert.throws(() => new GraphIndex(releaseId, edited, bytes, {}, {} as VerifiedRevocations), /does not match admitted record evidence/);
  const candidates = structuredClone(records);
  const candidate = candidates.find(record => record.id === blocked.id)!;
  candidate.verification.status = 'candidate';
  candidate.verification.evidenceHash = knowledgeEvidenceHash(candidate);
  const candidateBytes = JSON.stringify({ schemaVersion: KNOWLEDGE_SCHEMA_VERSION, generatedAt: now, records: candidates });
  assert.throws(() => new GraphIndex(releaseId, { ...graph, recordsSha256: sha256(candidateBytes) }, candidateBytes, {}, mask), /admitted records only/);
});

function diamondFixture() {
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map(id => mention(id, `Graph ${id}`));
  const record = recordFixture({ entities: [a, b, c, d], relations: [relation(a, b), relation(a, c), relation(b, d), relation(c, d)] }, 'diamond-record');
  return { record, ...publication([record]), fromId: record.entities[0].entityId, toId: record.entities[3].entityId };
}

test('all graph cursors bind the signed cohort even when changed masks expose identical graph bytes', () => {
  const { graph, bytes, fromId, toId } = diamondFixture();
  const originalMask = verifiedMask(releaseId, [], 0);
  const index = new GraphIndex(releaseId, graph, bytes, {}, originalMask);
  const recreated = new GraphIndex(releaseId, graph, bytes, {}, originalMask);
  const changed = [
    new GraphIndex(releaseId, graph, bytes, {}, verifiedMask(releaseId, [], 1)),
    new GraphIndex(releaseId, graph, bytes, {}, verifiedMask(releaseId, [{ type: 'record', recordId: 'not-in-this-release' }], 2)),
    new GraphIndex(releaseId, graph, bytes),
  ];
  const searchOptions = { query: 'Graph', limit: 1 };
  const neighborsOptions = { id: fromId, direction: 'out' as const, limit: 1 };
  const pathOptions = { fromId, toId, maxHops: 2, limit: 1 };
  const search = index.entitySearch(searchOptions), neighbors = index.neighbors(neighborsOptions), path = index.path(pathOptions);
  assert.ok(search.nextCursor); assert.ok(neighbors.nextCursor); assert.ok(path.nextCursor);
  assert.notEqual(recreated.entitySearch({ ...searchOptions, cursor: search.nextCursor }).items[0].id, search.items[0].id);
  assert.notEqual(recreated.neighbors({ ...neighborsOptions, cursor: neighbors.nextCursor }).items[0].edge.id, neighbors.items[0].edge.id);
  assert.notEqual(recreated.path({ ...pathOptions, cursor: path.nextCursor }).items[0].id, path.items[0].id);
  for (const other of changed) {
    assert.equal(other.recordsSha256, index.recordsSha256);
    assert.deepEqual(other.entitySearch({ query: 'Graph' }).items, index.entitySearch({ query: 'Graph' }).items);
    assert.notEqual(other.administrativeView?.viewId, index.administrativeView?.viewId);
    assert.throws(() => other.entitySearch({ ...searchOptions, cursor: search.nextCursor }), /mismatch/);
    assert.throws(() => other.neighbors({ ...neighborsOptions, cursor: neighbors.nextCursor }), /mismatch/);
    assert.throws(() => other.path({ ...pathOptions, cursor: path.nextCursor }), /mismatch/);
    const old = other.entitySearch(searchOptions);
    assert.ok(old.nextCursor);
    assert.throws(() => index.entitySearch({ ...searchOptions, cursor: old.nextCursor }), /mismatch/);
  }
});

test('graph budgets remain the fourth argument and bound the visible projection without changing truncation semantics', () => {
  const { record, graph: visibleGraph, bytes: visibleBytes, fromId, toId } = diamondFixture();
  const removed = recordFixture({ entities: [mention('removed', 'Graph Removed')], relations: [] }, 'budget-removed');
  const { graph, bytes } = publication([record, removed]);
  const mask = verifiedMask(releaseId, [{ type: 'record', recordId: removed.id }]);
  for (const budgets of [{ searchNodes: 1 }, { visitedNodes: 1 }, { examinedEdges: 1 }, { paths: 1 }, { pathSteps: 1 }] as Partial<GraphQueryBudgets>[]) {
    const index = new GraphIndex(releaseId, graph, bytes, budgets, mask);
    const expected = new GraphIndex(releaseId, visibleGraph, visibleBytes, budgets);
    assert.deepEqual(projectionContent(index.entitySearch({ query: 'Graph' })), projectionContent(expected.entitySearch({ query: 'Graph' })));
    assert.deepEqual(projectionContent(index.neighbors({ id: fromId, direction: 'out' })), projectionContent(expected.neighbors({ id: fromId, direction: 'out' })));
    const path = index.path({ fromId, toId, maxHops: 2 });
    assert.deepEqual(projectionContent(path), projectionContent(expected.path({ fromId, toId, maxHops: 2 })));
    if (budgets.searchNodes) {
      const missing = index.entitySearch({ query: 'Absent' });
      assert.equal(missing.truncated, true); assert.equal(missing.total, null); assert.equal(missing.status, 'incomplete');
    } else {
      assert.equal(path.truncated, true); assert.equal(path.complete, false); assert.equal(path.total, null);
      assert.notEqual(path.status, 'not_found_within_hops');
    }
  }
  for (const budgets of [{ searchNodes: 0 }, { examinedEdges: GRAPH_QUERY_BUDGETS.examinedEdges + 1 }]) assert.throws(() => new GraphIndex(releaseId, graph, bytes, budgets, mask), /Invalid graph search budget/);
});
