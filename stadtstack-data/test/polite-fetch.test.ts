import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,realpath,mkdir,chmod,readdir} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {PoliteFetcher as BasePoliteFetcher,PoliteFetchError,parseRobots,robotsAllows,publicUrl,sourceContentBinding} from '../src/polite-fetch.ts';
import {isPublicAddress} from '../src/public-address.ts';
import type {FetchObservation,ExcludedDocument,PoliteFetcherOptions} from '../src/polite-fetch.ts';
import {metadataPdf,reservedXmp} from './fixtures/tdm-pdf.ts';
import {ownerRobotsOverrideFor,APPROVED_OWNER_ROBOTS_OVERRIDE} from '../src/source-policy.ts';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setImmediate as immediate} from 'node:timers/promises';
import {recordHostOptOut,withManagedSourceWrite} from '../src/civic-opt-out.ts';
import {hash} from '../src/common.ts';
import {politeTestOptions} from './fixtures/polite-lane.ts';
import {crawlOparlSource} from '../src/district-source-adapters.ts';
import {ContentFreeSourcePolicySchema} from '../src/district-schema.ts';
import {readBoundSourceObservation} from '../src/source-observation.ts';
import {fixturePolicyInspection} from './fixtures/polite-inspection.ts';
import {CrawlRequestEvidenceSchema,CrawlRequestEvidenceCaptureError} from '../src/district-crawl-request.ts';

