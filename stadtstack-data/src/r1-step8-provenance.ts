import {constants} from 'node:fs';
import {open,lstat,realpath,readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {fork,type ChildProcess} from 'node:child_process';
import {isMainThread,parentPort} from 'node:worker_threads';
import {Pool,type PoolConfig} from 'pg';
import {z} from 'zod';
import {parse as parseConnectionString} from 'pg-connection-string';
import {userInfo,tmpdir} from 'node:os';
import type {TextRunContribution} from './text-run-lineage.ts';
import type {CivicPolicyOptions} from './civic-opt-out.ts';
import type {PrivatePublicationProvenance,AuthenticatedPublicationProvenance} from './district-publication-provenance.ts';
import {CanonicalWorkerProgressSchema,CanonicalWorkerDiagnosticSchema,canonicalWorkerDiagnostic,formatCanonicalWorkerDiagnostic,type CanonicalWorkerProgress} from './r1-step8-worker-diagnostics.ts';

const Hash=z.string().regex(/^[a-f0-9]{64}$/),MAX_BYTES=128*1024*1024;
export const NativeProvenancePinSchema=z.object({path:z.string().refine(path=>isAbsolute(path)&&resolve(path)===path),sha256:Hash,bytes:z.number().int().nonnegative().max(MAX_BYTES).optional()}).strict();
export const NativeSealSelectionSchema=z.object({schemaVersion:z.literal('stadtstack-r1-native-seal-selection-v1'),catalogue:NativeProvenancePinSchema,seals:z.array(z.object({municipalityId:z.string().min(1),sourceId:z.string().min(1),corpus:NativeProvenancePinSchema,output:NativeProvenancePinSchema,admission:z.enum(['published','adoption_candidate']),queue:z.unknown()}).strict()).min(1).max(256)}).strict();
export const NativeSealSelectionActionSchema=z.object({schemaVersion:z.literal('stadtstack-r1-operator-action-record-v1'),id:z.string().min(1),action:z.literal('select-governed-native-seals'),issuedBy:z.string().min(1),issuedAt:z.iso.datetime(),expiresAt:z.iso.datetime(),parentApproval:z.object({id:z.string().min(1),sha256:Hash}).strict(),catalogue:NativeProvenancePinSchema,selection:NativeProvenancePinSchema,evidence:NativeProvenancePinSchema,collector:NativeProvenancePinSchema,rule:z.object({generationPrecedenceNewestFirst:z.array(z.string().regex(/^[a-f0-9]{40}$/)).min(1),withinGeneration:z.literal('latest successful closed finishedAt; ties refuse'),publishedSourcesExcluded:z.array(z.string()),candidateSource:z.string().nullable(),order:z.literal('sourceId ascending')}).strict(),bounds:z.object({maxFreshSeals:z.literal(0),maxCoreCommands:z.literal(0),maxModelCalls:z.literal(0),maxExecutorRuns:z.literal(0),paidMicroUsd:z.literal(0)}).strict(),reason:z.string().min(1)}).strict();
export const ProvenanceSupplementPinSchema=z.object({inventory:NativeProvenancePinSchema,attestation:NativeProvenancePinSchema}).strict();
export const ProvenanceSupplementSelectionSchema=ProvenanceSupplementPinSchema.extend({targets:z.array(Hash).min(1).max(32)}).strict();
const EvidenceSchema=z.object({nativeOutput:NativeProvenancePinSchema,nativeProvenance:NativeProvenancePinSchema,targets:z.array(Hash).min(1).max(32)}).strict();
export type NativeProvenancePin=z.infer<typeof NativeProvenancePinSchema>;
export type SupplementEvidence=z.infer<typeof EvidenceSchema>;
export type SupplementSelection=z.infer<typeof ProvenanceSupplementSelectionSchema>;
export const WITNESSED_PROVENANCE_CORE_DEPENDENCIES=['src/civic-opt-out.ts','src/district-publication-provenance.ts','src/district-adapter-contract.ts','src/r1-step8-managed-read-view.ts','src/district-queue-text-run.ts','src/district-registry-config.ts','src/district-cas.ts','src/district-step-receipt.ts','src/r1-step8-governance.ts','src/district-r1-text-composition.ts','src/district-policy-receipt.ts','src/district-corpus.ts'] as const;
const defaultCoreRoot=fileURLToPath(new URL('../',import.meta.url));
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const metadata=(path:string)=>lstat(path,{bigint:true});
const stamp=(stat:Awaited<ReturnType<typeof metadata>>)=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs,stat.mode,stat.uid,stat.nlink].join(':');
async function loadCore(root:string){
 const [civic,provenance,adapter,audit,queue,registry,cas,receipt,governance,composition,policyReceipt,corpus]=await Promise.all(WITNESSED_PROVENANCE_CORE_DEPENDENCIES.map(file=>import(pathToFileURL(join(root,file)).href)));
 return {civic:civic as typeof import('./civic-opt-out.ts'),provenance:provenance as typeof import('./district-publication-provenance.ts'),adapter:adapter as typeof import('./district-adapter-contract.ts'),audit:audit as typeof import('./r1-step8-managed-read-view.ts'),queue:queue as typeof import('./district-queue-text-run.ts'),registry:registry as typeof import('./district-registry-config.ts'),cas:cas as typeof import('./district-cas.ts'),receipt:receipt as typeof import('./district-step-receipt.ts'),governance:governance as typeof import('./r1-step8-governance.ts'),composition:composition as typeof import('./district-r1-text-composition.ts'),policyReceipt:policyReceipt as typeof import('./district-policy-receipt.ts'),corpus:corpus as typeof import('./district-corpus.ts')};
}
type Core=Awaited<ReturnType<typeof loadCore>>;
type CanonicalStep=Awaited<ReturnType<Core['queue']['buildQueueTextRun']>>['steps'][number];
type Selection=z.infer<typeof NativeSealSelectionSchema>;
/** Publication requires the complete live catalogue. Adoption is a separate
 * ordinary native-seal acceptance path, never a reconstruction mode. */
