import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fsPromises,{writeFile,readFile,lstat} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {sha256} from '../src/district-schema.ts';
import {CIVIC_ACQUISITION_DECISION_ID,recordHostOptOut,HostOptedOutError,CivicPolicyStateError,withManagedSourceScratch,assertManagedSourceBindings} from '../src/civic-opt-out.ts';
import {buildOperatorRegistryConfigDescriptor,operatorRegistryConfigSchema,operatorRegistryConfigSourcePinSchema,operatorRegistryConfigBindingSchema,readOperatorRegistryConfig,importOperatorRegistryConfig,readOperatorRegistryConfigSourcePin,parseOperatorRegistryConfiguration,operatorRegistryInputPinSchema,readOperatorRegistryInputPin} from '../src/district-registry-config.ts';
import {districtR1Cli} from '../src/district-r1.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {createOperatorRegistryFixture,operatorRegistryFixtureValue,registryDescriptor,writeOperatorRegistryInputPin} from './helpers/operator-registry-fixture.ts';
import {knowledgePreparedSourcePinSchema} from '../src/prepare-knowledge.ts';
import {privatePublicationProvenanceSchema} from '../src/district-publication-provenance.ts';
const execFileAsync=promisify(execFile);
async function rawFixture(t:TestContext,value:unknown=operatorRegistryFixtureValue()){
 const context=await createCivicPolicyTestContext(t),input=await registryDescriptor(context,value);
 return {...context,input,value,body:Buffer.from(JSON.stringify(value)+'\n'),managedRoot:join(context.root,'managed-config')};
}
function targetOpenObserver(t:TestContext,target:string){
 const original=fsPromises.open;let calls=0;
 const observer=t.mock.method(fsPromises,'open',(...args:unknown[])=>{
  if(String(args[0])===target)calls++;
  return Reflect.apply(original,fsPromises,args);
 });
 syncBuiltinESMExports();t.after(()=>{observer.mock.restore();syncBuiltinESMExports();});
 return {get calls(){return calls;}};
}

