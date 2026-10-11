import { z } from 'zod';
import { KnowledgeRecordsSchema, hashSchema, sha256 } from './district-schema.ts';
import { EntityMentionSchema, IdentityBasisSchema, NormalizedRelationSchema, entityTypeSchema } from './district-graph-claims.ts';
import { canonical } from './mcp-pagination.ts';

export const GRAPH_SCHEMA_VERSION = 'stadtstack-graph-v1';
const evidenceSchema = z.object({
  recordId: z.string().min(1), municipalityId: z.string().min(1), evidenceHash: hashSchema,
  source: KnowledgeRecordsSchema.shape.records.element.shape.sources.element,
  textSha256: hashSchema, chunk: KnowledgeRecordsSchema.shape.records.element.shape.extraction.shape.chunk,
  relationNormalization: KnowledgeRecordsSchema.shape.records.element.shape.extraction.shape.relationNormalization,
}).strict();
export const GraphEntitySchema = z.object({
  id: z.string().regex(/^entity:[a-f0-9]{64}$/), type: entityTypeSchema, names: z.array(z.string().min(1)).min(1),
  identityBasis: IdentityBasisSchema,
  mentions: z.array(EntityMentionSchema.extend({ evidence: evidenceSchema }).strict()).min(1),
}).strict();
export const GraphEdgeSchema = NormalizedRelationSchema.extend({ id: z.string().regex(/^edge:[a-f0-9]{64}$/), evidence: evidenceSchema }).strict();
export const KnowledgeGraphSchema = z.object({
  schemaVersion: z.literal(GRAPH_SCHEMA_VERSION), recordsSha256: hashSchema,
  entities: z.array(GraphEntitySchema), edges: z.array(GraphEdgeSchema),
}).strict();
export type KnowledgeGraph = z.infer<typeof KnowledgeGraphSchema>;
export type GraphEntity = z.infer<typeof GraphEntitySchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

/** The only builder input is the exact publication bytes, not a second extraction or loose records. */
export function buildKnowledgeGraph(recordsBytes: string | Uint8Array): KnowledgeGraph {
  const input = KnowledgeRecordsSchema.parse(JSON.parse(typeof recordsBytes === 'string' ? recordsBytes : Buffer.from(recordsBytes).toString('utf8')));
  const entities = new Map<string, GraphEntity>();
  const edges: GraphEdge[] = [];
  const recordIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const record of [...input.records].sort((a, b) => a.id.localeCompare(b.id))) {
    if (recordIds.has(record.id)) throw Error('Duplicate graph source record');
    recordIds.add(record.id);
    if (record.verification.status !== 'auto-verified') throw Error('Graph requires admitted records only');
    const evidence = { recordId: record.id, municipalityId: record.municipalityId, evidenceHash: record.verification.evidenceHash, source: record.sources[0], textSha256: record.extraction.textSha256, chunk: record.extraction.chunk, ...(record.extraction.relationNormalization ? { relationNormalization: record.extraction.relationNormalization } : {}) };
    for (const entity of record.entities) {
      const { entityId, identityBasis, ...mention } = entity;
      let node = entities.get(entityId);
      if (!node) {
        node = { id: entityId, type: entity.type, names: [], identityBasis, mentions: [] };
        entities.set(entityId, node);
      }
      if (!node.names.includes(entity.name)) node.names.push(entity.name);
      node.mentions.push({ ...mention, evidence });
    }
    for (const relation of record.relations) {
      const edge = { ...relation, evidence };
      const id = `edge:${sha256(canonical(edge))}`;
      // Repeated claims in the same record cannot multiply paths.
      if (!edgeIds.has(id)) { edgeIds.add(id); edges.push({ id, ...edge }); }
    }
  }
  for (const entity of entities.values()) entity.names.sort();
  return KnowledgeGraphSchema.parse({ schemaVersion: GRAPH_SCHEMA_VERSION, recordsSha256: sha256(recordsBytes), entities: [...entities.values()].sort((a, b) => a.id.localeCompare(b.id)), edges: edges.sort((a, b) => a.id.localeCompare(b.id)) });
}

/** Recompute, rather than trusting an attacker-supplied binding hash or graph evidence. */
export function validateKnowledgeGraph(input: unknown, recordsBytes: string | Uint8Array): KnowledgeGraph {
  const graph = KnowledgeGraphSchema.parse(input);
  if (graph.recordsSha256 !== sha256(recordsBytes)) throw Error('Graph records byte binding mismatch');
  const expected = buildKnowledgeGraph(recordsBytes);
  if (canonical(graph) !== canonical(expected)) throw Error('Graph does not match admitted record evidence');
  return graph;
}
