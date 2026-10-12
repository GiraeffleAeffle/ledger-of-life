import { z } from 'zod';
import { buildKnowledgeGraph, projectKnowledgeReadEnvelope, validateKnowledgeGraph, validateMaskedKnowledgeGraph, conservativeGraphReadView, type GraphEntity, type GraphEdge, type KnowledgeGraph } from './district-graph.ts';
import {isRecordRevoked,isSourceRevoked,type VerifiedRevocations} from './civic-revocations.ts';
import { identityDaySchema, temporalPathEligible, intervalCouldContain, intervalBoundaryRange, effectiveIntervalFromExpression } from './district-entity-resolution.ts';
import { boundPage, cursorBinding, readCursor } from './mcp-pagination.ts';
import {administrativeView,type AdministrativeView} from './mcp-revocation-view.ts';
import {knowledgeSourceDescriptors} from './mcp-source-identity.ts';
import {KnowledgeRecordsSchema} from './district-schema.ts';
import { entityTypeSchema } from './district-graph-claims.ts';

const pageShape = { limit: z.number().int().min(1).max(50).default(20), cursor: z.string().min(1).max(2048).optional() };
const entityId = z.string().regex(/^entity:[a-f0-9]{64}$/);
const searchableEntityTypeSchema = z.enum([...entityTypeSchema.options, 'energy_unit', 'spatial_plan', 'council_meeting', 'council_paper', 'agenda_item', 'document', 'funding_operation', 'payment_disclosure', 'programme_attribution', 'procurement_notice', 'procurement_tender', 'procurement_lot', 'procurement_lot_result', 'procurement_procedure', 'procurement_party', 'procurement_tendering_party', 'award', 'contract', 'permit_procedure']);
export const entitySearchSchema = z.object({ query: z.string().trim().min(1).max(200), type: searchableEntityTypeSchema.optional(), asOf: identityDaySchema.optional(), ...pageShape }).strict();
export const graphNeighborsSchema = z.object({ id: entityId, relationTypes: z.array(z.string().min(1).max(100)).min(1).max(20).optional(), asOf: identityDaySchema.optional(), direction: z.enum(['in', 'out', 'both']).default('both'), ...pageShape }).strict();
export const graphPathSchema = z.object({ fromId: entityId, toId: entityId, maxHops: z.number().int().min(1).max(5), asOf: identityDaySchema.optional(), mode: z.enum(['as_of', 'chronological', 'historical']).default('as_of'), ...pageShape }).strict();
export const GRAPH_QUERY_BUDGETS = Object.freeze({ searchNodes: 10000, visitedNodes: 2000, examinedEdges: 10000, paths: 100, pathSteps: 20000 });
export type GraphQueryBudgets = { [K in keyof typeof GRAPH_QUERY_BUDGETS]: number };
const scope = 'Only explicit source-grounded relations and admitted identity assertions. Identity grouping is not independent legal-entity verification. Missing evidence is not absence of activity; paths establish neither causality nor success.';
const pathEligibility = { eligibleModalities: ['asserted', 'decided', 'implemented'], excludedModalities: ['planned', 'proposed', 'conditional', 'negated'], temporalRule: 'Ongoing edges and identity assertions must contain the pinned asOf; unknown validity is not current. Legal/financial events keep their own dates and identity at each event date. Historical mode returns attributed claims, not confirmed-current paths.' };
export function graphEdgeModalityEligible(edge: Pick<GraphEdge, 'type' | 'modality'>, historical = false): boolean {
  if (historical && edge.modality === 'historical') return true;
  if (edge.type === 'plans') return false;
  if (edge.modality === 'asserted') return !['implements', 'decides', 'approves'].includes(edge.type);
  if (edge.modality === 'decided') return edge.type === 'decides' || edge.type === 'approves';
  return edge.modality === 'implemented' && edge.type === 'implements';
}

