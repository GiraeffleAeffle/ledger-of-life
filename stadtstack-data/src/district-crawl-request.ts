import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {z} from 'zod';
import {HashSchema,digest,canonicalJson} from './district-adapter-contract.ts';
import {HttpSourceBindingSchema} from './district-http-observation.ts';
import {isPublicUrl} from './publication-quality.ts';
import {initializeManagedAcquisitionLane,withManagedSourceWrite,CIVIC_ACQUISITION_DECISION_ID,type CivicPolicyOptions} from './civic-opt-out.ts';
import {ownerGenesisAccessFor} from './source-policy.ts';

/** Local capture failure, never a failure of the already admitted HTTP source. */
export class CrawlRequestEvidenceCaptureError extends Error {
 constructor(){super('Managed request evidence capture failed');this.name='CrawlRequestEvidenceCaptureError';}
}
/** Only public selectors and digests: never request headers/account credentials. */
export const ObservationRequestSchema=z.object({
 url:z.url().refine(isPublicUrl,'Unsafe observation request URL'),method:z.enum(['GET','POST']),contentType:z.string().max(4096).refine(value=>!/[\u0000-\u001f\u007f]/u.test(value),'Invalid HTTP scalar').nullable(),bodySha256:HashSchema.nullable(),
 publicSelector:z.string().max(65536).nullable().refine(body=>body===null||![...new URLSearchParams(body).keys()].some(key=>/^(?:username|user|password|secret|authorization|access_token|api_key|apikey|token|sessionid|phpsessid|cookie)$/i.test(key)),'Credential-bearing selector is not public evidence'),
}).strict().superRefine((request,ctx)=>{
 if(request.publicSelector!==null&&digest(request.publicSelector)!==request.bodySha256||request.method==='GET'&&(request.bodySha256!==null||request.publicSelector!==null))ctx.addIssue({code:'custom',message:'Original public selector byte binding mismatch'});
});
export const CrawlRequestEvidenceSchema=z.object({schemaVersion:z.literal('stadtstack-crawl-request-evidence-v1'),httpObservation:HttpSourceBindingSchema,request:ObservationRequestSchema,redirectChain:z.array(ObservationRequestSchema.shape.url).min(1).max(21)}).strict().superRefine((evidence,ctx)=>{
 if(evidence.redirectChain[0]!==evidence.request.url||evidence.redirectChain.at(-1)!==evidence.httpObservation.url)ctx.addIssue({code:'custom',message:'Actual redirect endpoints differ from request/original'});
});
export const OwnerAcquisitionProducerSchema=z.object({jobKey:HashSchema,attempt:z.number().int().positive().max(2147483647),fencingToken:z.string().regex(/^[1-9]\d*$/).max(20)}).strict();
export type OwnerAcquisitionProducer=z.infer<typeof OwnerAcquisitionProducerSchema>;
/** Used only in the R1 owner-account sibling artifacts lane. The public crawl
 * codec and every legacy fetch-root observation/request format stay unchanged. */
export const OwnerAccountRequestEvidenceSchema=CrawlRequestEvidenceSchema.safeExtend({producer:OwnerAcquisitionProducerSchema});

async function persistManagedRequestEvidence(rawRoot:string,evidence:z.infer<typeof CrawlRequestEvidenceSchema>,policy:CivicPolicyOptions){
 const bytes=Buffer.from(canonicalJson(evidence)+'\n'),sha256=digest(bytes),root=rawRoot+'-request-evidence',relativePath='requests/'+evidence.httpObservation.observationId,path=join(root,relativePath);
 await initializeManagedAcquisitionLane(root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
 await withManagedSourceWrite(root,[{...evidence.httpObservation,relativePath,contentSha256:sha256,independentAllowed:false}],async()=>{await mkdir(join(root,'requests'),{recursive:true,mode:0o700});await writeFile(path,bytes,{flag:'wx',mode:0o600});},policy);
 return {path,sha256};
}

export async function persistOwnerAccountRequestEvidence(rawRoot:string,input:z.infer<typeof OwnerAccountRequestEvidenceSchema>,policy:CivicPolicyOptions){
 const evidence=OwnerAccountRequestEvidenceSchema.parse(input);
 if(!resolve(rawRoot).endsWith('-genesis-owner-account')||evidence.request.method!=='POST'||evidence.request.publicSelector!==null||!ownerGenesisAccessFor(evidence.request.url)||!ownerGenesisAccessFor(evidence.httpObservation.url))throw Error('Producer evidence requires the R1 owner-account lane');
 return persistManagedRequestEvidence(rawRoot,evidence,policy);
}

/** An ordinary source-bound artifacts entry; old 0.3.2 observation codecs stay unchanged. */
export async function persistCrawlRequestEvidence(rawRoot:string,input:z.infer<typeof CrawlRequestEvidenceSchema>,policy:CivicPolicyOptions){
 return persistManagedRequestEvidence(rawRoot,CrawlRequestEvidenceSchema.parse(input),policy);
}
