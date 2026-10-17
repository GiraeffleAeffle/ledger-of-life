import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Step8InputSchema,step8ReadPlan} from '../src/r1-step8.ts';
import {loadPriorPublicationRelease,preloadPriorPublicationReleases} from '../src/district-publication-predecessor.ts';
import {historicalKnowledgeRecords} from '../src/publish.ts';
import {PublicKnowledgeRecordSchema,knowledgeEvidenceHash} from '../src/district-schema.ts';
import {knowledgeChangeRecord} from '../src/changes.ts';
import {assertStep8ProcessingPin,assertStep8NativeBStep} from '../src/r1-step8-current-policy.ts';
import {OMP_NATIVE_STREAM_VERSION} from '../src/district-omp-b-runner.ts';

const execute=promisify(execFile),hash='a'.repeat(64),pin={path:'/synthetic/pinned-input',sha256:hash},at='2026-10-15T00:00:00.000Z';
const input={schemaVersion:'stadtstack-r1-step8-v1',campaign:pin,expectedSources:1,expectedDocuments:1,seals:[{sealResult:pin,jobKeys:[hash],reconciliationJobKeys:[]}],structuredRunIds:['3fe33cb6-fb63-4151-b56d-e94271c0d0af'],registry:pin,privateProvenance:pin,staging:[{...pin,destination:'catalogue.json'}],priorRelease:{gitCommit:'b'.repeat(40),manifestSha256:hash,releaseId:hash,directory:'release'},asOf:'2026-10-15',clocks:{recordsGeneratedAt:at,quarantineGeneratedAt:at,coverageGeneratedAt:at,qualityGeneratedAt:at,manifestGeneratedAt:at},casRoot:'/synthetic/cas',outputRoot:'/synthetic/cache/candidate',policy:{stateDir:'/synthetic/policy',authorityId:'synthetic',authoritySha256:hash}};
const currentGeneration={processingCommit:'a'.repeat(40),catalogue:pin,processingReview:pin,assessmentQueueContractSha256:hash,projectionVersion:'assessment-source-record-v2',B:{jobContractSha256:hash,runnerContractSha256:hash,runnerOutputContractSha256:hash,nativeStreamVersion:OMP_NATIVE_STREAM_VERSION,thinking:'medium',receiptVersion:'assessment-receipt-v2',selector:'anthropic/claude-sonnet-5-5',transport:'vm-omp'}};

test('operator plan is closed, explicit and never claims execution/value acceptance',()=>{
 const parsed=Step8InputSchema.parse({...input,currentGeneration}),plan=step8ReadPlan(parsed);
 assert.deepEqual(plan.writes,[]);assert.equal(plan.network,false);assert.equal(plan.providers,false);
 assert.equal(plan.reads.priorRelease.directory,'release');assert.ok(plan.notAuthorized.includes('value acceptance (step 9)'));
 for(const field of ['priorRelease','privateProvenance','clocks','asOf','seals','structuredRunIds','currentGeneration'])assert.throws(()=>Step8InputSchema.parse({...input,currentGeneration,[field]:undefined}));
 assert.throws(()=>Step8InputSchema.parse({...input,currentGeneration,allowLiveFallback:true}));
 assert.ok(plan.reads.database.includes('district_pipeline.r1_codex_allowance_intents'));
 assert.equal(plan.reads.allowance.approvals.length,5);assert.equal(plan.reads.allowance.approvals.at(-1)!.sha256,'12f110244241e0294148cafc5fe13319b627b692136dfbfe18d61022f5e9b7d2');assert.equal(plan.reads.allowance.bounds.paidMicroUsd,0);assert.equal(plan.reads.allowance.bounds.maxExtraCallsCohort,100);
 assert.throws(()=>Step8InputSchema.parse({...input,currentGeneration:{...currentGeneration,B:{...currentGeneration.B,receiptVersion:'assessment-receipt-v1'}}}));
});

test('operator processing selection follows the active confirmed pin, not a compiled window hash',()=>{
 const policy=Step8InputSchema.parse({...input,currentGeneration}).currentGeneration;
 const catalogue={processingCodeRevision:policy.processingCommit.slice(0,7),processingPinReview:{...pin,path:'pinned-input'}};
 const review={activation:'confirmed',to:{commit:policy.processingCommit},contracts:{current:{assessmentQueue:policy.assessmentQueueContractSha256},assessmentBJobContract:policy.B.jobContractSha256,ompRunnerContract:policy.B.runnerContractSha256,ompRunnerOutputContract:policy.B.runnerOutputContractSha256}};
 assert.doesNotThrow(()=>assertStep8ProcessingPin(policy,catalogue,review));
 const next=structuredClone(policy);next.processingCommit='b'.repeat(40);next.B.jobContractSha256='b'.repeat(64);next.B.runnerContractSha256='c'.repeat(64);next.B.runnerOutputContractSha256='d'.repeat(64);
 const nextCatalogue={...catalogue,processingCodeRevision:next.processingCommit.slice(0,7)},nextReview={...review,to:{commit:next.processingCommit},contracts:{...review.contracts,assessmentBJobContract:next.B.jobContractSha256,ompRunnerContract:next.B.runnerContractSha256,ompRunnerOutputContract:next.B.runnerOutputContractSha256}};
 assert.doesNotThrow(()=>assertStep8ProcessingPin(next,nextCatalogue,nextReview));
 assert.throws(()=>assertStep8ProcessingPin(next,nextCatalogue,review));
 assert.throws(()=>assertStep8ProcessingPin(policy,catalogue,{...review,activation:'pending'}));
 assert.throws(()=>assertStep8ProcessingPin(policy,{...catalogue,processingPinReview:{...pin,sha256:'b'.repeat(64)}},review));
 assert.throws(()=>assertStep8ProcessingPin(policy,{...catalogue,processingPinReview:{...pin,path:'/other/historical-review.json'}},review));
 for(const field of ['assessmentBJobContract','ompRunnerContract','ompRunnerOutputContract'] as const)assert.throws(()=>assertStep8ProcessingPin(policy,catalogue,{...review,contracts:{...review.contracts,[field]:'b'.repeat(64)}}));
 assert.throws(()=>assertStep8ProcessingPin(policy,catalogue,{...review,contracts:{...review.contracts,current:{assessmentQueue:'b'.repeat(64)}}}));
});

