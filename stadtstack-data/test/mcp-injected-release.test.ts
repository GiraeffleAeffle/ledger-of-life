import {test} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {server} from '../src/mcp.ts';
import {releasedResponse} from '../src/mcp-tools.ts';
import {changesSchema,diff,signalChangeRecord} from '../src/changes.ts';
import {prepareReleaseReadView} from '../src/mcp-release.ts';
import {GraphIndex} from '../src/district-graph-query.ts';
import {syntheticRelease} from './fixtures/mcp-release.ts';
import {verifiedMask} from './fixtures/revocations.ts';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {provisionCivicPolicyAuthority,recordHostOptOut} from '../src/civic-opt-out.ts';

// Source-gate tests inject explicitly synthetic snapshots. Real candidate data is
// tested separately in mcp-tools.test.ts through the governed release loader.
test('hosted sealed reads apply a real synthetic Ed25519 mask to core exports and bind response identity',async()=>{
 const publication=syntheticRelease(),fact=publication.bundle.facts[0];
 const revocations=verifiedMask(publication.dataManifest.id,[{type:'record',recordId:fact.id}]);
 const release=prepareReleaseReadView({...publication,revocations,graph:new GraphIndex(publication.dataManifest.id,publication.graphData,publication.knowledgeBytes,undefined,revocations)});
 const mcp=server({release,transformResult:data=>releasedResponse(data,release)}),client=new Client({name:'signed-safe-view-test',version:'1'});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await mcp.connect(serverTransport);await client.connect(clientTransport);
 try{
  const output=z.object({source:z.object({readViewId:z.string()}),data:z.object({bundle:z.object({facts:z.array(z.object({id:z.string()}))})})}).parse((await client.callTool({name:'get_core_bundle',arguments:{}})).structuredContent);
  assert.equal(output.source.readViewId,revocations.artifactSha256);assert.equal(output.data.bundle.facts.some(item=>item.id===fact.id),false);assert.equal(release.visibility?.maskIdentity,revocations.artifactSha256);
 }finally{await client.close();await mcp.close();}
});

test('get_changes uses the injected immutable release snapshot, not mutable output files',async()=>{
 const loaded=syntheticRelease(),cityId=loaded.catalogue.cities[0].id,source=loaded.features[0];
 const changes=diff([],[{...signalChangeRecord(source),id:'test:synthetic-release-snapshot'}],loaded.dataManifest.generatedAt);
 const release={...loaded,changes:{...loaded.changes,[cityId]:changes}},mcp=server({release}),client=new Client({name:'immutable-changes-test',version:'1'});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await mcp.connect(serverTransport);await client.connect(clientTransport);
 try{const {administrativeView:_view,...feed}=z.record(z.string(),z.unknown()).parse((await client.callTool({name:'get_changes',arguments:{cityId}})).structuredContent);assert.deepEqual(changesSchema.parse(feed),changes);}
 finally{await client.close();await mcp.close();}
});

test('injected VM-candidate releases recheck current authoritative opt-out before every tool access',async(t)=>{
 const base=await mkdtemp(join(await realpath(tmpdir()),'mcp-serving-policy-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const stateDir=join(base,'policy'),authority=await provisionCivicPolicyAuthority({stateDir,authorityId:'fixture:'+randomUUID()});
 const policyOptions={stateDir,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
 const publication=syntheticRelease(),release={...publication,mode:'vm_candidate' as const,revocations:null},fact=release.bundle.facts[0];
 const mcp=server({release,policyOptions}),client=new Client({name:'injected-serving-policy-test',version:'1'});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await mcp.connect(serverTransport);await client.connect(clientTransport);
 try{
  assert.equal((await client.callTool({name:'get_signal',arguments:{id:fact.id}})).isError,undefined);
  await recordHostOptOut({host:new URL(fact.source.url).hostname,reason:'rights_holder_objection'},policyOptions);
  assert.equal((await client.callTool({name:'get_signal',arguments:{id:fact.id}})).isError,true,'An already loaded/injected snapshot is not cached source permission');
  assert.equal((await client.callTool({name:'get_release_status',arguments:{}})).isError,true,'Metadata serving cannot bypass revoked source authority');
 }finally{await client.close();await mcp.close();}
});

test('released response metadata binds the supplied serving snapshot rather than a mutable global pointer',()=>{
 const loaded=syntheticRelease(),bound={...loaded,dataManifest:{...loaded.dataManifest,id:'b'.repeat(64)}};
 const output=releasedResponse({releaseId:bound.dataManifest.id},bound).structuredContent;
 assert.equal(output.source.release,bound.dataManifest.id);assert.equal(output.releasedAt,bound.dataManifest.generatedAt);
 assert.equal(output.data&&typeof output.data==='object'&&'releaseId' in output.data?output.data.releaseId:null,bound.dataManifest.id);
});
