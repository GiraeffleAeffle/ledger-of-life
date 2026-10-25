import test from 'node:test';
import assert from 'node:assert/strict';
import {sealPublicationInputs,verifyPublicationStaging,verifyPublicationPolicyReceipts,requiredPublicationStaging,publicationInputsSchema,type PublicationInputs} from '../src/district-publication-inputs.ts';
import {digest} from '../src/district-adapter-contract.ts';

// Byte-integrity fixtures only. The predecessor evidence is synthetic, never a release receipt.
const cities=['synthetic-town'],staging=new Map(requiredPublicationStaging(cities).map(path=>[path,Buffer.from(JSON.stringify({fixture:path}))]));
const priorRelease={gitCommit:'1'.repeat(40),manifestSha256:'2'.repeat(64),releaseId:'3'.repeat(64),members:[...['changes.json','signals.geojson'].map(name=>({path:`cities/synthetic-town/${name}`,sha256:digest(name),bytes:Buffer.byteLength(name)})),{path:'knowledge/records.json',sha256:digest('authentic prior knowledge'),bytes:24},{path:'quality-report.json',sha256:digest('authentic prior quality holds'),bytes:Buffer.byteLength('authentic prior quality holds')},...['strausberg-facts','release-manifest','handover-draft'].map(name=>({path:`core/${name}.json`,sha256:digest(name),bytes:Buffer.byteLength(name)}))]};
const policy={snapshotSha256:'4'.repeat(64),receipts:[{recordId:'synthetic-record',receiptSha256:'5'.repeat(64)}]};
const dependencies:PublicationInputs['dependencies']=[{role:'registry',sha256:'6'.repeat(64)},{role:'candidate_records',sha256:'a'.repeat(64)},{role:'candidate_quarantine',sha256:'b'.repeat(64)},{role:'policy_receipts',sha256:'c'.repeat(64)},{role:'critical_assessments',sha256:'d'.repeat(64)},{role:'publication_contract',sha256:'7'.repeat(64)},{role:'schema_contract',sha256:'8'.repeat(64)},{role:'graph_contract',sha256:'9'.repeat(64)}];
const fixture=()=>sealPublicationInputs({asOf:'2026-10-11',policy,dependencies,staging,priorRelease});

test('publication input identity binds all staging, predecessor change state, policy and asOf',()=>{
 const original=fixture();
 assert.doesNotThrow(()=>verifyPublicationStaging(original,cities,staging));
 const shuffled=sealPublicationInputs({asOf:original.asOf,policy,dependencies:[...dependencies].reverse(),staging:new Map([...staging].reverse()),priorRelease:{...priorRelease,members:[...priorRelease.members].reverse()}});
 assert.deepEqual(shuffled,original);
 for(const replacement of [
  {asOf:'2026-10-12'},
  {policy:{...policy,snapshotSha256:'a'.repeat(64)}},
  {priorRelease:{...priorRelease,gitCommit:'b'.repeat(40)}},
  {priorRelease:{...priorRelease,members:priorRelease.members.map(member=>({...member,sha256:'c'.repeat(64)}))}},
  {staging:new Map([...staging].map(([path,bytes])=>[path,path==='catalogue.json'?Buffer.from('changed catalogue input'):bytes]))},
  {staging:new Map([...staging].map(([path,bytes])=>[path,path==='knowledge/assessment-admissions.json'?Buffer.from('changed critical seals'):bytes]))},
 ])assert.notEqual(sealPublicationInputs({asOf:original.asOf,policy,dependencies,staging,priorRelease,...replacement}).inputSha256,original.inputSha256);
});
test('publication predecessor requires the authenticated quality report that carries council holds',()=>{
 const original=fixture();
 assert.ok(original.priorRelease.members.some(member=>member.path==='quality-report.json'));
 const missingQuality=sealPublicationInputs({asOf:original.asOf,policy,dependencies,staging,priorRelease:{...priorRelease,members:priorRelease.members.filter(member=>member.path!=='quality-report.json')}});
 assert.throws(()=>verifyPublicationStaging(missingQuality,cities,staging),/authentic predecessor signal and change/);
});

test('publication seal fails for changed/missing staging and missing authentic predecessor changes',()=>{
 const original=fixture(),changed=new Map(staging);
 changed.set('core/strausberg-facts.json',Buffer.from('changed core facts'));
 assert.throws(()=>verifyPublicationStaging(original,cities,changed),/input binding mismatch/);
 const missing=new Map(staging);missing.delete('regions/brandenburg-mol/topics.json');
 assert.throws(()=>verifyPublicationStaging(original,cities,missing),/complete.*staging inventory/);
 const noChanges=sealPublicationInputs({asOf:original.asOf,policy,dependencies,staging,priorRelease:{...priorRelease,members:[priorRelease.members[1],{...priorRelease.members[1],path:'cities/other-town/signals.geojson'}]}});
 assert.throws(()=>verifyPublicationStaging(noChanges,cities,staging),/authentic predecessor signal and change/);
 const modified=structuredClone(original);modified.asOf='2026-10-12';
 assert.equal(publicationInputsSchema.safeParse(modified).success,false);
});

test('publication seal does not erase duplicated dependencies or fabricate absent current receipts',()=>{
 assert.throws(()=>sealPublicationInputs({asOf:'2026-10-11',policy,dependencies:[...dependencies,dependencies[0]],staging,priorRelease}),/Duplicate publication input binding/);
 assert.throws(()=>sealPublicationInputs({asOf:'2026-10-11',policy:{...policy,receipts:[policy.receipts[0],policy.receipts[0]]},dependencies,staging,priorRelease}),/Duplicate publication input binding/);
 assert.equal(publicationInputsSchema.safeParse({...fixture(),policy:{snapshotSha256:policy.snapshotSha256}}).success,false);
 assert.throws(()=>sealPublicationInputs({asOf:'2026-10-11',policy,dependencies:dependencies.filter(dependency=>dependency.role!=='critical_assessments'),staging,priorRelease}),/Missing publication dependency: critical_assessments/);
});

test('current policy receipt inventory cannot omit, duplicate or add an admitted record',()=>{
 const original=fixture();
 assert.doesNotThrow(()=>verifyPublicationPolicyReceipts(original,['synthetic-record']));
 for(const ids of [[],['different-record'],['synthetic-record','synthetic-record'],['synthetic-record','extra-record']])assert.throws(()=>verifyPublicationPolicyReceipts(original,ids),/actual current-policy receipt/);
});
