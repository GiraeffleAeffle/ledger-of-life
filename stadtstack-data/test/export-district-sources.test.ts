import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,symlink,realpath,mkdir,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {renderDistrictSources,exportDistrictSources} from '../src/export-district-sources.ts';
import {districtSourceAdapterKind} from '../src/district-crawl.ts';
import type {DistrictRegistry} from '../src/district-registry.ts';
import {ownerRobotsOverrideFor} from '../src/source-policy.ts';
import {PoliteFetcher,sourceContentBinding} from '../src/polite-fetch.ts';
import {politeTestOptions} from './fixtures/polite-lane.ts';
import {createHash} from 'node:crypto';
import {sha256} from '../src/district-schema.ts';
import {CIVIC_ACQUISITION_DECISION_ID,recordHostOptOut,HostOptedOutError,CivicPolicyStateError,type CivicPolicyOptions} from '../src/civic-opt-out.ts';
import {operatorRegistryConfigSchema,operatorRegistryConfigContractSha256,operatorRegistryEndpoints,readOperatorRegistryInputPin} from '../src/district-registry-config.ts';
import {writeManagedSourceJson} from '../src/district-private-io.ts';

async function registryPin(root:string,value:DistrictRegistry){
 await mkdir(root,{mode:0o700});
 const bytes=Buffer.from(JSON.stringify(value)+'\n'),path=join(root,'registry.json');
 await writeFile(path,bytes,{mode:0o600});
 const oid=(kind:string,body:Buffer)=>createHash('sha1').update(kind+' '+body.length+'\0').update(body).digest('hex');
 const entry=(name:string,id:string,mode='40000')=>Buffer.concat([Buffer.from(mode+' '+name+'\0'),Buffer.from(id,'hex')]);
 const store=async(kind:string,body:Buffer)=>{
  const id=oid(kind,body),path=join(root,id+'.bin');await writeFile(path,body,{mode:0o600});
  return {path,oid:id,sha256:sha256(body),bytes:body.length};
 };
 const blobOid=oid('blob',bytes),leaf=await store('tree',entry('district-registry.json',blobOid,'100644')),middle=await store('tree',entry('sources',leaf.oid)),tree=await store('tree',entry('stadtstack-data',middle.oid));
 const commit=await store('commit',Buffer.from(`tree ${tree.oid}\nauthor Synthetic Fixture <fixture@example.test> 0 +0000\ncommitter Synthetic Fixture <fixture@example.test> 0 +0000\n\nSynthetic configuration\n`));
 const descriptor=operatorRegistryConfigSchema.parse({kind:'operator_registry_config',path,sha256:sha256(bytes),bytes:bytes.length,schemaContractSha256:await operatorRegistryConfigContractSha256(),code:{gitCommit:commit.oid,path:'stadtstack-data/sources/district-registry.json',blobOid,sha256:sha256(bytes),bytes:bytes.length},approval:{role:'district_source_registry',approver:'owner',decisionId:CIVIC_ACQUISITION_DECISION_ID,date:'2026-10-11',configurationSha256:sha256(bytes),gitCommit:commit.oid},commit,trees:[leaf,middle,tree],declaredEndpoints:operatorRegistryEndpoints(value)});
 const descriptorPath=join(root,'descriptor.json'),body=JSON.stringify(descriptor)+'\n';
 await writeFile(descriptorPath,body,{mode:0o600});
 return {path:descriptorPath,sha256:sha256(body)};
}

