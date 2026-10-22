import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {precheckStructuredSelection} from '../scripts/r1-step8-structured-precheck.mjs';
import {authenticateStep8StructuredSelection} from '../src/r1-step8-current-policy.ts';

const digest=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>JSON.stringify(value,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);
const semanticHash=value=>digest(canonical(value));
const id='11111111-1111-4111-8111-111111111111';
const id2='22222222-2222-4222-8222-222222222222';

// Synthetic branch fixtures deliberately isolate the refusal logic. Production
// always supplies Core's strict codecs and a real READ ONLY managed reader.
function fixture({remaining=14*3600000,step='structured_parse',page=null}={}){
  const blobs=new Map(),put=value=>{const raw=Buffer.isBuffer(value)?value:Buffer.from(canonical(value)),hash=digest(raw);blobs.set(hash,raw);return hash;};
  const scope={municipalityId:'hagenow',sourceId:'pegelonline'},source={sha256:put(Buffer.from('synthetic original')),url:'https://fixture.invalid/stations.json',mimeType:'application/json'},proof={source,scope,checkedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+remaining).toISOString()},proofHash=put(proof);
  const worker={scope,operation:'parse',snapshot:{sourceSha256:source.sha256,url:source.url,mimeType:source.mimeType,policyReceiptSha256:proofHash}};
  const output={requestSha256:semanticHash(worker),sourceSha256:source.sha256,policyReceiptSha256:proofHash,scope,supportingSources:[],parserContractSha256:'p',mappingContractSha256:'m',adapterVersion:'a',result:{coverage:{observedRows:1}},records:[],page};
  const receipt={runId:id,step,outcome:'succeeded',attempt:1,provider:null,sourceId:scope.sourceId,municipalityId:scope.municipalityId,policyProofSha256:proofHash,inputHashes:[source.sha256,proofHash],outputHashes:[put(output)],versions:{worker:'v',parser:'p',mapping:'m',adapter:'a'},counts:{rows:1,acceptedFacts:0}};
  const row={run_id:id,receipt_sha256:semanticHash(receipt),receipt,spec:{step,sourceScope:scope,selector:{worker,supportingSources:[]}},state:'succeeded',current_attempt:1};
  const codec={parse:value=>value};let reads=0,checks=0;
  const core={adapter:{HashSchema:codec,digest,semanticHash,canonicalJson:canonical},receipt:{StepReceiptSchema:codec},structuredJobs:{StructuredJobResultSchema:codec},policyReceipt:{PolicyReceiptSchema:codec,recheckPolicyReceipt:async()=>{checks++;}},worker:{StructuredWorkerRequestSchema:codec,STRUCTURED_WORKER_VERSION:'v'}};
  return {row,blobs,checks:()=>checks,reads:()=>reads,args:{runIds:[id],requiredThrough:Date.now()+13*3600000,policy:{},core,client:{query:async sql=>sql.startsWith('SHOW')?{rows:[{transaction_read_only:'on'}]}:{rows:[row]}},readCas:async hash=>{reads++;assert.ok(blobs.has(hash));return blobs.get(hash);}}};
}

test('acquisition-only selection refuses before any CAS read',async()=>{const f=fixture({step:'acquire_representation'});await assert.rejects(precheckStructuredSelection(f.args),/No committed structured_parse/);assert.equal(f.reads(),0);});
test('horizon refuses a proof that expires before 12 h plus 1 h',async()=>{const f=fixture({remaining:12*3600000});await assert.rejects(precheckStructuredSelection(f.args),/required strictly beyond/);assert.equal(f.checks(),0);});
test('fresh proof and exact committed receipt selection pass refusal layer',async()=>{const f=fixture();const report=await precheckStructuredSelection({...f.args,selection:{runIds:[id],receipts:[{runId:id,sha256:f.row.receipt_sha256,step:f.row.receipt.step,municipalityId:'hagenow',sourceId:'pegelonline'}]}});assert.equal(report.authorizesExecution,false);assert.equal(f.checks(),1);assert.equal(report.issues.length,0);});
test('wrong issued receipt pin refuses despite current policy',async()=>{const f=fixture();await assert.rejects(precheckStructuredSelection({...f.args,selection:{runIds:[id],receipts:[]}}),/differs from issued selection/);});
test('current attempt and complete page closure are required',async()=>{const stale=fixture();stale.row.current_attempt=2;await assert.rejects(precheckStructuredSelection(stale.args),/current job attempt/);const partial=fixture({page:{offset:1,end:2,total:2,bindingSha256:'b',sourceCoverage:{},nextCursor:null}});await assert.rejects(precheckStructuredSelection(partial.args),/Missing or overlapping/);});
test('writable transactions and duplicate run IDs refuse',async()=>{const f=fixture();await assert.rejects(precheckStructuredSelection({...f.args,client:{query:async()=>({rows:[{transaction_read_only:'off'}]})}}),/READ ONLY/);await assert.rejects(precheckStructuredSelection({...f.args,runIds:[id,id]}),/Duplicate/);});

