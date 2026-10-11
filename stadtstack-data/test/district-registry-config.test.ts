import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fsPromises,{mkdir,writeFile,readFile,lstat} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {sha256} from '../src/district-schema.ts';
import {retainedPublicationSources} from '../src/district-retained-import.ts';
import {CIVIC_ACQUISITION_DECISION_ID,recordHostOptOut,HostOptedOutError,CivicPolicyStateError,withManagedSourceScratch,assertManagedSourceBindings} from '../src/civic-opt-out.ts';
import {operatorRegistryConfigSchema,operatorRegistryConfigBindingSchema,operatorRegistryConfigContractSha256,readOperatorRegistryConfig,importOperatorRegistryConfig,readOperatorRegistryConfigSourcePin,parseOperatorRegistryConfiguration,operatorRegistryInputPinSchema,readOperatorRegistryInputPin} from '../src/district-registry-config.ts';
import type {OperatorRegistryConfig} from '../src/district-registry-config.ts';
import {knowledgeSourcePinSchema,knowledgePreparedSourcePinSchema,knowledgeRegistryInputSchema} from '../src/prepare-knowledge.ts';

const at='2026-10-11T12:00:00.000Z',url='https://example.org/configured-source';
function registryValue(){
 const evidence={url,locator:'Synthetic operator registry reference',sha256:sha256('synthetic source reference'),retrievedAt:at};
 return {schemaVersion:'stadtstack-source-registry-v1',generatedAt:at,districts:[{id:'synthetic-district',name:'Synthetic district',ags:'12064',state:'Brandenburg',inventorySources:[evidence],inventoryAsOf:'2026-10-11',inventoryComplete:true}],municipalities:[{id:'synthetic-town',name:'Synthetic town',ags:'12064001',districtId:'synthetic-district',districtAgs:'12064',amt:null,administrativeStatus:'amtsfrei',administrativeEvidence:[evidence],identitySources:[evidence],sources:['website','council','participation','gazette'].map(kind=>({id:kind,kind,url,vendor:'unknown',checkState:'not_checked',checkedAt:null,evidence:[],reason:'Synthetic configured endpoint, not an observed request'})),seedDocuments:[{url,sourceId:'website',title:'Synthetic seed',documentDate:null,dateReason:'No source date asserted',evidence:[evidence]}]}],inventory:[{ags:'12064001',name:'Synthetic town',districtId:'synthetic-district',identitySourceUrl:url,pilot:true,sourceCheckState:'not_checked',reason:'Synthetic operator configuration'}],notes:['Synthetic configuration, not source text or model evidence']};
}
function oid(kind:'blob'|'tree'|'commit',bytes:Buffer){return createHash('sha1').update(kind+' '+bytes.length+'\0').update(bytes).digest('hex');}
function entry(name:string,object:string,mode='40000'){return Buffer.concat([Buffer.from(mode+' '+name+'\0'),Buffer.from(object,'hex')]);}
async function fixture(t:TestContext,value:unknown=registryValue()){
 const authority=await createCivicPolicyTestContext(t),root=join(authority.root,'operator-code');await mkdir(root,{mode:0o700});
 const body=Buffer.from(JSON.stringify(value)+'\n'),path=join(root,'district-registry.json'),blobOid=oid('blob',body);await writeFile(path,body,{mode:0o600});
 const store=async(kind:'tree'|'commit',bytes:Buffer)=>{const object=oid(kind,bytes),path=join(root,kind+'-'+object+'.bin');await writeFile(path,bytes,{mode:0o600});return {path,oid:object,sha256:sha256(bytes),bytes:bytes.length};};
 const leaf=await store('tree',entry('district-registry.json',blobOid,'100644')),middle=await store('tree',entry('sources',leaf.oid)),tree=await store('tree',entry('stadtstack-data',middle.oid));
 const commit=await store('commit',Buffer.from(`tree ${tree.oid}\nauthor Synthetic Fixture <fixture@example.test> 0 +0000\ncommitter Synthetic Fixture <fixture@example.test> 0 +0000\n\nSynthetic operator configuration proof\n`));
 const input:OperatorRegistryConfig=operatorRegistryConfigSchema.parse({kind:'operator_registry_config',path,sha256:sha256(body),bytes:body.length,schemaContractSha256:await operatorRegistryConfigContractSha256(),code:{gitCommit:commit.oid,path:'stadtstack-data/sources/district-registry.json',blobOid,sha256:sha256(body),bytes:body.length},approval:{role:'district_source_registry',approver:'owner',decisionId:CIVIC_ACQUISITION_DECISION_ID,date:'2026-10-11',configurationSha256:sha256(body),gitCommit:commit.oid},commit,trees:[leaf,middle,tree],declaredEndpoints:[...new Set(retainedPublicationSources(value).map(source=>source.url))]});
 return {...authority,input,body,value,managedRoot:join(authority.root,'managed-config')};
}

