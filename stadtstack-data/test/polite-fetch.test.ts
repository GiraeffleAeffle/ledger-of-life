import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,realpath,mkdir,chmod,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PoliteFetcher as BasePoliteFetcher,PoliteFetchError,parseRobots,robotsAllows,publicUrl,sourceContentBinding} from '../src/polite-fetch.ts';
import {isPublicAddress} from '../src/public-address.ts';
import type {FetchObservation,ExcludedDocument,PoliteFetcherOptions} from '../src/polite-fetch.ts';
import {metadataPdf,reservedXmp} from './fixtures/tdm-pdf.ts';
import {ownerRobotsOverrideFor,APPROVED_OWNER_ROBOTS_OVERRIDE} from '../src/source-policy.ts';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setImmediate as immediate} from 'node:timers/promises';
import {recordHostOptOut} from '../src/civic-opt-out.ts';
import {hash} from '../src/common.ts';
import {politeTestOptions} from './fixtures/polite-lane.ts';

class PoliteFetcher extends BasePoliteFetcher {
 constructor(options:PoliteFetcherOptions){super(politeTestOptions(options));}
}

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
 const cache=await realpath(await mkdtemp(join(tmpdir(),'polite-schedule-')));t.after(()=>rm(cache,{recursive:true,force:true}));
 t.mock.timers.enable({apis:['Date','setTimeout'],now:10000});
 const fetcher=new PoliteFetcher({cacheDir:cache,minDelayMs:20}),scheduler=fetcher as unknown as LaneSeam;
 t.mock.method(scheduler,'hostStateDirectory',()=>join(cache,'lanes'));
 const starts:number[]=[];let active=0,maxActive=0;
 const work=async()=>{starts.push(Date.now());active++;maxActive=Math.max(maxActive,active);await Promise.resolve();active--;};
 let complete=false;const pending=Promise.all([scheduler.scheduled(new URL('https://stadt.de/a'),work),scheduler.scheduled(new URL('http://stadt.de/b'),work),scheduler.scheduled(new URL('https://stadt.de/c'),work)]).finally(()=>{complete=true;});
 for(let turn=0;!complete&&turn<3000;turn++){await immediate();t.mock.timers.tick(25);}
 await pending;
 assert.equal(maxActive,1);assert.ok(starts[1]-starts[0]>=2000);assert.ok(starts[2]-starts[1]>=2000);
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
  await assert.rejects(fetcher.fetch('https://stadt.de/plan.pdf'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure===(index===1?'access_barrier':'robots_unavailable'));
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
 const lanes=[0,1,2].map(index=>{
  const lane=new PoliteFetcher({cacheDir:join(root,String(index)),minDelayMs:index===0?5000:2000}) as unknown as LaneSeam;
  t.mock.method(lane,'hostStateDirectory',()=>join(root,'lanes'));return lane;
 });
 const work=async()=>{starts.push(Date.now());active++;maxActive=Math.max(active,maxActive);await immediate();active--;};
 let complete=false;
 const run=Promise.all(lanes.map((lane,index)=>lane.scheduled(new URL(['https://stadt.de/robots.txt','https://stadt.de/.well-known/tdmrep.json','http://stadt.de/document'][index]),work))).finally(()=>{complete=true;});
 for(let turn=0;!complete&&turn<3000;turn++){await immediate();t.mock.timers.tick(25);}
 await run;assert.equal(maxActive,1);assert.equal(starts.length,3);
 assert.ok(starts[1]-starts[0]>=5000);assert.ok(starts[2]-starts[1]>=5000);
 const state=JSON.parse(await readFile(join(root,'lanes','stadt.de.json'),'utf8'));
 assert.equal(state.lastStart,starts[2]);assert.equal(state.delayMs,5000);
 // A fresh instance reads the committed timestamp even after the in-memory queue drains.
 const restart=new PoliteFetcher({cacheDir:join(root,'restart')}) as unknown as LaneSeam;t.mock.method(restart,'hostStateDirectory',()=>join(root,'lanes'));
 complete=false;const resumed=restart.scheduled(new URL('https://stadt.de/restarted'),work).finally(()=>{complete=true;});
 for(let turn=0;!complete&&turn<3000;turn++){await immediate();t.mock.timers.tick(25);}
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
 const lock=await readFile(join(lanes,'stadt.de.lock'),'utf8'),fetcher=new PoliteFetcher({cacheDir:root}) as unknown as LaneSeam;
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
  const lane=new PoliteFetcher({cacheDir:root}) as unknown as LaneSeam;t.mock.method(lane,'hostStateDirectory',()=>directory);
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
  const restart=new PoliteFetcher({cacheDir:join(root,'restart')}) as unknown as LaneSeam;t.mock.method(restart,'hostStateDirectory',()=>directory);
  await assert.rejects(restart.scheduled(url,work),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_cooldown'&&!!error.retryAfter);
  assert.equal(requests,status===503?3:1);
  const state=JSON.parse(await readFile(join(directory,'stadt.de.json'),'utf8'));assert.ok(state.stop.until-Date.now()>=(status===503?3600000:7200000));
 }
});
test('unsafe shared state fails closed before work',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'polite-unsafe-lane-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const lane=new PoliteFetcher({cacheDir:root}) as unknown as LaneSeam;t.mock.method(lane,'hostStateDirectory',()=>root);
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
  const fetcher=new PoliteFetcher({cacheDir:join(root,mode)}),seen:string[]=[];
  t.mock.method(fetcher as unknown as WireSeam,'wire',async(target:URL)=>{
   seen.push(target.href);
   if(target.pathname==='/robots.txt')return mode==='unavailable'?{status:503,headers:{},body:Buffer.alloc(0)}:{status:200,headers:{'content-type':'text/plain'},body:Buffer.from(mode==='allowed'?'User-agent: *\nAllow: /':'User-agent: *\nDisallow: /')};
   if(target.pathname==='/.well-known/tdmrep.json')return mode==='tdm'?{status:200,headers:{'content-type':'application/json'},body:Buffer.from('[{"location":"/","tdm-reservation":1}]')}:{status:404,headers:{},body:Buffer.alloc(0)};
   if((mode==='redirect'||mode==='private')&&target.hostname==='strausberg.allris.cloud')return {status:302,headers:{location:mode==='private'?'http://127.0.0.1/private':'https://different.stadt.de/document'},body:Buffer.alloc(0)};
   if(mode==='forbidden'||mode==='paywall')return {status:mode==='forbidden'?403:402,headers:{},body:Buffer.alloc(0)};
   if(mode==='pdf')return {status:200,headers:{'content-type':'application/pdf'},body:metadataPdf(reservedXmp)};
   return {status:200,headers:{'content-type':'text/html'},body:Buffer.from(mode==='captcha'?'<title>Just a moment</title><form id="challenge-form"></form>':mode==='third_party'?'<h1>Externer Bericht</h1><p>Ein nicht zugeordneter Text über die Entwicklung des Quartiers und weitere Einzelheiten.</p>':official)};
  });
  const options=mode==='missing'?{}:{ownerRobotsOverride:mode==='forged'?{...decision,id:'forged'} as typeof decision:decision};
  if(['public','allowed','unavailable','tdm','redirect'].includes(mode)){
   const document=await fetcher.fetch(url,options),observation=JSON.parse(await readFile(document.observationPath,'utf8'));
   assert.equal(document.policy?.robots.state,mode==='allowed'?'allowed':mode==='unavailable'?'unavailable':'blocked');
   assert.equal(document.policy?.override,mode==='allowed'?undefined:'owner-approved 2026-10-11');assert.equal(document.policy?.documentOrigin?.classification,'official_work');
   assert.deepEqual(observation.policy,document.policy);
   if(mode==='public'){assert.equal(document.policy?.robotsStatus,'disallowed');assert.deepEqual(document.policy?.ownerRobotsOverride,decision);assert.match(document.policy!.robots.sha256!,/^[a-f0-9]{64}$/);assert.ok(document.policy?.robots.checkedAt);}
   if(mode==='unavailable'){assert.equal(document.policy?.robotsStatus,'unavailable');assert.equal(document.policy?.robots.sha256,undefined);assert.ok(document.policy?.robots.checkedAt);}
   if(mode==='tdm'){assert.equal(document.policy?.tdm.state,'reserved');assert.equal(document.policy?.tdmOverride,'owner-approved 2026-10-11');assert.deepEqual(document.policy?.ownerTdmOverride,decision);}
   if(mode==='redirect'){assert.equal(document.policy?.ownerRobotsOverride?.host,'different.stadt.de');assert.ok(seen.includes('https://different.stadt.de/robots.txt'));}
  }else{
   const failure=mode==='pdf'||mode==='third_party'?'document_excluded':mode==='captcha'||mode==='forbidden'||mode==='paywall'?'access_barrier':mode==='private'?'unsafe_url':'robots_blocked';
   await assert.rejects(fetcher.fetch(url,options),(error:unknown)=>error instanceof PoliteFetchError&&error.failure===failure,mode);
  }
 }
});

