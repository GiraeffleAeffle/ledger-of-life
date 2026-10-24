import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {createStep8RecordedR1ProcessingPins,createStep8R2CurrentGeneration,assertStep8R1ReceiptRecordedPin,assertStep8R2JobCurrent,assertStep8R2CutoverReady,STEP8_PROCESSING_CONTRACT_NAMES} from '../src/r1-step8-current-policy.ts';
import {StepReceiptSchema,encodeStepReceipt} from '../src/district-step-receipt.ts';
import {digest} from '../src/district-adapter-contract.ts';
import {CivicPolicyStateError,provisionCivicPolicyAuthority} from '../src/civic-opt-out.ts';
import {createReadOnlyManagedSourceAudit} from '../src/r1-step8-managed-read-view.ts';
import {ParserReviewSchema} from '../src/district-parser-isolation.ts';
import {OmpReviewSchema} from '../src/district-omp-b-runner.ts';

const repo=fileURLToPath(new URL('..',import.meta.url)),hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const contractSet=Object.fromEntries(STEP8_PROCESSING_CONTRACT_NAMES.map((name,index)=>[name,hash('R1:'+index)])) as Record<(typeof STEP8_PROCESSING_CONTRACT_NAMES)[number],string>;
const receipt=()=>StepReceiptSchema.parse({version:'district-step-receipt-v1',canonicalizationVersion:'district-json-v1',id:randomUUID(),runId:randomUUID(),jobKey:hash('old-r1-job'),step:'residual_extract',lane:'residual_extraction',sourceId:'fixture-source',municipalityId:'fixture-town',attempt:1,leaseToken:'1',category:'production',dependencyReceiptIds:[],enqueuedAt:'2026-10-24T00:00:00.000Z',startedAt:'2026-10-24T00:00:00.000Z',finishedAt:'2026-10-24T00:00:01.000Z',queueWaitMs:0,elapsedMs:1000,cpuUserMicros:10,cpuSystemMicros:5,outcome:'succeeded',reasonCode:'completed',inputHashes:[],outputHashes:[],policyProofSha256:null,originProofSha256:null,versions:{},cache:{disposition:'miss',originalGenerationReceiptId:null},provider:null,counts:{bytes:null,pages:null,ocrPages:null,rows:null,spans:null,candidates:null,acceptedFacts:null,heldFacts:null,distinctCases:null}});

test('R1 receipts validate only against their recorded pin set; R2 requires current generation and contract pins',()=>{
 const r1Pins=createStep8RecordedR1ProcessingPins({processingCommit:'a'.repeat(40),contracts:contractSet}),old=encodeStepReceipt(receipt());
 assert.doesNotThrow(()=>assertStep8R1ReceiptRecordedPin({contractFamily:'residualJob',semanticContractSha256:r1Pins.contracts.residualJob,jobKey:old.receipt.jobKey,receipt:old.receipt,receiptSha256:old.sha256,recordedPins:r1Pins}));
 assert.throws(()=>assertStep8R1ReceiptRecordedPin({contractFamily:'residualJob',semanticContractSha256:hash('different'),jobKey:old.receipt.jobKey,receipt:old.receipt,receiptSha256:old.sha256,recordedPins:r1Pins}),/recorded processing pin/);
 assert.throws(()=>assertStep8R1ReceiptRecordedPin({contractFamily:'residualJob',semanticContractSha256:r1Pins.contracts.residualJob,jobKey:old.receipt.jobKey,receipt:old.receipt,receiptSha256:hash('tampered receipt'),recordedPins:r1Pins}));
 const r2Contracts=Object.fromEntries(STEP8_PROCESSING_CONTRACT_NAMES.map((name,index)=>[name,hash('R2:'+index)])) as Record<(typeof STEP8_PROCESSING_CONTRACT_NAMES)[number],string>;
 const current=createStep8R2CurrentGeneration({processingCommit:'b'.repeat(40),fingerprintReportSha256:hash('final fingerprint report'),contracts:r2Contracts});
 const currentJob={processingGenerationSha256:current.generationSha256,contractFamily:'residualJob' as const,semanticContractSha256:current.contracts.residualJob};
 assert.equal(assertStep8R2JobCurrent(current,currentJob),current.generationSha256);
 assert.throws(()=>assertStep8R2JobCurrent(current,{contractFamily:'residualJob',semanticContractSha256:current.contracts.residualJob}));
 assert.throws(()=>assertStep8R2JobCurrent(current,{processingGenerationSha256:current.generationSha256,contractFamily:'residualJob'}));
 assert.throws(()=>assertStep8R2JobCurrent(current,{...currentJob,processingGenerationSha256:r1Pins.pinSetSha256}));
 assert.throws(()=>assertStep8R2JobCurrent(current,{...currentJob,semanticContractSha256:r1Pins.contracts.residualJob}));
 assert.throws(()=>assertStep8R2JobCurrent(current,{...currentJob,semanticContractSha256:hash('mismatch')}));
 assert.throws(()=>createStep8R2CurrentGeneration({processingCommit:'b'.repeat(40),fingerprintReportSha256:hash('report'),contracts:{...r2Contracts,ompRunner:undefined as unknown as string}}));
});

