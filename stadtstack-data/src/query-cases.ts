import {createHash} from 'node:crypto';
import type {QueryRecord} from './mcp-query.ts';
import type {DistrictKnowledgeRecord} from './district-schema.ts';
import type {CaseIdentity as ScopedCaseIdentity} from './district-case-linking.ts';
import {milestoneRank,normalizeStageAssertion,positiveStages,stageRankingContext,type StageRankingContext,type CanonicalStageDateAssertion} from './planning-stages.ts';
import {areaClaimsFromQuote,resolveMetricSupersession} from './case-supersession.ts';

export type IdentityBasis={type:'plan_number'|'diplan'|'paper_reference'|'bobsh'|'record';value:string;quote:string;recordId:string;sourceIds:string[]};
export type CaseIdentity={status:'source_identified'|'unresolved'|'not_applicable';basis:IdentityBasis[];instrument:IdentityBasis|null;relatedInstruments:IdentityBasis[]} & Partial<ScopedCaseIdentity>;
function verifiedClaims(record:Pick<QueryRecord,'origin'|'verification'|'evidence'>):boolean {
 const verification=record.verification;
 if(verification&&'kind' in verification&&verification.kind==='structured')return verification.status==='auto-verified'&&verification.deterministic.passed&&!!record.evidence?.length;
 return record.origin!=='knowledge'&&!verification||!!verification&&'faithfulness' in verification&&verification.status==='auto-verified'&&verification.deterministic.passed&&verification.faithfulness.score!==null&&verification.faithfulness.score>=verification.faithfulness.threshold;
}