async function exportFixture(t:TestContext,root:string,policy:CivicPolicyOptions){
 const rawRoot=join(root,'raw'),fetcher=new PoliteFetcher({cacheDir:rawRoot,ownerPolicyLane:{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy}});
 await fetcher.initialize();
 t.mock.method(fetcher as unknown as {wire(url:URL):Promise<unknown>},'wire',async(target:URL)=>target.pathname==='/robots.txt'||target.pathname==='/.well-known/tdmrep.json'?{status:404,headers:{},body:Buffer.alloc(0)}:{status:200,headers:{'content-type':'text/plain'},body:Buffer.from('Synthetic crawl input')});
 const document=await fetcher.fetch('https://stadt.de/fixture-index'),sourceBindings=await fetcher.sourceBindingsForArtifact([sourceContentBinding(document)]);
 const registry=await registryPin(join(root,'operator-code'),fixture()),admitted=await readOperatorRegistryInputPin(registry,policy),indexRoot=join(root,'indexes'),crawlIndex=join(indexRoot,'index.json');
 await writeManagedSourceJson(indexRoot,crawlIndex,crawl(),[...admitted.bindings,...sourceBindings],{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',...policy});
 return {registry,crawlIndex,rawRoot,markdown:join(root,'reports','SOURCES.md'),csv:join(root,'reports','sources.csv'),policy};
}

const date='2026-10-01T00:00:00.000Z',url='https://stadt.de/registry';
function fixture():DistrictRegistry{
 const evidence={url,locator:'Official inventory',sha256:'a'.repeat(64),retrievedAt:date};
 return {schemaVersion:'stadtstack-source-registry-v1',generatedAt:date,districts:[{id:'district',name:'District',ags:'13076',state:'MV',inventorySources:[evidence],inventoryAsOf:'2024-12-31',inventoryComplete:true}],
 municipalities:[{id:'town',name:'Town',ags:'13076090',districtId:'district',districtAgs:'13076',amt:null,administrativeStatus:'amtsfrei',administrativeEvidence:[evidence],identitySources:[evidence],sources:([['council','allris'],['participation','other'],['gazette','sessionnet'],['website','unknown']] as const).map(([kind,vendor])=>({id:kind,kind,vendor,url:kind==='website'?null:`https://stadt.de/${kind}`,checkState:'not_checked',checkedAt:null,evidence:[],reason:'Not checked'})),seedDocuments:[{url:'https://stadt.de/seed.pdf',sourceId:'gazette',title:'Seed',documentDate:null,dateReason:'Not known',evidence:[evidence]}]}],
 inventory:[{ags:'13076090',name:'Town',districtId:'district',identitySourceUrl:url,pilot:true,sourceCheckState:'not_checked',reason:'Pilot'},
 {ags:'13076091',name:'Unknown town',districtId:'district',identitySourceUrl:url,pilot:false,sourceCheckState:'not_checked',reason:'Inventory only'},
 {ags:'13076092',name:'Label town',districtId:'district',identitySourceUrl:url,administrativeLabel:'amtsangehoerig; Amt ARS 123456789',pilot:false,sourceCheckState:'not_checked',reason:'Inventory only'}],notes:[]};
}
function crawl(){return {schemaVersion:'stadtstack-crawl-index-v1',generatedAt:date,documents:[],checks:[]};}

test('raw URL coverage preserves duplicate identities, unknown pointers, roles and null source rows',()=>{
 const raw={...fixture(),unknown:{'a/b~c':['https://stadt.de/unknown','See https://stadt.de/ref and https://stadt.de/ref']}};
 raw.municipalities[0].sources[1].api={url:'https://stadt.de/api',format:'diplan-list',form:{search:'https://stadt.de/form-reference'}};
 const result=renderDistrictSources(raw,crawl());
 assert.equal(result.counts.municipalities,3);assert.equal(result.counts.agsObjects,5);
 assert.equal(result.rows.filter(r=>r.role==='text_reference').length,2);
 assert.equal(result.rows.find(r=>r.url==='https://stadt.de/unknown')?.pointer,'/unknown/a~1b~0c/0');
 assert.equal(result.rows.find(r=>r.url==='https://stadt.de/api')?.role,'configured_api');
 assert.equal(result.rows.find(r=>r.url==='https://stadt.de/form-reference')?.role,'unclassified_request_reference');
 assert.equal(result.rows.find(r=>r.role==='seed_document')?.sourceId,'gazette');
 assert.equal(result.rows.find(r=>r.rowType==='source'&&r.sourceId==='website')?.url,null);
 assert.equal(result.rows.find(r=>r.rowType==='source')?.crawlCheck,'missing');
 assert.equal(result.counts.urlOccurrences,result.rows.filter(r=>r.rowType==='url_occurrence').length);
 assert.equal(result.counts.urlOccurrences-result.counts.wholeStringUrlOccurrences,2);
 assert.ok(result.counts.urlOccurrences>result.counts.distinctUrls);
 assert.match(result.markdown,/amtsfrei — evidenced pilot/);assert.match(result.markdown,/Administration unknown/);assert.match(result.markdown,/not canonical Amt.*Amt ARS 123456789/);
});

test('adapter selector preserves crawler precedence rather than inferring vendor adapters',()=>{
 const source=fixture().municipalities[0].sources[0];
 assert.equal(districtSourceAdapterKind(source),'html');
 assert.equal(districtSourceAdapterKind({...source,vendor:'sessionnet'}),'html');
 assert.equal(districtSourceAdapterKind({...source,vendor:'somacos'}),'html');
 assert.equal(districtSourceAdapterKind({...source,api:{url,format:'diplan-list'}}),'participation-api');
 assert.equal(districtSourceAdapterKind({...source,api:{url,format:'bobsh-list'}}),'participation-api');
 assert.equal(districtSourceAdapterKind({...source,api:{url,format:'mv-bauleitplan'}}),'mv-bauleitplan');
 assert.equal(districtSourceAdapterKind({...source,vendor:'oparl',api:{url,format:'mv-bauleitplan'}}),'oparl');
});

test('configured dispatch, observed document labels, crawl failures and incomplete policy stages stay distinct',()=>{
 const raw=fixture();raw.municipalities[0].sources[0].api={url:'https://stadt.de/api',format:'diplan-list'};
 raw.municipalities[0].sources[0].robots={url:'https://stadt.de/robots.txt',checkState:'checked',checkedAt:date,evidence:[{url,locator:'Discovery'}]};
 const index={...crawl(),documents:[{municipalityId:'town',sourceId:'council',url:'https://stadt.de/document.pdf',adapter:'official-pdf'}],checks:[{municipalityId:'town',sourceId:'council',checkState:'checked',checkedAt:date,outcome:'blocked',documentCount:1,coverage:{state:'blocked'},blocked:[{url:'https://stadt.de/api'}]}]};
 const observations=[{url:'https://stadt.de/api',checkedAt:date,retrievedAt:null,state:'failed',failure:'robots_blocked',policy:{robots:{state:'blocked'},tdm:{state:'not_declared'}},headers:{authorization:'not-exportable'},body:'not-exportable'}];
 const result=renderDistrictSources(raw,index,observations),source=result.rows.find(r=>r.rowType==='source'&&r.sourceId==='council')!;
 assert.equal(source.configuredAdapter,'participation-api');assert.equal(source.observedAdapters,'official-pdf');assert.equal(source.crawlOutcome,'blocked');assert.equal(source.robotsDiscovery,'checked');
 const observation=result.rows.find(r=>r.rowType==='fetch_observation')!;
 assert.equal(observation.robotsPathState,'blocked');assert.equal(observation.tdmRuntimeState,'not_declared');assert.equal(observation.role,'retained_observation_url_match_only');
 assert.ok(!result.csv.includes('not-exportable'));assert.ok(!result.markdown.includes('not-exportable'));
 assert.match(result.markdown,/not a grant of permission/);assert.match(result.markdown,/not method\/form or bytes/);
});

test('unavailable TDM reference remains visible beside the actual reservation',()=>{
 const result=renderDistrictSources(fixture(),crawl(),[{url:'https://stadt.de/council',checkedAt:date,retrievedAt:null,state:'failed',failure:'tdm_unavailable',policy:{robots:{state:'allowed'},tdm:{state:'reserved',referenceStatus:'unavailable',evidence:[{value:'PRIVATE-INVALID-POLICY-URI'}]}}}]);
 const row=result.rows.find(value=>value.rowType==='fetch_observation')!;
 assert.equal(row.tdmRuntimeState,'reserved');assert.equal(row.tdmReferenceStatus,'unavailable');
 assert.ok(result.csv.includes('"tdmReferenceStatus"'));assert.ok(!result.csv.includes('PRIVATE-INVALID-POLICY-URI'));
});

test('output is deterministic and escapes Markdown, CSV and spreadsheet formulas',()=>{
 const raw=fixture();raw.inventory[0].name='<script>|[x]\n*Town*';raw.municipalities[0].sources[0].id='=SUM(1,2)';
 const first=renderDistrictSources(raw,crawl()),second=renderDistrictSources(raw,crawl());
 assert.equal(first.csv,second.csv);assert.equal(first.markdown,second.markdown);
 assert.match(first.markdown,/&lt;script&gt;/);assert.ok(!first.markdown.includes('<script>'));
 assert.ok(first.csv.includes('"\'=SUM(1,2)"'));assert.ok(first.csv.endsWith('\r\n'));
});

test('unsafe URL evidence fails closed even in stripped unknown fields, without echoing secrets',()=>{
 for(const unsafe of ['https://stadt.de/?token=DO_NOT_PRINT','https://name:DO_NOT_PRINT@stadt.de/','http://127.0.0.1/private','https://stadt.de/#token=DO_NOT_PRINT','file:///DO_NOT_PRINT']){
  assert.throws(()=>renderDistrictSources({...fixture(),unknown:unsafe},crawl()),error=>error instanceof Error&&!error.message.includes('DO_NOT_PRINT')&&/unsafe public URL/.test(error.message));
 }
});

test('observation ordering and object property insertion order do not affect rendered bytes',()=>{
 const raw=fixture(),observations=[{url:'https://stadt.de/council',checkedAt:date,retrievedAt:null,state:'failed',failure:'timeout'},{url:'https://stadt.de/council',checkedAt:date,retrievedAt:null,state:'failed',failure:'network_error'}];
 const first=renderDistrictSources(raw,crawl(),observations),second=renderDistrictSources(Object.fromEntries(Object.entries(raw).reverse()),crawl(),observations.toReversed());
 assert.equal(first.csv,second.csv);assert.equal(first.markdown,second.markdown);
});

test('explicit local export reads retained observations only and writes requested deterministic outputs',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'source-export-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const options=await politeTestOptions({cacheDir:join(root,'raw')}),inputs=await exportFixture(t,root,options.ownerPolicyLane!);
 const {registry,crawlIndex,rawRoot,markdown,csv,policy}=inputs;
 await writeFile(join(rawRoot,'observations','one.json'),JSON.stringify({url:'https://stadt.de/council',method:'GET',checkedAt:date,retrievedAt:null,state:'failed',failure:'timeout'}),{mode:0o600});
 const result=await exportDistrictSources({registry,crawlIndex,rawRoot,markdown,csv,policy});
 assert.equal(await readFile(markdown,'utf8'),result.markdown);assert.equal(await readFile(csv,'utf8'),result.csv);
 assert.equal(result.rows.filter(r=>r.rowType==='fetch_observation').length,1);
 await assert.rejects(exportDistrictSources({registry,crawlIndex,rawRoot,markdown:registry.path,csv,policy}),/collides/);
 const admitted=await readOperatorRegistryInputPin(registry,policy);
 await assert.rejects(exportDistrictSources({...inputs,markdown:admitted.path}),/collides/);
 const outside=join(root,'outside.json');await writeFile(outside,'{}');await symlink(outside,join(rawRoot,'observations','outside.json'));
 await assert.rejects(exportDistrictSources({registry,crawlIndex,rawRoot,markdown,csv,policy}),/escapes raw root/);
});

test('source export rejects bare registry paths and forged descriptor pins before reports',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'source-export-provenance-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const lane=await politeTestOptions({cacheDir:join(root,'raw')}),inputs=await exportFixture(t,root,lane.ownerPolicyLane!);
 const admitted=await readOperatorRegistryInputPin(inputs.registry,inputs.policy);
 await assert.rejects(exportDistrictSources({...inputs,registry:admitted.path as unknown as typeof inputs.registry}));
 await assert.rejects(exportDistrictSources({...inputs,registry:{path:admitted.path,sha256:sha256(admitted.bytes)}}));
 await assert.rejects(exportDistrictSources({...inputs,registry:{...inputs.registry,sha256:'f'.repeat(64)}}));
 await assert.rejects(lstat(inputs.markdown),{code:'ENOENT'});await assert.rejects(lstat(inputs.csv),{code:'ENOENT'});
});

