import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,lstat} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {extractDocumentText,runDocumentCommand} from '../src/district-document.ts';
import {CivicPolicyStateError,HostOptedOutError,recordHostOptOut,withManagedSourceScratch} from '../src/civic-opt-out.ts';
import type {ManagedSourceContext,ManagedSourceScratch} from '../src/civic-opt-out.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');

test('PDF/OCR source bytes and generated pages live only inside a pre-enrolled source scope',async t=>{
 const fixture=await createCivicPolicyTestContext(t),bytes=Buffer.from('%PDF-synthetic-source');
 const context:ManagedSourceContext={root:fixture.managedRoot,kind:'prepared',decisionId:fixture.decisionId,...fixture.policy,bindings:[{phase:'preparation-input',url:'https://council.test/document',sourceSha256:digest(bytes)}]};
 const text='Synthetic municipal source text with enough words to exercise deterministic document extraction. '.repeat(3);let temporary='',seen:ManagedSourceScratch|undefined;
 const result=await extractDocumentText(bytes,'application/pdf',context,async(file,args,scope)=>{
  if(seen)assert.equal(scope,seen);seen=scope;temporary=scope.directory;assert.ok(!relative(fixture.managedRoot,temporary).startsWith('..'));
  const inventory=JSON.parse(await readFile(join(fixture.policy.stateDir!,'inventory.json'),'utf8'));assert.equal(inventory.scratch[0].state,'active');assert.equal(inventory.scratch[0].sources[0].sourceSha256,digest(bytes));
  assert.equal((await lstat(join(temporary,'document.pdf'))).mode&0o777,0o600);assert.deepEqual(await readFile(join(temporary,'document.pdf')),bytes);
  if(file==='pdfinfo')return 'Pages: 1';if(file==='pdftotext')return '';
  if(file==='pdftoppm'){await writeFile(args.at(-1)!+'.png','synthetic generated OCR pixels',{mode:0o600});return '';}
  assert.equal(file,'tesseract');return text;
 });
 assert.equal(result.ocrUsed,true);assert.equal(result.text,text.trim());await assert.rejects(lstat(temporary),{code:'ENOENT'});
 const state=await readFile(join(fixture.policy.stateDir!,'inventory.json'),'utf8');assert.equal(state.includes('%PDF-synthetic-source'),false);assert.equal(state.includes('synthetic generated OCR pixels'),false);assert.equal(JSON.parse(state).scratch[0].state,'closed');
});

test('parser failure removes its enrolled source copy without scanning an OS temporary root',async t=>{
 const fixture=await createCivicPolicyTestContext(t),bytes=Buffer.from('%PDF-parser-failure');let temporary='';
 const context:ManagedSourceContext={root:fixture.managedRoot,kind:'prepared',decisionId:fixture.decisionId,...fixture.policy,bindings:[{phase:'preparation-input',url:'https://council.test/document',sourceSha256:digest(bytes)}]};
 await assert.rejects(extractDocumentText(bytes,'application/pdf',context,async(_file,_args,scope)=>{temporary=scope.directory;throw Error('Synthetic parser failure');}),/Synthetic parser failure/);
 await assert.rejects(lstat(temporary),{code:'ENOENT'});
});

test('missing authority, mismatched bytes and opted-out inputs reject before parser invocation or scratch creation',async t=>{
 const fixture=await createCivicPolicyTestContext(t),bytes=Buffer.from('%PDF-admission');let calls=0;
 const context:ManagedSourceContext={root:fixture.managedRoot,kind:'prepared',decisionId:fixture.decisionId,...fixture.policy,bindings:[{phase:'preparation-input',url:'https://council.test/document',sourceSha256:digest(bytes)}]};
 const command=async()=>{calls++;return 'Pages: 1';};
 await assert.rejects(extractDocumentText(bytes,'application/pdf',{...context,stateDir:join(fixture.root,'missing-authority')},command),CivicPolicyStateError);
 await assert.rejects(extractDocumentText(bytes,'application/pdf',{...context,bindings:[{...context.bindings[0],sourceSha256:digest('wrong')}]},command),CivicPolicyStateError);
 await recordHostOptOut({host:'council.test',reason:'municipality_objection'},fixture.policy);
 await assert.rejects(extractDocumentText(bytes,'application/pdf',context,command),HostOptedOutError);assert.equal(calls,0);await assert.rejects(lstat(fixture.managedRoot),{code:'ENOENT'});
});

test('native document command uses the enrolled process gate and bounds/sanitizes native diagnostics',async t=>{
 const fixture=await createCivicPolicyTestContext(t),binding={phase:'preparation-input' as const,url:'https://council.test/document',sourceSha256:digest('source')};let temporary='';
 await withManagedSourceScratch(fixture.managedRoot,[binding],async scope=>{
  temporary=scope.directory;
  assert.equal(await runDocumentCommand(process.execPath,['-e','process.stdout.write("bounded synthetic output")'],scope),'bounded synthetic output');
  await assert.rejects(runDocumentCommand(process.execPath,['-e','process.stderr.write("SYNTHETIC_PRIVATE_SOURCE");process.exit(1)'],scope),(error:unknown)=>error instanceof Error&&/Document command failed/.test(error.message)&&!error.message.includes('SYNTHETIC_PRIVATE_SOURCE'));
 },{decisionId:fixture.decisionId,kind:'prepared',purpose:'document',...fixture.policy});
 await assert.rejects(lstat(temporary),{code:'ENOENT'});
});

test('current policy errors are never converted into ordinary parser failures',async t=>{
 const fixture=await createCivicPolicyTestContext(t),binding={phase:'preparation-input' as const,url:'https://council.test/document',sourceSha256:digest('source')};
 await assert.rejects(withManagedSourceScratch(fixture.managedRoot,[binding],async scope=>{
  await recordHostOptOut({host:'council.test',reason:'municipality_objection'},fixture.policy);
  await runDocumentCommand(process.execPath,['-e','throw Error("must not execute")'],scope);
 },{decisionId:fixture.decisionId,purpose:'document',...fixture.policy}),HostOptedOutError);
});
