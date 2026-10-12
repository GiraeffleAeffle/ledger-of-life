import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {signRevocations,verifyRevocations,revocationKeyId} from '../src/civic-revocations.ts';
import {projectMaskedReleaseMetadata,type ReleasedData} from '../src/mcp-release.ts';
import {QueryIndex,type QueryVisibility} from '../src/mcp-query.ts';
import {signal,sourceFrom,hash} from '../src/common.ts';

test('a municipality-scoped registry revocation does not suppress a shared URL in another municipality',()=>{
  const releaseId='c'.repeat(64),{privateKey,publicKey}=generateKeyPairSync('ed25519'),keyId=revocationKeyId(publicKey);
  const signed=signRevocations({schemaVersion:'stadtstack-revocations-v1',releaseId,issuedAt:'2026-10-10T12:00:00Z',sequence:1,targets:[{type:'registry_source',municipalityId:'town-a',registrySourceId:'shared-source'}]},keyId,privateKey);
  const revocations=verifyRevocations(signed,{schemaVersion:'stadtstack-revocation-trust-v1',releaseId,expectedArtifactSha256:createHash('sha256').update(signed).digest('hex'),keys:[{keyId,publicKeySpki:publicKey.export({format:'der',type:'spki'}).toString('base64')}]},releaseId);
  const sharedUrl='https://shared.example.org/source',registrySource={id:'shared-source',url:sharedUrl},catalogueSource={id:'shared-source',url:sharedUrl,status:'checked',kind:'website',publisher:'Town',licence:'unknown',reuse:'facts_with_attribution',retrievedAt:null};
  const base={mode:'sealed',revocations,dataManifest:{id:releaseId,generatedAt:'2026-10-10T12:00:00Z'},catalogue:{schemaVersion:'stadtstack-signals-v1',generatedAt:'2026-10-10T12:00:00Z',publisher:'test',cities:[{id:'town-a',name:'A',state:'Test',center:[0,0],bbox:[0,0,1,1],sources:[catalogueSource]},{id:'town-b',name:'B',state:'Test',center:[1,0],bbox:[0,0,1,1],sources:[catalogueSource]}]},features:[],knowledge:{records:[]},feeds:{},coverage:{municipalities:['town-a','town-b'].map(id=>({id,documents:1,publishedRecords:1,datedStagedRecords:0,quarantinedRecords:0,textModelRecords:1,structuredRecords:0,sources:[{sourceId:'shared-source',kind:'website',registryState:'checked',crawlState:'checked',checkedAt:null,documentCount:1}]}))},registry:{municipalities:['town-a','town-b'].map(id=>({id,sources:[registrySource]})),sources:[registrySource]}} as unknown as ReleasedData;
 // Catalogue attribution survives only when a visible record contributes it.
 const bytes=Buffer.from('Synthetic shared source');
 base.features=['town-a','town-b'].map(cityId=>signal({id:`fixture:${cityId}`,cityId,kind:'council_paper',category:'planning',title:'Synthetic shared source',statement:'Synthetic shared source',status:'draft',startDate:'2026-09-01',endDate:null,nextStep:'Synthetic fixture',unknowns:[],scale:'city',geometryPrecision:'none',sources:[sourceFrom({body:bytes,sha256:hash(bytes),retrievedAt:base.dataManifest.generatedAt,url:sharedUrl},'Synthetic','Town','Synthetic fixture')],extraction:{method:'structured'},reviewState:'candidate',asOf:base.dataManifest.generatedAt},null));
  const index=new QueryIndex(releaseId,base.dataManifest.generatedAt,[],{schemaVersion:'stadtstack-regional-topics-v1',generatedAt:base.dataManifest.generatedAt,asOf:'2026-10-10',region:{id:'synthetic',name:'Synthetic'},municipalities:[],topics:[]},base.catalogue);
 const visibility:QueryVisibility={releaseId,maskIdentity:revocations.artifactSha256,index,visibleRecordIds:new Set(['fixture:town-b']),withheldSourceIds:new Set<string>(),sourceDescriptorsByRecord:new Map()};
  const result=projectMaskedReleaseMetadata(base,visibility);
  assert.deepEqual(result.catalogue.cities.map(city=>[city.id,city.sources.length]),[['town-a',0],['town-b',1]]);
  assert.deepEqual(result.coverage.municipalities.map(city=>[city.id,city.sources.map(source=>source.sourceId)]),[['town-a',[]],['town-b',['shared-source']]]);
  assert.equal(result.coverage.schemaVersion,'stadtstack-district-read-coverage-v1');
});