test('source export refuses a crawl index with a different authenticated registry contribution',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'source-export-registry-mismatch-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const lane=await politeTestOptions({cacheDir:join(root,'raw')}),inputs=await exportFixture(t,root,lane.ownerPolicyLane!);
 const other=fixture();other.notes=['Different authenticated operator configuration'];
 const registry=await registryPin(join(root,'other-operator-code'),other);
 await assert.rejects(exportDistrictSources({...inputs,registry}),(error:unknown)=>error instanceof CivicPolicyStateError&&error.code==='CONTENT_PROVENANCE_MISMATCH');
 await assert.rejects(lstat(inputs.markdown),{code:'ENOENT'});await assert.rejects(lstat(inputs.csv),{code:'ENOENT'});
});

test('source export rechecks objections for configured endpoints before writing reports',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'source-export-objection-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const lane=await politeTestOptions({cacheDir:join(root,'raw')}),inputs=await exportFixture(t,root,lane.ownerPolicyLane!);
 await recordHostOptOut({host:'stadt.de',reason:'municipality_objection'},inputs.policy);
 await assert.rejects(exportDistrictSources(inputs),HostOptedOutError);
 await assert.rejects(lstat(inputs.markdown),{code:'ENOENT'});await assert.rejects(lstat(inputs.csv),{code:'ENOENT'});
});

