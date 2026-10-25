import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,readFile,rm,writeFile,lstat,symlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createStep8RecordedR1ProcessingPins,createStep8R2CurrentGeneration,assertStep8R1ReceiptRecordedPin,assertStep8R2JobCurrent,assertStep8R2DrainEvidence,assertStep8R2CutoverReady,STEP8_PROCESSING_CONTRACT_NAMES,STEP8_R2_DRAIN_EVIDENCE_MAX_AGE_MS} from '../src/r1-step8-current-policy.ts';
import {StepReceiptSchema,encodeStepReceipt} from '../src/district-step-receipt.ts';
import {digest} from '../src/district-adapter-contract.ts';
import * as r1Core from '../src/civic-opt-out.ts';
import {ParserReviewSchema} from '../src/district-parser-isolation.ts';
import {OmpReviewSchema} from '../src/district-omp-b-runner.ts';

const repo=fileURLToPath(new URL('..',import.meta.url)),gitRoot=resolve(repo,'..'),hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const PINNED_R1_READER_COMMIT='0526d11216592b23465f89cd7d780c956edcddff';
async function loadPinnedR1Reader(directory:string){
 const archiveRoot=join(directory,'pinned-r1-reader');
 await mkdir(archiveRoot,{mode:0o700});
 const archive=execFileSync('git',['-C',gitRoot,'archive','--format=tar',PINNED_R1_READER_COMMIT,'stadtstack-data/package.json','stadtstack-data/src','stadtstack-data/regional'],{maxBuffer:64*1024*1024});
 execFileSync('tar',['-xf','-','-C',archiveRoot],{input:archive});
 const historicalRoot=join(archiveRoot,'stadtstack-data');
 await symlink(join(repo,'node_modules'),join(historicalRoot,'node_modules'),'dir');
 const core=await import(pathToFileURL(join(historicalRoot,'src/civic-opt-out.ts')).href) as unknown as {
  readCivicPolicyInventory:(options:Record<string,unknown>)=>Promise<unknown>;
  CivicPolicyStateError:new(code?:string)=>Error&{code:string};
 };
 const reader=await import(pathToFileURL(join(historicalRoot,'src/r1-step8-managed-read-view.ts')).href) as unknown as {
  createReadOnlyManagedSourceAudit:(options:Record<string,unknown>)=>Promise<{finish:()=>Promise<void>}>;
 };
 return {core,reader};
}
test('pinned R1 reader loads its historical Core modules from the base commit',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'r1-pinned-reader-')),stateDir=join(directory,'policy'),authorityId='fixture:'+randomUUID();
 try{
  const historical=await loadPinnedR1Reader(directory),authority=await r1Core.provisionCivicPolicyAuthority({stateDir,authorityId}),policy={stateDir,authorityId,authoritySha256:authority.authoritySha256};
  const current=await r1Core.readCivicPolicyInventory(policy),historicalInventory=await historical.core.readCivicPolicyInventory(policy) as {inventoryId:string};
  assert.equal(historicalInventory.inventoryId,current.inventoryId);
  const before=await readFile(join(stateDir,'inventory.json')),audit=await historical.reader.createReadOnlyManagedSourceAudit(policy);
  await audit.finish();assert.deepEqual(await readFile(join(stateDir,'inventory.json')),before);
 }finally{await rm(directory,{recursive:true,force:true});}
});

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

