import test from 'node:test';
import assert from 'node:assert/strict';
import {step8JsonBytes,encodeStep8Json,STEP8_JSON_LIMIT_BYTES} from '../src/r1-step8-json-budget.ts';
import {step8QueueEvidence,authenticateStep8QueueEvidence} from '../src/r1-step8-queue-evidence.ts';
import {forecastStep8JsonOutputs,assertStep8JsonBudget,forecastStep8NativeInventories} from '../src/r1-step8-json-forecast.ts';
import {privatePublicationProvenanceSchema} from '../src/district-publication-provenance.ts';

const h='a'.repeat(64),job='b'.repeat(64),pin={path:'/synthetic/immutable-extraction-run.json',sha256:h};
const current={sha256:h,receipt:{id:'11111111-1111-4111-8111-111111111111',jobKey:job,step:'residual_extract',outcome:'held_quality',reasonCode:'quality_failed'}};

test('JSON byte counter matches exact pretty serialization, including escapes and surrogate pairs',()=>{
 for(const value of [null,true,false,0,-0,NaN,Infinity,'','x\n\t\r\b\f"\\\u0001','Größe 😄 \ud800 \udfff',[null,undefined,{},[]],{empty:{},array:[{deep:'ä'}],omitted:undefined},Array(3)]){
  const expected=Buffer.from(JSON.stringify(value,null,2)+'\n');assert.equal(step8JsonBytes(value),expected.length);assert.deepEqual(encodeStep8Json(value),expected);
 }
 const embedded={nested:[{value:'ä'}]},serialized=JSON.stringify(embedded,null,2);
 assert.equal(step8JsonBytes(embedded,'embedded',undefined,2),Buffer.byteLength(serialized+'\n')+4*(serialized.split('\n').length-1));
});
test('large logical JSON is refused before constructing a V8-sized serialized string',()=>{
 const payload='x'.repeat(1024),repeated=Array.from({length:70000},()=>({payload}));
 assert.throws(()=>step8JsonBytes(repeated,'large source dispositions'),/JSON size limit/);
 assert.throws(()=>encodeStep8Json({value:'abc'},'exact boundary',step8JsonBytes({value:'abc'})),/maximum exclusive/);
 const cycle:unknown[]=[];cycle.push(cycle);assert.throws(()=>step8JsonBytes(cycle),/Cyclic/);
 assert.throws(()=>step8JsonBytes({date:new Date()}),/Non-data/);
 assert.equal(STEP8_JSON_LIMIT_BYTES,64*1024*1024);
});
test('document evidence contains one scoped current receipt and pins full source-wide history without copying it',async()=>{
 const other={...current,receipt:{...current.receipt,jobKey:h}},queue={stepReceipts:[{...current,spec:{large:'x'.repeat(2*1024*1024)}},other],callAccounting:{large:'x'.repeat(2*1024*1024)},extractionAttemptHistory:[{jobKey:job,fullAttempt:'retained original history'}]};
 const selected=step8QueueEvidence(pin,queue,'document:one',job);
 assert.ok(step8JsonBytes(selected)<2048);assert.equal(selected.stepReceipts.length,1);assert.equal(selected.stepReceipts[0].receipt.outcome,'held_quality');assert.equal(selected.stepReceipts[0].sha256,h);assert.deepEqual(selected.extractionAttemptHistory,{extractionRun:pin,pointer:'/queue/extractionAttemptHistory'});
 assert.equal('callAccounting' in selected,false);assert.equal('spec' in selected.stepReceipts[0],false);
 await authenticateStep8QueueEvidence(selected,'document:one',job,async actual=>{assert.deepEqual(actual,pin);return {queue};});
 await assert.rejects(authenticateStep8QueueEvidence(selected,'document:other',job,async()=>({queue})),/document\/job mismatch/);
 await assert.rejects(authenticateStep8QueueEvidence({...selected,stepReceipts:[{...selected.stepReceipts[0],receipt:{...selected.stepReceipts[0].receipt,outcome:'succeeded'}}]},'document:one',job,async()=>({queue})),/differs from its pinned original/);
 const {extractionAttemptHistory:_,...withoutHistory}=selected;
 await assert.rejects(authenticateStep8QueueEvidence(withoutHistory,'document:one',job,async()=>({queue})),/differs from its pinned original/);
 assert.ok('spec' in queue.stepReceipts[0]);assert.equal(queue.stepReceipts[0].spec.large.length,2*1024*1024,'projection never mutates the original evidence');
});
test('closed JSON budget ledger covers all writer families and refuses oversized or undeclared outputs',()=>{
 const exports={sourceDispositionArrayBytes:1000,sourceAuditPayloadBytes:1000,assessmentPayloadBytes:1000,assessmentArtifactSizes:[{path:'/synthetic/item.json',bytes:500}],publicationRecordsBytes:1000,publicationQuarantineBytes:1000,publicationPolicyBytes:1000,textCompositionBytes:1000};
 const input={exports,metadata:{input:'synthetic'},structuredBytes:1000,structuredCoverageBytes:1000,registryBytes:1000,allowanceBytes:1000,auditAuxiliaryBytes:1000,retainedMaximumBytes:1000,priorMaximumBytes:1000,primaryProvenanceBytes:1000,stagingProvenanceBytes:1000,nativeInventories:[{path:'audit/native-provenance/sha-inventory.json',bytes:1000}],staging:{campaignBytes:1000,primaryBytes:1000,retainedBytes:1000}},budget=forecastStep8JsonOutputs(input);
 for(const name of ['source-dispositions.json','audit/current-generation.json','audit/publication-preflight.json','audit/native-provenance/sha-inventory.json','audit/native-provenance/sha-attestation.json','audit/1-A.json','audit/assessments.json','inputs/records.json','inputs/provenance.json','exception-inventory.json','release/knowledge/records.json','release/release-manifest.json','replay-proof.json','replay-receipt.json','release-gate.json','step9-handoff.json'])assert.doesNotThrow(()=>assertStep8JsonBudget(budget,name,100));
 for(const name of ['staging/campaign.json','staging/private-publication-provenance.json','staging/staging-publication-provenance.json','staging/staging-component.json'])assert.doesNotThrow(()=>assertStep8JsonBudget(budget,name,100));
 assert.throws(()=>assertStep8JsonBudget(budget,'new-unbudgeted.json',100),/outside static pre-pass budget/);
 assert.throws(()=>assertStep8JsonBudget(budget,'audit/1-A.json',501),/outside static pre-pass budget/);
 assert.throws(()=>forecastStep8JsonOutputs({...input,exports:{...exports,sourceDispositionArrayBytes:40*1024*1024}}),/pre-pass budget refused/);
});

