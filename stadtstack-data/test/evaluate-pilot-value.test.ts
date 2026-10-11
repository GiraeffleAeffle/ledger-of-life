import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,rm} from 'node:fs/promises';
import {bankSchema,canonical,decodeTool,digest,summarize,validateReview,validateReport,markdown,
  prepareValueAssessment,assessedValueReview,valueAssessmentTarget,ingestValueAssessments,
  type EvaluationRow,type Review,type Report,type EvaluationMarkdownInput} from '../src/evaluate-pilot-value.ts';
import {assessmentItemSchema,assessmentOutputSchema,originalEvidence,deterministicChecks} from '../src/district-assessment.ts';
import {admittedAssessmentFixture,syntheticAssessmentTriplet} from './district-assessment.fixture.ts';
import {createHash} from 'node:crypto';

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
test('native citations bind exact retrieved source hash and locator without invented numeric quotes',()=>{
  const native={sourceSha256:'a'.repeat(64),format:'csv' as const,nativeId:'investment-1',path:'rows/1/amount',
    sheet:null,rowKey:'investment-1',cells:['amount'],rawValue:'10',schemaHash:'b'.repeat(64),mappingVersion:'fixture-v1'};
  const nativeEvidence={...evidence,records:{'record:1':{id:'record:1',sourceIds:['source:1'],evidence:[native]}},
    sources:{'source:1':{id:'source:1',url:'https://example.org/haushalt.pdf',sha256:native.sourceSha256,locators:[native]}}};
  const nativeReview:Review={...review,citations:[{recordId:'record:1',sourceId:'source:1',url:'https://example.org/haushalt.pdf',kind:'structured',evidence:native}]};
  assert.doesNotThrow(()=>validateReview(nativeReview,row,nativeEvidence));
  assert.throws(()=>validateReview({...nativeReview,citations:[{recordId:'record:1',sourceId:'source:1',url:'https://example.org/haushalt.pdf',kind:'structured',evidence:{...native,rawValue:'100'}}]},row,nativeEvidence),/locator/);
  assert.throws(()=>validateReview(nativeReview,row,{...nativeEvidence,sources:{'source:1':{...nativeEvidence.sources['source:1'],sha256:'c'.repeat(64)}}}),/hash/);
});
test('authentic historical baseline/enhanced reports retain old text citations and scores',async()=>{
  const baseline:Report=JSON.parse(await readFile(new URL('../reports/pilot-value-baseline.json',import.meta.url),'utf8'));
  const enhanced:Report=JSON.parse(await readFile(new URL('../reports/pilot-value-enhanced.json',import.meta.url),'utf8'));
  validateReport(baseline);validateReport(enhanced);
  assert.equal(summarize(baseline.evaluations).usefulnessPoints,4);
  assert.equal(summarize(enhanced.evaluations).usefulnessPoints,12);
  assert.equal(enhanced.evaluations.filter(row=>row.question.graphDependent).length,7);
});
test('value bridge imports only actual C review payload and rejects invented/unrelated record citations',async()=>{
  const quote='Geplante Investitionsauszahlungen: 10 Euro.';
  const admitted=await admittedAssessmentFixture(quote);
  try{
    const source={id:'source:1',registrySourceId:'source1',url:admitted.policy.source.url,sha256:admitted.source.originalSha256};
    const record={id:'record:1',sourceIds:['source:1'],statement:quote};
    const testRow:EvaluationRow={...row,graph:{...row.graph},review:null};
    testRow.evidenceSha256=digest({question,records:[record],sources:[source],retrievalComplete:true,graph:testRow.graph,graphResponses:[]});
    const rubric='Frozen fixture rubric; scores 0/1/2, abstention usefulness zero.';
    const report:Report={schemaVersion:'pilot-value-evaluation-v1',status:'awaiting_review',generatedAt:'2026-10-11T00:00:00.000Z',
      questionBankSha256:'a'.repeat(64),evaluatorSha256:'b'.repeat(64),server:{root:'/synthetic',gitCommit:'a'.repeat(40),
        sourceSha256:'c'.repeat(64),sourceFiles:[],releaseId:'d'.repeat(64),toolCount:16,tools:[],transport:'stdio',protocol:'synthetic test only'},
      method:{grading:rubric},releaseStatus:{},coverage:null,records:{'record:1':record},sources:{'source:1':source},calls:[],evaluations:[testRow]};
    const raw=assessmentItemSchema.parse({version:'assessment-item-v1',itemId:question.id,question:question.question,claim:'Plan versus actual',
      rubric,rubricSha256:createHash('sha256').update(rubric).digest('hex'),sources:[admitted.source],claimIds:['claim1'],entityIds:[],constraints:[],criticalKinds:['finance']});
    const item=prepareValueAssessment(report,raw,'withoutGraph');
    assert.equal(item.sources[0].mcpSourceId,'source:1');
    const actualReview:Review={...review,citations:[{recordId:'record:1',sourceId:'source:1',url:source.url,quote}]};
    const output=assessmentOutputSchema.parse({itemId:question.id,outcome:'supported',assertions:[{claimId:'claim1',sourceId:'source:1',locatorId:'page1',quote,
      subjectId:null,objectId:null,unit:'EUR',value:'10',date:null,dateRole:null,financialRole:'plan',stage:'planned',modality:'planned'}],
      scores:{correctness:2,sources:2,usefulness:1},holdReasons:[],rationale:'Synthetic original evidence assessment, no provider calls.',valueReview:actualReview});
    const receipts=await syntheticAssessmentTriplet(item,output,admitted.context);
    const decision=await assessedValueReview(report,item,receipts,admitted.context);
    assert.deepEqual(decision.review,actualReview);
    assert.equal(decision.binding.receiptHashes.length,3);
    const originals=await originalEvidence(item,admitted.context);
    for(const recordId of ['invented','record:unrelated']){
      const wrong=assessmentOutputSchema.parse({...output,valueReview:{...actualReview,citations:[{...actualReview.citations[0],recordId}]}});
      assert.ok(deterministicChecks(item,originals,wrong).includes('value_record_attribution'));
      await assert.rejects(assessedValueReview(report,item,await syntheticAssessmentTriplet(item,wrong,admitted.context),admitted.context),/held/);
    }
    const unrelated=assessmentItemSchema.parse({...item,valueTarget:{...item.valueTarget,records:{...item.valueTarget!.records,
      'record:unrelated':{id:'record:unrelated',sourceIds:['source:other'],statement:quote}}}});
    const unrelatedCitation=assessmentOutputSchema.parse({...output,valueReview:{...actualReview,
      citations:[{...actualReview.citations[0],recordId:'record:unrelated'}]}});
    assert.ok(deterministicChecks(unrelated,originals,unrelatedCitation).includes('value_record_attribution'));
    const noRecordEvidence=assessmentItemSchema.parse({...item,valueTarget:{...item.valueTarget,records:{...item.valueTarget!.records,
      'record:1':{...record,statement:'An unrelated council action, not the cited financial claim.'}}}});
    assert.ok(deterministicChecks(noRecordEvidence,originals,output).includes('value_record_evidence'));
    const wrongUrl=assessmentOutputSchema.parse({...output,valueReview:{...actualReview,citations:[{...actualReview.citations[0],url:'https://example.org/unrelated'}]}});
    assert.ok(deterministicChecks(item,originals,wrongUrl).includes('value_original_attribution'));
    const scoresOnly={...output,valueReview:null};
    await assert.rejects(assessedValueReview(report,item,await syntheticAssessmentTriplet(item,scoresOnly,admitted.context),admitted.context),/held/);
    assert.throws(()=>prepareValueAssessment(report,{...raw,question:'Easier substituted question'},'withoutGraph'),/question/);
    assert.throws(()=>valueAssessmentTarget(report,testRow,'withGraph'),/graph pair/);
    await assert.rejects(ingestValueAssessments({...report,evaluations:[{...testRow,review:{reviewer:'historic',withoutGraph:actualReview,withGraph:null}}]},[],undefined,admitted.context),/rewrite/);
  }finally{await rm(admitted.directory,{recursive:true,force:true});}
});
test('full bridge keeps all thirty questions, seven same-release pairs and zero abstention usefulness',async()=>{
  const bankBytes=await readFile(new URL('../evaluation/pilot-questions.json',import.meta.url));
  const bank=bankSchema.parse(JSON.parse(bankBytes.toString('utf8')));
  const admitted=await admittedAssessmentFixture('Synthetic unused CAS fixture, never provider evidence.');
  try{
    const rubric='Synthetic test rubric: 0/1/2 and abstention usefulness zero.';
    const evaluations:EvaluationRow[]=bank.questions.map(question=>{
      const row:EvaluationRow={question,recordIds:[],callIds:[],retrievalComplete:true,
        graph:{available:true,callIds:[],recordIds:[],bounded:false},evidenceSha256:'',review:null};
      row.evidenceSha256=digest({question,records:[],sources:[],retrievalComplete:true,graph:row.graph,graphResponses:[]});return row;
    });
    const report:Report={schemaVersion:'pilot-value-evaluation-v1',status:'awaiting_review',generatedAt:'2026-10-11T00:00:00.000Z',
      questionBankSha256:createHash('sha256').update(bankBytes).digest('hex'),evaluatorSha256:'a'.repeat(64),
      server:{root:'/synthetic',gitCommit:'a'.repeat(40),sourceSha256:'b'.repeat(64),sourceFiles:[],releaseId:'c'.repeat(64),
        toolCount:19,tools:[],transport:'stdio',protocol:'synthetic fixture; no MCP/provider execution'},
      method:{grading:rubric},releaseStatus:{},coverage:null,records:{},sources:{},calls:[],evaluations};
    const entries=[];
    for(const row of evaluations)for(const lane of row.question.graphDependent?['withoutGraph','withGraph'] as const:['withoutGraph'] as const){
      const item=prepareValueAssessment(report,{version:'assessment-item-v1',itemId:row.question.id,question:row.question.question,
        claim:'No supported answer in frozen retrieved evidence.',rubric,rubricSha256:createHash('sha256').update(rubric).digest('hex'),
        sources:[],claimIds:['question:'+row.question.id],entityIds:[],constraints:[],criticalKinds:[]},lane);
      const valueReview:Review={answer:'Keine abgerufene Originalevidenz beantwortet diese unveränderte Frage; dies belegt keine kommunale Inaktivität.',
        kind:'abstention',citations:[],correctness:{score:2,rationale:'Keine unbelegte positive oder negative Tatsachenbehauptung.'},
        sourcing:{score:0,rationale:'Keine passende Originalquelle in diesem synthetischen Abruf.'},
        usefulness:{score:0,rationale:'Eine ehrliche Enthaltung erhält keine Nutzenspunkte.'},
        data_missing:true,missing:row.question.requires,limitations:['Synthetic empty retrieval; no conclusion about activity.'],
        graphContribution:'No graph evidence in this synthetic same-release pair; no gain claimed.'};
      const output=assessmentOutputSchema.parse({itemId:row.question.id,outcome:'abstain',assertions:[],
        scores:{correctness:2,sources:0,usefulness:0},holdReasons:[],rationale:'Synthetic abstention fixture only.',valueReview});
      entries.push({item,...await syntheticAssessmentTriplet(item,output,admitted.context)});
    }
    const reviewed=await ingestValueAssessments(report,entries,undefined,admitted.context);
    assert.equal(reviewed.evaluations.length,30);
    assert.equal(reviewed.summary?.usefulnessPoints,0);assert.equal(reviewed.summary?.correctnessPoints,60);
    assert.equal(reviewed.summary?.graphReviewed,7);
    assert.ok(reviewed.evaluations.every(row=>row.review?.assessment?.independentlyValidated===false
      &&row.review.assessment.auditCoverage.phaseGatePassed===false));
    await assert.rejects(ingestValueAssessments(report,entries.filter(entry=>entry.item.valueTarget?.lane!=='withGraph'),undefined,admitted.context),/graph pair/);
    const changed=structuredClone(reviewed);changed.evaluations[0].review!.withoutGraph.correctness.score=1;
    assert.throws(()=>validateReport(changed),/bound/);
  }finally{await rm(admitted.directory,{recursive:true,force:true});}
});
