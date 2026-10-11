import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {renderDistrictSources,exportDistrictSources} from '../src/export-district-sources.ts';
import {districtSourceAdapterKind} from '../src/district-crawl.ts';
import type {DistrictRegistry} from '../src/district-registry.ts';

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
 const root=await mkdtemp(join(tmpdir(),'source-export-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const rawRoot=join(root,'raw');await mkdir(join(rawRoot,'observations'),{recursive:true});
 const registry=join(root,'registry.json'),crawlIndex=join(root,'index.json'),markdown=join(root,'reports','SOURCES.md'),csv=join(root,'reports','sources.csv');
 await writeFile(registry,JSON.stringify(fixture()));await writeFile(crawlIndex,JSON.stringify(crawl()));
 await writeFile(join(rawRoot,'observations','one.json'),JSON.stringify({url:'https://stadt.de/council',checkedAt:date,retrievedAt:null,state:'failed',failure:'timeout'}));
 const result=await exportDistrictSources({registry,crawlIndex,rawRoot,markdown,csv});
 assert.equal(await readFile(markdown,'utf8'),result.markdown);assert.equal(await readFile(csv,'utf8'),result.csv);
 assert.equal(result.rows.filter(r=>r.rowType==='fetch_observation').length,1);
 await assert.rejects(exportDistrictSources({registry,crawlIndex,rawRoot,markdown:registry,csv}),/collides/);
 const outside=join(root,'outside.json');await writeFile(outside,'{}');await symlink(outside,join(rawRoot,'observations','outside.json'));
 await assert.rejects(exportDistrictSources({registry,crawlIndex,rawRoot,markdown,csv}),/escapes raw root/);
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
