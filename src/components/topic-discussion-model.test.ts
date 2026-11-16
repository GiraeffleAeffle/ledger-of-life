import test from 'node:test';
import assert from 'node:assert/strict';
import { TOPIC_ARGUMENTS, type TopicArgument } from '../data/topic-discussion.ts';
import { discussionKeyAction, discussionLayout, discussionTree, focusedArguments, replyLabel, sectorPath, type DiscussionNode } from './topic-discussion-model.ts';

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9);
function flatten(nodes: DiscussionNode[]): DiscussionNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

test('18 invented voices form one mixed-stance reply tree without categorical wrappers', () => {
  const roots = discussionTree();
  const nodes = flatten(roots);
  assert.equal(nodes.length, 18);
  assert.equal(new Set(nodes.map((node) => node.argument.id)).size, 18);
  assert.deepEqual(roots.map((node) => node.argument.id), TOPIC_ARGUMENTS.filter((argument) => !argument.parentId).map((argument) => argument.id));
  for (const node of nodes) {
    for (const child of node.children) {
      assert.equal(child.argument.parentId, node.argument.id);
      assert.equal(child.depth, node.depth + 1);
    }
    assert.equal(node.weight, 1 + node.argument.sourceIds.length + node.children.reduce((sum, child) => sum + child.weight, 0));
    assert.equal(node.replyCount, node.children.reduce((sum, child) => sum + 1 + child.replyCount, 0));
  }
  for (const depth of [0, 1, 2]) {
    assert.deepEqual(new Set(nodes.filter((node) => node.depth === depth).map((node) => node.argument.side)), new Set(['support', 'weigh', 'concern']));
  }
  const challenge = nodes.find((node) => node.argument.id === 'conditions-budget')!;
  assert.equal(challenge.argument.parentId, 'future-power');
  assert.equal(challenge.argument.side, 'concern');
  assert.equal(challenge.children.find((node) => node.argument.id === 'future-family')!.argument.side, 'support');
});

test('each actual reply occupies its next ring inside its parent with additive subtree widths', () => {
  const segments = discussionLayout();
  const nodes = flatten(discussionTree());
  assert.equal(segments.length, TOPIC_ARGUMENTS.length);
  const roots = segments.filter((segment) => segment.depth === 0);
  const total = roots.reduce((sum, segment) => sum + segment.weight, 0);
  close(roots[0]!.start, -Math.PI / 2);
  close(roots.at(-1)!.end, 3 * Math.PI / 2);
  for (let index = 1; index < roots.length; index++) close(roots[index - 1]!.end, roots[index]!.start);
  for (const segment of segments) {
    const node = nodes.find((entry) => entry.argument.id === segment.id)!;
    assert.equal(segment.depth, node.depth);
    assert.equal(segment.weight, node.weight);
    assert.equal(segment.side, node.argument.side);
    assert.ok(segment.end > segment.start);
    assert.ok(segment.outer > segment.inner);
    assert.ok(!sectorPath(segment).includes('NaN'));
    close(segment.end - segment.start, Math.PI * 2 * segment.weight / total);
    if (segment.parentId) {
      const parent = segments.find((entry) => entry.id === segment.parentId)!;
      assert.equal(segment.depth, parent.depth + 1);
      assert.ok(segment.inner > parent.outer);
      assert.ok(segment.start >= parent.start - 1e-9 && segment.end <= parent.end + 1e-9);
    }
  }
  assert.deepEqual(discussionTree([]), []);
  assert.deepEqual(discussionLayout([]), []);
});

test('unanswered leaves do not generate segments or fill empty outer space', () => {
  const segments = discussionLayout();
  const leaf = segments.find((segment) => segment.id === 'soil-nature')!;
  assert.equal(leaf.depth, 1);
  assert.equal(leaf.replyCount, 0);
  assert.ok(segments.some((segment) => segment.depth === 2));
  assert.equal(segments.some((segment) => segment.depth > leaf.depth && segment.start < leaf.end - 1e-9 && segment.end > leaf.start + 1e-9), false);
  assert.equal(segments.some((segment) => segment.parentId === leaf.id), false);
  assert.equal(replyLabel(0), 'Keine Antwort');
  assert.equal(replyLabel(1), '1 Antwort');
  assert.equal(replyLabel(5), '5 Antworten');
});

