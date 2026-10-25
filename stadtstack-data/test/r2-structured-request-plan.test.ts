import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {digest} from '../src/district-adapter-contract.ts';
import type {AdmittedSnapshot,AdapterScope} from '../src/district-adapter-contract.ts';
import {districtRegistrySchema} from '../src/district-registry.ts';
import {admittedRegisteredRobotsScopes} from '../src/registered-source-policy.ts';
import {MASTR_LIMITS,MASTR_PILOT_AGS,mastrAdapter} from '../src/adapters/mastr.ts';
import {genesisAdapter,GENESIS_BASE} from '../src/adapters/genesis.ts';
import {buildR2StructuredRequestPlan,planR2MastrBulkRequest,R2_STRUCTURED_CAPS,R2_MASTR_LANDING} from '../src/r2-structured-request-plan.ts';

// All discovery/source records below are authored fixtures, not publisher data.
const scope:AdapterScope={publisherId:'bundesnetzagentur',sourceId:'mastr',municipalityId:'ratzeburg',ags:'01053100',tenant:null,observationWindow:'2026-10-24'};
function landing(content:string):AdmittedSnapshot{const bytes=Buffer.from(content);return {bytes,sourceSha256:digest(bytes),policyReceiptSha256:digest('synthetic policy'),url:R2_MASTR_LANDING,mimeType:'text/html',retrievedAt:'2026-10-24T00:00:00Z',sourceVersion:null};}
function discovered(html='<a href="/MaStR/Gesamtdatenexport_20261024.zip">Gesamtdatenexport</a>'){
 const input=landing(html),result=mastrAdapter.discover(input,scope,null);
 return {result,pins:{sourceSha256:input.sourceSha256,policyReceiptSha256:input.policyReceiptSha256,stepReceiptSha256:digest('synthetic discovery receipt'),resultSha256:digest(JSON.stringify(result))}};
}

test('draft contains exact metadata plus nine single-year municipal bodies without credentials or execution',()=>{
 const plan=buildR2StructuredRequestPlan(),saved=JSON.parse(readFileSync(new URL('../sources/r2-structured-request-plan.draft.json',import.meta.url),'utf8'));
 assert.deepEqual(plan,saved);assert.equal(plan.issuedAt,'');assert.equal(plan.state,'unissued_review_draft');
 assert.equal(plan.requests.length,25);assert.equal(plan.maxPrimaryRequestsIncludingOneResolvedBulk,26);assert.equal(plan.maxNetworkAttemptsIncludingPolicyRedirectFailure,208);
 assert.equal(plan.requests.filter(item=>item.phase==='preflight').length,15);
 assert.equal(plan.requests.filter(item=>item.phase==='genesis_metadata').length,1);
 const data=plan.requests.filter(item=>item.phase==='genesis_data');assert.equal(data.length,9);
 for(const item of data){
  assert.equal(item.credentials,'existing_owner_headers');assert.equal(item.method,'POST');assert.equal(item.url,GENESIS_BASE+'data/table');assert.equal(item.maxBodyBytes,4194304);
  const body=new URLSearchParams(item.body!);assert.equal(body.get('name'),'31231-02-01');assert.equal(body.get('regionalkey'),MASTR_PILOT_AGS[item.municipalityId!]);
  assert.equal(body.get('startyear'),'2024');assert.equal(body.get('endyear'),'2024');assert.equal(body.get('format'),'datencsv');assert.equal(body.get('quality'),'on');assert.equal(body.get('job'),'false');
  assert.ok(![...body.keys()].some(key=>/password|username|token|secret/i.test(key)));
  const raw=JSON.stringify({Ident:{Service:'metadata',Method:'table'},Status:{Code:0,Type:'Information',Content:'SYNTHETIC'},Object:{Code:'31231-02-01',Structure:{Rows:[{Code:'GEMEIN',Content:'Gemeinden',Selected:null}]}}}),bytes=Buffer.from(raw);
  const references=genesisAdapter.discover({bytes,sourceSha256:digest(bytes),policyReceiptSha256:digest('synthetic policy'),url:GENESIS_BASE+'metadata/table',mimeType:'application/json',retrievedAt:'2026-10-24T00:00:00Z',sourceVersion:null},{...scope,publisherId:'statistics',sourceId:'regionalstatistik-genesis',municipalityId:item.municipalityId!,ags:body.get('regionalkey')!,observationWindow:'2024'},null);
  assert.equal(references.resources[0].body,item.body);
 }
 assert.ok(plan.requests.filter(item=>item.phase!=='genesis_data').every(item=>item.credentials==='none'));
 assert.equal(plan.caps.maxInFlight,1);assert.equal(plan.caps.minSpacingMs,5000);assert.equal(plan.caps.automaticRetries,0);assert.equal(plan.caps.paidMicroUsd,0);assert.equal(plan.caps.modelCalls,0);
 assert.equal(plan.mastr.bulkRequestNotYetAuthorized,true);assert.ok(plan.caps.maxBulkCompressedBytes>1024**3);
});

