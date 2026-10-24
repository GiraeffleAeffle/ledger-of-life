import {z} from 'zod';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Signal} from './schema.ts';
import type {DistrictKnowledgeRecord} from './district-schema.ts';
import {knowledgeMetricRecord} from './query-cases.ts';
import {resolveMetricSupersession,MetricClaimSchema} from './case-supersession.ts';
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const recordType=z.enum(['signal','knowledge']);
export const changeRevisionSchema=z.object({
  version:hash.nullable(),evidenceHash:hash.nullable(),sourceHashes:z.array(hash),metricClaims:z.array(MetricClaimSchema),
}).strict().refine(value=>value.version!==null||value.evidenceHash!==null,'A revision needs its published version or evidence hash');
const evidenceBinding={recordId:z.string().min(1),sourceUrl:z.url(),sourceHash:hash,replacementRecordId:z.string().min(1).nullable()};
// Native witnesses retain their own source and mapping identity, not an invented prose quote.
const nativeLocator=z.object({
  sourceSha256:hash,format:z.enum(['json','xml','csv','xls','xlsx','html','gtfs']),
  nativeId:z.string().min(1),path:z.string().min(1),sheet:z.string().nullable(),rowKey:z.string().nullable(),
  cells:z.array(z.string()),rawValue:z.union([z.string(),z.number(),z.boolean(),z.null()]),
  schemaHash:hash,mappingVersion:z.string().min(1),
}).strict();
export const changeEvidenceSchema=z.discriminatedUnion('kind',[
  z.object({...evidenceBinding,kind:z.literal('text_model'),quote:z.string().min(1).max(1800)}).strict(),
  z.object({...evidenceBinding,kind:z.literal('structured'),locators:z.array(nativeLocator).min(1),
    adapterId:z.string().min(1),adapterContractSha256:hash,policyReceiptSha256:hash,scopeSha256:hash}).strict(),
]).superRefine((value,ctx)=>{
  if(value.kind==='structured'&&value.locators.some(locator=>locator.sourceSha256!==value.sourceHash))
    ctx.addIssue({code:'custom',message:'Native change evidence must retain its own source hash'});
});
export const changeEventSchema=z.object({
  id:z.string().min(1),cityId:z.string().min(1),recordType,
  kind:z.enum(['added','changed','removed','withdrawn','superseded']),reason:z.string().min(1),
  previous:changeRevisionSchema.nullable(),current:changeRevisionSchema.nullable(),
  evidence:changeEvidenceSchema.nullable(),targetRevision:z.enum(['previous','current']).nullable(),
}).strict().superRefine((event,ctx)=>{
  const fail=(message:string)=>ctx.addIssue({code:'custom',message});
  if(event.previous===null&&event.current===null)fail('Change must reference a published revision');
  if(event.kind==='added'&&(event.previous!==null||event.current===null))fail('Addition requires only the current revision');
  if(event.kind==='removed'&&(event.previous===null||event.current!==null))fail('Removal requires only the previous revision');
  if(event.kind==='changed'&&(event.previous===null||event.current===null))fail('Change requires both revisions');
  if(event.kind==='withdrawn'||event.kind==='superseded'){
    if(!event.evidence)fail('Semantic transitions require explicit source evidence');
    if(event.targetRevision===null||event[event.targetRevision]===null)fail('Semantic transition requires its explicitly selected target revision');
    if(event.kind==='withdrawn'&&event.targetRevision!=='current')fail('Withdrawal must target the current admitted assertion');
    if(event.kind==='superseded'&&(!event.evidence?.replacementRecordId||event.evidence.replacementRecordId===event.id))fail('Supersession requires a distinct replacement');
    if(event.kind==='withdrawn'&&event.evidence?.replacementRecordId!==null)fail('Withdrawal is not supersession');
  }else if(event.evidence!==null||event.targetRevision!==null)fail('Publication-only changes do not assert a source transition');
});
export const changeSnapshotSchema=z.object({
  cityId:z.string().min(1),recordType,previous:hash,current:hash,generatedAt:z.iso.datetime(),
}).strict();
export type ChangeScope={cityId:string;recordType:'signal'|'knowledge'};
export const changesSchema=z.object({
  schemaVersion:z.literal('stadtstack-changes-v2'),generatedAt:z.iso.datetime(),snapshots:z.array(changeSnapshotSchema),events:z.array(changeEventSchema),
}).strict().superRefine((feed,ctx)=>{
  const seen=new Set<string>(),publicationEvents=new Set<string>();
  const scopes=new Set<string>();
  for(const snapshot of feed.snapshots){
    const scope=JSON.stringify([snapshot.cityId,snapshot.recordType]);
    if(scopes.has(scope))ctx.addIssue({code:'custom',message:'Duplicate change snapshot scope'});
    scopes.add(scope);
  }
  for(const event of feed.events){
    if(!scopes.has(JSON.stringify([event.cityId,event.recordType])))ctx.addIssue({code:'custom',message:'Change event lacks its snapshot scope'});
    const key=JSON.stringify([event.cityId,event.recordType,event.id,event.kind,event.evidence]);
    if(seen.has(key))ctx.addIssue({code:'custom',message:'Duplicate change event'});
    seen.add(key);
    if(event.kind==='added'||event.kind==='changed'||event.kind==='removed'){
      const identity=JSON.stringify([event.cityId,event.recordType,event.id]);
      if(publicationEvents.has(identity))ctx.addIssue({code:'custom',message:'Conflicting publication change events'});
      publicationEvents.add(identity);
    }
  }
});
export type Changes=z.infer<typeof changesSchema>;
export type ChangeEvent=z.infer<typeof changeEventSchema>;
export type ChangeEvidence=z.infer<typeof changeEvidenceSchema>;
export type ChangeRevision=z.infer<typeof changeRevisionSchema>;
type Source={url:string;sha256:string|null};
export type ChangeRecord={
  id:string;cityId:string;recordType:'signal'|'knowledge';revision:ChangeRevision;sources:readonly Source[];
  semanticEvidence:readonly {kind:'withdrawn'|'superseded';reason:string;evidence:ChangeEvidence}[];
};
export type ExplicitChange=Pick<ChangeEvent,'id'|'cityId'|'recordType'|'reason'>&{
  kind:'withdrawn'|'superseded';evidence:ChangeEvidence;targetRevision:'previous'|'current';
};
type KnowledgeChangeBase={id:string;municipalityId:string;verification:{evidenceHash:string;status?:string;deterministic?:{passed:boolean};faithfulness?:{score:number|null;threshold:number}}};
type NativeLocator=z.infer<typeof nativeLocator>;
type KnowledgeChangeInput=DistrictKnowledgeRecord|KnowledgeChangeBase&(
  {sources:readonly Source[];stage?:string;stageQuote?:string;extraction?:{inputSha256:string}}|
  {kind:'structured';source:Source;supportingSources:readonly Source[];
    observation?:{kind:string;predicate:string;value:unknown;evidence:readonly NativeLocator[]};
    verification:KnowledgeChangeBase['verification']&{adapterId?:string;adapterContractSha256?:string;sourceSha256?:string;mappingVersion?:string;policyReceiptSha256?:string;scopeSha256?:string;locators?:readonly NativeLocator[]}}
);
const sourceHashes=(sources:readonly Source[])=>[...new Set(sources.flatMap(source=>source.sha256===null?[]:[source.sha256]))].sort();
export function signalChangeRecord(signal:Signal):ChangeRecord {
  const record=signal.properties;
  return {id:record.id,cityId:record.cityId,recordType:'signal',revision:{version:record.version,evidenceHash:null,sourceHashes:sourceHashes(record.sources),metricClaims:[]},sources:record.sources,semanticEvidence:[]};
}
/** Uses the admitted evidence hash, never a model receipt rewritten for feed purposes. */
export function knowledgeChangeRecord(record:KnowledgeChangeInput):ChangeRecord {
  const sources='sources' in record?record.sources:[record.source,...record.supportingSources];
  const metricClaims='summaryQuote' in record?knowledgeMetricRecord(record).metricClaims.map(claim=>MetricClaimSchema.parse(claim)):[];
  const semanticEvidence:ChangeRecord['semanticEvidence'][number][]=[],result:ChangeRecord={id:record.id,cityId:record.municipalityId,recordType:'knowledge',revision:{version:null,evidenceHash:record.verification.evidenceHash,sourceHashes:sourceHashes(sources),metricClaims},sources,semanticEvidence};
  const verified=record.verification.status==='auto-verified'&&record.verification.deterministic?.passed;
  if('sources' in record){
    const faithful=verified&&record.verification.faithfulness?.score!==null&&record.verification.faithfulness?.score!==undefined&&record.verification.faithfulness.score>=record.verification.faithfulness.threshold;
    const source=record.extraction?sources.find(source=>source.sha256===record.extraction?.inputSha256):undefined;
    if(faithful&&source?.sha256){
      if(record.stage==='withdrawn'&&record.stageQuote?.trim())semanticEvidence.push({
        kind:'withdrawn',reason:'The source explicitly states withdrawal.',
        evidence:{kind:'text_model',recordId:record.id,sourceUrl:source.url,sourceHash:source.sha256,quote:record.stageQuote,replacementRecordId:null},
      });
      for(const claim of metricClaims){
        if(!claim.replaces?.evidence.quote||!claim.reportedAt)continue;
        semanticEvidence.push({
          kind:'superseded',reason:`The source explicitly replaces ${claim.metric} ${claim.replaces.value} ${claim.unit} with ${claim.value} ${claim.unit} for ${claim.scope} (${claim.reportedAt}).`,
          evidence:{kind:'text_model',recordId:record.id,sourceUrl:source.url,sourceHash:source.sha256,quote:claim.replaces.evidence.quote,replacementRecordId:record.id},
        });
      }
    }
  }else{
    const observation=record.observation,proof=record.verification;
    // Council deleted=true is a source-record tombstone, not withdrawal of a civic proposal.
    // Only this existing admitted funding mapping supplies native withdrawal semantics.
    if(verified&&observation?.kind==='FundingOperation'&&observation.predicate==='source_status'&&observation.value==='withdrawn'&&proof.adapterId==='funding-operations'&&proof.sourceSha256===record.source.sha256&&proof.adapterContractSha256&&proof.policyReceiptSha256&&proof.scopeSha256&&proof.locators?.length&&isDeepStrictEqual(proof.locators,observation.evidence)&&proof.locators.every(locator=>locator.sourceSha256===proof.sourceSha256&&locator.mappingVersion===proof.mappingVersion)){
      semanticEvidence.push({
        kind:'withdrawn',reason:'The admitted funding source explicitly records withdrawal.',
        evidence:changeEvidenceSchema.parse({kind:'structured',recordId:record.id,sourceUrl:record.source.url,sourceHash:record.source.sha256,replacementRecordId:null,locators:proof.locators,adapterId:proof.adapterId,adapterContractSha256:proof.adapterContractSha256,policyReceiptSha256:proof.policyReceiptSha256,scopeSha256:proof.scopeSha256}),
      });
    }
  }
  return result;
}
const recordKey=(record:Pick<ChangeRecord,'id'|'cityId'|'recordType'>)=>JSON.stringify([record.cityId,record.recordType,record.id]);
function assertSemanticEvidence(transition:Pick<ChangeEvent,'id'|'cityId'|'kind'|'reason'|'evidence'>,record:ChangeRecord|undefined,target:ChangeRevision|null,asOf:string):void{
  if(!record||!record.semanticEvidence.some(witness=>witness.kind===transition.kind&&witness.reason===transition.reason&&isDeepStrictEqual(witness.evidence,transition.evidence)))throw Error('Change transition does not match an admitted semantic witness');
  if(transition.kind==='withdrawn'&&transition.id!==record.id)throw Error('Withdrawal target differs from its admitted assertion');
  if(transition.kind==='superseded'){
    const evidence=transition.evidence;
    if(!target||!evidence||evidence.kind!=='text_model'||evidence.replacementRecordId!==record.id)throw Error('Supersession target lacks an admitted replacement relationship');
    const relationships=resolveMetricSupersession([
      {id:transition.id,municipalityId:transition.cityId,metricClaims:target.metricClaims},
      {id:record.id,municipalityId:record.cityId,metricClaims:record.revision.metricClaims},
    ],asOf).relationships;
    if(!relationships.some(relation=>relation.recordId===transition.id&&relation.replacementRecordId===record.id&&relation.evidence.quote===evidence.quote))throw Error('Supersession target does not match the admitted metric, instrument, scope and time');
  }
}
function recordMap(records:readonly ChangeRecord[]):Map<string,ChangeRecord>{
  const result=new Map<string,ChangeRecord>();
  for(const record of records){
    const key=recordKey(record);
    if(result.has(key))throw Error('Duplicate change record');
    changeRevisionSchema.parse(record.revision);
    result.set(key,record);
  }
  return result;
}
const sameRevision=(left:ChangeRevision,right:ChangeRevision)=>left.version===right.version&&left.evidenceHash===right.evidenceHash&&left.sourceHashes.length===right.sourceHashes.length&&left.sourceHashes.every((hash,index)=>hash===right.sourceHashes[index])&&isDeepStrictEqual(left.metricClaims,right.metricClaims);
type RevisionRecord=Pick<ChangeRecord,'id'|'cityId'|'recordType'|'revision'>;
/** Snapshot identity is the canonical record/revision set, not source bytes or JSON formatting. */
export function changeSnapshotHash(records:readonly RevisionRecord[]):string{
  const rows=records.map(record=>JSON.stringify([record.cityId,record.recordType,record.id,record.revision.version,record.revision.evidenceHash,[...record.revision.sourceHashes].sort(),record.revision.metricClaims.map(claim=>MetricClaimSchema.parse(claim))])).sort();
  return createHash('sha256').update('['+rows.join(',')+']').digest('hex');
}
function snapshotGroups(records:readonly RevisionRecord[]):Map<string,{scope:ChangeScope;records:RevisionRecord[]}>{
  const groups=new Map<string,{scope:ChangeScope;records:RevisionRecord[]}>();
  for(const record of records){
    const key=JSON.stringify([record.cityId,record.recordType]);
    let group=groups.get(key);
    if(!group){group={scope:{cityId:record.cityId,recordType:record.recordType},records:[]};groups.set(key,group);}
    group.records.push(record);
  }
  return groups;
}
/** Validates the feed against the exact current records admitted by its data manifest. */
export function validateChanges(input:unknown,current:readonly ChangeRecord[]):Changes{
  const feed=changesSchema.parse(input),records=recordMap(current),groups=snapshotGroups(current);
  const previous=new Map<string,RevisionRecord>(records);
  for(const snapshot of feed.snapshots){
    const key=JSON.stringify([snapshot.cityId,snapshot.recordType]),group=groups.get(key);
    if(changeSnapshotHash(group?.records??[])!==snapshot.current)throw Error('Current change snapshot does not match publication');
    groups.delete(key);
  }
  if(groups.size)throw Error('Published records lack their change snapshot scope');
  for(const event of feed.events){
    const record=records.get(recordKey(event));
    if(event.current===null){
      if(record)throw Error('Absent change revision is still published');
    }else if(!record||!sameRevision(event.current,record.revision))throw Error('Current change revision does not match publication');
    if(event.evidence){
      const evidence=event.evidence,evidenceRecord=records.get(recordKey({...event,id:evidence.recordId}));
      if(!evidenceRecord?.sources.some(source=>source.url===evidence.sourceUrl&&source.sha256===evidence.sourceHash))throw Error('Change evidence is not bound to a current published source');
      const snapshot=feed.snapshots.find(snapshot=>snapshot.cityId===event.cityId&&snapshot.recordType===event.recordType)!;
      assertSemanticEvidence(event,evidenceRecord,event.targetRevision===null?null:event[event.targetRevision],snapshot.generatedAt);
      if(event.kind==='superseded'&&!records.has(recordKey({...event,id:evidence.replacementRecordId??''})))throw Error('Superseding record is not in the current publication');
    }
    if(event.kind==='added')previous.delete(recordKey(event));
    else if((event.kind==='changed'||event.kind==='removed')&&event.previous)previous.set(recordKey(event),{id:event.id,cityId:event.cityId,recordType:event.recordType,revision:event.previous});
  }
  for(const event of feed.events){
    const revision=previous.get(recordKey(event))?.revision??null;
    if(revision===null?event.previous!==null:event.previous===null||!sameRevision(revision,event.previous))throw Error('Previous change revision does not match snapshot');
  }
  const oldGroups=snapshotGroups([...previous.values()]);
  for(const snapshot of feed.snapshots){
    const key=JSON.stringify([snapshot.cityId,snapshot.recordType]);
    if(changeSnapshotHash(oldGroups.get(key)?.records??[])!==snapshot.previous)throw Error('Previous change snapshot does not match event revisions');
  }
  return feed;
}
/** Missing publication rows mean removal only, never source withdrawal or supersession. */
export function diff(previous:readonly ChangeRecord[],current:readonly ChangeRecord[],generatedAt:string,explicit:readonly ExplicitChange[]=[],scopes:readonly ChangeScope[]=[]):Changes{
  const before=recordMap(previous),after=recordMap(current),events:ChangeEvent[]=[];
  const transitions=[...explicit];
  for(const [key,record] of after){
    const old=before.get(key);
    if(!old||!sameRevision(old.revision,record.revision))events.push({
      id:record.id,cityId:record.cityId,recordType:record.recordType,kind:old?'changed':'added',
      reason:old?'Published revision changed.':'Record entered the published collection.',
      previous:old?.revision??null,current:record.revision,evidence:null,targetRevision:null,
    });
    for(const witness of record.semanticEvidence)if(witness.kind==='withdrawn'&&!old?.semanticEvidence.some(previous=>isDeepStrictEqual(previous,witness))){
      const transition:ExplicitChange={id:record.id,cityId:record.cityId,recordType:record.recordType,...witness,targetRevision:'current'};
      if(!transitions.some(existing=>isDeepStrictEqual(existing,transition)))transitions.push(transition);
    }
  }
  for(const [key,record] of before)if(!after.has(key))events.push({
    id:record.id,cityId:record.cityId,recordType:record.recordType,kind:'removed',
    reason:'Record is absent from this publication; absence alone does not establish source withdrawal or supersession.',
    previous:record.revision,current:null,evidence:null,targetRevision:null,
  });
  for(const transition of transitions){
    const key=recordKey(transition),old=before.get(key),record=after.get(key);
    if(!old&&!record)throw Error('Transition target is not a published record');
    const evidenceRecord=after.get(recordKey({...transition,id:transition.evidence.recordId}));
    if(!evidenceRecord?.sources.some(source=>source.url===transition.evidence.sourceUrl&&source.sha256===transition.evidence.sourceHash))throw Error('Change evidence is not bound to a current published source');
    const target=transition.targetRevision==='previous'?old?.revision:record?.revision;
    assertSemanticEvidence(transition,evidenceRecord,target??null,generatedAt);
    if(transition.kind==='superseded'&&!after.has(recordKey({...transition,id:transition.evidence.replacementRecordId??''})))throw Error('Superseding record is not in the current publication');
    events.push({...transition,previous:old?.revision??null,current:record?.revision??null});
  }
  events.sort((a,b)=>a.cityId.localeCompare(b.cityId)||a.recordType.localeCompare(b.recordType)||a.id.localeCompare(b.id)||a.kind.localeCompare(b.kind));
  const oldGroups=snapshotGroups(previous),newGroups=snapshotGroups(current),allScopes=new Map<string,ChangeScope>();
  for(const {scope} of [...oldGroups.values(),...newGroups.values()])allScopes.set(JSON.stringify([scope.cityId,scope.recordType]),scope);
  for(const scope of scopes)allScopes.set(JSON.stringify([scope.cityId,scope.recordType]),scope);
  const snapshots=[...allScopes].sort(([a],[b])=>a.localeCompare(b)).map(([key,scope])=>({
    ...scope,previous:changeSnapshotHash(oldGroups.get(key)?.records??[]),current:changeSnapshotHash(newGroups.get(key)?.records??[]),generatedAt,
  }));
  return changesSchema.parse({schemaVersion:'stadtstack-changes-v2',generatedAt,snapshots,events});
}
/** Retain authenticated history for an unchanged snapshot; v1 needs its authentic earlier records. No I/O or guessed revisions. */
export function retainChanges(input:unknown,current:readonly ChangeRecord[],legacyPrevious?:readonly ChangeRecord[],scopes:readonly ChangeScope[]=[]):Changes{
  if(typeof input==='object'&&input!==null&&'schemaVersion' in input){
    const feed=validateChanges(input,current);
    if(scopes.length){
      const expected=scopes.map(scope=>JSON.stringify([scope.cityId,scope.recordType])).sort(),actual=feed.snapshots.map(scope=>JSON.stringify([scope.cityId,scope.recordType])).sort();
      if(JSON.stringify(expected)!==JSON.stringify(actual))throw Error('Retained change snapshot scope mismatch');
    }
    return feed;
  }
  const legacy=z.object({added:z.array(z.string()),changed:z.array(z.string()),removed:z.array(z.string()),generatedAt:z.iso.datetime()}).strict().parse(input);
  if(legacyPrevious===undefined)throw Error('Legacy changes require the authenticated earlier signal snapshot');
  if([...legacyPrevious,...current,...scopes].some(record=>record.recordType!=='signal')||new Set([...legacyPrevious,...current,...scopes].map(record=>record.cityId)).size!==1)throw Error('Legacy changes require exactly one signal city scope');
  const reconstructed=diff(legacyPrevious,current,legacy.generatedAt,[],scopes);
  for(const kind of ['added','changed','removed'] as const){
    const expected=[...legacy[kind]].sort(),actual=reconstructed.events.filter(event=>event.kind===kind).map(event=>event.id).sort();
    if(JSON.stringify(expected)!==JSON.stringify(actual))throw Error('Legacy change IDs do not match the authenticated snapshots');
  }
  return reconstructed;
}
/** Publication adapter for admitted text knowledge; structured producers use the same diff/ExplicitChange contract. */
export function knowledgeChanges(previous:readonly DistrictKnowledgeRecord[],current:readonly DistrictKnowledgeRecord[],generatedAt:string,scopes:readonly ChangeScope[]=[]):Changes{
  const oldMetrics=previous.map(knowledgeMetricRecord),currentMetrics=current.map(knowledgeMetricRecord);
  const existing=new Set(resolveMetricSupersession(oldMetrics,generatedAt).relationships.map(relation=>JSON.stringify(relation)));
  const combined=new Map(oldMetrics.map(record=>[record.id,record]));
  for(const record of currentMetrics)combined.set(record.id,record);
  const currentChanges=current.map(knowledgeChangeRecord),changeRecords=new Map(currentChanges.map(record=>[record.id,record]));
  const records=new Map(current.map(record=>[record.id,record])),explicit:ExplicitChange[]=[];
  for(const relation of resolveMetricSupersession([...combined.values()],generatedAt).relationships){
    if(existing.has(JSON.stringify(relation)))continue;
    const replacement=records.get(relation.replacementRecordId);
    if(!replacement)continue;
    const source=replacement.sources.find(source=>relation.evidence.sourceIds.includes(source.id)&&source.sha256===replacement.extraction.inputSha256);
    if(!source||!relation.evidence.quote)throw Error('Text metric supersession evidence lacks its admitted source binding or quote');
    const evidence:ChangeEvidence={kind:'text_model',recordId:replacement.id,sourceUrl:source.url,sourceHash:source.sha256,quote:relation.evidence.quote,replacementRecordId:replacement.id};
    const witness=changeRecords.get(replacement.id)!.semanticEvidence.find(witness=>witness.kind==='superseded'&&isDeepStrictEqual(witness.evidence,evidence));
    if(!witness)throw Error('Metric supersession does not match an admitted semantic witness');
    const transition:ExplicitChange={id:relation.recordId,cityId:replacement.municipalityId,recordType:'knowledge',kind:'superseded',reason:witness.reason,evidence,targetRevision:records.has(relation.recordId)?'current':'previous'};
    const duplicate=explicit.find(event=>event.id===transition.id&&event.cityId===transition.cityId&&JSON.stringify(event.evidence)===JSON.stringify(transition.evidence));
    if(duplicate&&duplicate.reason!==transition.reason)throw Error('Ambiguous metric transition witness');
    if(!duplicate)explicit.push(transition);
  }
  return diff(previous.map(knowledgeChangeRecord),currentChanges,generatedAt,explicit,scopes);
}
