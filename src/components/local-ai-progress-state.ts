import type { ConnectorHostStatus, LocalAiRequest } from '../server/local-ai-types.ts';

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

export const isAiRequestTerminal = (request: LocalAiRequest) =>
  ['completed', 'failed', 'interrupted', 'expired'].includes(request.state);

export function aiRequestPollId(request: LocalAiRequest | null): string | null {
  return request && !request.recovery && !isAiRequestTerminal(request) && (request.state === 'running' || request.state === 'settling') ? request.id : null;
}

export function aiApprovalPollId(request: LocalAiRequest | null, approval: LocalAiRequest['approval']): string | null {
  return request && !request.recovery && !isAiRequestTerminal(request) && approval?.state === 'pending' ? request.id : null;
}

/** Persisted failure metadata remains visible even when question and answer text are purged. */
export function aiTerminalError(request: LocalAiRequest): string | null {
  if (!['failed', 'interrupted', 'expired'].includes(request.state)) return null;
  const label = request.state === 'interrupted' ? 'Request interrupted' : request.state === 'expired' ? 'Request expired' : 'Request failed';
  return `${label}. ${request.error || 'No complete answer was saved.'} This request will not run again. Start a new question deliberately if you want another attempt.`;
}

/** Current heartbeat status is not evidence of what caused an earlier request to stop. */
export function aiSelectedHostStatus(request: LocalAiRequest, hosts: ConnectorHostStatus[] | undefined, statusUnavailable = false): string | null {
  if (!request.host) return null;
  const host = statusUnavailable ? undefined : hosts?.find((candidate) => candidate.id === request.host!.id);
  if (!host || host.state !== 'active') return 'Selected host status is unavailable. This does not establish why the request stopped.';
  if (host.availability === 'offline') return 'Selected host is currently offline: no recent heartbeat. This does not establish why the request stopped.';
  if (host.availability === 'asleep') return host.canWake
    ? 'Selected host currently reports asleep: its AI service is unreachable, and it supports a wake attempt. This does not prove it will wake or complete an answer, physical sleep, or a failed wake signal.'
    : 'Selected host currently reports asleep: its AI service is unreachable and cannot be woken from here. This is not proof that the machine is physically asleep.';
  return 'Selected host currently reports online. This is not proof that the model is ready or an answer will complete.';
}

export function aiSolanaAllowanceNotice(request: Pick<LocalAiRequest, 'solanaReview' | 'approval'>): string | null {
  if (!request.solanaReview || request.approval?.state !== 'completed') return null;
  const maximum = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 6 }).format(Number(request.solanaReview.amountAtomic) / 1e6);
  return `The Solana SPL delegate approval is an allowance, not a payment receipt. Any unused allowance can remain on the token account, bounded by this answer's maximum of ${maximum} tUSDC. It is not automatically revoked when this request stops. A new question needs a deliberate new review and approval, replacing the prior allowance only after this request and any settlement are resolved.`;
}
export function deriveAiProgress(record: {
  request: LocalAiRequest; progressEvents?: AiProgressEvents; runningAt?: number; completedAt?: string;
  paymentJournal?: { signed?: unknown; hash?: string | null } | null;
}): AiProgress {
  const request = record.request;
  const events = { ...record.progressEvents };
  const failed = ['failed', 'interrupted', 'expired'].includes(request.state);
  const paid = request.payment.state === 'settled' && request.payment.receipt?.success === true;
  const stage: AiProgress['stage'] = failed ? 'failed' : paid ? 'paid'
    : request.payment.state === 'settled' ? 'confirming'
    : request.state === 'completed' ? 'complete' : request.state === 'settling' ? 'confirming'
    : request.state === 'running' ? events.pickedUpAt || !request.host ? 'answering'
      : events.hostAwakeAt || events.modelReachableAt ? 'host_awake' : 'waiting_host'
    : request.payment.state === 'authorized' ? 'authorized' : 'review';
  const money: AiProgress['money'] = request.payment.state === 'none' ? 'none'
    : paid ? 'paid'
    : request.payment.state === 'pending' || request.payment.state === 'settled' || request.state === 'settling' || (record.paymentJournal?.signed && request.payment.state !== 'failed') ? 'pending'
    : failed ? 'not_charged' : request.payment.state === 'authorized' ? 'authorized' : 'not_charged';
  return { stage, events, money, startedAt: events.authorizedAt ?? (record.runningAt ? new Date(record.runningAt).toISOString() : null),
    endedAt: events.finishedAt ?? record.completedAt ?? null,
    settlementTransaction: request.payment.receipt?.transaction || record.paymentJournal?.hash || null };
}
