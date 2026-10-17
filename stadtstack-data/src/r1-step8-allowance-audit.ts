import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {canonicalJson,digest,HashSchema} from './district-adapter-contract.ts';
import {CodexAssessmentAllowanceSchema,CohortSchema} from './district-codex-allowance.ts';
import {assessmentItemSchema} from './district-assessment.ts';
import {root} from './common.ts';

const approvals=[
 ['r1-codex-assessment-allowance-2026-10-17','fe20dffb70f1521b90deca2b5070fcf37a3c468fbad386820b12a6e040a6055a'],
 ['r1-codex-assessment-allowance-2026-10-17-r2','8e246c5736c0a556b7d27f87e72e38ece1fe946e66a5fef13023e36cae0fef8d'],
 ['r1-codex-assessment-allowance-2026-10-17-r3','2e38add3bff06319566fdfcdf21cda85566deda77e07f5c8a7984e74fa9fea2d'],
 ['r1-codex-assessment-allowance-2026-10-17-r4','2d468d0967b122cf2c679586a37016bedb8d5a5f05220b5f47935557168110fd'],
 ['r1-codex-assessment-allowance-2026-10-17-r5','12f110244241e0294148cafc5fe13319b627b692136dfbfe18d61022f5e9b7d2'],
] as const;
export const STEP8_ALLOWANCE_READ_PLAN={
 approvals:approvals.map(([id,sha256])=>({path:join(root,'reports/approvals',id+'.json'),sha256})),
 cohort:{path:join(root,'reports/approvals/r1-frozen-assessment-cohort-2026-10-17.json'),sha256:'24c8629ec588f4898988c7ee7a61eb7e7b2809d0b0ab052fc34669512e789965'},
 bounds:{baseMaxCallsPerOriginal:48,maxExtraCallsPerOriginal:24,maxExtraCallsCohort:100,paidMicroUsd:0,stages:['assessment_a','assessment_c']},
 transitive:'Hash-pinned parent/delegation approvals, original/cohort/queue membership and committed stage authorizations; preserve migration-009 ordinals and all lifetime attempts without resets or refunds.',
};
const historicalSchema=CodexAssessmentAllowanceSchema.safeExtend({id:z.string(),assessment:CodexAssessmentAllowanceSchema.shape.assessment.extend({queueContractSha256:HashSchema})});
const requireThat=(value:unknown,message:string)=>{if(!value)throw Error(message);};
export async function auditStep8Allowance(client:Pick<PoolClient,'query'>,originals:string[],readJson:(hash:string)=>Promise<unknown>){
 const pins: Array<{path:string;sha256:string;record:unknown}>=[],records=new Map<string,z.infer<typeof historicalSchema>>();
 const pinned=async(id:string,sha256:string)=>{const path=join(root,'reports/approvals',id+'.json'),bytes=await readFile(path);requireThat(digest(bytes)===sha256,'Allowance approval pin mismatch');const record=JSON.parse(bytes.toString('utf8'));pins.push({path,sha256,record});return record;};
 for(const [id,sha256] of approvals){const record=historicalSchema.parse(await pinned(id,sha256));requireThat(record.id===id,'Allowance approval identity mismatch');records.set(sha256,record);}
 const current=records.get(approvals[4][1])!,cohort=CohortSchema.parse(await pinned('r1-frozen-assessment-cohort-2026-10-17',current.cohort.sha256));
 for(const parent of [current.parentApproval,current.delegationApproval])await pinned(parent.id,parent.sha256);
 requireThat(cohort.documents.length===cohort.documentCount&&cohort.sources.length===cohort.sourceCount&&new Set(cohort.documents.map(row=>row.originalSha256)).size===cohort.uniqueOriginalCount,'Allowance cohort cardinality mismatch');
 const allOriginals=[...new Set([...originals,...cohort.documents.map(member=>member.originalSha256)])];
 const rows=(await client.query(`SELECT to_jsonb(i) AS intent,to_jsonb(a) AS attribution,to_jsonb(c) AS authorization,j.job_key AS "jobKey",j.spec,d.max_calls AS "maxCalls"
  FROM district_pipeline.r1_codex_call_intents i JOIN district_pipeline.jobs j ON j.id=i.job_id JOIN district_pipeline.r1_codex_documents d ON d.original_sha256=i.original_sha256
  LEFT JOIN district_pipeline.r1_codex_allowance_intents a ON a.intent_id=i.id LEFT JOIN district_pipeline.r1_codex_call_authorizations c ON c.intent_id=i.id
  WHERE i.original_sha256=ANY($1::text[]) ORDER BY i.created_at,i.id`,[allOriginals])).rows;
 const counts=new Map<string,number>(),attributions=new Map<string,number[]>(),cohortOrdinals:number[]=[];
 for(const row of rows){const i=row.intent;counts.set(i.original_sha256,(counts.get(i.original_sha256)??0)+1);requireThat(Number(i.paid_micro_usd)===0,'Paid Codex intent in step8 accounting');
  requireThat(row.authorization&&row.spec.step===i.stage,'Codex intent lacks committed stage authorization');
  if(!row.attribution)continue;
  const a=row.attribution,approval=records.get(a.allowance_sha256);requireThat(approval,'Unknown historical allowance approval');if(!approval)throw Error('Unknown allowance');
  requireThat(a.original_sha256===i.original_sha256&&a.cohort_sha256===approval.cohort.sha256&&a.cohort_sha256===current.cohort.sha256,'Allowance original/cohort mismatch');
  requireThat(row.authorization&&['assessment_a','assessment_c'].includes(i.stage)&&row.spec.step===i.stage&&Number(row.maxCalls)===48&&row.spec.selector.maxModelCalls===48,'Allowance is not a base-48 authorized A/C call');
  requireThat(row.spec.semanticContractSha256===a.queue_contract_sha256&&a.queue_contract_sha256===approval.assessment.queueContractSha256,'Allowance queue contract mismatch');
  requireThat(Date.parse(a.created_at)>=Date.parse(approval.issuedAt)&&Date.parse(a.created_at)<Date.parse(approval.expiresAt),'Allowance event outside approval lifetime');
  requireThat(cohort.documents.some(member=>member.originalSha256===i.original_sha256&&canonicalJson(member.scope)===canonicalJson(row.spec.sourceScope)),'Allowance original outside frozen cohort scope');
  const item=assessmentItemSchema.parse(await readJson(HashSchema.parse(row.spec.selector.itemArtifactSha256)));
  requireThat(item.sourceRecord?.version===approval.assessment.projectionVersion&&!item.valueTarget&&item.sources.length===1&&item.sources[0].originalSha256===i.original_sha256,'Allowance item is not the original source-record v2');
  const ordinals=attributions.get(i.original_sha256)??[];ordinals.push(a.original_extra_ordinal);attributions.set(i.original_sha256,ordinals);cohortOrdinals.push(a.cohort_extra_ordinal);
 }
 const contiguous=(values:number[],max:number)=>values.length<=max&&values.sort((a,b)=>a-b).every((value,index)=>value===index+1);
 requireThat(contiguous(cohortOrdinals,100),'Allowance cohort lifetime ordinals are not contiguous within 100');
 for(const [original,total] of counts){const attributed=attributions.get(original)??[],maxCalls=Number(rows.find(row=>row.intent.original_sha256===original)!.maxCalls);requireThat(contiguous(attributed,24)&&attributed.length===Math.max(0,total-48)&&(attributed.length?maxCalls===48&&total<=72:total<=maxCalls),'Allowance original lifetime count/ordinal mismatch');}
 // Store the selected originals plus every attributed lifetime charge: historical
 // failed/ambiguous charges are never refunded or inferred from UUID/time order.
 return {schemaVersion:'stadtstack-r1-step8-allowance-evidence-v1',selectedOriginals:[...originals].sort(),approvals:pins,cohortSha256:current.cohort.sha256,cohort,
  lifetimeCounts:[...counts].map(([originalSha256,total])=>({originalSha256,total,attributed:(attributions.get(originalSha256)??[]).length})).sort((a,b)=>a.originalSha256.localeCompare(b.originalSha256)),
  accounting:rows.filter(row=>originals.includes(row.intent.original_sha256)||row.attribution),cohortExtraCalls:cohortOrdinals.length};
}
