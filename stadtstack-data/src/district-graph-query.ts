import { z } from 'zod';
import { entityTypeSchema, relationTypeSchema, relationPathEligible } from './district-graph-claims.ts';
import { validateKnowledgeGraph, type GraphEntity, type GraphEdge } from './district-graph.ts';
import { boundPage, cursorBinding, readCursor } from './mcp-pagination.ts';

const pageShape = { limit: z.number().int().min(1).max(50).default(20), cursor: z.string().min(1).max(2048).optional() };
const entityId = z.string().regex(/^entity:[a-f0-9]{64}$/);
export const entitySearchSchema = z.object({ query: z.string().trim().min(1).max(200), type: entityTypeSchema.optional(), ...pageShape }).strict();
export const graphNeighborsSchema = z.object({ id: entityId, relationTypes: z.array(relationTypeSchema).min(1).max(10).optional(), direction: z.enum(['in', 'out', 'both']).default('both'), ...pageShape }).strict();
export const graphPathSchema = z.object({ fromId: entityId, toId: entityId, maxHops: z.number().int().min(1).max(5), ...pageShape }).strict();
export const GRAPH_QUERY_BUDGETS = Object.freeze({ searchNodes: 10000, visitedNodes: 2000, examinedEdges: 10000, paths: 100, pathSteps: 20000 });
export type GraphQueryBudgets = { [K in keyof typeof GRAPH_QUERY_BUDGETS]: number };
const scope = 'Only explicit source-grounded relations in admitted records. Name-only identities are municipality-scoped; ambiguous object labels remain source-scoped. Canonical type follows documented precedence; entity_search type matches canonical or original mention types. Original names, types and all source references remain in mention evidence. Identity grouping is not independent legal-entity verification. Missing evidence is not absence of activity; paths establish neither causality nor success.';
const pathEligibility = { eligibleModalities: ['asserted', 'decided', 'implemented'] as const, rules: { asserted: 'Non-action factual relations only.', decided: 'decides and approves only; not construction or spending.', implemented: 'implements only; only the execution explicitly quoted, not inferred completion or success.' }, excludedModalities: ['planned', 'proposed', 'conditional', 'negated', 'historical'] as const, note: 'plans never participates. Every eligible edge must also be admitted with quoted typed roles and original deterministic and model gates.' };

export class GraphIndex {
  readonly recordsSha256: string;
  readonly releaseId: string;
  private readonly entities: Map<string, GraphEntity>;
  private readonly orderedEntities: GraphEntity[];
  private readonly outgoing = new Map<string, GraphEdge[]>();
  private readonly incoming = new Map<string, GraphEdge[]>();
  private readonly budgets: GraphQueryBudgets;

  constructor(releaseId: string, graph: unknown, recordsBytes: string | Uint8Array, budgets: Partial<GraphQueryBudgets> = {}) {
    const bound = validateKnowledgeGraph(graph, recordsBytes);
    this.releaseId = releaseId;
    this.recordsSha256 = bound.recordsSha256;
    this.budgets = { ...GRAPH_QUERY_BUDGETS, ...budgets };
    for (const name of Object.keys(GRAPH_QUERY_BUDGETS) as (keyof GraphQueryBudgets)[]) {
      if (!Number.isInteger(this.budgets[name]) || this.budgets[name] < 1 || this.budgets[name] > GRAPH_QUERY_BUDGETS[name]) throw Error('Invalid graph search budget');
    }
    this.orderedEntities = bound.entities;
    this.entities = new Map(bound.entities.map(entity => [entity.id, entity]));
    for (const edge of bound.edges) {
      const outgoing = this.outgoing.get(edge.fromId) ?? [];
      outgoing.push(edge); this.outgoing.set(edge.fromId, outgoing);
      const incoming = this.incoming.get(edge.toId) ?? [];
      incoming.push(edge); this.incoming.set(edge.toId, incoming);
    }
  }

  entitySearch(input: unknown) {
    const options = entitySearchSchema.parse(input);
    const { cursor, ...filters } = options;
    const binding = cursorBinding({ tool: 'entity_search', filters, records: this.recordsSha256, budgets: this.budgets });
    readCursor(cursor, this.releaseId, binding);
    const query = options.query.normalize('NFC').toLocaleLowerCase('de');
    const matches: GraphEntity[] = [];
    let examinedNodes = 0;
    for (const entity of this.orderedEntities) {
      if (examinedNodes >= this.budgets.searchNodes) break;
      examinedNodes++;
      if ((!options.type || options.type === entity.type || entity.mentions.some(mention => mention.type === options.type)) && (entity.names.some(name => name.normalize('NFC').toLocaleLowerCase('de').includes(query)) || entity.mentions.some(mention => mention.identifiers.some(identifier => identifier.value.toLocaleLowerCase('de').includes(query))))) matches.push(entity);
    }
    const truncated = examinedNodes < this.orderedEntities.length;
    const page = boundPage(matches, entity => entity.id, options, this.releaseId, binding);
    return { releaseId: this.releaseId, recordsSha256: this.recordsSha256, ...page, total: truncated ? null : page.total, matchedLowerBound: matches.length, truncated, complete: !truncated, status: matches.length ? 'found' : truncated ? 'incomplete' : 'not_found', examinedNodes, budgets: this.budgets, scope };
  }

