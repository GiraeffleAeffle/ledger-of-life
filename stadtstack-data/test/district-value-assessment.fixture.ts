import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {bankSchema,digest} from '../src/evaluate-pilot-value.ts';
import type {Report,EvaluationRow} from '../src/evaluate-pilot-value.ts';
import type {AssessmentOutput,AssessmentItem} from '../src/district-assessment.ts';
import {admittedAssessmentFixture} from './district-assessment.fixture.ts';

/** Synthetic evidence only: no model execution, network or production state. */
export async function valueAssessmentFixture(managed=false){
 const quote='Strausberg plant eine Wärmeplanung; ein verabschiedeter Wärmeplan ist hier nicht belegt.';
 const text='x'.repeat(4000)+'\n'+quote+'\n'+'y'.repeat(4000),admitted=await admittedAssessmentFixture(text,managed);
 const bankBytes=await readFile(new URL('../evaluation/pilot-questions.json',import.meta.url));
 const bank=bankSchema.parse(JSON.parse(bankBytes.toString('utf8')));
 const source={...admitted.source,mcpSourceId:'source:fixture',locators:[{id:'span:fixture',page:1,table:null,start:4001,end:4001+quote.length}]};
 const record={id:'record:fixture',sourceIds:['source:fixture'],statement:quote};
 const attribution={id:'source:fixture',registrySourceId:source.sourceId,url:admitted.policy.source.url,sha256:source.originalSha256,
  locator:`text-sha256:${source.textSha256};chars:0-${text.length}`};
 const evaluations:EvaluationRow[]=bank.questions.map(question=>{
  const row:EvaluationRow={question,recordIds:question.id==='W01'?[record.id]:[],callIds:question.id==='W01'?[0,1]:[],retrievalComplete:true,
   graph:{available:true,callIds:[],recordIds:[],bounded:false},evidenceSha256:'',review:null};
  row.evidenceSha256=digest({question,records:row.recordIds.map(()=>record),sources:row.recordIds.map(()=>attribution),retrievalComplete:true,graph:row.graph,graphResponses:[]});return row;
 });
 const releaseId='d'.repeat(64),report:Report={schemaVersion:'pilot-value-evaluation-v1',status:'awaiting_review',generatedAt:'2026-10-15T00:00:00Z',
  questionBankSha256:createHash('sha256').update(bankBytes).digest('hex'),evaluatorSha256:'a'.repeat(64),
  server:{root:'/synthetic/code',gitCommit:'a'.repeat(40),sourceSha256:'b'.repeat(64),sourceFiles:[],releaseId,toolCount:20,
   tools:['entity_search','graph_neighbors','graph_path',...Array.from({length:17},(_,i)=>'synthetic_tool_'+i)],transport:'stdio',protocol:'Synthetic fixture only',
   mode:'vm_candidate',candidateDirectory:'/synthetic/candidate',policyStateDir:admitted.context.policyOptions.stateDir},
  method:{grading:'Frozen synthetic fixture rubric: score correctness, sources and usefulness 0–2; abstention usefulness zero.'},
  releaseStatus:{dataManifest:{id:releaseId},release:{mode:'vm_candidate'}},coverage:null,
  records:{[record.id]:record},sources:{[attribution.id]:attribution},
  calls:[{id:0,tool:'get_signal',selection:{id:record.id},response:record,responseSha256:digest(record)},
   {id:1,tool:'get_source',selection:{sourceId:attribution.id},response:attribution,responseSha256:digest(attribution)}],evaluations};
 return {...admitted,quote,text,source,report};
}
export function valueOutput(item:AssessmentItem,quote?:string):AssessmentOutput{
 const empty=!item.sources.length;
 const answer=empty?'Keine abgerufene Originalevidenz beantwortet diese synthetische Frage; daraus folgt keine kommunale Inaktivität.':'Das synthetische Original belegt nur die Planung; ein verabschiedeter Wärmeplan ist nicht belegt.';
 return {itemId:item.itemId,outcome:empty?'abstain':'supported',assertions:empty?[]:[{claimId:item.claimIds[0],sourceId:item.sources[0].mcpSourceId!,
  locatorId:item.sources[0].locators[0].id,quote:quote!,subjectId:null,objectId:null,unit:null,value:null,date:null,dateRole:null,financialRole:'none',stage:'planned',modality:'planned'}],
  scores:{correctness:2,sources:empty?0:2,usefulness:empty?0:1},holdReasons:[],rationale:'Synthetic fixture result, never provider evidence.',
  valueReview:{answer,kind:empty?'abstention':'partial',citations:empty?[]:[{recordId:'record:fixture',sourceId:item.sources[0].mcpSourceId!,url:'https://example.org/assessment-fixture.txt',quote:quote!}],
   correctness:{score:2,rationale:'Die synthetische Quelle wird nicht zu einem tatsächlichen Beschluss aufgewertet.'},
   sourcing:{score:empty?0:2,rationale:'Die vorgelegte synthetische Originalstelle bestimmt den möglichen Quellenbezug.'},
   usefulness:{score:empty?0:1,rationale:'Eine ehrliche Enthaltung bringt keinen Nutzenpunkt; die Planung bleibt unvollständig.'},
   data_missing:true,missing:['Beschlussdatum und verabschiedeter Plan'],limitations:['Synthetic source fixture; only fixed-neighbour original excerpts are available.'],graphContribution:'Synthetic same-release comparison; no graph gain asserted.'}};
}
