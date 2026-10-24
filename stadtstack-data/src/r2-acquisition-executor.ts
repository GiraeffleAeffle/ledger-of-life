import {spawn} from 'node:child_process';
import {constants as fsConstants} from 'node:fs';
import {createHash} from 'node:crypto';
import {chmod,copyFile,lstat,mkdir,open,readFile,realpath,rename,stat,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {PoliteFetcher,publicUrl,type PoliteFetcherOptions} from './polite-fetch.ts';
import {z} from 'zod';

const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const canonical=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`:JSON.stringify(value);
function responseMime(body:Buffer,contentType:string):string{if(body.subarray(0,5).toString('ascii')==='%PDF-')return 'application/pdf';if(body.length>=4&&body[0]===0x50&&body[1]===0x4b&&[3,5,7].includes(body[2]!))return 'application/zip';return contentType.split(';')[0]!.trim().toLowerCase()||'application/octet-stream';}
const bounds={documents:140,reviewBatch:10,requests:600,policyRequests:22,body:25_165_824,html:2_097_152,policyBody:1_048_576,totalWire:1_073_741_824,retained:1_073_741_824,elapsed:28_800_000,spacing:5000,redirects:5} as const;
export type R2ManifestItem={url:string;sourceId:string;scope:{municipalityId:string;sourceId:string;ags:string}};
export type R2IssuedRecord=Record<string,unknown>;
type Attempt={url:string;startedAt:string;bytes:number;status:number|null;failure:string|null;state:'started'|'succeeded'|'failed'};
export interface R2ExecutorOptions{recordPath:string;recordSha256:string;manifestPath:string;manifest:readonly R2ManifestItem[];manifestSha256:string;r1DigestInventoryPath:string;r1DigestInventorySha256:string;fetcherOptions:Omit<PoliteFetcherOptions,'beforeRequest'|'onResponseChunk'|'onWireAttemptResult'|'onWireResponse'>;journalPath:string;stopFile:string;reviewPath?:string;reviewSha256?:string;changedReleasePath?:string;changedReleaseSha256?:string}
interface ReviewCheckpoint{sequence:number;recordHash:string|null;createdAt:string;digestSet:Record<string,string>}
interface Journal{schemaVersion:'r2-acquisition-progress-v3';sequence:number;previousRecordHash:string|null;recordHash:string;recordSha256:string;manifestSha256:string;startedAt:string;attempts:Attempt[];completed:Record<string,{sha256:string;bytes:number;localPath:string;sourceId:string}>;quarantined:Record<string,{sha256:string;r1Sha256:string;bytes:number;localPath:string;sourceId:string;mimeType:string;reviewed:boolean}>;retainedBytes:number;wireBytes:number;documentsSinceReview:number;paused:boolean;stopped:boolean;checkpoint:ReviewCheckpoint|null;consumedReviews:string[]}
function exactList(record:R2IssuedRecord,name:'exactDocumentRequestAllowlist'|'exactPolicyRequestAllowlist'):{url:string;method:string}[]{const value=record[name];if(!Array.isArray(value))throw Error('Issued release allowlist missing');return value.map(row=>{if(!row||typeof row!=='object'||!('url'in row)||typeof row.url!=='string'||!('method'in row)||row.method!=='GET')throw Error('Invalid issued allowlist entry');return {url:publicUrl(row.url).href,method:row.method};});}
function boundsMatch(record:R2IssuedRecord){const got=record.proposedBounds as Record<string,unknown>|undefined;const expected={maxDocuments:bounds.documents,initialReviewBatchDocuments:bounds.reviewBatch,maxNetworkRequestsIncludingPoliciesRedirectsAndFailures:bounds.requests,maxPolicyBootstrapRequests:bounds.policyRequests,maxWireBytesPerResponse:bounds.body,maxHtmlBytesBeforeHostDiscovery:bounds.html,maxPolicyBodyBytes:bounds.policyBody,maxTotalWireBytes:bounds.totalWire,maxRetainedSourceBytes:bounds.retained,maxElapsedMs:bounds.elapsed,minGlobalStartIntervalMs:bounds.spacing,globalMaxInFlight:1,maxRedirects:bounds.redirects,maxAutomaticRetries:0,maxModelCalls:0,paidMicroUsd:0};return !!got&&Object.entries(expected).every(([key,value])=>got[key]===value);}
function candidateAllows(record:R2IssuedRecord,url:string,item:R2ManifestItem):boolean{const rows=record.exactDocumentRequestAllowlist;if(!Array.isArray(rows))return false;return rows.some((raw:unknown)=>{if(!raw||typeof raw!=='object'||!('url'in raw)||typeof raw.url!=='string'||publicUrl(raw.url).href!==url||!('candidateBindings'in raw)||!Array.isArray(raw.candidateBindings))return false;return raw.candidateBindings.some((binding:unknown)=>!!binding&&typeof binding==='object'&&'municipalityId'in binding&&binding.municipalityId===item.scope.municipalityId&&'sourceId'in binding&&binding.sourceId===item.sourceId);});}
const IssuedMetadataSchema=z.object({status:z.literal('ISSUED'),issuedAt:z.iso.datetime(),approver:z.string().min(1),sourceFetchStopLifted:z.literal(true),validFrom:z.iso.datetime(),expiresAt:z.iso.datetime(),ownerApprovalReference:z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/),approvalRecordPath:z.string().min(1),approvalRecordSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),r1DigestInventoryReference:z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()}).strict();
const ChangedSourceReleaseSchema=z.object({schemaVersion:z.literal('r2-changed-source-release-v1'),id:z.literal('r2-changed-source-release'),reviewedBy:z.string().min(1),reviewedAt:z.iso.datetime(),reason:z.string().min(1),representations:z.array(z.object({url:z.url(),sourceId:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/),r1Sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1)}).strict();
const R1DigestInventorySchema=z.object({schemaVersion:z.literal('r2-r1-digest-inventory-v1'),entries:z.array(z.object({url:z.url(),sourceIds:z.array(z.string().min(1)).min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/).nullable()}).strict()).min(1)}).strict();
function recordWindowValid(record:R2IssuedRecord,now=Date.now()):boolean{const parsed=IssuedMetadataSchema.safeParse(Object.fromEntries(Object.entries(record).filter(([key])=>['status','issuedAt','approver','sourceFetchStopLifted','validFrom','expiresAt','ownerApprovalReference','r1DigestInventoryReference'].includes(key))));if(!parsed.success)return false;const issued=Date.parse(parsed.data.issuedAt),from=Date.parse(parsed.data.validFrom),expires=Date.parse(parsed.data.expiresAt);return issued<=now&&from<=issued&&issued<=expires&&now<expires;}
const ReviewSchema=z.object({schemaVersion:z.literal('r2-acquisition-review-v1'),releaseSha256:z.string().regex(/^[a-f0-9]{64}$/),manifestSha256:z.string().regex(/^[a-f0-9]{64}$/),action:z.literal('resume'),reviewedBy:z.string().min(1),issuedAt:z.iso.datetime(),checkpointSequence:z.number().int().positive(),checkpointRecordHash:z.string().regex(/^[a-f0-9]{64}$/),digestSetSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
async function readIssuedRecord(path:string,expectedSha256:string,manifestSha256:string,r1InventorySha256:string):Promise<R2IssuedRecord>{
 const bytes=await readFile(path);if(hash(bytes)!==expectedSha256)throw new R2ExecutorError('RELEASE_HASH_MISMATCH','Issued release file digest mismatch');
 let parsed:unknown;try{parsed=JSON.parse(bytes.toString('utf8'));}catch{throw new R2ExecutorError('RELEASE_INVALID','Issued release JSON is invalid');}
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new R2ExecutorError('RELEASE_INVALID','Issued release must be an object');
 const value=parsed as R2IssuedRecord,issuance=IssuedMetadataSchema.safeParse(Object.fromEntries(Object.entries(value).filter(([key])=>['status','issuedAt','approver','sourceFetchStopLifted','validFrom','expiresAt','ownerApprovalReference','r1DigestInventoryReference'].includes(key))));
 if(!issuance.success||issuance.data.ownerApprovalReference.sha256!==manifestSha256||issuance.data.r1DigestInventoryReference.sha256!==r1InventorySha256)throw new R2ExecutorError('RELEASE_INVALID','Issued v3 approval, validity, manifest, or R1 inventory binding is invalid');
 const approvalPath=resolve(issuance.data.ownerApprovalReference.approvalRecordPath),approvalMetadata=await lstat(approvalPath);if(!approvalMetadata.isFile()||approvalMetadata.isSymbolicLink()||await realpath(approvalPath)!==approvalPath)throw new R2ExecutorError('OWNER_APPROVAL_PATH_UNSAFE','Owner approval record must be a regular non-symlink file');const approvalBytes=await readFile(approvalPath);if(hash(approvalBytes)!==issuance.data.ownerApprovalReference.approvalRecordSha256)throw new R2ExecutorError('OWNER_APPROVAL_HASH_MISMATCH','Owner approval record hash mismatch');const approval=JSON.parse(approvalBytes.toString('utf8')) as {approved?:{acquisition?:{manifest?:{sha256?:string}}}};if(approval.approved?.acquisition?.manifest?.sha256!==manifestSha256)throw new R2ExecutorError('OWNER_APPROVAL_MANIFEST_MISMATCH','Owner approval does not approve the exact acquisition manifest');
 const now=Date.now();if(!recordWindowValid(value,now))throw new R2ExecutorError('RELEASE_OUTSIDE_VALIDITY','Issued v3 record issuance and validity window is not currently valid');
 const draft=JSON.parse(await readFile(new URL('../reports/r2-district-source-fetch-security-release-v3.draft.json',import.meta.url),'utf8')) as R2IssuedRecord,normalized={...value};
 normalized.status=draft.status;normalized.issuedAt=draft.issuedAt;normalized.approvedBy=draft.approvedBy;normalized.sourceFetchStopLifted=draft.sourceFetchStopLifted;
 delete normalized.approver;delete normalized.validFrom;delete normalized.expiresAt;delete normalized.ownerApprovalReference;delete normalized.r1DigestInventoryReference;
 if(canonical(normalized)!==canonical(draft))throw new R2ExecutorError('RELEASE_SCHEMA_MISMATCH','Issued release differs from the exact v3 draft schema or values');
 return value;
}
async function loadJournal(path:string,recordSha256:string,manifestSha256:string):Promise<Journal>{
 let handle;try{handle=await open(path,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const journal:Journal={schemaVersion:'r2-acquisition-progress-v3',sequence:0,previousRecordHash:null,recordHash:'',recordSha256,manifestSha256,startedAt:new Date().toISOString(),attempts:[],completed:{},quarantined:{},retainedBytes:0,wireBytes:0,documentsSinceReview:0,paused:false,stopped:false,checkpoint:null,consumedReviews:[]};await persistJournal(path,journal);return journal;}
 try{
  if(!(await handle.stat()).isFile())throw Error('Progress journal is not a regular file');
  const text=(await handle.readFile()).toString('utf8');if(!text.endsWith('\n'))throw Error('Progress journal has an incomplete final record');
  const rows=text.trimEnd().split('\n');if(!rows.length||!rows[0])throw Error('Empty progress journal');
  let previous:Journal|undefined;
  for(const line of rows){
   const current=JSON.parse(line) as Journal,{recordHash,...payload}=current;
   if(current.schemaVersion!=='r2-acquisition-progress-v3'||current.sequence!==((previous?.sequence??0)+1)||current.previousRecordHash!==(previous?.recordHash??null)||recordHash!==hash(canonical(payload))||current.recordSha256!==recordSha256||current.manifestSha256!==manifestSha256||!Array.isArray(current.attempts)||!current.completed||!current.quarantined||!Number.isSafeInteger(current.wireBytes)||!Number.isSafeInteger(current.retainedBytes)||!Number.isSafeInteger(current.documentsSinceReview)||current.documentsSinceReview<0||current.documentsSinceReview>bounds.reviewBatch||current.wireBytes!==current.attempts.reduce((sum,row)=>sum+row.bytes,0)||current.retainedBytes!==Object.values(current.completed).reduce((sum,row)=>sum+row.bytes,0)||!Array.isArray(current.consumedReviews)||current.attempts.some(row=>!['started','succeeded','failed'].includes(row.state)||row.state==='started'&&row.status!==null||row.state==='succeeded'&&row.status===null||row.state==='failed'&&!row.failure))throw Error('Progress journal identity, chain, accounting, or shape mismatch');
   if(previous&&(current.attempts.length<previous.attempts.length||current.wireBytes<previous.wireBytes||current.retainedBytes<previous.retainedBytes||Object.keys(previous.completed).some(key=>!current.completed[key])||Object.keys(previous.quarantined).some(key=>!current.quarantined[key])||previous.consumedReviews.some(id=>!current.consumedReviews.includes(id))))throw Error('Progress journal counters regressed');
   previous=current;
  }
  return previous!;
 }finally{await handle.close();}
}
async function persistJournal(path:string,journal:Journal){
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 let exists=true;try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw Error('Progress journal path is unsafe');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;exists=false;}
 const flags=fsConstants.O_WRONLY|fsConstants.O_APPEND|fsConstants.O_NOFOLLOW|(exists?0:fsConstants.O_CREAT|fsConstants.O_EXCL),handle=await open(path,flags,0o600);
 try{
  const payload={...journal,sequence:journal.sequence+1,previousRecordHash:journal.recordHash||null,recordHash:''};const {recordHash:_ignored,...hashInput}=payload;const row={...payload,recordHash:hash(canonical(hashInput))};await handle.writeFile(JSON.stringify(row)+'\n');await handle.sync();Object.assign(journal,row);
 }finally{await handle.close();}
 if(!exists){const directory=await open(dirname(path),fsConstants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}}
}
async function acquireRunLock(path:string,recordSha256:string,manifestSha256:string):Promise<()=>Promise<void>>{
 const lockPath=path+'.run.lock',identityPath=lockPath+'.identity';await mkdir(dirname(lockPath),{recursive:true,mode:0o700});
 try{const metadata=await lstat(lockPath);if(!metadata.isFile()||metadata.isSymbolicLink())throw new R2ExecutorError('RUN_LOCK_UNSAFE','Executor run lock must be a regular file');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const lockFile=await open(lockPath,'a',0o600);await lockFile.close();await chmod(lockPath,0o600);
 const child=spawn('flock',['-n',lockPath,'sh','-c','printf "LOCKED\\n"; cat >/dev/null'],{stdio:['pipe','pipe','pipe']});
 let stdout='';const ready=new Promise<void>((resolveReady,rejectReady)=>{
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('LOCKED\n'))resolveReady();});
  child.once('error',rejectReady);child.once('exit',code=>rejectReady(new R2ExecutorError('RUN_LOCKED',`Could not acquire exclusive executor lock (${code??'signal'})`)));
 });
 try{await ready;}catch{child.stdin.end();throw new R2ExecutorError('RUN_LOCKED','Another executor holds the journal run lock');}
 const identity={schemaVersion:'r2-acquisition-run-lock-v1',recordSha256,manifestSha256};
 try{
  try{const previous=JSON.parse(await readFile(identityPath,'utf8'));if(previous.schemaVersion!==identity.schemaVersion||previous.recordSha256!==recordSha256||previous.manifestSha256!==manifestSha256)throw new R2ExecutorError('RUN_LOCK_IDENTITY_MISMATCH','Existing run lock is bound to a different record or manifest');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const temporary=`${identityPath}.${process.pid}.${Date.now()}.tmp`,handle=await open(temporary,'wx',0o600);
  try{await handle.writeFile(JSON.stringify(identity)+'\n');await handle.sync();}finally{await handle.close();}
  await rename(temporary,identityPath);const directory=await open(dirname(identityPath),'r');try{await directory.sync();}finally{await directory.close();}
  if(child.exitCode!==null||child.signalCode!==null)throw new R2ExecutorError('RUN_LOCKED','Exclusive executor lock ended before identity commit');
 }catch(error){child.stdin.end();throw error;}
 return async()=>{if(child.exitCode!==null||child.signalCode!==null)return;child.stdin.end();await new Promise<void>(resolveExit=>child.once('exit',()=>resolveExit()));};
}
export class R2ExecutorError extends Error{readonly code:string;constructor(code:string,message:string){super(message);this.name='R2ExecutorError';this.code=code;}}
export class R2AcquisitionExecutor{
 private readonly documents:Map<string,R2ManifestItem>;private readonly policies:Set<string>;private readonly record:R2IssuedRecord;private readonly priorR1:Readonly<Record<string,string>>;private readonly fetcher:PoliteFetcher;private readonly options:R2ExecutorOptions;private current?:Journal;private nextStart=0;private running=false;private startedProcess=false;
 static async open(options:R2ExecutorOptions):Promise<R2AcquisitionExecutor>{
  if(!/^[a-f0-9]{64}$/.test(options.recordSha256)||!/^[a-f0-9]{64}$/.test(options.manifestSha256)||!/^[a-f0-9]{64}$/.test(options.r1DigestInventorySha256))throw new R2ExecutorError('RELEASE_HASH_MISMATCH','Expected SHA-256 values are malformed');
  if(!!options.reviewPath!==!!options.reviewSha256||!!options.changedReleasePath!==!!options.changedReleaseSha256)throw new R2ExecutorError('REVIEW_BINDING_INCOMPLETE','Review and changed-source release paths require their exact expected file hashes');
  const manifestPath=resolve(options.manifestPath),manifestMetadata=await lstat(manifestPath);
  if(!manifestMetadata.isFile()||manifestMetadata.isSymbolicLink()||await realpath(manifestPath)!==manifestPath)throw new R2ExecutorError('MANIFEST_PATH_UNSAFE','Manifest path is not a regular non-symlink file');
  const manifestBytes=await readFile(manifestPath);if(hash(manifestBytes)!==options.manifestSha256)throw new R2ExecutorError('MANIFEST_HASH_MISMATCH','Acquisition manifest file digest mismatch');
  const manifestSchema=z.array(z.object({url:z.url(),sourceId:z.string().min(1),scope:z.object({municipalityId:z.string().min(1),sourceId:z.string().min(1),ags:z.string().min(1)}).strict()}).strict());
  const parsedManifest=manifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  if(canonical(parsedManifest)!==canonical(options.manifest))throw new R2ExecutorError('MANIFEST_BINDING_MISMATCH','Parsed manifest does not match its exact file bytes');
  const inventoryPath=resolve(options.r1DigestInventoryPath),inventoryMetadata=await lstat(inventoryPath);
  if(!inventoryMetadata.isFile()||inventoryMetadata.isSymbolicLink()||await realpath(inventoryPath)!==inventoryPath)throw new R2ExecutorError('R1_INVENTORY_PATH_UNSAFE','R1 digest inventory must be a regular non-symlink file');
  const inventoryBytes=await readFile(inventoryPath);if(hash(inventoryBytes)!==options.r1DigestInventorySha256)throw new R2ExecutorError('R1_INVENTORY_HASH_MISMATCH','Final R1 digest inventory hash mismatch');
  const inventory=R1DigestInventorySchema.parse(JSON.parse(inventoryBytes.toString('utf8'))),entries=new Map<string,typeof inventory.entries[number]>();
  for(const row of inventory.entries){if(new URL(row.url).href!==row.url||entries.has(row.url)||new Set(row.sourceIds).size!==row.sourceIds.length)throw new R2ExecutorError('R1_INVENTORY_INVALID','R1 digest inventory URLs and source bindings must be canonical and unique');entries.set(row.url,row);}
  const priorR1:Record<string,string>={};
  for(const item of parsedManifest){const url=publicUrl(item.url).href,row=entries.get(url);if(url!==item.url||!row)throw new R2ExecutorError('R1_INVENTORY_COVERAGE','R1 digest inventory does not cover every exact manifest URL');if(!row.sourceIds.includes(item.sourceId))throw new R2ExecutorError('R1_INVENTORY_SCOPE','R1 digest inventory source binding differs from the acquisition manifest');if(row.sha256)priorR1[url]=row.sha256;}
  const path=resolve(options.recordPath),metadata=await lstat(path);if(!metadata.isFile()||metadata.isSymbolicLink()||await realpath(path)!==path)throw new R2ExecutorError('RELEASE_PATH_UNSAFE','Release record path is not a regular non-symlink file');
  const record=await readIssuedRecord(path,options.recordSha256,options.manifestSha256,options.r1DigestInventorySha256);
  return new R2AcquisitionExecutor(options,record,priorR1);
 }
 private constructor(options:R2ExecutorOptions,record:R2IssuedRecord,priorR1:Readonly<Record<string,string>>){
  this.record=record;
  this.priorR1=priorR1;
  this.options=options;if(!boundsMatch(record))throw new R2ExecutorError('RELEASE_BOUNDS_MISMATCH','Issued v3 record does not contain exact draft budgets');
  const documentRows=exactList(record,'exactDocumentRequestAllowlist'),policyRows=exactList(record,'exactPolicyRequestAllowlist');
  this.documents=new Map(documentRows.map(row=>[row.url,options.manifest.find(item=>publicUrl(item.url).href===row.url)!]).filter((row):row is [string,R2ManifestItem]=>!!row[1]));
  if(this.documents.size!==documentRows.length||options.manifest.some(item=>!this.documents.has(publicUrl(item.url).href)||item.sourceId!==item.scope.sourceId||!candidateAllows(record,publicUrl(item.url).href,item)))throw new R2ExecutorError('MANIFEST_SCOPE_MISMATCH','Manifest URL/source/scope is not an exact released candidate binding');
  this.policies=new Set(policyRows.map(row=>row.url));
  this.fetcher=new PoliteFetcher({...options.fetcherOptions,minDelayMs:Math.max(5000,options.fetcherOptions.minDelayMs??0),timeoutMs:25000,maxBytes:bounds.body,maxRedirects:bounds.redirects,beforeRequest:url=>this.beforeRequest(url),onResponseChunk:(url,bytes)=>this.onChunk(url,bytes),onWireAttemptResult:(url,status,failure)=>this.onWireAttemptResult(url,status,failure),onWireResponse:(url,status,body,contentType)=>this.onWireResponse(url,status,body,contentType)});
 }
 async run():Promise<{completed:number;paused:boolean;stopped:boolean}>{
  if(this.running)throw new R2ExecutorError('GLOBAL_CONCURRENCY','Executor already has an active campaign');this.current=undefined;this.running=true;let releaseRunLock:(()=>Promise<void>)|undefined;
  try{
  releaseRunLock=await acquireRunLock(resolve(this.options.journalPath),this.options.recordSha256,this.options.manifestSha256);
  const journal=await loadJournal(resolve(this.options.journalPath),this.options.recordSha256,this.options.manifestSha256);this.current=journal;if(journal.stopped)throw new R2ExecutorError('JOURNAL_STOPPED','Journal records a terminal stop');if(!recordWindowValid(this.record))return this.stop('RELEASE_EXPIRED');if(!this.startedProcess&&journal.attempts.length>0&&!journal.paused)await this.pauseWithCheckpoint(journal);if(!this.startedProcess&&journal.attempts.length)this.nextStart=Date.parse(journal.attempts.at(-1)!.startedAt)+bounds.spacing;this.startedProcess=true;
  if(Date.now()-Date.parse(journal.startedAt)>=bounds.elapsed)return this.stop('TIME_BUDGET');
  if(await this.stopRequested())return this.stop('STOP_FILE');
  await this.releaseQuarantined(journal);
  if(journal.documentsSinceReview>=bounds.reviewBatch&&!journal.checkpoint)await this.pauseWithCheckpoint(journal);
  if(Object.values(journal.quarantined).some(row=>!row.reviewed))return {completed:Object.keys(journal.completed).length,paused:true,stopped:false};
  if(journal.paused){const reviewHash=await this.validReview(journal);if(!reviewHash)return {completed:Object.keys(journal.completed).length,paused:true,stopped:false};journal.consumedReviews.push(reviewHash);journal.paused=false;journal.checkpoint=null;if(journal.documentsSinceReview>=bounds.reviewBatch)journal.documentsSinceReview=0;await this.save();}
  for(const [url,item] of this.documents){
   if(journal.completed[url])continue;
   if(Object.keys(journal.completed).length>=bounds.documents)return this.stop('DOCUMENT_BUDGET');
   if(await this.stopRequested())return this.stop('STOP_FILE');
   try{
    const document=await this.fetcher.fetch(url,{registeredSourceUrl:url,registeredMunicipalityId:item.scope.municipalityId,registeredSourceId:item.sourceId});
    if(document.url!==url)throw new R2ExecutorError('URL_MISMATCH','Fetcher returned a non-allowlisted final URL');
    if(journal.quarantined[url])throw new R2ExecutorError('CHANGED_SINCE_R1','Changed R1 representation is quarantined for explicit independent review');
    if(!['text/html','application/xhtml+xml','application/pdf'].includes(document.mimeType))throw new R2ExecutorError('UNSUPPORTED_MIME','R2 permits only HTML, XHTML, and PDF');
    const bytes=await readFile(document.localPath);if(bytes.length>bounds.body)throw new R2ExecutorError('BODY_BUDGET','Per-document body cap reached');
    const prior=this.priorR1[url];if(prior&&prior!==document.sha256){const quarantinePath=join(dirname(this.options.journalPath),'quarantine',document.sha256);await mkdir(dirname(quarantinePath),{recursive:true,mode:0o700});await copyFile(document.localPath,quarantinePath);journal.quarantined[url]={sha256:document.sha256,r1Sha256:prior,bytes:bytes.length,localPath:quarantinePath,sourceId:item.sourceId,mimeType:document.mimeType,reviewed:false};journal.paused=true;await this.save();throw new R2ExecutorError('CHANGED_SINCE_R1','Changed R1 representation is quarantined for explicit independent review');}
    if(document.mimeType.startsWith('text/html')&&bytes.length>bounds.html)throw new R2ExecutorError('HTML_BUDGET','HTML discovery cap reached');
    if(journal.retainedBytes+bytes.length>bounds.retained)return this.stop('RETAINED_BYTE_BUDGET');
    journal.completed[url]={sha256:document.sha256,bytes:bytes.length,localPath:document.localPath,sourceId:item.sourceId};journal.retainedBytes+=bytes.length;journal.documentsSinceReview++;await this.save();
    if(journal.documentsSinceReview>=bounds.reviewBatch){await this.pauseWithCheckpoint(journal);return {completed:Object.keys(journal.completed).length,paused:true,stopped:false};}
   }catch(error){if(!(error instanceof R2ExecutorError&&error.code==='CHANGED_SINCE_R1'))journal.stopped=true;await this.save();throw error;}
  }
  return {completed:Object.keys(journal.completed).length,paused:false,stopped:false};
  }finally{this.running=false;await releaseRunLock?.();}
 }
 async beforeRequest(url:string){const journal=this.current!,canonicalUrl=publicUrl(url).href;if(!recordWindowValid(this.record))await this.stop('RELEASE_EXPIRED');if(!this.documents.has(canonicalUrl)&&!this.policies.has(canonicalUrl))throw new R2ExecutorError('URL_NOT_ALLOWLISTED','Wire request is outside exact release allowlist');if(journal.attempts.length>=bounds.requests)await this.stop('REQUEST_BUDGET');const policy=this.policies.has(canonicalUrl);if(policy&&journal.attempts.filter(row=>this.policies.has(row.url)).length>=bounds.policyRequests)await this.stop('POLICY_REQUEST_BUDGET');if(await this.stopRequested())await this.stop('STOP_FILE');if(Date.now()-Date.parse(journal.startedAt)>=bounds.elapsed)await this.stop('TIME_BUDGET');const delay=Math.max(0,this.nextStart-Date.now());if(delay)await new Promise(resolve=>setTimeout(resolve,delay));if(!recordWindowValid(this.record))await this.stop('RELEASE_EXPIRED');if(await this.stopRequested())await this.stop('STOP_FILE');if(Date.now()-Date.parse(journal.startedAt)>=bounds.elapsed)await this.stop('TIME_BUDGET');this.nextStart=Date.now()+bounds.spacing;journal.attempts.push({url:canonicalUrl,startedAt:new Date().toISOString(),bytes:0,status:null,failure:null,state:'started'});await this.save();}
 async onWireAttemptResult(url:string,status:number|null,failure:string|null){const attempt=this.current!.attempts.at(-1);if(!attempt||attempt.url!==publicUrl(url).href||attempt.state!=='started')throw new R2ExecutorError('JOURNAL_ACCOUNTING','Wire result has no matching started attempt');attempt.status=status;attempt.failure=failure;attempt.state=failure?'failed':'succeeded';await this.save();}
 async onChunk(url:string,bytes:number){const journal=this.current!,attempt=journal.attempts.at(-1);if(!attempt||attempt.url!==publicUrl(url).href)throw new R2ExecutorError('JOURNAL_ACCOUNTING','Wire body has no matching durable attempt');attempt.bytes+=bytes;journal.wireBytes+=bytes;await this.save();if(attempt.bytes>bounds.body)throw new R2ExecutorError('BODY_BUDGET','Per-response body budget reached');if(this.policies.has(attempt.url)&&attempt.bytes>bounds.policyBody)throw new R2ExecutorError('POLICY_BODY_BUDGET','Policy body budget reached');if(journal.wireBytes>bounds.totalWire)throw new R2ExecutorError('WIRE_BUDGET','Total wire body budget reached');}
 async onWireResponse(url:string,status:number,body:Buffer,contentType:string){
  const canonicalUrl=publicUrl(url).href;if(!this.documents.has(canonicalUrl)||status<200||status>=300)return;
  const prior=this.priorR1[canonicalUrl],sha256=hash(body);if(!prior||prior===sha256)return;
  const mimeType=responseMime(body,contentType),item=this.documents.get(canonicalUrl)!,journal=this.current!,quarantinePath=join(dirname(this.options.journalPath),'quarantine',sha256);
  await mkdir(dirname(quarantinePath),{recursive:true,mode:0o700});
  try{const handle=await open(quarantinePath,'wx',0o600);try{await handle.writeFile(body);await handle.sync();}finally{await handle.close();}}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const existing=await readFile(quarantinePath);if(hash(existing)!==sha256)throw new R2ExecutorError('QUARANTINE_CAS_MISMATCH','Existing quarantine object differs from changed representation');}
  journal.quarantined[canonicalUrl]={sha256,r1Sha256:prior,bytes:body.length,localPath:quarantinePath,sourceId:item.sourceId,mimeType,reviewed:false};journal.paused=true;await this.save();
 }
 private async stopRequested(){try{await stat(this.options.stopFile);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
 private async pauseWithCheckpoint(journal:Journal){
  journal.paused=true;
  journal.checkpoint={sequence:journal.sequence+1,recordHash:journal.recordHash||'0'.repeat(64),createdAt:new Date().toISOString(),digestSet:Object.fromEntries(Object.entries(journal.completed).map(([url,row])=>[url,row.sha256]))};
  await this.save();
  journal.checkpoint={...journal.checkpoint,sequence:journal.sequence,recordHash:journal.recordHash};
  await this.save();
 }
 private async validReview(journal:Journal):Promise<string|undefined>{
  if(!this.options.reviewPath||!this.options.reviewSha256||!journal.checkpoint)return;
  try{
   const path=resolve(this.options.reviewPath),metadata=await lstat(path);if(!metadata.isFile()||metadata.isSymbolicLink()||await realpath(path)!==path)return;
   const bytes=await readFile(path),digest=hash(bytes);if(digest!==this.options.reviewSha256||journal.consumedReviews.includes(digest))return;
   const review=ReviewSchema.parse(JSON.parse(bytes.toString('utf8'))),checkpoint=journal.checkpoint;
   if(review.releaseSha256!==this.options.recordSha256||review.manifestSha256!==this.options.manifestSha256||review.checkpointSequence!==checkpoint.sequence||review.checkpointRecordHash!==checkpoint.recordHash||review.digestSetSha256!==hash(canonical(checkpoint.digestSet))||Date.parse(review.issuedAt)<=Date.parse(checkpoint.createdAt)||Date.parse(review.issuedAt)>Date.now())return;
   return digest;
  }catch{return;}
 }
 private async save(){if(this.current)await persistJournal(this.options.journalPath,this.current);}
 private async releaseQuarantined(journal:Journal){
  const pending=Object.entries(journal.quarantined).filter(([,row])=>!row.reviewed);if(!pending.length)return;
  if(!this.options.changedReleasePath||!this.options.changedReleaseSha256)return;
  const path=resolve(this.options.changedReleasePath),metadata=await lstat(path);
  if(!metadata.isFile()||metadata.isSymbolicLink()||await realpath(path)!==path)throw new R2ExecutorError('CHANGED_RELEASE_PATH_UNSAFE','Changed-source release must be a regular file');
  const bytes=await readFile(path);if(hash(bytes)!==this.options.changedReleaseSha256)throw new R2ExecutorError('CHANGED_RELEASE_HASH_MISMATCH','Changed-source release digest mismatch');
  const release=ChangedSourceReleaseSchema.parse(JSON.parse(bytes.toString('utf8')));
  if(Date.parse(release.reviewedAt)>Date.now())throw new R2ExecutorError('CHANGED_RELEASE_TIME_INVALID','Changed-source review time is in the future');
  const tuples=new Map<string,typeof release.representations[number]>();
  for(const row of release.representations){
   const url=publicUrl(row.url).href,held=journal.quarantined[url];
   if(url!==row.url||tuples.has(url)||!held||held.sourceId!==row.sourceId||held.sha256!==row.sha256||held.r1Sha256!==row.r1Sha256)throw new R2ExecutorError('CHANGED_RELEASE_MISMATCH','Changed-source release contains a URL/source/digest tuple not held in this journal');
   tuples.set(url,row);
  }
  for(const [url,held] of pending){
   if(!tuples.has(url))continue;
   const casPath=join(this.fetcher.cacheDir,'sha256',held.sha256),casMetadata=await lstat(casPath),casBytes=await readFile(casPath);
   if(!casMetadata.isFile()||casMetadata.isSymbolicLink()||await realpath(casPath)!==casPath||hash(casBytes)!==held.sha256||casBytes.length!==held.bytes)throw new R2ExecutorError('CHANGED_RELEASE_CAS_MISSING','Exact changed-source approval has no matching retained CAS object');
   if(!['text/html','application/xhtml+xml','application/pdf'].includes(held.mimeType))await this.stop('RELEASE_UNSUPPORTED_MIME');
   if(held.bytes>bounds.body)await this.stop('RELEASE_BODY_BUDGET');
   if(held.mimeType.startsWith('text/html')&&held.bytes>bounds.html)await this.stop('RELEASE_HTML_BUDGET');
   if(Object.keys(journal.completed).length>=bounds.documents)await this.stop('DOCUMENT_BUDGET');
   if(journal.retainedBytes+held.bytes>bounds.retained)await this.stop('RETAINED_BYTE_BUDGET');
   held.reviewed=true;journal.completed[url]={sha256:held.sha256,bytes:held.bytes,localPath:casPath,sourceId:held.sourceId};journal.retainedBytes+=held.bytes;journal.documentsSinceReview++;
  }
  if(Object.values(journal.quarantined).every(row=>row.reviewed)&&journal.documentsSinceReview<bounds.reviewBatch)journal.paused=false;
  await this.save();
 }
 private async stop(code:string):Promise<{completed:number;paused:boolean;stopped:boolean}>{this.current!.stopped=true;await this.save();throw new R2ExecutorError(code,`R2 acquisition stopped: ${code}`);}
}
