import {z} from 'zod';

export const CanonicalWorkerProgressSchema=z.object({
 schemaVersion:z.literal('stadtstack-r1-canonical-progress-v1'),nonce:z.uuid(),
 phase:z.enum(['opening-context','source-started','source-completed','finishing-epoch','serializing-result']),
 index:z.number().int().min(0).max(255).optional(),
}).strict();
export type CanonicalWorkerProgress=z.infer<typeof CanonicalWorkerProgressSchema>;
const safeCode=z.string().regex(/^(?:(?:ERR|CIVIC|CONTENT|MANAGED|ACQUISITION|HOST|HISTORICAL|SOURCE|SCRATCH|DOCKER|DAEMON|INVALID|HTTP|PARSER)_[A-Z0-9_]{1,80}|E[A-Z0-9_]{1,40}|[0-9A-Z]{5})$/);
const errorName=z.enum(['Error','TypeError','RangeError','SyntaxError','AggregateError','DatabaseError','AbortError']);
export const CanonicalWorkerDiagnosticSchema=z.object({
 schemaVersion:z.literal('stadtstack-r1-canonical-diagnostic-v1'),nonce:z.uuid(),pid:z.number().int().positive(),
 reason:z.enum(['parent-disconnected','parent-stop','signal','database-error','heartbeat-failed','supervisor-exception','thread-error','thread-exit','duplicate-result','invalid-result','ipc-send-failed','canonical-error']),
 phase:CanonicalWorkerProgressSchema.shape.phase.optional(),index:CanonicalWorkerProgressSchema.shape.index,
 exitCode:z.number().int().optional(),signal:z.enum(['SIGTERM','SIGINT']).optional(),
 error:z.object({name:errorName,code:safeCode.optional(),classification:z.enum(['heap-limit','timeout','connection-closed','unclassified']),frames:z.array(z.string().max(240)).max(4)}).strict().optional(),
}).strict();
export type CanonicalWorkerDiagnostic=z.infer<typeof CanonicalWorkerDiagnosticSchema>;
/** Never serialize arbitrary messages, PostgreSQL detail, URLs, requests or workerData.
 * Stable runtime codes plus source/builtin frame locations retain actionable causes. */
export function canonicalWorkerError(error:unknown):NonNullable<CanonicalWorkerDiagnostic['error']>{
 const value=error&&typeof error==='object'?error as {name?:unknown;code?:unknown;message?:unknown;stack?:unknown}:{};
 const name=errorName.safeParse(value.name),code=safeCode.safeParse(value.code),message=typeof value.message==='string'?value.message:'';
 const classification=code.success&&code.data==='ERR_WORKER_OUT_OF_MEMORY'?'heap-limit':/timeout|timed out/i.test(message)?'timeout':code.success&&['ECONNRESET','EPIPE','57P01','57P02','57P03'].includes(code.data)||/connection (?:terminated|closed)|terminating connection/i.test(message)?'connection-closed':'unclassified';
 const frames:string[]=[];
 if(typeof value.stack==='string')for(const line of value.stack.split('\n').slice(1,25)){
  const location=/(?:\b(src\/[a-zA-Z0-9_./-]+\.(?:ts|js|mjs):\d+:\d+)|\b(node:[a-zA-Z0-9_./-]+:\d+:\d+))/.exec(line);
  if(location){frames.push((location[1]??location[2]).slice(0,240));if(frames.length===4)break;}
 }
 return {name:name.success?name.data:'Error',...(code.success?{code:code.data}:{}),classification,frames};
}
export function canonicalWorkerDiagnostic(nonce:string,reason:CanonicalWorkerDiagnostic['reason'],progress?:CanonicalWorkerProgress,error?:unknown,extra:Pick<Partial<CanonicalWorkerDiagnostic>,'exitCode'|'signal'>={}):CanonicalWorkerDiagnostic{
 return CanonicalWorkerDiagnosticSchema.parse({schemaVersion:'stadtstack-r1-canonical-diagnostic-v1',nonce,pid:process.pid,reason,...(progress?{phase:progress.phase,...(progress.index===undefined?{}:{index:progress.index})}:{}),...(error===undefined?{}:{error:canonicalWorkerError(error)}),...extra});
}
export function formatCanonicalWorkerDiagnostic(diagnostic:CanonicalWorkerDiagnostic){return 'R1_CANONICAL_WORKER '+JSON.stringify(diagnostic);}
