import test from 'node:test';
import assert from 'node:assert/strict';
import {describeOmpOutput,exactOmpJsonFence,OmpOutputStructureSchema,ompOutputStructureVersions,ompOutputStructureFromVersions} from '../src/district-omp-output-diagnostics.ts';
import {inspectOmpEvents,OmpAssessmentOutputRejected,ompOutputRejectionVersions,ompOutputRejectionFromVersions,handoffOmpAssessmentInput} from '../src/district-omp-b-runner.ts';
import {formatDistrictBFailure} from '../src/district-exception-diagnostics.ts';
import {canonicalJson,digest} from '../src/district-adapter-contract.ts';
import {StepReceiptSchema} from '../src/district-step-receipt.ts';
import {spawn} from 'node:child_process';
import {Writable} from 'node:stream';

const request=Buffer.from('Synthetic delivered request bytes');
const delivery={requestSha256:digest(request),systemPromptSha256:digest('Synthetic delivered control bytes'),stdin:{intendedBytes:request.length,deliveredBytes:request.length,deliveredSha256:digest(request),frameBytes:request.length+25}};
const valid={itemId:'synthetic',outcome:'supported',assertions:[],scores:{correctness:1,sources:1,usefulness:1},holdReasons:[],rationale:'Synthetic result',valueReview:null};
function stream(text:string){
 const message={role:'assistant',responseId:'synthetic',timestamp:1,provider:'anthropic',api:'anthropic-messages',model:'claude-haiku-5-5',stopReason:'stop',usage:{output:17},content:[{type:'text',text}]};
 return [{type:'session'},{type:'agent_start'},{type:'turn_start'},{type:'message_start',message:{role:'assistant'}},{type:'message_end',message},{type:'turn_end',message,toolResults:[]},{type:'agent_end',messages:[message]}].map(value=>JSON.stringify(value)).join('\n')+'\n';
}

test('accepted and rejected native outputs retain the same bounded production diagnostics and delivery hashes',()=>{
 for(const [text,accepted] of [[canonicalJson(valid),true],['```json\n'+canonicalJson(valid)+'\n```',true],['PRIVATE_PROSE\n'+canonicalJson(valid)+'\nPRIVATE_TRAILER',false],['{"PRIVATE_KEY":"PRIVATE_VALUE",}',false],['{}',false]] as const){
  let structure;
  if(accepted){const result=inspectOmpEvents(stream(text),0,delivery);assert.deepEqual(result.value,valid);structure=result.outputStructure;}
  else{
   let rejected:OmpAssessmentOutputRejected|undefined;
   try{inspectOmpEvents(stream(text),0,delivery);assert.fail('Must reject malformed output');}catch(error){assert.ok(error instanceof OmpAssessmentOutputRejected);rejected=error;}
   assert.ok(rejected.rejection.version==='omp-output-rejection-v3');structure=rejected.rejection.structure;
   const versions=ompOutputRejectionVersions(rejected.rejection);assert.deepEqual(ompOutputRejectionFromVersions(versions),rejected.rejection);
   assert.equal(ompOutputRejectionFromVersions({...versions,ompStructureDelivery:'{"requestSha256":"PRIVATE_VALUE"}'}),null);
  }
  assert.deepEqual(structure.delivery,{requestSha256:delivery.requestSha256,systemPromptSha256:delivery.systemPromptSha256});assert.deepEqual(structure.stdin,delivery.stdin);assert.equal(structure.completion.stopReason,'stop');assert.equal(structure.completion.outputTokens,17);
  const versions={...ompOutputStructureVersions(structure),transport:'vm-omp-docker',ompContainerExitCode:'0',...accepted?{}:{ompOutputRejectionVersion:'omp-output-rejection-v3',ompDecodeCheck:text==='{}'?'output_schema':'output_json'}};
  StepReceiptSchema.shape.versions.parse(versions);assert.ok(Object.values(versions).every(value=>Buffer.byteLength(value)<=256));
  const line=formatDistrictBFailure('a'.repeat(64),'assessment_b',{outcome:accepted?'succeeded':'held_quality',reasonCode:accepted?'completed':'quality_failed',versions});
  assert.ok(line);assert.match(line,new RegExp('kind=output_'+(accepted?'accepted':'rejected')));assert.match(line,/ structure=/);
  assert.doesNotMatch(canonicalJson(structure)+canonicalJson(versions)+line,/PRIVATE_/);
  assert.ok(line.length<2048);
 }
});

