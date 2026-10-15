import {z} from 'zod';
import {HashSchema,semanticHash,canonicalJson} from './district-adapter-contract.ts';
import {AssessmentContextHold} from './district-assessment-context.ts';
import type {AssessmentItem} from './district-assessment.ts';

export const ValueAssessmentContextSchema=z.object({version:z.literal('assessment-value-context-v1'),
  targetSha256:HashSchema,answerUnitSha256:HashSchema,custodyReceiptSha256:HashSchema}).strict();
export function valueAnswerUnit(target:NonNullable<AssessmentItem['valueTarget']>){
  return semanticHash({version:'r1-value-answer-unit-v1',questionBankSha256:target.questionBankSha256,
    releaseId:target.releaseId,questionId:target.question.id,lane:target.lane});
}
export function valueWindows(text:string,locators:readonly {start:number;end:number}[],bounds={start:0,end:text.length}){
  const splitsScalar=(offset:number)=>offset>0&&offset<text.length&&text.charCodeAt(offset-1)>=0xd800
    &&text.charCodeAt(offset-1)<=0xdbff&&text.charCodeAt(offset)>=0xdc00&&text.charCodeAt(offset)<=0xdfff;
  if(bounds.start<0||bounds.start>=bounds.end||bounds.end>text.length||splitsScalar(bounds.start)||splitsScalar(bounds.end))throw new AssessmentContextHold();
  const windows=locators.map(locator=>{
    if(locator.start<bounds.start||locator.start>=locator.end||locator.end>bounds.end||splitsScalar(locator.start)||splitsScalar(locator.end))throw new AssessmentContextHold();
    let start=Math.max(bounds.start,locator.start-256),end=Math.min(bounds.end,locator.end+256);
    if(splitsScalar(start))start++;if(splitsScalar(end))end--;
    return {start,end};
  }).sort((a,b)=>a.start-b.start||a.end-b.end);
  const merged:{start:number;end:number}[]=[];
  for(const window of windows){const prior=merged.at(-1);if(prior&&window.start<=prior.end)prior.end=Math.max(prior.end,window.end);else merged.push({...window});}
  return merged;
}
export function assertValueAssessmentContext(item:AssessmentItem){
  const context=ValueAssessmentContextSchema.parse(item.valueContext),target=item.valueTarget;
  if(!target||item.criticalTarget||context.targetSha256!==semanticHash(target)||context.answerUnitSha256!==valueAnswerUnit(target)
    ||item.sources.some(source=>source.assessmentContext||(!source.nativeLocators?.length&&!source.contextSelection)
      ||(source.nativeLocators?.length&&source.contextSelection)))throw new AssessmentContextHold();
  if(item.sources.length&&!item.sources.some(source=>source.admissionReceiptSha256===context.custodyReceiptSha256))throw new AssessmentContextHold();
}
function valueSourceBounds(source:AssessmentItem['sources'][number],attribution:Record<string,unknown>){
  if(source.nativeLocators?.length){
    const published=z.array(z.record(z.string(),z.unknown())).parse(attribution.locators);
    if(source.locators.length||source.nativeLocators.some(locator=>!published.some(value=>canonicalJson(value)===canonicalJson(locator))))throw new AssessmentContextHold();
    return null;
  }
  const locator=z.string().parse(attribution.locator),match=/^text-sha256:([a-f0-9]{64});chars:([0-9]+)-([0-9]+)$/.exec(locator);
  if(!match||match[1]!==source.textSha256)throw new AssessmentContextHold();
  return {start:Number(match[2]),end:Number(match[3])};
}
export function assertValueSourceContext(source:AssessmentItem['sources'][number],text:string,attribution:Record<string,unknown>){
  const bounds=valueSourceBounds(source,attribution);if(!bounds)return;
  if(!source.contextSelection||canonicalJson(source.contextSelection.spans)!==canonicalJson(valueWindows(text,source.locators,bounds)))throw new AssessmentContextHold();
}
export function boundedValueSource(source:AssessmentItem['sources'][number],text:string,attribution:Record<string,unknown>):AssessmentItem['sources'][number]{
  const {assessmentContext:_preparedContext,contextSelection:_priorSelection,...boundSource}=source;
  const bounds=valueSourceBounds(source,attribution);
  return !bounds?boundSource:{...boundSource,contextSelection:{
    version:'original-context-selection-v1',spans:valueWindows(text,source.locators,bounds),
    limitations:['Only exact locator spans and fixed 256-code-unit neighbours within the MCP-bound prepared-text interval are supplied. All other text is omitted; abstain or escalate if qualifications are unavailable.']}};
}
