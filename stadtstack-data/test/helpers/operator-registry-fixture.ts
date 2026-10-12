import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {TestContext} from 'node:test';
import {sha256} from '../../src/district-schema.ts';
import type {DistrictRegistry} from '../../src/district-registry.ts';
import {operatorRegistryConfigSchema,operatorRegistryConfigContractSha256,importOperatorRegistryConfig,readOperatorRegistryInputPin} from '../../src/district-registry-config.ts';
import type {OperatorRegistryConfig,OperatorRegistryInputPin} from '../../src/district-registry-config.ts';
import {retainedPublicationSources} from '../../src/district-retained-import.ts';
import {assertCivicPolicyAuthority,CIVIC_ACQUISITION_DECISION_ID} from '../../src/civic-opt-out.ts';
import type {CivicPolicyOptions} from '../../src/civic-opt-out.ts';
import {createCivicPolicyTestContext} from '../fixtures/civic-policy.ts';

const execFileAsync=promisify(execFile),at='2026-10-11T12:00:00.000Z';
export interface OperatorRegistryFixtureContext {root:string;policy:CivicPolicyOptions}

/** Invented configuration metadata only: no source observation or real municipality claim. */
export function operatorRegistryFixtureValue():DistrictRegistry{
 const url='https://example.org/configured-source',evidence={url,locator:'Synthetic operator registry reference',sha256:sha256('synthetic source reference'),retrievedAt:at};
 return {
  schemaVersion:'stadtstack-source-registry-v1',generatedAt:at,
  districts:[{id:'synthetic-district',name:'Synthetic district',ags:'12064',state:'Brandenburg',inventorySources:[evidence],inventoryAsOf:'2026-10-11',inventoryComplete:true}],
  municipalities:[{id:'synthetic-town',name:'Synthetic town',ags:'12064001',districtId:'synthetic-district',districtAgs:'12064',amt:null,administrativeStatus:'amtsfrei',administrativeEvidence:[evidence],identitySources:[evidence],
   sources:(['website','council','participation','gazette'] as const).map(kind=>({id:kind,kind,url,vendor:'unknown',checkState:'not_checked',checkedAt:null,evidence:[],reason:'Synthetic configured endpoint, not an observed request'})),
   seedDocuments:[{url,sourceId:'website',title:'Synthetic seed',documentDate:null,dateReason:'No source date asserted',evidence:[evidence]}]}],
  inventory:[{ags:'12064001',name:'Synthetic town',districtId:'synthetic-district',identitySourceUrl:url,pilot:true,sourceCheckState:'not_checked',reason:'Synthetic operator configuration'}],
  notes:['Synthetic configuration, not source text or model evidence'],
 };
}

/** Donor Git proof/approval contract, backed here by an actual isolated SHA-1 Git repository. */
export async function registryDescriptor(context:OperatorRegistryFixtureContext,value:unknown,label='registry-code'):Promise<OperatorRegistryConfig>{
 const authority=await assertCivicPolicyAuthority(context.policy);
 if(authority.mode!=='isolated-fixture'||!/^fixture:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(authority.authorityId))throw Error('Registry fixtures require a provisioned synthetic fixture authority');
 const codeRoot=join(context.root,label),repository=join(codeRoot,'repository'),codePath='stadtstack-data/sources/district-registry.json';
 await mkdir(join(repository,'stadtstack-data/sources'),{recursive:true,mode:0o700});
 const body=Buffer.from(JSON.stringify(value)+'\n'),path=join(repository,codePath);await writeFile(path,body,{mode:0o600});
 // Do not inherit a caller's Git repository, signing, hooks, filters or credentials.
 const env:NodeJS.ProcessEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
 Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_ATTR_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_AUTHOR_DATE:at,GIT_COMMITTER_DATE:at});
 const git=async(args:string[])=>{
  const result=await execFileAsync('git',['-c','core.hooksPath=/dev/null','-c','core.attributesFile=/dev/null','-c','commit.gpgSign=false','-c','user.name=Synthetic Fixture','-c','user.email=fixture@example.test',...args],{cwd:repository,env,encoding:'buffer',maxBuffer:8*1024*1024});
  return result.stdout;
 };
 await git(['init','--template=','--object-format=sha1','--initial-branch=fixture']);
 await git(['add','--',codePath]);
 await git(['commit','--no-verify','-m','Synthetic operator registry configuration']);
 const gitCommit=(await git(['rev-parse','HEAD'])).toString('ascii').trim(),blobOid=(await git(['rev-parse',`HEAD:${codePath}`])).toString('ascii').trim();
 const objectPin=async(kind:'commit'|'tree',oid:string)=>{
  const bytes=await git(['cat-file',kind,oid]),path=join(codeRoot,kind+'-'+oid+'.bin');
  await writeFile(path,bytes,{mode:0o600});return {path,oid,sha256:sha256(bytes),bytes:bytes.length};
 };
 const commit=await objectPin('commit',gitCommit),trees=[];
 for(const revision of ['HEAD:stadtstack-data/sources','HEAD:stadtstack-data','HEAD^{tree}']){
  const oid=(await git(['rev-parse',revision])).toString('ascii').trim();trees.push(await objectPin('tree',oid));
 }
 return operatorRegistryConfigSchema.parse({
  kind:'operator_registry_config',path,sha256:sha256(body),bytes:body.length,schemaContractSha256:await operatorRegistryConfigContractSha256(),
  code:{gitCommit,path:codePath,blobOid,sha256:sha256(body),bytes:body.length},commit,trees,
  approval:{role:'district_source_registry',approver:'owner',decisionId:CIVIC_ACQUISITION_DECISION_ID,date:'2026-10-11',configurationSha256:sha256(body),gitCommit},
  declaredEndpoints:[...new Set(retainedPublicationSources(value).map(source=>source.url))],
 });
}

/** The outer pin authenticates descriptor bytes, not the registry body itself. */
export async function writeOperatorRegistryInputPin(root:string,name:string,value:unknown):Promise<OperatorRegistryInputPin>{
 const path=join(root,name+'.json'),bytes=Buffer.from(JSON.stringify(value)+'\n');
 await writeFile(path,bytes,{mode:0o600});return {path,sha256:sha256(bytes)};
}

/** Provision a fixture realm (or reuse one), import its Git proof and admit its managed descriptor. */
export async function createOperatorRegistryFixture(test:TestContext,options:{context?:OperatorRegistryFixtureContext;value?:unknown;label?:string}={}){
 const context=options.context??await createCivicPolicyTestContext(test),value=options.value??operatorRegistryFixtureValue(),label=options.label??'operator-registry';
 const input=await registryDescriptor(context,value,label),body=Buffer.from(JSON.stringify(value)+'\n'),managedRoot=join(context.root,label+'-managed');
 const sourcePin=await importOperatorRegistryConfig({...input,managedRoot,destinationPath:'registry.json'},context.policy);
 const registryPin=await writeOperatorRegistryInputPin(context.root,label+'-input',sourcePin),admitted=await readOperatorRegistryInputPin(registryPin,context.policy);
 return {...context,input,body,value,managedRoot,sourcePin,registryPin,registrySha256:sha256(admitted.bytes),admitted};
}
