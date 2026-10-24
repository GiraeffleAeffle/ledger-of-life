import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {changesSchema,changeEventSchema,diff,knowledgeChangeRecord,knowledgeChanges,validateChanges,retainChanges,changeSnapshotHash,type ChangeRecord,type ExplicitChange} from '../src/changes.ts';
import type {DistrictKnowledgeRecord} from '../src/district-schema.ts';

const at='2026-10-11T00:00:00.000Z',sourceHash='1'.repeat(64),oldHash='2'.repeat(64),newHash='3'.repeat(64);
function knowledge(id:string,evidenceHash=oldHash){
  return {id,municipalityId:'hoppegarten',sources:[{id:'source:plan',url:'https://example.org/plan',sha256:sourceHash}],verification:{evidenceHash,status:'auto-verified',deterministic:{passed:true},faithfulness:{score:1,threshold:0.8}}};
}

test('knowledge additions changes and removals preserve actual evidence/source hashes and explain absence',()=>{
  const old=knowledgeChangeRecord(knowledge('knowledge:old')),revised=knowledgeChangeRecord(knowledge('knowledge:old',newHash));
  const missing=knowledgeChangeRecord(knowledge('knowledge:missing')),added=knowledgeChangeRecord(knowledge('knowledge:added'));
  const feed=diff([old,missing],[revised,added],at);
  assert.equal(feed.schemaVersion,'stadtstack-changes-v2');
  const changed=feed.events.find(event=>event.kind==='changed')!;
  assert.deepEqual(changed.previous,{version:null,evidenceHash:oldHash,sourceHashes:[sourceHash],metricClaims:[]});
  assert.deepEqual(changed.current,{version:null,evidenceHash:newHash,sourceHashes:[sourceHash],metricClaims:[]});
  assert.ok(feed.events.every(event=>event.recordType==='knowledge'&&event.reason.length>0));
  const removed=feed.events.find(event=>event.kind==='removed')!;
  assert.equal(removed.current,null);assert.equal(removed.evidence,null);assert.match(removed.reason,/absence alone does not establish/);
  assert.equal(feed.events.some(event=>event.kind==='withdrawn'||event.kind==='superseded'),false);
  assert.equal(feed.events.find(event=>event.kind==='added')!.previous,null);
  assert.deepEqual(validateChanges(feed,[revised,added]),feed);
  assert.throws(()=>validateChanges(feed,[old,added]),/snapshot does not match/);
  assert.deepEqual(diff([old],[old],at).events,[]);
});

test('explicit withdrawal is separate from disappearance and is not emitted again for unchanged evidence',()=>{
  const old=knowledgeChangeRecord({...knowledge('knowledge:old'),stage:'draft',stageQuote:'Entwurf'});
  const withdrawn=knowledgeChangeRecord({...knowledge('knowledge:old',newHash),stage:'withdrawn',stageQuote:'Der Antrag wird zurückgezogen.',extraction:{inputSha256:sourceHash}});
  const feed=diff([old],[withdrawn],at),event=feed.events.find(event=>event.kind==='withdrawn')!;
  assert.equal(event.previous?.evidenceHash,oldHash);assert.equal(event.current?.evidenceHash,newHash);
  assert.equal(event.evidence?.kind,'text_model');assert.equal(event.evidence?.replacementRecordId,null);
  assert.deepEqual(diff([withdrawn],[withdrawn],at).events,[]);
  assert.deepEqual(diff([withdrawn],[],at).events.map(event=>event.kind),['removed']);
  const unquoted=knowledgeChangeRecord({...knowledge('knowledge:unquoted'),stage:'withdrawn',stageQuote:''});
  const wrongSource=knowledgeChangeRecord({...knowledge('knowledge:wrong'),stage:'withdrawn',stageQuote:'Zurückgezogen.',extraction:{inputSha256:newHash}});
  assert.equal(diff([],[unquoted,wrongSource],at).events.some(event=>event.kind==='withdrawn'),false);
});