// Exact wire fields from Core's strict V2ManifestSchema (r2-core-codec d04e61a);
// kept as a local adapter until that source is merged into this worktree.
const V2ManifestSchema=z.object({schemaVersion:z.literal('civic-inventory-v2'),codecVersion:z.literal(2),canonicalizationVersion:z.literal(1),layoutVersion:z.literal(2),inventoryId:z.uuid(),generation:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().positive().max(480*1024*1024),aggregateBytes:z.number().int().positive(),largestFileBytes:z.number().int().positive().max(480*1024*1024),previousManifestSha256:z.string().regex(/^[a-f0-9]{64}$/),v2Writes:z.number().int().nonnegative(),writeBarrierSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),migration:z.object({preparedSha256:z.string().regex(/^[a-f0-9]{64}$/),oldManifestSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()}).strict().superRefine((value,ctx)=>{if((value.v2Writes===0)!==(value.writeBarrierSha256===null))ctx.addIssue({code:'custom',message:'Manifest write barrier mismatch'});});

test('the old R1 read-only inventory reader rejects the committed strict v2 manifest',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'r2-old-reader-')),stateDir=join(directory,'policy'),authorityId='fixture:'+randomUUID();
 try{
  const authority=await provisionCivicPolicyAuthority({stateDir,authorityId});
  const manifest=V2ManifestSchema.parse({schemaVersion:'civic-inventory-v2',codecVersion:2,canonicalizationVersion:1,layoutVersion:2,inventoryId:randomUUID(),generation:hash('v2 generation'),bytes:1,aggregateBytes:1,largestFileBytes:1,previousManifestSha256:hash('old manifest'),v2Writes:0,writeBarrierSha256:null,migration:{preparedSha256:hash('prepared checkpoint'),oldManifestSha256:hash('old manifest')}});
  const bytes=Buffer.from(JSON.stringify(manifest)+'\n');await writeFile(join(stateDir,'inventory.json'),bytes,{mode:0o600});
  await assert.rejects(createReadOnlyManagedSourceAudit({stateDir,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256}),error=>error instanceof CivicPolicyStateError);
  assert.deepEqual(await readFile(join(stateDir,'inventory.json')),bytes);
  assert.equal((await readdir(stateDir)).includes('inventory.lock'),false,'the old read-only path does not create a writer lock');
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('cutover readiness refuses active leases and old-reader markers, accepting only matched empty observations',async()=>{
 const authoritySha256=hash('authority'),inventorySha256=hash('inventory'),observedAt=new Date(Date.now()-1000).toISOString();
 const drain={schemaVersion:'civic-inventory-drain-v2',authoritySha256,inventorySha256,observedAt,noReaders:true,noWriters:true,reference:'reviewed-drain-evidence',pendingScratch:[]},drainProofBytes=Buffer.from(JSON.stringify(drain)+'\n'),drainSha256=digest(drainProofBytes);
 const input={authoritySha256,inventorySha256,observedAt,drainProofBytes,drainSha256,activeLeases:[] as string[],oldReaderMarkers:[] as string[],now:Date.parse(observedAt)+1};
 assert.deepEqual(assertStep8R2CutoverReady(input),{authoritySha256,inventorySha256,drainSha256});
 assert.throws(()=>assertStep8R2CutoverReady({...input,activeLeases:['lease-1']}),/active leases or old readers/);
 assert.throws(()=>assertStep8R2CutoverReady({...input,oldReaderMarkers:['reader-1042']}),/active leases or old readers/);
 assert.throws(()=>assertStep8R2CutoverReady({...input,inventorySha256:hash('different inventory')}));
 assert.throws(()=>assertStep8R2CutoverReady({...input,observedAt:new Date(Date.parse(observedAt)+1).toISOString()}));
 assert.throws(()=>assertStep8R2CutoverReady({...input,drainSha256:hash('wrong bytes')}));
 const directory=await mkdtemp(join(tmpdir(),'r2-cutover-check-'));
 try{
  const script=join(repo,'scripts/r2-cutover-check.mjs'),drainProofPath=join(directory,'drain.json'),observationPath=join(directory,'observation.json');
  await writeFile(drainProofPath,drainProofBytes,{mode:0o600});
  const observation={schemaVersion:'stadtstack-r2-cutover-observation-v1',authoritySha256,inventorySha256,observedAt,drainProofPath,drainSha256,activeLeases:[],oldReaderMarkers:[]};
  await writeFile(observationPath,JSON.stringify(observation)+'\n',{mode:0o600});
  assert.equal(JSON.parse(execFileSync(process.execPath,['--experimental-strip-types',script,observationPath],{cwd:repo,encoding:'utf8'})).status,'cutover-ready');
  for(const blocked of [{activeLeases:['lease-1']},{oldReaderMarkers:['reader-1042']}]){await writeFile(observationPath,JSON.stringify({...observation,...blocked})+'\n',{mode:0o600});const result=spawnSync(process.execPath,['--experimental-strip-types',script,observationPath],{cwd:repo,encoding:'utf8'});assert.equal(result.status,1);assert.match(result.stderr??'',/R2 cutover requires no active leases or old readers/);}
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('review-pin generator emits exact parser and OMP exported schemas as non-root drafts',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'r2-review-drafts-')),outDir=join(directory,'drafts');await mkdir(outDir,{mode:0o700});
 try{
  const input={schemaVersion:'stadtstack-r2-review-pin-draft-input-v1',parser:{imageId:'sha256:'+('a'.repeat(64)),securityReviewId:'synthetic-review',reviewedBy:'synthetic-reviewer',reviewedAt:new Date().toISOString(),dockerSocket:'/run/synthetic-parser.sock'},omp:{imageId:'sha256:'+('b'.repeat(64)),ompBinarySha256:hash('synthetic omp binary'),hostResolverBinarySha256:hash('synthetic host resolver'),dockerDaemonId:'synthetic-daemon',securityReviewId:'synthetic-omp-review',reviewedBy:'synthetic-reviewer',reviewedAt:new Date().toISOString(),dockerSocket:'/run/synthetic-omp.sock'}};
  const inputPath=join(directory,'input.json');await writeFile(inputPath,JSON.stringify(input)+'\n',{mode:0o600});
  const script=join(repo,'scripts/r2-review-pin-drafts.mjs'),stdout=execFileSync(process.execPath,['--experimental-strip-types',script,inputPath,outDir],{cwd:repo,encoding:'utf8',maxBuffer:1024*1024});
  assert.equal(JSON.parse(stdout).status,'drafts_written');
  const parserBytes=await readFile(join(outDir,'parser-isolation-review.draft.json')),ompBytes=await readFile(join(outDir,'omp-b-review.draft.json'));
  const parser=ParserReviewSchema.parse(JSON.parse(parserBytes.toString('utf8'))),omp=OmpReviewSchema.parse(JSON.parse(ompBytes.toString('utf8')));
  assert.equal(parser.imageId,input.parser.imageId);assert.equal(omp.imageId,input.omp.imageId);assert.equal(omp.hostResolverBinarySha256,input.omp.hostResolverBinarySha256);
  assert.equal((await lstat(join(outDir,'parser-isolation-review.draft.json'))).mode&0o777,0o644);
  assert.equal(Object.hasOwn(parser,'approved'),false);assert.equal(Object.hasOwn(omp,'authorization'),false);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('fingerprint report measures all fourteen exported contract families in fresh processes with closures',()=>{
 const script=join(repo,'scripts/r2-contract-fingerprints.mjs'),stdout=execFileSync(process.execPath,['--experimental-strip-types',script,repo],{cwd:repo,encoding:'utf8',maxBuffer:16*1024*1024}),report=JSON.parse(stdout);
 assert.equal(report.schemaVersion,'stadtstack-r2-contract-fingerprint-report-v1');assert.equal(report.contractCount,14);
 assert.deepEqual(Object.keys(report.contracts).sort(),[...STEP8_PROCESSING_CONTRACT_NAMES].sort());
 for(const entry of Object.values(report.contracts) as Array<{contractSha256:string;sourceFiles:Array<{path:string;sha256:string}>;exportedValue:unknown}>){
  assert.match(entry.contractSha256,/^[a-f0-9]{64}$/);assert.ok(entry.sourceFiles.length);assert.ok(entry.sourceFiles.every(source=>/^[a-f0-9]{64}$/.test(source.sha256)));
 }
 assert.match(report.fingerprintSetSha256,/^[a-f0-9]{64}$/);assert.equal(report.method.includes('fresh Node process'),true);
 const parserRunner=report.contracts.parserIsolation;assert.ok(parserRunner.sourceFiles.some((source:{path:string})=>source.path==='src/district-parser-worker.py'),'parser runner closure binds the worker image contents');
});
