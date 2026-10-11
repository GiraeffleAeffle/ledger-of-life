import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PROVIDER_CONFIGS, type ExtractorProvider } from './district-model-contract.ts';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Provider = z.enum(['openai-subscription', 'anthropic-subscription']);
const Municipalities = z.enum(['strausberg', 'hoppegarten', 'ruedersdorf-bei-berlin', 'ratzeburg', 'moelln', 'schwarzenbek', 'ludwigslust', 'parchim', 'hagenow']);
const GroupSchema = z.object({ municipalityId: Municipalities, sourceSha256: Hash, preparedSha256: Hash }).strict();
export type WorkGroup = z.infer<typeof GroupSchema>;
export const AssignmentModeSchema = z.enum(['balanced', 'codex-only']);
export type AssignmentMode = z.infer<typeof AssignmentModeSchema>;
export interface ExtractionWorkContract { promptSha256: string; schemaSha256: string; extractorSha256: string }
export const FailureCategorySchema = z.enum(['authentication', 'tool', 'transport', 'integrity', 'quota', 'model', 'operator_pause', 'interrupted', 'provider_failed']);
export const WorkFailureSchema = z.object({ failureCategory: FailureCategorySchema, errorMessageSha256: Hash }).strict();
export type WorkFailure = z.infer<typeof WorkFailureSchema>;
export function classifyWorkFailure(error: unknown): WorkFailure {
  if (error instanceof RemoteWorkFailure) return error.failure;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Non-error provider failure';
  const supplied = error instanceof Error && 'failureCategory' in error ? String(error.failureCategory) : '';
  const aliases: Record<string, WorkFailure['failureCategory']> = { subscription_authentication: 'authentication', tool_attempt: 'tool', rate_limit: 'quota', process_failure: 'transport', generation_error: 'model', invalid_structured_output: 'model', model_identity_mismatch: 'integrity', model_identity_missing: 'integrity' };
  const explicit = FailureCategorySchema.safeParse(supplied);
  const failureCategory = explicit.success ? explicit.data : (Object.hasOwn(aliases, supplied) ? aliases[supplied] : undefined) ??
    (/authentication|login|oauth/iu.test(message) ? 'authentication' :
      /tool.attempt|tool.use|forbidden.tool/iu.test(message) ? 'tool' :
      /hash|integrity|mismatch|binding|identity|schema|ZodError/iu.test(message) || error instanceof z.ZodError ? 'integrity' :
      /ssh|transport|worker|lease|timed.out|timeout|ECONN|EPIPE/iu.test(message) ? 'transport' :
      /quota|rate.limit|429/iu.test(message) ? 'quota' :
      /paused|abort/iu.test(message) ? 'operator_pause' : 'provider_failed');
  return { failureCategory, errorMessageSha256: createHash('sha256').update(message).digest('hex') };
}
// A remote worker sends only this validated category/digest, never its raw error.
export class RemoteWorkFailure extends Error {
  readonly failure: WorkFailure;
  constructor(failure: unknown) { super('Remote provider execution failed'); this.failure = WorkFailureSchema.parse(failure); }
}
const TaskSchema = z.object({ id: Hash, groupId: Hash, group: GroupSchema, provider: Provider, purpose: z.enum(['production', 'agreement']), state: z.enum(['pending', 'running', 'completed', 'failed']), attempts: z.number().int().nonnegative(), resultSha256: Hash.nullable(), failure: z.enum(['provider_failed', 'interrupted']).nullable(), failureCategory: FailureCategorySchema.nullable().default(null), errorMessageSha256: Hash.nullable().default(null) }).strict();
export type WorkTask = z.infer<typeof TaskSchema>;
export const WorkPlanSchema = z.object({ version: z.literal('district-dual-plan-v2'), assignmentMode: AssignmentModeSchema, id: Hash, promptSha256: Hash, schemaSha256: Hash, extractorSha256: Hash, tasks: z.array(TaskSchema), providers: z.object({ 'openai-subscription': z.enum(['ready', 'paused']), 'anthropic-subscription': z.enum(['ready', 'paused']) }).strict() }).strict();
export type WorkPlan = z.infer<typeof WorkPlanSchema>;
const PROVIDERS: ExtractorProvider[] = ['openai-subscription', 'anthropic-subscription'];
export function createWorkPlan(groups: unknown[], contract: ExtractionWorkContract, assignmentMode: AssignmentMode = 'balanced'): WorkPlan {
  Hash.parse(contract.promptSha256); Hash.parse(contract.schemaSha256); Hash.parse(contract.extractorSha256); AssignmentModeSchema.parse(assignmentMode);
  const unique = new Map<string, WorkGroup>();
  for (const raw of groups) {
    const group = GroupSchema.parse(raw);
    const key = hash([group.municipalityId, group.sourceSha256]);
    const previous = unique.get(key);
    if (previous && previous.preparedSha256 !== group.preparedSha256) throw Error('Document group has conflicting prepared inputs');
    unique.set(key, group);
  }
  const ordered = [...unique].sort(([a], [b]) => a.localeCompare(b));
  const sampled = new Set(assignmentMode === 'balanced' ? [...unique.keys()].filter(groupId=>Number.parseInt(hash(['agreement-v1',groupId]).slice(0,8),16)%20===0) : []);
  const tasks: WorkTask[] = [];
  for (const [groupId, group] of ordered) {
    const providerIndex=assignmentMode==='codex-only'?0:Number.parseInt(groupId.slice(0,8),16)%2,provider=PROVIDERS[providerIndex];
    for (const purpose of sampled.has(groupId) ? ['production', 'agreement'] as const : ['production'] as const) {
      const assigned = purpose === 'production' ? provider : PROVIDERS[(providerIndex + 1) % 2];
      tasks.push({ id: hash([groupId, group.preparedSha256, assigned, purpose, contract.promptSha256, contract.schemaSha256]), groupId, group, provider: assigned, purpose, state: 'pending', attempts: 0, resultSha256: null, failure: null, failureCategory: null, errorMessageSha256: null });
    }
  }
  return { version: 'district-dual-plan-v2', assignmentMode, id: hash([ordered, contract.promptSha256, contract.schemaSha256, contract.extractorSha256, PROVIDER_CONFIGS, assignmentMode]), promptSha256: contract.promptSha256, schemaSha256: contract.schemaSha256, extractorSha256: contract.extractorSha256, tasks, providers: { 'openai-subscription': 'ready', 'anthropic-subscription': 'ready' } };
}
export function restoreWorkPlan(raw: unknown): WorkPlan {
  const plan = WorkPlanSchema.parse(raw);
  const expected = createWorkPlan(plan.tasks.filter(task => task.purpose === 'production').map(task => task.group), plan, plan.assignmentMode);
  if (plan.id !== expected.id || plan.tasks.length !== expected.tasks.length) throw Error('Work plan identity mismatch');
  for (const [index, task] of plan.tasks.entries()) {
    const original = expected.tasks[index];
    if (task.id !== original.id || task.provider !== original.provider || task.purpose !== original.purpose || task.groupId !== original.groupId || JSON.stringify(task.group) !== JSON.stringify(original.group)) throw Error('Work plan assignment/input mismatch');
    if (task.state === 'completed' ? !task.resultSha256 || task.failure !== null : task.resultSha256 !== null) throw Error('Work plan result/state mismatch');
    if (task.state === 'running') { task.state = 'failed'; task.failure = 'interrupted'; task.failureCategory = 'interrupted'; task.errorMessageSha256 = null; plan.providers[task.provider] = 'paused'; }
    if (task.state === 'failed') plan.providers[task.provider] = 'paused';
  }
  return plan;
}
export function resumeWorkPlan(plan: WorkPlan, provider: ExtractorProvider): void {
  if (plan.tasks.some(task => task.provider === provider && task.state === 'running')) throw Error('Cannot resume an active provider');
  for (const task of plan.tasks) if (task.provider === provider && task.state === 'failed') { task.state = 'pending'; task.failure = null; task.failureCategory = null; task.errorMessageSha256 = null; }
  plan.providers[provider] = 'ready';
}
export type WorkResult = { resultSha256: string; preparedSha256: string; promptSha256: string; schemaSha256: string };
// The callback runs the whole source group (including same-provider judging). It must use the pinned prepared input.
// Agreement results have separate IDs and purpose; the caller must never publish them as duplicate facts.
export type WorkerCapacity = Record<ExtractorProvider, number>;
export function workerCapacity(anthropicWorkers = 1): WorkerCapacity {
  if (!Number.isInteger(anthropicWorkers) || anthropicWorkers < 1 || anthropicWorkers > 4) throw Error('Anthropic workers must be an integer from 1 to 4');
  return { 'openai-subscription': 1, 'anthropic-subscription': anthropicWorkers };
}
export function resumeWorkPlanProviders(plan: WorkPlan, providers: ExtractorProvider[]): void {
  const requested = [...new Set(providers.map(provider => Provider.parse(provider)))];
  if (plan.tasks.some(task => requested.includes(task.provider) && task.state === 'running')) throw Error('Cannot resume an active provider');
  for (const provider of requested) resumeWorkPlan(plan, provider);
}
export async function runWorkPlan(
  plan: WorkPlan,
  execute: (task: Readonly<WorkTask>, contract: Readonly<{ promptSha256: string; schemaSha256: string }>, signal: AbortSignal) => Promise<WorkResult>,
  persist: (snapshot: WorkPlan) => Promise<void>,
  shouldPause: (provider: ExtractorProvider) => Promise<boolean>,
  options: { anthropicWorkers?: number; capacity?: () => WorkerCapacity; signal?: AbortSignal; onCapacity?: (active: WorkerCapacity) => void } = {},
): Promise<void> {
  if (plan.tasks.some(task => task.state === 'running')) throw Error('Plan already running or requires interruption recovery');
  const maximum = workerCapacity(options.anthropicWorkers);
  const controllers = Object.fromEntries(PROVIDERS.map(provider => [provider, new AbortController()])) as Record<ExtractorProvider, AbortController>;
  const active: WorkerCapacity = { 'openai-subscription': 0, 'anthropic-subscription': 0 };
  const groups = new Set<string>(), running = new Set<Promise<void>>();
  let writes = Promise.resolve(), controlFailed = false;
  const abortAll = () => { for (const provider of PROVIDERS) controllers[provider].abort(options.signal?.reason ?? Error('Work plan control stopped')); };
  const save = () => {
    const snapshot = structuredClone(plan);
    writes = writes.then(() => persist(snapshot));
    return writes;
  };
  const pause = (provider: ExtractorProvider) => {
    plan.providers[provider] = 'paused';
    controllers[provider].abort(Object.assign(Error('Provider paused'), { failureCategory: 'operator_pause' }));
  };
  options.signal?.addEventListener('abort', abortAll, { once: true });
  try {
    await save();
    while (true) {
      const capacity = options.capacity?.() ?? maximum;
      for (const provider of PROVIDERS) {
        if (!Number.isInteger(capacity[provider]) || capacity[provider] < 0 || capacity[provider] > maximum[provider]) throw Error('Worker capacity exceeds provider bound');
        if (plan.providers[provider] === 'ready' && (options.signal?.aborted || await shouldPause(provider) || capacity[provider] === 0)) {
          pause(provider); await save();
        }
        while (plan.providers[provider] === 'ready' && active[provider] < capacity[provider]) {
          if (options.signal?.aborted || controllers[provider].signal.aborted) { pause(provider); await save(); break; }
          const task = plan.tasks.find(task => task.provider === provider && task.state === 'pending' && !groups.has(task.groupId));
          if (!task) break;
          task.state = 'running'; task.attempts++; groups.add(task.groupId); active[provider]++;
          await save(); // No worker starts before its sole assignment is durable.
          options.onCapacity?.({ ...active });
          let work: Promise<void>;
          work = (async () => {
            try {
              controllers[provider].signal.throwIfAborted();
              const result = await execute(structuredClone(task), { promptSha256: plan.promptSha256, schemaSha256: plan.schemaSha256 }, controllers[provider].signal);
              if (result.preparedSha256 !== task.group.preparedSha256 || result.promptSha256 !== plan.promptSha256 || result.schemaSha256 !== plan.schemaSha256) throw Error('Work result input/contract mismatch');
              task.resultSha256 = Hash.parse(result.resultSha256); task.state = 'completed';
            } catch (error) {
              task.state = 'failed'; task.failure = 'provider_failed'; Object.assign(task, classifyWorkFailure(error)); task.resultSha256 = null; pause(provider);
            }
            await save();
          })().catch(() => { controlFailed = true; abortAll(); }).finally(() => {
            active[provider]--; groups.delete(task.groupId); running.delete(work); options.onCapacity?.({ ...active });
          });
          running.add(work);
        }
      }
      if (controlFailed) throw Error('Work plan persistence failed');
      if (!running.size) break;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([...running, new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); })]);
      clearTimeout(timer);
    }
    await writes;
  } catch {
    abortAll(); await Promise.allSettled(running);
    throw Error('Work plan control/persistence failed; recover durable state before resuming');
  } finally {
    options.signal?.removeEventListener('abort', abortAll);
  }
}
export function modelCacheKey(input: { provider: ExtractorProvider; modelIdentitySha256: string; preparedSha256: string; inputSha256: string; promptSha256: string; schemaSha256: string; extractorSha256: string; purpose: 'extraction' | 'judge' }): string {
  for (const [key, value] of Object.entries(input)) if (key.endsWith('Sha256')) Hash.parse(value);
  return hash(['district-model-cache-v2', input.provider, PROVIDER_CONFIGS[input.provider], input.modelIdentitySha256, input.preparedSha256, input.inputSha256, input.promptSha256, input.schemaSha256, input.extractorSha256, input.purpose]);
}