test('retained or removed old revisions need explicit replacement evidence for supersession',()=>{
  const old=knowledgeChangeRecord(metricRecord('knowledge:old','Der Geltungsbereich beträgt 68,6 ha.','2024-01-01')),replacement=knowledgeChangeRecord(metricRecord('knowledge:new','Der Geltungsbereich wurde von 68,6 ha auf 41,5 ha reduziert.','2025-08-07'));
  const transition:ExplicitChange={id:old.id,cityId:old.cityId,recordType:'knowledge',...replacement.semanticEvidence[0],targetRevision:'previous'};
  assert.equal(diff([old],[old,replacement],at).events.some(event=>event.kind==='superseded'),false);
  const retained=diff([old],[old,replacement],at,[transition]).events.find(event=>event.kind==='superseded')!;
  assert.deepEqual(retained.previous,old.revision);assert.deepEqual(retained.current,old.revision);
  assert.equal(retained.evidence?.replacementRecordId,replacement.id);
  const absent=diff([old],[replacement],at,[transition]);
  assert.deepEqual(absent.events.filter(event=>event.id===old.id).map(event=>event.kind),['removed','superseded']);
  assert.deepEqual(validateChanges(absent,[replacement]),absent);
  const forged=structuredClone(absent);forged.events.find(event=>event.kind==='superseded')!.previous={...old.revision,evidenceHash:newHash};
  assert.throws(()=>validateChanges(forged,[replacement]),/Previous change revision/);
  assert.throws(()=>diff([old],[old],at,[transition]),/evidence is not bound/);
  assert.throws(()=>diff([old],[old,replacement],at,[{...transition,evidence:{...transition.evidence,sourceHash:newHash}}]),/evidence is not bound/);
  assert.throws(()=>diff([old],[old,replacement],at,[{...transition,evidence:{...transition.evidence,replacementRecordId:old.id}}]));
  assert.equal(changeEventSchema.safeParse({...retained,evidence:null}).success,false);
  assert.equal(changesSchema.safeParse({added:[],changed:[],removed:[],generatedAt:at}).success,false);
});

test('structured knowledge preserves primary/support hashes and native locator identity without quotes',()=>{
  const supportHash='4'.repeat(64),locator={sourceSha256:sourceHash,format:'json' as const,nativeId:'operation-1',path:'$.status',sheet:null,rowKey:null,cells:[],rawValue:'withdrawn',schemaHash:'5'.repeat(64),mappingVersion:'funding-operations-v1'};
  const input={kind:'structured' as const,id:'structured:one',municipalityId:'hoppegarten',source:{url:'https://example.org/native',sha256:sourceHash},supportingSources:[{url:'https://example.org/municipalities',sha256:supportHash}],observation:{kind:'FundingOperation',predicate:'source_status',value:'withdrawn',evidence:[locator]},verification:{evidenceHash:newHash,status:'auto-verified',deterministic:{passed:true},sourceSha256:sourceHash,mappingVersion:locator.mappingVersion,locators:[locator],adapterId:'funding-operations',adapterContractSha256:'6'.repeat(64),policyReceiptSha256:'7'.repeat(64),scopeSha256:'8'.repeat(64)}};
  const record=knowledgeChangeRecord(input),evidence=record.semanticEvidence[0].evidence;
  assert.deepEqual(record.revision.sourceHashes,[sourceHash,supportHash]);
  const feed=diff([],[record],at),event=feed.events.find(event=>event.kind==='withdrawn')!;
  assert.deepEqual(event.evidence,evidence);assert.equal('quote' in event.evidence!,false);
  assert.deepEqual(validateChanges(feed,[record]),feed);
  if(evidence.kind!=='structured')throw Error('Expected native witness');
  for(const patch of [{path:'$.invented'},{rawValue:'approved'},{schemaHash:oldHash},{mappingVersion:'invented-v2'}]){
    const forged={...evidence,locators:[{...locator,...patch}]};
    assert.throws(()=>diff([record],[record],at,[{id:record.id,cityId:record.cityId,recordType:'knowledge',kind:'withdrawn',reason:event.reason,evidence:forged,targetRevision:'current'}]),/admitted semantic witness/);
    const changed=structuredClone(feed);changed.events.find(event=>event.kind==='withdrawn')!.evidence=forged;
    assert.throws(()=>validateChanges(changed,[record]),/admitted semantic witness/);
  }
  assert.equal(changeEventSchema.safeParse({...event,evidence:{...evidence,locators:[{...locator,sourceSha256:supportHash}]}}).success,false);
  const deletion=knowledgeChangeRecord({...input,observation:{...input.observation,kind:'Paper',predicate:'withdrawn',value:true},verification:{...input.verification,adapterId:'council'}});
  assert.equal(diff([],[deletion],at).events.some(event=>event.kind==='withdrawn'),false);
  const mismatched=knowledgeChangeRecord({...input,observation:{...input.observation,evidence:[{...locator,path:'$.other'}]}});
  assert.equal(mismatched.semanticEvidence.length,0);
});

