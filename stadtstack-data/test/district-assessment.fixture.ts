import { mkdtemp, realpath } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DistrictCas, type CasPutOptions } from '../src/district-cas.ts';
import { createPolicyReceipt } from '../src/district-policy-receipt.ts';
import { canonicalJson, digest, semanticHash } from '../src/district-adapter-contract.ts';
import { encodeStepReceipt, unknownReceiptCounts, type StepReceipt } from '../src/district-step-receipt.ts';
import { provisionCivicPolicyAuthority, initializeManagedAcquisitionLane, withManagedSourceWrite, CIVIC_ACQUISITION_DECISION_ID } from '../src/civic-opt-out.ts';
import { z } from 'zod';
import { assessmentBlindProjection, assessmentItemSchema, assessmentOutputSchema, PROMPTS, digest as assessmentDigest, originalEvidence, buildAssessmentPassInput,
  type AssessmentEvidenceContext, type AssessmentItem, type AssessmentOutput, type AssessmentReceipt, type AssessmentPassInput,type OriginalEvidence } from '../src/district-assessment.ts';
import {DistrictKnowledgeRecordSchema,REQUIRED_DETERMINISTIC_CHECKS,knowledgeEvidenceHash} from '../src/district-schema.ts';
import {GRAPH_DETERMINISTIC_CHECKS} from '../src/district-graph-claims.ts';
import {PROVIDER_CONFIGS,EMPTY_USAGE,type ModelAnswer} from '../src/district-model-contract.ts';
import type {PolicyReceipt} from '../src/district-policy-receipt.ts';
import {prepareCriticalAssessment} from '../src/district-critical-assessment.ts';
import {criticalKnowledgeTarget} from '../src/district-critical-assessment-public.ts';
import type {DistrictKnowledgeRecord} from '../src/district-schema.ts';
import {resolveProviderQuoteReferences} from '../src/district-assessment-projection.ts';

