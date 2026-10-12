import {z} from 'zod';
import {readFile,realpath,lstat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {ManagedSourceBindingSchema,assertManagedSourceBindings,type CivicPolicyOptions} from './civic-opt-out.ts';
import {hashSchema,sha256} from './district-schema.ts';
import type {SourceArtifactBinding} from './district-private-io.ts';

// Decode the canonical proof body, removing only its separately checked custody flag.
const artifactBindingSchema=z.unknown().transform((input,ctx):SourceArtifactBinding=>{
 if(!input||typeof input!=='object'||Array.isArray(input)){ctx.addIssue({code:'custom',message:'Source artifact binding must be a closed object'});return z.NEVER;}
 const {independentAllowed,...body}=input as Record<string,unknown>,flag=z.boolean().safeParse(independentAllowed),binding=ManagedSourceBindingSchema.safeParse(body);
 if(!flag.success||!binding.success){ctx.addIssue({code:'custom',message:'Source artifact binding codec mismatch'});return z.NEVER;}
 if(binding.data.kind==='authenticated_git_snapshot'){ctx.addIssue({code:'custom',message:'Historical Git is preload-only, never general source provenance'});return z.NEVER;}
 return {...binding.data,independentAllowed:flag.data};
});
const pinSchema=z.object({path:z.string().min(1),sha256:hashSchema,bytes:z.number().int().nonnegative().max(512*1024*1024),bindings:z.array(artifactBindingSchema).min(1)}).strict();
export const privatePublicationProvenanceSchema=z.object({schemaVersion:z.literal('stadtstack-private-publication-provenance-v1'),inputs:z.array(pinSchema).min(1)}).strict();
export type PrivatePublicationProvenance=z.infer<typeof privatePublicationProvenanceSchema>;
export interface AuthenticatedPublicationProvenance {sha256:string;bindings:SourceArtifactBinding[];read(path:string):Promise<Buffer>;pins:ReadonlyMap<string,PrivatePublicationProvenance['inputs'][number]>}
const authenticatedProvenances=new WeakSet<object>();
export function assertAuthenticatedPublicationProvenance(value:AuthenticatedPublicationProvenance):void{if(!authenticatedProvenances.has(value))throw Error('Publication requires an authenticated provenance capability');}
/** Independent inventory pins plus actual live inventory proofs; no label grants rights. */
export async function authenticatePublicationProvenance(path:string,expectedSha256:string,policy:CivicPolicyOptions={}):Promise<AuthenticatedPublicationProvenance>{
 hashSchema.parse(expectedSha256);const filename=await realpath(resolve(path)),metadata=await lstat(filename);
 if(!metadata.isFile()||metadata.size>16*1024*1024)throw Error('Private publication provenance size/type rejected');
 const controlBytes=await readFile(filename);if(sha256(controlBytes)!==expectedSha256)throw Error('Private publication provenance independent pin mismatch');
 const inventory=privatePublicationProvenanceSchema.parse(JSON.parse(controlBytes.toString('utf8'))),pins=new Map<string,PrivatePublicationProvenance['inputs'][number]>(),contributors=new Map<string,SourceArtifactBinding>();
 for(const pin of inventory.inputs){
  const actual=await realpath(resolve(dirname(filename),pin.path));if(pins.has(actual))throw Error('Duplicate private publication provenance input');
  await assertManagedSourceBindings(actual,pin.bindings,policy);const stat=await lstat(actual);if(!stat.isFile()||stat.size!==pin.bytes)throw Error('Private publication provenance byte size mismatch');
  pins.set(actual,pin);for(const binding of pin.bindings)contributors.set(JSON.stringify(binding),binding);
 }
 const read=async(path:string)=>{
  const actual=await realpath(resolve(path)),pin=pins.get(actual);if(!pin)throw Error('Publication input lacks exact independently pinned source custody');
  await assertManagedSourceBindings(actual,pin.bindings,policy);const bytes=await readFile(actual);
  if(bytes.length!==pin.bytes||sha256(bytes)!==pin.sha256)throw Error('Private publication input byte binding mismatch');
  await assertManagedSourceBindings(actual,pin.bindings,policy);return bytes;
 };
 const authenticated={sha256:expectedSha256,bindings:[...contributors.values()],read,pins};
 authenticatedProvenances.add(authenticated);return authenticated;
}
