import {test} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {loadRelease as loadSealedRelease,hostedServer} from '../src/mcp-tools.ts';
import {server} from '../src/mcp.ts';
import {changesSchema,diff,knowledgeChangeRecord} from '../src/changes.ts';
import {verifyDataRelease} from '../src/data-release.ts';
import {governedReleaseDirectory} from '../src/governed-release-directory.ts';
import {verifiedMask} from './fixtures/revocations.ts';
import {MCP_RELEASE_VERSION} from '../src/mcp-version.ts';

async function loadRelease(){
  const directory=governedReleaseDirectory(),manifest=await verifyDataRelease(directory);
  return loadSealedRelease(directory,{mode:'sealed',revocations:verifiedMask(manifest.id)});
}

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
    assert.equal(envelope.source.release,release.dataManifest.id);assert.equal(envelope.releasedAt,release.dataManifest.generatedAt);
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
    assert.deepEqual(source.data,{...sources.sources[0],administrativeView:release.index.administrativeView});
    assert.equal((await client.callTool({name:'get_sources',arguments:{id:record.sourceIds[0]}})).isError,true);
    assert.equal((await client.callTool({name:'get_source',arguments:{sourceId:fact.id}})).isError,true);
    const status=envelopeSchema.parse((await client.callTool({name:'get_release_status',arguments:{}})).structuredContent);
    assert.deepEqual(z.object({dataManifest:z.unknown(),manifest:z.unknown()}).parse(status.data),{dataManifest:release.dataManifest,manifest:release.manifest});
    assert.deepEqual(z.object({release:z.object({version:z.string(),dataManifestId:z.string()})}).parse(status.data).release,{version:MCP_RELEASE_VERSION,dataManifestId:release.dataManifest.id});
  } finally {await client.close();await mcp.close();}
});

