import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,lstat,mkdir,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash} from '../src/common.ts';
import {PoliteFetcher as BasePoliteFetcher,PoliteFetchError} from '../src/polite-fetch.ts';
import {createDistrictCrawlFetcher,crawlDistrictRegistry,projectCrawlIndexDenials,type DistrictCrawlIndex} from '../src/district-crawl.ts';
import {discoverDocumentLinks,crawlHtmlSource,crawlMvPlanningApi,crawlParticipationApi,crawlOparlSource} from '../src/district-source-adapters.ts';
import {createPoliteCouncilLoader} from '../src/council-cache.ts';
import type {RegistryMunicipality,RegistrySource} from '../src/district-source-adapters.ts';
import {metadataPdf} from './fixtures/tdm-pdf.ts';
import {PDF_TDM_POLICY_VERSION} from '../src/pdf-tdm-policy.ts';
import { DOCUMENT_ORIGIN_CLASSIFIER_VERSION } from '../src/document-origin-contract.ts'
import type {SourceAccessPolicy} from '../src/source-policy.ts';
import {ownerRobotsOverrideFor} from '../src/source-policy.ts';
import type {PoliteFetcherOptions,SourceContentBinding,FetchOptions} from '../src/polite-fetch.ts';
import {politeTestOptions} from './fixtures/polite-lane.ts';
import {writePrivateJson} from '../src/district-private-io.ts';
import {assertCivicPolicyAuthority,type CivicPolicyOptions} from '../src/civic-opt-out.ts';
import {fixturePolicyInspection} from './fixtures/polite-inspection.ts';
import {CrawlRequestEvidenceCaptureError} from '../src/district-crawl-request.ts';
import {largeBobInventory} from './fixtures/bob-inventory.ts';

/** Adapter-unit fetch/read/write doubles use explicit fixture authority, not a production acquisition marker. */
class AdapterFixtureFetcher extends BasePoliteFetcher {
 private readonly fixturePolicy:CivicPolicyOptions;
 constructor(options:PoliteFetcherOptions){
  super(options);assert.ok(options.ownerPolicyLane?.authorityId?.startsWith('fixture:'),'Adapter unit doubles require fixture authority');
  this.fixturePolicy=options.ownerPolicyLane!;
 }
 override async initialize():Promise<void>{
  await assertCivicPolicyAuthority(this.fixturePolicy);await mkdir(this.cacheDir,{recursive:true,mode:0o700});
 }
 override async assertSourceReadable(path:string,sourceUrl?:string):Promise<void>{
  await this.initialize();if(sourceUrl)await this.assertHostAllowed(sourceUrl);
  assert.equal((await lstat(path)).isFile(),true,'Adapter fixture source must exist');
 }
 override async assertSourceBindingsAllowed(bindings:SourceContentBinding[]):Promise<void>{
  await this.initialize();assert.ok(bindings.length,'Adapter fixture must carry its mocked upstream binding');
  for(const binding of bindings)await this.assertHostAllowed(binding.url);
 }
 override async persistDerivedJson(path:string,value:unknown,_bindings:SourceContentBinding[]):Promise<void>{
  await this.initialize();await writePrivateJson(path,value);
 }
}
async function createPoliteFetcher(options:PoliteFetcherOptions):Promise<AdapterFixtureFetcher> {
 return new AdapterFixtureFetcher(await politeTestOptions({...options,cacheDir:join(options.cacheDir,'managed')}));
}
/** Wire-only tests retain every real transport and managed-lifecycle gate. */
async function createWireFetcher(options:PoliteFetcherOptions):Promise<BasePoliteFetcher>{
 return new BasePoliteFetcher({...await politeTestOptions({...options,cacheDir:join(options.cacheDir,'managed')}),fixtureInspection:fixturePolicyInspection});
}

// Synthetic upstream policy for frontier tests; PDF parsing itself uses complete PDF fixtures.
function fixturePolicy(url:string,sha256:string,checkedAt:string,mimeType:string):SourceAccessPolicy {
 return {robots:{state:'allowed',url:new URL('/robots.txt',url).href,checkedAt},tdm:{state:'not_declared',evidence:mimeType==='application/pdf'?[{url,sha256,checkedAt,locator:`PDF.js fixture XMP metadata (${PDF_TDM_POLICY_VERSION})`,value:'no_tdm_reservation_field'}]:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'};
}
const source:RegistrySource={id:'city-planning',kind:'participation',url:'https://stadt.de/planning',vendor:'other',checkState:'checked',checkedAt:'2026-10-01T00:00:00.000Z',evidence:[{url:'https://stadt.de/planning',locator:'Planning portal'}]};
const city:RegistryMunicipality={id:'ludwigslust',name:'Ludwigslust',ags:'13076090',districtId:'ludwigslust-parchim',sources:[source]};

test('standalone crawler fetcher consumes the shared configured pacing floor without acquisition',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-crawl-pacing-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const config=JSON.parse(await readFile(new URL('../sources/district-host-groups.json',import.meta.url),'utf8'));
 const fetcher=await createDistrictCrawlFetcher({cacheDir:folder,policyTtlMs:30_000});
 assert.ok(fetcher instanceof BasePoliteFetcher);
 assert.equal(fetcher.options.minDelayMs,config.serviceGroups[0].minStartIntervalMs);
 assert.equal(fetcher.options.minDelayMs,2500);assert.equal(config.serviceGroups[0].maxInFlight,1);
 assert.equal(fetcher.options.policyTtlMs,30_000);assert.equal(fetcher.requestCount,0);
 assert.deepEqual(await readdir(folder),[]);
});
test('standalone crawler rejects invalid host spacing and concurrency config before acquisition',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-crawl-invalid-pacing-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const config=JSON.parse(await readFile(new URL('../sources/district-host-groups.json',import.meta.url),'utf8')),group=config.serviceGroups[0],path=join(folder,'host-groups.json');
 for(const changed of [
  {...config,serviceGroups:[{...group,minStartIntervalMs:2000}]},
  {...config,serviceGroups:[{...group,maxInFlight:2}]},
  {...config,serviceGroups:[{...group,unrecognized:true}]},
  {...config,serviceGroups:[]},
  {...config,serviceGroups:[group,group]},
  {...config,unrecognized:true},
 ]){
  await writeFile(path,JSON.stringify(changed));
  await assert.rejects(createDistrictCrawlFetcher({cacheDir:join(folder,'raw')},path),{name:'ZodError'});
 }
 await writeFile(path,'not JSON');
 await assert.rejects(createDistrictCrawlFetcher({cacheDir:join(folder,'raw')},path),SyntaxError);
 await assert.rejects(createDistrictCrawlFetcher({cacheDir:join(folder,'raw')},join(folder,'missing.json')),{code:'ENOENT'});
 await assert.rejects(lstat(join(folder,'raw')),{code:'ENOENT'});
});