test('fence variants are observed without widening the exact accepted wrapper',()=>{
 for(const [prefix,suffix,opening,closing,exact] of [
  ['```json\n','\n```','json','exact',true],[' \r\n```json\r\n','\r\n```\t\r\n','json','whitespace',true],
  ['```JSON\n','\n```','JSON','exact',false],['```\n','\n```','unlabelled','exact',false],
  ['```json \n','\n```','other','exact',false],['```python\n','\n```','other','exact',false],
  ['```json\n','\n````','json','other',false],['','', 'none','none',false],
 ] as const){
  const text=prefix+'{}'+suffix,structure=describeOmpOutput(text,delivery,undefined);
  assert.deepEqual(structure.fence,{opening,closing,exactWrapper:exact});assert.equal(exactOmpJsonFence(text)!==undefined,exact);
  assert.equal(structure.objects.count,1);assert.deepEqual(structure.objects.offsets,[[prefix.length,prefix.length+2]]);
  assert.equal(structure.objects.leadingNonJson,prefix.length);assert.equal(structure.objects.trailingNonJson,suffix.length);
 }
 assert.equal(exactOmpJsonFence('```json\n{}\n```\n```json\n{}\n```'),undefined);
});

test('complete-object offsets are bounded observations, not recovery or acceptance',()=>{
 const quoted=JSON.stringify({key:'Braces { } and escaped " quote',array:[{nested:true}]}),text=' \n'+quoted+'\r\t';
 const result=describeOmpOutput(text,delivery,0);
 assert.deepEqual(result.lengths,{utf16:text.length,bytes:Buffer.byteLength(text),leadingWhitespace:2,trailingWhitespace:2});
 assert.deepEqual(result.objects,{count:1,offsets:[[2,text.length-2]],leadingNonJson:2,trailingNonJson:2});
 assert.deepEqual(result.syntax,{balance:0,minimum:0,unclosedString:false,unclosedContainers:0,mismatch:false,parseCategory:'valid',parsePosition:null,parseInput:'raw'});
 const many=describeOmpOutput('{} '.repeat(6),delivery,1);assert.equal(many.objects.count,6);assert.equal(many.objects.offsets.length,4);assert.equal(many.objects.leadingNonJson,null);assert.equal(many.objects.trailingNonJson,null);
 const malformed=describeOmpOutput('}{"PRIVATE":"unfinished',delivery,undefined);
 assert.equal(malformed.syntax.minimum,-1);assert.equal(malformed.syntax.unclosedString,true);assert.equal(malformed.syntax.unclosedContainers,1);assert.equal(malformed.syntax.mismatch,true);
 assert.equal(describeOmpOutput('[{}]',delivery,undefined).objects.count,0,'Objects inside arrays are not standalone top-level objects');
 assert.equal(describeOmpOutput(' \t\n',delivery,undefined).lengths.trailingWhitespace,0,'All-whitespace lengths do not overlap');
 assert.equal(describeOmpOutput('ä',delivery,undefined).lengths.bytes,2);
});

test('JSON parse observations contain closed categories and optional bounded positions, never parser prose',()=>{
 for(const text of ['', '{"PRIVATE":}', '{"PRIVATE":"unterminated', '{"PRIVATE":"bad\ncontrol"}', '{"PRIVATE":"\\q"}', 'PRIVATE_TEXT', '{} PRIVATE_TEXT']){
  const value=describeOmpOutput(text,delivery,Infinity);
  assert.notEqual(value.syntax.parseCategory,'valid');assert.ok(value.syntax.parsePosition===null||value.syntax.parsePosition<=text.length);
  assert.equal(value.completion.outputTokens,null);assert.doesNotMatch(canonicalJson(value),/PRIVATE/);
 }
 const value=describeOmpOutput('',delivery,undefined);assert.equal(value.syntax.parseCategory,'end');assert.equal(value.syntax.parsePosition,0);
 const wrapped=describeOmpOutput('```json\n{\n```',delivery,undefined);assert.equal(wrapped.syntax.parseInput,'wrapper');
});

test('structure codecs refuse unknown, oversized, missing and inconsistent fields at every slot',()=>{
 const value=describeOmpOutput('{}',delivery,Number.MAX_SAFE_INTEGER),versions=ompOutputStructureVersions(value);
 assert.deepEqual(ompOutputStructureFromVersions(versions),value);
 for(const key of Object.keys(versions)){const changed={...versions};delete changed[key];assert.equal(ompOutputStructureFromVersions(changed),null);}
 assert.equal(ompOutputStructureFromVersions({...versions,ompStructureVersion:'PRIVATE_VERSION'}),null);
 assert.equal(ompOutputStructureFromVersions({...versions,ompStructureLengths:'x'.repeat(257)}),null);
 assert.equal(ompOutputStructureFromVersions({...versions,ompStructureSyntax:canonicalJson({...value.syntax,parseCategory:'PRIVATE_TEXT'})}),null);
 assert.equal(OmpOutputStructureSchema.safeParse({...value,PRIVATE_KEY:'PRIVATE_VALUE'}).success,false);
 assert.equal(OmpOutputStructureSchema.safeParse({...value,objects:{...value.objects,offsets:[[1,3]]}}).success,false);
 assert.equal(OmpOutputStructureSchema.safeParse({...value,objects:{...value.objects,count:2}}).success,false);
 const worst={...value,lengths:{utf16:98304,bytes:98304,leadingWhitespace:0,trailingWhitespace:0},objects:{count:98304,offsets:[[10000,20000],[30000,40000],[50000,60000],[70000,98304]] as [number,number][],leadingNonJson:null,trailingNonJson:null},syntax:{...value.syntax,balance:-98304,minimum:-98304,unclosedContainers:98304,parsePosition:98304}};
 assert.ok(Object.values(ompOutputStructureVersions(worst)).every(slot=>Buffer.byteLength(slot)<=256));
});