export class GraphIndex {
  readonly recordsSha256: string;
  readonly releaseId: string;
  readonly releaseAsOf: string;
  readonly identitySha256: string;
  readonly maskIdentity:string|null;
  readonly administrativeView:AdministrativeView|null;
  private readonly graph:KnowledgeGraph;
  private readonly entities: Map<string, GraphEntity>;
  private readonly orderedEntities: GraphEntity[];
  private readonly outgoing = new Map<string, GraphEdge[]>();
  private readonly incoming = new Map<string, GraphEdge[]>();
  private readonly budgets: GraphQueryBudgets;
  private readonly roleEvidence = new Map<string, GraphEdge[]>();

  constructor(releaseId: string, graph: unknown, recordsBytes: string | Uint8Array, budgets: Partial<GraphQueryBudgets> = {}, revocations?:VerifiedRevocations, authenticatedReadView=false) {
    let bound:KnowledgeGraph;
    if(authenticatedReadView){
      if(!revocations)throw Error('Authenticated graph read view requires verified revocations');
      this.administrativeView=administrativeView(releaseId,revocations);
      bound=validateMaskedKnowledgeGraph(graph,recordsBytes,releaseId,revocations.artifactSha256);
    }else{
      bound=validateKnowledgeGraph(graph,recordsBytes);
      this.administrativeView=revocations===undefined?null:administrativeView(releaseId,revocations);
      if(revocations!==undefined){
        const original=KnowledgeRecordsSchema.parse(JSON.parse(typeof recordsBytes==='string'?recordsBytes:Buffer.from(recordsBytes).toString('utf8')));
        const ids=new Set(original.records.filter(record=>!isRecordRevoked(revocations,{recordId:record.id,municipalityId:record.municipalityId,sources:knowledgeSourceDescriptors(record)})).map(record=>record.id));
        const safeBytes=ids.size===original.records.length?recordsBytes:JSON.stringify(projectKnowledgeReadEnvelope(original,ids));
        const safe=validateKnowledgeGraph(buildKnowledgeGraph(safeBytes,{asOf:bound.asOf}),safeBytes);
        bound=conservativeGraphReadView(bound,safe,ids,revocations);
      }
    }
    const maskIdentity=revocations?.artifactSha256??null;
    this.releaseId = releaseId; this.recordsSha256 = bound.recordsSha256; this.releaseAsOf = bound.asOf; this.identitySha256 = bound.identitySha256;this.maskIdentity=maskIdentity;this.graph=bound;
    this.budgets = { ...GRAPH_QUERY_BUDGETS, ...budgets };
    for (const name of Object.keys(GRAPH_QUERY_BUDGETS) as (keyof GraphQueryBudgets)[]) if (!Number.isInteger(this.budgets[name]) || this.budgets[name] < 1 || this.budgets[name] > GRAPH_QUERY_BUDGETS[name]) throw Error('Invalid graph search budget');
    this.orderedEntities = bound.entities; this.entities = new Map(bound.entities.map(entity => [entity.id, entity]));
    for (const edge of bound.edges) {
      if (!this.entities.has(edge.fromId) || !this.entities.has(edge.toId)) throw Error('Dangling graph edge');
      const outgoing = this.outgoing.get(edge.fromId) ?? []; outgoing.push(edge); this.outgoing.set(edge.fromId, outgoing);
      const incoming = this.incoming.get(edge.toId) ?? []; incoming.push(edge); this.incoming.set(edge.toId, incoming);
      if (edge.modality === 'negated' || edge.modality === 'historical' && edge.temporal.eventDate === null && edge.temporal.validity.validTo.kind === 'date') {
        const key = JSON.stringify([edge.fromId, edge.toId, edge.type]), entries = this.roleEvidence.get(key) ?? [];
        entries.push(edge); this.roleEvidence.set(key, entries);
      }
    }
  }
  /** Strictly authenticate safe inputs, then serve the original graph's conservative closure. */
  withReadView(safeGraph:unknown,safeRecordsBytes:string|Uint8Array,visibleRecordIds:ReadonlySet<string>,mask:VerifiedRevocations):GraphIndex {
    isSourceRevoked(mask,{});
    if(this.maskIdentity!==null)throw Error('Graph read views require the original publication index');
    if(mask.releaseId!==this.releaseId)throw Error('Graph read mask release mismatch');
    const checkedSafe=validateKnowledgeGraph(safeGraph,safeRecordsBytes),view=conservativeGraphReadView(this.graph,checkedSafe,visibleRecordIds,mask);
    return new GraphIndex(this.releaseId,view,safeRecordsBytes,this.budgets,mask,true);
  }

