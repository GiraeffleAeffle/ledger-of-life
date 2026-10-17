import {z} from 'zod';
import {HashSchema,digest,semanticHash} from './district-adapter-contract.ts';
import {identityDaySchema} from './district-entity-resolution.ts';
import {RetainedKnowledgeLineageSchema,type RetainedKnowledgeLineage} from './retained-knowledge-lineage.ts';

export const publicationStagingPathSchema=z.string().regex(/^(?:catalogue\.json|cities\/[a-z0-9-]+\/(?:signals\.geojson|feed\.json)|regions\/brandenburg-mol\/topics\.json|core\/strausberg-facts\.json|knowledge\/(?:registry|records|coverage|assessment-admissions)\.json)$/);
const memberSchema=z.object({path:publicationStagingPathSchema,sha256:HashSchema,bytes:z.number().int().nonnegative()}).strict();
const priorMemberSchema=z.object({path:z.string().regex(/^(?:cities\/[a-z0-9-]+\/(?:signals\.geojson|changes\.json)|knowledge\/(?:records|changes)\.json|core\/(?:strausberg-facts|release-manifest|handover-draft)\.json)$/),sha256:HashSchema,bytes:z.number().int().nonnegative()}).strict();
export const priorPublicationReleaseSchema=z.object({gitCommit:z.string().regex(/^[a-f0-9]{40}$/),manifestSha256:HashSchema,releaseId:HashSchema,directory:z.enum(['out','release']).optional(),members:z.array(priorMemberSchema).min(2)}).strict();
const dependencySchema=z.object({role:z.enum(['registry','text_composition','candidate_records','candidate_quarantine','structured_run','structured_receipts','question_disposition','adapter_contract','policy_receipts','regional_policy_receipts','identity_assessments','critical_assessments','legacy_city_changes','publication_contract','graph_contract','schema_contract','parser_contract','regional_contract']),sha256:HashSchema}).strict();
export type PublicationDependency=z.infer<typeof dependencySchema>;
export const knowledgePreparationInputsSchema=z.object({schemaVersion:z.literal('stadtstack-knowledge-preparation-inputs-v1'),dependencies:z.array(dependencySchema).min(1),outputs:z.array(memberSchema.extend({path:z.enum(['knowledge/registry.json','knowledge/records.json','knowledge/coverage.json','knowledge/assessment-admissions.json'])})).length(4)}).strict().superRefine((value,ctx)=>{
 for(const [rows,key] of [[value.dependencies,'role'],[value.outputs,'path']] as const)if(new Set(rows.map(row=>(row as unknown as Record<string,string>)[key])).size!==rows.length)ctx.addIssue({code:'custom',message:'Duplicate knowledge preparation input binding'});
 for(const role of ['registry','candidate_records','candidate_quarantine','critical_assessments'])if(!value.dependencies.some(dependency=>dependency.role===role))ctx.addIssue({code:'custom',message:`Missing knowledge preparation dependency: ${role}`});
});
const payloadSchema=z.object({schemaVersion:z.literal('stadtstack-publication-inputs-v1'),asOf:identityDaySchema,policy:z.object({snapshotSha256:HashSchema,receipts:z.array(z.object({recordId:z.string().min(1),receiptSha256:HashSchema}).strict())}).strict(),dependencies:z.array(dependencySchema).min(1),staging:z.array(memberSchema).min(1),priorRelease:priorPublicationReleaseSchema,retainedPublication:RetainedKnowledgeLineageSchema.optional()}).strict();
export const publicationInputsSchema=payloadSchema.extend({inputSha256:HashSchema}).strict().superRefine((value,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 const {inputSha256,...payload}=value;
 if(inputSha256!==semanticHash(payload))fail('Publication input seal mismatch');
 for(const [rows,key] of [[value.staging,'path'],[value.priorRelease.members,'path'],[value.dependencies,'role'],[value.policy.receipts,'recordId']] as const){
  const identifiers=rows.map(row=>(row as unknown as Record<string,string>)[key]);
  if(new Set(identifiers).size!==identifiers.length)fail('Duplicate publication input binding');
  if(identifiers.some((id,index)=>index>0&&identifiers[index-1]>=id))fail('Publication input bindings must be canonically ordered');
 }
 for(const role of ['registry','candidate_records','candidate_quarantine','policy_receipts','critical_assessments','publication_contract','graph_contract','schema_contract'])if(!value.dependencies.some(dependency=>dependency.role===role))fail(`Missing publication dependency: ${role}`);
});
export type PublicationInputs=z.infer<typeof publicationInputsSchema>;
export type PriorPublicationRelease=z.infer<typeof priorPublicationReleaseSchema>;
export function requiredPublicationStaging(cities:readonly string[]):string[]{
 if(new Set(cities).size!==cities.length||cities.some(city=>!/^[a-z0-9-]+$/.test(city)))throw Error('Invalid publication city inventory');
 return ['catalogue.json','regions/brandenburg-mol/topics.json','core/strausberg-facts.json','knowledge/registry.json','knowledge/records.json','knowledge/coverage.json','knowledge/assessment-admissions.json',...cities.flatMap(city=>[`cities/${city}/signals.geojson`,`cities/${city}/feed.json`])].sort();
}
/** Receipts are supplied by the shared current-policy admission boundary, never minted here. */
export function sealPublicationInputs(input:{asOf:string;policy:PublicationInputs['policy'];dependencies:PublicationInputs['dependencies'];staging:ReadonlyMap<string,Uint8Array>;priorRelease:PriorPublicationRelease;retainedPublication?:RetainedKnowledgeLineage|null}):PublicationInputs{
 const staging=[...input.staging].map(([path,bytes])=>({path,sha256:digest(bytes),bytes:bytes.byteLength})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const payload=payloadSchema.parse({schemaVersion:'stadtstack-publication-inputs-v1',asOf:input.asOf,policy:{snapshotSha256:input.policy.snapshotSha256,receipts:[...input.policy.receipts].sort((a,b)=>a.recordId<b.recordId?-1:a.recordId>b.recordId?1:0)},dependencies:[...input.dependencies].sort((a,b)=>a.role<b.role?-1:a.role>b.role?1:0),staging,priorRelease:{...input.priorRelease,members:[...input.priorRelease.members].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)},...(input.retainedPublication?{retainedPublication:input.retainedPublication}:{})});
 return publicationInputsSchema.parse({...payload,inputSha256:semanticHash(payload)});
}
export function verifyPublicationStaging(inputs:PublicationInputs,cities:readonly string[],staging:ReadonlyMap<string,Uint8Array>){
 publicationInputsSchema.parse(inputs);
 const required=requiredPublicationStaging(cities);
 if(JSON.stringify(inputs.staging.map(member=>member.path))!==JSON.stringify(required)||JSON.stringify([...staging.keys()].sort())!==JSON.stringify(required))throw Error('Publication requires the complete knowledge and non-knowledge staging inventory');
 for(const member of inputs.staging){const bytes=staging.get(member.path)!;if(bytes.byteLength!==member.bytes||digest(bytes)!==member.sha256)throw Error(`Publication input binding mismatch: ${member.path}`);}
 const prior=[...cities.flatMap(city=>[`cities/${city}/signals.geojson`,`cities/${city}/changes.json`]),'knowledge/records.json','core/strausberg-facts.json','core/release-manifest.json','core/handover-draft.json'].sort();
 if(inputs.priorRelease.members.some(member=>member.path==='knowledge/changes.json')){prior.push('knowledge/changes.json');prior.sort();}
 if(JSON.stringify(inputs.priorRelease.members.map(member=>member.path))!==JSON.stringify(prior))throw Error('Publication requires every authentic predecessor signal and change member');
}
export function verifyPublicationPolicyReceipts(inputs:PublicationInputs,recordIds:readonly string[]){
 const ids=[...recordIds].sort();
 if(new Set(ids).size!==ids.length||JSON.stringify(inputs.policy.receipts.map(receipt=>receipt.recordId))!==JSON.stringify(ids))throw Error('Publication requires one actual current-policy receipt for every admitted record');
 if(inputs.retainedPublication?.selectedRecordOrigins.some(origin=>!ids.includes(origin.recordId)))throw Error('Retained publication origin is not an admitted publication record');
}
