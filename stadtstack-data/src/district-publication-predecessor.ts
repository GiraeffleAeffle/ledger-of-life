import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import {root,hash} from './common.ts';
import {dataReleaseSchema,dataReleaseId,releasePathSchema} from './data-release.ts';
import {HashSchema} from './district-adapter-contract.ts';

export const priorReleaseSchema=z.object({gitCommit:z.string().regex(/^[a-f0-9]{40}$/),manifestSha256:HashSchema,releaseId:HashSchema}).strict();
export type PriorRelease=z.infer<typeof priorReleaseSchema>;
const execute=promisify(execFile);
export interface PriorReleaseCache {readonly authenticated:true}
const authenticatedCaches=new WeakMap<PriorReleaseCache,ReadonlyMap<string,string>>();
/** The private map contains immutable byte encodings, never caller-owned mutable buffers. */
export async function preloadPriorPublicationReleases(requests:readonly {prior:PriorRelease;paths:readonly string[];targetGeneratedAt:string;targetReleaseId?:string}[]):Promise<PriorReleaseCache>{
 const entries=new Map<string,string>();
 for(const request of requests){
  const loaded=await loadPriorPublicationRelease(request.prior,request.paths,request.targetGeneratedAt,request.targetReleaseId);
  for(const [path,bytes] of [['release-manifest.json',loaded.manifestBytes] as const,...loaded.files]){
   const key=`${request.prior.gitCommit}:${path}`,encoded=bytes.toString('base64'),existing=entries.get(key);
   if(existing!==undefined&&existing!==encoded)throw Error('Conflicting authenticated predecessor bytes');
   entries.set(key,encoded);
  }
 }
 const cache=Object.freeze({authenticated:true as const});authenticatedCaches.set(cache,entries);return cache;
}
export async function readCommittedReleaseFile(commit:string,path:string,cache?:PriorReleaseCache):Promise<Buffer>{
 if(!/^(?:[a-f0-9]{40}|HEAD)$/.test(commit))throw Error('Invalid committed release identity');
 if(path!=='release-manifest.json')releasePathSchema.parse(path);
 if(cache){const entries=authenticatedCaches.get(cache),encoded=entries?.get(`${commit}:${path}`);if(encoded===undefined)throw Error('Authenticated predecessor cache miss; process execution is forbidden');return Buffer.from(encoded,'base64');}
 try{return (await execute('git',['--no-replace-objects','show',`${commit}:./out/${path}`],{cwd:root,encoding:'buffer',maxBuffer:512*1024*1024,env:{...process.env,GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'}})).stdout;}
 catch{throw Error('Replay prior committed release object missing; network fetch is forbidden');}
}
export async function loadPriorPublicationRelease(input:PriorRelease,paths:readonly string[],targetGeneratedAt:string,targetReleaseId?:string,cache?:PriorReleaseCache){
 const prior=priorReleaseSchema.parse(input),bytes=await readCommittedReleaseFile(prior.gitCommit,'release-manifest.json',cache);
 if(hash(bytes)!==prior.manifestSha256)throw Error('Replay prior committed manifest digest mismatch');
 const manifest=dataReleaseSchema.parse(JSON.parse(bytes.toString('utf8')));
 if(manifest.id!==prior.releaseId||dataReleaseId(manifest.files)!==manifest.id||manifest.id===targetReleaseId||Date.parse(manifest.generatedAt)>=Date.parse(z.iso.datetime().parse(targetGeneratedAt))||new Set(manifest.files.map(file=>file.path)).size!==manifest.files.length)throw Error('Publication requires an authentic earlier baseline, not the target release');
 const members=[],files=new Map<string,Buffer>();
 for(const path of [...paths].sort()){
  if(files.has(path))throw Error('Duplicate predecessor member');
  const file=manifest.files.find(file=>file.path===path);if(!file)throw Error(`Replay prior baseline member missing: ${path}`);
  const body=await readCommittedReleaseFile(prior.gitCommit,path,cache);
  if(hash(body)!==file.sha256||body.length!==file.bytes)throw Error('Replay prior committed member binding mismatch');
  members.push({path,sha256:file.sha256,bytes:file.bytes});files.set(path,body);
 }
 return {manifest,manifestBytes:bytes,priorRelease:{...prior,members},files};
}
