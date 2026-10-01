import type { Store } from './store.ts';

/** The hourly job runs once an hour; three hours without a run means the scheduler or the job itself is down. */
export const PRICE_JOB_OVERDUE_SECONDS = 3 * 3600;
const KEY = 'tsla-price-job:last';
/** Skips that mean "nothing newer to copy right now": the mirror already holds the newest acceptable round. */
const WAITING_REASONS = new Set(['same_or_older_round', 'push_interval', 'nonincreasing_source_time']);

export type PriceJobOutcome = {
  status: string; reason?: string; sourceRoundId?: string; sourceUpdatedAt?: number; transactionHash?: string;
};
export type PriceJobRecord = {
  /** Unix seconds when the job last ran. */
  at: number; status: 'pushed' | 'skipped' | 'unconfigured' | 'failed'; reason: string | null;
  sourceRoundId: string | null; sourceUpdatedAt: number | null; transactionHash: string | null;
  /** Unix seconds when a round was last copied to the testnet mirror, by any run. */
  lastPush: { at: number; sourceRoundId: string; sourceUpdatedAt: number | null; transactionHash: string | null } | null;
};
/** `ok`: the last run copied a round. `waiting`: nothing newer to copy. `attention`: a person should look. */
export type PriceJobHealth = 'ok' | 'waiting' | 'attention';
export type PriceJobStatus = {
  health: PriceJobHealth; message: string; lastRun: Omit<PriceJobRecord, 'lastPush'> | null; lastPush: PriceJobRecord['lastPush'];
  lastRunAgeSeconds: number | null; overdue: boolean;
};

export async function recordPriceJob(store: Store, outcome: PriceJobOutcome, at: number): Promise<PriceJobRecord> {
  const status = ['pushed', 'skipped', 'unconfigured', 'failed'].includes(outcome.status) ? outcome.status as PriceJobRecord['status'] : 'failed';
  const run = (previous: PriceJobRecord | null): PriceJobRecord => ({
    at, status, reason: outcome.reason ?? null, sourceRoundId: outcome.sourceRoundId ?? null,
    sourceUpdatedAt: outcome.sourceUpdatedAt ?? null, transactionHash: outcome.transactionHash ?? null,
    lastPush: status === 'pushed' && outcome.sourceRoundId
      ? { at, sourceRoundId: outcome.sourceRoundId, sourceUpdatedAt: outcome.sourceUpdatedAt ?? null, transactionHash: outcome.transactionHash ?? null }
      : previous?.lastPush ?? null,
  });
  if (!await store.get(KEY)) {
    try { await store.create(KEY, run(null)); return (await store.get<PriceJobRecord>(KEY))!; } catch { /* a concurrent first write won; update below */ }
  }
  return store.update<PriceJobRecord>(KEY, run);
}
export const readPriceJob = (store: Store) => store.get<PriceJobRecord>(KEY);

/** Turns the stored last run into what a status page or loan panel can show without hiding a failure. */
export function shapePriceJob(record: PriceJobRecord | null, now: number): PriceJobStatus {
  if (!record) return { health: 'attention', message: 'The price job has not reported a run yet.', lastRun: null, lastPush: null, lastRunAgeSeconds: null, overdue: true };
  const { lastPush, ...lastRun } = record;
  const lastRunAgeSeconds = Math.max(0, now - record.at);
  const overdue = lastRunAgeSeconds > PRICE_JOB_OVERDUE_SECONDS;
  let health: PriceJobHealth; let message: string;
  if (record.status === 'pushed') { health = 'ok'; message = 'The last run copied a new mainnet round.'; }
  else if (record.status === 'skipped' && record.reason && WAITING_REASONS.has(record.reason)) { health = 'waiting'; message = `The last run copied nothing: ${record.reason.replaceAll('_', ' ')}.`; }
  else if (record.status === 'skipped') { health = 'attention'; message = `The last run was skipped: ${(record.reason ?? 'unknown reason').replaceAll('_', ' ')}. The mirrored price is not being refreshed.`; }
  else if (record.status === 'unconfigured') { health = 'attention'; message = `The price job is not configured: ${record.reason ?? 'unknown reason'}`; }
  else { health = 'attention'; message = `The last run failed: ${record.reason ?? 'unknown error'}.`; }
  if (overdue) { health = 'attention'; message = `No run in over ${PRICE_JOB_OVERDUE_SECONDS / 3600} hours. ${message}`; }
  return { health, message, lastRun, lastPush, lastRunAgeSeconds, overdue };
}
