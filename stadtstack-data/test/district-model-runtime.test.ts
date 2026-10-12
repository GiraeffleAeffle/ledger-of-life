import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, writeFile, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { PROVIDER_CONFIGS, SubscriptionRuntimeError } from '../src/district-model-contract.ts';
import type {ReportedUsage,RuntimeFailureDiagnostic} from '../src/district-model-contract.ts';
import { assertClaudeSubscriptionAuth, claudeExecutionArgs, inspectClaudeEvents } from '../src/district-claude.ts';
import { inspectCodexEvents, modelReadiness, subscriptionChat, subscriptionExecutionArgs, collectSubscriptionProcess, encodeSubscriptionInput, MAX_SUBSCRIPTION_INPUT_BYTES, subscriptionInputWithinBound } from '../src/district-model.ts';
import { appendUsageEntry, readUsageLedger, hourlyUsage, recordExercisedReadinessProbe, usageEntry, writeOperatorPause, pauseProvider, isProviderStopped, COST_MEANING, appendFailureDiagnostic, failureDiagnosticPath, rejectRuntimeFailure } from '../src/district-model-usage.ts';
import { classifyRuntimeFailure, failureDiagnostic, runtimeFailureReason, runtimeToolEvidence, RuntimeFailureDiagnosticSchema } from '../src/district-model-diagnostics.ts';
import {CivicPolicyStateError} from '../src/civic-opt-out.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {EXTRACTION_INSTRUCTIONS,JUDGE_INSTRUCTIONS} from '../src/district-claims.ts';
import {TOPIC_VOCABULARY} from '../src/topic-vocabulary.ts';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function claudeResult(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { supported: true }, usage: { input_tokens: 2, output_tokens: 52, cache_read_input_tokens: 3, cache_creation_input_tokens: 923 }, modelUsage: { 'claude-haiku-5-5': { inputTokens: 2, outputTokens: 52, cacheReadInputTokens: 3, cacheCreationInputTokens: 923, costUSD: 0.008432 } }, total_cost_usd: 0.008432, ...extra });
}
test('native Claude auth accepts only existing first-party Max subscription', () => {
  assert.doesNotThrow(() => assertClaudeSubscriptionAuth(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' })));
  for (const invalid of [{ loggedIn: false }, { loggedIn: true, authMethod: 'apiKey', subscriptionType: 'max' }, { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro' }, { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', apiProvider: 'bedrock' }]) assert.throws(() => assertClaudeSubscriptionAuth(JSON.stringify(invalid)), /authentication/);
  assert.throws(() => assertClaudeSubscriptionAuth('not-json'), /invalid/);
});
test('provider arguments isolate tools and never enable API-key or fallback modes', () => {
  const args = claudeExecutionArgs('fixed instructions', { type: 'object' });
  for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-chrome', '--no-session-persistence']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
  assert.equal(args[args.indexOf('--model') + 1], 'claude-haiku-5-5');
  for (const flag of ['--bare', '--fallback-model', '--dangerously-skip-permissions']) assert.ok(!args.includes(flag));
  const codex = subscriptionExecutionArgs('/tmp/unit', '/tmp/unit/schema.json', '/tmp/unit/answer.json', 'fixed instructions');
  assert.ok(codex.includes(PROVIDER_CONFIGS['openai-subscription'].model));
  assert.equal(PROVIDER_CONFIGS['openai-subscription'].model, 'gpt-6.1-sol');
  assert.ok(codex.includes('model_reasoning_effort="medium"'));
  assert.ok(codex.includes('forced_login_method="chatgpt"'));
  assert.ok(codex.includes('read-only'));
});
test('Claude requires exact reported model and retains original response digest and both usage levels', () => {
  const line = claudeResult();
  const result = inspectClaudeEvents(line);
  assert.equal(result.failureCategory, null);
  assert.equal(result.responseSha256, digest(line));
  assert.deepEqual(result.reportedModels, ['claude-haiku-5-5']);
  assert.deepEqual(result.value, { supported: true });
  assert.equal(result.usage.topLevel?.cacheCreationTokens, 923);
  assert.equal(result.usage.perModel['claude-haiku-5-5'].outputTokens, 52);
  const mismatch = inspectClaudeEvents(claudeResult({ modelUsage: { 'claude-haiku-4-5': { inputTokens: 10 } } }));
  assert.equal(mismatch.failureCategory, 'model_identity_mismatch');
  assert.equal(mismatch.usage.topLevel?.outputTokens, 52);
  assert.equal(inspectClaudeEvents(claudeResult({ modelUsage: {} })).failureCategory, 'model_identity_missing');
  assert.equal(inspectClaudeEvents(claudeResult({ is_error: true, subtype: 'error_during_execution', errors: ['429 quota'] })).failureCategory, 'rate_limit');
  assert.equal(inspectClaudeEvents('').completed, false);
});
test('native StructuredOutput is a linked return formatter, not permission for operational tools', () => {
  const init = { type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [] };
  const call = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'format-1', name: 'StructuredOutput', input: { ready: true } }] } };
  const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'format-1', content: 'validated' }] } };
  const stream = [init, call, result].map(value => JSON.stringify(value)).join('\n') + '\n' + claudeResult();
  assert.equal(inspectClaudeEvents(stream).toolAttempted, false);
  assert.equal(inspectClaudeEvents(stream).formatterUsed, true);
  for (const event of [
    { type: 'assistant', message: { content: [{ type: 'server_tool_use', id: 'format-2', name: 'StructuredOutput' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'untrusted' }] } },
    { type: 'permission_request', tool_name: 'StructuredOutput' },
    { type: 'tool_progress', tool_name: 'Read', tool_use_id: 'format-1' },
  ]) assert.equal(inspectClaudeEvents(stream + '\n' + JSON.stringify(event)).toolAttempted, true);
  assert.equal(inspectClaudeEvents(JSON.stringify(call)).toolAttempted, true);
});
test('reported tool availability and attempts reject even otherwise successful output', () => {
  for (const event of [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }, { type: 'tool_progress' }, { type: 'system', subtype: 'init', tools: ['Read'], mcp_servers: [] }, { type: 'system', subtype: 'init', tools: [], mcp_servers: [{ name: 'unknown' }] }]) {
    assert.equal(inspectClaudeEvents(JSON.stringify(event) + '\n' + claudeResult()).toolAttempted, true);
  }
  assert.equal(inspectCodexEvents('{"type":"item.started","item":{"type":"command_execution"}}').toolAttempted, true);
  assert.throws(() => inspectCodexEvents(`{"type":"session.started","model":"wrong"}\n{"type":"session.started","model":"${PROVIDER_CONFIGS['openai-subscription'].model}"}`), /different model/);
});
test('live Codex model validation does not accept historical models as a fallback', () => {
  const event = (model: string) => JSON.stringify({ type: 'session.started', model });
  assert.equal(inspectCodexEvents(event('gpt-6.1-sol')).returnedModel, 'gpt-6.1-sol');
  for (const model of ['gpt-6-luna', 'gpt-x']) assert.throws(() => inspectCodexEvents(event(model)), /different model/);
});

