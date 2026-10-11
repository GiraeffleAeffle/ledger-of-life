import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {extractRegionalStatement,REGIONAL_EXCERPT_LIMITS} from '../regional/statements.mjs';
import {regionalStatement,verifyRegionalStatementSnapshot} from '../src/regional-statement.ts';
import {QueryIndex,regionalSchema,type Regional} from '../src/mcp-query.ts';
import {normalizeRegionalPublication} from '../src/regional-quality.ts';
import {EXTRACTION_INSTRUCTIONS,JUDGE_INSTRUCTIONS} from '../src/district-claims.ts';

// Synthetic source prose, not an assertion or quotation about either real heat plan.
const context='Dieser synthetische Hintergrundabsatz bleibt unzitiert. Er erläutert weitere Verfahrensschritte, allgemeine Beteiligungsmöglichkeiten und methodische Grenzen der Untersuchung. Diese zusätzlichen Angaben werden weder als Aussage veröffentlicht noch aus dem Kontext in die ausgewählten Zitate hineingelesen.';
const html=`<nav><p>Wärmeplanung navigation</p></nav><main><p>Die Wärmeplanung der Beispielgemeinde beginnt im Januar 2024 und dauert etwa 18 Monate.</p><p>Der Entwurf nennt zwei Eignungsgebiete und mindestens fünf Maßnahmen innerhalb von fünf Jahren.</p><p>${context}</p></main>`;
const anchors=['beginnt im Januar','zwei Eignungsgebiete'];
const source=extractRegionalStatement(html,anchors);
function dataset(statement:Record<string,unknown>={}):Regional {
 return regionalSchema.parse({schemaVersion:'stadtstack-regional-topics-v1',generatedAt:'2026-10-11T00:00:00Z',asOf:'2026-10-11',region:{id:'brandenburg-mol',name:'Märkisch-Oderland'},municipalities:[{id:'ruedersdorf-bei-berlin',name:'Rüdersdorf bei Berlin'}],topics:[{id:'waermeplanung',label:'Kommunale Wärmeplanung',municipalities:[{municipalityId:'ruedersdorf-bei-berlin',stage:'adopted',items:[{title:'Kommunale Wärmeplanung: Wärmeplan beschlossen',url:'https://www.ruedersdorf.de/meine-gemeinde/konzepte/kommunale-waermeplanung/',date:'2025-07-22',sourceType:'cityWebsite',locator:'Abschnitt „Wärmeplan beschlossen“, erster Absatz',stage:'adopted',...statement}]}]}]});
}
function query(regional:Regional){return new QueryIndex('a'.repeat(64),'2026-10-11T00:00:00Z',[],regional,{schemaVersion:'stadtstack-signals-v1',generatedAt:'2026-10-11T00:00:00Z',publisher:'Test',cities:[]});}

test('Rüdersdorf locator-only legacy finding is explicit, never promoted into a statement',()=>{
 const record=query(dataset()).records[0];
 assert.equal(record.statement,'');assert.equal(record.statementStatus,'not_extracted');
 assert.equal(record.locator,'Abschnitt „Wärmeplan beschlossen“, erster Absatz');assert.deepEqual(record.statementEvidence,[]);
});
test('source collector preserves substantive qualifiers and hashes the exact HTML snapshot',()=>{
 assert.equal(source.statementEvidence.length,2);
 assert.match(source.statement,/Januar 2024.*etwa 18 Monate/);assert.match(source.statement,/mindestens fünf Maßnahmen innerhalb von fünf Jahren/);
 assert.ok(source.statementEvidence.every(evidence=>evidence.sourceSha256===createHash('sha256').update(html).digest('hex')));
 assert.equal(regionalStatement({locator:'main p',...source}).statement,source.statement);
 assert.equal(source.statement.includes('navigation'),false);
});
test('statement selection refuses absent, ambiguous and navigation-only anchors',()=>{
 assert.throws(()=>extractRegionalStatement(html,['EWE NETZ']),/missing or ambiguous/);
 assert.throws(()=>extractRegionalStatement('<p>Plan beginnt heute.</p><p>Plan beginnt morgen.</p>',['Plan beginnt']),/ambiguous/);
 assert.throws(()=>extractRegionalStatement(html,['navigation']),/missing or ambiguous/);
});
test('query/export exposes substantive evidence separately and searches its contents',()=>{
 const index=query(dataset(source));
 const page=index.page({query:'Eignungsgebiete',fields:['statement','locator','statementEvidence','statementStatus']},'search_topics');
 assert.equal(page.total,1);assert.equal(page.items[0].statement,source.statement);assert.equal(page.items[0].statementStatus,'source_backed');
 assert.notEqual(page.items[0].statement,page.items[0].locator);assert.deepEqual(page.items[0].statementEvidence,source.statementEvidence);
});
test('schema and publication reject unsupported statements and mixed source snapshots',async()=>{
 assert.throws(()=>dataset({statement:'Invented substantive fact'}));
 assert.throws(()=>dataset({...source,statement:'A different assertion'}));
 assert.throws(()=>regionalStatement({locator:'p',...source,statementEvidence:source.statementEvidence.map((evidence,index)=>({...evidence,sourceSha256:String(index).repeat(64)}))}));
 await assert.rejects(()=>normalizeRegionalPublication({...dataset(),coverage:{},topics:dataset().topics.map(topic=>({...topic,municipalities:topic.municipalities.map(city=>({...city,items:city.items.map(item=>({...item,statement:'Unbound assertion'}))}))}))}));
});
test('same regional source identity cannot silently select conflicting substantive versions',()=>{
 const regional=dataset(source),topic=structuredClone(regional.topics[0]);
 const item=topic.municipalities[0].items[0];
 const other=extractRegionalStatement(`<p>Die Wärmeplanung der Beispielgemeinde beginnt später.</p><p>${context}</p>`,['beginnt']);
 Object.assign(item,other);regional.topics.push(topic);
 assert.throws(()=>query(regional),/Conflicting regional source identity/);
});
test('heat extraction contract requests grounded facts, all named members and target precision',()=>{
 for(const instructions of [EXTRACTION_INSTRUCTIONS,JUDGE_INSTRUCTIONS]){
  assert.match(instructions,/approximate duration, named contractor, suitability-area counts/);
  assert.match(instructions,/every named member and its member_of relation/);
  assert.match(instructions,/never invent a calendar day/);
  assert.match(instructions,/contractor is not thereby a member/);
 }
});

