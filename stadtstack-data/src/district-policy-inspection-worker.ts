import {readFile,lstat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import {classifyDocumentOriginRules,inspectDocumentOriginPdf} from './document-origin-rules.ts';
import {DOCUMENT_ORIGIN_INPUT_TOKEN} from './document-origin-contract.ts';
import type {DocumentOriginInput,DocumentOriginCommand} from './document-origin-contract.ts';
import {inspectResourcePolicy} from './source-policy.ts';
import {PARSER_INPUT_MAX_BYTES} from './district-adapter-contract.ts';
import {ParserIsolationError} from './district-parser-isolation.ts';

const execute=promisify(execFile);
const metadataSchema=z.object({url:z.url(),mimeType:z.string(),title:z.string().optional(),linkText:z.string().optional(),municipalityName:z.string().optional(),administrativeOriginEvidence:z.union([z.string(),z.array(z.string())]).optional(),oparlContext:z.object({bodyId:z.string(),bodyName:z.string(),apiUrl:z.string()}).strict().optional()}).strict();
const resourceSchema=z.object({url:z.url(),mimeType:z.string(),headers:z.object({'tdm-reservation':z.string().optional(),'tdm-policy':z.string().optional(),'x-robots-tag':z.string().optional()}).strict()}).strict();
const env={PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC',HOME:'/scratch/home',TMPDIR:'/scratch/tmp',TESSDATA_PREFIX:'/usr/share/tesseract-ocr/5/tessdata',OMP_THREAD_LIMIT:'1'};
// Native tools here are already inside the reviewed, nonnetworked namespace; never a host fallback.
const command:DocumentOriginCommand=async(tool,args)=>{
 const bound=args.map(arg=>arg===DOCUMENT_ORIGIN_INPUT_TOKEN?'/input/document':arg);
 if(!['pdfinfo','pdftotext'].includes(tool)||bound.some(arg=>arg.startsWith('/')&&arg!=='/input/document'))throw Error('Origin inspection tool request rejected');
 const result=await execute('/usr/bin/'+tool,bound,{env,timeout:120000,maxBuffer:tool==='pdfinfo'?65536:32768,encoding:'utf8',windowsHide:true});
 return result.stdout;
};
async function main(){
 const [operation,encoded,...extra]=process.argv.slice(2);
 if(!encoded||Buffer.byteLength(encoded)>65536||extra.length)throw Error('Policy inspection request rejected');
 const metadata=await lstat('/input/document');
 if(!metadata.isFile()||metadata.size>PARSER_INPUT_MAX_BYTES)throw Error('Policy inspection input limit');
 const bytes=await readFile('/input/document');
 if(bytes.length!==metadata.size)throw Error('Policy inspection input changed');
 const parsed:unknown=JSON.parse(encoded);
 if(operation==='origin'){
  const input:DocumentOriginInput={...metadataSchema.parse(parsed),bytes};
  process.stdout.write(JSON.stringify(await classifyDocumentOriginRules(input,()=>inspectDocumentOriginPdf(command)))+'\n');
 }else if(operation==='resource'){
  const input=resourceSchema.parse(parsed);
  process.stdout.write(JSON.stringify(inspectResourcePolicy(input.url,input.headers,bytes,input.mimeType))+'\n');
 }else throw Error('Policy inspection operation rejected');
}
await main().catch(error=>{
 // No exception text or source bytes cross the worker protocol.
 process.exitCode=error instanceof ParserIsolationError&&error.reason==='request_rejected'?64:1;
});
