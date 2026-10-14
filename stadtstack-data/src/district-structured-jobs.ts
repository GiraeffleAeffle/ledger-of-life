import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {CoverageSchema,ObservationSchema,HashSchema,ScopeSchema,canonicalJson,semanticHash,digest} from './district-adapter-contract.ts';
import {operatorRegistryInputPinSchema} from './district-registry-config.ts';
import {authenticateStructuredRegistry} from './district-structured-registry-admission.ts';
import {StructuredWorkerRequestSchema,StructuredOutputPageSchema,STRUCTURED_WORKER_VERSION,type StructuredWorkerRequest} from './district-structured-parser-worker.ts';
import {withParserSandbox,parserOutputContractSha256,readParserReview,ParserIsolationError,type ParserSourceContext} from './district-parser-isolation.ts';
import type {ParserReview} from './district-parser-isolation.ts';
import {admitStructuredObservations,StructuredKnowledgeRecordSchema,StructuredSupportingSourceSchema,type StructuredKnowledgeRecord,type StructuredAdmission} from './district-structured-record.ts';
import {PolicyReceiptSchema,recheckPolicyReceipt} from './district-policy-receipt.ts';
import {runDistrictJobsCli,type JobHandler,type JobHandlerContext,type JobHandlerResult} from './district-jobs.ts';
import {initializeManagedAcquisitionLane,withManagedSourceWrite,assertManagedSourceBindings,assertManagedIndependentHttpSourceBinding,CIVIC_ACQUISITION_DECISION_ID,type CivicPolicyOptions} from './civic-opt-out.ts';
import {pipelineNotificationConfig} from './district-notifications.ts';
import {structuredFieldPublicationHold} from './district-public-fields.ts';
import {HttpSourceBindingSchema,authenticateHttpSourceBindings} from './district-http-observation.ts';

const SelectorSchema=z.object({worker:StructuredWorkerRequestSchema,registry:operatorRegistryInputPinSchema,registrySha256:HashSchema,adapterContractSha256:HashSchema,parserContractSha256:HashSchema,mappingContractSha256:HashSchema,districtId:z.string().min(1),supportingSources:z.array(StructuredSupportingSourceSchema),sourceBindings:z.array(HttpSourceBindingSchema).min(1)}).strict();
const resourceSchema=z.object({url:z.url(),nativeId:z.string().min(1),parentId:z.string().nullable(),method:z.enum(['GET','POST']),body:z.string().nullable(),format:z.string().min(1)}).strict();
const outputSchema=z.object({version:z.literal(STRUCTURED_WORKER_VERSION),requestSha256:HashSchema,adapterId:z.string().min(1),adapterVersion:z.string().min(1),result:z.union([z.object({observations:z.array(ObservationSchema),coverage:CoverageSchema}).strict(),z.object({resources:z.array(resourceSchema),coverage:CoverageSchema}).strict()]),page:StructuredOutputPageSchema.nullable()}).strict();
export const StructuredJobResultSchema=z.object({schemaVersion:z.literal('district-structured-job-result-v2'),requestSha256:HashSchema,adapterId:z.string().min(1),adapterVersion:z.string().min(1),adapterContractSha256:HashSchema,parserContractSha256:HashSchema,mappingContractSha256:HashSchema,scope:ScopeSchema,sourceSha256:HashSchema,policyReceiptSha256:HashSchema,supportingSources:z.array(StructuredSupportingSourceSchema),result:outputSchema.shape.result,page:StructuredOutputPageSchema.nullable(),records:z.array(StructuredKnowledgeRecordSchema),unpublishedObservations:z.number().int().nonnegative()}).strict();
export type StructuredJobResult=z.infer<typeof StructuredJobResultSchema>;
type StructuredWorkerOutput=z.infer<typeof outputSchema>;
export interface StructuredJobContract {adapterContractSha256:string;parserContractSha256:string;mappingContractSha256:string;semanticContractSha256:string}
export async function structuredJobContract(adapter:StructuredWorkerRequest['adapter'],hash?:(file:string)=>Promise<string>):Promise<StructuredJobContract>{
 const name=StructuredWorkerRequestSchema.shape.adapter.parse(adapter)==='state-gauges'?'gauges':adapter;
 const adapterContractSha256=hash?await hash(`../sources/${name}-contract.json`):digest(await readFile(new URL(`../sources/${name}-contract.json`,import.meta.url)));
 const files=['district-structured-jobs.ts','district-structured-record.ts','district-public-fields.ts','district-entity-resolution.ts','district-case-linking.ts','district-schema.ts','district-graph-claims.ts','planning-stages.ts','case-supersession.ts'];
 const mappingContractSha256=semanticHash(await Promise.all(files.map(async file=>({file,sha256:hash?await hash(file):digest(await readFile(new URL(file,import.meta.url)))}))));
 const parserContractSha256=await parserOutputContractSha256(hash);
 return {adapterContractSha256,parserContractSha256,mappingContractSha256,semanticContractSha256:semanticHash({worker:STRUCTURED_WORKER_VERSION,adapterContractSha256,parserContractSha256,mappingContractSha256})};
}

