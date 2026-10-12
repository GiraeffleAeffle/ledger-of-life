import { z } from 'zod';
import { KnowledgeRecordsSchema, DistrictKnowledgeRecordSchema, hashSchema, sha256 } from './district-schema.ts';
import { IdentityBasisSchema, graphIdentityMention, relationModalitySchema, ENTITY_TYPE_PRECEDENCE, type GraphClaims } from './district-graph-claims.ts';
import { StructuredKnowledgeRecordSchema } from './district-structured-record.ts';
import { StructuredLocatorSchema, ObservationSchema, semanticHash, canonicalJson, type AdapterScope, type StructuredObservation } from './district-adapter-contract.ts';
import { IdentityMentionSchema, IdentityAssertionSchema, IdentityAdmissionSchema, assertIdentityAssertionsBound, identityAssertion, identifierKey, TemporalPathStepSchema, effectiveIntervalFromExpression, sourceCalendarDay, identityDaySchema, resolveIdentityMentions, unknownValidity, nativeStructuredIdentityGraph, type IdentityMention, type IdentityAssertion, type IdentityAdmission, type TemporalPathStep } from './district-entity-resolution.ts';
import { canonical } from './mcp-source-identity.ts';
import { CASE_LINKING_VERSION, CaseIdentitySchema, caseIdentityFromText, type CaseIdentity } from './district-case-linking.ts';

export const GRAPH_SCHEMA_VERSION = 'stadtstack-graph-v3';
const textEvidenceSchema = z.object({
  kind: z.literal('text_model'), recordId: z.string().min(1), municipalityId: z.string().min(1), evidenceHash: hashSchema,
  source: DistrictKnowledgeRecordSchema.shape.sources.element, sources: DistrictKnowledgeRecordSchema.shape.sources,
  textSha256: hashSchema, chunk: DistrictKnowledgeRecordSchema.shape.extraction.shape.chunk,
  relationNormalization: DistrictKnowledgeRecordSchema.shape.extraction.shape.relationNormalization,
}).strict();
const structuredEvidenceSchema = z.object({
  kind: z.literal('structured'), recordId: z.string().min(1), municipalityId: z.string().min(1), evidenceHash: hashSchema,
  source: StructuredKnowledgeRecordSchema.shape.source, locators: z.array(StructuredLocatorSchema).min(1),
  supportingSources: StructuredKnowledgeRecordSchema.shape.supportingSources, supportingEvidence: ObservationSchema.shape.supportingEvidence,
}).strict();
const evidenceSchema = z.discriminatedUnion('kind', [textEvidenceSchema, structuredEvidenceSchema]);
const graphMentionSchema = IdentityMentionSchema.extend({ evidence: z.array(evidenceSchema).min(1) }).strict();
export const GraphEntitySchema = z.object({
  id: z.string().regex(/^entity:[a-f0-9]{64}$/), type: z.string().min(1), names: z.array(z.string().min(1)).min(1),
  identityBasis: IdentityBasisSchema, identityAssertionIds: z.array(z.string()), conflicts: z.array(z.string()),
  mentions: z.array(graphMentionSchema).min(1),
}).strict();
export const GraphEdgeSchema = z.object({
  id: z.string().regex(/^edge:[a-f0-9]{64}$/), fromId: z.string(), toId: z.string(), fromMention: z.string(), toMention: z.string(),
  type: z.string().min(1), modality: relationModalitySchema, quote: z.string().nullable(), predicateQuote: z.string().nullable(),
  time: z.object({ text: z.string(), quote: z.string() }).strict().nullable(), conditions: z.string().nullable(),
  temporal: TemporalPathStepSchema, evidence: evidenceSchema, eventEvidence: z.array(evidenceSchema),
}).strict();
const graphIdentitySchema = z.object({ mentions: z.array(IdentityMentionSchema), assertions: z.array(IdentityAssertionSchema), admissions: z.array(IdentityAdmissionSchema), blocked: z.array(z.object({ assertionId: z.string(), reasons: z.array(z.string()) }).strict()) }).strict();
export const KnowledgeGraphSchema = z.object({
  schemaVersion: z.literal(GRAPH_SCHEMA_VERSION), recordsSha256: hashSchema, asOf: identityDaySchema, identitySha256: hashSchema,
  identity: graphIdentitySchema, entities: z.array(GraphEntitySchema), edges: z.array(GraphEdgeSchema),
  caseLinkingVersion: z.literal(CASE_LINKING_VERSION), cases: z.array(z.object({ recordId: z.string().min(1), identity: CaseIdentitySchema }).strict()),
}).strict();
export type KnowledgeGraph = z.infer<typeof KnowledgeGraphSchema>;
export type GraphEntity = z.infer<typeof GraphEntitySchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
type Evidence = z.infer<typeof evidenceSchema>;

