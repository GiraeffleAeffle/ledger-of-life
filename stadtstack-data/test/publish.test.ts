import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publicationInput,PublicationOptionsSchema,publish} from '../src/publish.ts';
import type {PublicationOptions} from '../src/publish.ts';
import {outDir} from '../src/common.ts';

const at='2026-10-11T09:25:14.000Z',manifestAt='2026-10-11T09:25:14.460Z';
const prerequisites={asOf:'2026-10-11',priorRelease:{gitCommit:'a'.repeat(40),manifestSha256:'b'.repeat(64),releaseId:'c'.repeat(64)},policyReceipts:'synthetic-policy-inventory.json',publicationInputs:'synthetic-publication-inputs.json',offlineReplay:true};
test('publication replay requires explicit quality and manifest clocks without overriding staged data clocks',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'stadtstack-publication-clock-'));
 try{
  const options:PublicationOptions={...prerequisites,stagingDir:join(directory,'staging'),outDir:join(directory,'release'),priorCityRoot:join(directory,'prior'),qualityGeneratedAt:at,manifestGeneratedAt:manifestAt};
  assert.deepEqual(PublicationOptionsSchema.parse(options),options);
  assert.throws(()=>PublicationOptionsSchema.parse({...options,qualityGeneratedAt:undefined}));
  assert.throws(()=>PublicationOptionsSchema.parse({...options,manifestGeneratedAt:'now'}));
  assert.throws(()=>PublicationOptionsSchema.parse({...options,asOf:undefined}));
  assert.throws(()=>PublicationOptionsSchema.parse({...options,priorRelease:undefined}));
  await mkdir(options.stagingDir);const catalogue={generatedAt:'2026-10-11T03:46:26.421Z',cities:[]};
  await writeFile(join(options.stagingDir,'catalogue.json'),JSON.stringify(catalogue));
  assert.deepEqual(await publicationInput('catalogue.json',options),catalogue);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('missing replay staging never falls back to released regional or knowledge members',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'stadtstack-publication-no-fallback-'));
 try{
  const options:PublicationOptions={...prerequisites,stagingDir:directory,outDir:join(directory,'release'),priorCityRoot:join(directory,'prior'),qualityGeneratedAt:at,manifestGeneratedAt:manifestAt};
  for(const path of ['regions/brandenburg-mol/topics.json','knowledge/registry.json','knowledge/records.json','knowledge/coverage.json'])await assert.rejects(publicationInput(path,options),{code:'ENOENT'});
  await assert.rejects(publish({...options,outDir}),/target output/);
  await assert.rejects(publish({...options,priorCityRoot:outDir}),/target output/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