// Minimal synthetic admitted projection: these objects never pass publication gates or enter release files.
function metricRecord(id:string,quote:string,date:string):DistrictKnowledgeRecord{
  return {...knowledge(id),caseType:'planning',caseKey:'B-Plan 68/23',caseKeyType:'plan_number',caseQuote:'Bebauungsplan Nr. 68/23',title:'Bebauungsplan Nr. 68/23',titleQuote:'Bebauungsplan Nr. 68/23',summaryQuote:quote,documentDate:date,extraction:{inputSha256:sourceHash},verification:{evidenceHash:id.endsWith('new')?newHash:oldHash,status:'auto-verified',deterministic:{passed:true},faithfulness:{score:1,threshold:0.8}}} as DistrictKnowledgeRecord;
}

test('publication metric supersession reuses scoped sourced reduction rules and does not replay established transitions',()=>{
  const old=metricRecord('knowledge:old','Der Geltungsbereich beträgt 68,6 ha.','2024-01-01');
  const replacement=metricRecord('knowledge:new','Der Geltungsbereich wurde von 68,6 ha auf 41,5 ha reduziert.','2025-08-07');
  const feed=knowledgeChanges([old],[old,replacement],at),event=feed.events.find(event=>event.kind==='superseded')!;
  assert.ok(event);assert.equal(event.id,old.id);assert.equal(event.previous?.evidenceHash,oldHash);
  assert.equal(event.evidence?.replacementRecordId,replacement.id);assert.match(event.reason,/68.6 ha.*41.5 ha/);
  assert.deepEqual(knowledgeChanges([old,replacement],[old,replacement],at).events,[]);
  const merelyNewer={...replacement,summaryQuote:'Der Geltungsbereich beträgt 41,5 ha.'};
  assert.equal(knowledgeChanges([old],[old,merelyNewer],at).events.some(event=>event.kind==='superseded'),false);
});

test('unchanged v2 snapshots retain authentic prior event state and clocks, not an empty new diff',()=>{
  const old=knowledgeChangeRecord(knowledge('knowledge:old')),current=knowledgeChangeRecord(knowledge('knowledge:old',newHash));
  const feed=diff([old],[current],'2026-10-01T00:00:00.000Z');
  assert.deepEqual(retainChanges(feed,[current]),feed);
  assert.equal(retainChanges(feed,[current]).snapshots[0].generatedAt,'2026-10-01T00:00:00.000Z');
  assert.throws(()=>retainChanges(feed,[old]),/snapshot does not match/);
  const wrongPrevious=structuredClone(feed);wrongPrevious.snapshots[0].previous=sourceHash;
  assert.throws(()=>retainChanges(wrongPrevious,[current]),/Previous change snapshot/);
  assert.equal(changesSchema.safeParse({...feed,snapshots:[...feed.snapshots,...feed.snapshots]}).success,false);
  assert.equal(changeSnapshotHash([old,current]),changeSnapshotHash([current,old]));
});