test('excluded new raw stays absent and a later 304 cannot revive its request pointer',async t=>{
 const root=await mkdtemp(join(tmpdir(),'polite-excluded-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const url='https://stadt.de/external',body=Buffer.from('<h1>Gutachten</h1><p>Verfasser: Ingenieurbüro Beispiel GmbH</p><p>Externe Untersuchung zur Verkehrsentwicklung im gesamten Stadtgebiet.</p>');
 const fetcher=new PoliteFetcher({cacheDir:root});let response304=false,seenValidators:FetchObservation|undefined;
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
 const policyDir=join(root,'policy'),fetcher=new PoliteFetcher({cacheDir:join(root,'raw'),ownerPolicyLane:{decisionId:APPROVED_OWNER_ROBOTS_OVERRIDE.id,stateDir:policyDir}});
 const seam=fetcher as unknown as LaneSeam;
 t.mock.method(seam,'hostStateDirectory',()=>join(root,'lanes'));
 await recordHostOptOut({host:'stadt.de',reason:'rights_holder_objection'},{stateDir:policyDir});
 let calls=0;t.mock.method(fetcher as unknown as WireSeam,'wire',async()=>{calls++;throw Error('Must not request opted-out host');});
 await assert.rejects(fetcher.fetch('https://stadt.de/document'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_opted_out');
 await assert.rejects(seam.scheduled(new URL('https://stadt.de/robots.txt'),async()=>{calls++;}),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_opted_out');
 assert.equal(calls,0);
});

test('owner robots permission never bypasses policy login/private redirects or credential forms',async t=>{
 const root=await mkdtemp(join(tmpdir(),'polite-policy-redirect-gates-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target='https://stadt.de/document',decision=ownerRobotsOverrideFor(target)!;
 for(const [name,location,failure] of [['login','https://stadt.de/login','access_barrier'],['private','http://127.0.0.1/private','unsafe_url']] as const){
  const fetcher=new PoliteFetcher({cacheDir:join(root,name)});let calls=0;
  t.mock.method(fetcher as unknown as WireSeam,'wire',async()=>{calls++;return {status:302,headers:{location},body:Buffer.alloc(0)};});
  await assert.rejects(fetcher.fetch(target,{ownerRobotsOverride:decision}),(error:unknown)=>error instanceof PoliteFetchError&&error.failure===failure);assert.equal(calls,1);
 }
 const fetcher=new PoliteFetcher({cacheDir:join(root,'credentials')});let calls=0;
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
 const options=politeTestOptions({cacheDir:legacy}),fetcher=new BasePoliteFetcher(options);let calls=0;
 t.mock.method(fetcher as unknown as WireSeam,'wire',async()=>{calls++;throw Error('Unmarked nonempty root must fail before wire');});
 await assert.rejects(fetcher.fetch('https://stadt.de/'),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_state_unsafe');
 assert.equal(calls,0);assert.deepEqual(await readdir(legacy),['frozen.json']);assert.equal(await readFile(join(legacy,'frozen.json'),'utf8'),'historical bytes');
 await assert.rejects(readFile(join(options.ownerPolicyLane!.stateDir!,'inventory.json')),{code:'ENOENT'});
});

test('real lane lifecycle enrolls raw and parsed copies and opt-out prevents cache revival',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'polite-managed-derived-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const options=politeTestOptions({cacheDir:root}),fetcher=new BasePoliteFetcher(options),url='https://stadt.de/public';let calls=0;
 t.mock.method(fetcher as unknown as WireSeam,'wire',async(target:URL)=>{
  calls++;if(target.pathname==='/robots.txt'||target.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  return {status:200,headers:{'content-type':'text/plain',etag:'"fixture"'},body:Buffer.from('Public municipal information with a bounded synthetic source representation.')};
 });
 const document=await fetcher.fetch(url),binding=sourceContentBinding(document),derived=join(root,'oparl-bodies',hash('derived-fixture')+'.json');
 await fetcher.persistDerivedJson(derived,{bodies:[],sourceBindings:[binding]},[binding]);
 assert.ok((await readFile(derived)).length>0);assert.ok((await readFile(join(root,'.civic-acquisition-lane.json'))).length>0);
 const receipt=await recordHostOptOut({host:'stadt.de',reason:'municipality_objection'},{stateDir:options.ownerPolicyLane!.stateDir});
 assert.equal(receipt.purge.status,'purged');assert.ok(receipt.purge.deletedFiles>=2);
 await assert.rejects(readFile(document.localPath),{code:'ENOENT'});await assert.rejects(readFile(derived),{code:'ENOENT'});
 const before=calls;await assert.rejects(fetcher.fetch(url),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='host_opted_out');assert.equal(calls,before);
});
