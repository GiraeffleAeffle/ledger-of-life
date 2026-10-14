import {z} from 'zod';
import {HashSchema,canonicalJson,digest} from './district-adapter-contract.ts';
import {documentChunks} from './district-claims.ts';
import {DistrictExecutionHold} from './district-jobs.ts';

// Canonical provider data, including claim/rubric/locators and C's reviews, not
// just raw excerpt bytes. Leaves 2 KB below B's 24 KB envelope and 18 KB below
// Codex's 40 KB data bound for source-free control/schema and answer overhead.
export const ASSESSMENT_CONTEXT_BYTES=22000;
export class AssessmentContextHold extends DistrictExecutionHold {
 constructor(reason:'quality_failed'|'assessment_context_exceeded'='quality_failed'){super(reason);}
}
export const AssessmentContextSchema=z.object({
 version:z.literal('assessment-prepared-context-v1'),offsetUnit:z.literal('utf16_code_units'),preparedTextSha256:HashSchema,
 chunks:z.array(z.object({id:z.string().min(1),index:z.number().int().nonnegative(),start:z.number().int().nonnegative(),end:z.number().int().positive(),excerpt:z.string().min(1),excerptSha256:HashSchema}).strict()).min(1),
 limitations:z.array(z.string().min(1)).min(1),
}).strict();
export type AssessmentContext=z.infer<typeof AssessmentContextSchema>;
export function assertAssessmentContextBound(data:unknown):void {
 if(Buffer.byteLength(canonicalJson(data))>ASSESSMENT_CONTEXT_BYTES)throw new AssessmentContextHold('assessment_context_exceeded');
}
/** The entire extraction-cited chunk is the minimal governed context: it also
 * covers propositions without individual quotes and preserves qualifications.
 * No adaptive shrinking, summaries, nearest-string matches or omitted prefix. */
export function buildPreparedAssessmentContext(text:string,textSha256:string,chunk:{index:number;start:number;end:number;count:number},sourceLocators:readonly string[]):AssessmentContext {
 const chunks=documentChunks(text),actual=chunks[chunk.index];
 if(digest(text)!==textSha256||!actual||chunks.length!==chunk.count||actual.start!==chunk.start||actual.end!==chunk.end
  ||!sourceLocators.length||sourceLocators.some(locator=>locator!==`text-sha256:${textSha256};chars:${chunk.start}-${chunk.end}`))throw new AssessmentContextHold();
 const context=AssessmentContextSchema.parse({version:'assessment-prepared-context-v1',offsetUnit:'utf16_code_units',preparedTextSha256:textSha256,
  chunks:[{id:`chunk:${chunk.index}:${chunk.start}:${chunk.end}`,index:chunk.index,start:chunk.start,end:chunk.end,excerpt:actual.text,excerptSha256:digest(actual.text)}],
  limitations:['Only complete extraction-cited prepared-text chunks are supplied; the rest of the authenticated document is omitted. Abstain or escalate if these chunks cannot establish a claim or its qualifications.']});
 assertAssessmentContextBound(context);
 return context;
}
/** Reopen authenticated text on each A/B/C, reconcile and seal read. */
export function verifyAssessmentContext(context:AssessmentContext,text:string,textSha256:string,locators:readonly {start:number;end:number}[]):void {
 const chunks=documentChunks(text);
 if(context.preparedTextSha256!==textSha256||digest(text)!==textSha256)throw new AssessmentContextHold();
 let priorEnd=0;
 for(const span of context.chunks){
  const actual=chunks[span.index];
  if(!actual||span.start<priorEnd||span.start!==actual.start||span.end!==actual.end||span.id!==`chunk:${span.index}:${span.start}:${span.end}`
   ||span.excerpt!==actual.text||digest(span.excerpt)!==span.excerptSha256)throw new AssessmentContextHold();
  priorEnd=span.end;
 }
 if(locators.some(locator=>!context.chunks.some(span=>span.start<=locator.start&&span.end>=locator.end)))throw new AssessmentContextHold();
 assertAssessmentContextBound(context);
}
