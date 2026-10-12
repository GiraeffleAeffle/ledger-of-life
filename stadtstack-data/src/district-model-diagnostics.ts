import { z } from 'zod';
import { sha256 } from './district-schema.ts';
import { PROVIDER_CONFIGS, RUNTIME_TOOL_KINDS, type ExtractorProvider, type RuntimeFailureDiagnostic, type RuntimeFailureReason, type RuntimeToolEvidence, type SubscriptionFailureCategory } from './district-model-contract.ts';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Activity = z.enum(['declaration', 'attempt', 'unknown']);
const ToolEvidenceSchema = z.union([
  z.object({ activity: Activity, kind: z.enum(RUNTIME_TOOL_KINDS) }).strict(),
  z.object({ activity: Activity, kindSha256: Hash }).strict(),
]);
export const RuntimeFailureDiagnosticSchema = z.object({
  version: z.literal(1), callId: z.uuid(), groupId: Hash.nullable(), groupIdSha256: Hash.nullable(),
  provider: z.enum(['openai-subscription', 'anthropic-subscription']), requestedModel: z.enum(['gpt-6.1-sol', 'gpt-6-luna', 'claude-haiku-5-5']),
  startedAt: z.iso.datetime(), failedAt: z.iso.datetime(), attempted: z.boolean(), exitCode: z.number().int().min(0).max(255).nullable(),
  failureCategory: z.enum(['subscription_authentication', 'model_identity_mismatch', 'model_identity_missing', 'rate_limit', 'generation_error', 'invalid_structured_output', 'tool_attempt', 'operator_pause', 'process_failure']),
  reason: z.enum(['timeout', 'output_bound', 'operator_pause', 'model', 'schema', 'context', 'tool', 'generation', 'authentication', 'rate_limit', 'configuration', 'event_stream', 'input_channel', 'process']),
  parserFailureCategory: z.enum(['model_metadata_unavailable', 'structured_schema_rejected', 'configured_model_unavailable', 'context_limit', 'subscription_authentication', 'cli_configuration', 'rate_limit', 'generation_error', 'model_identity_mismatch', 'model_identity_missing', 'invalid_structured_output']).nullable(),
  toolEvidence: z.array(ToolEvidenceSchema).max(64), toolEvidenceTruncated: z.boolean(),
}).strict().refine(value => (value.requestedModel === PROVIDER_CONFIGS[value.provider].model || (PROVIDER_CONFIGS[value.provider].historicalModels as readonly string[]).includes(value.requestedModel)) && !(value.groupId && value.groupIdSha256));

