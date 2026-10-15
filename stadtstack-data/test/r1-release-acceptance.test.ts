import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {computeReleaseAcceptance,classifyReleaseException,inventoryExceptionItems,loadStep8ExceptionBundle,
  OPTION_B_APPROVAL_SHA256,Step8ExceptionInventorySchema,runReleaseAcceptance} from '../src/r1-release-acceptance.ts';
import {dataReleaseId} from '../src/data-release.ts';
import {FROZEN_R1_INPUTS} from '../src/pilot-value-audit.ts';
import {classifyStep8Exception} from '../src/r1-step8-governance.ts';
import {RELEASE_ACCEPTANCE_RULES} from '../src/r1-release-context.ts';
const hash=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const h='a'.repeat(64),b='b'.repeat(64);
const requiredChecks=['exact campaign membership','complete exception inventory','atomic generation ownership','native contributor custody','authenticated source exports','quality','coverage','critical assessments','identity admissions','current policy','every manifest member','exact manifest bytes and ID','vm_candidate loader'];
async function fixture(contributingSource='website',sourceSha256='c'.repeat(64)){
  const root=await mkdtemp(join(tmpdir(),'r1-release-acceptance-'));
  const save=async(name:string,value:unknown)=>{const path=join(root,name),bytes=JSON.stringify(value)+'\n';await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes,{mode:0o600});return {path,sha256:hash(bytes)};};
  const candidateDirectory=join(root,'candidate'),files=[];
  for(const path of ['catalogue.json','quality-report.json','core/strausberg-facts.json','core/release-manifest.json','core/handover-draft.json','regions/brandenburg-mol/topics.json','knowledge/registry.json','knowledge/records.json','knowledge/coverage.json','knowledge/graph.json','knowledge/changes.json','knowledge/publication-inputs.json','knowledge/assessment-admissions.json']){
    const value=path==='knowledge/records.json'?{records:[{id:'admitted:fixture',municipalityId:'synthetic-town',
      source:{id:contributingSource,url:contributingSource==='website'?'https://example.invalid/retained':'https://other.invalid/retained',sha256:sourceSha256},verification:{status:'auto-verified'}}]}
      :path==='knowledge/registry.json'?{municipalities:[{id:'synthetic-town',sources:[{id:'website',url:'https://example.invalid/'}]}]}:{};
    const pin=await save('candidate/'+path,value),bytes=(await readFile(pin.path)).length;files.push({path,sha256:pin.sha256,bytes});
  }
  const manifest={schemaVersion:'stadtstack-data-release-v1',id:dataReleaseId(files),generatedAt:'2026-10-15T12:00:00Z',files,quality:{publishedRecords:1,quarantinedRecords:0,cities:1}};
  const manifestPin=await save('candidate/release-manifest.json',manifest),comparison={releaseId:manifest.id,manifestSha256:manifestPin.sha256,files};
  const campaign=await save('campaign.json',{schemaVersion:'stadtstack-r1-step8-campaign-v1',sources:[{municipalityId:'synthetic-town',sourceId:'website',corpus:{path:'/synthetic/corpus',sha256:h},documents:[{documentId:'document:fixture',sha256:h,jobKey:b}]}]});
  const casRoot=join(root,'cas');
  const receipt={schemaVersion:'stadtstack-offline-replay-v2',expectedRelease:manifestPin,casRoot};
  const receiptPin=await save('replay-receipt.json',receipt);
  const proof={schemaVersion:'stadtstack-offline-replay-proof-v2',execution:{modelCalls:0,readinessCalls:0,liveFallback:'forbidden'},comparison};
  const persistReplay=async()=>{
    const proofPin=await save('replay-proof.json',proof),storageKey=`sha256/${proofPin.sha256.slice(0,2)}/${proofPin.sha256}`;
    await mkdir(dirname(join(casRoot,storageKey)),{recursive:true});await writeFile(join(casRoot,storageKey),await readFile(proofPin.path));
    const audit={schemaVersion:'district-replay-proof-audit-v1',receiptSha256:receiptPin.sha256,comparison,artifacts:[{path:'proof.json',sha256:proofPin.sha256,storageKey}]};
    const auditPin=await save('replay-audit.json',audit),auditPath=join(casRoot,'sha256',auditPin.sha256.slice(0,2),auditPin.sha256);
    await mkdir(dirname(auditPath),{recursive:true});await writeFile(auditPath,await readFile(auditPin.path));return auditPin;
  };
  const inventory=Step8ExceptionInventorySchema.parse({schemaVersion:'stadtstack-r1-step8-exceptions-v1',releaseId:manifest.id,campaign,complete:true,
    sourceDispositions:[{municipalityId:'synthetic-town',sourceId:'website',documentId:'document:fixture',sourceSha256:h,jobKey:b,admittedRecordIds:['admitted:fixture'],cases:[],classification:{critical:false,rights:false,disagreement:false},assessments:[],queueEvidence:{stepReceipts:[{receipt:{jobKey:b,step:'residual_extract',outcome:'succeeded',reasonCode:'completed'}}]}}],
    native:{coverage:[],fieldHolds:{schemaVersion:'district-r1-native-field-holds-v1',basis:'actual_committed_output_pages',unpublishedObservations:0,counts:{narrative_requires_text_model:0,source_literal_exceeds_short_quote:0,contact_field:0}}},
    preparation:{publicationQuarantine:{schemaVersion:'stadtstack-publication-quarantine-v1',records:[]},criticalHolds:[],classification:{critical:false,rights:false,disagreement:false}},assessments:[]});
  const gateState={status:'passed',checks:[...requiredChecks]};
  const value={version:'pilot-value-r1-verdict-v1',releaseId:manifest.id,manifestSha256:manifestPin.sha256,reportSha256:h,packetSha256:b,
    frozenInputs:FROZEN_R1_INPUTS,verdict:'pass',blockingReasons:[] as string[],pending_owner_audit:true,ownerAuditPolicy:'option_B_post_release_sample_only',
    gates:{questions:{actual:30,reviewed:30,denominator:30,pass:true},usefulness:{actual:30,minimum:30,denominator:60,lane:'withoutGraph',pass:true},
      completeAnswers:{actual:8,minimum:8,pass:true},correctness:{actual:60,required:60,denominator:60,pass:true},sources:{actual:46,minimum:46,denominator:60,pass:true},
      graphPairs:{actual:7,required:7,minimumGain:2,gain:2,correctnessLosses:0,pass:true,pairs:['W03','W04','E03','B03','K03','M03','H03'].map((id,index)=>({id,reviewed:true,usefulnessWithout:1,usefulnessWith:index<2?2:1,gain:index<2?1:0,correctnessWithout:2,correctnessWith:2}))},
      unresolvedCriticalAndRights:{actual:0,required:0,pass:true},ownerWorkload:{plannedMinutes:80,maximumMinutes:120,pass:true},ownerFindings:{blockingFindings:[] as string[],pass:true}}};
  const seal=async()=>{
    const exceptions=await save('exception-inventory.json',inventory),assessmentManifest=await save('assessments.json',[]);
    const handoff=await save('step9-handoff.json',{schemaVersion:'stadtstack-r1-step9-handoff-v1',releaseId:manifest.id,candidateDirectory,exceptionInventory:exceptions,assessmentManifest,policy:{}});
    const audit=await persistReplay();
    const gate=await save('release-gate.json',{schemaVersion:'stadtstack-r1-step8-gate-v1',...gateState,releaseId:manifest.id,manifestSha256:manifestPin.sha256,candidateDirectory,campaign,
      exceptionInventory:exceptions,step9Handoff:handoff,replayReceipt:receiptPin,replayAuditSha256:audit.sha256,generationNonce:'synthetic-generation'});
    const step8={gate,exceptions,handoff};
    const valueVerdict=await save('value-verdict.json',{...value,step8});
    return {step8,valueVerdict,ownerApproval:{path:new URL('../reports/approvals/r1-autonomy-and-release-2026-10-14.json',import.meta.url).pathname,sha256:OPTION_B_APPROVAL_SHA256}};
  };
  return {root,save,seal,inventory,value,gateState,proof,manifest,manifestPin};
}