test('publication verifies retained HTML bytes and exact URL before exposing statements',async()=>{
 const input={...dataset(source),coverage:{}},item=input.topics[0].municipalities[0].items[0];
 const snapshot={url:item.url,bytes:Buffer.from(html)};
 verifyRegionalStatementSnapshot(item,snapshot);
 const valid=await normalizeRegionalPublication(input,async request=>{
  assert.equal(request.url,item.url);assert.equal(request.sourceSha256,source.statementEvidence[0].sourceSha256);return snapshot;
 });
 assert.equal(valid.publishedRecords,1);assert.equal(valid.quarantined.length,0);
 assert.equal(valid.data.topics[0].municipalities[0].items[0].statement,source.statement);
 for(const replacement of [
  {url:'https://example.org/unrelated-source',bytes:snapshot.bytes},
  {url:item.url,bytes:Buffer.from('<p>Different retained bytes.</p>')},
 ]){
  const rejected=await normalizeRegionalPublication(input,async()=>replacement);
  assert.equal(rejected.publishedRecords,0);assert.equal(rejected.quarantined[0].reason,'statement_source_snapshot_mismatch');
 }
});
test('self-consistent fabricated excerpts never pass actual retained source verification',async()=>{
 const quote='Der Wärmeplan ist vollständig umgesetzt.';
 const forged={statement:quote,statementEvidence:[{...source.statementEvidence[0],quote}]};
 const input={...dataset(forged),coverage:{}},url=input.topics[0].municipalities[0].items[0].url;
 const rejected=await normalizeRegionalPublication(input,async()=>({url,bytes:Buffer.from(html)}));
 assert.equal(rejected.publishedRecords,0);assert.equal(rejected.quarantined[0].reason,'statement_source_snapshot_mismatch');
});
test('missing snapshots withhold statements and current policy failures abort publication',async()=>{
 const input={...dataset(source),coverage:{}};
 for(const resolver of [undefined,async()=>null]){
  const rejected=await normalizeRegionalPublication(input,resolver);
  assert.equal(rejected.publishedRecords,0);assert.equal(rejected.quarantined[0].reason,'statement_source_snapshot_missing');
 }
 await assert.rejects(()=>normalizeRegionalPublication(input,async()=>{throw Error('Current policy denies source');}),/Current policy denies source/);
});

test('short-excerpt policy rejects whole articles and never truncates oversized source blocks',async()=>{
 const quote='Eine vollständige kurze Meldung zum Wärmeplan.';
 const article=`<article><h1>Wärmeplanung</h1><p>${quote}</p></article><p>${context.repeat(4)}</p>`;
 assert.throws(()=>extractRegionalStatement(article,['vollständige']),/whole article/);
 const evidence={quote,sourceSha256:createHash('sha256').update(article).digest('hex'),textNormalization:'html-whitespace-v1'};
 const input={...dataset({statement:quote,statementEvidence:[evidence]}),coverage:{}};
 const rejected=await normalizeRegionalPublication(input,async request=>({url:request.url,bytes:Buffer.from(article)}));
 assert.equal(rejected.publishedRecords,0);assert.equal(rejected.quarantined[0].reason,'statement_source_snapshot_mismatch');
 const longQuote='Qualifizierter Beginn: '+ 'x'.repeat(REGIONAL_EXCERPT_LIMITS.quoteCharacters);
 assert.throws(()=>extractRegionalStatement(`<main><p>${longQuote}</p><p>${context.repeat(4)}</p></main>`,['Qualifizierter Beginn']),/do not truncate/);
 assert.throws(()=>dataset({statement:longQuote,statementEvidence:[{...evidence,quote:longQuote}]}));
 const paragraphs=Array.from({length:4},(_,index)=>`Absatz ${index}: ${'x'.repeat(450)}`);
 assert.throws(()=>extractRegionalStatement(`<main>${paragraphs.map(text=>`<p>${text}</p>`).join('')}<p>${context.repeat(10)}</p></main>`,paragraphs),/publication bound/);
 assert.throws(()=>extractRegionalStatement(html,Array(REGIONAL_EXCERPT_LIMITS.quotes+1).fill('beginnt')),/excerpt limit/);
});
