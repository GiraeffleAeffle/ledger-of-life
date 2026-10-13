import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest,type IncomingMessage,type RequestOptions} from 'node:http';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {once} from 'node:events';
import {mkdtemp,readFile,writeFile,rm,chmod,readdir,symlink} from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import {join,basename,dirname} from 'node:path';
import {tmpdir,userInfo} from 'node:os';
import {inspect} from 'node:util';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {PoliteFetcher,PoliteFetchError,type FetchObservation} from '../../src/polite-fetch.ts';
import type {FetchedDocument,PoliteFetcherOptions} from '../../src/polite-fetch.ts';
import {nativePublicRequestHeaders,type NativePublicOperation} from '../../src/district-native-request.ts';
import {GENESIS_OWNER_CREDENTIAL_PATH,GENESIS_CREDENTIAL_MAX_BYTES,type GenesisOwnerCredentials} from '../../src/genesis-owner-credentials.ts';
import {APPROVED_OWNER_GENESIS_ACCESS,effectiveSourcePermission} from '../../src/source-policy.ts';
import {ContentFreeSourcePolicySchema} from '../../src/district-schema.ts';
import {createPolicyReceipt} from '../../src/district-policy-receipt.ts';
import {DistrictCas} from '../../src/district-cas.ts';
import {DistrictJobStore,migrateDistrictJobs} from '../../src/district-jobs.ts';
import {persistR1Representation} from '../../src/district-r1-state.ts';
import {digest} from '../../src/district-adapter-contract.ts';
import {politeTestOptions} from './polite-lane.ts';
import {fixturePolicyInspection} from './polite-inspection.ts';
import {genesisOwnerAccountRoot,readGenesisOwnerRepresentation} from '../../src/genesis-owner-acquisition.ts';
import {HttpObservationProofSchema} from '../../src/district-http-observation.ts';
import {SourceObservationSchema} from '../../src/source-observation.ts';
import {assertManagedSourceReadable,assertManagedRawSourceBinding,recoverManagedSourceScratch,recordHostOptOut} from '../../src/civic-opt-out.ts';

const token='fixture-secret-token-628104',username='fixture-owner-user-628104',password='fixture-owner-password-628104';
const endpoint='https://www.regionalstatistik.de/genesisws/rest/2020/data/table';
const body=new URLSearchParams({name:'12411-02-03',area:'free',language:'de',regionalvariable:'GEMEIN',regionalkey:'12064472',startyear:'2024',endyear:'2024',compress:'false',transpose:'false',job:'false'}).toString();
function noSecrets(bytes:string|Buffer){for(const secret of [token,username,password])assert.ok(!Buffer.from(bytes).includes(Buffer.from(secret)),'Credential bytes escaped the host boundary');}
async function scanArtifacts(root:string){for(const entry of await readdir(root,{withFileTypes:true})){const path=join(root,entry.name);if(entry.isDirectory())await scanArtifacts(path);else if(entry.isFile())noSecrets(await readFile(path));}}
interface Response {status:number;headers:Record<string,string|undefined>;body:Buffer}
interface Seam {
 wire(url:URL,method:'GET'|'POST',body:string|undefined,previous:FetchObservation|undefined,operation?:NativePublicOperation,credentials?:GenesisOwnerCredentials):Promise<Response>;
 wireRequest(url:URL,method:'GET'|'POST',body:string|undefined,previous:FetchObservation|undefined,pinned:{address:string;family:number},headers:Record<string,string>):Promise<Response>;
}

