import {mkdir,open,lstat,readFile,realpath} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {parse} from 'pg-connection-string';
import {isAbsolute} from 'node:path';
import {z} from 'zod';
import {HashSchema,canonicalJson} from './district-adapter-contract.ts';
import {loadFrozenCorpusBytes,R1_NINE_TOWN_2026_10_13_CORPUS_SHA256} from './district-corpus.ts';
import type {CivicPolicyOptions} from './civic-opt-out.ts';
import {assertCivicPolicyAuthority} from './civic-opt-out.ts';

export const Step8CampaignSchema=z.object({schemaVersion:z.literal('stadtstack-r1-step8-campaign-v1'),sources:z.array(z.object({municipalityId:z.string().min(1),sourceId:z.string().min(1),corpus:z.object({path:z.string().min(1),sha256:HashSchema}).strict(),documents:z.array(z.object({documentId:z.string().min(1),sha256:HashSchema,jobKey:HashSchema}).strict()).min(1)}).strict()).min(1)}).strict();
export type Step8Campaign=z.infer<typeof Step8CampaignSchema>;
export async function authenticateStep8Campaign(raw:unknown,read:(path:string)=>Promise<Uint8Array>,policy:CivicPolicyOptions){
 const campaign=Step8CampaignSchema.parse(raw),mode=(await assertCivicPolicyAuthority(policy)).mode,identities=new Set<string>(),jobs=new Set<string>();
 const corpora=campaign.sources.map(source=>source.corpus.sha256);
 if(new Set(corpora).size!==corpora.length)throw Error('Duplicate campaign corpus');
 if(mode!=='isolated-fixture'&&canonicalJson([...corpora].sort())!==canonicalJson([...R1_NINE_TOWN_2026_10_13_CORPUS_SHA256].sort()))throw Error('Campaign must equal the complete frozen nine-town corpus set');
 for(const source of campaign.sources){
  const identity=canonicalJson([source.municipalityId,source.sourceId]);if(identities.has(identity))throw Error('Duplicate campaign source identity');identities.add(identity);
  const corpus=loadFrozenCorpusBytes(await read(source.corpus.path),source.corpus.sha256),groups=new Map<string,Set<string>>();
  for(const document of corpus.documents){if(document.municipalityId!==source.municipalityId||document.sourceId!==source.sourceId)throw Error('Campaign corpus contains another source scope');const ids=groups.get(document.sha256)??new Set<string>();ids.add(document.id);groups.set(document.sha256,ids);}
  if(source.documents.length!==groups.size||new Set(source.documents.map(document=>document.sha256)).size!==groups.size)throw Error('Campaign omits or duplicates frozen document groups');
  for(const document of source.documents){if(!groups.get(document.sha256)?.has(document.documentId)||jobs.has(document.jobKey))throw Error('Campaign document/job membership mismatch');jobs.add(document.jobKey);}
 }
 return campaign;
}
export function assertStep8ExportMembership(source:Step8Campaign['sources'][number],results:readonly {documentId:string;corpusSha256:string;result:{taskId:string;municipalityId:string;sourceSha256:string}}[]){
 const expected=source.documents.map(document=>canonicalJson([document.documentId,document.sha256,document.jobKey])).sort();
 const actual=results.map(result=>{if(result.corpusSha256!==source.corpus.sha256||result.result.municipalityId!==source.municipalityId)throw Error('Exported campaign source scope mismatch');return canonicalJson([result.documentId,result.result.sourceSha256,result.result.taskId]);}).sort();
 if(canonicalJson(expected)!==canonicalJson(actual))throw Error('Exported campaign document/job set mismatch');
}
/** mkdir is the atomic generation reservation; the sibling claim is non-source control metadata. */
export async function reserveStep8Generation(output:string){
 await mkdir(output,{mode:0o700});
 const directory=await lstat(output),path=output+'.claim',nonce=randomUUID(),file=await open(path,'wx',0o600);
 try{await file.writeFile(nonce);await file.sync();}finally{await file.close();}
 const claim=await lstat(path);
 return {nonce,async assertOwned(){const current=await lstat(output),owner=await lstat(path);if(!current.isDirectory()||current.ino!==directory.ino||current.dev!==directory.dev||await realpath(output)!==output||!owner.isFile()||owner.ino!==claim.ino||owner.dev!==claim.dev||(await readFile(path,'utf8'))!==nonce)throw Error('Step8 generation claim changed');}};
}
export function classifyStep8Exception(value:unknown){
 const reasons:string[]=[];let criticalKind=false;
 const visit=(entry:unknown):void=>{if(Array.isArray(entry)){entry.forEach(visit);return;}if(entry&&typeof entry==='object')for(const [key,child] of Object.entries(entry)){if(key==='criticalKinds'&&Array.isArray(child)&&child.some(value=>typeof value==='string'))criticalKind=true;if(['reason','holdReasons','criticalKinds'].includes(key))reasons.push(...(Array.isArray(child)?child.filter((value):value is string=>typeof value==='string'):typeof child==='string'?[child]:[]));else visit(child);}};
 visit(value);const text=reasons.join(' ').toLowerCase();
 return {critical:criticalKind||/critical|assessment_held|assessment_missing/.test(text),rights:/rights|policy|robots|tdm|licen/.test(text),disagreement:/disagreement|unresolved|assessment_held|assessment_missing/.test(text)};
}
export function step8SocketConnection(dsn:string){const host=parse(dsn).host;if(!host||!isAbsolute(host))throw Error('Offline step8 requires a PostgreSQL Unix-domain socket');return dsn;}
export function assertNativeContributorCoverage(bindings:readonly {url:string;sourceSha256:string}[],sources:readonly {url:string;sha256:string}[]){
 const expected=[...new Set(sources.map(source=>canonicalJson([source.url,source.sha256])))].sort(),actual=bindings.map(binding=>canonicalJson([binding.url,binding.sourceSha256])).sort();
 if(canonicalJson(expected)!==canonicalJson(actual))throw Error('Native primary/supporting contributor coverage mismatch');
}
