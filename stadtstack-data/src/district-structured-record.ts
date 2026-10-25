import {z} from 'zod';
import {HashSchema,ObservationSchema,StructuredLocatorSchema,ScopeSchema,semanticHash,canonicalJson,assertSnapshot,type StructuredAdapter,type AdmittedSnapshot,type AdapterScope,type StructuredObservation,type ParseResult} from './district-adapter-contract.ts';
import {EffectiveIntervalSchema,IdentityMentionSchema,IdentityAssertionSchema,identityDaySchema,nativeStructuredIdentityGraph} from './district-entity-resolution.ts';
import {structuredFieldPublicationHold} from './district-public-fields.ts';

export const STRUCTURED_VERIFICATION_VERSION='structured-field-replay-v1';
export const StructuredRelationSchema=z.object({id:HashSchema,subjectMentionId:z.string().min(1),objectMentionId:z.string().min(1),predicate:z.string().min(1),modality:z.enum(['asserted','planned','conditional','negated','historical']),validity:EffectiveIntervalSchema,eventDate:identityDaySchema.nullable(),eventDateRole:z.string().nullable(),evidence:z.array(StructuredLocatorSchema).min(1)}).strict();
export const StructuredGraphSchema=z.object({mentions:z.array(IdentityMentionSchema),assertions:z.array(IdentityAssertionSchema),relations:z.array(StructuredRelationSchema)}).strict();
export const StructuredVerificationSchema=z.object({kind:z.literal('structured'),status:z.literal('auto-verified'),version:z.literal(STRUCTURED_VERIFICATION_VERSION),adapterId:z.string().min(1),mappingVersion:z.string().min(1),adapterContractSha256:HashSchema,sourceSha256:HashSchema,policyReceiptSha256:HashSchema,scopeSha256:HashSchema,locators:z.array(StructuredLocatorSchema).min(1),deterministic:z.object({passed:z.literal(true),checks:z.array(z.object({id:z.string().min(1),passed:z.literal(true),reason:z.string().min(1)}).strict()).min(1)}).strict(),evidenceHash:HashSchema}).strict();
export const StructuredSourceSchema=z.object({id:z.string().min(1),url:z.url(),sha256:HashSchema,mimeType:z.string().min(1),retrievedAt:z.iso.datetime(),policyReceiptSha256:HashSchema}).strict();
export const StructuredSupportingSourceSchema=StructuredSourceSchema.extend({scopeSha256:HashSchema,role:z.enum(['municipality_join','source_metadata'])}).strict();
export type StructuredSupportingSource=z.infer<typeof StructuredSupportingSourceSchema>;
export const StructuredKnowledgeRecordSchema=z.object({kind:z.literal('structured'),id:z.string().regex(/^structured:[a-f0-9]{64}$/),municipalityId:z.string().min(1),ags:z.string().regex(/^\d{8}$/),districtId:z.string().min(1),scope:ScopeSchema,observation:ObservationSchema,source:StructuredSourceSchema,supportingSources:z.array(StructuredSupportingSourceSchema),graph:StructuredGraphSchema,verification:StructuredVerificationSchema}).strict().superRefine((record,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 const publicFieldHold=structuredFieldPublicationHold(record.observation);if(publicFieldHold)fail(`Structured field publication held: ${publicFieldHold}`);
 if(record.id!==`structured:${record.observation.id}`)fail('Structured record ID mismatch');
 if(record.municipalityId!==record.scope.municipalityId||record.ags!==record.scope.ags)fail('Structured scope mismatch');
 if(record.observation.sourceId!==record.scope.sourceId||record.observation.publisherId!==record.scope.publisherId||record.source.id!==record.scope.sourceId)fail('Structured source identity mismatch');
 if(record.verification.sourceSha256!==record.source.sha256||record.verification.policyReceiptSha256!==record.source.policyReceiptSha256||record.verification.scopeSha256!==semanticHash(record.scope))fail('Structured admission binding mismatch');
 if(record.observation.evidence.some(locator=>locator.sourceSha256!==record.source.sha256)||canonicalJson(record.verification.locators)!==canonicalJson(record.observation.evidence))fail('Structured locator mismatch');
 const supportKeys=record.supportingSources.map(source=>`${source.role}:${source.sha256}`);
 if(new Set(supportKeys).size!==supportKeys.length)fail('Duplicate supporting source');
 for(const evidence of record.observation.supportingEvidence)if(evidence.locator.sourceSha256!==record.source.sha256&&!record.supportingSources.some(source=>source.role===evidence.role&&source.sha256===evidence.locator.sourceSha256))fail('Unbound supporting evidence');
 for(const source of record.supportingSources)if(!record.observation.supportingEvidence.some(evidence=>evidence.role===source.role&&evidence.locator.sourceSha256===source.sha256))fail('Unreferenced supporting source');
 const {id,...observation}=record.observation;if(id!==semanticHash(observation))fail('Observation semantic identity mismatch');
 const {verification,...claims}=record;const {evidenceHash,...gates}=verification;if(evidenceHash!==semanticHash({...claims,verification:gates}))fail('Structured verification hash mismatch');
 const mentions=new Map(record.graph.mentions.map(mention=>[mention.id,mention]));
 if(mentions.size!==record.graph.mentions.length)fail('Duplicate structured mention');
 for(const mention of mentions.values())if(mention.sourceSha256!==record.source.sha256||mention.municipalityId!==record.municipalityId)fail('Unbound structured mention');
 for(const relation of record.graph.relations)if(!mentions.has(relation.subjectMentionId)||!mentions.has(relation.objectMentionId)||relation.evidence.some(locator=>locator.sourceSha256!==record.source.sha256))fail('Unbound structured relation');
 for(const assertion of record.graph.assertions)if(!mentions.has(assertion.leftMentionId)||!mentions.has(assertion.rightMentionId))fail('Unbound structured identity assertion');
 try{if(canonicalJson(record.graph)!==canonicalJson(nativeStructuredIdentityGraph(record.observation,record.scope)))fail('Structured graph differs from pinned native identity mapping');}catch{fail('Native identity evidence is invalid');}
});
export type StructuredKnowledgeRecord=z.infer<typeof StructuredKnowledgeRecordSchema>;
export interface StructuredAdmission {receiptSha256:string;sourceSha256:string;scopeSha256:string;allowed:boolean;checkedAt:string}
/** Current policy is checked even for cached parser output. The callback is the shared acquisition policy, not a second rights engine. */
export async function admitStructuredObservations(input:{adapter:Pick<StructuredAdapter,'id'|'version'>;adapterContractSha256:string;snapshot:AdmittedSnapshot;scope:AdapterScope;districtId:string;candidates:StructuredObservation[];checkCurrentPolicy:()=>Promise<StructuredAdmission>;replayInSandbox:()=>Promise<ParseResult>;supportingSources?:StructuredSupportingSource[];checkSupportingPolicies?:()=>Promise<StructuredAdmission[]>}):Promise<StructuredKnowledgeRecord[]> {
 assertSnapshot(input.snapshot);HashSchema.parse(input.adapterContractSha256);ScopeSchema.parse(input.scope);
 const admission=await input.checkCurrentPolicy();
 if(!admission.allowed||admission.sourceSha256!==input.snapshot.sourceSha256||admission.scopeSha256!==semanticHash(input.scope)||admission.receiptSha256!==input.snapshot.policyReceiptSha256||!Number.isFinite(Date.parse(admission.checkedAt)))throw Error('Structured policy admission missing or stale binding');
 const supporting=(input.supportingSources??[]).map(source=>StructuredSupportingSourceSchema.parse(source));
 const supportAdmissions=input.checkSupportingPolicies?await input.checkSupportingPolicies():[];
 for(const source of supporting)if(!supportAdmissions.some(proof=>proof.allowed&&proof.sourceSha256===source.sha256&&proof.receiptSha256===source.policyReceiptSha256&&proof.scopeSha256===source.scopeSha256&&Number.isFinite(Date.parse(proof.checkedAt))))throw Error('Supporting source lacks current policy admission');
 const replay=await input.replayInSandbox();
 if(!['complete','partial','empty'].includes(replay.coverage.state))throw Error(`Structured parse held: ${replay.coverage.state}`);
 const originals=new Map(replay.observations.map(value=>[value.id,canonicalJson(ObservationSchema.parse(value))]));
 if(originals.size!==replay.observations.length)throw Error('Duplicate structured native observation');
 const ids=new Set<string>();
 return input.candidates.map(candidate=>{
  const observation=ObservationSchema.parse(candidate);
  const publicFieldHold=structuredFieldPublicationHold(observation);if(publicFieldHold)throw Error(`Structured field publication held: ${publicFieldHold}`);
  if(ids.has(observation.id)||originals.get(observation.id)!==canonicalJson(observation))throw Error('Structured mapping replay mismatch');ids.add(observation.id);
  if(observation.geography.ags!==input.scope.ags||observation.geography.basis==='unknown'||!['project_location','performance_location','administrative_area'].includes(observation.geography.role))throw Error('Structured observation lacks applicable municipal geography');
  const supportingSources=supporting.filter(source=>observation.supportingEvidence.some(evidence=>evidence.role===source.role&&evidence.locator.sourceSha256===source.sha256));
  if(observation.supportingEvidence.some(evidence=>evidence.locator.sourceSha256!==input.snapshot.sourceSha256&&!supportingSources.some(source=>source.role===evidence.role&&source.sha256===evidence.locator.sourceSha256)))throw Error('Supporting evidence lacks original source admission');
  const claims={kind:'structured' as const,id:`structured:${observation.id}`,municipalityId:input.scope.municipalityId,ags:input.scope.ags,districtId:input.districtId,scope:input.scope,observation,source:{id:input.scope.sourceId,url:input.snapshot.url,sha256:input.snapshot.sourceSha256,mimeType:input.snapshot.mimeType,retrievedAt:input.snapshot.retrievedAt,policyReceiptSha256:admission.receiptSha256},supportingSources,graph:nativeStructuredIdentityGraph(observation,input.scope)};
  const gates={kind:'structured' as const,status:'auto-verified' as const,version:STRUCTURED_VERIFICATION_VERSION,adapterId:input.adapter.id,mappingVersion:input.adapter.version,adapterContractSha256:input.adapterContractSha256,sourceSha256:input.snapshot.sourceSha256,policyReceiptSha256:admission.receiptSha256,scopeSha256:admission.scopeSha256,locators:observation.evidence,deterministic:{passed:true as const,checks:[{id:'native_field_replay',passed:true as const,reason:'Candidate equals deterministic parser output for exact admitted bytes and scope.'},{id:'current_policy',passed:true as const,reason:'Current shared policy admits the source bytes in this scope.'}]}};
  return StructuredKnowledgeRecordSchema.parse({...claims,verification:{...gates,evidenceHash:semanticHash({...claims,verification:gates})}});
 });
}
