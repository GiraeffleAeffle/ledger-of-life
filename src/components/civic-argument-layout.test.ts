import test from 'node:test';
import assert from 'node:assert/strict';
import type { CivicContribution } from '../data/civic.ts';
import { CIVIC_LIMITS } from '../data/civic.ts';
import { civicArgumentTree, civicArgumentLayout, civicSectorPath, civicTopicUrl, civicShareUrl } from './civic-argument-layout.ts';

function contribution(id: string, parentId: string | null = null, stance: CivicContribution['stance'] = 'pro'): CivicContribution {
  return { id, parentId, stance, text: `Reason ${id}`, createdAt: '2026-10-09T12:00:00.000Z' };
}
const epsilon = 1e-9;

test('empty discussion has no fabricated argument or sector', () => {
  assert.deepEqual(civicArgumentTree([]), []);
  assert.deepEqual(civicArgumentLayout([]), []);
});

test('hierarchy preserves stable input order and parent links even if replies arrive first', () => {
  const input = [contribution('reply', 'root', 'con'), contribution('root'), contribution('second', null, 'con')];
  const tree = civicArgumentTree(input);
  assert.deepEqual(tree.map((node) => node.contribution.id), ['root', 'second']);
  assert.equal(tree[0].children[0].contribution.id, 'reply');
  assert.equal(tree[0].children[0].parentNumber, 1);
  assert.equal(tree[0].children[0].depth, 1);
  assert.equal(tree[1].number, 3);
  assert.deepEqual(input.map((item) => item.id), ['reply', 'root', 'second']);
});

test('accessible labels include stance, complete text and stable navigation numbers', () => {
  const tree = civicArgumentTree([contribution('a'), contribution('b', 'a', 'con'), contribution('c', 'b')]);
  const segments = civicArgumentLayout(tree);
  assert.deepEqual(segments.map(({ node }) => node.label), ['1. Pro: Reason a', '2. Con: Reason b', '3. Pro: Reason c']);
  assert.deepEqual(segments.map(({ node }) => node.parentNumber), [null, 1, 2]);
  assert.deepEqual(segments.map(({ node }) => node.depth), [0, 1, 2]);
});

test('every argument has exactly one sector in the same preorder as the textual hierarchy', () => {
  const input = [contribution('a'), contribution('b'), contribution('a1', 'a'), contribution('a2', 'a', 'con'), contribution('a1x', 'a1')];
  const segments = civicArgumentLayout(civicArgumentTree(input));
  assert.deepEqual(segments.map(({ node }) => node.contribution.id), ['a', 'a1', 'a1x', 'a2', 'b']);
  assert.equal(new Set(segments.map(({ node }) => node.contribution.id)).size, input.length);
});

test('structural angular weights count terminal branches, not stance or text length', () => {
  const inputs = [contribution('a'), contribution('a1', 'a'), contribution('a2', 'a'), contribution('b', null, 'con')];
  const original = civicArgumentLayout(civicArgumentTree(inputs));
  const changed = civicArgumentLayout(civicArgumentTree(inputs.map((item) => ({ ...item, stance: 'con', text: 'Much longer text '.repeat(30) }))));
  assert.equal(original[0].node.leafCount, 2);
  assert.ok(Math.abs(original[0].end - 4 * Math.PI / 3) < epsilon);
  assert.deepEqual(original.map(({ start, end, inner, outer }) => [start, end, inner, outer]), changed.map(({ start, end, inner, outer }) => [start, end, inner, outer]));
});

test('all rings remain inside the fixed viewbox at maximum supported reply depth', () => {
  const input = Array.from({ length: CIVIC_LIMITS.depth }, (_, index) => contribution(String(index), index ? String(index - 1) : null));
  const segments = civicArgumentLayout(civicArgumentTree(input));
  assert.equal(segments.length, CIVIC_LIMITS.depth);
  for (const segment of segments) {
    assert.ok(segment.inner >= 30);
    assert.ok(segment.outer > segment.inner);
    assert.ok(segment.outer < 150);
    assert.ok(segment.start >= -epsilon);
    assert.ok(segment.end <= 2 * Math.PI + epsilon);
    assert.ok(segment.end > segment.start);
    assert.doesNotMatch(segment.path, /NaN|Infinity/);
  }
  for (let index = 1; index < segments.length; index++) assert.ok(segments[index].inner > segments[index - 1].outer);
});

