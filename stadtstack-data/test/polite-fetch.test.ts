import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PoliteFetcher,PoliteFetchError,parseRobots,robotsAllows,publicUrl} from '../src/polite-fetch.ts';
import {isPublicAddress} from '../src/public-address.ts';
import type {FetchObservation} from '../src/polite-fetch.ts';
import {metadataPdf,reservedXmp} from './fixtures/tdm-pdf.ts';

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
 const fetcher=new PoliteFetcher({cacheDir:cache}),seen:{path:string;validators?:FetchObservation}[]=[];let documents=0;
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL,_method:string,_body:string|undefined,validators:FetchObservation|undefined)=>{
  seen.push({path:url.pathname,validators});if(url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  documents++;return documents===1?{status:200,headers:{'content-type':'application/pdf',etag:'"abc"','last-modified':'Wed, 01 Jul 2026 00:00:00 GMT'},body:metadataPdf()}:{status:304,headers:{},body:Buffer.alloc(0)};
 });
 const first=await fetcher.fetch('https://stadt.de/plan.pdf'),second=await fetcher.fetch('https://stadt.de/plan.pdf');
 assert.equal(second.sha256,first.sha256);assert.equal(second.retrievedAt,first.retrievedAt);assert.equal(second.status,304);assert.equal(seen.at(-1)?.validators?.etag,'"abc"');assert.equal(seen.filter(item=>item.path==='/robots.txt').length,1);
 const observation=JSON.parse(await readFile(second.observationPath,'utf8'));assert.equal(observation.state,'not_modified');assert.equal(observation.sha256,first.sha256);
 await writeFile(first.localPath,'changed');await assert.rejects(fetcher.fetch('https://stadt.de/plan.pdf'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='cache_missing');
});
test('robots denial and unavailable policy are distinct from missing source',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-robots-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const blocked=new PoliteFetcher({cacheDir:join(cache,'blocked')});let calls=0;
 t.mock.method(blocked as unknown as WireSeam,'wire',async()=>{calls++;return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from('User-agent: StadtstackData\nDisallow: /private')};});
 await assert.rejects(blocked.fetch('https://stadt.de/private'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='robots_blocked');assert.equal(calls,1);
 const unavailable=new PoliteFetcher({cacheDir:join(cache,'unavailable')});t.mock.method(unavailable as unknown as WireSeam,'wire',async()=>({status:503,headers:{},body:Buffer.alloc(0)}));
 await assert.rejects(unavailable.fetch('https://stadt.de/'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='robots_unavailable');
});
test('each redirected origin gets robots checks and private redirect is rejected before transport',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-redirect-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const fetcher=new PoliteFetcher({cacheDir:cache}),seen:string[]=[];
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL)=>{
  seen.push(url.href);if(url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  return {status:302,headers:{location:url.hostname==='stadt.de'?'https://docs.stadt.de/plan.pdf':'http://127.0.0.1/private'},body:Buffer.alloc(0)};
 });
 await assert.rejects(fetcher.fetch('https://stadt.de/start'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='unsafe_url');
 assert.deepEqual(seen,['https://stadt.de/robots.txt','https://stadt.de/.well-known/tdmrep.json','https://stadt.de/start','https://docs.stadt.de/robots.txt','https://docs.stadt.de/.well-known/tdmrep.json','https://docs.stadt.de/plan.pdf']);
});
test('host scheduler serializes concurrent work and respects minimum spacing',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-schedule-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
 const fetcher=new PoliteFetcher({cacheDir:cache,minDelayMs:20});const scheduler=fetcher as unknown as {scheduled<T>(url:URL,work:()=>Promise<T>):Promise<T>};
 const starts:number[]=[];let active=0,maxActive=0;
 const work=async()=>{starts.push(Date.now());active++;maxActive=Math.max(maxActive,active);await Promise.resolve();active--;};
 const pending=Promise.all([scheduler.scheduled(new URL('https://stadt.de/a'),work),scheduler.scheduled(new URL('http://stadt.de/b'),work),scheduler.scheduled(new URL('https://stadt.de/c'),work)]);
 for(let turn=0;turn<40;turn++){await Promise.resolve();t.mock.timers.tick(5);}
 await pending;
 assert.equal(maxActive,1);assert.ok(starts[1]-starts[0]>=20);assert.ok(starts[2]-starts[1]>=20);
});
test('origin TDM reservation prevents document fetch and carries ask-municipality evidence',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-tdm-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const fetcher=new PoliteFetcher({cacheDir:cache}),seen:string[]=[];
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL)=>{
  seen.push(url.pathname);if(url.pathname==='/robots.txt')return {status:404,headers:{},body:Buffer.alloc(0)};
  if(url.pathname==='/.well-known/tdmrep.json')return {status:200,headers:{'content-type':'application/json'},body:Buffer.from('[{"location":"/","tdm-reservation":1}]')};
  throw Error('Reserved document must not be requested');
 });
 await assert.rejects(fetcher.fetch('https://stadt.de/plan.pdf'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='tdm_reserved'&&error.policy?.tdm.state==='reserved'&&error.policy.tdm.evidence.some(item=>item.value==='1'));
 assert.deepEqual(seen,['/robots.txt','/.well-known/tdmrep.json']);
});
test('Optional absent or non-JSON policy cache never satisfies an explicit required endpoint',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-policy-mode-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 for(const status of [404,410,200]){
  const fetcher=new PoliteFetcher({cacheDir:join(cache,String(status))});let policies=0,documents=0;
  const seam=fetcher as unknown as WireSeam;
  t.mock.method(seam,'wire',async(url:URL)=>{
   if(url.pathname==='/robots.txt')return {status:404,headers:{},body:Buffer.alloc(0)};
   if(url.pathname==='/.well-known/tdmrep.json'){policies++;return {status,headers:{'content-type':'text/html'},body:Buffer.from('<h1>No policy representation</h1>')};}
   documents++;return {status:200,headers:{'content-type':'text/html'},body:Buffer.from('<h1>Public planning information</h1>')};
  });
  await fetcher.fetch('https://stadt.de/plan');
  await assert.rejects(fetcher.fetch('https://stadt.de/plan',{machinePolicyUrls:['https://stadt.de/.well-known/tdmrep.json']}),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='tdm_unavailable');
  assert.equal(policies,2);assert.equal(documents,1);
 }
});
test('HTML reservation and CAPTCHA are withheld from document cache results',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-barrier-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 for(const [html,failure] of [['<meta name="tdm-reservation" content="1"><h1>Plan</h1>','tdm_reserved'],['<title>Just a moment</title><form id="challenge-form"></form>','access_barrier']] as const){
  const fetcher=new PoliteFetcher({cacheDir:join(cache,failure)});
  t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL)=>url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json'?{status:404,headers:{},body:Buffer.alloc(0)}:{status:200,headers:{'content-type':'text/html'},body:Buffer.from(html)});
  await assert.rejects(fetcher.fetch('https://stadt.de/plan'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure===failure);
 }
});
test('robots 200 HTML or CAPTCHA never becomes an empty allow-all policy',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-robots-html-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 for(const [index,body] of ['<html><title>Server error</title><body>Try later</body></html>','<html><title>Just a moment</title><form id="challenge-form"></form></html>','<div>Authentication required</div>'].entries()){
  const fetcher=new PoliteFetcher({cacheDir:join(cache,String(index))}),seen:string[]=[];
  t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL)=>{seen.push(url.pathname);return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from(body)};});
  await assert.rejects(fetcher.fetch('https://stadt.de/plan.pdf'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='robots_unavailable');
  assert.deepEqual(seen,['/robots.txt']);
 }
});
test('compressed PDF TDM is enforced and parser failures are unavailable rather than unreserved',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-pdf-metadata-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 for(const [label,bytes,expected] of [['reserved',metadataPdf(reservedXmp),'tdm_reserved'],['invalid',Buffer.from('%PDF-invalid'),'tdm_unavailable']] as const){
  const fetcher=new PoliteFetcher({cacheDir:join(cache,label)});
  t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL)=>url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json'?{status:404,headers:{},body:Buffer.alloc(0)}:{status:200,headers:{'content-type':'application/pdf'},body:bytes});
  await assert.rejects(fetcher.fetch('https://stadt.de/plan.pdf'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure===expected);
 }
});
test('HTTP reservation remains a veto even when PDF metadata would be zero or unreadable',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-header-veto-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const fetcher=new PoliteFetcher({cacheDir:cache});
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(url:URL)=>url.pathname==='/robots.txt'||url.pathname==='/.well-known/tdmrep.json'?{status:404,headers:{},body:Buffer.alloc(0)}:{status:200,headers:{'content-type':'application/pdf','tdm-reservation':'1'},body:Buffer.from('%PDF-invalid')});
 await assert.rejects(fetcher.fetch('https://stadt.de/plan.pdf'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='tdm_reserved'&&error.policy?.tdm.state==='reserved');
});
test('long-lived fetchers revalidate expired robots and machine policies before reusing permission',async t=>{
 const cache=await mkdtemp(join(tmpdir(),'polite-policy-ttl-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-10T12:00:00.000Z')});
 for(const kind of ['robots','tdm'] as const){
  const fetcher=new PoliteFetcher({cacheDir:join(cache,kind),policyTtlMs:60*60_000}),seen:string[]=[];let changed=false;
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
