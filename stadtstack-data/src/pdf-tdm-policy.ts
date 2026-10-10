import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

export const PDF_TDM_POLICY_VERSION='pdf-tdm-v2';
const MAX_INPUT=32*1024*1024,MAX_OUTPUT=8192,DEADLINE_MS=15000;
export type PdfTdmFinding={state:'checked';reservation:0|1|null;policyPresent:boolean;metadataPresent:boolean}|{state:'unavailable';reason:string};
export interface PdfTdmPolicyResult {schemaVersion:1;policyVersion:string;pdfjsVersion:string;sha256:string;checkedAt:string;finding:PdfTdmFinding;fromCache:boolean}
const require=createRequire(import.meta.url);
let versionPromise:Promise<string>|undefined;

/** Isolated, non-rendering PDF.js metadata parse. The caller's digest must describe the supplied bytes. */
export async function inspectPdfTdmPolicy(bytes:Buffer,sha256:string,cacheRoot:string):Promise<PdfTdmPolicyResult>{
 if(!/^[a-f0-9]{64}$/.test(sha256))throw Error('Invalid PDF metadata cache digest');
 let pdfjsVersion:string;
 try{
  versionPromise??=readFile(require.resolve('pdfjs-dist/package.json'),'utf8').then(text=>{
   const version:unknown=JSON.parse(text).version;if(typeof version!=='string'||!/^[a-zA-Z0-9.+-]+$/.test(version))throw Error('Invalid PDF parser version');return version;
  });
  pdfjsVersion=await versionPromise;
 }catch{return {schemaVersion:1,policyVersion:PDF_TDM_POLICY_VERSION,pdfjsVersion:'unavailable',sha256,checkedAt:new Date().toISOString(),finding:{state:'unavailable',reason:'parser_unavailable'},fromCache:false};}
 const folder=join(cacheRoot,'pdf-tdm-policy'),path=join(folder,`${PDF_TDM_POLICY_VERSION}-${pdfjsVersion}-${sha256}.json`);
 try{
  const cached=JSON.parse(await readFile(path,'utf8')) as PdfTdmPolicyResult;
  const finding=cached.finding;
  if(cached.schemaVersion===1&&cached.policyVersion===PDF_TDM_POLICY_VERSION&&cached.pdfjsVersion===pdfjsVersion&&cached.sha256===sha256&&typeof cached.checkedAt==='string'&&finding?.state==='checked'&&[0,1,null].includes(finding.reservation)&&typeof finding.policyPresent==='boolean'&&typeof finding.metadataPresent==='boolean')return {...cached,fromCache:true};
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof SyntaxError))throw Error('PDF policy cache unavailable');}
 let finding:PdfTdmFinding;
 if(bytes.length>MAX_INPUT||bytes.length===0)finding={state:'unavailable',reason:'size_limit'};
 else{
  const {promise,resolve:complete}=Promise.withResolvers<PdfTdmFinding>();let settled=false,total=0;const output:Buffer[]=[];
  const child=spawn(process.execPath,['--max-old-space-size=192','--experimental-strip-types',fileURLToPath(new URL('./pdf-tdm-policy-worker.ts',import.meta.url))],{stdio:['pipe','pipe','ignore'],env:{NODE_NO_WARNINGS:'1'}});
  const finish=(result:PdfTdmFinding)=>{if(settled)return;settled=true;clearTimeout(timer);complete(result);};
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish({state:'unavailable',reason:'metadata_timeout'});},DEADLINE_MS);
  child.on('error',()=>finish({state:'unavailable',reason:'parser_process_failed'}));
  child.stdin.on('error',()=>{child.kill('SIGKILL');finish({state:'unavailable',reason:'parser_input_failed'});});
  child.stdout.on('data',(chunk:Buffer)=>{total+=chunk.length;if(total>MAX_OUTPUT){child.kill('SIGKILL');finish({state:'unavailable',reason:'parser_output_limit'});}else output.push(chunk);});
  child.on('close',code=>{
   if(settled)return;
   if(code!==0){finish({state:'unavailable',reason:'parser_process_failed'});return;}
   try{
    const result=JSON.parse(Buffer.concat(output,total).toString('utf8')) as PdfTdmFinding&{policyVersion?:string};
    if(result.policyVersion!==PDF_TDM_POLICY_VERSION){finish({state:'unavailable',reason:'parser_version_mismatch'});return;}
    if(result.state==='checked'&&[0,1,null].includes(result.reservation)&&typeof result.policyPresent==='boolean'&&typeof result.metadataPresent==='boolean')finish({state:'checked',reservation:result.reservation,policyPresent:result.policyPresent,metadataPresent:result.metadataPresent});
    else if(result.state==='unavailable'&&typeof result.reason==='string'&&/^[a-z_]{1,64}$/.test(result.reason))finish({state:'unavailable',reason:result.reason});
    else finish({state:'unavailable',reason:'parser_protocol_error'});
   }catch{finish({state:'unavailable',reason:'parser_protocol_error'});}
  });
  child.stdin.end(bytes);finding=await promise;
 }
 const result:PdfTdmPolicyResult={schemaVersion:1,policyVersion:PDF_TDM_POLICY_VERSION,pdfjsVersion,sha256,checkedAt:new Date().toISOString(),finding,fromCache:false};
 // Transient parser/resource failures are deliberately not cached as an absence of reservation.
 if(finding.state==='checked'){
  await mkdir(folder,{recursive:true});const temporary=path+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(result)+'\n');await rename(temporary,path);
 }
 return result;
}
