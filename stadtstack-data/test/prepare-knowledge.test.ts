import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareKnowledge} from '../src/prepare-knowledge.ts';
import {knowledgePublicationHold,knowledgePublicationQuarantineCase,quarantineReasonHistogram} from '../src/district-publication.ts';
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

test('preparation carries structured date and URL holds into one source-bound quarantine entry',()=>{
 const record={id:'synthetic-held-record',municipalityId:'synthetic-town',sources:[{id:'synthetic-source'}],extraction:{inputSha256:'1'.repeat(64)},documentDate:null,stageDate:null,stages:[],summaryQuote:'Withheld source evidence file:///private/1998-04-03'};
 const original=structuredClone(record),hold=knowledgePublicationHold(record)!;
 const item=knowledgePublicationQuarantineCase(record,hold);
 assert.equal(item.recordId,record.id);
 assert.equal(item.municipalityId,record.municipalityId);
 assert.equal(item.sourceId,record.sources[0].id);
 assert.equal(item.sourceSha256,record.extraction.inputSha256);
 assert.deepEqual(item.publicationReasons,['missing_sourced_date','nonpublic_evidence_url']);
 assert.deepEqual(quarantineReasonHistogram([item]),{categories:[{reason:'missing_sourced_date',count:1},{reason:'nonpublic_evidence_url',count:1}],failedDeterministicChecks:[]});
 assert.equal(JSON.stringify(item).includes('file:///'),false);
 assert.equal(JSON.stringify(item).includes('1998-04-03'),false);
 assert.deepEqual(record,original);
 const dated={...record,documentDate:'1998-04-03'};
 const datedItem=knowledgePublicationQuarantineCase(dated,knowledgePublicationHold(dated)!);
 assert.deepEqual(quarantineReasonHistogram([datedItem]).categories,[{reason:'nonpublic_evidence_url',count:1}]);
 assert.equal(JSON.stringify(datedItem).includes('1998-04-03'),false);
});
