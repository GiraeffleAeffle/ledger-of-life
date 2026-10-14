import {readFile} from 'node:fs/promises';
import {AsyncLocalStorage} from 'node:async_hooks';
import {assertCivicPolicyAuthority,type CivicPolicyOptions} from './civic-opt-out.ts';
import {z} from 'zod';
import {daySchema,hashSchema,sha256,SourceAccessPolicySchema} from './district-schema.ts';
import {documentOriginExcludes} from './source-policy.ts';

export const PILOT_BASE_CORPUS_SHA256='fbcd03c8474e3fa3cb2a3db0b9a976e3793863a3a6e268b0ead21868516ec2c0';
export const PILOT_COMPLETION_CORPUS_SHA256='fb4e08eee8bf1a3bf036433893553b5ebb0e7ae4dec1fea6ce702a8f66642992';
// 0.3.2 bounded targets (owner scope decision 2026-10-11, recorded by the VM lead 2026-10-12): exact crawl index bytes.
// Append-only: round-2 preparation plans in the fixed managed prepared root stay authenticated.
export const PATCH_032_R2_STRAUSBERG_SOLARPARK_CORPUS_SHA256='98a2432a6e423d9cfc0ac7263f8f38e66e03d3a04cf8be5990aec806e9e55d6f';
export const PATCH_032_R2_RUEDERSDORF_HEAT_CORPUS_SHA256='7b95020ed73079db0990986c5139c283841f525f3e3b77f12d7d182ed6ef4478';
export const PATCH_032_R2_HOPPEGARTEN_HEAT_CORPUS_SHA256='2dd6731e63d03e1928ef9d09f2854139a9296f934fc05e06c98c8220565821d0';
// Round 3: acquisition used for the gpt-6.1-sol extraction (registry contract 0f341059…).
export const PATCH_032_STRAUSBERG_SOLARPARK_CORPUS_SHA256='1306a37e00e47505bd9f8f13a80521587cb6efd41ad2a9a945b00b4b8446225d';
export const PATCH_032_RUEDERSDORF_HEAT_CORPUS_SHA256='5dcbf35e456d0c2fc04dd7ecfd3cb069f76020ffbb67c5bd245e1bacb7193db6';
export const PATCH_032_HOPPEGARTEN_HEAT_CORPUS_SHA256='9aae0d802de6aeb9b349bef5cd9862ceb573091dbad45f121bfacb39ad8f600a';
// Exact frozen Strausberg planning index under owner approvals r1-nine-town-crawl-2026-10-13
// (caae1253f8654a214174500d22e4a3d41251996c0e747d22bef41d6ca9b3c593) and r1-nine-town-models-2026-10-13
// (2ac6267d17ed08452665a0b2de92ec4da89915fe8619b668b85585301327502b); no scope or job authorization implied.
export const R1_NINE_TOWN_STRAUSBERG_PLANNING_CORPUS_SHA256='59dd581ab2fc27bada2c039d505e3763b7fa9125af65100f3464c272dde377c4';
// Exact owner-authorized snapshots; a caller-selected checksum cannot extend scope.
const ownerAuthorizedCorpusSchema=z.enum([PILOT_BASE_CORPUS_SHA256,PILOT_COMPLETION_CORPUS_SHA256,PATCH_032_R2_STRAUSBERG_SOLARPARK_CORPUS_SHA256,PATCH_032_R2_RUEDERSDORF_HEAT_CORPUS_SHA256,PATCH_032_R2_HOPPEGARTEN_HEAT_CORPUS_SHA256,PATCH_032_STRAUSBERG_SOLARPARK_CORPUS_SHA256,PATCH_032_RUEDERSDORF_HEAT_CORPUS_SHA256,PATCH_032_HOPPEGARTEN_HEAT_CORPUS_SHA256,R1_NINE_TOWN_STRAUSBERG_PLANNING_CORPUS_SHA256]);
const fixtureCorpus=new AsyncLocalStorage<{sha256:string;policy:CivicPolicyOptions}>();
export const authorizedPilotCorpusSchema=hashSchema.refine(hash=>ownerAuthorizedCorpusSchema.safeParse(hash).success||fixtureCorpus.getStore()?.sha256===hash,'Corpus is not an exact owner-authorized snapshot');
/** Test-only, scoped capability: no environment switch or production hash entry. */
export async function withFixtureAuthorizedCorpus<T>(bytes:Uint8Array,policy:CivicPolicyOptions,body:()=>Promise<T>):Promise<T>{
 if((await assertCivicPolicyAuthority(policy)).mode!=='isolated-fixture')throw Error('Corpus fixtures require an isolated authority realm');
 return fixtureCorpus.run({sha256:sha256(bytes),policy},body);
}
export function corpusFixturePolicy():CivicPolicyOptions|undefined{return fixtureCorpus.getStore()?.policy;}
export const crawlDocumentSchema=z.object({id:z.string(),municipalityId:z.string(),ags:z.string().regex(/^\d{8}$/),districtId:z.string(),sourceId:z.string(),url:z.url(),sha256:hashSchema,mimeType:z.string(),retrievedAt:z.iso.datetime(),checkedAt:z.iso.datetime().optional(),status:z.number().int().min(100).max(599).optional(),observationPath:z.string().min(1).optional(),documentDate:daySchema.nullable(),localPath:z.string(),adapter:z.string(),metadata:z.record(z.string(),z.unknown()),policy:z.unknown().optional(),exclusion:z.never().optional()});
export type CrawlDocument=z.infer<typeof crawlDocumentSchema>;
export const excludedCrawlDocumentSchema=crawlDocumentSchema.omit({localPath:true,policy:true,exclusion:true}).extend({
 checkedAt:z.iso.datetime(),status:z.number().int(),observationPath:z.string().min(1),policy:SourceAccessPolicySchema,sizeBytes:z.number().int().nonnegative(),
 exclusion:z.object({reason:z.literal('non_official_restricted'),excludedAt:z.iso.datetime(),previousManagedCopy:z.enum(['removed','retained_independent','not_managed','partial'])}).strict(),
}).strict().superRefine((document,ctx)=>{
 const origin=document.policy.documentOrigin;
 if(!origin||origin.url!==document.url||origin.sha256!==document.sha256||!documentOriginExcludes(document.policy,document))ctx.addIssue({code:'custom',message:'Excluded acquisition requires bound origin classification and an actual restriction'});
});
export type ExcludedCrawlDocument=z.infer<typeof excludedCrawlDocumentSchema>;
export const frozenCorpusSchema=z.object({schemaVersion:z.literal('stadtstack-crawl-index-v1'),documents:z.array(crawlDocumentSchema),excludedDocuments:z.array(excludedCrawlDocumentSchema).optional()}).passthrough();
export function loadFrozenCorpusBytes(bytes:Uint8Array,expectedSha256:string){
 authorizedPilotCorpusSchema.parse(expectedSha256);
 if(sha256(bytes)!==expectedSha256)throw Error('Frozen corpus index hash mismatch');
 return frozenCorpusSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
}
export async function loadFrozenCorpus(path:string,expectedSha256:string){
 authorizedPilotCorpusSchema.parse(expectedSha256);
 return loadFrozenCorpusBytes(await readFile(path),expectedSha256);
}
export function groupCrawlDocuments<T extends {municipalityId:string;sha256:string}>(documents:T[]):T[][]{
 const groups=new Map<string,T[]>();
 for(const document of documents){const key=`${document.municipalityId}:${document.sha256}`,group=groups.get(key);if(group)group.push(document);else groups.set(key,[document]);}
 return [...groups.values()];
}
interface SelectableDocument {municipalityId:string;sourceId:string;url:string;sha256:string;mimeType?:string;metadata?:Record<string,unknown>}
function documentPriority(document:SelectableDocument):number{
 const title=typeof document.metadata?.title==='string'?document.metadata.title:'';
 const content=/pdf|xml|json|zip/i.test(document.mimeType??'')||/\.(?:pdf|gml|xml|zip)(?:[?#]|$)/i.test(document.url);
 const caseBound=typeof document.metadata?.caseKey==='string';
 const topic=/wärme|waerme|solar|wind|wohn|bebau|bauleit|schul|kita|kindertag|verkehr|mobil|haushalt|invest|förder|foerder/iu.test(title);
 // Link-year hints rank work only; they never become document or stage dates.
 const recent=/202[456]/.test(title+' '+document.url);
 return (caseBound?16:0)+(content?8:0)+(topic?4:0)+(recent?1:0);
}
export function selectExtractionGroups<T extends SelectableDocument>(documents:T[],seeds:Array<{municipalityId:string;sourceId:string;url:string}>,limit?:number):T[][]{
 if(limit!==undefined&&(!Number.isInteger(limit)||limit<1))throw Error('Document limit per municipality must be a positive integer');
 const seedKeys=new Set(seeds.map(seed=>JSON.stringify([seed.municipalityId,seed.sourceId,seed.url])));
 const queues=new Map<string,Array<{group:T[];preferred:boolean;priority:number;order:number}>>();
 for(const [order,group] of groupCrawlDocuments(documents).entries()){
  const id=group[0].municipalityId,queue=queues.get(id)??[];
  queue.push({group,preferred:group.some(document=>seedKeys.has(JSON.stringify([id,document.sourceId,document.url]))),priority:Math.max(...group.map(documentPriority)),order});queues.set(id,queue);
 }
 const selected=[...queues.values()].map(queue=>queue.sort((a,b)=>Number(b.preferred)-Number(a.preferred)||b.priority-a.priority||a.order-b.order).slice(0,limit).map(item=>item.group));
 const result:T[][]=[];
 for(let turn=0;selected.some(queue=>turn<queue.length);turn++)for(const queue of selected)if(queue[turn])result.push(queue[turn]);
 return result;
}
