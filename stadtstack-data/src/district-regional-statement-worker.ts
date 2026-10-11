import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {PARSER_INPUT_MAX_BYTES} from './district-adapter-contract.ts';
import {extractRegionalStatement,REGIONAL_EXCERPT_LIMITS} from '../regional/statements.mjs';

export const REGIONAL_STATEMENT_WORKER_VERSION='district-regional-statement-worker-v1';
const requestSchema=z.object({version:z.literal(REGIONAL_STATEMENT_WORKER_VERSION),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),sourceBase64:z.string().min(1).max(PARSER_INPUT_MAX_BYTES),anchors:z.array(z.string().trim().min(1).max(REGIONAL_EXCERPT_LIMITS.quoteCharacters)).min(1).max(REGIONAL_EXCERPT_LIMITS.quotes)}).strict();
/** Pure fixture seam; production invokes this only in the selected-input sandbox. */
export function inspectRegionalStatementBundle(input:unknown){
 const request=requestSchema.parse(input),bytes=Buffer.from(request.sourceBase64,'base64');
 if(bytes.length===0||bytes.length>PARSER_INPUT_MAX_BYTES||bytes.toString('base64')!==request.sourceBase64||createHash('sha256').update(bytes).digest('hex')!==request.sourceSha256)throw Error('Regional statement source encoding or digest mismatch');
 const html=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
 return {version:REGIONAL_STATEMENT_WORKER_VERSION,sourceSha256:request.sourceSha256,...extractRegionalStatement(html,request.anchors)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  if(process.argv.length!==3||process.argv[2]!=='/input/document')throw Error('Selected input required');
  const file=await open(process.argv[2],constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const metadata=await file.stat();if(!metadata.isFile()||metadata.size<=0||metadata.size>PARSER_INPUT_MAX_BYTES)throw Error('Regional statement input limit');
   const bytes=await file.readFile();if(bytes.length!==metadata.size||bytes.length>PARSER_INPUT_MAX_BYTES)throw Error('Regional statement input changed');
   const result=inspectRegionalStatementBundle(JSON.parse(bytes.toString('utf8'))),output=JSON.stringify(result)+'\n';
   if(Buffer.byteLength(output)>16*1024)throw Error('Regional statement output limit');
   process.stdout.write(output);
  }finally{await file.close();}
 }catch{process.stderr.write('Regional statement parsing rejected\n');process.exitCode=1;}
}
