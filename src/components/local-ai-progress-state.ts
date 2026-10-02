import type { LocalAiRequest } from '../server/local-ai-types.ts';

/** Metadata only: no prompt, answer, signature, or connector protocol changes. */
export type AiProgressEvents = {
  authorizedAt?: string; queuedAt?: string; hostAwakeAt?: string; modelReachableAt?: string;
  pickedUpAt?: string; answerReceivedAt?: string; finishedAt?: string;
};
export type AiProgress = {
  stage: 'review' | 'authorized' | 'waiting_host' | 'host_awake' | 'answering' | 'confirming' | 'paid' | 'complete' | 'failed';
  startedAt: string | null; endedAt: string | null; events: AiProgressEvents;
  money: 'none' | 'authorized' | 'pending' | 'paid' | 'not_charged';
  settlementTransaction: string | null;
};
export type ProgressRequest = LocalAiRequest & { progress?: AiProgress };
export function deriveAiProgress(record: {
  request: LocalAiRequest; progressEvents?: AiProgressEvents; runningAt?: number; completedAt?: string;
  paymentJournal?: { signed?: unknown; hash?: string | null } | null;
}): AiProgress {
  const request = record.request;
  const events = { ...record.progressEvents };
  const failed = ['failed', 'interrupted', 'expired'].includes(request.state);
  const stage: AiProgress['stage'] = failed ? 'failed' : request.payment.state === 'settled' ? 'paid'
    : request.state === 'completed' ? 'complete' : request.state === 'settling' ? 'confirming'
    : request.state === 'running' ? events.pickedUpAt || !request.host ? 'answering'
      : events.hostAwakeAt || events.modelReachableAt ? 'host_awake' : 'waiting_host'
    : request.payment.state === 'authorized' ? 'authorized' : 'review';
  const money: AiProgress['money'] = request.payment.state === 'none' ? 'none'
    : request.payment.state === 'settled' ? 'paid'
    : request.state === 'settling' || (record.paymentJournal?.signed && request.payment.state !== 'failed') ? 'pending'
    : failed ? 'not_charged' : request.payment.state === 'authorized' ? 'authorized' : 'not_charged';
  return { stage, events, money, startedAt: events.authorizedAt ?? (record.runningAt ? new Date(record.runningAt).toISOString() : null),
    endedAt: events.finishedAt ?? record.completedAt ?? null,
    settlementTransaction: request.payment.receipt?.transaction || record.paymentJournal?.hash || null };
}