/** Source dates retain their original precision and role; retrieval clocks never establish validity. */
export function textRelationTemporal(relation: GraphClaims['relations'][number], sourceSha256: string): TemporalPathStep {
  const temporal: TemporalPathStep = { validity: unknownValidity(), identityValidity: [], eventDate: null, eventDateRole: null, eventEvidenceHashes: [], unresolvedContradiction: false };
  if (!relation.time) return temporal;
  const expression = relation.time.text, evidenceHashes = [semanticHash([sourceSha256, relation.time.quote])];
  temporal.validity = effectiveIntervalFromExpression(expression, evidenceHashes);
  if (temporal.validity.validFrom.kind === 'date' && temporal.validity.validTo.kind === 'date' && temporal.validity.validFrom.date === temporal.validity.validTo.date && temporal.validity.validFrom.precision === temporal.validity.validTo.precision) temporal.validity = { ...unknownValidity(), expression, evidenceHashes };
  const eventDate = sourceCalendarDay(expression.replace(/^am\s+/iu, ''));
  if (eventDate && ['decides', 'approves', 'implements', 'amends', 'succeeds'].includes(relation.type)) {
    temporal.eventDate = eventDate; temporal.eventDateRole = relation.type; temporal.eventEvidenceHashes = evidenceHashes;
  }
  return temporal;
}

export interface GraphIdentityInputs {
  mentions: IdentityMention[];
  mentionsById: Map<string, IdentityMention>;
  assertions: IdentityAssertion[];
  identityAdmissions: IdentityAdmission[];
  additionalSourceHashes: string[];
  mentionEvidence: Map<string, Evidence[]>;
  pendingEdges: Array<Omit<GraphEdge, 'id' | 'fromId' | 'toId'>>;
  cases: Array<{ recordId: string; identity: CaseIdentity }>;
}

