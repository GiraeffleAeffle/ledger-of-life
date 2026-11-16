import { DISCUSSION_SIDES, DISCUSSION_THEMES, TOPIC_ARGUMENTS, type TopicArgument } from '../data/topic-discussion.ts';

export type DiscussionFocus = { kind: 'side' | 'theme' | 'argument'; id: string } | null;
export interface DiscussionSegment {
  id: string;
  kind: 'side' | 'theme' | 'argument';
  side: string;
  themeId?: string;
  label: string;
  weight: number;
  start: number;
  end: number;
  inner: number;
  outer: number;
}
export function argumentWeight(argument: TopicArgument, arguments_: readonly TopicArgument[] = TOPIC_ARGUMENTS): number {
  return 1 + arguments_.filter((child) => child.parentId === argument.id).length + argument.sourceIds.length;
}

/** Three rings share the same weighted partition; area represents structure, never votes. */
export function discussionLayout(arguments_: readonly TopicArgument[] = TOPIC_ARGUMENTS): DiscussionSegment[] {
  const weights = new Map(arguments_.map((argument) => [argument.id, argumentWeight(argument, arguments_)]));
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  if (!total) return [];
  const segments: DiscussionSegment[] = [];
  let angle = -Math.PI / 2;
  for (const side of DISCUSSION_SIDES) {
    const sideArguments = arguments_.filter((argument) => argument.side === side.id);
    const weight = sideArguments.reduce((sum, argument) => sum + weights.get(argument.id)!, 0);
    if (!weight) continue;
    const start = angle;
    const end = start + weight / total * Math.PI * 2;
    segments.push({ id: side.id, kind: 'side', side: side.id, label: side.label, weight, start, end, inner: 48, outer: 84 });
    for (const theme of DISCUSSION_THEMES.filter((entry) => entry.side === side.id)) {
      const members = sideArguments.filter((argument) => argument.themeId === theme.id);
      const themeWeight = members.reduce((sum, argument) => sum + weights.get(argument.id)!, 0);
      if (!themeWeight) continue;
      const themeStart = angle;
      const themeEnd = angle + themeWeight / total * Math.PI * 2;
      segments.push({ id: theme.id, kind: 'theme', side: side.id, themeId: theme.id, label: theme.label, weight: themeWeight, start: themeStart, end: themeEnd, inner: 87, outer: 123 });
      for (const argument of members) {
        const argumentEnd = angle + weights.get(argument.id)! / total * Math.PI * 2;
        segments.push({ id: argument.id, kind: 'argument', side: side.id, themeId: theme.id, label: argument.title, weight: weights.get(argument.id)!, start: angle, end: argumentEnd, inner: 126, outer: 176 });
        angle = argumentEnd;
      }
    }
    angle = end;
  }
  return segments;
}

export function focusedArguments(focus: DiscussionFocus, arguments_: readonly TopicArgument[] = TOPIC_ARGUMENTS): TopicArgument[] {
  if (!focus) return [...arguments_];
  if (focus.kind === 'side') return arguments_.filter((argument) => argument.side === focus.id);
  if (focus.kind === 'theme') return arguments_.filter((argument) => argument.themeId === focus.id);
  const selected = arguments_.find((argument) => argument.id === focus.id);
  if (!selected) return [...arguments_];
  const ids = new Set([selected.id]);
  let parentId = selected.parentId;
  while (parentId && !ids.has(parentId)) {
    ids.add(parentId);
    parentId = arguments_.find((argument) => argument.id === parentId)?.parentId;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const argument of arguments_) {
      if (argument.parentId && ids.has(argument.parentId) && !ids.has(argument.id)) {
        // Keep the selected branch, not siblings of its ancestors.
        let ancestor = argument.parentId;
        const visited = new Set<string>();
        while (ancestor && !visited.has(ancestor)) {
          if (ancestor === selected.id) { ids.add(argument.id); changed = true; break; }
          visited.add(ancestor);
          ancestor = arguments_.find((entry) => entry.id === ancestor)?.parentId ?? '';
        }
      }
    }
  }
  return arguments_.filter((argument) => ids.has(argument.id));
}

export function segmentHighlighted(segment: DiscussionSegment, focus: DiscussionFocus, arguments_: readonly TopicArgument[] = TOPIC_ARGUMENTS): boolean {
  if (!focus) return true;
  if (focus.kind === 'side') return segment.side === focus.id;
  if (focus.kind === 'theme') return segment.themeId === focus.id || (segment.kind === 'side' && DISCUSSION_THEMES.some((theme) => theme.id === focus.id && theme.side === segment.id));
  const selected = arguments_.find((argument) => argument.id === focus.id);
  return segment.kind === 'argument' ? focusedArguments(focus, arguments_).some((argument) => argument.id === segment.id) : segment.kind === 'side' ? segment.id === selected?.side : segment.id === selected?.themeId;
}

export function sectorPath(segment: DiscussionSegment): string {
  const { inner, outer, start, end } = segment;
  const point = (radius: number, angle: number) => `${200 + radius * Math.cos(angle)},${200 + radius * Math.sin(angle)}`;
  const middle = (start + end) / 2;
  return `M${point(outer, start)} A${outer},${outer} 0 0 1 ${point(outer, middle)} A${outer},${outer} 0 0 1 ${point(outer, end)} L${point(inner, end)} A${inner},${inner} 0 0 0 ${point(inner, middle)} A${inner},${inner} 0 0 0 ${point(inner, start)} Z`;
}

export function moveSegmentIndex(index: number, key: string, length: number): number {
  if (!length) return 0;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % length;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + length) % length;
  return index;
}
