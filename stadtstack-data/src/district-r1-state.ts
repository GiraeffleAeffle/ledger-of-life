import {randomUUID} from 'node:crypto';
import {insertR1MetadataSnapshot,type DistrictJobStore,type DistrictJobSpec} from './district-jobs.ts';
import {type DistrictCas,type CasArtifact} from './district-cas.ts';
import {canonicalJson,digest,semanticHash,PARSER_INPUT_MAX_BYTES,type AdapterScope} from './district-adapter-contract.ts';
import {PolicyReceiptSchema,recheckPolicyReceipt,type PolicyReceipt} from './district-policy-receipt.ts';
import {initializeManagedAcquisitionLane,withManagedSourceWrite,CIVIC_ACQUISITION_DECISION_ID,type ManagedSourceBinding,type ManagedSourceContent,type CivicPolicyOptions} from './civic-opt-out.ts';
import {structuredJobContract,type StructuredJobContract} from './district-structured-jobs.ts';
import {STRUCTURED_WORKER_VERSION,type StructuredWorkerRequest} from './district-structured-parser-worker.ts';
import {encodeStepReceipt,StepReceiptSchema} from './district-step-receipt.ts';
import {type StructuredSupportingSource} from './district-structured-record.ts';
import {HttpObservationProofSchema,HttpObservationSchema,authenticatedHttpBinding,authenticateHttpSourceBindings} from './district-http-observation.ts';
import type {OperatorRegistryInputPin,AdmittedOperatorRegistryConfiguration} from './district-registry-config.ts';
import {authenticateStructuredRegistry} from './district-structured-registry-admission.ts';

