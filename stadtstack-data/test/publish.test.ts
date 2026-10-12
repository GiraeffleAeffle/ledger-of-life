import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {publicationInput,PublicationOptionsSchema,publish} from '../src/publish.ts';
import type {PublicationOptions} from '../src/publish.ts';
import {outDir,hash} from '../src/common.ts';
import {writeManagedSourceArtifact} from '../src/district-private-io.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';

async function stagedFixture(directory:string,t:{after:(callback:()=>Promise<void>)=>void}){
 const context=await createCivicPolicyTestContext(t),stagingDir=join(context.managedRoot,'staging'),privateProvenance=join(directory,'private-provenance.json'),cataloguePath=join(stagingDir,'catalogue.json'),catalogueBytes=Buffer.from(JSON.stringify({generatedAt:'2026-10-11T03:46:26.421Z',cities:[]})),binding={kind:'prepared_source' as const,url:'https://example.org/synthetic-publication-input',sourceSha256:hash('synthetic source'),observationId:'synthetic-publication-input',receiptSha256:hash('synthetic receipt'),independentAllowed:true};
 await mkdir(stagingDir,{recursive:true});
 await writeManagedSourceArtifact(context.managedRoot,cataloguePath,catalogueBytes,[binding],{...context.policy,decisionId:context.decisionId,kind:'artifacts'});
 const inventory={schemaVersion:'stadtstack-private-publication-provenance-v1',inputs:[{path:relative(directory,cataloguePath),sha256:hash(catalogueBytes),bytes:catalogueBytes.length,bindings:[binding]}]};
 await writeFile(privateProvenance,JSON.stringify(inventory));
 return {stagingDir,privateProvenance:{path:privateProvenance,sha256:hash(JSON.stringify(inventory))},policyStateDir:context.policy.stateDir,policyAuthorityId:context.policy.authorityId,policyAuthoritySha256:context.policy.authoritySha256};
}

const at='2026-10-11T09:25:14.000Z',manifestAt='2026-10-11T09:25:14.460Z';
const prerequisites={asOf:'2026-10-11',priorRelease:{gitCommit:'a'.repeat(40),manifestSha256:'b'.repeat(64),releaseId:'c'.repeat(64)},policyReceipts:'synthetic-policy-inventory.json',publicationInputs:'synthetic-publication-inputs.json',offlineReplay:true};

test('publication replay requires explicit quality and manifest clocks without overriding staged data clocks',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'stadtstack-publication-clock-'));
 try{
  const custody=await stagedFixture(directory,t),options:PublicationOptions={...prerequisites,...custody,outDir:join(directory,'release'),priorCityRoot:join(directory,'prior'),qualityGeneratedAt:at,manifestGeneratedAt:manifestAt};
  assert.deepEqual(PublicationOptionsSchema.parse(options),options);
  assert.throws(()=>PublicationOptionsSchema.parse({...options,qualityGeneratedAt:undefined}));
  assert.throws(()=>PublicationOptionsSchema.parse({...options,manifestGeneratedAt:'now'}));
  assert.throws(()=>PublicationOptionsSchema.parse({...options,asOf:undefined}));
  assert.throws(()=>PublicationOptionsSchema.parse({...options,priorRelease:undefined}));
  assert.throws(()=>PublicationOptionsSchema.parse(({privateProvenance:_unused,...options})),/privateProvenance/);
  assert.deepEqual(await publicationInput('catalogue.json',options),{generatedAt:'2026-10-11T03:46:26.421Z',cities:[]});
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('missing replay staging never falls back to released regional or knowledge members',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'stadtstack-publication-no-fallback-'));
 try{
  const custody=await stagedFixture(directory,t),options:PublicationOptions={...prerequisites,...custody,outDir:join(directory,'release'),priorCityRoot:join(directory,'prior'),qualityGeneratedAt:at,manifestGeneratedAt:manifestAt};
  for(const path of ['regions/brandenburg-mol/topics.json','knowledge/registry.json','knowledge/records.json','knowledge/coverage.json'])await assert.rejects(publicationInput(path,options),{code:'ENOENT'});
  await assert.rejects(publish({...options,outDir}),/target output/);
  await assert.rejects(publish({...options,priorCityRoot:outDir}),/target output/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
