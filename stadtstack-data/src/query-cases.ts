import {createHash} from 'node:crypto';
import type {QueryRecord} from './mcp-query.ts';

export type IdentityBasis={type:'plan_number'|'diplan'|'paper_reference'|'bobsh'|'record';value:string;quote:string;recordId:string;sourceIds:string[]};
export type CaseIdentity={status:'source_identified'|'unresolved';basis:IdentityBasis[];instrument:IdentityBasis|null;relatedInstruments:IdentityBasis[]};
export const positiveStages=['planning','agenda','motion','draft','consultation','consultation_closed','evaluation','decision_pending','decision','adopted','in_force','implemented'] as const;
function verifiedClaims(record:QueryRecord):boolean {
 const verification=record.verification;
 return record.origin!=='knowledge'&&!verification||!!verification&&verification.status==='auto-verified'&&verification.deterministic.passed&&verification.faithfulness.score!==null&&verification.faithfulness.score>=verification.faithfulness.threshold;
}

// Publication admission remains upstream. This single query gate is used by search,
// comparison and export for every origin; unknown civic identity never invents a plan.
export function comparisonEligibility(record:QueryRecord):{comparisonEligible:boolean;comparisonReason:string|null} {
 let reason:string|null=null;
 if(!verifiedClaims(record))reason='Verification gates not passed; candidate evidence only';
 else if(record.recordType!=='place'&&!record.eventDate&&!record.documentDate&&!record.stageDate&&!record.stages?.some(stage=>stage.date))reason='Required sourced document/stage/event date unknown';
 else if(record.origin==='knowledge'&&(record.stage==='unknown'||!record.stageQuote?.trim()))reason='Source stage unknown or unsupported';
 else if(record.origin==='regional'&&(!record.stage||record.stage==='unknown'))reason='Source stage unknown or unsupported';
 return {comparisonEligible:reason===null,comparisonReason:reason};
}

/** Regional item.date is not uniformly a milestone date: preserve its source role. */
export function regionalDates(item:{date:string|null;stage:string;sourceType:string;locator:string;participationEnd?:unknown}):Pick<QueryRecord,'eventDate'|'endDate'|'dateSemantics'|'documentDate'|'stageDate'|'stageDateReason'> {
 const publication=/(?:Veröffentlich\w*|veröffentlicht|Publikation\w*|publication)/iu.test(item.locator);
 const participationEnd=typeof item.participationEnd==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(item.participationEnd)?item.participationEnd:null;
 let stageDate:string|null=null;
 if(item.sourceType==='planningProcedure'&&item.stage==='consultation_closed')stageDate=participationEnd;
 else if(!publication&&item.sourceType==='planningProcedure'&&item.stage==='consultation'&&item.date&&item.locator.includes(`publicParticipationStartDate ${item.date}`))stageDate=item.date;
 else if(!publication&&item.sourceType==='councilAgenda'&&item.stage==='agenda')stageDate=item.date;
 else if(!publication&&item.sourceType==='cityWebsite'&&item.stage==='adopted'&&/\bbeschlossen\b/iu.test(item.locator)&&!/\b(?:geplant|offen|vorgesehen|Bekanntmachung|Inkrafttreten)\b/iu.test(item.locator))stageDate=item.date;
 return {eventDate:stageDate??(publication?null:item.date),endDate:participationEnd,dateSemantics:stageDate||!publication&&item.date?'source_event':publication&&item.date?'source_document':'unknown',documentDate:publication?item.date:null,stageDate,stageDateReason:stageDate?null:'The released date is not explicitly bound to this stage; publication and participation-start dates are not substituted.'};
}

