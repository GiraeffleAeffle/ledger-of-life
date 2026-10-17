import {z} from 'zod';
import {createHash} from 'node:crypto';
export const caseSemanticsVersion='stadtstack-case-semantics-0.3.2';
export const MetricEvidenceSchema=z.object({
 quote:z.string().min(1).max(1800).optional(),
 sourceIds:z.array(z.string().min(1).max(500)).min(1).max(100),
 locator:z.unknown().optional(),
 kind:z.enum(['text_model','structured']).optional(),
}).strict().superRefine((evidence,ctx)=>{
 if(evidence.kind!=='structured'&&!evidence.quote?.trim())ctx.addIssue({code:'custom',message:'Text metric evidence requires its source quote'});
 if(evidence.kind==='structured'||evidence.locator!==undefined){
  let encoded:string|undefined;
  try{encoded=JSON.stringify(evidence.locator);}catch{}
  const native=evidence.kind!=='structured'||Boolean(evidence.locator&&typeof evidence.locator==='object'&&Object.keys(evidence.locator).length);
  if(!native||!encoded||encoded.length>8192)ctx.addIssue({code:'custom',message:'Metric evidence requires a bounded locator; structured evidence requires a native locator object'});
 }
});
export type MetricEvidence=z.infer<typeof MetricEvidenceSchema>;
/** Scope is an explicitly identified instrument/project, never a title similarity key. */
export const MetricClaimSchema=z.object({
 metric:z.string().min(1).max(100),unit:z.string().min(1).max(40),value:z.number().finite(),
 scope:z.string().min(1).max(500),scopeEvidence:MetricEvidenceSchema,
 instrument:z.string().min(1).max(500).nullable(),reportedAt:z.iso.date().nullable(),evidence:MetricEvidenceSchema,
 replaces:z.object({value:z.number().finite(),reportedAt:z.iso.date().optional(),evidence:MetricEvidenceSchema}).strict().optional(),
}).strict();
export type MetricClaim=z.infer<typeof MetricClaimSchema>;
export type MetricRecord={id:string;municipalityId:string;metricClaims:MetricClaim[]};
export type MetricHistoryEntry={recordId:string;municipalityId:string;claim:MetricClaim;status:'superseded'|'current_supported'|'unresolved';supersededBy:string[]};
/** Administrative uncertainty only; never includes the withheld record, value, quote or source. */
export type MetricReadConstraint={groupId:string;status:'unresolved';reason:'withheld_read_context'};
export type RecordSupersession={status:'superseded'|'partially_superseded'|'not_established';currentValues:MetricHistoryEntry[];history:MetricHistoryEntry[];withheldContext?:MetricReadConstraint[]};
export function metricGroupId(municipalityId:string,claim:Pick<MetricClaim,'scope'|'instrument'|'metric'|'unit'>):string {
 return `metric-group:${createHash('sha256').update(JSON.stringify([municipalityId,claim.scope,claim.instrument,claim.metric,claim.unit])).digest('hex')}`;
}
export type MetricSupersession={recordId:string;replacementRecordId:string;metric:string;unit:string;scope:string;instrument:string|null;previousValue:number;currentValue:number;evidence:MetricEvidence;reportedAt:string};
function sourced(evidence:MetricEvidence):boolean {
 if(!evidence.sourceIds.length)return false;
 if(evidence.kind!=='structured')return Boolean(evidence.quote?.trim());
 // Native locators are passed through unchanged; admission validates their schema.
 return evidence.locator!==null&&typeof evidence.locator==='object'&&Object.keys(evidence.locator).length>0;
}
/** Call only on admitted evidence. Dates constrain explicit replacement, never create it. */
export function resolveMetricSupersession(records:readonly MetricRecord[],asOf:string,historyContext:readonly MetricHistoryEntry[]=[],readConstraints:readonly MetricReadConstraint[]=[]):{records:Map<string,RecordSupersession>;relationships:MetricSupersession[];currentValues:MetricHistoryEntry[];history:MetricHistoryEntry[];withheldContext?:MetricReadConstraint[]} {
 // Full released context survives record filtering and pagination. Explicit input
 // records replace their cached projections, while omitted siblings remain evidence.
 const context=new Map<string,MetricRecord>();
 for(const entry of historyContext){
  const key=JSON.stringify([entry.municipalityId,entry.recordId]),existing=context.get(key);
  if(existing){if(!existing.metricClaims.includes(entry.claim))existing.metricClaims.push(entry.claim);}
  else context.set(key,{id:entry.recordId,municipalityId:entry.municipalityId,metricClaims:[entry.claim]});
 }
 for(const record of records)context.set(JSON.stringify([record.municipalityId,record.id]),record);
 const complete=[...context.values()];
 const entries=complete.flatMap(record=>record.metricClaims.filter(claim=>Number.isFinite(claim.value)&&claim.scope&&claim.metric&&claim.unit&&sourced(claim.evidence)&&sourced(claim.scopeEvidence)&&(!claim.reportedAt||claim.reportedAt<=asOf.slice(0,10))).map(claim=>({municipalityId:record.municipalityId,recordId:record.id,claim,status:'unresolved' as MetricHistoryEntry['status'],supersededBy:[] as string[]})));
 const constraints=new Map(readConstraints.map(constraint=>[constraint.groupId,constraint]));
 const entryGroups=new Map(constraints.size?entries.map(entry=>[entry,metricGroupId(entry.municipalityId,entry.claim)] as const):[]);
 const withheldEntries=new Set(entries.filter(entry=>constraints.has(entryGroups.get(entry)??'')));
 const withheldContext=[...constraints.values()].filter(constraint=>entries.some(entry=>entryGroups.get(entry)===constraint.groupId)).sort((a,b)=>a.groupId.localeCompare(b.groupId));
 const relationships:MetricSupersession[]=[];
 for(const next of entries){
  // Masking cannot create a replacement/current decision by deleting competing evidence.
  if(withheldEntries.has(next))continue;
  const replacement=next.claim.replaces;
  if(!replacement||!sourced(replacement.evidence)||!next.claim.reportedAt)continue;
  const previous=entries.filter(old=>old.recordId!==next.recordId&&old.municipalityId===next.municipalityId&&old.claim.scope===next.claim.scope&&old.claim.instrument===next.claim.instrument&&old.claim.metric===next.claim.metric&&old.claim.unit===next.claim.unit&&old.claim.value===replacement.value&&old.claim.reportedAt&&old.claim.reportedAt<next.claim.reportedAt!&&(!replacement.reportedAt||replacement.reportedAt===old.claim.reportedAt));
  for(const old of previous){
   old.status='superseded';old.supersededBy.push(next.recordId);
   if(next.status!=='superseded')next.status='current_supported';
   relationships.push({recordId:old.recordId,replacementRecordId:next.recordId,metric:next.claim.metric,unit:next.claim.unit,scope:next.claim.scope,instrument:next.claim.instrument,previousValue:old.claim.value,currentValue:next.claim.value,evidence:replacement.evidence,reportedAt:next.claim.reportedAt});
  }
 }
 // Competing terminal values remain conflicts, not a latest-document election.
 for(const entry of entries)if(entry.status==='current_supported'&&entries.some(other=>other!==entry&&other.status!=='superseded'&&other.municipalityId===entry.municipalityId&&other.claim.scope===entry.claim.scope&&other.claim.instrument===entry.claim.instrument&&other.claim.metric===entry.claim.metric&&other.claim.unit===entry.claim.unit&&other.claim.value!==entry.claim.value))entry.status='unresolved';
 const history:MetricHistoryEntry[]=entries;
 const currentValues=history.filter(entry=>entry.status==='current_supported');
 const result=new Map<string,RecordSupersession>();
 for(const record of complete){
  const own=history.filter(entry=>entry.recordId===record.id),superseded=own.filter(entry=>entry.status==='superseded');
  const related=history.filter(entry=>entry.municipalityId===record.municipalityId&&own.some(old=>old.claim.scope===entry.claim.scope&&old.claim.instrument===entry.claim.instrument&&old.claim.metric===entry.claim.metric&&old.claim.unit===entry.claim.unit));
  const withheld=withheldContext.filter(constraint=>related.some(entry=>entryGroups.get(entry)===constraint.groupId));
  result.set(record.id,{status:superseded.length?(superseded.length===own.length?'superseded':'partially_superseded'):'not_established',currentValues:related.filter(entry=>entry.status==='current_supported'),history:related,...(withheld.length?{withheldContext:withheld}:{})});
 }
 return {records:result,relationships,currentValues,history,...(withheldContext.length?{withheldContext}:{})};
}
/** Conservative released-quote rule: an explicit area reduction within one identified instrument. */
export function areaClaimsFromQuote(input:{quote:string;sourceIds:string[];scope:string;scopeQuote:string;instrument:string;reportedAt:string|null}):MetricClaim[] {
 const {quote,sourceIds,scope,instrument,reportedAt}=input;
 if(!quote||!scope||!input.scopeQuote||!sourceIds.length)return [];
 const evidence={quote,sourceIds},scopeEvidence={quote:input.scopeQuote,sourceIds};
 const reduction=/(?:Geltungsbereich|Gesamtfläche|Änderungsbereich)[\s\S]{0,120}?von\s+(?:ca\.?\s*)?(\d+(?:[,.]\d+)?)\s*ha\s+auf\s+(?:nunmehr\s+)?(?:ca\.?\s*)?(\d+(?:[,.]\d+)?)\s*ha[\s\S]{0,240}?reduziert/iu.exec(quote);
 if(reduction){
  // The source must assert an accomplished reduction, not a proposal or denial.
  const subject=/^(?:Geltungsbereich|Gesamtfläche|Änderungsbereich)([\s\S]*?)\bvon\b/iu.exec(reduction[0])!;
  const prefield=quote.slice(0,reduction.index),link=subject[1].trim();
  const subjectFirst=/^\s*(?:(?:der|die|das)\s*)?$/iu.test(prefield)&&/^(?:wurde|wurden|ist|sind)$/iu.test(link);
  const inverted=link===''&&/^(?:[^,;.!?]{1,120}\s+)?wurde(?:n)?\s+(?:nach\s+dem\s+(?:Vorentwurf|Entwurf)\s+)?(?:der|die|das)\s*$/iu.test(prefield);
  const completedTail=/^\s*[.!]?\s*$/u.test(quote.slice(reduction.index+reduction[0].length));
  if(!(subjectFirst||inverted)||!completedTail||/\b(?:nicht|kein\w*)\b/iu.test(reduction[0]))return [];
  return [{metric:'plan_area',unit:'ha',value:Number(reduction[2].replace(',','.')),scope,instrument,reportedAt,evidence,scopeEvidence,replaces:{value:Number(reduction[1].replace(',','.')),evidence}}];
 }
 const area=/(?:Geltungsbereich|Gesamtfläche|Änderungsbereich)[\s\S]{0,65}?(?:ca\.?\s*|etwa\s*)?(\d+(?:[,.]\d+)?)\s*ha\b/iu.exec(quote);
 return area?[{metric:'plan_area',unit:'ha',value:Number(area[1].replace(',','.')),scope,instrument,reportedAt,evidence,scopeEvidence}]:[];
}