test('fixture-reviewed owner entry exercises headers, holds, persisted receipts and redirect refusal',async t=>{
 assert.equal(APPROVED_OWNER_GENESIS_ACCESS[0]?.id,'fixture-owner-genesis');
 const root=await mkdtemp(join(tmpdir(),'genesis-reviewed-artifacts-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const seen:Array<{host:string;path:string;authenticated:boolean}>=[];
 let reply:'success'|'cross'|'same'|'echo'|'header-echo'|'unauthorized'='success',kind:'token'|'password'='token';
 const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));noSecrets(Buffer.concat(chunks));noSecrets(req.url??'');
  const host=req.headers.host??'',path=req.url??'',isData=host==='www.regionalstatistik.de'&&/^\/genesisws\/rest\/2020\/data\/table(?:file)?$/.test(path);
  if(isData){assert.ok(req.headers.username===(kind==='token'?token:username),'Owner username header mismatch');assert.ok(req.headers.password===(kind==='token'?'':password),'Owner password header mismatch');}
  else {assert.ok(req.headers.username===undefined||req.headers.username==='GAST','Unexpected account header');assert.ok(req.headers.password===undefined||req.headers.password==='GAST','Unexpected account header');}
  seen.push({host,path,authenticated:isData});
  if(path==='/robots.txt'||path==='/.well-known/tdmrep.json'){res.writeHead(404);res.end();return;}
  if(isData&&reply==='cross'){res.writeHead(307,{location:'https://other.de/stolen'});res.end();return;}
  if(isData&&reply==='same'){res.writeHead(307,{location:'https://www.regionalstatistik.de/genesisws/rest/2020/data/tablefile'});res.end();return;}
  if(isData&&reply==='unauthorized'){res.writeHead(401,{'www-authenticate':'fixture'});res.end();return;}
  res.writeHead(200,{'content-type':'application/json',...(isData&&reply==='header-echo'?{etag:token}:{})});
  res.end(JSON.stringify({value:isData&&reply==='echo'?token:17}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>(done=>server.close(()=>done())));
 const address=server.address();assert.ok(address&&typeof address!=='string');
 // Exercise the production wireRequest HTTP streaming/header implementation, but
 // replace only TLS routing to our loopback fixture. Live wire's authority/DNS
 // gate is not bypassed or granted by the fixture authority.
 t.mock.method(https,'request',(url:URL,options:RequestOptions,callback:(response:IncomingMessage)=>void)=>httpRequest({hostname:'127.0.0.1',port:address.port,path:url.pathname+url.search,method:options.method,headers:{...options.headers,Host:url.hostname},agent:false},callback));
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const fetchers:Array<{fetcher:PoliteFetcher;stateDir:string;cache:string;options:PoliteFetcherOptions}>=[];
 let failWire=false;
 t.mock.method(PoliteFetcher.prototype as unknown as Seam,'wire',async function(this:Seam,url:URL,method:'GET'|'POST',requestBody:string|undefined,previous:FetchObservation|undefined,operation:NativePublicOperation|undefined,credentials:GenesisOwnerCredentials|undefined){
  if(failWire&&credentials)throw new Error(token,{cause:new Error(password)});
  const headers=credentials?credentials.requestHeaders(url,method,requestBody,operation):nativePublicRequestHeaders(url,method,requestBody,operation);
  return this.wireRequest(url,method,requestBody,previous,{address:'127.0.0.1',family:4},headers);
 });
 async function lane(name:string){
  const cache=join(root,name),options=await politeTestOptions({cacheDir:cache}),fetcher=new PoliteFetcher({...options,fixtureInspection:fixturePolicyInspection});
  fetchers.push({fetcher,stateDir:options.ownerPolicyLane!.stateDir!,cache,options});
  return {fetcher,options,cache};
 }
 const successes:Array<{source:FetchedDocument;options:PoliteFetcherOptions;cache:string}>=[];
 for(const credentialKind of ['token','password'] as const){
  kind=credentialKind;reply='success';await writeFile(GENESIS_OWNER_CREDENTIAL_PATH,JSON.stringify(kind==='token'?{token}:{username,password}),{mode:0o600});await chmod(GENESIS_OWNER_CREDENTIAL_PATH,0o600);
  const {fetcher,options,cache}=await lane(kind),source=await fetcher.fetch(endpoint+(kind==='password'?'file':''),{method:'POST',body,publicOperation:'genesis_guest'});
  assert.equal(source.policy?.access,'authenticated_owner_account');assert.deepEqual(source.policy?.ownerAccountAccess,{decisionId:'fixture-owner-genesis',credentialKind:kind});
  assert.ok(ContentFreeSourcePolicySchema.safeParse(source.policy).success);assert.ok(effectiveSourcePermission(source.policy!,source));
  const observation=await readFile(source.observationPath);noSecrets(observation);assert.ok(observation.includes(Buffer.from('authenticated_owner_account')));
  const marker=JSON.parse(await readFile(join(genesisOwnerAccountRoot(cache),'.civic-acquisition-lane.json'),'utf8'));assert.equal(marker.kind,'artifacts');
  const admitted=await readGenesisOwnerRepresentation(cache,source,options.ownerPolicyLane);assert.equal(digest(admitted.bytes),source.sha256);
  await fetcher.assertSourceBindingsAllowed([{url:source.url,sha256:source.sha256,observationPath:source.observationPath,independentAllowed:true}]);
  for(const name of await readdir(join(cache,'observations'))){const publicObservation=JSON.parse(await readFile(join(cache,'observations',name),'utf8'));assert.notEqual(publicObservation.policy.access,'authenticated_owner_account');assert.equal(publicObservation.policy.ownerAccountAccess,undefined);}
  successes.push({source,options,cache});
  await fetcher.fetch('https://other.de/public.json');await fetcher.fetch('https://www.regionalstatistik.de/genesisws/rest/2020/metadata/table',{method:'POST',body,publicOperation:'genesis_guest'});
 }
 kind='token';await writeFile(GENESIS_OWNER_CREDENTIAL_PATH,JSON.stringify({token}));
 for(const [name,mode,failure] of [['cross-redirect','cross','cross_host_redirect'],['same-redirect','same','invalid_redirect'],['response-echo','echo','access_barrier'],['header-echo','header-echo','access_barrier'],['rejected-account','unauthorized','access_barrier']] as const){
  reply=mode;const {fetcher}=await lane(name),before=seen.length;
  await assert.rejects(fetcher.fetch(endpoint,{method:'POST',body,publicOperation:'genesis_guest'}),(error:unknown)=>{assert.ok(error instanceof PoliteFetchError);assert.equal(error.failure,failure);assert.equal(error.cause,undefined);noSecrets(inspect(error));return true;});
  assert.equal(seen.slice(before).filter(item=>item.path==='/stolen').length,0);
  assert.equal(seen.slice(before).filter(item=>item.authenticated).length,1);
 }
 reply='success';
 for(const name of ['missing','file-permissions','parent-permissions','symlink','oversize','invalid-json']){
  await rm(GENESIS_OWNER_CREDENTIAL_PATH,{force:true});await chmod(join(process.cwd(),'credentials'),0o700);
  if(name==='symlink')await symlink(join(root,'absent'),GENESIS_OWNER_CREDENTIAL_PATH);
  else if(name!=='missing')await writeFile(GENESIS_OWNER_CREDENTIAL_PATH,name==='oversize'?'x'.repeat(GENESIS_CREDENTIAL_MAX_BYTES+1):name==='invalid-json'?`{"token":"${token}"`:JSON.stringify({token}),{mode:0o600});
  if(name==='file-permissions')await chmod(GENESIS_OWNER_CREDENTIAL_PATH,0o644);
  if(name==='parent-permissions')await chmod(join(process.cwd(),'credentials'),0o755);
  const {fetcher}=await lane(name),before=seen.length;
  await assert.rejects(fetcher.fetch(endpoint,{method:'POST',body,publicOperation:'genesis_guest'}),(error:unknown)=>{assert.ok(error instanceof PoliteFetchError);assert.equal(error.failure,'credential_unavailable');assert.equal(error.policy?.access,'authentication');noSecrets(inspect(error));return true;});
  assert.equal(seen.slice(before).filter(item=>item.authenticated).length,0);
 }
 await chmod(join(process.cwd(),'credentials'),0o700);await writeFile(GENESIS_OWNER_CREDENTIAL_PATH,JSON.stringify({token}));
 const errorLane=await lane('error-redaction');
 failWire=true;
 await assert.rejects(errorLane.fetcher.fetch(endpoint,{method:'POST',body,publicOperation:'genesis_guest'}),(error:unknown)=>{assert.ok(error instanceof PoliteFetchError);assert.equal(error.failure,'network_error');assert.equal(error.cause,undefined);noSecrets(inspect(error));return true;});
 failWire=false;
 const denialRoot=genesisOwnerAccountRoot(errorLane.cache),denialName=(await readdir(join(denialRoot,'observations')))[0],denialPath=join(denialRoot,'observations',denialName),denialBytes=await readFile(denialPath),denial=JSON.parse(denialBytes.toString('utf8'));
 await assertManagedSourceReadable(denialPath,errorLane.options.ownerPolicyLane); // Custody only.
 assert.equal(SourceObservationSchema.safeParse(denial).success,false);
 assert.equal(HttpObservationProofSchema.safeParse({observationId:denialName,receiptSha256:digest(denialBytes),bytes:denialBytes.toString('utf8')}).success,false);
 const denialBinding={kind:'http_observation' as const,url:endpoint,sourceSha256:digest(denialBytes),observationId:denialName,receiptSha256:digest(denialBytes)};
 await assert.rejects(errorLane.fetcher.assertSourceBindingsAllowed([{url:endpoint,sha256:denialBinding.sourceSha256,observationPath:denialPath,independentAllowed:false}]));
 await assert.rejects(assertManagedRawSourceBinding(denialPath,denialBinding,errorLane.options.ownerPolicyLane));
 const inventory=JSON.parse(await readFile(join(errorLane.options.ownerPolicyLane!.stateDir!,'inventory.json'),'utf8'));
 assert.ok(inventory.entries.filter((entry:{rootId:string})=>entry.rootId===digest(denialRoot)).every((entry:{independentAllowed:boolean})=>!entry.independentAllowed));
 // Real interruption after the body write but before successful observation
 // retention; no clock, receipt or successful observation is synthesized.
 const interrupted=await lane('interrupted'),originalWrite=fsPromises.writeFile;let interrupt=true;
 const writeMock=t.mock.method(fsPromises,'writeFile',async function(...args:Parameters<typeof fsPromises.writeFile>){
  if(interrupt&&typeof args[0]==='string'&&dirname(args[0])===join(genesisOwnerAccountRoot(interrupted.cache),'observations')){interrupt=false;throw Error('Fixture interrupted observation write');}
  return originalWrite(...args);
 });syncBuiltinESMExports();
 await assert.rejects(interrupted.fetcher.fetch(endpoint,{method:'POST',body,publicOperation:'genesis_guest'}),PoliteFetchError);
 writeMock.mock.restore();syncBuiltinESMExports();
 assert.equal((await recoverManagedSourceScratch(interrupted.options.ownerPolicyLane)).status,'complete');
 // Exercise the ACTUAL immutable tag reader against this disposable realm.
 // This test intentionally loads modules materialized from the immutable tag
 // into the disposable snapshot; these files do not exist at typecheck time.
 const legacy=await import(new URL('../../legacy-src/civic-opt-out.ts',import.meta.url).href);
 const legacySchema=await import(new URL('../../legacy-src/district-schema.ts',import.meta.url).href);
 assert.equal(legacySchema.ContentFreeSourcePolicySchema.safeParse(successes[0].source.policy).success,false);
 for(const item of fetchers){
  assert.equal((await recoverManagedSourceScratch(item.options.ownerPolicyLane)).status,'complete');
  assert.equal((await legacy.recoverManagedSourceScratch(item.options.ownerPolicyLane)).status,'complete');
 }
 // Real canonical policy receipts and, when the coordinated gate supplies PG,
 // real representation persistence through the existing R1 CAS/PG writer.
 const connectionString=process.env.DISTRICT_TEST_DATABASE_URL;
 let pool:Pool|undefined,admin:Pool|undefined,database:string|undefined;
 if(connectionString){
  const url=new URL(connectionString),host=url.searchParams.get('host');
  assert.ok(['localhost','127.0.0.1','::1',''].includes(url.hostname)&&(!host||host.startsWith('/')||['localhost','127.0.0.1','::1'].includes(host))&&url.pathname!=='/civic_r1','Non-fixture database rejected');
  admin=new Pool({connectionString,user:userInfo().username,max:2});database='genesis_auth_test_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE "'+database+'"');url.pathname='/'+database;pool=new Pool({connectionString:url.href,user:userInfo().username,max:2});await migrateDistrictJobs(pool);
 }
 try{
  for(const {source,options,cache} of successes){
   const scope={publisherId:'fixture-regionalstatistik',sourceId:'regionalstatistik-genesis',municipalityId:'strausberg',ags:'12064472',tenant:null,observationWindow:'2024'},checkedAt=new Date().toISOString();
   const proof=await createPolicyReceipt({source:{url:source.url,sha256:source.sha256,mimeType:source.mimeType},sourcePolicy:source.policy,permission:{kind:'facts_with_attribution'},scope,checkedAt,expiresAt:new Date(Date.now()+60_000).toISOString()},options.ownerPolicyLane);
   noSecrets(JSON.stringify(proof));
   await assert.rejects(createPolicyReceipt({source:proof.receipt.source,sourcePolicy:source.policy,permission:{kind:'official_work'},scope,checkedAt,expiresAt:proof.receipt.expiresAt},options.ownerPolicyLane),/facts_with_attribution only/);
   if(pool){
    const observationBytes=await readFile(source.observationPath),cas=new DistrictCas(join(root,'cas-'+source.policy!.ownerAccountAccess!.credentialKind)),store=new DistrictJobStore(pool);
    const input={bytes:await readFile(source.localPath),receipt:proof.receipt,request:{url:source.url,method:'POST' as const,body,contentType:'application/x-www-form-urlencoded;charset=UTF-8'},retrievedAt:source.retrievedAt,fetchedAt:source.checkedAt,sourceVersion:null,redirectChain:[],httpObservation:{observationId:basename(source.observationPath),receiptSha256:digest(observationBytes),bytes:observationBytes}};
    await persistR1Representation(store,cas,input,options.ownerPolicyLane);
    await assert.rejects(persistR1Representation(store,cas,{...input,httpObservation:{observationId:denialName,receiptSha256:digest(denialBytes),bytes:denialBytes}},options.ownerPolicyLane));
   }
  }
  if(pool){const tables=await pool.query<{table_name:string}>("SELECT table_name FROM information_schema.tables WHERE table_schema='district_pipeline' AND table_type='BASE TABLE'");for(const {table_name} of tables.rows){assert.match(table_name,/^[a-z][a-z0-9_]*$/);noSecrets(JSON.stringify((await pool.query('SELECT * FROM district_pipeline."'+table_name+'"')).rows));}}
  await scanArtifacts(root);for(const {stateDir} of fetchers)await scanArtifacts(stateDir);
  for(const {source,options,cache} of successes){
   const outcome=await legacy.recordHostOptOut({host:'www.regionalstatistik.de',reason:'rights_holder_objection',reference:'fixture-genesis-account-purge'},options.ownerPolicyLane);
   assert.equal(outcome.purge.status,'purged');assert.ok(outcome.purge.deletedFiles>=2);
   await assert.rejects(readFile(source.localPath),{code:'ENOENT'});await assert.rejects(readFile(source.observationPath),{code:'ENOENT'});
   assert.equal((await readdir(join(genesisOwnerAccountRoot(cache),'observations'))).length,0);
   assert.equal((await recordHostOptOut({host:'www.regionalstatistik.de',reason:'rights_holder_objection',reference:'fixture-genesis-account-purge'},options.ownerPolicyLane)).purge.status,'purged');
  }
  const denialPurge=await legacy.recordHostOptOut({host:'www.regionalstatistik.de',reason:'rights_holder_objection',reference:'fixture-genesis-denial-purge'},errorLane.options.ownerPolicyLane);
  assert.equal(denialPurge.purge.status,'purged');await assert.rejects(readFile(denialPath),{code:'ENOENT'});
 }finally{await pool?.end();if(admin&&database)await admin.query('DROP DATABASE "'+database+'" WITH (FORCE)');await admin?.end();}
 noSecrets(JSON.stringify(seen));noSecrets(JSON.stringify(process.argv));noSecrets(JSON.stringify(process.env));
});