/** Only explicitly normalized stage dates may date a milestone, for every origin. */
export function sourceStageDate(record:QueryRecord):string|null {return record.stageDate??null;}
export function hasKnownStage(record:QueryRecord):boolean {
 return Boolean(record.stage&&record.stage!=='unknown')||Boolean(record.stages?.some(stage=>stage.stage!=='unknown'));
}
const normalize=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('de').replace(/\s+/gu,' ').trim();
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
function instruments(text:string,record:QueryRecord):IdentityBasis[] {
 const found:{offset:number;basis:IdentityBasis}[]=[];
 const add=(match:RegExpMatchArray,value:string)=>{
  const suffix=/^[\s,;:–—-]*(\d+)\.\s*(?:Änderung|Aenderung)\b/iu.exec(text.slice((match.index??0)+match[0].length));
  if(/^(?:teil)?fnp:base$/.test(value)&&!suffix)return;
  found.push({offset:match.index??0,basis:{type:'plan_number',value:value+(suffix&&!match[1]?`:amendment:${suffix[1]}`:''),quote:match[0]+(suffix?.[0]??''),recordId:record.id,sourceIds:record.sourceIds}});
 };
 // Instrument and amendment number are part of identity: a numbered FNP amendment
 // is never the B-Plan it accompanies, nor an amendment the original instrument.
 for(const match of text.matchAll(/(?:(\d+)\.\s*(?:Änderung|Aenderung)\s+(?:(?:des|zum|von)\s+)?)?(?:vorhabenbezogen\w*\s+)?(?:Bebauungsplan(?:es|s)?|(?:vB|B)[-\s]?Plan|BP)\s*(?:\([^)]{1,30}\)\s*)?(?:Nr\.?\s*)?(\d+[a-z]?(?:\s*[\/._-]\s*\d+[a-z]?)*)(?![\w/._-])/giu))add(match,`bplan:${normalize(match[2]).replace(/\s/g,'')}${match[1]?`:amendment:${match[1]}`:''}`);
 for(const match of text.matchAll(/(?:(\d+)\.\s*(?:Änderung|Aenderung)\s+(?:(?:des|zum|von)\s+)?)?(?:Teilflächennutzungsplan(?:es|s)?|Flächennutzungsplan(?:es|s)?|FNP)(?:\s+(?:Nr\.?\s*)(\d+(?:\/\d+)?))?/giu))add(match,`${/Teilflächennutzungsplan/i.test(match[0])?'teilfnp':'fnp'}:${match[2]??'base'}${match[1]?`:amendment:${match[1]}`:''}`);
 return found.sort((a,b)=>a.offset-b.offset).map(item=>item.basis);
}
function identities(record:QueryRecord,sources:Map<string,Record<string,unknown>>):CaseIdentity {
 const basis:IdentityBasis[]=[];
 const supported=verifiedClaims(record);
 const title=record.origin==='knowledge'?record.titleQuote??record.title:record.title;
 const authoritative=record.origin==='city'&&record.caseKey&&record.caseQuote?{type:'plan_number' as const,value:`authority:${record.caseKey}`,quote:record.caseQuote,recordId:record.id,sourceIds:record.sourceIds}:null;
 const plans=supported?(authoritative?[authoritative]:instruments(title,record)):[];
 if(supported&&!plans.length&&record.caseQuote)plans.push(...instruments(record.caseQuote,record));
 let instrument=plans[0]??null;
 if(supported&&!instrument&&record.caseKeyType==='plan_number'&&record.caseKey&&record.caseQuote){
  const number=record.caseKey.replace(/^Nr\.?\s*/iu,'');
  // An identifier without a quoted legal instrument remains explicitly untyped.
  instrument={type:'plan_number',value:`untyped:${normalize(number)}`,quote:record.caseQuote,recordId:record.id,sourceIds:record.sourceIds};
 }
 if(instrument)basis.push(instrument);
 for(const sourceId of record.sourceIds){
  const source=sources.get(sourceId);if(!source)continue;
  const url=typeof source.url==='string'?new URL(source.url):null;
  if(url&&/(^|\.)diplanung\.de$/i.test(url.hostname)){
   const path=/^\/(?:verfahren|file)\/([^/]+)/u.exec(url.pathname);
   if(path)basis.push({type:'diplan',value:`${url.hostname.toLowerCase()}:${path[1]}`,quote:source.url as string,recordId:record.id,sourceIds:[sourceId]});
   const procedure=/\bprocedureId=([a-z0-9-]+)/iu.exec(String(source.locator??''));
   if(procedure)basis.push({type:'diplan',value:`${url.hostname.toLowerCase()}:${procedure[1]}`,quote:String(source.locator),recordId:record.id,sourceIds:[sourceId]});
  }
  if(record.origin!=='knowledge'&&record.recordType==='council_paper'){
   const locator=String(source.locator??'');
   const paper=/\b(?:Vorlage(?:nnummer)?|Drucksache|reference)\s*(?:Nr\.?\s*|[:=]\s*)?([A-Z]{0,8}[-/]?\d+(?:[-/]\d+)+)\b/iu.exec(`${record.title}\n${locator}`);
   if(paper)basis.push({type:'paper_reference',value:normalize(paper[1]),quote:paper[0],recordId:record.id,sourceIds:[sourceId]});
  }
 }
 if(supported&&record.caseKey&&record.caseQuote&&['diplan','paper_reference','bobsh'].includes(record.caseKeyType??''))basis.push({type:record.caseKeyType as 'diplan'|'paper_reference'|'bobsh',value:normalize(record.caseKey),quote:record.caseQuote,recordId:record.id,sourceIds:record.sourceIds});
 if(!basis.length)basis.push({type:'record',value:record.id,quote:'No source-backed case identifier; standalone evidence record, not an identified civic case.',recordId:record.id,sourceIds:record.sourceIds});
 return {status:basis[0].type==='record'?'unresolved':'source_identified',basis,instrument,relatedInstruments:plans.slice(1)};
}