test('Git-authenticated owner configuration imports exact managed bytes without source observation or network',async t=>{
 const network=t.mock.method(globalThis,'fetch',async()=>{throw Error('Configuration intake must remain offline');}),f=await createOperatorRegistryFixture(t);
 const read=await readOperatorRegistryConfig(f.input,f.policy);
 assert.deepEqual(read.registry,f.value);assert.deepEqual(read.bytes,f.body);
 assert.deepEqual((await readOperatorRegistryConfigSourcePin(f.sourcePin,f.policy)).bytes,f.body);
 assert.deepEqual(f.admitted.registry,f.value);assert.deepEqual(f.admitted.bytes,f.body);assert.deepEqual(f.admitted.bindings,f.sourcePin.bindings);
 assert.equal(f.sourcePin.sha256,sha256(f.body));assert.equal(f.sourcePin.bytes,f.body.length);
 assert.equal(operatorRegistryConfigSchema.safeParse(f.input).success,true);
 assert.equal(operatorRegistryConfigSourcePinSchema.safeParse(f.sourcePin).success,true);
 assert.equal(knowledgePreparedSourcePinSchema.safeParse(f.sourcePin).success,false,'configuration is not prepared claim admission');
 assert.equal(privatePublicationProvenanceSchema.safeParse({schemaVersion:'stadtstack-private-publication-provenance-v1',inputs:[{path:f.sourcePin.path,sha256:f.sourcePin.sha256,bytes:f.sourcePin.bytes,bindings:f.sourcePin.bindings}]}).success,true);
 await assertManagedSourceBindings(f.sourcePin.path,f.sourcePin.bindings,f.policy);
 await assertManagedSourceBindings(f.sourcePin.path,f.sourcePin.bindings,f.policy,'operator_registry_config');
 for(const binding of f.sourcePin.bindings){
  assert.equal(binding.kind,'operator_registry_config');assert.equal(binding.configurationSha256,sha256(f.body));assert.equal(binding.independentAllowed,false);
  assert.deepEqual(binding.code,f.input.code);assert.deepEqual(binding.approval,f.input.approval);
  for(const field of ['sourceSha256','observationId','receiptSha256','publication','purpose'])assert.equal(field in binding,false);
 }
 let native=false;
 await assert.rejects(withManagedSourceScratch(f.managedRoot,f.sourcePin.bindings.map(({independentAllowed:_flag,...binding})=>binding),async()=>{native=true;},{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',purpose:'openai',...f.policy}));
 assert.equal(native,false);assert.equal(network.mock.callCount(),0);
});

test('changed registry bytes cannot retain their byte pin or reuse the original committed blob',async t=>{
 for(const replacePins of [false,true]){
  const f=await rawFixture(t),changed=Buffer.from(JSON.stringify({...operatorRegistryFixtureValue(),notes:['Different uncommitted operator text']})+'\n');
  await writeFile(f.input.path,changed);
  const input=structuredClone(f.input);
  if(replacePins){input.sha256=sha256(changed);input.bytes=changed.length;input.code.sha256=input.sha256;input.code.bytes=input.bytes;input.approval.configurationSha256=input.sha256;}
  await assert.rejects(importOperatorRegistryConfig({...input,managedRoot:f.managedRoot,destinationPath:'registry.json'},f.policy));
  await assert.rejects(lstat(f.managedRoot),{code:'ENOENT'});
 }
});

test('commit and tree object bodies must authenticate their real OIDs and complete the committed path',async t=>{
 for(const failure of ['commit-bytes','commit-oid','tree-bytes','tree-oid','missing-tree','foreign-tree'] as const){
  const f=await rawFixture(t),input=structuredClone(f.input);
  if(failure==='commit-bytes'||failure==='tree-bytes'){
   const pin=failure==='commit-bytes'?input.commit:input.trees[0],changed=Buffer.concat([await readFile(pin.path),Buffer.from('altered')]);
   await writeFile(pin.path,changed);pin.sha256=sha256(changed);pin.bytes=changed.length;
  }
  if(failure==='commit-oid'){input.commit.oid=sha256('another commit').slice(0,40);input.code.gitCommit=input.commit.oid;input.approval.gitCommit=input.commit.oid;}
  if(failure==='tree-oid')input.trees[0].oid=sha256('another tree').slice(0,40);
  if(failure==='missing-tree')input.trees.pop();
  if(failure==='foreign-tree'){
   const foreign=await registryDescriptor(f,{...operatorRegistryFixtureValue(),notes:['A separate real Git tree']},'foreign-code');
   input.trees[0]=foreign.trees[0];
  }
  await assert.rejects(importOperatorRegistryConfig({...input,managedRoot:f.managedRoot,destinationPath:'registry.json'},f.policy));
  await assert.rejects(lstat(f.managedRoot),{code:'ENOENT'});
 }
});

test('bounded closed registry codec rejects unknown fields, copied bodies and unsafe metadata',async t=>{
 const bodies:unknown[]=[
  {...operatorRegistryFixtureValue(),records:[{summary:'cannot enter via config'}]},
  {...operatorRegistryFixtureValue(),modelResponse:{text:'forbidden'}},
  {...operatorRegistryFixtureValue(),notes:['x'.repeat(1025)]},
  {...operatorRegistryFixtureValue(),notes:['<html><body>Copied body</body></html>']},
  {...operatorRegistryFixtureValue(),unrecognizedConfiguration:true},
 ];
 const longEvidence=operatorRegistryFixtureValue();longEvidence.municipalities[0].identitySources[0].locator='x'.repeat(601);bodies.push(longEvidence);
 const nested=operatorRegistryFixtureValue();nested.municipalities[0].sources[0].api={url:'https://example.org/api',method:'POST',format:'diplan-list',form:{body:'Source bodies cannot hide in request metadata'}};bodies.push(nested);
 for(const value of bodies){
  assert.throws(()=>parseOperatorRegistryConfiguration(value));
  const f=await createCivicPolicyTestContext(t);
  await assert.rejects(registryDescriptor(f,value),'The canonical builder must refuse invalid committed metadata before it can become an intake descriptor');
  await assert.rejects(lstat(join(f.root,'managed-config')),{code:'ENOENT'});
 }
 const unsafe=operatorRegistryFixtureValue();unsafe.municipalities[0].sources[0].url='http://localhost/private';assert.throws(()=>parseOperatorRegistryConfiguration(unsafe));
});

test('owner approval role, configuration and commit must match the exact code descriptor',async t=>{
 const f=await rawFixture(t);
 const invalid=[
  {...f.input,approval:{...f.input.approval,configurationSha256:sha256('not approved')}},
  {...f.input,approval:{...f.input.approval,gitCommit:sha256('not approved commit').slice(0,40)}},
  {...f.input,approval:{...f.input.approval,role:'model_admission'}},
  {...f.input,approval:{...f.input.approval,approver:'unapproved'}},
  {...f.input,approval:{...f.input.approval,decisionId:'not-owner-decision'}},
  {...f.input,code:{...f.input.code,path:'stadtstack-data/cache/source-body.json'}},
  {...f.input,commit:{...f.input.commit,oid:sha256('another commit').slice(0,40)}},
  {...f.input,code:{...f.input.code,sha256:sha256('different code bytes')}},
 ];
 for(const raw of invalid){
  assert.equal(operatorRegistryConfigSchema.safeParse(raw).success,false);
  await assert.rejects(readOperatorRegistryConfig(raw as typeof f.input,f.policy));
 }
 const read=await readOperatorRegistryConfig(f.input,f.policy);
 assert.equal(operatorRegistryConfigBindingSchema.safeParse({...read.bindings[0],sourceSha256:sha256('fake source')}).success,false);
});

test('codec contracts and declared endpoints cannot omit or add registry authority',async t=>{
 for(const failure of ['contract','missing-endpoint','extra-endpoint','duplicate-endpoint'] as const){
  const value=operatorRegistryFixtureValue();value.municipalities[0].sources[0].url='https://another.example.org/configured';
  const f=await rawFixture(t,value);
  if(failure==='contract')f.input.schemaContractSha256=sha256('old codec');
  if(failure==='missing-endpoint')f.input.declaredEndpoints.pop();
  if(failure==='extra-endpoint')f.input.declaredEndpoints.push('https://example.org/not-configured');
  if(failure==='duplicate-endpoint')f.input.declaredEndpoints.push(f.input.declaredEndpoints[0]);
  assert.equal(operatorRegistryConfigSchema.safeParse(f.input).success,true);
  await assert.rejects(importOperatorRegistryConfig({...f.input,managedRoot:f.managedRoot,destinationPath:'registry.json'},f.policy));
  await assert.rejects(lstat(f.managedRoot),{code:'ENOENT'});
 }
});

test('current endpoint objections gate before code reads and purge managed copies but not the Git input',async t=>{
 const blocked=await rawFixture(t);
 await recordHostOptOut({host:'example.org',reason:'municipality_objection',reference:'synthetic-config-block'},blocked.policy);
 blocked.input.path=join(blocked.root,'missing-code-proves-pre-read-gate');
 await assert.rejects(readOperatorRegistryConfig(blocked.input,blocked.policy),HostOptedOutError);
 const f=await createOperatorRegistryFixture(t),objection=await recordHostOptOut({host:'example.org',reason:'rights_holder_objection',reference:'synthetic-config-purge'},f.policy);
 assert.equal(objection.purge.status,'purged');await assert.rejects(lstat(f.sourcePin.path),{code:'ENOENT'});assert.deepEqual(await readFile(f.input.path),f.body);
 await assert.rejects(readOperatorRegistryConfigSourcePin(f.sourcePin,f.policy),HostOptedOutError);
});

test('input descriptor pins admit real Git descriptors and exact managed operator pins',async t=>{
 const f=await createOperatorRegistryFixture(t),rawPin=await writeOperatorRegistryInputPin(f.root,'raw-operator-descriptor',f.input);
 const raw=await readOperatorRegistryInputPin(rawPin,f.policy);
 assert.deepEqual(raw.registry,f.value);assert.deepEqual(raw.bytes,f.body);assert.ok(raw.bindings.every(binding=>binding.kind==='operator_registry_config'));
 const managed=await readOperatorRegistryInputPin(f.registryPin,f.policy);
 assert.deepEqual(managed.registry,f.value);assert.deepEqual(managed.bytes,f.body);assert.deepEqual(managed.bindings,f.sourcePin.bindings);
});

test('missing pins and bare registry data cannot bypass descriptor admission',async t=>{
 const f=await createOperatorRegistryFixture(t);
 for(const input of [undefined,null,{},'sources/district-registry.json',{path:f.input.path},{sha256:f.input.sha256},{path:'',sha256:f.input.sha256}])assert.equal(operatorRegistryInputPinSchema.safeParse(input).success,false);
 await assert.rejects(readOperatorRegistryInputPin({path:join(f.root,'missing-descriptor.json'),sha256:f.input.sha256},f.policy),{code:'ENOENT'});
 await assert.rejects(readOperatorRegistryInputPin({path:f.input.path,sha256:f.input.sha256},f.policy));
 const malformed=await writeOperatorRegistryInputPin(f.root,'path-only-descriptor',{path:f.input.path,sha256:f.input.sha256});
 await assert.rejects(readOperatorRegistryInputPin(malformed,f.policy));assert.deepEqual(await readFile(f.input.path),f.body);
});

test('descriptor digest and policy authority are checked before controlled Git access',async t=>{
 const f=await rawFixture(t),descriptor=await writeOperatorRegistryInputPin(f.root,'pinned-descriptor',f.input),observed=targetOpenObserver(t,f.input.path);
 await assert.rejects(readOperatorRegistryInputPin({...descriptor,sha256:sha256('wrong descriptor digest')},f.policy));assert.equal(observed.calls,0);
 const unavailable={path:join(f.root,'missing-descriptor-with-wrong-authority.json'),sha256:descriptor.sha256};
 await assert.rejects(readOperatorRegistryInputPin(unavailable,{...f.policy,authoritySha256:sha256('wrong authority')}),error=>error instanceof CivicPolicyStateError&&error.code.startsWith('CIVIC_POLICY_AUTHORITY_'));
 assert.equal(observed.calls,0);
});

test('revoked managed and Git descriptors do not open purged or absent configuration bytes',async t=>{
 const f=await createOperatorRegistryFixture(t);
 await recordHostOptOut({host:'example.org',reason:'municipality_objection',reference:'synthetic-native-config-revocation'},f.policy);
 await assert.rejects(lstat(f.sourcePin.path),{code:'ENOENT'});
 const observed=targetOpenObserver(t,f.sourcePin.path);
 await assert.rejects(readOperatorRegistryInputPin(f.registryPin,f.policy),HostOptedOutError);assert.equal(observed.calls,0);
 const missingGit={...f.input,path:join(f.root,'unavailable-config-body.json')},raw=await writeOperatorRegistryInputPin(f.root,'revoked-git-descriptor',missingGit);
 await assert.rejects(readOperatorRegistryInputPin(raw,f.policy),HostOptedOutError);await assert.rejects(lstat(missingGit.path),{code:'ENOENT'});
});

test('forged managed configuration bindings reject before decoding registry data',async t=>{
 const f=await createOperatorRegistryFixture(t),forged=structuredClone(f.sourcePin);
 forged.bindings[0].code.gitCommit=sha256('foreign fixture commit').slice(0,40);forged.bindings[0].approval.gitCommit=forged.bindings[0].code.gitCommit;
 const descriptor=await writeOperatorRegistryInputPin(f.root,'wrong-managed-binding-descriptor',forged),nativeParse=JSON.parse,body=f.body.toString('utf8');let registryDecodes=0;
 t.mock.method(JSON,'parse',(...args:unknown[])=>{if(args[0]===body)registryDecodes++;return Reflect.apply(nativeParse,JSON,args);});
 await assert.rejects(readOperatorRegistryInputPin(descriptor,f.policy),error=>error instanceof CivicPolicyStateError&&error.code==='CONTENT_PROVENANCE_MISMATCH');
 assert.equal(registryDecodes,0);assert.deepEqual(await readFile(f.sourcePin.path),f.body);
});
test('canonical builder pins committed bytes and admits its schema-valid descriptor under fixture authority',async t=>{
 const f=await rawFixture(t),repository=join(f.root,'registry-code','repository'),commit=f.input.code.gitCommit,output=join(f.root,'canonical-builder');
 const built=await buildOperatorRegistryConfigDescriptor({repository,commit,outputDirectory:output});
 assert.deepEqual(operatorRegistryConfigSchema.parse(built.descriptor),built.descriptor);
 assert.deepEqual((await readOperatorRegistryConfig(built.descriptor,f.policy)).bytes,f.body);
 await writeFile(join(repository,'stadtstack-data/sources/district-registry.json'),Buffer.from('{"worktree":"changed"}\n'));
 const after=await buildOperatorRegistryConfigDescriptor({repository,commit,outputDirectory:join(f.root,'after-worktree-change')});
 assert.equal(after.descriptor.sha256,built.descriptor.sha256);assert.deepEqual(await readFile(after.descriptor.path),f.body);
 await assert.rejects(buildOperatorRegistryConfigDescriptor({repository,commit,outputDirectory:output}));
 const tampered=structuredClone(built.descriptor);await writeFile(tampered.commit.path,Buffer.from('tampered'));
 await assert.rejects(readOperatorRegistryConfig(tampered,f.policy));
 await execFileAsync('/usr/bin/git',['-c','user.name=Fixture','-c','user.email=fixture@example.test','checkout','--orphan','without-registry'],{cwd:repository});
 // Orphan checkout retains the old index; explicitly empty this isolated fixture's index.
 await execFileAsync('/usr/bin/git',['read-tree','--empty'],{cwd:repository});
 await execFileAsync('/usr/bin/git',['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--allow-empty','-m','No registry path'],{cwd:repository});
 const missing=(await execFileAsync('/usr/bin/git',['rev-parse','HEAD'],{cwd:repository})).stdout.trim();
 await assert.rejects(buildOperatorRegistryConfigDescriptor({repository,commit:missing,outputDirectory:join(f.root,'missing-registry-path')}));
});

test('registry-descriptor CLI validates flags and confines output to the operator cache',async()=>{
 for(const args of [[],['--commit','abc'],['--commit','a','--output','x','--commit','b'],['--commit','a','--output','x','--other']])
  await assert.rejects(districtR1Cli(['registry-descriptor',...args]));
 await assert.rejects(districtR1Cli(['registry-descriptor','--commit','a'.repeat(40),'--output','/tmp/out']));
});
