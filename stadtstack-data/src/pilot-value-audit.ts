import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {z} from 'zod';
import {bankSchema,canonical,digest,validateReport,summarize,assessedValueReview,
  type Report,type EvaluationRow} from './evaluate-pilot-value.ts';
import {assessmentItemSchema,assessmentEvidenceContext,originalEvidence,reconcile,ownerAudit,recordOwnerAudit,validateReceipt,
  writeImmutable,type AssessmentEvidenceContext,type AssessmentItem,type AssessmentReceipt,type OriginalEvidence} from './district-assessment.ts';

// These identify the read-only acceptance contract, not a new editable rubric.
export const FROZEN_R1_INPUTS={
  questionBankSha256:'2e74ab25477c83ed58a34e1a57ae76c16ed7f524fe7e6865106bfcc32bad18cc',
  rebuildPlanSha256:'cec8d20a8f443db49744e1b8ce51be6283184526e0895aa0010abcf8b0c2bdf2',
  statusCheckpointSha256:'643fe639b7c87cc285a2a84960aef34f7f2c36fac1606f93296c438feaa3969a',
  optionBApprovalSha256:'865e80d2aad2ec23250b83b50c012639d0b04f068fc64d42eabe1b36a82b35f5',
} as const;
export const GRAPH_PAIR_IDS=['W03','W04','E03','B03','K03','M03','H03'] as const;
const bytesHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const bankBytes=await readFile(new URL('../evaluation/pilot-questions.json',import.meta.url));
if(bytesHash(bankBytes)!==FROZEN_R1_INPUTS.questionBankSha256)throw Error('Frozen question bank bytes changed');
const bank=bankSchema.parse(JSON.parse(bankBytes.toString('utf8')));
type Lane='withoutGraph'|'withGraph';
type AuditReport=Report & {ownerAudit?:unknown};
export interface AuditAssessmentEntry {item:unknown;A:unknown;B:unknown;C:unknown;exceptionMinutes?:number}
type Disposition=Awaited<ReturnType<typeof reconcile>>;
type Risk=ReturnType<typeof ownerAudit>['frame'][number]['risk'];
export interface AuditPacketItem {
  itemId:string;evidenceSha256:string;questionId:string|null;lane:Lane|null;risk:Risk;
  exception:'none'|'unresolved'|'rights';exceptionMinutes:number;
  assessmentItem:AssessmentItem;assessmentItemSha256:string;
  answer:EvaluationRow['review'];criticalClaims:unknown[];
  originalEvidence:unknown[];mcpSources:Record<string,unknown>;
  outcomes:{A:unknown;B:unknown;C:unknown};disposition:Disposition;
}
export interface PilotAuditPacket {
  version:'pilot-value-owner-packet-v1';releaseId:string;reportSha256:string;
  frozenInputs:typeof FROZEN_R1_INPUTS;seed:string;items:AuditPacketItem[];
  sample:ReturnType<typeof ownerAudit>;blockingReasons:string[];
  labelPolicy:string;packetSha256:string;
}
// A later owner audit does not change the finalized evidence identity.
export function auditReportHash(report:AuditReport){const {ownerAudit:ignored,...value}=report;return digest(value);}
function assertFrozenReport(report:Report){
  validateReport(report);
  if(report.status!=='reviewed'||canonical(report.summary)!==canonical(summarize(report.evaluations)))throw Error('Finalize the complete evaluator report first');
  if(report.questionBankSha256!==FROZEN_R1_INPUTS.questionBankSha256||report.evaluations.length!==30
    ||new Set(report.evaluations.map(row=>row.question.id)).size!==30
    ||bank.questions.some(question=>!report.evaluations.some(row=>canonical(row.question)===canonical(question))))throw Error('Frozen questions/wording/denominator changed');
  if(report.method.assessmentProtocol!=='blinded-original-v1'||report.evaluations.some(row=>!row.review?.assessment))throw Error('R1 requires actual original-evidence A/B/C assessment provenance');
}
function originalExcerpts(evidence:OriginalEvidence){
  return evidence.map(({text:ignored,...source})=>({...source,
    locators:source.locators.map(locator=>({...locator,excerptSha256:bytesHash(locator.quote)})),
    ...(source.selectedContext?{selectedContext:{...source.selectedContext,spans:source.selectedContext.spans.map(span=>({...span,excerptSha256:bytesHash(span.text)}))}}:{}),
    ...(source.nativeLocators?{nativeLocators:source.nativeLocators.map(locator=>({locator,locatorSha256:digest(locator)}))}:{}),
  }));
}
function exceptionFor(disposition:Disposition,receipts:{A:AssessmentReceipt;B:AssessmentReceipt;C:AssessmentReceipt}):AuditPacketItem['exception']{
  const holds=[receipts.A,receipts.B,receipts.C].flatMap(receipt=>receipt.output.holdReasons);
  // C cannot grant rights. A/B rights questions remain explicit owner exceptions.
  if(holds.includes('rights'))return 'rights';
  if(disposition.blocksAffectedAdmission||disposition.output?.outcome==='unresolved'
    ||disposition.output?.holdReasons.some(reason=>['disagreement','critical_unsupported','insufficient_evidence','missing_original','ocr_suspected'].includes(reason)))return 'unresolved';
  return 'none';
}
function risks(item:AssessmentItem,disposition:Disposition):Risk[]{
  const result=new Set<Risk>();
  for(const kind of item.criticalKinds)result.add(kind==='stage'?'critical_stage':kind==='finance'?'critical_finance':kind==='identity'?'critical_identity':'ocr');
  for(const assertion of disposition.output?.assertions??[]){
    if(assertion.stage)result.add('critical_stage');
    if(assertion.financialRole!=='none')result.add('critical_finance');
    if(assertion.subjectId||assertion.objectId)result.add('critical_identity');
  }
  if(item.sources.some(source=>source.ocrSuspected))result.add('ocr');
  return [...result].sort();
}
export async function buildPilotAuditPacket(report:Report,entries:AuditAssessmentEntry[],seed:string,context?:AssessmentEvidenceContext):Promise<PilotAuditPacket>{
  assertFrozenReport(report);
  if(!seed)throw Error('Record a precommitted nonempty sample seed');
  const items:AuditPacketItem[]=[],seen=new Set<string>(),lanes=new Set<string>();
  for(const entry of entries){
    const item=assessmentItemSchema.parse(entry.item),lane=item.valueTarget?.lane??null;
    const key=lane?item.itemId+':'+lane:'claim:'+digest(item);
    if(seen.has(key))throw Error('Duplicate packet assessment');seen.add(key);
    const receipts={A:validateReceipt(entry.A,item,'A'),B:validateReceipt(entry.B,item,'B'),C:validateReceipt(entry.C,item,'C')};
    const disposition=await reconcile(item,entry,context),evidence=await originalEvidence(item,context);
    let row:EvaluationRow|undefined;
    if(lane){
      row=report.evaluations.find(row=>row.question.id===item.itemId);
      const decision=await assessedValueReview(report,item,entry,context);
      const binding=row?.review?.assessment?.lanes[lane];
      if(!row||canonical(binding)!==canonical(decision.binding)||canonical(row.review?.[lane])!==canonical(decision.review))throw Error('Packet receipts do not bind finalized answer');
      lanes.add(key);
    }
    const exception=exceptionFor(disposition,receipts);
    const reservation=entry.exceptionMinutes??(exception==='none'?0:10);
    if(!Number.isFinite(reservation)||reservation<0||(exception!=='none'&&reservation<=0))throw Error('Invalid exception time reservation');
    const mcpSources:Record<string,unknown>={};
    for(const source of evidence){
      const matches=Object.entries(report.sources).filter(([,attribution])=>attribution.sha256===source.originalSha256&&attribution.url===source.url
        &&(attribution.id===source.sourceId||attribution.registrySourceId===source.admittedSourceId));
      if(item.valueTarget&&!matches.length)throw Error('Original excerpt lacks MCP source attribution');
      for(const [id,attribution] of matches)mcpSources[id]=attribution;
    }
    const base={questionId:row?.question.id??null,lane,assessmentItem:item,assessmentItemSha256:digest(item),
      answer:row?.review??null,criticalClaims:[...(item.criticalTarget?.claims??[]),...(disposition.output?.assertions??[])],
      originalEvidence:originalExcerpts(evidence),mcpSources,
      outcomes:{A:receipts.A.output,B:receipts.B.output,C:receipts.C.output},disposition};
    // All answers/lanes are in the frame. Critical claims have additional risk
    // strata, rather than displacing the genuine routine random component.
    const strata:Risk[]=lane?['routine',...risks(item,disposition)]:risks(item,disposition);
    if(!strata.length)strata.push('routine');
    for(const [index,risk] of strata.entries()){
      const itemId=key+':'+risk;
      const content={...base,itemId,risk,exception:index===0?exception:'none' as const,exceptionMinutes:index===0?reservation:0};
      items.push({...content,evidenceSha256:digest(content)});
    }
  }
  for(const row of report.evaluations){
    if(!lanes.has(row.question.id+':withoutGraph'))throw Error('Packet must include all thirty answer assessments');
    if(row.question.graphDependent&&row.graph.available&&!lanes.has(row.question.id+':withGraph'))throw Error('Packet must include every established graph lane');
  }
  items.sort((a,b)=>a.itemId.localeCompare(b.itemId));
  const sample=ownerAudit(items.map(({itemId,evidenceSha256,risk,exception,exceptionMinutes})=>({itemId,evidenceSha256,risk,exception,exceptionMinutes})),seed);
  const blockingReasons=items.filter(item=>item.exception!=='none').map(item=>item.itemId+':'+item.exception);
  if(!sample.withinGate)blockingReasons.push('owner_packet_exceeds_80_sample_40_exception_120_total_minutes');
  const body={version:'pilot-value-owner-packet-v1' as const,releaseId:report.server.releaseId,reportSha256:auditReportHash(report),
    frozenInputs:FROZEN_R1_INPUTS,seed,items,sample,blockingReasons,
    labelPolicy:'AI-assessed, not independent gold. Option B defers only the sample audit until after release; unresolved critical/rights exceptions block release. Individually audited items never upgrade the full set.'};
  return {...body,packetSha256:digest(body)};
}
export function validatePilotAuditPacket(report:Report,packet:PilotAuditPacket){
  assertFrozenReport(report);
  const {packetSha256,...body}=packet;
  if(packet.version!=='pilot-value-owner-packet-v1'||packetSha256!==digest(body)||packet.reportSha256!==auditReportHash(report)
    ||packet.releaseId!==report.server.releaseId||canonical(packet.frozenInputs)!==canonical(FROZEN_R1_INPUTS))throw Error('Audit packet/report/release binding changed');
  for(const {evidenceSha256,...content} of packet.items)if(evidenceSha256!==digest(content))throw Error('Audit item evidence changed');
  const frame=packet.items.map(({itemId,evidenceSha256,risk,exception,exceptionMinutes})=>({itemId,evidenceSha256,risk,exception,exceptionMinutes}));
  if(canonical(ownerAudit(frame,packet.seed))!==canonical(packet.sample))throw Error('Audit sample changed');
  const expected=packet.items.filter(item=>item.exception!=='none').map(item=>item.itemId+':'+item.exception);
  if(!packet.sample.withinGate)expected.push('owner_packet_exceeds_80_sample_40_exception_120_total_minutes');
  if(canonical(expected)!==canonical(packet.blockingReasons))throw Error('Packet exception blockers changed');
}
const ownerCheckSchema=z.object({itemId:z.string().min(1),evidenceSha256:z.string().regex(/^[a-f0-9]{64}$/),
  minutes:z.number().finite().positive(),findings:z.string().min(1),reviewer:z.string().min(1),
  verdict:z.enum(['pass','fail','unresolved']),blockers:z.array(z.string().min(1))}).strict();
