import {lstat,readFile} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {z} from 'zod';
import {assertStep8R2CutoverReady} from '../src/r1-step8-current-policy.ts';

const hash=z.string().regex(/^[a-f0-9]{64}$/),path=z.string().min(1).refine(isAbsolute);
const InputSchema=z.object({
 schemaVersion:z.literal('stadtstack-r2-cutover-observation-v1'),authoritySha256:hash,inventorySha256:hash,observedAt:z.iso.datetime(),
 drainProofPath:path,drainSha256:hash,activeLeases:z.array(z.string().min(1).max(256)),oldReaderMarkers:z.array(z.string().min(1).max(4096)),
}).strict();
async function readNonProductionFile(path,label){
 const absolute=resolve(path);
 if(!isAbsolute(path)||absolute==='/etc'||absolute.startsWith('/etc/'))throw Error(label+' must be an absolute non-production file');
 let current='/',metadata;
 for(const part of absolute.split('/').filter(Boolean)){
  current=resolve(current,part);metadata=await lstat(current);
  if(metadata.isSymbolicLink()||current!==absolute&&!metadata.isDirectory())throw Error(label+' path contains a symlink or non-directory ancestor');
 }
 if(!metadata?.isFile())throw Error(label+' must be a regular file');
 return readFile(absolute);
}
const inputPath=process.argv[2];
if(process.argv.length!==3||!inputPath)throw Error('Use one absolute non-production observation file');
const input=InputSchema.parse(JSON.parse((await readNonProductionFile(inputPath,'Observation')).toString('utf8')));
const drainProofBytes=await readNonProductionFile(input.drainProofPath,'Drain proof');
const result=assertStep8R2CutoverReady({authoritySha256:input.authoritySha256,inventorySha256:input.inventorySha256,observedAt:input.observedAt,drainProofBytes,drainSha256:input.drainSha256,activeLeases:input.activeLeases,oldReaderMarkers:input.oldReaderMarkers});
process.stdout.write(JSON.stringify({schemaVersion:'stadtstack-r2-cutover-check-v1',status:'cutover-ready',...result},null,2)+'\n');
