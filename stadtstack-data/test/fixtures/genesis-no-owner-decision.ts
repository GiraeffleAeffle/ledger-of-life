import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspect} from 'node:util';
import {APPROVED_OWNER_GENESIS_ACCESS,ownerGenesisAccessFor,effectiveSourcePermission} from '../../src/source-policy.ts';
import {ContentFreeSourcePolicySchema} from '../../src/district-schema.ts';
import {PoliteFetcher,PoliteFetchError,type FetchObservation} from '../../src/polite-fetch.ts';
import {nativePublicRequestHeaders} from '../../src/district-native-request.ts';
import {politeTestOptions} from './polite-lane.ts';
import {fixturePolicyInspection} from './polite-inspection.ts';

const endpoint='https://www.regionalstatistik.de/genesisws/rest/2020/data/table';
const body=new URLSearchParams({name:'12411-02-03',area:'free',language:'de',regionalvariable:'GEMEIN',regionalkey:'12064472',startyear:'2024',endyear:'2024',compress:'false',transpose:'false',job:'false'}).toString();
async function scanArtifacts(root:string):Promise<void>{
 for(const entry of await readdir(root,{withFileTypes:true})){
  const path=join(root,entry.name);
  if(entry.isDirectory())await scanArtifacts(path);
  else if(entry.isFile())assert.ok(!(await readFile(path)).includes(Buffer.from('authenticated_owner_account')),'No-entry request acquired authenticated audit metadata');
 }
}

test('isolated empty decision list preserves the GENESIS GAST 401 hold',async t=>{
 assert.equal(APPROVED_OWNER_GENESIS_ACCESS.length,0);assert.equal(ownerGenesisAccessFor(endpoint),null);
 const root=await mkdtemp(join(tmpdir(),'genesis-no-decision-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const fetcher=new PoliteFetcher({...await politeTestOptions({cacheDir:root}),fixtureInspection:fixturePolicyInspection});
 interface Seam {wire(url:URL,method:string,body:string|undefined,previous:FetchObservation|undefined,operation:string|undefined,credentials:unknown):Promise<{status:number;headers:Record<string,string>;body:Buffer}>}
 t.mock.method(fetcher as unknown as Seam,'wire',async(url:URL,_method:string,_body:string|undefined,_previous:unknown,_operation:unknown,credentials:unknown)=>{
  assert.equal(credentials,undefined);
  if(url.href===endpoint){const headers=nativePublicRequestHeaders(url,'POST',body,'genesis_guest');assert.equal(headers.username,'GAST');assert.equal(headers.password,'GAST');}
  return {status:url.pathname.includes('/data/')?401:404,headers:{},body:Buffer.alloc(0)};
 });
 await assert.rejects(fetcher.fetch(endpoint,{method:'POST',body,publicOperation:'genesis_guest'}),(error:unknown)=>{assert.ok(error instanceof PoliteFetchError);assert.equal(error.failure,'access_barrier');assert.equal(error.policy?.access,'authentication');assert.equal(error.policy?.ownerAccountAccess,undefined);assert.ok(!inspect(error).includes('authenticated_owner_account'));return true;});
 const policy={robots:{state:'allowed' as const,url:'https://www.regionalstatistik.de/robots.txt'},tdm:{state:'not_declared' as const,evidence:[]},access:'authenticated_owner_account' as const,ownerAccountAccess:{decisionId:'fixture-unapproved',credentialKind:'token' as const},legalClassification:'not_assessed' as const,publication:'facts_with_attribution_only' as const};
 assert.equal(ContentFreeSourcePolicySchema.safeParse(policy).success,false);assert.equal(effectiveSourcePermission(policy,{url:endpoint,sha256:'a'.repeat(64)}),false);
 await scanArtifacts(root);
});