/** Exact source-native/text projection shared by the admission publisher and final graph builder. */
export function graphIdentityInputs(envelope: unknown): GraphIdentityInputs {
  const input = KnowledgeRecordsSchema.parse(envelope);
  const mentions = new Map<string, IdentityMention>(), mentionEvidence = new Map<string, Evidence[]>();
  const assertions: IdentityAssertion[] = [...input.identityAssertions], pendingEdges: Array<Omit<GraphEdge, 'id' | 'fromId' | 'toId'>> = [];
  const recordIds = new Set<string>();
  const cases: Array<{ recordId: string; identity: CaseIdentity }> = [];
  const sourceHashes: string[] = [];
  const nativeActionDates = new Map<string, Array<{ date: string; role: string; evidence: Evidence }>>();
  const nativeRecordKeys = new Map<string, string>();
  const nativeKey = (observation: StructuredObservation, scope: AdapterScope, sourceSha256: string) => canonicalJson([scope, sourceSha256, observation.publisherId, observation.sourceId, observation.nativeId, observation.nativeVersion, observation.subject]);
  const addMention = (mention: IdentityMention, evidence: Evidence) => {
    const prior = mentions.get(mention.id);
    if (prior) {
      const priorIdentity = { ...prior, legalForm: prior.legalForm ?? mention.legalForm, evidenceHashes: [], name: '', identifiers: prior.identifiers.map(({ evidenceHashes, ...key }) => key) };
      const nextIdentity = { ...mention, legalForm: mention.legalForm ?? prior.legalForm, evidenceHashes: [], name: '', identifiers: mention.identifiers.map(({ evidenceHashes, ...key }) => key) };
      if (canonicalJson(priorIdentity) !== canonicalJson(nextIdentity)) throw Error('Conflicting source mention identity');
      prior.evidenceHashes = [...new Set([...prior.evidenceHashes, ...mention.evidenceHashes])].sort();
      prior.legalForm ??= mention.legalForm;
      for (let index = 0; index < prior.identifiers.length; index++) prior.identifiers[index].evidenceHashes = [...new Set([...prior.identifiers[index].evidenceHashes, ...mention.identifiers[index].evidenceHashes])].sort();
      // Source-native ID labels may be replaced by an explicitly disclosed organization name, never vice versa.
      if (prior.name === prior.identifiers[0]?.value && mention.name !== mention.identifiers[0]?.value) prior.name = mention.name;
    } else mentions.set(mention.id, structuredClone(mention));
    const evidenceList = mentionEvidence.get(mention.id) ?? []; evidenceList.push(evidence); mentionEvidence.set(mention.id, evidenceList);
  };
  for (const record of [...input.records].sort((a, b) => a.id.localeCompare(b.id))) {
    if (recordIds.has(record.id)) throw Error('Duplicate graph source record'); recordIds.add(record.id);
    if (record.verification.status !== 'auto-verified') throw Error('Graph requires admitted records only');
    sourceHashes.push(record.verification.evidenceHash);
    if (record.kind === 'structured') {
      const mapped = nativeStructuredIdentityGraph(record.observation, record.scope);
      if (canonicalJson(mapped.mentions) !== canonicalJson(record.graph.mentions) || canonicalJson(mapped.relations) !== canonicalJson(record.graph.relations)) throw Error('Structured graph differs from pinned native identity mapping');
      sourceHashes.push(record.source.sha256, ...record.observation.evidence.map(locator => semanticHash(locator)), ...record.supportingSources.map(source => source.sha256), ...record.observation.supportingEvidence.map(value => semanticHash(value.locator)));
      const evidence: Evidence = { kind: 'structured', recordId: record.id, municipalityId: record.municipalityId, evidenceHash: record.verification.evidenceHash, source: record.source, locators: record.observation.evidence, supportingSources: record.supportingSources, supportingEvidence: record.observation.supportingEvidence };
      const key = nativeKey(record.observation, record.scope, record.source.sha256);
      nativeRecordKeys.set(record.id, key);
      const actionRoles: Record<string, { predicate: string; role: string }> = { Award: { predicate: 'decision_date', role: 'award_decision' }, Contract: { predicate: 'signature_date', role: 'contract_signature' } };
      const action = Object.hasOwn(actionRoles, record.observation.kind) ? actionRoles[record.observation.kind] : null;
      if (action && record.observation.nativeVersion !== null && record.observation.predicate === action.predicate && record.observation.dateRole === action.role && ['day', 'instant'].includes(record.observation.datePrecision) && record.observation.date !== null && record.observation.evidence.every(locator => locator.mappingVersion === 'procurement-native-v1')) {
        const date = identityDaySchema.parse(record.observation.date.slice(0, 10));
        if (!record.observation.evidence.some(locator => typeof locator.rawValue === 'string' && (locator.rawValue.startsWith(date) || sourceCalendarDay(locator.rawValue) === date))) throw Error('Native action date lacks original field value');
        const dates = nativeActionDates.get(key) ?? [];
        dates.push({ date, role: action.role, evidence }); nativeActionDates.set(key, dates);
      }
      for (const mention of record.graph.mentions) addMention(mention, evidence);
      assertions.push(...record.graph.assertions);
      for (const relation of record.graph.relations) pendingEdges.push({
        fromMention: relation.subjectMentionId, toMention: relation.objectMentionId, type: relation.predicate, modality: relation.modality,
        quote: null, predicateQuote: null, time: null, conditions: null,
        temporal: { validity: relation.validity, identityValidity: [], eventDate: relation.eventDate, eventDateRole: relation.eventDateRole, eventEvidenceHashes: relation.eventDate ? relation.evidence.map(locator => semanticHash(locator)) : [], unresolvedContradiction: false },
        evidence: { ...evidence, locators: relation.evidence }, eventEvidence: relation.eventDate ? [{ ...evidence, locators: relation.evidence }] : [],
      });
    } else {
      sourceHashes.push(record.extraction.inputSha256, ...record.relations.flatMap(relation => [semanticHash([record.extraction.inputSha256, relation.quote]), ...(relation.time ? [semanticHash([record.extraction.inputSha256, relation.time.quote])] : [])]));
      cases.push({ recordId: record.id, identity: caseIdentityFromText(record) });
      const evidence: Evidence = { kind: 'text_model', recordId: record.id, municipalityId: record.municipalityId, evidenceHash: record.verification.evidenceHash, source: record.sources[0], sources: record.sources, textSha256: record.extraction.textSha256, chunk: record.extraction.chunk, ...(record.extraction.relationNormalization ? { relationNormalization: record.extraction.relationNormalization } : {}) };
      const localMentions = new Map<string, IdentityMention>();
      for (const entity of record.entities) {
        const mention = graphIdentityMention(entity, { municipalityId: record.municipalityId, sourceSha256: record.extraction.inputSha256, ags: record.ags });
        addMention(mention, evidence); localMentions.set(entity.mentionId, mention);
      }
      for (const relation of record.relations) {
        const from = localMentions.get(relation.fromMention), to = localMentions.get(relation.toMention);
        if (!from || !to) throw Error('Unbound text graph endpoint');
        const temporal = textRelationTemporal(relation, record.extraction.inputSha256);
        pendingEdges.push({ ...relation, fromMention: from.id, toMention: to.id, temporal, evidence, eventEvidence: temporal.eventDate ? [evidence] : [] });
      }
    }
  }
  for (const edge of pendingEdges) {
    if (edge.evidence.kind !== 'structured') continue;
    const key = nativeRecordKeys.get(edge.evidence.recordId)!, dates = nativeActionDates.get(key) ?? [];
    if (!dates.length) continue;
    const distinct = new Set(dates.map(value => canonicalJson([value.date, value.role])));
    edge.eventEvidence = dates.map(value => value.evidence);
    if (distinct.size !== 1) { edge.temporal.unresolvedContradiction = true; continue; }
    const date = dates[0];
    edge.temporal.eventDate = date.date; edge.temporal.eventDateRole = date.role;
    edge.temporal.eventEvidenceHashes = [...new Set(dates.flatMap(value => value.evidence.kind === 'structured' ? value.evidence.locators.map(locator => semanticHash(locator)) : []))].sort();
  }
  for (const edge of pendingEdges) {
    if (edge.type !== 'succeeds') continue;
    const from = mentions.get(edge.fromMention)!, to = mentions.get(edge.toMention)!;
    const identifiers = new Set(from.identifiers.map(identifierKey));
    if (!to.identifiers.some(value => identifiers.has(identifierKey(value)))) continue;
    const evidenceHashes = edge.evidence.kind === 'text_model' ? [semanticHash([from.sourceSha256, edge.quote])] : edge.evidence.locators.map(locator => semanticHash(locator));
    assertions.push(identityAssertion({
      version: 1, leftMentionId: from.id, rightMentionId: to.id, decision: 'different_identity', status: 'contested',
      method: 'strong_identifier', ruleVersion: 'source-succession-conflict-v1', author: 'deterministic-source-conflict-check',
      adjudicator: null, reviewReceiptSha256: null, validity: unknownValidity(), evidenceHashes,
    }));
  }
  return { mentions: [...mentions.values()], mentionsById: mentions, assertions, identityAdmissions: input.identityAdmissions, additionalSourceHashes: sourceHashes, mentionEvidence, pendingEdges, cases };
}

