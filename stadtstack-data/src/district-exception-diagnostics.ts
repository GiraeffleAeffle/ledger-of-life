import {constants,readdirSync,readFileSync,openSync,fstatSync,closeSync} from 'node:fs';
import type {Dirent} from 'node:fs';
import {constants as osConstants} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseError} from 'pg';
import {z} from 'zod';
import {ReasonCodeSchema,type StepReceipt} from './district-step-receipt.ts';

const sourceRoot=fileURLToPath(new URL('.',import.meta.url));
/** Snapshot only real source files at module startup. No thrown string can add
 * a filename or expand its line range; symlinks are not admitted.
 */
function sourceCatalogue():Readonly<Record<string,number>> {
 const files:Record<string,number>=Object.create(null);
 const visit=(directory:string):void=>{
  let entries:Dirent[];try{entries=readdirSync(directory,{withFileTypes:true});}catch{return;}
  for(const entry of entries){
   const path=join(directory,entry.name);
   if(entry.isDirectory())visit(path);
   else if(entry.isFile()){
    let fd:number|undefined;
    try{
     fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
     if(!fstatSync(fd).isFile())continue;
     const bytes=readFileSync(fd);let lines=0;
     for(let offset=bytes.indexOf(10);offset!==-1;offset=bytes.indexOf(10,offset+1))lines++;
     if(bytes.length&&bytes[bytes.length-1]!==10)lines++;
     files[relative(sourceRoot,path)]=lines;
    }catch{/* An unreadable file is not an admitted diagnostic location. */}
    finally{if(fd!==undefined)closeSync(fd);}
   }
  }
 };
 visit(sourceRoot);return Object.freeze(files);
}
const sourceFiles=sourceCatalogue();
// Fixed operational vocabulary only. New spellings require an explicit code
// review; neither syntax, Error.name nor Error.constructor.name grants admission.
const codes:Readonly<Record<string,true>>=Object.freeze(Object.fromEntries([
 ...Object.keys(osConstants.errno),...ReasonCodeSchema.options,
 'ABORT_ERR','ENOTFOUND','EAI_AGAIN','EAI_FAIL','ESOCKETTIMEDOUT',
 'ERR_ASSERTION','ERR_INVALID_ARG_TYPE','ERR_INVALID_ARG_VALUE','ERR_OUT_OF_RANGE','ERR_BUFFER_TOO_LARGE',
 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER','ERR_ENCODING_INVALID_ENCODED_DATA','ERR_INVALID_URL','ERR_INVALID_URL_SCHEME',
 'ERR_STREAM_DESTROYED','ERR_STREAM_PREMATURE_CLOSE','ERR_STREAM_WRITE_AFTER_END','ERR_STREAM_CANNOT_PIPE',
 'ERR_HTTP_REQUEST_TIMEOUT','ERR_SOCKET_CLOSED','ERR_TLS_CERT_ALTNAME_INVALID','ERR_WORKER_OUT_OF_MEMORY',
 'ERR_SCRIPT_EXECUTION_TIMEOUT','ERR_UNSUPPORTED_ESM_URL_SCHEME','ERR_UNKNOWN_FILE_EXTENSION','ERR_MODULE_NOT_FOUND',
 'ERR_REQUIRE_ESM','ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE',
 '08000','08001','08003','08004','08006','08007','08P01','23503','23505','23514','40001','40P01',
 '42501','42601','42703','42P01','53100','53200','53300','53400','55000','55P03','57014','57P01','57P02','57P03',
 'DATABASE_CONNECTION_LOST','HOST_OPTED_OUT','municipal_identity_unbound',
 'CIVIC_POLICY_STATE_UNSAFE','CIVIC_POLICY_INVENTORY_UNAVAILABLE','CIVIC_POLICY_AUTHORITY_FOREIGN',
 'CIVIC_POLICY_AUTHORITY_UNAVAILABLE','CIVIC_POLICY_REPAIR_REQUIRED','CIVIC_POLICY_AUTHORITY_UNPINNED',
 'CIVIC_POLICY_AUTHORITY_MISMATCH','CIVIC_POLICY_AUTHORITY_UNPROVISIONED','CIVIC_POLICY_ORPHAN_OBJECTION',
 'CIVIC_POLICY_BUSY','CIVIC_POLICY_SHUTDOWN','CIVIC_POLICY_COMPACTION_MISMATCH','CIVIC_POLICY_BACKUP_MISMATCH',
 'INVALID_HOST','INVALID_LOCK_WAIT','LOCK_IDENTITY_UNAVAILABLE','REGISTRY_CONFIGURATION_PROVENANCE_MISMATCH',
 'HISTORICAL_SOURCE_PURPOSE_REQUIRED','SOURCE_PROVENANCE_KIND_REQUIRED','SOURCE_PROVENANCE_KIND_MISMATCH',
 'DAEMON_RESOURCE_BINDING_MISMATCH','CONTENT_REFERENCE_REVOKED','INVALID_PREPARATION_METADATA','PREPARED_PARSER_CONTRACT_MISSING',
 'ACQUISITION_LANE_MISMATCH','ACQUISITION_LANE_UNSAFE','ACQUISITION_LANE_REQUIRED','ACQUISITION_DECISION_REQUIRED',
 'MANAGED_INVENTORY_INCOMPLETE','INVALID_FRONTIER_METADATA','CONTENT_PROVENANCE_MISSING','CONTENT_BINDING_MISMATCH',
 'OBSERVATION_PATH_REQUIRED','INVALID_MANAGED_OBSERVATION','HTTP_SOURCE_PROVENANCE_REQUIRED','CONTENT_PROVENANCE_MISMATCH',
 'HTTP_OBSERVATION_BINDING_MISMATCH','SCRATCH_PATH_UNSAFE','SCRATCH_IDENTITY_MISMATCH','SCRATCH_INVENTORY_INCOMPLETE',
 'SCRATCH_PROCESS_INVALID','SCRATCH_PROCESS_UNAVAILABLE','SCRATCH_CLOSED','SCRATCH_CONTENT_CHANGED',
 'SCRATCH_PROVENANCE_MISSING','SCRATCH_PROVENANCE_INVALID','NON_SOURCE_PROVENANCE_ADMISSION_DENIED',
 'NON_SOURCE_PROVENANCE_NATIVE_DENIED','NATIVE_MODEL_REQUIRES_PRODUCTION_AUTHORITY','VM_CODEX_ONLY',
 'DAEMON_RESOURCE_LEASE_REQUIRED','SCRATCH_SOURCE_BINDING_MISMATCH','SCRATCH_COMMAND_INVALID',
 'DOCKER_CONTRACT_INVALID','DOCKER_SOCKET_UNSAFE','DOCKER_INPUT_NOT_IMMUTABLE','DOCKER_CONTROL_INVALID',
 'DOCKER_INPUT_CHANGED','DOCKER_DAEMON_CHANGED','DOCKER_START_REJECTED','DOCKER_INPUT_REJECTED','DOCKER_NOT_STARTED',
 'SCRATCH_CLEANUP_INCOMPLETE','INVALID_OPERATOR_ARGUMENTS','MANAGED_ROOT_UNSAFE','MANAGED_ROOT_ACTIVE_SCRATCH',
 'MANAGED_CONTENT_CHANGED','INVALID_RECEIVED_AT','HOST_NOT_REGISTERED','FIXTURE_READINESS_REQUIRES_ISOLATED_AUTHORITY','SOURCE_CONTEXT_REQUIRED',
].map(code=>[code,true as const])));

