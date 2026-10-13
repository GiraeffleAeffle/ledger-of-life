import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Pool} from 'pg';
import {canonicalJson,digest,semanticHash,observation} from '../src/district-adapter-contract.ts';
import {DistrictCas} from '../src/district-cas.ts';
import type {CasPutOptions} from '../src/district-cas.ts';
import {DistrictJobStore,migrateDistrictJobs} from '../src/district-jobs.ts';
import {createPolicyReceipt,recheckPolicyReceipt} from '../src/district-policy-receipt.ts';
import {persistR1Representation} from '../src/district-r1-state.ts';
import {admitStructuredObservations} from '../src/district-structured-record.ts';
import {persistMetadata,R1ArtifactAuditSchema,RepresentationDescriptorSchema} from '../src/district-r1.ts';
import {provisionCivicPolicyAuthority,recordHostOptOut,purgeOptedOutHost} from '../src/civic-opt-out.ts';
import {poolShutdownBarrier} from './helpers/postgres-pool.ts';

// Opt-in disposable local Postgres and isolated managed-source authority. This
// authored fixture makes no HTTP, parser, provider or publication calls.
const connectionString=process.env.DISTRICT_TEST_DATABASE_URL;
test('source quotations and parser errors remain purgable CAS, never immutable R1 audit',{skip:!connectionString,timeout:120000},async t=>{
 const url=new URL(connectionString!);
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]',''].includes(url.hostname))throw Error('Privacy fixture refuses non-local Postgres');
 const host=url.searchParams.get('host');if(host&&!host.startsWith('/')&&!['localhost','127.0.0.1','::1'].includes(host))throw Error('Privacy fixture refuses non-local host override');
 const admin=new Pool({connectionString,max:2,connectionTimeoutMillis:5000,statement_timeout:10000}),database='district_metadata_test_'+randomUUID().replaceAll('-','');
 const closeAdmin=poolShutdownBarrier(admin),resources:{created:boolean;closePool?:()=>Promise<void>;root?:string}={created:false};
 t.after(async()=>{try{await resources.closePool?.();if(resources.created)await admin.query('DROP DATABASE "'+database+'"');}finally{await closeAdmin();if(resources.root)await rm(resources.root,{recursive:true,force:true});}});
 await admin.query('CREATE DATABASE "'+database+'"');resources.created=true;
 const isolated=new URL(url);isolated.pathname='/'+database;
 const pool=new Pool({connectionString:isolated.href,max:4,connectionTimeoutMillis:5000,statement_timeout:10000});resources.closePool=poolShutdownBarrier(pool);
 const root=await realpath(await mkdtemp(join(tmpdir(),'r1-metadata-privacy-')));resources.root=root;
 const options={stateDir:join(root,'authority'),authorityId:`fixture:${randomUUID()}`},authority=await provisionCivicPolicyAuthority(options),policy={...options,authoritySha256:authority.authoritySha256};
 const store=new DistrictJobStore(pool);await migrateDistrictJobs(pool);
 const quote='R1_PRIVATE_NATIVE_QUOTE_SENTINEL_6da01428',diagnostic='R1_PRIVATE_SYNTAX_ERROR_SENTINEL_7eb02339';
 const scope={publisherId:'fixture-publisher',sourceId:'fixture-source',municipalityId:'strausberg',ags:'12064472',tenant:null,observationWindow:'synthetic-privacy-fixture'};
 const bytes=Buffer.from(JSON.stringify({ags:scope.ags,value:quote})),source={url:'https://example.org/fixture.json',sha256:digest(bytes),mimeType:'application/json'},now=Date.now();
 const retrievedAt=new Date(now-3000).toISOString(),fetchedAt=new Date(now-2000).toISOString();
 const proof=await createPolicyReceipt({source,scope,sourcePolicy:{robots:{state:'allowed',url:'https://example.org/robots.txt'},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'},permission:{kind:'facts_with_attribution'},checkedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+600000).toISOString()},policy);
 const originalObservation=Buffer.from(JSON.stringify({url:source.url,method:'GET',checkedAt:fetchedAt,retrievedAt,state:'fetched',status:200,sha256:source.sha256,bytes:bytes.length,mimeType:source.mimeType},null,2)+'\n');
 const httpObservation={observationId:`${now}-${randomUUID()}.json`,receiptSha256:digest(originalObservation),bytes:originalObservation};
 const cas=new DistrictCas(join(root,'cas'));
 const representation=await persistR1Representation(store,cas,{bytes,receipt:proof.receipt,request:{url:source.url,method:'GET',body:null,contentType:null},retrievedAt,fetchedAt,sourceVersion:null,redirectChain:[],httpObservation},policy);
 const sources=[{...source,policyReceiptSha256:proof.receiptSha256,httpObservation:{...httpObservation,bytes:originalObservation.toString('utf8')}}];
 const candidate=observation({publisherId:scope.publisherId,sourceId:scope.sourceId,nativeId:'fixture-row',nativeVersion:null,kind:'FixtureObservation',subject:'fixture-row',predicate:'fixture_literal',value:quote,unit:null,date:null,dateRole:null,financialRole:'none',geography:{ags:scope.ags,basis:'source_explicit',role:'administrative_area'},sourceReferenceDate:null,publishedAt:null,retrievedAt,evidence:[{sourceSha256:source.sha256,format:'json',nativeId:'fixture-row',path:'$.value',sheet:null,rowKey:null,cells:[],rawValue:quote,schemaHash:digest('fixture-json-schema'),mappingVersion:'fixture-v1'}],limitations:['Authored fixture, not live source evidence.']});
 const privateCoverage={state:'partial' as const,scope:'synthetic fixture',reason:`SyntaxError: ${diagnostic}`,checkedAt:retrievedAt,nextCursor:null,observedRows:1,limitations:[quote]};
 const records=await admitStructuredObservations({adapter:{id:'fixture',version:'fixture-v1'},adapterContractSha256:digest('fixture-contract'),snapshot:{...representation.snapshot,bytes},scope,districtId:'mol',candidates:[candidate],checkCurrentPolicy:async()=>{const checked=await recheckPolicyReceipt(proof.receipt,{...policy,evaluationAt:new Date().toISOString()});return {receiptSha256:checked.receiptSha256,sourceSha256:source.sha256,scopeSha256:semanticHash(scope),allowed:true,checkedAt:new Date().toISOString()};},replayInSandbox:async()=>({observations:[candidate],coverage:privateCoverage})});
 const coverage=[{family:'fixture',operation:'parse' as const,adapterId:'fixture',adapterVersion:'fixture-v1',municipalityId:scope.municipalityId,sourceId:scope.sourceId,scopeSha256:semanticHash(scope),sourceSha256:source.sha256,policyReceiptSha256:proof.receiptSha256,stepReceiptSha256:digest('synthetic parser receipt'),additionalStepReceiptSha256s:[],coverage:privateCoverage}];
 const run={schemaVersion:'district-structured-run-v1',generatedAt:retrievedAt,registrySha256:digest('fixture registry'),questionDispositionSha256:digest('fixture question dispositions'),adapterContractSha256:semanticHash([digest('fixture-contract')]),records,coverage};
 const descriptor=RepresentationDescriptorSchema.parse({version:'district-r1-representation-v1',scope,root:source.url,snapshotId:representation.snapshotId,policyDecisionId:representation.policyDecisionId,receiptSha256:representation.receiptSha256,sourceArtifact:representation.sourceArtifact,snapshot:{...representation.snapshot,sourceVersion:quote},httpObservation:sources[0].httpObservation,fetchedAt,admittedAt:proof.receipt.checkedAt,redirectChain:[]});
 let auditOrderedWrites=0;
 class AuditOrderedCas extends DistrictCas {
  override async put(payload:Uint8Array,putOptions:CasPutOptions){
   const contentSha=digest(payload),rows=await pool.query<{sha256:string;payload_json:unknown}>(`SELECT sha256,payload_json FROM district_pipeline.r1_metadata_snapshots WHERE payload_json->'artifact'->>'sha256'=$1`,[contentSha]);
   assert.equal(rows.rowCount,1);
   const audit=R1ArtifactAuditSchema.parse(rows.rows[0].payload_json);
   assert.equal(semanticHash(audit),rows.rows[0].sha256);assert.equal(audit.artifact.sha256,contentSha);assert.equal(audit.artifact.byteLength,payload.byteLength);
   const encoded=canonicalJson(audit);assert.equal(encoded.includes(quote),false);assert.equal(encoded.includes(diagnostic),false);auditOrderedWrites++;
   return super.put(payload,putOptions);
  }
 }
 const auditedCas=new AuditOrderedCas(cas.root),artifacts=[];
 for(const item of [{kind:'records' as const,payload:records},{kind:'coverage' as const,payload:coverage},{kind:'structured_run' as const,payload:run},{kind:'acquisition_descriptor' as const,payload:descriptor}])artifacts.push(await persistMetadata(store,auditedCas,{...item,sources},policy));
 assert.equal(auditOrderedWrites,4);
 assert.ok((await cas.read(artifacts[0].sha256)).toString('utf8').includes(quote));
 assert.ok((await cas.read(artifacts[1].sha256)).toString('utf8').includes(diagnostic));
 assert.ok((await cas.read(artifacts[2].sha256)).toString('utf8').includes(quote));
 assert.ok((await cas.read(artifacts[2].sha256)).toString('utf8').includes(diagnostic));
 assert.ok((await cas.read(artifacts[3].sha256)).toString('utf8').includes(quote));
 const before=await pool.query<{sha256:string;payload_json:unknown}>(`SELECT sha256,payload_json FROM district_pipeline.r1_metadata_snapshots WHERE kind IN ('records','coverage','structured_run','acquisition_descriptor') ORDER BY kind`);
 assert.equal(before.rowCount,4);
 for(const row of before.rows){const audit=R1ArtifactAuditSchema.parse(row.payload_json);assert.notEqual(row.sha256,audit.artifact.sha256);assert.equal(canonicalJson(row.payload_json).includes(quote),false);assert.equal(canonicalJson(row.payload_json).includes(diagnostic),false);assert.throws(()=>R1ArtifactAuditSchema.parse({...audit,reason:diagnostic}));}
 await recordHostOptOut({host:'example.org',reason:'rights_holder_objection',reference:'synthetic-metadata-privacy'},policy);
 await purgeOptedOutHost('example.org',policy);
 for(const artifact of artifacts)await assert.rejects(cas.read(artifact.sha256));
 const after=await pool.query<{sha256:string;payload_json:unknown}>(`SELECT sha256,payload_json FROM district_pipeline.r1_metadata_snapshots WHERE kind IN ('records','coverage','structured_run','acquisition_descriptor') ORDER BY kind`);
 assert.deepEqual(after.rows,before.rows);
});
