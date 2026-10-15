import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {bankSchema,digest,prepareValueAssessment,ingestValueAssessments,summarize,type Report,type Review,type EvaluationRow} from '../src/evaluate-pilot-value.ts';
import {assessmentItemSchema,assessmentOutputSchema,ownerAudit,type AssessmentItem} from '../src/district-assessment.ts';
import {admittedAssessmentFixture,syntheticAssessmentTriplet} from './district-assessment.fixture.ts';
import {buildPilotAuditPacket,computeFrozenVerdict,ingestPilotOwnerAudit,auditPacketMarkdown,auditReportHash,
  validatePilotAuditPacket,FROZEN_R1_INPUTS,type AuditAssessmentEntry,type PilotAuditPacket} from '../src/pilot-value-audit.ts';
import {Step8ExceptionInventorySchema,inventoryExceptionItems,type Step8ExceptionBundle} from '../src/r1-release-acceptance.ts';
import {bindReleaseExceptionContext,type CandidateMaterialContext} from '../src/r1-release-context.ts';

const bank=bankSchema.parse(JSON.parse(await readFile(new URL('../evaluation/pilot-questions.json',import.meta.url),'utf8')));
const quote='Der Haushaltsplan nennt geplante Auszahlungen von 10 Euro; ein Zahlungsnachweis fehlt.';
const rubric='Synthetic audit fixture: frozen 0/1/2 scoring, never a real value assessment.';
function review(index:number):Review{
  const kind=[0,1,4,5,6,8,9,10].includes(index)?'substantive':index<22?'partial':'abstention';
  return {answer:'Synthetic fixture answer distinguishes a budget plan from an actual payment.',kind,
    citations:[{recordId:'record:fixture',sourceId:'source:fixture',url:'https://example.org/assessment-fixture.txt',quote}],
    correctness:{score:2,rationale:'Synthetic fixture preserves the original evidence role.'},
    sourcing:{score:index>=23?0:2,rationale:'Synthetic fixture has explicit bound original attribution.'},
    usefulness:{score:kind==='substantive'?2:kind==='partial'?1:0,rationale:'Synthetic scoring only, not practitioner validation.'},
    data_missing:kind!=='substantive',missing:kind==='substantive'?[]:['Synthetic missing evidence role'],
    limitations:['Synthetic data and provider receipts only; not independent gold.'],graphContribution:'Synthetic graph comparison at exactly the same release.'};
}
function rebound(report:Report,packet:PilotAuditPacket){
  // Synthetic gate-unit mutations are not claimed to be provider assessments.
  const value=structuredClone(packet);value.reportSha256=auditReportHash(report);
  const {packetSha256:ignored,...body}=value;value.packetSha256=digest(body);return value;
}
function replaceReview(report:Report,index:number,transform:(review:Review)=>Review,lane:'withoutGraph'|'withGraph'='withoutGraph'){
  const result=structuredClone(report),row=result.evaluations[index];
  row.review![lane]=transform(row.review![lane]!);
  row.review!.assessment!.lanes[lane]!.reviewSha256=digest(row.review![lane]);
  result.summary=summarize(result.evaluations);return result;
}

