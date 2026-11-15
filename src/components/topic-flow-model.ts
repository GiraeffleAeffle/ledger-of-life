import {
  TOPIC_DEMO_STAGES,
  TOPIC_SOURCES,
  type TopicStageId,
} from '../data/topic-flow-demo.ts';

export function moveTopicStage(stage: TopicStageId, delta: -1 | 1): TopicStageId {
  const index = TOPIC_DEMO_STAGES.findIndex((item) => item.id === stage);
  return TOPIC_DEMO_STAGES[Math.max(0, Math.min(TOPIC_DEMO_STAGES.length - 1, index + delta))]?.id ?? 'feed';
}

export function topicSource(id: string) {
  return TOPIC_SOURCES.find((item) => item.id === id) ?? null;
}

 