/** Canonical managed CAS copy of the admitted operator registry; the single path for CLI and fixtures. */
export async function persistOperatorRegistry(store:DistrictJobStore,cas:DistrictCas,admitted:AdmittedOperatorRegistryConfiguration,policy:CivicPolicyOptions={}){
 const hash=digest(admitted.bytes);
 await initializeManagedAcquisitionLane(cas.root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
 const entries:ManagedSourceContent[]=admitted.bindings.map(binding=>({...binding,relativePath:`sha256/${hash.slice(0,2)}/${hash}`,contentSha256:hash,independentAllowed:false}));
 const artifact=await withManagedSourceWrite(cas.root,entries,()=>cas.put(admitted.bytes,{kind:'derived',mimeType:'application/json'}),policy);
 await store.addArtifact(artifact);return hash;
}
export interface PersistedRepresentation {snapshotId:string;policyDecisionId:string;receiptSha256:string;sourceArtifact:CasArtifact;receiptArtifact:CasArtifact;observationArtifact:CasArtifact;httpObservation:{observationId:string;receiptSha256:string};snapshot:StructuredWorkerRequest['snapshot']}
/** Canonical safe audit metadata commits to Postgres before registering any purgable CAS duplicate. */
export async function persistR1Representation(store:DistrictJobStore,cas:DistrictCas,input:{bytes:Uint8Array;receipt:PolicyReceipt;request:{url:string;method:'GET'|'POST';body:string|null;contentType:string|null};retrievedAt:string;fetchedAt:string;sourceVersion:string|null;redirectChain:string[];httpObservation:{observationId:string;receiptSha256:string;bytes:Uint8Array};origin?:'imported'},policyOptions:CivicPolicyOptions={}):Promise<PersistedRepresentation>{
 const receipt=PolicyReceiptSchema.parse(input.receipt),proof=await recheckPolicyReceipt(receipt,{...policyOptions,evaluationAt:new Date().toISOString()}),sourceSha256=digest(input.bytes);
 if(sourceSha256!==receipt.source.sha256)throw Error('Acquired representation byte binding mismatch');
 const originalObservation=HttpObservationProofSchema.parse({...input.httpObservation,bytes:Buffer.from(input.httpObservation.bytes).toString('utf8')});
 const binding=authenticatedHttpBinding(originalObservation,{url:receipt.source.url,sha256:sourceSha256,mimeType:receipt.source.mimeType,retrievedAt:input.retrievedAt,fetchedAt:input.fetchedAt});
 const observed=HttpObservationSchema.parse(JSON.parse(originalObservation.bytes));if(observed.bytes!==input.bytes.byteLength)throw Error('Original observation size mismatch');
 const requestSelectorSha256=semanticHash({method:input.request.method,body:input.request.body,contentType:input.request.contentType}),scopeSha256=semanticHash(receipt.scope);
 const client=await store.pool.connect();let snapshotId:string=randomUUID(),policyDecisionId:string=randomUUID();
 try{
  await client.query('BEGIN');
  await client.query(`INSERT INTO district_pipeline.source_snapshots(id,publisher_id,source_id,municipality_id,ags,tenant,resource_identity,request_method,request_selector_sha256,observation_window,source_version,retrieved_at,scope_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,[snapshotId,receipt.scope.publisherId,receipt.scope.sourceId,receipt.scope.municipalityId,receipt.scope.ags,receipt.scope.tenant,input.request.url,input.request.method,requestSelectorSha256,receipt.scope.observationWindow,input.sourceVersion,input.retrievedAt,scopeSha256]);
  const snapshot=await client.query<{id:string}>(`SELECT id FROM district_pipeline.source_snapshots WHERE publisher_id=$1 AND source_id=$2 AND scope_sha256=$3 AND resource_identity=$4 AND request_method=$5 AND request_selector_sha256=$6 AND observation_window=$7`,[receipt.scope.publisherId,receipt.scope.sourceId,scopeSha256,input.request.url,input.request.method,requestSelectorSha256,receipt.scope.observationWindow]);
  if(snapshot.rowCount!==1)throw Error('Source snapshot identity mismatch');snapshotId=snapshot.rows[0].id;
  await client.query(`INSERT INTO district_pipeline.policy_decisions(id,source_snapshot_id,proof_sha256,source_sha256,state,observed_robots,owner_robots_override,origin_evidence_sha256,opt_out_version,policy_version,checked_at,expires_at,reason_code,receipt_json) VALUES($1,$2,$3,$4,'allowed',$5,$6,$7,$8,$9,$10,$11,'shared_policy_admitted',$12) ON CONFLICT(proof_sha256) DO NOTHING`,[policyDecisionId,snapshotId,proof.receiptSha256,sourceSha256,receipt.sourcePolicy.robots.state==='allowed'?'allowed':receipt.sourcePolicy.robots.state==='blocked'?'disallowed':'unknown',Boolean(receipt.sourcePolicy.ownerRobotsOverride),receipt.sourcePolicy.documentOrigin?semanticHash(receipt.sourcePolicy.documentOrigin):null,receipt.optOutSnapshotSha256,receipt.version,receipt.checkedAt,receipt.expiresAt,receipt]);
  const policy=await client.query<{id:string;state:string;receipt_json:unknown;source_snapshot_id:string}>(`SELECT id,state,receipt_json,source_snapshot_id FROM district_pipeline.policy_decisions WHERE proof_sha256=$1`,[proof.receiptSha256]);
  if(policy.rowCount!==1||policy.rows[0].state!=='allowed'||policy.rows[0].source_snapshot_id!==snapshotId||semanticHash(policy.rows[0].receipt_json)!==proof.receiptSha256)throw Error('Existing policy proof is excluded or incompatible');policyDecisionId=policy.rows[0].id;
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 await insertR1MetadataSnapshot(store.pool,{kind:'http_observation',payload:{schemaVersion:'district-http-observation-audit-v1',...originalObservation,...(input.origin?{origin:input.origin}:{})}});
 await initializeManagedAcquisitionLane(cas.root,{...policyOptions,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
 const receiptBytes=Buffer.from(canonicalJson(receipt));
 const sourceArtifact=await withManagedSourceWrite(cas.root,[{...binding,relativePath:`sha256/${sourceSha256.slice(0,2)}/${sourceSha256}`,contentSha256:sourceSha256,independentAllowed:true}],()=>cas.put(input.bytes,{kind:'source_original',mimeType:receipt.source.mimeType,admission:{state:'allowed',sourceSha256,policyProofSha256:proof.receiptSha256,checkedAt:receipt.checkedAt,expiresAt:receipt.expiresAt}}),policyOptions);
 // This is a purgable operational duplicate; receipt_json above is the immutable canonical audit copy.
 const receiptArtifact=await withManagedSourceWrite(cas.root,[{...binding,relativePath:`sha256/${proof.receiptSha256.slice(0,2)}/${proof.receiptSha256}`,contentSha256:proof.receiptSha256,independentAllowed:false}],()=>cas.put(receiptBytes,{kind:'receipt',mimeType:'application/json'}),policyOptions);
 const observationHash=originalObservation.receiptSha256,observationArtifact=await withManagedSourceWrite(cas.root,[{...binding,relativePath:`sha256/${observationHash.slice(0,2)}/${observationHash}`,contentSha256:observationHash,independentAllowed:false}],()=>cas.put(input.httpObservation.bytes,{kind:'receipt',mimeType:'application/json'}),policyOptions);
 await store.addArtifact(sourceArtifact);await store.addArtifact(receiptArtifact);await store.addArtifact(observationArtifact);
 await store.pool.query(`INSERT INTO district_pipeline.representations(id,source_snapshot_id,artifact_sha256,policy_decision_id,final_url,redirect_chain,fetched_at,admitted_at,mime_type,admission) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'admitted') ON CONFLICT(source_snapshot_id,artifact_sha256,policy_decision_id) DO NOTHING`,[randomUUID(),snapshotId,sourceSha256,policyDecisionId,receipt.source.url,JSON.stringify(input.redirectChain),input.fetchedAt,receipt.checkedAt,receipt.source.mimeType]);
 return {snapshotId,policyDecisionId,receiptSha256:proof.receiptSha256,sourceArtifact,receiptArtifact,observationArtifact,httpObservation:{observationId:originalObservation.observationId,receiptSha256:observationHash},snapshot:{sourceSha256,url:receipt.source.url,mimeType:receipt.source.mimeType,retrievedAt:input.retrievedAt,policyReceiptSha256:proof.receiptSha256,sourceVersion:input.sourceVersion,request:{method:input.request.method,body:input.request.body,contentType:input.request.contentType}}};
}
export async function enqueueStructuredSnapshot(store:DistrictJobStore,cas:DistrictCas,input:{adapter:StructuredWorkerRequest['adapter'];operation:'parse'|'discover';registry:OperatorRegistryInputPin;registrySha256:string;scope:AdapterScope;districtId:string;snapshot:PersistedRepresentation['snapshot'];options:Record<string,unknown>;cursor:string|null;sourceBindings:ManagedSourceBinding[];supportingSources?:StructuredSupportingSource[];auxiliary?:StructuredWorkerRequest['auxiliary']},policyOptions:CivicPolicyOptions={}):Promise<{jobKey:string;spec:DistrictJobSpec;contract:StructuredJobContract}>{
 const contract=await structuredJobContract(input.adapter);
 if(!input.snapshot.request)throw Error('Original HTTP selector required for structured jobs');
 const supportingSources=input.supportingSources??[],auxiliary=input.auxiliary??[];
 await authenticateStructuredRegistry(cas,{registry:input.registry,registrySha256:input.registrySha256,scope:input.scope,districtId:input.districtId,supportingSourceIds:supportingSources.map(source=>source.id)},policyOptions);
 for(const declared of auxiliary)if(!supportingSources.some(source=>source.sha256===declared.snapshot.sourceSha256&&source.policyReceiptSha256===declared.snapshot.policyReceiptSha256&&source.url===declared.snapshot.url&&source.mimeType===declared.snapshot.mimeType))throw Error('Auxiliary snapshot lacks supporting admission binding');
 const references=[{sha256:input.snapshot.sourceSha256,url:input.snapshot.url,policyReceiptSha256:input.snapshot.policyReceiptSha256},...supportingSources];
 for(const source of references){const proof=PolicyReceiptSchema.parse(JSON.parse((await cas.read(source.policyReceiptSha256)).toString('utf8')));if(semanticHash(proof)!==source.policyReceiptSha256||proof.source.sha256!==source.sha256||proof.source.url!==source.url)throw Error('Bundle input policy mismatch');await recheckPolicyReceipt(proof,{...policyOptions,evaluationAt:new Date().toISOString()});}
 const sourceBindings=await authenticateHttpSourceBindings(cas,input.sourceBindings,references,policyOptions);
 let inputArtifactSha256=input.snapshot.sourceSha256;
 if(auxiliary.length){
  const bundle={version:'structured-input-bundle-v1',sourceBytes:(await cas.read(input.snapshot.sourceSha256)).toString('base64'),auxiliary:await Promise.all(auxiliary.map(async item=>({slot:item.slot,bytes:(await cas.read(item.snapshot.sourceSha256)).toString('base64')})))};
  const bytes=Buffer.from(canonicalJson(bundle));if(bytes.length>PARSER_INPUT_MAX_BYTES)throw Error('Supporting source bundle exceeds parser input bound');inputArtifactSha256=digest(bytes);
  const hash=inputArtifactSha256,artifact=await withManagedSourceWrite(cas.root,sourceBindings.map(binding=>({...binding,relativePath:`sha256/${hash.slice(0,2)}/${hash}`,contentSha256:hash,independentAllowed:false})),()=>cas.put(bytes,{kind:'derived',mimeType:'application/json'}),policyOptions);
  await store.addArtifact(artifact);
 }
 const worker:StructuredWorkerRequest={version:STRUCTURED_WORKER_VERSION,operation:input.operation,adapter:input.adapter,options:input.options,scope:input.scope,cursor:input.cursor,snapshot:{...input.snapshot,request:input.snapshot.request},inputArtifactSha256,auxiliary};
 const spec:DistrictJobSpec={step:`structured_${input.operation}`,lane:'structured',semanticContractSha256:contract.semanticContractSha256,inputArtifactHashes:[...new Set([input.registrySha256,inputArtifactSha256,...sourceBindings.map(binding=>binding.receiptSha256),...references.flatMap(source=>[source.sha256,source.policyReceiptSha256])])],sourceScope:input.scope,selector:{worker,registry:input.registry,registrySha256:input.registrySha256,adapterContractSha256:contract.adapterContractSha256,parserContractSha256:contract.parserContractSha256,hostContractSha256:contract.hostContractSha256,districtId:input.districtId,supportingSources,sourceBindings},policyProofSha256:input.snapshot.policyReceiptSha256};
 return {jobKey:await store.enqueue(spec),spec,contract};
}
/** Export selected committed metadata for exact offline replay; Postgres retains the canonical audit copy. */
export async function exportStepReceipt(store:DistrictJobStore,cas:DistrictCas,receiptSha256:string,source:{url:string;sha256:string;policyReceiptSha256:string;binding:ManagedSourceBinding},policyOptions:CivicPolicyOptions={}):Promise<CasArtifact>{
 const result=await store.pool.query<{receipt:unknown}>(`SELECT receipt FROM district_pipeline.step_receipts WHERE receipt_sha256=$1`,[receiptSha256]);
 if(result.rowCount!==1)throw Error('Committed step receipt not found');
 const encoded=encodeStepReceipt(StepReceiptSchema.parse(result.rows[0].receipt));
 if(encoded.sha256!==receiptSha256||!encoded.receipt.inputHashes.includes(source.sha256)||encoded.receipt.policyProofSha256!==source.policyReceiptSha256)throw Error('Step receipt export source binding mismatch');
 const [binding]=await authenticateHttpSourceBindings(cas,[source.binding],[source],policyOptions);
 return withManagedSourceWrite(cas.root,[{...binding,relativePath:`sha256/${receiptSha256.slice(0,2)}/${receiptSha256}`,contentSha256:receiptSha256,independentAllowed:false}],()=>cas.put(Buffer.from(encoded.bytes),{kind:'receipt',mimeType:'application/json'}),policyOptions);
}