test('HTML discovery follows actual public PDF links, rejects private URLs and unrelated navigation',()=>{
 const links=discoverDocumentLinks('<a href="/plan.pdf">Plan &amp; Begründung</a><a href="https://files.stadt.de/plan.pdf">Anlage</a><a href="http://127.1/plan.pdf">private</a><a href="/login">Login</a><a href="/tourismus">Tourismus</a><a href="/bekanntmachungen/plan">Bekanntmachung</a><a href="https://other.de/bekanntmachung">foreign navigation</a>','https://stadt.de/planning');
 assert.deepEqual(links.map(link=>link.url),['https://stadt.de/plan.pdf','https://files.stadt.de/plan.pdf','https://stadt.de/bekanntmachungen/plan']);assert.equal(links[0].title,'Plan & Begründung');
});
test('HTML fallback prioritizes grounded document seeds and keeps event date unknown',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-adapter-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const fetcher=await createPoliteFetcher({cacheDir:folder}),seen:string[]=[];
 t.mock.method(fetcher,'fetch',async(url:string)=>{
  seen.push(url);const body=Buffer.from(url.endsWith('.pdf')?'%PDF-1.7 fixture':'<h1>Planning</h1><a href="/plan.pdf">Plan</a>');const localPath=join(folder,hash(body));await writeFile(localPath,body);
  return {url,sha256:hash(body),localPath,mimeType:url.endsWith('.pdf')?'application/pdf':'text/html',retrievedAt:'2026-10-01T00:00:00.000Z',checkedAt:'2026-10-01T00:00:00.000Z',status:200,observationPath:join(folder,'observation.json'),policy:fixturePolicy(url,hash(body),'2026-10-01T00:00:00.000Z',url.endsWith('.pdf')?'application/pdf':'text/html')};
 });
 const result=await crawlHtmlSource(fetcher,{...city,seedDocuments:[{url:'https://stadt.de/plan.pdf',sourceId:source.id}]},source,{maxDocuments:1,maxPages:2,maxRequests:3});
 assert.deepEqual(seen,['https://stadt.de/plan.pdf']);assert.equal(result.documents[0].documentDate,null);assert.equal(result.documents[0].ags,city.ags);assert.equal(result.documents[0].adapter,'official-pdf');assert.equal(result.coverage?.state,'partial');assert.equal(result.coverage?.pendingCount,1);
});
test('robots blocked source remains checked failure, not nonexistent',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-checks-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const fetcher=await createPoliteFetcher({cacheDir:folder});t.mock.method(fetcher,'fetch',async()=>{throw new PoliteFetchError('robots_blocked','Robots disallows source');});
 const index=await crawlDistrictRegistry({schemaVersion:'stadtstack-source-registry-v1',municipalities:[city]},fetcher,{maxDocuments:3,maxPages:2,maxRequests:3});
 assert.equal(index.checks[0].checkState,'checked');assert.equal(index.checks[0].outcome,'blocked');assert.equal(index.checks[0].blocked?.[0].failure,'robots_blocked');assert.equal(index.documents.length,0);
});
test('MV public API flattens observed nested results and binds exact AGS before following PDFs',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-mv-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const fetcher=await createPoliteFetcher({cacheDir:folder}),seen:string[]=[];
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
 const fetcher=await createPoliteFetcher({cacheDir:folder});const apiSource:RegistrySource={...source,api:{url:'https://bb.beteiligung.diplanung.de/list/json',format:'diplan-list',method:'POST',form:{search:'',municipalCode:''}}};
 t.mock.method(fetcher,'fetch',async(url:string)=>{
  const api=url.endsWith('/list/json'),body=Buffer.from(api?JSON.stringify({success:true,procedureCount:1,mapVars:[{procedureId:'case-1',procedureUrl:'/verfahren/case-1/public/detail',externalName:'Ludwigslust Testverfahren',publicParticipationStartDate:'01.07.2026'}],responseHtml:'<div class="c-procedurelist__item" data-procedure-id="case-1">Ludwigslust</div>'}):'<h1>Ludwigslust Testverfahren</h1>');const localPath=join(folder,hash(body));await writeFile(localPath,body);
  return {url,sha256:hash(body),localPath,mimeType:api?'application/json':'text/html',retrievedAt:'2026-10-01T00:00:00.000Z',checkedAt:'2026-10-01T00:00:00.000Z',status:200,observationPath:join(folder,'observation.json')};
 });
 const result=await crawlParticipationApi(fetcher,city,apiSource,{maxDocuments:2,maxPages:2,maxRequests:3});assert.equal(result.documents[0].metadata.caseKey,'case-1');assert.equal(result.documents[0].metadata.stage,undefined);assert.equal(result.documents[0].documentDate,null);
});
function bobInventory(rows:unknown[]):string {
 const encoded=JSON.stringify(rows).replace(/[\s\S]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
 return `<script>var initialProcedures = JSON.parse('${encoded}');</script>`;
}
test('BOB binds exact AGS and ARS without names, isolates legacy roots and excludes neighboring procedures',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-bob-bound-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const fetcher=await createPoliteFetcher({cacheDir:folder}),seen:string[]=[],root='https://bob-sh.de/';
 const bobSource:RegistrySource={...source,id:'schwarzenbek-bob-sh',url:root,crawlScope:{pageRoots:[],followLinkedDocuments:false},api:{url:root+'list/json',format:'bobsh-list',method:'POST',form:{municipalCode:'01053'}}};
 const town:RegistryMunicipality={...city,id:'schwarzenbek',name:'Schwarzenbek',ags:'01053116',sources:[bobSource]};
 const rows=[{id:'exact',municipalCode:town.ags,ars:'010530116116'},{id:'ars',ars:'010535373116'},{id:'neighbor',municipalCode:'01053021',ars:'010535373021'}];
 const mapVars=rows.map(row=>({procedureId:row.id,procedureUrl:`/verfahren/${row.id}/public/detail`,externalName:row.id==='neighbor'?'Amt Schwarzenbek-Land':'Neutraler Planname'}));
 const responseHtml=mapVars.map(row=>`<div class="c-procedurelist__item" data-procedure-id="${row.procedureId}">${row.externalName}</div>`).join('');
 t.mock.method(fetcher,'fetch',async(url:string)=>{
  seen.push(url);const api=url===bobSource.api!.url,pdf=url.endsWith('.pdf');
  const body=Buffer.from(api?JSON.stringify({success:true,procedureCount:mapVars.length,mapVars,responseHtml}):pdf?'%PDF fixture':url===root?bobInventory(rows)+'<a href="/verfahren/neighbor/public/detail">Verfahren</a>':url.endsWith('/public/documents')?'<h1>Dokumente</h1><a href="/deep.pdf">Plan</a>':`<h1>Plan</h1><a href="/plan.pdf">Plan</a><a href="/verfahren/neighbor/public/detail">Nachbarverfahren</a><a href="/?search=beteiligung">Alle Beteiligungen</a><a href="/verfahren/exact/public/documents">Dokumente</a>`);
  const localPath=join(folder,hash(body)),at=new Date().toISOString(),mimeType=api?'application/json':pdf?'application/pdf':'text/html';await writeFile(localPath,body);
  return {url,sha256:hash(body),localPath,mimeType,retrievedAt:at,checkedAt:at,status:200,observationPath:join(folder,'observation.json'),policy:fixturePolicy(url,hash(body),at,mimeType)};
 });
 const legacy=await crawlHtmlSource(fetcher,town,{...bobSource,crawlScope:{pageRoots:[root],followLinkedDocuments:true}},{maxDocuments:1,maxPages:1,maxRequests:1});
 assert.ok(legacy.documents.some(document=>document.url===root));assert.equal(legacy.coverage?.pendingCount,1);seen.length=0;
 const result=await crawlParticipationApi(fetcher,town,bobSource,{maxDocuments:12,maxPages:8,maxRequests:12});
 assert.notEqual(result.coverage?.frontierPath,legacy.coverage?.frontierPath);
 assert.equal(seen.filter(url=>url===root).length,1);assert.ok(!seen.some(url=>url.includes('/neighbor/')||url.includes('?search=')));
 assert.ok(!result.documents.some(document=>document.url===root));assert.equal(result.documents.filter(document=>document.mimeType==='application/pdf').length,2);
 assert.ok(result.documents.some(document=>document.metadata.caseKey==='exact'));assert.ok(result.documents.some(document=>document.metadata.caseKey==='ars'));
 assert.ok(result.documents.every(document=>document.sourceId===bobSource.id&&document.ags===town.ags));assert.equal(result.coverage?.state,'complete');
});
test('BOB missing, partial, malformed, conflicting and unjoined municipal identities fail closed',async t=>{
 const cases=[
  {name:'missing codes',rows:[{id:'p'}]},
  {name:'county prefix is not an AGS',rows:[{id:'p',municipalCode:'01053'}]},
  {name:'numeric AGS loses leading zero',rows:[{id:'p',municipalCode:1053116}]},
  {name:'ARS is not the first eight digits',rows:[{id:'p',municipalCode:'01053537',ars:'010535373116'}]},
  {name:'conflicting AGS and ARS',rows:[{id:'p',municipalCode:'01053116',ars:'010535373021'}]},
  {name:'invalid supplied ARS',rows:[{id:'p',municipalCode:'01053116',ars:'01053'}]},
  {name:'conflicting duplicate procedure',rows:[{id:'p',municipalCode:'01053116'},{id:'p',municipalCode:'01053021'}]},
  {name:'API procedure missing from inventory',rows:[{id:'different',municipalCode:'01053116'}]}
 ];
 for(const scenario of cases)await t.test(scenario.name,async t=>{
  const folder=await mkdtemp(join(tmpdir(),'district-bob-ambiguous-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const fetcher=await createPoliteFetcher({cacheDir:folder}),seen:string[]=[],root='https://bob-sh.de/';
  const bobSource:RegistrySource={...source,url:root,api:{url:root+'list/json',format:'bobsh-list'}};
  t.mock.method(fetcher,'fetch',async(url:string)=>{
   seen.push(url);const body=Buffer.from(url===root?bobInventory(scenario.rows):JSON.stringify({success:true,procedureCount:1,mapVars:[{procedureId:'p',procedureUrl:'/verfahren/p/public/detail',externalName:'Schwarzenbek'}],responseHtml:'<div class="c-procedurelist__item" data-procedure-id="p">Schwarzenbek</div>'})),localPath=join(folder,hash(body));await writeFile(localPath,body);
   return {url,sha256:hash(body),localPath,mimeType:'text/html',retrievedAt:'2026-10-11T00:00:00.000Z',checkedAt:'2026-10-11T00:00:00.000Z',status:200,observationPath:join(folder,'observation.json')};
  });
  await assert.rejects(crawlParticipationApi(fetcher,{...city,ags:'01053116',name:'Schwarzenbek'},bobSource,{maxDocuments:5,maxPages:5,maxRequests:5}),/municipal code missing or conflicting/);
  assert.deepEqual(seen,[root+'list/json',root]);
 });
});
test('BOB scoped empty result is distinct from unsupported inventory and respects identity request budget',async t=>{
 for(const mode of ['empty','unsupported','budget'] as const)await t.test(mode,async t=>{
  const folder=await mkdtemp(join(tmpdir(),'district-bob-empty-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const fetcher=await createWireFetcher({cacheDir:folder}),seen:string[]=[],root='https://bob-sh.de/';
  const bobSource:RegistrySource={...source,url:root,api:{url:root+'list/json',format:'bobsh-list'}};
  type Wire={wire(url:URL):Promise<{status:number;headers:Record<string,string>;body:Buffer}>};
  t.mock.method(fetcher as unknown as Wire,'wire',async(url:URL)=>{
   if(url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
   seen.push(url.href);return {status:200,headers:{'content-type':'text/html'},body:Buffer.from(url.href===root?(mode==='unsupported'?'<h1>No inventory</h1>':bobInventory([{id:'other',municipalCode:'01053021'}])):JSON.stringify({success:true,procedureCount:0,mapVars:[],responseHtml:''}))};
  });
  const pending=crawlParticipationApi(fetcher,{...city,ags:'01053116'},bobSource,{maxDocuments:5,maxPages:5,maxRequests:mode==='budget'?1:5});
  if(mode==='unsupported'){await assert.rejects(pending,/inventory missing or ambiguous/);return;}
  const result=await pending;assert.equal(result.documents.length,0);assert.equal(result.coverage?.state,mode==='budget'?'partial':'complete');
  assert.equal(result.requests,mode==='budget'?1:2);assert.deepEqual(seen,mode==='budget'?[root+'list/json']:[root+'list/json',root]);
  assert.match(result.notes.join(' '),mode==='budget'?/no empty-coverage inference/:/0 exact-bound procedures/);
 });
});
test('BOB 10.5 MB inventory completes the real fetch/read/binding path for all three towns without neighboring traversal',async t=>{
 const root='https://bob-sh.de/',inventory=largeBobInventory();assert.ok(inventory.length>=10_500_000);
 for(const [id,ags] of [['ratzeburg','01053100'],['moelln','01053090'],['schwarzenbek','01053116']])await t.test(id,async t=>{
  const folder=await mkdtemp(join(tmpdir(),'district-bob-large-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const fetcher=await createWireFetcher({cacheDir:folder}),seen:string[]=[],bobSource:RegistrySource={...source,id:id+'-bob-sh',url:root,crawlScope:{pageRoots:[],followLinkedDocuments:false},api:{url:root+'list/json',format:'bobsh-list',method:'POST',form:{municipalCode:'01053'}}};
  const mapVars=['ratzeburg','moelln','schwarzenbek','neighbor'].map(procedureId=>({procedureId,procedureUrl:`/verfahren/${procedureId}/public/detail`,externalName:'Neutraler Planname'}));
  const responseHtml=mapVars.map(row=>`<div class="c-procedurelist__item" data-procedure-id="${row.procedureId}">Neutraler Planname</div>`).join('');
  type Wire={wire(url:URL):Promise<{status:number;headers:Record<string,string>;body:Buffer}>};
  t.mock.method(fetcher as unknown as Wire,'wire',async(url:URL)=>{
   seen.push(url.href);
   if(url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
   const api=url.href===bobSource.api!.url,body=url.href===root?inventory:Buffer.from(api?JSON.stringify({success:true,procedureCount:mapVars.length,mapVars,responseHtml}):'<h1>Neutraler Planname</h1>');
   return {status:200,headers:{'content-type':api?'application/json':'text/html'},body};
  });
  const result=await crawlParticipationApi(fetcher,{...city,id,name:id,ags},bobSource,{maxDocuments:4,maxPages:4,maxRequests:6});
  assert.equal(result.coverage?.state,'complete');assert.equal(result.documents.length,1);
  assert.equal(result.documents[0].metadata.caseKey,id);assert.equal(result.documents[0].ags,ags);
  assert.deepEqual(seen.filter(url=>url.includes('/verfahren/')),[`${root}verfahren/${id}/public/detail`]);
  const observed=JSON.parse(await readFile(join(fetcher.cacheDir,'requests',hash('GET '+root+'\n')+'.json'),'utf8'));
  assert.equal(observed.state,'fetched');assert.equal(observed.bytes,inventory.length);assert.equal(observed.sha256,hash(inventory));
  assert.equal(observed.policy.documentOrigin.classification,'unknown');assert.equal(observed.failure,undefined);
 });
});
test('BOB ambiguous identity never falls back to registry seeds through the district crawler',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-bob-no-fallback-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const fetcher=await createPoliteFetcher({cacheDir:folder}),seen:string[]=[],root='https://bob-sh.de/';
 const bobSource:RegistrySource={...source,url:root,api:{url:root+'list/json',format:'bobsh-list'}};
 t.mock.method(fetcher,'fetch',async(url:string)=>{
  seen.push(url);const body=Buffer.from(url===root?bobInventory([{id:'p'}]):JSON.stringify({success:true,procedureCount:1,mapVars:[{procedureId:'p',procedureUrl:'/verfahren/p/public/detail',externalName:'Schwarzenbek'}],responseHtml:'<div class="c-procedurelist__item" data-procedure-id="p">Schwarzenbek</div>'})),localPath=join(folder,hash(body));await writeFile(localPath,body);
  return {url,sha256:hash(body),localPath,mimeType:'text/html',retrievedAt:'2026-10-11T00:00:00.000Z',checkedAt:'2026-10-11T00:00:00.000Z',status:200,observationPath:join(folder,'observation.json')};
 });
 const registry={schemaVersion:'stadtstack-source-registry-v1' as const,municipalities:[{...city,ags:'01053116',name:'Schwarzenbek',sources:[bobSource],seedDocuments:[{sourceId:bobSource.id,url:root+'unbound.pdf'}]}]};
 const result=await crawlDistrictRegistry(registry,fetcher,{maxDocuments:5,maxPages:5,maxRequests:5});
 assert.equal(result.documents.length,0);assert.equal(result.checks[0].outcome,'blocked');assert.match(result.checks[0].reason!,/municipal code missing or conflicting/);
 assert.deepEqual(seen,[root+'list/json',root]);assert.ok(!result.checks[0].reason?.includes('official-document fallback'));
});
test('failed public API retains confirmed official-document fallback within its request budget',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-fallback-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const fetcher=await createWireFetcher({cacheDir:folder}),apiSource:RegistrySource={...source,api:{url:'https://api.stadt.de/plans',format:'mv-bauleitplan'}};
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
 const fetcher=await createPoliteFetcher({cacheDir:folder}),body=Buffer.from('{\"data\":[]}'),localPath=join(folder,hash(body));await writeFile(localPath,body);
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
 const firstFetcher=await createPoliteFetcher({cacheDir:folder});t.mock.method(firstFetcher,'fetch',fixtureFetch);
 const partial=await crawlDistrictRegistry(registry,firstFetcher,{maxDocuments:8,maxPages:3,maxRequests:24,maxRounds:1});
 assert.equal(partial.checks[0].coverage?.state,'partial');assert.ok(partial.checks[0].coverage!.pendingCount>200);
 const secondFetcher=await createPoliteFetcher({cacheDir:folder});t.mock.method(secondFetcher,'fetch',fixtureFetch);
 const complete=await crawlDistrictRegistry(registry,secondFetcher,{maxDocuments:8,maxPages:3,maxRequests:24});
 assert.equal(complete.checks[0].coverage?.state,'complete');assert.equal(complete.checks[0].coverage?.pendingCount,0);
 assert.equal(complete.documents.filter(document=>document.mimeType==='application/pdf').length,231);
 assert.equal(complete.documents.filter(document=>document.adapter==='xplanung-document').length,2);
 assert.ok(complete.documents.some(document=>document.url.endsWith('/plans/deep.pdf')));
 assert.equal(seen.filter(url=>url===root).length,1);assert.equal(new Set(seen).size,seen.length);
});
test('Deep archives take bounded turns so later municipalities are reached before another round',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-fair-rounds-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const fetcher=await createPoliteFetcher({cacheDir:folder}),turns:string[]=[];
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
 const fetcher=await createPoliteFetcher({cacheDir:folder}),seen:string[]=[];
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
 const fetcher=await createPoliteFetcher({cacheDir:folder}),seen:string[]=[],representations=new Map<string,{sha256:string;retrievedAt:string}>();let expanded=false;
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
 const fetcher=await createPoliteFetcher({cacheDir:folder}),direct={...source,url:'https://stadt.de/plan.pdf'};let reserved=false;
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
 const fetcher=await createPoliteFetcher({cacheDir:folder}),endpoint='https://council.stadt.de/system';
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
 const fetcher=await createPoliteFetcher({cacheDir:folder}),mvSource:RegistrySource={...source,api:{url:'https://www.gaia-mv.de/geoportalsearch/_ajax/search/?type=Bauleitplan',format:'mv-bauleitplan'}};let expanded=false,apiCalls=0;
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
 const fetcher=await createPoliteFetcher({cacheDir:folder}),direct={...source,url:'https://stadt.de/plan.pdf'};let calls=0;
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

test('source adapter passes explicit owner decision and stops the frontier immediately on 403/429',async t=>{
 const root=await mkdtemp(join(tmpdir(),'district-owner-stop-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const configured={...source,ownerRobotsOverride:ownerRobotsOverrideFor(source.url!)!};
 for(const status of [403,429]){
  const fetcher=await createPoliteFetcher({cacheDir:join(root,String(status))});let calls=0;
  const retryAfter='2026-10-12T00:00:00.000Z';
  t.mock.method(fetcher,'fetch',async(_url:string,options?:FetchOptions)=>{
   calls++;assert.deepEqual(options?.ownerRobotsOverride,configured.ownerRobotsOverride);assert.equal(options?.hostProfile,'municipal');assert.equal(options?.registeredSourceUrl,configured.url);
   throw new PoliteFetchError(status===403?'access_barrier':'http_error',`HTTP ${status}`,status,undefined,retryAfter);
  });
  const operation=crawlHtmlSource(fetcher,city,configured,{maxDocuments:10,maxPages:10,maxRequests:10},[{sourceId:source.id,url:'https://stadt.de/a'},{sourceId:source.id,url:'https://stadt.de/b'}]);
  if(status===403)await assert.rejects(operation,(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='access_barrier'&&error.status===403&&error.retryAfter===retryAfter);
  else{const result=await operation;assert.equal(result.coverage?.runnableCount,0);assert.equal(result.blocked?.[0].status,status);assert.equal(result.blocked?.[0].retryAfter,retryAfter);}
  assert.equal(calls,1);
 }
});
test('API access stops cannot trigger document fallback',async t=>{
 const root=await mkdtemp(join(tmpdir(),'district-owner-api-stop-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const configured:RegistrySource={...source,api:{url:'https://stadt.de/api',format:'diplan-list'}},fetcher=await createPoliteFetcher({cacheDir:root});let calls=0;
 t.mock.method(fetcher,'fetch',async()=>{calls++;throw new PoliteFetchError('http_error','HTTP 429',429,undefined,'2026-10-12T00:00:00.000Z');});
 const registry={schemaVersion:'stadtstack-source-registry-v1' as const,municipalities:[{...city,sources:[configured],seedDocuments:[{sourceId:source.id,url:'https://stadt.de/document'}]}]};
 const result=await crawlDistrictRegistry(registry,fetcher,{maxDocuments:10,maxPages:10,maxRequests:10});
 assert.equal(calls,1);assert.equal(result.checks[0].httpStatus,429);assert.equal(result.checks[0].retryAfter,'2026-10-12T00:00:00.000Z');
});

test('excluded representations survive the crawl index without parsed links or raw document rows',async t=>{
 const root=await mkdtemp(join(tmpdir(),'district-excluded-index-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const configured:RegistrySource={...source,ownerRobotsOverride:ownerRobotsOverrideFor(source.url!)!},fetcher=await createWireFetcher({cacheDir:root}),seen:string[]=[];
 const wire=fetcher as unknown as {wire(url:URL):Promise<{status:number;headers:Record<string,string>;body:Buffer}>};
 t.mock.method(wire,'wire',async(url:URL)=>{
  seen.push(url.href);
  if(url.pathname==='/robots.txt')return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from('User-agent: *\nDisallow: /')};
  if(url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  return {status:200,headers:{'content-type':'text/html'},body:Buffer.from('<h1>Gutachten</h1><p>Verfasser: Ingenieurbüro Beispiel GmbH</p><p>Externe Untersuchung zur Verkehrsentwicklung des Quartiers.</p><a href="/must-not-follow.pdf">Anlage</a>')};
 });
 const index=await crawlDistrictRegistry({schemaVersion:'stadtstack-source-registry-v1',municipalities:[{...city,sources:[configured]}]},fetcher,{maxDocuments:10,maxPages:10,maxRequests:10});
 assert.equal(index.documents.length,0);assert.equal(index.excludedDocuments?.length,1);
 const excluded=index.excludedDocuments![0];assert.equal(excluded.policy.documentOrigin?.classification,'third_party');assert.equal('localPath' in excluded,false);assert.equal(excluded.municipalityId,city.id);
 assert.ok(!seen.some(url=>url.includes('must-not-follow')));assert.equal(index.checks[0].blocked?.[0].failure,'document_excluded');
});

test('exact registered page roots isolate source, seeds, links and previous frontiers',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-exact-pages-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const target='https://stadt.de/heat',other='https://stadt.de/other-registered-page';
 const selected:RegistrySource={...source,id:'selected-website',kind:'website',url:'https://stadt.de/',crawlScope:{pageRoots:[target,other],followLinkedDocuments:true}};
 const neighbor:RegistrySource={...source,id:'unselected-source',url:'https://stadt.de/unselected'};
 const municipality={...city,sources:[selected,neighbor],seedDocuments:[{sourceId:selected.id,url:'https://stadt.de/unselected-seed.pdf'}]};
 const registry={schemaVersion:'stadtstack-source-registry-v1' as const,municipalities:[municipality]},fetcher=await createPoliteFetcher({cacheDir:folder}),seen:string[]=[];
 t.mock.method(fetcher,'fetch',async(url:string,options?:FetchOptions)=>{
  seen.push(url);assert.equal(options?.registeredSourceUrl,selected.url);
  const body=Buffer.from('<h1>Selected registered page</h1><a href="/must-not-follow.pdf">Attachment</a>'),localPath=join(folder,hash(body)),at='2026-10-11T00:00:00.000Z';await writeFile(localPath,body);
  return {url,sha256:hash(body),localPath,mimeType:'text/html',retrievedAt:at,checkedAt:at,status:200,observationPath:join(folder,'fixture-observation.json'),policy:fixturePolicy(url,hash(body),at,'text/html')};
 });
 const limits={municipality:city.id,sourceId:selected.id,maxDocuments:1,maxPages:1,maxRequests:1,maxRounds:1};
 const broader=await crawlHtmlSource(fetcher,municipality,selected,limits),broaderPath=broader.coverage!.frontierPath!,broaderBytes=await readFile(broaderPath,'utf8');assert.ok(broader.coverage!.pendingCount>0);seen.length=0;
 const first=await crawlDistrictRegistry(registry,fetcher,{...limits,pageRoots:[target]});
 assert.deepEqual(seen,[target]);assert.deepEqual(first.documents.map(document=>document.url),[target]);
 assert.equal(first.checks.find(check=>check.sourceId===neighbor.id)?.outcome,'not_checked');assert.match(first.checks.find(check=>check.sourceId===selected.id)!.coverage!.scope,/Exactly selected registered page roots/);
 const completedTarget=first.checks.find(check=>check.sourceId===selected.id)!.coverage!;
 assert.equal(completedTarget.state,'partial');assert.equal(completedTarget.sourceCoverage,'not_assessed');assert.equal(completedTarget.targetScope?.state,'complete');assert.deepEqual(completedTarget.targetScope?.urls,[target]);assert.equal(completedTarget.runnableCount,0);
 const second=await crawlDistrictRegistry(registry,fetcher,{...limits,pageRoots:[other]});
 assert.deepEqual(seen,[target,other]);assert.deepEqual(second.documents.map(document=>document.url),[other]);
 assert.notEqual(first.checks.find(check=>check.sourceId===selected.id)?.coverage?.frontierPath,second.checks.find(check=>check.sourceId===selected.id)?.coverage?.frontierPath);
 assert.equal(await readFile(broaderPath,'utf8'),broaderBytes,'Narrow target completion must not rewrite broader pending work');
});

test('registered extensionless seed selection bypasses API discovery without expanding other seeds',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-exact-seed-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const target='https://stadt.de/file/solarpark/fixture-id';
 const selected:RegistrySource={...source,api:{url:'https://stadt.de/list/json',format:'diplan-list'}};
 const municipality={...city,sources:[selected],seedDocuments:[{sourceId:selected.id,url:target,title:'Registered Solarpark document',documentDate:'2026-01-02'},{sourceId:selected.id,url:'https://stadt.de/file/unselected'}]};
 const fetcher=await createPoliteFetcher({cacheDir:folder}),seen:string[]=[];
 t.mock.method(fetcher,'fetch',async(url:string)=>{
  seen.push(url);const body=Buffer.from('%PDF synthetic adapter fixture'),localPath=join(folder,hash(body)),at='2026-10-11T00:00:00.000Z';await writeFile(localPath,body);
  return {url,sha256:hash(body),localPath,mimeType:'application/pdf',retrievedAt:at,checkedAt:at,status:200,observationPath:join(folder,'fixture-observation.json'),policy:fixturePolicy(url,hash(body),at,'application/pdf')};
 });
 const index=await crawlDistrictRegistry({schemaVersion:'stadtstack-source-registry-v1',municipalities:[municipality]},fetcher,{municipality:city.id,sourceId:selected.id,seedDocumentUrls:[target],maxDocuments:1,maxPages:1,maxRequests:1,maxRounds:1});
 assert.deepEqual(seen,[target]);assert.equal(index.documents[0].sourceId,selected.id);assert.equal(index.documents[0].documentDate,'2026-01-02');assert.equal(index.documents[0].adapter,'official-pdf');
 assert.match(index.checks[0].coverage!.scope,/registered seed documents/);assert.match(index.checks[0].reason!,/API discovery.*not run/);
 assert.equal(index.checks[0].coverage!.state,'partial');assert.equal(index.checks[0].coverage!.sourceCoverage,'not_assessed');assert.equal(index.checks[0].coverage!.targetScope?.kind,'seed_documents');assert.equal(index.checks[0].coverage!.targetScope?.state,'complete');
});

test('unknown, mismatched or ambiguous target selections fail before initialization',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-target-reject-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const root='https://stadt.de/registered',selected={...source,crawlScope:{pageRoots:[root],followLinkedDocuments:true}},fetcher=await createPoliteFetcher({cacheDir:folder});
 let initializations=0;t.mock.method(fetcher,'initialize',async()=>{initializations++;throw Error('Selection must fail before initialization');});
 const registry={schemaVersion:'stadtstack-source-registry-v1' as const,municipalities:[{...city,sources:[selected],seedDocuments:[{sourceId:selected.id,url:'https://stadt.de/file/registered'}]}]},limits={maxDocuments:1,maxPages:1,maxRequests:1,maxRounds:1};
 for(const selection of [
  {sourceId:selected.id},
  {municipality:'unknown',sourceId:selected.id},
  {municipality:city.id,sourceId:'other-source'},
  {municipality:city.id,pageRoots:[root]},
  {municipality:city.id,sourceId:selected.id,pageRoots:['https://stadt.de/unregistered']},
  {municipality:city.id,sourceId:selected.id,pageRoots:[]},
  {municipality:city.id,sourceId:selected.id,pageRoots:[root,root]},
  {municipality:city.id,sourceId:selected.id,seedDocumentUrls:['https://stadt.de/file/unregistered']},
  {municipality:city.id,sourceId:selected.id,pageRoots:[root],seedDocumentUrls:['https://stadt.de/file/registered']},
 ])await assert.rejects(crawlDistrictRegistry(registry,fetcher,{...limits,...selection}),/registered|registration|selection|Select|Duplicate|mutually exclusive|source/i);
 assert.equal(initializations,0);
});

test('fresh-TTL pre-security origin classifications are withheld until revalidated',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-origin-version-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const selected={...source,ownerRobotsOverride:ownerRobotsOverrideFor(source.url!)!},fetcher=await createPoliteFetcher({cacheDir:folder});let calls=0;
 t.mock.method(fetcher,'fetch',async(url:string)=>{
  calls++;const bytes=Buffer.from('Synthetic classified source document'),sha256=hash(bytes),localPath=join(folder,sha256),at=new Date().toISOString();await writeFile(localPath,bytes);
  const policy:SourceAccessPolicy={...fixturePolicy(url,sha256,at,'text/plain'),documentOrigin:{classification:'official_work',method:'rules',classifierVersion:DOCUMENT_ORIGIN_CLASSIFIER_VERSION,url,sha256,classifiedAt:at,evidence:[]}};
  return {url,sha256,localPath,mimeType:'text/plain',retrievedAt:at,checkedAt:at,status:200,observationPath:join(folder,'fixture-observation.json'),policy};
 });
 const limits={maxDocuments:1,maxPages:1,maxRequests:1,revalidateAfterMs:30*24*60*60_000},first=await crawlHtmlSource(fetcher,city,selected,limits);
 const path=first.coverage!.frontierPath!,old=JSON.parse(await readFile(path,'utf8'));old.documents[0].policy.documentOrigin.classifierVersion='document-origin-rules-v1';await writeFile(path,JSON.stringify(old));
 const held=await crawlHtmlSource(fetcher,city,selected,{...limits,maxRequests:0});assert.equal(held.documents.length,0);assert.equal(calls,1);
 const refreshed=await crawlHtmlSource(fetcher,city,selected,limits);assert.equal(calls,2);assert.equal(refreshed.documents[0].policy?.documentOrigin?.classifierVersion,DOCUMENT_ORIGIN_CLASSIFIER_VERSION);
});

test('configured seed metadata is rehydrated rather than stored as unbound bootstrap source content',async t=>{
 const root=await mkdtemp(join(tmpdir(),'district-bootstrap-control-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const fetcher=await createPoliteFetcher({cacheDir:root}),seed={url:'https://stadt.de/registered.pdf',sourceId:source.id,title:'Configured municipal seed',documentDate:'2026-10-01',metadata:{stage:'draft'},evidence:[{url:'https://stadt.de/config-proof',locator:'Configured proof'}],dateReason:'Configured date'},municipality={...city,seedDocuments:[seed]};
 const deferred=await crawlHtmlSource(fetcher,municipality,source,{maxDocuments:1,maxPages:1,maxRequests:0}),path=deferred.coverage!.frontierPath!,bootstrap=JSON.parse(await readFile(path,'utf8'));
 assert.equal(bootstrap.documents.length,0);assert.equal(bootstrap.sourceBindings,undefined);
 for(const entry of bootstrap.queue){assert.equal(entry.title,undefined);assert.equal(entry.metadata,undefined);assert.equal(entry.evidence,undefined);assert.equal(entry.dateReason,undefined);}
 t.mock.method(fetcher,'fetch',async(url:string)=>{
  const body=Buffer.from('%PDF synthetic adapter source'),localPath=join(root,hash(body)),checkedAt=new Date().toISOString();await writeFile(localPath,body);
  return {url,sha256:hash(body),localPath,mimeType:'application/pdf',retrievedAt:checkedAt,checkedAt,status:200,observationPath:join(root,'fixture-observation.json'),policy:fixturePolicy(url,hash(body),checkedAt,'application/pdf')};
 });
 const result=await crawlHtmlSource(fetcher,municipality,source,{maxDocuments:1,maxPages:1,maxRequests:1});
 assert.equal(result.documents[0].metadata.title,seed.title);assert.equal(result.documents[0].metadata.stage,'draft');assert.equal(result.documents[0].documentDate,seed.documentDate);assert.equal(result.sourceBindings?.length,1);
 const persisted=JSON.parse(await readFile(path,'utf8'));assert.equal(persisted.documents[0].metadata.title,undefined);assert.equal(persisted.documents[0].metadata.stage,undefined);assert.equal(persisted.documents[0].documentDate,null);assert.equal(persisted.sourceBindings.length,1);
});

test('source-wide API permission loss cannot become a document-seed availability fallback',async t=>{
 const root=await mkdtemp(join(tmpdir(),'district-no-permission-fallback-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const fetcher=await createPoliteFetcher({cacheDir:root}),api={...source,api:{url:'https://stadt.de/observed-api',format:'diplan-list' as const}},seen:string[]=[];
 t.mock.method(fetcher,'fetch',async(url:string)=>{seen.push(url);throw new PoliteFetchError('tdm_unavailable','Policy cannot be resolved');});
 const result=await crawlDistrictRegistry({schemaVersion:'stadtstack-source-registry-v1',municipalities:[{...city,sources:[api],seedDocuments:[{url:'https://stadt.de/must-not-fallback.pdf',sourceId:source.id}]}]},fetcher,{maxDocuments:1,maxPages:1,maxRequests:3});
 assert.deepEqual(seen,[api.api.url]);assert.deepEqual(result.documents,[]);assert.equal(result.checks[0].blocked?.[0].failure,'tdm_unavailable');
});

test('no-body redirect denial exports hashed target audit, not invented HTTP body provenance',()=>{
 const target='https://third-party.test/denied',policy:SourceAccessPolicy={robots:{state:'blocked',url:'https://third-party.test/robots.txt',sha256:hash('actual denial'),checkedAt:'2026-10-11T12:00:00.000Z'},tdm:{state:'unavailable',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'};
 const index:DistrictCrawlIndex={schemaVersion:'stadtstack-crawl-index-v1',generatedAt:'2026-10-11T12:00:00.000Z',documents:[],checks:[{municipalityId:city.id,sourceId:source.id,checkState:'checked',checkedAt:'2026-10-11T12:00:00.000Z',documentCount:0,outcome:'blocked',blocked:[{url:target,failure:'robots_blocked',reason:'robots_blocked',checkedAt:'2026-10-11T12:00:00.000Z',policy,action:'ask_municipality'}]}]};
 const projected=projectCrawlIndexDenials(index,{schemaVersion:'stadtstack-source-registry-v1',municipalities:[city]},new Set(['stadt.de'])),audit=projected.checks[0].blocked![0];
 assert.equal(audit.url,source.url);assert.equal(audit.urlRole,'registered_source_context');assert.equal(audit.targetUrlSha256,hash(target));assert.equal(audit.policy,undefined);assert.equal(audit.policyAudit?.robotsState,'blocked');assert.equal(audit.policyAudit?.robotsStatus,'disallowed');assert.equal(audit.policyAudit?.tdmState,'unavailable');
 assert.equal(JSON.stringify(projected).includes('third-party.test'),false);assert.equal('sourceSha256' in audit,false);assert.equal(index.checks[0].blocked![0].url,target);
});

test('governed persistence failure propagates once instead of retrying it as a source failure',async t=>{
 const root=await mkdtemp(join(tmpdir(),'district-write-boundary-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const fetcher=await createPoliteFetcher({cacheDir:root});let calls=0;
 t.mock.method(fetcher,'fetch',async()=>{throw new PoliteFetchError('robots_blocked','Actual source denial');});
 await assert.rejects(crawlDistrictRegistry({schemaVersion:'stadtstack-source-registry-v1',municipalities:[city]},fetcher,{maxDocuments:1,maxPages:1,maxRequests:1,onSource:async(index,bindings)=>{calls++;assert.equal(index.documents.length,0);assert.deepEqual(bindings,[]);throw Error('Managed artifact write rejected');}}),/Managed artifact write rejected/);
 assert.equal(calls,1);
});

test('real transport receipts keep a source-bearing frontier readable across a fresh fetcher',async t=>{
 const root=await mkdtemp(join(tmpdir(),'district-managed-frontier-restart-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const first=await createWireFetcher({cacheDir:root}),seen:string[]=[],limits={maxDocuments:1,maxPages:1,maxRequests:3};
 type Wire={wire(url:URL):Promise<{status:number;headers:Record<string,string|undefined>;body:Buffer}>};
 const wire=async(target:URL)=>{
  if(target.pathname==='/robots.txt'||target.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  seen.push(target.href);
  return target.href===source.url?{status:200,headers:{'content-type':'text/html'},body:Buffer.from('<h1>Municipal planning archive</h1><a href="/plan.gml">XPlanung</a>')}:{status:200,headers:{'content-type':'application/gml+xml'},body:Buffer.from('<gml:FeatureCollection xmlns:gml="http://www.opengis.net/gml"/>')};
 };
 t.mock.method(first as unknown as Wire,'wire',wire);
 const partial=await crawlHtmlSource(first,city,source,limits);assert.equal(partial.coverage?.state,'partial');assert.equal(partial.documents.length,1);
 await first.assertSourceReadable(partial.coverage!.frontierPath!);
 const second=await createWireFetcher({cacheDir:root});t.mock.method(second as unknown as Wire,'wire',wire);
 const complete=await crawlHtmlSource(second,city,source,{maxDocuments:10,maxPages:3,maxRequests:10});
 assert.equal(complete.coverage?.state,'complete');assert.equal(complete.documents.length,2);assert.deepEqual(seen,[source.url,'https://stadt.de/plan.gml']);
 await second.assertSourceReadable(complete.coverage!.frontierPath!);await second.assertSourceBindingsAllowed(complete.sourceBindings!);
});

for(const phase of ['robots','tdm'] as const)test(`mandatory API ${phase} transport failure blocks document-seed fallback`,async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-policy-phase-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const fetcher=await createWireFetcher({cacheDir:folder}),apiSource:RegistrySource={...source,api:{url:'https://api.stadt.de/plans',format:'mv-bauleitplan'}},seen:string[]=[];
 interface Wire {wire(url:URL):Promise<{status:number;headers:Record<string,string>;body:Buffer}>}
 t.mock.method(fetcher as unknown as Wire,'wire',async(url:URL)=>{
  seen.push(url.href);
  if(url.hostname==='api.stadt.de'&&url.pathname===(phase==='robots'?'/robots.txt':'/.well-known/tdmrep.json'))throw new PoliteFetchError('network_error','Synthetic mandatory policy transport failure');
  if(url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  return {status:200,headers:{'content-type':'application/pdf'},body:metadataPdf()};
 });
 const registry={schemaVersion:'stadtstack-source-registry-v1' as const,municipalities:[{...city,sources:[apiSource],seedDocuments:[{sourceId:source.id,url:'https://stadt.de/must-not-fallback.pdf'}]}]};
 const index=await crawlDistrictRegistry(registry,fetcher,{maxDocuments:2,maxPages:2,maxRequests:3});
 assert.deepEqual(index.documents,[]);assert.equal(index.checks[0].outcome,'blocked');assert.equal(index.checks[0].blocked?.[0].failure,'network_error');
 assert.equal(fetcher.requestCount,1);assert.doesNotMatch(index.checks[0].reason!,/official-document fallback/);
 assert.deepEqual(seen,phase==='robots'?['https://api.stadt.de/robots.txt']:['https://api.stadt.de/robots.txt','https://api.stadt.de/.well-known/tdmrep.json']);
});

for(const phase of ['robots','tdm'] as const)test(`HTML frontier ${phase} transport failure cannot return source-wide preloaded documents`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'district-frontier-policy-phase-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const first=await createWireFetcher({cacheDir:root}),limits={maxDocuments:1,maxPages:1,maxRequests:3};
 interface Wire {wire(url:URL):Promise<{status:number;headers:Record<string,string|undefined>;body:Buffer}>}
 t.mock.method(first as unknown as Wire,'wire',async(url:URL)=>{
  if(url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  assert.equal(url.href,source.url);
  return {status:200,headers:{'content-type':'text/html'},body:Buffer.from('<h1>Municipal planning archive</h1><a href="/plan.gml">XPlanung</a>')};
 });
 const initial=await crawlHtmlSource(first,city,source,limits);assert.equal(initial.documents.length,1);assert.equal(initial.coverage?.pendingCount,1);
 const second=await createWireFetcher({cacheDir:root}),denial=new PoliteFetchError('network_error','Synthetic mandatory frontier policy transport failure'),seen:string[]=[];
 t.mock.method(second as unknown as Wire,'wire',async(url:URL)=>{
  seen.push(url.pathname);
  if(url.pathname===(phase==='robots'?'/robots.txt':'/.well-known/tdmrep.json'))throw denial;
  assert.equal(url.pathname,'/robots.txt');return {status:404,headers:{},body:Buffer.alloc(0)};
 });
 const returned:unknown[]=[];
 await assert.rejects(async()=>{returned.push(await crawlHtmlSource(second,city,source,{maxDocuments:10,maxPages:3,maxRequests:10}));},error=>error===denial&&denial.policyPhase===phase);
 assert.deepEqual(returned,[]);assert.deepEqual(seen,phase==='robots'?['/robots.txt']:['/robots.txt','/.well-known/tdmrep.json']);
});

for(const boundary of ['adapter','registry'] as const)test(`${boundary} HTML capture failure aborts with pending revalidation and original custody intact`,async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-html-capture-stop-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-13T00:00:00.000Z')});
 const fetcher=await createWireFetcher({cacheDir:folder}),body=Buffer.from('<h1>Synthetic municipal page</h1>'),limits={maxDocuments:1,maxPages:1,maxRequests:3,revalidateAfterMs:1000},seen:string[]=[];
 interface Wire {wire(url:URL):Promise<{status:number;headers:Record<string,string>;body:Buffer}>}
 t.mock.method(fetcher as unknown as Wire,'wire',async(url:URL)=>{
  seen.push(url.href);if(url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  assert.equal(url.href,source.url);return {status:200,headers:{'content-type':'text/html'},body};
 });
 const first=await crawlHtmlSource(fetcher,city,source,limits),original=first.documents[0];assert.equal(first.documents.length,1);
 t.mock.timers.tick(1001);
 const deferred=await crawlHtmlSource(fetcher,city,source,{...limits,maxRequests:0}),frontierPath=deferred.coverage!.frontierPath!,pendingBytes=await readFile(frontierPath),pending=JSON.parse(pendingBytes.toString('utf8'));
 assert.equal(pending.queue.length,1);assert.equal(pending.queue[0].previous.id,original.id);assert.deepEqual(pending.failures,[]);
 await rm(fetcher.cacheDir+'-request-evidence',{recursive:true,force:true});await writeFile(fetcher.cacheDir+'-request-evidence','SYNTHETIC_LOCAL_CAPTURE_OBSTRUCTION',{mode:0o600,flag:'wx'});
 let projections=0;
 const crawl=boundary==='adapter'?crawlHtmlSource(fetcher,city,source,limits):crawlDistrictRegistry({schemaVersion:'stadtstack-source-registry-v1',municipalities:[city]},fetcher,{...limits,onSource:async()=>{projections++;}});
 await assert.rejects(crawl,(error:unknown)=>{assert.ok(error instanceof CrawlRequestEvidenceCaptureError);assert.equal(error instanceof PoliteFetchError,false);assert.equal(error.message,'Managed request evidence capture failed');return true;});
 assert.equal(projections,0);assert.deepEqual(await readFile(frontierPath),pendingBytes);
 assert.deepEqual(await readFile(original.localPath),body);assert.equal(JSON.parse(await readFile(original.observationPath,'utf8')).state,'fetched');
 const observations=await Promise.all((await readdir(join(fetcher.cacheDir,'observations'))).map(async name=>JSON.parse(await readFile(join(fetcher.cacheDir,'observations',name),'utf8')))),retained=observations.filter(row=>row.url===source.url);
 assert.equal(retained.length,2);assert.ok(retained.every(row=>row.state==='fetched'&&row.status===200&&row.sha256===hash(body)&&row.failure===undefined));
 assert.equal(seen.filter(url=>url===source.url).length,2);assert.doesNotMatch((await readFile(frontierPath)).toString('utf8'),/ask_municipality|source_adapter_failed|representation_error/);
});

test('API discovery capture failure aborts without seed fallback or source-failure projection',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'district-api-capture-stop-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const fetcher=await createWireFetcher({cacheDir:folder}),apiSource:RegistrySource={...source,api:{url:'https://api.stadt.de/plans',format:'mv-bauleitplan'}},seed={sourceId:source.id,url:'https://stadt.de/must-not-fallback.pdf'},municipality={...city,sources:[apiSource],seedDocuments:[seed]},limits={maxDocuments:2,maxPages:2,maxRequests:4},seen:string[]=[];
 const deferred=await crawlHtmlSource(fetcher,municipality,{...apiSource,registeredSourceUrl:source.url!,url:null},{...limits,maxRequests:0}),frontierPath=deferred.coverage!.frontierPath!,pendingBytes=await readFile(frontierPath);
 assert.equal(JSON.parse(pendingBytes.toString('utf8')).queue[0].url,seed.url);
 await writeFile(fetcher.cacheDir+'-request-evidence','SYNTHETIC_LOCAL_API_CAPTURE_OBSTRUCTION',{mode:0o600,flag:'wx'});
 const body=Buffer.from(JSON.stringify({success:true,total:0,hits:0,results:[[]]}));
 const apiRequest=new URL(apiSource.api!.url);apiRequest.searchParams.set('offset','0');apiRequest.searchParams.set('n','100');
 interface Wire {wire(url:URL):Promise<{status:number;headers:Record<string,string>;body:Buffer}>}
 t.mock.method(fetcher as unknown as Wire,'wire',async(url:URL)=>{
  seen.push(url.href);if(url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  assert.equal(url.href,apiRequest.href,'A capture failure must never dispatch the fallback seed');return {status:200,headers:{'content-type':'application/json'},body};
 });
 let projections=0;
 await assert.rejects(crawlDistrictRegistry({schemaVersion:'stadtstack-source-registry-v1',municipalities:[municipality]},fetcher,{...limits,onSource:async()=>{projections++;}}),CrawlRequestEvidenceCaptureError);
 assert.equal(projections,0);assert.equal(fetcher.requestCount,1);assert.deepEqual(seen,['https://api.stadt.de/robots.txt','https://api.stadt.de/.well-known/tdmrep.json',apiRequest.href]);assert.ok(!seen.includes(seed.url));
 assert.deepEqual(await readFile(frontierPath),pendingBytes);assert.doesNotMatch(pendingBytes.toString('utf8'),/ask_municipality|source_adapter_failed|api_error/);
 assert.deepEqual(await readFile(join(fetcher.cacheDir,'sha256',hash(body))),body);
 const observations=await Promise.all((await readdir(join(fetcher.cacheDir,'observations'))).map(async name=>JSON.parse(await readFile(join(fetcher.cacheDir,'observations',name),'utf8')))),retained=observations.filter(row=>row.url===apiRequest.href);
 assert.equal(retained.length,1);assert.equal(retained[0].state,'fetched');assert.equal(retained[0].failure,undefined);assert.equal(retained[0].sha256,hash(body));
});