test('whole release acceptance is immutable-input bound and option B defers only sample audit',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  const selected=await f.seal(),result=await computeReleaseAcceptance(selected);
  assert.equal(result.accepted,true);assert.deepEqual(result.blockers,[]);assert.equal(result.pending_owner_audit,true);
  assert.equal(result.ownerReviewed,false);assert.equal(result.independentlyValidated,false);assert.equal(result.manifestSha256,f.manifestPin.sha256);
  assert.deepEqual(result.exceptionRuleSet,RELEASE_ACCEPTANCE_RULES);
  assert.deepEqual(await computeReleaseAcceptance(selected),result);
  const changed={...selected,step8:{...selected.step8,exceptions:{...selected.step8.exceptions,sha256:'0'.repeat(64)}}};
  await assert.rejects(computeReleaseAcceptance(changed),/hash mismatch/);
  await assert.rejects(loadStep8ExceptionBundle(selected.step8,'0'.repeat(64)),/another release/);
});

test('passed technical gates never override candidate-affecting risks, unknown cases or applicable source policy',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  const source=f.inventory.sourceDispositions[0];
  for(const reason of ['rights_pending','assessment_held','legal_decision_required','novel_unclassified_hold','terminal_document_exception:unrecognized_code']){
    source.cases=[{reason,candidate:{id:'admitted:fixture'}}];source.classification=classifyStep8Exception(source.cases);
    const decision=await computeReleaseAcceptance(await f.seal());
    assert.equal(decision.accepted,false,reason);assert.equal(decision.pending_owner_audit,false);
    assert.ok(decision.blockers.some(blocker=>blocker.startsWith('exception:')),reason);
  }
  source.cases=[{reason:'no_supported_case'}];source.classification=classifyStep8Exception(source.cases);source.admittedRecordIds=[];
  assert.equal((await computeReleaseAcceptance(await f.seal())).accepted,true);
  source.terminalDocumentException={reasonCode:'policy_excluded'};
  assert.equal((await computeReleaseAcceptance(await f.seal())).accepted,false);
});

