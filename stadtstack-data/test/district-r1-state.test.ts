import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Pool} from 'pg';
import {z} from 'zod';
import {canonicalJson,digest,semanticHash} from '../src/district-adapter-contract.ts';
import {DistrictCas,type CasPutOptions} from '../src/district-cas.ts';
import {DistrictJobStore,migrateDistrictJobs,runDistrictJobs,artifactVerificationHandler} from '../src/district-jobs.ts';
import {createPolicyReceipt} from '../src/district-policy-receipt.ts';
import {persistR1Representation,enqueueStructuredSnapshot,exportStepReceipt} from '../src/district-r1-state.ts';
import {authenticatedHttpBinding} from '../src/district-http-observation.ts';
import {provisionCivicPolicyAuthority,recordHostOptOut,purgeOptedOutHost,assertManagedSourceBindings} from '../src/civic-opt-out.ts';
import {encodeStepReceipt,type StepReceipt} from '../src/district-step-receipt.ts';
import {StructuredWorkerRequestSchema,StructuredInputBundleSchema} from '../src/district-structured-parser-worker.ts';
import {createOperatorRegistryFixture,operatorRegistryFixtureValue,writeOperatorRegistryInputPin} from './helpers/operator-registry-fixture.ts';
import {persistOperatorRegistry} from '../src/district-r1.ts';
import type {DistrictRegistry} from '../src/district-registry.ts';

