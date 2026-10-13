import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {cities} from '../src/cities.ts';
import {canonicalOparlUrl,councilId} from '../src/dedupe.ts';
import {traverseCouncilList,createCouncilAcquisition,isCouncilPermissionFailure} from '../src/council-cache.ts';
import {CouncilBindingError,bodyIdMatchesCity,bodyMatchesCity,councilCoverage,councilEventDate,councilLicence,councilWindow,inCouncilWindow,mergeCouncilRecords,parseOparlList,recordMatchesBody,selectCouncilBody} from '../src/council-oparl.ts';
import type {CouncilLoader,CouncilSegment,CouncilStorage} from '../src/council-cache.ts';
import type {CouncilCheckpoint,OparlBody,OparlRecord,StoredCouncilRecord} from '../src/council-oparl.ts';
import {councilBindingFailure,collectOparl} from '../src/council.ts';
import {PoliteFetcher,PoliteFetchError} from '../src/polite-fetch.ts';
import type {FetchOptions} from '../src/polite-fetch.ts';
import {readFile,writeFile,mkdir,stat,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {hash} from '../src/common.ts';
import {recordHostOptOut} from '../src/civic-opt-out.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {fixturePolicyInspection} from './fixtures/polite-inspection.ts';
import {CrawlRequestEvidenceCaptureError} from '../src/district-crawl-request.ts';

const at='2026-10-10T12:00:00.000Z';
const body:OparlBody={id:'https://council.example/body/1',name:'Example',type:'https://schema.oparl.org/1.1/Body',paper:'https://council.example/body/1/paper'};
const paper=(id:string,date='2026-09-01',modified='2026-09-02T00:00:00Z'):OparlRecord=>({id:`https://council.example/body/1/paper/${id}`,type:'https://schema.oparl.org/1.1/Paper',body:body.id,name:id,date,modified});
const evidence={url:body.paper!,retrievedAt:at,sha256:'a'.repeat(64)};
function memoryStorage():CouncilStorage {
 let state:CouncilCheckpoint|undefined;const segments:CouncilSegment[]=[];
 return {async load(){return state?structuredClone(state):undefined;},async readSegment(index){assert.ok(segments[index]);return structuredClone(segments[index]);},async checkpoint(value,segment){if(segment)segments[value.segments-1]=structuredClone(segment);state=structuredClone(value);}};
}
function pageLoader(pages:Record<string,unknown>,requests:string[]=[]):CouncilLoader {
 return async url=>{requests.push(url);assert.ok(Object.hasOwn(pages,url),`Unexpected source URL ${url}`);return {...evidence,url,data:pages[url]};};
}

test('Scoped public GET failures remain durable-resume failures without a hidden reconnect loop',async t=>{
 const {root,policy}=await createCivicPolicyTestContext(t);
 const city=cities.find(city=>city.id==='koeln')!,acquisition=createCouncilAcquisition(city,{cacheRoot:join(root,'raw'),policy});
 let requests=0;
 t.mock.method(acquisition.fetcher,'fetch',async()=>{requests++;throw new PoliteFetchError('network_error','Public request failed');});
 await assert.rejects(acquisition.loadJson(city.endpoint!),/Public request failed/);
 assert.equal(requests,1);
 assert.ok((await readFile(join(root,'raw','.civic-acquisition-lane.json'))).length);
});

test('Scoped council loader never retries policy, HTTP or integrity failures',async t=>{
 const {root,policy}=await createCivicPolicyTestContext(t);
 const city=cities.find(city=>city.id==='koeln')!,acquisition=createCouncilAcquisition(city,{cacheRoot:join(root,'raw'),policy});
 let failure:Error=new PoliteFetchError('robots_blocked','Blocked'),requests=0;
 t.mock.method(acquisition.fetcher,'fetch',async()=>{requests++;throw failure;});
 for(const error of [failure,new PoliteFetchError('tdm_reserved','Reserved'),new PoliteFetchError('http_error','HTTP 429',429),new Error('Council source cache digest mismatch')]){
  failure=error;const before=requests;await assert.rejects(acquisition.loadJson(city.endpoint!),error);assert.equal(requests,before+1);
 }
});

test('council JSON and text loaders reject cross-host redirects without destination retention',async t=>{
 const {root,policy}=await createCivicPolicyTestContext(t);
 const city=cities.find(city=>city.id==='koeln')!,acquisition=createCouncilAcquisition(city,{cacheRoot:join(root,'raw'),policy}),seen:string[]=[];
 const bytes=Buffer.from('{"data":[]}'),destination='https://different.stadt.de/oparl';
 t.mock.method(acquisition.fetcher as unknown as {wire(url:URL):Promise<unknown>},'wire',async(url:URL)=>{
  seen.push(url.href);
  if(url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  return {status:302,headers:{location:destination},body:Buffer.alloc(0)};
 });
 for(const load of [acquisition.loadJson,acquisition.loadText])await assert.rejects(load(city.endpoint!),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='cross_host_redirect');
 assert.ok(!seen.some(value=>new URL(value).hostname==='different.stadt.de'));
 await assert.rejects(readFile(join(root,'raw','sha256',hash(bytes))),{code:'ENOENT'});
 await assert.rejects(readdir(join(root,'raw','collections')),{code:'ENOENT'});
});

test('Düsseldorf selects exact approved municipality and body ID, never the first two shared bodies',()=>{
 const city=cities.find(city=>city.id==='duesseldorf')!;
 const candidates=[{id:'http://ris-oparl.itk-rheinland.de/Oparl/bodies/0009',name:'Stadt Neuss'},{id:'http://ris-oparl.itk-rheinland.de/Oparl/bodies/0011',name:'Stadt Mönchengladbach'},{id:'http://ris-oparl.itk-rheinland.de/Oparl/bodies/0015',name:'Stadt Duesseldorf'}];
 assert.equal(selectCouncilBody(candidates,city).id,candidates[2].id);
 assert.equal(bodyMatchesCity('Stadt Neuss',city),false);
 assert.equal(bodyMatchesCity('Stadt Duesseldorf',city),true);
 assert.equal(bodyMatchesCity('Stadt Duesseldorf - Neuss',city),false);
 assert.equal(bodyIdMatchesCity(candidates[0].id,city),false);
 assert.throws(()=>selectCouncilBody(candidates.slice(0,2),city),/binding rejected/);
 assert.throws(()=>selectCouncilBody([{...candidates[0],name:'Stadt Duesseldorf'}],city),/binding rejected/);
 assert.throws(()=>selectCouncilBody([candidates[2],candidates[2]],city),/exactly one/);
});

test('Freiburg approved administration label and Castrop municipality exclude EUV',()=>{
 const freiburg=cities.find(city=>city.id==='freiburg')!,castrop=cities.find(city=>city.id==='castrop-rauxel')!;
 assert.equal(bodyMatchesCity('Stadtverwaltung Freiburg',freiburg),true);
 assert.equal(bodyMatchesCity('EUV',castrop),false);
 assert.equal(selectCouncilBody([{id:'https://castroprauxel.gremien.info/oparl/body/EUV',name:'EUV'},{id:castrop.councilBodyId!,name:'Stadt Castrop-Rauxel'}],castrop).id,castrop.councilBodyId);
});

test('Actual more-rubin Paper envelope and /page/N links are parsed without inventing URL shape',()=>{
 const url='https://ris.freiburg.de/oparl/body/FR/paper';
 const data={data:[{...paper('1'),id:'https://ris.freiburg.de/oparl/paper/3012011100012',type:'https://schema.oparl.org/1.0/Paper',date:'2014-10-08'}],pagination:{totalElements:14055,elementsPerPage:100,currentPage:1,totalPages:141},links:{next:'https://ris.freiburg.de/oparl/body/FR/paper/page/2'}};
 const page=parseOparlList<OparlRecord>(data,url,'Paper');
 assert.equal(page.records.length,1);assert.equal(page.records[0].date,'2014-10-08');assert.equal(page.next,data.links.next);
 assert.throws(()=>parseOparlList({pagination:{totalElements:0}},url,'Paper'),/data must be an array/);
 assert.throws(()=>parseOparlList({data:[{...paper('1'),type:'https://schema.oparl.org/1.0/Meeting'}]},url,'Paper'),/Invalid OParl Paper object/);
 assert.throws(()=>parseOparlList({data:[],pagination:{currentPage:1,totalPages:2}},url,'Paper'),/Missing next-page/);
});

test('Backfill traverses old-first lists and every row; bounded work exposes resumable partial coverage',async()=>{
 const storage=memoryStorage(),next=body.paper!+'/page/2',last=body.paper!+'/page/3',requests:string[]=[];
 const rows=Array.from({length:200},(_,index)=>paper(String(index)));
 const loader=pageLoader({[body.paper!]:{data:[paper('old','2003-02-17')],links:{next}},[next]:{data:rows,links:{next:last}},[last]:{data:[paper('last','2024-10-10')]}},requests);
 const first=await traverseCouncilList(body,'paper',storage,loader,{maxPages:1,now:at});
 assert.equal(first.fetchedPages,1);assert.equal(first.state.backfillComplete,false);assert.equal(first.state.watermark,null);
 assert.equal(councilCoverage(first.records,'paper',councilWindow(new Date(at)),first.state,at).coverage.state,'partial');
 const rest=await traverseCouncilList(body,'paper',storage,loader,{maxPages:2,now:at,reuseCompleteMs:60*60_000});
 assert.equal(rest.state.backfillComplete,true);assert.equal(rest.state.active,null);assert.equal(rest.records.size,202);
 const health=councilCoverage(rest.records,'paper',councilWindow(new Date(at)),rest.state,at);
 assert.equal(health.recordCount,201);assert.equal(health.coverage.state,'complete');assert.equal(health.coverage.observedStart,'2024-10-10');
 assert.deepEqual(requests,[body.paper,next,last]);
});

test('Completed inventories reuse a bounded cache without claiming a fresh check; expiry resumes incremental collection',async()=>{
 const storage=memoryStorage();
 await traverseCouncilList(body,'paper',storage,pageLoader({[body.paper!]:{data:[paper('one')]}}),{now:at});
 const requests:string[]=[],reuse=await traverseCouncilList(body,'paper',storage,pageLoader({},requests),{now:'2026-10-10T12:30:00.000Z',reuseCompleteMs:60*60_000});
 assert.equal(reuse.fetchedPages,0);assert.equal(reuse.records.size,1);assert.equal(reuse.state.lastCheckedAt,at);assert.equal(requests.length,0);
 const expiredAt='2026-10-10T14:00:00.000Z';
 const refreshed=await traverseCouncilList(body,'paper',storage,async url=>{requests.push(url);return {...evidence,url,checkedAt:expiredAt,data:{data:[]}};},{now:expiredAt,reuseCompleteMs:60*60_000});
 assert.equal(refreshed.fetchedPages,1);assert.equal(refreshed.state.lastCheckedAt,expiredAt);assert.equal(requests.length,1);
 assert.equal(new URL(requests[0]).searchParams.get('modified_since'),'2026-10-10T11:59:59.000Z');
 await assert.rejects(()=>traverseCouncilList(body,'paper',storage,pageLoader({}),{reuseCompleteMs:-1}),/reuse policy/);
});

test('Incremental modified_since updates and tombstones merge without dropping backfilled history',async()=>{
 const storage=memoryStorage();
 await traverseCouncilList(body,'paper',storage,pageLoader({[body.paper!]:{data:[paper('older','2024-11-01'),paper('change'),paper('delete')]}}),{now:at});
 const requests:string[]=[],incremental=new URL(body.paper!);incremental.searchParams.set('modified_since','2026-10-10T11:59:59.000Z');
 const second=await traverseCouncilList(body,'paper',storage,pageLoader({[incremental.toString()]:{data:[{...paper('change','2026-09-01','2026-10-11T09:00:00Z'),name:'Corrected title'},{id:paper('delete').id,type:paper('delete').type,deleted:true,modified:'2026-10-11T09:00:00Z'}]}},requests),{now:'2026-10-11T12:00:00.000Z'});
 assert.deepEqual(requests,[incremental.toString()]);assert.equal(second.records.size,3);
 assert.equal(second.records.get(paper('older').id)?.record.date,'2024-11-01');assert.equal(second.records.get(paper('change').id)?.record.name,'Corrected title');
 assert.equal(second.records.get(paper('delete').id)?.record.deleted,true);
 assert.equal(councilCoverage(second.records,'paper',councilWindow(new Date(at)),second.state,at).recordCount,2);
 const thirdUrl=new URL(body.paper!);thirdUrl.searchParams.set('modified_since','2026-10-11T11:59:59.000Z');
 const unchanged=await traverseCouncilList(body,'paper',storage,pageLoader({[thirdUrl.toString()]:{data:[]}}),{now:'2026-10-12T12:00:00.000Z'});
 assert.equal(unchanged.records.size,3);assert.equal(councilCoverage(unchanged.records,'paper',councilWindow(new Date(at)),unchanged.state,at).recordCount,2);
});

test('Checked empty is distinct from malformed and failed; no empty source can be ok',async()=>{
 const empty=await traverseCouncilList(body,'paper',memoryStorage(),pageLoader({[body.paper!]:{data:[]}}),{now:at});
 const health=councilCoverage(empty.records,'paper',councilWindow(new Date(at)),empty.state,at);
 assert.equal(health.recordCount,0);assert.equal(health.coverage.state,'empty');
 const failed=await traverseCouncilList(body,'paper',memoryStorage(),pageLoader({[body.paper!]:{error:'not a list'}}),{now:at});
 assert.equal(failed.state.watermark,null);assert.equal(failed.state.pages,0);assert.equal(councilCoverage(failed.records,'paper',councilWindow(new Date(at)),failed.state,at).coverage.state,'failed');
});

test('Missing/invalid event dates are quarantined, never replaced by modified or retrieval time',async()=>{
 assert.equal(councilEventDate({...paper('missing'),date:undefined},'paper'),null);
 assert.equal(councilEventDate(paper('invalid','2026-02-30'),'paper'),null);
 assert.equal(inCouncilWindow(paper('old','2003-02-17',at),'paper',councilWindow(new Date(at))),false);
 const result=await traverseCouncilList(body,'paper',memoryStorage(),pageLoader({[body.paper!]:{data:[{...paper('missing'),date:undefined},paper('valid')]}}),{now:at});
 const health=councilCoverage(result.records,'paper',councilWindow(new Date(at)),result.state,at);
 assert.equal(health.recordCount,1);assert.equal(health.quarantined,1);assert.equal(health.coverage.state,'partial');assert.match(health.coverage.reason!,/not substituted/);
});

test('Foreign bodies and paging cycles fail without advancing the watermark',async()=>{
 const wrong=await traverseCouncilList(body,'paper',memoryStorage(),pageLoader({[body.paper!]:{data:[{...paper('wrong'),body:'https://council.example/body/2'}]}}),{now:at});
 assert.match(wrong.state.error!,/Wrong Body/);assert.equal(wrong.records.size,0);assert.equal(wrong.state.watermark,null);
 const loop=await traverseCouncilList(body,'paper',memoryStorage(),pageLoader({[body.paper!]:{data:[paper('1')],links:{next:body.paper}}}),{now:at});
 assert.match(loop.state.error!,/pagination cycle/);assert.equal(loop.state.backfillComplete,false);
});

test('Archive and live identity is canonical; old archive updates cannot resurrect newer deletion',()=>{
 const records=new Map<string,StoredCouncilRecord>(),old=paper('deleted','2025-01-01','2025-01-02T00:00:00Z');
 mergeCouncilRecords(records,[{id:old.id,type:old.type,deleted:true,modified:at}],evidence);mergeCouncilRecords(records,[{...old,id:old.id.replace('https:','http:')+'/'}],evidence);
 assert.equal(records.get(canonicalOparlUrl(old.id))?.record.deleted,true);
 assert.equal(councilId(old.id),councilId(old.id.replace('https:','http:')+'/'));
 assert.equal(recordMatchesBody(old,body),true);assert.equal(recordMatchesBody({...old,body:'https://council.example/body/2'},body),false);
 assert.equal(recordMatchesBody({...old,body:undefined,id:'https://council.example/paper/unscoped'},body),false);
});

test('Ignored modified_since automatically switches to bounded full refresh; missing rows withdraw only on complete scan',async()=>{
 const storage=memoryStorage();
 await traverseCouncilList(body,'paper',storage,pageLoader({[body.paper!]:{data:[paper('older','2024-11-01'),paper('change'),paper('withdraw')]}}),{now:at});
 const query=new URL(body.paper!);query.searchParams.set('modified_since','2026-10-10T11:59:59.000Z');
 const ignored=await traverseCouncilList(body,'paper',storage,pageLoader({[query.toString()]:{data:[paper('older','2024-11-01')],links:{next:body.paper!+'/page/2'}}}),{maxPages:1,now:'2026-10-11T12:00:00.000Z'});
 assert.equal(ignored.state.filterSupport,'unsupported');assert.equal(ignored.state.watermark,null);assert.equal(ignored.state.active?.mode,'refresh');assert.equal(ignored.records.size,3);
 const next=body.paper!+'/page/2',requests:string[]=[];
 const loader=pageLoader({[body.paper!]:{data:[paper('older','2024-11-01')],pagination:{totalElements:2},links:{next}},[next]:{data:[{...paper('change','2026-09-01','2026-10-11T09:00:00Z'),name:'Changed by full refresh'}],pagination:{totalElements:2}}},requests);
 const partial=await traverseCouncilList(body,'paper',storage,loader,{maxPages:1,now:'2026-10-11T12:00:00.000Z'});
 assert.equal(partial.records.size,3);assert.equal(partial.state.withdrawnIds?.length??0,0);
 assert.equal(councilCoverage(partial.records,'paper',councilWindow(new Date(at)),partial.state,at).coverage.state,'partial');
 const complete=await traverseCouncilList(body,'paper',storage,loader,{maxPages:1,now:'2026-10-11T12:00:00.000Z'});
 assert.equal(complete.state.active,null);assert.equal(complete.state.watermark,null);assert.equal(complete.records.size,2);
 assert.deepEqual(complete.state.withdrawnIds,[paper('withdraw').id]);assert.equal(complete.records.get(paper('change').id)?.record.name,'Changed by full refresh');
 assert.match(councilCoverage(complete.records,'paper',councilWindow(new Date(at)),complete.state,at).coverage.reason!,/not incremental coverage/);
 assert.deepEqual(requests,[body.paper,next]);
 const later=await traverseCouncilList(body,'paper',storage,loader,{maxPages:2,now:'2026-10-12T12:00:00.000Z'});
 assert.equal(later.records.has(paper('withdraw').id),false);assert.equal(later.state.watermark,null);assert.equal(later.records.size,2);
});

test('Advertised full-list count mismatch retains prior rows and automatically restarts instead of deleting',async()=>{
 const storage=memoryStorage();
 await traverseCouncilList(body,'paper',storage,pageLoader({[body.paper!]:{data:[paper('older'),paper('keep')]}}),{now:at});
 const query=new URL(body.paper!);query.searchParams.set('modified_since','2026-10-10T11:59:59.000Z');
 const result=await traverseCouncilList(body,'paper',storage,pageLoader({[query.toString()]:{data:[paper('older')]},[body.paper!]:{data:[paper('older')],pagination:{totalElements:2}}}),{maxPages:2,now:'2026-10-11T12:00:00.000Z'});
 assert.equal(result.records.size,2);assert.equal(result.state.active?.nextUrl,body.paper);assert.match(result.state.error!,/count changed or truncated/);
 const resumed=await traverseCouncilList(body,'paper',storage,pageLoader({[body.paper!]:{data:[paper('older'),paper('keep')],pagination:{totalElements:2}}}),{maxPages:1,now:'2026-10-11T12:00:00.000Z'});
 assert.equal(resumed.state.active,null);assert.equal(resumed.state.error,undefined);assert.equal(resumed.records.size,2);
});

test('Rights retain explicit restrictive terms but never infer an open licence from Open or OParl itself',()=>{
 assert.deepEqual(councilLicence('Open'),{licence:'unknown',reuse:'facts_with_attribution'});
 assert.deepEqual(councilLicence(),{licence:'unknown',reuse:'facts_with_attribution'});
 const restricted='https://creativecommons.org/licenses/by-nc-nd/4.0/';
 assert.deepEqual(councilLicence(restricted),{licence:restricted,reuse:'facts_with_attribution'});
 assert.deepEqual(councilLicence('https://www.govdata.de/dl-de/zero-2-0'),{licence:'https://www.govdata.de/dl-de/zero-2-0',reuse:'open_licence'});
});

test('Incremental pagination resumes after network failure and advances watermark only on the final page',async()=>{
 const storage=memoryStorage();
 await traverseCouncilList(body,'paper',storage,pageLoader({[body.paper!]:{data:[paper('old','2024-10-12'),paper('change'),paper('delete')]}}),{now:at});
 const query=new URL(body.paper!);query.searchParams.set('modified_since','2026-10-10T11:59:59.000Z');
 const cursor='https://council.example/delta?cursor=opaque-public-cursor';
 const partial=await traverseCouncilList(body,'paper',storage,pageLoader({[query.toString()]:{data:[{...paper('change','2026-09-01','2026-10-11T10:00:00Z'),name:'Updated'}],links:{next:cursor}}}),{maxPages:1,now:'2026-10-11T12:00:00.000Z'});
 assert.equal(partial.state.watermark,at);assert.equal(partial.state.active?.nextUrl,cursor);assert.equal(partial.records.size,3);
 const unavailable:CouncilLoader=async()=>{throw Error('HTTP 503 public source unavailable');};
 const failed=await traverseCouncilList(body,'paper',storage,unavailable,{maxPages:1,now:'2026-10-11T13:00:00.000Z'});
 assert.match(failed.state.error!,/HTTP 503/);assert.equal(failed.state.watermark,at);assert.equal(failed.records.get(paper('old').id)?.record.date,'2024-10-12');
 const unavailableCoverage=councilCoverage(failed.records,'paper',councilWindow(new Date(at)),failed.state,at);
 assert.equal(unavailableCoverage.coverage.state,'partial');assert.match(unavailableCoverage.coverage.reason!,/HTTP 503.*Resumable incremental/);
 const complete=await traverseCouncilList(body,'paper',storage,pageLoader({[cursor]:{data:[{id:paper('delete').id,type:paper('delete').type,deleted:true,modified:'2026-10-11T11:00:00Z'}]}}),{maxPages:1,now:'2026-10-11T14:00:00.000Z'});
 assert.equal(complete.state.active,null);assert.equal(complete.state.watermark,'2026-10-11T12:00:00.000Z');assert.equal(complete.state.filterSupport,'supported');
 assert.equal(complete.records.get(paper('change').id)?.record.name,'Updated');assert.equal(complete.records.get(paper('delete').id)?.record.deleted,true);
 assert.equal(councilCoverage(complete.records,'paper',councilWindow(new Date(at)),complete.state,at).recordCount,2);
});

test('Rejected municipality becomes release-checkable failed binding metadata, not an empty successful source',()=>{
 const city=cities.find(city=>city.id==='duesseldorf')!,wrong={id:'https://ris-oparl.itk-rheinland.de/Oparl/bodies/0009',name:'Stadt Neuss'};
 const result=councilBindingFailure(city,new CouncilBindingError(city,[wrong]));
 assert.equal(result.features.length,0);assert.equal(result.sources[0].status,'failed');assert.equal(result.sources[0].recordCount,0);
 assert.equal(result.sources[0].bodyBinding.id,wrong.id);assert.equal(result.sources[0].bodyBinding.name,wrong.name);assert.equal(result.sources[0].bodyBinding.matched,false);
 assert.equal(result.sources[0].coverage.state,'failed');assert.match(result.sources[0].coverage.reason,/Stadt Neuss/);
});

test('Requested history is 24 calendar months; published future announcements remain available',()=>{
 assert.deepEqual(councilWindow(new Date(at)),{start:'2024-10-10',end:'2026-10-10'});
 assert.deepEqual(councilWindow(new Date('2024-02-29T12:00:00Z')),{start:'2022-02-28',end:'2024-02-29'});
 assert.equal(inCouncilWindow(paper('boundary','2024-10-10'),'paper',councilWindow(new Date(at))),true);
 assert.equal(inCouncilWindow(paper('old','2024-10-09'),'paper',councilWindow(new Date(at))),false);
 assert.equal(inCouncilWindow(paper('future','2026-10-11'),'paper',councilWindow(new Date(at))),true);
});

test('Rejected modified_since is not treated as empty; verified full-list fallback preserves history',async()=>{
 const storage=memoryStorage();
 await traverseCouncilList(body,'paper',storage,pageLoader({[body.paper!]:{data:[paper('old','2024-11-01'),paper('change')]}}),{now:at});
 const rejected:CouncilLoader=async url=>{assert.ok(new URL(url).searchParams.has('modified_since'));throw Error(`HTTP 404 ${url}`);};
 const partial=await traverseCouncilList(body,'paper',storage,rejected,{maxPages:1,now:'2026-10-11T12:00:00.000Z'});
 assert.equal(partial.records.size,2);assert.equal(partial.state.filterSupport,'unsupported');assert.equal(partial.state.watermark,null);assert.equal(partial.state.active?.mode,'refresh');
 assert.match(partial.state.filterSupportReason!,/not interpreted as empty/);
 const complete=await traverseCouncilList(body,'paper',storage,pageLoader({[body.paper!]:{data:[paper('old','2024-11-01'),{...paper('change','2026-09-01','2026-10-11T10:00:00Z'),name:'Corrected'}],pagination:{totalElements:2}}}),{maxPages:1,now:'2026-10-11T12:00:00.000Z'});
 assert.equal(complete.records.size,2);assert.equal(complete.state.active,null);assert.equal(complete.state.watermark,null);assert.equal(complete.records.get(paper('change').id)?.record.name,'Corrected');
 assert.equal(councilCoverage(complete.records,'paper',councilWindow(new Date(at)),complete.state,at).coverage.state,'complete');
});

test('Successful restarted backfill withdraws objects absent from its completed inventory',async()=>{
 const storage=memoryStorage();
 const interrupted=await traverseCouncilList(body,'paper',storage,pageLoader({[body.paper!]:{data:[paper('removed'),paper('kept')],pagination:{totalElements:3}}}),{now:at});
 assert.equal(interrupted.state.backfillComplete,false);assert.ok(interrupted.state.error);
 const complete=await traverseCouncilList(body,'paper',storage,pageLoader({[body.paper!]:{data:[paper('kept'),paper('new')],pagination:{totalElements:2}}}),{now:at});
 assert.equal(complete.state.backfillComplete,true);assert.equal(complete.state.active,null);
 assert.equal(complete.records.has(paper('removed').id),false);
 assert.deepEqual((await storage.readSegment(1)).withdrawnIds,[paper('removed').id]);
 const cached=await traverseCouncilList(body,'paper',storage,pageLoader({}),{now:at,reuseCompleteMs:60_000});
 assert.equal(cached.records.has(paper('removed').id),false);assert.equal(cached.records.size,2);
});

test('Duplicate full-list rows cannot conceal missing IDs or authorize withdrawals',async()=>{
 for(const advertised of [true,false]){
  const storage=memoryStorage();
  await traverseCouncilList(body,'paper',storage,pageLoader({[body.paper!]:{data:[paper('a'),paper('b')]}}),{now:at});
  const state=await storage.load();assert.ok(state);state.filterSupport='unsupported';await storage.checkpoint(state);
  const broken=await traverseCouncilList(body,'paper',storage,pageLoader({[body.paper!]:{data:[paper('a'),paper('a')],...(advertised?{pagination:{totalElements:2}}:{})}}),{now:at});
  assert.ok(broken.state.error);assert.equal(broken.state.active?.mode,'refresh');
  assert.equal(broken.records.has(paper('b').id),true);assert.equal(broken.state.withdrawnIds?.includes(paper('b').id),false);
  const completed=await traverseCouncilList(body,'paper',storage,pageLoader({[body.paper!]:{data:[paper('a'),paper('b')],pagination:{totalElements:2}}}),{now:at});
  assert.equal(completed.state.active,null);assert.equal(completed.records.size,2);
 }
});

interface CouncilWireSeam {wire(url:URL):Promise<{status:number;headers:Record<string,string|undefined>;body:Buffer}>}
test('council inspection fixture seam cannot authorize a production acquisition context',()=>{
 const city=cities.find(city=>city.id==='koeln')!;
 assert.throws(()=>createCouncilAcquisition(city,{cacheRoot:'/unused-before-inspection',fixtureInspection:fixturePolicyInspection}),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_state_unsafe');
});

test('registered council discovery and traversal retain managed provenance and stop cache reuse on objection',async t=>{
 const {root,policy}=await createCivicPolicyTestContext(t);
 const city=cities.find(city=>city.id==='koeln')!,cacheRoot=join(root,'raw'),acquisition=createCouncilAcquisition(city,{cacheRoot,policy,fixtureInspection:fixturePolicyInspection});
 const selectedBody:OparlBody={id:city.councilBodyId!,name:city.councilBodyAliases![0],type:'https://schema.oparl.org/1.1/Body',paper:city.councilBodyId+'/paper',meeting:city.councilBodyId+'/meeting'},bodiesUrl=new URL('/oparl/bodies',city.endpoint).href;
 const record:OparlRecord={id:selectedBody.paper+'/1',body:selectedBody.id,type:'https://schema.oparl.org/1.1/Paper',name:'Synthetic municipal council submission',date:'2026-09-01',modified:'2026-09-02T00:00:00Z'};
 let wireCalls=0;
 t.mock.method(acquisition.fetcher as unknown as CouncilWireSeam,'wire',async(url:URL)=>{
  wireCalls++;
  if(url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  const data=url.href===city.endpoint?{id:city.endpoint,type:'https://schema.oparl.org/1.1/System',body:bodiesUrl,license:'https://www.govdata.de/dl-de/zero-2-0'}:url.href===bodiesUrl?{data:[selectedBody]}:url.href===selectedBody.paper?{data:[record]}:url.href===selectedBody.meeting?{data:[]}:undefined;
  assert.ok(data,`Unexpected synthetic URL ${url.href}`);
  return {status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(data))};
 });
 const collection=await collectOparl(city,{acquisition,maxPages:5,now:new Date(at)});
 assert.equal(collection.features.length,1);assert.equal(collection.features[0].properties.kind,'council_paper');
 const storage=acquisition.storage(selectedBody.id,'paper'),checkpoint=await storage.load();assert.equal(checkpoint?.backfillComplete,true);
 const segment=await storage.readSegment(0),path=join(cacheRoot,'oparl',hash(canonicalOparlUrl(selectedBody.id)),'paper','page-0.json'),persisted=JSON.parse(await readFile(path,'utf8'));
 assert.equal(persisted.sourceBindings.length,1);assert.equal(persisted.sourceBindings[0].sha256,segment.evidence.sha256);
 assert.ok((await readFile(join(cacheRoot,'sha256',segment.evidence.sha256))).length);
 const signalPath=await acquisition.persistCollection('signals.geojson',{type:'FeatureCollection',features:collection.features});
 const summaryPath=await acquisition.persistCollection('collection.json',{cityId:city.id,sources:collection.sources});
 const before=wireCalls,objection=await recordHostOptOut({host:new URL(city.endpoint!).hostname,reason:'municipality_objection',reference:'synthetic-council-test'},policy);
 assert.equal(objection.purge.status,'purged');
 await assert.rejects(stat(path),{code:'ENOENT'});
 await assert.rejects(stat(signalPath),{code:'ENOENT'});await assert.rejects(stat(summaryPath),{code:'ENOENT'});
 await assert.rejects(storage.load(),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_opted_out');
 await assert.rejects(storage.readSegment(0),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_opted_out');
 await assert.rejects(acquisition.loadJson(city.endpoint!),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_opted_out');
 assert.equal(wireCalls,before);
});

test('managed preloaded council pages cannot survive a current document exclusion as stale collector results',async t=>{
 const {root,policy}=await createCivicPolicyTestContext(t);
 const city=cities.find(city=>city.id==='koeln')!,acquisition=createCouncilAcquisition(city,{cacheRoot:join(root,'raw'),policy,fixtureInspection:fixturePolicyInspection});
 await acquisition.fetcher.initialize();
 const selectedBody:OparlBody={id:city.councilBodyId!,name:city.councilBodyAliases![0],type:'https://schema.oparl.org/1.1/Body',paper:city.councilBodyId+'/paper',meeting:city.councilBodyId+'/meeting'},bodiesUrl=new URL('/oparl/bodies',city.endpoint).href;
 const record:OparlRecord={id:selectedBody.paper+'/1',body:selectedBody.id,type:'https://schema.oparl.org/1.1/Paper',name:'Synthetic previously admitted council submission',date:'2026-09-01',modified:'2026-09-02T00:00:00Z'};
 let excluded=false,paperRequests=0;
 t.mock.method(acquisition.fetcher as unknown as CouncilWireSeam,'wire',async(url:URL)=>{
  if(url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  if(url.pathname===new URL(selectedBody.paper!).pathname){
   paperRequests++;
   return {status:200,headers:{'content-type':'application/json',...(excluded?{'tdm-reservation':'1'}:{})},body:Buffer.from(JSON.stringify({data:[excluded?{...record,body:undefined}:record]}))};
  }
  const data=url.href===city.endpoint?{id:city.endpoint,type:'https://schema.oparl.org/1.1/System',body:bodiesUrl,license:'https://www.govdata.de/dl-de/zero-2-0'}:url.href===bodiesUrl?{data:[selectedBody]}:url.pathname===new URL(selectedBody.meeting!).pathname?{data:[]}:undefined;
  assert.ok(data,`Unexpected synthetic URL ${url.href}`);
  return {status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(data))};
 });
 const initial=await collectOparl(city,{acquisition,maxPages:5,now:new Date(at)});
 assert.equal(initial.features.length,1);assert.equal(initial.features[0].geometry,null);
 const storage=acquisition.storage(selectedBody.id,'paper');
 assert.equal((await storage.readSegment(0)).records[0].id,record.id);
 excluded=true;
 const returned:unknown[]=[];
 await assert.rejects(async()=>{returned.push(await collectOparl(city,{acquisition,maxPages:5,now:new Date('2026-10-11T12:00:00.000Z')}));},error=>error instanceof PoliteFetchError&&error.failure==='document_excluded');
 assert.match((await storage.load())!.error!,/Current source permission/);
 await assert.rejects(async()=>{returned.push(await collectOparl(city,{acquisition,maxPages:5,now:new Date('2026-10-11T12:01:00.000Z'),reuseCompleteMs:48*60*60_000}));},error=>error instanceof PoliteFetchError&&error.failure==='document_excluded');
 assert.deepEqual(returned,[]);assert.equal(paperRequests,3);
});

test('council live context rejects forged registration and never adopts a named historical cache',async t=>{
 const {root,policy}=await createCivicPolicyTestContext(t);
 const city=cities.find(city=>city.id==='koeln')!,cacheRoot=join(root,'owner-policy-2026-10-11');
 assert.throws(()=>createCouncilAcquisition({...city,endpoint:'https://other-council.de/system'},{cacheRoot,policy}),/registered City endpoint/);
 assert.throws(()=>createCouncilAcquisition({...city,id:'unregistered-city'},{cacheRoot,policy}),/registered City endpoint/);
 await mkdir(cacheRoot);await writeFile(join(cacheRoot,'frozen.json'),'retained historical snapshot');
 const acquisition=createCouncilAcquisition(city,{cacheRoot,policy});let calls=0;
 t.mock.method(acquisition.fetcher,'fetch',async()=>{calls++;throw Error('Unmarked root must fail first');});
 await assert.rejects(acquisition.loadJson(city.endpoint!),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_state_unsafe');
 assert.equal(calls,0);assert.equal(await readFile(join(cacheRoot,'frozen.json'),'utf8'),'retained historical snapshot');
 await assert.rejects(stat(join(cacheRoot,'.civic-acquisition-lane.json')),{code:'ENOENT'});
 assert.ok((await stat(policy.stateDir!)).isDirectory());
 assert.throws(()=>acquisition.storage('https://other-council.de/body/1','paper'),/registered City/);
});


test('licence-page acquisition keeps its own origin assessment instead of inheriting OParl Body authorship',async t=>{
 const {root,policy}=await createCivicPolicyTestContext(t);
 const city=cities.find(city=>city.id==='koeln')!,acquisition=createCouncilAcquisition(city,{cacheRoot:join(root,'raw'),policy,fixtureInspection:fixturePolicyInspection});
 const selected:OparlBody={id:city.councilBodyId!,name:city.councilBodyAliases![0],type:'https://schema.oparl.org/1.1/Body',paper:city.councilBodyId+'/paper'};
 acquisition.bindBody(selected);
 const seen:Array<{registeredSourceUrl?:string;originEvidence:FetchOptions['oparlContext']}>= [];
 const governedFetch=acquisition.fetcher.fetch.bind(acquisition.fetcher);
 t.mock.method(acquisition.fetcher as unknown as CouncilWireSeam,'wire',async(url:URL)=>{
  if(url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  return url.href===selected.paper?{status:200,headers:{'content-type':'application/json'},body:Buffer.from('{"data":[]}')}:{status:200,headers:{'content-type':'text/html'},body:Buffer.from('<html><body>Municipal copyright notice.</body></html>')};
 });
 t.mock.method(acquisition.fetcher,'fetch',async(url:string,options:FetchOptions={})=>{
  seen.push({registeredSourceUrl:options.registeredSourceUrl,originEvidence:options.oparlContext});
  return governedFetch(url,options);
 });
 await acquisition.loadJson(selected.paper!);
 await acquisition.loadText('https://www.stadt-koeln.de/impressum');
 assert.deepEqual(seen[0].originEvidence,{bodyId:selected.id,bodyName:selected.name,apiUrl:selected.paper});assert.equal(seen[1].originEvidence,undefined);
 assert.ok(seen.every(item=>item.registeredSourceUrl===city.endpoint));
});

test('current council permission denial cannot return loaded records or regain a completed-cache shortcut',async()=>{
 for(const failure of ['document_excluded','tdm_reserved','tdm_unavailable','access_barrier','host_opted_out','host_state_unsafe','cross_host_redirect'] as const){
  const storage=memoryStorage();
  await traverseCouncilList(body,'paper',storage,pageLoader({[body.paper!]:{data:[paper('previously-permitted')]}}),{now:at});
  const denial=new PoliteFetchError(failure,'Synthetic current permission denial');let attempts=0;
  const denied:CouncilLoader=async()=>{attempts++;throw denial;};
  await assert.rejects(traverseCouncilList(body,'paper',storage,denied,{now:'2026-10-11T12:00:00.000Z'}),error=>error===denial);
  const state=await storage.load();assert.match(state!.error!,/Current source permission/);
  await assert.rejects(traverseCouncilList(body,'paper',storage,denied,{now:'2026-10-11T12:01:00.000Z',reuseCompleteMs:24*60*60_000}),error=>error===denial);
  assert.equal(attempts,2);
 }
 const storage=memoryStorage();
 await traverseCouncilList(body,'paper',storage,pageLoader({[body.paper!]:{data:[paper('network-partial-only')]}}),{now:at});
 const partial=await traverseCouncilList(body,'paper',storage,async()=>{throw new PoliteFetchError('network_error','Synthetic temporary network failure');},{now:'2026-10-11T12:00:00.000Z'});
 assert.equal(partial.records.size,1);assert.equal(isCouncilPermissionFailure(new PoliteFetchError('network_error','Synthetic')),false);
});
test('permission denial remains structured when its durable metadata checkpoint also fails',async()=>{
 const storage=memoryStorage();
 await traverseCouncilList(body,'paper',storage,pageLoader({[body.paper!]:{data:[paper('old')]}}),{now:at});
 const failing:CouncilStorage={...storage,checkpoint:async()=>{throw Error('Synthetic unavailable checkpoint');}},denial=new PoliteFetchError('http_error','Synthetic HTTP403',403);
 await assert.rejects(traverseCouncilList(body,'paper',failing,async()=>{throw denial;},{now:'2026-10-11T12:00:00.000Z'}),error=>error instanceof AggregateError&&error.errors[0]===denial&&isCouncilPermissionFailure(error));
});

for(const phase of ['robots','tdm'] as const)test(`council ${phase} transport failures cannot reuse preloaded records or completed cache`,async t=>{
 const {root,policy}=await createCivicPolicyTestContext(t),city=cities.find(city=>city.id==='koeln')!;
 const selected:OparlBody={id:city.councilBodyId!,name:city.councilBodyAliases![0],type:'https://schema.oparl.org/1.1/Body',paper:city.councilBodyId+'/paper'};
 const record:OparlRecord={id:selected.paper+'/1',body:selected.id,type:'https://schema.oparl.org/1.1/Paper',name:'Synthetic preloaded council record',date:'2026-09-01',modified:'2026-09-02T00:00:00Z'},storage=memoryStorage();
 const initial=await traverseCouncilList(selected,'paper',storage,pageLoader({[selected.paper!]:{data:[record]}}),{now:at});assert.equal(initial.records.size,1);
 const acquisition=createCouncilAcquisition(city,{cacheRoot:join(root,'raw'),policy,fixtureInspection:fixturePolicyInspection});acquisition.bindBody(selected);
 const denial=new PoliteFetchError('network_error','Synthetic mandatory policy transport failure'),seen:string[]=[];
 t.mock.method(acquisition.fetcher as unknown as CouncilWireSeam,'wire',async(url:URL)=>{
  seen.push(url.pathname);
  if(url.pathname===(phase==='robots'?'/robots.txt':'/.well-known/tdmrep.json'))throw denial;
  assert.equal(url.pathname,'/robots.txt');return {status:404,headers:{},body:Buffer.alloc(0)};
 });
 const returned:unknown[]=[];
 for(const [now,reuseCompleteMs] of [['2026-10-11T12:00:00.000Z',0],['2026-10-11T12:01:00.000Z',48*60*60_000]] as const){
  await assert.rejects(async()=>{returned.push(await traverseCouncilList(selected,'paper',storage,acquisition.loadJson,{now,reuseCompleteMs}));},error=>error===denial&&denial.policyPhase===phase&&isCouncilPermissionFailure(error));
  assert.match((await storage.load())!.error!,/Current source permission/);
 }
 assert.deepEqual(returned,[]);assert.equal(acquisition.fetcher.requestCount,2);
 assert.deepEqual(seen,phase==='robots'?['/robots.txt']:['/robots.txt','/.well-known/tdmrep.json']);
});

test('ordinary council document transport errors keep partial availability without policy-phase context',async t=>{
 const {root,policy}=await createCivicPolicyTestContext(t),city=cities.find(city=>city.id==='koeln')!;
 const selected:OparlBody={id:city.councilBodyId!,name:city.councilBodyAliases![0],type:'https://schema.oparl.org/1.1/Body',paper:city.councilBodyId+'/paper'};
 const record:OparlRecord={id:selected.paper+'/1',body:selected.id,type:'https://schema.oparl.org/1.1/Paper',name:'Synthetic preloaded council record',date:'2026-09-01',modified:'2026-09-02T00:00:00Z'},storage=memoryStorage();
 await traverseCouncilList(selected,'paper',storage,pageLoader({[selected.paper!]:{data:[record]}}),{now:at});
 const acquisition=createCouncilAcquisition(city,{cacheRoot:join(root,'raw'),policy,fixtureInspection:fixturePolicyInspection});acquisition.bindBody(selected);
 const failure=new PoliteFetchError('network_error','Synthetic ordinary document transport failure');
 t.mock.method(acquisition.fetcher as unknown as CouncilWireSeam,'wire',async(url:URL)=>{
  if(url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  throw failure;
 });
 const partial=await traverseCouncilList(selected,'paper',storage,acquisition.loadJson,{now:'2026-10-11T12:00:00.000Z'});
 assert.equal(partial.records.size,1);assert.equal(failure.policyPhase,null);assert.equal(isCouncilPermissionFailure(failure),false);
});

test('OParl capture failure aborts without returning cached records or checkpointing a permission denial',async t=>{
 const {root,policy}=await createCivicPolicyTestContext(t),city=cities.find(city=>city.id==='koeln')!,cacheRoot=join(root,'raw');
 const acquisition=createCouncilAcquisition(city,{cacheRoot,policy,fixtureInspection:fixturePolicyInspection}),selected:OparlBody={id:city.councilBodyId!,name:city.councilBodyAliases![0],type:'https://schema.oparl.org/1.1/Body',paper:city.councilBodyId+'/paper'};
 acquisition.bindBody(selected);
 const record:OparlRecord={id:selected.paper+'/1',body:selected.id,type:'https://schema.oparl.org/1.1/Paper',name:'Synthetic cached council record',date:'2026-09-01',modified:'2026-09-02T00:00:00Z'};
 const initialBytes=Buffer.from(JSON.stringify({data:[record]})),updatedBytes=Buffer.from(JSON.stringify({data:[{...record,name:'Synthetic newly fetched council record'}]}));let refresh=false;
 t.mock.method(acquisition.fetcher as unknown as CouncilWireSeam,'wire',async(url:URL)=>{
  if(url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  assert.equal(url.pathname,new URL(selected.paper!).pathname);return {status:200,headers:{'content-type':'application/json'},body:refresh?updatedBytes:initialBytes};
 });
 const storage=acquisition.storage(selected.id,'paper'),first=await traverseCouncilList(selected,'paper',storage,acquisition.loadJson,{now:at});assert.equal(first.records.size,1);
 const checkpointPath=join(cacheRoot,'oparl',hash(canonicalOparlUrl(selected.id)),'paper','checkpoint.json'),checkpointBytes=await readFile(checkpointPath),originalCheckpoint=storage.checkpoint.bind(storage);let checkpoints=0;
 t.mock.method(storage,'checkpoint',async(...args:Parameters<CouncilStorage['checkpoint']>)=>{checkpoints++;return originalCheckpoint(...args);});
 await rm(cacheRoot+'-request-evidence',{recursive:true,force:true});await writeFile(cacheRoot+'-request-evidence','SYNTHETIC_COUNCIL_CAPTURE_OBSTRUCTION',{mode:0o600,flag:'wx'});refresh=true;
 const returned:unknown[]=[];
 await assert.rejects(async()=>{returned.push(await traverseCouncilList(selected,'paper',storage,acquisition.loadJson,{now:'2026-10-11T12:00:00.000Z'}));},(error:unknown)=>{assert.ok(error instanceof CrawlRequestEvidenceCaptureError);assert.equal(isCouncilPermissionFailure(error),false);return true;});
 assert.deepEqual(returned,[]);assert.equal(checkpoints,0);assert.deepEqual(await readFile(checkpointPath),checkpointBytes);assert.equal((await storage.readSegment(0)).records[0].name,record.name);
 assert.deepEqual(await readFile(join(cacheRoot,'sha256',hash(initialBytes))),initialBytes);assert.deepEqual(await readFile(join(cacheRoot,'sha256',hash(updatedBytes))),updatedBytes);
 const observations=await Promise.all((await readdir(join(cacheRoot,'observations'))).map(async name=>JSON.parse(await readFile(join(cacheRoot,'observations',name),'utf8')))),fresh=observations.filter(row=>row.sha256===hash(updatedBytes));
 assert.equal(fresh.length,1);assert.equal(fresh[0].state,'fetched');assert.equal(fresh[0].status,200);assert.equal(fresh[0].failure,undefined);
});

for(const [cityId,rightsUrl] of [
 ['duesseldorf','https://opendata.duesseldorf.de/dataset/oparl-schnittstelle-zum-ratsinformationsystem-der-stadt-d%C3%BCsseldorf'],
 ['freiburg','https://www.freiburg.de/pb/224613.html'],
 ['castrop-rauxel','https://www.castrop-rauxel.de/impressum'],
] as const)test(`${cityId} rights-page capture failure propagates instead of reporting unavailable rights`,async t=>{
 const {root,policy}=await createCivicPolicyTestContext(t),city=cities.find(city=>city.id===cityId)!,cacheRoot=join(root,'raw'),acquisition=createCouncilAcquisition(city,{cacheRoot,policy,fixtureInspection:fixturePolicyInspection});
 const selected:OparlBody={id:city.councilBodyId!,name:city.councilBodyAliases?.[0]??city.name,type:'https://schema.oparl.org/1.1/Body'},bodiesUrl=new URL('/capture-test/bodies',city.endpoint).href,rightsBytes=Buffer.from('<html><body>Synthetic municipal Urheberrecht notice.</body></html>'),seen:string[]=[];
 t.mock.method(acquisition.fetcher as unknown as CouncilWireSeam,'wire',async(url:URL)=>{
  if(url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  seen.push(url.href);
  if(url.href===rightsUrl)return {status:200,headers:{'content-type':'text/html'},body:rightsBytes};
  const data=url.href===canonicalOparlUrl(city.endpoint!)?{id:city.endpoint,type:'https://schema.oparl.org/1.1/System',body:bodiesUrl}:url.href===bodiesUrl?{data:[selected]}:undefined;
  assert.ok(data,`Unexpected synthetic rights-discovery URL ${url.href}`);return {status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(data))};
 });
 const loadText=acquisition.loadText.bind(acquisition);
 t.mock.method(acquisition,'loadText',async(url:string)=>{
  assert.equal(url,rightsUrl);await rm(cacheRoot+'-request-evidence',{recursive:true,force:true});await writeFile(cacheRoot+'-request-evidence','SYNTHETIC_RIGHTS_CAPTURE_OBSTRUCTION',{mode:0o600,flag:'wx'});
  return loadText(url);
 });
 const returned:unknown[]=[];
 await assert.rejects(async()=>{returned.push(await collectOparl(city,{acquisition,maxPages:1,now:new Date(at)}));},(error:unknown)=>{assert.ok(error instanceof CrawlRequestEvidenceCaptureError);assert.equal(isCouncilPermissionFailure(error),false);return true;});
 assert.deepEqual(returned,[]);assert.equal(seen.at(-1),rightsUrl);assert.deepEqual(await readFile(join(cacheRoot,'sha256',hash(rightsBytes))),rightsBytes);
 const observations=await Promise.all((await readdir(join(cacheRoot,'observations'))).map(async name=>JSON.parse(await readFile(join(cacheRoot,'observations',name),'utf8')))),rights=observations.filter(row=>row.url===rightsUrl);
 assert.equal(rights.length,1);assert.equal(rights[0].state,'fetched');assert.equal(rights[0].status,200);assert.equal(rights[0].failure,undefined);
 await assert.rejects(stat(join(cacheRoot,'collections')),{code:'ENOENT'});
});