test('owner packet, frozen gates and audit binding use synthetic original-backed A/B/C only',async t=>{
  const admitted=await admittedAssessmentFixture(quote);
  try{
    const source={id:'source:fixture',registrySourceId:'source1',url:admitted.policy.source.url,sha256:admitted.source.originalSha256};
    const record={id:'record:fixture',sourceIds:['source:fixture'],statement:quote};
    const rows:EvaluationRow[]=bank.questions.map(question=>{
      const row:EvaluationRow={question,recordIds:[record.id],callIds:[],retrievalComplete:true,
        graph:{available:!!question.graphDependent,callIds:[],recordIds:[],bounded:false},review:null,evidenceSha256:''};
      row.evidenceSha256=digest({question,records:[record],sources:[source],retrievalComplete:true,graph:row.graph,graphResponses:[]});return row;
    });
    const report:Report={schemaVersion:'pilot-value-evaluation-v1',status:'awaiting_review',generatedAt:'2026-10-15T00:00:00Z',
      questionBankSha256:FROZEN_R1_INPUTS.questionBankSha256,evaluatorSha256:'a'.repeat(64),server:{root:'/synthetic',gitCommit:'b'.repeat(40),
        sourceSha256:'c'.repeat(64),sourceFiles:[],releaseId:'d'.repeat(64),toolCount:20,tools:[],transport:'stdio',protocol:'synthetic-only'},
      method:{grading:rubric},releaseStatus:{},coverage:null,records:{[record.id]:record},sources:{[source.id]:source},calls:[],evaluations:rows};
    const entries:AuditAssessmentEntry[]=[];
    for(const [index,row] of rows.entries())for(const lane of row.question.graphDependent?['withoutGraph','withGraph'] as const:['withoutGraph'] as const){
      const item=prepareValueAssessment(report,assessmentItemSchema.parse({version:'assessment-item-v1',itemId:row.question.id,question:row.question.question,
        claim:'Synthetic budget-plan claim only',rubric,rubricSha256:createHash('sha256').update(rubric).digest('hex'),
        sources:[admitted.source],claimIds:['claim:fixture'],entityIds:[],constraints:[],criticalKinds:['stage','finance','identity']}),lane);
      const answer=review(index);
      if(lane==='withGraph'&&['E03','B03'].includes(row.question.id))answer.usefulness.score=2;
      const output=assessmentOutputSchema.parse({itemId:row.question.id,outcome:answer.kind==='abstention'?'abstain':'supported',
        assertions:[{claimId:'claim:fixture',sourceId:source.id,locatorId:'page1',quote,subjectId:null,objectId:null,unit:'EUR',value:'10',date:null,dateRole:null,
          financialRole:'plan',stage:'planned',modality:'planned'}],scores:{correctness:answer.correctness.score,sources:answer.sourcing.score,usefulness:answer.usefulness.score},
        holdReasons:[],rationale:'Synthetic original-bound audit fixture, no model or network call.',valueReview:answer});
      entries.push({item,...await syntheticAssessmentTriplet(item,output,admitted.context)});
    }
    const finalized=await ingestValueAssessments(report,entries,undefined,admitted.context);
    const packet=await buildPilotAuditPacket(finalized,entries,'precommitted-synthetic-seed',admitted.context);
    await t.test('sample is reproducible, stratified and includes all 37 answer units',async()=>{
      const again=await buildPilotAuditPacket(finalized,[...entries].reverse(),packet.seed,admitted.context);
      assert.deepEqual(again,packet);
      assert.equal(packet.items.filter(item=>item.risk==='routine').length,37);
      assert.ok(packet.sample.selected.some(item=>item.risk==='routine'));
      assert.ok(packet.sample.selected.some(item=>item.risk==='critical_finance'));
      assert.ok(packet.sample.selected.every(item=>item.inclusionProbability>0&&item.inclusionProbability<=1));
      assert.ok(packet.sample.plannedMinutes<=120);
      const text=auditPacketMarkdown(packet);
      assert.match(text,/Original excerpts/);assert.match(text,/A\/B\/C outcomes/);assert.match(text,/MCP attribution/);
      assert.match(text,/not independent gold/);assert.match(text,/excerptSha256/);
      assert.notEqual(ownerAudit(packet.sample.frame,'different-seed').frameSha256,'');
      await assert.rejects(buildPilotAuditPacket(finalized,entries.slice(1),packet.seed,admitted.context),/all thirty|every established/);
    });
    await t.test('exact R1 boundary passes with post-release sample audit pending',()=>{
      const verdict=computeFrozenVerdict(finalized,packet);
      assert.equal(verdict.verdict,'pass');assert.equal(verdict.pending_owner_audit,true);
      assert.equal(verdict.gates.usefulness.actual,30);assert.equal(verdict.gates.completeAnswers.actual,8);
      assert.equal(verdict.gates.sources.actual,46);assert.equal(verdict.gates.correctness.actual,60);
      assert.equal(verdict.gates.graphPairs.actual,7);assert.equal(verdict.gates.graphPairs.gain,2);
    });
    await t.test('each numerical failure blocks and graph correctness losses cannot be offset',()=>{
      const cases:[number,(review:Review)=>Review,'withoutGraph'|'withGraph',string][]=[
        [0,r=>({...r,usefulness:{...r.usefulness,score:1}}),'withoutGraph','usefulness'],
        [0,r=>({...r,kind:'partial',data_missing:true,missing:['fixture gap']}),'withoutGraph','completeAnswers'],
        [0,r=>({...r,correctness:{...r.correctness,score:1}}),'withoutGraph','correctness'],
        [0,r=>({...r,sourcing:{...r.sourcing,score:1}}),'withoutGraph','sources'],
        [rows.findIndex(row=>row.question.id==='E03'),r=>({...r,usefulness:{...r.usefulness,score:1}}),'withGraph','graphPairs'],
        [rows.findIndex(row=>row.question.id==='W03'),r=>({...r,correctness:{...r.correctness,score:1}}),'withGraph','graphPairs'],
      ];
      for(const [index,change,lane,gate] of cases){
        const changed=replaceReview(finalized,index,change,lane),verdict=computeFrozenVerdict(changed,rebound(changed,packet));
        assert.equal(verdict.verdict,'fail');assert.ok(verdict.blockingReasons.includes('gate_failed:'+gate));
      }
    });
    await t.test('wrong report, source excerpt, seed and owner packet identities are rejected',()=>{
      assert.throws(()=>validatePilotAuditPacket({...finalized,server:{...finalized.server,releaseId:'other'}},packet),/binding|identity/);
      const changed=structuredClone(packet);changed.seed='tampered';
      assert.throws(()=>validatePilotAuditPacket(finalized,changed),/binding/);
      assert.throws(()=>ingestPilotOwnerAudit(finalized,packet,{version:'pilot-value-owner-checks-v1',releaseId:packet.releaseId,packetSha256:'0'.repeat(64),checks:[]}),/identity/);
      const duplicate=structuredClone(finalized);duplicate.evaluations[29]=duplicate.evaluations[0];duplicate.summary=summarize(duplicate.evaluations);
      assert.throws(()=>computeFrozenVerdict(duplicate,rebound(duplicate,packet)),/Frozen questions/);
      const incomplete=structuredClone(finalized);incomplete.status='awaiting_review';
      assert.throws(()=>computeFrozenVerdict(incomplete,rebound(incomplete,packet)),/Finalize/);
    });
    await t.test('actual checked IDs, findings, blockers and minutes bind to packet and release',()=>{
      const checks=packet.sample.selected.map(item=>({itemId:item.itemId,evidenceSha256:item.evidenceSha256,minutes:10,
        findings:'Synthetic owner check, not a real human audit.',reviewer:'synthetic-owner',verdict:'pass' as const,blockers:[]}));
      const input={version:'pilot-value-owner-checks-v1',releaseId:packet.releaseId,packetSha256:packet.packetSha256,checks};
      const audited=ingestPilotOwnerAudit(finalized,packet,input);
      assert.equal(auditReportHash(audited),auditReportHash(finalized));
      assert.equal(computeFrozenVerdict(audited,packet).pending_owner_audit,false);
      assert.equal(computeFrozenVerdict(audited,packet).verdict,'pass');
      assert.throws(()=>ingestPilotOwnerAudit(audited,packet,input),/overwrite/);
      assert.throws(()=>ingestPilotOwnerAudit(finalized,packet,{...input,checks:[...checks,checks[0]]}),/Duplicate/);
      assert.throws(()=>ingestPilotOwnerAudit(finalized,packet,{...input,checks:[{...checks[0],evidenceSha256:'0'.repeat(64)}]}),/binding/);
      const failed=ingestPilotOwnerAudit(finalized,packet,{...input,checks:checks.map((check,index)=>index?check:{...check,verdict:'fail',blockers:['unsupported payment']})});
      assert.equal(computeFrozenVerdict(failed,packet).verdict,'fail');
      const over=ingestPilotOwnerAudit(finalized,packet,{...input,checks:checks.map(check=>({...check,minutes:121}))});
      assert.equal(computeFrozenVerdict(over,packet).gates.ownerWorkload.pass,false);
    });
    await t.test('all unresolved and rights exceptions remain blocking under option B; excess budget never truncates',async()=>{
      const sourceItem=assessmentItemSchema.parse(entries[0].item);
      const exceptions:AuditAssessmentEntry[]=[];
      for(let index=0;index<5;index++){
        const {valueTarget:ignored,...base}=sourceItem;
        const item:AssessmentItem=assessmentItemSchema.parse({...base,itemId:'exception:'+index,claim:'Unresolved synthetic critical evidence',criticalKinds:['identity']});
        const output=assessmentOutputSchema.parse({itemId:item.itemId,outcome:'unresolved',assertions:[],scores:{correctness:0,sources:0,usefulness:0},
          holdReasons:[index===0?'rights':'disagreement'],rationale:'Unresolved synthetic exception, never an admitted claim.'});
        exceptions.push({item,...await syntheticAssessmentTriplet(item,output,admitted.context),exceptionMinutes:10});
      }
      const blocked=await buildPilotAuditPacket(finalized,[...entries,...exceptions],packet.seed,admitted.context);
      assert.equal(blocked.sample.exceptions.length,5);assert.equal(blocked.sample.withinGate,false);
      assert.equal(blocked.sample.exceptions.filter(item=>item.exception==='rights').length,1);
      const verdict=computeFrozenVerdict(finalized,blocked);
      assert.equal(verdict.verdict,'fail');assert.equal(verdict.pending_owner_audit,false);
      assert.equal(verdict.gates.unresolvedCriticalAndRights.actual,5);
      assert.ok(verdict.blockingReasons.includes('owner_packet_exceeds_80_sample_40_exception_120_total_minutes'));
    });
    await t.test('noncritical excluded A/B/C quality holds remain explicit known gaps',async()=>{
      const {valueTarget:ignored,...base}=assessmentItemSchema.parse(entries[0].item);
      const item=assessmentItemSchema.parse({...base,itemId:'noncritical-quality-gap',criticalKinds:[]});
      const output=assessmentOutputSchema.parse({itemId:item.itemId,outcome:'abstain',assertions:[],scores:{correctness:2,sources:0,usefulness:0},
        holdReasons:['insufficient_evidence'],rationale:'Synthetic excluded noncritical quality gap, not a final claim.'});
      const packetWithGap=await buildPilotAuditPacket(finalized,[...entries,{item,...await syntheticAssessmentTriplet(item,output,admitted.context)}],packet.seed,admitted.context);
      assert.equal(packetWithGap.items.filter(item=>item.validationDisposition==='known_gap').length,1);
      assert.equal(computeFrozenVerdict(finalized,packetWithGap).verdict,'pass');
    });
    await t.test('owner packet includes non-A/B/C step8 inventory exceptions and cannot defer them',async()=>{
      const pin={path:'/synthetic/pinned-input.json',sha256:'e'.repeat(64)};
      const inventory=Step8ExceptionInventorySchema.parse({schemaVersion:'stadtstack-r1-step8-exceptions-v1',releaseId:finalized.server.releaseId,campaign:pin,complete:true,
        sourceDispositions:[{municipalityId:'synthetic',sourceId:'source1',documentId:'document:held',sourceSha256:'f'.repeat(64),jobKey:'b'.repeat(64),
          admittedRecordIds:[],cases:[{reason:'rights_pending'}],classification:{critical:false,rights:true,disagreement:false},assessments:[],
          terminalDocumentException:{reasonCode:'policy_excluded'},queueEvidence:{stepReceipts:[{receipt:{jobKey:'b'.repeat(64),step:'residual_prepare',outcome:'blocked_policy',reasonCode:'policy_excluded'}}]}}],
        native:{coverage:[],fieldHolds:{unpublishedObservations:0,counts:{contact_field:0}}},preparation:{publicationQuarantine:{schemaVersion:'stadtstack-publication-quarantine-v1',records:[]},
          criticalHolds:[],classification:{critical:false,rights:false,disagreement:false}},assessments:[]});
      const candidateContext:CandidateMaterialContext={manifestSha256:'1'.repeat(64),ids:[],sourceHashes:[],sourceUrls:[],sourceScopes:['synthetic\nsource1'],materialBlockers:[]};
      const step8:Step8ExceptionBundle={version:'r1-step8-exception-bundle-v1',releaseId:finalized.server.releaseId,manifestSha256:'1'.repeat(64),
        pins:{gate:pin,exceptions:pin,handoff:pin},inventory,candidateContext,items:bindReleaseExceptionContext(inventoryExceptionItems(inventory),candidateContext,inventory.sourceDispositions)};
      const withInventory=await buildPilotAuditPacket(finalized,entries,packet.seed,admitted.context,step8);
      assert.ok(withInventory.step8?.items.length);assert.ok(withInventory.sample.exceptions.every(item=>item.itemId.startsWith('step8:')));
      assert.match(auditPacketMarkdown(withInventory),/Step-8 exception inventory/);
      assert.match(auditPacketMarkdown(withInventory),/policy_excluded/);
      const verdict=computeFrozenVerdict(finalized,withInventory);
      assert.equal(verdict.verdict,'fail');assert.equal(verdict.pending_owner_audit,false);
      assert.equal(verdict.manifestSha256,step8.manifestSha256);
      const required=[...new Map([...withInventory.sample.selected,...withInventory.sample.exceptions].map(item=>[item.itemId,item])).values()];
      const checked=ingestPilotOwnerAudit(finalized,withInventory,{version:'pilot-value-owner-checks-v1',releaseId:withInventory.releaseId,packetSha256:withInventory.packetSha256,
        checks:required.map(item=>({itemId:item.itemId,evidenceSha256:item.evidenceSha256,minutes:1,findings:'Synthetic check; no waiver of unresolved policy.',reviewer:'synthetic-owner',verdict:'pass',blockers:[]}))});
      assert.equal(computeFrozenVerdict(checked,withInventory).verdict,'fail');
      const excludedContext={...candidateContext,sourceScopes:[]};
      const excludedStep8={...step8,candidateContext:excludedContext,items:bindReleaseExceptionContext(inventoryExceptionItems(inventory),excludedContext,inventory.sourceDispositions)};
      const excludedPacket=await buildPilotAuditPacket(finalized,entries,packet.seed,admitted.context,excludedStep8);
      assert.ok(excludedPacket.step8!.items.every(item=>item.classification==='known_gap'&&item.ownerAuditPriority==='high'&&!item.blocking));
      assert.equal(excludedPacket.sample.exceptions.length,0);assert.ok(excludedPacket.sample.plannedMinutes<=80);
      assert.ok(excludedPacket.sample.frame.some(item=>item.itemId.startsWith('step8:')));
      const excludedVerdict=computeFrozenVerdict(finalized,excludedPacket);
      assert.equal(excludedVerdict.verdict,'pass');assert.equal(excludedVerdict.pending_owner_audit,true);
      assert.match(auditPacketMarkdown(excludedPacket),/r1-option-b-candidate-scope-v1/);
      const {valueTarget:ignored,...base}=assessmentItemSchema.parse(entries[0].item);
      const item=assessmentItemSchema.parse({...base,itemId:'excluded:critical',criticalKinds:['identity']});
      const output=assessmentOutputSchema.parse({itemId:item.itemId,outcome:'unresolved',assertions:[],scores:{correctness:0,sources:0,usefulness:0},
        holdReasons:['disagreement'],rationale:'Synthetic excluded critical disagreement, not a candidate member.'});
      const extendedInventory=Step8ExceptionInventorySchema.parse({...inventory,sourceDispositions:inventory.sourceDispositions.map(source=>({...source,
        cases:[...source.cases,{reason:'assessment_held',candidate:{id:item.itemId}}],classification:{critical:true,rights:true,disagreement:true}}))});
      const extendedStep8={...excludedStep8,inventory:extendedInventory,items:bindReleaseExceptionContext(inventoryExceptionItems(extendedInventory),excludedContext,extendedInventory.sourceDispositions)};
      const extendedPacket=await buildPilotAuditPacket(finalized,[...entries,{item,...await syntheticAssessmentTriplet(item,output,admitted.context)}],packet.seed,admitted.context,extendedStep8);
      assert.ok(extendedPacket.items.some(row=>row.assessmentItem.itemId===item.itemId&&row.ownerAuditPriority==='high'&&row.validationDisposition==='known_gap'));
      assert.equal(computeFrozenVerdict(finalized,extendedPacket).verdict,'pass');
    });
  }finally{await rm(admitted.directory,{recursive:true,force:true});}
});
