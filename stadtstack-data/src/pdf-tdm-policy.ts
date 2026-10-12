import {mkdir,writeFile,rename,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {withParserSandbox,readParserReview,type ParserSourceContext} from './district-parser-isolation.ts';
import {digest} from './district-adapter-contract.ts';
export const PDF_TDM_POLICY_VERSION='pdf-tdm-v2';
const MAX_INPUT=32*1024*1024,MAX_OUTPUT=8192,DEADLINE_MS=15000;
export type PdfTdmFinding={state:'checked';reservation:0|1|null;policyPresent:boolean;metadataPresent:boolean}|{state:'unavailable';reason:string};
export interface PdfTdmPolicyResult {schemaVersion:1;policyVersion:string;pdfjsVersion:string;sha256:string;checkedAt:string;finding:PdfTdmFinding;fromCache:boolean}
const versions=new Map<string,Promise<string>>();

/** Source-only metadata inspection in the reviewed credential-free job, never host PDF.js. */
export async function inspectPdfTdmPolicy(bytes:Buffer,sha256:string,cacheRoot:string,context:ParserSourceContext):Promise<PdfTdmPolicyResult>{
 if(!/^[a-f0-9]{64}$/.test(sha256)||digest(bytes)!==sha256)throw Error('Invalid PDF metadata cache digest');
 if(context.purpose!=='classification'||!context.bindings.some(binding=>'sourceSha256' in binding&&binding.sourceSha256===sha256))throw Error('PDF metadata inspection requires a source-only classification binding');
 context.signal?.throwIfAborted();
 // Host-only active permission is not part of the minimal parser-image dependency closure.
 const {assertCivicPolicyAuthority,assertHostNotOptedOut}=await import('./civic-opt-out.ts');
 await assertCivicPolicyAuthority(context);
 for(const binding of context.bindings)await assertHostNotOptedOut(binding.url,context);
 const review=await readParserReview(),key=review.imageId+':'+review.runnerSha256;
 let version=versions.get(key);
 if(!version){
  version=withParserSandbox(null,async sandbox=>{
   const result=JSON.parse((await sandbox.run('node',['--max-old-space-size=192','--experimental-strip-types','/opt/stadtstack/src/pdf-tdm-policy-worker.ts','--version'])).stdout) as {policyVersion?:unknown;pdfjsVersion?:unknown};
   if(result.policyVersion!==PDF_TDM_POLICY_VERSION||typeof result.pdfjsVersion!=='string'||!/^[A-Za-z0-9.+-]+$/.test(result.pdfjsVersion))throw Error('PDF parser version unavailable');
   return result.pdfjsVersion;
  },{...context,signal:context.signal?AbortSignal.any([context.signal,AbortSignal.timeout(DEADLINE_MS)]):AbortSignal.timeout(DEADLINE_MS)});
  versions.set(key,version);
  void version.catch(()=>{if(versions.get(key)===version)versions.delete(key);});
 }
 const pdfjsVersion=await version;
 context.signal?.throwIfAborted();
 for(const binding of context.bindings)await assertHostNotOptedOut(binding.url,context);
 // The policy version remains real v2; image/contract bind the private cache identity separately.
 const folder=join(cacheRoot,'pdf-tdm-policy'),path=join(folder,`${PDF_TDM_POLICY_VERSION}-${pdfjsVersion}-${review.imageId.slice(7)}-${review.runnerSha256}-${sha256}.json`);
 try{
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let cached:PdfTdmPolicyResult;
  try{
   const metadata=await handle.stat();
   if(!metadata.isFile()||metadata.size>MAX_OUTPUT)throw Error('PDF policy cache unavailable');
   cached=JSON.parse(await handle.readFile('utf8')) as PdfTdmPolicyResult;
  }finally{await handle.close();}
  const finding=cached.finding;
  if(cached.schemaVersion===1&&cached.policyVersion===PDF_TDM_POLICY_VERSION&&cached.pdfjsVersion===pdfjsVersion&&cached.sha256===sha256&&typeof cached.checkedAt==='string'&&Number.isFinite(Date.parse(cached.checkedAt))&&finding?.state==='checked'&&[0,1,null].includes(finding.reservation)&&typeof finding.policyPresent==='boolean'&&typeof finding.metadataPresent==='boolean'){
   for(const binding of context.bindings)await assertHostNotOptedOut(binding.url,context);
   return {...cached,fromCache:true};
  }
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
 let finding:PdfTdmFinding;
 if(bytes.length>MAX_INPUT||bytes.length===0)finding={state:'unavailable',reason:'size_limit'};
 else{
  try{
   finding=await withParserSandbox(bytes,async sandbox=>{
    const output=(await sandbox.run('node',['--max-old-space-size=192','--experimental-strip-types','/opt/stadtstack/src/pdf-tdm-policy-worker.ts','/input/document'])).stdout;
    if(Buffer.byteLength(output)>MAX_OUTPUT)return {state:'unavailable',reason:'parser_output_limit'};
    const result=JSON.parse(output) as PdfTdmFinding&{policyVersion?:unknown;pdfjsVersion?:unknown};
    if(result.policyVersion!==PDF_TDM_POLICY_VERSION||result.pdfjsVersion!==pdfjsVersion)return {state:'unavailable',reason:'parser_version_mismatch'};
    if(result.state==='checked'&&[0,1,null].includes(result.reservation)&&typeof result.policyPresent==='boolean'&&typeof result.metadataPresent==='boolean')return {state:'checked',reservation:result.reservation,policyPresent:result.policyPresent,metadataPresent:result.metadataPresent};
    if(result.state==='unavailable'&&typeof result.reason==='string'&&/^[a-z_]{1,64}$/.test(result.reason))return {state:'unavailable',reason:result.reason};
    return {state:'unavailable',reason:'parser_protocol_error'};
   },{...context,signal:context.signal?AbortSignal.any([context.signal,AbortSignal.timeout(DEADLINE_MS)]):AbortSignal.timeout(DEADLINE_MS)});
  }catch(error){
   if(context.signal?.aborted)throw error;
   if(error instanceof Error&&error.name==='TimeoutError')finding={state:'unavailable',reason:'metadata_timeout'};
   else throw error; // Missing review/isolation, objections and unsafe custody must stop acquisition.
  }
 }
 const result:PdfTdmPolicyResult={schemaVersion:1,policyVersion:PDF_TDM_POLICY_VERSION,pdfjsVersion,sha256,checkedAt:new Date().toISOString(),finding,fromCache:false};
 for(const binding of context.bindings)await assertHostNotOptedOut(binding.url,context);
 // Content-free findings only; transient parser/resource failures never become cached permission.
 if(finding.state==='checked'){
  await mkdir(folder,{recursive:true,mode:0o700});const temporary=path+'.'+randomUUID()+'.tmp';
  await writeFile(temporary,JSON.stringify(result)+'\n',{flag:'wx',mode:0o600});await rename(temporary,path);
 }
 return result;
}
