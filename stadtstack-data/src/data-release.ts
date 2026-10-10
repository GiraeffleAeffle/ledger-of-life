import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,lstat,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';

const sha=z.string().regex(/^[a-f0-9]{64}$/);
export const releasePathSchema=z.string().regex(/^(?:catalogue\.json|quality-report\.json|cities\/[a-z0-9-]+\/(?:signals(?:\.min)?\.geojson|feed\.json|changes\.json)|regions\/[a-z0-9-]+\/topics\.json|core\/(?:strausberg-facts|release-manifest|handover-draft)\.json|knowledge\/(?:registry|records|coverage)\.json)$/);
const fileSchema=z.object({path:releasePathSchema,sha256:sha,bytes:z.number().int().nonnegative().max(512*1024*1024)});
export const dataReleaseSchema=z.object({
 schemaVersion:z.literal('stadtstack-data-release-v1'),id:sha,generatedAt:z.string().datetime(),
 files:z.array(fileSchema).min(1).max(10000),
 quality:z.object({publishedRecords:z.number().int().nonnegative(),quarantinedRecords:z.number().int().nonnegative(),cities:z.number().int().positive(),knowledgeMunicipalities:z.number().int().nonnegative().optional(),districts:z.number().int().nonnegative().optional()}),
});
export type DataRelease=z.infer<typeof dataReleaseSchema>;
export function dataReleaseId(files:DataRelease['files']){
 const canonical=[...files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0).map(({path,sha256,bytes})=>({path,sha256,bytes}));
 return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
async function fileEvidence(directory:string,path:string){
 releasePathSchema.parse(path);
 const filename=join(directory,path),stat=await lstat(filename);
 if(!stat.isFile()||stat.size>512*1024*1024)throw Error(`Invalid release file: ${path}`);
 const hash=createHash('sha256');
 for await(const chunk of createReadStream(filename))hash.update(chunk);
 return {path,sha256:hash.digest('hex'),bytes:stat.size};
}
export function requireReleaseFiles(manifest:DataRelease,paths:readonly string[]){
 const present=new Set(manifest.files.map(file=>file.path));
 if(present.size!==manifest.files.length)throw Error('Duplicate release file');
 for(const path of paths)if(!present.has(path))throw Error(`Release does not bind required file: ${path}`);
}
/** Validate the exact buffer the consumer parses, not an earlier stream/read of its path. */
export async function readReleaseFile(directory:string,manifest:DataRelease,path:string):Promise<Buffer>{
 releasePathSchema.parse(path);
 const expected=manifest.files.find(file=>file.path===path);if(!expected)throw Error(`Release does not bind required file: ${path}`);
 const stat=await lstat(join(directory,path));if(!stat.isFile()||stat.size!==expected.bytes)throw Error(`Release file mismatch: ${path}`);
 const bytes=await readFile(join(directory,path));
 if(bytes.length!==expected.bytes||createHash('sha256').update(bytes).digest('hex')!==expected.sha256)throw Error(`Release file mismatch: ${path}`);
 return bytes;
}
export async function verifyDataRelease(directory:string):Promise<DataRelease>{
 const manifest=dataReleaseSchema.parse(JSON.parse(await readFile(join(directory,'release-manifest.json'),'utf8')));
 if(dataReleaseId(manifest.files)!==manifest.id)throw Error('Whole-data release identity mismatch');
 requireReleaseFiles(manifest,['catalogue.json','quality-report.json','core/strausberg-facts.json','core/release-manifest.json','core/handover-draft.json','regions/brandenburg-mol/topics.json','knowledge/registry.json','knowledge/records.json','knowledge/coverage.json']);
 for(const expected of manifest.files){
  const actual=await fileEvidence(directory,expected.path);
  if(actual.sha256!==expected.sha256||actual.bytes!==expected.bytes)throw Error(`Release file mismatch: ${expected.path}`);
 }
 return manifest;
}
export async function publishDataRelease(directory:string,paths:readonly string[],quality:DataRelease['quality'],generatedAt=new Date().toISOString()){
 if(new Set(paths).size!==paths.length)throw Error('Duplicate publication file');
 const files=[];
 for(const path of [...paths].sort())files.push(await fileEvidence(directory,path));
 const manifest=dataReleaseSchema.parse({schemaVersion:'stadtstack-data-release-v1',id:dataReleaseId(files),generatedAt,files,quality});
 // Written last; readers must reject any corpus not bound to this exact manifest.
 const path=join(directory,'release-manifest.json'),temporary=path+'.pending';
 await writeFile(temporary,JSON.stringify(manifest,null,2)+'\n',{flag:'w'});
 await rename(temporary,path);
 return manifest;
}
