import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool,Client} from 'pg';
import {NativeSealSelectionSchema,ProvenanceSupplementSelectionSchema,createCanonicalWitnessReadPool} from '../src/r1-step8-provenance.ts';

const pin={path:'/synthetic/private/control.json',sha256:'a'.repeat(64)};
const seal={municipalityId:'synthetic',sourceId:'website',corpus:pin,output:pin,admission:'published',queue:{jobKeys:['b'.repeat(64)],reconciliationJobKeys:[]}};
test('governed native selection is pinned, ordered and has no free-standing witness authority',()=>{
 const frame={schemaVersion:'stadtstack-r1-native-seal-selection-v1',catalogue:pin,seals:[seal]};
 assert.equal(NativeSealSelectionSchema.parse(frame).seals.length,1);
 assert.throws(()=>NativeSealSelectionSchema.parse({...frame,witnesses:[{output:pin,provenance:pin}]}));
 assert.throws(()=>NativeSealSelectionSchema.parse({...frame,seals:[]}));
 assert.throws(()=>NativeSealSelectionSchema.parse({...frame,seals:[{...seal,output:{...pin,path:'/synthetic/../alias'}}]}));
 assert.throws(()=>NativeSealSelectionSchema.parse({...frame,issuedAt:''}),'issuance is a separately reviewed lead-action wrapper, not invented frame metadata');
});
test('supplements require independent inventory and exact-witness attestation pins',()=>{
 const selected={inventory:pin,attestation:{...pin,path:'/synthetic/private/attestation.json'},targets:['c'.repeat(64)]};
 assert.deepEqual(ProvenanceSupplementSelectionSchema.parse(selected),selected);
 assert.throws(()=>ProvenanceSupplementSelectionSchema.parse({...pin,targets:selected.targets}));
 assert.throws(()=>ProvenanceSupplementSelectionSchema.parse({...selected,attestation:undefined}));
});
test('real socket DSNs default omitted ports and never inherit injected clients or GUC overrides',async()=>{
 class ForbiddenClient extends Client {constructor(){super();assert.fail('Caller client must never be constructed');}}
 for(const [url,port] of [['postgresql:///civic_r1?host=/var/run/postgresql',5432],['postgresql:///civic_r1?host=/var/run/postgresql&port=55432',55432]] as const){
  const caller=new Pool({connectionString:url,Client:ForbiddenClient,options:'-c default_transaction_read_only=off'}),reader=createCanonicalWitnessReadPool(caller.options);
  try{assert.equal(reader.options.port,port);assert.equal(reader.options.host,'/var/run/postgresql');assert.equal(reader.options.database,'civic_r1');assert.equal(reader.options.options,'-c default_transaction_read_only=on');assert.equal(reader.options.Client,undefined);assert.equal(reader.options.connectionString,undefined);}finally{await reader.end();await caller.end();}
 }
 assert.throws(()=>createCanonicalWitnessReadPool(new Pool({connectionString:'postgresql:///civic_r1?host=/var/run/postgresql&port=0'}).options));
});
// Positive canonical receipt/ancillary-role and negative operator-authored proof,
// alias/reordering/no-op-witness/epoch regressions run in the real disposable-PG
// topology fixture via helpers/step8-provenance-fixture.ts. Enrolling synthetic
// JSON alone is deliberately no longer a positive authentication fixture.
