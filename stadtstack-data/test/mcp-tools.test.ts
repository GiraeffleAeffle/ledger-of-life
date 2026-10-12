import {test} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {loadRelease,hostedServer,releasedResponse} from '../src/mcp-tools.ts';
import {server} from '../src/mcp.ts';
import {changesSchema,diff,signalChangeRecord} from '../src/changes.ts';
import {MCP_RELEASE_VERSION} from '../src/mcp-version.ts';
import {GraphEntitySchema,GraphEdgeSchema} from '../src/district-graph.ts';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import {signRevocations,verifyRevocations,revocationKeyId} from '../src/civic-revocations.ts';
import {provisionCivicPolicyAuthority,recordHostOptOut} from '../src/civic-opt-out.ts';

const envelopeSchema=z.object({source:z.object({release:z.string()}),releasedAt:z.iso.datetime(),respondedAt:z.iso.datetime(),status:z.literal('candidate'),data:z.unknown()}).passthrough();
const recordSchema=z.object({id:z.string(),cityId:z.string(),sourceIds:z.array(z.string())}).passthrough();

test('released MCP contract retains core evidence, separates times and fact/source lookup semantics',async()=>{
  const release=await loadRelease(),mcp=hostedServer(),client=new Client({name:'query-contract-test',version:'1'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);await client.connect(clientTransport);
  try {
    assert.equal(client.getServerVersion()?.version,MCP_RELEASE_VERSION);
    const tools=await client.listTools();
    assert.equal(tools.tools.length,20);
    for(const name of ['list_topics','get_source','compare_topic','similar','entity_search','graph_neighbors','graph_path','export_records'])assert.ok(tools.tools.some(tool=>tool.name===name));
    const before=Date.now();
    const result=await client.callTool({name:'get_core_bundle',arguments:{}});
    const envelope=envelopeSchema.parse(result.structuredContent);
    assert.equal(envelope.source.release,release.dataManifest.id);assert.equal(envelope.source.readViewId,release.visibility?.maskIdentity??null);assert.equal(envelope.releasedAt,release.dataManifest.generatedAt);
    assert.ok(Date.parse(envelope.respondedAt)>=before&&Date.parse(envelope.respondedAt)<=Date.now());
    assert.equal('date' in envelope,false);
    const core=z.object({bundle:z.unknown(),manifest:z.unknown()}).parse(envelope.data);
    assert.deepEqual(core.bundle,release.bundle);assert.deepEqual(core.manifest,release.manifest);
    const fact=release.bundle.facts[0];
    const signal=envelopeSchema.parse((await client.callTool({name:'get_signal',arguments:{id:fact.id}})).structuredContent);
    const record=recordSchema.parse(signal.data);
    assert.deepEqual(record.verification,fact.verification);assert.deepEqual(record.assertion,fact.assertion);
    assert.equal('sources' in record,false);assert.equal('source' in record,false);
    const attribution=envelopeSchema.parse((await client.callTool({name:'get_sources',arguments:{id:fact.id}})).structuredContent);
    const sources=z.object({id:z.string(),sourceIds:z.array(z.string()),sources:z.array(z.record(z.string(),z.unknown())),verification:z.unknown()}).passthrough().parse(attribution.data);
    assert.equal(sources.id,fact.id);assert.deepEqual(sources.verification,fact.verification);assert.equal('source' in sources,false);
    assert.deepEqual(sources.sourceIds,record.sourceIds);
    const source=envelopeSchema.parse((await client.callTool({name:'get_source',arguments:{sourceId:record.sourceIds[0]}})).structuredContent);
    assert.deepEqual(source.data,sources.sources[0]);
    assert.equal((await client.callTool({name:'get_sources',arguments:{id:record.sourceIds[0]}})).isError,true);
    assert.equal((await client.callTool({name:'get_source',arguments:{sourceId:fact.id}})).isError,true);
    const status=envelopeSchema.parse((await client.callTool({name:'get_release_status',arguments:{}})).structuredContent);
    assert.deepEqual(z.object({dataManifest:z.unknown(),manifest:z.unknown()}).parse(status.data),{dataManifest:release.dataManifest,manifest:release.manifest});
    assert.deepEqual(z.object({release:z.object({version:z.string(),dataManifestId:z.string(),mode:z.string(),readViewId:z.string().nullable()})}).parse(status.data).release,{version:MCP_RELEASE_VERSION,dataManifestId:release.dataManifest.id,mode:'sealed',readViewId:release.visibility?.maskIdentity??null});
  } finally {await client.close();await mcp.close();}
});
test('hosted sealed reads apply a real synthetic Ed25519 mask to core exports and bind response identity',async()=>{
  const publication=await loadRelease(),fact=publication.bundle.facts[0],releaseId=publication.dataManifest.id;
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),keyId=revocationKeyId(publicKey);
  const signed=signRevocations({schemaVersion:'stadtstack-revocations-v1',releaseId,issuedAt:'2026-10-10T12:00:00Z',sequence:1,targets:[{type:'record',recordId:fact.id}]},keyId,privateKey);
  const revocations=verifyRevocations(signed,{schemaVersion:'stadtstack-revocation-trust-v1',releaseId,expectedArtifactSha256:createHash('sha256').update(signed).digest('hex'),keys:[{keyId,publicKeySpki:publicKey.export({format:'der',type:'spki'}).toString('base64')}]},releaseId);
  const release=await loadRelease(undefined,{mode:'sealed',revocations}),mcp=server({release}),client=new Client({name:'signed-safe-view-test',version:'1'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await mcp.connect(serverTransport);await client.connect(clientTransport);
  try{
    const output=envelopeSchema.parse((await client.callTool({name:'get_core_bundle',arguments:{}})).structuredContent);
    assert.equal(output.source.readViewId,revocations.artifactSha256);
    const core=z.object({bundle:z.object({facts:z.array(z.object({id:z.string()}).passthrough())})}).parse(output.data);
    assert.equal(core.bundle.facts.some(item=>item.id===fact.id),false);
    assert.equal(release.visibility?.maskIdentity,revocations.artifactSha256);
  }finally{await client.close();await mcp.close();}
});

test('get_changes uses the injected immutable release snapshot, not mutable output files',async()=>{
  const loaded=await loadRelease(),cityId=loaded.catalogue.cities[0].id;
  const source=loaded.features.find(feature=>feature.properties.cityId===cityId)!;
  const changes=diff([],[{...signalChangeRecord(source),id:'test:synthetic-release-snapshot'}],loaded.dataManifest.generatedAt);
  const release={...loaded,changes:{...loaded.changes,[cityId]:changes}};
  const mcp=server({release}),client=new Client({name:'immutable-changes-test',version:'1'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await mcp.connect(serverTransport);await client.connect(clientTransport);
  try{assert.deepEqual(changesSchema.parse((await client.callTool({name:'get_changes',arguments:{cityId}})).structuredContent),changes);}
  finally{await client.close();await mcp.close();}
});

test('registered search tools reject old offsets, unknown cities/topics and mismatched cursors',async()=>{
  await loadRelease();const mcp=hostedServer(),client=new Client({name:'query-schema-test',version:'1'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await mcp.connect(serverTransport);await client.connect(clientTransport);
  try {
    for(const [name,args] of [['search_topics',{offset:1}],['get_council_items',{offset:1}],['get_regional_topics',{offset:1}],['search_signals',{cityId:'strausberg',offset:1}],['search_topics',{topic:'planning'}],['search_topics',{topic:'unknown-topic'}],['search_topics',{cityIds:['unknown-city']}],['search_topics',{fields:['sources']}]] as const)assert.equal((await client.callTool({name,arguments:args})).isError,true);
    for(const topic of ['solarpark','waermeplanung']) {
      const result=envelopeSchema.parse((await client.callTool({name:'search_topics',arguments:{topic}})).structuredContent);
      assert.ok(z.object({total:z.number().positive()}).parse(result.data).total>0);
    }
    const first=envelopeSchema.parse((await client.callTool({name:'search_topics',arguments:{limit:1,fields:['id','cityId','sourceIds']}})).structuredContent);
    const page=z.object({items:z.array(recordSchema),nextCursor:z.string(),total:z.number().positive()}).parse(first.data);
    assert.deepEqual(Object.keys(page.items[0]).sort(),['cityId','id','sourceIds']);assert.equal(JSON.stringify(page.items).includes('"sources":'),false);
    assert.equal((await client.callTool({name:'search_topics',arguments:{limit:2,fields:['id','cityId','sourceIds'],cursor:page.nextCursor}})).isError,true);
    const next=envelopeSchema.parse((await client.callTool({name:'search_topics',arguments:{limit:1,fields:['id','cityId','sourceIds'],cursor:page.nextCursor}})).structuredContent);
    const following=z.object({items:z.array(recordSchema)}).parse(next.data);
    assert.notDeepEqual([following.items[0].cityId,following.items[0].id],[page.items[0].cityId,page.items[0].id]);
  } finally {await client.close();await mcp.close();}
});

test('normalized three-district release exposes qualifying and zero-gated towns through the same MCP tools',async()=>{
  const release=await loadRelease(),mcp=hostedServer(),client=new Client({name:'district-contract-test',version:'1'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await mcp.connect(serverTransport);await client.connect(clientTransport);
  try {
    const cityIds=['strausberg','hoppegarten','ruedersdorf-bei-berlin','ratzeburg','moelln','schwarzenbek','ludwigslust','parchim','hagenow'];
    const records=release.index.records.filter(record=>record.origin==='knowledge');
    const coverage=z.object({municipalities:z.array(z.object({id:z.string(),status:z.enum(['gated_records','checked_no_gated_records','not_checked']),publishedRecords:z.number()}))}).parse(release.index.knowledge?.coverage);
    for(const cityId of cityIds){
      const city=coverage.municipalities.find(city=>city.id===cityId);assert.ok(city,`Missing explicit coverage for ${cityId}`);
      const count=records.filter(record=>record.cityId===cityId).length;assert.equal(city.publishedRecords,count);
      assert.equal(city.status,count?'gated_records':'checked_no_gated_records');
    }
    for(const districtId of ['maerkisch-oderland','herzogtum-lauenburg','ludwigslust-parchim'])assert.ok(records.some(record=>record.districtId===districtId&&record.comparisonEligible),`Missing actual qualifying district evidence: ${districtId}`);
    const target=records.find(record=>record.topics.length)!;assert.ok(target);
    const comparison=envelopeSchema.parse((await client.callTool({name:'compare_topic',arguments:{topic:target.topics[0].id,cityIds}})).structuredContent);
    const compared=z.object({releaseId:z.string(),cities:z.array(z.object({cityId:z.string(),recordCount:z.number(),coverage:z.unknown()}))}).parse(comparison.data);
    assert.equal(compared.releaseId,release.dataManifest.id);assert.deepEqual(compared.cities.map(city=>city.cityId),cityIds);
    const similarity=envelopeSchema.parse((await client.callTool({name:'similar',arguments:{id:target.id,limit:50}})).structuredContent);
    const similar=z.object({releaseId:z.string(),method:z.object({model:z.null(),version:z.literal('district-similarity-v3')}),items:z.array(z.object({id:z.string(),cityId:z.string(),memberRecordIds:z.array(z.string()).min(1),sourceIds:z.array(z.string())}).passthrough())}).parse(similarity.data);
    assert.equal(similar.releaseId,release.dataManifest.id);assert.ok(similar.items.every(item=>item.cityId!==target.cityId));
    const source=envelopeSchema.parse((await client.callTool({name:'get_source',arguments:{sourceId:target.sourceIds[0]}})).structuredContent);
    assert.equal(z.object({registrySourceId:z.string()}).parse(source.data).registrySourceId.length>0,true);
  } finally {await client.close();await mcp.close();}
});

test('graph MCP tools are read-only, source-bound and reject unbounded or ambiguous query input',async()=>{
  const release=await loadRelease(),mcp=server({release}),client=new Client({name:'graph-contract-test',version:'1'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);await client.connect(clientTransport);
  try{
    const tools=await client.listTools();
    for(const name of ['entity_search','graph_neighbors','graph_path']){
      const definition=tools.tools.find(tool=>tool.name===name);assert.ok(definition);
      assert.equal(definition.annotations?.readOnlyHint,true);assert.equal(definition.annotations?.destructiveHint,false);
      if(name!=='entity_search'){
        assert.match(definition.description!,/succeeds/);assert.match(definition.description!,/separate/);assert.match(definition.description!,/never.*identity merge/);assert.match(definition.description!,/member_of/);
        assert.match(definition.description!,/Historical committed 0\.3\.1 inventory/);assert.match(definition.description!,/not current identifiers or live coverage guarantees/);
        assert.match(definition.description!,/edge:7048119fc2453e41926d943f02578c605ef633634148f1401e7d3049d89cdf3c/);
        assert.match(definition.description!,/edge:b19c051984380d89ea42f57e3375fa0b15757620d184fc1c725d17c92689bc42/);
        assert.match(definition.description!,/edge:abe58d44b4927db8f59eeed36939f06b06d1b1ffe0b604c7d31377ca2c91b43d/);
      }else{assert.match(definition.description!,/same AGS/);assert.match(definition.description!,/no cross-municipality name merge/);assert.match(definition.description!,/notice\+version scope, not verified companies/);assert.match(definition.description!,/technical party IDs cannot/);}
    }
    const result=await client.callTool({name:'entity_search',arguments:{query:'a',limit:1}});
    assert.equal(result.isError,undefined);
    const page=z.object({releaseId:z.string(),recordsSha256:z.string(),items:z.array(GraphEntitySchema),truncated:z.boolean(),complete:z.boolean(),nextCursor:z.string().nullable()}).passthrough().parse(result.structuredContent);
    assert.equal(page.releaseId,release.dataManifest.id);
    assert.equal(page.recordsSha256,release.graph.recordsSha256);
    for(const entity of page.items)for(const mention of entity.mentions)for(const evidence of mention.evidence){
      if(evidence.kind==='structured'){
        assert.ok(evidence.locators.every(locator=>locator.sourceSha256===evidence.source.sha256));
        assert.ok(evidence.supportingEvidence.every(support=>evidence.supportingSources.some(source=>source.sha256===support.locator.sourceSha256&&source.role===support.role)));
        assert.equal('quote' in evidence,false);assert.equal('faithfulness' in evidence,false);
      }else{assert.equal(evidence.textSha256.length,64);assert.equal(evidence.source.sha256.length,64);}
    }
    const temporal=z.object({releaseAsOf:z.iso.date(),asOf:z.iso.date()}).passthrough().parse(result.structuredContent);
    assert.equal(temporal.releaseAsOf,release.graph.releaseAsOf);assert.equal(temporal.asOf,release.graph.releaseAsOf);
    const explicit=z.object({releaseAsOf:z.iso.date(),asOf:z.iso.date()}).passthrough().parse((await client.callTool({name:'entity_search',arguments:{query:'a',limit:1,asOf:'2020-01-01'}})).structuredContent);
    assert.equal(explicit.releaseAsOf,release.graph.releaseAsOf);assert.equal(explicit.asOf,'2020-01-01');
    if(page.nextCursor)assert.equal((await client.callTool({name:'entity_search',arguments:{query:'a',limit:1,asOf:'2020-01-01',cursor:page.nextCursor}})).isError,true);
    assert.equal(page.complete,!page.truncated);
    for(const [name,args] of [['entity_search',{query:'a',limit:51}],['entity_search',{query:'a',offset:1}],['entity_search',{query:'a',type:'person'}],['graph_neighbors',{id:'entity:'+ '0'.repeat(64),direction:'sideways'}],['graph_path',{fromId:'entity:'+ '0'.repeat(64),toId:'entity:'+ '1'.repeat(64),maxHops:6}]] as const)assert.equal((await client.callTool({name,arguments:args})).isError,true);
    if(page.items[0]){
      const item=page.items[0];
      const neighbors=await client.callTool({name:'graph_neighbors',arguments:{id:item.id,limit:1}});
      assert.equal(neighbors.isError,undefined);
      const neighborTime=z.object({releaseAsOf:z.iso.date(),asOf:z.iso.date()}).passthrough().parse(neighbors.structuredContent);
      assert.equal(neighborTime.asOf,release.graph.releaseAsOf);
      const rolePage=z.object({items:z.array(z.object({edge:GraphEdgeSchema,blockingEvidence:z.array(GraphEdgeSchema),roleEvidenceComplete:z.boolean(),pathEligible:z.boolean(),qualification:z.string()}).passthrough())}).passthrough().parse(neighbors.structuredContent);
      for(const entry of rolePage.items)if(!entry.roleEvidenceComplete||entry.blockingEvidence.length)assert.equal(entry.pathEligible,false);
      const path=await client.callTool({name:'graph_path',arguments:{fromId:item.id,toId:item.id,maxHops:1,limit:1}});
      assert.equal(path.isError,undefined);
      const pathData=z.object({shortestHops:z.number(),modalities:z.array(z.string()),pathEligibility:z.object({eligibleModalities:z.array(z.string())})}).passthrough().parse(path.structuredContent);
      assert.equal(pathData.shortestHops,0);
      assert.deepEqual(pathData.modalities,[]);
      assert.deepEqual(pathData.pathEligibility.eligibleModalities,['asserted','decided','implemented']);
      assert.equal('modality' in pathData,false);
      const pathTime=z.object({releaseAsOf:z.iso.date(),asOf:z.iso.date(),temporalMode:z.literal('as_of')}).passthrough().parse(path.structuredContent);
      assert.equal(pathTime.asOf,release.graph.releaseAsOf);
      const historical=await client.callTool({name:'graph_path',arguments:{fromId:item.id,toId:item.id,maxHops:1,asOf:'2020-01-01',mode:'historical'}});
      const historicalTime=z.object({asOf:z.literal('2020-01-01'),temporalMode:z.literal('historical')}).passthrough().parse(historical.structuredContent);
      assert.equal(historicalTime.temporalMode,'historical');
    }
  }finally{await client.close();await mcp.close();}
});

test('0.3.1 heat comparisons, bulk export and quarantine coverage share the released evidence',async()=>{
 const release=await loadRelease(),mcp=server({release}),client=new Client({name:'patch-031-regression',version:'1'});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
 await mcp.connect(serverTransport);await client.connect(clientTransport);
 try{
  const cityIds=['strausberg','hoppegarten','ruedersdorf-bei-berlin'],topic='waermeplanung';
  const compared=z.object({method:z.object({version:z.literal('district-comparison-v3')}),cities:z.array(z.object({cityId:z.string(),sourceBackedRecordCount:z.number(),sourceBackedCaseCount:z.number(),cases:z.array(z.object({eligibleRecordIds:z.array(z.string()),furthestSupportedStage:z.string().nullable(),furthestSupportedDate:z.string().nullable()}).passthrough())}).passthrough())}).parse((await client.callTool({name:'compare_topic',arguments:{topic,cityIds}})).structuredContent);
  for(const cityId of cityIds){
   const page=z.object({items:z.array(z.object({id:z.string(),caseId:z.string(),comparisonEligible:z.literal(true)})),nextCursor:z.null()}).parse((await client.callTool({name:'search_topics',arguments:{topic,cityIds:[cityId],limit:50,fields:['id','caseId','comparisonEligible']}})).structuredContent);
   assert.ok(page.items.length>0,`${cityId} heat evidence must not disappear`);
   const comparison=compared.cities.find(city=>city.cityId===cityId)!;
   assert.equal(comparison.sourceBackedRecordCount,page.items.length);
   assert.equal(comparison.sourceBackedCaseCount,new Set(page.items.map(item=>item.caseId)).size);
   const members=new Set(comparison.cases.flatMap(item=>item.eligibleRecordIds));
   assert.ok(page.items.every(item=>members.has(item.id)));
   assert.ok(comparison.cases.some(item=>item.furthestSupportedStage));
   if(cityId==='hoppegarten'||cityId==='strausberg')assert.ok(comparison.cases.every(item=>item.furthestSupportedDate===null),'Unbound/publication dates are not stage dates');
   if(cityId==='ruedersdorf-bei-berlin')assert.ok(comparison.cases.some(item=>item.furthestSupportedStage==='adopted'&&item.furthestSupportedDate==='2025-07-22'));
  }
  const exportPage=z.object({releaseId:z.string(),items:z.array(z.object({id:z.string(),caseId:z.string(),sourceIds:z.array(z.string()),originalRecord:z.unknown()}).passthrough()),sources:z.array(z.object({id:z.string(),url:z.string()}).passthrough()),totalRecords:z.number(),totalCases:z.number(),nextCursor:z.string().nullable()}).passthrough();
  const first=exportPage.parse((await client.callTool({name:'export_records',arguments:{municipality:'strausberg',limit:1}})).structuredContent);
  assert.equal(first.releaseId,release.dataManifest.id);assert.equal(first.items.length,1);assert.ok(first.items[0].originalRecord);
  assert.ok(first.totalCases<=first.totalRecords);assert.ok(first.nextCursor);
  assert.ok(first.items[0].sourceIds.every(id=>first.sources.some(source=>source.id===id)));
  const next=exportPage.parse((await client.callTool({name:'export_records',arguments:{municipality:'strausberg',limit:1,cursor:first.nextCursor}})).structuredContent);
  assert.notEqual(next.items[0].id,first.items[0].id);
  assert.equal((await client.callTool({name:'export_records',arguments:{municipality:'hoppegarten',limit:1,cursor:first.nextCursor}})).isError,true);
  assert.equal((await client.callTool({name:'export_records',arguments:{limit:51}})).isError,true);
  assert.equal((await client.callTool({name:'export_records',arguments:{topic:'not-a-topic'}})).isError,true);
  const coverage=z.object({accounting:z.object({registryMunicipalities:z.number(),attemptedMunicipalities:z.number()}),districts:z.array(z.object({id:z.string(),municipalitiesRegistered:z.number(),municipalitiesAttempted:z.number()}).passthrough()),municipalities:z.array(z.object({id:z.string(),publishedRecords:z.number(),quarantinedRecords:z.number(),quarantineReasons:z.object({categories:z.array(z.object({reason:z.string(),count:z.number()})),failedDeterministicChecks:z.array(z.object({id:z.string(),count:z.number()}))})}).passthrough())}).passthrough();
  const status=z.object({knowledgeCoverage:coverage}).parse((await client.callTool({name:'get_release_status',arguments:{}})).structuredContent).knowledgeCoverage;
  const cities=z.object({knowledgeCoverage:coverage}).parse((await client.callTool({name:'list_cities',arguments:{}})).structuredContent).knowledgeCoverage;
  assert.deepEqual(status.accounting,cities.accounting);assert.equal(status.accounting.registryMunicipalities,319);assert.equal(status.accounting.attemptedMunicipalities,9);
  const mol=status.districts.find(district=>district.id==='maerkisch-oderland')!;
  assert.equal(mol.municipalitiesRegistered,45);assert.equal(mol.municipalitiesAttempted,3);
  const strausberg=status.municipalities.find(city=>city.id==='strausberg')!;
  assert.equal(strausberg.publishedRecords,39);assert.equal(strausberg.quarantinedRecords,384);
  assert.ok(strausberg.quarantineReasons.categories.some(reason=>reason.reason==='missing_sourced_date'&&reason.count>0));
 }finally{await client.close();await mcp.close();}
});

test('injected VM-candidate releases recheck current authoritative opt-out before every tool access',async(t)=>{
 const base=await mkdtemp(join(await realpath(tmpdir()),'mcp-serving-policy-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const stateDir=join(base,'policy'),authority=await provisionCivicPolicyAuthority({stateDir,authorityId:'fixture:'+randomUUID()});
 const policyOptions={stateDir,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
 const release=await loadRelease(undefined,{mode:'vm_candidate',policyOptions}),fact=release.bundle.facts[0];
 const mcp=server({release,policyOptions}),client=new Client({name:'injected-serving-policy-test',version:'1'});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await mcp.connect(serverTransport);await client.connect(clientTransport);
 try{
  assert.equal((await client.callTool({name:'get_signal',arguments:{id:fact.id}})).isError,undefined);
  await recordHostOptOut({host:new URL(fact.source.url).hostname,reason:'rights_holder_objection'},policyOptions);
  assert.equal((await client.callTool({name:'get_signal',arguments:{id:fact.id}})).isError,true,'An already loaded/injected snapshot is not cached source permission');
  assert.equal((await client.callTool({name:'get_release_status',arguments:{}})).isError,true,'Metadata serving cannot bypass revoked source authority');
 }finally{await client.close();await mcp.close();}
});

test('released response metadata binds the supplied serving snapshot rather than a mutable global pointer',async()=>{
 const loaded=await loadRelease();
 // Synthetic header-only fixture, never a published or admitted data release.
 const bound={...loaded,dataManifest:{...loaded.dataManifest,id:'b'.repeat(64)}};
 const output=releasedResponse({releaseId:bound.dataManifest.id},bound).structuredContent;
 assert.equal(output.source.release,bound.dataManifest.id);assert.equal(output.releasedAt,bound.dataManifest.generatedAt);
 assert.equal(output.data&&typeof output.data==='object'&&'releaseId' in output.data?output.data.releaseId:null,bound.dataManifest.id);
});
