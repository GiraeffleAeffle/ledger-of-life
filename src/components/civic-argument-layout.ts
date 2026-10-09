import type { CivicContribution, CivicStance } from '../data/civic.ts';

export const CIVIC_STANCE_LABEL: Record<CivicStance, string> = { discussion: 'Discussion', pro: 'Pro', con: 'Con' };
export interface CivicArgumentNode {
  contribution: CivicContribution;
  children: CivicArgumentNode[];
  depth: number;
  number: number;
  parentNumber: number | null;
  leafCount: number;
  label: string;
}
export interface CivicArgumentSegment {
  node: CivicArgumentNode;
  start: number;
  end: number;
  inner: number;
  outer: number;
  path: string;
}

/** One hierarchy for both text navigation and geometry. Invalid links never silently lose a contribution. */
export function civicArgumentTree(contributions: readonly CivicContribution[]): CivicArgumentNode[] {
  const nodes = new Map<string, CivicArgumentNode>();
  for (const contribution of contributions) {
    if (nodes.has(contribution.id)) throw new Error('Duplicate contribution identifier.');
    nodes.set(contribution.id, { contribution, children: [], depth: 0, number: 0, parentNumber: null, leafCount: 1, label: '' });
  }
  const roots: CivicArgumentNode[] = [];
  for (const node of nodes.values()) {
    if (node.contribution.parentId === null) roots.push(node);
    else {
      const parent = nodes.get(node.contribution.parentId);
      if (!parent) throw new Error('Contribution parent is missing.');
      parent.children.push(node);
    }
  }
  const ordered: CivicArgumentNode[] = [];
  const stack = [...roots].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    node.number = ordered.length + 1;
    node.label = `${node.number}. ${CIVIC_STANCE_LABEL[node.contribution.stance]}: ${node.contribution.text}`;
    ordered.push(node);
    for (let index = node.children.length - 1; index >= 0; index--) {
      const child = node.children[index];
      child.depth = node.depth + 1;
      child.parentNumber = node.number;
      stack.push(child);
    }
  }
  if (ordered.length !== nodes.size) throw new Error('Contribution hierarchy contains a cycle.');
  for (let index = ordered.length - 1; index >= 0; index--) {
    const node = ordered[index];
    if (node.children.length) node.leafCount = node.children.reduce((sum, child) => sum + child.leafCount, 0);
  }
  return roots;
}

/** Two half-arcs also represent a complete ring; a single SVG arc cannot do that. */
export function civicSectorPath(inner: number, outer: number, start: number, end: number): string {
  if (!(Number.isFinite(inner) && Number.isFinite(outer) && Number.isFinite(start) && Number.isFinite(end) && inner > 0 && outer > inner && end > start && end - start <= 2 * Math.PI + 1e-10)) throw new Error('Invalid sunburst sector.');
  const point = (radius: number, angle: number) => `${radius * Math.sin(angle)},${-radius * Math.cos(angle)}`;
  const middle = (start + end) / 2;
  return `M${point(outer, start)} A${outer},${outer} 0 0 1 ${point(outer, middle)} A${outer},${outer} 0 0 1 ${point(outer, end)} L${point(inner, end)} A${inner},${inner} 0 0 0 ${point(inner, middle)} A${inner},${inner} 0 0 0 ${point(inner, start)} Z`;
}

/** Terminal branches share angle equally. Rings encode reply depth, never votes or popularity. */
export function civicArgumentLayout(roots: readonly CivicArgumentNode[]): CivicArgumentSegment[] {
  if (!roots.length) return [];
  let deepest = 0;
  const pending = [...roots];
  while (pending.length) {
    const node = pending.pop()!;
    deepest = Math.max(deepest, node.depth);
    pending.push(...node.children);
  }
  const ring = 112 / (deepest + 1);
  const total = roots.reduce((sum, node) => sum + node.leafCount, 0);
  const segments: CivicArgumentSegment[] = [];
  const queue: { node: CivicArgumentNode; start: number; end: number }[] = [];
  let cursor = 0;
  for (const node of roots) {
    const end = cursor + 2 * Math.PI * node.leafCount / total;
    queue.push({ node, start: cursor, end });
    cursor = end;
  }
  queue.reverse();
  while (queue.length) {
    const current = queue.pop()!;
    const { node, start, end } = current;
    const inner = 30 + node.depth * ring;
    const outer = inner + ring * 0.94;
    segments.push({ ...current, inner, outer, path: civicSectorPath(inner, outer, start, end) });
    let offset = end;
    for (let index = node.children.length - 1; index >= 0; index--) {
      const child = node.children[index];
      const childStart = offset - (end - start) * child.leafCount / node.leafCount;
      queue.push({ node: child, start: childStart, end: offset });
      offset = childStart;
    }
  }
  return segments;
}

export function civicTopicUrl(location: string, topicId: string | null): string {
  const url = new URL(location);
  url.searchParams.set('area', 'places');
  url.searchParams.set('tab', 'places-say');
  if (topicId) url.searchParams.set('civicTopic', topicId);
  else url.searchParams.delete('civicTopic');
  return url.toString();
}

/** Share only public civic routing; internal navigation may retain private invitation fragments. */
export function civicShareUrl(location: string, topicId: string): string {
  const url = new URL('/', location);
  url.search = new URLSearchParams({ area: 'places', tab: 'places-say', civicTopic: topicId }).toString();
  return url.toString();
}
