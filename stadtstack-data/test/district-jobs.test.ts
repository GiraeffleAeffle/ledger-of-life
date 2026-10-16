import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseError} from 'pg';
import {z} from 'zod';
import {CivicPolicyStateError,HostOptedOutError} from '../src/civic-opt-out.ts';
import {formatDistrictJobException,formatDistrictBFailure,OmpFailureKindSchema,OmpDecodeCheckSchema} from '../src/district-exception-diagnostics.ts';
import {digest} from '../src/district-adapter-contract.ts';
import {canonicalJobIdentity,canonicalResourceIdentity,runDistrictJobsCli,R1_MUNICIPALITIES,DistrictExecutionHold,type DistrictJobSpec} from '../src/district-jobs.ts';

const spec:DistrictJobSpec={step:'parse',lane:'cpu',semanticContractSha256:digest('parser-v1'),inputArtifactHashes:[digest('b'),digest('a')],sourceScope:{publisherId:'synthetic-publisher',sourceId:'synthetic-source',municipalityId:'strausberg',ags:'12064472',tenant:'town-tenant',observationWindow:'2026-10-11'},selector:{query:{b:2,a:1},candidateIds:['candidate-b','candidate-a']},policyProofSha256:digest('policy')};
test('semantic identity sorts unordered hashes and object keys, preserves meaningful candidate order and scope',()=>{
  const first=canonicalJobIdentity(spec);
  const reordered=canonicalJobIdentity({...spec,inputArtifactHashes:[...spec.inputArtifactHashes].reverse(),selector:{candidateIds:['candidate-b','candidate-a'],query:{a:1,b:2}}});
  assert.equal(first.jobKey,reordered.jobKey);
  assert.equal(first.jobKey,canonicalJobIdentity({...spec,inputArtifactHashes:[...spec.inputArtifactHashes,spec.inputArtifactHashes[0]]}).jobKey);
  assert.equal(first.jobKey,canonicalJobIdentity({...spec,lane:'cpu-priority'}).jobKey);
  for(const changed of [
    {...spec,semanticContractSha256:digest('parser-v2')},
    {...spec,selector:{query:{a:1,b:2},candidateIds:['candidate-a','candidate-b']}},
    {...spec,sourceScope:{...spec.sourceScope,tenant:'another-tenant'}},
    {...spec,sourceScope:{...spec.sourceScope,observationWindow:'2026-10-12'}},
    {...spec,policyProofSha256:digest('policy-v2')},
  ])assert.notEqual(first.jobKey,canonicalJobIdentity(changed).jobKey);
  assert.throws(()=>canonicalJobIdentity({...spec,selector:{value:undefined}}),/canonical/);
  assert.throws(()=>canonicalJobIdentity({...spec,selector:{value:Infinity}}),/canonical/);
});
test('R1 scope refuses new towns, leading-zero loss, district prefixes and municipality/AGS mismatches',()=>{
  for(const sourceScope of [
    {...spec.sourceScope,municipalityId:'new-town'},
    {...spec.sourceScope,ags:'12064'},
    {...spec.sourceScope,municipalityId:'ratzeburg',ags:'1053100'},
    {...spec.sourceScope,municipalityId:'ratzeburg',ags:'12064472'},
    {...spec.sourceScope,municipalityId:'ruedersdorf',ags:'12064428'},
  ])assert.throws(()=>canonicalJobIdentity({...spec,sourceScope}));
});
test('all nine exact registry municipality IDs are admitted without compatibility aliases',()=>{
  assert.equal(Object.keys(R1_MUNICIPALITIES).length,9);
  assert.equal(R1_MUNICIPALITIES['ruedersdorf-bei-berlin'],'12064428');
  for(const [municipalityId,ags] of Object.entries(R1_MUNICIPALITIES))assert.match(canonicalJobIdentity({...spec,sourceScope:{...spec.sourceScope,municipalityId,ags}}).jobKey,/^[a-f0-9]{64}$/);
});
test('resource identities retain portal tenant/query selectors and strip only non-HTTP fragments',()=>{
  assert.equal(canonicalResourceIdentity('https://EXAMPLE.ORG:443/portal?tenant=12&item=7#page-2'),'https://example.org/portal?tenant=12&item=7');
  assert.notEqual(canonicalResourceIdentity('https://example.org/portal?tenant=12'),canonicalResourceIdentity('https://example.org/portal?tenant=13'));
  assert.notEqual(canonicalResourceIdentity('https://example.org/portal?a=1&a=2'),canonicalResourceIdentity('https://example.org/portal?a=2&a=1'));
  assert.throws(()=>canonicalResourceIdentity('https://user:secret@example.org/'),/rejected/);
  assert.throws(()=>canonicalResourceIdentity('file:///private/source.pdf'),/rejected/);
});
test('CLI never accepts shell or arbitrary module-loading flags',async()=>{
  await assert.rejects(runDistrictJobsCli({},['run','--shell','touch /tmp/not-executed']),/Unknown CLI flag/);
  await assert.rejects(runDistrictJobsCli({},['run','--handler-module','arbitrary.ts']),/Unknown CLI flag/);
});

