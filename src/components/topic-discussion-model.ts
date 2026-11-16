import { TOPIC_ARGUMENTS, type DiscussionSide, type TopicArgument } from '../data/topic-discussion.ts';

export interface DiscussionNode {
  argument: TopicArgument;
  children: DiscussionNode[];
  depth: number;
  weight: number;
  replyCount: number;
}
export interface DiscussionSegment {
  id: string;
  parentId?: string;
  side: DiscussionSide;
  label: string;
  depth: number;
  weight: number;
  replyCount: number;
  start: number;
  end: number;
  inner: number;
  outer: number;
}

/** One parent relation drives both views; weight counts contributions and context, never approval. */
export function discussionTree(arguments_: readonly TopicArgument[] = TOPIC_ARGUMENTS): DiscussionNode[] {
  const nodes = new Map(arguments_.map((argument) => [argument.id, { argument, children: [], depth: 0, weight: 0, replyCount: 0 } as DiscussionNode]));
  const roots: DiscussionNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.argument.parentId ? nodes.get(node.argument.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  function measure(node: DiscussionNode, depth: number) {
    node.depth = depth;
    node.weight = 1 + node.argument.sourceIds.length;
    for (const child of node.children) {
      measure(child, depth + 1);
      node.weight += child.weight;
      node.replyCount += 1 + child.replyCount;
    }
  }
  for (const root of roots) measure(root, 0);
  return roots;
}

/** Each actual reply moves out one ring. No synthetic category or repeated leaf fills a gap. */
export function discussionLayout(arguments_: readonly TopicArgument[] = TOPIC_ARGUMENTS): DiscussionSegment[] {
  const roots = discussionTree(arguments_);
  const total = roots.reduce((sum, node) => sum + node.weight, 0);
  if (!total) return [];
  const maxDepth = (nodes: DiscussionNode[]): number => Math.max(...nodes.map((node) => node.children.length ? maxDepth(node.children) : node.depth));
  const step = 136 / (maxDepth(roots) + 1);
  const segments: DiscussionSegment[] = [];
  function partition(node: DiscussionNode, start: number, end: number) {
    const { argument, depth, weight, replyCount } = node;
    const inner = 48 + depth * step;
    segments.push({ id: argument.id, parentId: argument.parentId, side: argument.side, label: argument.title, depth, weight, replyCount, start, end, inner, outer: inner + step - 3 });
    let angle = start;
    for (const child of node.children) {
      const childEnd = angle + (end - start) * child.weight / weight;
      partition(child, angle, childEnd);
      angle = childEnd;
    }
  }
  let angle = -Math.PI / 2;
  for (const root of roots) {
    const end = angle + Math.PI * 2 * root.weight / total;
    partition(root, angle, end);
    angle = end;
  }
  return segments;
}

/** Keep only the selected subtree and its ancestor path, including mixed-stance replies. */
export function focusedArguments(focusId: string | null, arguments_: readonly TopicArgument[] = TOPIC_ARGUMENTS): TopicArgument[] {
  const byId = new Map(arguments_.map((argument) => [argument.id, argument]));
  if (!focusId || !byId.has(focusId)) return [...arguments_];
  const ids = new Set<string>();
  function descend(id: string) {
    ids.add(id);
    for (const argument of arguments_) if (argument.parentId === id) descend(argument.id);
  }
  descend(focusId);
  let parentId = byId.get(focusId)?.parentId;
  while (parentId) {
    ids.add(parentId);
    parentId = byId.get(parentId)?.parentId;
  }
  return arguments_.filter((argument) => ids.has(argument.id));
}

export function replyLabel(count: number): string {
  return count === 0 ? 'Keine Antwort' : `${count} ${count === 1 ? 'Antwort' : 'Antworten'}`;
}

export function sectorPath(segment: DiscussionSegment): string {
  const { inner, outer, start, end } = segment;
  const point = (radius: number, angle: number) => `${200 + radius * Math.cos(angle)},${200 + radius * Math.sin(angle)}`;
  const middle = (start + end) / 2;
  return `M${point(outer, start)} A${outer},${outer} 0 0 1 ${point(outer, middle)} A${outer},${outer} 0 0 1 ${point(outer, end)} L${point(inner, end)} A${inner},${inner} 0 0 0 ${point(inner, middle)} A${inner},${inner} 0 0 0 ${point(inner, start)} Z`;
}

type DiscussionKeyAction = { type: 'move'; index: number } | { type: 'select'; id: string } | { type: 'reset' };

/** Left/right traverse a ring; up/down follow the same parent/child links as the tree. */
export function discussionKeyAction(index: number, key: string, segments: readonly DiscussionSegment[]): DiscussionKeyAction | null {
  const current = segments[index];
  if (!current) return null;
  if (key === 'Enter' || key === ' ') return { type: 'select', id: current.id };
  if (key === 'Escape') return { type: 'reset' };
  let next = index;
  if (key === 'Home') next = 0;
  else if (key === 'End') next = segments.length - 1;
  else if (key === 'ArrowUp') {
    const parent = segments.findIndex((segment) => segment.id === current.parentId);
    if (parent >= 0) next = parent;
  } else if (key === 'ArrowDown') {
    const child = segments.findIndex((segment) => segment.parentId === current.id);
    if (child >= 0) next = child;
  } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const ring = segments.map((segment, position) => ({ segment, position })).filter(({ segment }) => segment.depth === current.depth);
    const position = ring.findIndex((entry) => entry.position === index);
    next = ring[(position + (key === 'ArrowRight' ? 1 : -1) + ring.length) % ring.length]!.position;
  } else return null;
  return { type: 'move', index: next };
}
