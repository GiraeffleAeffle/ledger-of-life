import {z} from 'zod';
import {isAbsolute} from 'node:path';
import {HashSchema,canonicalJson,digest,semanticHash} from './district-adapter-contract.ts';
import {StepReceiptSchema} from './district-step-receipt.ts';

const Pin=z.object({path:z.string().refine(isAbsolute),sha256:HashSchema}).strict();
const Clock=z.iso.datetime();
const Step=z.object({sha256:HashSchema,receipt:StepReceiptSchema,stageAuthority:Pin}).strict();
const Evidence=z.object({
 schemaVersion:z.literal('r1-step8-structured-execution-evidence-v1'),continuation:Pin,ownerDecision:Pin,baseAuthority:Pin,
 startedAt:Clock,finishedAt:Clock,
 priorGenesis:z.object({continuation:Pin,sha256:HashSchema,receipt:StepReceiptSchema}).strict(),
 steps:z.array(Step).min(3).max(6),stageAuthorities:z.array(Pin).min(3).max(6),
 wholeOperationHttpCeilingIncludingHistory:z.literal(20),newAcquisitionAttempts:z.literal(1),newParseJobs:z.number().int().min(2).max(5),
}).strict();
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
const requireThat=(condition:unknown,message:string)=>{if(!condition)throw Error(message);};
/** An execution deadline governs actual completed work, not the later policy
 * recheck clock. It cannot authorize a future request or renew any source proof. */
