import {
  TOPIC_DEMO_STAGES,
  TOPIC_FEEDBACK_ROUNDS,
  TOPIC_SOURCES,
  TOPIC_SOURCE_TIMELINE,
  TOPIC_ARGUMENTS,
  type TopicStageId,
} from '../data/topic-flow-demo.ts';

export function moveTopicStage(stage: TopicStageId, delta: -1 | 1): TopicStageId {
  const index = TOPIC_DEMO_STAGES.findIndex((item) => item.id === stage);
  return TOPIC_DEMO_STAGES[Math.max(0, Math.min(TOPIC_DEMO_STAGES.length - 1, index + delta))]?.id ?? 'feed';
}

export function topicSource(id: string) {
  return TOPIC_SOURCES.find((item) => item.id === id) ?? null;
}

export function topicEvidenceGraphIsComplete(): boolean {
  const sourceIds = new Set<string>(TOPIC_SOURCES.map((item) => item.id));
  const citedIds = [
    ...TOPIC_ARGUMENTS.flatMap((item) => item.sourceIds),
    ...TOPIC_FEEDBACK_ROUNDS.flatMap((item) => item.sourceIds),
    ...TOPIC_SOURCE_TIMELINE.map((item) => item.sourceId),
  ];
  const stageIds = new Set(TOPIC_DEMO_STAGES.map((item) => item.id));
  return TOPIC_DEMO_STAGES.length === 7
    && stageIds.size === TOPIC_DEMO_STAGES.length
    && TOPIC_SOURCES.every((item) => item.caseId.length > 0 && item.evidenceSourceId.length > 0)
    && citedIds.every((id) => sourceIds.has(id));
}