/** Independent HTTP membership is only for the actual original, never for a
 * multi-source input bundle or another derived parser artifact. */
export async function assertStructuredParserInput(cas:{root:string},request:StructuredWorkerRequest,bindings:z.infer<typeof HttpSourceBindingSchema>[],policy:CivicPolicyOptions){
 const path=join(cas.root,'sha256',request.inputArtifactSha256.slice(0,2),request.inputArtifactSha256);
 if(request.inputArtifactSha256===request.snapshot.sourceSha256&&!request.auxiliary.length){
  const selected=bindings.filter(binding=>binding.sourceSha256===request.snapshot.sourceSha256&&binding.url===request.snapshot.url);
  if(selected.length!==1)throw Error('Parser original requires one selected HTTP observation');
  await assertManagedIndependentHttpSourceBinding(path,selected[0],policy);
 }else await assertManagedSourceBindings(path,bindings,policy);
}

async function isolatedAdapter(context:JobHandlerContext,request:StructuredWorkerRequest,sourceContext:ParserSourceContext&{bindings:z.infer<typeof HttpSourceBindingSchema>[]}){
 context.signal.throwIfAborted();
 const policy={stateDir:sourceContext.stateDir,authorityId:sourceContext.authorityId,authoritySha256:sourceContext.authoritySha256};
 await assertStructuredParserInput(context.cas,request,sourceContext.bindings,policy);
 const input=await context.cas.read(request.inputArtifactSha256);
 await assertStructuredParserInput(context.cas,request,sourceContext.bindings,policy);
 const output=await withParserSandbox(input,sandbox=>sandbox.run('node',['--experimental-strip-types','/opt/stadtstack/src/district-structured-parser-worker.ts','/input/document',canonicalJson(request)]),sourceContext);
 context.signal.throwIfAborted();
 const parsed=outputSchema.parse(JSON.parse(output.stdout));
 if(parsed.requestSha256!==semanticHash(request))throw Error('Sandbox response request binding mismatch');
 if(request.operation==='parse'&&!('observations' in parsed.result)||request.operation==='discover'&&!('resources' in parsed.result))throw Error('Sandbox response operation mismatch');
 return parsed;
}
async function executeStructured(context:JobHandlerContext):Promise<JobHandlerResult>{
 const selector=SelectorSchema.parse(context.job.spec.selector),request=selector.worker;
 if(context.job.spec.step!==`structured_${request.operation}`||context.job.spec.policyProofSha256!==request.snapshot.policyReceiptSha256||semanticHash(context.job.spec.sourceScope)!==semanticHash(request.scope)||!context.job.spec.inputArtifactHashes.includes(request.snapshot.sourceSha256)||!context.job.spec.inputArtifactHashes.includes(request.snapshot.policyReceiptSha256))throw Error('Structured job selector binding mismatch');
 if(!context.job.spec.inputArtifactHashes.includes(request.inputArtifactSha256))throw Error('Selected parser artifact omitted from job identity');
 if(!context.job.spec.inputArtifactHashes.includes(selector.registrySha256))throw Error('Admitted registry omitted from job identity');
 for(const declared of request.auxiliary)if(!selector.supportingSources.some(source=>source.sha256===declared.snapshot.sourceSha256&&source.policyReceiptSha256===declared.snapshot.policyReceiptSha256&&source.url===declared.snapshot.url&&source.mimeType===declared.snapshot.mimeType))throw Error('Auxiliary snapshot lacks admitted supporting source');
 const contract=await structuredJobContract(request.adapter);
 if(selector.adapterContractSha256!==contract.adapterContractSha256||selector.parserContractSha256!==contract.parserContractSha256||selector.mappingContractSha256!==contract.mappingContractSha256||context.job.spec.semanticContractSha256!==contract.semanticContractSha256)throw Error('Structured parser or mapping semantic contract changed');
 const receipt=PolicyReceiptSchema.parse(JSON.parse((await context.cas.read(request.snapshot.policyReceiptSha256)).toString('utf8')));
 if(semanticHash(receipt)!==request.snapshot.policyReceiptSha256||receipt.source.url!==request.snapshot.url||receipt.source.sha256!==request.snapshot.sourceSha256||receipt.source.mimeType!==request.snapshot.mimeType||semanticHash(receipt.scope)!==semanticHash(request.scope))throw Error('Structured source policy binding mismatch');
 const policy=await recheckPolicyReceipt(receipt,{evaluationAt:new Date().toISOString()});
 await authenticateStructuredRegistry(context.cas,{registry:selector.registry,registrySha256:selector.registrySha256,scope:request.scope,districtId:selector.districtId,supportingSourceIds:selector.supportingSources.map(source=>source.id)},{authorityId:receipt.authorityId,authoritySha256:receipt.authoritySha256});
 const supportAdmissions:StructuredAdmission[]=[];
 for(const source of selector.supportingSources){
  if(!context.job.spec.inputArtifactHashes.includes(source.sha256)||!context.job.spec.inputArtifactHashes.includes(source.policyReceiptSha256))throw Error('Supporting original/receipt omitted from job identity');
  const proof=PolicyReceiptSchema.parse(JSON.parse((await context.cas.read(source.policyReceiptSha256)).toString('utf8')));
  if(semanticHash(proof)!==source.policyReceiptSha256||proof.source.url!==source.url||proof.source.sha256!==source.sha256||proof.source.mimeType!==source.mimeType||proof.scope.sourceId!==source.id||semanticHash(proof.scope)!==source.scopeSha256||proof.scope.municipalityId!==request.scope.municipalityId||proof.scope.ags!==request.scope.ags)throw Error('Supporting source policy binding mismatch');
  await recheckPolicyReceipt(proof,{evaluationAt:new Date().toISOString()});await context.cas.verify(source.sha256);
  supportAdmissions.push({receiptSha256:source.policyReceiptSha256,sourceSha256:source.sha256,scopeSha256:source.scopeSha256,allowed:true,checkedAt:new Date().toISOString()});
 }
 const sourceBindings=await authenticateHttpSourceBindings(context.cas,selector.sourceBindings,[{url:request.snapshot.url,sha256:request.snapshot.sourceSha256},...selector.supportingSources]);
 if(sourceBindings.some(binding=>!context.job.spec.inputArtifactHashes.includes(binding.receiptSha256)))throw Error('Original HTTP proof omitted from job identity');
 const sourceContext:ParserSourceContext&{bindings:z.infer<typeof HttpSourceBindingSchema>[]}={root:context.cas.root,kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,bindings:sourceBindings,purpose:'artifact',signal:context.signal,authorityId:receipt.authorityId,authoritySha256:receipt.authoritySha256};
 let parserReview:ParserReview;
 const runParser=()=>isolatedAdapter(context,request,sourceContext);
 let parsed:StructuredWorkerOutput;
 try{parserReview=await readParserReview();parsed=await runParser();}catch(error){if(error instanceof ParserIsolationError)return ['security_review_required','unavailable'].includes(error.reason)?{outcome:'held_execution',reasonCode:'isolation_unavailable'}:{outcome:'held_quality',reasonCode:'quality_failed'};throw error;}
 await recheckPolicyReceipt(receipt,{evaluationAt:new Date().toISOString()});
 const result=parsed.result,coverage=result.coverage;
 let records:StructuredKnowledgeRecord[]=[];
 if(request.operation==='parse'&&'observations' in result&&['complete','partial','empty'].includes(coverage.state)){
  const candidates=result.observations.filter(row=>row.geography.ags===request.scope.ags&&row.geography.basis!=='unknown'&&['project_location','performance_location','administrative_area'].includes(row.geography.role)&&structuredFieldPublicationHold(row)===null);
  records=await admitStructuredObservations({adapter:{id:parsed.adapterId,version:parsed.adapterVersion},adapterContractSha256:selector.adapterContractSha256,snapshot:{...request.snapshot,bytes:await context.cas.read(request.snapshot.sourceSha256)},scope:request.scope,districtId:selector.districtId,candidates,supportingSources:selector.supportingSources,checkSupportingPolicies:async()=>{for(const source of selector.supportingSources){const proof=PolicyReceiptSchema.parse(JSON.parse((await context.cas.read(source.policyReceiptSha256)).toString('utf8')));await recheckPolicyReceipt(proof,{evaluationAt:new Date().toISOString()});}return supportAdmissions;},checkCurrentPolicy:async()=>{const checked=await recheckPolicyReceipt(receipt,{evaluationAt:new Date().toISOString()});return {receiptSha256:checked.receiptSha256,sourceSha256:receipt.source.sha256,scopeSha256:semanticHash(receipt.scope),allowed:true,checkedAt:new Date().toISOString()};},replayInSandbox:async()=>{const replay=await runParser();if(!('observations' in replay.result))throw Error('Expected parse replay');return replay.result;}});
 }
 const envelope=StructuredJobResultSchema.parse({schemaVersion:'district-structured-job-result-v2',requestSha256:parsed.requestSha256,adapterId:parsed.adapterId,adapterVersion:parsed.adapterVersion,adapterContractSha256:selector.adapterContractSha256,parserContractSha256:selector.parserContractSha256,mappingContractSha256:selector.mappingContractSha256,scope:request.scope,sourceSha256:request.snapshot.sourceSha256,policyReceiptSha256:policy.receiptSha256,supportingSources:selector.supportingSources,result,page:parsed.page,records,unpublishedObservations:'observations' in result?result.observations.length-records.length:0});
 const bytes=Buffer.from(canonicalJson(envelope)),hash=digest(bytes),storageKey=`sha256/${hash.slice(0,2)}/${hash}`;
 await initializeManagedAcquisitionLane(context.cas.root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
 const artifact=await withManagedSourceWrite(context.cas.root,sourceBindings.map(binding=>({...binding,relativePath:storageKey,contentSha256:hash,independentAllowed:false})),()=>context.cas.put(bytes,{kind:'parser_output',mimeType:'application/json'}),{authorityId:receipt.authorityId,authoritySha256:receipt.authoritySha256});
 const failure:Partial<Record<typeof coverage.state,JobHandlerResult>>={blocked_policy:{outcome:'blocked_policy',reasonCode:'policy_excluded'},blocked_access:{outcome:'blocked_access',reasonCode:'host_access_blocked'},held_origin:{outcome:'held_origin',reasonCode:'origin_unresolved'},held_quality:{outcome:'held_quality',reasonCode:'quality_failed'},held_execution:{outcome:'held_execution',reasonCode:'execution_exception'},failed_execution:{outcome:'failed_execution',reasonCode:'execution_exception'},not_checked:{outcome:'deferred',reasonCode:'quality_failed'}};
 return {...(failure[coverage.state]??{outcome:'succeeded' as const,reasonCode:'completed' as const}),outputs:[artifact],versions:{worker:STRUCTURED_WORKER_VERSION,adapter:parsed.adapterVersion,parser:selector.parserContractSha256,mapping:selector.mappingContractSha256,parserImage:parserReview.imageId,parserAuthorization:parserReview.runnerSha256},counts:{rows:coverage.observedRows,acceptedFacts:records.length,heldFacts:'observations' in result?result.observations.length-records.length:0,distinctCases:0}};
}
export const structuredJobHandlers:Readonly<Record<string,JobHandler>>={structured_discover:executeStructured,structured_parse:executeStructured};
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await runDistrictJobsCli(structuredJobHandlers,process.argv.slice(2),pipelineNotificationConfig);
