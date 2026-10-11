import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {bankSchema,canonical,decodeTool,digest,summarize,validateReview,markdown,type EvaluationRow,type Review,type Report,type EvaluationMarkdownInput} from '../src/evaluate-pilot-value.ts';

const question={id:'unit',area:'haushalt_investitionen' as const,cityIds:['strausberg'],query:'Haushalt',question:'Was ist Plan und was ist bezahlt?',requires:['Plan-Ist-Abgrenzung']};
const row:EvaluationRow={question,recordIds:['record:1'],callIds:[],retrievalComplete:true,graph:{available:false,callIds:[],recordIds:[],bounded:false},evidenceSha256:'',review:null};
const evidence:Pick<Report,'records'|'sources'|'calls'>={records:{'record:1':{id:'record:1',sourceIds:['source:1'],statement:'Geplante Investitionsauszahlungen: 10 Euro.'}},sources:{'source:1':{id:'source:1',url:'https://example.org/haushalt.pdf'}},calls:[]};
const review:Review={answer:'Der Haushalt nennt einen Planansatz; tatsächliche Auszahlungen sind nicht belegt.',kind:'partial',citations:[{recordId:'record:1',sourceId:'source:1',url:'https://example.org/haushalt.pdf',quote:'Geplante Investitionsauszahlungen: 10 Euro.'}],correctness:{score:2,rationale:'Plan und Ist werden ausdrücklich getrennt.'},sourcing:{score:2,rationale:'Die zitierte Aussage steht in der gelieferten Evidenz.'},usefulness:{score:1,rationale:'Der Ansatz ist nutzbar; ein Ist-Vergleich bleibt offen.'},data_missing:true,missing:['Ist-Auszahlung'],limitations:['Nur veröffentlichte MCP-Evidenz, keine unabhängige Prüfung.'],graphContribution:'Graph in diesem Release nicht verfügbar.'};

test('frozen bank contains thirty concrete questions across six equal areas and nine towns',async()=>{
  const bank=bankSchema.parse(JSON.parse(await readFile(new URL('../evaluation/pilot-questions.json',import.meta.url),'utf8')));
  assert.equal(bank.questions.length,30);
  assert.ok(bank.questions.filter(q=>q.graphDependent).length>=6);
  for(const question of bank.questions)assert.ok(question.question.length>70);
  assert.throws(()=>bankSchema.parse({...bank,questions:bank.questions.map((q,i)=>i? q:{...q,cityIds:['outside-pilot']})}));
  assert.throws(()=>bankSchema.parse({...bank,questions:bank.questions.map((q,i)=>i? q:{...q,id:bank.questions[1].id})}));
});
test('MCP result decoder accepts protocol content and rejects tool errors rather than inventing gaps',()=>{
  assert.deepEqual(decodeTool({content:[{type:'text',text:'{"items":[]}'}]}),{items:[]});
  assert.deepEqual(decodeTool({structuredContent:{items:[]},content:[]}),{items:[]});
  assert.throws(()=>decodeTool({isError:true,content:[{type:'text',text:'sensitive server error must not be repeated'}]}),error=>error instanceof Error&&!error.message.includes('sensitive'));
});
test('evidence digest is stable across object key order, not changed claims',()=>{
  assert.equal(canonical({b:2,a:1}),canonical({a:1,b:2}));
  assert.equal(digest({b:2,a:1}),digest({a:1,b:2}));
  assert.notEqual(digest({paid:10}),digest({planned:10}));
});
test('cited answer needs actual record/source binding and exact returned quote',()=>{
  assert.doesNotThrow(()=>validateReview(review,row,evidence));
  assert.throws(()=>validateReview({...review,citations:[{...review.citations[0],quote:'Tatsächlich bezahlt: 10 Euro.'}]},row,evidence));
  assert.throws(()=>validateReview({...review,citations:[{...review.citations[0],url:'https://example.org/other.pdf'}]},row,evidence));
  assert.throws(()=>validateReview({...review,citations:[{...review.citations[0],recordId:'not-returned'}]},row,evidence));
  assert.throws(()=>validateReview({...review,citations:[]},row,evidence));
});
test('correct abstention remains separate from useful substantive answers and sourcing',()=>{
  const abstention:Review={...review,kind:'abstention',citations:[],sourcing:{score:0,rationale:'Keine Primärquelle beantwortet die verlangte Tatsache.'},usefulness:{score:0,rationale:'Die ehrliche Lücke ist keine nützliche Sachantwort.'}};
  validateReview(abstention,row,evidence);
  assert.throws(()=>validateReview({...abstention,usefulness:{...abstention.usefulness,score:1}},row,evidence));
  const summary=summarize([{...row,review:{reviewer:'test',withoutGraph:abstention,withGraph:null}}]);
  assert.equal(summary.correctAbstentions,1);assert.equal(summary.usefulSubstantive,0);assert.equal(summary.usefulnessPoints,0);
  assert.throws(()=>validateReview({...review,kind:'substantive'},row,evidence));
  assert.throws(()=>validateReview({...review,data_missing:false},row,evidence));
});
test('truncated retrieval must be acknowledged, not scored as established absence',()=>{
  assert.throws(()=>validateReview(review,{...row,retrievalComplete:false},evidence));
  validateReview({...review,limitations:['Die Abfrage ist unvollständig; weitere Evidenz kann fehlen.']},{...row,retrievalComplete:false},evidence);
});
test('graph-only records cannot leak into paired no-graph answer',()=>{
  const graphRow={...row,recordIds:[],graph:{available:true,callIds:[],recordIds:['record:1'],bounded:false}};
  assert.throws(()=>validateReview(review,graphRow,evidence));
  validateReview(review,graphRow,evidence,true);
  assert.throws(()=>validateReview(review,{...graphRow,graph:{...graphRow.graph,bounded:true}},evidence,true));
});

test('enhanced report publishes paired graph evidence and separates release growth from graph contribution',()=>{
  const report:EvaluationMarkdownInput={generatedAt:'2026-10-11T00:00:00.000Z',server:{root:'/synthetic/server',releaseId:'synthetic-current',toolCount:19},evaluations:[{...row,question:{...question,graphDependent:true},graph:{...row.graph,available:true},review:{reviewer:'synthetic-test',withoutGraph:review,withGraph:{...review,graphContribution:'Ein zusätzlicher Graphnutzen ist in dieser Testevidenz nicht belegt.'}}}],comparison:{baselineRelease:'synthetic-before',currentRelease:'synthetic-current',interpretation:'Synthetic comparison only.',questions:[{id:'unit',withoutGraphUsefulnessDelta:1,withinReleaseGraphUsefulnessDelta:0,graphRationale:'No added graph utility.'}]}};
  const text=markdown(report,'reports/pilot-value-enhanced.json');
  assert.match(text,/Erweiterte Evaluation mit Graphvergleich/);
  assert.match(text,/reports\/pilot-value-enhanced\.json/);
  assert.match(text,/Graphbeitrag bei identischem Datenstand/);
  assert.match(text,/2\/2\/1 → 2\/2\/1/);
  assert.match(text,/synthetic-before/);
  assert.match(text,/\| unit \| 1 \| 0 \|/);
  assert.match(text,/KI-Assistenz, keine menschliche Freigabe/);
  assert.doesNotMatch(text,/# Pilotwert: Baseline-Evaluation/);
});