test('current selected A/B/C admission distinguishes superseded assessment jobs from unresolved cases',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  const source=f.inventory.sourceDispositions[0];
  source.cases=[{reason:'terminal_assessment_exception:quality_failed'}];
  source.classification=classifyStep8Exception(source.cases);
  source.terminalAssessmentExceptions=[{recordIds:['admitted:fixture'],reasonCode:'quality_failed',step:'assessment_reconcile'}];
  assert.equal((await computeReleaseAcceptance(await f.seal())).accepted,false);
  source.assessments=[{recordId:'admitted:fixture',pins:{itemArtifactSha256:h,AArtifactSha256:h,BArtifactSha256:h,CArtifactSha256:h,finalArtifactSha256:h}}];
  const items=inventoryExceptionItems(f.inventory);
  assert.ok(items.every(item=>!item.blocking));assert.ok(items.some(item=>item.classification==='superseded_assessment'));
  assert.equal((await computeReleaseAcceptance(await f.seal())).accepted,true);
  source.terminalAssessmentExceptions=[{recordIds:['admitted:fixture'],reasonCode:'policy_excluded',step:'assessment_reconcile'}];
  assert.equal((await computeReleaseAcceptance(await f.seal())).accepted,false);
});

test('frozen value failure, altered graph gain, missing technical checks and nonexact replay all block',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  f.value.verdict='fail';assert.ok((await computeReleaseAcceptance(await f.seal())).blockers.includes('frozen_value_gate_not_passed'));
  f.value.verdict='pass';f.value.gates.graphPairs.pairs[0].gain=2;
  assert.equal((await computeReleaseAcceptance(await f.seal())).accepted,false);
  f.value.gates.graphPairs.pairs[0].gain=1;f.gateState.checks=[];
  assert.ok((await computeReleaseAcceptance(await f.seal())).blockers.includes('technical_gate_checks_incomplete'));
  f.gateState.checks=[...requiredChecks];f.proof.execution.modelCalls=1;
  assert.ok((await computeReleaseAcceptance(await f.seal())).blockers.includes('exact_replay_not_passed'));
  f.proof.execution.modelCalls=0;f.inventory.complete=false;
  assert.ok((await computeReleaseAcceptance(await f.seal())).blockers.includes('exception_inventory_incomplete'));
});

