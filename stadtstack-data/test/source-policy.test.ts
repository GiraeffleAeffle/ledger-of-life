import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseTdmRules,parseTdmReservation,tdmRuleForUrl,inspectResourcePolicy,matchesPolicyPattern,ownerRobotsOverrideFor,ownerRobotsOverrideApplies,effectiveRobotsPermission,documentOriginExcludes,effectiveSourcePermission,projectSourcePolicyMetadata,MAX_POLICY_METADATA_EVIDENCE,ownerGenesisAccessFor,ownerGenesisRobotsDecisionFor,type SourceAccessPolicy} from '../src/source-policy.ts';
import {SourceAccessPolicySchema,ContentFreeSourcePolicySchema,assertSubscriptionSourcePolicy,sha256} from '../src/district-schema.ts';
import {districtSourceSchema,loadDistrictRegistry} from '../src/district-registry.ts';
import { DOCUMENT_ORIGIN_CLASSIFIER_VERSION } from '../src/document-origin-contract.ts'
import {frozenCorpusSchema,excludedCrawlDocumentSchema} from '../src/district-corpus.ts';

test('TDMRep uses ordered specific rules and encoded path matching',()=>{
 const rules=parseTdmRules([{location:'/public/*','tdm-reservation':0},{location:'/','tdm-reservation':1}]);
 assert.equal(tdmRuleForUrl(rules,'https://stadt.de/public/plan.pdf')?.['tdm-reservation'],0);
 assert.equal(tdmRuleForUrl(rules,'https://stadt.de/private/plan.pdf')?.['tdm-reservation'],1);
 assert.equal(tdmRuleForUrl(parseTdmRules([{location:'/~plans/*.pdf$','tdm-reservation':1}]),'https://stadt.de/%7Eplans/a.pdf')?.['tdm-reservation'],1);
 assert.throws(()=>parseTdmRules([{location:'/', 'tdm-reservation':'yes'}]),/Invalid/);
});
test('Policy wildcards match literal segments without remote regex backtracking',{timeout:1000},()=>{
 for(const [pattern,value,expected] of [['/a*b$','/axbb',true],['/ab*bc$','/abc',false],['/a**b*c$','/abZZc',true],['/a*b','/abtail',true],['/a.b','/axb',false],['/a*$','/a',true]] as const)assert.equal(matchesPolicyPattern(pattern,value),expected);
 const hostile='/'+'a*'.repeat(1000)+'b$',target='/'+'a'.repeat(4000);
 assert.equal(matchesPolicyPattern(hostile,target),false);
 assert.equal(tdmRuleForUrl([{location:hostile,'tdm-reservation':0},{location:'/','tdm-reservation':1}],'https://stadt.de'+target)?.['tdm-reservation'],1);
});
test('HTTP and HTML meta reservations are recorded without granting copyright permission',()=>{
 const header=inspectResourcePolicy('https://stadt.de/a.pdf',{'tdm-reservation':'1','tdm-policy':'https://stadt.de/policy.json'},Buffer.from('%PDF-1.7'),'application/pdf');
 assert.equal(header.reservation,1);assert.equal(header.evidence[0].locator,'HTTP TDM-Reservation');
 const meta=inspectResourcePolicy('https://stadt.de/page',{},Buffer.from('<meta name="tdm-reservation" content="1"><h1>Plan</h1>'),'text/html');assert.equal(meta.reservation,1);
 const absent=inspectResourcePolicy('https://stadt.de/page',{},Buffer.from('<h1>Öffentliche Bekanntmachung</h1>'),'text/html');assert.equal(absent.reservation,null);assert.equal(absent.access,'public');
});
test('access barriers do not become municipal source content',()=>{
 const cases=[['<title>Login</title><input type="password">','authentication'],['<title>Just a moment</title><form id="challenge-form"></form>','captcha'],['<h1>Zahlung erforderlich</h1>','paywall']] as const;
 for(const [html,expected] of cases)assert.equal(inspectResourcePolicy('https://stadt.de/',{},Buffer.from(html),'text/html').access,expected);
 assert.equal(inspectResourcePolicy('https://stadt.de/',{},Buffer.from('<h1>Bauleitplanung</h1><footer><a href="/login">Login</a></footer>'),'text/html').access,'public');
});