async function createPoliteFetcher(options:PoliteFetcherOptions):Promise<BasePoliteFetcher> {
 return new BasePoliteFetcher({...await politeTestOptions(options),fixtureInspection:fixturePolicyInspection});
}
test('production and unpinned contexts reject injected parser inspection before execution',()=>{
 for(const ownerPolicyLane of [undefined,{decisionId:APPROVED_OWNER_ROBOTS_OVERRIDE.id,authorityId:'owner-2026-10-11-codex-workstation',authoritySha256:hash('not a fixture'),stateDir:'/home/max/.local/state/stadtstack-data/civic-policy'}]){
  assert.throws(()=>new BasePoliteFetcher({cacheDir:'/unused-before-inspection',ownerPolicyLane,fixtureInspection:fixturePolicyInspection}),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_state_unsafe');
 }
});

test('robots selects longest matching agent, combines groups and preserves allow ties',()=>{
 const policy=parseRobots('User-agent: *\nDisallow: /\nCrawl-delay: 100\n\nUser-agent: Stadtstack\nDisallow: /short\n\nUser-agent: StadtstackData\nUser-agent: AnotherBot\nDisallow: /private\nAllow: /private/public\nCrawl-delay: 2.5\n\nUser-agent: StadtstackData\nAllow: /same\nDisallow: /same\n');
 assert.equal(policy.delayMs,2500);assert.equal(robotsAllows(policy,'https://stadt.de/other'),true);assert.equal(robotsAllows(policy,'https://stadt.de/private/a'),false);assert.equal(robotsAllows(policy,'https://stadt.de/private/public/a'),true);assert.equal(robotsAllows(policy,'https://stadt.de/same'),true);
});
test('robots wildcard, end anchor, query and percent normalization',()=>{
 const policy=parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /search?secret=*\nDisallow: /~internal\nAllow: /~internal/ok\n');
 assert.equal(robotsAllows(policy,'https://stadt.de/a.pdf'),false);assert.equal(robotsAllows(policy,'https://stadt.de/a.pdf?public=1'),true);assert.equal(robotsAllows(policy,'https://stadt.de/search?secret=a'),false);assert.equal(robotsAllows(policy,'https://stadt.de/%7Einternal/a'),false);assert.equal(robotsAllows(policy,'https://stadt.de/%7Einternal/ok'),true);
});
test('Long alternating robots wildcards cannot monopolize the crawler',{timeout:1000},()=>{
 const policy=parseRobots('User-agent: *\nDisallow: /\nAllow: /'+'a*'.repeat(1000)+'b$');
 assert.equal(robotsAllows(policy,'https://stadt.de/'+'a'.repeat(4000)),false);
});
test('private, loopback, mapped IPv6, transition and special networks fail closed',()=>{
 for(const address of ['0.0.0.0','127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','198.18.0.1','192.0.2.1','198.51.100.1','203.0.113.1','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::1','2001::1'])assert.equal(isPublicAddress(address),false,address);
 for(const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888'])assert.equal(isPublicAddress(address),true,address);
 for(const url of ['http://127.1/a','http://2130706433/a','http://[::1]/','http://router.local/a','http://localhost/a','file:///etc/passwd','https://user:pass@stadt.de/','https://stadt.de:11434/','https://stadt.de/?token=private'])assert.throws(()=>publicUrl(url),PoliteFetchError);
 assert.equal(publicUrl('https://www.stadt.de/plan.pdf#page=2').href,'https://www.stadt.de/plan.pdf');
});
interface WireResult {status:number;headers:Record<string,string|undefined>;body:Buffer}
interface WireSeam {wire(url:URL,method:'GET'|'POST',body:string|undefined,validators:FetchObservation|undefined):Promise<WireResult>}
test('conditional 304 retains original byte hash and retrieval observation',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-cache-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const fetcher=await createPoliteFetcher({cacheDir:cache}),seen:{path:string;validators?:FetchObservation}[]=[];let documents=0;
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL,_method:string,_body:string|undefined,validators:FetchObservation|undefined)=>{
  seen.push({path:url.pathname,validators});if(url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  documents++;return documents===1?{status:200,headers:{'content-type':'application/pdf',etag:'"abc"','last-modified':'Wed, 01 Jul 2026 00:00:00 GMT'},body:metadataPdf()}:{status:304,headers:{},body:Buffer.alloc(0)};
 });
 const first=await fetcher.fetch('https://stadt.de/plan.pdf'),second=await fetcher.fetch('https://stadt.de/plan.pdf');
 assert.equal(second.sha256,first.sha256);assert.equal(second.retrievedAt,first.retrievedAt);assert.equal(second.status,304);assert.equal(seen.at(-1)?.validators?.etag,'"abc"');assert.equal(seen.filter(item=>item.path==='/robots.txt').length,1);
 const observation=JSON.parse(await readFile(second.observationPath,'utf8'));assert.equal(observation.state,'not_modified');assert.equal(observation.sha256,first.sha256);
 await writeFile(first.localPath,'changed');await assert.rejects(fetcher.fetch('https://stadt.de/plan.pdf'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='cache_missing');
});
test('request evidence records canonical dispatched URLs for roots, fragments and mixed-case hosts',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-canonical-evidence-'));t.after(()=>rm(cache,{recursive:true,force:true}));t.after(()=>rm(cache+'-request-evidence',{recursive:true,force:true}));
 const fetcher=await createPoliteFetcher({cacheDir:cache});
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL)=>{
  if(url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  if(url.pathname==='/start')return {status:302,headers:{location:'/final#not-dispatched'},body:Buffer.alloc(0)};
  return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from('Synthetic canonical source')};
 });
 for(const input of ['https://stadt.de','https://stadt.de/plan#section','https://STADT.DE/PLAN','HTTPS://STADT.DE/start#section']){
  const document=await fetcher.fetch(input),evidence=CrawlRequestEvidenceSchema.parse(JSON.parse(await readFile(join(cache+'-request-evidence','requests',basename(document.observationPath)),'utf8')));
  assert.equal(evidence.request.url,publicUrl(input).href);assert.equal(evidence.redirectChain[0],publicUrl(input).href);assert.equal(evidence.redirectChain.at(-1),document.url);
  assert.equal(document.status,200);assert.equal(evidence.httpObservation.receiptSha256,hash(await readFile(document.observationPath)));
  if(input.includes('/start'))assert.deepEqual(evidence.redirectChain,['https://stadt.de/start','https://stadt.de/final']);
 }
});
test('capture failure is an explicit content-free internal error and never rewrites successful source observations',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-capture-error-'));t.after(()=>rm(cache,{recursive:true,force:true}));t.after(()=>rm(cache+'-request-evidence',{recursive:true,force:true}));
 const body=Buffer.from('SYNTHETIC_SOURCE_CONTENT_NEVER_IN_CAPTURE_ERROR'),fetcher=await createPoliteFetcher({cacheDir:cache}),url='https://stadt.de/plan';
 await writeFile(cache+'-request-evidence','SYNTHETIC_PRIVATE_CAPTURE_FAILURE',{mode:0o600,flag:'wx'});
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(dispatched:URL)=>dispatched.pathname==='/robots.txt'||dispatched.pathname==='/.well-known/tdmrep.json'?{status:404,headers:{},body:Buffer.alloc(0)}:{status:200,headers:{'content-type':'text/plain'},body});
 await assert.rejects(fetcher.fetch(url),(error:unknown)=>{
  assert.ok(error instanceof CrawlRequestEvidenceCaptureError);assert.equal(error instanceof PoliteFetchError,false);assert.equal(error.message,'Managed request evidence capture failed');assert.equal(error.cause,undefined);assert.equal(Object.hasOwn(error,'failure'),false);assert.equal(JSON.stringify(error).includes('SYNTHETIC_PRIVATE'),false);return true;
 });
 assert.deepEqual(await readFile(join(cache,'sha256',hash(body))),body);
 const observations=await Promise.all((await readdir(join(cache,'observations'))).map(async name=>JSON.parse(await readFile(join(cache,'observations',name),'utf8')))),source=observations.filter(row=>row.url===url);
 assert.equal(source.length,1);assert.equal(source[0].state,'fetched');assert.equal(source[0].status,200);assert.equal(source[0].sha256,hash(body));assert.equal(source[0].failure,undefined);
 const requests=await Promise.all((await readdir(join(cache,'requests'))).map(async name=>JSON.parse(await readFile(join(cache,'requests',name),'utf8'))));assert.equal(requests.find(row=>row.url===url)?.state,'fetched');
});
test('robots denial and unavailable policy are distinct from missing source',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-robots-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const blocked=await createPoliteFetcher({cacheDir:join(cache,'blocked')});let calls=0;
 t.mock.method(blocked as unknown as WireSeam,'wire',async()=>{calls++;return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from('User-agent: StadtstackData\nDisallow: /private')};});
 await assert.rejects(blocked.fetch('https://stadt.de/private'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='robots_blocked');assert.equal(calls,1);
 const unavailable=await createPoliteFetcher({cacheDir:join(cache,'unavailable')});t.mock.method(unavailable as unknown as WireSeam,'wire',async()=>({status:503,headers:{},body:Buffer.alloc(0)}));
 await assert.rejects(unavailable.fetch('https://stadt.de/'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='robots_unavailable');
});
test('cross-host document redirects fail before destination transport or raw/derived retention',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-redirect-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const fetcher=await createPoliteFetcher({cacheDir:cache}),seen:string[]=[],destination=Buffer.from('destination source body');
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL)=>{
  seen.push(url.href);if(url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  return url.hostname==='stadt.de'?{status:302,headers:{location:'https://docs.stadt.de/plan.pdf'},body:Buffer.alloc(0)}:{status:200,headers:{'content-type':'text/plain'},body:destination};
 });
 await assert.rejects(fetcher.fetch('https://stadt.de/start'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='cross_host_redirect');
 assert.deepEqual(seen,['https://stadt.de/robots.txt','https://stadt.de/.well-known/tdmrep.json','https://stadt.de/start']);
 await assert.rejects(readFile(join(cache,'sha256',hash(destination))),{code:'ENOENT'});
 await assert.rejects(readdir(join(cache,'frontiers')),{code:'ENOENT'});
 const observations=await Promise.all((await readdir(join(cache,'observations'))).map(async name=>JSON.parse(await readFile(join(cache,'observations',name),'utf8'))));
 assert.ok(observations.some(item=>item.url==='https://stadt.de/start'&&item.state==='failed'&&item.failure==='cross_host_redirect'&&item.location==='https://docs.stadt.de/plan.pdf'));
});
test('same-host scheme and path redirects retain normal admission and private redirects remain unsafe',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-same-host-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const fetcher=await createPoliteFetcher({cacheDir:cache});
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL)=>{
  if(url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  if(url.protocol==='http:')return {status:301,headers:{location:'https://stadt.de/final'},body:Buffer.alloc(0)};
  if(url.pathname==='/private')return {status:302,headers:{location:'http://127.0.0.1/private'},body:Buffer.alloc(0)};
  return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from('public source')};
 });
 assert.equal((await fetcher.fetch('http://stadt.de/start')).url,'https://stadt.de/final');
 await assert.rejects(fetcher.fetch('https://stadt.de/private'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='unsafe_url');
});
test('host scheduler serializes concurrent work and respects minimum spacing',async t=>{
 const cache=await realpath(await mkdtemp(join(tmpdir(),'polite-schedule-')));t.after(()=>rm(cache,{recursive:true,force:true}));
 t.mock.timers.enable({apis:['Date','setTimeout'],now:10000});
 const fetcher=await createPoliteFetcher({cacheDir:cache,minDelayMs:20}),scheduler=fetcher as unknown as LaneSeam;
 t.mock.method(scheduler,'hostStateDirectory',()=>join(cache,'lanes'));
 const starts:number[]=[];let active=0,maxActive=0;
 const work=async()=>{starts.push(Date.now());active++;maxActive=Math.max(maxActive,active);await Promise.resolve();active--;};
 let complete=false;const pending=Promise.all([scheduler.scheduled(new URL('https://stadt.de/a'),work),scheduler.scheduled(new URL('http://stadt.de/b'),work),scheduler.scheduled(new URL('https://stadt.de/c'),work)]).finally(()=>{complete=true;});
 // Real filesystem I/O interleaves with the mocked clock; bound by wall time, not by a turn count,
 // so a loaded host cannot strand the remaining mocked timers and hang the runner.
 const deadline=performance.now()+60_000;
 while(!complete){assert.ok(performance.now()<deadline,'scheduler did not finish within 60 s of real time');await immediate();t.mock.timers.tick(25);}
 await pending;
 assert.equal(maxActive,1);assert.ok(starts[1]-starts[0]>=2000);assert.ok(starts[2]-starts[1]>=2000);
});
test('origin TDM reservation prevents document fetch and carries ask-municipality evidence',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-tdm-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const fetcher=await createPoliteFetcher({cacheDir:cache}),seen:string[]=[];
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL)=>{
  seen.push(url.pathname);if(url.pathname==='/robots.txt')return {status:404,headers:{},body:Buffer.alloc(0)};
  if(url.pathname==='/.well-known/tdmrep.json')return {status:200,headers:{'content-type':'application/json'},body:Buffer.from('[{"location":"/","tdm-reservation":1}]')};
  throw Error('Reserved document must not be requested');
 });
 await assert.rejects(fetcher.fetch('https://stadt.de/plan.pdf'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='tdm_reserved'&&error.policy?.tdm.state==='reserved'&&error.policy.tdm.evidence.some(item=>item.value==='1'));
 assert.deepEqual(seen,['/robots.txt','/.well-known/tdmrep.json']);
});
test('standardized TDMRep redirects admit only same-origin absence or valid policies',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-tdm-redirect-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 for(const mode of ['absent','gone','cross-host','html','reserved','loop','limit','server-error','explicit'] as const){
  const fetcher=await createPoliteFetcher({cacheDir:join(cache,mode)}),seen:string[]=[];
  const html=Buffer.from('<html>Not a policy</html>');
  t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL)=>{
   seen.push(url.href);
   if(url.pathname==='/robots.txt')return {status:404,headers:{},body:Buffer.alloc(0)};
   if(url.pathname==='/.well-known/tdmrep.json')return mode==='explicit'?{status:404,headers:{},body:Buffer.alloc(0)}:{status:302,headers:{location:mode==='cross-host'?'https://other.de/policy':'/policy'},body:Buffer.alloc(0)};
   if(url.pathname==='/policy'||url.pathname.startsWith('/hop')){
    if(mode==='loop'||mode==='explicit')return {status:302,headers:{location:'/policy'},body:Buffer.alloc(0)};
    if(mode==='limit')return {status:302,headers:{location:`/hop${seen.length}`},body:Buffer.alloc(0)};
    if(mode==='html')return {status:200,headers:{'content-type':'text/html'},body:html};
    if(mode==='reserved')return {status:200,headers:{'content-type':'application/json'},body:Buffer.from('[{"location":"/plan","tdm-reservation":1}]')};
    return {status:mode==='server-error'?503:mode==='gone'?410:404,headers:{},body:Buffer.alloc(0)};
   }
   return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from('Public planning source')};
  });
  if(mode==='absent'||mode==='gone'){
   const document=await fetcher.fetch('https://stadt.de/plan');
   assert.equal(document.policy?.tdm.state,'not_declared');
   assert.ok(document.policy?.tdm.evidence.some(item=>item.locator==='TDMRep standardized location HTTP absence after same-host redirect'&&item.url==='https://stadt.de/policy'&&item.value===(mode==='gone'?'410':'404')));
  }else{
   const failure=mode==='reserved'?'tdm_reserved':mode==='cross-host'?'cross_host_redirect':mode==='loop'||mode==='limit'?'redirect_limit':mode==='explicit'?'invalid_redirect':'tdm_unavailable';
   await assert.rejects(fetcher.fetch('https://stadt.de/plan',mode==='explicit'?{machinePolicyUrls:['https://stadt.de/policy']}:{}),(error:unknown)=>error instanceof PoliteFetchError&&error.failure===failure);
   assert.ok(!seen.includes('https://stadt.de/plan'));
  }
  assert.ok(!seen.some(url=>url.startsWith('https://other.de/')));
  assert.ok(seen.filter(url=>!url.endsWith('/robots.txt')).length<=6);
  await assert.rejects(readFile(join(fetcher.cacheDir,'sha256',hash(html))),{code:'ENOENT'});
  const observations=await Promise.all((await readdir(join(fetcher.cacheDir,'observations'))).map(async name=>JSON.parse(await readFile(join(fetcher.cacheDir,'observations',name),'utf8')) as FetchObservation));
  assert.ok(observations.some(item=>item.status===302&&item.location));
  if(mode==='absent'||mode==='gone')assert.ok(observations.some(item=>item.url==='https://stadt.de/policy'&&item.status===(mode==='gone'?410:404)));
 }
});
test('Absent policy cache never satisfies a required endpoint and non-policy 200 fails before retention',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-policy-mode-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 for(const status of [404,410,200]){
  const fetcher=await createPoliteFetcher({cacheDir:join(cache,String(status))});let policies=0,documents=0;
  const seam=fetcher as unknown as WireSeam;
  t.mock.method(seam,'wire',async(url:URL)=>{
   if(url.pathname==='/robots.txt')return {status:404,headers:{},body:Buffer.alloc(0)};
   if(url.pathname==='/.well-known/tdmrep.json'){policies++;return {status,headers:{'content-type':'text/html'},body:Buffer.from('<h1>No policy representation</h1>')};}
   documents++;return {status:200,headers:{'content-type':'text/html'},body:Buffer.from('<h1>Public planning information</h1>')};
  });
  if(status===200){
   await assert.rejects(fetcher.fetch('https://stadt.de/plan'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='tdm_unavailable');
   await assert.rejects(fetcher.fetch('https://stadt.de/plan',{machinePolicyUrls:['https://stadt.de/.well-known/tdmrep.json']}),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='tdm_unavailable');
   assert.equal(policies,1);assert.equal(documents,0);
   await assert.rejects(readFile(join(fetcher.cacheDir,'sha256',hash('<h1>No policy representation</h1>'))),{code:'ENOENT'});
  }else{
   await fetcher.fetch('https://stadt.de/plan');
   await assert.rejects(fetcher.fetch('https://stadt.de/plan',{machinePolicyUrls:['https://stadt.de/.well-known/tdmrep.json']}),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='tdm_unavailable');
   assert.equal(policies,2);assert.equal(documents,1);
  }
 }
});
test('HTML reservation and CAPTCHA are withheld from document cache results',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-barrier-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 for(const [html,failure] of [['<meta name="tdm-reservation" content="1"><h1>Plan</h1>','tdm_reserved'],['<title>Just a moment</title><form id="challenge-form"></form>','access_barrier']] as const){
  const fetcher=await createPoliteFetcher({cacheDir:join(cache,failure)});
  t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL)=>url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json'?{status:404,headers:{},body:Buffer.alloc(0)}:{status:200,headers:{'content-type':'text/html'},body:Buffer.from(html)});
  await assert.rejects(fetcher.fetch('https://stadt.de/plan'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure===failure);
 }
});
test('robots 200 HTML or CAPTCHA never becomes an empty allow-all policy',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-robots-html-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 for(const [index,body] of ['<html><title>Server error</title><body>Try later</body></html>','<html><title>Just a moment</title><form id="challenge-form"></form></html>','<div>Authentication required</div>'].entries()){
  const fetcher=await createPoliteFetcher({cacheDir:join(cache,String(index))}),seen:string[]=[];
  t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL)=>{seen.push(url.pathname);return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from(body)};});
  await assert.rejects(fetcher.fetch('https://stadt.de/plan.pdf'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure===(index===1?'access_barrier':'robots_unavailable'));
  assert.deepEqual(seen,['/robots.txt']);
 }
});
test('compressed PDF TDM is enforced and parser failures are unavailable rather than unreserved',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-pdf-metadata-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 for(const [label,bytes,expected] of [['reserved',metadataPdf(reservedXmp),'tdm_reserved'],['invalid',Buffer.from('%PDF-invalid'),'tdm_unavailable']] as const){
  const fetcher=await createPoliteFetcher({cacheDir:join(cache,label)});
  t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL)=>url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json'?{status:404,headers:{},body:Buffer.alloc(0)}:{status:200,headers:{'content-type':'application/pdf'},body:bytes});
  await assert.rejects(fetcher.fetch('https://stadt.de/plan.pdf'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure===expected);
 }
});
test('HTTP reservation remains a veto even when PDF metadata would be zero or unreadable',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-header-veto-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const fetcher=await createPoliteFetcher({cacheDir:cache});
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL)=>url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json'?{status:404,headers:{},body:Buffer.alloc(0)}:{status:200,headers:{'content-type':'application/pdf','tdm-reservation':'1'},body:Buffer.from('%PDF-invalid')});
 await assert.rejects(fetcher.fetch('https://stadt.de/plan.pdf'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='tdm_reserved'&&error.policy?.tdm.state==='reserved');
});
test('long-lived fetchers revalidate expired robots and machine policies before reusing permission',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-policy-ttl-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-10T12:00:00.000Z')});
 for(const kind of ['robots','tdm'] as const){
  const fetcher=await createPoliteFetcher({cacheDir:join(cache,kind),policyTtlMs:60*60_000}),seen:string[]=[];let changed=false;
  t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL)=>{
   seen.push(url.pathname);
   if(url.pathname==='/robots.txt')return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from(changed&&kind==='robots'?'User-agent: StadtstackData\nDisallow: /':'User-agent: *\nAllow: /')};
   if(url.pathname==='/.well-known/tdmrep.json')return changed&&kind==='tdm'?{status:200,headers:{'content-type':'application/json'},body:Buffer.from('[{"location":"/","tdm-reservation":1}]')}:{status:404,headers:{},body:Buffer.alloc(0)};
   return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from('Public source')};
  });
  await fetcher.fetch('https://stadt.de/data.txt');changed=true;t.mock.timers.tick(2*60*60_000);
  await assert.rejects(fetcher.fetch('https://stadt.de/data.txt'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure===(kind==='robots'?'robots_blocked':'tdm_reserved'));
  assert.equal(seen.filter(path=>path==='/data.txt').length,1);assert.equal(seen.filter(path=>path==='/robots.txt').length,2);
 }
});