test('literal historical v2 proofs retain their exact canonical bytes and hash after v3 cutover',()=>{
 const proof={version:'omp-output-rejection-v2' as const,check:'output_schema' as const,streamSha256:digest('Historical synthetic stream'),outputSha256:digest('Historical synthetic text'),issueCount:1,issues:[{code:'unrecognized_keys' as const,path:'$',keyCount:2}],outputNormalization:'single-json-fence-v1' as const};
 const before=canonicalJson(proof),versions=ompOutputRejectionVersions(proof),decoded=ompOutputRejectionFromVersions(versions);
 assert.equal(canonicalJson(decoded),before);assert.equal(digest(canonicalJson(decoded)),digest(before));assert.equal(versions.ompStructureVersion,undefined);
 assert.equal(ompOutputRejectionFromVersions({...versions,ompOutputRejectionVersion:'omp-output-rejection-v3'}),null,'v3 cannot omit structure');
});

test('single framed handoff survives a delayed pipe reader and wipes both input buffers',{timeout:10000},async t=>{
 const token=Buffer.from('sk-ant-oat-synthetic-private'),payload=Buffer.from(canonicalJson({synthetic:'x'.repeat(14000)})),expected=Buffer.from(payload),tokenBytes=token.length;
 // A real pipe reader waits on an IPC barrier, not a guessed wall-clock delay.
 const child=spawn(process.execPath,['-e',`process.send('ready');process.once('message',async()=>{const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);const bytes=Buffer.concat(chunks);process.stdout.write(bytes.subarray(bytes.indexOf(10)+1));process.disconnect();});`],{env:{PATH:'/usr/bin:/bin'},stdio:['pipe','pipe','pipe','ipc']});
 t.after(()=>{child.kill('SIGKILL');});
 const chunks:Buffer[]=[],errors:Buffer[]=[];child.stdout!.on('data',chunk=>chunks.push(Buffer.from(chunk)));child.stderr!.on('data',chunk=>errors.push(Buffer.from(chunk)));
 const ended=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('Synthetic delayed reader failed')));});
 await new Promise<void>(resolve=>child.once('message',()=>resolve()));
 const handing=handoffOmpAssessmentInput(child.stdin!,token,payload);
 child.send('read');const metadata=await handing;
 await ended;assert.equal(Buffer.concat(errors).length,0);assert.deepEqual(Buffer.concat(chunks),expected);
 assert.deepEqual(metadata,{intendedBytes:expected.length,deliveredBytes:expected.length,deliveredSha256:digest(expected),frameBytes:tokenBytes+1+expected.length});
 assert.ok(token.every(byte=>byte===0));assert.ok(payload.every(byte=>byte===0));assert.doesNotMatch(canonicalJson(metadata),/sk-ant|synthetic-private/);
});

test('managed handoff invokes one guarded write, waits for its delayed callback, and ends once',async()=>{
 const token=Buffer.from('synthetic-token'),payload=Buffer.from('{}'),originalToken=Buffer.from(token);
 let writes=0,ends=0,observed=Buffer.alloc(0),release:(()=>void)|undefined;
 const stdin=new Writable({write(chunk,_encoding,callback){writes++;release=()=>{observed=Buffer.from(chunk);callback();};},final(callback){ends++;callback();}});
 const handoff=handoffOmpAssessmentInput(stdin,token,payload);
 assert.deepEqual(token,originalToken,'Credentials remain intact until the write completes');
 assert.ok(release);release();
 await handoff;assert.equal(writes,1);assert.equal(ends,1);assert.equal(observed.toString(),'synthetic-token\n{}');
 assert.ok(token.every(byte=>byte===0));assert.ok(payload.every(byte=>byte===0));
});

test('aborted or failed handoff wipes the contiguous credential/request frame without success metadata',async()=>{
 for(const failure of ['abort','write'] as const){
  const token=Buffer.from('synthetic-token'),payload=Buffer.from('{}'),controller=new AbortController();
  let borrowed:Buffer|undefined;
  const stdin=new Writable({write(chunk,_encoding,callback){borrowed=chunk;if(failure==='write')callback(new Error('Synthetic closed failure'));}});
  const handed=handoffOmpAssessmentInput(stdin,token,payload,controller.signal);
  if(failure==='abort')controller.abort(new Error('Synthetic abort'));
  await assert.rejects(handed);assert.ok(borrowed);assert.ok(borrowed.every(byte=>byte===0));assert.ok(token.every(byte=>byte===0));assert.ok(payload.every(byte=>byte===0));
 }
});
