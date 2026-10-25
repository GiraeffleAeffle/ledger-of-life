import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {digest,canonicalJson} from '../src/district-adapter-contract.ts';
import {writeManagedSourceArtifact,type SourceArtifactBinding} from '../src/district-private-io.ts';
import {assertManagedSourceBindings,CIVIC_ACQUISITION_DECISION_ID} from '../src/civic-opt-out.ts';
import {normalizePublicationBindings} from '../src/publication-binding-normalization.ts';
import {assertPublicationPartition,authenticatePublicationPartition,partitionPublicationInputs,provenanceBytes,type PublicationInputPin} from '../src/publication-provenance-partition.ts';
import {readCrawlOperatorRegistryInputPin} from '../src/district-registry-config.ts';
import {createOperatorRegistryFixture,operatorRegistryFixtureValue,writeOperatorRegistryInputPin} from './helpers/operator-registry-fixture.ts';

const http=(label:string):SourceArtifactBinding=>({kind:'http_observation',url:'https://example.org/'+label,sourceSha256:digest(label),observationId:label,receiptSha256:digest(label+' receipt'),independentAllowed:true});
test('equivalent complete registry families reduce deterministically; non-equivalent families and every HTTP binding remain',async t=>{
 const fixture=await createOperatorRegistryFixture(t),old={...fixture.input,schemaContractSha256:digest('synthetic earlier complete codec')},oldPin=await writeOperatorRegistryInputPin(fixture.root,'old-codec',old);
 const processingPin=await writeOperatorRegistryInputPin(fixture.root,'current-codec',fixture.input),migration=await readCrawlOperatorRegistryInputPin({pin:oldPin},processingPin,fixture.policy);
 const otherValue=operatorRegistryFixtureValue();otherValue.notes.push('A genuinely different configuration');
 const other=await createOperatorRegistryFixture(t,{context:fixture,value:otherValue,label:'other-configuration'});
 const bindings:SourceArtifactBinding[]=[...migration.crawl.bindings,...migration.processing.bindings,...other.admitted.bindings,http('one'),http('two')];
 const normalized=normalizePublicationBindings(bindings);
 assert.deepEqual(normalizePublicationBindings([...bindings].reverse()),normalized);assert.deepEqual(normalizePublicationBindings(normalized),normalized);
 assert.equal(normalized.filter(binding=>binding.kind==='http_observation').length,2);
 assert.equal(normalized.filter(binding=>binding.kind==='operator_registry_config').length,migration.processing.bindings.length+other.admitted.bindings.length);
 // Pure representation test only: these altered endpoint descriptors are never
 // enrolled, authenticated or claimed as genuine configuration authority.
 const otherEndpoints=migration.processing.bindings.map(binding=>({...binding,url:'https://example.org/different-complete-endpoint',schemaContractSha256:digest('synthetic different endpoint family')}));
 assert.equal(normalizePublicationBindings([...migration.processing.bindings,...otherEndpoints]).length,migration.processing.bindings.length+otherEndpoints.length,'same configuration with different complete endpoint sets is not equivalent');
 const root=join(fixture.root,'derived'),path=join(root,'data.json'),bytes=Buffer.from('{"synthetic":true}');
 await writeManagedSourceArtifact(root,path,bytes,bindings,{...fixture.policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
 const before=await readFile(join(fixture.policy.stateDir!,'inventory.json'));
 await assertManagedSourceBindings(path,normalized,fixture.policy);
 await assert.rejects(assertManagedSourceBindings(path,normalized.filter(binding=>binding.kind!=='http_observation'),fixture.policy),{code:'CONTENT_PROVENANCE_MISMATCH'});
 await assert.rejects(assertManagedSourceBindings(path,normalized.filter(binding=>binding.kind!=='operator_registry_config'||binding.configurationSha256!==other.registrySha256),fixture.policy),{code:'CONTENT_PROVENANCE_MISMATCH'});
 assert.deepEqual(await readFile(path),bytes);assert.deepEqual(await readFile(join(fixture.policy.stateDir!,'inventory.json')),before,'normalization/authentication never rebind the existing blob');
});

test('partition is disjoint and exhaustive; unchanged Core refuses a missing binding',async t=>{
 const fixture=await createOperatorRegistryFixture(t),root=join(fixture.root,'partition-data'),bindings=[http('primary'),http('support')],pins:PublicationInputPin[]=[];
 for(const name of ['primary','stage']){const bytes=Buffer.from(JSON.stringify({synthetic:name})),path=join(root,name+'.json'),sha256=await writeManagedSourceArtifact(root,path,bytes,bindings,{...fixture.policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});pins.push({path,sha256,bytes:bytes.length,bindings});}
 const partition=partitionPublicationInputs(pins,[pins[1].path]);assertPublicationPartition(partition.primary,partition.staging,pins);
 assert.throws(()=>assertPublicationPartition(partition.primary,partition.staging,[...pins,{path:join(root,'missing.json'),sha256:digest('missing')}]),/missing from both/);
 assert.throws(()=>assertPublicationPartition(partition.primary,[...partition.staging,pins[0]],pins),/both inventories or twice/);
 const control=async(name:string,inputs:typeof pins)=>{const path=join(fixture.root,name+'.json'),bytes=provenanceBytes(inputs);await writeFile(path,bytes,{mode:0o600});return {path,sha256:digest(bytes)};};
 const primary=await control('primary-inventory',partition.primary),stage=await control('stage-inventory',partition.staging);
 const authenticated=await authenticatePublicationPartition(primary,stage,fixture.policy);authenticated.assertCoverage(pins);assert.equal((await authenticated.read(pins[0].path)).toString(),'{"synthetic":"primary"}');
 const duplicate=await control('duplicate-stage',[pins[0]]);await assert.rejects(authenticatePublicationPartition(primary,duplicate,fixture.policy),/both inventories or twice/);
 const missingBinding=await control('missing-binding',[{...pins[1],bindings:[bindings[0]]}]);await assert.rejects(authenticatePublicationPartition(primary,missingBinding,fixture.policy),{code:'CONTENT_PROVENANCE_MISMATCH'});
 assert.equal(canonicalJson(authenticated.inputs.map(pin=>pin.path).sort()),canonicalJson(pins.map(pin=>pin.path).sort()));
});
