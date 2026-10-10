import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {cities} from '../src/cities.ts';
import {canonicalOparlUrl,councilId} from '../src/dedupe.ts';
import {traverseCouncilList,loadCouncilJson} from '../src/council-cache.ts';
import {CouncilBindingError,bodyIdMatchesCity,bodyMatchesCity,councilCoverage,councilEventDate,councilLicence,councilWindow,inCouncilWindow,mergeCouncilRecords,parseOparlList,recordMatchesBody,selectCouncilBody} from '../src/council-oparl.ts';
import type {CouncilLoader,CouncilSegment,CouncilStorage} from '../src/council-cache.ts';
import type {CouncilCheckpoint,OparlBody,OparlRecord,StoredCouncilRecord} from '../src/council-oparl.ts';
import {councilBindingFailure} from '../src/council.ts';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {PoliteFetcher,PoliteFetchError} from '../src/polite-fetch.ts';

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

test('Interrupted public GETs back off twice, then preserve the failure for durable resume',async t=>{
 let requests=0;
 t.mock.method(PoliteFetcher.prototype,'fetch',async()=>{requests++;throw new PoliteFetchError('network_error','Public request failed');});
 t.mock.timers.enable({apis:['setTimeout']});
 const failed=assert.rejects(loadCouncilJson(body.paper!),/Public request failed/);
 await nextTurn();assert.equal(requests,1);
 t.mock.timers.tick(14_999);await nextTurn();assert.equal(requests,1);
 t.mock.timers.tick(1);await nextTurn();assert.equal(requests,2);
 t.mock.timers.tick(30_000);await failed;assert.equal(requests,3);
});

test('Policy, HTTP and integrity failures are never retried as connection failures',{timeout:1000},async t=>{
 let failure:Error=new PoliteFetchError('robots_blocked','Blocked'),requests=0;
 t.mock.method(PoliteFetcher.prototype,'fetch',async()=>{requests++;throw failure;});
 for(const error of [failure,new PoliteFetchError('tdm_reserved','Reserved'),new PoliteFetchError('http_error','HTTP 429',429),new Error('Council source cache digest mismatch')]){
  failure=error;const before=requests;await assert.rejects(loadCouncilJson(body.paper!),error);assert.equal(requests,before+1);
 }
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
 const result=councilBindingFailure(city,new CouncilBindingError(city,[wrong]),'oparl');
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