test('operator native B admission rejects stale contracts, runners and stream versions independently',()=>{
 const policy=Step8InputSchema.parse({...input,currentGeneration}).currentGeneration;
 const spec={semanticContractSha256:policy.B.jobContractSha256,selector:{transport:'vm-omp',requestedModel:'claude-sonnet-5-5',runnerOutputContractSha256:policy.B.runnerOutputContractSha256}},versions={runnerContractSha256:policy.B.runnerContractSha256,ompNativeStreamVersion:policy.B.nativeStreamVersion,ompThinking:policy.B.thinking};
 assert.doesNotThrow(()=>assertStep8NativeBStep(policy,spec,versions));
 assert.throws(()=>assertStep8NativeBStep(policy,{...spec,semanticContractSha256:'b'.repeat(64)},versions));
 assert.throws(()=>assertStep8NativeBStep(policy,{...spec,selector:{...spec.selector,runnerOutputContractSha256:'b'.repeat(64)}},versions));
 assert.throws(()=>assertStep8NativeBStep(policy,{...spec,selector:{...spec.selector,requestedModel:'claude-haiku-5-5'}},versions));
 for(const [field,value] of [['runnerContractSha256','b'.repeat(64)],['ompNativeStreamVersion','omp-native-stream-v1'],['ompNativeStreamVersion',''],['ompThinking','low'],['ompOutputNormalization','single-json-fence-v1']])assert.throws(()=>assertStep8NativeBStep(policy,spec,{...versions,[field]:value}));
});

test('offline bootstrap denies providers, HTTP, DNS, TCP and arbitrary child processes',async()=>{
 const guard=fileURLToPath(new URL('../scripts/r1-step8-offline.cjs',import.meta.url));
 const script=`const assert=require('node:assert/strict'),cp=require('node:child_process'),net=require('node:net'),dns=require('node:dns');
 assert.throws(()=>fetch('https://example.org'),/offline guard/);
 assert.throws(()=>require('node:https').get('https://example.org'),/offline guard/);
 assert.throws(()=>dns.lookup('example.org',()=>{}),/offline guard/);
 assert.throws(()=>dns.resolveMx('example.org',()=>{}),/offline guard/);
 assert.throws(()=>dns.promises.resolveTxt('example.org'),/offline guard/);
 assert.throws(()=>new dns.Resolver(),/offline guard/);
 assert.throws(()=>new (require('node:dgram').Socket)('udp4'),/offline guard/);
 assert.throws(()=>net.connect({host:'127.0.0.1',port:443}),/offline guard/);
 assert.throws(()=>cp.spawn('codex',['--version']),/offline guard/);
 assert.throws(()=>cp.execFile('git',['fetch']),/offline guard/);
 assert.equal(process.env.STADTSTACK_STEP8_OFFLINE,'1');`;
 await execute(process.execPath,['--require',guard,'-e',script]);
});

test('authentic live 0.3.2 predecessor selects release/, not the distinct historical out/ snapshot',async()=>{
 const prior={gitCommit:'57bddbbd8b84b0634229ad9cd45b689bda7271ea',directory:'release' as const,manifestSha256:'85b9236328402364ee1211ffe274933d3eaf0ff52c976a39720920337cc866b8',releaseId:'4ceebf75374df54c51bcf4a212c73770186a1a6db502423be7f108b665096691'},paths=['core/strausberg-facts.json','core/release-manifest.json','knowledge/records.json'];
 const loaded=await loadPriorPublicationRelease(prior,paths,at);
 assert.equal(loaded.manifest.id,prior.releaseId);assert.equal(loaded.priorRelease.directory,'release');
 const cache=await preloadPriorPublicationReleases([{prior,paths,targetGeneratedAt:at}]);
 assert.deepEqual((await loadPriorPublicationRelease(prior,paths,at,undefined,cache)).manifestBytes,loaded.manifestBytes);
 const archive=JSON.parse(loaded.files.get('knowledge/records.json')!.toString('utf8')),original=JSON.stringify(archive),historical=historicalKnowledgeRecords(archive);
 assert.ok(historical.length>0);assert.equal(JSON.stringify(archive),original);
 assert.deepEqual(historical.map(knowledgeChangeRecord).map(record=>record.id),archive.records.map((record:{id:string})=>record.id));
 const first={...archive.records[0],kind:'text_model',verification:{...archive.records[0].verification,kind:'text_model'}};first.verification.evidenceHash=knowledgeEvidenceHash(first);
 assert.equal(PublicKnowledgeRecordSchema.safeParse(first).success,false,'historical municipality-name grouping is not current identity admission');
 assert.throws(()=>historicalKnowledgeRecords({...archive,schemaVersion:'stadtstack-knowledge-v3'}));
 await assert.rejects(loadPriorPublicationRelease({...prior,directory:'out'},paths,at),/manifest digest mismatch/);
 await assert.rejects(loadPriorPublicationRelease({...prior,directory:'out'},paths,at,undefined,cache),/cache miss/);
 await assert.rejects(loadPriorPublicationRelease(prior,paths,at,prior.releaseId),/earlier baseline/);
});
