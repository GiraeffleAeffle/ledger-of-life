import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareKnowledge} from '../src/prepare-knowledge.ts';
import {PILOT_COMPLETION_CORPUS_SHA256} from '../src/district-corpus.ts';
import {root,hash} from '../src/common.ts';

const at='2026-10-10T12:00:00.000Z';
test('importable knowledge preparation retains the mandatory district acceptance gate',async()=>{
 for(const minimum of [0,-1,1.5,NaN])await assert.rejects(prepareKnowledge({registry:'not-read',index:'not-read',records:'not-read',quarantine:'not-read',extractionRun:'not-read',minimum}),/at least one evidenced municipality/);
});
test('a replay clock never substitutes for the original frozen corpus binding or writes staging on failure',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'stadtstack-knowledge-replay-'));
 try{
  const registry=join(root,'sources','district-registry.json'),registryBytes=await readFile(registry);
  const inputs={index:{schemaVersion:'stadtstack-crawl-index-v1',generatedAt:at,documents:[],checks:[]},records:{schemaVersion:'stadtstack-knowledge-v2',generatedAt:at,records:[]},quarantine:{schemaVersion:'stadtstack-quarantine-v1',generatedAt:at,cases:[]},run:{corpusSha256:PILOT_COMPLETION_CORPUS_SHA256,registrySha256:hash(registryBytes)}};
  for(const [name,value] of Object.entries(inputs))await writeFile(join(directory,name+'.json'),JSON.stringify(value));
  const stagingDir=join(directory,'staging'),publicationQuarantinePath=join(directory,'publication-quarantine.json');
  await assert.rejects(prepareKnowledge({registry,index:join(directory,'index.json'),records:join(directory,'records.json'),quarantine:join(directory,'quarantine.json'),extractionRun:join(directory,'run.json'),coverageGeneratedAt:'2026-10-11T09:25:12.545Z',stagingDir,publicationQuarantinePath}),/not bound to the frozen corpus\/registry bytes/);
  await assert.rejects(lstat(stagingDir),{code:'ENOENT'});await assert.rejects(lstat(publicationQuarantinePath),{code:'ENOENT'});
 }finally{await rm(directory,{recursive:true,force:true});}
});
