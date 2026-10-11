import { spawn } from 'node:child_process';
import { z } from 'zod';
import { workerCapacity, type WorkerCapacity } from './district-work-plan.ts';

const FRESH_MS = 90_000;
const fraction = z.number().finite().min(0).max(1);
const reportSchema = z.object({
  generatedAt: z.number().finite(),
  reports: z.array(z.object({ provider: z.literal('anthropic'), fetchedAt: z.number().finite(),
    limits: z.array(z.object({ status: z.string(), amount: z.object({ usedFraction: fraction, remainingFraction: fraction }) })).min(1),
  })).length(1),
  accountsWithoutUsage: z.array(z.unknown()).length(0),
  disabledCredentials: z.array(z.unknown()).length(0),
});
export type SafeQuota = { state: 'healthy' | 'warning' | 'unknown'; checkedAt: number; maxUsedFraction: number | null; limitCount: number };
// Never retain identifiers, labels, endpoint metadata, reset credits or raw reports.
export type QuotaSummary = SafeQuota & { requestedWorkers: number; effectiveWorkers: number; paused: boolean; policy?: 'owner-watched' };
export interface QuotaMonitor {
  capacity: () => WorkerCapacity;
  summary: () => QuotaSummary;
  dispose: () => Promise<void>;
}
// Multiple accounts cannot prove which account backs the native CLI: fail closed.
export function projectQuota(raw: unknown, now = Date.now()): SafeQuota {
  const unknown: SafeQuota = { state: 'unknown', checkedAt: now, maxUsedFraction: null, limitCount: 0 };
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) return unknown;
  const report = parsed.data.reports[0];
  if ([parsed.data.generatedAt, report.fetchedAt].some(time => time > now + 5_000 || now - time > FRESH_MS)) return unknown;
  if (report.limits.some(limit => Math.abs(limit.amount.usedFraction + limit.amount.remainingFraction - 1) > 0.02)) return unknown;
  const maxUsedFraction = Math.max(...report.limits.map(limit => limit.amount.usedFraction));
  return { state: report.limits.some(limit => limit.status !== 'ok') || maxUsedFraction >= 0.8 ? 'warning' : 'healthy', checkedAt: Math.min(parsed.data.generatedAt, report.fetchedAt), maxUsedFraction, limitCount: report.limits.length };
}
export type QuotaCommand = (args: string[], signal: AbortSignal) => Promise<{ ok: boolean; output: string }>;
const runQuotaCommand: QuotaCommand = async (args, signal) => {
  signal.throwIfAborted();
  const child = spawn('omp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const result = Promise.withResolvers<{ ok: boolean; output: string }>(), chunks: Buffer[] = [];
  let bytes = 0, failed = false;
  const stop = () => { failed = true; child.kill('SIGKILL'); };
  child.once('error', () => { failed = true; });
  child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1_048_576) stop(); else if (!failed) chunks.push(chunk); });
  child.stderr.resume();
  child.once('close', code => {
    result.resolve({ ok: !failed && code === 0, output: failed || code !== 0 ? '' : Buffer.concat(chunks).toString('utf8') });
  });
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  const timeout = setTimeout(stop, 15_000);
  try { return await result.promise; }
  finally { clearTimeout(timeout); signal.removeEventListener('abort', stop); }
};
export async function readQuotaMetadata(signal: AbortSignal, run: QuotaCommand = runQuotaCommand): Promise<unknown> {
  signal.throwIfAborted();
  // The CLI cache can outlive our freshness lease. Invalidate once per coordinated
  // poll, then require a successful live query; never fall back to cached metadata.
  const invalidated = await run(['usage', 'invalidate', '--provider', 'anthropic', '--no-extensions'], signal);
  signal.throwIfAborted();
  if (!invalidated.ok) return null;
  const report = await run(['usage', '--provider', 'anthropic', '--json', '--no-extensions'], signal);
  signal.throwIfAborted();
  if (!report.ok) return null;
  try { return JSON.parse(report.output); } catch { return null; }
}
export async function startQuotaMonitor(options: {
  requestedWorkers: number; signal: AbortSignal; pause: () => Promise<void>; ownerWatchesQuota?: boolean;
  persist: (summary: SafeQuota & { requestedWorkers: number; effectiveWorkers: number }) => Promise<void>;
  read?: (signal: AbortSignal) => Promise<unknown>; intervalMs?: number;
}): Promise<QuotaMonitor> {
  workerCapacity(options.requestedWorkers);
  if (options.ownerWatchesQuota) {
    options.signal.throwIfAborted();
    // Explicit operator policy: unavailable usage metadata is not a quota warning.
    // The scheduler still checks owner pauses and shared native failure markers.
    const snapshot: QuotaSummary = { state: 'unknown', checkedAt: Date.now(), maxUsedFraction: null, limitCount: 0, requestedWorkers: options.requestedWorkers, effectiveWorkers: options.requestedWorkers, paused: false, policy: 'owner-watched' };
    await options.persist(snapshot);
    return {
      capacity: () => ({ 'openai-subscription': 1, 'anthropic-subscription': options.signal.aborted ? 0 : options.requestedWorkers }),
      summary: () => ({ ...snapshot, paused: options.signal.aborted, effectiveWorkers: options.signal.aborted ? 0 : options.requestedWorkers }),
      dispose: async () => {},
    };
  }
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  let current: SafeQuota = { state: 'unknown', checkedAt: 0, maxUsedFraction: null, limitCount: 0 };
  let effectiveWorkers = 1, ceiling = options.requestedWorkers, paused = false, disposed = false;
  let timer: NodeJS.Timeout | undefined, pending: Promise<void> = Promise.resolve();
  let stalePause = Promise.resolve();
  const refresh = async () => {
    let raw: unknown;
    try { raw = await (options.read ?? readQuotaMetadata)(controller.signal); } catch { raw = null; }
    if (disposed || controller.signal.aborted) return;
    current = projectQuota(raw);
    // Never automatically scale back up during a run, including after an unavailable initial probe.
    if (current.state === 'warning' || (current.state === 'unknown' && effectiveWorkers > 1)) paused = true;
    if (current.state === 'unknown') ceiling = 1;
    effectiveWorkers = paused ? 0 : Math.min(ceiling, options.requestedWorkers);
    if (paused) await options.pause();
    await options.persist({ ...current, requestedWorkers: options.requestedWorkers, effectiveWorkers });
  };
  const failClosed = async () => { paused = true; effectiveWorkers = 0; await options.pause(); };
  const schedule = () => {
    if (disposed || controller.signal.aborted || paused) return;
    timer = setTimeout(() => {
      pending = refresh().catch(failClosed).catch(() => { paused = true; effectiveWorkers = 0; }).finally(schedule);
    }, options.intervalMs ?? 30_000);
  };
  try { await refresh(); schedule(); }
  catch (error) { disposed = true; controller.abort(); options.signal.removeEventListener('abort', abort); throw error; }
  return {
    capacity: () => {
      if (!paused && current.checkedAt && Date.now() - current.checkedAt > FRESH_MS) {
        paused = true; effectiveWorkers = 0; current = { ...current, state: 'unknown' };
        stalePause = options.pause().then(() => options.persist({ ...current, requestedWorkers: options.requestedWorkers, effectiveWorkers })).catch(() => {});
      }
      return { 'openai-subscription': 1, 'anthropic-subscription': effectiveWorkers };
    },
    summary: () => ({ ...current, requestedWorkers: options.requestedWorkers, effectiveWorkers, paused }),
    dispose: async () => { disposed = true; clearTimeout(timer); controller.abort(); options.signal.removeEventListener('abort', abort); await pending; await stalePause; },
  };
}
