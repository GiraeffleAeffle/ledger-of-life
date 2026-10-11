import {z} from 'zod';
import {REGIONAL_EXCERPT_LIMITS} from '../regional/statements.mjs';
import type {ParserSourceContext} from './district-parser-isolation.ts';

export const statementEvidenceSchema=z.object({quote:z.string().trim().min(1).max(REGIONAL_EXCERPT_LIMITS.quoteCharacters),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),textNormalization:z.literal('html-whitespace-v1')}).strict();
export type StatementEvidence=z.infer<typeof statementEvidenceSchema>;
export const regionalStatementFields={statement:z.string().trim().min(1).max(REGIONAL_EXCERPT_LIMITS.statementCharacters).optional(),statementEvidence:z.array(statementEvidenceSchema).min(1).max(REGIONAL_EXCERPT_LIMITS.quotes).optional()};
const statementInput=z.object({locator:z.string(),...regionalStatementFields}).superRefine((item,ctx)=>{
 if(item.statement===undefined&&item.statementEvidence===undefined)return;
 if(!item.statement||!item.statementEvidence||item.statement!==item.statementEvidence.map(evidence=>evidence.quote).join('\n\n'))ctx.addIssue({code:'custom',message:'Regional statement must equal its source-bound excerpts; locators are not statements'});
 if(item.statementEvidence&&new Set(item.statementEvidence.map(evidence=>evidence.sourceSha256)).size!==1)ctx.addIssue({code:'custom',message:'Regional statement excerpts must bind the same source snapshot'});
});
export const sourcedStatementInput=statementInput.safeExtend({url:z.url()});
/** Historical locator-only items stay readable without presenting navigation as a fact. */
export function regionalStatement(input:unknown){
 const item=statementInput.parse(input);
 return {statement:item.statement??'',locator:item.locator,statementEvidence:item.statementEvidence??[],statementStatus:item.statement?'source_backed' as const:'not_extracted' as const};
}

export interface RegionalStatementSourceRequest {url:string;sourceSha256:string}
export interface RegionalStatementSnapshot {url:string;bytes:Uint8Array;sourceContext:ParserSourceContext}
/** Implementations must resolve an authoritative retained URL/hash observation, with current policy checks. */
export type RegionalStatementSourceResolver=(request:RegionalStatementSourceRequest)=>Promise<RegionalStatementSnapshot|null>;