let classCatalogue:Promise<WeakMap<object,string>>|undefined;
/** Curated imports are lazy to avoid jobs/assessment/parser initialization cycles.
 * This imports declarations only; no authority, provider or credential is read.
 */
async function errorClasses():Promise<WeakMap<object,string>> {
 const [civic,docker,jobs,database,context,crawl,haiku,model,omp,parser,adapters,work,genesis,revocation,fetch,oparl]=await Promise.all([
  import('./civic-opt-out.ts'),import('./civic-docker.ts'),import('./district-jobs.ts'),import('./district-database.ts'),
  import('./district-assessment-context.ts'),import('./district-crawl-request.ts'),import('./district-haiku-bridge.ts'),
  import('./district-model-contract.ts'),import('./district-omp-b-runner.ts'),import('./district-parser-isolation.ts'),
  import('./district-source-adapters.ts'),import('./district-work-plan.ts'),import('./genesis-owner-credentials.ts'),
  import('./mcp-revocation-config.ts'),import('./polite-fetch.ts'),import('./council-oparl.ts'),
 ]);
 const constructors={Error,TypeError,RangeError,SyntaxError,ReferenceError,AggregateError,EvalError,URIError,DOMException,
  ZodError:z.ZodError,DatabaseError,
  CivicPolicyStateError:civic.CivicPolicyStateError,HostOptedOutError:civic.HostOptedOutError,DockerLifecycleError:docker.DockerLifecycleError,
  DistrictExecutionHold:jobs.DistrictExecutionHold,NotificationTransientError:jobs.NotificationTransientError,NotificationAmbiguousError:jobs.NotificationAmbiguousError,
  DistrictDatabaseConnectionLost:database.DistrictDatabaseConnectionLost,AssessmentContextHold:context.AssessmentContextHold,
  CrawlRequestEvidenceCaptureError:crawl.CrawlRequestEvidenceCaptureError,HaikuBridgeHold:haiku.HaikuBridgeHold,
  SubscriptionRuntimeError:model.SubscriptionRuntimeError,OmpRunnerHold:omp.OmpRunnerHold,ParserIsolationError:parser.ParserIsolationError,
  MunicipalIdentityBindingError:adapters.MunicipalIdentityBindingError,RemoteWorkFailure:work.RemoteWorkFailure,
  GenesisResponseScreeningHold:genesis.GenesisResponseScreeningHold,GenesisCredentialUnavailable:genesis.GenesisCredentialUnavailable,
  GovernedRevocationConfigError:revocation.GovernedRevocationConfigError,PoliteFetchError:fetch.PoliteFetchError,CouncilBindingError:oparl.CouncilBindingError,
 };
 const prototypes=new WeakMap<object,string>();
 for(const [name,constructor] of Object.entries(constructors)){
  const prototype=Object.getOwnPropertyDescriptor(constructor,'prototype')?.value;
  if(prototype&&typeof prototype==='object')prototypes.set(prototype,name);
 }
 // Zod's schema parser can use its separate real-Error implementation.
 const invalid=z.never().safeParse(null);
 if(!invalid.success)prototypes.set(Object.getPrototypeOf(invalid.error),'ZodError');
 // Node's AbortError constructor is not public. Obtain its actual prototype
 // from the real already-aborted timers API, never from a thrown name string.
 try{await delay(0,undefined,{signal:AbortSignal.abort()});}
 catch(error){prototypes.set(Object.getPrototypeOf(error),'AbortError');}
 return prototypes;
}
function firstSourceFrame(error:{stack?:unknown;name?:unknown;message?:unknown}):string {
 const stack=error.stack;if(typeof stack!=='string')return 'none';
 let frames=stack;
 const name=error.name,message=error.message;
 if(typeof name==='string'&&typeof message==='string'){
  const prefix=name?name+(message?': ':''):'',offset=prefix.length+message.length,boundary=stack[offset];
  if(!stack.startsWith(prefix)||!stack.startsWith(message,prefix.length)||boundary!==undefined&&boundary!=='\r'&&boundary!=='\n')return 'none';
  frames=stack.slice(offset);
 }
 const frame=/^[ \t]*at ([^\r\n]*)/m.exec(frames);
 const location=frame&&/(?:^|[ (])((?:file:\/\/\/|\/)[^()\s]+):([1-9][0-9]{0,9}):[1-9][0-9]{0,9}\)?$/.exec(frame[1]);
 if(!location)return 'none';
 const path=location[1].startsWith('file:')?fileURLToPath(location[1]):location[1],source=relative(sourceRoot,path),line=Number(location[2]);
 if(isAbsolute(source)||!Object.hasOwn(sourceFiles,source)||line>sourceFiles[source])return 'none';
 return 'src/'+source+':'+line;
}
/** Content-free stderr projection only; never persisted or used for disposition. */
export async function formatDistrictJobException(jobKey:string,step:string,error:unknown):Promise<string> {
 let errorClass='other',code='other',at='none';
 if(error!==null&&(typeof error==='object'||typeof error==='function')){
  const value=error as {code?:unknown;stack?:unknown;name?:unknown;message?:unknown};
  // Every emitted label comes from a fixed dictionary. Accessor/proxy failures
  // cannot replace the already-committed hold or expand that vocabulary.
  try{const classes=await(classCatalogue??=errorClasses());errorClass=classes.get(Object.getPrototypeOf(error))??'other';}catch{}
  try{const candidate=value.code;if(typeof candidate==='string'&&candidate.length<=64&&Object.hasOwn(codes,candidate))code=candidate;}catch{}
  try{at=firstSourceFrame(value);}catch{}
 }
 return `R1_EXCEPTION job=${jobKey.slice(0,12)} step=${step} class=${errorClass} code=${code} at=${at}\n`;
}

/** Fixed native-B vocabulary. Provider labels come only from typed event fields,
 * never source content, error prose, stderr, account identity or credential data. */
export const OmpFailureKindSchema=z.enum([
 'exit_nonzero','stop_length','stop_error','stop_other','stream_update_error','turn_reason','agent_reason',
 'provider_error_auth','provider_error_rate_limit','provider_error_overloaded','provider_error_invalid_request',
 'provider_error_not_found','provider_error_server','provider_error_network','provider_error_unknown','exception_other',
]);
export type OmpFailureKind=z.infer<typeof OmpFailureKindSchema>;
export function formatDistrictBFailure(jobKey:string,step:string,receipt:Pick<StepReceipt,'outcome'|'reasonCode'|'versions'>):string|undefined {
 if(step!=='assessment_b'||receipt.outcome!=='held_execution'||!['omp_provider_failed','budget_paused'].includes(receipt.reasonCode)||!/^[a-f0-9]{64}$/.test(jobKey))return;
 const kind=OmpFailureKindSchema.safeParse(receipt.versions.ompFailureKind);
 if(kind.success)return `R1_B_FAILURE job=${jobKey.slice(0,12)} kind=${kind.data}\n`;
}