test('get_changes uses the injected immutable release snapshot, not mutable output files',async()=>{
  const cityId='hoppegarten',generatedAt='2026-10-11T00:00:00.000Z';
  const record=knowledgeChangeRecord({id:'test:synthetic-release-snapshot',municipalityId:cityId,sources:[{url:'https://example.org/evidence',sha256:'1'.repeat(64)}],verification:{evidenceHash:'2'.repeat(64)}});
  const changes=diff([],[record],generatedAt);
  // Full sealed admission and a genuinely signed empty cohort; only feed dispatch is replaced.
  const release={...await loadRelease(),changes:{[cityId]:changes}};
  const mcp=server({release}),client=new Client({name:'immutable-changes-test',version:'1'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await mcp.connect(serverTransport);await client.connect(clientTransport);
  try{
    const response=z.object({administrativeView:z.unknown()}).passthrough().parse((await client.callTool({name:'get_changes',arguments:{cityId}})).structuredContent);
    const {administrativeView,...feed}=response;assert.ok(administrativeView);
    assert.deepEqual(changesSchema.parse(feed),changes);
    assert.equal((await client.callTool({name:'get_changes',arguments:{cityId:'unknown-city'}})).isError,true);
    const tools=await client.listTools();
    assert.match(tools.tools.find(tool=>tool.name==='get_changes')!.description!,/sealed release/);
    assert.match(tools.tools.find(tool=>tool.name==='get_changes')!.description!,/never creates a civic/);
  }
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
    const similar=z.object({releaseId:z.string(),method:z.object({model:z.null(),version:z.literal('district-similarity-v2')}),items:z.array(z.object({id:z.string(),cityId:z.string(),memberRecordIds:z.array(z.string()).min(1),sourceIds:z.array(z.string())}).passthrough())}).parse(similarity.data);
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
    const graphDescription=tools.tools.find(tool=>tool.name==='graph_neighbors')?.description??'';
    assert.match(graphDescription,/member_of/);
    assert.match(graphDescription,/Coverage is sparse/);
    assert.match(graphDescription,/Edge IDs are release-specific output IDs/);
    assert.deepEqual(graphDescription.match(/edge:[a-f0-9]{64}/g),[
      'edge:7048119fc2453e41926d943f02578c605ef633634148f1401e7d3049d89cdf3c',
      'edge:abe58d44b4927db8f59eeed36939f06b06d1b1ffe0b604c7d31377ca2c91b43d',
      'edge:b19c051984380d89ea42f57e3375fa0b15757620d184fc1c725d17c92689bc42',
    ]);
    assert.match(tools.tools.find(tool=>tool.name==='entity_search')?.description??'',/AGS-scoped council body/);
    for(const name of ['entity_search','graph_neighbors','graph_path']){
      const definition=tools.tools.find(tool=>tool.name===name);assert.ok(definition);
      assert.equal(definition.annotations?.readOnlyHint,true);assert.equal(definition.annotations?.destructiveHint,false);
    }
    const result=await client.callTool({name:'entity_search',arguments:{query:'a',limit:1}});
    assert.equal(result.isError,undefined);
    const page=z.object({releaseId:z.string(),recordsSha256:z.string(),items:z.array(z.object({id:z.string(),identityBasis:z.object({ambiguity:z.string()}).passthrough(),mentions:z.array(z.object({quote:z.string(),evidence:z.object({recordId:z.string(),source:z.object({url:z.string(),sha256:z.string()}).passthrough()}).passthrough()}).passthrough())}).passthrough()),truncated:z.boolean(),complete:z.boolean(),nextCursor:z.string().nullable()}).passthrough().parse(result.structuredContent);
    assert.equal(page.releaseId,release.dataManifest.id);
    assert.equal(page.recordsSha256,release.graph.recordsSha256);
    assert.equal(page.complete,!page.truncated);
    for(const [name,args] of [['entity_search',{query:'a',limit:51}],['entity_search',{query:'a',offset:1}],['entity_search',{query:'a',type:'person'}],['graph_neighbors',{id:'entity:'+ '0'.repeat(64),direction:'sideways'}],['graph_path',{fromId:'entity:'+ '0'.repeat(64),toId:'entity:'+ '1'.repeat(64),maxHops:6}]] as const)assert.equal((await client.callTool({name,arguments:args})).isError,true);
    if(page.items[0]){
      const item=page.items[0];
      const neighbors=await client.callTool({name:'graph_neighbors',arguments:{id:item.id,limit:1}});
      assert.equal(neighbors.isError,undefined);
      const path=await client.callTool({name:'graph_path',arguments:{fromId:item.id,toId:item.id,maxHops:1,limit:1}});
      assert.equal(path.isError,undefined);
      const pathData=z.object({shortestHops:z.number(),modalities:z.array(z.string()),pathEligibility:z.object({eligibleModalities:z.array(z.string())})}).passthrough().parse(path.structuredContent);
      assert.equal(pathData.shortestHops,0);
      assert.deepEqual(pathData.modalities,[]);
      assert.deepEqual(pathData.pathEligibility.eligibleModalities,['asserted','decided','implemented']);
      assert.equal('modality' in pathData,false);
    }
  }finally{await client.close();await mcp.close();}
});

test('0.3.1 heat comparisons, bulk export and quarantine coverage share the released evidence',async()=>{
 const release=await loadRelease(),mcp=server({release}),client=new Client({name:'patch-031-regression',version:'1'});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
 await mcp.connect(serverTransport);await client.connect(clientTransport);
 try{
  const cityIds=['strausberg','hoppegarten','ruedersdorf-bei-berlin'],topic='waermeplanung';
  const compared=z.object({method:z.object({version:z.literal('district-comparison-v2')}),cities:z.array(z.object({cityId:z.string(),sourceBackedRecordCount:z.number(),sourceBackedCaseCount:z.number(),cases:z.array(z.object({eligibleRecordIds:z.array(z.string()),furthestSupportedStage:z.string().nullable(),furthestSupportedDate:z.string().nullable()}).passthrough())}).passthrough())}).parse((await client.callTool({name:'compare_topic',arguments:{topic,cityIds}})).structuredContent);
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