test('native inventory forecast retains the exact complete shared binding union and refuses unsupported custody',()=>{
 const a={kind:'http_observation',url:'https://example.invalid/a',sourceSha256:h,observationId:'one.json',receiptSha256:h,independentAllowed:true},b={...a,url:'https://example.invalid/b',sourceSha256:job,observationId:'two.json'};
 const inventory=(binding:unknown)=>privatePublicationProvenanceSchema.parse({schemaVersion:'stadtstack-private-publication-provenance-v1',inputs:[{path:'/synthetic/shared-empty-critical.json',sha256:h,bytes:14,bindings:[binding]}]});
 const first=inventory(a),second=inventory(b),predicted=forecastStep8NativeInventories([{seal:{sha256:h},inventory:first},{seal:{sha256:job},inventory:second}]);
 assert.equal(predicted.length,2);assert.equal(predicted[0].bytes,step8JsonBytes({...first,inputs:[{...first.inputs[0],bindings:[first.inputs[0].bindings[0],second.inputs[0].bindings[0]]}]}));
 assert.equal(first.inputs[0].bindings.length,1,'forecast never rebinds the original shared artifact');
 assert.throws(()=>forecastStep8NativeInventories([{seal:{sha256:h},inventory:first},{seal:{sha256:job},inventory:inventory({...b,independentAllowed:false})}]),/non-independent HTTP custody/);
});