test('a withheld record actually present in candidate and native unknown observations cannot pass',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  f.inventory.preparation.publicationQuarantine.records=[{recordId:'admitted:fixture',reason:'assessment_held'}];
  f.inventory.preparation.classification=classifyStep8Exception(f.inventory.preparation.publicationQuarantine);
  const decision=await computeReleaseAcceptance(await f.seal());
  assert.ok(decision.exceptionItems.some(item=>item.blocking&&item.candidateAffected));
  f.inventory.preparation.publicationQuarantine.records=[];f.inventory.preparation.classification=classifyStep8Exception([]);
  f.inventory.native.fieldHolds.unpublishedObservations=1;
  assert.ok((await computeReleaseAcceptance(await f.seal())).blockers.some(blocker=>blocker.startsWith('exception:unknown:')));
  f.inventory.native.fieldHolds.counts={contact_field:1};
  assert.equal((await computeReleaseAcceptance(await f.seal())).accepted,true);
});

test('current held_quality extraction is a known gap, not a negative or a blanket blocker',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  const source=f.inventory.sourceDispositions[0];
  source.cases=[{reason:'no_supported_case'}];source.classification=classifyStep8Exception(source.cases);source.admittedRecordIds=[];
  source.queueEvidence={stepReceipts:[{receipt:{jobKey:b,step:'residual_extract',outcome:'held_quality',reasonCode:'quality_failed'}}]};
  const gap=await computeReleaseAcceptance(await f.seal());
  assert.equal(gap.accepted,true);assert.ok(gap.exceptionItems.some(item=>item.classification==='known_gap'));
  source.cases=[{reason:'assessment_held',candidate:{id:'withheld:fixture'}}];source.classification=classifyStep8Exception(source.cases);
  const excluded=await computeReleaseAcceptance(await f.seal());
  assert.equal(excluded.accepted,true);assert.ok(excluded.exceptionItems.some(item=>item.classification==='known_gap'&&item.ownerAuditPriority==='high'));
  source.cases=[{reason:'no_supported_case'}];source.classification=classifyStep8Exception(source.cases);
  source.queueEvidence={stepReceipts:[{receipt:{jobKey:b,step:'residual_extract',outcome:'no_supported_case',reasonCode:'completed'}}]};
  assert.equal((await computeReleaseAcceptance(await f.seal())).accepted,true);
});

test('excluded context and infrastructure terminal documents are known gaps, but their candidate material cannot leak',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  const source=f.inventory.sourceDispositions[0];source.admittedRecordIds=[];
  for(const reasonCode of ['assessment_context_exceeded','execution_exception']){
    source.cases=[{reason:'terminal_document_exception:'+reasonCode}];source.classification=classifyStep8Exception(source.cases);
    source.terminalDocumentException={reasonCode,outcome:'held_execution'};
    source.queueEvidence={stepReceipts:[{receipt:{jobKey:b,step:'residual_extract',outcome:'held_execution',reasonCode}}]};
    const result=await computeReleaseAcceptance(await f.seal());
    assert.equal(result.accepted,true);assert.ok(result.exceptionItems.some(item=>item.classification==='known_gap'));
  }
  source.cases=[{reason:'terminal_document_exception:execution_exception',candidate:{id:'admitted:fixture'}}];
  source.classification=classifyStep8Exception(source.cases);
  assert.ok((await computeReleaseAcceptance(await f.seal())).exceptionItems.some(item=>item.blocking&&item.candidateAffected));
});

test('release acceptance handler writes exclusively and cannot overwrite an acceptance decision',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  const input=await f.save('acceptance-input.json',await f.seal()),output=join(f.root,'acceptance.json');
  const options=new Map([['input',input.path],['output',output]]);
  await runReleaseAcceptance(options);
  assert.equal(JSON.parse(await readFile(output,'utf8')).accepted,true);
  await assert.rejects(runReleaseAcceptance(options),error=>error instanceof Error&&'code' in error&&error.code==='EEXIST');
});