test('nine-town registrations remain discovery-only and do not inherit R1 robots authority',()=>{
 const registry=districtRegistrySchema.parse(JSON.parse(readFileSync(new URL('../sources/district-registry.json',import.meta.url),'utf8')));
 assert.equal(registry.municipalities.length,9);
 for(const town of registry.municipalities){
  assert.equal(MASTR_PILOT_AGS[town.id],town.ags);
  for(const sourceId of ['mastr','regionalstatistik-genesis']){
   const source=town.sources.find(item=>item.id===sourceId)!;assert.ok(source);assert.equal(source.kind,'structured');assert.equal(source.checkState,'not_checked');assert.equal(source.rights!.checkState,'not_checked');assert.equal(source.checkedAt,null);assert.equal(source.crawlScope!.followLinkedDocuments,false);assert.equal(source.ownerRobotsOverride,undefined);
  }
 }
 const historical=admittedRegisteredRobotsScopes(registry,digest('synthetic registry pin'));
 assert.equal(historical.filter(item=>item.sourceId==='mastr').length,0);
 assert.deepEqual(historical.filter(item=>item.sourceId==='regionalstatistik-genesis').map(item=>item.municipalityId),['strausberg']);
});

test('one advertised static bulk reference yields a review-only request, not host parsing or download authority',()=>{
 const {result,pins}=discovered(),planned=planR2MastrBulkRequest(result,pins);
 assert.equal(result.resources[0].format,'zip');assert.equal(planned.request.url,'https://www.marktstammdatenregister.de/MaStR/Gesamtdatenexport_20261024.zip');
 assert.equal(planned.request.method,'GET');assert.equal(planned.request.body,null);assert.equal(planned.request.credentials,'none');assert.equal(planned.request.maxBodyBytes,R2_STRUCTURED_CAPS.maxBulkCompressedBytes);
 assert.equal(planned.requiresCanonicalDiscoveryReplay,true);assert.equal(planned.requiresNewIssuedRequestPin,true);assert.equal(planned.requiresReviewedStreamingTransportAndParser,true);assert.equal(planned.executableByExistingCore,false);
 assert.deepEqual(planned.discovery,{...pins,landing:R2_MASTR_LANDING,nativeId:'/MaStR/Gesamtdatenexport_20261024.zip'});
});

test('interactive, absent, ambiguous and signed export references cannot become guessed data requests',()=>{
 for(const html of ['<a href="#" class="js-show-csv-modal">CSV-Export</a>','<html>No export</html>','<a href="/MaStR/Gesamtdatenexport_1.zip">Gesamtdatenexport</a><a href="/MaStR/Gesamtdatenexport_2.zip">Gesamtdatenexport</a>','<a href="/MaStR/Gesamtdatenexport.zip?token=synthetic">Gesamtdatenexport</a>']){
  const {result,pins}=discovered(html);assert.throws(()=>planR2MastrBulkRequest(result,pins));
 }
});

test('bulk resolution requires complete exact native GET discovery and immutable evidence pins',()=>{
 const {result,pins}=discovered();
 assert.throws(()=>planR2MastrBulkRequest({...result,coverage:{...result.coverage,nextCursor:'synthetic-next'}},pins),/Complete bounded native discovery/);
 assert.throws(()=>planR2MastrBulkRequest(result,{...pins,stepReceiptSha256:'not-a-hash'}));
 for(const change of [{parentId:'https://example.org/'},{method:'POST' as const},{body:'session=synthetic'},{nativeId:'fabricated'}])assert.throws(()=>planR2MastrBulkRequest({...result,resources:[{...result.resources[0],...change}]},pins),/differs from exact native/);
});

test('a terminal discovery page cannot hide an earlier bulk candidate',()=>{
 const fillers=Array.from({length:MASTR_LIMITS.resources-1},(_,index)=>`<a href="/MaStR/100-filler-${String(index).padStart(2,'0')}.csv">Synthetic CSV</a>`).join('');
 const input=landing(`<a href="/MaStR/000-Gesamtdatenexport.zip">Synthetic first Gesamtdatenexport</a>${fillers}<a href="/MaStR/999-Gesamtdatenexport.zip">Synthetic last Gesamtdatenexport</a>`);
 const first=mastrAdapter.discover(input,scope,null);
 assert.equal(first.resources.length,MASTR_LIMITS.resources);assert.ok(first.coverage.nextCursor);
 assert.equal(first.resources.filter(resource=>resource.format==='zip').length,1);
 const last=mastrAdapter.discover(input,scope,first.coverage.nextCursor);
 assert.equal(last.coverage.nextCursor,null);assert.equal(last.resources.length,1);
 assert.equal(last.resources[0].url,'https://www.marktstammdatenregister.de/MaStR/999-Gesamtdatenexport.zip');
 assert.equal(last.coverage.observedRows,MASTR_LIMITS.resources+1);
 for(const [page,result] of [['first',first],['last',last]] as const){
  const pins={sourceSha256:input.sourceSha256,policyReceiptSha256:input.policyReceiptSha256,stepReceiptSha256:digest('synthetic '+page+' discovery receipt'),resultSha256:digest(JSON.stringify(result))};
  assert.throws(()=>planR2MastrBulkRequest(result,pins),/Complete bounded native discovery/);
 }
});