const v2CodecPath=new URL('../src/civic-inventory-codec-v2.ts',import.meta.url);
test('PENDING Core v2 integration: valid committed manifest round-trips before the old R1 reader rejects it',{skip:existsSync(fileURLToPath(v2CodecPath))?false:'Pending merge of the Core v2 codec and migration API'},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'r2-core-v2-reader-')),stateDir=join(directory,'policy'),authorityId='fixture:'+randomUUID();
 try{
  const historical=await loadPinnedR1Reader(directory);
  // Core's v2 migration API is not exported in the R1 branch; this integration loads only after the v2 codec source is merged.
  const core=r1Core as unknown as {
   provisionCivicPolicyAuthority:(options:Record<string,unknown>)=>Promise<{authorityId:string;authoritySha256:string}>;
   registerManagedCacheRoot:(path:string,options:Record<string,unknown>)=>Promise<void>;
   readCivicPolicyInventory:(options:Record<string,unknown>)=>Promise<unknown>;
   migrateCivicPolicyInventoryV2:(options:Record<string,unknown>)=>Promise<{status:string}>;
  };
  // The v2 codec module does not exist yet in this branch, so its source is intentionally imported only inside this pending integration test.
  const codec=await import(v2CodecPath.href) as unknown as {V2ManifestSchema:{parse(value:unknown):{inventoryId:string}}};
  const policy={stateDir,authorityId},authority=await core.provisionCivicPolicyAuthority(policy),corePolicy={...policy,authoritySha256:authority.authoritySha256},root=join(directory,'managed-root');
  await mkdir(root,{mode:0o700});await core.registerManagedCacheRoot(root,{...corePolicy,kind:'fetch'});
  const before=await core.readCivicPolicyInventory(corePolicy) as {inventoryId:string},inventoryPath=join(stateDir,'inventory.json'),oldInventoryBytes=await readFile(inventoryPath);
  const historicalBefore=await historical.core.readCivicPolicyInventory(corePolicy) as {inventoryId:string};
  assert.equal(historicalBefore.inventoryId,before.inventoryId,'pinned R1 Core reads the pre-migration inventory');
  const historicalAudit=await historical.reader.createReadOnlyManagedSourceAudit(corePolicy);await historicalAudit.finish();
  const drain={schemaVersion:'civic-inventory-drain-v2',authoritySha256:authority.authoritySha256,inventorySha256:digest(oldInventoryBytes),observedAt:new Date().toISOString(),noReaders:true,noWriters:true,reference:'reviewed-fixture-drain',pendingScratch:[]};
  const drainProofBytes=Buffer.from(JSON.stringify(drain)),drainProofPath=join(directory,'drain.json'),drainSha256=digest(drainProofBytes);
  await writeFile(drainProofPath,drainProofBytes,{mode:0o600});
  const observation={schemaVersion:'stadtstack-r2-cutover-observation-v1',stateDir,authorityId,authoritySha256:authority.authoritySha256,observedAt:drain.observedAt,drainProofPath,activeLeases:[],oldReaderMarkers:[]},observationBytes=Buffer.from(JSON.stringify(observation)),observationPath=join(directory,'observation.json');
  await writeFile(observationPath,observationBytes,{mode:0o600});
  const script=join(repo,'scripts/r2-cutover-check.mjs'),check=JSON.parse(execFileSync(process.execPath,['--experimental-strip-types',script,observationPath,digest(observationBytes),drainSha256],{cwd:repo,encoding:'utf8'}));
  assert.equal(check.status,'cutover-ready');assert.equal(check.lockedInventorySha256,digest(oldInventoryBytes));
  const originalDateNow=Date.now,validTime=Date.parse(drain.observedAt)+1000,expiredTime=validTime+STEP8_R2_DRAIN_EVIDENCE_MAX_AGE_MS+1;let dateReads=0;
  try{
   Date.now=()=>dateReads++===0?validTime:expiredTime;
   await assert.rejects(assertStep8R2CutoverReady({observationBytes,observationSha256:digest(observationBytes),drainProofBytes,drainSha256}),/fresh locked evidence/);
   assert.ok(dateReads>1,'Core dry-run crossed the pinned evidence validity window');
  }finally{Date.now=originalDateNow;}
  const migrated=await core.migrateCivicPolicyInventoryV2({...corePolicy,drainPath:drainProofPath,drainSha256});
  assert.equal(migrated.status,'committed');
  const after=await core.readCivicPolicyInventory(corePolicy) as {inventoryId:string};
  assert.equal(after.inventoryId,before.inventoryId,'Core v2 preserves the inventory identity');
  assert.deepEqual(after,before,'Core v2 reader accepts the exact migrated logical inventory');
  const manifestBytes=await readFile(inventoryPath),manifest=codec.V2ManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  assert.equal(manifest.inventoryId,before.inventoryId);
  const historicalRejection=(error:unknown)=>error instanceof historical.core.CivicPolicyStateError&&error.code==='CIVIC_POLICY_INVENTORY_UNAVAILABLE';
  await assert.rejects(historical.core.readCivicPolicyInventory(corePolicy),historicalRejection);
  await assert.rejects(historical.reader.createReadOnlyManagedSourceAudit(corePolicy),historicalRejection);
  assert.ok((await readFile(inventoryPath)).equals(manifestBytes),'the pinned old R1 reader rejects without rewriting the committed v2 manifest');
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('cutover evidence requires independent hashes, a fresh matching drain and empty lease/reader census',async()=>{
 const authoritySha256=hash('authority'),inventorySha256=hash('inventory'),observedAt=new Date(Date.now()-1000).toISOString();
 const drain={schemaVersion:'civic-inventory-drain-v2',authoritySha256,inventorySha256,observedAt,noReaders:true,noWriters:true,reference:'reviewed-drain-evidence',pendingScratch:[]},drainProofBytes=Buffer.from(JSON.stringify(drain)),drainSha256=digest(drainProofBytes);
 const observation={schemaVersion:'stadtstack-r2-cutover-observation-v1',stateDir:'/tmp/civic-policy-fixture',authorityId:'fixture:'+randomUUID(),authoritySha256,observedAt,drainProofPath:'/tmp/drain-proof.json',activeLeases:[],oldReaderMarkers:[]},observationBytes=Buffer.from(JSON.stringify(observation)),observationSha256=digest(observationBytes);
 const input={observationBytes,observationSha256,drainProofBytes,drainSha256,now:Date.now()},revise=(changes:Record<string,unknown>)=>{const bytes=Buffer.from(JSON.stringify({...observation,...changes}));return {...input,observationBytes:bytes,observationSha256:digest(bytes)};};
 assert.deepEqual(assertStep8R2DrainEvidence(input),{observation,drain});
 assert.throws(()=>assertStep8R2DrainEvidence({...input,observationSha256:hash('wrong observation')}),/observation digest mismatch/);
 assert.throws(()=>assertStep8R2DrainEvidence({...input,drainSha256:hash('wrong drain')}),/drain-proof digest mismatch/);
 assert.throws(()=>assertStep8R2DrainEvidence(revise({activeLeases:['lease-1']})),/fresh locked evidence and no active leases or old readers/);
 assert.throws(()=>assertStep8R2DrainEvidence(revise({oldReaderMarkers:['reader-1042']})),/fresh locked evidence and no active leases or old readers/);
 assert.throws(()=>assertStep8R2DrainEvidence(revise({authoritySha256:hash('different authority')})),/fresh locked evidence/);
 assert.throws(()=>assertStep8R2DrainEvidence(revise({observedAt:new Date(Date.parse(observedAt)+1).toISOString()})),/fresh locked evidence/);
 const staleAt=new Date(Date.now()-STEP8_R2_DRAIN_EVIDENCE_MAX_AGE_MS-1000).toISOString(),staleDrain=Buffer.from(JSON.stringify({...drain,observedAt:staleAt}));
 assert.throws(()=>assertStep8R2DrainEvidence({...revise({observedAt:staleAt}),drainProofBytes:staleDrain,drainSha256:digest(staleDrain)}),/fresh locked evidence/);
 const futureAt=new Date(Date.now()+1000).toISOString(),futureDrain=Buffer.from(JSON.stringify({...drain,observedAt:futureAt}));
 assert.throws(()=>assertStep8R2DrainEvidence({...revise({observedAt:futureAt}),drainProofBytes:futureDrain,drainSha256:digest(futureDrain)}),/fresh locked evidence/);
 const staleObservationBytes=Buffer.from(JSON.stringify({...observation,observedAt:staleAt}));
 const staleInput={observationBytes:staleObservationBytes,observationSha256:digest(staleObservationBytes),drainProofBytes:staleDrain,drainSha256:digest(staleDrain),now:Date.parse(staleAt)+1};
 await assert.rejects(assertStep8R2CutoverReady(staleInput),/fresh locked evidence/);
});
test('cutover CLI rejects mismatched hashes, active leases and old-reader markers',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'r2-cutover-hash-'));
 try{
  const observationPath=join(directory,'observation.json'),script=join(repo,'scripts/r2-cutover-check.mjs');
  await writeFile(observationPath,'{}',{mode:0o600});
  const result=spawnSync(process.execPath,['--experimental-strip-types',script,observationPath,hash('different observation'),hash('drain proof')],{cwd:repo,encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stderr??'',/R2 observation digest mismatch/);
  const authoritySha256=hash('cli authority'),observedAt=new Date(Date.now()-1000).toISOString();
  const drain={schemaVersion:'civic-inventory-drain-v2',authoritySha256,inventorySha256:hash('cli inventory'),observedAt,noReaders:true,noWriters:true,reference:'cli-drain',pendingScratch:[]};
  const drainProofBytes=Buffer.from(JSON.stringify(drain)),drainPath=join(directory,'drain.json');
  await writeFile(drainPath,drainProofBytes,{mode:0o600});
  for(const census of [{activeLeases:['lease-1'],oldReaderMarkers:[]},{activeLeases:[],oldReaderMarkers:['reader-1']}]){
   const observation={schemaVersion:'stadtstack-r2-cutover-observation-v1',stateDir:join(directory,'fixture-state'),authorityId:'fixture-cli',authoritySha256,observedAt,drainProofPath:drainPath,...census};
   const bytes=Buffer.from(JSON.stringify(observation));await writeFile(observationPath,bytes,{mode:0o600});
   const blocked=spawnSync(process.execPath,['--experimental-strip-types',script,observationPath,digest(bytes),digest(drainProofBytes)],{cwd:repo,encoding:'utf8'});
   assert.equal(blocked.status,1);assert.match(blocked.stderr??'',/fresh locked evidence and no active leases or old readers/);
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('review-pin generator emits exact parser and OMP schemas only in its private draft root',async()=>{
 const home=await mkdtemp(join(tmpdir(),'r2-review-drafts-')),outDir=join(home,'.local/state/stadtstack-data/r2-review-pin-drafts');await mkdir(outDir,{recursive:true,mode:0o700});
 try{
  const input={schemaVersion:'stadtstack-r2-review-pin-draft-input-v1',parser:{imageId:'sha256:'+('a'.repeat(64)),securityReviewId:'synthetic-review',reviewedBy:'synthetic-reviewer',reviewedAt:new Date().toISOString(),dockerSocket:'/run/synthetic-parser.sock'},omp:{imageId:'sha256:'+('b'.repeat(64)),ompBinarySha256:hash('synthetic omp binary'),hostResolverBinarySha256:hash('synthetic host resolver'),dockerDaemonId:'synthetic-daemon',securityReviewId:'synthetic-omp-review',reviewedBy:'synthetic-reviewer',reviewedAt:new Date().toISOString(),dockerSocket:'/run/synthetic-omp.sock'}};
  const inputPath=join(home,'input.json');await writeFile(inputPath,JSON.stringify(input),{mode:0o600});
  const script=join(repo,'scripts/r2-review-pin-drafts.mjs'),env={...process.env,HOME:home},stdout=execFileSync(process.execPath,['--experimental-strip-types',script,inputPath,outDir],{cwd:repo,encoding:'utf8',maxBuffer:1024*1024,env});
  assert.equal(JSON.parse(stdout).status,'drafts_written');
  const parserPath=join(outDir,'parser-isolation-review.draft.json'),ompPath=join(outDir,'omp-b-review.draft.json'),parserBytes=await readFile(parserPath),ompBytes=await readFile(ompPath);
  const parser=ParserReviewSchema.parse(JSON.parse(parserBytes.toString('utf8'))),omp=OmpReviewSchema.parse(JSON.parse(ompBytes.toString('utf8')));
  assert.equal(parser.imageId,input.parser.imageId);assert.equal(omp.imageId,input.omp.imageId);assert.equal(omp.hostResolverBinarySha256,input.omp.hostResolverBinarySha256);
  assert.equal((await lstat(parserPath)).mode&0o022,0,'generated file must not be group/world writable under any umask');
  assert.equal((await lstat(ompPath)).mode&0o022,0,'generated file must not be group/world writable under any umask');
  assert.equal((await lstat(outDir)).mode&0o077,0,'draft root is owner-private');
  assert.equal(Object.hasOwn(parser,'approved'),false);assert.equal(Object.hasOwn(omp,'authorization'),false);
  for(const name of ['civic-policy','cas','cache']){
   const unsafeRoot=join(home,'.local/state/stadtstack-data',name);await mkdir(unsafeRoot,{recursive:true,mode:0o700});
   const rejected=spawnSync(process.execPath,['--experimental-strip-types',script,inputPath,unsafeRoot],{cwd:repo,encoding:'utf8',env});
   assert.equal(rejected.status,1);assert.match(rejected.stderr??'',/owner-private dedicated R2 review-pin draft root/);
   assert.equal(existsSync(join(unsafeRoot,'parser-isolation-review.draft.json')),false);
  }
 }finally{await rm(home,{recursive:true,force:true});}
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
