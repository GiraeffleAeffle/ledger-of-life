import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,mkdir,writeFile,readFile,rm,symlink,cp,readdir} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir,userInfo} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {inspect} from 'node:util';
import {readGenesisOwnerCredentials,GENESIS_CREDENTIAL_MAX_BYTES,GenesisCredentialUnavailable,GenesisOwnerCredentials,GenesisResponseScreeningHold,GENESIS_RESPONSE_SCREEN_LIMITS} from '../src/genesis-owner-credentials.ts';
import {APPROVED_OWNER_GENESIS_ACCESS,ownerGenesisAccessFor,effectiveSourcePermission} from '../src/source-policy.ts';
import {ContentFreeSourcePolicySchema} from '../src/district-schema.ts';
import {PoliteFetcher,PoliteFetchError,type FetchObservation} from '../src/polite-fetch.ts';
import {politeTestOptions} from './fixtures/polite-lane.ts';
import {fixturePolicyInspection} from './fixtures/polite-inspection.ts';
import {deflatedZip,unicodeEscape,percentEscape} from './fixtures/genesis-echo.ts';

const token='fixture-secret-token-628104',username='fixture-owner-user-628104',password='fixture-sécure-password-628104';
const endpoint='https://www.regionalstatistik.de/genesisws/rest/2020/data/table';
const body=new URLSearchParams({name:'12411-02-03',area:'free',language:'de',regionalvariable:'GEMEIN',regionalkey:'12064472',startyear:'2024',endyear:'2024',compress:'false',transpose:'false',job:'false'}).toString();
function noSecrets(bytes:string|Buffer){for(const secret of [token,username,password])assert.ok(!Buffer.from(bytes).includes(Buffer.from(secret)),'Credential bytes escaped the host boundary');}
async function scanArtifacts(root:string){for(const entry of await readdir(root,{withFileTypes:true})){const path=join(root,entry.name);if(entry.isDirectory())await scanArtifacts(path);else if(entry.isFile())noSecrets(await readFile(path));}}