export const ownerAuditInputSchema=z.object({version:z.literal('pilot-value-owner-checks-v1'),releaseId:z.string().min(1),
  packetSha256:z.string().regex(/^[a-f0-9]{64}$/),checks:z.array(ownerCheckSchema)}).strict();
const ownerBindingSchema=z.object({version:z.literal('pilot-value-owner-audit-binding-v1'),releaseId:z.string(),
  reportSha256:z.string(),packetSha256:z.string(),checks:z.array(ownerCheckSchema),recorded:z.unknown(),bindingSha256:z.string()}).strict();
export function ingestPilotOwnerAudit(report:AuditReport,packet:PilotAuditPacket,input:unknown):AuditReport{
  validatePilotAuditPacket(report,packet);
  if(report.ownerAudit)throw Error('Do not overwrite a recorded owner audit');
  const audit=ownerAuditInputSchema.parse(input);
  if(audit.packetSha256!==packet.packetSha256||audit.releaseId!==packet.releaseId)throw Error('Owner audit packet/release identity changed');
  const recorded=recordOwnerAudit(packet.sample.frame,packet.seed,audit.checks.map(({verdict,blockers,...check})=>({...check,resolved:verdict==='pass'&&!blockers.length})));
  const binding={version:'pilot-value-owner-audit-binding-v1',releaseId:packet.releaseId,reportSha256:packet.reportSha256,
    packetSha256:packet.packetSha256,checks:audit.checks,recorded};
  return {...report,ownerAudit:{...binding,bindingSha256:digest(binding)}};
}
function recordedAudit(report:AuditReport,packet:PilotAuditPacket){
  if(!report.ownerAudit)return null;
  const binding=ownerBindingSchema.parse(report.ownerAudit);
  const {bindingSha256,...body}=binding;
  if(binding.version!=='pilot-value-owner-audit-binding-v1'||bindingSha256!==digest(body)||binding.releaseId!==packet.releaseId
    ||binding.packetSha256!==packet.packetSha256||binding.reportSha256!==packet.reportSha256)throw Error('Recorded owner audit binding changed');
  const {ownerAudit:ignored,...original}=report;
  const recomputed=ingestPilotOwnerAudit(original,packet,{version:'pilot-value-owner-checks-v1',releaseId:packet.releaseId,packetSha256:packet.packetSha256,checks:binding.checks});
  if(canonical(recomputed.ownerAudit)!==canonical(report.ownerAudit))throw Error('Recorded owner audit verdict changed');
  const recorded=recordOwnerAudit(packet.sample.frame,packet.seed,binding.checks.map(({verdict,blockers,...check})=>({...check,resolved:verdict==='pass'&&!blockers.length})));
  return {...binding,recorded};
}
export function computeFrozenVerdict(report:AuditReport,packet:PilotAuditPacket){
  validatePilotAuditPacket(report,packet);
  const summary=summarize(report.evaluations),audit=recordedAudit(report,packet);
  const pairs=GRAPH_PAIR_IDS.map(id=>{
    const row=report.evaluations.find(row=>row.question.id===id)!;
    const before=row.review!.withoutGraph,after=row.review!.withGraph;
    return {id,reviewed:!!after&&row.graph.available&&row.question.graphDependent===true,
      usefulnessWithout:before.usefulness.score,usefulnessWith:after?.usefulness.score??null,
      gain:after?after.usefulness.score-before.usefulness.score:null,
      correctnessWithout:before.correctness.score,correctnessWith:after?.correctness.score??null};
  });
  const gain=pairs.reduce((sum,pair)=>sum+(pair.gain??0),0),loss=pairs.filter(pair=>pair.correctnessWith!==null&&pair.correctnessWith<pair.correctnessWithout).length;
  const ownerBlockers=audit?.checks.filter(check=>check.verdict!=='pass'||check.blockers.length).map(check=>check.itemId+':'+check.verdict)??[];
  const blockers=[...packet.blockingReasons,...ownerBlockers];
  const gates={
    questions:{actual:summary.questions,reviewed:summary.reviewed,denominator:30,pass:summary.questions===30&&summary.reviewed===30},
    usefulness:{actual:summary.usefulnessPoints,minimum:30,denominator:60,lane:'withoutGraph',pass:summary.usefulnessPoints>=30},
    completeAnswers:{actual:summary.substantive,minimum:8,pass:summary.substantive>=8},
    correctness:{actual:summary.correctnessPoints,required:60,denominator:60,pass:summary.correctnessPoints===60},
    sources:{actual:summary.sourcingPoints,minimum:46,denominator:60,pass:summary.sourcingPoints>=46},
    graphPairs:{actual:pairs.filter(pair=>pair.reviewed).length,required:7,gain,minimumGain:2,correctnessLosses:loss,pairs,
      pass:pairs.every(pair=>pair.reviewed)&&gain>=2&&loss===0},
    unresolvedCriticalAndRights:{actual:packet.items.filter(item=>item.exception!=='none').length,required:0,pass:!packet.items.some(item=>item.exception!=='none')},
    ownerWorkload:{plannedMinutes:packet.sample.plannedMinutes,maximumMinutes:120,pass:packet.sample.withinGate&&(!audit||!audit.recorded.blocksPhaseAcceptance)},
    ownerFindings:{blockingFindings:ownerBlockers,pass:ownerBlockers.length===0},
  };
  for(const [name,gate] of Object.entries(gates))if(!gate.pass)blockers.push('gate_failed:'+name);
  return {version:'pilot-value-r1-verdict-v1',releaseId:report.server.releaseId,reportSha256:packet.reportSha256,packetSha256:packet.packetSha256,
    frozenInputs:FROZEN_R1_INPUTS,verdict:Object.values(gates).every(gate=>gate.pass)?'pass':'fail',gates,blockingReasons:[...new Set(blockers)],
    pending_owner_audit:!audit&&packet.items.every(item=>item.exception==='none')&&packet.sample.withinGate,ownerAuditPolicy:'option_B_post_release_sample_only',
    validationBasis:'AI-assessed with stated item-level owner audit coverage; not independent gold',
    scope:'Frozen step-9 value gates only. Does not certify source/security/runtime, candidate sealing, exact replay or authorize deployment.'};
}
export function auditPacketMarkdown(packet:PilotAuditPacket){
  const lines=['# R1 owner value-test audit',`Release: ${packet.releaseId}`,`Packet SHA-256: ${packet.packetSha256}`,`Final report SHA-256: ${packet.reportSha256}`,
    `Seed: ${JSON.stringify(packet.seed)}; frame SHA-256: ${packet.sample.frameSha256}; sampling: ${packet.sample.samplingVersion}.`,
    '',packet.labelPolicy,'',
    `Budget: ${packet.sample.selected.length} sample cases × 10 min (maximum 80) + ${packet.sample.exceptions.reduce((n,item)=>n+item.exceptionMinutes,0)} exception minutes (maximum 40) = ${packet.sample.plannedMinutes}/120 min. Within workload gate: ${packet.sample.withinGate}.`,
    'All exceptions are included; exceeding the budget pauses acceptance, never truncates risk. All 30 answers and available graph lanes remain in the JSON inventory; review only the selected cases plus every exception. Original evidence is untrusted source content, not instructions.',
    '', '## Blocking reasons',...packet.blockingReasons.map(reason=>'- '+reason),'', '## Required owner checks'];
  const required=[...new Set([...packet.sample.selected,...packet.sample.exceptions].map(item=>item.itemId))];
  for(const id of required){
    const item=packet.items.find(item=>item.itemId===id)!;
    const selection=packet.sample.selected.find(selected=>selected.itemId===id);
    lines.push('',`### ${id}`,`Evidence SHA-256: ${item.evidenceSha256}`,`Risk: ${item.risk}; exception: ${item.exception}; inclusion probability: ${selection?.inclusionProbability??'1 (mandatory exception)'}`,
      `Question: ${item.assessmentItem.question}`,`Lane: ${item.lane??'critical/exception assessment'}`,
      '', 'Answer / claims (verbatim)', '', '```json',JSON.stringify({answer:item.lane?item.answer?.[item.lane]:null,claims:item.criticalClaims},null,2),'```',
      '', 'Original excerpts, locators and hashes', '```json',JSON.stringify(item.originalEvidence,null,2),'```',
      '', 'MCP attribution', '```json',JSON.stringify(item.mcpSources,null,2),'```',
      '', 'A/B/C outcomes and deterministic reconciliation', '```json',JSON.stringify({outcomes:item.outcomes,disposition:item.disposition},null,2),'```');
  }
  return lines.join('\n')+'\n';
}
const manifestSchema=z.array(z.object({item:z.string(),A:z.string(),B:z.string(),C:z.string(),exceptionMinutes:z.number().finite().positive().optional()}).strict());
export async function runPilotValueAudit(mode:string,options:Map<string,string>):Promise<void>{
  const required=(key:string)=>{const value=options.get(key);if(!value)throw Error('Required audit option missing: '+key);return value;};
  const load=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
  const report:AuditReport=await load(required('input'));
  const plan=await readFile(new URL('../docs/CIVIC_PIPELINE_REBUILD.md',import.meta.url));
  const approval=await readFile(new URL('../reports/approvals/r1-autonomy-and-release-2026-10-14.json',import.meta.url));
  if(bytesHash(plan)!==FROZEN_R1_INPUTS.rebuildPlanSha256||bytesHash(approval)!==FROZEN_R1_INPUTS.optionBApprovalSha256)throw Error('Frozen gate contract/option B approval bytes changed');
  if(mode==='ingest-owner-audit'){
    const packet:PilotAuditPacket=await load(required('packet'));
    await writeImmutable(required('output'),ingestPilotOwnerAudit(report,packet,await load(required('audit'))));return;
  }
  const manifest=manifestSchema.parse(await load(required('assessments')));
  const entries=await Promise.all(manifest.map(async entry=>({item:await load(entry.item),A:await load(entry.A),B:await load(entry.B),C:await load(entry.C),exceptionMinutes:entry.exceptionMinutes})));
  const context=assessmentEvidenceContext({casRoot:options.get('cas-root'),policyStateDir:options.get('policy-state-dir'),
    currentAdmissionReceipts:options.has('current-policy-map')?await load(required('current-policy-map')):undefined});
  const prior:PilotAuditPacket|undefined=mode==='verdict'&&options.has('packet')?await load(required('packet')):undefined;
  const packet=await buildPilotAuditPacket(report,entries,prior?.seed??required('seed'),context);
  if(mode==='audit-packet'){
    await writeImmutable(required('output'),packet);
    const path=required('markdown');await mkdir(dirname(path),{recursive:true});await writeFile(path,auditPacketMarkdown(packet),{flag:'wx',mode:0o600});
    console.log(JSON.stringify({packetSha256:packet.packetSha256,plannedMinutes:packet.sample.plannedMinutes,blockingReasons:packet.blockingReasons}));
  }else if(mode==='verdict'){
    if(prior&&canonical(packet)!==canonical(prior))throw Error('Audit packet no longer matches original assessment manifest');
    const verdict=computeFrozenVerdict(report,packet);await writeImmutable(required('output'),verdict);
    console.log(JSON.stringify(verdict));if(verdict.verdict==='fail')process.exitCode=1;
  }else throw Error('Use audit-packet, ingest-owner-audit or verdict');
}