async function inputDescriptor(root:string,name:string,value:unknown){
 const path=join(root,name+'.json'),bytes=JSON.stringify(value)+'\n';
 await writeFile(path,bytes,{mode:0o600});return {path,sha256:sha256(bytes)};
}
function targetOpenObserver(t:TestContext,target:string){
 const original=fsPromises.open;let calls=0;
 const observer=t.mock.method(fsPromises,'open',(...args:unknown[])=>{
  if(String(args[0])===target)calls++;
  return Reflect.apply(original,fsPromises,args);
 });
 syncBuiltinESMExports();
 t.after(()=>{observer.mock.restore();syncBuiltinESMExports();});
 return {get calls(){return calls;}};
}

test('operator registry bootstrap authenticates code and role approval without pretending to be source observation',async t=>{
 const f=await fixture(t),network=t.mock.method(globalThis,'fetch',async()=>{throw Error('Configuration intake is offline');});
 const read=await readOperatorRegistryConfig(f.input,f.policy);assert.deepEqual(read.registry,f.value);assert.deepEqual(read.bytes,f.body);
 const pin=await importOperatorRegistryConfig({...f.input,managedRoot:f.managedRoot,destinationPath:'registry.json'},f.policy);
 assert.deepEqual((await readOperatorRegistryConfigSourcePin(pin,f.policy)).bytes,f.body);
 await assertManagedSourceBindings(pin.path,pin.bindings,f.policy);
 assert.equal(knowledgeRegistryInputSchema.safeParse(f.input).success,true);assert.equal(knowledgeSourcePinSchema.safeParse(pin).success,true);
 assert.equal(knowledgePreparedSourcePinSchema.safeParse(pin).success,false,'configuration is not prepared source admission');
 for(const binding of pin.bindings){assert.equal(binding.kind,'operator_registry_config');assert.equal(binding.configurationSha256,sha256(f.body));assert.equal(binding.independentAllowed,false);assert.equal('sourceSha256' in binding,false);assert.equal('observationId' in binding,false);assert.equal('receiptSha256' in binding,false);assert.equal('publication' in binding,false);assert.equal('purpose' in binding,false);}
 let native=false;
 await assert.rejects(withManagedSourceScratch(f.managedRoot,pin.bindings.map(({independentAllowed:_flag,...binding})=>binding),async()=>{native=true;},{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',purpose:'openai',...f.policy}));
 assert.equal(native,false);assert.equal(network.mock.callCount(),0);
});

test('uncommitted bytes cannot use an older Git tree or silently replace the approved code hash',async t=>{
 const f=await fixture(t),changed=Buffer.from(JSON.stringify({...registryValue(),notes:['Different uncommitted operator text']})+'\n');
 await writeFile(f.input.path,changed);
 const input=structuredClone(f.input);input.sha256=sha256(changed);input.bytes=changed.length;input.code.sha256=input.sha256;input.code.bytes=input.bytes;input.approval.configurationSha256=input.sha256;
 await assert.rejects(importOperatorRegistryConfig({...input,managedRoot:f.managedRoot,destinationPath:'registry.json'},f.policy),/Git blob OID mismatch/);
 await assert.rejects(lstat(f.managedRoot),{code:'ENOENT'});
});

test('closed bounded configuration codec rejects unknown body/model fields and unsafe policy metadata',async t=>{
 const bodies=[{...registryValue(),records:[{summary:'must not enter via config'}]},{...registryValue(),modelResponse:{text:'forbidden'}},{...registryValue(),notes:['x'.repeat(1025)]},{...registryValue(),notes:['<html><body>Copied body</body></html>']}];
 const longEvidence=registryValue();longEvidence.municipalities[0].identitySources[0].locator='x'.repeat(601);bodies.push(longEvidence);
 const nestedPayload=registryValue();bodies.push({...nestedPayload,municipalities:nestedPayload.municipalities.map(city=>({...city,sources:city.sources.map((source,index)=>index===0?{...source,api:{url,method:'POST',format:'diplan-list',form:{body:'A source body must not hide in dynamic request metadata'}}}:source)}))});
 for(const value of bodies){
  assert.throws(()=>parseOperatorRegistryConfiguration(value));
  const f=await fixture(t,value);await assert.rejects(importOperatorRegistryConfig({...f.input,managedRoot:f.managedRoot,destinationPath:'registry.json'},f.policy));
  await assert.rejects(lstat(f.managedRoot),{code:'ENOENT'});
 }
 const unsafe=registryValue();unsafe.municipalities[0].sources[0].url='http://localhost/private';assert.throws(()=>parseOperatorRegistryConfiguration(unsafe));
});

test('source registry approval, declared endpoints and codec code pins must all match',async t=>{
 for(const failure of ['approval','role','contract','missing-endpoint','extra-endpoint','wrong-code-path'] as const){
  const f=await fixture(t);
  if(failure==='approval')f.input.approval.configurationSha256=sha256('not approved');
  if(failure==='contract')f.input.schemaContractSha256=sha256('old codec');
  if(failure==='missing-endpoint')f.input.declaredEndpoints=[];
  if(failure==='extra-endpoint')f.input.declaredEndpoints.push('https://example.org/not-configured');
  const raw=failure==='role'?{...f.input,approval:{...f.input.approval,role:'model_admission'}}:failure==='wrong-code-path'?{...f.input,code:{...f.input.code,path:'stadtstack-data/cache/source-body.json'}}:f.input;
  assert.equal(operatorRegistryConfigSchema.safeParse(raw).success,failure==='contract'||failure==='extra-endpoint');
  if(failure==='contract'||failure==='extra-endpoint')await assert.rejects(readOperatorRegistryConfig(f.input,f.policy));
 }
 const f=await fixture(t),read=await readOperatorRegistryConfig(f.input,f.policy);
 assert.equal(operatorRegistryConfigBindingSchema.safeParse({...read.bindings[0],sourceSha256:sha256('fake source')}).success,false);
});

test('current objections gate before config reads and purge managed control copies without modifying code',async t=>{
 const blocked=await fixture(t);await recordHostOptOut({host:'example.org',reason:'municipality_objection',reference:'synthetic-config-block'},blocked.policy);blocked.input.path=join(blocked.root,'missing-code-proves-pre-read-gate');
 await assert.rejects(readOperatorRegistryConfig(blocked.input,blocked.policy),HostOptedOutError);
 const f=await fixture(t),pin=await importOperatorRegistryConfig({...f.input,managedRoot:f.managedRoot,destinationPath:'registry.json'},f.policy);
 const objection=await recordHostOptOut({host:'example.org',reason:'rights_holder_objection',reference:'synthetic-config-purge'},f.policy);
 assert.equal(objection.purge.status,'purged');await assert.rejects(lstat(pin.path),{code:'ENOENT'});assert.deepEqual(await readFile(f.input.path),f.body);
 await assert.rejects(readOperatorRegistryConfigSourcePin(pin,f.policy),HostOptedOutError);
});

test('native registry input pins admit only authenticated Git descriptors or exact managed operator pins',async t=>{
 const f=await fixture(t),rawDescriptor=await inputDescriptor(f.root,'raw-operator-descriptor',f.input);
 const raw=await readOperatorRegistryInputPin(rawDescriptor,f.policy);
 assert.deepEqual(raw.registry,f.value);assert.deepEqual(raw.bytes,f.body);assert.ok(raw.bindings.every(binding=>binding.kind==='operator_registry_config'));
 const managed=await importOperatorRegistryConfig({...f.input,managedRoot:f.managedRoot,destinationPath:'registry.json'},f.policy);
 const managedDescriptor=await inputDescriptor(f.root,'managed-operator-descriptor',managed);
 const admitted=await readOperatorRegistryInputPin(managedDescriptor,f.policy);
 assert.deepEqual(admitted.registry,f.value);assert.deepEqual(admitted.bytes,f.body);assert.deepEqual(admitted.bindings,managed.bindings);
});

test('missing/default input pins and bare registry JSON cannot bypass native registry descriptor admission',async t=>{
 const f=await fixture(t);
 for(const input of [undefined,null,{},'sources/district-registry.json',{path:f.input.path},{sha256:f.input.sha256},{path:'',sha256:f.input.sha256}])assert.equal(operatorRegistryInputPinSchema.safeParse(input).success,false);
 await assert.rejects(readOperatorRegistryInputPin({path:join(f.root,'missing-explicit-descriptor.json'),sha256:f.input.sha256},f.policy),{code:'ENOENT'});
 await assert.rejects(readOperatorRegistryInputPin({path:f.input.path,sha256:f.input.sha256},f.policy));
 const malformed=await inputDescriptor(f.root,'path-only-descriptor',{path:f.input.path,sha256:f.input.sha256});
 await assert.rejects(readOperatorRegistryInputPin(malformed,f.policy));
 assert.deepEqual(await readFile(f.input.path),f.body);
});

test('outer registry descriptor digest and authority are checked before controlled source access',async t=>{
 const f=await fixture(t),descriptor=await inputDescriptor(f.root,'pinned-descriptor',f.input),observed=targetOpenObserver(t,f.input.path);
 await assert.rejects(readOperatorRegistryInputPin({...descriptor,sha256:sha256('wrong descriptor digest')},f.policy),/byte binding mismatch/);
 assert.equal(observed.calls,0);
 const unavailable={path:join(f.root,'missing-descriptor-with-wrong-authority.json'),sha256:descriptor.sha256};
 await assert.rejects(readOperatorRegistryInputPin(unavailable,{...f.policy,authoritySha256:sha256('wrong actual authority')}),error=>error instanceof CivicPolicyStateError&&error.code.startsWith('CIVIC_POLICY_AUTHORITY_'));
 assert.equal(observed.calls,0);
});

test('revoked native registry descriptors cannot open managed or absent controlled Git data',async t=>{
 const f=await fixture(t),managed=await importOperatorRegistryConfig({...f.input,managedRoot:f.managedRoot,destinationPath:'registry.json'},f.policy);
 const descriptor=await inputDescriptor(f.root,'revoked-managed-descriptor',managed);
 await recordHostOptOut({host:'example.org',reason:'municipality_objection',reference:'synthetic-native-config-revocation'},f.policy);
 await assert.rejects(lstat(managed.path),{code:'ENOENT'});
 const observed=targetOpenObserver(t,managed.path);
 await assert.rejects(readOperatorRegistryInputPin(descriptor,f.policy),HostOptedOutError);
 assert.equal(observed.calls,0);
 const missingGit={...f.input,path:join(f.root,'unavailable-config-body.json')},raw=await inputDescriptor(f.root,'revoked-git-descriptor',missingGit);
 await assert.rejects(readOperatorRegistryInputPin(raw,f.policy),HostOptedOutError);
 await assert.rejects(lstat(missingGit.path),{code:'ENOENT'});
});

test('a forged managed configuration tuple fails before role-specific registry decode or admission',async t=>{
 const f=await fixture(t),managed=await importOperatorRegistryConfig({...f.input,managedRoot:f.managedRoot,destinationPath:'registry.json'},f.policy);
 const forged=structuredClone(managed);
 forged.bindings[0].code.gitCommit='f'.repeat(40);forged.bindings[0].approval.gitCommit='f'.repeat(40);
 const descriptor=await inputDescriptor(f.root,'wrong-managed-binding-descriptor',forged),nativeParse=JSON.parse,body=f.body.toString('utf8');
 let registryDecodes=0;
 // Permission/byte hashing still runs normally; observe only the exact registry payload decoder.
 t.mock.method(JSON,'parse',(...args:unknown[])=>{
  if(args[0]===body)registryDecodes++;
  return Reflect.apply(nativeParse,JSON,args);
 });
 await assert.rejects(readOperatorRegistryInputPin(descriptor,f.policy),error=>error instanceof CivicPolicyStateError&&error.code==='CONTENT_PROVENANCE_MISMATCH');
 assert.equal(registryDecodes,0);assert.deepEqual(await readFile(managed.path),f.body);
});