// Only explicit identifier overlap joins evidence. Multiple DiPlan paths on the
// same published evidence establish a publication bundle, not legal equivalence.
// Titles alone and generic shared document URLs are deliberately not join keys.
export function assignCaseIdentities(records:QueryRecord[],sources:Map<string,Record<string,unknown>>):void {
 const parents=new Map<string,string>();
 const find=(key:string):string=>{const parent=parents.get(key);if(!parent){parents.set(key,key);return key;}if(parent===key)return key;const root=find(parent);parents.set(key,root);return root;};
 const key=(record:QueryRecord,basis:IdentityBasis)=>`${record.cityId}:${basis.type}:${basis.value}`;
 for(const record of records){
  record.caseIdentity=identities(record,sources);
  const keys=record.caseIdentity.basis.map(basis=>key(record,basis));
  for(const next of keys.slice(1)){const a=find(keys[0]),b=find(next);if(a!==b)parents.set(a<b?b:a,a<b?a:b);}
 }
 for(const record of records)record.caseId=`case:${digest(find(key(record,record.caseIdentity!.basis[0])))}`;
}
export function groupCases(records:QueryRecord[]):QueryRecord[][] {
 const groups=new Map<string,QueryRecord[]>();
 for(const record of records){const key=record.caseId??record.id;const group=groups.get(key);if(group)group.push(record);else groups.set(key,[record]);}
 return [...groups.values()];
}
export type StageClaim={record:QueryRecord;stage:string;date:string|null;quote:string;dateSemantics:string;evidenceBasis:'quoted_claim'|'released_structured_stage'};
export function stageClaims(records:QueryRecord[],asOf:string):StageClaim[] {
 const claims:StageClaim[]=[];
 for(const record of records){
  if(!comparisonEligibility(record).comparisonEligible)continue;
  const date=sourceStageDate(record);
  const quote=record.stageQuote??(record.origin==='regional'?record.statement:'');
  if(record.stage&&quote)claims.push({record,stage:record.stage,date,quote,dateSemantics:date?'source_stage':'unknown',evidenceBasis:record.origin==='knowledge'?'quoted_claim':'released_structured_stage'});
  for(const stage of record.stages??[])if(stage.quote)claims.push({record,stage:stage.stage,date:stage.date,quote:stage.quote,dateSemantics:stage.date?'source_stage':'unknown',evidenceBasis:'quoted_claim'});
 }
 return claims.filter(claim=>(!claim.date||claim.date.slice(0,10)<=asOf.slice(0,10))&&positiveStages.some(stage=>stage===claim.stage));
}
export function furthestMilestone(records:QueryRecord[],asOf:string){
 const claims=stageClaims(records,asOf),stage=[...positiveStages].reverse().find(stage=>claims.some(claim=>claim.stage===stage));
 if(!stage)return null;
 const evidence=claims.filter(claim=>claim.stage===stage).sort((a,b)=>(b.date??'').localeCompare(a.date??'')||a.record.id.localeCompare(b.record.id));
 return {stage,date:evidence[0].date,dateSemantics:evidence[0].dateSemantics,evidenceCount:evidence.length,evidence:evidence.slice(0,5).map(({record,...claim})=>({id:record.id,stage:record.stage,sourceIds:record.sourceIds,milestone:claim})),meaning:'Furthest source-supported milestone as of release, not current status, overall legal completion, or construction; dates retain their source role.'};
}
export function caseEvidence(records:QueryRecord[],asOf:string){
 const first=records[0],eligible=records.filter(record=>comparisonEligibility(record).comparisonEligible);
 const identityBasis=records.flatMap(record=>record.caseIdentity?.basis??[]);
 const instrumentGroups=new Map<string,{identity:IdentityBasis;records:QueryRecord[]}>();
 for(const record of records){const identity=record.caseIdentity?.instrument;if(!identity)continue;const group=instrumentGroups.get(identity.value);if(group)group.records.push(record);else instrumentGroups.set(identity.value,{identity,records:[record]});}
 const milestone=furthestMilestone(records,asOf);
 const procedureLinks=records.flatMap(record=>{
  const procedures=record.caseIdentity?.basis.filter(basis=>basis.type==='diplan')??[];
  return procedures.length>1?[{type:'shared_published_procedure_evidence',recordId:record.id,sourceIds:record.sourceIds,procedures,meaning:'The same released evidence explicitly binds these procedure identifiers/paths; a case bundle, not legal instrument equivalence.'}]:[];
 });
 return {id:first.caseId??first.id,caseId:first.caseId??first.id,cityId:first.cityId,districtId:records.find(record=>record.districtId)?.districtId,title:first.title,memberRecordIds:records.map(record=>record.id).sort(),recordCount:records.length,eligibleRecordIds:eligible.map(record=>record.id).sort(),comparisonEligible:eligible.length>0,comparisonReason:eligible.length?null:'No member record passes the shared comparison eligibility gate',identityStatus:identityBasis.some(basis=>basis.type!=='record')?'source_identified':'unresolved',identityBasis,sourceIds:[...new Set(records.flatMap(record=>record.sourceIds))].sort(),topics:[...new Map(records.flatMap(record=>record.topics).map(topic=>[topic.id,topic])).values()],furthestSupportedStage:milestone?.stage??null,furthestSupportedDate:milestone?.date??null,furthestPositiveMilestone:milestone,instruments:[...instrumentGroups.values()].map(({identity,records})=>({identity,memberRecordIds:records.map(record=>record.id).sort(),furthestPositiveMilestone:furthestMilestone(records,asOf)})),relationships:[...procedureLinks,...records.filter(record=>record.caseIdentity&&record.caseIdentity.relatedInstruments.length).map(record=>({type:'source_mentions_instruments',recordId:record.id,sourceIds:record.sourceIds,instruments:[record.caseIdentity!.instrument,...record.caseIdentity!.relatedInstruments],meaning:'Explicit source co-reference, not legal equivalence or transferred stage.'}))],unknowns:[...(identityBasis.some(basis=>basis.type!=='record')?[]:['Case identity unknown; record-scoped fallback is counted explicitly.']),...(records.some(record=>!record.caseIdentity?.instrument)?['Some member legal instruments are unidentified; their stages are not assigned to another instrument.']:[])]};
}