test('legacy migration requires actual earlier/current signals and matches every original ID and clock',()=>{
  const old:ChangeRecord={...knowledgeChangeRecord(knowledge('signal:old')),recordType:'signal',revision:{version:oldHash,evidenceHash:null,sourceHashes:[sourceHash],metricClaims:[]}};
  const current={...old,revision:{...old.revision,version:newHash}},removed={...old,id:'signal:removed'},added={...current,id:'signal:added'};
  const before=[old,removed],after=[current,added],legacy={added:[added.id],changed:[old.id],removed:[removed.id],generatedAt:'2026-10-01T00:00:00.000Z'};
  const migrated=retainChanges(legacy,after,before);
  assert.equal(migrated.generatedAt,legacy.generatedAt);assert.equal(migrated.snapshots[0].generatedAt,legacy.generatedAt);
  assert.equal(migrated.snapshots[0].previous,changeSnapshotHash(before));assert.equal(migrated.snapshots[0].current,changeSnapshotHash(after));
  assert.equal(migrated.events.find(event=>event.kind==='removed')!.previous?.version,oldHash);
  assert.equal(migrated.events.find(event=>event.kind==='changed')!.current?.version,newHash);
  assert.deepEqual(retainChanges(migrated,after),migrated);
  assert.throws(()=>retainChanges(legacy,after),/authenticated earlier/);
  assert.throws(()=>retainChanges(legacy,after,after),/IDs do not match/);
  assert.throws(()=>retainChanges({...legacy,changed:[]},after,before),/IDs do not match/);
  assert.throws(()=>retainChanges({...legacy,generatedAt:undefined},after,before));
});

test('all-removed and genuinely empty scopes retain explicit snapshot bindings',()=>{
  const old=knowledgeChangeRecord(knowledge('knowledge:old')),scope={cityId:old.cityId,recordType:'knowledge' as const};
  const removed=diff([old],[],at);
  assert.equal(removed.snapshots.length,1);assert.equal(removed.snapshots[0].current,changeSnapshotHash([]));
  assert.deepEqual(retainChanges(removed,[]),removed);
  const empty=diff([],[],at,[],[scope]);
  assert.equal(empty.snapshots.length,1);assert.equal(empty.snapshots[0].previous,changeSnapshotHash([]));
  assert.deepEqual(validateChanges(empty,[]),empty);
  const another={...old,id:'knowledge:other',cityId:'strausberg'};
  const forward=diff([],[another,old],at),reverse=diff([],[old,another],at);
  assert.deepEqual(forward.snapshots,reverse.snapshots);
  assert.equal(changesSchema.safeParse({...removed,snapshots:[]}).success,false);
});

