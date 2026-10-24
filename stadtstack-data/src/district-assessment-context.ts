import {z} from 'zod';
import {HashSchema,canonicalJson,digest} from './district-adapter-contract.ts';
import {documentChunks} from './district-claims.ts';
import {DistrictExecutionHold} from './district-jobs.ts';

// Canonical A/B role data, not merely raw excerpt bytes: 2 KB below B's
// 24 KB evidence ceiling. C adds genuine reviews on Codex only; leave 4 KB
// below Codex's 40 KB data ceiling (source-free prompt/schema are separate).
export const ASSESSMENT_CONTEXT_BYTES=22000;
export const ASSESSMENT_RECONCILIATION_BYTES=36000;
export const ASSESSMENT_NEIGHBOUR_CODE_UNITS=256;
export class AssessmentContextHold extends DistrictExecutionHold {
 declare readonly reasonCode:'quality_failed'|'assessment_context_exceeded';
 constructor(reason:'quality_failed'|'assessment_context_exceeded'='quality_failed'){super(reason);}
}
const CitedChunkSchema=z.object({id:z.string().min(1),index:z.number().int().nonnegative(),start:z.number().int().nonnegative(),end:z.number().int().positive()}).strict();
export const AssessmentContextSchema=z.object({
 version:z.literal('assessment-prepared-context-v1'),offsetUnit:z.literal('utf16_code_units'),preparedTextSha256:HashSchema,
 neighbourCodeUnits:z.literal(ASSESSMENT_NEIGHBOUR_CODE_UNITS),chunks:z.array(CitedChunkSchema).min(1),
 spans:z.array(z.object({chunkId:z.string().min(1),start:z.number().int().nonnegative(),end:z.number().int().positive(),excerpt:z.string().min(1),excerptSha256:HashSchema}).strict()).min(1),
 limitations:z.array(z.string().min(1)).min(1),
}).strict();
export type AssessmentContext=z.infer<typeof AssessmentContextSchema>;
export function assertAssessmentContextBound(data:unknown,role:'A'|'B'|'C'='A'):void {
 const cap=role==='C'?ASSESSMENT_RECONCILIATION_BYTES:ASSESSMENT_CONTEXT_BYTES;
 if(Buffer.byteLength(canonicalJson(data))>cap)throw new AssessmentContextHold('assessment_context_exceeded');
}
function splitsUtf16Scalar(text:string,offset:number):boolean {
 return offset>0&&offset<text.length&&text.charCodeAt(offset-1)>=0xd800&&text.charCodeAt(offset-1)<=0xdbff
  &&text.charCodeAt(offset)>=0xdc00&&text.charCodeAt(offset)<=0xdfff;
}
/** Fixed neighbouring windows, clipped to extraction provenance, merged only
 * on overlap/touch. UTF-16 neighbours never introduce half a Unicode scalar.
 * Quote/claim evidence is not trimmed to fit: an oversized union is held. */
function evidenceWindows(text:string,chunks:AssessmentContext['chunks'],locators:readonly {start:number;end:number}[]):AssessmentContext['spans'] {
 if(!locators.length)throw new AssessmentContextHold();
 const windows=locators.map(locator=>{
  const chunk=chunks.find(c=>c.start<=locator.start&&c.end>=locator.end);
  if(!chunk||locator.start>=locator.end||splitsUtf16Scalar(text,locator.start)||splitsUtf16Scalar(text,locator.end))throw new AssessmentContextHold();
  let start=Math.max(chunk.start,locator.start-ASSESSMENT_NEIGHBOUR_CODE_UNITS),end=Math.min(chunk.end,locator.end+ASSESSMENT_NEIGHBOUR_CODE_UNITS);
  if(splitsUtf16Scalar(text,start))start++;
  if(splitsUtf16Scalar(text,end))end--;
  return {chunkId:chunk.id,start,end};
 }).sort((a,b)=>a.start-b.start||a.end-b.end);
 const merged:typeof windows=[];
 for(const window of windows){
  const prior=merged.at(-1);
  if(prior&&prior.chunkId===window.chunkId&&window.start<=prior.end)prior.end=Math.max(prior.end,window.end);
  else merged.push({...window});
 }
 return merged.map(span=>{const excerpt=text.slice(span.start,span.end);return {...span,excerpt,excerptSha256:digest(excerpt)};});
}
export function buildPreparedAssessmentContext(text:string,textSha256:string,chunk:{index:number;start:number;end:number;count:number},sourceLocators:readonly string[],locators:readonly {start:number;end:number}[]):AssessmentContext {
 const chunks=documentChunks(text),actual=chunks[chunk.index];
 if(digest(text)!==textSha256||!actual||chunks.length!==chunk.count||actual.start!==chunk.start||actual.end!==chunk.end
  ||!sourceLocators.length||sourceLocators.some(locator=>locator!==`text-sha256:${textSha256};chars:${chunk.start}-${chunk.end}`))throw new AssessmentContextHold();
 const cited=[{id:`chunk:${chunk.index}:${chunk.start}:${chunk.end}`,index:chunk.index,start:chunk.start,end:chunk.end}];
 const context=AssessmentContextSchema.parse({version:'assessment-prepared-context-v1',offsetUnit:'utf16_code_units',preparedTextSha256:textSha256,neighbourCodeUnits:ASSESSMENT_NEIGHBOUR_CODE_UNITS,
  chunks:cited,spans:evidenceWindows(text,cited,locators),
  limitations:['Only exact quote spans with fixed neighbouring prepared text are supplied, clipped to extraction-cited chunks. Other document/chunk text is omitted. Abstain or escalate if supplied spans cannot establish every proposition or its qualifications; no omitted context may be inferred.']});
 assertAssessmentContextBound(context);
 return context;
}
/** Reopen authenticated text on each A/B/C, reconcile and seal read. */
export function verifyAssessmentContext(context:AssessmentContext,text:string,textSha256:string,locators:readonly {start:number;end:number}[]):void {
 const chunks=documentChunks(text);
 if(context.preparedTextSha256!==textSha256||digest(text)!==textSha256)throw new AssessmentContextHold();
 let priorIndex=-1;
 for(const cited of context.chunks){
  const actual=chunks[cited.index];
  if(!actual||cited.index<=priorIndex||cited.start!==actual.start||cited.end!==actual.end||cited.id!==`chunk:${cited.index}:${cited.start}:${cited.end}`)throw new AssessmentContextHold();
  priorIndex=cited.index;
 }
 if(canonicalJson(context.spans)!==canonicalJson(evidenceWindows(text,context.chunks,locators)))throw new AssessmentContextHold();
 assertAssessmentContextBound(context);
}
