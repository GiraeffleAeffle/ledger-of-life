import {lstat,readFile} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {z} from 'zod';
import {digest} from '../src/district-adapter-contract.ts';
import {assertStep8R2CutoverReady} from '../src/r1-step8-current-policy.ts';
const hash=z.string().regex(/^[a-f0-9]{64}$/);
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
const [inputPath,observationSha256,drainSha256]=process.argv.slice(2);
if(process.argv.length!==5||!inputPath||!observationSha256||!drainSha256)throw Error('Use an absolute observation path plus independently pinned observation and drain SHA-256 values');
hash.parse(observationSha256);hash.parse(drainSha256);
const observationBytes=await readNonProductionFile(inputPath,'Observation');
if(digest(observationBytes)!==observationSha256)throw Error('R2 observation digest mismatch');
const observation=JSON.parse(observationBytes.toString('utf8')),drainProofPath=typeof observation?.drainProofPath==='string'?observation.drainProofPath:'';
if(!isAbsolute(drainProofPath))throw Error('Drain proof path must be absolute');
const drainProofBytes=await readNonProductionFile(drainProofPath,'Drain proof');
const result=await assertStep8R2CutoverReady({observationBytes,observationSha256,drainProofBytes,drainSha256});
process.stdout.write(JSON.stringify({schemaVersion:'stadtstack-r2-cutover-check-v1',status:'cutover-ready',...result},null,2));