test('existing source URL/hash never authorizes invented text withdrawal, supersession or reasons',()=>{
  const withdrawn=knowledgeChangeRecord({...knowledge('knowledge:withdrawn'),stage:'withdrawn',stageQuote:'Der Antrag wird zurückgezogen.',extraction:{inputSha256:sourceHash}});
  const witness=withdrawn.semanticEvidence[0],explicit:ExplicitChange={id:withdrawn.id,cityId:withdrawn.cityId,recordType:'knowledge',...witness,targetRevision:'current'};
  assert.equal(witness.evidence.kind,'text_model');
  if(witness.evidence.kind!=='text_model')throw Error('Expected text witness');
  const invented={...explicit,evidence:{...witness.evidence,quote:'A fabricated source withdrawal.'}};
  assert.throws(()=>diff([withdrawn],[withdrawn],at,[invented]),/admitted semantic witness/);
  assert.throws(()=>diff([withdrawn],[withdrawn],at,[{...explicit,reason:'The project was implemented.'}]),/admitted semantic witness/);
  const feed=diff([],[withdrawn],at),forged=structuredClone(feed);
  forged.events.find(event=>event.kind==='withdrawn')!.evidence=invented.evidence;
  assert.throws(()=>validateChanges(forged,[withdrawn]),/admitted semantic witness/);
  const ordinary=knowledgeChangeRecord({...knowledge('knowledge:ordinary'),stage:'draft',stageQuote:'Entwurf',extraction:{inputSha256:sourceHash}});
  assert.throws(()=>diff([ordinary],[ordinary],at,[{...invented,id:ordinary.id,evidence:{...invented.evidence,recordId:ordinary.id}}]),/admitted semantic witness/);
  const old=knowledgeChangeRecord(metricRecord('knowledge:old','Der Geltungsbereich beträgt 68,6 ha.','2024-01-01')),replacement=knowledgeChangeRecord(metricRecord('knowledge:new','Der Geltungsbereich wurde von 68,6 ha auf 41,5 ha reduziert.','2025-08-07'));
  const supersession:ExplicitChange={id:old.id,cityId:old.cityId,recordType:'knowledge',...replacement.semanticEvidence[0],targetRevision:'current'};
  if(supersession.evidence.kind!=='text_model')throw Error('Expected text witness');
  const inventedSupersession={...supersession,evidence:{...supersession.evidence,quote:'The newer record supersedes everything.'}};
  assert.throws(()=>diff([old],[old,replacement],at,[inventedSupersession]),/admitted semantic witness/);
});

test('an admitted withdrawal witness cannot be retargeted to another record in the same city',()=>{
  const withdrawn=knowledgeChangeRecord({...knowledge('knowledge:withdrawn'),stage:'withdrawn',stageQuote:'Der Antrag wird zurückgezogen.',extraction:{inputSha256:sourceHash}});
  const unrelated=knowledgeChangeRecord(knowledge('knowledge:budget'));
  const forged:ExplicitChange={id:unrelated.id,cityId:unrelated.cityId,recordType:'knowledge',...withdrawn.semanticEvidence[0],targetRevision:'current'};
  assert.throws(()=>diff([withdrawn,unrelated],[withdrawn,unrelated],at,[forged]),/Withdrawal target/);
  const feed=diff([unrelated],[withdrawn,unrelated],at),event=feed.events.find(event=>event.kind==='withdrawn')!;
  event.id=unrelated.id;event.previous=unrelated.revision;event.current=unrelated.revision;
  assert.throws(()=>validateChanges(feed,[withdrawn,unrelated]),/Withdrawal target/);
});

test('an admitted reduction cannot supersede an unrelated record, instrument, scope or metric',()=>{
  const old=knowledgeChangeRecord(metricRecord('knowledge:old','Der Geltungsbereich beträgt 68,6 ha.','2024-01-01'));
  const replacement=knowledgeChangeRecord(metricRecord('knowledge:new','Der Geltungsbereich wurde von 68,6 ha auf 41,5 ha reduziert.','2025-08-07'));
  const budget=knowledgeChangeRecord(knowledge('knowledge:budget'));
  const anotherInstrument=knowledgeChangeRecord({...metricRecord('knowledge:foreign','Der Geltungsbereich beträgt 68,6 ha.','2024-01-01'),title:'10. Änderung des Flächennutzungsplans',titleQuote:'10. Änderung des Flächennutzungsplans',caseQuote:'10. Änderung des Flächennutzungsplans'});
  const targets=[budget,anotherInstrument,...[{scope:'other-project'},{instrument:'fnp:base:amendment:10'},{metric:'project_capacity'},{unit:'MWp'},{value:67},{reportedAt:'2025-09-01'}].map(patch=>({...old,id:'knowledge:other',revision:{...old.revision,metricClaims:old.revision.metricClaims.map(claim=>({...claim,...patch}))}}))];
  for(const target of targets){
    const transition:ExplicitChange={id:target.id,cityId:target.cityId,recordType:'knowledge',...replacement.semanticEvidence[0],targetRevision:'previous'};
    assert.throws(()=>diff([target],[target,replacement],at,[transition]),/Supersession target/);
    assert.throws(()=>diff([target],[replacement],at,[transition]),/Supersession target/);
  }
  const transition:ExplicitChange={id:old.id,cityId:old.cityId,recordType:'knowledge',...replacement.semanticEvidence[0],targetRevision:'previous'};
  const removed=diff([old],[replacement],at,[transition]);
  assert.deepEqual(validateChanges(removed,[replacement]),removed);
  const forged=structuredClone(removed),event=forged.events.find(event=>event.kind==='superseded')!;
  event.previous={...event.previous!,metricClaims:budget.revision.metricClaims};
  assert.throws(()=>validateChanges(forged,[replacement]),/Supersession target/);
});