test('CSV carries honest hierarchy and source kind/vendor/API context across every row type',()=>{
 const raw=fixture();raw.municipalities[0].sources[1].api={url:'https://stadt.de/api',format:'bobsh-list'};
 const result=renderDistrictSources(raw,crawl(),[{url:'https://stadt.de/participation',checkedAt:date,retrievedAt:null,state:'failed',failure:'timeout'}]);
 const bound=result.rows.filter(row=>row.sourceId==='participation');
 assert.deepEqual([...new Set(bound.map(row=>row.rowType))].sort(),['fetch_observation','source','url_occurrence']);
 for(const row of bound){
  assert.equal(row.districtName,'District');assert.equal(row.districtAgs,'13076');assert.equal(row.municipalityName,'Town');
  assert.equal(row.administrativeStatus,'amtsfrei');assert.equal(row.amtEvidenceLevel,'pilot_amtsfrei_evidence');
  assert.equal(row.amtId,'');assert.equal(row.amtName,'');assert.equal(row.sourceKind,'participation');assert.equal(row.sourceVendor,'other');assert.equal(row.apiFormat,'bobsh-list');
 }
 assert.equal(result.rows.find(row=>row.rowType==='source'&&row.sourceId==='council')?.sourceVendor,'allris');
 assert.equal(result.rows.find(row=>row.rowType==='source'&&row.sourceId==='gazette')?.sourceVendor,'sessionnet');
 const unknown=result.rows.find(row=>row.ags==='13076091')!;
 assert.equal(unknown.municipalityName,'Unknown town');assert.equal(unknown.administrativeStatus,'unknown');assert.equal(unknown.amtEvidenceLevel,'unknown');assert.equal(unknown.sourceKind,'');
 const labelled=result.rows.find(row=>row.ags==='13076092')!;
 assert.equal(labelled.administrativeLabel,'amtsangehoerig; Amt ARS 123456789');assert.equal(labelled.administrativeStatus,'unknown');assert.equal(labelled.amtEvidenceLevel,'inventory_label_only');assert.equal(labelled.amtId,'');assert.equal(labelled.amtName,'');
 const district=result.rows.find(row=>row.role==='inventory_evidence')!;
 assert.equal(district.districtName,'District');assert.equal(district.districtAgs,'13076');assert.equal(district.municipalityName,'');
 assert.match(result.markdown,/vendor allris; API format not configured/);assert.match(result.markdown,/vendor other; API format bobsh-list/);
});

