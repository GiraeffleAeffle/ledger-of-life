import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash} from '../src/common.ts';
import {PoliteFetcher,PoliteFetchError} from '../src/polite-fetch.ts';
import {crawlDistrictRegistry} from '../src/district-crawl.ts';
import {discoverDocumentLinks,crawlHtmlSource,crawlMvPlanningApi,crawlParticipationApi,crawlOparlSource,createPoliteCouncilLoader} from '../src/district-source-adapters.ts';
import type {RegistryMunicipality,RegistrySource} from '../src/district-source-adapters.ts';
import {metadataPdf} from './fixtures/tdm-pdf.ts';
import {PDF_TDM_POLICY_VERSION} from '../src/pdf-tdm-policy.ts';
import type {SourceAccessPolicy} from '../src/source-policy.ts';

// Synthetic upstream policy for frontier tests; PDF parsing itself uses complete PDF fixtures.
function fixturePolicy(url:string,sha256:string,checkedAt:string,mimeType:string):SourceAccessPolicy {
 return {robots:{state:'allowed',url:new URL('/robots.txt',url).href,checkedAt},tdm:{state:'not_declared',evidence:mimeType==='application/pdf'?[{url,sha256,checkedAt,locator:`PDF.js fixture XMP metadata (${PDF_TDM_POLICY_VERSION})`,value:'no_tdm_reservation_field'}]:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'};
}
const source:RegistrySource={id:'city-planning',kind:'participation',url:'https://stadt.de/planning',vendor:'other',checkState:'checked',checkedAt:'2026-10-01T00:00:00.000Z',evidence:[{url:'https://stadt.de/planning',locator:'Planning portal'}]};
const city:RegistryMunicipality={id:'ludwigslust',name:'Ludwigslust',ags:'13076090',districtId:'ludwigslust-parchim',sources:[source]};

test('HTML discovery follows actual public PDF links, rejects private URLs and unrelated navigation',()=>{
 const links=discoverDocumentLinks('<a href="/plan.pdf">Plan &amp; Begründung</a><a href="https://files.stadt.de/plan.pdf">Anlage</a><a href="http://127.1/plan.pdf">private</a><a href="/login">Login</a><a href="/tourismus">Tourismus</a><a href="/bekanntmachungen/plan">Bekanntmachung</a><a href="https://other.de/bekanntmachung">foreign navigation</a>','https://stadt.de/planning');
 assert.deepEqual(links.map(link=>link.url),['https://stadt.de/plan.pdf','https://files.stadt.de/plan.pdf','https://stadt.de/bekanntmachungen/plan']);assert.equal(links[0].title,'Plan & Begründung');
});
test('HTML fallback prioritizes grounded document seeds and keeps event date unknown',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-adapter-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const fetcher=new PoliteFetcher({cacheDir:folder}),seen:string[]=[];
 t.mock.method(fetcher,'fetch',async(url:string)=>{
  seen.push(url);const body=Buffer.from(url.endsWith('.pdf')?'%PDF-1.7 fixture':'<h1>Planning</h1><a href="/plan.pdf">Plan</a>');const localPath=join(folder,hash(body));await writeFile(localPath,body);
  return {url,sha256:hash(body),localPath,mimeType:url.endsWith('.pdf')?'application/pdf':'text/html',retrievedAt:'2026-10-01T00:00:00.000Z',checkedAt:'2026-10-01T00:00:00.000Z',status:200,observationPath:join(folder,'observation.json'),policy:fixturePolicy(url,hash(body),'2026-10-01T00:00:00.000Z',url.endsWith('.pdf')?'application/pdf':'text/html')};
 });
 const result=await crawlHtmlSource(fetcher,{...city,seedDocuments:[{url:'https://stadt.de/plan.pdf',sourceId:source.id}]},source,{maxDocuments:1,maxPages:2,maxRequests:3});
 assert.deepEqual(seen,['https://stadt.de/plan.pdf']);assert.equal(result.documents[0].documentDate,null);assert.equal(result.documents[0].ags,city.ags);assert.equal(result.documents[0].adapter,'official-pdf');assert.equal(result.coverage?.state,'partial');assert.equal(result.coverage?.pendingCount,1);
});
test('robots blocked source remains checked failure, not nonexistent',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-checks-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const fetcher=new PoliteFetcher({cacheDir:folder});t.mock.method(fetcher,'fetch',async()=>{throw new PoliteFetchError('robots_blocked','Robots disallows source');});
 const index=await crawlDistrictRegistry({schemaVersion:'stadtstack-source-registry-v1',municipalities:[city]},fetcher,{maxDocuments:3,maxPages:2,maxRequests:3});
 assert.equal(index.checks[0].checkState,'checked');assert.equal(index.checks[0].outcome,'blocked');assert.equal(index.checks[0].blocked?.[0].failure,'robots_blocked');assert.equal(index.documents.length,0);
});
test('MV public API flattens observed nested results and binds exact AGS before following PDFs',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-mv-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const fetcher=new PoliteFetcher({cacheDir:folder}),seen:string[]=[];
 const mvSource:RegistrySource={...source,api:{url:'https://www.gaia-mv.de/geoportalsearch/_ajax/search/?type=Bauleitplan&x_filter%5Bregionalschluessel%5D=130760090090',format:'mv-bauleitplan'}};
 t.mock.method(fetcher,'fetch',async(url:string)=>{
  seen.push(url);const api=url.includes('geoportalsearch'),body=Buffer.from(api?JSON.stringify({success:true,total:2,hits:2,results:[[{_resourceLinkId:'plan-1',title:'Ludwigslust B-Plan',x_GKZ:['13076090'],x_dokumentURL:['https://bauleitplaene-mv.de/download/plan.pdf']},{_resourceLinkId:'wrong-city',title:'Wrong city',x_GKZ:['13076108'],x_dokumentURL:['https://bauleitplaene-mv.de/download/wrong.pdf']}]]}):'%PDF-fixture');const localPath=join(folder,hash(body));await writeFile(localPath,body);
  return {url,sha256:hash(body),localPath,mimeType:api?'application/json':'application/pdf',retrievedAt:'2026-10-01T00:00:00.000Z',checkedAt:'2026-10-01T00:00:00.000Z',status:200,observationPath:join(folder,'observation.json'),policy:fixturePolicy(url,hash(body),'2026-10-01T00:00:00.000Z',api?'application/json':'application/pdf')};
 });
 const result=await crawlMvPlanningApi(fetcher,city,mvSource,{maxDocuments:3,maxPages:2,maxRequests:4});
 assert.equal(result.documents.filter(document=>document.adapter==='mv-bauleitplan').length,1);assert.equal(result.documents[0].metadata.caseKey,'plan-1');assert.equal(result.documents[0].documentDate,null);assert.ok(!seen.some(url=>url.includes('wrong.pdf')));assert.match(result.notes[0],/evidence [a-f0-9]{64}/);
});
test('DiPlan observed list protocol preserves API case identity without fabricating stage',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-diplan-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const fetcher=new PoliteFetcher({cacheDir:folder});const apiSource:RegistrySource={...source,api:{url:'https://bb.beteiligung.diplanung.de/list/json',format:'diplan-list',method:'POST',form:{search:'',municipalCode:''}}};
 t.mock.method(fetcher,'fetch',async(url:string)=>{
  const api=url.endsWith('/list/json'),body=Buffer.from(api?JSON.stringify({success:true,procedureCount:1,mapVars:[{procedureId:'case-1',procedureUrl:'/verfahren/case-1/public/detail',externalName:'Ludwigslust Testverfahren',publicParticipationStartDate:'01.07.2026'}],responseHtml:'<div class="c-procedurelist__item" data-procedure-id="case-1">Ludwigslust</div>'}):'<h1>Ludwigslust Testverfahren</h1>');const localPath=join(folder,hash(body));await writeFile(localPath,body);
  return {url,sha256:hash(body),localPath,mimeType:api?'application/json':'text/html',retrievedAt:'2026-10-01T00:00:00.000Z',checkedAt:'2026-10-01T00:00:00.000Z',status:200,observationPath:join(folder,'observation.json')};
 });
 const result=await crawlParticipationApi(fetcher,city,apiSource,{maxDocuments:2,maxPages:2,maxRequests:3});assert.equal(result.documents[0].metadata.caseKey,'case-1');assert.equal(result.documents[0].metadata.stage,undefined);assert.equal(result.documents[0].documentDate,null);
});
test('failed public API retains confirmed official-document fallback within its request budget',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-fallback-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const fetcher=new PoliteFetcher({cacheDir:folder}),apiSource:RegistrySource={...source,api:{url:'https://api.stadt.de/plans',format:'mv-bauleitplan'}};
 type Wire={wire(url:URL):Promise<{status:number;headers:Record<string,string>;body:Buffer}>};
 t.mock.method(fetcher as unknown as Wire,'wire',async(url:URL)=>{
  if(url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  if(url.hostname==='api.stadt.de')return {status:503,headers:{},body:Buffer.alloc(0)};
  return {status:200,headers:{'content-type':'application/pdf'},body:metadataPdf()};
 });
 const registry={schemaVersion:'stadtstack-source-registry-v1' as const,municipalities:[{...city,sources:[apiSource],seedDocuments:[{sourceId:source.id,url:'https://stadt.de/known.pdf'}]}]};
 const index=await crawlDistrictRegistry(registry,fetcher,{maxDocuments:2,maxPages:2,maxRequests:2});
 assert.equal(index.documents.length,1);assert.equal(fetcher.requestCount,2);assert.equal(index.checks[0].requests,2);assert.match(index.checks[0].reason!,/official-document fallback/);assert.match(index.checks[0].reason!,/http_error/);
});
test('shared council loader reports evidence lifecycle after conditional validation',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-loader-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const fetcher=new PoliteFetcher({cacheDir:folder}),body=Buffer.from('{\"data\":[]}'),localPath=join(folder,hash(body));await writeFile(localPath,body);
 t.mock.method(fetcher,'fetch',async(url:string)=>({url,sha256:hash(body),localPath,mimeType:'application/json',retrievedAt:'2026-09-01T00:00:00.000Z',checkedAt:'2026-10-01T00:00:00.000Z',status:304,observationPath:join(folder,'observation.json')}));
 const observations:string[]=[],loader=createPoliteCouncilLoader(fetcher,{maxRequests:2,onDocument:document=>{observations.push(document.retrievedAt);}});
 const result=await loader('https://stadt.de/oparl/papers');
 assert.equal(result.retrievedAt,'2026-09-01T00:00:00.000Z');assert.equal(result.checkedAt,'2026-10-01T00:00:00.000Z');
 assert.deepEqual(observations,['2026-09-01T00:00:00.000Z']);assert.deepEqual(result.data,{data:[]});
});
test('230 linked PDFs plus structured plans survive bounded restart and automatic frontier exhaustion',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-full-frontier-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const seen:string[]=[],root='https://stadt.de/bauleitplanung-2/',scopedSource:RegistrySource={...source,url:root,crawlScope:{pageRoots:[root],followLinkedDocuments:true}};
 const registry={schemaVersion:'stadtstack-source-registry-v1' as const,municipalities:[{...city,sources:[scopedSource]}]};
 const fixtureFetch=async(url:string)=>{
  seen.push(url);let mimeType='application/pdf',text='%PDF-1.7 '+url;
  if(url===root){mimeType='text/html';text='<h1>Bauleitplanung</h1>'+Array.from({length:230},(_,index)=>`<a href="/plans/${index}.pdf">Plan ${index}</a>`).join('')+'<a href="/plans/xplanung.gml">XPlanung</a><a href="/plans/xplanung.zip">XPlanung ZIP</a><a href="/bauleitplanung/deep-1">Weitere Bauleitplanung</a>';}
  else if(url.includes('/bauleitplanung/deep-')){mimeType='text/html';const depth=Number(url.split('-').at(-1));text=depth<5?`<h1>Bauleitplanung</h1><a href="/bauleitplanung/deep-${depth+1}">Weitere Bauleitplanung</a>`:'<h1>Bauleitplanung</h1><a href="/plans/deep.pdf">Plan</a>';}
  else if(url.endsWith('.gml')){mimeType='application/gml+xml';text='<gml:FeatureCollection xmlns:gml="http://www.opengis.net/gml"/>';}
  else if(url.endsWith('.zip')){mimeType='application/zip';text='PK fixture';}
  const body=Buffer.from(text),localPath=join(folder,hash(body));await writeFile(localPath,body);
  const observedAt=new Date().toISOString();return {url,sha256:hash(body),localPath,mimeType,retrievedAt:observedAt,checkedAt:observedAt,status:200,observationPath:join(folder,'observation.json'),policy:fixturePolicy(url,hash(body),observedAt,mimeType)};
 };
 const firstFetcher=new PoliteFetcher({cacheDir:folder});t.mock.method(firstFetcher,'fetch',fixtureFetch);
 const partial=await crawlDistrictRegistry(registry,firstFetcher,{maxDocuments:8,maxPages:3,maxRequests:24,maxRounds:1});
 assert.equal(partial.checks[0].coverage?.state,'partial');assert.ok(partial.checks[0].coverage!.pendingCount>200);
 const secondFetcher=new PoliteFetcher({cacheDir:folder});t.mock.method(secondFetcher,'fetch',fixtureFetch);
 const complete=await crawlDistrictRegistry(registry,secondFetcher,{maxDocuments:8,maxPages:3,maxRequests:24});
 assert.equal(complete.checks[0].coverage?.state,'complete');assert.equal(complete.checks[0].coverage?.pendingCount,0);
 assert.equal(complete.documents.filter(document=>document.mimeType==='application/pdf').length,231);
 assert.equal(complete.documents.filter(document=>document.adapter==='xplanung-document').length,2);
 assert.ok(complete.documents.some(document=>document.url.endsWith('/plans/deep.pdf')));
 assert.equal(seen.filter(url=>url===root).length,1);assert.equal(new Set(seen).size,seen.length);
});
test('Deep archives take bounded turns so later municipalities are reached before another round',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-fair-rounds-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const fetcher=new PoliteFetcher({cacheDir:folder}),turns:string[]=[];
 const municipalities=['first','second'].map(id=>({...city,id,sources:[{...source,url:`https://stadt.de/${id}/`,crawlScope:{pageRoots:[`https://stadt.de/${id}/`],followLinkedDocuments:true}}]}));
 t.mock.method(fetcher,'fetch',async(url:string)=>{
  const pdf=url.endsWith('.pdf'),mimeType=pdf?'application/pdf':'text/html';
  const bytes=Buffer.from(pdf?`%PDF-1.7 ${url}`:'<h1>Bauleitplanung</h1>'+Array.from({length:4},(_,i)=>`<a href="${i}.pdf">Plan ${i}</a>`).join(''));
  const localPath=join(folder,hash(bytes));await writeFile(localPath,bytes);
  const at=new Date().toISOString();return {url,sha256:hash(bytes),localPath,mimeType,retrievedAt:at,checkedAt:at,status:200,observationPath:join(folder,'observation.json'),policy:fixturePolicy(url,hash(bytes),at,mimeType)};
 });
 const index=await crawlDistrictRegistry({schemaVersion:'stadtstack-source-registry-v1',municipalities},fetcher,{maxDocuments:1,maxPages:1,maxRequests:3,maxRounds:2,onSource:async snapshot=>{
  const previous=turns.length<2?1:2,updated=snapshot.checks.find(check=>check.rounds===previous&&!turns.includes(`${previous}:${check.municipalityId}`));
  assert.ok(updated);turns.push(`${previous}:${updated.municipalityId}`);
 }});
 assert.deepEqual(turns,['1:first','1:second','2:first','2:second']);
 assert.ok(index.checks.every(check=>check.coverage?.state==='partial'&&check.rounds===2));
 assert.equal(index.documents.filter(document=>document.municipalityId==='first').length,2);
 assert.equal(index.documents.filter(document=>document.municipalityId==='second').length,2);
});
test('discovery-only statewide portal is checked without unbound municipal expansion',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-discovery-only-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const fetcher=new PoliteFetcher({cacheDir:folder}),seen:string[]=[];
 t.mock.method(fetcher,'fetch',async(url:string)=>{
  seen.push(url);const body=Buffer.from('<h1>Landesportal</h1><a href="/verfahren/fremde-stadt">Verfahren</a><a href="/other-city.pdf">Plan</a>'),localPath=join(folder,hash(body));await writeFile(localPath,body);
  return {url,sha256:hash(body),localPath,mimeType:'text/html',retrievedAt:'2026-10-01T00:00:00.000Z',checkedAt:'2026-10-01T00:00:00.000Z',status:200,observationPath:join(folder,'observation.json')};
 });
 const result=await crawlHtmlSource(fetcher,city,{...source,crawlScope:{pageRoots:[],followLinkedDocuments:false}},{maxDocuments:8,maxPages:3,maxRequests:24});
 assert.equal(seen.length,1);assert.match(result.notes.join(' '),/municipal procedure binding is not established/);
});
test('TTL rediscovery finds new links, preserves unfinished work and does not freshen unchecked cache',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-ttl-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-10T12:00:00.000Z')});
 const fetcher=new PoliteFetcher({cacheDir:folder}),seen:string[]=[],representations=new Map<string,{sha256:string;retrievedAt:string}>();let expanded=false;
 t.mock.method(fetcher,'fetch',async(url:string)=>{
  seen.push(url);const isRoot=url===source.url,body=Buffer.from(isRoot?'<h1>Planning</h1><a href="/plan-a.pdf">Plan A</a>'+(expanded?'<a href="/plan-b.pdf">Plan B</a>':''):'%PDF fixture '+url),sha256=hash(body),localPath=join(folder,sha256),checkedAt=new Date().toISOString(),prior=representations.get(url);
  await writeFile(localPath,body);const same=prior?.sha256===sha256,retrievedAt=same?prior.retrievedAt:checkedAt;representations.set(url,{sha256,retrievedAt});
  return {url,sha256,localPath,mimeType:isRoot?'text/html':'application/pdf',retrievedAt,checkedAt,status:same?304:200,observationPath:join(folder,'observation.json'),policy:fixturePolicy(url,sha256,checkedAt,isRoot?'text/html':'application/pdf')};
 });
 const registry={schemaVersion:'stadtstack-source-registry-v1' as const,municipalities:[city]},options={maxDocuments:2,maxPages:3,maxRequests:4,revalidateAfterMs:24*60*60_000};
 const first=await crawlDistrictRegistry(registry,fetcher,options),original=first.documents.find(document=>document.url.endsWith('/plan-a.pdf'))!;
 t.mock.timers.tick(60*60_000);
 const cached=await crawlDistrictRegistry(registry,fetcher,options);assert.equal(seen.length,2);assert.equal(cached.checks[0].checkedAt,first.checks[0].checkedAt);assert.equal(cached.checks[0].requests,0);
 expanded=true;t.mock.timers.tick(24*60*60_000);
 const partial=await crawlDistrictRegistry(registry,fetcher,{...options,maxRounds:1});assert.equal(partial.checks[0].coverage?.state,'partial');assert.equal(partial.checks[0].coverage?.runnableCount,1);
 const refreshed=partial.documents.find(document=>document.url===original.url)!;assert.equal(refreshed.sha256,original.sha256);assert.equal(refreshed.id,original.id);assert.equal(refreshed.retrievedAt,original.retrievedAt);assert.notEqual(refreshed.checkedAt,original.checkedAt);assert.equal(refreshed.status,304);
 const complete=await crawlDistrictRegistry(registry,fetcher,options);assert.equal(complete.checks[0].coverage?.state,'complete');assert.ok(complete.documents.some(document=>document.url.endsWith('/plan-b.pdf')));assert.equal(seen.filter(url=>url===source.url).length,2);
});
test('expired document is withdrawn when current policy rejects revalidation',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-ttl-blocked-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-10T12:00:00.000Z')});
 const fetcher=new PoliteFetcher({cacheDir:folder}),direct={...source,url:'https://stadt.de/plan.pdf'};let reserved=false;
 t.mock.method(fetcher,'fetch',async(url:string)=>{
  if(reserved)throw new PoliteFetchError('tdm_reserved','Current publisher reservation; ask municipality');
  const body=Buffer.from('%PDF fixture'),localPath=join(folder,hash(body)),checkedAt=new Date().toISOString();await writeFile(localPath,body);
  return {url,sha256:hash(body),localPath,mimeType:'application/pdf',retrievedAt:checkedAt,checkedAt,status:200,observationPath:join(folder,'observation.json'),policy:fixturePolicy(url,hash(body),checkedAt,'application/pdf')};
 });
 const registry={schemaVersion:'stadtstack-source-registry-v1' as const,municipalities:[{...city,sources:[direct]}]},options={maxDocuments:2,maxPages:2,maxRequests:3,revalidateAfterMs:60*60_000};
 const first=await crawlDistrictRegistry(registry,fetcher,options);assert.equal(first.documents.length,1);
 reserved=true;t.mock.timers.tick(2*60*60_000);
 const blocked=await crawlDistrictRegistry(registry,fetcher,options);assert.equal(blocked.documents.length,0);assert.equal(blocked.checks[0].outcome,'blocked');assert.equal(blocked.checks[0].blocked?.[0].failure,'tdm_reserved');
});
test('incomplete OParl Body inventory exposes one runnable durable cursor',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-body-cursor-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const fetcher=new PoliteFetcher({cacheDir:folder}),endpoint='https://council.stadt.de/system';
 t.mock.method(fetcher,'fetch',async(url:string)=>{
  const data=url===endpoint?{id:endpoint,type:'https://schema.oparl.org/1.1/System',body:'https://council.stadt.de/bodies'}:{data:[{id:'https://council.stadt.de/body/1',type:'https://schema.oparl.org/1.1/Body',name:city.name}],links:{next:'https://council.stadt.de/bodies?page=2'}};
  const bytes=Buffer.from(JSON.stringify(data)),localPath=join(folder,hash(bytes)),checkedAt=new Date().toISOString();await writeFile(localPath,bytes);
  return {url,sha256:hash(bytes),localPath,mimeType:'application/json',retrievedAt:checkedAt,checkedAt,status:200,observationPath:join(folder,'observation.json')};
 });
 const result=await crawlOparlSource(fetcher,city,{...source,url:endpoint,vendor:'oparl'},{maxDocuments:2,maxPages:1,maxRequests:5});
 assert.equal(result.coverage?.state,'partial');assert.equal(result.coverage?.pendingCount,1);assert.equal(result.coverage?.runnableCount,1);assert.equal(result.documents.length,0);
});
test('completed MV API cursor is conditionally rediscovered after TTL rather than frozen forever',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-mv-ttl-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-10T12:00:00.000Z')});
 const fetcher=new PoliteFetcher({cacheDir:folder}),mvSource:RegistrySource={...source,api:{url:'https://www.gaia-mv.de/geoportalsearch/_ajax/search/?type=Bauleitplan',format:'mv-bauleitplan'}};let expanded=false,apiCalls=0;
 t.mock.method(fetcher,'fetch',async(url:string)=>{
  const api=url.includes('geoportalsearch');if(api)apiCalls++;
  const records=[{_resourceLinkId:'plan-a',title:'Ludwigslust Plan A',x_GKZ:[city.ags],x_dokumentURL:['https://stadt.de/plan-a.pdf']},...(expanded?[{_resourceLinkId:'plan-b',title:'Ludwigslust Plan B',x_GKZ:[city.ags],x_dokumentURL:['https://stadt.de/plan-b.pdf']}]:[])];
  const mimeType=api?'application/json':url===source.url?'text/html':'application/pdf',body=Buffer.from(api?JSON.stringify({success:true,total:records.length,hits:records.length,results:[records]}):mimeType==='text/html'?'<h1>Planning</h1>':'%PDF fixture '+url),localPath=join(folder,hash(body)),checkedAt=new Date().toISOString();await writeFile(localPath,body);
  return {url,sha256:hash(body),localPath,mimeType,retrievedAt:checkedAt,checkedAt,status:200,observationPath:join(folder,'observation.json'),policy:fixturePolicy(url,hash(body),checkedAt,mimeType)};
 });
 const options={maxDocuments:4,maxPages:3,maxRequests:8,revalidateAfterMs:24*60*60_000};
 const first=await crawlMvPlanningApi(fetcher,city,mvSource,options);assert.equal(apiCalls,1);assert.equal(first.coverage?.state,'complete');
 t.mock.timers.tick(60*60_000);
 const cached=await crawlMvPlanningApi(fetcher,city,mvSource,options);assert.equal(apiCalls,1);assert.equal(cached.requests,0);assert.equal(cached.checkedAt,first.checkedAt);
 expanded=true;t.mock.timers.tick(24*60*60_000);
 const refreshed=await crawlMvPlanningApi(fetcher,city,mvSource,options);assert.equal(apiCalls,2);assert.ok(refreshed.documents.some(document=>document.metadata.caseKey==='plan-b'));assert.equal(refreshed.coverage?.state,'complete');
});
test('fresh cached PDF with v1 proof is withheld and revalidated despite a long TTL',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-policy-upgrade-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-10T12:00:00.000Z')});
 const fetcher=new PoliteFetcher({cacheDir:folder}),direct={...source,url:'https://stadt.de/plan.pdf'};let calls=0;
 t.mock.method(fetcher,'fetch',async(url:string)=>{
  calls++;const body=metadataPdf(),sha256=hash(body),localPath=join(folder,sha256),checkedAt=new Date().toISOString();await writeFile(localPath,body);
  return {url,sha256,localPath,mimeType:'application/pdf',retrievedAt:checkedAt,checkedAt,status:200,observationPath:join(folder,'observation.json'),policy:fixturePolicy(url,sha256,checkedAt,'application/pdf')};
 });
 const options={maxDocuments:2,maxPages:2,maxRequests:3,revalidateAfterMs:30*24*60*60_000};
 const first=await crawlHtmlSource(fetcher,city,direct,options),frontierPath=first.coverage!.frontierPath!;
 const legacy=JSON.parse(await readFile(frontierPath,'utf8'));legacy.documents[0].policy.tdm.evidence[0].locator='PDF.js fixture XMP metadata (pdf-tdm-v1)';await writeFile(frontierPath,JSON.stringify(legacy));
 const withheld=await crawlHtmlSource(fetcher,city,direct,{...options,maxRequests:0});assert.equal(withheld.documents.length,0);assert.equal(withheld.coverage?.state,'partial');assert.equal(withheld.coverage?.runnableCount,1);assert.equal(calls,1);
 const refreshed=await crawlHtmlSource(fetcher,city,direct,options);assert.equal(calls,2);assert.equal(refreshed.documents.length,1);assert.equal(refreshed.documents[0].sha256,first.documents[0].sha256);assert.ok(refreshed.documents[0].policy!.tdm.evidence[0].locator.endsWith(`(${PDF_TDM_POLICY_VERSION})`));
});