  graphView():KnowledgeGraph{return this.graph;}
  /** Relation scope only: metric replacements and corporate succession never imply an operator transfer. */
  private blockingRoleEvidence(edge: GraphEdge, asOf: string, inspect: () => boolean): GraphEdge[] | null {
    const result: GraphEdge[] = [], reference = edge.temporal.eventDate ?? asOf;
    for (const other of this.roleEvidence.get(JSON.stringify([edge.fromId, edge.toId, edge.type])) ?? []) {
      if (other.id === edge.id) continue;
      if (!inspect()) return null;
      const validity = other.time ? effectiveIntervalFromExpression(other.time.text, other.temporal.validity.evidenceHashes.length ? other.temporal.validity.evidenceHashes : [other.evidence.evidenceHash]) : other.temporal.validity;
      if (other.modality === 'negated' && intervalCouldContain(validity, reference)) { result.push(other); continue; }
      if (edge.temporal.eventDate !== null) continue;
      const start = intervalBoundaryRange(edge.temporal.validity.validFrom), end = intervalBoundaryRange(validity.validTo);
      const negativePoint = other.modality === 'negated' && validity.validFrom.kind === 'date' && validity.validTo.kind === 'date' && validity.validFrom.date === validity.validTo.date && validity.validFrom.precision === validity.validTo.precision;
      if ((other.modality === 'historical' || negativePoint) && end && reference > end.latest && (!start || start.earliest <= end.latest)) {
        if (other.modality === 'historical' || intervalCouldContain(edge.temporal.validity, end.earliest)) result.push(other);
      }
    }
    return result;
  }

  entitySearch(input: unknown) {
    const options = entitySearchSchema.parse(input), asOf = options.asOf ?? this.releaseAsOf;
    const { cursor, ...filters } = options;
    const binding = cursorBinding({ tool: 'entity_search', releaseId:this.releaseId,maskIdentity:this.maskIdentity,filters: { ...filters, asOf }, records: this.recordsSha256, identity: this.identitySha256, budgets: this.budgets });
    readCursor(cursor, this.releaseId, binding);
    const query = options.query.normalize('NFC').toLocaleLowerCase('de'), matches: GraphEntity[] = [];
    let examinedNodes = 0;
    for (const entity of this.orderedEntities) {
      if (examinedNodes >= this.budgets.searchNodes) break; examinedNodes++;
      if ((!options.type || options.type === entity.type || entity.mentions.some(mention => mention.type === options.type)) && (entity.names.some(name => name.normalize('NFC').toLocaleLowerCase('de').includes(query)) || entity.mentions.some(mention => mention.identifiers.some(identifier => identifier.value.toLocaleLowerCase('de').includes(query))))) matches.push(entity);
    }
    const truncated = examinedNodes < this.orderedEntities.length, page = boundPage(matches, entity => entity.id, options, this.releaseId, binding);
    return { administrativeView:this.administrativeView,releaseId: this.releaseId,maskIdentity:this.maskIdentity, releaseAsOf: this.releaseAsOf, asOf, temporalMode: 'identity_search', identitySha256: this.identitySha256, recordsSha256: this.recordsSha256, ...page, total: truncated ? null : page.total, matchedLowerBound: matches.length, truncated, complete: !truncated, status: matches.length ? 'found' : truncated ? 'incomplete' : 'not_found', examinedNodes, budgets: this.budgets, scope };
  }