test('explicit pilot Amt identity is retained without promoting inventory labels',()=>{
 const raw=fixture(),pilot=raw.municipalities[0];
 pilot.administrativeStatus='amtsangehoerig';pilot.amt={id:'verified-amt',name:'Verified Amt',sourceUrl:'https://stadt.de/amt'};
 const result=renderDistrictSources(raw,crawl());
 for(const row of result.rows.filter(row=>row.ags===pilot.ags)){
  assert.equal(row.administrativeStatus,'amtsangehoerig');assert.equal(row.amtId,'verified-amt');assert.equal(row.amtName,'Verified Amt');assert.equal(row.amtEvidenceLevel,'pilot_administrative_evidence');
 }
 assert.match(result.markdown,/Amt Verified Amt/);
});

test('public export preserves applied document denial and exact decision without inheriting registry audit',()=>{
 const raw=fixture(),source=raw.municipalities[0].sources[0],decision=ownerRobotsOverrideFor(source.url!)!;
 Object.assign(source,{ownerRobotsOverride:decision,override:'owner-approved 2026-10-11',robotsStatus:'disallowed',robots:{url:'https://stadt.de/robots.txt',checkState:'checked',checkedAt:date,evidence:[{url:'https://stadt.de/robots.txt',locator:'Actual denied group',sha256:'a'.repeat(64),retrievedAt:date}]}});
 const policy={robots:{state:'blocked',url:'https://stadt.de/robots.txt',sha256:'a'.repeat(64),checkedAt:date},tdm:{state:'not_declared'},ownerRobotsOverride:decision,override:'owner-approved 2026-10-11',robotsStatus:'disallowed'};
 const document={municipalityId:'town',sourceId:'council',url:'https://stadt.de/document',adapter:'official-html',policy};
 const observation={url:document.url,checkedAt:date,retrievedAt:date,state:'fetched',policy};
 const result=renderDistrictSources(raw,{...crawl(),documents:[document]},[observation,{...observation,policy:{robots:{state:'allowed'},tdm:{state:'not_declared'}}}]);
 const row=result.rows.find(row=>row.rowType==='document')!;
 assert.equal(row.formatVersion,'stadtstack-source-export-v2');assert.equal(row.robotsPathState,'blocked');assert.equal(row.robotsStatus,'disallowed');assert.equal(row.override,'owner-approved 2026-10-11');assert.deepEqual(JSON.parse(row.ownerRobotsOverride),decision);
 assert.equal(JSON.parse(row.robotsEvidence).sha256,'a'.repeat(64));
 const allowed=result.rows.find(row=>row.rowType==='fetch_observation'&&row.robotsPathState==='allowed')!;
 assert.equal(allowed.robotsStatus,'allowed');assert.equal(allowed.override,'');assert.equal(allowed.ownerRobotsOverride,'');
 assert.match(result.markdown,/Applied owner robots decisions/);
 for(const mutated of [{...policy,robots:{...policy.robots,state:'allowed'}},{...policy,robots:{...policy.robots,sha256:undefined}},{...policy,ownerRobotsOverride:{...decision,host:'different.stadt.de'}}]){
  assert.throws(()=>renderDistrictSources(raw,{...crawl(),documents:[{...document,policy:mutated}]}),/audit|schema/);
 }
});

