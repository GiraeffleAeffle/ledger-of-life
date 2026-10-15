import {z} from 'zod';
import {canonicalJson,semanticHash} from './district-adapter-contract.ts';
import type {Report,EvaluationRow} from './evaluate-pilot-value.ts';
import type {AssessmentItem} from './district-assessment.ts';

type Call=Report['calls'][number];
type Question=EvaluationRow['question'];
const object=z.record(z.string(),z.unknown());
const paginationCursor='[opaque pagination cursor omitted]';
export const valueCallSchema=z.object({id:z.number().int().nonnegative(),tool:z.string().min(1),selection:z.record(z.string(),z.unknown()),response:z.unknown(),responseSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const VALUE_AREAS=['waerme','solar_wind','wohnen_planung','schule_kita','mobilitaet','haushalt_investitionen'] as const;
export const valueQuestionSchema=z.object({id:z.string(),area:z.enum(VALUE_AREAS),cityIds:z.array(z.string()).min(1),query:z.string(),question:z.string(),requires:z.array(z.string()).min(1),graphDependent:z.boolean().optional(),graphQueries:z.array(z.string()).optional()}).strict();
export const VALUE_TOPICS:Record<Question['area'],string[]>={waerme:['waermeplanung'],solar_wind:['solarpark','windenergie'],wohnen_planung:['wohnbau'],schule_kita:['schule','kita'],mobilitaet:['mobilitaet'],haushalt_investitionen:['haushalt']};
export function valueSearches(question:Question):[string,Record<string,unknown>][] {
 const selections:[string,Record<string,unknown>][]=[['search_topics',{query:question.query,cityIds:question.cityIds,excludePlaces:true,excludeOSM:true}]];
 for(const topic of VALUE_TOPICS[question.area]){
  selections.push(['search_topics',{topic,cityIds:question.cityIds,excludePlaces:true,excludeOSM:true}]);
  for(const municipalityId of question.cityIds)selections.push(['get_regional_topics',{topic,municipalityId,excludePlaces:true,excludeOSM:true}]);
 }
 return selections;
}
/** Exact persisted projection used at collection and every subsequent trust boundary. */
export function projectMcpResponse(value:unknown):unknown {
 if(Array.isArray(value))return value.map(projectMcpResponse);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/^(?:authorization|headers?|request|rawResponse|rawEvents|accessToken|refreshToken|apiKey|accountId|email)$/i.test(key)).map(([key,item])=>[key,(key==='nextCursor'||key==='cursor')&&typeof item==='string'?paginationCursor:projectMcpResponse(item)]));
 return value;
}
function validateMaps(records:Report['records'],sources:Report['sources'],calls:Call[]){
 const selected=new Map<string,Call>();
 for(const call of calls){
  if(call.responseSha256!==semanticHash(call.response)||canonicalJson(call.response)!==canonicalJson(projectMcpResponse(call.response)))throw Error('MCP response integrity changed');
  if(call.tool!=='get_signal'&&call.tool!=='get_source')continue;
  const id=z.string().parse(call.selection[call.tool==='get_signal'?'id':'sourceId']),key=call.tool+':'+id;
  if(selected.has(key))throw Error('Ambiguous primary MCP response');selected.set(key,call);
  const value=(call.tool==='get_signal'?records:sources)[id];
  if(!value||value.id!==id||canonicalJson(value)!==canonicalJson(projectMcpResponse(call.response)))throw Error('Primary MCP response/map mismatch');
 }
 for(const [id,record] of Object.entries(records)){
  if(!selected.has('get_signal:'+id))throw Error('Missing primary record response');
  for(const sourceId of z.array(z.string()).parse(record.sourceIds))if(!sources[sourceId])throw Error('Missing record attribution');
 }
 const sourceIds=new Set(Object.values(records).flatMap(record=>z.array(z.string()).parse(record.sourceIds)));
 if(sourceIds.size!==Object.keys(sources).length)throw Error('Orphan source attribution');
 for(const id of Object.keys(sources))if(!selected.has('get_source:'+id))throw Error('Missing primary source response');
}
function deriveQuestion(question:Question,calls:Call[],withGraph:boolean){
 const used=new Set<number>();let retrievalComplete=true,graphBounded=false;
 const paged=(tool:string,selection:Record<string,unknown>)=>{
  const pages=calls.filter(call=>{
   const {cursor:_cursor,limit:_limit,...query}=call.selection;
   return call.tool===tool&&canonicalJson(query)===canonicalJson(selection);
  });
  if(!pages.length||pages.length>100)throw Error('Missing or excessive query pages');
  const items:Record<string,unknown>[]=[];
  for(const [index,call] of pages.entries()){
   if(used.has(call.id)||call.selection.limit!==50||(index===0?call.selection.cursor!==undefined:call.selection.cursor!==paginationCursor))throw Error('Ambiguous query page');
   used.add(call.id);const response=object.parse(call.response),hasNext=response.nextCursor!==null&&response.nextCursor!==undefined;
   if(index<pages.length-1&&!hasNext||index===pages.length-1&&hasNext&&pages.length!==100)throw Error('Incomplete query transcript');
   if(hasNext&&response.nextCursor!==paginationCursor)throw Error('Invalid persisted cursor');
   items.push(...z.array(object).parse(response.items));
   if(index===pages.length-1)return {items,complete:!hasNext&&response.complete!==false&&response.truncated!==true};
  }
  throw Error('Missing query page');
 };
 const records=new Set<string>();
 for(const [tool,selection] of valueSearches(question)){
  const page=paged(tool,selection);retrievalComplete&&=page.complete;
  for(const item of page.items)records.add(z.string().parse(item.id));
 }
 const graphRecords=new Set<string>();
 if(withGraph){
  const entities=new Set<string>();
  for(const query of question.graphQueries??[question.query]){
   const page=paged('entity_search',{query});graphBounded||=!page.complete;
   for(const item of page.items)entities.add(z.string().parse(item.id));
  }
  const ids=[...entities].sort().slice(0,12);graphBounded||=entities.size>ids.length;
  for(const id of ids){const page=paged('graph_neighbors',{id,direction:'both'});graphBounded||=!page.complete;}
  let pairs=0;
  for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++){
   if(pairs++>=12){graphBounded=true;continue;}
   const matches=calls.filter(call=>call.tool==='graph_path'&&canonicalJson(call.selection)===canonicalJson({fromId:ids[i],toId:ids[j],maxHops:5,limit:20}));
   if(matches.length!==1||used.has(matches[0].id))throw Error('Missing or ambiguous graph path call');
   const call=matches[0],response=object.parse(call.response);used.add(call.id);
   graphBounded||=!!response.nextCursor||response.truncated===true||response.complete===false;
  }
  const visit=(value:unknown):void=>{
   if(Array.isArray(value)){value.forEach(visit);return;}
   if(!value||typeof value!=='object')return;
   if('recordId' in value&&typeof value.recordId==='string'&&'municipalityId' in value&&typeof value.municipalityId==='string'&&question.cityIds.includes(value.municipalityId))graphRecords.add(value.recordId);
   Object.values(value).forEach(visit);
  };
  for(const call of calls)if(['entity_search','graph_neighbors','graph_path'].includes(call.tool)&&used.has(call.id))visit(call.response);
 }
 for(const call of calls)if(!used.has(call.id)&&call.tool!=='get_signal'&&call.tool!=='get_source')throw Error('Unexpected question MCP call');
 return {recordIds:[...records].sort(),graphRecordIds:[...graphRecords].sort(),retrievalComplete,graphBounded};
}
export function validateCandidateTranscript(report:Pick<Report,'records'|'sources'|'calls'|'evaluations'>){
 validateMaps(report.records,report.sources,report.calls);
 const membershipCalls=new Set<number>(),records=new Set<string>();
 for(const row of report.evaluations){
  const ids=[...row.callIds,...row.graph.callIds];
  if(new Set(ids).size!==ids.length)throw Error('Duplicate question call reference');
  const calls=ids.map(id=>{const call=report.calls[id];if(!call||call.id!==id)throw Error('Missing question call');return call;});
  const derived=deriveQuestion(row.question,calls,!!row.question.graphDependent&&row.graph.available);
  if(canonicalJson(row.recordIds)!==canonicalJson(derived.recordIds)||canonicalJson(row.graph.recordIds)!==canonicalJson(derived.graphRecordIds)
   ||row.retrievalComplete!==derived.retrievalComplete||row.graph.bounded!==derived.graphBounded)throw Error('Question membership differs from MCP transcript');
  const rowRecords=new Set([...derived.recordIds,...derived.graphRecordIds]);rowRecords.forEach(id=>records.add(id));
  const rowSources=new Set([...rowRecords].flatMap(id=>z.array(z.string()).parse(report.records[id]?.sourceIds)));
  for(const call of calls){
   if(call.tool==='get_signal'){if(!rowRecords.has(z.string().parse(call.selection.id)))throw Error('Unrelated record call');}
   else if(call.tool==='get_source'){if(!rowSources.has(z.string().parse(call.selection.sourceId)))throw Error('Unrelated source call');}
   else {if(membershipCalls.has(call.id))throw Error('Shared question retrieval call');membershipCalls.add(call.id);}
   if(row.graph.callIds.includes(call.id)!==['entity_search','graph_neighbors','graph_path'].includes(call.tool))throw Error('Graph/non-graph call partition changed');
  }
 }
 if(canonicalJson([...records].sort())!==canonicalJson(Object.keys(report.records).sort()))throw Error('Record map exceeds retrieved membership');
 for(const call of report.calls)if(!membershipCalls.has(call.id)&&!['get_signal','get_source','get_release_status','list_cities','list_topics'].includes(call.tool))throw Error('Unbound retrieval call');
}
/** Reused by originalEvidence: A, B, C, reconciliation and owner-audit reads. */
export function validateValueTargetTranscript(target:NonNullable<AssessmentItem['valueTarget']>){
 const calls=target.calls.map(call=>valueCallSchema.parse(call));validateMaps(target.records,target.sources,calls);
 if(new Set(calls.map(call=>call.id)).size!==calls.length)throw Error('Duplicate value-target call');
 const parsed=valueQuestionSchema.parse(target.question);
 if(target.lane==='withGraph'&&!parsed.graphDependent)throw Error('Unestablished graph pair');
 const derived=deriveQuestion(parsed,calls,target.lane==='withGraph');
 const ids=[...new Set([...derived.recordIds,...derived.graphRecordIds])].sort();
 if(canonicalJson(ids)!==canonicalJson(Object.keys(target.records).sort())||target.retrievalComplete!==derived.retrievalComplete
  ||target.graphBounded!==(target.lane==='withGraph'&&derived.graphBounded))throw Error('Value target exceeds served MCP evidence');
}
