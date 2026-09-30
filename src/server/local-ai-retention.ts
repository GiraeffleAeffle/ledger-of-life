type RetainedRequest = {
  state: 'payment_required' | 'approval_required' | 'ready' | 'running' | 'settling' | 'completed' | 'failed' | 'expired' | 'interrupted';
  expiresAt: string; prompt: string; answer: string | null; purgedAt?: string | null;
  payment: { state: string };
};

type RetainedRecord = {
  request: RetainedRequest;
  paymentJournal: unknown | null;
  completedAt?: string;
  runningAt?: number;
};

export function textGraceMs(environment: Record<string, string | undefined> = process.env): number {
  const raw = environment.LOCAL_AI_TEXT_GRACE_SECONDS;
  if (raw === undefined) return 600_000;
  const seconds = Number(raw);
  return raw.trim() && Number.isFinite(seconds) ? Math.min(86400, Math.max(0, seconds)) * 1000 : 600_000;
}

export function textDue(record: RetainedRecord, now: number, graceMs: number): boolean {
  const { request } = record;
  const terminal = request.state === 'completed' || request.state === 'failed' || request.state === 'expired' || request.state === 'interrupted';
  if (request.purgedAt || request.state === 'running' || request.state === 'settling') return false;
  // An in-flight payment keeps its text until it resolves. A terminal request can never deliver more than it already has,
  // and a failed inference leaves its payment "authorized", so that state must not keep a question forever.
  if (!terminal && (request.payment.state === 'authorized' || request.payment.state === 'pending')) return false;
  let endedAt: number;
  if (request.state === 'payment_required' || request.state === 'approval_required' || request.state === 'ready') {
    if (record.paymentJournal) return false;
    endedAt = Date.parse(request.expiresAt);
  } else if (request.state === 'completed' || request.state === 'failed' ||
      request.state === 'expired' || request.state === 'interrupted') {
    endedAt = Date.parse(record.completedAt ?? (request.state === 'interrupted' && record.runningAt != null
      ? new Date(record.runningAt).toISOString() : request.expiresAt));
  } else return false;
  return Number.isFinite(endedAt) && now >= endedAt + graceMs;
}

export function purged<T extends RetainedRecord>(record: T, now: number): T {
  return { ...record, request: { ...record.request, prompt: '', answer: null, purgedAt: new Date(now).toISOString() } };
}