// Publication admission remains upstream. This single query gate is used by search,
// comparison and export for every origin; unknown civic identity never invents a plan.
export function comparisonEligibility(record:QueryRecord):{comparisonEligible:boolean;comparisonReason:string|null} {
 let reason:string|null=null;
 if(!verifiedClaims(record))reason='Verification gates not passed; candidate evidence only';
 else if(record.kind==='structured')return {comparisonEligible:true,comparisonReason:null};
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
 return canonicalRecordStages(record).some(stage=>stage!=='unknown');
}
const normalize=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('de').replace(/\s+/gu,' ').trim();
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
function instruments(text:string,record:Pick<QueryRecord,'id'|'sourceIds'>):IdentityBasis[] {
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
function identities(record:Pick<QueryRecord,'id'|'kind'|'origin'|'verification'|'evidence'|'title'|'titleQuote'|'caseQuote'|'caseKey'|'caseKeyType'|'recordType'|'sourceIds'>,sources:Map<string,Record<string,unknown>>):CaseIdentity {
 // Native assets, entities, statistics, events and procedures are not identified projects.
 // A source-native ID does not justify turning an observation into a civic case.
 if(record.kind==='structured')return {status:'not_applicable',basis:[],instrument:null,relatedInstruments:[]};
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
export function assignCaseIdentities(records:QueryRecord[],sources:Map<string,Record<string,unknown>>,nativeIdentities?:ReadonlyMap<string,ScopedCaseIdentity>):void {
 const parents=new Map<string,string>();
 const find=(key:string):string=>{const parent=parents.get(key);if(!parent){parents.set(key,key);return key;}if(parent===key)return key;const root=find(parent);parents.set(key,root);return root;};
 const key=(record:QueryRecord,basis:IdentityBasis)=>`${record.cityId}:${basis.type}:${basis.value}`;
 for(const record of records){
  record.caseIdentity={...identities(record,sources),...nativeIdentities?.get(record.id),countedProject:false};
  if(record.caseIdentity.status==='not_applicable')continue;
  const keys=record.caseIdentity.basis.map(basis=>key(record,basis));
  for(const next of keys.slice(1)){const a=find(keys[0]),b=find(next);if(a!==b)parents.set(a<b?b:a,a<b?a:b);}
 }
 for(const record of records)if(record.caseIdentity?.status!=='not_applicable')record.caseId=`case:${digest(find(key(record,record.caseIdentity!.basis[0])))}`;
}
export function groupCases(records:QueryRecord[]):QueryRecord[][] {
 const groups=new Map<string,QueryRecord[]>();
 for(const record of records){if(record.caseIdentity?.status==='not_applicable')continue;const key=record.caseId??record.id;const group=groups.get(key);if(group)group.push(record);else groups.set(key,[record]);}
 return [...groups.values()];
}
export type StageClaim={record:QueryRecord;stage:string;date:string|null;quote:string;dateSemantics:string;rankingContext:'baugb'|'civic';evidenceBasis:'quoted_claim'|'released_structured_stage'};
/** Canonical procedure/event grouping is separate from publication-bundle discovery. */
export function scopedCases(records:QueryRecord[],includeDocumentBuckets=false) {
 const groups=new Map<string,QueryRecord[]>();
 for(const record of records){
  const identity=record.caseIdentity;
  if(!identity?.id||!identity.kind||!verifiedClaims(record)||identity.kind==='document_bucket'&&!includeDocumentBuckets)continue;
  const members=groups.get(identity.id);
  if(members)members.push(record);else groups.set(identity.id,[record]);
 }
 return [...groups.values()].map(members=>{
  const identity=members[0].caseIdentity!;
  return {id:identity.id!,kind:identity.kind!,reference:identity.reference??null,ruleVersion:identity.ruleVersion,countedProject:false as const,memberRecordIds:members.map(record=>record.id).sort(),sourceIds:[...new Set(members.flatMap(record=>record.sourceIds))].sort(),evidenceHashes:[...new Set(members.flatMap(record=>record.caseIdentity?.reference?.evidenceHashes??[]))].sort()};
 }).sort((a,b)=>a.id.localeCompare(b.id));
}
/** Shared source-supported metric semantics; native claims require admitted scope/replacement witnesses. */
export function caseMetrics(records:QueryRecord[],asOf:string) {
 return resolveMetricSupersession(records.map(record=>{
  const instrument=record.caseIdentity?.instrument;
  const metricClaims=verifiedClaims(record)?record.metricClaims??(record.kind!=='structured'&&instrument?areaClaimsFromQuote({quote:record.summaryQuote??'',sourceIds:record.sourceIds,scope:instrument.value,scopeQuote:instrument.quote,instrument:instrument.value,reportedAt:record.documentDate??null}):[]):[];
  return {id:record.id,municipalityId:record.cityId,metricClaims};
 }),asOf,records.flatMap(record=>record.caseMetricHistory??record.supersession?.history??[]));
}
/** Shared text publication projector; native changes use the canonical source-native change contract. */
export function knowledgeMetricRecord(record:DistrictKnowledgeRecord) {
 const sourceIds=record.sources.map(source=>source.id);
 const identity=identities({...record,recordType:record.caseType,origin:'knowledge',sourceIds},new Map());
 const instrument=identity.instrument;
 return {id:record.id,municipalityId:record.municipalityId,metricClaims:instrument&&verifiedClaims({origin:'knowledge',verification:record.verification})?areaClaimsFromQuote({quote:record.summaryQuote,sourceIds,scope:instrument.value,scopeQuote:instrument.quote,instrument:instrument.value,reportedAt:record.documentDate}):[]};
}
/** Canonical filter/display label; original stage/status and source dates remain untouched. */
export function canonicalRecordStage(record:QueryRecord,context:StageRankingContext=stageRankingContext({title:record.title,titleQuote:record.titleQuote,caseQuote:record.caseQuote,instrument:record.caseIdentity?.instrument?.value})):string|null {
 if(record.kind==='structured'||!record.stage)return null;
 const quote=record.stageQuote??(record.origin==='regional'?record.locator??record.statement:'');
 return normalizeStageAssertion({stage:record.stage,quote,originalStatus:record.originalStatus},context);
}
/** Stage/date filters bind the same source assertion; top dates are not overwritten by history. */
export function canonicalRecordStageAssertions(record:QueryRecord):CanonicalStageDateAssertion[] {
 if(record.kind==='structured')return [];
 const context=stageRankingContext({title:record.title,titleQuote:record.titleQuote,caseQuote:record.caseQuote,instrument:record.caseIdentity?.instrument?.value}),top=canonicalRecordStage(record,context);
 const assertions=top?[{stage:top,date:sourceStageDate(record)}]:[];
 for(const assertion of record.stages??[])if(assertion.quote)assertions.push({stage:normalizeStageAssertion(assertion,context),date:assertion.date});
 return assertions;
}
export function canonicalRecordStages(record:QueryRecord):string[] {
 return [...new Set(canonicalRecordStageAssertions(record).map(assertion=>assertion.stage))];
}
export function stageClaims(records:QueryRecord[],asOf:string):StageClaim[] {
 const claims:StageClaim[]=[];
 for(const record of records){
  if(!comparisonEligibility(record).comparisonEligible)continue;
  const date=sourceStageDate(record);
  const quote=record.stageQuote??(record.origin==='regional'?record.locator??record.statement:'');
  const rankingContext=stageRankingContext({title:record.title,titleQuote:record.titleQuote,caseQuote:record.caseQuote,instrument:record.caseIdentity?.instrument?.value});
  const stage=canonicalRecordStage(record,rankingContext);
  if(stage&&quote)claims.push({record,stage,date,quote,rankingContext,dateSemantics:date?'source_stage':'unknown',evidenceBasis:record.origin==='knowledge'?'quoted_claim':'released_structured_stage'});
  for(const assertion of record.stages??[])if(assertion.quote)claims.push({record,stage:normalizeStageAssertion(assertion,rankingContext),date:assertion.date,quote:assertion.quote,rankingContext,dateSemantics:assertion.date?'source_stage':'unknown',evidenceBasis:'quoted_claim'});
 }
 return claims.filter(claim=>(!claim.date||claim.date.slice(0,10)<=asOf.slice(0,10))&&positiveStages.some(stage=>stage===claim.stage));
}
export function furthestMilestone(records:QueryRecord[],asOf:string){
 const claims=stageClaims(records,asOf);
 const ranked=claims.map(claim=>({claim,rank:milestoneRank(claim.stage,claim.rankingContext==='baugb')})).filter((entry):entry is {claim:StageClaim;rank:number}=>entry.rank!==null).sort((a,b)=>b.rank-a.rank);
 const stage=ranked[0]?.claim.stage;
 if(!stage)return null;
 const evidence=ranked.filter(entry=>entry.claim.stage===stage).map(entry=>entry.claim).sort((a,b)=>(b.date??'').localeCompare(a.date??'')||a.record.id.localeCompare(b.record.id));
 return {stage,date:evidence[0].date,dateSemantics:evidence[0].dateSemantics,evidenceCount:evidence.length,evidence:evidence.slice(0,5).map(({record,...claim})=>({id:record.id,stage:record.stage,sourceIds:record.sourceIds,milestone:claim})),meaning:'Furthest source-supported milestone as of release, not current status, overall legal completion, or construction; dates retain their source role.'};
}
export function caseEvidence(records:QueryRecord[],asOf:string){
 const first=records[0],eligible=records.filter(record=>comparisonEligibility(record).comparisonEligible);
 const identityBasis=records.flatMap(record=>record.caseIdentity?.basis??[]);
 const instrumentGroups=new Map<string,{identity:IdentityBasis;records:QueryRecord[]}>();
 for(const record of records){const identity=record.caseIdentity?.instrument;if(!identity)continue;const group=instrumentGroups.get(identity.value);if(group)group.records.push(record);else instrumentGroups.set(identity.value,{identity,records:[record]});}
 const milestone=furthestMilestone(records,asOf);
 const metrics=caseMetrics(records,asOf);
 const procedureLinks=records.flatMap(record=>{
  const procedures=record.caseIdentity?.basis.filter(basis=>basis.type==='diplan')??[];
  return procedures.length>1?[{type:'shared_published_procedure_evidence',recordId:record.id,sourceIds:record.sourceIds,procedures,meaning:'The same released evidence explicitly binds these procedure identifiers/paths; a case bundle, not legal instrument equivalence.'}]:[];
 });
 const metricState={currentValues:metrics.currentValues,history:metrics.history,supersession:metrics.relationships,metricEvidenceSourceIds:[...new Set(metrics.history.flatMap(entry=>[...entry.claim.evidence.sourceIds,...entry.claim.scopeEvidence.sourceIds,...(entry.claim.replaces?.evidence.sourceIds??[])]))].sort()};
 return {...metricState,id:first.caseId??first.id,caseId:first.caseId??first.id,cityId:first.cityId,districtId:records.find(record=>record.districtId)?.districtId,title:first.title,memberRecordIds:records.map(record=>record.id).sort(),recordCount:records.length,eligibleRecordIds:eligible.map(record=>record.id).sort(),comparisonEligible:eligible.length>0,comparisonReason:eligible.length?null:'No member record passes the shared comparison eligibility gate',identityStatus:identityBasis.some(basis=>basis.type!=='record')?'source_identified':'unresolved',identityBasis,sourceIds:[...new Set(records.flatMap(record=>record.sourceIds))].sort(),topics:[...new Map(records.flatMap(record=>record.topics).map(topic=>[topic.id,topic])).values()],furthestSupportedStage:milestone?.stage??null,furthestSupportedDate:milestone?.date??null,furthestPositiveMilestone:milestone,instruments:[...instrumentGroups.values()].map(({identity,records})=>({identity,memberRecordIds:records.map(record=>record.id).sort(),furthestPositiveMilestone:furthestMilestone(records,asOf)})),relationships:[...procedureLinks,...records.filter(record=>record.caseIdentity&&record.caseIdentity.relatedInstruments.length).map(record=>({type:'source_mentions_instruments',recordId:record.id,sourceIds:record.sourceIds,instruments:[record.caseIdentity!.instrument,...record.caseIdentity!.relatedInstruments],meaning:'Explicit source co-reference, not legal equivalence or transferred stage.'}))],unknowns:[...(identityBasis.some(basis=>basis.type!=='record')?[]:['Case identity unknown; record-scoped fallback is counted explicitly.']),...(records.some(record=>!record.caseIdentity?.instrument)?['Some member legal instruments are unidentified; their stages are not assigned to another instrument.']:[]),...(metrics.history.some(entry=>entry.status==='unresolved')?['Current metric values are unresolved without an explicit sourced replacement relation; newer documents alone do not supersede prior claims.']:[])]};
}