// Synthetic licensed bytes and explicit parser receipts; never source data or provider calls.
export async function admittedAssessmentFixture(text: string, managed = false) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'assessment-cas-test-'));
  const cas = new DistrictCas(join(directory, 'cas'), { maxBytes: 1024 * 1024 });
  // Explicit synthetic provisioning follows the canonical opt-out test seam.
  // Production assessment never provisions or substitutes a policy authority.
  const stateDir = join(directory, 'policy');
  const authority = await provisionCivicPolicyAuthority({ stateDir, authorityId: 'fixture:' + randomUUID() });
  const policyOptions = { stateDir, authorityId: authority.authorityId, authoritySha256: authority.authoritySha256 };
  const source = { url: 'https://example.org/assessment-fixture.txt', sha256: digest(text), mimeType: 'text/plain' };
  const now = Date.now(), checkedAt = new Date(now - 1000).toISOString(), expiresAt = new Date(now + 300_000).toISOString();
  const created = await createPolicyReceipt({ source,
    scope: { publisherId: 'fixture', sourceId: 'source1', municipalityId: 'strausberg', ags: '12064472', tenant: null, observationWindow: '2026-10-11' },
    sourcePolicy: { robots: { state: 'allowed', url: 'https://example.org/robots.txt' }, tdm: { state: 'not_declared', evidence: [] }, access: 'public', legalClassification: 'not_assessed', publication: 'facts_with_attribution_only' },
    permission: { kind: 'distribution_licence', distributionUrl: source.url, licenceId: 'synthetic-test-only', termsUrl: 'https://example.org/terms', termsSha256: digest('test terms'), approvalSha256: digest('test approval') },
    checkedAt, expiresAt }, policyOptions);
  if (managed) await initializeManagedAcquisitionLane(cas.root, { ...policyOptions, decisionId: CIVIC_ACQUISITION_DECISION_ID, kind: 'artifacts' });
  const put = async (bytes: Buffer, options: CasPutOptions) => {
    if (!managed) return cas.put(bytes, options);
    const hash = digest(bytes);
    return withManagedSourceWrite(cas.root, [{ kind: 'http_observation', relativePath: `sha256/${hash.slice(0,2)}/${hash}`,
      contentSha256: hash, url: source.url, sourceSha256: source.sha256, observationId: 'synthetic-assessment-fixture',
      receiptSha256: created.receiptSha256, independentAllowed: options.kind === 'source_original' }],
      () => cas.put(bytes, options), policyOptions);
  };
  const policyArtifact = await put(Buffer.from(canonicalJson(created.receipt)), { kind: 'receipt', mimeType: 'application/json' });
  const originalArtifact = await put(Buffer.from(text), { kind: 'source_original', mimeType: 'text/plain', admission: {
    state: 'allowed', sourceSha256: source.sha256, policyProofSha256: policyArtifact.sha256, checkedAt, expiresAt } });
  const step: StepReceipt = { version: 'district-step-receipt-v1', canonicalizationVersion: 'district-json-v1',
    id: randomUUID(), runId: randomUUID(), jobKey: digest('fixture parse'), step: 'parse', lane: 'cpu', sourceId: 'source1', municipalityId: 'strausberg',
    attempt: 1, leaseToken: '1', category: 'development', dependencyReceiptIds: [], enqueuedAt: checkedAt, startedAt: checkedAt, finishedAt: checkedAt,
    queueWaitMs: 0, elapsedMs: null, cpuUserMicros: null, cpuSystemMicros: null, outcome: 'succeeded', reasonCode: 'completed',
    inputHashes: [source.sha256], outputHashes: [source.sha256], policyProofSha256: policyArtifact.sha256, originProofSha256: null,
    versions: { parser: 'fixture-parser-v1' }, cache: { disposition: 'miss', originalGenerationReceiptId: null }, provider: null, counts: unknownReceiptCounts };
  const encoded = encodeStepReceipt(step);
  const parserArtifact = await put(Buffer.from(encoded.bytes), { kind: 'receipt', mimeType: 'application/json' });
  return { directory, authority, context: { cas, policyOptions }, policy: created.receipt, policyArtifact, parserArtifact, originalArtifact,
    originalObjectPath: join(cas.root, originalArtifact.storageKey),
    source: { sourceId: 'source1', originalSha256: source.sha256, textSha256: source.sha256, parserVersion: 'fixture-parser-v1',
      parserReceiptSha256: parserArtifact.sha256, admissionReceiptSha256: policyArtifact.sha256, ocrSuspected: false,
      locators: [{ id: 'page1', page: 1, table: null, start: 0, end: text.length }] } };
}
export function syntheticAssessmentReceipt(item: AssessmentItem, role: 'A' | 'B' | 'C', output: AssessmentOutput,
  request: unknown, dependencies: string[] = []): AssessmentReceipt {
  const identity = { provider: 'anthropic-subscription' as const, tool: 'claude-cli' as const,
    toolVersion: '0.0.0-synthetic-test-only', model: 'claude-haiku-5-5',
    modelIdentityBasis: 'reported-cli-model-and-tool-version' as const };
  const body = { version: 'assessment-receipt-v1' as const, canonicalizationVersion: 'district-json-v1' as const,
    role, itemSha256: assessmentDigest(item),
    requestSha256: assessmentDigest(request), responseSha256: createHash('sha256').update(JSON.stringify(output)).digest('hex'),
    outputSha256: assessmentDigest(output), promptSha256: createHash('sha256').update(PROMPTS[role]).digest('hex'),
    schemaSha256: assessmentDigest(z.toJSONSchema(assessmentOutputSchema)), rubricSha256: item.rubricSha256,
    provider: 'anthropic-subscription' as const, requestedModel: 'claude-haiku-5-5', returnedModel: 'claude-haiku-5-5',
    modelEvidence: { ...identity, modelIdentitySha256: createHash('sha256').update(JSON.stringify(identity)).digest('hex') },
    decoding: 'subscription-runtime-pinned' as const,
    startedAt: '2026-10-11T00:00:00Z', finishedAt: '2026-10-11T00:00:01Z', usage: null, actualBilledUsd: null,
    estimatedApiUsd: null, dependencies, output, deterministicIssues: [] };
  return { ...body, receiptSha256: assessmentDigest(body) };
}
export async function syntheticAssessmentTriplet(item: AssessmentItem, output: AssessmentOutput, context: AssessmentEvidenceContext) {
  const evidence = await originalEvidence(item, context);
  const input = buildAssessmentPassInput(item, evidence, 'A');
  const A = syntheticAssessmentReceipt(item, 'A', output, input.data), B = syntheticAssessmentReceipt(item, 'B', output, input.data);
  const reconciliation = buildAssessmentPassInput(item, evidence, 'C', { A, B });
  const C = syntheticAssessmentReceipt(item, 'C', output, reconciliation.data, reconciliation.dependencies);
  return { A, B, C };
}
export function recordFor(f:{source:AssessmentItem['sources'][number];policy:PolicyReceipt},text:string){
 const pinned=PROVIDER_CONFIGS['openai-subscription'],hash=digest('synthetic record contract');
 const route={provider:'openai-subscription' as const,model:pinned.model,tool:pinned.tool};
 const config={...route,modelIdentityBasis:pinned.modelIdentityBasis};
 const record={kind:'text_model',id:'knowledge:fixture:'+randomUUID(),municipalityId:'strausberg',ags:'12064472',districtId:'maerkisch-oderland',title:'Strausberg',titleQuote:'Strausberg',municipalityQuote:'Strausberg',summary:text,summaryQuote:text,caseKeyType:'source_document',caseKey:'source_document:'+f.source.originalSha256,caseQuote:null,caseType:'unknown',documentDate:null,documentDateQuote:null,documentDateReason:'Synthetic undated source',stage:'unknown',stageDate:null,stageDateQuote:null,stageDateReason:'Synthetic undated event',originalStatus:'',stageQuote:'',stages:[],entities:[],relations:[],locations:[],topics:[],sources:[{id:f.source.sourceId,url:f.policy.source.url,sha256:f.source.originalSha256,retrievedAt:'2026-10-11T00:00:00.000Z',locator:'source-original',mimeType:'text/plain',sourceType:'website',policy:f.policy.sourcePolicy}],extraction:{extractorVersion:'synthetic-test',extractorSha256:hash,...config,toolVersion:'synthetic-test',modelIdentitySha256:hash,returnedModel:null,promptVersion:'synthetic-test',promptSha256:hash,judgePromptVersion:'synthetic-test',judgePromptSha256:hash,inputSha256:f.source.originalSha256,textSha256:f.source.textSha256,responseSha256:hash,ocrUsed:false,textMethod:'text',cacheKey:hash,extractedAt:'2026-10-11T00:00:00.000Z',chunk:{index:0,count:1,start:0,end:text.length}},verification:{kind:'text_model',status:'auto-verified',deterministic:{passed:true,checks:[...REQUIRED_DETERMINISTIC_CHECKS,...GRAPH_DETERMINISTIC_CHECKS].map(id=>({id,passed:true,reason:'Synthetic fixture only'}))},faithfulness:{score:0.9,threshold:0.8,...route,toolVersion:'synthetic-test',modelIdentitySha256:hash,returnedModel:null,reason:'Synthetic fixture only',evaluatedAt:'2026-10-11T00:00:00.000Z',responseSha256:hash,sameModel:true,limitation:'Same-model judgment is not independent verification.'},evidenceHash:hash}};
 record.sources[0].locator=`text-sha256:${f.source.textSha256};chars:0-${text.length}`;
 record.verification.evidenceHash=knowledgeEvidenceHash(record);return DistrictKnowledgeRecordSchema.parse(record);
}
export function answer(input:AssessmentPassInput,unresolved=false):ModelAnswer{
 const data=(input.data.providerEncoding?resolveProviderQuoteReferences(input.data,input.data.evidence as OriginalEvidence):input.data) as {itemId:string;claimIds:string[];claim?:{propositions?:{claimId:string;selector:string;quote:string|null;assertionEncoding?:{modality?:AssessmentOutput['assertions'][number]['modality'];subjectId?:string|null;objectId?:string|null}}[]};evidence:{sourceId:string;locators:{id:string;quote:string}[]}[]};
 const source=data.evidence[0],locator=source.locators[0];
 const assertions:AssessmentOutput['assertions']=unresolved?[]:data.claimIds.map(claimId=>{
  const proposition=data.claim?.propositions?.find(proposition=>proposition.claimId===claimId),selected=source.locators.find(candidate=>candidate.quote===proposition?.quote)??locator;
  const assertion:AssessmentOutput['assertions'][number]={claimId,sourceId:source.sourceId,locatorId:selected.id,quote:selected.quote,subjectId:null,objectId:null,unit:null,value:null,date:null,dateRole:null,financialRole:'none',stage:null,modality:'unknown'};
  if(proposition?.selector.startsWith('/relations/')){
   assertion.subjectId=proposition.assertionEncoding?.subjectId??null;assertion.objectId=proposition.assertionEncoding?.objectId??null;
   assertion.modality=proposition.assertionEncoding?.modality??'unknown';
  }
  return assertion;
 });
 const output:AssessmentOutput={itemId:data.itemId,outcome:unresolved?'unresolved':'supported',assertions,scores:{correctness:2,sources:2,usefulness:unresolved?0:1},holdReasons:[],rationale:'Synthetic provider fixture; never a civic assessment.'};
 const config=PROVIDER_CONFIGS['openai-subscription'];
 const identity={provider:'openai-subscription' as const,tool:config.tool,toolVersion:'0.0.0-synthetic-test-only',model:config.model,modelIdentityBasis:config.modelIdentityBasis};
 return {value:output,responseSha256:digest(canonicalJson(output)),evidence:{...identity,modelIdentitySha256:digest(JSON.stringify(identity))},requestedModel:config.model,returnedModel:null,reportedModels:[],runtimeWarnings:[],usage:{...EMPTY_USAGE,perModel:{}}};
}
/** Literal pre-v2 target encoding for authenticated historical queue fixtures.
 * This is not an alternate production preparation route. */