const councilUrl='https://strausberg.allris.cloud/public/si010';
const decision=ownerRobotsOverrideFor(councilUrl)!;
const checkedAt='2026-10-11T12:00:00.000Z';
function councilPolicy():SourceAccessPolicy {
 return {robots:{state:'blocked',url:'https://strausberg.allris.cloud/robots.txt',sha256:'a'.repeat(64),checkedAt},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only',ownerRobotsOverride:decision,robotsStatus:'disallowed',override:'owner-approved 2026-10-11',documentOrigin:{classification:'official_work',method:'rules',classifierVersion:DOCUMENT_ORIGIN_CLASSIFIER_VERSION,url:councilUrl,sha256:'b'.repeat(64),classifiedAt:checkedAt,evidence:[{locator:'synthetic fixture',value:'administrative authorship and formal work fixture'}]}};
}
test('global civic owner decision is exact and bound independently to each public host',()=>{
 assert.deepEqual(decision,{host:'strausberg.allris.cloud',reason:'public civic sources, owner decision',date:'2026-10-11',approver:'owner',id:'owner-2026-10-11-public-civic-sources'});
 assert.equal(Object.isFrozen(decision),true);
 assert.equal(ownerRobotsOverrideApplies('https://STRAUSBERG.ALLRIS.CLOUD/public/doc',JSON.parse(JSON.stringify(decision))),true);
 for(const url of ['not a URL','file://strausberg.allris.cloud/public','https://strausberg.allris.cloud./public','https://strausberg.allris.cloud@127.0.0.1/public','https://user@strausberg.allris.cloud/public','http://127.0.0.1/','http://[::1]/','http://10.0.0.1/','https://localhost/','https://host.internal/','https://stadt.de:8443/','https://stadt.de/?token=credential']){
  assert.equal(ownerRobotsOverrideFor(url),null,url);assert.equal(ownerRobotsOverrideApplies(url,decision),false,url);
 }
 for(const url of ['https://child.strausberg.allris.cloud/public','https://other.allris.cloud/public','https://stadt.de/']){
  const own=ownerRobotsOverrideFor(url)!;assert.equal(own.host,new URL(url).hostname);
  assert.equal(ownerRobotsOverrideApplies(url,own),true);assert.equal(ownerRobotsOverrideApplies(url,decision),false);
 }
 for(const key of ['host','reason','date','approver','id'] as const){
  assert.equal(ownerRobotsOverrideApplies(councilUrl,{...decision,[key]:'forged'}),false,key);
  const missing:Record<string,unknown>={...decision};delete missing[key];assert.equal(ownerRobotsOverrideApplies(councilUrl,missing),false,key);
 }
 for(const supplied of [undefined,null,[],{},Object.create(decision),{...decision,extra:'unapproved'}])assert.equal(ownerRobotsOverrideApplies(councilUrl,supplied),false);
});
test('effective robots permission preserves blocked evidence and binds exception to document and policy origin',()=>{
 const policy=councilPolicy(),document={url:councilUrl,mimeType:'text/html',sha256:'b'.repeat(64)};
 assert.equal(effectiveRobotsPermission(policy,councilUrl),true);
 assert.deepEqual(assertSubscriptionSourcePolicy(policy,document),policy);
 assert.equal(policy.robots.state,'blocked');
 assert.throws(()=>assertSubscriptionSourcePolicy(policy),/blocks extraction/);
 for(const url of ['https://other.allris.cloud/public/doc','https://strausberg.allris.cloud./public/doc','https://strausberg.allris.cloud:8443/public/doc','http://strausberg.allris.cloud/public/doc','http://127.0.0.1/doc']){
  assert.equal(effectiveRobotsPermission(policy,url),false,url);
  assert.throws(()=>assertSubscriptionSourcePolicy(policy,{...document,url}),/blocks extraction/);
 }
 for(const missing of ['ownerRobotsOverride','robotsStatus','override'] as const){
  const changed={...policy};delete changed[missing];
  assert.equal(effectiveRobotsPermission(changed,councilUrl),false);
  assert.equal(SourceAccessPolicySchema.safeParse(changed).success,false);
 }
 for(const robots of [{...policy.robots,state:'unavailable' as const},{...policy.robots,state:'allowed' as const},{...policy.robots,sha256:undefined},{...policy.robots,checkedAt:undefined},{...policy.robots,sha256:'forged'},{...policy.robots,checkedAt:'invalid'},{...policy.robots,url:'https://other.allris.cloud/robots.txt'},{...policy.robots,url:'https://strausberg.allris.cloud/policy'},{...policy.robots,url:'https://strausberg.allris.cloud/robots.txt?other'}]){
  assert.equal(effectiveRobotsPermission({...policy,robots},councilUrl),false);
  assert.equal(SourceAccessPolicySchema.safeParse({...policy,robots}).success,false);
 }
 const unavailable:SourceAccessPolicy={...policy,robots:{state:'unavailable',url:policy.robots.url,checkedAt},robotsStatus:'unavailable'};
 assert.equal(effectiveRobotsPermission(unavailable,councilUrl),true);
 assert.deepEqual(SourceAccessPolicySchema.parse(unavailable),unavailable);
 assert.equal(unavailable.robots.sha256,undefined);
 assert.equal(effectiveRobotsPermission({...unavailable,robotsStatus:'disallowed'},councilUrl),false);
 assert.equal(effectiveRobotsPermission({...unavailable,robots:{...unavailable.robots,checkedAt:undefined}},councilUrl),false);
 const {ownerRobotsOverride:_decision,robotsStatus:_status,override:_override,documentOrigin:_origin,...historical}=policy;
 assert.equal(SourceAccessPolicySchema.safeParse(historical).success,true);
 assert.equal(effectiveRobotsPermission(historical,councilUrl),false);
 const allowed={...historical,robots:{state:'allowed' as const,url:'https://example.org/robots.txt'}};
 assert.deepEqual(assertSubscriptionSourcePolicy(allowed),allowed);
});
test('robots exception never replaces source registration, access or TDM/PDF gates',()=>{
 const policy=councilPolicy(),document={url:councilUrl,mimeType:'text/html',sha256:'b'.repeat(64)},registered={url:councilUrl,ownerRobotsOverride:decision};
 assert.deepEqual(assertSubscriptionSourcePolicy(policy,document,registered),policy);
 for(const source of [{url:councilUrl},{url:null,ownerRobotsOverride:decision},{url:'https://other.allris.cloud/',ownerRobotsOverride:decision},{...registered,ownerRobotsOverride:{...decision,id:'forged'}}])assert.throws(()=>assertSubscriptionSourcePolicy(policy,document,source),/registered source/);
 const linkedSource={url:'https://stadt.de/official-index',ownerRobotsOverride:ownerRobotsOverrideFor('https://stadt.de/official-index')!};
 assert.deepEqual(assertSubscriptionSourcePolicy(policy,document,linkedSource),policy);
 for(const state of ['reserved','unavailable'] as const)assert.throws(()=>assertSubscriptionSourcePolicy({...policy,tdm:{state,evidence:[]}},document),/blocks extraction/);
 for(const access of ['authentication','captcha','paywall'] as const)assert.throws(()=>assertSubscriptionSourcePolicy({...policy,access},document),/blocks extraction/);
 const pdf={...document,mimeType:'application/pdf'},proof={url:document.url,sha256:document.sha256,checkedAt,locator:'PDF.js 6.3.289 XMP metadata (pdf-tdm-v2)',value:'no_tdm_reservation_field'};
 assert.throws(()=>assertSubscriptionSourcePolicy(policy,pdf),/parsed metadata evidence/);
 const permitted={...policy,tdm:{...policy.tdm,evidence:[proof]}};
 assert.equal(assertSubscriptionSourcePolicy(permitted,pdf).robots.state,'blocked');
 for(const invalid of [{...proof,sha256:'c'.repeat(64)},{...proof,url:'https://other.allris.cloud/doc'},{...proof,locator:'Raw PDF metadata regex'},{...proof,value:'metadata_parse_failed'}])assert.throws(()=>assertSubscriptionSourcePolicy({...permitted,tdm:{...permitted.tdm,evidence:[invalid]}},pdf),/parsed metadata evidence/);
 assert.throws(()=>assertSubscriptionSourcePolicy({...permitted,tdm:{...permitted.tdm,evidence:[proof,{...proof,value:'1'}]}},pdf),/reserves TDM/);
});
test('registry config preserves global civic owner decisions and honest historical denial evidence',async()=>{
 const registry=await loadDistrictRegistry(new URL('../sources/district-registry.json',import.meta.url).pathname);
 const configured=registry.municipalities.flatMap(city=>city.sources).filter(source=>source.ownerRobotsOverride);
 const publicSources=registry.municipalities.flatMap(city=>city.sources).filter(source=>source.url);
 assert.deepEqual(configured.map(source=>source.id).sort(),publicSources.filter(source=>source.kind!=='structured').map(source=>source.id).sort());
 assert.ok(publicSources.filter(source=>source.kind==='structured').every(source=>source.checkState==='not_checked'&&!source.ownerRobotsOverride),'Uninspected structured distributions do not inherit website owner approval');
 for(const item of configured){assert.equal(ownerRobotsOverrideApplies(item.url!,item.ownerRobotsOverride),true);assert.equal(item.override,'owner-approved 2026-10-11');}
 const source=configured.find(item=>item.id==='strausberg-council')!;
 assert.equal(source.id,'strausberg-council');assert.deepEqual(source.ownerRobotsOverride,decision);
 assert.equal(source.robotsStatus,'disallowed');assert.equal(source.override,'owner-approved 2026-10-11');
 assert.equal(source.robots!.checkedAt,'2026-10-10T19:05:13.370Z');
 assert.equal(source.robots!.evidence[0].sha256,'133e4db054e73a10017a1f429c80c35cd5bfa9c3a1aba581b364ecc459c48a4b');
 assert.match(source.robots!.reason!,/historical/);assert.equal(source.tdm!.status,'not_checked');assert.equal(source.rights!.licence,'unknown');
 for(const changed of [{...source,url:'https://other.allris.cloud/public'},{...source,ownerRobotsOverride:{...decision,date:'2026-10-10'}},{...source,ownerRobotsOverride:undefined},{...source,override:undefined},{...source,robots:{...source.robots,evidence:[]}},{...source,robots:{...source.robots,url:'https://other.allris.cloud/robots.txt'}}])assert.equal(districtSourceSchema.safeParse(changed).success,false);
 const {ownerRobotsOverride:_decision,robotsStatus:_status,override:_override,...historical}=source;
 assert.equal(districtSourceSchema.safeParse(historical).success,true);
});

test('TDM override audit cannot relabel reservations or stand in for source-bound origin proof',()=>{
 const policy=councilPolicy(),document={url:councilUrl,mimeType:'text/html',sha256:'b'.repeat(64)};
 const reserved:SourceAccessPolicy={...policy,documentOrigin:undefined,tdm:{state:'reserved',evidence:[{url:councilUrl,locator:'HTTP TDM-Reservation',value:'1'}]},ownerTdmOverride:decision,tdmOverride:'owner-approved 2026-10-11'};
 assert.equal(SourceAccessPolicySchema.parse(reserved).tdm.state,'reserved');
 assert.throws(()=>assertSubscriptionSourcePolicy(reserved,document));
 for(const changed of [
  {...reserved,ownerTdmOverride:undefined},
  {...reserved,tdmOverride:undefined},
  {...reserved,ownerTdmOverride:{...decision,host:'other.allris.cloud'}},
  {...reserved,tdm:{...reserved.tdm,state:'not_reserved'}},
  {...reserved,tdm:{...reserved.tdm,state:'unavailable'}},
 ])assert.equal(SourceAccessPolicySchema.safeParse(changed).success,false);
 const inspected=inspectResourcePolicy(councilUrl,{'x-robots-tag':'noai'},Buffer.from('<h1>Amtliche Bekanntmachung</h1>'),'text/html');
 assert.equal(inspected.reservation,1);
 assert.equal(inspected.evidence[0].value,'noai');
});

test('origin matrix permits bound official reservations without erasing them and excludes restricted nonofficial material',()=>{
 const policy=councilPolicy(),document={url:councilUrl,sha256:'b'.repeat(64),mimeType:'text/html'};
 const {ownerRobotsOverride:_owner,robotsStatus:_status,override:_override,...base}=policy;
 const allowed:SourceAccessPolicy={...base,robots:{...base.robots,state:'allowed'}};
 for(const robots of ['allowed','blocked','unavailable'] as const)for(const classification of ['official_work','third_party','mixed','unknown'] as const)for(const reserved of [false,true]){
  const candidate:SourceAccessPolicy={...(robots==='allowed'?allowed:policy),robots:{...policy.robots,state:robots},...(robots==='unavailable'?{robotsStatus:'unavailable' as const}:{}),documentOrigin:{...policy.documentOrigin!,classification},tdm:{state:reserved?'reserved':'not_declared',evidence:reserved?[{url:councilUrl,locator:'HTTP TDM-Reservation',value:'1'}]:[]},...(reserved&&classification==='official_work'?{ownerTdmOverride:decision,tdmOverride:'owner-approved 2026-10-11' as const}:{})};
  const excluded=classification!=='official_work'&&(robots==='blocked'||reserved);
  assert.equal(documentOriginExcludes(candidate,document),excluded,JSON.stringify({robots,classification,reserved}));
  assert.equal(effectiveSourcePermission(candidate,document),!excluded);
  if(excluded)assert.throws(()=>assertSubscriptionSourcePolicy(candidate,document),/blocks extraction/);
  else {const parsed=assertSubscriptionSourcePolicy(candidate,document);assert.equal(parsed.tdm.state,candidate.tdm.state);assert.equal(parsed.documentOrigin!.classification,classification);}
 }
 for(const documentOrigin of [undefined,{...policy.documentOrigin!,url:'https://other.allris.cloud/doc'},{...policy.documentOrigin!,sha256:'c'.repeat(64)}]){
  assert.equal(documentOriginExcludes({...policy,documentOrigin},document),true);
  assert.equal(effectiveSourcePermission({...policy,documentOrigin},document),false);
 }
 assert.equal(documentOriginExcludes({...policy,documentOrigin:{...policy.documentOrigin!,classification:'forged'} as never},document),true);
 const pdf={...document,mimeType:'application/pdf'},reserved:SourceAccessPolicy={...allowed,tdm:{state:'reserved',evidence:[{url:councilUrl,sha256:document.sha256,checkedAt,locator:'PDF.js 6.3.289 XMP metadata (pdf-tdm-v2)',value:'1'}]},ownerTdmOverride:decision,tdmOverride:'owner-approved 2026-10-11'};
 assert.equal(assertSubscriptionSourcePolicy(reserved,pdf).tdm.evidence[0].value,'1');
 assert.equal(assertSubscriptionSourcePolicy(reserved,pdf).robots.state,'allowed');
 assert.equal(assertSubscriptionSourcePolicy(reserved,pdf).override,undefined);
 assert.throws(()=>assertSubscriptionSourcePolicy({...reserved,tdm:{...reserved.tdm,evidence:[]}},pdf),/parsed metadata evidence/);
 assert.throws(()=>assertSubscriptionSourcePolicy({...reserved,ownerTdmOverride:undefined,tdmOverride:undefined},pdf),/blocks extraction/);
});

test('reviewed owner GENESIS API exemption changes only robots exclusion, never origin or TDM',()=>{
 const url='https://www.regionalstatistik.de/genesisws/rest/2020/data/table',account=ownerGenesisAccessFor(url);assert.ok(account);
 const audit={decisionId:account.id,credentialKind:'token' as const},grant=ownerGenesisRobotsDecisionFor(url,audit);assert.ok(grant);
 assert.equal(grant.id,'r1-genesis-api-robots-2026-10-13');assert.ok(Object.isFrozen(grant));
 const owner=ownerRobotsOverrideFor(url);assert.ok(owner);
 const document={url,sha256:'b'.repeat(64),mimeType:'application/json'};
 const base:SourceAccessPolicy={robots:{state:'blocked',url:'https://www.regionalstatistik.de/robots.txt',sha256:'a'.repeat(64),checkedAt},tdm:{state:'not_declared',evidence:[]},access:'authenticated_owner_account',ownerAccountAccess:{...audit,robotsDecisionId:grant.id},legalClassification:'not_assessed',publication:'facts_with_attribution_only',ownerRobotsOverride:owner,robotsStatus:'disallowed',override:'owner-approved 2026-10-11',documentOrigin:{classification:'unknown',method:'rules',classifierVersion:DOCUMENT_ORIGIN_CLASSIFIER_VERSION,url,sha256:document.sha256,classifiedAt:checkedAt,evidence:[]}};
 for(const endpoint of [url,url+'file'])for(const credentialKind of ['token','password'] as const){
  const exact={...document,url:endpoint},policy:SourceAccessPolicy={...base,ownerAccountAccess:{...base.ownerAccountAccess!,credentialKind},documentOrigin:{...base.documentOrigin!,url:endpoint}};
  assert.equal(documentOriginExcludes(policy,exact),false);assert.equal(effectiveSourcePermission(policy,exact),true);
  const parsed=assertSubscriptionSourcePolicy(policy,exact,{url:endpoint,ownerRobotsOverride:owner});
  assert.equal(parsed.documentOrigin!.classification,'unknown');assert.equal(parsed.robots.state,'blocked');assert.equal(parsed.ownerAccountAccess!.robotsDecisionId,grant.id);
  assert.ok(ContentFreeSourcePolicySchema.safeParse(policy).success);
  const reserved:SourceAccessPolicy={...policy,tdm:{state:'reserved',evidence:[]},ownerTdmOverride:owner,tdmOverride:'owner-approved 2026-10-11'};
  assert.equal(documentOriginExcludes(reserved,exact),true);assert.equal(effectiveSourcePermission(reserved,exact),false);
  assert.throws(()=>assertSubscriptionSourcePolicy(reserved,exact),/blocks extraction/);
 }
 for(const changed of [
  {...base,access:'public' as const,ownerAccountAccess:undefined},
  {...base,ownerAccountAccess:undefined},
  {...base,ownerAccountAccess:audit},
  {...base,ownerAccountAccess:{...base.ownerAccountAccess!,decisionId:'forged'}},
  {...base,ownerAccountAccess:{...base.ownerAccountAccess!,robotsDecisionId:'forged'}},
 ]){
  assert.equal(documentOriginExcludes(changed,document),true);assert.equal(effectiveSourcePermission(changed,document),false);
  assert.throws(()=>assertSubscriptionSourcePolicy(changed,document));
 }
 for(const endpoint of ['https://other.de/genesisws/rest/2020/data/table','https://www.regionalstatistik.de/genesisws/rest/2020/data/cube','https://www.regionalstatistik.de/genesisws/rest/2020/metadata/table','https://www.regionalstatistik.de/web/page','http://www.regionalstatistik.de/genesisws/rest/2020/data/table',url+'?x=1',url+'#fragment']){
  const exact={...document,url:endpoint},policy:SourceAccessPolicy={...base,documentOrigin:{...base.documentOrigin!,url:endpoint}};
  assert.equal(ownerGenesisRobotsDecisionFor(endpoint,audit),null);
  assert.equal(documentOriginExcludes(policy,exact),true);assert.equal(effectiveSourcePermission(policy,exact),false);
 }
 for(const documentOrigin of [undefined,{...base.documentOrigin!,sha256:'c'.repeat(64)},{...base.documentOrigin!,classifierVersion:'document-origin-rules-v1'}]){
  assert.equal(documentOriginExcludes({...base,documentOrigin},document),true);assert.equal(effectiveSourcePermission({...base,documentOrigin},document),false);
 }
 for(const changed of [{...base,robots:{...base.robots,sha256:undefined}},{...base,tdm:{state:'unavailable' as const,evidence:[]}},{...base,tdm:{...base.tdm,referenceStatus:'unavailable' as const}}])assert.equal(effectiveSourcePermission(changed,document),false);
 assert.equal(SourceAccessPolicySchema.safeParse({...base,robots:{...base.robots,state:'allowed'},ownerRobotsOverride:undefined,robotsStatus:undefined,override:undefined}).success,false);
 assert.equal(SourceAccessPolicySchema.safeParse({...base,ownerAccountAccess:{...base.ownerAccountAccess!,robotsDecisionId:'forged'}}).success,false);
});
test('excluded acquisition rows preserve honest policy evidence but cannot enter retained corpus documents',()=>{
 const policy=councilPolicy(),excluded={id:'excluded:fixture',municipalityId:'strausberg',ags:'12064472',districtId:'maerkisch-oderland',sourceId:'strausberg-council',url:councilUrl,sha256:'b'.repeat(64),mimeType:'application/pdf',retrievedAt:checkedAt,checkedAt,status:200,observationPath:'observations/fixture.json',policy:{...policy,documentOrigin:{...policy.documentOrigin!,classification:'third_party' as const}},sizeBytes:100,documentDate:null,adapter:'official-pdf',metadata:{},exclusion:{reason:'non_official_restricted' as const,excludedAt:checkedAt,previousManagedCopy:'not_managed' as const}};
 assert.deepEqual(excludedCrawlDocumentSchema.parse(excluded),excluded);
 assert.equal(excludedCrawlDocumentSchema.safeParse({...excluded,localPath:'forged-cas-path'}).success,false);
 assert.equal(excludedCrawlDocumentSchema.safeParse({...excluded,policy}).success,false);
 const corpus=frozenCorpusSchema.parse({schemaVersion:'stadtstack-crawl-index-v1',documents:[],excludedDocuments:[excluded]});
 assert.equal(corpus.documents.length,0);assert.equal(corpus.excludedDocuments![0].policy.robots.state,'blocked');
 assert.equal(frozenCorpusSchema.safeParse({schemaVersion:'stadtstack-crawl-index-v1',documents:[{...excluded,localPath:'forged-cas-path'}]}).success,false);
});

test('policy metadata hashes source-controlled declarations instead of retaining source text',()=>{
 const secret='FULL_SOURCE_TEXT_MUST_NOT_SURVIVE_IN_POLICY_METADATA_'.repeat(3000);
 const inspected=inspectResourcePolicy(councilUrl,{'tdm-policy':secret,'x-robots-tag':'noai, '+secret},Buffer.from('<meta name="tdm-policy" content="'+secret+'"><meta name="tdm-reservation" content="1"><h1>Public source</h1>'),'text/html');
 assert.equal(inspected.reservation,1);assert.equal(inspected.unavailable,true);
 const safe=projectSourcePolicyMetadata({...councilPolicy(),tdm:{state:'reserved',referenceStatus:'unavailable',evidence:inspected.evidence}});
 assert.equal(ContentFreeSourcePolicySchema.safeParse(safe).success,true);
 assert.equal(JSON.stringify(safe).includes(secret),false);
 const reference=safe.tdm.evidence.find(item=>item.locator==='HTTP TDM-Policy')!;
 assert.equal(reference.value,'invalid_policy_reference');assert.equal(reference.valueSha256,sha256(secret));assert.equal(reference.valueBytes,Buffer.byteLength(secret));
 assert.equal(safe.tdm.state,'reserved');assert.equal(safe.robots.state,'blocked');
 assert.equal(effectiveSourcePermission(safe,{url:councilUrl,sha256:'b'.repeat(64)}),false);
 assert.deepEqual(projectSourcePolicyMetadata(safe),safe);
 const referenceUrl='https://stadt.de/tdm-policy';
 const valid=inspectResourcePolicy(councilUrl,{'tdm-policy':referenceUrl},Buffer.from('public'),'text/plain');
 assert.equal(valid.unavailable,false);assert.equal(valid.evidence[0].value,'policy_reference_present');assert.equal(valid.evidence[0].valueSha256,sha256(referenceUrl));
 assert.equal(JSON.stringify(valid.evidence).includes(referenceUrl),false);
});
test('metadata exemptions reject arbitrary locators/origin text and preserve overflow declaration inventory',()=>{
 const policy=councilPolicy(),raw={...policy,tdm:{state:'reserved' as const,evidence:[{url:councilUrl,locator:'SOURCE_BODY_IN_LOCATOR',value:'SOURCE_BODY_IN_VALUE'}]}};
 assert.equal(SourceAccessPolicySchema.safeParse(raw).success,true);
 assert.equal(ContentFreeSourcePolicySchema.safeParse(raw).success,false);
 const projected=projectSourcePolicyMetadata(raw);
 assert.equal(ContentFreeSourcePolicySchema.safeParse(projected).success,true);
 assert.equal(projected.tdm.evidence[0].locatorSha256,sha256('SOURCE_BODY_IN_LOCATOR'));
 assert.equal(JSON.stringify(projected).includes('SOURCE_BODY_IN_'),false);
 const many={...policy,tdm:{state:'reserved' as const,evidence:Array.from({length:100},(_,index)=>({url:councilUrl,locator:'HTML meta[name=tdm-policy]',value:'https://stadt.de/policy/'+index}))}};
 const bounded=projectSourcePolicyMetadata(many),inventory=bounded.tdm.evidence.at(-1)!;
 assert.equal(bounded.tdm.evidence.length,MAX_POLICY_METADATA_EVIDENCE);
 assert.equal(inventory.value,'policy_evidence_inventory');assert.equal(inventory.itemCount,100);assert.match(inventory.valueSha256!,/^[a-f0-9]{64}$/);
 assert.equal(bounded.tdm.state,'reserved');assert.equal(ContentFreeSourcePolicySchema.safeParse(bounded).success,true);
 assert.deepEqual(projectSourcePolicyMetadata(bounded),bounded);
 assert.throws(()=>parseTdmRules([{location:'/','tdm-reservation':1,'tdm-policy':'unstructured source text'}]),/Invalid/);
 assert.throws(()=>parseTdmRules([{location:'/','tdm-reservation':0,sourceBody:'must not bypass policy-resource validation'}]),/Invalid/);
});
test('old origin-rule authority cannot authorize a new restricted extraction',()=>{
 const policy=councilPolicy(),old={...policy,documentOrigin:{...policy.documentOrigin!,classifierVersion:'document-origin-rules-v1'}};
 assert.equal(SourceAccessPolicySchema.safeParse(old).success,true);
 assert.equal(effectiveSourcePermission(old,{url:councilUrl,sha256:'b'.repeat(64)}),false);
 assert.throws(()=>assertSubscriptionSourcePolicy(old,{url:councilUrl,sha256:'b'.repeat(64),mimeType:'text/html'}),/blocks extraction/);
});
test('bounded named source targets are registered without inventing fresh acquisition',async()=>{
 const registry=await loadDistrictRegistry(new URL('../sources/district-registry.json',import.meta.url).pathname);
 const hoppegarten=registry.municipalities.find(city=>city.id==='hoppegarten')!.sources.find(source=>source.id==='hoppegarten-website')!;
 assert.ok(hoppegarten.crawlScope!.pageRoots.includes('https://www.gemeinde-hoppegarten.de/news/1/1240589/nachrichten/kommunale-w%C3%A4rmeplanung-in-hoppegarten.html'));
 const ruedersdorf=registry.municipalities.find(city=>city.id==='ruedersdorf-bei-berlin')!.sources.find(source=>source.id==='ruedersdorf-bei-berlin-website')!;
 assert.ok(ruedersdorf.crawlScope!.pageRoots.includes('https://www.ruedersdorf.de/meine-gemeinde/konzepte/kommunale-waermeplanung/'));
 const seed=registry.municipalities.find(city=>city.id==='strausberg')!.seedDocuments.find(seed=>seed.url==='https://bb.beteiligung.diplanung.de/file/fnp-solarpark-flugplatz/e85e3cda-c72c-405f-9b66-bd1ac7d6c347')!;
 assert.equal(seed.sourceId,'strausberg-participation');assert.equal(seed.documentDate,'2025-08-07');
 assert.equal(seed.evidence[0].sha256,'6b3d0a467c73bac1617dbcc88a692d9cc3319ec2d17ca22dbd3e5d91c764ea55');
 assert.equal(seed.evidence[0].retrievedAt,undefined);assert.match(seed.evidence[0].locator,/current managed reacquisition/);
});

test('present malformed reservation declarations are not absence and retain any explicit one',()=>{
 assert.deepEqual(parseTdmReservation(undefined),{state:'absent',reservation:null});
 for(const [value,reservation] of [['0',0],['1',1],[' 1 ',1]] as const)assert.deepEqual(parseTdmReservation(value),{state:'valid',reservation});
 for(const [value,reservation] of [['1, 1',1],['1, 0',1],['0, 1',1],['garbage, 1',1],['0, 0',null],['',null],['   ',null],['PRIVATE-MALFORMED-DECLARATION',null]] as const){
  assert.deepEqual(parseTdmReservation(value),{state:'invalid',reservation});
  const inspected=inspectResourcePolicy(councilUrl,{'tdm-reservation':value},Buffer.from('Synthetic source'),'text/plain');
  assert.equal(inspected.reservation,reservation);assert.equal(inspected.unavailable,true);assert.equal(inspected.declarationUnavailable,true);assert.equal(inspected.referenceUnavailable,false);
  const marker=inspected.evidence.find(item=>item.value==='invalid_reservation_declaration')!;assert.equal(marker.valueSha256,sha256(value));assert.equal(marker.valueBytes,Buffer.byteLength(value));assert.equal(marker.locator,'HTTP TDM-Reservation');
  const candidate:SourceAccessPolicy={...councilPolicy(),tdm:{state:reservation===1?'reserved':'unavailable',evidence:inspected.evidence},...(reservation===1?{ownerTdmOverride:decision,tdmOverride:'owner-approved 2026-10-11' as const}:{})},safe=projectSourcePolicyMetadata(candidate);
  assert.equal(safe.tdm.declarationStatus,'unavailable');assert.equal(safe.tdm.referenceStatus,undefined);assert.equal(ContentFreeSourcePolicySchema.safeParse(safe).success,true);
  assert.equal(effectiveSourcePermission(safe,{url:councilUrl,sha256:'b'.repeat(64)}),false);assert.throws(()=>assertSubscriptionSourcePolicy(safe,{url:councilUrl,sha256:'b'.repeat(64),mimeType:'text/plain'}));
  const forged=structuredClone(safe);delete forged.tdm.declarationStatus;assert.equal(SourceAccessPolicySchema.safeParse(forged).success,false);
  assert.equal(JSON.stringify(safe).includes('PRIVATE-MALFORMED-DECLARATION'),false);assert.deepEqual(projectSourcePolicyMetadata(safe),safe);
 }
});

test('HTML reservation fields use the same fail-closed parser, including missing content and bounded evidence',()=>{
 for(const html of ['<meta name="tdm-reservation">','<meta name="tdm-reservation" content="garbage">','<meta name="tdm-reservation" content="0, 0">']){
  const result=inspectResourcePolicy(councilUrl,{},Buffer.from(html),'text/html');assert.equal(result.declarationUnavailable,true);assert.equal(result.reservation,null);assert.equal(result.evidence[0].value,'invalid_reservation_declaration');
 }
 const many='<meta name="tdm-reservation" content="0">'.repeat(MAX_POLICY_METADATA_EVIDENCE+10)+'<meta name="tdm-reservation" content="1, 1">';
 const result=inspectResourcePolicy(councilUrl,{},Buffer.from(many),'text/html');assert.equal(result.reservation,1);assert.equal(result.declarationUnavailable,true);assert.equal(result.unavailable,true);assert.ok(result.evidence.length<=MAX_POLICY_METADATA_EVIDENCE);
});
