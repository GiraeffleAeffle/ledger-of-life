import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {daySchema,hashSchema,sha256} from './district-schema.ts';

export const PILOT_BASE_CORPUS_SHA256='fbcd03c8474e3fa3cb2a3db0b9a976e3793863a3a6e268b0ead21868516ec2c0';
export const PILOT_COMPLETION_CORPUS_SHA256='fb4e08eee8bf1a3bf036433893553b5ebb0e7ae4dec1fea6ce702a8f66642992';
// Exact owner-authorized snapshots; a caller-selected checksum cannot extend scope.
export const authorizedPilotCorpusSchema=z.enum([PILOT_BASE_CORPUS_SHA256,PILOT_COMPLETION_CORPUS_SHA256]);
export const crawlDocumentSchema=z.object({id:z.string(),municipalityId:z.string(),ags:z.string().regex(/^\d{8}$/),districtId:z.string(),sourceId:z.string(),url:z.url(),sha256:hashSchema,mimeType:z.string(),retrievedAt:z.iso.datetime(),documentDate:daySchema.nullable(),localPath:z.string(),adapter:z.string(),metadata:z.record(z.string(),z.unknown()),policy:z.unknown().optional()});
export type CrawlDocument=z.infer<typeof crawlDocumentSchema>;
export const frozenCorpusSchema=z.object({schemaVersion:z.literal('stadtstack-crawl-index-v1'),documents:z.array(crawlDocumentSchema)}).passthrough();
export async function loadFrozenCorpus(path:string,expectedSha256:string){
 authorizedPilotCorpusSchema.parse(expectedSha256);
 const bytes=await readFile(path);
 if(sha256(bytes)!==hashSchema.parse(expectedSha256))throw Error('Frozen corpus index hash mismatch');
 return frozenCorpusSchema.parse(JSON.parse(bytes.toString('utf8')));
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
