import test from 'node:test';
import assert from 'node:assert/strict';
import {diff,retainChanges,validateChanges,changeSnapshotHash,type ChangeRecord} from '../src/changes.ts';
import {semanticHash} from '../src/district-adapter-contract.ts';

// Synthetic revision-set fixtures only; no civic facts, generation receipts or prior release approval.
const scope={cityId:'synthetic-town',recordType:'signal' as const},at='2026-10-10T12:00:00.000Z';
const record=(version:string):ChangeRecord=>({id:'synthetic:signal',cityId:scope.cityId,recordType:'signal',revision:{version:semanticHash(version),evidenceHash:null,sourceHashes:[semanticHash('synthetic source')],metricClaims:[]},sources:[{url:'https://example.org/synthetic-source',sha256:semanticHash('synthetic source')}],semanticEvidence:[]});

test('identical current signals with different authentic predecessor revisions yield different bound feeds',()=>{
 const current=[record('current')],first=diff([record('earlier A')],current,at,[],[scope]),second=diff([record('earlier B')],current,at,[],[scope]);
 assert.notDeepEqual(first,second);
 assert.equal(first.events[0].kind,'changed');
 assert.equal(first.snapshots[0].current,changeSnapshotHash(current));
 assert.notEqual(first.snapshots[0].previous,second.snapshots[0].previous);
 assert.doesNotThrow(()=>validateChanges(first,current));
});

test('unchanged signals retain original v2 change state and original scoped clocks',()=>{
 const current=[record('current')],prior=diff([record('earlier')],current,at,[],[scope]);
 assert.deepEqual(retainChanges(prior,current,undefined,[scope]),prior);
 const fresh=diff(current,current,'2026-10-11T12:00:00.000Z',[],[scope]);
 assert.equal(fresh.events.length,0);
 assert.notDeepEqual(fresh,retainChanges(prior,current,undefined,[scope]));
 const rebound=structuredClone(prior);rebound.snapshots[0].current=semanticHash('unrelated snapshot');
 assert.throws(()=>retainChanges(rebound,current,undefined,[scope]));
});

test('legacy ID-only change state requires actual earlier snapshots and exact original ID sets',()=>{
 const earlier=[record('earlier')],current=[record('current')];
 const legacy={generatedAt:at,added:[],changed:[current[0].id],removed:[]};
 assert.throws(()=>retainChanges(legacy,current,undefined,[scope]));
 const reconstructed=retainChanges(legacy,current,earlier,[scope]);
 assert.equal(reconstructed.generatedAt,at);
 assert.equal(reconstructed.events[0].previous?.version,earlier[0].revision.version);
 assert.equal(reconstructed.snapshots[0].previous,changeSnapshotHash(earlier));
 assert.throws(()=>retainChanges(legacy,current,current,[scope]));
 assert.throws(()=>retainChanges({...legacy,changed:['synthetic:wrong']},current,earlier,[scope]));
});
