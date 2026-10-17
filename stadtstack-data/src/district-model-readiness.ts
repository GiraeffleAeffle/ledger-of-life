import { assertClaudeSubscriptionAuth } from './district-claude.ts';
import { PROVIDER_CONFIGS, modelIdentitySha256, SubscriptionRuntimeError, type ExtractorProvider, type ModelEvidence, type RuntimeFailureReason } from './district-model-contract.ts';

// Protocol only: no native executor, filesystem, host policy, source path or stdin.
// The caller owns the execution boundary (authoritative VM or deny-write Mac probe).
// Deliberately Codex/Claude-specific: omp auth-broker health/list is not Max
// route evidence, and omp must never be probed using Claude's auth protocol.
export type ReadinessExecutor = (provider: ExtractorProvider, args: ['--version'] | ['login', 'status'] | ['auth', 'status', '--json'], timeout: number, signal?: AbortSignal) => Promise<{ stdout: string; stderr: string; code: number | null; failure: RuntimeFailureReason | null }>;
export async function sourceFreeModelReadiness(provider: ExtractorProvider, execute: ReadinessExecutor, signal?: AbortSignal): Promise<ModelEvidence> {
  const config = PROVIDER_CONFIGS[provider];
  const version = await execute(provider, ['--version'], 10_000, signal);
  const match = (provider === 'openai-subscription' ? /^codex-cli\s+(\d+\.\d+\.\d+(?:[-.a-zA-Z0-9]*))\s*$/m : /^(\d+\.\d+\.\d+(?:[-.a-zA-Z0-9]*))\s+\(Claude Code\)\s*$/m).exec(version.stdout);
  if (version.code !== 0 || version.failure || !match) throw new SubscriptionRuntimeError(version.failure === 'operator_pause' ? 'operator_pause' : 'process_failure', 'Subscription CLI version unavailable', { reason: version.failure ?? 'process' });
  const login = await execute(provider, provider === 'openai-subscription' ? ['login', 'status'] : ['auth', 'status', '--json'], 15_000, signal);
  if (login.code !== 0 || login.failure) throw new SubscriptionRuntimeError(login.failure === 'operator_pause' ? 'operator_pause' : 'subscription_authentication', 'Subscription existing authentication unavailable', { reason: login.failure ?? 'authentication' });
  if (provider === 'openai-subscription') {
    if (!/logged in using chatgpt/iu.test(login.stdout + login.stderr)) throw new SubscriptionRuntimeError('subscription_authentication', 'Subscription CLI existing ChatGPT login unavailable', { reason: 'authentication' });
  } else {
    try { assertClaudeSubscriptionAuth(login.stdout); }
    catch { throw new SubscriptionRuntimeError('subscription_authentication', 'Native first-party Max subscription authentication unavailable', { reason: 'authentication' }); }
  }
  const identity = { provider, tool: config.tool, toolVersion: match[1], model: config.model, modelIdentityBasis: config.modelIdentityBasis };
  return { ...identity, modelIdentitySha256: modelIdentitySha256(identity) };
}