test('child sectors stay within parent span and siblings partition without overlaps', () => {
  const input = [contribution('a'), contribution('b'), contribution('a1', 'a'), contribution('a2', 'a'), contribution('a3', 'a'), contribution('a2x', 'a2'), contribution('a2y', 'a2')];
  const segments = civicArgumentLayout(civicArgumentTree(input));
  const byId = new Map(segments.map((segment) => [segment.node.contribution.id, segment]));
  for (const parent of segments) {
    const children = parent.node.children.map((node) => byId.get(node.contribution.id)!);
    if (!children.length) continue;
    assert.ok(Math.abs(children[0].start - parent.start) < epsilon);
    assert.ok(Math.abs(children[children.length - 1].end - parent.end) < epsilon);
    children.forEach((child, index) => {
      assert.ok(child.start >= parent.start - epsilon && child.end <= parent.end + epsilon);
      assert.ok(child.inner > parent.outer);
      if (index) assert.ok(Math.abs(children[index - 1].end - child.start) < epsilon);
    });
  }
});

test('maximum contribution breadth is fully visible without clipping or omitted paths', () => {
  const input = Array.from({ length: CIVIC_LIMITS.contributions }, (_, index) => contribution(`argument-${index}`));
  const segments = civicArgumentLayout(civicArgumentTree(input));
  assert.equal(segments.length, CIVIC_LIMITS.contributions);
  assert.ok(Math.abs(segments[0].start) < epsilon);
  assert.ok(Math.abs(segments[segments.length - 1].end - 2 * Math.PI) < epsilon);
  for (let index = 1; index < segments.length; index++) assert.ok(Math.abs(segments[index].start - segments[index - 1].end) < epsilon);
});

test('a single argument is a complete annulus with four half-arcs, not an empty full-circle arc', () => {
  const [segment] = civicArgumentLayout(civicArgumentTree([contribution('only')]));
  assert.equal(segment.start, 0);
  assert.equal(segment.end, 2 * Math.PI);
  assert.equal((segment.path.match(/ A/g) ?? []).length, 4);
  assert.ok(segment.path.endsWith(' Z'));
});

test('malformed relationships fail explicitly rather than inventing roots or losing nodes', () => {
  assert.throws(() => civicArgumentTree([contribution('a'), contribution('a')]), /Duplicate/);
  assert.throws(() => civicArgumentTree([contribution('a', 'missing')]), /missing/);
  assert.throws(() => civicArgumentTree([contribution('a', 'a')]), /cycle/);
  assert.throws(() => civicArgumentTree([contribution('root'), contribution('a', 'b'), contribution('b', 'a')]), /cycle/);
});

test('sector geometry rejects non-finite, reversed and invalid radius inputs', () => {
  for (const values of [[0, 20, 0, 1], [20, 10, 0, 1], [10, 20, 1, 0], [10, 20, 0, 7], [10, 20, 0, Number.NaN], [10, Number.POSITIVE_INFINITY, 0, 1], [Number.NaN, 20, 0, 1]]) {
    assert.throws(() => civicSectorPath(values[0], values[1], values[2], values[3]), /Invalid/);
  }
});

test('internal civic navigation activates Places while retaining local query data and invitation hash', () => {
  const result = new URL(civicTopicUrl('https://ledger.example/app?area=home&tab=home-rent&filter=nearby&civicCity=strausberg#original-section', 'topic / & ?'));
  assert.equal(result.searchParams.get('area'), 'places');
  assert.equal(result.searchParams.get('tab'), 'places-say');
  assert.equal(result.searchParams.get('civicTopic'), 'topic / & ?');
  assert.equal(result.searchParams.get('filter'), 'nearby');
  assert.equal(result.searchParams.get('civicCity'), 'strausberg');
  assert.equal(result.hash, '#original-section');
  const back = new URL(civicTopicUrl(result.href, null));
  assert.equal(back.searchParams.has('civicTopic'), false);
  assert.equal(back.searchParams.get('filter'), 'nearby');
  assert.equal(back.hash, '#original-section');
});

test('shared civic URLs exclude tenancy invitation fragments and unrelated private query data', () => {
  const shared = new URL(civicShareUrl('https://ledger.example/?area=home&privateDraft=secret#invitation=private-token', 'public-topic'));
  assert.equal(shared.pathname, '/');
  assert.equal(shared.hash, '');
  assert.deepEqual([...shared.searchParams.keys()], ['area', 'tab', 'civicTopic']);
  assert.equal(shared.searchParams.get('civicTopic'), 'public-topic');
  assert.doesNotMatch(shared.href, /private|invitation|secret/);
});