// Opt-in real local Postgres, with a newly created disposable database. All source
// content/permissions/observations are synthetic; no HTTP or parser is executed.
const connectionString=process.env.DISTRICT_TEST_DATABASE_URL;
test('R1 state preserves independent HTTP and policy proofs through managed CAS and Postgres',{skip:!connectionString,timeout:120000},async t=>{
 const url=new URL(connectionString!);
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]',''].includes(url.hostname))throw Error('Integration test refuses a non-local Postgres endpoint');
 const host=url.searchParams.get('host');if(host&&!host.startsWith('/')&&!['localhost','127.0.0.1','::1'].includes(host))throw Error('Integration test refuses non-local host override');
 const admin=new Pool({connectionString,max:2,connectionTimeoutMillis:5000,statement_timeout:10000}),database='district_state_test_'+randomUUID().replaceAll('-','');
 const resources:{created:boolean;pool?:Pool;root?:string}={created:false};
 t.after(async()=>{try{await resources.pool?.end();if(resources.created)await admin.query('DROP DATABASE "'+database+'" WITH (FORCE)');}finally{await admin.end();if(resources.root)await rm(resources.root,{recursive:true,force:true});}});
 await admin.query('CREATE DATABASE "'+database+'"');resources.created=true;
 const isolated=new URL(url);isolated.pathname='/'+database;
 const pool=new Pool({connectionString:isolated.href,max:4,connectionTimeoutMillis:5000,statement_timeout:10000});resources.pool=pool;
 const root=await mkdtemp(join(tmpdir(),'r1-state-proof-'));resources.root=root;
 const options={stateDir:join(root,'authority'),authorityId:`fixture:${randomUUID()}`};
 const authority=await provisionCivicPolicyAuthority(options),policy={...options,authoritySha256:authority.authoritySha256};
 const store=new DistrictJobStore(pool);await migrateDistrictJobs(pool);
 const scope={publisherId:'synthetic-publisher',sourceId:'synthetic-source',municipalityId:'strausberg',ags:'12064472',tenant:null,observationWindow:'2026-10-11'};
 async function fixture(name:string,body='id,value\nsynthetic,1\n'){
  const bytes=Buffer.from(body),source={url:`https://example.org/${name}.csv`,sha256:digest(bytes),mimeType:'text/csv'},now=Date.now();
  const created=await createPolicyReceipt({source,scope:{...scope,sourceId:'synthetic-'+name},sourcePolicy:{robots:{state:'allowed',url:'https://example.org/robots.txt'},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'},permission:{kind:'distribution_licence',distributionUrl:source.url,licenceId:'synthetic-test-only',termsUrl:'https://example.org/synthetic-terms',termsSha256:digest('synthetic terms'),approvalSha256:digest('synthetic approval')},checkedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+600000).toISOString()},policy);
  const retrievedAt=new Date(now-3000).toISOString(),fetchedAt=new Date(now-2000).toISOString();
  const observation={url:source.url,method:'GET',checkedAt:fetchedAt,retrievedAt,state:'fetched',status:200,sha256:source.sha256,bytes:bytes.length,mimeType:source.mimeType};
  const raw=Buffer.from(JSON.stringify(observation,null,2)+'\n');
  return {bytes,receipt:created.receipt,request:{url:source.url,method:'GET' as const,body:null,contentType:null},retrievedAt,fetchedAt,sourceVersion:null,redirectChain:[],httpObservation:{observationId:`${now}-${randomUUID()}.json`,receiptSha256:digest(raw),bytes:raw}};
 }
 const first=await fixture('primary');
 const audit={schemaVersion:'district-http-observation-audit-v1',...first.httpObservation,bytes:first.httpObservation.bytes.toString('utf8')};
 let auditedWrites=0;
 // Instrument only the boundary, delegating every write to the real CAS. A
 // separate pool query proves the audit is committed, not merely transactional.
 class AuditOrderedCas extends DistrictCas {
  override async put(bytes:Uint8Array,options:CasPutOptions){
   const p=await pool.query<{receipt_json:unknown}>('SELECT receipt_json FROM district_pipeline.policy_decisions WHERE proof_sha256=$1',[semanticHash(first.receipt)]);
   const h=await pool.query<{payload_json:unknown}>('SELECT payload_json FROM district_pipeline.r1_metadata_snapshots WHERE sha256=$1',[semanticHash(audit)]);
   assert.deepEqual(p.rows[0]?.receipt_json,first.receipt);assert.deepEqual(h.rows[0]?.payload_json,audit);auditedWrites++;
   return super.put(bytes,options);
  }
 }
 const cas=new AuditOrderedCas(join(root,'cas'));
 const primary=await persistR1Representation(store,cas,first,policy);
 const binding=authenticatedHttpBinding({...first.httpObservation,bytes:first.httpObservation.bytes.toString('utf8')},{url:first.receipt.source.url,sha256:primary.sourceArtifact.sha256});
 assert.ok(binding.kind==='http_observation');
 await t.test('safe canonical audits precede all three purgable originals/receipts',async()=>{
  assert.equal(auditedWrites,3);
  assert.notEqual(primary.httpObservation.receiptSha256,primary.receiptSha256);
  assert.notEqual(primary.httpObservation.receiptSha256,semanticHash(JSON.parse(first.httpObservation.bytes.toString('utf8'))));
  assert.notEqual(primary.httpObservation.receiptSha256,semanticHash(audit));
  assert.equal(primary.receiptArtifact.sha256,semanticHash(first.receipt));
  assert.equal(primary.observationArtifact.sha256,first.httpObservation.receiptSha256);
  assert.deepEqual(await cas.read(primary.observationArtifact.sha256),first.httpObservation.bytes);
  assert.equal((await cas.read(primary.receiptArtifact.sha256)).toString('utf8'),canonicalJson(first.receipt));
  assert.equal((await persistR1Representation(store,cas,first,policy)).snapshotId,primary.snapshotId);
  await assert.rejects(pool.query("UPDATE district_pipeline.r1_metadata_snapshots SET payload_json='{}' WHERE sha256=$1",[semanticHash(audit)]),/Immutable/);
 });
 await t.test('forged, unsafe, expired and mismatched representations fail before CAS',async()=>{
  const before=auditedWrites;
  await assert.rejects(persistR1Representation(store,cas,{...first,bytes:Buffer.from('other')},policy),/byte binding/);
  for(const patch of [{url:'https://example.org/wrong.csv'},{sha256:digest('wrong')},{mimeType:'application/json'},{retrievedAt:new Date(0).toISOString()},{checkedAt:new Date(0).toISOString()},{bytes:first.bytes.length+1},{state:'excluded'},{authorization:'synthetic-secret'},{url:'http://127.0.0.1/private'}]){
   const raw=Buffer.from(JSON.stringify({...JSON.parse(first.httpObservation.bytes.toString('utf8')),...patch}));
   await assert.rejects(persistR1Representation(store,cas,{...first,httpObservation:{...first.httpObservation,bytes:raw,receiptSha256:digest(raw)}},policy));
  }
  await assert.rejects(persistR1Representation(store,cas,{...first,httpObservation:{...first.httpObservation,receiptSha256:primary.receiptSha256}},policy));
  await assert.rejects(persistR1Representation(store,cas,{...first,httpObservation:{...first.httpObservation,observationId:`policy-${primary.receiptSha256}.json`}},policy));
  await assert.rejects(persistR1Representation(store,cas,{...first,receipt:{...first.receipt,checkedAt:new Date(Date.now()-120000).toISOString(),expiresAt:new Date(Date.now()-60000).toISOString()}},policy),/expired/);
  await assert.rejects(persistR1Representation(store,cas,first,{...policy,authoritySha256:digest('forged')}));
  assert.equal(auditedWrites,before);
 });
 const second=await fixture('support','station,value\nsynthetic,2\n'),support=await persistR1Representation(store,cas,second,policy);
 const supportBinding=authenticatedHttpBinding({...second.httpObservation,bytes:second.httpObservation.bytes.toString('utf8')},second.receipt.source);
 const supportingSource={id:second.receipt.scope.sourceId,...second.receipt.source,retrievedAt:second.retrievedAt,policyReceiptSha256:support.receiptSha256,scopeSha256:semanticHash(second.receipt.scope),role:'source_metadata' as const};
 const registryValue=operatorRegistryFixtureValue(),city=registryValue.municipalities[0];
 city.id=scope.municipalityId;city.ags=scope.ags;city.districtId='mol';registryValue.districts[0].id='mol';
 registryValue.inventory[0].ags=scope.ags;registryValue.inventory[0].districtId='mol';
 for(const name of ['primary','support','support-changed'])city.sources.push({id:'synthetic-'+name,kind:'structured',url:`https://example.org/${name}.csv`,vendor:'unknown',checkState:'not_checked',checkedAt:null,evidence:[],reason:'Synthetic structured fixture endpoint; no observation inferred from configuration'});
 async function admittedRegistry(value:DistrictRegistry,label:string){
  const registry=await createOperatorRegistryFixture(t,{context:{root,policy},value,label});
  const hash=await persistOperatorRegistry(store,cas,registry.admitted,policy);
  assert.equal(hash,registry.registrySha256);
  await assertManagedSourceBindings(join(cas.root,'sha256',hash.slice(0,2),hash),registry.admitted.bindings,policy);
  assert.deepEqual(await cas.read(hash),registry.body);return registry;
 }
 const registry=await admittedRegistry(registryValue,'structured-registry');
 const input={adapter:'gauges' as const,operation:'parse' as const,registry:registry.registryPin,registrySha256:registry.registrySha256,scope:first.receipt.scope,districtId:'mol',snapshot:primary.snapshot,options:{},cursor:null,sourceBindings:[binding,supportBinding],supportingSources:[supportingSource],auxiliary:[{slot:'stationSnapshot' as const,snapshot:support.snapshot}]};
 const queued=await enqueueStructuredSnapshot(store,cas,input,policy);
 await t.test('all source and HTTP proofs plus immutable auxiliary bundle participate in job identity',async()=>{
  for(const hash of [primary.sourceArtifact.sha256,primary.receiptSha256,primary.httpObservation.receiptSha256,support.sourceArtifact.sha256,support.receiptSha256,support.httpObservation.receiptSha256])assert.ok(queued.spec.inputArtifactHashes.includes(hash),hash);
  assert.ok(queued.spec.inputArtifactHashes.includes(registry.registrySha256));
  const selector=z.object({registry:z.object({path:z.string(),sha256:z.string()}),registrySha256:z.string()}).parse(queued.spec.selector);
  assert.deepEqual(selector.registry,registry.registryPin);assert.equal(selector.registrySha256,registry.registrySha256);
  const worker=z.object({worker:StructuredWorkerRequestSchema}).parse(queued.spec.selector).worker,bytes=await cas.read(worker.inputArtifactSha256),bundle=StructuredInputBundleSchema.parse(JSON.parse(bytes.toString('utf8')));
  assert.equal(digest(bytes),worker.inputArtifactSha256);assert.ok(queued.spec.inputArtifactHashes.includes(worker.inputArtifactSha256));
  assert.equal(bundle.sourceBytes,first.bytes.toString('base64'));assert.deepEqual(bundle.auxiliary,[{slot:'stationSnapshot',bytes:second.bytes.toString('base64')}]);
  assert.equal((await enqueueStructuredSnapshot(store,cas,input,policy)).jobKey,queued.jobKey);
  const third=await fixture('support-changed','station,value\nsynthetic,3\n'),changed=await persistR1Representation(store,cas,third,policy);
  const changedBinding=authenticatedHttpBinding({...third.httpObservation,bytes:third.httpObservation.bytes.toString('utf8')},third.receipt.source);
  const next=await enqueueStructuredSnapshot(store,cas,{...input,sourceBindings:[binding,changedBinding],supportingSources:[{...supportingSource,...third.receipt.source,id:third.receipt.scope.sourceId,retrievedAt:third.retrievedAt,policyReceiptSha256:changed.receiptSha256,scopeSha256:semanticHash(third.receipt.scope)}],auxiliary:[{slot:'stationSnapshot',snapshot:changed.snapshot}]},policy);
  assert.notEqual(next.jobKey,queued.jobKey);assert.notEqual(z.object({worker:StructuredWorkerRequestSchema}).parse(next.spec.selector).worker.inputArtifactSha256,worker.inputArtifactSha256);
  for(const sourceBindings of [[binding],[supportBinding],[binding,supportBinding,supportBinding],[binding,{...supportBinding,receiptSha256:support.receiptSha256}]])await assert.rejects(enqueueStructuredSnapshot(store,cas,{...input,sourceBindings},policy));
  await assert.rejects(enqueueStructuredSnapshot(store,cas,{...input,supportingSources:[]},policy),/supporting admission/);
  await assert.rejects(enqueueStructuredSnapshot(store,cas,{...input,supportingSources:[{...supportingSource,sha256:digest('wrong')}]},policy));
 });
 await t.test('the descriptor path, descriptor digest and admitted registry bytes each bind job identity',async()=>{
  const movedPin=await writeOperatorRegistryInputPin(root,'same-registry-another-descriptor',registry.sourcePin);
  assert.equal(movedPin.sha256,registry.registryPin.sha256);
  assert.notEqual((await enqueueStructuredSnapshot(store,cas,{...input,registry:movedPin},policy)).jobKey,queued.jobKey);
  const original=await readFile(registry.registryPin.path),formatted=Buffer.from(JSON.stringify(registry.sourcePin,null,2)+'\n');
  assert.notEqual(digest(formatted),registry.registryPin.sha256);
  try{
   await writeFile(registry.registryPin.path,formatted,{mode:0o600});
   const changedPin={...registry.registryPin,sha256:digest(formatted)};
   assert.notEqual((await enqueueStructuredSnapshot(store,cas,{...input,registry:changedPin},policy)).jobKey,queued.jobKey);
  }finally{await writeFile(registry.registryPin.path,original,{mode:0o600});}
  const changedValue=structuredClone(registryValue);changedValue.notes.push('Synthetic approved operator configuration amendment');
  const changed=await admittedRegistry(changedValue,'changed-structured-registry');
  assert.notEqual(changed.registrySha256,registry.registrySha256);
  const next=await enqueueStructuredSnapshot(store,cas,{...input,registry:changed.registryPin,registrySha256:changed.registrySha256},policy);
  assert.notEqual(next.jobKey,queued.jobKey);assert.ok(next.spec.inputArtifactHashes.includes(changed.registrySha256));
 });
 await t.test('enqueue rejects absent municipalities, absent primary or supporting sources, and mismatched registry hashes',async()=>{
  for(const missing of ['municipality','primary','support'] as const){
   const value=structuredClone(registryValue);
   if(missing==='municipality')value.municipalities[0].id='other-synthetic-town';
   else value.municipalities[0].sources=value.municipalities[0].sources.filter(source=>source.id!=='synthetic-'+missing);
   const absent=await admittedRegistry(value,'registry-without-'+missing);
   await assert.rejects(enqueueStructuredSnapshot(store,cas,{...input,registry:absent.registryPin,registrySha256:absent.registrySha256},policy));
  }
  await assert.rejects(enqueueStructuredSnapshot(store,cas,{...input,registrySha256:digest('not the admitted registry bytes')},policy));
  await assert.rejects(enqueueStructuredSnapshot(store,cas,{...input,registry:{...input.registry,sha256:digest('not the descriptor bytes')}},policy));
 });
 await t.test('export reproduces the exact committed step receipt and refuses another source or missing receipt',async()=>{
  const jobKey=await store.enqueue({...queued.spec,step:'verify_artifacts'});
  const authorizationId=await store.authorize({approvalSha256:digest('synthetic execution approval'),approvedBy:'synthetic-fixture-owner',expiresAt:new Date(Date.now()+60000).toISOString(),jobKeys:[jobKey],ags:['12064472'],maxJobs:1,maxElapsedMs:60000,category:'development'});
  const run=await runDistrictJobs({store,cas,handlers:{verify_artifacts:artifactVerificationHandler},authorizationId,ownerPresent:true,maxJobs:1,maxElapsedMs:60000});
  assert.equal(run.state,'completed');
  const committed=await pool.query<{receipt:StepReceipt;receipt_sha256:string}>('SELECT receipt,receipt_sha256 FROM district_pipeline.step_receipts WHERE run_id=$1',[run.runId]);assert.equal(committed.rowCount,1);
  const row=committed.rows[0],source={url:primary.snapshot.url,sha256:primary.sourceArtifact.sha256,policyReceiptSha256:primary.receiptSha256,binding};
  const exported=await exportStepReceipt(store,cas,row.receipt_sha256,source,policy);
  assert.equal(exported.sha256,row.receipt_sha256);assert.equal((await cas.read(exported.sha256)).toString('utf8'),encodeStepReceipt(row.receipt).bytes);
  await assert.rejects(exportStepReceipt(store,cas,digest('not committed'),source,policy),/not found/);
  await assert.rejects(exportStepReceipt(store,cas,row.receipt_sha256,{...source,sha256:digest('wrong')},policy),/source binding/);
  await assert.rejects(exportStepReceipt(store,cas,row.receipt_sha256,{...source,policyReceiptSha256:support.receiptSha256},policy),/source binding/);
  await assert.rejects(exportStepReceipt(store,cas,row.receipt_sha256,{...source,binding:{...binding,receiptSha256:primary.receiptSha256}},policy));
 });
 await t.test('opt-out rejects reuse and purges operational duplicates without deleting safe PG audit',async()=>{
  await recordHostOptOut({host:'example.org',reason:'rights_holder_objection',reference:'synthetic-state-test'},policy);
  await assert.rejects(persistR1Representation(store,cas,first,policy));
  await assert.rejects(enqueueStructuredSnapshot(store,cas,input,policy));
  await purgeOptedOutHost('example.org',policy);
  for(const hash of [primary.sourceArtifact.sha256,primary.receiptArtifact.sha256,primary.observationArtifact.sha256,registry.registrySha256])await assert.rejects(cas.read(hash));
  const retained=await pool.query<{payload_json:typeof audit}>('SELECT payload_json FROM district_pipeline.r1_metadata_snapshots WHERE sha256=$1',[semanticHash(audit)]);
  assert.deepEqual(retained.rows[0].payload_json,audit);assert.equal(digest(retained.rows[0].payload_json.bytes),first.httpObservation.receiptSha256);
  const proof=await pool.query<{receipt_json:unknown}>('SELECT receipt_json FROM district_pipeline.policy_decisions WHERE proof_sha256=$1',[primary.receiptSha256]);assert.deepEqual(proof.rows[0].receipt_json,first.receipt);
 });
});