export function assertProductionNativeSealCohort(selection:Selection,rawCatalogue:unknown){
 const catalogue=z.object({rows:z.array(z.object({scope:z.object({municipalityId:z.string().min(1),sourceId:z.string().min(1)}).passthrough()}).passthrough())}).passthrough().parse(rawCatalogue);
 const identity=(source:{municipalityId:string;sourceId:string})=>JSON.stringify([source.municipalityId,source.sourceId]),expected=catalogue.rows.map(row=>identity(row.scope)).sort(),actual=selection.seals.map(identity).sort();
 if(expected.length!==27||actual.length!==27||new Set(expected).size!==27||new Set(actual).size!==27||JSON.stringify(expected)!==JSON.stringify(actual))throw Error('Production native seal selection must equal the complete 27-source live catalogue exactly once');
 if(selection.seals.some(seal=>seal.admission!=='published'))throw Error('Production step8 requires all 27 published');
}
type CanonicalRun=Awaited<ReturnType<Core['queue']['buildQueueTextRun']>>;
type CanonicalExport={contribution:TextRunContribution;stepReceipts:CanonicalRun['committed']['receipts'];results:CanonicalRun['committed']['results'];terminalDocumentExceptions:CanonicalRun['terminalDocumentExceptions'];terminalAssessmentExceptions:CanonicalRun['terminalAssessmentExceptions'];assessmentItemHolds:CanonicalRun['assessmentItemHolds']};
type PolicyCheck={receipt:import('./district-policy-receipt.ts').PolicyReceipt;current:import('./district-policy-receipt.ts').PolicyReceipt};
type NativeRecord={output:NativeProvenancePin;provenance:NativeProvenancePin;inventory:PrivatePublicationProvenance;identity:unknown;exported:CanonicalExport;policyChecks:PolicyCheck[]};
type FileRecord={bytes:Buffer;stamp:string};
export const ReconstructionWorkersSchema=z.number().int().min(1).max(3).default(3);
export const ReconstructionTimingSchema=z.object({estimatedDurationSeconds:z.number().int().min(1).max(7*86400),expiryMarginSeconds:z.number().int().min(60).max(86400)}).strict().default({estimatedDurationSeconds:43200,expiryMarginSeconds:3600});
export function reconstructionPolicyHorizon(raw:z.input<typeof ReconstructionTimingSchema>,startedAt=Date.now()){
 const timing=ReconstructionTimingSchema.parse(raw);return startedAt+1000*(timing.estimatedDurationSeconds+timing.expiryMarginSeconds);
}
export function assertReconstructionPolicyExpiry(expiresAt:string,requiredThrough:number){
 if(!Number.isFinite(requiredThrough)||Date.parse(z.iso.datetime().parse(expiresAt))<=requiredThrough)throw Error('Pinned policy proof expires before estimated reconstruction end plus margin; require a re-issued selection with genuine refreshed/re-sealed proofs');
}
type NativeImportDisposition={kind:'import_rejection';municipalityId:string;sourceId:string;corpusSha256:string;documentId:string;sourceSha256:string;sealResult:NativeProvenancePin;processed:false;admittedRecordIds:never[]};
export function assertReconstructionMemory(workers:number,meminfo:string){
 const count=ReconstructionWorkersSchema.parse(workers),match=/^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
 if(!match)throw Error('Reconstruction requires Linux MemAvailable');
 const available=Number(match[1])*1024,required=count*1.5*1024**3+4*1024**3;
 if(!Number.isSafeInteger(available)||available<required)throw Error(`Reconstruction memory refused: MemAvailable ${available} < ${required} bytes for ${count} workers`);
 return {workers:count,availableBytes:available,requiredBytes:required};
}
export interface WitnessedProvenanceContext {readonly witnesses:number;readonly reconstructionWorkers:number;checkpoint():Promise<void>;finish():Promise<void>}
type ContextOptions={pool:Pool;casRoot:string;catalogue:NativeProvenancePin;mode:'step8';coreRoot?:string;workers?:number;timing?:z.input<typeof ReconstructionTimingSchema>;importDispositionDecision?:NativeProvenancePin};
interface ContextState {
 core:Core;coreRoot:string;casRoot:string;policy:CivicPolicyOptions;selection:Selection;selectionPin:NativeProvenancePin;issuancePin:NativeProvenancePin;issuance:z.infer<typeof NativeSealSelectionActionSchema>;native:Map<string,NativeRecord>;files:Map<string,FileRecord>;db:Pool;steps:Map<string,CanonicalStep>;controls?:string;importDispositions:NativeImportDisposition[];importDispositionDecision?:NativeProvenancePin;importDecisionWindow?:{issuedAt:string;expiresAt:string};
 fence:Awaited<ReturnType<Core['audit']['createReadOnlyManagedSourceAudit']>>;inventoryPin:NativeProvenancePin;inventoryStamp:string;finished:boolean;epochAccepted:boolean;
}
const contexts=new WeakMap<WitnessedProvenanceContext,ContextState>();
const acceptedEpochs=new WeakSet<WitnessedProvenanceContext>();
const pinKey=(pin:NativeProvenancePin)=>JSON.stringify([pin.path,pin.sha256]);
/** Only scalar, explicit Unix-socket settings cross into the independent pool.
 * pg-connection-string uses an empty string for an omitted URL port. */