interface LaneState {schemaVersion:1;host:string;lastStart:number;delayMs:number;nextAllowedAt:number;failures:number[];stop:null|{status:number;reason:string;checkedAt:string;until:number}}
interface LaneSeam {
 hostStateDirectory():string;
 scheduled<T>(url:URL,work:()=>Promise<T>,onResult?:(result:T,state:LaneState)=>void):Promise<T>;
 recordHostResponse(url:URL,response:WireResult,state:LaneState):void;
}
test('municipal lane serializes instances, policy requests and restart state without credits',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'polite-shared-')));t.after(()=>rm(root,{recursive:true,force:true}));
 t.mock.timers.enable({apis:['Date','setTimeout'],now:10000});
 const starts:number[]=[];let active=0,maxActive=0;
 const lanes=await Promise.all([0,1,2].map(async index=>{
  const lane=await createPoliteFetcher({cacheDir:join(root,String(index)),minDelayMs:index===0?5000:2000}) as unknown as LaneSeam;
  t.mock.method(lane,'hostStateDirectory',()=>join(root,'lanes'));return lane;
 }));
 const work=async()=>{starts.push(Date.now());active++;maxActive=Math.max(active,maxActive);await immediate();active--;};
 let complete=false;
 const run=Promise.all(lanes.map((lane,index)=>lane.scheduled(new URL(['https://stadt.de/robots.txt','https://stadt.de/.well-known/tdmrep.json','http://stadt.de/document'][index]),work))).finally(()=>{complete=true;});
 let deadline=performance.now()+60_000;
 while(!complete){assert.ok(performance.now()<deadline,'lanes did not finish within 60 s of real time');await immediate();t.mock.timers.tick(25);}
 await run;assert.equal(maxActive,1);assert.equal(starts.length,3);
 assert.ok(starts[1]-starts[0]>=5000);assert.ok(starts[2]-starts[1]>=5000);
 const state=JSON.parse(await readFile(join(root,'lanes','stadt.de.json'),'utf8'));
 assert.equal(state.lastStart,starts[2]);assert.equal(state.delayMs,5000);
 // A fresh instance reads the committed timestamp even after the in-memory queue drains.
 const restart=await createPoliteFetcher({cacheDir:join(root,'restart')}) as unknown as LaneSeam;t.mock.method(restart,'hostStateDirectory',()=>join(root,'lanes'));
 complete=false;const resumed=restart.scheduled(new URL('https://stadt.de/restarted'),work).finally(()=>{complete=true;});
 deadline=performance.now()+60_000;
 while(!complete){assert.ok(performance.now()<deadline,'restarted lane did not finish within 60 s of real time');await immediate();t.mock.timers.tick(25);}
 await resumed;assert.ok(starts[3]-starts[2]>=5000);
});
test('shared lane refuses a live other-process lock without stealing it',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'polite-process-lock-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const lanes=join(root,'lanes');await mkdir(lanes,{mode:0o700});
 const moduleUrl=new URL('../src/district-private-io.ts',import.meta.url).href;
 const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',`import {acquirePrivateRunLock} from ${JSON.stringify(moduleUrl)};const release=await acquirePrivateRunLock(${JSON.stringify(join(lanes,'stadt.de.lock'))},'test lane');process.stdout.write('locked\\n');process.stdin.once('data',async()=>{await release();process.exit(0);});`],{stdio:['pipe','pipe','pipe']});
 t.after(()=>{child.kill();});
 const ready=once(child.stdout,'data'),failure=once(child,'exit').then(()=>{throw Error('Lock child exited before signaling');});
 await Promise.race([ready,failure]);
 const lock=await readFile(join(lanes,'stadt.de.lock'),'utf8'),fetcher=await createPoliteFetcher({cacheDir:root}) as unknown as LaneSeam;
 t.mock.method(fetcher,'hostStateDirectory',()=>lanes);
 await assert.rejects(fetcher.scheduled(new URL('https://stadt.de/document'),async()=>{throw Error('Busy host must not dispatch');}),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_busy');
 assert.equal(await readFile(join(lanes,'stadt.de.lock'),'utf8'),lock);
 const exited=once(child,'exit');child.stdin.write('release');await exited;
});
test('403/429 and three rolling 5xx persist cooldowns across restart with no retry',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'polite-circuit-')));t.after(()=>rm(root,{recursive:true,force:true}));
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-11T12:00:00.000Z')});
 for(const status of [403,429,503]){
  const directory=join(root,String(status)),url=new URL('https://stadt.de/document');
  const lane=await createPoliteFetcher({cacheDir:root}) as unknown as LaneSeam;t.mock.method(lane,'hostStateDirectory',()=>directory);
  let requests=0;
  const work=async()=>{requests++;return {status,headers:status===503?{}:{'retry-after':'7200'},body:Buffer.alloc(0)};};
  const record=(response:WireResult,state:LaneState)=>lane.recordHostResponse(url,response,state);
  await lane.scheduled(url,work,record);
  if(status===503){
   for(const delay of [5000,10000]){
    await assert.rejects(lane.scheduled(url,work,record),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_cooldown');
    t.mock.timers.tick(delay);await lane.scheduled(url,work,record);
   }
  }
  const restart=await createPoliteFetcher({cacheDir:join(root,'restart')}) as unknown as LaneSeam;t.mock.method(restart,'hostStateDirectory',()=>directory);
  await assert.rejects(restart.scheduled(url,work),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_cooldown'&&!!error.retryAfter);
  assert.equal(requests,status===503?3:1);
  const state=JSON.parse(await readFile(join(directory,'stadt.de.json'),'utf8'));assert.ok(state.stop.until-Date.now()>=(status===503?3600000:7200000));
 }
});
test('unsafe shared state fails closed before work',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'polite-unsafe-lane-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const lane=await createPoliteFetcher({cacheDir:root}) as unknown as LaneSeam;t.mock.method(lane,'hostStateDirectory',()=>root);
 const path=join(root,'stadt.de.json');await writeFile(path,'{}',{mode:0o600});
 await assert.rejects(lane.scheduled(new URL('https://stadt.de/'),async()=>{throw Error('Must not start');}),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_state_unsafe');
 await chmod(root,0o755);
 await assert.rejects(lane.scheduled(new URL('https://stadt.de/'),async()=>{throw Error('Must not start');}),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_state_unsafe');
});
test('global registered exception preserves real robots/TDM states and independently audits redirects',async t=>{
 const root=await mkdtemp(join(tmpdir(),'polite-owner-policy-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const url='https://strausberg.allris.cloud/document',decision=ownerRobotsOverrideFor(url)!;
 const official='<html><title>Beschlussvorlage</title><main><p>Herausgeber: Stadt Beispielstadt</p><p>Informationen zur Entwicklung des Quartiers und zur weiteren Beratung in der kommenden Sitzung.</p></main></html>';
 for(const mode of ['public','missing','forged','unavailable','allowed','tdm','pdf','third_party','captcha','paywall','forbidden','redirect','private'] as const){
  const fetcher=await createPoliteFetcher({cacheDir:join(root,mode)}),seen:string[]=[];
  t.mock.method(fetcher as unknown as WireSeam,'wire',async(target:URL)=>{
   seen.push(target.href);
   if(target.pathname==='/robots.txt')return mode==='unavailable'?{status:503,headers:{},body:Buffer.alloc(0)}:{status:200,headers:{'content-type':'text/plain'},body:Buffer.from(mode==='allowed'?'User-agent: *\nAllow: /':'User-agent: *\nDisallow: /')};
   if(target.pathname==='/.well-known/tdmrep.json')return mode==='tdm'?{status:200,headers:{'content-type':'application/json'},body:Buffer.from('[{"location":"/","tdm-reservation":1}]')}:{status:404,headers:{},body:Buffer.alloc(0)};
   if((mode==='redirect'||mode==='private')&&target.hostname==='strausberg.allris.cloud')return {status:302,headers:{location:mode==='private'?'http://127.0.0.1/private':'https://different.stadt.de/document'},body:Buffer.alloc(0)};
   if(mode==='forbidden'||mode==='paywall')return {status:mode==='forbidden'?403:402,headers:{},body:Buffer.alloc(0)};
   if(mode==='pdf')return {status:200,headers:{'content-type':'application/pdf'},body:metadataPdf(reservedXmp)};
   return {status:200,headers:{'content-type':'text/html'},body:Buffer.from(mode==='captcha'?'<title>Just a moment</title><form id="challenge-form"></form>':mode==='third_party'?'<h1>Externer Bericht</h1><p>Ein nicht zugeordneter Text über die Entwicklung des Quartiers und weitere Einzelheiten.</p>':official)};
  });
  const options=mode==='missing'?{}:{ownerRobotsOverride:mode==='forged'?{...decision,id:'forged'} as unknown as typeof decision:decision};
  if(['public','allowed','unavailable','tdm'].includes(mode)){
   const document=await fetcher.fetch(url,options),observation=JSON.parse(await readFile(document.observationPath,'utf8'));
   assert.equal(document.policy?.robots.state,mode==='allowed'?'allowed':mode==='unavailable'?'unavailable':'blocked');
   assert.equal(document.policy?.override,mode==='allowed'?undefined:'owner-approved 2026-10-11');assert.equal(document.policy?.documentOrigin?.classification,'official_work');
   assert.deepEqual(observation.policy,document.policy);
   if(mode==='public'){assert.equal(document.policy?.robotsStatus,'disallowed');assert.deepEqual(document.policy?.ownerRobotsOverride,decision);assert.match(document.policy!.robots.sha256!,/^[a-f0-9]{64}$/);assert.ok(document.policy?.robots.checkedAt);}
   if(mode==='unavailable'){assert.equal(document.policy?.robotsStatus,'unavailable');assert.equal(document.policy?.robots.sha256,undefined);assert.ok(document.policy?.robots.checkedAt);}
   if(mode==='tdm'){assert.equal(document.policy?.tdm.state,'reserved');assert.equal(document.policy?.tdmOverride,'owner-approved 2026-10-11');assert.deepEqual(document.policy?.ownerTdmOverride,decision);}
  }else{
   const failure=mode==='pdf'||mode==='third_party'?'document_excluded':mode==='captcha'||mode==='forbidden'||mode==='paywall'?'access_barrier':mode==='private'?'unsafe_url':mode==='redirect'?'cross_host_redirect':'robots_blocked';
   await assert.rejects(fetcher.fetch(url,options),(error:unknown)=>error instanceof PoliteFetchError&&error.failure===failure,mode);
   if(mode==='redirect')assert.ok(!seen.some(value=>new URL(value).hostname==='different.stadt.de'));
  }
 }
});

test('excluded new raw stays absent and a later 304 cannot revive its request pointer',async t=>{
 const root=await mkdtemp(join(tmpdir(),'polite-excluded-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const url='https://stadt.de/external',body=Buffer.from('<h1>Gutachten</h1><p>Verfasser: Ingenieurbüro Beispiel GmbH</p><p>Externe Untersuchung zur Verkehrsentwicklung im gesamten Stadtgebiet.</p>');
 const fetcher=await createPoliteFetcher({cacheDir:root});let response304=false,seenValidators:FetchObservation|undefined;
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(target:URL,_method:'GET'|'POST',_body:string|undefined,validators:FetchObservation|undefined)=>{
  if(target.pathname==='/robots.txt')return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from('User-agent: *\nDisallow: /')};
  if(target.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  seenValidators=validators;return response304?{status:304,headers:{},body:Buffer.alloc(0)}:{status:200,headers:{'content-type':'text/html',etag:'"excluded"'},body};
 });
 const options={ownerRobotsOverride:ownerRobotsOverrideFor(url)!};let excluded:ExcludedDocument|undefined;
 try{await fetcher.fetch(url,options);assert.fail('Restricted third-party work must be excluded');}catch(error){assert.ok(error instanceof PoliteFetchError);assert.equal(error.failure,'document_excluded');excluded=error.excludedDocument!;}
 assert.ok(excluded);
 assert.equal(excluded.policy.documentOrigin?.classification,'third_party');assert.equal(excluded.sha256,hash(body));assert.equal(excluded.sizeBytes,body.length);assert.equal('localPath' in excluded,false);
 await assert.rejects(readFile(join(root,'sha256',excluded.sha256)),{code:'ENOENT'});
 const observation=JSON.parse(await readFile(excluded.observationPath,'utf8'));assert.equal(observation.state,'excluded');assert.equal(observation.policy.robots.state,'blocked');assert.equal(observation.etag,undefined);
 response304=true;
 await assert.rejects(fetcher.fetch(url,options),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='cache_missing');
 assert.equal(seenValidators,undefined);
});
test('opt-out is checked before policy/cache reads and before paced dispatch',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'polite-optout-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const options=await politeTestOptions({cacheDir:join(root,'raw')}),fetcher=new BasePoliteFetcher(options);
 const seam=fetcher as unknown as LaneSeam;
 t.mock.method(seam,'hostStateDirectory',()=>join(root,'lanes'));
 await recordHostOptOut({host:'stadt.de',reason:'rights_holder_objection'},options.ownerPolicyLane!);
 let calls=0;t.mock.method(fetcher as unknown as WireSeam,'wire',async()=>{calls++;throw Error('Must not request opted-out host');});
 await assert.rejects(fetcher.fetch('https://stadt.de/document'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_opted_out');
 await assert.rejects(seam.scheduled(new URL('https://stadt.de/robots.txt'),async()=>{calls++;}),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_opted_out');
 assert.equal(calls,0);
});

test('owner robots permission never bypasses policy login/private redirects or credential forms',async t=>{
 const root=await mkdtemp(join(tmpdir(),'polite-policy-redirect-gates-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target='https://stadt.de/document',decision=ownerRobotsOverrideFor(target)!;
 for(const [name,location,failure] of [['login','https://stadt.de/login','access_barrier'],['private','http://127.0.0.1/private','unsafe_url']] as const){
  const fetcher=await createPoliteFetcher({cacheDir:join(root,name)});let calls=0;
  t.mock.method(fetcher as unknown as WireSeam,'wire',async()=>{calls++;return {status:302,headers:{location},body:Buffer.alloc(0)};});
  await assert.rejects(fetcher.fetch(target,{ownerRobotsOverride:decision}),(error:unknown)=>error instanceof PoliteFetchError&&error.failure===failure);assert.equal(calls,1);
 }
 const fetcher=await createPoliteFetcher({cacheDir:join(root,'credentials')});let calls=0;
 t.mock.method(fetcher as unknown as WireSeam,'wire',async()=>{calls++;throw Error('Credentials must never reach wire');});
 await assert.rejects(fetcher.fetch(target,{method:'POST',body:'password=fixture-only',ownerRobotsOverride:decision}),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='unsafe_url');
 await assert.rejects(fetcher.fetch('https://stadt.de/login',{ownerRobotsOverride:decision}),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='access_barrier');
 assert.equal(calls,0);
});

test('lane context and empty-root marker are required even when wire is mocked',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'polite-lane-boundary-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const absent=new BasePoliteFetcher({cacheDir:join(root,'without-context')});
 await assert.rejects(absent.fetch('https://stadt.de/'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_state_unsafe');
 await assert.rejects(readFile(join(root,'without-context','.civic-acquisition-lane.json')),{code:'ENOENT'});
 const legacy=join(root,'owner-policy-2026-10-11');await mkdir(legacy);await writeFile(join(legacy,'frozen.json'),'historical bytes');
 const options=await politeTestOptions({cacheDir:legacy}),fetcher=new BasePoliteFetcher(options);let calls=0;
 const inventoryPath=join(options.ownerPolicyLane!.stateDir!,'inventory.json'),inventoryBefore=await readFile(inventoryPath);
 t.mock.method(fetcher as unknown as WireSeam,'wire',async()=>{calls++;throw Error('Unmarked nonempty root must fail before wire');});
 await assert.rejects(fetcher.fetch('https://stadt.de/'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_state_unsafe');
 assert.equal(calls,0);assert.deepEqual(await readdir(legacy),['frozen.json']);assert.equal(await readFile(join(legacy,'frozen.json'),'utf8'),'historical bytes');
 assert.deepEqual(await readFile(inventoryPath),inventoryBefore,'Rejecting an unmarked legacy root must not alter the explicitly provisioned fixture inventory');
});

test('real lane lifecycle enrolls raw and parsed copies and opt-out prevents cache revival',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'polite-managed-derived-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const options=await politeTestOptions({cacheDir:root}),fetcher=new BasePoliteFetcher({...options,fixtureInspection:fixturePolicyInspection}),url='https://stadt.de/public';let calls=0;
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(target:URL)=>{
  calls++;if(target.pathname==='/robots.txt'||target.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  return {status:200,headers:{'content-type':'text/plain',etag:'"fixture"'},body:Buffer.from('Public municipal information with a bounded synthetic source representation.')};
 });
 const document=await fetcher.fetch(url),binding=sourceContentBinding(document),derived=join(root,'oparl-bodies',hash('derived-fixture')+'.json');
 await fetcher.persistDerivedJson(derived,{bodies:[],sourceBindings:[binding]},[binding]);
 assert.ok((await readFile(derived)).length>0);assert.ok((await readFile(join(root,'.civic-acquisition-lane.json'))).length>0);
 const receipt=await recordHostOptOut({host:'stadt.de',reason:'municipality_objection'},options.ownerPolicyLane!);
 assert.equal(receipt.purge.status,'purged');assert.ok(receipt.purge.deletedFiles>=2);
 await assert.rejects(readFile(document.localPath),{code:'ENOENT'});await assert.rejects(readFile(derived),{code:'ENOENT'});
 const before=calls;await assert.rejects(fetcher.fetch(url),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_opted_out');assert.equal(calls,before);
});

test('original observation reader and derived gates accept genuine shared-byte receipts, never relocation or exclusions',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'polite-original-observation-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const options=await politeTestOptions({cacheDir:root}),fetcher=new BasePoliteFetcher({...options,fixtureInspection:fixturePolicyInspection}),body=Buffer.from('Synthetic public municipal representation with sufficient source text.');
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(target:URL)=>target.pathname==='/robots.txt'||target.pathname==='/.well-known/tdmrep.json'?{status:404,headers:{},body:Buffer.alloc(0)}:{status:200,headers:{'content-type':'text/plain'},body});
 const first=await fetcher.fetch('https://stadt.de/first'),second=await fetcher.fetch('https://stadt.de/second');
 assert.equal(first.sha256,second.sha256);assert.notEqual(first.observationPath,second.observationPath);
 for(const document of [first,second]){
  const result=await readBoundSourceObservation({rawRoot:root,document,policy:options.ownerPolicyLane});
  assert.deepEqual(result.sourceBytes,body);assert.equal(result.binding.url,document.url);assert.equal(result.binding.kind,'http_observation');
  await fetcher.assertSourceBindingsAllowed([sourceContentBinding(document)]);
 }
 for(const change of [{observationPath:join(root,'other','observations','copied.json')},{status:304},{mimeType:'application/pdf'},{checkedAt:undefined},{exclusion:{reason:'non_official_restricted'}}])await assert.rejects(readBoundSourceObservation({rawRoot:root,document:{...first,...change},policy:options.ownerPolicyLane}));
 const derived=join(root,'frontiers',hash('shared-source-fixture')+'.json');
 await fetcher.persistDerivedJson(derived,{documents:[],sourceBindings:[sourceContentBinding(first)]},[sourceContentBinding(first)]);
 await fetcher.assertSourceReadable(derived);
 await recordHostOptOut({host:'stadt.de',reason:'municipality_objection'},options.ownerPolicyLane!);
 await assert.rejects(readBoundSourceObservation({rawRoot:root,document:first,policy:options.ownerPolicyLane}));
});

test('an active inventory entry cannot turn an ineffective stored policy into derived permission',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'polite-derived-policy-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const options=await politeTestOptions({cacheDir:root}),fetcher=new BasePoliteFetcher({...options,fixtureInspection:fixturePolicyInspection}),body=Buffer.from('Synthetic public municipal source body for a deliberately invalid historical-policy receipt.');
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(target:URL)=>target.pathname==='/robots.txt'||target.pathname==='/.well-known/tdmrep.json'?{status:404,headers:{},body:Buffer.alloc(0)}:{status:200,headers:{'content-type':'text/plain'},body});
 const document=await fetcher.fetch('https://stadt.de/document'),original=JSON.parse(await readFile(document.observationPath,'utf8')) as FetchObservation;
 const observation={...original,policy:{...original.policy!,tdm:{...original.policy!.tdm,state:'unavailable' as const}}},bytes=JSON.stringify(observation)+'\n',name='unavailable-policy.json',observationPath=join(root,'observations',name);
 await writeFile(observationPath,bytes,{mode:0o600});
 // Isolated adversarial fixture: inventory flags alone must not bless this policy.
 await withManagedSourceWrite(root,[{kind:'http_observation',url:document.url,sourceSha256:document.sha256,observationId:name,receiptSha256:hash(bytes),relativePath:'sha256/'+document.sha256,contentSha256:document.sha256,independentAllowed:true}],async()=>{await writeFile(document.localPath,body,{mode:0o600});},options.ownerPolicyLane!);
 const binding={...sourceContentBinding(document),observationPath,independentAllowed:true},out=join(root,'oparl-bodies',hash('must-not-write')+'.json');
 await assert.rejects(fetcher.assertSourceBindingsAllowed([binding]),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='document_excluded');
 await assert.rejects(fetcher.persistDerivedJson(out,{body:'must not persist'},[binding]),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='document_excluded');
 await assert.rejects(readFile(out),{code:'ENOENT'});
});

test('wildcard denial without explicit owner approval still stops HTML and OParl content',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-council-denial-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const knownCalendar='https://strausberg.allris.cloud/public/si010';
 const policyText='User-agent: *\nDisallow: /\n';
 assert.equal(robotsAllows(parseRobots(policyText),knownCalendar),false);
 for(const mode of ['known-calendar','synthetic-oparl'] as const){
  const fetcher=await createPoliteFetcher({cacheDir:join(cache,mode)}),seen:string[]=[];
  t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL)=>{
   seen.push(url.href);assert.equal(url.pathname,'/robots.txt','Neither target content nor TDM may be requested after robots denial');
   return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from(policyText)};
  });
  // The OParl URL is synthetic test-only data, not a discovered Strausberg endpoint.
  const source={id:'synthetic-council',kind:'council' as const,url:'https://oparl.example.org/system',vendor:'oparl',checkState:'checked' as const,checkedAt:'2026-10-11T00:00:00.000Z',evidence:[{url:'https://oparl.example.org/system',locator:'Synthetic fixture only'}]};
  const operation=mode==='known-calendar'?fetcher.fetch(knownCalendar):crawlOparlSource(fetcher,{id:'synthetic-town',name:'Synthetic town',ags:'12064472',districtId:'maerkisch-oderland',sources:[source]},source,{maxDocuments:1,maxPages:1,maxRequests:3});
  await assert.rejects(operation,(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='robots_blocked');
  assert.deepEqual(seen,[mode==='known-calendar'?'https://strausberg.allris.cloud/robots.txt':'https://oparl.example.org/robots.txt']);
 }
});

test('policy-resource exemptions reject unauthorized redirects and non-policy bodies before CAS',async t=>{
 const root=await mkdtemp(join(tmpdir(),'polite-policy-resource-binding-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target='https://stadt.de/document',ownerRobotsOverride=ownerRobotsOverrideFor(target)!;
 const official=Buffer.from('<html><title>Beschlussvorlage</title><main><p>Herausgeber: Stadt Beispielstadt</p><p>Informationen zur Entwicklung des Quartiers und zur weiteren Beratung in der kommenden Sitzung.</p></main></html>');
 const thirdParty=Buffer.from('<html><h1>Gutachten</h1><p>Verfasser: Ingenieurbüro Beispiel GmbH</p><p>Externe Untersuchung zur Entwicklung des Quartiers und seiner Verkehrsanlagen.</p></html>');
 for(const mode of ['tdm-redirect','tdm-html','tdm-pdf','tdm-invalid-json','robots-html','robots-pdf'] as const){
  const fetcher=await createPoliteFetcher({cacheDir:join(root,mode)}),seen:string[]=[];
  const invalid=mode.endsWith('pdf')?metadataPdf(reservedXmp):mode==='tdm-invalid-json'?Buffer.from('{"document":"ordinary source, not TDMRep rules"}'):thirdParty;
  t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL)=>{
   seen.push(url.href);
   if(url.pathname==='/robots.txt')return mode.startsWith('robots-')?{status:200,headers:{'content-type':mode.endsWith('pdf')?'application/pdf':'text/html'},body:invalid}:{status:200,headers:{'content-type':'text/plain'},body:Buffer.from('User-agent: *\nDisallow: /\n')};
   if(url.pathname==='/.well-known/tdmrep.json'){
    if(mode.startsWith('robots-'))return {status:404,headers:{},body:Buffer.alloc(0)};
    if(mode==='tdm-redirect')return {status:302,headers:{location:'https://stadt.de/unrelated-report.pdf'},body:Buffer.alloc(0)};
    return {status:200,headers:{'content-type':mode==='tdm-pdf'?'application/pdf':mode==='tdm-invalid-json'?'application/json':'text/html','tdm-reservation':'1'},body:invalid};
   }
   if(url.pathname==='/unrelated-report.pdf')return {status:200,headers:{'content-type':'application/pdf','tdm-reservation':'1'},body:invalid};
   return {status:200,headers:{'content-type':'text/html'},body:official};
  });
  if(mode.startsWith('robots-')){
   const document=await fetcher.fetch(target,{ownerRobotsOverride});
   assert.equal(document.policy?.robots.state,'unavailable');assert.equal(document.policy?.robots.sha256,hash(invalid));
  }else await assert.rejects(fetcher.fetch(target,{ownerRobotsOverride}),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='tdm_unavailable',mode);
  assert.equal(seen.includes('https://stadt.de/unrelated-report.pdf'),mode==='tdm-redirect');
  await assert.rejects(readFile(join(fetcher.cacheDir,'sha256',hash(invalid))),{code:'ENOENT'});
 }
});

test('validated control policies survive conditional revalidation without leaking control fields to documents',async t=>{
 const root=await mkdtemp(join(tmpdir(),'polite-valid-controls-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const fetcher=await createPoliteFetcher({cacheDir:root,policyTtlMs:1}),counts=new Map<string,number>();
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-11T12:00:00.000Z')});
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL,_method:string,_body:string|undefined,validators:FetchObservation|undefined)=>{
  const count=(counts.get(url.pathname)??0)+1;counts.set(url.pathname,count);
  if(url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json'){
   if(count>1){assert.ok(validators?.etag);return {status:304,headers:{},body:Buffer.alloc(0)};}
   return {status:200,headers:{'content-type':url.pathname==='/robots.txt'?'text/plain':'application/json',etag:'"policy"'},body:Buffer.from(url.pathname==='/robots.txt'?'User-agent: *\nAllow: /\n':'[{"location":"/","tdm-reservation":0}]')};
  }
  return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from('Public synthetic municipal information for a bounded source-policy regression.')};
 });
 const first=await fetcher.fetch('https://stadt.de/document');t.mock.timers.tick(2);
 const second=await fetcher.fetch('https://stadt.de/document');
 assert.equal(second.policy?.robots.state,'allowed');assert.equal(second.policy?.tdm.state,'not_reserved');
 assert.equal(second.policy?.robots.sha256,first.policy?.robots.sha256);assert.equal(counts.get('/robots.txt'),2);assert.equal(counts.get('/.well-known/tdmrep.json'),2);
 assert.equal('validatedPolicy' in second,false);
});

test('304 preserves every omitted representation policy field, but honors explicit updates',async t=>{
 const root=await mkdtemp(join(tmpdir(),'polite-304-declarations-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const url='https://stadt.de/document',ownerRobotsOverride=ownerRobotsOverrideFor(url)!;
 const bytes=Buffer.from('<html><title>Beschlussvorlage</title><main><p>Herausgeber: Stadt Beispielstadt</p><p>Informationen zur Entwicklung des Quartiers und zur weiteren Beratung in der kommenden Sitzung.</p></main></html>');
 for(const mode of ['omitted','updated'] as const){
  const fetcher=await createPoliteFetcher({cacheDir:join(root,mode)});let documents=0;
  t.mock.method(fetcher as unknown as WireSeam,'wire',async(target:URL)=>{
   if(target.pathname==='/robots.txt'||target.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
   documents++;
   if(documents===1)return {status:200,headers:{'content-type':'text/html','tdm-reservation':'1','tdm-policy':'https://stadt.de/declared-policy','x-robots-tag':'noai, noimageai',etag:'"reserved"'},body:bytes};
   return {status:304,headers:mode==='updated'&&documents===2?{'tdm-reservation':'0','tdm-policy':'https://stadt.de/updated-policy','x-robots-tag':'all'}:{},body:Buffer.alloc(0)};
  });
  const first=await fetcher.fetch(url,{ownerRobotsOverride});assert.equal(first.policy?.tdm.state,'reserved');
  const second=await fetcher.fetch(url,{ownerRobotsOverride});
  if(mode==='omitted'){
   assert.equal(second.policy?.tdm.state,'reserved');assert.equal(second.policy?.tdmOverride,'owner-approved 2026-10-11');
   for(const locator of ['HTTP TDM-Reservation','HTTP TDM-Policy','HTTP X-Robots-Tag'])assert.deepEqual(second.policy?.tdm.evidence.find(item=>item.url===url&&item.locator===locator),first.policy?.tdm.evidence.find(item=>item.url===url&&item.locator===locator));
   const policyReference=second.policy?.tdm.evidence.find(item=>item.locator==='HTTP TDM-Policy')!;assert.equal(policyReference.value,'policy_reference_present');assert.equal(policyReference.valueSha256,hash('https://stadt.de/declared-policy'));
   await assert.rejects(fetcher.fetch(url,{ownerRobotsOverride,title:'Gutachten'}),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='document_excluded'&&error.excludedDocument?.policy.tdm.state==='reserved');
  }else{
   assert.equal(second.policy?.tdm.state,'not_reserved');assert.equal(second.policy?.tdmOverride,undefined);
   assert.ok(!second.policy?.tdm.evidence.some(item=>item.locator==='HTTP X-Robots-Tag'));
   assert.equal(second.policy?.tdm.evidence.find(item=>item.locator==='HTTP TDM-Policy')?.valueSha256,hash('https://stadt.de/updated-policy'));
   const third=await fetcher.fetch(url,{ownerRobotsOverride});assert.equal(third.policy?.tdm.state,'not_reserved');assert.equal(third.policy?.tdmOverride,undefined);
  }
 }
});

test('an omitted X-Robots-Tag alone remains a reservation on 304',async t=>{
 const root=await mkdtemp(join(tmpdir(),'polite-304-noai-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const fetcher=await createPoliteFetcher({cacheDir:root}),url='https://stadt.de/document';let calls=0;
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(target:URL)=>{
  if(target.pathname==='/robots.txt'||target.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  return ++calls===1?{status:200,headers:{'content-type':'text/html','x-robots-tag':'noai'},body:Buffer.from('<html><title>Beschlussvorlage</title><main><p>Herausgeber: Stadt Beispielstadt</p><p>Informationen zur Entwicklung des Quartiers und zur weiteren Beratung in der kommenden Sitzung.</p></main></html>')}:{status:304,headers:{},body:Buffer.alloc(0)};
 });
 const ownerRobotsOverride=ownerRobotsOverrideFor(url)!;await fetcher.fetch(url,{ownerRobotsOverride});
 await assert.rejects(fetcher.fetch(url,{ownerRobotsOverride,title:'Gutachten'}),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='document_excluded'&&error.excludedDocument?.policy.tdm.evidence.some(item=>item.locator==='HTTP X-Robots-Tag'&&item.value==='noai')===true);
});

test('OParl issuer context applies only to matching body-bound JSON, never documents or redirected JSON',async t=>{
 const root=await mkdtemp(join(tmpdir(),'polite-oparl-context-binding-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const apiUrl='https://stadt.de/oparl/papers',bodyId='https://stadt.de/oparl/body',ownerRobotsOverride=ownerRobotsOverrideFor(apiUrl)!;
 const oparlContext={bodyId,bodyName:'Stadt Beispielstadt',apiUrl};
 const json=Buffer.from(JSON.stringify({data:[{id:'https://stadt.de/oparl/paper/1',type:'https://schema.oparl.org/1.1/Paper',body:bodyId,name:'Beschluss zur weiteren Beratung des Quartiers'}]}));
 for(const mode of ['bound','html','pdf','unbound-json','redirected-json'] as const){
  const fetcher=await createPoliteFetcher({cacheDir:join(root,mode)});
  const bytes=mode==='pdf'?metadataPdf(reservedXmp):mode==='html'?Buffer.from('<html><h1>Beschluss</h1><p>Weitere Beratung der Entwicklung des Quartiers in der kommenden Sitzung und ihrer einzelnen Schritte.</p></html>'):mode==='unbound-json'?Buffer.from(JSON.stringify({data:[{id:'https://stadt.de/oparl/paper/1',type:'https://schema.oparl.org/1.1/Paper',name:'Beschluss zur weiteren Beratung des Quartiers'}]})):json;
  t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL)=>{
   if(url.pathname==='/robots.txt')return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from('User-agent: *\nDisallow: /\n')};
   if(url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
   if(mode==='redirected-json'&&url.href===apiUrl)return {status:302,headers:{location:'https://stadt.de/unrelated.json'},body:Buffer.alloc(0)};
   return {status:200,headers:{'content-type':mode==='pdf'?'application/pdf':mode==='html'?'text/html':'application/json','tdm-reservation':'1'},body:bytes};
  });
  if(mode==='bound'){const document=await fetcher.fetch(apiUrl,{ownerRobotsOverride,oparlContext});assert.equal(document.policy?.documentOrigin?.classification,'official_work');assert.equal(document.policy?.tdmOverride,'owner-approved 2026-10-11');}
  else{
   await assert.rejects(fetcher.fetch(apiUrl,{ownerRobotsOverride,oparlContext}),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='document_excluded'&&error.excludedDocument?.policy.documentOrigin?.classification!=='official_work',mode);
   await assert.rejects(readFile(join(fetcher.cacheDir,'sha256',hash(bytes))),{code:'ENOENT'});
  }
 }
});

test('valid robots directives keep their denial even under a misleading text media label',async t=>{
 const root=await mkdtemp(join(tmpdir(),'polite-robots-media-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const fetcher=await createPoliteFetcher({cacheDir:root}),url='https://stadt.de/study';
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(target:URL)=>{
  if(target.pathname==='/robots.txt')return {status:200,headers:{'content-type':'text/html'},body:Buffer.from('User-agent: *\nDisallow: /\n')};
  if(target.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from('Gutachten\nVerfasser: Ingenieurbüro Beispiel GmbH\nExterne Untersuchung zur Verkehrsentwicklung im Stadtgebiet.')};
 });
 await assert.rejects(fetcher.fetch(url,{ownerRobotsOverride:ownerRobotsOverrideFor(url)!}),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='document_excluded'&&error.excludedDocument?.policy.robots.state==='blocked');
});

test('missing, mismatched or removed authority fails without self-provisioning or wire fallback',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'polite-authority-boundary-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const missingState=join(root,'missing-authority'),unprovisioned=new BasePoliteFetcher({cacheDir:join(root,'unprovisioned-raw'),ownerPolicyLane:{decisionId:APPROVED_OWNER_ROBOTS_OVERRIDE.id,stateDir:missingState}});
 await assert.rejects(unprovisioned.fetch('https://stadt.de/document'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_state_unsafe');
 await assert.rejects(readFile(join(missingState,'authority.json')),{code:'ENOENT'});
 const options=await politeTestOptions({cacheDir:join(root,'raw')});
 const mismatch=new BasePoliteFetcher({...options,ownerPolicyLane:{...options.ownerPolicyLane!,authoritySha256:'0'.repeat(64)}});
 await assert.rejects(mismatch.fetch('https://stadt.de/document'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_state_unsafe');
 const fetcher=new BasePoliteFetcher(options);await fetcher.initialize();let calls=0;
 t.mock.method(fetcher as unknown as WireSeam,'wire',async()=>{calls++;throw Error('An unavailable authority must not fall through to wire');});
 await rm(join(options.ownerPolicyLane!.stateDir!,'authority.json'));
 await assert.rejects(fetcher.fetch('https://stadt.de/document'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_state_unsafe');
 assert.equal(calls,0);await assert.rejects(readFile(join(options.ownerPolicyLane!.stateDir!,'authority.json')),{code:'ENOENT'});
});

test('fixture authority never authorizes the actual HTTP boundary',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'polite-fixture-wire-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const fetcher=await createPoliteFetcher({cacheDir:root});
 // The private-address fallback also prevents network activity if the realm guard regresses.
 await assert.rejects((fetcher as unknown as WireSeam).wire(new URL('https://127.0.0.1/'),'GET',undefined,undefined),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_state_unsafe'&&/canonical production authority/.test(error.message));
});

test('invalid remote policy text is withheld and never persisted as exempt metadata',async t=>{
 const root=await mkdtemp(join(tmpdir(),'polite-policy-content-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const options=await politeTestOptions({cacheDir:root}),fetcher=new BasePoliteFetcher({...options,fixtureInspection:fixturePolicyInspection}),url='https://stadt.de/document';
 const marker='SYNTHETIC-SOURCE-CONTENT',remoteValue=(marker+' ').repeat(1500).trim();
 const bytes=Buffer.from(`<html><meta name="tdm-reservation" content="1"><meta name="tdm-policy" content="${remoteValue}"><h1>Beschluss</h1><p>Herausgeber: Stadt Beispielstadt</p></html>`);
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(target:URL)=>target.pathname==='/robots.txt'||target.pathname==='/.well-known/tdmrep.json'?{status:404,headers:{},body:Buffer.alloc(0)}:{status:200,headers:{'content-type':'text/html'},body:bytes});
 await assert.rejects(fetcher.fetch(url,{ownerRobotsOverride:ownerRobotsOverrideFor(url)!}),(error:unknown)=>{
  if(!(error instanceof PoliteFetchError)||error.failure!=='tdm_unavailable')return false;
  assert.equal(error.policy?.tdm.state,'reserved');assert.equal(error.policy?.tdm.referenceStatus,'unavailable');
  const item=error.policy?.tdm.evidence.find(item=>item.locator==='HTML meta[name=tdm-policy]')!;
  assert.equal(item.value,'invalid_policy_reference');assert.equal(item.valueSha256,hash(remoteValue));assert.equal(item.valueBytes,Buffer.byteLength(remoteValue));
  assert.equal(ContentFreeSourcePolicySchema.safeParse(error.policy).success,true);assert.ok(!JSON.stringify(error.policy).includes(marker));return true;
 });
 await assert.rejects(readFile(join(root,'sha256',hash(bytes))),{code:'ENOENT'});
 for(const name of await readdir(join(root,'observations')))assert.ok(!(await readFile(join(root,'observations',name),'utf8')).includes(marker));
 const receipt=await recordHostOptOut({host:'stadt.de',reason:'rights_holder_objection'},options.ownerPolicyLane!);assert.equal(receipt.purge.status,'purged');
});

test('valid policy references are digest-only in returned, observation and request metadata',async t=>{
 const root=await mkdtemp(join(tmpdir(),'polite-policy-uri-digest-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const options=await politeTestOptions({cacheDir:root}),fetcher=new BasePoliteFetcher({...options,fixtureInspection:fixturePolicyInspection}),url='https://stadt.de/document';
 const marker='SYNTHETIC-CONTENT-IN-URI',reference='https://stadt.de/policy?note='+marker;
 const bytes=Buffer.from(`<html><meta name="tdm-policy" content="${reference}"><h1>Beschlussvorlage</h1><p>Herausgeber: Stadt Beispielstadt</p><p>Informationen zur Entwicklung des Quartiers und zur weiteren Beratung.</p></html>`);
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(target:URL)=>target.pathname==='/robots.txt'||target.pathname==='/.well-known/tdmrep.json'?{status:404,headers:{},body:Buffer.alloc(0)}:{status:200,headers:{'content-type':'text/html'},body:bytes});
 const document=await fetcher.fetch(url);
 assert.equal(document.policy?.tdm.evidence.find(item=>item.locator==='HTML meta[name=tdm-policy]')?.valueSha256,hash(reference));assert.ok(!JSON.stringify(document.policy).includes(marker));
 for(const directory of ['observations','requests'])for(const name of await readdir(join(root,directory)))assert.ok(!(await readFile(join(root,directory,name),'utf8')).includes(marker));
 const receipt=await recordHostOptOut({host:'stadt.de',reason:'rights_holder_objection'},options.ownerPolicyLane!);assert.equal(receipt.purge.status,'purged');
 await assert.rejects(readFile(document.localPath),{code:'ENOENT'});
 for(const directory of ['observations','requests'])for(const name of await readdir(join(root,directory)))assert.ok(!(await readFile(join(root,directory,name),'utf8')).includes(marker));
});

test('a failed 304 policy-reference update remains blocking until an explicit valid update',async t=>{
 const root=await mkdtemp(join(tmpdir(),'polite-304-invalid-reference-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const fetcher=await createPoliteFetcher({cacheDir:root}),url='https://stadt.de/document',ownerRobotsOverride=ownerRobotsOverrideFor(url)!;let requests=0;
 const invalid='Not a policy URL; synthetic source text must remain opaque';
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(target:URL)=>{
  if(target.pathname==='/robots.txt'||target.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  requests++;
  if(requests===1)return {status:200,headers:{'content-type':'text/html','tdm-reservation':'1','tdm-policy':'https://stadt.de/policy',etag:'"fixture"'},body:Buffer.from('<html><h1>Beschlussvorlage</h1><p>Herausgeber: Stadt Beispielstadt</p><p>Informationen zur Entwicklung des Quartiers und zur weiteren Beratung.</p></html>')};
  return {status:304,headers:requests===2?{'tdm-policy':invalid}:requests===4?{'tdm-policy':'https://stadt.de/restored-policy'}:{},body:Buffer.alloc(0)};
 });
 await fetcher.fetch(url,{ownerRobotsOverride});
 for(let attempt=0;attempt<2;attempt++)await assert.rejects(fetcher.fetch(url,{ownerRobotsOverride}),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='tdm_unavailable'&&error.policy?.tdm.state==='reserved'&&error.policy.tdm.referenceStatus==='unavailable'&&error.policy.tdm.evidence.some(item=>item.locator==='HTTP TDM-Policy'&&item.valueSha256===hash(invalid)));
 const restored=await fetcher.fetch(url,{ownerRobotsOverride});assert.equal(restored.policy?.tdm.state,'reserved');assert.equal(restored.policy?.tdm.referenceStatus,undefined);
 const observation=JSON.parse(await readFile(restored.observationPath,'utf8'));assert.equal(observation.state,'not_modified');assert.equal(observation.failure,undefined);
});

test('malformed or combined reservation on 200 withholds non-official bytes before raw retention',async t=>{
 const root=await mkdtemp(join(tmpdir(),'polite-invalid-reservation-200-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const url='https://stadt.de/report',body=Buffer.from('<h1>Gutachten</h1><p>Verfasser: Ingenieurbüro Beispiel GmbH</p><p>Synthetic third-party report, not an official municipal work.</p>');
 for(const value of ['1, 1','1, 0','0, 1','0, 0','','   ','PRIVATE-BAD-DECLARATION']){
  const cache=join(root,hash(value)),fetcher=await createPoliteFetcher({cacheDir:cache});
  t.mock.method(fetcher as unknown as WireSeam,'wire',async(target:URL)=>target.pathname==='/robots.txt'||target.pathname==='/.well-known/tdmrep.json'?{status:404,headers:{},body:Buffer.alloc(0)}:{status:200,headers:{'content-type':'text/html','tdm-reservation':value},body});
  await assert.rejects(fetcher.fetch(url,{ownerRobotsOverride:ownerRobotsOverrideFor(url)!}),(error:unknown)=>{
   if(!(error instanceof PoliteFetchError)||error.failure!=='tdm_unavailable')return false;
   assert.equal(error.policy?.tdm.state,value.split(',').some(token=>token.trim()==='1')?'reserved':'unavailable');assert.equal(error.policy?.tdm.declarationStatus,'unavailable');assert.equal(error.policy?.tdm.referenceStatus,undefined);
   const evidence=error.policy?.tdm.evidence.find(item=>item.value==='invalid_reservation_declaration')!;assert.equal(evidence.valueSha256,hash(value));assert.equal(evidence.valueBytes,Buffer.byteLength(value));assert.equal(ContentFreeSourcePolicySchema.safeParse(error.policy).success,true);return true;
  });
  await assert.rejects(readFile(join(cache,'sha256',hash(body))),{code:'ENOENT'});
  for(const name of await readdir(join(cache,'observations')))assert.equal((await readFile(join(cache,'observations',name),'utf8')).includes('PRIVATE-BAD-DECLARATION'),false);
 }
});

test('invalid 304 reservation cannot erase prior declarations and remains blocking through omitted updates',async t=>{
 const root=await mkdtemp(join(tmpdir(),'polite-invalid-reservation-304-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const url='https://stadt.de/document',ownerRobotsOverride=ownerRobotsOverrideFor(url)!;
 const body=Buffer.from('<html><h1>Beschlussvorlage</h1><p>Herausgeber: Stadt Beispielstadt</p><p>Synthetic official municipal information for a conditional policy regression.</p></html>');
 for(const initial of ['0','1'])for(const invalid of ['1, 1','1, 0','0, 0','','PRIVATE-BAD-DECLARATION']){
  const cache=join(root,hash(initial+'\\n'+invalid)),fetcher=await createPoliteFetcher({cacheDir:cache});let requests=0;
  t.mock.method(fetcher as unknown as WireSeam,'wire',async(target:URL)=>{
   if(target.pathname==='/robots.txt'||target.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
   requests++;
   if(requests===1)return {status:200,headers:{'content-type':'text/html','tdm-reservation':initial,'tdm-policy':'https://stadt.de/policy',etag:'"fixture"'},body};
   return {status:304,headers:requests===2?{'tdm-reservation':invalid}:requests===4?{'tdm-reservation':'PRIVATE-SECOND-BAD-DECLARATION'}:requests===5?{'tdm-reservation':'0'}:{},body:Buffer.alloc(0)};
  });
  const first=await fetcher.fetch(url,{ownerRobotsOverride}),reserved=initial==='1'||invalid.split(',').some(token=>token.trim()==='1');
  for(let attempt=0;attempt<3;attempt++)await assert.rejects(fetcher.fetch(url,{ownerRobotsOverride}),(error:unknown)=>{
   if(!(error instanceof PoliteFetchError)||error.failure!=='tdm_unavailable')return false;
   assert.equal(error.policy?.tdm.state,reserved?'reserved':'unavailable');assert.equal(error.policy?.tdm.declarationStatus,'unavailable');assert.equal(error.policy?.tdm.referenceStatus,undefined);
   assert.equal(error.policy?.tdm.evidence.findLast(item=>item.value==='invalid_reservation_declaration')?.valueSha256,hash(attempt===2?'PRIVATE-SECOND-BAD-DECLARATION':invalid));
   if(reserved)assert.ok(error.policy?.tdm.evidence.some(item=>item.locator==='HTTP TDM-Reservation'&&item.value==='1'));
   assert.equal(ContentFreeSourcePolicySchema.safeParse(error.policy).success,true);return true;
  });
  const restored=await fetcher.fetch(url,{ownerRobotsOverride}),again=await fetcher.fetch(url,{ownerRobotsOverride});
  for(const document of [restored,again]){assert.equal(document.sha256,first.sha256);assert.equal(document.retrievedAt,first.retrievedAt);assert.equal(document.policy?.tdm.state,'not_reserved');assert.equal(document.policy?.tdm.declarationStatus,undefined);assert.ok(!document.policy?.tdm.evidence.some(item=>item.value==='invalid_reservation_declaration'));}
  for(const directory of ['observations','requests'])for(const name of await readdir(join(cache,directory)))assert.equal((await readFile(join(cache,directory,name),'utf8')).includes('PRIVATE-'),false);
 }
});

test('policy wrappers preserve typed failures and structured unknown causes with policy-phase context',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-policy-errors-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 interface PolicySeam {
  fetchInternal():Promise<never>;
  policy(url:URL):Promise<unknown>;
  machinePolicy(url:URL):Promise<unknown>;
 }
 for(const phase of ['robots','tdm'] as const)for(const kind of ['unknown','network_error','dns_error','timeout','cache_missing','too_large','unsupported_encoding'] as const){
  const error=kind==='unknown'?Error('Synthetic unexpected runtime failure'):new PoliteFetchError(kind,'Synthetic typed failure');
  const fetcher=await createPoliteFetcher({cacheDir:join(cache,phase+'-'+kind)}),seam=fetcher as unknown as PolicySeam;
  t.mock.method(seam,'fetchInternal',async()=>{throw error;});
  const request=phase==='robots'?seam.policy(new URL('https://stadt.de/document')):seam.machinePolicy(new URL('https://stadt.de/document'));
  await assert.rejects(request,(failure:unknown)=>failure instanceof PoliteFetchError&&failure.policyPhase===phase&&(kind==='unknown'?failure.failure==='network_error'&&failure.cause===error:failure===error));
 }
});

test('PDF inspection runtime errors remain network_error with structured cause, not policy refusals',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-pdf-runtime-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const options=await politeTestOptions({cacheDir:cache}),cause=Error('Synthetic PDF cache or version failure');
 const fetcher=new BasePoliteFetcher({...options,fixtureInspection:{...fixturePolicyInspection,pdf:async()=>{throw cause;}}});
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL)=>url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json'?{status:404,headers:{},body:Buffer.alloc(0)}:{status:200,headers:{'content-type':'application/pdf'},body:Buffer.from('%PDF-invalid')});
 await assert.rejects(fetcher.fetch('https://stadt.de/plan.pdf'),(failure:unknown)=>failure instanceof PoliteFetchError&&failure.failure==='network_error'&&failure.policyPhase==='tdm'&&failure.cause===cause);
});

test('invalid fetched robots without an owner override remains a source-policy refusal',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-invalid-policy-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const fetcher=await createPoliteFetcher({cacheDir:cache});
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL)=>{
  assert.equal(url.pathname,'/robots.txt');
  return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from('Not a robots policy representation')};
 });
 await assert.rejects(fetcher.fetch('https://stadt.de/document'),(failure:unknown)=>failure instanceof PoliteFetchError&&failure.failure==='robots_unavailable'&&failure.status===200);
});
