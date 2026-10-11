import {z} from 'zod';
import {createHash} from 'node:crypto';
import {extractRegionalStatement,REGIONAL_EXCERPT_LIMITS} from '../regional/statements.mjs';

export const statementEvidenceSchema=z.object({quote:z.string().trim().min(1).max(REGIONAL_EXCERPT_LIMITS.quoteCharacters),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),textNormalization:z.literal('html-whitespace-v1')}).strict();
export type StatementEvidence=z.infer<typeof statementEvidenceSchema>;
export const regionalStatementFields={statement:z.string().trim().min(1).max(REGIONAL_EXCERPT_LIMITS.statementCharacters).optional(),statementEvidence:z.array(statementEvidenceSchema).min(1).max(REGIONAL_EXCERPT_LIMITS.quotes).optional()};
const statementInput=z.object({locator:z.string(),...regionalStatementFields}).superRefine((item,ctx)=>{
 if(item.statement===undefined&&item.statementEvidence===undefined)return;
 if(!item.statement||!item.statementEvidence||item.statement!==item.statementEvidence.map(evidence=>evidence.quote).join('\n\n'))ctx.addIssue({code:'custom',message:'Regional statement must equal its source-bound excerpts; locators are not statements'});
 if(item.statementEvidence&&new Set(item.statementEvidence.map(evidence=>evidence.sourceSha256)).size!==1)ctx.addIssue({code:'custom',message:'Regional statement excerpts must bind the same source snapshot'});
});
const sourcedStatementInput=statementInput.safeExtend({url:z.url()});
/** Historical locator-only items stay readable without presenting navigation as a fact. */
export function regionalStatement(input:unknown){
 const item=statementInput.parse(input);
 return {statement:item.statement??'',locator:item.locator,statementEvidence:item.statementEvidence??[],statementStatus:item.statement?'source_backed' as const:'not_extracted' as const};
}

export interface RegionalStatementSourceRequest {url:string;sourceSha256:string}
export interface RegionalStatementSnapshot {url:string;bytes:Uint8Array}
/** Implementations must resolve an authoritative retained URL/hash observation, with current policy checks. */
export type RegionalStatementSourceResolver=(request:RegionalStatementSourceRequest)=>Promise<RegionalStatementSnapshot|null>;
/** The shape contract alone is not source verification; publication must check actual retained bytes. */
export function verifyRegionalStatementSnapshot(input:unknown,snapshot:RegionalStatementSnapshot):void {
 const item=sourcedStatementInput.parse(input);
 if(!item.statement||!item.statementEvidence)throw Error('Regional statement source verification requires excerpts');
 if(snapshot.url!==item.url)throw Error('Regional statement source URL mismatch');
 if(createHash('sha256').update(snapshot.bytes).digest('hex')!==item.statementEvidence[0].sourceSha256)throw Error('Regional statement source hash mismatch');
 const html=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(snapshot.bytes);
 const actual=extractRegionalStatement(html,item.statementEvidence.map(evidence=>evidence.quote));
 if(actual.statement!==item.statement||actual.statementEvidence.some(evidence=>evidence.sourceSha256!==item.statementEvidence![0].sourceSha256))throw Error('Regional statement excerpts do not match source snapshot');
}