/** Exact admitted bytes bind claims and both identity input sets; asOf is an explicit publication input. */
export function buildKnowledgeGraph(recordsBytes: string | Uint8Array, options: { asOf: string }): KnowledgeGraph {
  const asOf = identityDaySchema.parse(options.asOf);
  const projected = graphIdentityInputs(JSON.parse(typeof recordsBytes === 'string' ? recordsBytes : Buffer.from(recordsBytes).toString('utf8')));
  const { mentionsById: mentions, assertions, identityAdmissions, additionalSourceHashes: sourceHashes, mentionEvidence, pendingEdges, cases } = projected;
  assertIdentityAssertionsBound(projected.mentions, assertions, identityAdmissions, sourceHashes);
  const resolved = resolveIdentityMentions(projected.mentions, assertions);
  const identity = { mentions: projected.mentions.sort((a, b) => a.id.localeCompare(b.id)), assertions: resolved.assertions, admissions: [...identityAdmissions].sort((a, b) => a.assertionId.localeCompare(b.assertionId) || a.assertionSha256.localeCompare(b.assertionSha256)), blocked: resolved.blocked };
  const entities: GraphEntity[] = [], owner = new Map<string, GraphEntity>();
  const blockedIds = new Set(resolved.blocked.map(value => value.assertionId));
  for (const cluster of resolved.clusters) {
    const members = cluster.mentionIds.map(id => mentions.get(id)!);
    const kinds = [...new Set(members.map(value => value.type))].sort((a, b) => {
      const rankA = (ENTITY_TYPE_PRECEDENCE as readonly string[]).indexOf(a), rankB = (ENTITY_TYPE_PRECEDENCE as readonly string[]).indexOf(b);
      return (rankA < 0 ? 100 : rankA) - (rankB < 0 ? 100 : rankB) || a.localeCompare(b);
    });
    const node: GraphEntity = { id: cluster.id, type: kinds[0], names: cluster.aliases, conflicts: cluster.conflicts,
      identityBasis: !members.some(value => value.identifiers.length) && members[0].councilBodyIdentity && !cluster.conflicts.length ? members[0].councilBodyIdentity : { kind: members.some(value => value.identifiers.length) && !cluster.conflicts.length ? 'explicit_identifier' : 'source_scoped_mention', key: canonicalJson({ id: cluster.id }), scope: members.some(value => value.identifiers.length) ? null : members[0].municipalityId, ambiguity: 'Source-grounded identity grouping, not independent legal-entity verification.' },
      identityAssertionIds: resolved.assertions.filter(value => value.status === 'accepted' && value.decision === 'same_identity' && !blockedIds.has(value.id) && cluster.mentionIds.includes(value.leftMentionId) && cluster.mentionIds.includes(value.rightMentionId)).map(value => value.id),
      mentions: members.map(value => ({ ...value, evidence: mentionEvidence.get(value.id)! })),
    };
    entities.push(node); for (const id of cluster.mentionIds) owner.set(id, node);
  }
  const assertionById = new Map(resolved.assertions.map(value => [value.id, value]));
  const edges = new Map<string, GraphEdge>();
  for (const pending of pendingEdges) {
    const from = owner.get(pending.fromMention), to = owner.get(pending.toMention);
    if (!from || !to) throw Error('Unbound graph identity endpoint');
    const relevant = [...new Set([...from.identityAssertionIds, ...to.identityAssertionIds])];
    const temporal = { ...pending.temporal, identityValidity: relevant.map(id => assertionById.get(id)!.validity), unresolvedContradiction: pending.temporal.unresolvedContradiction || from.conflicts.length > 0 || to.conflicts.length > 0 || resolved.blocked.some(value => { const assertion = assertionById.get(value.assertionId)!; return [from, to].some(node => node.mentions.some(mention => mention.id === assertion.leftMentionId || mention.id === assertion.rightMentionId)); }) };
    const value = { ...pending, temporal, fromId: from.id, toId: to.id };
    const id = `edge:${sha256(canonical(value))}`; edges.set(id, { id, ...value });
  }
  return KnowledgeGraphSchema.parse({ schemaVersion: GRAPH_SCHEMA_VERSION, asOf, recordsSha256: sha256(recordsBytes), identitySha256: semanticHash(identity), identity, caseLinkingVersion: CASE_LINKING_VERSION, cases, entities: entities.sort((a, b) => a.id.localeCompare(b.id)), edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)) });
}

