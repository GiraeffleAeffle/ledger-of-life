import {constants} from 'node:fs';
import {open,readdir,lstat,realpath} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import {z} from 'zod';
import {HashSchema,digest,semanticHash} from './district-adapter-contract.ts';
import {assertManagedSourceReadable,type CivicPolicyOptions} from './civic-opt-out.ts';

// Read-only decoding of district-answer-cache's existing private envelope. Keep
// that hashed generation/cache module unchanged: queued Codex contracts depend on it.
const BodySchema=z.object({binding:HashSchema,modelIdentitySha256:HashSchema,receivedAt:z.iso.datetime(),value:z.unknown(),responseSha256:HashSchema,returnedModel:z.string().nullable(),runtimeWarnings:z.array(z.string())}).strict();
const EnvelopeSchema=BodySchema.extend({cacheSha256:HashSchema}).strict();
export interface CodexCompletionIntent {id:string;request_sha256:string}
export interface CodexCompletionProof {intentId:string;requestSha256:string;answerContentSha256:string;cacheSha256:string}

/** No generation, locking, registration or cache publication: missing evidence
 * remains ambiguous. Managed custody and stable inode metadata authenticate the
 * exact bytes, not merely the envelope's freely recomputable self-digest. */
export async function completedCodexIntents(casRoot:string,jobKey:string,intents:CodexCompletionIntent[],policy:CivicPolicyOptions={}):Promise<CodexCompletionProof[]>{
 HashSchema.parse(jobKey);
 const root=join(dirname(casRoot),basename(casRoot)+'-residual-model',jobKey,'cache');
 let names:string[];
 try{if(await realpath(root)!==root)return [];names=await readdir(root);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
 const byRequest=new Map<string,CodexCompletionIntent[]>(),proofs:CodexCompletionProof[]=[];
 for(const intent of intents){const group=byRequest.get(intent.request_sha256);if(group)group.push(intent);else byRequest.set(intent.request_sha256,[intent]);}
 for(const name of names.sort()){
  if(!/^[a-f0-9]{64}\.answer\.json$/.test(name))continue;
  const binding=name.slice(0,64),requestSha256=semanticHash(binding),matching=byRequest.get(requestSha256);
  if(!matching)continue;
  const path=join(root,name);await assertManagedSourceReadable(path,policy);
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const before=await file.stat({bigint:true});if(!before.isFile())throw Error('Completed answer cache file rejected');
   const bytes=await file.readFile(),cached=EnvelopeSchema.parse(JSON.parse(bytes.toString('utf8'))),{cacheSha256,...body}=cached;
   if(body.binding!==binding||digest(JSON.stringify(body))!==cacheSha256)throw Error('Completed answer cache integrity mismatch');
   await assertManagedSourceReadable(path,policy);
   const after=await file.stat({bigint:true}),current=await lstat(path,{bigint:true});
   if(!current.isFile()||[after,current].some(stat=>stat.dev!==before.dev||stat.ino!==before.ino||stat.size!==before.size||stat.mtimeNs!==before.mtimeNs||stat.ctimeNs!==before.ctimeNs))throw Error('Completed answer cache changed during authentication');
   const answerContentSha256=digest(bytes);
   for(const intent of matching)proofs.push({intentId:intent.id,requestSha256,answerContentSha256,cacheSha256});
  }finally{await file.close();}
 }
 return proofs;
}