test('empty approval list preserves the GENESIS guest 401 hold and rejects forged account audit',async t=>{
 assert.equal(APPROVED_OWNER_GENESIS_ACCESS.length,0);assert.equal(ownerGenesisAccessFor(endpoint),null);
 const root=await mkdtemp(join(tmpdir(),'genesis-no-decision-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const fetcher=new PoliteFetcher({...await politeTestOptions({cacheDir:root}),fixtureInspection:fixturePolicyInspection});
 interface Seam {wire(url:URL,method:string,body:string|undefined,previous:FetchObservation|undefined,operation:string|undefined,credentials:unknown):Promise<{status:number;headers:Record<string,string>;body:Buffer}>}
 t.mock.method(fetcher as unknown as Seam,'wire',async(url:URL,_method:string,_body:string|undefined,_previous:unknown,_operation:unknown,credentials:unknown)=>{
  assert.equal(credentials,undefined);
  return {status:url.pathname.includes('/data/')?401:404,headers:{},body:Buffer.alloc(0)};
 });
 await assert.rejects(fetcher.fetch(endpoint,{method:'POST',body,publicOperation:'genesis_guest'}),(error:unknown)=>{assert.ok(error instanceof PoliteFetchError);assert.equal(error.failure,'access_barrier');assert.equal(error.policy?.access,'authentication');noSecrets(inspect(error));return true;});
 const policy={robots:{state:'allowed' as const,url:'https://www.regionalstatistik.de/robots.txt'},tdm:{state:'not_declared' as const,evidence:[]},access:'authenticated_owner_account' as const,ownerAccountAccess:{decisionId:'fixture-unapproved',credentialKind:'token' as const},legalClassification:'not_assessed' as const,publication:'facts_with_attribution_only' as const};
 assert.equal(ContentFreeSourcePolicySchema.safeParse(policy).success,false);assert.equal(effectiveSourcePermission(policy,{url:endpoint,sha256:'a'.repeat(64)}),false);
 await scanArtifacts(root);
});

test('trusted file reader accepts only private regular bounded owner credential files',async t=>{
 const root=await mkdtemp(join(tmpdir(),'genesis-file-fixture-'));t.after(()=>rm(root,{recursive:true,force:true}));await chmod(root,0o700);
 const path=join(root,'credentials.json');
 for(const value of [{token},{username,password}]){
  await writeFile(path,JSON.stringify(value),{mode:0o600});await chmod(path,0o600);
  const credentials=await readGenesisOwnerCredentials(path),headers=credentials.requestHeaders(new URL(endpoint),'POST',body,'genesis_guest');
  assert.ok(headers.username===('token' in value?token:username),'Username header mismatch');assert.ok(headers.password===('token' in value?'':password),'Password header mismatch');
  noSecrets(JSON.stringify(credentials));noSecrets(inspect(credentials));
  for(const url of ['https://other.de/genesisws/rest/2020/data/table','http://www.regionalstatistik.de/genesisws/rest/2020/data/table','https://www.regionalstatistik.de/genesisws/rest/2020/metadata/table','https://www.regionalstatistik.de/genesisws/rest/2020/data/table?x=1'])assert.throws(()=>credentials.requestHeaders(new URL(url),'POST',body,'genesis_guest'),GenesisCredentialUnavailable);
 }
 const reject=async()=>assert.rejects(readGenesisOwnerCredentials(path),(error:unknown)=>{assert.ok(error instanceof GenesisCredentialUnavailable);noSecrets(inspect(error));assert.equal(error.cause,undefined);return true;});
 await chmod(path,0o644);await reject();await chmod(path,0o600);await chmod(root,0o755);await reject();await chmod(root,0o700);
 await rm(path);await symlink(join(root,'missing-target'),path);await reject();await rm(path);
 await mkdir(path);await reject();await rm(path,{recursive:true});
 await writeFile(path,'x'.repeat(GENESIS_CREDENTIAL_MAX_BYTES+1),{mode:0o600});await reject();
 for(const value of [{token,username,password},{token:17},{token:''},{username,password:''},{username:'GAST',password:'GAST'},[],{token,extra:'no'},null]){await writeFile(path,JSON.stringify(value));await reject();}
 await writeFile(path,`{"token":"${token}"`);await reject();await rm(path);await reject();
 const linked=join(root,'linked');await symlink(root,linked);await assert.rejects(readGenesisOwnerCredentials(join(linked,'credentials.json')),GenesisCredentialUnavailable);
});

test('response screening decodes every JSON string, ZIP member and retained header before admission',()=>{
 const secret='sécure-"password',credentials=new GenesisOwnerCredentials('password',username,secret);
 const hold=(bytes:Buffer,mime='application/json',headers:Record<string,string>={})=>{
  assert.throws(()=>credentials.screenResponse(bytes,{'content-type':mime,...headers},200),(error:unknown)=>{
   assert.ok(error instanceof GenesisResponseScreeningHold);assert.equal(error.cause,undefined);
   noSecrets(inspect(error));assert.ok(!inspect(error).includes(secret),'Screening error exposed private material');return true;
  });
 };
 for(const value of [username,secret]){
  for(const mixed of [false,true]){
   const encoded=unicodeEscape(value,mixed);
   hold(Buffer.from(`{"Status":{"Content":"${encoded}"}}`));
   hold(Buffer.from(`{"${encoded}":17}`));
   hold(Buffer.from(`{"value":"${encoded}","value":17}`));
   hold(deflatedZip({'table.csv':'value;number\nsafe;17\n','ignored.json':`{"value":"${encoded}"}`}), 'application/zip');
  }
  hold(deflatedZip({'table.csv':`value;number\n"${value.replaceAll('"','""')}";17\n`}), 'application/zip');
  hold(deflatedZip({[percentEscape(value)+'.txt']:'safe'}),'application/zip');
  for(const passes of [1,3,8])hold(Buffer.from('{"value":17}'),'application/json',{location:'https://other.de/'+percentEscape(value,passes)});
 }
 hold(Buffer.from('{"value":17}'),'application/json',{etag:Buffer.from(secret).toString('latin1')});
 const quoteSecret='"quote"password',quoted=new GenesisOwnerCredentials('token',quoteSecret,'');
 assert.throws(()=>quoted.screenResponse(Buffer.from('value\n"""quote""password"\n'),{'content-type':'text/csv'},200),GenesisResponseScreeningHold);
 for(const [bytes,mime] of [[Buffer.from('{"malformed":'),'application/json'],[deflatedZip({'table.csv':'safe','ignored.bin':'safe'}),'application/zip'],[Buffer.from('%PDF-unknown'),'text/plain'],[Buffer.from([0,1,2]),'application/octet-stream'],[Buffer.from('safe'),'image/png'],[deflatedZip({'table.csv':'a'.repeat(100000)}),'application/zip']] as const)hold(bytes,mime);
 hold(Buffer.alloc(GENESIS_RESPONSE_SCREEN_LIMITS.inputBytes+1),'text/plain');
 hold(Buffer.from('{"value":17}'),'application/json',{etag:'x'.repeat(GENESIS_RESPONSE_SCREEN_LIMITS.headerBytes+1)});
 hold(Buffer.from('{"value":17}'),'application/json',{location:percentEscape('ordinary',9)});
 credentials.screenResponse(Buffer.from('{"value":"ordinary","nested":{"safe":"déjà"}}'),{'content-type':'application/json'},200);
 credentials.screenResponse(Buffer.from('value;number\nsafe;17\n'),{'content-type':'text/csv'},200);
 credentials.screenResponse(deflatedZip({'table.csv':'value;number\nsafe;17\n','ignored.json':'{"safe":17}'}),{'content-type':'application/zip'},200);
 credentials.screenResponse(Buffer.alloc(0),{location:'https://other.de/public'},307);
 credentials.clear();quoted.clear();
});

test('reviewed-entry integration runs only in an isolated source snapshot and fixture authority',async t=>{
 // No mutable production decision/credential injection. A disposable source copy
 // models the lead's future code-reviewed entry; the checked-in list stays empty.
 const packageRoot=dirname(dirname(fileURLToPath(import.meta.url))),snapshot=await mkdtemp(join(tmpdir(),'genesis-auth-code-fixture-'));
 t.after(()=>rm(snapshot,{recursive:true,force:true}));
 await cp(join(packageRoot,'src'),join(snapshot,'src'),{recursive:true});await cp(join(packageRoot,'regional'),join(snapshot,'regional'),{recursive:true});
 await mkdir(join(snapshot,'test','fixtures'),{recursive:true});
 for(const name of ['genesis-owner-account.ts','genesis-echo.ts','polite-lane.ts','polite-inspection.ts','civic-policy.ts','tdm-pdf.ts'])await cp(join(packageRoot,'test','fixtures',name),join(snapshot,'test','fixtures',name));
 await symlink(join(packageRoot,'node_modules'),join(snapshot,'node_modules'),'dir');
 await cp(join(packageRoot,'migrations'),join(snapshot,'migrations'),{recursive:true});
 await cp(join(packageRoot,'src'),join(snapshot,'legacy-src'),{recursive:true});
 for(const name of ['civic-opt-out.ts','civic-docker.ts','source-policy.ts','district-schema.ts'])await writeFile(join(snapshot,'legacy-src',name),execFileSync('/usr/bin/git',['show',`0.3.2:stadtstack-data/src/${name}`],{cwd:packageRoot,maxBuffer:4*1024*1024}));
 const policyPath=join(snapshot,'src','source-policy.ts'),source=await readFile(policyPath,'utf8'),marker='export const APPROVED_OWNER_GENESIS_ACCESS:readonly OwnerGenesisAccessDecision[]=Object.freeze([]);';
 assert.equal(source.split(marker).length,2);
 await writeFile(policyPath,source.replace(marker,"export const APPROVED_OWNER_GENESIS_ACCESS:readonly OwnerGenesisAccessDecision[]=Object.freeze([Object.freeze({id:'fixture-owner-genesis',date:'2026-10-13',approver:'owner',host:'www.regionalstatistik.de',purpose:'regionalstatistik_genesis_statistics',permission:'facts_with_attribution'} as const)]);"));
 const credentialPath=join(snapshot,'credentials','credentials.json');await mkdir(dirname(credentialPath),{mode:0o700});
 const readerPath=join(snapshot,'src','genesis-owner-credentials.ts'),reader=await readFile(readerPath,'utf8');assert.ok(reader.includes("'/home/max/.config/stadtstack/regionalstatistik/credentials.json'"));
 await writeFile(readerPath,reader.replace("'/home/max/.config/stadtstack/regionalstatistik/credentials.json'",JSON.stringify(credentialPath)));
 const child=spawn(process.execPath,['--experimental-strip-types','--test','--test-concurrency=1','test/fixtures/genesis-owner-account.ts'],{cwd:snapshot,env:{PATH:process.env.PATH,LANG:'C.UTF-8',HOME:tmpdir(),USER:userInfo().username,...(process.env.DISTRICT_TEST_DATABASE_URL?{DISTRICT_TEST_DATABASE_URL:process.env.DISTRICT_TEST_DATABASE_URL}:{})},stdio:['ignore','pipe','pipe']});
 const chunks:Buffer[]=[];child.stdout.on('data',chunk=>chunks.push(chunk));child.stderr.on('data',chunk=>chunks.push(chunk));
 const code=await new Promise<number|null>((done,reject)=>{child.on('error',reject);child.on('close',done);});
 const output=Buffer.concat(chunks);noSecrets(output);assert.equal(code,0,output.toString('utf8'));
});