function issuedSelectionFixture(){
  const files=new Map(),issuedAt=new Date(Date.now()-10000).toISOString(),expiresAt=new Date(Date.now()+24*3600000).toISOString(),store=(name,value)=>{const raw=Buffer.from(JSON.stringify(value,null,2)+'\n'),pin={path:'/synthetic/'+name+'.json',sha256:digest(raw)};files.set(pin.path,raw);return pin;};
  const bounds={maxModelCalls:0,paidMicroUsd:0,maxJobs:7},acquisition={path:'/synthetic/acquisition.json',sha256:'a'.repeat(64)};
  const actionDraft={schemaVersion:'stadtstack-r1-operator-action-record-v1',id:'action',action:'fresh-exact-k1-k2-acquisition-and-structured-parse-for-step8',issuedBy:'synthetic fixture lead',issuedAt:'',expiresAt,requiredOwnerDecision:'owner',processingCommit:'b'.repeat(40),acquisition,bounds};
  const renewalAuthority=store('action',{...actionDraft,issuedAt}),ownerDecision=store('owner',{schemaVersion:'stadtstack-r1-owner-approval-record-v1',id:'owner',issuedAt,approver:'Max (owner)',ownerStatementsVerbatim:['SYNTHETIC TEST ONLY, not a real approval'],approved:true,request:{action:actionDraft.action,actionDraftSha256:digest(JSON.stringify(actionDraft,null,2)+'\n'),acquisition,bounds,expiresAt}});
  const selection={schemaVersion:'stadtstack-r1-step8-structured-selection-v1',id:'selection',issuedBy:'synthetic fixture lead',issuedAt,expiresAt,renewalAuthority,ownerDecision,runIds:[id,id2],receipts:[{runId:id,sha256:'c'.repeat(64),step:'structured_parse',municipalityId:'hagenow',sourceId:'pegelonline'},{runId:id2,sha256:'d'.repeat(64),step:'structured_parse',municipalityId:'strausberg',sourceId:'regionalstatistik-genesis'}]};
  return {selection,store,options:{selection:store('selection',selection),runIds:[id,id2],requiredThrough:Date.now()+13*3600000,readControl:async pin=>files.get(pin.path)}};
}
test('issued authority chain authenticates raw reviewed draft order and exact run pins',async()=>{const f=issuedSelectionFixture();assert.deepEqual((await authenticateStep8StructuredSelection(f.options)).runIds,[id,id2]);await assert.rejects(authenticateStep8StructuredSelection({...f.options,runIds:[id2,id]}),/ordered run IDs/);});
test('unissued selection and duplicate receipt pins fail closed',async()=>{const f=issuedSelectionFixture();await assert.rejects(authenticateStep8StructuredSelection({...f.options,selection:f.store('unissued',{...f.selection,issuedAt:''})}));const duplicate={...f.selection,receipts:[f.selection.receipts[0],f.selection.receipts[0],f.selection.receipts[1]]};await assert.rejects(authenticateStep8StructuredSelection({...f.options,selection:f.store('duplicate',duplicate)}),/duplicate, missing or extra/);});
test('execution evidence cannot use controls-only selection authentication',async()=>{const f=issuedSelectionFixture(),selection={...f.selection,executionEvidence:{path:'/synthetic/execution.json',sha256:'e'.repeat(64)}};await assert.rejects(authenticateStep8StructuredSelection({...f.options,selection:f.store('without-custody',selection)}),/requires canonical read-only DB\/CAS custody/);});