test('exception diagnostics admit only the first real src frame and a bounded existing line',async()=>{
  const key=digest('synthetic diagnostic job'),prefix=`R1_EXCEPTION job=${key.slice(0,12)} step=residual_prepare `,source=new URL('../src/district-jobs.ts',import.meta.url);
  const error=Object.assign(new TypeError('synthetic-secret-message'),{code:'CIVIC_POLICY_BUSY',stack:`TypeError: synthetic-secret-message\n    at hiddenFunction (${source.href}:42:9)\n    at /private/secret.ts:3:4`});
  assert.equal(await formatDistrictJobException(key,'residual_prepare',error),prefix+'class=TypeError code=CIVIC_POLICY_BUSY at=src/district-jobs.ts:42\n');
  error.stack=`TypeError: synthetic-secret-message\n    at async ${fileURLToPath(source)}:123:4`;
  assert.equal(await formatDistrictJobException(key,'residual_prepare',error),prefix+'class=TypeError code=CIVIC_POLICY_BUSY at=src/district-jobs.ts:123\n');
  for(const frame of ['at parse (node:internal/parser:2:3)','at parse (/private/src/secret.ts:2:3)','at parse ('+new URL('../README.md',import.meta.url).href+':2:3)','at parse ('+source.href.replace('/src/','/src/../')+':2:3)']){
    error.stack=`TypeError: synthetic-secret-message\n    ${frame}\n    at later (${source.href}:99:1)`;
    assert.equal(await formatDistrictJobException(key,'residual_prepare',error),prefix+'class=TypeError code=CIVIC_POLICY_BUSY at=src/district-jobs.ts:99\n');
  }
  const text=await readFile(source,'utf8'),lineCount=text.split('\n').length-(text.endsWith('\n')?1:0);
  for(const location of [new URL('../src/SECRET_TOKEN.ts',import.meta.url).href+':42:9',source.href+':'+(lineCount+1)+':9',source.href+':0:9']){
    error.stack=`TypeError: synthetic-secret-message\n    at forged (${location})`;
    assert.equal(await formatDistrictJobException(key,'residual_prepare',error),prefix+'class=TypeError code=CIVIC_POLICY_BUSY at=none\n');
  }
  const injected=new Error(`synthetic-secret-message\n    at forged (${source.href}:42:9)`);
  assert.equal(await formatDistrictJobException(key,'residual_prepare',injected),prefix+'class=Error code=other at=none\n');
});
test('execution wrappers preserve original content-free exception provenance without following hostile causes',async()=>{
 const key=digest('synthetic wrapped exception'),prefix=`R1_EXCEPTION job=${key.slice(0,12)} step=assessment_b `,source=new URL('../src/district-assessment-broker.ts',import.meta.url);
 const cause=new DatabaseError('PRIVATE synthetic database detail',0,'error');
 cause.code='23514';cause.stack=`error: PRIVATE synthetic database detail\n    at /private/node_modules/pg/client.js:1:1\n    at async ${source.href}:100:9`;
 const hold=new DistrictExecutionHold('execution_exception',{cause});
 assert.equal(await formatDistrictJobException(key,'assessment_b',hold),prefix+'class=DatabaseError code=23514 at=src/district-assessment-broker.ts:100\n');
 assert.equal(await formatDistrictJobException(key,'assessment_b',new DistrictExecutionHold('execution_exception',{cause:hold})),prefix+'class=DatabaseError code=23514 at=src/district-assessment-broker.ts:100\n');
 let read=false;const hostile=new DistrictExecutionHold('execution_exception');Object.defineProperty(hostile,'cause',{get(){read=true;throw Error('PRIVATE');}});
 assert.match(await formatDistrictJobException(key,'assessment_b',hostile),/class=DistrictExecutionHold code=other/);assert.equal(read,false);
 const generic=new Error('PRIVATE',{cause});assert.match(await formatDistrictJobException(key,'assessment_b',generic),/class=Error code=other/);
 const cyclic=new DistrictExecutionHold('execution_exception');Object.defineProperty(cyclic,'cause',{value:cyclic});
 assert.match(await formatDistrictJobException(key,'assessment_b',cyclic),/class=DistrictExecutionHold code=other/);
});
test('exception diagnostics use closed constructor/code vocabularies and survive hostile accessors',async()=>{
  const key=digest('synthetic diagnostic job'),prefix=`R1_EXCEPTION job=${key.slice(0,12)} step=residual_prepare `;
  for(const name of ['PrivateDocumentName','Error','Bad Class','bad\nclass','x'.repeat(65),''])for(const code of ['SECRET_TOKEN_VALUE','ERR_SYNTHETIC','bad-code','lowercase','BAD\nCODE','X'.repeat(65),1,undefined]){
    const error={constructor:{name},code,message:'synthetic-secret-message',stack:'synthetic-secret-stack'};
    assert.equal(await formatDistrictJobException(key,'residual_prepare',error),prefix+'class=other code=other at=none\n');
  }
  const hostile=new Proxy({},{get(){throw Error('synthetic-secret-accessor');}});
  for(const error of [hostile,null,undefined])assert.equal(await formatDistrictJobException(key,'residual_prepare',error),prefix+'class=other code=other at=none\n');
  const error={constructor:{name:'X'.repeat(64)},code:'C'.repeat(64),stack:42};
  assert.equal(await formatDistrictJobException(key,'residual_prepare',error),prefix+'class=other code=other at=none\n');
  const spoofed=Object.assign(new Error('secret'),{constructor:{name:'PrivateDocumentName'},code:'SECRET_TOKEN_VALUE'});
  assert.equal(await formatDistrictJobException(key,'residual_prepare',spoofed),prefix+'class=Error code=other at=none\n');
});
test('exception diagnostics identify real built-in, library and project constructors',async()=>{
  const key=digest('synthetic diagnostic job'),prefix=`R1_EXCEPTION job=${key.slice(0,12)} step=residual_prepare `;
  const abort=await delay(0,undefined,{signal:AbortSignal.abort()}).catch(error=>error);
  const parsed=z.string().safeParse(null);assert.equal(parsed.success,false);
  for(const [error,name,code] of [
    [new Error('secret'),'Error','other'],[new RangeError('secret'),'RangeError','other'],
    [new SyntaxError('secret'),'SyntaxError','other'],[new ReferenceError('secret'),'ReferenceError','other'],
    [new AggregateError([],'secret'),'AggregateError','other'],[new DOMException('secret','AbortError'),'DOMException','other'],
    [new z.ZodError([]),'ZodError','other'],[new DatabaseError('secret',0,'error'),'DatabaseError','other'],
    [parsed.error,'ZodError','other'],
    [new CivicPolicyStateError('CIVIC_POLICY_BUSY'),'CivicPolicyStateError','CIVIC_POLICY_BUSY'],
    [new HostOptedOutError('private.example'),'HostOptedOutError','HOST_OPTED_OUT'],[abort,'AbortError','ABORT_ERR'],
    [new CivicPolicyStateError('SECRET_TOKEN_VALUE'),'CivicPolicyStateError','other'],
    [Object.assign(new Error('secret'),{code:'ENOENT'}),'Error','ENOENT'],
    [Object.assign(new Error('secret'),{code:'ERR_INVALID_ARG_TYPE'}),'Error','ERR_INVALID_ARG_TYPE'],
    [Object.assign(new Error('secret'),{code:'execution_exception'}),'Error','execution_exception'],
  ] as const){
    const line=await formatDistrictJobException(key,'residual_prepare',error);
    assert.ok(line.startsWith(prefix+'class='+name+' code='+code+' at='),line);
  }
  class PrivateDocumentName extends Error {}
  assert.equal(await formatDistrictJobException(key,'residual_prepare',new PrivateDocumentName('secret')),prefix+'class=other code=other at=none\n');
});

