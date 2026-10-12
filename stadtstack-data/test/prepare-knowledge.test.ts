import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {prepareKnowledge} from '../src/prepare-knowledge.ts';
import {KNOWLEDGE_SCHEMA_VERSION} from '../src/district-schema.ts';
import {knowledgePublicationHold,knowledgePublicationQuarantineCase,quarantineReasonHistogram} from '../src/district-publication.ts';
import {root,hash} from '../src/common.ts';
import {districtRegistrySchema} from '../src/district-registry.ts';
import {writeManagedSourceArtifact} from '../src/district-private-io.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';

const at='2026-10-10T12:00:00.000Z';
test('importable knowledge preparation retains the mandatory district acceptance gate',async()=>{
 for(const minimum of [0,-1,1.5,NaN])await assert.rejects(prepareKnowledge({registry:'not-read',records:'not-read',quarantine:'not-read',minimum}),/at least one evidenced municipality/);
});
test('a replay clock cannot substitute implicit lineage for original ordered text contributions or write staging on failure',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'stadtstack-knowledge-replay-'));
 try{
  const policy=await createCivicPolicyTestContext(t),registry=join(root,'sources','district-registry.json'),registryBytes=await readFile(registry),city=districtRegistrySchema.parse(JSON.parse(registryBytes.toString('utf8'))).municipalities.find(city=>city.sources.length>0)!;
  const inputs={records:{schemaVersion:KNOWLEDGE_SCHEMA_VERSION,generatedAt:at,records:[],identityAssertions:[],identityAdmissions:[]},quarantine:{schemaVersion:'stadtstack-quarantine-v1',generatedAt:at,cases:[{kind:'text_model',municipalityId:city.id,sourceId:city.sources[0].id,sourceSha256:hash('synthetic no-case source bytes'),reason:'No supported case in source excerpt'}]}};
  const artifacts:Record<string,Buffer>={registry:registryBytes,records:Buffer.from(JSON.stringify(inputs.records)),quarantine:Buffer.from(JSON.stringify(inputs.quarantine))},pins:{path:string;sha256:string;bytes:number;bindings:{kind:'prepared_source';url:string;sourceSha256:string;observationId:string;receiptSha256:string;independentAllowed:boolean}[]}[]=[];
  for(const [name,bytes] of Object.entries(artifacts)){const path=join(policy.managedRoot,'inputs',`${name}.json`),binding={kind:'prepared_source' as const,url:`https://example.org/synthetic-${name}`,sourceSha256:hash(`synthetic ${name} source`),observationId:`synthetic-${name}`,receiptSha256:hash(`synthetic ${name} receipt`),independentAllowed:true};await writeManagedSourceArtifact(policy.managedRoot,path,bytes,[binding],{...policy.policy,decisionId:policy.decisionId,kind:'artifacts'});pins.push({path:relative(directory,path),sha256:hash(bytes),bytes:bytes.length,bindings:[binding]});}
  const privateProvenance=join(directory,'private-provenance.json'),inventory={schemaVersion:'stadtstack-private-publication-provenance-v1',inputs:pins};await writeFile(privateProvenance,JSON.stringify(inventory));
  const stagingDir=join(directory,'staging'),publicationQuarantinePath=join(directory,'publication-quarantine.json');
  await assert.rejects(prepareKnowledge({registry:join(policy.managedRoot,'inputs','registry.json'),records:join(policy.managedRoot,'inputs','records.json'),quarantine:join(policy.managedRoot,'inputs','quarantine.json'),privateProvenance:{path:privateProvenance,sha256:hash(JSON.stringify(inventory))},policyStateDir:policy.policy.stateDir,policyAuthorityId:policy.policy.authorityId,policyAuthoritySha256:policy.policy.authoritySha256,coverageGeneratedAt:'2026-10-11T09:25:12.545Z',stagingDir,publicationQuarantinePath}),/explicit authenticated ordered text composition/);
  await assert.rejects(lstat(stagingDir),{code:'ENOENT'});await assert.rejects(lstat(publicationQuarantinePath),{code:'ENOENT'});
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('preparation carries text date and URL holds into one source-bound quarantine entry',()=>{
 const record={kind:'text_model' as const,id:'synthetic-held-record',municipalityId:'synthetic-town',sources:[{id:'synthetic-source'}],extraction:{inputSha256:'1'.repeat(64)},documentDate:null,stageDate:null,stages:[],summaryQuote:'Withheld source evidence file:///private/1998-04-03'};
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
