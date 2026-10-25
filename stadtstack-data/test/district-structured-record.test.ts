import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson,digest,semanticHash,observation,type StructuredAdapter,type AdapterScope,type AdmittedSnapshot} from '../src/district-adapter-contract.ts';
import {admitStructuredObservations,StructuredKnowledgeRecordSchema} from '../src/district-structured-record.ts';

const scope:AdapterScope={publisherId:'fixture-publisher',sourceId:'fixture-source',municipalityId:'ratzeburg',ags:'01053100',tenant:null,observationWindow:'2026-10-11'};
const bytes=Buffer.from('{"unit":"asset-1","capacity":12}');
const snapshot:AdmittedSnapshot={sourceSha256:digest(bytes),bytes,url:'https://example.org/export.json',mimeType:'application/json',retrievedAt:'2026-10-11T00:00:00.000Z',policyReceiptSha256:digest('policy-fixture'),sourceVersion:'1'};
const candidate=observation({publisherId:scope.publisherId,sourceId:scope.sourceId,nativeId:'asset-1',nativeVersion:'1',kind:'EnergyUnit',subject:'asset-1',predicate:'rated_capacity',value:12,unit:'kW',date:null,dateRole:null,financialRole:'none',geography:{ags:scope.ags,basis:'source_explicit',role:'project_location'},sourceReferenceDate:null,publishedAt:null,retrievedAt:snapshot.retrievedAt,evidence:[{sourceSha256:snapshot.sourceSha256,format:'json',nativeId:'asset-1',path:'$.capacity',sheet:null,rowKey:null,cells:[],rawValue:12,schemaHash:digest('fixture-schema'),mappingVersion:'fixture-v1'}],limitations:['Synthetic fixture; not publisher evidence.']});
const coverage={state:'complete' as const,scope:'fixture row only',reason:'Fixture exhausted',checkedAt:snapshot.retrievedAt,nextCursor:null,observedRows:1,limitations:[]};
const adapter:StructuredAdapter={id:'fixture',version:'fixture-v1',discover:()=>({resources:[],coverage}),parse:()=>({observations:[candidate],coverage})};
const admission={receiptSha256:snapshot.policyReceiptSha256,sourceSha256:snapshot.sourceSha256,scopeSha256:semanticHash(scope),allowed:true,checkedAt:snapshot.retrievedAt};
const input={adapter,adapterContractSha256:digest('fixture-contract'),snapshot,scope,districtId:'herzogtum-lauenburg',candidates:[candidate],checkCurrentPolicy:async()=>admission,replayInSandbox:async()=>adapter.parse(snapshot,scope)};

test('canonical identity sorts object keys but preserves evidence choice order',()=>{
 assert.equal(canonicalJson({b:2,a:1}),canonicalJson({a:1,b:2}));
 assert.notEqual(semanticHash(['a','b']),semanticHash(['b','a']));
 assert.throws(()=>canonicalJson({value:undefined}));assert.throws(()=>canonicalJson(Number.NaN));
});
test('structured native replay has no synthetic model or quotation receipt',async()=>{
 const first=await admitStructuredObservations(input),second=await admitStructuredObservations(input);
 assert.deepEqual(first,second);assert.equal(first[0].verification.kind,'structured');
 assert.equal('faithfulness' in first[0].verification,false);assert.equal('extraction' in first[0],false);
 assert.deepEqual(first[0].graph,{mentions:[],assertions:[],relations:[]});
});
test('current policy revocation blocks even identical cached native fields',async()=>{
 await assert.rejects(admitStructuredObservations({...input,checkCurrentPolicy:async()=>({...admission,allowed:false})}),/policy/);
 await assert.rejects(admitStructuredObservations({...input,checkCurrentPolicy:async()=>({...admission,scopeSha256:digest('wrong')})}),/policy/);
});
test('mutated bytes and fabricated deterministic fields fail closed',async()=>{
 await assert.rejects(admitStructuredObservations({...input,snapshot:{...snapshot,bytes:Buffer.from('changed')}}),/byte binding/);
 await assert.rejects(admitStructuredObservations({...input,candidates:[{...candidate,value:99}]}),/mapping replay/);
 await assert.rejects(admitStructuredObservations({...input,candidates:[candidate,candidate]}),/mapping replay/);
});
test('beneficiary office cannot establish a municipal project location',async()=>{
 const {id,...fields}=candidate;
 const office=observation({...fields,geography:{ags:scope.ags,basis:'source_explicit',role:'beneficiary_office'}});
 await assert.rejects(admitStructuredObservations({...input,replayInSandbox:async()=>({observations:[office],coverage}),candidates:[office]}),/municipal geography/);
});
test('tampered source and verification locators are rejected by live schema',async()=>{
 const [record]=await admitStructuredObservations(input);
 assert.equal(StructuredKnowledgeRecordSchema.safeParse({...record,source:{...record.source,sha256:digest('different')}}).success,false);
 assert.equal(StructuredKnowledgeRecordSchema.safeParse({...record,verification:{...record.verification,locators:[]}}).success,false);
});

test('verified joins bind supporting originals and their independent current policy',async()=>{
 const {id,...fields}=candidate,sourceSha256=digest('synthetic boundary'),policyReceiptSha256=digest('boundary permission'),scopeSha256=digest('boundary scope');
 const locator={...candidate.evidence[0],sourceSha256,nativeId:'boundary-1',path:'$.properties.ags',rawValue:scope.ags};
 const joined=observation({...fields,geography:{ags:scope.ags,basis:'verified_join',role:'project_location'},supportingEvidence:[{role:'municipality_join',locator}]});
 const replayInSandbox=async()=>({observations:[joined],coverage});
 await assert.rejects(admitStructuredObservations({...input,candidates:[joined],replayInSandbox}),/Supporting evidence/);
 const supportingSources=[{id:'boundary-source',url:'https://example.org/boundary.json',sha256:sourceSha256,mimeType:'application/json',retrievedAt:snapshot.retrievedAt,policyReceiptSha256,scopeSha256,role:'municipality_join' as const}];
 await assert.rejects(admitStructuredObservations({...input,candidates:[joined],replayInSandbox,supportingSources}),/current policy/);
 const [record]=await admitStructuredObservations({...input,candidates:[joined],replayInSandbox,supportingSources,checkSupportingPolicies:async()=>[{receiptSha256:policyReceiptSha256,sourceSha256,scopeSha256,allowed:true,checkedAt:snapshot.retrievedAt}]});
 assert.equal(record.observation.evidence[0].sourceSha256,snapshot.sourceSha256);
 assert.equal(record.observation.supportingEvidence[0].locator.sourceSha256,sourceSha256);
 assert.deepEqual(record.supportingSources,supportingSources);
 assert.equal(StructuredKnowledgeRecordSchema.safeParse({...record,supportingSources:[]}).success,false);
});