test('hourly ledger separates scopes, missing reports, failures and API estimates from subscription charges', async () => {
  const root = await mkdtemp(join(tmpdir(), 'district-usage-test-'));
  try {
    const path = join(root, 'private', 'usage.jsonl');
    await recordExercisedReadinessProbe(path);
    await recordExercisedReadinessProbe(path);
    const usage: ReportedUsage = { topLevel: { outputTokens: 4 }, perModel: { 'claude-haiku-5-5': { outputTokens: 7, cliEstimatedApiCostUsd: 0.001 } }, cliEstimatedApiCostUsd: 0.002 };
    const failure = usageEntry({ purpose: 'extraction' }, 'failure-one', '2026-10-11T00:59:59.000Z', '2.1.284', usage, ['claude-haiku-5-5'], 'failed', 'rate_limit');
    await appendUsageEntry(path, failure);
    await appendUsageEntry(path, usageEntry({ purpose: 'judge' }, 'unknown-counts', '2026-10-11T00:01:00.000Z', '2.1.284', { topLevel: null, perModel: {}, cliEstimatedApiCostUsd: null }, [], 'failed', 'process_failure'));
    const entries = await readUsageLedger(path);
    assert.equal(entries.length, 3);
    const hours = hourlyUsage(entries);
    assert.equal(hours.length, 2);
    assert.equal(hours[0].purposes.synthetic_readiness, 1);
    assert.equal(hours[1].calls, 2);
    assert.equal(hours[1].topLevel.sumsOfReported.outputTokens, 4);
    assert.equal(hours[1].topLevel.sumsOfReported.inputTokens, undefined);
    assert.equal(hours[1].topLevel.reportingCalls.outputTokens, 1);
    assert.equal(hours[1].perModel['claude-haiku-5-5'].sumsOfReported.outputTokens, 7);
    assert.equal(hours[1].topLevel.cliEstimatedApiCostUsd, 0.002);
    assert.equal(hours[1].actualSubscriptionCharge, null);
    assert.equal(hours[1].subscriptionQuotaRemaining, null);
    assert.equal(hours[1].costMeaning, COST_MEANING);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.throws(() => hourlyUsage([failure, failure]), /duplicate/);
    await assert.rejects(appendUsageEntry(path, { ...failure, prompt: 'must never persist' } as typeof failure));
    assert.ok(!(await readFile(path, 'utf8')).includes('must never persist'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('operator pause and independent failure markers are fail closed and provider scoped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'district-pause-test-'));
  try {
    const path = join(root, 'control.json');
    assert.equal(await isProviderStopped(path, 'anthropic-subscription'), false);
    await writeOperatorPause(path, { 'openai-subscription': false, 'anthropic-subscription': true });
    assert.equal(await isProviderStopped(path, 'anthropic-subscription'), true);
    assert.equal(await isProviderStopped(path, 'openai-subscription'), false);
    await pauseProvider(path, 'openai-subscription');
    await writeOperatorPause(path, { 'openai-subscription': false, 'anthropic-subscription': false });
    assert.equal(await isProviderStopped(path, 'openai-subscription'), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function diagnosticFixture(extra: Partial<Parameters<typeof failureDiagnostic>[0]> = {}): RuntimeFailureDiagnostic {
  return failureDiagnostic({
    callId: '651e9188-613c-43ec-91ea-898cb025b84c', groupId: digest('group'),
    provider: 'openai-subscription', startedAt: '2026-10-11T04:12:58.000Z', attempted: true,
    exitCode: 1, failureCategory: 'generation_error', reason: 'generation', parserFailureCategory: 'generation_error',
    toolEvidence: [], toolEvidenceTruncated: false, ...extra,
  });
}
test('failure reasons retain parser distinctions and process stops cannot become generic generation errors', () => {
  for (const [category, reason] of [
    ['model_metadata_unavailable', 'model'], ['configured_model_unavailable', 'model'],
    ['structured_schema_rejected', 'schema'], ['context_limit', 'context'],
    ['subscription_authentication', 'authentication'], ['cli_configuration', 'configuration'],
    ['rate_limit', 'rate_limit'], ['generation_error', 'generation'],
  ]) assert.equal(runtimeFailureReason(category), reason);
  assert.deepEqual(classifyRuntimeFailure('timeout', null, 'generation_error', false), { reason: 'timeout', failureCategory: 'process_failure' });
  assert.deepEqual(classifyRuntimeFailure('output_bound', null, null, false), { reason: 'output_bound', failureCategory: 'process_failure' });
  assert.deepEqual(classifyRuntimeFailure('operator_pause', null, 'generation_error', false), { reason: 'operator_pause', failureCategory: 'operator_pause' });
  assert.deepEqual(classifyRuntimeFailure(null, 1, 'generation_error', false), { reason: 'generation', failureCategory: 'generation_error' });
  assert.deepEqual(classifyRuntimeFailure(null, 1, null, false), { reason: 'process', failureCategory: 'process_failure' });
  assert.deepEqual(classifyRuntimeFailure(null, 0, null, true), { reason: 'tool', failureCategory: 'tool_attempt' });
  assert.deepEqual(classifyRuntimeFailure('timeout', null, null, true), { reason: 'timeout', failureCategory: 'process_failure' });
  assert.deepEqual(classifyRuntimeFailure(null, 1, 'model_identity_mismatch', false), { reason: 'model', failureCategory: 'model_identity_mismatch' });
  assert.deepEqual(classifyRuntimeFailure(null, 1, 'structured_schema_rejected', false), { reason: 'schema', failureCategory: 'invalid_structured_output' });
});
test('Codex evidence distinguishes declared availability, operational attempts and unknown rejected kinds', () => {
  const secret = 'private_source_header_account';
  const stream = [
    { type: 'tool.available', name: secret },
    { type: 'item.started', item: { type: 'command_execution', command: secret, output: secret } },
    { type: 'item.completed', item: { type: secret, request: secret } },
    { type: `tool.${secret}`, payload: secret },
  ].map(event => JSON.stringify(event)).join('\n');
  const details = runtimeToolEvidence('openai-subscription', stream);
  assert.deepEqual(details.toolEvidence, [
    { kind: 'tool.available', activity: 'declaration' },
    { kind: 'item:command_execution', activity: 'attempt' },
    { kindSha256: digest(`item:${secret}`), activity: 'unknown' },
    { kindSha256: digest(`tool.${secret}`), activity: 'unknown' },
  ]);
  assert.equal(details.toolEvidenceTruncated, false);
  const parsed = inspectCodexEvents(stream);
  assert.equal(parsed.toolAttempted, true);
  assert.deepEqual(parsed.attemptedToolTypes, ['tool.available', 'item:command_execution', `sha256:${digest(`item:${secret}`)}`, `sha256:${digest(`tool.${secret}`)}`]);
  assert.doesNotMatch(JSON.stringify({ details, parsed }), /private_source_header_account/);
  assert.equal(inspectCodexEvents(JSON.stringify({ type: 'item.started', item: { type: 'new_tool_kind' } })).toolAttempted, true);
  const bounded = runtimeToolEvidence('openai-subscription', Array.from({ length: 70 }, (_, i) => JSON.stringify({ type: `tool.unknown_${i}` })).join('\n'));
  assert.equal(bounded.toolEvidence.length, 64);
  assert.equal(bounded.toolEvidenceTruncated, true);
});
test('Claude diagnostic evidence does not mistake declarations or linked formatting for operational execution', () => {
  const declaration = JSON.stringify({ type: 'system', subtype: 'init', tools: ['Read'], mcp_servers: [{ name: 'private-server' }] });
  assert.deepEqual(runtimeToolEvidence('anthropic-subscription', declaration).toolEvidence, [
    { kind: 'tools', activity: 'declaration' }, { kind: 'mcp_servers', activity: 'declaration' },
  ]);
  assert.equal(inspectClaudeEvents(declaration).toolAttempted, true);
  const linked = [
    { type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [] },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', id: 'f1', input: { secret: 'private' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'f1', content: 'private' }] } },
    { type: 'tool_progress', tool_name: 'StructuredOutput', tool_use_id: 'f1' },
    { type: 'tool_use_summary', preceding_tool_use_ids: ['f1'] },
  ].map(event => JSON.stringify(event)).join('\n');
  assert.deepEqual(runtimeToolEvidence('anthropic-subscription', linked).toolEvidence, []);
  assert.equal(inspectClaudeEvents(linked).toolAttempted, false);
  const attempted = linked + '\n' + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: 'private' }] } });
  assert.deepEqual(runtimeToolEvidence('anthropic-subscription', attempted).toolEvidence, [{ kind: 'tool_use', activity: 'attempt' }]);
  assert.equal(inspectClaudeEvents(attempted).toolAttempted, true);
  const unlinked = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'unknown' }] } });
  assert.deepEqual(runtimeToolEvidence('anthropic-subscription', unlinked).toolEvidence, [{ kind: 'tool_result', activity: 'unknown' }]);
});
test('failure diagnostics project only controlled fields and do not fabricate exit status or group IDs', () => {
  const secret = 'Bearer private-source-account-value';
  for (const exitCode of [null, -1, 256, 1.5, NaN, Infinity]) assert.equal(diagnosticFixture({ exitCode }).exitCode, null);
  for (const exitCode of [0, 1, 255]) assert.equal(diagnosticFixture({ exitCode }).exitCode, exitCode);
  const diagnostic = diagnosticFixture({ groupId: secret });
  assert.equal(diagnostic.groupId, null);
  assert.equal(diagnostic.groupIdSha256, digest(secret));
  assert.doesNotMatch(JSON.stringify(diagnostic), /Bearer|private-source-account-value/);
  assert.equal(diagnosticFixture().groupId, digest('group'));
  assert.equal(diagnosticFixture().groupIdSha256, null);
  assert.equal(diagnosticFixture({ groupId: undefined }).groupIdSha256, null);
  assert.throws(() => RuntimeFailureDiagnosticSchema.parse({ ...diagnostic, stderr: secret }));
  assert.throws(() => RuntimeFailureDiagnosticSchema.parse({ ...diagnostic, reason: secret }));
  assert.throws(() => RuntimeFailureDiagnosticSchema.parse({ ...diagnostic, parserFailureCategory: secret }));
  assert.throws(() => RuntimeFailureDiagnosticSchema.parse({ ...diagnostic, toolEvidence: [{ activity: 'attempt', kind: secret }] }));
  assert.throws(() => RuntimeFailureDiagnosticSchema.parse({ ...diagnostic, requestedModel: 'claude-haiku-5-5' }));
  assert.equal(diagnostic.requestedModel, 'gpt-6.1-sol');
  assert.equal(RuntimeFailureDiagnosticSchema.parse({ ...diagnostic, requestedModel: 'gpt-6-luna' }).requestedModel, 'gpt-6-luna');
  for (const requestedModel of ['gpt-6.1-sol', 'gpt-6-luna']) {
    assert.equal(RuntimeFailureDiagnosticSchema.safeParse({ ...diagnostic, provider: 'anthropic-subscription', requestedModel }).success, false);
  }
  assert.equal(RuntimeFailureDiagnosticSchema.safeParse({ ...diagnostic, requestedModel: 'gpt-x' }).success, false);
  for (const stream of ['null', '[]', '{"type":']) {
    assert.throws(() => inspectCodexEvents(stream), error => error instanceof SubscriptionRuntimeError && error.reason === 'event_stream');
  }
});
test('private diagnostics append at 0600, repair file permissions and refuse symlink targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'district-diagnostic-test-'));
  try {
    const path = join(root, 'private', 'failures.jsonl'), diagnostic = diagnosticFixture();
    await appendFailureDiagnostic(path, diagnostic);
    await chmod(path, 0o644);
    await appendFailureDiagnostic(path, diagnosticFixture({ exitCode: 2 }));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, 'private'))).mode & 0o777, 0o700);
    const rows = (await readFile(path, 'utf8')).trim().split('\n').map(line => RuntimeFailureDiagnosticSchema.parse(JSON.parse(line)));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], diagnostic);
    assert.equal(rows[1].exitCode, 2);
    await assert.rejects(appendFailureDiagnostic(path, { ...diagnostic, stderr: 'must-never-persist' } as RuntimeFailureDiagnostic));
    assert.doesNotMatch(await readFile(path, 'utf8'), /must-never-persist/);
    const target = join(root, 'target'), link = join(root, 'symlink');
    await writeFile(target, 'unchanged', { mode: 0o644 });
    await symlink(target, link);
    await assert.rejects(appendFailureDiagnostic(link, diagnostic));
    assert.equal(await readFile(target, 'utf8'), 'unchanged');
    assert.equal((await stat(target)).mode & 0o777, 0o644);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('failure persistence retains reported counts, unknown usage and safe diagnostics even when private writes fail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'district-failure-test-'));
  try {
    const context = { ledgerPath: join(root, 'usage.jsonl'), pausePath: join(root, 'pause.json') };
    const diagnostic = diagnosticFixture({ provider: 'anthropic-subscription', reason: 'timeout', failureCategory: 'process_failure', parserFailureCategory: null });
    const usage: ReportedUsage = { topLevel: { outputTokens: 7 }, perModel: {}, cliEstimatedApiCostUsd: null };
    const failedUsage = usageEntry({ purpose: 'extraction' }, diagnostic.callId, diagnostic.startedAt, '2.1.284', usage, [], 'failed', 'process_failure');
    await assert.rejects(rejectRuntimeFailure(context, diagnostic, failedUsage), error => {
      assert.ok(error instanceof SubscriptionRuntimeError);
      assert.deepEqual(error.diagnostic, diagnostic);
      assert.equal(error.reason, 'timeout');
      return true;
    });
    assert.equal(await isProviderStopped(context.pausePath, 'anthropic-subscription'), true);
    assert.deepEqual((await readUsageLedger(context.ledgerPath))[0].topLevel, { outputTokens: 7 });
    assert.equal((await readUsageLedger(context.ledgerPath))[0].cliEstimatedApiCostUsd, null);
    assert.deepEqual(JSON.parse((await readFile(failureDiagnosticPath(context.ledgerPath), 'utf8')).trim()), diagnostic);
    const blocked = join(root, 'private-account-path');
    await writeFile(blocked, 'not-a-directory');
    await assert.rejects(rejectRuntimeFailure({ ledgerPath: join(blocked, 'usage'), pausePath: join(root, 'second-pause') }, diagnostic), error => {
      assert.ok(error instanceof SubscriptionRuntimeError);
      assert.equal(error.reason, 'timeout');
      assert.deepEqual(error.diagnostic, diagnostic);
      assert.match(error.message, /private failure persistence unavailable/);
      assert.doesNotMatch(error.message, /private-account-path|ENOTDIR/);
      return true;
    });
    assert.equal(await isProviderStopped(join(root, 'second-pause'), 'anthropic-subscription'), true);
    const diagnosticOnly = { ledgerPath: join(root, 'diagnostic-only'), pausePath: join(blocked, 'pause') };
    await assert.rejects(rejectRuntimeFailure(diagnosticOnly, diagnostic), SubscriptionRuntimeError);
    assert.equal(JSON.parse((await readFile(failureDiagnosticPath(diagnosticOnly.ledgerPath), 'utf8')).trim()).reason, 'timeout');
    await assert.rejects(rejectRuntimeFailure(context, { ...diagnostic, stderr: 'private-payload' } as RuntimeFailureDiagnostic), error => {
      assert.ok(error instanceof SubscriptionRuntimeError);
      assert.equal(error.diagnostic, undefined);
      assert.doesNotMatch(error.message, /private-payload/);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('native runtime rejects fixture, missing and non-OpenAI authority before any executable starts',async t=>{
 const fixture=await createCivicPolicyTestContext(t),platform=Object.getOwnPropertyDescriptor(process,'platform')!;
 Object.defineProperty(process,'platform',{...platform,value:'linux'});t.after(()=>Object.defineProperty(process,'platform',platform));
 const native=t.mock.method(childProcess,'spawn',()=>{throw Error('No native process is allowed for this fixture');});syncBuiltinESMExports();t.after(()=>{native.mock.restore();syncBuiltinESMExports();});
 const sourceContext={root:fixture.managedRoot,kind:'artifacts' as const,decisionId:fixture.decisionId,...fixture.policy,bindings:[{kind:'prepared_source' as const,url:'https://council.test/source',sourceSha256:digest('source'),observationId:'fixture-observation',receiptSha256:digest('fixture-receipt')}]};
 const context={purpose:'extraction' as const,ledgerPath:join(fixture.root,'usage.jsonl'),pausePath:join(fixture.root,'pause.json'),policy:fixture.policy,sourceContext};
 for(const provider of ['openai-subscription','anthropic-subscription'] as const){
  await assert.rejects(modelReadiness(provider,undefined,fixture.policy),CivicPolicyStateError);
  await assert.rejects(subscriptionChat(provider,'private prompt',{source:'private source'},{},context),CivicPolicyStateError);
 }
 await assert.rejects(modelReadiness('openai-subscription',undefined,{...fixture.policy,stateDir:join(fixture.root,'missing')}),CivicPolicyStateError);
 await assert.rejects(subscriptionChat('openai-subscription','prompt',{}, {},{purpose:'judge',ledgerPath:context.ledgerPath,pausePath:context.pausePath,policy:fixture.policy}),CivicPolicyStateError);
 assert.equal(native.mock.callCount(),0);await assert.rejects(stat(fixture.managedRoot),{code:'ENOENT'});
});
test('context bounds are deterministic before any process creation or model input write',()=>{
 assert.equal(encodeSubscriptionInput('fixed instructions',{source:'synthetic'}),'{"source":"synthetic"}');
 assert.throws(()=>encodeSubscriptionInput('x'.repeat(8001),{}),/context byte limit/);
 const overhead=Buffer.byteLength(JSON.stringify({source:''})),atBound={source:'x'.repeat(MAX_SUBSCRIPTION_INPUT_BYTES-overhead)};
 assert.equal(Buffer.byteLength(encodeSubscriptionInput('fixed',atBound)),MAX_SUBSCRIPTION_INPUT_BYTES);
 assert.equal(subscriptionInputWithinBound(atBound),true);
 const oversize={source:atBound.source+'x'};
 assert.equal(subscriptionInputWithinBound(oversize),false);
 assert.throws(()=>encodeSubscriptionInput('fixed',oversize),/context byte limit/);
});
test('full 12000-character multibyte German windows encode without truncation for extraction and judgment',()=>{
 const text='äöüß€„'.repeat(2000),source={text};
 assert.equal(text.length,12000);
 const extraction={municipality:{id:'strausberg',name:'Strausberg'},vocabulary:TOPIC_VOCABULARY.map(({pattern:_pattern,...topic})=>topic),source};
 const judgment={source,candidate:{summary:'Strausberg: äöüß€„'}};
 for(const [system,input] of [[EXTRACTION_INSTRUCTIONS,extraction],[JUDGE_INSTRUCTIONS,judgment]] as const){
  const bytes=Buffer.byteLength(JSON.stringify(input));
  assert.ok(bytes>24000&&bytes<=MAX_SUBSCRIPTION_INPUT_BYTES);
  assert.equal(subscriptionInputWithinBound(input),true);
  const encoded=encodeSubscriptionInput(system,input);
  assert.equal(encoded,JSON.stringify(input));assert.equal(JSON.parse(encoded).source.text,text);
 }
});
test('fatal Codex fixtures preserve controlled parser causes without retaining messages or request data', () => {
  const secret = 'private-request-source-header';
  for (const [message, category, reason] of [
    ['model metadata unavailable', 'model_metadata_unavailable', 'model'],
    ['Invalid schema for response_format', 'structured_schema_rejected', 'schema'],
    ['model not found', 'configured_model_unavailable', 'model'],
    ['context limit exceeded', 'context_limit', 'context'],
    ['generation failed', 'generation_error', 'generation'],
  ]) {
    const parsed = inspectCodexEvents(JSON.stringify({ type: 'turn.failed', error: { message, request: secret } }));
    assert.equal(parsed.failureCategory, category);
    assert.equal(runtimeFailureReason(parsed.failureCategory), reason);
    const diagnostic = diagnosticFixture({ parserFailureCategory: parsed.failureCategory, ...classifyRuntimeFailure(null, 1, parsed.failureCategory, parsed.toolAttempted) });
    assert.doesNotMatch(JSON.stringify(diagnostic), /private-request-source-header/);
    assert.equal(diagnostic.parserFailureCategory, category);
  }
  const truncated = '{"type":"item.started","item":{"type":"command_execution","command":"private"}}\n{"type":';
  assert.throws(() => inspectCodexEvents(truncated), SubscriptionRuntimeError);
  assert.deepEqual(runtimeToolEvidence('openai-subscription', truncated).toolEvidence, [{ kind: 'item:command_execution', activity: 'attempt' }]);
  assert.deepEqual(runtimeToolEvidence('anthropic-subscription', '{"type":"system","subtype":"init"}').toolEvidence, [
    { kind: 'tools', activity: 'unknown' }, { kind: 'mcp_servers', activity: 'unknown' },
  ]);
  const invalidFormatter = '{"type":"tool_progress","tool_name":"StructuredOutput","tool_use_id":"unlinked"}';
  assert.equal(inspectClaudeEvents(invalidFormatter).toolAttempted, true);
  assert.deepEqual(runtimeToolEvidence('anthropic-subscription', invalidFormatter).toolEvidence, [{ kind: 'tool_progress', activity: 'unknown' }]);
});

// In-memory process collection exercises cancellation without granting native authority.
function processFixture(t:TestContext){
 const child=Object.assign(new EventEmitter(),{pid:700_001,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{assert.fail('Expected owned detached group termination');}}) as unknown as ChildProcessWithoutNullStreams;
 const kills:Array<{pid:number;signal:NodeJS.Signals|number|undefined}>=[];
 t.mock.method(process,'kill',(pid:number,signal?:NodeJS.Signals|number)=>{kills.push({pid,signal});return true;});
 t.after(()=>{child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();});return {child,kills};
}
for(const args of [['--version'],['login','status'],['exec','--json']]){
 test(`bounded process collector aborts ${args[0]} and waits for close`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const {child,kills}=processFixture(t),controller=new AbortController();
  const pending=collectSubscriptionProcess(child,{args,input:'synthetic input',timeout:10000,signal:controller.signal});let settled=false;void pending.finally(()=>{settled=true;});
  controller.abort();controller.abort();assert.deepEqual(kills,[{pid:-700_001,signal:'SIGKILL'}]);
  child.emit('exit',null,'SIGKILL');await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(settled,false);
  child.emit('close',null);const result=await pending;assert.equal(result.failure,'operator_pause');assert.equal(getEventListeners(controller.signal,'abort').length,0);
  t.mock.timers.tick(60000);assert.equal(kills.length,1);
 });
}
test('collector timeout and output bounds cannot turn into successful model output',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const {child,kills}=processFixture(t);
 const pending=collectSubscriptionProcess(child,{args:['exec','--json'],input:'',timeout:1000});
 child.stdout.emit('data','x'.repeat(512*1024+1));assert.deepEqual(kills,[{pid:-700_001,signal:'SIGKILL'}]);child.emit('close',null);
 const result=await pending;assert.equal(result.failure,'output_bound');assert.equal(result.stdout,'');t.mock.timers.tick(1000);assert.equal(kills.length,1);
});
test('collector parses no generation events during metadata preflight and releases listeners after close',async t=>{
 const {child,kills}=processFixture(t),controller=new AbortController();const pending=collectSubscriptionProcess(child,{args:['login','status'],input:'',timeout:10000,signal:controller.signal});
 child.stdout.emit('data','Logged in using ChatGPT\\n');child.emit('close',0);
 const result=await pending;assert.equal(result.failure,null);assert.match(result.stdout,/Logged in/);assert.equal(getEventListeners(controller.signal,'abort').length,0);controller.abort();assert.deepEqual(kills,[]);
});
test('historical multiline Claude authentication remains parseable without a live Claude path',()=>{
 const historical=JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'},null,2);
 assert.doesNotThrow(()=>assertClaudeSubscriptionAuth(historical));assert.throws(()=>assertClaudeSubscriptionAuth(historical.replace('"max"','"pro"')),/authentication/);
});