export function createCanonicalWitnessReadPool(configuration:PoolConfig){
 const parsed:Partial<ReturnType<typeof parseConnectionString>>=configuration.connectionString?parseConnectionString(configuration.connectionString):{};
 const connection=z.object({host:z.string().refine(isAbsolute),database:z.string().min(1),user:z.string().min(1),port:z.coerce.number().int().min(1).max(65535)}).parse({host:parsed.host??configuration.host,database:parsed.database??configuration.database,user:parsed.user||configuration.user||userInfo().username,port:parsed.port||(configuration.port??5432)});
 if(parsed.password||configuration.password)throw Error('Canonical native witnesses require local peer/trust authentication without credentials');
 return new Pool({...connection,max:1,min:0,connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:10000,options:'-c default_transaction_read_only=on',application_name:'r1-native-seal-selection-readonly',password:async()=>{throw Error('Canonical witness password authentication prohibited');}});
}
function state(context:WitnessedProvenanceContext){const value=contexts.get(context);if(!value||value.finished)throw Error('Native provenance context unavailable or finished');return value;}
async function readPrivate(pin:NativeProvenancePin,files:Map<string,FileRecord>,maxBytes=MAX_BYTES,publicControl=false){
 const actual=NativeProvenancePinSchema.parse(pin),before=await metadata(actual.path),cached=files.get(pinKey(actual));
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.uid!==BigInt(process.getuid!())||(before.mode&(publicControl?0o022n:0o077n))!==0n||before.size>BigInt(maxBytes)||await realpath(actual.path)!==actual.path)throw Error('Unsafe native provenance control');
 if(cached){if(stamp(before)!==cached.stamp||actual.bytes!==undefined&&actual.bytes!==cached.bytes.length)throw Error('Native provenance witness changed');return cached.bytes;}
 const handle=await open(actual.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const opened=await handle.stat({bigint:true}),bytes=await handle.readFile(),after=await handle.stat({bigint:true});if(stamp(before)!==stamp(opened)||stamp(opened)!==stamp(after)||bytes.length!==Number(after.size)||actual.bytes!==undefined&&actual.bytes!==bytes.length||digest(bytes)!==actual.sha256)throw Error('Native provenance control pin mismatch');files.set(pinKey(actual),{bytes,stamp:stamp(after)});return bytes;}finally{await handle.close();}
}
function equal(value:ContextState,left:unknown,right:unknown,message:string){if(value.core.adapter.canonicalJson(left)!==value.core.adapter.canonicalJson(right))throw Error(message);}
function assertIssued(issuance:{issuedAt:string;expiresAt:string},label='Native seal selection'){const now=Date.now();if(Date.parse(issuance.issuedAt)>now||Date.parse(issuance.expiresAt)<=now||Date.parse(issuance.expiresAt)<=Date.parse(issuance.issuedAt))throw Error(label+' is unissued, future-issued or expired');}
async function assertCurrent(value:ContextState){
 if(value.finished)throw Error('Native provenance context finished');
 await value.core.civic.assertCivicPolicyAuthority(value.policy);
 if(stamp(await metadata(value.inventoryPin.path))!==value.inventoryStamp)throw Error('Native provenance inventory epoch changed');
 assertIssued(value.issuance);assertPolicyClocks(value);
 if(value.importDecisionWindow)assertIssued(value.importDecisionWindow,'Import disposition decision');
 if((await value.core.civic.readCivicOptOutSnapshot(value.policy)).sha256!==value.fence.optOutSnapshotSha256)throw Error('Native provenance objection epoch changed');
 for(const [key,file] of value.files){const path=JSON.parse(key)[0] as string;if(stamp(await metadata(path))!==file.stamp||await realpath(path)!==path)throw Error('Native provenance witness changed');}
 // One fresh SQL snapshot, not the historical snapshot used to rebuild a seal.
 // Receipt bodies and specs are checked too: a stored digest alone is not proof.
 if(value.steps.size){const rows=(await value.db.query('SELECT j.job_key,j.spec,j.state,j.attempt,r.id,r.receipt,r.receipt_sha256 FROM district_pipeline.jobs j JOIN district_pipeline.step_receipts r ON r.id = ANY($2::uuid[]) AND r.receipt->>\'jobKey\'=j.job_key WHERE j.job_key = ANY($1::text[])',[[...value.steps.keys()],[...value.steps.values()].map(step=>step.receipt.id)])).rows;
  if(rows.length!==value.steps.size)throw Error('Native seal canonical receipt set changed');
  for(const row of rows){const expected=value.steps.get(row.job_key);if(!expected||row.id!==expected.receipt.id||row.receipt_sha256!==expected.sha256||value.core.receipt.encodeStepReceipt(row.receipt).sha256!==expected.sha256||row.attempt!==expected.receipt.attempt||row.state!==expected.receipt.outcome)throw Error('Native seal canonical receipt state changed');equal(value,row.spec,expected.spec,'Native seal canonical job spec changed');}
 }
}
function nativeRecord(value:ContextState,output:NativeProvenancePin,provenance?:NativeProvenancePin){const native=value.native.get(pinKey(output));if(!native||output.bytes!==undefined&&output.bytes!==native.output.bytes)throw Error('Native output is not in the exact governed seal selection');if(provenance&&(pinKey(native.provenance)!==pinKey(provenance)||provenance.bytes!==undefined&&provenance.bytes!==native.provenance.bytes))throw Error('Native witness provenance pin differs');return native;}
async function canonicalSeal(value:ContextState,selected:Selection['seals'][number],cas:InstanceType<Core['cas']['DistrictCas']>){
 const {core}=value,raw=await readPrivate(selected.output,value.files),output=z.object({runId:Hash,compositionArtifactSha256:Hash,path:z.string(),privateProvenance:NativeProvenancePinSchema.extend({bytes:z.number().int().nonnegative(),bindings:z.array(z.unknown()).min(1)}),artifacts:z.record(z.string(),NativeProvenancePinSchema),criticalInventory:z.unknown(),criticalAdmissions:z.unknown(),policyInventory:z.unknown()}).passthrough().parse(JSON.parse(raw.toString('utf8')));
 const queue=core.queue.QueueTextSealInputSchema.parse(selected.queue),run=JSON.parse((await cas.read(output.runId)).toString('utf8'));
 const recorded=z.object({extractionAttemptHistory:z.array(z.unknown()).optional(),terminalAssessmentExceptions:z.array(z.object({jobKey:Hash,preparation:z.object({jobKey:Hash,receiptId:z.uuid(),receiptSha256:Hash}).optional()}).passthrough()).default([]),stepReceipts:z.array(z.object({spec:z.object({step:z.string()}),receipt:z.object({jobKey:Hash,id:z.uuid()}),sha256:Hash}))}).passthrough().parse(run.queue);
 const preparationPins=recorded.stepReceipts.filter(step=>step.spec.step==='assessment_prepare').map(step=>({jobKey:step.receipt.jobKey,receiptId:step.receipt.id,receiptSha256:step.sha256}));
 const built=await core.queue.buildQueueTextRun(value.db,cas,queue,{extractionAttemptHistory:recorded.extractionAttemptHistory!==undefined,terminalAssessmentHistory:{preparationPins,recordedPins:new Map(recorded.terminalAssessmentExceptions.flatMap(pin=>pin.preparation?[[pin.jobKey,pin.preparation] as const]:[]))}});
 if(built.contribution.runId!==output.runId||built.contribution.pins.corpusSha256!==selected.corpus.sha256)throw Error('Native seal differs from canonical queue run or governed corpus');
 for(const source of built.originals)if(source.municipality.id!==selected.municipalityId||source.document.sourceId!==selected.sourceId)throw Error('Native seal canonical source scope differs from selection');
 const catalogue=z.object({rows:z.array(z.object({scope:z.object({municipalityId:z.string(),sourceId:z.string()}).passthrough(),index:NativeProvenancePinSchema,originals:z.array(z.object({documentId:z.string(),sha256:Hash}).passthrough())}).passthrough()).min(1)}).passthrough().parse(JSON.parse((await readPrivate(value.selection.catalogue,value.files)).toString('utf8')));
 const rows=catalogue.rows.filter(row=>row.scope.municipalityId===selected.municipalityId&&row.scope.sourceId===selected.sourceId);if(rows.length!==1)throw Error('Native selection source is absent or duplicated in governed catalogue');
 equal(value,{path:selected.corpus.path,sha256:selected.corpus.sha256},rows[0].index,'Native selection corpus differs from governed catalogue');
 const documents=(entries:{documentId:string;sha256:string}[])=>entries.map(entry=>[entry.documentId,entry.sha256]).sort((a,b)=>a[0].localeCompare(b[0]));
 const rejected=value.importDispositions.filter(disposition=>disposition.municipalityId===selected.municipalityId&&disposition.sourceId===selected.sourceId&&disposition.corpusSha256===selected.corpus.sha256&&pinKey(disposition.sealResult)===pinKey(selected.output)),excluded=new Set<string>();
 for(const disposition of rejected){
  if(!rows[0].originals.some(original=>original.documentId===disposition.documentId&&original.sha256===disposition.sourceSha256)||built.originals.some(original=>original.document.id===disposition.documentId&&original.document.sha256===disposition.sourceSha256))throw Error('Import rejection differs from catalogue or names a processed native original');
  const key=JSON.stringify([disposition.documentId,disposition.sourceSha256]);if(excluded.has(key))throw Error('Duplicate native import rejection');excluded.add(key);
 }
 equal(value,documents(built.originals.map(source=>({documentId:source.document.id,sha256:source.document.sha256}))),documents(rows[0].originals.filter(original=>!excluded.has(JSON.stringify([original.documentId,original.sha256])))),'Native selection document cohort differs from governed catalogue');
 await value.fence.read(selected.corpus.path,selected.corpus.sha256);
 const bindings=[...new Map(built.originals.map(source=>{const binding={...source.sourceBinding,independentAllowed:true};return [core.adapter.canonicalJson(binding),binding] as const;})).values()];
 const pin=(bytes:Uint8Array|string,sha256=digest(typeof bytes==='string'?Buffer.from(bytes):bytes),declared:PrivatePublicationProvenance['inputs'][number]['bindings']=bindings)=>({path:join(cas.root,'sha256',sha256.slice(0,2),sha256),sha256,bytes:typeof bytes==='string'?Buffer.byteLength(bytes):bytes.byteLength,bindings:declared});
 const artifact=(data:unknown)=>pin(Buffer.from(core.adapter.canonicalJson(data)));
 const pins:PrivatePublicationProvenance['inputs']=[],artifacts:Record<string,{path:string;sha256:string}>={};
 for(const key of ['extractionRun','records','quarantine','preparationPlan'] as const){const original=built.contribution.artifacts[key];if(!original)throw Error('Canonical native seal artifact absent');const expected=pin(original.bytes,original.sha256);pins.push(expected);artifacts[key]={path:expected.path,sha256:expected.sha256};}
 const admitted=await core.registry.readOperatorRegistryInputPin(built.first.registry,built.policy),migration=built.first.crawlRegistry?await core.registry.readCrawlOperatorRegistryInputPin(built.first.crawlRegistry,built.first.registry,built.policy):undefined;
 for(const key of ['crawl','registry'] as const){const original=built.contribution.artifacts[key],all=key==='registry'?admitted.bindings:[...admitted.bindings,...migration?.crawl.bindings??[],...built.first.corpusObservations],expected=pin(original.bytes,original.sha256,all.map(binding=>({...binding,independentAllowed:false})));pins.push(expected);artifacts[key]={path:expected.path,sha256:expected.sha256};}
 const composition=core.composition.r1TextCompositionInputSchema.parse({schemaVersion:'district-r1-text-composition-input-v1',generatedAt:built.knowledge.generatedAt,approvedRunOrder:[built.contribution.runId],admissions:[{runId:built.contribution.runId,recordIds:built.knowledge.records.map(record=>record.id)}],contributions:[{runId:built.contribution.runId,pins:built.contribution.pins,sourceArtifactKind:'native_extraction_output',artifacts}]});
 const compositionPin=artifact(composition),criticalInventory=artifact(built.criticalInventory),criticalAdmissions=artifact(built.criticalAdmissions),policyInventory=artifact(built.policyInventory);pins.push(compositionPin,criticalInventory,policyInventory,criticalAdmissions);
 const inventory=core.provenance.privatePublicationProvenanceSchema.parse({schemaVersion:'stadtstack-private-publication-provenance-v1',inputs:pins}),provenance=artifact(inventory);
 equal(value,output.artifacts,artifacts,'Native seal artifacts differ from canonical producer');
 for(const [name,expected] of Object.entries({criticalInventory,criticalAdmissions,policyInventory,privateProvenance:provenance}))equal(value,output[name],expected,'Native seal '+name+' differs from canonical producer');
 if(output.compositionArtifactSha256!==compositionPin.sha256||output.path!==compositionPin.path)throw Error('Native seal composition differs from canonical producer');
 equal(value,output,{runId:built.contribution.runId,compositionArtifactSha256:compositionPin.sha256,path:compositionPin.path,artifacts,criticalInventory,criticalAdmissions,policyInventory,privateProvenance:provenance,records:built.knowledge.records.length,heldRecords:built.heldRecords,committedDocuments:built.originals.length,...(built.attemptHistory?{attemptHistory:built.attemptHistory}:{}),terminalDocumentExceptions:built.terminalDocumentExceptions,terminalAssessmentExceptions:built.terminalAssessmentExceptions,assessmentItemHolds:built.assessmentItemHolds},'Native seal output differs from canonical producer');
 const provenancePin={path:provenance.path,sha256:provenance.sha256,bytes:provenance.bytes},bytes=await readPrivate(provenancePin,value.files);if(!bytes.equals(Buffer.from(core.adapter.canonicalJson(inventory))))throw Error('Native seal provenance differs from canonical producer');
 await core.civic.assertManagedSourceBindings(provenance.path,bindings,value.policy);await value.fence.read(provenance.path,provenance.sha256);
 const currentKeys=new Set([...queue.jobKeys,...queue.reconciliationJobKeys,...queue.terminalDocumentExceptions.map(entry=>entry.jobKey),...queue.terminalAssessmentExceptions.map(entry=>entry.jobKey),...queue.assessmentItemHolds.map(entry=>entry.preparationJobKey)]);
 for(const step of built.steps)if(currentKeys.has(step.receipt.jobKey)){const previous=value.steps.get(step.receipt.jobKey);if(previous&&previous.sha256!==step.sha256)throw Error('Selected native seals disagree on canonical receipt');value.steps.set(step.receipt.jobKey,step);}
 for(const key of currentKeys)if(!value.steps.has(key))throw Error('Selected native job has no canonical receipt');
 const policyChecks:PolicyCheck[]=[];
 for(const hash of new Set(built.steps.flatMap(step=>step.spec.policyProofSha256?[step.spec.policyProofSha256]:[]))){
  const receipt=core.policyReceipt.PolicyReceiptSchema.parse(JSON.parse((await cas.read(hash)).toString('utf8'))),currentHash=built.policyInventory.currentAdmissionReceipts?.[hash];
  const current=currentHash?core.policyReceipt.PolicyReceiptSchema.parse(JSON.parse((await cas.read(currentHash)).toString('utf8'))):receipt;
  policyChecks.push({receipt,current});
 }
 const exported:CanonicalExport={contribution:built.contribution,stepReceipts:built.committed.receipts,results:built.committed.results,terminalDocumentExceptions:built.terminalDocumentExceptions,terminalAssessmentExceptions:built.terminalAssessmentExceptions,assessmentItemHolds:built.assessmentItemHolds};
 const result:NativeRecord={output:{...selected.output,bytes:raw.length},provenance:provenancePin,inventory,exported,policyChecks,identity:{municipalityId:selected.municipalityId,sourceId:selected.sourceId,corpus:selected.corpus,admission:selected.admission,queue,output:{...selected.output,bytes:raw.length},provenance:provenancePin,runId:built.contribution.runId,receipts:built.steps.map(step=>({jobKey:step.receipt.jobKey,receiptId:step.receipt.id,receiptSha256:step.sha256}))}};value.native.set(pinKey(selected.output),result);
}
/** Opening a state authenticates the complete issued frame, never a worker shard. */
async function openContextState(selectionPin:NativeProvenancePin,policy:CivicPolicyOptions,options:ContextOptions):Promise<ContextState>{
 const files=new Map<string,FileRecord>(),issuanceBytes=await readPrivate(selectionPin,files,MAX_BYTES,true),issuance=NativeSealSelectionActionSchema.parse(JSON.parse(issuanceBytes.toString('utf8')));assertIssued(issuance);
 const frameBytes=await readPrivate(issuance.selection,files),selection=NativeSealSelectionSchema.parse(JSON.parse(frameBytes.toString('utf8'))),core=await loadCore(resolve(options.coreRoot??defaultCoreRoot));
 if(pinKey(issuance.catalogue)!==pinKey(selection.catalogue))throw Error('Issued native selection catalogue differs from frame');
 await readPrivate(issuance.evidence,files);await readPrivate(issuance.collector,files);
 if(pinKey(selection.catalogue)!==pinKey(options.catalogue))throw Error('Native selection belongs to another governed catalogue');
 const seenSources=new Set<string>(),seenOutputs=new Set<string>();for(const selected of selection.seals){const source=JSON.stringify([selected.municipalityId,selected.sourceId]);if(seenSources.has(source)||seenOutputs.has(pinKey(selected.output)))throw Error('Duplicate native selection source or output');seenSources.add(source);seenOutputs.add(pinKey(selected.output));core.queue.QueueTextSealInputSchema.parse(selected.queue);}
 const authority=await core.civic.assertCivicPolicyAuthority(policy),bound={...policy,stateDir:resolve(policy.stateDir??core.civic.CIVIC_POLICY_STATE_DIR),authorityId:authority.authorityId,authoritySha256:authority.authoritySha256},candidates=selection.seals.filter(seal=>seal.admission==='adoption_candidate').length;
 if(authority.mode!=='isolated-fixture'&&(issuance.parentApproval.id!=='r1-nine-town-models-2026-10-13'||issuance.parentApproval.sha256!=='2ac6267d17ed08452665a0b2de92ec4da89915fe8619b668b85585301327502b'))throw Error('Native selection parent approval differs from frozen campaign');
 if(options.mode!=='step8'||candidates!==0)throw Error('Native selection admission set differs from governed step8 operation');
 if(authority.mode!=='isolated-fixture')assertProductionNativeSealCohort(selection,JSON.parse((await readPrivate(selection.catalogue,files)).toString('utf8')));
 if(options.pool.options.connectionString)core.governance.step8SocketConnection(options.pool.options.connectionString);
 const db=createCanonicalWitnessReadPool(options.pool.options);
 try{
  const fence=await core.audit.createReadOnlyManagedSourceAudit(bound),inventoryPin={path:join(resolve(bound.stateDir??core.civic.CIVIC_POLICY_STATE_DIR),'inventory.json'),sha256:fence.inventorySha256},epochFiles=new Map<string,FileRecord>();await readPrivate(inventoryPin,epochFiles,512*1024*1024);
  const value:ContextState={core,coreRoot:resolve(options.coreRoot??defaultCoreRoot),casRoot:resolve(options.casRoot),policy:bound,selection,selectionPin:{...issuance.selection,bytes:frameBytes.length},issuancePin:{...selectionPin,bytes:issuanceBytes.length},issuance,native:new Map(),files,db,steps:new Map(),fence,inventoryPin,inventoryStamp:epochFiles.get(pinKey(inventoryPin))!.stamp,finished:false,epochAccepted:false,importDispositions:[],...(options.importDispositionDecision?{importDispositionDecision:{...options.importDispositionDecision}}:{})};
  if(options.importDispositionDecision){
   const [helper,contract]=await Promise.all(['src/r1-step8-import-dispositions.ts','src/r1-step8-import-disposition-contract.ts'].map(file=>import(pathToFileURL(join(value.coreRoot,file)).href)));
   value.importDispositions=contract.ImportRejectionDispositionSchema.array().parse(await helper.authenticateImportDispositions({decision:options.importDispositionDecision,nativeSealSelection:value.issuancePin,catalogue:selection.catalogue,seals:selection.seals.map(seal=>({sealResult:seal.output})),policy:bound,
    control:(pin:NativeProvenancePin)=>readPrivate(pin,files,MAX_BYTES,pin.path===options.importDispositionDecision!.path||pin.path===value.issuancePin.path),
    managed:(pin:NativeProvenancePin)=>fence.read(pin.path,pin.sha256)}));
   const decision=contract.ImportDispositionDecisionSchema.parse(JSON.parse((await readPrivate(options.importDispositionDecision,files,MAX_BYTES,true)).toString('utf8')));value.importDecisionWindow={issuedAt:decision.issuedAt,expiresAt:decision.expiresAt};
   for(const disposition of value.importDispositions)if(!selection.seals.some(seal=>seal.municipalityId===disposition.municipalityId&&seal.sourceId===disposition.sourceId&&seal.corpus.sha256===disposition.corpusSha256&&pinKey(seal.output)===pinKey(disposition.sealResult)))throw Error('Import disposition lies outside the issued native frame');
  }
  return value;
 }catch(error){await db.end();throw error;}
}
/** This preflight can only refuse: native producer authentication still follows.
 * Read the exact pinned current continuations, never replace a proof from a
 * mutable latest-proof lookup or renew it here. */