export function assertHistoricalStructuredExecution(window:{issuedAt:string;expiresAt:string},startedAt:string,finishedAt:string){
 const issued=Date.parse(Clock.parse(window.issuedAt)),end=Date.parse(Clock.parse(window.expiresAt)),started=Date.parse(Clock.parse(startedAt)),finished=Date.parse(Clock.parse(finishedAt));
 requireThat(issued<=started&&started<=finished&&finished<=end&&finished<=Date.now(),'Structured work did not finish inside its genuinely issued execution window');
}
export async function authenticateStructuredExecutionEvidence(input:{evidence:z.infer<typeof Pin>;baseAuthority:z.infer<typeof Pin>;selectionIssuedAt:string;receipts:readonly {runId:string;sha256:string;step:string;municipalityId:string;sourceId:string}[];readControl:(pin:z.infer<typeof Pin>)=>Promise<Uint8Array>}){
 const read=async(pin:z.infer<typeof Pin>)=>{const bytes=Buffer.from(await input.readControl(Pin.parse(pin)));requireThat(digest(bytes)===pin.sha256,'Structured execution control digest mismatch');return JSON.parse(bytes.toString('utf8'));};
 const evidence=Evidence.parse(await read(input.evidence));requireThat(same(evidence.baseAuthority,input.baseAuthority),'Execution evidence changes original renewal authority');
 const continuation=z.object({schemaVersion:z.literal('r1-step8-structured-rest-continuation-v1'),issuedAt:Clock,expiresAt:Clock,baseAuthority:Pin,ownerDecision:Pin,ownerDraftSha256:HashSchema,resolution:z.object({action:z.literal('resume-pegel-once-then-all-remaining-local-parses'),resumeJobKey:HashSchema,pegelAttemptBefore:z.literal(1),pegelAttemptAfter:z.literal(2),additionalHttpRequestCeiling:z.literal(8),wholeOperationHttpCeilingIncludingHistory:z.literal(20),maxNewAcquisitionJobs:z.literal(1),maxLocalParseJobs:z.literal(5),maxPegelPages:z.literal(4),maxNewJobs:z.literal(6),maxWholeOperationJobs:z.literal(8),maxModelCalls:z.literal(0),paidMicroUsd:z.literal(0)}).passthrough()}).passthrough().parse(await read(evidence.continuation));
 const rawOwner=await read(evidence.ownerDecision),owner=z.object({schemaVersion:z.literal('stadtstack-r1-owner-approval-record-v1'),issuedAt:Clock,approved:z.literal(true),approver:z.literal('Max (owner)'),ownerStatementsVerbatim:z.array(z.string().min(1)).min(1),baseAuthority:Pin,request:z.object({action:z.literal('one-additional-exact-pegel-attempt-and-remaining-local-structured-parses'),jobKey:HashSchema,additionalAcquisitionAttempts:z.literal(1),additionalPegelDataRequests:z.literal(1),additionalHttpRequestCeiling:z.literal(8),wholeOperationHttpCeilingIncludingHistory:z.literal(20),wholeOperationAcquisitionAttemptCeilingIncludingHistory:z.literal(3),wholeOperationJobCeilingIncludingHistory:z.literal(8),maxRemainingLocalParseJobs:z.literal(5),maxPegelParserPages:z.literal(4),maxModelCalls:z.literal(0),paidMicroUsd:z.literal(0),wallBudgetExtension:z.literal(true),expiresAt:Clock}).passthrough()}).passthrough().parse(rawOwner);
 requireThat(same(continuation.baseAuthority,input.baseAuthority)&&same(owner.baseAuthority,input.baseAuthority)&&same(continuation.ownerDecision,evidence.ownerDecision)&&continuation.expiresAt===owner.request.expiresAt&&continuation.resolution.resumeJobKey===owner.request.jobKey,'Execution continuation changes exact owner scope');
 requireThat(continuation.ownerDraftSha256===digest(JSON.stringify({...rawOwner,issuedAt:'',approved:false,ownerStatementsVerbatim:[]},null,2)+'\n'),'Execution owner decision differs from reviewed draft');
 requireThat(Date.parse(owner.issuedAt)<=Date.parse(continuation.issuedAt),'Continuation precedes owner decision');
 assertHistoricalStructuredExecution(continuation,evidence.startedAt,evidence.finishedAt);
 requireThat(Date.parse(evidence.finishedAt)<=Date.parse(Clock.parse(input.selectionIssuedAt)),'Selection precedes completed structured execution');
 const prior=z.object({issuedAt:Clock,expiresAt:Clock,baseAuthority:Pin,resolution:z.object({action:z.literal('fresh-authority-for-unattempted-genesis-only'),jobKeys:z.array(HashSchema).length(1)}).passthrough()}).passthrough().parse(await read(evidence.priorGenesis.continuation)),genesis=evidence.priorGenesis.receipt;
 requireThat(same(prior.baseAuthority,input.baseAuthority)&&semanticHash(genesis)===evidence.priorGenesis.sha256&&genesis.sourceId==='regionalstatistik-genesis'&&genesis.municipalityId==='strausberg'&&genesis.step==='acquire_representation'&&genesis.attempt===1&&genesis.outcome==='succeeded'&&genesis.provider===null&&prior.resolution.jobKeys[0]===genesis.jobKey,'Prior GENESIS acquisition is not the exact successful inspected continuation');
 assertHistoricalStructuredExecution(prior,genesis.startedAt,genesis.finishedAt);
 requireThat(new Set(evidence.steps.map(row=>row.sha256)).size===evidence.steps.length,'Duplicate execution step');
 const acquisitions=evidence.steps.filter(row=>row.receipt.step==='acquire_representation'),parsers=evidence.steps.filter(row=>row.receipt.step==='structured_parse');
 requireThat(acquisitions.length===1&&parsers.length===evidence.newParseJobs&&acquisitions.length+parsers.length===evidence.steps.length,'Execution evidence changes acquisition/parse count');
 const acquisition=acquisitions[0].receipt;requireThat(acquisition.jobKey===owner.request.jobKey&&acquisition.attempt===2&&acquisition.sourceId==='pegelonline'&&acquisition.municipalityId==='hagenow','Additional acquisition is not the exact PEGEL second attempt');
 let genesisParsers=0,pegelParsers=0;
 for(const row of parsers){if(row.receipt.sourceId==='regionalstatistik-genesis')genesisParsers++;else if(row.receipt.sourceId==='pegelonline')pegelParsers++;}
 requireThat(genesisParsers===1&&pegelParsers>=1&&pegelParsers<=4&&genesisParsers+pegelParsers===parsers.length,'Execution evidence changes local parser source/page scope');
 const metadata=parsers.map(({sha256,receipt})=>({sha256,runId:receipt.runId,step:receipt.step,municipalityId:receipt.municipalityId,sourceId:receipt.sourceId})).sort((a,b)=>a.sha256.localeCompare(b.sha256));
 requireThat(same(metadata,[...input.receipts].sort((a,b)=>a.sha256.localeCompare(b.sha256))),'Execution evidence differs from exact selected parser receipts');
 requireThat(same(evidence.stageAuthorities,evidence.steps.map(row=>row.stageAuthority)),'Unused or reordered execution stage authority');
 for(const row of evidence.steps){
  const receipt=row.receipt;requireThat(semanticHash(receipt)===row.sha256&&receipt.outcome==='succeeded'&&receipt.provider===null,'Execution receipt identity/outcome mismatch');
  assertHistoricalStructuredExecution(continuation,receipt.startedAt,receipt.finishedAt);
  requireThat(Date.parse(receipt.startedAt)>=Date.parse(evidence.startedAt)&&Date.parse(receipt.finishedAt)<=Date.parse(evidence.finishedAt),'Receipt outside completed evidence interval');
  const stage=z.object({schemaVersion:z.literal('stadtstack-r1-stage-authorization-record-v1'),issuedAt:Clock,expiresAt:Clock,parentContinuation:Pin,stage:z.object({step:z.string(),jobKeys:z.array(HashSchema).length(1),ags:z.array(z.string()).length(1),maxJobs:z.literal(1),maxElapsedMs:z.number().int().positive().max(540000),category:z.literal('production'),mode:z.literal('bounded_unattended')}).strict()}).passthrough().parse(await read(row.stageAuthority));
  requireThat(same(stage.parentContinuation,evidence.continuation)&&stage.stage.step===receipt.step&&stage.stage.jobKeys[0]===receipt.jobKey&&stage.stage.ags[0]===(receipt.sourceId==='pegelonline'?'13076060':'12064472')&&stage.expiresAt===continuation.expiresAt&&Date.parse(stage.issuedAt)>=Date.parse(continuation.issuedAt),'Stage authority changes continuation/job scope');
  assertHistoricalStructuredExecution(stage,receipt.startedAt,receipt.finishedAt);
 }
 return evidence;
}
