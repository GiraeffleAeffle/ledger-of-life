import {readFile,realpath,lstat} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {z} from 'zod';
import {hashSchema,sha256,SourceAccessPolicySchema,ContentFreeSourcePolicySchema,assertSubscriptionSourcePolicy} from './district-schema.ts';
import {excludedCrawlDocumentSchema} from './district-corpus.ts';
import {isPublicUrl} from './publication-quality.ts';
import {assertCivicPolicyAuthority,assertHostNotOptedOut,assertManagedSourceReadable,assertManagedObservationReadable,assertManagedRawSourceBinding,CIVIC_POLICY_AUTHORITY} from './civic-opt-out.ts';
import type {CivicPolicyOptions,ManagedSourceBinding} from './civic-opt-out.ts';
import type {SourceAccessPolicy} from './source-policy.ts';

const timestamp=z.string().datetime({offset:true});
const publicUrl=z.string().url().refine(isPublicUrl,'Unsafe observation URL');
const mime=z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/);
const header=z.string().max(4096).refine(value=>!/[\u0000-\u001f\u007f]/u.test(value),'Invalid HTTP scalar');
/** Original immutable observation fields only; never request-cache pointers. */
export const SourceObservationSchema=z.object({url:publicUrl,method:z.enum(['GET','POST']),checkedAt:timestamp,retrievedAt:timestamp,state:z.enum(['fetched','not_modified','excluded']),status:z.number().int().min(100).max(599),sha256:hashSchema,bytes:z.number().int().nonnegative(),mimeType:mime,etag:header.optional(),lastModified:header.optional(),policy:SourceAccessPolicySchema.optional(),exclusion:excludedCrawlDocumentSchema.shape.exclusion.optional()});
export type SourceObservation=z.infer<typeof SourceObservationSchema>;
export interface SourceObservationExpectation {
 url:string;sha256:string;mimeType:string;retrievedAt:string;checkedAt:string;status:number;sizeBytes:number;bodyState:'retained'|'excluded';
}
export function sourceObservationMatches(observation:SourceObservation,expected:SourceObservationExpectation):boolean {
 return observation.url===expected.url&&observation.sha256===expected.sha256&&observation.mimeType===expected.mimeType&&observation.retrievedAt===expected.retrievedAt&&observation.checkedAt===expected.checkedAt&&observation.status===expected.status&&observation.bytes===expected.sizeBytes&&
  (expected.bodyState==='excluded'?observation.state==='excluded'&&(observation.status===304||observation.status>=200&&observation.status<300):observation.state==='not_modified'?observation.status===304:observation.state==='fetched'&&observation.status>=200&&observation.status<300);
}
export interface SourceObservationDocument {
 url:string;sha256:string;mimeType:string;retrievedAt:string;checkedAt?:string;status?:number;observationPath?:string;exclusion?:unknown;
}
export interface ReadBoundSourceObservationOptions {
 rawRoot:string;document:SourceObservationDocument;policy?:CivicPolicyOptions;
 registeredSource?:{url:string|null;ownerRobotsOverride?:unknown};
}
export interface BoundSourceObservation {
 binding:Extract<ManagedSourceBinding,{kind:'http_observation'}>;policy:SourceAccessPolicy;observation:SourceObservation;sourceBytes:Buffer;
}
/** Source-processing admission: exact original in-root observation, no relocation or fallback.
 * Historical metadata-only inventory may use the shared schema/matcher separately,
 * but cannot use that weaker audit purpose to obtain an admitted source binding. */
export async function readBoundSourceObservation(options:ReadBoundSourceObservationOptions):Promise<BoundSourceObservation> {
 const document=options.document;
 if(document.exclusion!==undefined||!document.observationPath||!document.checkedAt||document.status===undefined)throw Error('Source observation index binding is incomplete or excluded');
 publicUrl.parse(document.url);hashSchema.parse(document.sha256);
 const selected=options.policy??CIVIC_POLICY_AUTHORITY,authority=await assertCivicPolicyAuthority(selected),policy={...selected,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
 await assertHostNotOptedOut(document.url,policy);
 const root=await realpath(options.rawRoot),observationPath=resolve(document.observationPath),name=basename(observationPath);
 if(dirname(observationPath)!==join(root,'observations')||!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(name))throw Error('Source observation is outside the explicitly managed raw root');
 const metadata=await lstat(observationPath);
 if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size>16*1024*1024||await realpath(observationPath)!==observationPath)throw Error('Source observation path/type/size rejected');
 const rawPath=join(root,'sha256',document.sha256);
 await assertManagedSourceReadable(rawPath,{...policy,sourceUrl:document.url});
 await assertManagedObservationReadable(observationPath,policy);
 const bytes=await readFile(observationPath),observation=SourceObservationSchema.parse(JSON.parse(bytes.toString('utf8'))),sizeBytes=(await lstat(rawPath)).size;
 await assertManagedObservationReadable(observationPath,policy);
 if(!sourceObservationMatches(observation,{...document,checkedAt:document.checkedAt,status:document.status,sizeBytes,bodyState:'retained'}))throw Error('Source observation does not bind the requested representation');
 const binding:BoundSourceObservation['binding']={kind:'http_observation',url:document.url,sourceSha256:document.sha256,observationId:name,receiptSha256:sha256(bytes)};
 await assertManagedRawSourceBinding(rawPath,binding,policy);
 const sourcePolicy=ContentFreeSourcePolicySchema.parse(observation.policy);
 assertSubscriptionSourcePolicy(sourcePolicy,{url:document.url,sha256:document.sha256,mimeType:document.mimeType},options.registeredSource);
 const sourceBytes=await readFile(rawPath);
 if(sourceBytes.length!==observation.bytes||sha256(sourceBytes)!==document.sha256)throw Error('Source representation bytes changed after observation binding');
 await assertManagedRawSourceBinding(rawPath,binding,policy);
 await assertHostNotOptedOut(document.url,policy);
 return {binding,policy:sourcePolicy,observation,sourceBytes};
}