test('B failure stderr admits exactly a job prefix and one closed kind for a committed B execution hold',()=>{
 const key=digest('synthetic B diagnostic job'),receipt={outcome:'held_execution' as const,reasonCode:'omp_provider_failed' as const,versions:{ompFailureKind:'exit_nonzero'}};
 for(const kind of OmpFailureKindSchema.options)assert.equal(formatDistrictBFailure(key,'assessment_b',{...receipt,versions:{ompFailureKind:kind}}),`R1_B_FAILURE job=${key.slice(0,12)} kind=${kind}\n`);
 assert.equal(formatDistrictBFailure(key,'assessment_b',{...receipt,reasonCode:'budget_paused'}),`R1_B_FAILURE job=${key.slice(0,12)} kind=exit_nonzero\n`);
 for(let exit=0;exit<=255;exit++)assert.equal(formatDistrictBFailure(key,'assessment_b',{...receipt,versions:{...receipt.versions,ompContainerExitCode:String(exit)}}),`R1_B_FAILURE job=${key.slice(0,12)} kind=exit_nonzero exit=${exit}\n`);
 for(const exit of ['256','-1','1.5','NaN','Infinity','01','+1',' 1','1\nPRIVATE_PROVIDER_ERROR','PRIVATE_TOKEN',''])assert.equal(formatDistrictBFailure(key,'assessment_b',{...receipt,versions:{...receipt.versions,ompContainerExitCode:exit}}),`R1_B_FAILURE job=${key.slice(0,12)} kind=exit_nonzero\n`);
 for(const kind of ['PRIVATE_PROVIDER_ERROR','401 auth failed','exit_nonzero\\nSECRET_TOKEN','provider_error_unauthorized',''])assert.equal(formatDistrictBFailure(key,'assessment_b',{...receipt,versions:{ompFailureKind:kind}}),undefined);
 for(const step of ['assessment_a','assessment_c','assessment_reconcile','assessment_b\\nPRIVATE'])assert.equal(formatDistrictBFailure(key,step,receipt),undefined);
 assert.equal(formatDistrictBFailure('PRIVATE_JOB_KEY','assessment_b',receipt),undefined);
 assert.equal(formatDistrictBFailure(key,'assessment_b',{...receipt,reasonCode:'lease_lost'}),undefined);
 assert.equal(formatDistrictBFailure(key,'assessment_b',{...receipt,outcome:'succeeded',reasonCode:'completed'}),undefined);
 assert.equal(formatDistrictBFailure(key,'assessment_b',{...receipt,outcome:'held_quality',reasonCode:'quality_failed'}),undefined);
});

