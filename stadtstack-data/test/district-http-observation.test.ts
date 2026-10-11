import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest,semanticHash} from '../src/district-adapter-contract.ts';
import {DistrictCas} from '../src/district-cas.ts';
import {HttpObservationProofSchema,authenticatedHttpBinding,authenticateHttpSourceBindings} from '../src/district-http-observation.ts';
import {provisionCivicPolicyAuthority,initializeManagedAcquisitionLane,withManagedSourceWrite,recordHostOptOut,CIVIC_ACQUISITION_DECISION_ID} from '../src/civic-opt-out.ts';

// Synthetic transport observations only: no request, provider or production authority.
function fixture(overrides:Record<string,unknown>={}) {
 const observation={url:'https://example.org/synthetic.csv',method:'GET',checkedAt:'2026-10-11T10:00:01.000Z',retrievedAt:'2026-10-11T10:00:00.000Z',state:'fetched',status:200,sha256:digest('synthetic bytes'),bytes:15,mimeType:'text/csv',...overrides};
 const bytes=JSON.stringify(observation,null,2)+'\n';
 return {observation,proof:{observationId:`1791712801000-${randomUUID()}.json`,receiptSha256:digest(bytes),bytes}};
}

test('original pretty JSON HTTP proof retains byte identity, not canonical policy identity',()=>{
 const {observation,proof}=fixture();
 assert.notEqual(proof.receiptSha256,semanticHash(observation));
 assert.deepEqual(HttpObservationProofSchema.parse(proof),proof);
 const binding=authenticatedHttpBinding(proof,{url:observation.url,sha256:observation.sha256,mimeType:observation.mimeType,retrievedAt:observation.retrievedAt,fetchedAt:observation.checkedAt});
 assert.deepEqual(binding,{kind:'http_observation',url:observation.url,sourceSha256:observation.sha256,observationId:proof.observationId,receiptSha256:proof.receiptSha256});
 assert.throws(()=>authenticatedHttpBinding({...proof,receiptSha256:semanticHash(observation)},observation));
 assert.throws(()=>authenticatedHttpBinding({...proof,observationId:`policy-${semanticHash(observation)}.json`},observation));
});

test('HTTP observation binds URL, source digest, MIME and both clocks independently',()=>{
 const {observation,proof}=fixture();
 const expected={url:observation.url,sha256:observation.sha256,mimeType:observation.mimeType,retrievedAt:observation.retrievedAt,fetchedAt:observation.checkedAt};
 for(const mismatch of [{url:'https://example.org/other.csv'},{sha256:digest('other')},{mimeType:'application/json'},{retrievedAt:'2026-10-10T10:00:00.000Z'},{fetchedAt:'2026-10-10T10:00:01.000Z'}])assert.throws(()=>authenticatedHttpBinding(proof,{...expected,...mismatch}),/does not bind/);
 for(const changed of [{state:'excluded'},{state:'fetched',status:304},{state:'not_modified',status:200},{url:'http://127.0.0.1/private'},{url:'https://user:secret@example.org/private'},{authorization:'Bearer synthetic-secret'},{etag:'unsafe\nheader'},{bytes:-1},{mimeType:'text/csv; secret=value'}]){
  const invalid=fixture(changed);assert.throws(()=>authenticatedHttpBinding(invalid.proof,{url:invalid.observation.url,sha256:invalid.observation.sha256}));
 }
 const cached=fixture({state:'not_modified',status:304});
 assert.equal(authenticatedHttpBinding(cached.proof,cached.observation).kind,'http_observation');
 assert.equal(HttpObservationProofSchema.safeParse({...proof,bytes:proof.bytes+' '}).success,false);
 assert.equal(HttpObservationProofSchema.safeParse({...proof,bytes:' '.repeat(1024*1024+1)}).success,false);
});

test('managed CAS authenticates every selected HTTP binding and rejects invented policy provenance or opt-out',async t=>{
 const root=await mkdtemp(join(tmpdir(),'r1-http-proof-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const options={stateDir:join(root,'authority'),authorityId:`fixture:${randomUUID()}`};
 const authority=await provisionCivicPolicyAuthority(options),policy={...options,authoritySha256:authority.authoritySha256};
 const cas=new DistrictCas(join(root,'cas'));
 await initializeManagedAcquisitionLane(cas.root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
 const {observation,proof}=fixture(),source={url:observation.url,sha256:observation.sha256};
 const binding=authenticatedHttpBinding(proof,source);
 assert.ok(binding.kind==='http_observation');
 for(const [bytes,kind] of [[Buffer.from('synthetic bytes'),'derived'],[Buffer.from(proof.bytes),'receipt']] as const){
  const hash=digest(bytes);
  await withManagedSourceWrite(cas.root,[{...binding,relativePath:`sha256/${hash.slice(0,2)}/${hash}`,contentSha256:hash,independentAllowed:kind==='derived'}],()=>cas.put(bytes,{kind,mimeType:kind==='receipt'?'application/json':'text/csv'}),policy);
 }
 assert.deepEqual(await authenticateHttpSourceBindings(cas,[binding],[source],policy),[binding]);
 await assert.rejects(authenticateHttpSourceBindings(cas,[],[source],policy),/Exactly one/);
 await assert.rejects(authenticateHttpSourceBindings(cas,[binding,binding],[source],policy),/Exactly one/);
 await assert.rejects(authenticateHttpSourceBindings(cas,[binding],[],policy),/Unselected/);
 await assert.rejects(authenticateHttpSourceBindings(cas,[{...binding,kind:'prepared_source'}],[source],policy),/Exactly one/);
 await assert.rejects(authenticateHttpSourceBindings(cas,[{...binding,receiptSha256:semanticHash(observation)}],[source],policy));
 await assert.rejects(authenticateHttpSourceBindings(cas,[{...binding,observationId:`1791712801000-${randomUUID()}.json`}],[source],policy));
 await assert.rejects(authenticateHttpSourceBindings(cas,[binding],[source],{...policy,authoritySha256:digest('foreign-authority')}));
 await recordHostOptOut({host:'example.org',reason:'rights_holder_objection',reference:'synthetic-http-proof-test'},policy);
 await assert.rejects(authenticateHttpSourceBindings(cas,[binding],[source],policy));
});