export function historicalResidualAssessmentItem(record:DistrictKnowledgeRecord,current:AssessmentItem):AssessmentItem{
 const {extraction:_generation,verification:_judgment,sources,...claims}=record;
 const sourceProjection=sources.map(({id,url,sha256})=>({id,url,sha256}));
 const projection=z.record(z.string(),z.unknown()).parse(assessmentBlindProjection({...claims,sources:sourceProjection}));
 const metadata=new Set(['id','kind','municipalityId','ags','districtId','sources']);
 const propositions=Object.entries(projection).sort(([a],[b])=>a<b?-1:a>b?1:0).filter(([field])=>!metadata.has(field)&&!field.endsWith('Quote')).flatMap(([field,value])=>{
  const claim=(selector:string,member:unknown)=>{
   const quote=member&&typeof member==='object'&&'quote' in member?member.quote:projection[field+'Quote']??null;
   const body={selector,value:member,quote,sources:sourceProjection};
   return {...body,claimId:'proposition:'+semanticHash({recordId:record.id,...body})};
  };
  return Array.isArray(value)?value.map((member,index)=>claim('/'+field+'/'+index,member)):[claim('/'+field,value)];
 });
 const {sourceRecord:_sourceRecord,criticalTarget:_criticalTarget,...rest}=current;
 const base=assessmentItemSchema.parse({...rest,question:'Independently verify every source-bound proposition in the supplied record projection. Return supported only with an evidence assertion for every claimId; otherwise abstain or mark unresolved.',
  claim:canonicalJson({version:'r1-record-propositions-v1',recordId:record.id,projectionSha256:semanticHash(projection),sources:sourceProjection,propositions}),
  claimIds:propositions.map(proposition=>proposition.claimId),entityIds:[...new Set([record.id,...record.entities.map(entity=>entity.entityId)])],constraints:[],criticalKinds:current.sources.some(source=>source.ocrSuspected)?['ocr']:[]});
 return criticalKnowledgeTarget(record)?prepareCriticalAssessment(record,base):base;
}
