import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inspectRegionalStatementBundle,REGIONAL_STATEMENT_WORKER_VERSION} from '../src/district-regional-statement-worker.ts';
import {assertRegionalStatementResult,verifyRegionalStatementSnapshot} from '../src/district-regional-statement-verification.ts';
import {normalizeRegionalPublication} from '../src/regional-quality.ts';
import type {ParserSourceContext} from '../src/district-parser-isolation.ts';

const quote='Synthetischer Beschluss: Der Plan ist angenommen.';
const bytes=Buffer.from(`<article><p>${quote}</p><p>Weitere synthetische Angaben erläutern das Verfahren, die nächsten Schritte und die unveränderten Voraussetzungen. Diese Fixture ist keine tatsächliche kommunale Evidenz.</p></article>`);
const sourceSha256=createHash('sha256').update(bytes).digest('hex'),url='https://example.org/synthetic-plan';
const request={version:REGIONAL_STATEMENT_WORKER_VERSION,sourceSha256,sourceBase64:bytes.toString('base64'),anchors:[quote]};
const result=inspectRegionalStatementBundle(request);
const item={title:'Synthetic source',date:'2026-10-01',url,locator:'Synthetic original article',statement:result.statement,statementEvidence:result.statementEvidence};
const preAdmissionContext:ParserSourceContext={root:'/unused-synthetic-source-root',kind:'fetch',decisionId:'owner-2026-10-11-public-civic-sources',purpose:'document',bindings:[{phase:'pre-admission',url,sourceSha256}]};
const publication=()=>({schemaVersion:'stadtstack-regional-topics-v1',generatedAt:'2026-10-11T00:00:00Z',asOf:'2026-10-11',coverage:{},topics:[{id:'synthetic',municipalities:[{municipalityId:'synthetic-town',items:[item]}]}]});

test('fixed regional worker preserves canonical source excerpt and original byte identity',()=>{
 assert.equal(result.sourceSha256,sourceSha256);assert.equal(result.statement,quote);
 assert.deepEqual(result.statementEvidence,[{quote,sourceSha256,textNormalization:'html-whitespace-v1'}]);
 assertRegionalStatementResult(item,result);
});
test('regional worker rejects changed bytes, ambiguous encodings and unsupported selectors',()=>{
 assert.throws(()=>inspectRegionalStatementBundle({...request,sourceSha256:'0'.repeat(64)}),/digest/);
 assert.throws(()=>inspectRegionalStatementBundle({...request,sourceBase64:request.sourceBase64+'\n'}),/encoding/);
 assert.throws(()=>inspectRegionalStatementBundle({...request,sourceBase64:''}));
 assert.throws(()=>inspectRegionalStatementBundle({...request,anchors:['Not in the original source']}),/missing|ambiguous/);
 assert.throws(()=>inspectRegionalStatementBundle({...request,module:'untrusted-module'}));
});
test('regional worker retains whole-article and short-excerpt limits rather than truncating qualifiers',()=>{
 const whole=Buffer.from(`<article><p>${quote}</p></article>`);
 assert.throws(()=>inspectRegionalStatementBundle({...request,sourceSha256:createHash('sha256').update(whole).digest('hex'),sourceBase64:whole.toString('base64')}),/whole article|excessive/);
 assert.throws(()=>inspectRegionalStatementBundle({...request,anchors:['x'.repeat(601)]}));
});
test('regional result matching rejects changed quotes, hashes, order and extra fields',()=>{
 assert.throws(()=>assertRegionalStatementResult(item,{...result,sourceSha256:'0'.repeat(64)}),/match/);
 assert.throws(()=>assertRegionalStatementResult(item,{...result,statementEvidence:[{...result.statementEvidence[0],quote:'Different synthetic quotation'}]}),/match/);
 assert.throws(()=>assertRegionalStatementResult(item,{...result,statementEvidence:[...result.statementEvidence,...result.statementEvidence]}),/match/);
 assert.throws(()=>assertRegionalStatementResult(item,{...result,sourcePath:'/not-an-approved-input'}));
 const second='Eine zweite synthetische Quellenangabe.',pairBytes=Buffer.from(`<article><p>${quote}</p><p>${second}</p><p>${'Zusätzlicher synthetischer Kontext. '.repeat(20)}</p></article>`);
 const pair=inspectRegionalStatementBundle({...request,sourceSha256:createHash('sha256').update(pairBytes).digest('hex'),sourceBase64:pairBytes.toString('base64'),anchors:[quote,second]}),pairItem={...item,statement:pair.statement,statementEvidence:pair.statementEvidence};
 assertRegionalStatementResult(pairItem,pair);
 assert.throws(()=>assertRegionalStatementResult(pairItem,{...pair,statementEvidence:[pair.statementEvidence[1],pair.statementEvidence[0]]}),/match/);
});
test('regional source verification rejects URL, bytes and pre-admission custody before sandbox execution',async()=>{
 await assert.rejects(verifyRegionalStatementSnapshot(item,{url:url+'/other',bytes,sourceContext:preAdmissionContext}),/URL mismatch/);
 await assert.rejects(verifyRegionalStatementSnapshot(item,{url,bytes:Buffer.from('changed'),sourceContext:preAdmissionContext}),/hash mismatch/);
 await assert.rejects(verifyRegionalStatementSnapshot(item,{url,bytes,sourceContext:preAdmissionContext}),/original HTTP source custody/);
});
test('regional normalization awaits source verification and propagates resolver authorization failure',async()=>{
 const held=await normalizeRegionalPublication(publication(),async()=>({url,bytes,sourceContext:preAdmissionContext}));
 assert.equal(held.publishedRecords,0);assert.equal(held.quarantined[0].reason,'statement_source_snapshot_mismatch');
 await assert.rejects(normalizeRegionalPublication(publication(),async()=>{throw Error('synthetic_authority_denied');}),/synthetic_authority_denied/);
});