  neighbors(input: unknown) {
    const options = graphNeighborsSchema.parse(input);
    if (!this.entities.has(options.id)) throw Error('Unknown graph entity; use entity_search');
    const { cursor, ...filters } = options;
    const binding = cursorBinding({ tool: 'graph_neighbors', filters: { ...filters, relationTypes: options.relationTypes ? [...new Set(options.relationTypes)].sort() : undefined }, records: this.recordsSha256, budgets: this.budgets });
    readCursor(cursor, this.releaseId, binding);
    const matches: GraphEdge[] = [];
    const seen = new Set<string>();
    const visited = new Set<string>([options.id]);
    const lists = options.direction === 'out' ? [this.outgoing.get(options.id) ?? []] : options.direction === 'in' ? [this.incoming.get(options.id) ?? []] : [this.outgoing.get(options.id) ?? [], this.incoming.get(options.id) ?? []];
    let examinedEdges = 0, truncated = false;
    scan: for (const list of lists) for (const edge of list) {
      if (examinedEdges >= this.budgets.examinedEdges) { truncated = true; break scan; }
      examinedEdges++;
      if (!seen.has(edge.id) && (!options.relationTypes || options.relationTypes.includes(edge.type))) {
        const otherId = edge.fromId === options.id ? edge.toId : edge.fromId;
        if (!visited.has(otherId) && visited.size >= this.budgets.visitedNodes) { truncated = true; break scan; }
        visited.add(otherId); seen.add(edge.id); matches.push(edge);
      }
    }
    matches.sort((a, b) => a.id.localeCompare(b.id));
    const page = boundPage(matches, edge => edge.id, options, this.releaseId, binding);
    return { releaseId: this.releaseId, recordsSha256: this.recordsSha256, entity: this.entities.get(options.id), ...page, items: page.items.map(edge => ({ edge, from: this.entities.get(edge.fromId), to: this.entities.get(edge.toId), pathEligible: relationPathEligible(edge) })), total: truncated ? null : page.total, matchedLowerBound: matches.length, truncated, complete: !truncated, status: matches.length ? 'found' : truncated ? 'incomplete' : 'not_found', visitedNodes: visited.size, examinedEdges, budgets: this.budgets, scope, pathEligibility, modalityNote: 'All evidence retains its explicit modality. Plans, proposals, conditions, negation and history never participate in confirmed paths; decisions and approvals are not implementation.' };
  }

  path(input: unknown) {
    const options = graphPathSchema.parse(input);
    if (!this.entities.has(options.fromId) || !this.entities.has(options.toId)) throw Error('Unknown graph entity; use entity_search');
    const { cursor, ...filters } = options;
    const binding = cursorBinding({ tool: 'graph_path', filters, records: this.recordsSha256, budgets: this.budgets });
    readCursor(cursor, this.releaseId, binding);
    const distance = new Map<string, number>([[options.fromId, 0]]);
    const predecessors = new Map<string, GraphEdge[]>();
    const queue = [options.fromId];
    let examinedEdges = 0, truncated = false, shortestHops: number | null = options.fromId === options.toId ? 0 : null;
    bfs: for (let cursor = 0; cursor < queue.length; cursor++) {
      const id = queue[cursor], depth = distance.get(id)!;
      if (depth >= options.maxHops || shortestHops !== null && depth >= shortestHops) continue;
      for (const edge of this.outgoing.get(id) ?? []) {
        if (examinedEdges >= this.budgets.examinedEdges) { truncated = true; break bfs; }
        examinedEdges++;
        if (!relationPathEligible(edge)) continue;
        let nextDepth = distance.get(edge.toId);
        if (nextDepth === undefined) {
          if (distance.size >= this.budgets.visitedNodes) { truncated = true; break bfs; }
          nextDepth = depth + 1;
          distance.set(edge.toId, nextDepth); queue.push(edge.toId);
        }
        if (nextDepth === depth + 1) {
          const incoming = predecessors.get(edge.toId) ?? [];
          incoming.push(edge); predecessors.set(edge.toId, incoming);
          if (edge.toId === options.toId) shortestHops = nextDepth;
        }
      }
    }
    const paths: Array<{ id: string; entities: GraphEntity[]; edges: GraphEdge[]; hops: number }> = [];
    let pathSteps = 0, enumerationStopped = false;
    const enumerate = (id: string, reverse: GraphEdge[]): void => {
      if (enumerationStopped) return;
      if (pathSteps >= this.budgets.pathSteps) { enumerationStopped = true; return; }
      pathSteps++;
      if (id === options.fromId) {
        if (paths.length >= this.budgets.paths) { enumerationStopped = true; return; }
        const edges = [...reverse].reverse();
        paths.push({ id: cursorBinding(edges.map(edge => edge.id)), entities: [this.entities.get(options.fromId)!, ...edges.map(edge => this.entities.get(edge.toId)!)], edges, hops: edges.length });
        return;
      }
      for (const edge of predecessors.get(id) ?? []) {
        enumerate(edge.fromId, [...reverse, edge]);
        if (enumerationStopped) break;
      }
    };
    if (shortestHops !== null) enumerate(options.toId, []);
    truncated ||= enumerationStopped;
    const page = boundPage(paths, path => path.id, options, this.releaseId, binding);
    return { releaseId: this.releaseId, recordsSha256: this.recordsSha256, ...page, total: truncated ? null : page.total, pathsLowerBound: paths.length, status: paths.length ? 'found' : truncated ? 'incomplete' : 'not_found_within_hops', shortestHops, maxHops: options.maxHops, truncated, complete: !truncated, visitedNodes: distance.size, examinedEdges, pathSteps, budgets: this.budgets, direction: 'out', pathEligibility, modalities: [...new Set(page.items.flatMap(path => path.edges.map(edge => edge.modality)))].sort(), scope, searchNote: 'Directed shortest paths only, bounded by maxHops and explicit budgets. Pagination covers enumerated results; truncated searches are incomplete even when nextCursor is null. Eligible modalities remain explicit: factual assertion, decision/approval and implementation are distinct source claims, not independently confirmed operation, completion, spending or success.' };
  }
}