test('excluded export rows retain origin and physical-disposition metadata without claiming stored raw',()=>{
 const raw=fixture(),source=raw.municipalities[0].sources[0],decision=ownerRobotsOverrideFor(source.url!)!;
 Object.assign(source,{ownerRobotsOverride:decision,override:'owner-approved 2026-10-11'});
 const target='https://stadt.de/external',sha256='b'.repeat(64),documentOrigin={classification:'unknown',method:'rules',classifierVersion:'document-origin-rules-v1',url:target,sha256,classifiedAt:date,evidence:[]};
 const policy={robots:{state:'blocked',url:'https://stadt.de/robots.txt',sha256:'a'.repeat(64),checkedAt:date},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only',documentOrigin,ownerRobotsOverride:decision,override:'owner-approved 2026-10-11',robotsStatus:'disallowed'};
 const exclusion={reason:'non_official_restricted',excludedAt:date,previousManagedCopy:'retained_independent'};
 const document={id:'excluded',municipalityId:'town',ags:'13076090',districtId:'district',sourceId:'council',url:target,sha256,mimeType:'text/html',retrievedAt:date,checkedAt:date,status:200,observationPath:'/private/cache/observations/excluded.json',policy,sizeBytes:123,exclusion,documentDate:null,adapter:'excluded-source',metadata:{}};
 const result=renderDistrictSources(raw,{...crawl(),excludedDocuments:[document]},[{url:target,sha256,checkedAt:date,retrievedAt:date,state:'excluded',status:200,policy,exclusion}]);
 const row=result.rows.find(row=>row.rowType==='excluded_document')!;
 assert.equal(row.bodyState,'excluded');assert.equal(row.originClassification,'unknown');assert.equal(row.robotsStatus,'disallowed');assert.equal(JSON.parse(row.exclusion).previousManagedCopy,'retained_independent');
 assert.equal(JSON.parse(row.documentOrigin).sha256,sha256);assert.equal(result.rows.find(row=>row.rowType==='source'&&row.sourceId==='council')?.robotsStatus,'unavailable');
 assert.ok(!result.csv.includes('/private/cache'));assert.match(result.markdown,/raw excluded/);
});

test('a declared allowed robots status is not fabricated into an applied override',()=>{
 const policy={robots:{state:'allowed',url:'https://stadt.de/robots.txt'},tdm:{state:'not_declared'},robotsStatus:'allowed'};
 const document={municipalityId:'town',sourceId:'council',url:'https://stadt.de/council/document',sha256:'b'.repeat(64),adapter:'official-html',policy};
 const index={...crawl(),documents:[document]};
 const exported=renderDistrictSources(fixture(),index),row=exported.rows.find(row=>row.rowType==='document')!;
 assert.equal(row.robotsStatus,'allowed');assert.equal(row.override,'');assert.equal(row.ownerRobotsOverride,'');
 assert.throws(()=>renderDistrictSources(fixture(),{...index,documents:[{...document,policy:{...policy,robotsStatus:'disallowed'}}]}),/declared robots audit/);
});

test('target completion is exported separately and cannot erase broader source pending work',()=>{
 const raw=fixture(),target='https://stadt.de/heat';
 raw.municipalities[0].sources[0].crawlScope={pageRoots:[target],followLinkedDocuments:true};
 const broader={municipalityId:'town',sourceId:'council',runId:'older-broader-run',checkState:'checked',checkedAt:date,documentCount:2,outcome:'partial',coverage:{state:'partial',pendingCount:17,runnableCount:12,blockedCount:5}};
 const narrow={municipalityId:'town',sourceId:'council',runId:'new-target-run',checkState:'checked',checkedAt:'2026-10-11T00:00:00.000Z',documentCount:1,outcome:'partial',coverage:{state:'partial',pendingCount:0,runnableCount:0,blockedCount:0,sourceCoverage:'not_assessed',targetScope:{kind:'page_roots',urls:[target],state:'complete',pendingCount:0,runnableCount:0,blockedCount:0}}};
 const result=renderDistrictSources(raw,{...crawl(),checks:[narrow,broader]}),source=result.rows.find(row=>row.rowType==='source'&&row.sourceId==='council')!;
 assert.equal(source.coverage,'partial');assert.equal(source.coverageSelection,'latest_broader_check');assert.equal(source.coveragePendingCount,17);assert.equal(source.runId,'older-broader-run');
 const observations=result.rows.filter(row=>row.rowType==='crawl_observation'&&row.sourceId==='council');assert.equal(observations.length,2);
 const targetRow=observations.find(row=>row.runId==='new-target-run')!;assert.equal(targetRow.sourceCoverage,'not_assessed');assert.equal(JSON.parse(targetRow.targetScope!).state,'complete');assert.equal(JSON.parse(targetRow.targetScope!).urls[0],target);
 assert.match(result.markdown,/pending 17/);assert.ok(result.csv.includes('not_assessed'));
 const targetOnly=renderDistrictSources(raw,{...crawl(),checks:[narrow]}).rows.find(row=>row.rowType==='source'&&row.sourceId==='council')!;
 assert.equal(targetOnly.coverage,'partial');assert.equal(targetOnly.sourceCoverage,'not_assessed');assert.equal(targetOnly.coverageSelection,'latest_target_check');
 assert.throws(()=>renderDistrictSources(raw,{...crawl(),checks:[{...narrow,coverage:{...narrow.coverage,state:'complete'}}]}),/whole-source/);
 assert.throws(()=>renderDistrictSources(raw,{...crawl(),checks:[{...narrow,coverage:{...narrow.coverage,targetScope:{...narrow.coverage.targetScope,urls:['https://user:secret@stadt.de/']}}}]}),/unsafe public URL/);
});

test('hashed no-body denial audit remains distinct from configured source robots metadata',()=>{
 const policyAudit={policySha256:'a'.repeat(64),sourceHostSha256:'b'.repeat(64),robotsState:'blocked',robotsStatus:'disallowed',override:null,tdmState:'unavailable',tdmReferenceStatus:'unavailable',access:'public'};
 const index={...crawl(),checks:[{municipalityId:'town',sourceId:'council',checkState:'checked',checkedAt:date,documentCount:0,outcome:'blocked',blocked:[{url:'https://stadt.de/council',urlRole:'registered_source_context',targetUrlSha256:'c'.repeat(64),policyAudit,body:'PRIVATE-REJECTED-BODY'}]}]};
 const result=renderDistrictSources(fixture(),index),row=result.rows.find(row=>row.rowType==='crawl_observation')!;
 const audit=JSON.parse(row.blockedAudit!)[0];assert.equal(audit.policyAudit.robotsStatus,'disallowed');assert.equal(audit.urlRole,'registered_source_context');assert.equal(audit.targetUrlSha256,'c'.repeat(64));
 assert.ok(result.csv.includes('"blockedAudit"'));assert.ok(result.markdown.includes('disallowed'));assert.equal(result.csv.includes('PRIVATE-REJECTED-BODY'),false);
 const forged=structuredClone(index);forged.checks[0].blocked[0].policyAudit.robotsStatus='allowed';assert.throws(()=>renderDistrictSources(fixture(),forged),/schema/);
});

test('malformed reservation status is exported separately from policy-reference availability',()=>{
 const result=renderDistrictSources(fixture(),crawl(),[{url:'https://stadt.de/council',checkedAt:date,retrievedAt:null,state:'failed',failure:'tdm_unavailable',policy:{robots:{state:'allowed'},tdm:{state:'reserved',declarationStatus:'unavailable'}}}]);
 const row=result.rows.find(row=>row.rowType==='fetch_observation')!;
 assert.equal(row.tdmRuntimeState,'reserved');assert.equal(row.tdmDeclarationStatus,'unavailable');assert.equal(row.tdmReferenceStatus,'');assert.ok(result.csv.includes('"tdmDeclarationStatus"'));
});
