import {z} from 'zod';
import {join} from 'node:path';
import {assertManagedSourceReadable,assertManagedSourceBindings,type CivicPolicyOptions} from './civic-opt-out.ts';
import {HashSchema,digest} from './district-adapter-contract.ts';
import {ContentFreeSourcePolicySchema} from './district-schema.ts';
import {SourceObservationSchema} from './source-observation.ts';
import type {ManagedSourceBinding} from './civic-opt-out.ts';

export const HttpObservationSchema=SourceObservationSchema.omit({exclusion:true}).extend({state:z.enum(['fetched','not_modified']),status:z.number().int().min(200).max(399),policy:ContentFreeSourcePolicySchema.optional()}).strict();
export const HttpObservationProofSchema=z.object({observationId:z.string().regex(/^[0-9]+-[a-f0-9-]{36}\.json$/).max(160),receiptSha256:HashSchema,bytes:z.string().max(1024*1024)}).strict().superRefine((proof,ctx)=>{
 if(Buffer.byteLength(proof.bytes)>1024*1024||digest(proof.bytes)!==proof.receiptSha256)ctx.addIssue({code:'custom',message:'Original HTTP observation byte digest/bound mismatch'});
 try{HttpObservationSchema.parse(JSON.parse(proof.bytes));}catch{ctx.addIssue({code:'custom',message:'Original HTTP observation safe schema mismatch'});}
});
export const HttpSourceBindingSchema=z.object({kind:z.literal('http_observation'),url:SourceObservationSchema.shape.url,sourceSha256:HashSchema,observationId:HttpObservationProofSchema.shape.observationId,receiptSha256:HashSchema}).strict();
export type HttpObservationProof=z.infer<typeof HttpObservationProofSchema>;
export function authenticatedHttpBinding(proofInput:unknown,expected:{url:string;sha256:string;mimeType?:string;retrievedAt?:string;fetchedAt?:string}):Extract<ManagedSourceBinding,{kind:'http_observation'}>{
 const proof=HttpObservationProofSchema.parse(proofInput),observation=HttpObservationSchema.parse(JSON.parse(proof.bytes));
 if(observation.url!==expected.url||observation.sha256!==expected.sha256||expected.mimeType!==undefined&&observation.mimeType!==expected.mimeType||expected.retrievedAt!==undefined&&observation.retrievedAt!==expected.retrievedAt||expected.fetchedAt!==undefined&&observation.checkedAt!==expected.fetchedAt||observation.state==='fetched'&&(observation.status<200||observation.status>=300)||observation.state==='not_modified'&&observation.status!==304)throw Error('Original HTTP observation does not bind the selected representation');
 return {kind:'http_observation',url:observation.url,sourceSha256:observation.sha256,observationId:proof.observationId,receiptSha256:proof.receiptSha256};
}

export async function authenticateHttpSourceBindings(cas:{root:string;read:(hash:string)=>Promise<Uint8Array>},bindings:ManagedSourceBinding[],sources:{url:string;sha256:string}[],policy:CivicPolicyOptions={}):Promise<Extract<ManagedSourceBinding,{kind:'http_observation'}>[]>{
 const result:Extract<ManagedSourceBinding,{kind:'http_observation'}>[]=[];
 for(const source of sources){
  const matches=bindings.filter(binding=>binding.kind==='http_observation'&&binding.url===source.url&&binding.sourceSha256===source.sha256);
  if(matches.length!==1)throw Error('Exactly one original HTTP binding is required per selected source');
  const selected=matches[0];if(selected.kind!=='http_observation')throw Error('Original HTTP provenance required');
  await assertManagedSourceReadable(join(cas.root,'sha256',selected.receiptSha256.slice(0,2),selected.receiptSha256),{...policy,sourceUrl:source.url});
  const bytes=Buffer.from(await cas.read(selected.receiptSha256));
  const bound=authenticatedHttpBinding({observationId:selected.observationId,receiptSha256:selected.receiptSha256,bytes:bytes.toString('utf8')},source);
  await assertManagedSourceBindings(join(cas.root,'sha256',source.sha256.slice(0,2),source.sha256),[selected],{...policy,sourceUrl:source.url});
  result.push(bound);
 }
 if(bindings.some(binding=>binding.kind!=='http_observation'||!sources.some(source=>source.url===binding.url&&source.sha256===binding.sourceSha256)))throw Error('Unselected source binding');
 return result;
}