  neighbors(input: unknown) {
    const options = graphNeighborsSchema.parse(input), asOf = options.asOf ?? this.releaseAsOf;
    if (!this.entities.has(options.id)) throw Error('Unknown graph entity; use entity_search');
    const { cursor, ...filters } = options;
    const binding = cursorBinding({ tool: 'graph_neighbors', releaseId:this.releaseId,maskIdentity:this.maskIdentity,filters: { ...filters, asOf, relationTypes: options.relationTypes ? [...new Set(options.relationTypes)].sort() : undefined }, records: this.recordsSha256, identity: this.identitySha256, budgets: this.budgets });
    readCursor(cursor, this.releaseId, binding);
    const matches: GraphEdge[] = [], seen = new Set<string>(), visited = new Set<string>([options.id]);
    const lists = options.direction === 'out' ? [this.outgoing.get(options.id) ?? []] : options.direction === 'in' ? [this.incoming.get(options.id) ?? []] : [this.outgoing.get(options.id) ?? [], this.incoming.get(options.id) ?? []];
    let examinedEdges = 0, truncated = false;
    scan: for (const list of lists) for (const edge of list) {
      if (examinedEdges >= this.budgets.examinedEdges) { truncated = true; break scan; } examinedEdges++;
      if (!seen.has(edge.id) && (!options.relationTypes || options.relationTypes.includes(edge.type))) {
        const otherId = edge.fromId === options.id ? edge.toId : edge.fromId;
        if (!visited.has(otherId) && visited.size >= this.budgets.visitedNodes) { truncated = true; break scan; }
        visited.add(otherId); seen.add(edge.id); matches.push(edge);
      }
    }
    matches.sort((a, b) => a.id.localeCompare(b.id));
    const page = boundPage(matches, edge => edge.id, options, this.releaseId, binding);
    const items = page.items.map(edge => {
      const supported = temporalPathEligible([edge.temporal], asOf);
      const blocking = supported && graphEdgeModalityEligible(edge) ? this.blockingRoleEvidence(edge, asOf, () => {
        if (examinedEdges >= this.budgets.examinedEdges) { truncated = true; return false; }
        examinedEdges++; return true;
      }) : [];
      return { edge, from: this.entities.get(edge.fromId), to: this.entities.get(edge.toId), pathEligible: supported && graphEdgeModalityEligible(edge) && blocking !== null && !blocking.length, blockingEvidence: blocking ?? [], roleEvidenceComplete: blocking !== null, qualification: blocking === null ? 'incomplete_role_evidence' : blocking.length ? 'unresolved_contradictory_or_ended_role' : supported ? 'supported_as_of' : 'historical_or_unknown_validity' };
    });
    return { administrativeView:this.administrativeView,releaseId: this.releaseId,maskIdentity:this.maskIdentity, releaseAsOf: this.releaseAsOf, asOf, temporalMode: 'as_of', identitySha256: this.identitySha256, recordsSha256: this.recordsSha256, entity: this.entities.get(options.id), ...page, items, total: truncated ? null : page.total, matchedLowerBound: matches.length, truncated, complete: !truncated, status: matches.length ? 'found' : truncated ? 'incomplete' : 'not_found', visitedNodes: visited.size, examinedEdges, budgets: this.budgets, scope, pathEligibility };
  }