test('release exception classifier never treats unknown classes or operator-cleared labels as a waiver',()=>{
  assert.equal(classifyReleaseException({reasonCode:'policy_excluded'}),'rights');
  assert.equal(classifyReleaseException({criticalKinds:['identity']}),'critical');
  assert.equal(classifyReleaseException({reason:'copyright_question'}),'legal');
  assert.equal(classifyReleaseException({reason:'new_unknown_hold',resolved:true,ownerReviewed:true}),'unknown');
  assert.equal(classifyReleaseException({reason:'no_supported_case'}),'negative');
  assert.equal(classifyReleaseException({reasonCode:'quality_failed',outcome:'held_quality'}),'known_gap');
  assert.equal(classifyReleaseException({reason:'terminal_document_exception:assessment_context_exceeded'}),'known_gap');
  assert.equal(classifyReleaseException({reason:'terminal_document_exception:execution_exception'}),'known_gap');
  assert.equal(classifyReleaseException({reason:'source_literal_exceeds_short_quote'}),'known_gap');
});

test('authenticated excluded origin, disagreement, legal and critical claims are high-priority known gaps',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  const source=f.inventory.sourceDispositions[0];
  for(const reason of ['origin_unresolved','disagreement','assessment_held','critical_payment_unsupported','copyright_question','privacy_question']){
    source.cases=[{reason,candidate:{id:'excluded:fixture'}}];source.classification=classifyStep8Exception(source.cases);
    const result=await computeReleaseAcceptance(await f.seal());
    assert.equal(result.accepted,true,reason);assert.equal(result.pending_owner_audit,true);
    assert.ok(result.exceptionItems.some(item=>item.classification==='known_gap'&&item.ownerAuditPriority==='high'&&item.candidateAffected===false),reason);
  }
});

test('source-level permission blocks retained material of the same source, but not an authenticated noncontributor',async t=>{
  for(const contributingSource of ['website','unrelated-source']){
    const f=await fixture(contributingSource);t.after(()=>rm(f.root,{recursive:true,force:true}));
    const source=f.inventory.sourceDispositions[0];
    for(const reason of ['rights_pending','source_permission_pending','tdm_opt_out','policy_excluded']){
      source.cases=[{reason,candidate:{id:'excluded:fixture'}}];source.classification=classifyStep8Exception(source.cases);
      const result=await computeReleaseAcceptance(await f.seal());
      assert.equal(result.accepted,contributingSource!=='website',reason);
      assert.ok(result.exceptionItems.some(item=>item.sourceLevel&&item.sourceContributes===(contributingSource==='website')&&item.ownerAuditPriority==='high'),reason);
    }
  }
});

test('document-origin exceptions follow source hashes into derived candidate material',async t=>{
  const f=await fixture('website',h);t.after(()=>rm(f.root,{recursive:true,force:true}));
  const source=f.inventory.sourceDispositions[0];
  source.cases=[{reason:'origin_unresolved'}];source.classification=classifyStep8Exception(source.cases);
  const result=await computeReleaseAcceptance(await f.seal());
  assert.equal(result.accepted,false);assert.ok(result.exceptionItems.some(item=>item.candidateAffected&&item.blocking));
});

test('unknown case codes remain blockers even when accompanied by a controlled quality receipt',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  const source=f.inventory.sourceDispositions[0];
  source.cases=[{reason:'novel_unclassified_hold'}];source.classification=classifyStep8Exception(source.cases);
  source.queueEvidence={stepReceipts:[{receipt:{jobKey:b,step:'residual_extract',outcome:'held_quality',reasonCode:'quality_failed'}}]};
  assert.ok((await computeReleaseAcceptance(await f.seal())).exceptionItems.some(item=>item.classification==='unknown'&&item.blocking));
  source.terminalAssessmentExceptions=[{recordIds:['admitted:fixture'],reasonCode:'invented_code'}];
  source.assessments=[{recordId:'admitted:fixture',pins:{itemArtifactSha256:h,AArtifactSha256:h,BArtifactSha256:h,CArtifactSha256:h,finalArtifactSha256:h}}];
  assert.ok((await computeReleaseAcceptance(await f.seal())).exceptionItems.some(item=>item.origin.includes('terminalAssessmentExceptions')&&item.classification==='unknown'&&item.blocking));
});
