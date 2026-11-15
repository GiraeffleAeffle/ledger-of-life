import test from 'node:test';
import assert from 'node:assert/strict';
import { TOPIC_DEMO_STAGES } from '../data/topic-flow-demo.ts';
import { moveTopicStage, topicSource } from './topic-flow-model.ts';

test('stage navigation advances once and stops at both ends', () => {
  const ids = TOPIC_DEMO_STAGES.map((stage) => stage.id);
  assert.equal(ids.length, 7);
  assert.equal(moveTopicStage(ids[0]!, -1), ids[0]);
  assert.equal(moveTopicStage(ids.at(-1)!, 1), ids.at(-1));
  for (let index = 0; index < ids.length - 1; index += 1) {
    assert.equal(moveTopicStage(ids[index]!, 1), ids[index + 1]);
    assert.equal(moveTopicStage(ids[index + 1]!, -1), ids[index]);
  }
});

test('source lookup resolves known links and safely rejects unknown IDs', () => {
  assert.equal(topicSource('minutes')?.authority, 'Niederschrift · Gemeindevertretung Tramm');
  assert(topicSource('minutes')?.url.startsWith('https://'));
});
