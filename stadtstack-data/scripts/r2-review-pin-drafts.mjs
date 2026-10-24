import {lstat,readFile,writeFile} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {z} from 'zod';
import {ParserReviewSchema,PARSER_ISOLATION_VERSION,parserIsolationContractSha256,parserOutputContractSha256} from '../src/district-parser-isolation.ts';
import {OmpReviewSchema,OMP_RUNNER_VERSION,OMP_HOST_VERSION,ompRunnerContractSha256} from '../src/district-omp-b-runner.ts';

const CANDIDATE_IMAGE='sha256:4feb00e1d9fa7802c523e9b6af16b8ab72014e0bf812d1b345b7a155eb608046';
const CANDIDATE_PARSER_ISOLATION='04edb466058cbb79faa03432978640d96181d366b8dfddcffd251e1fab4326c3';
const CANDIDATE_PARSER_OUTPUT='79999b46004d9471ff4c76f3267b5d5db707308077924ab27dcc3c6dc3504530';
const image=z.string().regex(/^sha256:[a-f0-9]{64}$/),hash=z.string().regex(/^[a-f0-9]{64}$/);
const InputSchema=z.object({
 schemaVersion:z.literal('stadtstack-r2-review-pin-draft-input-v1'),
 parser:z.object({imageId:image,securityReviewId:z.string().min(1).max(200),reviewedBy:z.string().min(1).max(200),reviewedAt:z.iso.datetime(),dockerSocket:z.string().min(1)}).strict(),
 omp:z.object({imageId:image,ompBinarySha256:hash,hostResolverBinarySha256:hash,dockerDaemonId:z.string().regex(/^[A-Za-z0-9:_-]{1,256}$/),securityReviewId:z.string().min(1).max(200),reviewedBy:z.string().min(1).max(200),reviewedAt:z.iso.datetime(),dockerSocket:z.string().min(1)}).strict(),
}).strict();
async function existingNonProductionPath(path,label,kind){
 const absolute=resolve(path);
 if(!isAbsolute(path)||absolute==='/etc'||absolute.startsWith('/etc/'))throw Error(label+' must be an absolute non-production path');
 let current='/',metadata;
 for(const part of absolute.split('/').filter(Boolean)){
  current=resolve(current,part);metadata=await lstat(current);
  if(metadata.isSymbolicLink()||current!==absolute&&!metadata.isDirectory())throw Error(label+' path contains a symlink or non-directory ancestor');
 }
 if(!metadata||kind==='file'&&!metadata.isFile()||kind==='directory'&&!metadata.isDirectory())throw Error(label+' must be an existing '+kind);
 return absolute;
}
const [inputPath,outDir]=process.argv.slice(2);
if(process.argv.length!==4||!inputPath||!outDir)throw Error('Use absolute input and non-production draft output paths');
const inputFile=await existingNonProductionPath(inputPath,'Review input','file'),outputDirectory=await existingNonProductionPath(outDir,'Draft output','directory');
const input=InputSchema.parse(JSON.parse(await readFile(inputFile,'utf8')));
if(Date.parse(input.parser.reviewedAt)>Date.now()||Date.parse(input.omp.reviewedAt)>Date.now())throw Error('Review timestamp cannot be in the future');
const [parserOutputSha256,parserRunnerSha256,ompRunnerContractSha256Value]=await Promise.all([parserOutputContractSha256(),parserIsolationContractSha256(),ompRunnerContractSha256()]);
if(input.parser.imageId===CANDIDATE_IMAGE&&(parserOutputSha256!==CANDIDATE_PARSER_OUTPUT||parserRunnerSha256!==CANDIDATE_PARSER_ISOLATION))throw Error('Parser worker/output contract changed; rebuild the candidate image before review');
const parser=ParserReviewSchema.parse({version:PARSER_ISOLATION_VERSION,imageId:input.parser.imageId,runnerSha256:parserRunnerSha256,securityReviewId:input.parser.securityReviewId,reviewedBy:input.parser.reviewedBy,reviewedAt:input.parser.reviewedAt,dockerSocket:input.parser.dockerSocket});
const omp=OmpReviewSchema.parse({version:OMP_RUNNER_VERSION,imageId:input.omp.imageId,runnerContractSha256:ompRunnerContractSha256Value,ompBinarySha256:input.omp.ompBinarySha256,hostResolverBinarySha256:input.omp.hostResolverBinarySha256,hostResolverVersion:OMP_HOST_VERSION,dockerDaemonId:input.omp.dockerDaemonId,securityReviewId:input.omp.securityReviewId,reviewedBy:input.omp.reviewedBy,reviewedAt:input.omp.reviewedAt,dockerSocket:input.omp.dockerSocket});
for(const [name,value] of [['parser-isolation-review.draft.json',parser],['omp-b-review.draft.json',omp]])await writeFile(resolve(outputDirectory,name),JSON.stringify(value,null,2)+'\n',{encoding:'utf8',mode:0o644,flag:'wx'});
process.stdout.write(JSON.stringify({status:'drafts_written',outputDirectory,parser:{imageId:parser.imageId,runnerSha256:parser.runnerSha256,parserOutputSha256},omp:{imageId:omp.imageId,runnerContractSha256:ompRunnerContractSha256Value},schemas:['ParserReviewSchema','OmpReviewSchema'],installTargets:['/etc/stadtstack/parser-isolation-review.json','/etc/stadtstack/omp-b-review.json']},null,2)+'\n');
