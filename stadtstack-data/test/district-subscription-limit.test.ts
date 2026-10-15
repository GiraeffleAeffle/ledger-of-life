import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {codexSubscriptionLimit,codexSubscriptionNoOutput,ompSubscriptionLimit} from '../src/district-subscription-limit.ts';
import {runtimeToolEvidence,failureDiagnostic,RuntimeFailureDiagnosticSchema} from '../src/district-model-diagnostics.ts';
import {OmpRunnerHold} from '../src/district-omp-b-runner.ts';
import {assessmentBridgeHoldReason} from '../src/district-assessment-broker.ts';
const observedAt='2026-10-15T08:00:00.000Z',resetAt='2026-10-15T09:00:00.000Z';
const events=(values:unknown[])=>values.map(value=>JSON.stringify(value)).join('\n')+'\n';
test('Codex projects only actual absolute clocks and preserves them across the unchanged runtime framing',()=>{
 const stdout=events([{type:'thread.started'},{type:'turn.failed',error:{code:'usage_limit_reached',resets_at:1792054800,message:'PRIVATE_ERROR_DO_NOT_RETAIN'}}]);
 assert.equal(codexSubscriptionLimit(stdout,observedAt)?.resetAt,resetAt);
 assert.equal(codexSubscriptionNoOutput(stdout),true);
 const details=runtimeToolEvidence('openai-subscription',stdout);
 const diagnostic=failureDiagnostic({callId:randomUUID(),provider:'openai-subscription',startedAt:observedAt,attempted:true,exitCode:1,failureCategory:'rate_limit',reason:'rate_limit',parserFailureCategory:'rate_limit',...details});
 const saved=RuntimeFailureDiagnosticSchema.parse(diagnostic);
 assert.equal(saved.subscriptionLimit?.resetAt,resetAt);assert.equal(saved.subscriptionNoOutput,true);
 assert.equal(JSON.stringify(saved).includes('PRIVATE_ERROR'),false);
 assert.equal(codexSubscriptionLimit(events([{type:'error',message:"You've hit your usage limit. Resets at 2026-10-15T09:00:00Z"}]),observedAt)?.resetAt,resetAt);
});
test('installed raw token_count windows supply absolute clocks only alongside a real limit failure',()=>{
 const snapshot={type:'token_count',info:null,rate_limits:{primary:{used_percent:100,resets_at:1792054800},secondary:{used_percent:100,resets_at:1792058400}}};
 const failure={type:'error',message:"You've hit your usage limit."};
 assert.equal(codexSubscriptionLimit(events([snapshot,failure]),observedAt)?.resetAt,'2026-10-15T10:00:00.000Z');
 assert.equal(codexSubscriptionNoOutput(events([snapshot,failure])),true);
 assert.equal(codexSubscriptionLimit(events([snapshot]),observedAt),null,'Percent is not a limit failure');
 assert.equal(codexSubscriptionLimit(events([{...snapshot,rate_limits:{primary:{used_percent:100}}},failure]),observedAt)?.resetAt,null);
 assert.equal(codexSubscriptionNoOutput(events([{...snapshot,info:{last_token_usage:{output_tokens:1}}},failure])),false);
});
test('missing, conflicting, local/relative reset clocks and generic 429s never authorize a guessed reset',()=>{
 for(const error of [{code:'usage_limit_reached'},{code:'usage_limit_reached',message:'resets in 2 hours'},{code:'usage_limit_reached',message:'resets at 09:00'},{code:'usage_limit_reached',reset_at:resetAt,resets_at:'2026-10-15T10:00:00Z'}]){
  assert.equal(codexSubscriptionLimit(events([{type:'turn.failed',error}]),observedAt)?.resetAt,null);
 }
 assert.equal(codexSubscriptionLimit(events([{type:'error',message:'429 overloaded, try again later'}]),observedAt),null);
 assert.equal(codexSubscriptionLimit('{broken\n',observedAt),null);
 assert.equal(codexSubscriptionNoOutput(events([{type:'item.completed',item:{type:'agent_message',text:'partial'}}])),false);
});
test('omp accepts only typed empty limit failures and retains ambiguous exposure barriers',()=>{
 const error={type:'rate_limit_error',reset_at:resetAt,message:'PRIVATE_PROVIDER_ERROR'};
 const stream=(content:unknown[]=[])=>events([{type:'session'},{type:'message_end',message:{role:'assistant',provider:'anthropic',model:'claude-haiku-5-5',stopReason:'error',content,errorMessage:'429 '+JSON.stringify(error)}}]);
 const proof=ompSubscriptionLimit(stream(),'',observedAt);assert.ok(proof);assert.equal(proof.noOutput,true);assert.equal(proof.limit.resetAt,resetAt);
 assert.equal(assessmentBridgeHoldReason(new OmpRunnerHold('provider_failed',proof)),'budget_paused');
 assert.equal(JSON.stringify(proof).includes('PRIVATE_PROVIDER_ERROR'),false);
 assert.equal(ompSubscriptionLimit(stream([{type:'text',text:'partial output'}]),'',observedAt)?.noOutput,false);
 assert.equal(ompSubscriptionLimit(stream(),'unclassified stderr',observedAt)?.noOutput,false);
 assert.equal(ompSubscriptionLimit(events([{type:'session'}]),JSON.stringify({...error,content:[{type:'text',text:'partial stderr response'}]}),observedAt)?.noOutput,false);
 assert.equal(ompSubscriptionLimit(stream().trimEnd(),'',observedAt),null);
 assert.equal(ompSubscriptionLimit(events([{type:'session'},{type:'tool_result'}]),JSON.stringify(error),observedAt),null);
 assert.equal(ompSubscriptionLimit(events([{type:'session'},{type:'message_update',assistantMessageEvent:{type:'error',error:{...error,content:[{type:'text',text:'partial'}]}}}]),'',observedAt)?.noOutput,false);
 assert.equal(ompSubscriptionLimit(events([{type:'session'},{type:'error',error:{type:'rate_limit_error'}}]),'',observedAt)?.limit.resetAt,null);
 assert.equal(ompSubscriptionLimit(events([{type:'session'},{type:'error',error:{type:'overloaded_error'}}]),'',observedAt),null);
});
