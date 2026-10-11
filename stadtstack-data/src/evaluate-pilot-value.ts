import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {z} from 'zod';

// Deliberately imports no release/query/extraction code from this checkout. All evidence
// crosses the MCP protocol to a separately selected, release-pinned server process.
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const areas=['waerme','solar_wind','wohnen_planung','schule_kita','mobilitaet','haushalt_investitionen'] as const;
const questionSchema=z.object({id:z.string(),area:z.enum(areas),cityIds:z.array(z.string()).min(1),query:z.string(),question:z.string(),requires:z.array(z.string()).min(1),graphDependent:z.boolean().optional(),graphQueries:z.array(z.string()).optional()}).strict();
export const bankSchema=z.object({schemaVersion:z.literal('pilot-questions-v1'),frozenBeforeBaselineRetrieval:z.literal(true),scope:z.string(),municipalities:z.array(z.string()).length(9),questions:z.array(questionSchema).length(30)}).strict().superRefine((bank,ctx)=>{
  if(new Set(bank.questions.map(q=>q.id)).size!==30)ctx.addIssue({code:'custom',message:'Duplicate question ID'});
  if(new Set(bank.municipalities).size!==9)ctx.addIssue({code:'custom',message:'Duplicate municipality'});
  for(const area of areas)if(bank.questions.filter(q=>q.area===area).length!==5)ctx.addIssue({code:'custom',message:'Five questions required per area'});
  for(const q of bank.questions)if(q.cityIds.some(id=>!bank.municipalities.includes(id)))ctx.addIssue({code:'custom',message:'Question outside frozen pilot'});
});
type Question=z.infer<typeof questionSchema>;
type JsonObject=Record<string,unknown>;
const objectSchema=z.record(z.string(),z.unknown());
const topics:Record<Question['area'],string[]>={waerme:['waermeplanung'],solar_wind:['solarpark','windenergie'],wohnen_planung:['wohnbau'],schule_kita:['schule','kita'],mobilitaet:['mobilitaet'],haushalt_investitionen:['haushalt']};
const citationSchema=z.object({recordId:z.string(),sourceId:z.string(),url:z.url(),quote:z.string().min(1)}).strict();
export const reviewSchema=z.object({
  answer:z.string().min(20),kind:z.enum(['substantive','partial','abstention']),citations:z.array(citationSchema),
  correctness:z.object({score:z.number().int().min(0).max(2),rationale:z.string().min(20)}).strict(),
  sourcing:z.object({score:z.number().int().min(0).max(2),rationale:z.string().min(20)}).strict(),
  usefulness:z.object({score:z.number().int().min(0).max(2),rationale:z.string().min(20)}).strict(),
  data_missing:z.boolean(),missing:z.array(z.string()),limitations:z.array(z.string()).min(1),
  graphContribution:z.string().min(10),
}).strict();
export type Review=z.infer<typeof reviewSchema>;
export interface EvaluationRow {question:Question;recordIds:string[];callIds:number[];retrievalComplete:boolean;graph:{available:boolean;callIds:number[];recordIds:string[];bounded:boolean};evidenceSha256:string;review:null|{reviewer:string;withoutGraph:Review;withGraph:Review|null}}
export interface EvaluationSummary {questions:number;reviewed:number;substantive:number;partial:number;abstentions:number;correctAbstentions:number;usefulSubstantive:number;dataMissing:number;correctnessPoints:number;sourcingPoints:number;usefulnessPoints:number;maximumPoints:number;graphUnavailable:number;graphReviewed:number}
export interface EvaluationComparison {baselineRelease:string;currentRelease:string;interpretation:string;questions:{id:string;withoutGraphUsefulnessDelta:number;withinReleaseGraphUsefulnessDelta:number|null;graphRationale:string}[]}
export interface EvaluationMarkdownInput {generatedAt:string;server:Pick<Report['server'],'root'|'releaseId'|'toolCount'>;evaluations:EvaluationRow[];comparison?:EvaluationComparison}
export interface Report {
  schemaVersion:'pilot-value-evaluation-v1';status:'awaiting_review'|'reviewed';generatedAt:string;
  questionBankSha256:string;evaluatorSha256:string;server:{root:string;gitCommit:string;sourceSha256:string;sourceFiles:{path:string;sha256:string}[];releaseId:string;toolCount:number;tools:string[];transport:'stdio';protocol:string};
  method:JsonObject;releaseStatus:JsonObject;coverage:unknown;records:Record<string,JsonObject>;sources:Record<string,JsonObject>;
  calls:{id:number;tool:string;selection:JsonObject;response:unknown;responseSha256:string}[];evaluations:EvaluationRow[];
  summary?:EvaluationSummary;comparison?:EvaluationComparison;
}
export function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value);
}
export const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const byteHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
function containsQuote(value:unknown,quote:string):boolean {
  if(typeof value==='string')return value.includes(quote);
  if(Array.isArray(value))return value.some(item=>containsQuote(item,quote));
  return !!value&&typeof value==='object'&&Object.values(value).some(item=>containsQuote(item,quote));
}
export function validateReview(review:Review,row:EvaluationRow,report:Pick<Report,'records'|'sources'|'calls'>,withGraph=false){
  reviewSchema.parse(review);
  if(review.data_missing!==(review.missing.length>0))throw Error('Missing-data flag and rationale disagree');
  if(review.kind==='abstention'&&review.usefulness.score!==0)throw Error('Abstention is not a useful substantive answer');
  if(review.kind==='substantive'&&review.data_missing)throw Error('Incomplete answer must be partial, not substantive');
  if(review.kind!=='abstention'&&!review.citations.length)throw Error('Substantive claims need citations');
  if(review.sourcing.score>0&&!review.citations.length)throw Error('Sourcing score needs citations');
  if(!row.retrievalComplete&&!review.limitations.some(text=>/unvollständig|incomplete|begrenzt|bounded/i.test(text)))throw Error('Incomplete retrieval must be disclosed');
  if(withGraph&&row.graph.bounded&&!review.limitations.some(text=>/unvollständig|incomplete|begrenzt|bounded/i.test(text)))throw Error('Bounded graph retrieval must be disclosed');
  for(const citation of review.citations){
    const record=report.records[citation.recordId],source=report.sources[citation.sourceId];
    if(!(withGraph?[...row.recordIds,...row.graph.recordIds]:row.recordIds).includes(citation.recordId)||!record||!source||!Array.isArray(record.sourceIds)||!record.sourceIds.includes(citation.sourceId)||source.url!==citation.url)throw Error('Citation is not bound to retrieved primary attribution');
    const graphQuote=withGraph&&row.graph.callIds.some(id=>containsQuote(report.calls[id].response,citation.quote));
    if(!containsQuote(record,citation.quote)&&!containsQuote(source,citation.quote)&&!graphQuote)throw Error('Citation quote absent from MCP evidence');
  }
}
export function summarize(rows:EvaluationRow[]):EvaluationSummary{
  const reviews=rows.map(row=>row.review?.withoutGraph).filter((review):review is Review=>!!review);
  return {questions:rows.length,reviewed:reviews.length,substantive:reviews.filter(r=>r.kind==='substantive').length,partial:reviews.filter(r=>r.kind==='partial').length,abstentions:reviews.filter(r=>r.kind==='abstention').length,correctAbstentions:reviews.filter(r=>r.kind==='abstention'&&r.correctness.score===2).length,usefulSubstantive:reviews.filter(r=>r.kind!=='abstention'&&r.correctness.score===2&&r.usefulness.score>0).length,dataMissing:reviews.filter(r=>r.data_missing).length,correctnessPoints:reviews.reduce((n,r)=>n+r.correctness.score,0),sourcingPoints:reviews.reduce((n,r)=>n+r.sourcing.score,0),usefulnessPoints:reviews.reduce((n,r)=>n+r.usefulness.score,0),maximumPoints:reviews.length*2,graphUnavailable:rows.filter(r=>r.question.graphDependent&&!r.graph.available).length,graphReviewed:rows.filter(r=>r.review?.withGraph).length};
}
function rowHash(row:EvaluationRow,report:Report){
  const recordIds=[...new Set([...row.recordIds,...row.graph.recordIds])].sort();
  return digest({question:row.question,records:recordIds.map(id=>report.records[id]),sources:[...new Set(recordIds.flatMap(id=>report.records[id].sourceIds as string[]))].sort().map(id=>report.sources[id]),retrievalComplete:row.retrievalComplete,graph:row.graph,graphResponses:row.graph.callIds.map(id=>report.calls[id].response)});
}
export function validateReport(report:Report){
  if(report.schemaVersion!=='pilot-value-evaluation-v1'||report.evaluations.length!==30)throw Error('Expected thirty evaluations');
  for(const call of report.calls)if(call.responseSha256!==digest(call.response))throw Error('MCP evidence response changed');
  for(const row of report.evaluations){
    if(row.evidenceSha256!==rowHash(row,report))throw Error('Reviewed evidence binding changed');
    if(!row.review?.reviewer)throw Error('Every question requires explicit practitioner review');
    validateReview(row.review.withoutGraph,row,report);
    if(row.graph.available&&row.question.graphDependent&&!row.review.withGraph)throw Error('Enhanced graph questions require paired graph/no-graph reviews');
    if(row.review.withGraph){if(!row.graph.available)throw Error('Cannot review unavailable graph');validateReview(row.review.withGraph,row,report,true);}
  }
}
export function compareReports(baseline:Report,current:Report):EvaluationComparison{
  validateReport(baseline);validateReport(current);
  if(baseline.questionBankSha256!==current.questionBankSha256)throw Error('Question bank changed; paired comparison invalid');
  return {baselineRelease:baseline.server.releaseId,currentRelease:current.server.releaseId,interpretation:'Release-to-release change combines corpus and extraction changes. Only within-release paired reviews estimate graph contribution; neither proves causal effectiveness.',questions:current.evaluations.map(row=>{
    const old=baseline.evaluations.find(other=>other.question.id===row.question.id);if(!old)throw Error('Unpaired question');
    const before=old.review!.withoutGraph,after=row.review!.withoutGraph,graph=row.review!.withGraph;
    return {id:row.question.id,withoutGraphUsefulnessDelta:after.usefulness.score-before.usefulness.score,withinReleaseGraphUsefulnessDelta:graph?graph.usefulness.score-after.usefulness.score:null,graphRationale:graph?.graphContribution??'Graph unavailable or not requested; no contribution estimated.'};
  })};
}
async function sourceIdentity(root:string){
  const files:{path:string;sha256:string}[]=[];
  async function visit(relative:string){for(const entry of (await readdir(join(root,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(relative,entry.name);if(entry.isDirectory())await visit(path);else if(entry.isFile()&&/\.(?:ts|mjs|js)$/.test(path))files.push({path,sha256:byteHash(await readFile(join(root,path)))});}}
  await visit('src');await visit('regional');
  for(const path of ['package.json','package-lock.json'])files.push({path,sha256:byteHash(await readFile(join(root,path)))});
  const gitCommit=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  if(!/^[a-f0-9]{40}$/.test(gitCommit))throw Error('Cannot identify server source revision');
  return {gitCommit,sourceSha256:digest(files),sourceFiles:files};
}
function safeResponse(value:unknown):unknown {
  if(Array.isArray(value))return value.map(safeResponse);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>! /^(?:authorization|headers?|request|rawResponse|rawEvents|accessToken|refreshToken|apiKey|accountId|email)$/i.test(key)).map(([key,item])=>[key,(key==='nextCursor'||key==='cursor')&&typeof item==='string'?'[opaque pagination cursor omitted]':safeResponse(item)]));
  return value;
}
export function decodeTool(result:unknown):JsonObject {
  const value=objectSchema.parse(result);if(value.isError)throw Error('MCP tool returned an error; no missing-data inference permitted');
  if(value.structuredContent)return objectSchema.parse(value.structuredContent);
  const content=z.array(z.object({type:z.string(),text:z.string().optional()})).parse(value.content);
  const text=content.find(item=>item.type==='text')?.text;if(!text)throw Error('MCP response has no structured evidence');
  return objectSchema.parse(JSON.parse(text));
}
export async function collect(options:{serverRoot:string;releaseId:string;toolCount:16|19|20;bankPath:string}):Promise<Report>{
  sha.parse(options.releaseId);
  const root=await realpath(options.serverRoot),bankBytes=await readFile(options.bankPath),bank=bankSchema.parse(JSON.parse(bankBytes.toString('utf8')));
  const identity=await sourceIdentity(root);
  const transport=new StdioClientTransport({command:process.execPath,args:['--experimental-strip-types',join(root,'src/mcp.ts')],cwd:root,stderr:'ignore',env:{PATH:process.env.PATH??'',NODE_NO_WARNINGS:'1'}});
  const client=new Client({name:'pilot-value-evaluator',version:'1.0.0'});
  const report:Report={schemaVersion:'pilot-value-evaluation-v1',status:'awaiting_review',generatedAt:new Date().toISOString(),questionBankSha256:byteHash(bankBytes),evaluatorSha256:byteHash(await readFile(fileURLToPath(import.meta.url))),server:{root,...identity,releaseId:options.releaseId,toolCount:options.toolCount,tools:[],transport:'stdio',protocol:'MCP SDK initialize + tools/list + tools/call'},method:{scope:bank.scope,questionOrder:'Frozen before evidence retrieval; no favourable-answer selection',retrieval:'Per question: text search, then all area topics through search_topics and get_regional_topics (including withheld district candidates). Full records and attribution fetched via get_signal/get_source. No new URLs fetched.',pagination:'50 rows/page; maximum 100 pages/query. Truncation explicit, not absence.',grading:'AI-assisted claim-by-claim source-to-answer review, not human approval or row-count scoring. 0/1/2: correctness unsupported/qualified/supported; sourcing absent/partial/claim-bound; usefulness none/partial/actionable full answer. Correct abstention scores correctness separately, usefulness zero.',independence:'Coding assistant review of released MCP evidence; no independent primary-document re-reading or external factual audit. Auto-verified is not independent corroboration.',dateAuthority:'Document/publication/retrieval dates are not automatically decision dates; agenda/proposal is not adopted policy; budget is not expenditure; completed is not effective.',graph:'Unavailable is distinct from no path. Graph results are bounded discovery, preserve modality and identity caveats. Compare paired no-graph/graph reviews within the same release; release-to-release difference is confounded by added evidence.'},releaseStatus:{},coverage:null,records:{},sources:{},calls:[],evaluations:[]};
  async function call(tool:string,selection:JsonObject){
    const response=decodeTool(await client.callTool({name:tool,arguments:selection}));
    const data=typeof response.data==='object'&&response.data!==null&&'source' in response?objectSchema.parse(response.data):response;
    if(typeof data.releaseId==='string'&&data.releaseId!==options.releaseId)throw Error('MCP response release changed');
    const clean=safeResponse(data),id=report.calls.length;
    report.calls.push({id,tool,selection:objectSchema.parse(safeResponse(selection)),response:clean,responseSha256:digest(clean)});
    return {data,id};
  }
  async function pages(tool:string,selection:JsonObject){
    const items:JsonObject[]=[],callIds:number[]=[];let cursor:string|undefined;
    for(let page=0;page<100;page++){
      const result=await call(tool,{...selection,limit:50,...(cursor?{cursor}:{})});callIds.push(result.id);
      items.push(...z.array(objectSchema).parse(result.data.items));
      const next=result.data.nextCursor;if(next===null||next===undefined)return {items,callIds,complete:result.data.complete!==false&&result.data.truncated!==true};
      if(typeof next!=='string'||!next||next===cursor)throw Error('Invalid MCP pagination');cursor=next;
    }
    return {items,callIds,complete:false};
  }
  try{
    await client.connect(transport);
    const listed=await client.listTools();report.server.tools=listed.tools.map(tool=>tool.name).sort();
    if(listed.nextCursor||report.server.tools.length!==options.toolCount)throw Error('Unexpected release tool inventory');
    const requiredGraph=['entity_search','graph_neighbors','graph_path'];
    const graphAvailable=requiredGraph.every(name=>report.server.tools.includes(name));
    if(graphAvailable!==(options.toolCount>=19))throw Error('Graph inventory does not match selected release');
    report.releaseStatus=(await call('get_release_status',{})).data;
    if(objectSchema.parse(report.releaseStatus.dataManifest).id!==options.releaseId)throw Error('Wrong immutable release');
    report.coverage=(await call('list_cities',{})).data;
    await call('list_topics',{cityIds:bank.municipalities});
    for(const question of bank.questions){
      const row:EvaluationRow={question,recordIds:[],callIds:[],retrievalComplete:true,graph:{available:graphAvailable,callIds:[],recordIds:[],bounded:false},evidenceSha256:'',review:null};
      const found=new Set<string>();
      const selections:[string,JsonObject][]=[['search_topics',{query:question.query,cityIds:question.cityIds,excludePlaces:true,excludeOSM:true}]];
      for(const topic of topics[question.area]){
        selections.push(['search_topics',{topic,cityIds:question.cityIds,excludePlaces:true,excludeOSM:true}]);
        for(const municipalityId of question.cityIds)selections.push(['get_regional_topics',{topic,municipalityId,excludePlaces:true,excludeOSM:true}]);
      }
      for(const [tool,selection] of selections){const result=await pages(tool,selection);row.callIds.push(...result.callIds);row.retrievalComplete&&=result.complete;for(const item of result.items)found.add(z.string().parse(item.id));}
      row.recordIds=[...found].sort();
      for(const id of row.recordIds){
        if(!report.records[id]){const result=await call('get_signal',{id});report.records[id]=result.data;row.callIds.push(result.id);}
        for(const sourceId of z.array(z.string()).parse(report.records[id].sourceIds))if(!report.sources[sourceId]){const result=await call('get_source',{sourceId});report.sources[sourceId]=result.data;row.callIds.push(result.id);}
      }
      if(question.graphDependent&&graphAvailable){
        const entities=new Set<string>();
        for(const query of question.graphQueries??[question.query]){const result=await pages('entity_search',{query});row.graph.callIds.push(...result.callIds);row.graph.bounded||=!result.complete;for(const entity of result.items)entities.add(z.string().parse(entity.id));}
        const ids=[...entities].sort().slice(0,12);row.graph.bounded||=entities.size>ids.length;
        for(const id of ids){const result=await pages('graph_neighbors',{id,direction:'both'});row.graph.callIds.push(...result.callIds);row.graph.bounded||=!result.complete;}
        // Deterministic bounded pair set. No inferred endpoints, legal identity or causal claims.
        let pairs=0;for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++){
          if(pairs++>=12){row.graph.bounded=true;continue;}
          const result=await call('graph_path',{fromId:ids[i],toId:ids[j],maxHops:5,limit:20});row.graph.callIds.push(result.id);
          if(result.data.nextCursor||result.data.truncated===true||result.data.complete===false)row.graph.bounded=true;
        }
        const graphRecords=new Set<string>();
        function findEvidence(value:unknown){
          if(Array.isArray(value)){for(const item of value)findEvidence(item);return;}
          if(!value||typeof value!=='object')return;
          const object=value as JsonObject;
          if(typeof object.recordId==='string'&&typeof object.municipalityId==='string'&&question.cityIds.includes(object.municipalityId))graphRecords.add(object.recordId);
          for(const item of Object.values(object))findEvidence(item);
        }
        for(const id of row.graph.callIds)findEvidence(report.calls[id].response);
        row.graph.recordIds=[...graphRecords].sort();
        for(const id of row.graph.recordIds){
          if(!report.records[id]){const result=await call('get_signal',{id});report.records[id]=result.data;row.callIds.push(result.id);}
          for(const sourceId of z.array(z.string()).parse(report.records[id].sourceIds))if(!report.sources[sourceId]){const result=await call('get_source',{sourceId});report.sources[sourceId]=result.data;row.callIds.push(result.id);}
        }
      }
      row.evidenceSha256=rowHash(row,report);report.evaluations.push(row);
    }
    const finalStatus=(await call('get_release_status',{})).data;
    if(objectSchema.parse(finalStatus.dataManifest).id!==options.releaseId||(await sourceIdentity(root)).sourceSha256!==identity.sourceSha256)throw Error('Server source or release changed during evaluation');
    return report;
  }finally{await client.close();await transport.close();}
}
export function markdown(report:EvaluationMarkdownInput,evidencePath:string):string{
  const summary=summarize(report.evaluations),hasGraph=report.evaluations.some(row=>row.graph.available);
  const cell=(value:string)=>value.replace(/\|/g,'\\|').replace(/\s+/g,' ');
  const points=(review:Review)=>`${review.correctness.score}/${review.sourcing.score}/${review.usefulness.score}`;
  const citations=(review:Review)=>[...new Set(review.citations.map(citation=>citation.url))].map((url,i)=>`[Quelle ${i+1}](${url})`).join(' ');
  const lines=[`# Pilotwert: ${hasGraph?'Erweiterte Evaluation mit Graphvergleich':'Baseline-Evaluation'}`,'',`Release: \`${report.server.releaseId}\` · ${report.server.toolCount} MCP-Tools · ${report.generatedAt}.`,'',
    `**${summary.questions} vorab festgelegte Fragen, ohne Graph-Tools bewertet:** ${summary.substantive} vollständige, ${summary.partial} teilweise Antworten, ${summary.abstentions} Enthaltungen. ${summary.usefulSubstantive} quellengetragene zumindest teilweise nützliche Antworten; ${summary.correctAbstentions} korrekte Enthaltungen sind **nicht** als nützliche Sachantworten gezählt. Datenlücken: ${summary.dataMissing}/${summary.questions}.`,
    `Punkte (je 0–2): Korrektheit ${summary.correctnessPoints}/${summary.maximumPoints}, Quellen ${summary.sourcingPoints}/${summary.maximumPoints}, Nutzen ${summary.usefulnessPoints}/${summary.maximumPoints}. Korrektheit schließt vorsichtige Enthaltungen ein und ist deshalb keine Erfolgsquote.`,'','## Methode und Grenzen','',
    '- Echte MCP-Initialisierung, Tool-Inventar und Tool-Aufrufe über einen getrennten lokalen stdio-Prozess. Ausgewählte unveränderliche Serverquellen und veröffentlichter Datenstand; keine neuen Downloads.',
    '- Fragebank vor Baseline-Abfrage eingefroren. Text- und Themenabfragen mit Pagination; Record- und Quellenabruf über MCP, kein direkter Zugriff auf unveröffentlichte Kandidaten.',
    '- Quellengebundene Einzelbewertung durch KI-Assistenz, keine menschliche Freigabe und keine Punkte allein für Treffer. Keine flächendeckende unabhängige Prüfung der Originaldokumente. Fehlende Treffer belegen keine fehlende kommunale Aktivität.',
    '- Dokumentdatum, Sitzungstermin, Beschlussdatum und Abrufdatum bleiben verschieden. Bekanntmachung oder Vorlage ist kein Umsetzungsbeleg; Ansatz ist keine Auszahlung; Umsetzung ist kein Wirkungsnachweis.',
    `- Graphabhängige Fragen ohne verfügbare Graph-Tools: ${summary.graphUnavailable}; tatsächlich paarweise bewertete Fragen: ${summary.graphReviewed}. „Nicht verfügbar“ bedeutet nicht „kein Pfad“.`,
    '- Die maschinenlesbare Datei bindet Fragen, Tool-Auswahl, öffentliche Evidenz, Record-IDs, Quellen und Bewertungsbegründungen durch SHA-256. Keine Zugangsdaten oder Protokoll-Header.','', '## Einzelantworten ohne Graph-Tools','',
    `K/Q/N = Korrektheit/Quellen/Nutzen, je 0–2. Vollständige Fragen, Zitate und Einzelbegründungen: \`${evidencePath}\`. Jede Zeile bleibt enthalten, auch bei Datenlücken.`,'',
    '| Frage | Antwort / konkrete Lücke | K/Q/N |','| --- | --- | --- |'];
  for(const row of report.evaluations){
    const review=row.review!.withoutGraph;
    lines.push(`| ${row.question.id} | ${cell(review.answer)} ${citations(review)} | ${points(review)} |`);
  }
  if(hasGraph){
    lines.push('','## Graphbeitrag bei identischem Datenstand','',
      'Nur diese Paare vergleichen denselben Release mit und ohne Graph-Tools. Zusätzliche Datensätze sind kein kausaler Graphgewinn. Namensgruppen, gefundene Pfade oder ein fehlender Pfad beweisen weder rechtliche Identität noch Wirkung.','',
      '| Frage | Ohne → mit Graph: K/Q/N | Antwort mit Graph / Beitrag / verbleibende Lücke |','| --- | --- | --- |');
    for(const row of report.evaluations.filter(row=>row.question.graphDependent)){
      const without=row.review!.withoutGraph,withGraph=row.review!.withGraph;
      lines.push(withGraph?`| ${row.question.id} | ${points(without)} → ${points(withGraph)} | ${cell(withGraph.answer)} ${citations(withGraph)} ${cell(withGraph.graphContribution)} ${cell(withGraph.missing.join('; '))} |`:`| ${row.question.id} | nicht paarweise bewertet | Keine Aussage über einen Graphgewinn. |`);
    }
  }
  if(report.comparison){
    lines.push('','## Veränderung gegenüber der Baseline','',
      `Baseline: \`${report.comparison.baselineRelease}\`; aktuell: \`${report.comparison.currentRelease}\`. Änderungen zwischen Releases enthalten zugleich Daten- und Extraktionsänderungen. Die Graph-Spalte betrifft nur Paare innerhalb des aktuellen Releases, keinen Wirkungsnachweis.`,'',
      '| Frage | Nutzendifferenz ohne Graph zur Baseline | Nutzendifferenz mit Graph im selben Release |','| --- | --- | --- |');
    for(const row of report.comparison.questions)lines.push(`| ${row.id} | ${row.withoutGraphUsefulnessDelta} | ${row.withinReleaseGraphUsefulnessDelta??'nicht bewertet'} |`);
  }
  lines.push('','## Reproduzieren und vergleichen','','Im Verzeichnis `stadtstack-data`:','','```sh',
    `node --experimental-strip-types src/evaluate-pilot-value.ts collect --server-root ${report.server.root} --release ${report.server.releaseId} --tools ${report.server.toolCount} --output reports/pilot-value-replay.json --reuse-review ${evidencePath}`,
    '```','','Review-Wiederverwendung nur bei identischer Fragebank, Release-ID und fragebezogenem Evidenzhash. Neue Evidenz erfordert neue Einzelbewertungen. `finalize --input DATEI --markdown BERICHT --baseline reports/pilot-value-baseline.json` prüft Bindungen und unveränderte Fragen vor dem Vergleich. Graphfragen benötigen zusätzlich `withGraph` für denselben Release.','');
  return lines.join('\n');
}
async function save(path:string,value:string){await mkdir(dirname(path),{recursive:true});await writeFile(path,value);}
async function main(){
  const [mode,...args]=process.argv.slice(2),options=new Map<string,string>();
  for(let i=0;i<args.length;i+=2){if(!args[i]?.startsWith('--')||!args[i+1]||args[i+1].startsWith('--'))throw Error('Expected named option and value');options.set(args[i].slice(2),args[i+1]);}
  const required=(name:string)=>{const value=options.get(name);if(!value)throw Error('Required evaluation option missing');return value;};
  const load=async(path:string)=>JSON.parse(await readFile(path,'utf8')) as Report;
  if(mode==='collect'){
    const toolCount=Number(required('tools'));if(toolCount!==16&&toolCount!==19&&toolCount!==20)throw Error('Expected 16, 19 or 20 tools');
    const report=await collect({serverRoot:required('server-root'),releaseId:required('release'),toolCount,bankPath:options.get('bank')??new URL('../evaluation/pilot-questions.json',import.meta.url).pathname});
    const reuse=options.get('reuse-review');if(reuse){const prior=await load(reuse);validateReport(prior);if(prior.questionBankSha256!==report.questionBankSha256||prior.server.releaseId!==report.server.releaseId)throw Error('Review identity mismatch');for(const row of report.evaluations){const old=prior.evaluations.find(item=>item.question.id===row.question.id);if(!old||old.evidenceSha256!==row.evidenceSha256)throw Error('Cannot reuse review after evidence change');row.review=old.review;}validateReport(report);report.status='reviewed';report.summary=summarize(report.evaluations);}
    await save(required('output'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,questions:report.evaluations.length,tools:toolCount,releaseId:report.server.releaseId}));
  }else if(mode==='finalize'){
    const path=required('input'),report=await load(path);validateReport(report);report.status='reviewed';report.summary=summarize(report.evaluations);
    if(options.has('baseline'))report.comparison=compareReports(await load(required('baseline')),report);
    await save(path,JSON.stringify(report,null,2)+'\n');await save(required('markdown'),markdown(report,path));console.log(JSON.stringify(report.summary));
  }else throw Error('Use collect or finalize');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Pilot evaluation failed; no credentials, server stderr or raw protocol objects emitted. Check pinned release, tool contract and review evidence.');process.exitCode=1;});
