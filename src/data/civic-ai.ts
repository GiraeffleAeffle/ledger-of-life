/** Native public City AI is independent of paid inference and grants no municipal authority. */
export interface CivicAiSource {
  id: string; title: string; url: string; asOf: string; kind: string; reviewState: string;
}
export type CivicAiStatus = 'pending' | 'running' | 'completed' | 'failed' | 'unavailable' | 'budget_exhausted' | 'interrupted';
export interface CivicAiJob {
  id: string; topicId: string; contributionId: string | null; status: CivicAiStatus;
  answer: string | null; message: string | null; model: string | null; sources: CivicAiSource[];
  createdAt: string; completedAt: string | null; authority: 'none'; provider: 'ledger-library'; retryable: boolean;
}
export const CIVIC_AI_LIMITS = { accountPerDay: 3, topicPerDay: 3, globalPerDay: 30, outputTokens: 192 } as const;
const cityAiTag = /(?:^|[^\p{L}\p{N}_@])@(?:city-ai|Mecky)(?![\p{L}\p{N}_-])/iu;
/** A deliberate tag, not an email address or a prefix of another account name. Mecky is an alias for City AI. */
export function hasCityAiTag(text: string): boolean {
  return cityAiTag.test(text);
}

/** Text after the intentional mention is the question; appended mentions refer to the preceding text. */
export function cityAiQuestion(text: string): string {
  const mention = cityAiTag.exec(text);
  if (!mention) return text.trim();
  const after = text.slice(mention.index + mention[0].length).replace(/^[\s)\]}:;,]+/u, '').trim();
  return /[\p{L}\p{N}]/u.test(after) ? after : text.slice(0, mention.index).trim();
}
