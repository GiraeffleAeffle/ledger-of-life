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
/** A deliberate tag, not an email address or a prefix of another account name. Mecky is an alias for City AI. */
export function hasCityAiTag(text: string): boolean {
  return /(?:^|[^\p{L}\p{N}_@])@(?:city-ai|Mecky)(?![\p{L}\p{N}_-])/iu.test(text);
}