export function runtimeFailureReason(category: string | null): RuntimeFailureReason {
  switch (category) {
    case 'model_metadata_unavailable': case 'configured_model_unavailable': case 'model_identity_mismatch': case 'model_identity_missing': return 'model';
    case 'structured_schema_rejected': case 'invalid_structured_output': return 'schema';
    case 'context_limit': return 'context';
    case 'subscription_authentication': return 'authentication';
    case 'cli_configuration': return 'configuration';
    case 'rate_limit': return 'rate_limit';
    case 'generation_error': return 'generation';
    case 'tool_attempt': return 'tool';
    case 'operator_pause': return 'operator_pause';
    default: return 'process';
  }
}
export function safeToolEvidence(kind: string, activity: RuntimeToolEvidence['activity']): RuntimeToolEvidence {
  return (RUNTIME_TOOL_KINDS as readonly string[]).includes(kind)
    ? { activity, kind: kind as typeof RUNTIME_TOOL_KINDS[number] }
    : { activity, kindSha256: sha256(kind) };
}
export function classifyRuntimeFailure(processFailure: RuntimeFailureReason | null, exitCode: number | null, parserFailureCategory: string | null, toolAttempted: boolean): { reason: RuntimeFailureReason; failureCategory: SubscriptionFailureCategory } {
  const reason = processFailure ?? (toolAttempted ? 'tool' : parserFailureCategory ? runtimeFailureReason(parserFailureCategory) : exitCode === 0 ? 'generation' : 'process');
  const failureCategory: SubscriptionFailureCategory = reason === 'tool' ? 'tool_attempt'
    : reason === 'operator_pause' ? 'operator_pause'
    : reason === 'authentication' ? 'subscription_authentication'
    : reason === 'rate_limit' ? 'rate_limit'
    : reason === 'schema' || reason === 'event_stream' ? 'invalid_structured_output'
    : reason === 'model' && parserFailureCategory === 'model_identity_mismatch' ? 'model_identity_mismatch'
    : reason === 'model' && parserFailureCategory === 'model_identity_missing' ? 'model_identity_missing'
    : ['generation', 'model', 'context'].includes(reason) ? 'generation_error' : 'process_failure';
  return { reason, failureCategory };
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
// Diagnostic projection only: never grants tool permission or replaces the authoritative provider parser.
// Malformed/truncated lines are omitted here, but still rejected by the runtime parser.
export function runtimeToolEvidence(provider: ExtractorProvider, stdout: string): Pick<RuntimeFailureDiagnostic, 'toolEvidence' | 'toolEvidenceTruncated'> {
  const evidence = new Map<string, RuntimeToolEvidence>();
  let toolEvidenceTruncated = false;
  const add = (kind: string, activity: RuntimeToolEvidence['activity']) => {
    const safe = safeToolEvidence(kind, activity), key = JSON.stringify(safe);
    if (evidence.has(key)) return;
    if (evidence.size === 64) { toolEvidenceTruncated = true; return; }
    evidence.set(key, safe);
  };
  const formatterCalls = new Set<string>();
  let formatterDeclared = false;
  for (const line of stdout.split('\n')) {
    let event: Record<string, unknown>;
    try { event = object(JSON.parse(line)); } catch { continue; }
    const type = typeof event.type === 'string' ? event.type : '';
    if (provider === 'openai-subscription') {
      const item = object(event.item);
      if (typeof item.type === 'string' && !['agent_message', 'reasoning', 'error'].includes(item.type)) {
        const kind = `item:${item.type}`;
        add(kind, (RUNTIME_TOOL_KINDS as readonly string[]).includes(kind) && ['item.started', 'item.updated', 'item.completed'].includes(type) ? 'attempt' : 'unknown');
      }
      if (/tool|command|file_change|web_search|mcp|function_call|patch/iu.test(type)) {
        add(type, ['tool.available', 'tool.declared'].includes(type) ? 'declaration' : (RUNTIME_TOOL_KINDS as readonly string[]).includes(type) ? 'attempt' : 'unknown');
      }
      continue;
    }
    if (type === 'system' && event.subtype === 'init') {
      formatterDeclared = Array.isArray(event.tools) && event.tools.includes('StructuredOutput');
      if (!Array.isArray(event.tools)) add('tools', 'unknown');
      else if (event.tools.some(tool => tool !== 'StructuredOutput')) add('tools', 'declaration');
      if (!Array.isArray(event.mcp_servers)) add('mcp_servers', 'unknown');
      else if (event.mcp_servers.length) add('mcp_servers', 'declaration');
    }
    const message = object(event.message);
    for (const raw of Array.isArray(message.content) ? message.content : []) {
      const block = object(raw);
      if (block.type === 'tool_use') {
        if (formatterDeclared && block.name === 'StructuredOutput' && typeof block.id === 'string' && !formatterCalls.has(block.id)) formatterCalls.add(block.id);
        else add('tool_use', block.name === 'StructuredOutput' ? 'unknown' : 'attempt');
      } else if (block.type === 'server_tool_use') add('server_tool_use', 'attempt');
      else if (block.type === 'tool_result' && !(typeof block.tool_use_id === 'string' && formatterCalls.has(block.tool_use_id))) add('tool_result', 'unknown');
    }
    if (/tool_use|tool_result|tool_progress|permission_request/.test(type)) {
      const formatterProgress = type === 'tool_progress' && event.tool_name === 'StructuredOutput' && typeof event.tool_use_id === 'string' && formatterCalls.has(event.tool_use_id);
      const formatterSummary = type === 'tool_use_summary' && Array.isArray(event.preceding_tool_use_ids) && event.preceding_tool_use_ids.length > 0 && event.preceding_tool_use_ids.every(id => typeof id === 'string' && formatterCalls.has(id));
      if (!formatterProgress && !formatterSummary) add(type, event.tool_name !== 'StructuredOutput' && ['tool_use', 'tool_progress', 'permission_request'].includes(type) ? 'attempt' : 'unknown');
    }
  }
  return { toolEvidence: [...evidence.values()], toolEvidenceTruncated };
}
export function failureDiagnostic(input: {
  callId: string; groupId?: string; provider: ExtractorProvider; startedAt: string; attempted: boolean;
  exitCode: number | null; failureCategory: SubscriptionFailureCategory; reason: RuntimeFailureReason;
  parserFailureCategory: string | null; toolEvidence: RuntimeToolEvidence[]; toolEvidenceTruncated: boolean;
}): RuntimeFailureDiagnostic {
  const groupId = input.groupId && /^[a-f0-9]{64}$/.test(input.groupId) ? input.groupId : null;
  return RuntimeFailureDiagnosticSchema.parse({
    version: 1, callId: input.callId, groupId, groupIdSha256: input.groupId !== undefined && !groupId ? sha256(input.groupId) : null,
    provider: input.provider, requestedModel: PROVIDER_CONFIGS[input.provider].model, startedAt: input.startedAt, failedAt: new Date().toISOString(),
    attempted: input.attempted, exitCode: Number.isInteger(input.exitCode) && input.exitCode! >= 0 && input.exitCode! <= 255 ? input.exitCode : null,
    failureCategory: input.failureCategory, reason: input.reason, parserFailureCategory: input.parserFailureCategory,
    toolEvidence: input.toolEvidence, toolEvidenceTruncated: input.toolEvidenceTruncated,
  });
}
