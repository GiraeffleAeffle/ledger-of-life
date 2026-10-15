import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {codexSubscriptionLimit,codexSubscriptionNoOutput,ompSubscriptionLimit} from '../src/district-subscription-limit.ts';
import {runtimeToolEvidence,failureDiagnostic,RuntimeFailureDiagnosticSchema} from '../src/district-model-diagnostics.ts';
import {OmpRunnerHold,inspectOmpLimitFailure,inspectOmpEvents} from '../src/district-omp-b-runner.ts';
import {assessmentBridgeHoldReason,assessmentBridgeFailureVersions} from '../src/district-assessment-broker.ts';
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
test('conflicting or unusable provider clocks cannot fall back to an earlier rate snapshot',()=>{
 const snapshot={type:'token_count',rate_limits:{primary:{used_percent:100,resets_at:1792054800}}};
 const failure={type:'turn.failed',error:{code:'usage_limit_reached',reset_at:'2026-10-15T10:00:00Z',resets_at:'2026-10-15T11:00:00Z'}};
 assert.equal(codexSubscriptionLimit(events([snapshot,failure]),observedAt)?.resetAt,null);
 assert.equal(codexSubscriptionLimit(events([snapshot,{type:'error',error:{code:'usage_limit_reached',reset_at:'not an absolute clock'}}]),observedAt)?.resetAt,null);
 assert.equal(codexSubscriptionLimit(events([snapshot,{type:'error',error:{code:'usage_limit_reached',message:'resets in 2 hours'}}]),observedAt)?.resetAt,null);
 assert.equal(codexSubscriptionLimit(events([snapshot,{type:'error',error:{code:'usage_limit_reached'}}]),observedAt)?.resetAt,resetAt,'Only absent clocks permit the provider snapshot fallback');
});
test('missing, conflicting, local/relative reset clocks and generic 429s never authorize a guessed reset',()=>{
 for(const error of [{code:'usage_limit_reached'},{code:'usage_limit_reached',message:'resets in 2 hours'},{code:'usage_limit_reached',message:'resets at 09:00'},{code:'usage_limit_reached',reset_at:resetAt,resets_at:'2026-10-15T10:00:00Z'}]){
  assert.equal(codexSubscriptionLimit(events([{type:'turn.failed',error}]),observedAt)?.resetAt,null);
 }
 assert.equal(codexSubscriptionLimit(events([{type:'error',message:'429 overloaded, try again later'}]),observedAt),null);
 assert.equal(codexSubscriptionLimit('{broken\n',observedAt),null);
 assert.equal(codexSubscriptionNoOutput(events([{type:'item.completed',item:{type:'agent_message',text:'partial'}}])),false);
});
test('omp accepts only typed empty limit failures with normal exit and complete terminal framing',()=>{
 const error={type:'rate_limit_error',reset_at:resetAt,message:'PRIVATE_PROVIDER_ERROR'};
 const stream=(content:unknown[]=[])=>{
  const message={role:'assistant',provider:'anthropic',api:'anthropic-messages',model:'claude-haiku-5-5',timestamp:1,stopReason:'error',content,errorMessage:'429 '+JSON.stringify(error)};
  return events([{type:'session'},{type:'agent_start'},{type:'turn_start'},{type:'message_start',message:{...message,stopReason:undefined,errorMessage:undefined}},{type:'message_end',message},{type:'turn_end',message,toolResults:[]},{type:'agent_end',messages:[message]}]);
 };
 const proof=ompSubscriptionLimit(stream(),'',observedAt,0);assert.ok(proof);assert.equal(proof.noOutput,true);assert.equal(proof.limit.resetAt,resetAt);
 assert.equal(proof.failureProof.terminalFrame,'assistant_turn_agent_error');
 assert.equal(assessmentBridgeHoldReason(new OmpRunnerHold('provider_failed',proof)),'budget_paused');
 assert.equal(JSON.stringify(proof).includes('PRIVATE_PROVIDER_ERROR'),false);
 assert.throws(()=>inspectOmpEvents(stream(),0),(error:unknown)=>error instanceof OmpRunnerHold&&error.reason==='provider_failed');
 assert.equal(inspectOmpLimitFailure(stream(),'',observedAt,0,new OmpRunnerHold('provider_failed'))?.noOutput,true);
 const classified=new OmpRunnerHold('provider_failed',undefined,'provider_error_rate_limit'),limited=inspectOmpLimitFailure(stream(),'',observedAt,0,classified);
 assert.ok(limited);assert.equal(limited.failureKind,'provider_error_rate_limit');assert.equal(limited.noOutput,true);assert.equal(assessmentBridgeHoldReason(limited),'budget_paused');
 const versions=assessmentBridgeFailureVersions(randomUUID(),limited);
 assert.equal(versions.ompFailureKind,'provider_error_rate_limit');assert.equal(versions.subscriptionLimitNoOutput,'true');assert.equal(versions.subscriptionLimitTerminalFrame,'assistant_turn_agent_error');
 assert.doesNotMatch(JSON.stringify(versions),/PRIVATE_PROVIDER_ERROR|rate_limit_error|reset_at/);
 for(const reason of ['event_stream','resource_limit','model_identity_mismatch'] as const)assert.equal(inspectOmpLimitFailure(stream(),'',observedAt,0,new OmpRunnerHold(reason))?.noOutput,false,'An unrelated successful-decoder rejection cannot certify a quota retry');
 assert.equal(inspectOmpLimitFailure(stream(),'',observedAt,137,new OmpRunnerHold('provider_failed'))?.noOutput,false);
 for(const exitCode of [1,137])assert.equal(ompSubscriptionLimit(stream(),'',observedAt,exitCode)?.noOutput,false,'Abnormal process termination cannot certify empty output');
 const incomplete=events([{type:'session'},{type:'error',error}]);
 for(const exitCode of [0,137])assert.equal(ompSubscriptionLimit(incomplete,'',observedAt,exitCode)?.noOutput,false,'A typed error is not a complete terminal provider failure');
 assert.equal(ompSubscriptionLimit(stream().split('\n').slice(0,-2).join('\n')+'\n','',observedAt,0)?.noOutput,false,'Missing agent_end remains ambiguous');
 assert.equal(ompSubscriptionLimit(stream()+JSON.stringify({type:'agent_start'})+'\n','',observedAt,0)?.noOutput,false,'Extra events after terminal framing remain ambiguous');
 assert.equal(ompSubscriptionLimit(stream([{type:'text',text:'partial output'}]),'',observedAt,0)?.noOutput,false);
 assert.equal(ompSubscriptionLimit(stream(),'unclassified stderr',observedAt,0)?.noOutput,false);
 assert.equal(ompSubscriptionLimit(events([{type:'session'}]),JSON.stringify({...error,content:[{type:'text',text:'partial stderr response'}]}),observedAt,0)?.noOutput,false);
 assert.equal(ompSubscriptionLimit(stream().trimEnd(),'',observedAt,0),null);
 assert.equal(ompSubscriptionLimit(events([{type:'session'},{type:'tool_result'}]),JSON.stringify(error),observedAt,0),null);
 assert.equal(ompSubscriptionLimit(events([{type:'session'},{type:'message_update',assistantMessageEvent:{type:'error',error:{...error,content:[{type:'text',text:'partial'}]}}}]),'',observedAt,0)?.noOutput,false);
 assert.equal(ompSubscriptionLimit(events([{type:'session'},{type:'error',error:{type:'rate_limit_error'}}]),'',observedAt,0)?.limit.resetAt,null);
 assert.equal(ompSubscriptionLimit(events([{type:'session'},{type:'error',error:{type:'overloaded_error'}}]),'',observedAt,0),null);
});