/** A graph or identity hash alone is not a proof: recompute from the admitted input bytes. */
export function validateKnowledgeGraph(input: unknown, recordsBytes: string | Uint8Array): KnowledgeGraph {
  const graph = KnowledgeGraphSchema.parse(input);
  if (graph.recordsSha256 !== sha256(recordsBytes)) throw Error('Graph records byte binding mismatch');
  const expected = buildKnowledgeGraph(recordsBytes, { asOf: graph.asOf });
  if (canonical(graph) !== canonical(expected)) throw Error('Graph does not match admitted record and identity evidence');
  return graph;
}
/** Withholding is never new truth: remove any component whose original provenance was masked. */
export function conservativeGraphReadView(original: KnowledgeGraph, safe: KnowledgeGraph, visibleRecordIds: ReadonlySet<string>): KnowledgeGraph {
  if (safe.asOf !== original.asOf) throw Error('Graph read mask changed pinned asOf');
  const adjacency = new Map<string, string[]>(), affected = new Set<string>(), queue: string[] = [];
  const mark = (id: string) => { if (!affected.has(id)) { affected.add(id); queue.push(id); } };
  for (const entity of original.entities) {
    adjacency.set(entity.id, []);
    if (entity.mentions.some(mention => mention.evidence.some(evidence => !visibleRecordIds.has(evidence.recordId)))) mark(entity.id);
  }
  for (const edge of original.edges) {
    adjacency.get(edge.fromId)!.push(edge.toId); adjacency.get(edge.toId)!.push(edge.fromId);
    if (!visibleRecordIds.has(edge.evidence.recordId) || edge.eventEvidence.some(evidence => !visibleRecordIds.has(evidence.recordId))) { mark(edge.fromId); mark(edge.toId); }
  }
  const originalAssertions = new Map(original.identity.assertions.map(value => [value.id, value]));
  const safeAssertions = new Map(safe.identity.assertions.map(value => [value.id, value]));
  for (const entity of original.entities) if (entity.identityAssertionIds.some(id => canonicalJson(originalAssertions.get(id)) !== canonicalJson(safeAssertions.get(id) ?? null))) mark(entity.id);
  for (let index = 0; index < queue.length; index++) for (const id of adjacency.get(queue[index]) ?? []) mark(id);
  const originalOwners = new Map(original.entities.flatMap(entity => entity.mentions.map(mention => [mention.id, entity.id] as const)));
  const entities = safe.entities.filter(entity => entity.mentions.every(mention => !affected.has(originalOwners.get(mention.id)!)));
  const entityIds = new Set(entities.map(entity => entity.id)), mentionIds = new Set(entities.flatMap(entity => entity.mentions.map(mention => mention.id)));
  const assertions = safe.identity.assertions.filter(value => mentionIds.has(value.leftMentionId) && mentionIds.has(value.rightMentionId));
  const assertionIds = new Set(assertions.map(value => value.id));
  const identity = { mentions: safe.identity.mentions.filter(value => mentionIds.has(value.id)), assertions,
    admissions: safe.identity.admissions.filter(value => assertionIds.has(value.assertionId)), blocked: safe.identity.blocked.filter(value => assertionIds.has(value.assertionId)) };
  return KnowledgeGraphSchema.parse({ ...safe, entities, edges: safe.edges.filter(edge => entityIds.has(edge.fromId) && entityIds.has(edge.toId)), identity, identitySha256: semanticHash(identity) });
}
