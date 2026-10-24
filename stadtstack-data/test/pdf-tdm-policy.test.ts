import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {hash} from '../src/common.ts';
import {inspectPdfTdmPolicy as sandboxPdfTdmPolicy,PDF_TDM_POLICY_VERSION} from '../src/pdf-tdm-policy.ts';
import {readParserReview,withParserSandbox,type ParserSourceContext} from '../src/district-parser-isolation.ts';
import {PREPARED_VM_ROOT} from '../src/district-prepared-document.ts';
import {metadataPdf,reservedXmp} from './fixtures/tdm-pdf.ts';
import {inspectResourcePolicySandbox} from '../src/district-policy-inspection.ts';
import {classifyDocumentOrigin} from '../src/document-origin.ts';
import {assertCivicPolicyAuthority,CIVIC_ACQUISITION_DECISION_ID} from '../src/civic-opt-out.ts';
// A cold invocation enrolls two real scopes (version probe + artifact), each with ~100 s of host inventory work.
const reviewedSecurityOptions={skip:process.env.STADTSTACK_PARSER_SECURITY_TESTS!=='1',timeout:2*240000};
async function withPdfInspectionFixture<T>(bytes:Buffer,inspect:(context:ParserSourceContext)=>Promise<T>):Promise<T>{
 await readParserReview(); // No environment flag can approve or provision the sandbox.
 const authority=await assertCivicPolicyAuthority();
 return inspect({root:join(dirname(PREPARED_VM_ROOT),'parser-security-fixtures'),kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256,purpose:'classification',bindings:[{phase:'pre-admission',url:'https://pdf-tdm-fixture.invalid/synthetic-input',sourceSha256:hash(bytes)}]});
}
async function inspectPdfTdmPolicy(bytes:Buffer,sha256:string,cacheRoot:string){
 return withPdfInspectionFixture(bytes,context=>sandboxPdfTdmPolicy(bytes,sha256,cacheRoot,context));
}