async function preflightPolicyHorizon(value:ContextState,requiredThrough:number){
 await assertCurrent(value);
 const {core}=value,cas={read:(hash:string)=>value.fence.read(join(value.casRoot,'sha256',hash.slice(0,2),hash),hash)},proofs=new Map<string,import('./district-policy-receipt.ts').PolicyReceipt>(),checked=new Set<string>();
 const proof=async(hash:string)=>{let result=proofs.get(hash);if(!result){result=await core.policyReceipt.loadPolicyReceipt(cas,hash);proofs.set(hash,result);}return result;};
 const sourcePin=z.object({path:z.string().refine(isAbsolute),sha256:Hash,bytes:z.number().int().nonnegative().optional()}).passthrough();
 const policySchema=z.object({currentAdmissionReceipts:z.record(Hash,Hash).default({}),records:z.array(z.object({receipts:z.array(z.object({receiptSha256:Hash,currentReceiptSha256:Hash.optional()}).passthrough())}).passthrough())}).passthrough();
 for(const selected of value.selection.seals){
  const output=z.object({runId:Hash,policyInventory:sourcePin}).passthrough().parse(JSON.parse((await readPrivate(selected.output,value.files)).toString('utf8')));
  const recorded=z.object({queue:z.object({stepReceipts:z.array(z.object({spec:z.object({policyProofSha256:Hash.nullable().optional()}).passthrough()}).passthrough())}).passthrough()}).passthrough().parse(JSON.parse((await cas.read(output.runId)).toString('utf8')));
  const policy=policySchema.parse(JSON.parse((await value.fence.read(output.policyInventory.path,output.policyInventory.sha256)).toString('utf8'))),hashes=new Set<string>(Object.keys(policy.currentAdmissionReceipts));
  for(const step of recorded.queue.stepReceipts)if(step.spec.policyProofSha256)hashes.add(step.spec.policyProofSha256);
  for(const record of policy.records)for(const receipt of record.receipts){
   hashes.add(receipt.receiptSha256);
   if(receipt.currentReceiptSha256&&policy.currentAdmissionReceipts[receipt.receiptSha256]!==receipt.currentReceiptSha256)throw Error('Pinned policy inventory current-proof mapping conflicts');
  }
  for(const hash of hashes){
   const currentHash=policy.currentAdmissionReceipts[hash]??hash,key=hash+':'+currentHash;if(checked.has(key))continue;
   const original=await proof(hash),current=await proof(currentHash);
   await core.policyReceipt.recheckPolicyReceipt(original,{...value.policy,evaluationAt:new Date().toISOString(),currentProof:current});
   try{assertReconstructionPolicyExpiry(current.expiresAt,requiredThrough);}catch(error){throw Error(`${selected.municipalityId}/${selected.sourceId}: policy ${currentHash} expires ${current.expiresAt}; required through ${new Date(requiredThrough).toISOString()}: ${(error as Error).message}`);}
   checked.add(key);
  }
 }
 await assertCurrent(value);
}
function epochIdentity(value:ContextState){return JSON.stringify([value.policy.authorityId,value.policy.authoritySha256,value.inventoryPin.sha256,value.inventoryStamp,value.fence.optOutSnapshotSha256]);}
function assertPolicyClocks(value:ContextState){
 const now=Date.now();for(const native of value.native.values())for(const check of native.policyChecks)if(now<Date.parse(check.current.checkedAt)||now>=Date.parse(check.current.expiresAt))throw Error('Canonical source policy receipt expired; source revalidation required');
}
async function checkpoint(value:ContextState){
 await assertCurrent(value);assertPolicyClocks(value);
 const seen=new Set<string>();
 for(const native of value.native.values())for(const {receipt,current} of native.policyChecks){
  const key=value.core.adapter.canonicalJson([receipt,current]);if(seen.has(key))continue;seen.add(key);
  await value.core.policyReceipt.recheckPolicyReceipt(receipt,{...value.policy,evaluationAt:new Date().toISOString(),currentProof:current});
 }
 await assertCurrent(value);
}
async function reconstruct(value:ContextState,indices:readonly number[],report?:(index:number,phase:'source-started'|'source-completed')=>void){
 const {core}=value;
 class ReadOnlyCas extends core.cas.DistrictCas {
  override async read(hash:string){core.adapter.HashSchema.parse(hash);return value.fence.read(join(this.root,'sha256',hash.slice(0,2),hash),hash);}
  override async put():Promise<never>{throw Error('Canonical witness CAS is read-only');}
 }
 const cas=new ReadOnlyCas(value.casRoot);
 for(const index of indices){
  report?.(index,'source-started');
  // Hold a real checked-out client throughout reconstruction. Pool.query(BEGIN)
  // alone releases it to the idle reaper and cannot guarantee a transaction.
  const client=await value.db.connect(),query=value.db.query,connect=value.db.connect;
  try{
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const transaction=(await client.query("SELECT current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation")).rows[0];
   if(transaction.read_only!=='on'||transaction.isolation!=='repeatable read')throw Error('Canonical reconstruction requires an actual READ ONLY repeatable-read client');
   Object.defineProperty(value.db,'query',{value:client.query.bind(client),configurable:true,writable:true});
   Object.defineProperty(value.db,'connect',{value:()=>{throw Error('Nested reconstruction client checkout prohibited');},configurable:true,writable:true});
   const selected=value.selection.seals[index];
   if(value.fence.authority.mode==='isolated-fixture'){
    // Workers cannot inherit AsyncLocalStorage. Only the real isolated authority
    // may reissue this existing Core fixture capability for its exact pinned bytes.
    await core.corpus.withFixtureAuthorizedCorpus(await value.fence.read(selected.corpus.path,selected.corpus.sha256),value.policy,()=>canonicalSeal(value,selected,cas));
   }else await canonicalSeal(value,selected,cas);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{Object.defineProperty(value.db,'query',{value:query,configurable:true,writable:true});Object.defineProperty(value.db,'connect',{value:connect,configurable:true,writable:true});client.release();}
  report?.(index,'source-completed');
 }
}
const WorkerRequestSchema=z.object({
 schemaVersion:z.literal('stadtstack-r1-canonical-worker-v1'),nonce:z.uuid(),
 issuance:NativeProvenancePinSchema,policy:z.object({stateDir:z.string().refine(isAbsolute),authorityId:z.string().min(1),authoritySha256:Hash,lockWaitMs:z.number().int().positive().optional()}).strict(),
 options:z.object({casRoot:z.string().refine(isAbsolute),catalogue:NativeProvenancePinSchema,mode:z.literal('step8'),coreRoot:z.string().refine(isAbsolute),importDispositionDecision:NativeProvenancePinSchema.optional()}).strict(),
 connection:z.object({host:z.string().refine(isAbsolute),database:z.string().min(1),user:z.string().min(1),port:z.number().int().min(1).max(65535)}).strict(),
 indices:z.array(z.number().int().min(0).max(255)).min(1),epoch:z.string().min(1),
}).strict();
type WorkerPacket={nonce:string;epoch:string;native:Array<[number,NativeRecord]>;steps:CanonicalStep[];files:Array<{pin:NativeProvenancePin;stamp:string}>};
/** Only the fixed child's reconstruction thread calls this data-only worker.
 * It never mints a public context or accepts a persisted passed-result cache. */
export async function reconstructCanonicalWorkerRequest(raw:unknown){
 if(isMainThread||!parentPort||process.env.STADTSTACK_STEP8_OFFLINE!=='1')throw Error('Canonical reconstruction requires its offline worker thread');
 const stop=new AbortController(),onClose=()=>stop.abort();parentPort.once('close',onClose);
 let value:ContextState|undefined,carrier:Pool|undefined,nonce='',progress:CanonicalWorkerProgress|undefined,reply:WorkerPacket|{nonce:string;error:string};
 try{
  const request=WorkerRequestSchema.parse(raw);nonce=request.nonce;
  const report=(phase:CanonicalWorkerProgress['phase'],index?:number)=>{progress={schemaVersion:'stadtstack-r1-canonical-progress-v1',nonce,phase,...(index===undefined?{}:{index})};parentPort!.postMessage(progress);};
  report('opening-context');
  carrier=new Pool(request.connection);value=await openContextState(request.issuance,request.policy,{...request.options,pool:carrier});
  const live=value;
  await live.core.civic.withCivicPolicyShutdown(async()=>{
   if(epochIdentity(live)!==request.epoch||new Set(request.indices).size!==request.indices.length||request.indices.some(index=>index>=live.selection.seals.length))throw Error('Canonical worker epoch or selection shard differs');
   await reconstruct(live,request.indices,(index,phase)=>report(phase,index));report('finishing-epoch');await checkpoint(live);await live.fence.finish();
  },stop.signal);
  report('serializing-result');
  reply={nonce,epoch:epochIdentity(live),native:request.indices.map(index=>[index,nativeRecord(live,live.selection.seals[index].output)]),steps:[...live.steps.values()],files:[...live.files].map(([key,file])=>({pin:{path:JSON.parse(key)[0],sha256:digest(file.bytes),bytes:file.bytes.length},stamp:file.stamp}))};
 }catch(error){if(!nonce)throw error;reply={nonce,error:formatCanonicalWorkerDiagnostic(canonicalWorkerDiagnostic(nonce,'canonical-error',progress,error))};}
 finally{if(value){value.finished=true;await value.db.end();}await carrier?.end();parentPort.removeListener('close',onClose);}
 return reply;
}
async function reconstructParallel(value:ContextState,options:ContextOptions,workers:number){
 const children:ChildProcess[]=[],jobs:Array<Promise<WorkerPacket>>=[],nonce=randomUUID(),epoch=epochIdentity(value),entry=fileURLToPath(new URL('./r1-step8-reconstruction-worker.ts',import.meta.url));
 let launchError:unknown,firstFailure:Error|undefined,stopping=false;
 const abort=()=>{stopping=true;for(const child of children)if(child.connected)child.send({stop:true},()=>{});};
 try{
  for(let worker=0;worker<Math.min(workers,value.selection.seals.length);worker++){
   const indices=value.selection.seals.flatMap((_seal,index)=>index%workers===worker?[index]:[]),db=value.db.options;
   const child=fork(entry,[],{execPath:process.execPath,execArgv:['--experimental-strip-types','--max-old-space-size=1024','--require',fileURLToPath(new URL('../scripts/r1-step8-offline.cjs',import.meta.url))],serialization:'advanced',stdio:['ignore','ignore','inherit','ipc'],env:{...process.env,NODE_OPTIONS:''}});children.push(child);
   jobs.push(new Promise<WorkerPacket>((accept,reject)=>{
    let packet:WorkerPacket|undefined,failure:Error|undefined,progress:CanonicalWorkerProgress|undefined;
    const label=()=>`worker=${worker} pid=${child.pid??'unavailable'} shard=${indices.join(',')} phase=${progress?.phase??'not-reported'} sourceIndex=${progress?.index??'none'}`;
    const failed=(error:Error)=>{failure??=error;if(!stopping&&!firstFailure)firstFailure=error;abort();};
    child.on('message',(message:unknown)=>{
     if(failure)return;
     const candidate=message as WorkerPacket&{error?:string};
     if(!candidate||typeof candidate!=='object'||candidate.nonce!==nonce){failed(new Error(`${label()}: Canonical worker IPC identity rejected`));return;}
     const event=CanonicalWorkerProgressSchema.safeParse(message);
     if(event.success){
      if(packet||event.data.index!==undefined&&!indices.includes(event.data.index)){failed(new Error(`${label()}: Canonical worker progress shard/cardinality rejected`));return;}
      progress=event.data;const selected=progress.index===undefined?undefined:value.selection.seals[progress.index],safeId=(id:string)=>/^[a-z0-9-]{1,80}$/.test(id);
      process.stderr.write('R1_CANONICAL_PROGRESS '+JSON.stringify({worker,pid:child.pid,shard:indices,...event.data,...(selected&&safeId(selected.municipalityId)&&safeId(selected.sourceId)?{municipalityId:selected.municipalityId,sourceId:selected.sourceId}:{})})+'\n');return;
     }
     const diagnostic=CanonicalWorkerDiagnosticSchema.safeParse(message);
     if(diagnostic.success){if(diagnostic.data.index!==undefined&&!indices.includes(diagnostic.data.index)){failed(new Error(`${label()}: Canonical worker diagnostic shard rejected`));return;}failed(new Error(`${label()}: ${formatCanonicalWorkerDiagnostic(diagnostic.data)}`));return;}
     if(packet){failed(new Error(`${label()}: Canonical worker result cardinality rejected`));return;}
     if(candidate.error!==undefined){failed(new Error(`${label()}: ${candidate.error}`));return;}
     if(candidate.epoch!==epoch||!Array.isArray(candidate.native)||candidate.native.length!==indices.length||candidate.native.some(([index],offset)=>index!==indices[offset])){failed(new Error(`${label()}: Canonical worker returned another epoch or ordered shard`));return;}
     packet=candidate;
    });
    child.on('error',error=>failed(new Error(`${label()}: ${formatCanonicalWorkerDiagnostic(canonicalWorkerDiagnostic(nonce,'ipc-send-failed',progress,error))}`)));
    child.once('close',(code,signal)=>{if(failure||code!==0||signal||!packet){const error=failure??new Error(`${label()}: Canonical worker exited without a complete result (${code}/${signal})`);if(!failure)failed(error);reject(error);}else accept(packet);});
    child.send({schemaVersion:'stadtstack-r1-canonical-worker-v1',nonce,issuance:value.issuancePin,policy:value.policy,options:{casRoot:value.casRoot,catalogue:options.catalogue,mode:options.mode,coreRoot:value.coreRoot,...(options.importDispositionDecision?{importDispositionDecision:options.importDispositionDecision}:{})},connection:{host:db.host,database:db.database,user:db.user,port:db.port},indices,epoch},error=>{if(error)failed(new Error(`${label()}: ${formatCanonicalWorkerDiagnostic(canonicalWorkerDiagnostic(nonce,'ipc-send-failed',progress,error))}`));});
   }));
  }
 }catch(error){launchError=error;abort();}
 const settled=await Promise.allSettled(jobs);
 if(launchError)throw launchError;
 if(firstFailure)throw firstFailure;
 const rejected=settled.find(result=>result.status==='rejected');if(rejected?.status==='rejected')throw rejected.reason;
 const packets=settled.map(result=>(result as PromiseFulfilledResult<WorkerPacket>).value),ordered=new Map<number,NativeRecord>();
 for(const packet of packets){
  for(const {pin,stamp:captured} of packet.files){await readPrivate(pin,value.files,MAX_BYTES,pin.path===value.issuancePin.path);if(value.files.get(pinKey(pin))!.stamp!==captured)throw Error('Canonical worker control epoch changed');}
  for(const step of packet.steps){const old=value.steps.get(step.receipt.jobKey);if(old)equal(value,old,step,'Canonical workers disagree on receipt');value.steps.set(step.receipt.jobKey,step);}
  for(const [index,native] of packet.native){if(ordered.has(index)||pinKey(native.output)!==pinKey(value.selection.seals[index].output))throw Error('Canonical workers returned conflicting source identities');ordered.set(index,native);}
 }
 if(ordered.size!==value.selection.seals.length)throw Error('Canonical worker cohort incomplete');
 for(let index=0;index<value.selection.seals.length;index++)value.native.set(pinKey(value.selection.seals[index].output),ordered.get(index)!);
}
/** Exactly one canonical producer pass, with one common epoch and current
 * receipt fence. The result set is an opaque in-process capability, not a cache. */
export async function createWitnessedProvenanceContext(selectionPin:NativeProvenancePin,policy:CivicPolicyOptions,options:ContextOptions):Promise<WitnessedProvenanceContext>{
 const requiredThrough=reconstructionPolicyHorizon(options.timing),workers=ReconstructionWorkersSchema.parse(options.workers);assertReconstructionMemory(workers,await readFile('/proc/meminfo','utf8'));
 const value=await openContextState(selectionPin,policy,options);
 try{
  await preflightPolicyHorizon(value,requiredThrough);
  if(workers===1)await reconstruct(value,value.selection.seals.map((_seal,index)=>index));else await reconstructParallel(value,options,workers);
  await checkpoint(value);
  const context:WitnessedProvenanceContext=Object.freeze({witnesses:value.selection.seals.length,reconstructionWorkers:workers,async checkpoint(){await checkpoint(state(context));},async finish(){
   const live=state(context);try{await checkpoint(live);await live.fence.finish();live.epochAccepted=true;}
   finally{
    live.finished=true;contexts.delete(context);
    try{await live.db.end();}finally{if(live.controls)await rm(live.controls,{recursive:true,force:true});}
    if(live.epochAccepted)acceptedEpochs.add(context);
   }
  }});contexts.set(context,value);return context;
 }catch(error){value.finished=true;await value.db.end();throw error;}
}
/** No subset, reordering, replacement or copied-path alias can stand in for the
 * exact ordered governed frame selected by an execute/audit caller. */
export async function assertCanonicalSealSelection(context:WitnessedProvenanceContext,seals:readonly {output:NativeProvenancePin;queue:unknown}[]){const value=state(context);if(seals.length!==value.selection.seals.length)throw Error('Native selection witness set differs');for(let index=0;index<seals.length;index++){const expected=value.selection.seals[index],actual=seals[index];if(pinKey(expected.output)!==pinKey(actual.output))throw Error('Native selection witness identity or order differs');equal(value,value.core.queue.QueueTextSealInputSchema.parse(actual.queue),value.core.queue.QueueTextSealInputSchema.parse(expected.queue),'Native selection queue differs');}await assertCurrent(value);}
function samePolicy(value:ContextState,policy:CivicPolicyOptions){
 const expected={stateDir:resolve(value.policy.stateDir??value.core.civic.CIVIC_POLICY_STATE_DIR),authorityId:value.policy.authorityId,authoritySha256:value.policy.authoritySha256};
 const supplied={stateDir:resolve(policy.stateDir??value.core.civic.CIVIC_POLICY_STATE_DIR),authorityId:policy.authorityId??value.core.civic.CIVIC_POLICY_AUTHORITY_ID,authoritySha256:policy.authoritySha256??value.policy.authoritySha256};
 equal(value,expected,supplied,'Native provenance context belongs to another authority');
}
async function withContext<T>(policy:CivicPolicyOptions,context:WitnessedProvenanceContext,work:(value:ContextState)=>Promise<T>){const value=state(context);samePolicy(value,policy);await assertCurrent(value);const result=await work(value);await assertCurrent(value);return result;}
async function supplemented(value:ContextState,inputs:SupplementEvidence){
 const native=nativeRecord(value,inputs.nativeOutput,inputs.nativeProvenance),result=structuredClone(native.inventory),targets=new Set(inputs.targets),found=new Set<string>();if(targets.size!==inputs.targets.length)throw Error('Duplicate provenance supplement target');
 for(const pin of result.inputs){if(!targets.has(pin.sha256))continue;found.add(pin.sha256);const bindings=new Map(pin.bindings.map(binding=>[value.core.adapter.canonicalJson(binding),binding]));
  for(const witness of value.native.values())for(const other of witness.inventory.inputs){if(other.sha256!==pin.sha256)continue;if(other.path!==pin.path||other.bytes!==pin.bytes)throw Error('Shared target path or byte-size differs');for(const binding of other.bindings){if(binding.kind!=='http_observation'||binding.independentAllowed!==true)throw Error('Supplement requires actual native HTTP binding witnesses');bindings.set(value.core.adapter.canonicalJson(binding),binding);}}
  if(bindings.size<=pin.bindings.length)throw Error('No independent supplemental bindings for target');pin.bindings=[...bindings].sort(([a],[b])=>a.localeCompare(b)).map(([,binding])=>binding);
 }
 if(found.size!==targets.size)throw Error('Supplement target absent from native provenance');
 const inventory=value.core.provenance.privatePublicationProvenanceSchema.parse(result),bytes=encode(inventory),sha256=digest(bytes);
 const attestation=structuredClone({schemaVersion:'stadtstack-r1-native-provenance-union-v2',issuance:value.issuancePin,selection:value.selectionPin,witnesses:[...value.native.values()].map(witness=>witness.identity),nativeOutput:native.output,nativeProvenance:native.provenance,targets:inputs.targets,inventory:{sha256,bytes:bytes.length}}),attestationBytes=encode(attestation);
 return {inventory,bytes,sha256,attestation,attestationBytes,attestationSha256:digest(attestationBytes)};
}
export async function buildProvenanceSupplement(raw:SupplementEvidence,policy:CivicPolicyOptions,context:WitnessedProvenanceContext){const inputs=EvidenceSchema.parse(raw);return withContext(policy,context,value=>supplemented(value,inputs));}
async function authenticatedSupplement(value:ContextState,inputs:SupplementEvidence,raw:z.infer<typeof ProvenanceSupplementPinSchema>){const pin=ProvenanceSupplementPinSchema.parse(raw),expected=await supplemented(value,inputs),bytes=await readPrivate(pin.inventory,value.files),attestation=await readPrivate(pin.attestation,value.files);if(!bytes.equals(expected.bytes)||!attestation.equals(expected.attestationBytes))throw Error('Supplement differs from exact governed canonical witness set');const reader=await value.core.provenance.authenticatePublicationProvenance(pin.inventory.path,pin.inventory.sha256,value.policy);for(const input of expected.inventory.inputs)await reader.read(resolve(dirname(pin.inventory.path),input.path));return {reader,inventory:expected.inventory};}
/** The final capability and exact live binding checks come from unchanged Core. */
export async function authenticateSupplement(raw:SupplementEvidence,pin:z.infer<typeof ProvenanceSupplementPinSchema>,policy:CivicPolicyOptions,context:WitnessedProvenanceContext):Promise<AuthenticatedPublicationProvenance>{const inputs=EvidenceSchema.parse(raw);return withContext(policy,context,async value=>(await authenticatedSupplement(value,inputs,pin)).reader);}
export async function authenticateSealProvenance(output:NativeProvenancePin,selection:SupplementSelection|undefined,policy:CivicPolicyOptions,context:WitnessedProvenanceContext){return withContext(policy,context,async value=>{const native=nativeRecord(value,output);if(!selection){const reader=await value.core.provenance.authenticatePublicationProvenance(native.provenance.path,native.provenance.sha256,value.policy);for(const input of native.inventory.inputs)await reader.read(resolve(dirname(native.provenance.path),input.path));return {reader,inventory:structuredClone(native.inventory),originalProvenance:{...native.provenance}};}const {targets,...pin}=ProvenanceSupplementSelectionSchema.parse(selection),authenticated=await authenticatedSupplement(value,{nativeOutput:output,nativeProvenance:native.provenance,targets},pin);return {...authenticated,originalProvenance:{...native.provenance}};});}

/** Derive all and only growing HTTP-binding unions from the already canonical
 * frame. This is not a fallback for a failed Core proof: Core authenticates the
 * complete resulting inventory, including its exact live binding sets. */
export async function authenticateCanonicalSealProvenance(output:NativeProvenancePin,selected:SupplementSelection|undefined,policy:CivicPolicyOptions,context:WitnessedProvenanceContext){
 if(selected)return {...await authenticateSealProvenance(output,selected,policy,context),generatedSupplement:undefined};
 return withContext(policy,context,async value=>{
  const native=nativeRecord(value,output),targets:string[]=[];
  for(const pin of native.inventory.inputs){
   const bindings=new Set(pin.bindings.map(binding=>value.core.adapter.canonicalJson(binding)));
   for(const witness of value.native.values())for(const other of witness.inventory.inputs)if(other.sha256===pin.sha256){
    if(other.path!==pin.path||other.bytes!==pin.bytes)throw Error('Shared canonical target path or size differs');
    for(const binding of other.bindings)bindings.add(value.core.adapter.canonicalJson(binding));
   }
   if(bindings.size>pin.bindings.length)targets.push(pin.sha256);
  }
  if(!targets.length){
   const reader=await value.core.provenance.authenticatePublicationProvenance(native.provenance.path,native.provenance.sha256,value.policy);
   for(const pin of native.inventory.inputs)await reader.read(pin.path);
   return {reader,inventory:structuredClone(native.inventory),originalProvenance:{...native.provenance},generatedSupplement:undefined};
  }
  const evidence={nativeOutput:output,nativeProvenance:native.provenance,targets:[...new Set(targets)].sort()},built=await supplemented(value,evidence);
  value.controls??=await mkdtemp(join(tmpdir(),'stadtstack-step8-provenance-'));
  const control=async(name:string,bytes:Buffer,sha256:string)=>{
   const path=join(value.controls!,name+'-'+sha256+'.json'),pin={path,sha256,bytes:bytes.length};
   try{await writeFile(path,bytes,{mode:0o600,flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
   await readPrivate(pin,value.files);return pin;
  };
  const pins={inventory:await control('inventory',built.bytes,built.sha256),attestation:await control('attestation',built.attestationBytes,built.attestationSha256)};
  const authenticated=await authenticatedSupplement(value,evidence,pins);
  return {...authenticated,originalProvenance:{...native.provenance},generatedSupplement:structuredClone({targets:evidence.targets,inventoryBytes:built.bytes,inventorySha256:built.sha256,attestationBytes:built.attestationBytes,attestationSha256:built.attestationSha256})};
 });
}

/** Reuse the genuine canonical producer result, comparing every contribution
 * byte and the declared extraction selection. Never reconstruct a second time. */
export async function exportCanonicalTextContribution(context:WitnessedProvenanceContext,output:NativeProvenancePin,jobKeys:readonly string[],contribution:TextRunContribution):Promise<CanonicalExport>{
 const value=state(context);return withContext(value.policy,context,async live=>{
  const native=nativeRecord(live,output),expected=native.exported.contribution,selected=live.selection.seals.find(seal=>pinKey(seal.output)===pinKey(output))!,queue=live.core.queue.QueueTextSealInputSchema.parse(selected.queue);
  equal(live,[...jobKeys].sort(),[...queue.jobKeys].sort(),'Canonical export extraction selection differs');
  equal(live,[contribution.runId,contribution.pins,contribution.sourceArtifactKind],[expected.runId,expected.pins,expected.sourceArtifactKind],'Canonical export contribution identity differs');
  equal(live,Object.keys(contribution.artifacts).sort(),Object.keys(expected.artifacts).sort(),'Canonical export artifact set differs');
  for(const key of Object.keys(expected.artifacts) as Array<keyof TextRunContribution['artifacts']>){
   const actual=contribution.artifacts[key],wanted=expected.artifacts[key];
   if(!!actual!==!!wanted||actual&&wanted&&(actual.sha256!==wanted.sha256||digest(Buffer.from(actual.bytes))!==wanted.sha256))throw Error('Canonical export artifact bytes differ');
  }
  return structuredClone(native.exported);
 });
}

/** Borrow the same immutable source epoch. A phase finish is only a fresh
 * checkpoint; the owner must finish the context before any managed write. */
export function canonicalManagedSourceAudit(context:WitnessedProvenanceContext){
 const {authority,inventorySha256,optOutSnapshotSha256}=state(context).fence;
 return Object.freeze({authority:structuredClone(authority),inventorySha256,optOutSnapshotSha256,
  async read(path:string,hash?:string,purpose?:'historical_change_reconstruction_only'){return state(context).fence.read(path,hash,purpose);},
  async finish(){await context.checkpoint();return {inventorySha256,optOutSnapshotSha256};}
 });
}

export function assertCanonicalEpochFinished(context:WitnessedProvenanceContext){
 if(!acceptedEpochs.has(context))throw Error('Managed staging requires a successfully finished canonical source epoch');
}
export function canonicalOutputForProvenance(context:WitnessedProvenanceContext,pin:NativeProvenancePin){
 const value=state(context),matches=[...value.native.values()].filter(native=>pinKey(native.provenance)===pinKey(pin));
 if(matches.length>1)throw Error('Canonical provenance selection is ambiguous');
 return matches[0]?{...matches[0].output}:undefined;
}
export function assertCanonicalContextInputs(context:WitnessedProvenanceContext,policy:CivicPolicyOptions,inputs:{selection?:NativeProvenancePin;catalogue?:NativeProvenancePin;casRoot?:string;importDispositionDecision?:NativeProvenancePin}={}){
 const value=state(context);samePolicy(value,policy);
 if(inputs.selection&&pinKey(inputs.selection)!==pinKey(value.issuancePin)||inputs.catalogue&&pinKey(inputs.catalogue)!==pinKey(value.selection.catalogue)||inputs.casRoot&&resolve(inputs.casRoot)!==value.casRoot||inputs.importDispositionDecision&&(!value.importDispositionDecision||pinKey(inputs.importDispositionDecision)!==pinKey(value.importDispositionDecision)))throw Error('Borrowed canonical context belongs to different staging inputs');
}
