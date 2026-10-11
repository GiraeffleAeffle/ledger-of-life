import { constants } from 'node:fs';
import { open, readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SubscriptionRuntimeError, type CallPurpose, type ExtractorProvider, type ReportedUsage, type TokenCounts, type RuntimeFailureDiagnostic, type UsageContext } from './district-model-contract.ts';
import { RuntimeFailureDiagnosticSchema } from './district-model-diagnostics.ts';
export const COST_MEANING = 'CLI API-price estimate, not actual subscription billing or quota fraction';
const CountsSchema = z.object({ inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(), cacheReadTokens: z.number().int().nonnegative().optional(), cacheCreationTokens: z.number().int().nonnegative().optional() }).strict();
const ModelCountsSchema = CountsSchema.extend({ cliEstimatedApiCostUsd: z.number().nonnegative().finite().optional() });
export const UsageEntrySchema = z.object({
  version: z.literal(1), callId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/), provider: z.literal('anthropic-subscription'),
  purpose: z.enum(['extraction', 'judge', 'agreement', 'synthetic_readiness']), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
  requestedModel: z.literal('claude-haiku-5-5'), reportedModels: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/)), toolVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-.a-zA-Z0-9]*)$/),
  status: z.enum(['success', 'failed', 'paused']), errorClass: z.enum(['subscription_authentication', 'model_identity_mismatch', 'model_identity_missing', 'rate_limit', 'generation_error', 'invalid_structured_output', 'tool_attempt', 'operator_pause', 'process_failure']).nullable(),
  topLevel: CountsSchema.nullable(), perModel: z.record(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/), ModelCountsSchema), cliEstimatedApiCostUsd: z.number().nonnegative().finite().nullable(), costMeaning: z.literal(COST_MEANING),
}).strict();
export type UsageEntry = z.infer<typeof UsageEntrySchema>;
export async function appendUsageEntry(path: string, entry: UsageEntry): Promise<void> {
  const safe = UsageEntrySchema.parse(entry);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try { await file.chmod(0o600); await file.writeFile(JSON.stringify(safe) + '\n'); await file.sync(); } finally { await file.close(); }
}
// Kept separate from token accounting: diagnostics never imply reported usage or a billable call.
export function failureDiagnosticPath(ledgerPath: string): string { return `${ledgerPath}.failures.jsonl`; }
export async function appendFailureDiagnostic(path: string, diagnostic: RuntimeFailureDiagnostic): Promise<void> {
  const safe = RuntimeFailureDiagnosticSchema.parse(diagnostic);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try { await file.chmod(0o600); await file.writeFile(JSON.stringify(safe) + '\n'); await file.sync(); } finally { await file.close(); }
}
export async function rejectRuntimeFailure(context: Pick<UsageContext, 'ledgerPath' | 'pausePath'>, diagnostic: RuntimeFailureDiagnostic, failedUsage?: UsageEntry): Promise<never> {
  try { diagnostic = RuntimeFailureDiagnosticSchema.parse(diagnostic); }
  catch { throw new SubscriptionRuntimeError('process_failure', 'Private failure diagnostic invalid', { reason: 'process' }); }
  // Attempt every private write even if a sibling write fails. No filesystem error/path escapes.
  const writes = await Promise.allSettled([
    context.pausePath ? pauseProvider(context.pausePath, diagnostic.provider) : Promise.reject(),
    context.ledgerPath ? appendFailureDiagnostic(failureDiagnosticPath(context.ledgerPath), diagnostic) : Promise.reject(),
    ...(failedUsage ? [appendUsageEntry(context.ledgerPath, failedUsage)] : []),
  ]);
  const persistenceFailed = writes.some(result => result.status === 'rejected');
  throw new SubscriptionRuntimeError(diagnostic.failureCategory,
    `Subscription provider stopped (${diagnostic.provider}; ${diagnostic.reason}); pending work must not be rerouted${persistenceFailed ? '; private failure persistence unavailable' : ''}`,
    { reason: diagnostic.reason, diagnostic });
}
export async function readUsageLedger(path: string): Promise<UsageEntry[]> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw Error('Private usage ledger unavailable'); }
  return text.split('\n').filter(Boolean).map(line => UsageEntrySchema.parse(JSON.parse(line)));
}
export async function recordExercisedReadinessProbe(path: string): Promise<void> {
  const callId = 'exercised-haiku-readiness-20261010T232306848Z';
  if ((await readUsageLedger(path)).some(entry => entry.callId === callId)) return;
  // Existing successful native probe, not another model request. Only aggregate counts were retained.
  await appendUsageEntry(path, { version: 1, callId, provider: 'anthropic-subscription', purpose: 'synthetic_readiness', startedAt: '2026-10-10T23:23:06.848Z', finishedAt: '2026-10-10T23:23:09.464Z', requestedModel: 'claude-haiku-5-5', reportedModels: ['claude-haiku-5-5'], toolVersion: '2.1.284', status: 'success', errorClass: null, topLevel: { inputTokens: 2, outputTokens: 52, cacheReadTokens: 0, cacheCreationTokens: 923 }, perModel: {}, cliEstimatedApiCostUsd: 0.008432, costMeaning: COST_MEANING });
}
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const;
type CountSummary = { sumsOfReported: TokenCounts; reportingCalls: Record<keyof TokenCounts, number>; cliEstimatedApiCostUsd: number | null; costReportingCalls: number };
function emptyCounts(): CountSummary { return { sumsOfReported: {}, reportingCalls: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, cliEstimatedApiCostUsd: null, costReportingCalls: 0 }; }
function addCounts(target: CountSummary, counts: TokenCounts | null, cost: number | null | undefined) {
  for (const key of TOKEN_FIELDS) if (counts?.[key] !== undefined) { target.sumsOfReported[key] = (target.sumsOfReported[key] ?? 0) + counts[key]; target.reportingCalls[key]++; }
  if (cost !== null && cost !== undefined) { target.cliEstimatedApiCostUsd = (target.cliEstimatedApiCostUsd ?? 0) + cost; target.costReportingCalls++; }
}
export function hourlyUsage(entries: UsageEntry[]) {
  const hours = new Map<string, { hourUtc: string; calls: number; purposes: Partial<Record<CallPurpose, number>>; statuses: Partial<Record<UsageEntry['status'], number>>; requestedModels: Record<string, number>; reportedModels: Record<string, number>; topLevel: CountSummary; perModel: Record<string, CountSummary>; costMeaning: string; actualSubscriptionCharge: null; subscriptionQuotaRemaining: null }>();
  const seen = new Set<string>();
  for (const raw of entries) {
    const entry = UsageEntrySchema.parse(raw);
    if (seen.has(entry.callId)) throw Error('Usage ledger duplicate call ID');
    seen.add(entry.callId);
    const key = entry.startedAt.slice(0, 13) + ':00:00.000Z';
    let hour = hours.get(key);
    if (!hour) { hour = { hourUtc: key, calls: 0, purposes: {}, statuses: {}, requestedModels: {}, reportedModels: {}, topLevel: emptyCounts(), perModel: {}, costMeaning: COST_MEANING, actualSubscriptionCharge: null, subscriptionQuotaRemaining: null }; hours.set(key, hour); }
    hour.calls++;
    hour.purposes[entry.purpose] = (hour.purposes[entry.purpose] ?? 0) + 1;
    hour.statuses[entry.status] = (hour.statuses[entry.status] ?? 0) + 1;
    hour.requestedModels[entry.requestedModel] = (hour.requestedModels[entry.requestedModel] ?? 0) + 1;
    for (const model of entry.reportedModels) hour.reportedModels[model] = (hour.reportedModels[model] ?? 0) + 1;
    addCounts(hour.topLevel, entry.topLevel, entry.cliEstimatedApiCostUsd);
    for (const [model, counts] of Object.entries(entry.perModel)) { hour.perModel[model] ??= emptyCounts(); addCounts(hour.perModel[model], counts, counts.cliEstimatedApiCostUsd); }
  }
  return [...hours.values()].sort((a, b) => a.hourUtc.localeCompare(b.hourUtc));
}
const PauseSchema = z.object({ version: z.literal(1), 'openai-subscription': z.boolean(), 'anthropic-subscription': z.boolean() }).strict();
export async function providerIsPaused(path: string, provider: ExtractorProvider): Promise<boolean> {
  try { return PauseSchema.parse(JSON.parse(await readFile(path, 'utf8')))[provider]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw Error('Operator pause state invalid; refusing inference'); }
}
// Each provider has its own marker, avoiding lost updates when both providers fail concurrently.
export function providerPausePath(path: string, provider: ExtractorProvider): string { return `${path}.${provider}.pause`; }
export async function isProviderStopped(path: string, provider: ExtractorProvider): Promise<boolean> {
  if (await providerIsPaused(path, provider)) return true;
  try { await readFile(providerPausePath(path, provider)); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw Error('Provider pause marker unavailable; refusing inference'); }
}
export async function pauseProvider(path: string, provider: ExtractorProvider): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(providerPausePath(path, provider), 'paused\n', { mode: 0o600 });
}
// Explicit operator action after resolving the cause; it does not override the global operator pause file.
export async function clearProviderFailurePause(path: string, provider: ExtractorProvider): Promise<void> {
  await rm(providerPausePath(path, provider), { force: true });
}
export async function writeOperatorPause(path: string, states: Record<ExtractorProvider, boolean>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(PauseSchema.parse({ version: 1, ...states })) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}
export function usageEntry(context: { purpose: CallPurpose }, callId: string, startedAt: string, toolVersion: string, usage: ReportedUsage, reportedModels: string[], status: UsageEntry['status'], errorClass: UsageEntry['errorClass']): UsageEntry {
  return { version: 1, callId, provider: 'anthropic-subscription', purpose: context.purpose, startedAt, finishedAt: new Date().toISOString(), requestedModel: 'claude-haiku-5-5', reportedModels, toolVersion, status, errorClass, ...usage, costMeaning: COST_MEANING };
}
