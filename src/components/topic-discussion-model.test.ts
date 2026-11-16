import test from 'node:test';
import assert from 'node:assert/strict';
import { TOPIC_ARGUMENTS, DISCUSSION_SIDES, DISCUSSION_THEMES } from '../data/topic-discussion.ts';
import { argumentWeight, discussionLayout, focusedArguments, moveSegmentIndex, sectorPath, segmentHighlighted } from './topic-discussion-model.ts';

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9);

test('three rings partition a full circle with additive structural weights', () => {
  const segments = discussionLayout();
  assert.equal(segments.filter((segment) => segment.kind === 'side').length, 3);
  assert.equal(segments.filter((segment) => segment.kind === 'theme').length, 6);
  assert.equal(segments.filter((segment) => segment.kind === 'argument').length, 18);
  for (const kind of ['side', 'theme', 'argument']) {
    const ring = segments.filter((segment) => segment.kind === kind);
    close(ring[0]!.start, -Math.PI / 2);
    close(ring.at(-1)!.end, 3 * Math.PI / 2);
    for (let index = 1; index < ring.length; index++) close(ring[index - 1]!.end, ring[index]!.start);
    for (const segment of ring) {
      assert.ok(segment.end > segment.start);
      assert.ok(segment.outer > segment.inner);
      assert.ok(!sectorPath(segment).includes('NaN'));
    }
  }
  for (const side of segments.filter((segment) => segment.kind === 'side')) {
    assert.equal(side.weight, segments.filter((segment) => segment.kind === 'argument' && segment.side === side.id).reduce((sum, segment) => sum + segment.weight, 0));
  }
  for (const argument of TOPIC_ARGUMENTS) {
    assert.equal(argumentWeight(argument), 1 + argument.sourceIds.length + TOPIC_ARGUMENTS.filter((child) => child.parentId === argument.id).length);
    const segment = segments.find((entry) => entry.id === argument.id)!;
    const theme = segments.find((entry) => entry.id === argument.themeId)!;
    assert.ok(segment.start >= theme.start - 1e-9 && segment.end <= theme.end + 1e-9);
  }
  assert.deepEqual(discussionLayout([]), []);
});

test('side and theme focus filter the tree and highlight matching chart ancestry', () => {
  const segments = discussionLayout();
  for (const side of DISCUSSION_SIDES) {
    const focus = { kind: 'side' as const, id: side.id };
    assert.deepEqual(focusedArguments(focus), TOPIC_ARGUMENTS.filter((argument) => argument.side === side.id));
    for (const segment of segments) assert.equal(segmentHighlighted(segment, focus), segment.side === side.id);
  }
  for (const theme of DISCUSSION_THEMES) {
    const focus = { kind: 'theme' as const, id: theme.id };
    assert.deepEqual(focusedArguments(focus), TOPIC_ARGUMENTS.filter((argument) => argument.themeId === theme.id));
    assert.equal(segmentHighlighted(segments.find((segment) => segment.id === theme.side)!, focus), true);
    assert.equal(segmentHighlighted(segments.find((segment) => segment.id === theme.id)!, focus), true);
  }
});

test('argument focus retains ancestors and selected descendants without siblings', () => {
  const root = TOPIC_ARGUMENTS.find((argument) => !argument.parentId)!;
  const children = TOPIC_ARGUMENTS.filter((argument) => argument.parentId === root.id);
  assert.ok(children.length > 1);
  assert.deepEqual(focusedArguments({ kind: 'argument', id: root.id }).map((argument) => argument.id), [root.id, ...children.map((argument) => argument.id)]);
  const selected = children[0]!;
  const focus = { kind: 'argument' as const, id: selected.id };
  assert.deepEqual(focusedArguments(focus).map((argument) => argument.id), [root.id, selected.id]);
  const segments = discussionLayout();
  assert.equal(segmentHighlighted(segments.find((segment) => segment.id === selected.id)!, focus), true);
  assert.equal(segmentHighlighted(segments.find((segment) => segment.id === children[1]!.id)!, focus), false);
  assert.equal(segmentHighlighted(segments.find((segment) => segment.id === selected.themeId)!, focus), true);
});

test('reset and unknown initial argument preserve the complete tree', () => {
  assert.deepEqual(focusedArguments(null), TOPIC_ARGUMENTS);
  assert.deepEqual(focusedArguments({ kind: 'argument', id: 'missing' }), TOPIC_ARGUMENTS);
  assert.ok(discussionLayout().every((segment) => segmentHighlighted(segment, null)));
});

test('keyboard navigation wraps, supports endpoints and ignores activation keys', () => {
  assert.equal(moveSegmentIndex(0, 'ArrowLeft', 27), 26);
  assert.equal(moveSegmentIndex(26, 'ArrowRight', 27), 0);
  assert.equal(moveSegmentIndex(0, 'ArrowUp', 27), 26);
  assert.equal(moveSegmentIndex(26, 'ArrowDown', 27), 0);
  assert.equal(moveSegmentIndex(8, 'Home', 27), 0);
  assert.equal(moveSegmentIndex(8, 'End', 27), 26);
  assert.equal(moveSegmentIndex(8, 'Enter', 27), 8);
  assert.equal(moveSegmentIndex(0, 'ArrowRight', 0), 0);
});
