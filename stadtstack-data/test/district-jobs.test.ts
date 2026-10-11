import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../src/district-adapter-contract.ts';
import {canonicalJobIdentity,canonicalResourceIdentity,runDistrictJobsCli,R1_MUNICIPALITIES,type DistrictJobSpec} from '../src/district-jobs.ts';

const spec:DistrictJobSpec={step:'parse',lane:'cpu',semanticContractSha256:digest('parser-v1'),inputArtifactHashes:[digest('b'),digest('a')],sourceScope:{publisherId:'synthetic-publisher',sourceId:'synthetic-source',municipalityId:'strausberg',ags:'12064472',tenant:'town-tenant',observationWindow:'2026-10-11'},selector:{query:{b:2,a:1},candidateIds:['candidate-b','candidate-a']},policyProofSha256:digest('policy')};
test('semantic identity sorts unordered hashes and object keys, preserves meaningful candidate order and scope',()=>{
  const first=canonicalJobIdentity(spec);
  const reordered=canonicalJobIdentity({...spec,inputArtifactHashes:[...spec.inputArtifactHashes].reverse(),selector:{candidateIds:['candidate-b','candidate-a'],query:{a:1,b:2}}});
  assert.equal(first.jobKey,reordered.jobKey);
  assert.equal(first.jobKey,canonicalJobIdentity({...spec,inputArtifactHashes:[...spec.inputArtifactHashes,spec.inputArtifactHashes[0]]}).jobKey);
  assert.equal(first.jobKey,canonicalJobIdentity({...spec,lane:'cpu-priority'}).jobKey);
  for(const changed of [
    {...spec,semanticContractSha256:digest('parser-v2')},
    {...spec,selector:{query:{a:1,b:2},candidateIds:['candidate-a','candidate-b']}},
    {...spec,sourceScope:{...spec.sourceScope,tenant:'another-tenant'}},
    {...spec,sourceScope:{...spec.sourceScope,observationWindow:'2026-10-12'}},
    {...spec,policyProofSha256:digest('policy-v2')},
  ])assert.notEqual(first.jobKey,canonicalJobIdentity(changed).jobKey);
  assert.throws(()=>canonicalJobIdentity({...spec,selector:{value:undefined}}),/canonical/);
  assert.throws(()=>canonicalJobIdentity({...spec,selector:{value:Infinity}}),/canonical/);
});
test('R1 scope refuses new towns, leading-zero loss, district prefixes and municipality/AGS mismatches',()=>{
  for(const sourceScope of [
    {...spec.sourceScope,municipalityId:'new-town'},
    {...spec.sourceScope,ags:'12064'},
    {...spec.sourceScope,municipalityId:'ratzeburg',ags:'1053100'},
    {...spec.sourceScope,municipalityId:'ratzeburg',ags:'12064472'},
    {...spec.sourceScope,municipalityId:'ruedersdorf',ags:'12064428'},
  ])assert.throws(()=>canonicalJobIdentity({...spec,sourceScope}));
});
test('all nine exact registry municipality IDs are admitted without compatibility aliases',()=>{
  assert.equal(Object.keys(R1_MUNICIPALITIES).length,9);
  assert.equal(R1_MUNICIPALITIES['ruedersdorf-bei-berlin'],'12064428');
  for(const [municipalityId,ags] of Object.entries(R1_MUNICIPALITIES))assert.match(canonicalJobIdentity({...spec,sourceScope:{...spec.sourceScope,municipalityId,ags}}).jobKey,/^[a-f0-9]{64}$/);
});
test('resource identities retain portal tenant/query selectors and strip only non-HTTP fragments',()=>{
  assert.equal(canonicalResourceIdentity('https://EXAMPLE.ORG:443/portal?tenant=12&item=7#page-2'),'https://example.org/portal?tenant=12&item=7');
  assert.notEqual(canonicalResourceIdentity('https://example.org/portal?tenant=12'),canonicalResourceIdentity('https://example.org/portal?tenant=13'));
  assert.notEqual(canonicalResourceIdentity('https://example.org/portal?a=1&a=2'),canonicalResourceIdentity('https://example.org/portal?a=2&a=1'));
  assert.throws(()=>canonicalResourceIdentity('https://user:secret@example.org/'),/rejected/);
  assert.throws(()=>canonicalResourceIdentity('file:///private/source.pdf'),/rejected/);
});
test('CLI never accepts shell or arbitrary module-loading flags',async()=>{
  await assert.rejects(runDistrictJobsCli({},['run','--shell','touch /tmp/not-executed']),/Unknown CLI flag/);
  await assert.rejects(runDistrictJobsCli({},['run','--handler-module','arbitrary.ts']),/Unknown CLI flag/);
});