test('B decoder diagnostics admit only controlled checks on the correct committed dispositions',()=>{
 const key=digest('synthetic decoder diagnostics');
 for(const check of OmpDecodeCheckSchema.options){
  const versions={ompDecodeCheck:check,ompContainerExitCode:'0',ompOutputRejection:'PRIVATE_NOT_LOGGED'};
  assert.equal(formatDistrictBFailure(key,'assessment_b',{outcome:'held_execution',reasonCode:'omp_event_stream',versions}),`R1_B_FAILURE job=${key.slice(0,12)} kind=event_stream exit=0 check=${check}\n`);
  assert.equal(formatDistrictBFailure(key,'assessment_b',{outcome:'held_quality',reasonCode:'quality_failed',versions}),['output_json','output_schema'].includes(check)?`R1_B_FAILURE job=${key.slice(0,12)} kind=output_rejected exit=0 check=${check}\n`:undefined);
 }
 for(const check of ['PRIVATE_VALUE','output_json\nPRIVATE_TOKEN','',null]){
  const versions={ompDecodeCheck:check as unknown as string,ompContainerExitCode:'0'};
  assert.equal(formatDistrictBFailure(key,'assessment_b',{outcome:'held_execution',reasonCode:'omp_event_stream',versions}),undefined);
  assert.equal(formatDistrictBFailure(key,'assessment_b',{outcome:'held_quality',reasonCode:'quality_failed',versions}),undefined);
 }
});