test('arbitrary reply depths get further rings rather than a fixed third-ring category', () => {
  const chain: TopicArgument[] = Array.from({ length: 5 }, (_, index) => ({
    id: `reply-${index}`, ...(index ? { parentId: `reply-${index - 1}` } : {}),
    side: index % 2 ? 'concern' : 'support', voice: 'Beispiel', role: 'Erfunden',
    title: `Antwort ${index}`, summary: 'Ein erfundener Beitrag.', text: 'Ein erfundener Beitrag.', sourceIds: [],
  }));
  const segments = discussionLayout(chain);
  assert.deepEqual(segments.map((segment) => segment.depth), [0, 1, 2, 3, 4]);
  for (let index = 1; index < segments.length; index++) assert.ok(segments[index]!.inner > segments[index - 1]!.outer);
  assert.ok(segments.at(-1)!.outer <= 184);
  assert.deepEqual(focusedArguments('reply-3', chain).map((argument) => argument.id), chain.map((argument) => argument.id));
});

test('selecting a challenge retains mixed-stance ancestors and replies but excludes sibling branches', () => {
  assert.deepEqual(focusedArguments('conditions-budget').map((argument) => argument.id), ['future-power', 'conditions-budget', 'future-family', 'alternatives-grid']);
  assert.deepEqual(focusedArguments('future-family').map((argument) => argument.id), ['future-power', 'conditions-budget', 'future-family']);
  assert.deepEqual(focusedArguments('village-renter').map((argument) => argument.id), ['village-coop', 'village-renter', 'village-club']);
  assert.deepEqual(focusedArguments('soil-nature').map((argument) => argument.id), ['soil-farmer', 'soil-nature']);
  assert.deepEqual(focusedArguments(null), TOPIC_ARGUMENTS);
  assert.deepEqual(focusedArguments('missing'), TOPIC_ARGUMENTS);
  for (const id of ['conditions-mayor', 'village-coop', 'alternatives-roofs', 'alternatives-farm', 'soil-farmer', 'everyday-trust']) assert.ok(TOPIC_ARGUMENTS.some((argument) => argument.id === id));
});

test('keyboard moves around a ring, follows ancestry, selects with Enter and resets with Escape', () => {
  const segments = discussionLayout();
  const indexOf = (id: string) => segments.findIndex((segment) => segment.id === id);
  const first = indexOf('future-power');
  const challenge = indexOf('conditions-budget');
  const answer = indexOf('future-family');
  const lastRoot = indexOf('everyday-neighbor');
  assert.deepEqual(discussionKeyAction(first, 'ArrowDown', segments), { type: 'move', index: challenge });
  assert.deepEqual(discussionKeyAction(challenge, 'ArrowUp', segments), { type: 'move', index: first });
  assert.deepEqual(discussionKeyAction(challenge, 'ArrowDown', segments), { type: 'move', index: answer });
  assert.deepEqual(discussionKeyAction(first, 'ArrowUp', segments), { type: 'move', index: first });
  assert.deepEqual(discussionKeyAction(answer, 'ArrowDown', segments), { type: 'move', index: answer });
  assert.deepEqual(discussionKeyAction(first, 'ArrowLeft', segments), { type: 'move', index: lastRoot });
  assert.deepEqual(discussionKeyAction(lastRoot, 'ArrowRight', segments), { type: 'move', index: first });
  assert.deepEqual(discussionKeyAction(challenge, 'ArrowRight', segments), { type: 'move', index: indexOf('conditions-mayor') });
  assert.deepEqual(discussionKeyAction(challenge, 'Enter', segments), { type: 'select', id: 'conditions-budget' });
  assert.deepEqual(discussionKeyAction(challenge, ' ', segments), { type: 'select', id: 'conditions-budget' });
  assert.deepEqual(discussionKeyAction(challenge, 'Escape', segments), { type: 'reset' });
  assert.deepEqual(discussionKeyAction(challenge, 'Home', segments), { type: 'move', index: 0 });
  assert.deepEqual(discussionKeyAction(challenge, 'End', segments), { type: 'move', index: segments.length - 1 });
  assert.equal(discussionKeyAction(challenge, 'Tab', segments), null);
  assert.equal(discussionKeyAction(0, 'ArrowRight', []), null);
});