test('one PDF sandbox keeps separate-execution outcomes and the exact checked-result cache key', {...reviewedSecurityOptions,timeout:4*240000}, async t=>{
 const cache=await mkdtemp(join(tmpdir(),'pdf-tdm-batch-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const bytes=metadataPdf(reservedXmp),sha256=hash(bytes),commands:string[]=[];
 await withPdfInspectionFixture(bytes,async context=>{
  const url=context.bindings[0].url,input={url,mimeType:'application/pdf',bytes};
  const combined=await withParserSandbox(bytes,async sandbox=>{
   const run=sandbox.run;
   sandbox.run=async(tool,args,timeoutMs)=>{commands.push(args.at(-1)==='--version'?'version':args.includes('/opt/stadtstack/src/pdf-tdm-policy-worker.ts')?'metadata':args[2]);return run(tool,args,timeoutMs);};
   const resource=await inspectResourcePolicySandbox(url,{},bytes,input.mimeType,context,sandbox);
   const origin=await classifyDocumentOrigin(input,{scratch:context,sandbox});
   const pdf=await sandboxPdfTdmPolicy(bytes,sha256,cache,context,sandbox);
   return {resource,origin,pdf};
  },context);
  assert.deepEqual(commands,['resource','origin','version','metadata']);
  const resource=await inspectResourcePolicySandbox(url,{},bytes,input.mimeType,context);
  const origin=await classifyDocumentOrigin(input,{scratch:context});
  const pdf=await sandboxPdfTdmPolicy(bytes,sha256,cache,context);
  assert.equal(JSON.stringify(resource),JSON.stringify(combined.resource));
  // Only the independent worker observation clock differs between executions.
  assert.equal(JSON.stringify({...origin,classifiedAt:combined.origin.classifiedAt}),JSON.stringify(combined.origin));
  assert.equal(pdf.fromCache,true);assert.equal(combined.pdf.fromCache,false);
  assert.equal(JSON.stringify({...pdf,fromCache:false}),JSON.stringify(combined.pdf));
  const review=await readParserReview();
  assert.deepEqual(await readdir(join(cache,'pdf-tdm-policy')),[`${PDF_TDM_POLICY_VERSION}-${pdf.pdfjsVersion}-${review.imageId.slice(7)}-${review.runnerSha256}-${sha256}.json`]);
  // A hit still runs origin/resource; it adds neither a version nor metadata command.
  commands.length=0;
  await withParserSandbox(bytes,async sandbox=>{
   const run=sandbox.run;sandbox.run=async(tool,args,timeoutMs)=>{commands.push(args[2]);return run(tool,args,timeoutMs);};
   await inspectResourcePolicySandbox(url,{},bytes,input.mimeType,context,sandbox);
   await classifyDocumentOrigin(input,{scratch:context,sandbox});
   assert.equal((await sandboxPdfTdmPolicy(bytes,sha256,cache,context,sandbox)).fromCache,true);
  },context);
  assert.deepEqual(commands,['resource','origin']);
 });
});

test('compressed XMP reservation with an alternate namespace prefix is detected and cached by digest/version', reviewedSecurityOptions, async t=>{
 const cache=await mkdtemp(join(tmpdir(),'pdf-tdm-compressed-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const bytes=metadataPdf(reservedXmp),digest=hash(bytes);assert.equal(bytes.includes(Buffer.from('mine:reservation')),false);
 const first=await inspectPdfTdmPolicy(bytes,digest,cache);assert.equal(first.finding.state,'checked');
 if(first.finding.state!=='checked')assert.fail('Compressed XMP must be parsed');
 assert.equal(first.finding.reservation,1);assert.equal(first.finding.policyPresent,true);assert.equal(first.policyVersion,PDF_TDM_POLICY_VERSION);assert.equal(first.fromCache,false);
 const second=await inspectPdfTdmPolicy(bytes,digest,cache);assert.equal(second.fromCache,true);assert.equal(second.checkedAt,first.checkedAt);
});
test('valid PDF without metadata has a checked absent reservation', reviewedSecurityOptions, async t=>{
 const cache=await mkdtemp(join(tmpdir(),'pdf-tdm-clear-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const absent=metadataPdf(),absentResult=await inspectPdfTdmPolicy(absent,hash(absent),cache);
 assert.deepEqual(absentResult.finding,{state:'checked',reservation:null,policyPresent:false,metadataPresent:false});
});
test('valid PDF with explicit zero has a checked zero reservation', reviewedSecurityOptions, async t=>{
 const cache=await mkdtemp(join(tmpdir(),'pdf-tdm-zero-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const zero=metadataPdf(reservedXmp.replace('<mine:reservation>1','<mine:reservation>0')),zeroResult=await inspectPdfTdmPolicy(zero,hash(zero),cache);
 assert.equal(zeroResult.finding.state,'checked');if(zeroResult.finding.state==='checked')assert.equal(zeroResult.finding.reservation,0);
});
for(const {name,bytes} of [
 {name:'malformed PDF',bytes:Buffer.from('%PDF-invalid')},
 {name:'compressed malformed metadata',bytes:metadataPdf('<x:xmpmeta><malformed>')},
]){
 test(`${name} is unavailable, never no-reservation`, reviewedSecurityOptions, async t=>{
  const cache=await mkdtemp(join(tmpdir(),'pdf-tdm-invalid-'));t.after(()=>rm(cache,{recursive:true,force:true}));
  const result=await inspectPdfTdmPolicy(bytes,hash(bytes),cache);assert.equal(result.finding.state,'unavailable');
 });
}
test('numeric XML references in TDM namespaces and values cannot hide a reservation', reviewedSecurityOptions, async t=>{
 const cache=await mkdtemp(join(tmpdir(),'pdf-tdm-entities-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const xml=reservedXmp.replace('http://www.w3.org/ns/tdmrep/','http://www.w3.org/ns/tdmrep&#47;').replace('<mine:reservation>1','<mine:reservation>&#49;');
 const bytes=metadataPdf(xml),result=await inspectPdfTdmPolicy(bytes,hash(bytes),cache);
 assert.equal(result.finding.state,'checked');if(result.finding.state==='checked')assert.equal(result.finding.reservation,1);
});
test('hexadecimal references and TDM attribute forms use the same XML decoding semantics', reviewedSecurityOptions, async t=>{
 const cache=await mkdtemp(join(tmpdir(),'pdf-tdm-hex-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const xml=reservedXmp.replace('http://www.w3.org/ns/tdmrep/','http://www.w3.org/ns/tdmrep&#x2f;').replace('<mine:reservation>1</mine:reservation>','').replace('xmlns:mine="http://www.w3.org/ns/tdmrep&#x2f;"','xmlns:mine="http://www.w3.org/ns/tdmrep&#x2f;" mine:reservation="&#x31;"');
 const bytes=metadataPdf(xml),result=await inspectPdfTdmPolicy(bytes,hash(bytes),cache);
 assert.equal(result.finding.state,'checked');if(result.finding.state==='checked')assert.equal(result.finding.reservation,1);
});
test('escaped namespace references are not decoded twice', reviewedSecurityOptions, async t=>{
 const cache=await mkdtemp(join(tmpdir(),'pdf-tdm-once-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const literalNamespace=metadataPdf(reservedXmp.replace('http://www.w3.org/ns/tdmrep/','http://www.w3.org/ns/tdmrep&amp;#47;'));
 const namespaceResult=await inspectPdfTdmPolicy(literalNamespace,hash(literalNamespace),cache);
 assert.equal(namespaceResult.finding.state,'checked');if(namespaceResult.finding.state==='checked')assert.equal(namespaceResult.finding.reservation,null);
});
for(const [name,value] of [['escaped decimal','&amp;#49;'],['escaped ampersand','&#38;#49;'],['literal CDATA','<![CDATA[&#49;]]>']]){
 test(`TDM reservation values retain single XML decoding: ${name}`, reviewedSecurityOptions, async t=>{
  const cache=await mkdtemp(join(tmpdir(),'pdf-tdm-once-'));t.after(()=>rm(cache,{recursive:true,force:true}));
  const bytes=metadataPdf(reservedXmp.replace('<mine:reservation>1',`<mine:reservation>${value}`)),result=await inspectPdfTdmPolicy(bytes,hash(bytes),cache);
  assert.equal(result.finding.state,'unavailable');
 });
}
test('CDATA retains a literal valid TDM reservation', reviewedSecurityOptions, async t=>{
 const cache=await mkdtemp(join(tmpdir(),'pdf-tdm-cdata-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const cdata=metadataPdf(reservedXmp.replace('<mine:reservation>1','<mine:reservation><![CDATA[1]]>')),cdataResult=await inspectPdfTdmPolicy(cdata,hash(cdata),cache);
 assert.equal(cdataResult.finding.state,'checked');if(cdataResult.finding.state==='checked')assert.equal(cdataResult.finding.reservation,1);
});
const dtd=reservedXmp.replace('<?xml version="1.0"?>','<?xml version="1.0"?><!DOCTYPE x:xmpmeta [<!ENTITY reserved "1">]>').replace('<mine:reservation>1','<mine:reservation>&reserved;');
for(const {name,xml} of [
 {name:'DTD declarations',xml:dtd},
 {name:'invalid XML code points',xml:reservedXmp.replace('<mine:reservation>1','<mine:reservation>&#xD800;')},
]){
 test(`${name} remain unavailable`, reviewedSecurityOptions, async t=>{
  const cache=await mkdtemp(join(tmpdir(),'pdf-tdm-rejected-'));t.after(()=>rm(cache,{recursive:true,force:true}));
  const bytes=metadataPdf(xml),result=await inspectPdfTdmPolicy(bytes,hash(bytes),cache);assert.equal(result.finding.state,'unavailable');
 });
}
test('a legal namespace prefix cannot shadow the namespace binding table prototype', reviewedSecurityOptions, async t=>{
 const cache=await mkdtemp(join(tmpdir(),'pdf-tdm-prefix-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const xml=reservedXmp.replace('xmlns:mine=','xmlns:__proto__=').replaceAll('mine:','__proto__:');
 const bytes=metadataPdf(xml),result=await inspectPdfTdmPolicy(bytes,hash(bytes),cache);
 assert.equal(result.finding.state,'checked');if(result.finding.state==='checked')assert.equal(result.finding.reservation,1);
});
test('v2 ignores a v1 cached false-negative finding for identical bytes', reviewedSecurityOptions, async t=>{
 const cache=await mkdtemp(join(tmpdir(),'pdf-tdm-v1-cache-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const xml=reservedXmp.replace('http://www.w3.org/ns/tdmrep/','http://www.w3.org/ns/tdmrep&#47;').replace('<mine:reservation>1','<mine:reservation>&#49;'),bytes=metadataPdf(xml),sha256=hash(bytes);
 const pdfjsVersion=JSON.parse(await readFile(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'),'utf8')).version as string,folder=join(cache,'pdf-tdm-policy');await mkdir(folder,{recursive:true});
 await writeFile(join(folder,`pdf-tdm-v1-${pdfjsVersion}-${sha256}.json`),JSON.stringify({schemaVersion:1,policyVersion:'pdf-tdm-v1',pdfjsVersion,sha256,checkedAt:'2026-10-10T12:00:00.000Z',finding:{state:'checked',reservation:null,policyPresent:false,metadataPresent:true},fromCache:false}));
 const result=await inspectPdfTdmPolicy(bytes,sha256,cache);assert.equal(result.policyVersion,'pdf-tdm-v2');assert.equal(result.fromCache,false);assert.equal(result.finding.state,'checked');if(result.finding.state==='checked')assert.equal(result.finding.reservation,1);
});
