import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOPIC_ARGUMENTS,
  TOPIC_DEMO_STAGES,
  TOPIC_FEEDBACK_ROUNDS,
  TOPIC_SOURCES,
  TOPIC_SOURCE_TIMELINE,
} from '../data/topic-flow-demo.ts';
import { moveTopicStage, topicEvidenceGraphIsComplete, topicSource } from './topic-flow-model.ts';

test('stage controls move one step and stop at both ends', () => {
  const ids = TOPIC_DEMO_STAGES.map((stage) => stage.id);
  assert.equal(moveTopicStage(ids[0]!, -1), ids[0]);
  assert.equal(moveTopicStage(ids[ids.length - 1]!, 1), ids[ids.length - 1]);
  for (let index = 0; index < ids.length - 1; index += 1) {
    assert.equal(moveTopicStage(ids[index]!, 1), ids[index + 1]);
    assert.equal(moveTopicStage(ids[index + 1]!, -1), ids[index]);
  }
});

test('all topic arguments, feedback, and timeline entries resolve to identified evidence', () => {
  assert.equal(topicEvidenceGraphIsComplete(), true);
  assert.equal(new Set(TOPIC_SOURCES.map((item) => item.id)).size, TOPIC_SOURCES.length);
  assert(TOPIC_SOURCES.every((item) => item.caseId.startsWith('case:') && item.evidenceSourceId.length > 0));
  for (const id of [
    ...TOPIC_ARGUMENTS.flatMap((item) => item.sourceIds),
    ...TOPIC_FEEDBACK_ROUNDS.flatMap((item) => item.sourceIds),
    ...TOPIC_SOURCE_TIMELINE.map((item) => item.sourceId),
  ]) assert(topicSource(id));
  assert.equal(topicSource('paper')?.evidenceSourceId, 'html_sessionnet:council:destatis:01053:5318:01053126');
  assert.equal(topicSource('roseburg')?.evidenceSourceId, 'html_sessionnet:council:destatis:01053:5318:01053104');
  assert.equal(topicSource('witzeeze')?.evidenceSourceId, 'html_sessionnet:council:destatis:01053:5318:01053132');
  assert.equal(topicSource('missing-source'), null);
});
test('the displayed topic tree has valid parents and the public reply rounds are paired', () => {
  const ids = new Set(TOPIC_ARGUMENTS.map((item) => item.id));
  assert.equal(ids.size, TOPIC_ARGUMENTS.length);
  for (const argument of TOPIC_ARGUMENTS) {
    assert(argument.sourceIds.length > 0);
    assert(argument.parent === null || ids.has(argument.parent));
  }
  assert.deepEqual([...new Set(TOPIC_FEEDBACK_ROUNDS.map((item) => item.round))], [1, 2]);
  for (const round of [1, 2]) {
    assert.equal(TOPIC_FEEDBACK_ROUNDS.filter((item) => item.round === round).length, 2);
  }
});
