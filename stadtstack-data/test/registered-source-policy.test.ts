import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest,type IncomingMessage,type RequestOptions} from 'node:http';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {once} from 'node:events';
import {cp,readFile,writeFile,symlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {PoliteFetcher,PoliteFetchError,type FetchObservation,type FetchOptions} from '../src/polite-fetch.ts';
import {nativePublicRequestHeaders,type NativePublicOperation} from '../src/district-native-request.ts';
import {ownerRobotsOverrideFor,effectiveSourcePermission,sourcePolicyExpiresAt,sourcePolicyValidityMs} from '../src/source-policy.ts';
import {ContentFreeSourcePolicySchema,sha256} from '../src/district-schema.ts';
import {districtRegistrySchema} from '../src/district-registry.ts';
import {DOCUMENT_ORIGIN_CLASSIFIER_VERSION} from '../src/document-origin-contract.ts';
import {PolicyReceiptSchema,createPolicyReceipt,recheckPolicyReceipt} from '../src/district-policy-receipt.ts';
import {recordHostOptOut,recoverManagedSourceScratch} from '../src/civic-opt-out.ts';
import {admittedRegisteredRobotsScopes,REVIEWED_REGISTERED_ROBOTS_SCOPES,REGISTERED_SOURCE_ROBOTS_DECISION,REGISTERED_SOURCE_POLICY_VALIDITY_MS,PUBLIC_SOURCE_POLICY_VALIDITY_MS,registeredRobotsAuditApplies,registeredRobotsEvidence,readRegisteredRobotsAudit} from '../src/registered-source-policy.ts';
import {createOperatorRegistryFixture} from './helpers/operator-registry-fixture.ts';
import {discoverDocumentLinks} from '../src/district-source-adapters.ts';
import {politeTestOptions} from './fixtures/polite-lane.ts';
import {fixturePolicyInspection} from './fixtures/polite-inspection.ts';
import {metadataPdf,reservedXmp} from './fixtures/tdm-pdf.ts';

const packageRoot=dirname(dirname(fileURLToPath(import.meta.url)));
const registry=()=>readFile(join(packageRoot,'sources/district-registry.json'),'utf8').then(bytes=>districtRegistrySchema.parse(JSON.parse(bytes)));
const root='https://www.ratzeburg.de/';
const scope={publisherId:'registered-source-fixture',municipalityId:'ratzeburg',ags:'01053100',sourceId:'ratzeburg-website',tenant:null,observationWindow:'2026-10-13'};
const requestOptions:FetchOptions={registeredSourceUrl:root,registeredMunicipalityId:scope.municipalityId,registeredSourceId:scope.sourceId,ownerRobotsOverride:ownerRobotsOverrideFor(root)??undefined};
interface WireFixture {
 wire(url:URL,method:'GET'|'POST',body:string|undefined,previous:FetchObservation|undefined,operation?:NativePublicOperation):Promise<{status:number;headers:Record<string,string|undefined>;body:Buffer}>;
 wireRequest(url:URL,method:'GET'|'POST',body:string|undefined,previous:FetchObservation|undefined,pinned:{address:string;family:number},headers:Record<string,string>):Promise<{status:number;headers:Record<string,string|undefined>;body:Buffer}>;
}

test('frozen owner scope matches the admitted nine-town registry, never a changed root or crawl scope',async t=>{
 const fixture=await createOperatorRegistryFixture(t,{value:await registry()});
 const audits=admittedRegisteredRobotsScopes(fixture.admitted.registry,fixture.registrySha256);
 assert.equal(audits.length,43);assert.equal(new Set(audits.map(row=>row.municipalityId)).size,9);
 assert.equal(REGISTERED_SOURCE_ROBOTS_DECISION.id,'r1-registered-sources-robots-2026-10-13');
 assert.ok(Object.isFrozen(REGISTERED_SOURCE_ROBOTS_DECISION));assert.ok(Object.isFrozen(REVIEWED_REGISTERED_ROBOTS_SCOPES));
 for(const row of REVIEWED_REGISTERED_ROBOTS_SCOPES){assert.ok(Object.isFrozen(row));assert.ok(Object.isFrozen(row.pageRoots));assert.ok(Object.isFrozen(row.seeds));}
 const changed=structuredClone(fixture.admitted.registry),city=changed.municipalities.find(row=>row.id===scope.municipalityId)!;
 const source=city.sources.find(row=>row.id===scope.sourceId)!;
 source.url='https://unregistered.example/';
 assert.ok(!admittedRegisteredRobotsScopes(changed,fixture.registrySha256).some(row=>row.sourceId===scope.sourceId));
 source.url=root;source.crawlScope!.pageRoots.push('https://unregistered.example/');
 assert.ok(!admittedRegisteredRobotsScopes(changed,fixture.registrySha256).some(row=>row.sourceId===scope.sourceId));
 const council=audits.find(row=>row.sourceId==='ruedersdorf-bei-berlin-council')!;
 assert.equal(registeredRobotsAuditApplies(council,'https://ratsinfo-online.net/other-tenant/allris.net.asp'),false);
 assert.equal(registeredRobotsAuditApplies({...council,discovery:{from:council.root,sha256:'a'.repeat(64)}},'https://ratsinfo-online.net/other-tenant/file.pdf'),false);
 const participation=audits.find(row=>row.sourceId==='hoppegarten-participation')!;
 assert.equal(registeredRobotsAuditApplies({...participation,discovery:{from:participation.root,sha256:'a'.repeat(64)}},'https://bb.beteiligung.diplanung.de/verfahren/unregistered/public/detail'),false);
 assert.equal(registeredRobotsAuditApplies({...participation,discovery:{from:participation.root,sha256:'a'.repeat(64)}},'https://unregistered.example/file.pdf'),false);
 const api=audits.find(row=>row.sourceId==='hagenow-participation');
 assert.ok(api);const page=new URL(api.root);page.searchParams.set('offset','100');
 assert.equal(registeredRobotsAuditApplies(api,page.href),true);
 const filterKey=[...page.searchParams.keys()].find(key=>/filter/i.test(key));assert.ok(filterKey);
 page.searchParams.append(filterKey,'different-municipality');assert.equal(registeredRobotsAuditApplies(api,page.href),false);
 const audit=audits.find(row=>row.sourceId===scope.sourceId)!;
 const evidence=registeredRobotsEvidence(audit,root,new Date().toISOString());assert.deepEqual(readRegisteredRobotsAudit([evidence],root),audit);
 assert.equal(readRegisteredRobotsAudit([{...evidence,valueSha256:'0'.repeat(64)}],root),undefined);
 assert.equal(readRegisteredRobotsAudit([evidence],'https://unregistered.example/'),undefined);
});

test('registered blocked robots retain unknown origin, honour reservations/opt-outs, expire at seven days and decode with real legacy codecs',async t=>{
 const registryFixture=await createOperatorRegistryFixture(t,{value:await registry()}),seen:Array<{host:string;path:string}>=[];
 const pdf=metadataPdf(reservedXmp);
 const server=createServer((req,res)=>{
  assert.equal(req.headers.username,undefined);assert.equal(req.headers.password,undefined);
  const host=req.headers.host??'',path=req.url??'';seen.push({host,path});
  if(path==='/robots.txt'){res.writeHead(200,{'content-type':'text/plain'});res.end('User-agent: *\nDisallow: /\n');return;}
  if(path==='/.well-known/tdmrep.json'){res.writeHead(404);res.end();return;}
  if(path==='/reserved.pdf'){res.writeHead(200,{'content-type':'application/pdf'});res.end(pdf);return;}
  if(path==='/login'){res.writeHead(401,{'www-authenticate':'fixture'});res.end();return;}
  res.writeHead(200,{'content-type':'text/html',...(path==='/reserved'?{'tdm-reservation':'1'}:{})});
  const next=path==='/linked/documentation.html'?'next-documentation.html':'documentation.html';
  res.end(`<html><body>Unclassified synthetic fixture publication<a href="/linked/${next}">Dokument</a></body></html>`);
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>(done=>server.close(()=>done())));
 const address=server.address();assert.ok(address&&typeof address!=='string');
 t.mock.method(https,'request',(url:URL,options:RequestOptions,callback:(response:IncomingMessage)=>void)=>httpRequest({hostname:'127.0.0.1',port:address.port,path:url.pathname+url.search,method:options.method,headers:{...options.headers,Host:url.hostname},agent:false},callback));
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const seam=PoliteFetcher.prototype as unknown as WireFixture;
 t.mock.method(seam,'wire',async function(this:WireFixture,url:URL,method:'GET'|'POST',body:string|undefined,previous:FetchObservation|undefined,operation?:NativePublicOperation){return this.wireRequest(url,method,body,previous,{address:'127.0.0.1',family:4},nativePublicRequestHeaders(url,method,body,operation));});
 const inspection={...fixturePolicyInspection,async origin(input:Parameters<typeof fixturePolicyInspection.origin>[0]){
  return {classification:'unknown' as const,method:'rules' as const,classifierVersion:DOCUMENT_ORIGIN_CLASSIFIER_VERSION,url:input.url,sha256:sha256(input.bytes),classifiedAt:new Date().toISOString(),evidence:[]};
 }};
 async function lane(name:string,registered=true){
  // Public acquisition has its own real fixture realm so the old-tool probe is
  // not testing unrelated R1 operator-configuration binding codecs.
  const options=await politeTestOptions({cacheDir:join(registryFixture.root,name),minDelayMs:0}),fetcher=new PoliteFetcher({...options,fixtureInspection:inspection});
  if(registered)fetcher.registerRegisteredSources(registryFixture.admitted.registry,registryFixture.registrySha256);
  return {fetcher,options};
 }
 const without=await lane('unconfigured',false);
 await assert.rejects(without.fetcher.fetch(root,requestOptions),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='document_excluded');
 const {fetcher,options}=await lane('registered'),response=await fetcher.fetch(root,{...requestOptions,ownerRobotsOverride:undefined});
 assert.equal(response.policy?.robots.state,'blocked');assert.equal(response.policy?.robotsStatus,'disallowed');
 assert.equal(response.policy?.override,'owner-approved 2026-10-11');assert.equal(response.policy?.documentOrigin?.classification,'unknown');
 assert.ok(effectiveSourcePermission(response.policy!,response));assert.ok(ContentFreeSourcePolicySchema.safeParse(response.policy).success);
 const audit=readRegisteredRobotsAudit(response.policy!.tdm.evidence,response.url);assert.equal(audit?.decisionId,REGISTERED_SOURCE_ROBOTS_DECISION.id);assert.equal(audit?.registrySha256,registryFixture.registrySha256);
 const gazette=registryFixture.admitted.registry.municipalities.find(row=>row.id===scope.municipalityId)!.sources.find(row=>row.id==='ratzeburg-gazette')!;
 const gazetteOptions={...requestOptions,registeredSourceUrl:gazette.url!,registeredSourceId:gazette.id};
 const parent=await fetcher.fetch(gazette.url!,gazetteOptions),linked=root+'linked/documentation.html';
 await assert.rejects(fetcher.fetch(linked,gazetteOptions),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='document_excluded');
 await fetcher.recordDiscoveredSourceLinks(gazetteOptions,parent,discoverDocumentLinks(await readFile(parent.localPath,'utf8'),parent.url).map(row=>row.url));
 const child=await fetcher.fetch(linked,gazetteOptions);assert.equal(readRegisteredRobotsAudit(child.policy!.tdm.evidence,child.url)?.discovery?.from,parent.url);
 const resumed=new PoliteFetcher({...options,fixtureInspection:inspection});resumed.registerRegisteredSources(registryFixture.admitted.registry,registryFixture.registrySha256);
 await resumed.recordDiscoveredSourceLinks(gazetteOptions,child,discoverDocumentLinks(await readFile(child.localPath,'utf8'),child.url).map(row=>row.url));
 const grandchild=await resumed.fetch(root+'linked/next-documentation.html',gazetteOptions),witness=readRegisteredRobotsAudit(grandchild.policy!.tdm.evidence,grandchild.url);
 assert.equal(witness?.discovery?.from,child.url);assert.deepEqual(witness?.discovery?.anchor,{url:parent.url,sha256:parent.sha256});
 for(const path of ['reserved','reserved.pdf'])await assert.rejects(fetcher.fetch(root+path,requestOptions),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='document_excluded');
 await assert.rejects(fetcher.fetch(root+'login',requestOptions),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='access_barrier');
 const outside=await lane('outside');await assert.rejects(outside.fetcher.fetch('https://unregistered.example/',{...requestOptions,registeredSourceUrl:'https://unregistered.example/',ownerRobotsOverride:ownerRobotsOverrideFor('https://unregistered.example/')??undefined}),(error:unknown)=>error instanceof PoliteFetchError&&error.failure==='document_excluded');
 assert.equal(sourcePolicyValidityMs(response.policy!,response,scope),REGISTERED_SOURCE_POLICY_VALIDITY_MS);
 assert.equal(sourcePolicyValidityMs({...response.policy!,tdm:{...response.policy!.tdm,evidence:[]}},response,{...scope,sourceId:'unregistered'}),PUBLIC_SOURCE_POLICY_VALIDITY_MS);
 const clocks=[response.checkedAt,response.policy!.robots.checkedAt!,...response.policy!.tdm.evidence.map(row=>row.checkedAt!)],start=Math.min(...clocks.map(Date.parse));
 const expiresAt=sourcePolicyExpiresAt(response.policy!,response.checkedAt,response,scope);assert.equal(Date.parse(expiresAt),start+REGISTERED_SOURCE_POLICY_VALIDITY_MS);
 const created=await createPolicyReceipt({source:{url:response.url,sha256:response.sha256,mimeType:response.mimeType},scope,sourcePolicy:response.policy,permission:{kind:'facts_with_attribution'},checkedAt:new Date().toISOString(),expiresAt},options.ownerPolicyLane);
 assert.ok(PolicyReceiptSchema.safeParse(created.receipt).success);
 assert.equal(PolicyReceiptSchema.safeParse({...created.receipt,expiresAt:new Date(start+REGISTERED_SOURCE_POLICY_VALIDITY_MS+1).toISOString()}).success,false);
 // Actual released tag code, not a permissive mock schema.
 const legacyRoot=join(registryFixture.root,'legacy-src');await cp(join(packageRoot,'src'),legacyRoot,{recursive:true});
 await symlink(join(packageRoot,'node_modules'),join(registryFixture.root,'node_modules'),'dir');
 for(const name of ['civic-opt-out.ts','civic-docker.ts','source-policy.ts','district-schema.ts','source-observation.ts'])await writeFile(join(legacyRoot,name),execFileSync('/usr/bin/git',['show',`0.3.2:stadtstack-data/src/${name}`],{cwd:packageRoot,maxBuffer:4*1024*1024}));
 const legacySchema=await import(pathToFileURL(join(legacyRoot,'district-schema.ts')).href),legacyObservation=await import(pathToFileURL(join(legacyRoot,'source-observation.ts')).href),legacyPolicy=await import(pathToFileURL(join(legacyRoot,'civic-opt-out.ts')).href);
 assert.ok(legacySchema.ContentFreeSourcePolicySchema.safeParse(response.policy).success);
 assert.ok(legacyObservation.SourceObservationSchema.safeParse(JSON.parse(await readFile(response.observationPath,'utf8'))).success);
 assert.equal((await legacyPolicy.recoverManagedSourceScratch(options.ownerPolicyLane)).status,'complete');
 assert.equal((await recoverManagedSourceScratch(options.ownerPolicyLane)).status,'complete');
 let now=start+6*24*60*60*1000;t.mock.method(Date,'now',()=>now);
 await recheckPolicyReceipt(created.receipt,{...options.ownerPolicyLane,evaluationAt:new Date(now).toISOString()});
 // Cached robots/TDM evidence remains genuine and is not re-requested at +6d.
 const policyCount=seen.filter(row=>row.path==='/robots.txt'||row.path==='/.well-known/tdmrep.json').length;
 await fetcher.fetch(root+'six-days',requestOptions);
 assert.equal(seen.filter(row=>row.path==='/robots.txt'||row.path==='/.well-known/tdmrep.json').length,policyCount);
 await recordHostOptOut({host:'www.ratzeburg.de',reason:'rights_holder_objection',reference:'synthetic fixture'},options.ownerPolicyLane);
 await assert.rejects(recheckPolicyReceipt(created.receipt,{...options.ownerPolicyLane,evaluationAt:new Date(now).toISOString()}));
 const requests=seen.length;await assert.rejects(fetcher.fetch(root,requestOptions));assert.equal(seen.length,requests);
 now=start+REGISTERED_SOURCE_POLICY_VALIDITY_MS+1000;
 await assert.rejects(recheckPolicyReceipt(created.receipt,{...options.ownerPolicyLane,evaluationAt:new Date(now).toISOString()}),/expired/);
});