  path(input: unknown) {
    const options = graphPathSchema.parse(input), asOf = options.asOf ?? this.releaseAsOf;
    if (!this.entities.has(options.fromId) || !this.entities.has(options.toId)) throw Error('Unknown graph entity; use entity_search');
    const { cursor, ...filters } = options;
    const binding = cursorBinding({ tool: 'graph_path', releaseId:this.releaseId,maskIdentity:this.maskIdentity,filters: { ...filters, asOf }, records: this.recordsSha256, identity: this.identitySha256, budgets: this.budgets });
    readCursor(cursor, this.releaseId, binding);
    const paths: Array<{ id: string; entities: GraphEntity[]; edges: GraphEdge[]; hops: number }> = [];
    const visited = new Set<string>([options.fromId]);
    type PathState = { id: string; parent: number; edge: GraphEdge | null; depth: number; lastEventDate: string | null };
    const states: PathState[] = [{ id: options.fromId, parent: -1, edge: null, depth: 0, lastEventDate: null }];
    let examinedEdges = 0, pathSteps = 0, truncated = false, shortestHops: number | null = null;
    const roleDecisions = new Map<string, GraphEdge[]>();
    // Temporal history belongs to each path state; node-only BFS can discard the only valid chronological route.
    scan: for (let current = 0; current < states.length; current++) {
      if (pathSteps >= this.budgets.pathSteps) { truncated = true; break; }
      pathSteps++;
      const state = states[current];
      if (state.id === options.toId) {
        if (shortestHops === null) shortestHops = state.depth;
        if (state.depth !== shortestHops) continue;
        if (paths.length >= this.budgets.paths) { truncated = true; break; }
        const edges: GraphEdge[] = [];
        for (let index = current; states[index].parent >= 0; index = states[index].parent) edges.push(states[index].edge!);
        edges.reverse();
        paths.push({ id: cursorBinding(edges.map(edge => edge.id)), entities: [this.entities.get(options.fromId)!, ...edges.map(edge => this.entities.get(edge.toId)!)], edges, hops: edges.length });
        continue;
      }
      if (state.depth >= options.maxHops || shortestHops !== null && state.depth >= shortestHops) continue;
      for (const edge of this.outgoing.get(state.id) ?? []) {
        if (examinedEdges >= this.budgets.examinedEdges) { truncated = true; break scan; }
        examinedEdges++;
        if (!graphEdgeModalityEligible(edge, options.mode === 'historical')) continue;
        if (options.mode !== 'historical' && !temporalPathEligible([edge.temporal], asOf)) continue;
        if (options.mode !== 'historical') {
          let blocking = roleDecisions.get(edge.id);
          if (!blocking) {
            const decision = this.blockingRoleEvidence(edge, asOf, () => {
              if (examinedEdges >= this.budgets.examinedEdges) return false;
              examinedEdges++; return true;
            });
            if (decision === null) { truncated = true; break scan; }
            blocking = decision; roleDecisions.set(edge.id, blocking);
          }
          if (blocking.length) continue;
        }
        if (options.mode === 'chronological' && edge.temporal.eventDate !== null && state.lastEventDate !== null && edge.temporal.eventDate < state.lastEventDate) continue;
        let cycle = false;
        for (let index = current; index >= 0; index = states[index].parent) if (states[index].id === edge.toId) { cycle = true; break; }
        if (cycle) continue;
        if ((!visited.has(edge.toId) && visited.size >= this.budgets.visitedNodes) || states.length >= this.budgets.pathSteps) { truncated = true; break scan; }
        visited.add(edge.toId);
        states.push({ id: edge.toId, parent: current, edge, depth: state.depth + 1, lastEventDate: edge.temporal.eventDate ?? state.lastEventDate });
      }
    }
    paths.sort((a, b) => a.id.localeCompare(b.id));
    const page = boundPage(paths, path => path.id, options, this.releaseId, binding);
    return { administrativeView:this.administrativeView,releaseId: this.releaseId,maskIdentity:this.maskIdentity, releaseAsOf: this.releaseAsOf, asOf, temporalMode: options.mode, identitySha256: this.identitySha256, recordsSha256: this.recordsSha256, ...page, total: truncated ? null : page.total, pathsLowerBound: paths.length, status: paths.length ? 'found' : truncated ? 'incomplete' : 'not_found_within_hops', shortestHops, maxHops: options.maxHops, truncated, complete: !truncated, visitedNodes: visited.size, examinedEdges, pathSteps, budgets: this.budgets, direction: 'out', pathEligibility, qualification: options.mode === 'historical' ? 'attributed_historical_claims_not_confirmed_current' : 'supported_at_explicit_temporal_reference', modalities: [...new Set(page.items.flatMap(path => path.edges.map(edge => edge.modality)))].sort()};
  }
}