test('frozen Solarpark correction fixture preserves the actual baseline hash but is not a new admission',async()=>{
  const fixture=JSON.parse(await readFile(new URL('../reports/correction-solarpark-0.3.2.json',import.meta.url),'utf8'));
  const historical=JSON.parse(await readFile(new URL('../out/knowledge/records.json',import.meta.url),'utf8')) as {records:DistrictKnowledgeRecord[]};
  const previous=historical.records.find(record=>record.id===fixture.baseline.recordId);
  assert.ok(previous);
  assert.equal(previous.verification.evidenceHash,fixture.baseline.evidenceHash);
  assert.equal(knowledgeChangeRecord(previous).revision.evidenceHash,fixture.acceptance.get_changes.previousEvidenceHash);
  assert.ok(previous.sources.some(source=>source.url===fixture.baseline.sourceUrl&&source.sha256===fixture.baseline.sourceSha256));
  assert.equal(fixture.replacementEvidence.value,41.5);
  assert.equal(fixture.acceptance.get_changes.replacementSelector.sourceSha256,fixture.replacementEvidence.expectedRetainedSourceSha256);
  assert.match(fixture.replacementEvidence.admission,/actual passing extraction/);
  // Expectations/private excerpts are not a passing new claim or an invented replacement record ID.
  assert.deepEqual(knowledgeChanges([previous],[previous],at).events,[]);
});

test('same-ID re-extraction supersedes the explicitly selected current metric without rewriting its previous revision',()=>{
  const before=metricRecord('knowledge:old','Der Entwurf beschreibt einen Solarpark.','2024-01-01');
  const revised={...before,summaryQuote:'Der Geltungsbereich beträgt 68,6 ha.',verification:{...before.verification,evidenceHash:'9'.repeat(64)}};
  const replacement=metricRecord('knowledge:new','Der Geltungsbereich wurde von 68,6 ha auf 41,5 ha reduziert.','2025-08-07');
  const feed=knowledgeChanges([before],[revised,replacement],at),event=feed.events.find(event=>event.kind==='superseded')!;
  assert.ok(event);assert.equal(event.targetRevision,'current');
  assert.equal(event.previous?.evidenceHash,before.verification.evidenceHash);
  assert.deepEqual(event.previous?.metricClaims,[]);
  assert.equal(event.current?.evidenceHash,revised.verification.evidenceHash);
  assert.equal(event.current?.metricClaims[0].value,68.6);
  const records=[revised,replacement].map(knowledgeChangeRecord);
  assert.deepEqual(validateChanges(feed,records),feed);
  assert.deepEqual(retainChanges(feed,records),feed);
  const wrongRevision=structuredClone(feed);wrongRevision.events.find(event=>event.kind==='superseded')!.targetRevision='previous';
  assert.throws(()=>validateChanges(wrongRevision,records),/Supersession target/);
  const transition:ExplicitChange={id:event.id,cityId:event.cityId,recordType:event.recordType,kind:'superseded',reason:event.reason,evidence:event.evidence!,targetRevision:'previous'};
  assert.throws(()=>diff([knowledgeChangeRecord(before)],records,at,[transition]),/Supersession target/);
  assert.deepEqual(knowledgeChanges([revised,replacement],[revised,replacement],at).events,[]);
});
