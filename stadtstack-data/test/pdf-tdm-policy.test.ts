import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {hash} from '../src/common.ts';
import {inspectPdfTdmPolicy as sandboxPdfTdmPolicy,PDF_TDM_POLICY_VERSION} from '../src/pdf-tdm-policy.ts';
import {readParserReview} from '../src/district-parser-isolation.ts';
import {PREPARED_VM_ROOT} from '../src/district-prepared-document.ts';
import {metadataPdf,reservedXmp} from './fixtures/tdm-pdf.ts';
const reviewedSecurityOptions={skip:process.env.STADTSTACK_PARSER_SECURITY_TESTS!=='1',timeout:240000};
async function inspectPdfTdmPolicy(bytes:Buffer,sha256:string,cacheRoot:string){
 await readParserReview(); // No environment flag can approve or provision the sandbox.
 const {assertCivicPolicyAuthority,CIVIC_ACQUISITION_DECISION_ID}=await import('../src/civic-opt-out.ts');
 const authority=await assertCivicPolicyAuthority();
 return sandboxPdfTdmPolicy(bytes,sha256,cacheRoot,{root:join(dirname(PREPARED_VM_ROOT),'parser-security-fixtures'),kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256,purpose:'classification',bindings:[{phase:'pre-admission',url:'https://pdf-tdm-fixture.invalid/synthetic-input',sourceSha256:sha256}]});
}

test('compressed XMP reservation with an alternate namespace prefix is detected and cached by digest/version', reviewedSecurityOptions, async t=>{
 const cache=await mkdtemp(join(tmpdir(),'pdf-tdm-compressed-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const bytes=metadataPdf(reservedXmp),digest=hash(bytes);assert.equal(bytes.includes(Buffer.from('mine:reservation')),false);
 const first=await inspectPdfTdmPolicy(bytes,digest,cache);assert.equal(first.finding.state,'checked');
 if(first.finding.state!=='checked')assert.fail('Compressed XMP must be parsed');
 assert.equal(first.finding.reservation,1);assert.equal(first.finding.policyPresent,true);assert.equal(first.policyVersion,PDF_TDM_POLICY_VERSION);assert.equal(first.fromCache,false);
 const second=await inspectPdfTdmPolicy(bytes,digest,cache);assert.equal(second.fromCache,true);assert.equal(second.checkedAt,first.checkedAt);
});
test('valid PDF without metadata and explicit zero are distinct checked results', reviewedSecurityOptions, async t=>{
 const cache=await mkdtemp(join(tmpdir(),'pdf-tdm-clear-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const absent=metadataPdf(),absentResult=await inspectPdfTdmPolicy(absent,hash(absent),cache);
 assert.deepEqual(absentResult.finding,{state:'checked',reservation:null,policyPresent:false,metadataPresent:false});
 const zero=metadataPdf(reservedXmp.replace('<mine:reservation>1','<mine:reservation>0')),zeroResult=await inspectPdfTdmPolicy(zero,hash(zero),cache);
 assert.equal(zeroResult.finding.state,'checked');if(zeroResult.finding.state==='checked')assert.equal(zeroResult.finding.reservation,0);
});
test('malformed PDF and compressed malformed metadata are unavailable, never no-reservation', reviewedSecurityOptions, async t=>{
 const cache=await mkdtemp(join(tmpdir(),'pdf-tdm-invalid-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 for(const bytes of [Buffer.from('%PDF-invalid'),metadataPdf('<x:xmpmeta><malformed>')]){
  const result=await inspectPdfTdmPolicy(bytes,hash(bytes),cache);assert.equal(result.finding.state,'unavailable');
 }
});
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
test('escaped references are not decoded twice and CDATA retains its literal meaning', reviewedSecurityOptions, async t=>{
 const cache=await mkdtemp(join(tmpdir(),'pdf-tdm-once-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const literalNamespace=metadataPdf(reservedXmp.replace('http://www.w3.org/ns/tdmrep/','http://www.w3.org/ns/tdmrep&amp;#47;'));
 const namespaceResult=await inspectPdfTdmPolicy(literalNamespace,hash(literalNamespace),cache);
 assert.equal(namespaceResult.finding.state,'checked');if(namespaceResult.finding.state==='checked')assert.equal(namespaceResult.finding.reservation,null);
 for(const value of ['&amp;#49;','&#38;#49;','<![CDATA[&#49;]]>']){
  const bytes=metadataPdf(reservedXmp.replace('<mine:reservation>1',`<mine:reservation>${value}`)),result=await inspectPdfTdmPolicy(bytes,hash(bytes),cache);
  assert.equal(result.finding.state,'unavailable');
 }
 const cdata=metadataPdf(reservedXmp.replace('<mine:reservation>1','<mine:reservation><![CDATA[1]]>')),cdataResult=await inspectPdfTdmPolicy(cdata,hash(cdata),cache);
 assert.equal(cdataResult.finding.state,'checked');if(cdataResult.finding.state==='checked')assert.equal(cdataResult.finding.reservation,1);
});
test('DTD declarations and invalid XML code points remain unavailable', reviewedSecurityOptions, async t=>{
 const cache=await mkdtemp(join(tmpdir(),'pdf-tdm-rejected-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 const dtd=reservedXmp.replace('<?xml version="1.0"?>','<?xml version="1.0"?><!DOCTYPE x:xmpmeta [<!ENTITY reserved "1">]>').replace('<mine:reservation>1','<mine:reservation>&reserved;');
 for(const xml of [dtd,reservedXmp.replace('<mine:reservation>1','<mine:reservation>&#xD800;')]){
  const bytes=metadataPdf(xml),result=await inspectPdfTdmPolicy(bytes,hash(bytes),cache);assert.equal(result.finding.state,'unavailable');
 }
});
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
