import type {ManagedSourceContext,CivicPolicyOptions} from './civic-opt-out.ts';

export type ExtractorProvider = 'openai-subscription' | 'anthropic-subscription';
export const PROVIDER_CONFIGS = Object.freeze({
  'openai-subscription': Object.freeze({ model: 'gpt-6-luna', tool: 'codex-cli', host: 'codex-workstation', binary: '/home/max/.local/bin/codex', modelIdentityBasis: 'configured-cli-model-and-tool-version', toolLimitation: 'Codex retains apply_patch availability; read-only sandbox blocks writes. Shell/browser/app/plugin features are disabled and any attempted tool use rejects the result. This is not a blanket tool-free CLI.' }),
  'anthropic-subscription': Object.freeze({ model: 'claude-haiku-5-5', tool: 'claude-cli', host: 'Mac', binary: '/Users/max/.local/bin/claude', modelIdentityBasis: 'reported-cli-model-and-tool-version', toolLimitation: 'Native Claude safe/restricted mode, no operational tools or MCP servers. Only its built-in StructuredOutput return formatter is allowed, with linked call/result IDs; every other tool declaration or attempt rejects the result. Existing first-party Max authentication only.' }),
} as const);
export type ModelEvidence = {
  provider: ExtractorProvider; tool: 'codex-cli' | 'claude-cli'; toolVersion: string;
  model: string; modelIdentitySha256: string;
  modelIdentityBasis: 'configured-cli-model-and-tool-version' | 'reported-cli-model-and-tool-version';
};
export type TokenCounts = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number };
export type ReportedUsage = { topLevel: TokenCounts | null; perModel: Record<string, TokenCounts & { cliEstimatedApiCostUsd?: number }>; cliEstimatedApiCostUsd: number | null };
export type CallPurpose = 'extraction' | 'judge' | 'agreement' | 'synthetic_readiness';
export type UsageContext = { purpose: CallPurpose; ledgerPath: string; pausePath: string; groupId?: string; signal?: AbortSignal; sourceContext?: ManagedSourceContext; policy?: CivicPolicyOptions };
export type ModelAnswer = {
  value: unknown; responseSha256: string; returnedModel: string | null; runtimeWarnings: string[];
  evidence: ModelEvidence; requestedModel: string; reportedModels: string[]; usage: ReportedUsage;
};
export type SubscriptionFailureCategory = 'subscription_authentication' | 'model_identity_mismatch' | 'model_identity_missing' | 'rate_limit' | 'generation_error' | 'invalid_structured_output' | 'tool_attempt' | 'operator_pause' | 'process_failure';
export type RuntimeFailureReason = 'timeout' | 'output_bound' | 'operator_pause' | 'model' | 'schema' | 'context' | 'tool' | 'generation' | 'authentication' | 'rate_limit' | 'configuration' | 'event_stream' | 'input_channel' | 'process';
export const RUNTIME_TOOL_KINDS = ['item:command_execution', 'item:file_change', 'item:mcp_tool_call', 'item:web_search', 'item:collab_tool_call', 'tools', 'mcp_servers', 'tool_use', 'server_tool_use', 'tool_result', 'tool_progress', 'tool_use_summary', 'permission_request', 'tool.available', 'tool.declared', 'tool.started', 'tool.completed', 'command.started', 'command.completed', 'function_call', 'apply_patch'] as const;
export type RuntimeToolEvidence = { activity: 'declaration' | 'attempt' | 'unknown' } & ({ kind: typeof RUNTIME_TOOL_KINDS[number]; kindSha256?: never } | { kindSha256: string; kind?: never });
export type RuntimeFailureDiagnostic = {
  version: 1; callId: string; groupId: string | null; groupIdSha256: string | null;
  provider: ExtractorProvider; requestedModel: typeof PROVIDER_CONFIGS[ExtractorProvider]['model'];
  startedAt: string; failedAt: string; attempted: boolean; exitCode: number | null;
  failureCategory: SubscriptionFailureCategory; reason: RuntimeFailureReason;
  parserFailureCategory: string | null; toolEvidence: RuntimeToolEvidence[]; toolEvidenceTruncated: boolean;
};
export class SubscriptionRuntimeError extends Error {
  readonly failureCategory: SubscriptionFailureCategory;
  readonly reason?: RuntimeFailureReason;
  readonly diagnostic?: RuntimeFailureDiagnostic;
  constructor(failureCategory: SubscriptionFailureCategory, message: string, details?: { reason?: RuntimeFailureReason; diagnostic?: RuntimeFailureDiagnostic }) {
    super(message); this.name = 'SubscriptionRuntimeError'; this.failureCategory = failureCategory;
    this.reason = details?.reason; this.diagnostic = details?.diagnostic;
  }
}
export const EMPTY_USAGE: ReportedUsage = Object.freeze({ topLevel: null, perModel: Object.freeze({}), cliEstimatedApiCostUsd: null });
