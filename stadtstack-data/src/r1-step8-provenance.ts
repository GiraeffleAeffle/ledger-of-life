import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {Pool} from 'pg';
import {z} from 'zod';
import {parse as parseConnectionString} from 'pg-connection-string';
import {userInfo} from 'node:os';
import type {CivicPolicyOptions} from './civic-opt-out.ts';
import type {PrivatePublicationProvenance,AuthenticatedPublicationProvenance} from './district-publication-provenance.ts';

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
export const WITNESSED_PROVENANCE_CORE_DEPENDENCIES=['src/civic-opt-out.ts','src/district-publication-provenance.ts','src/district-adapter-contract.ts','src/r1-step8-managed-read-view.ts','src/district-queue-text-run.ts','src/district-registry-config.ts','src/district-cas.ts','src/district-step-receipt.ts','src/r1-step8-governance.ts','src/district-r1-text-composition.ts'] as const;
const defaultCoreRoot=fileURLToPath(new URL('../',import.meta.url));
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const metadata=(path:string)=>lstat(path,{bigint:true});
const stamp=(stat:Awaited<ReturnType<typeof metadata>>)=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs,stat.mode,stat.uid,stat.nlink].join(':');
async function loadCore(root:string){
 const [civic,provenance,adapter,audit,queue,registry,cas,receipt,governance,composition]=await Promise.all(WITNESSED_PROVENANCE_CORE_DEPENDENCIES.map(file=>import(pathToFileURL(join(root,file)).href)));
 return {civic:civic as typeof import('./civic-opt-out.ts'),provenance:provenance as typeof import('./district-publication-provenance.ts'),adapter:adapter as typeof import('./district-adapter-contract.ts'),audit:audit as typeof import('./r1-step8-managed-read-view.ts'),queue:queue as typeof import('./district-queue-text-run.ts'),registry:registry as typeof import('./district-registry-config.ts'),cas:cas as typeof import('./district-cas.ts'),receipt:receipt as typeof import('./district-step-receipt.ts'),governance:governance as typeof import('./r1-step8-governance.ts'),composition:composition as typeof import('./district-r1-text-composition.ts')};
}
type Core=Awaited<ReturnType<typeof loadCore>>;
type CanonicalStep=Awaited<ReturnType<Core['queue']['buildQueueTextRun']>>['steps'][number];
type Selection=z.infer<typeof NativeSealSelectionSchema>;
type NativeRecord={output:NativeProvenancePin;provenance:NativeProvenancePin;inventory:PrivatePublicationProvenance;identity:unknown};
type FileRecord={bytes:Buffer;stamp:string};
export interface WitnessedProvenanceContext {readonly witnesses:number;finish():Promise<void>}
interface ContextState {
 core:Core;policy:CivicPolicyOptions;selection:Selection;selectionPin:NativeProvenancePin;issuancePin:NativeProvenancePin;issuance:z.infer<typeof NativeSealSelectionActionSchema>;native:Map<string,NativeRecord>;files:Map<string,FileRecord>;db:Pool;steps:Map<string,CanonicalStep>;
 fence:Awaited<ReturnType<Core['audit']['createReadOnlyManagedSourceAudit']>>;inventoryPin:NativeProvenancePin;inventoryStamp:string;finished:boolean;
}
const contexts=new WeakMap<WitnessedProvenanceContext,ContextState>();
const pinKey=(pin:NativeProvenancePin)=>JSON.stringify([pin.path,pin.sha256]);
/** Only scalar, explicit Unix-socket settings cross into the independent pool.
 * pg-connection-string uses an empty string for an omitted URL port. */
export function createCanonicalWitnessReadPool(configuration:Pool['options']){
 const parsed=configuration.connectionString?parseConnectionString(configuration.connectionString):{};
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
function assertIssued(issuance:z.infer<typeof NativeSealSelectionActionSchema>){const now=Date.now();if(Date.parse(issuance.issuedAt)>now||Date.parse(issuance.expiresAt)<=now||Date.parse(issuance.expiresAt)<=Date.parse(issuance.issuedAt))throw Error('Native seal selection is unissued, future-issued or expired');}
async function assertCurrent(value:ContextState){
 if(value.finished)throw Error('Native provenance context finished');
 await value.core.civic.assertCivicPolicyAuthority(value.policy);
 if(stamp(await metadata(value.inventoryPin.path))!==value.inventoryStamp)throw Error('Native provenance inventory epoch changed');
 assertIssued(value.issuance);
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
 equal(value,documents(built.originals.map(source=>({documentId:source.document.id,sha256:source.document.sha256}))),documents(rows[0].originals),'Native selection document cohort differs from governed catalogue');
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
 const result={output:{...selected.output,bytes:raw.length},provenance:provenancePin,inventory,identity:{municipalityId:selected.municipalityId,sourceId:selected.sourceId,corpus:selected.corpus,admission:selected.admission,queue,output:{...selected.output,bytes:raw.length},provenance:provenancePin,runId:built.contribution.runId,receipts:built.steps.map(step=>({jobKey:step.receipt.jobKey,receiptId:step.receipt.id,receiptSha256:step.sha256}))}};value.native.set(pinKey(selected.output),result);
}
/** The caller supplies an independently reviewed/issued selection pin. Database
 * access is a separate one-connection Unix-socket pool, enforced read-only by
 * PostgreSQL. Canonical reconstruction never initializes or writes a CAS. */
export async function createWitnessedProvenanceContext(selectionPin:NativeProvenancePin,policy:CivicPolicyOptions,options:{pool:Pool;casRoot:string;catalogue:NativeProvenancePin;mode:'step8'|'adoption';coreRoot?:string}):Promise<WitnessedProvenanceContext>{
 const files=new Map<string,FileRecord>(),issuanceBytes=await readPrivate(selectionPin,files,MAX_BYTES,true),issuance=NativeSealSelectionActionSchema.parse(JSON.parse(issuanceBytes.toString('utf8')));assertIssued(issuance);
 const frameBytes=await readPrivate(issuance.selection,files),selection=NativeSealSelectionSchema.parse(JSON.parse(frameBytes.toString('utf8'))),core=await loadCore(resolve(options.coreRoot??defaultCoreRoot));
 if(pinKey(issuance.catalogue)!==pinKey(selection.catalogue))throw Error('Issued native selection catalogue differs from frame');
 await readPrivate(issuance.evidence,files);await readPrivate(issuance.collector,files);
 if(pinKey(selection.catalogue)!==pinKey(options.catalogue))throw Error('Native selection belongs to another governed catalogue');
 const seenSources=new Set<string>(),seenOutputs=new Set<string>();for(const selected of selection.seals){const source=JSON.stringify([selected.municipalityId,selected.sourceId]);if(seenSources.has(source)||seenOutputs.has(pinKey(selected.output)))throw Error('Duplicate native selection source or output');seenSources.add(source);seenOutputs.add(pinKey(selected.output));core.queue.QueueTextSealInputSchema.parse(selected.queue);}
 const authority=await core.civic.assertCivicPolicyAuthority(policy),bound={...policy,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256},candidates=selection.seals.filter(seal=>seal.admission==='adoption_candidate').length;
 if(authority.mode!=='isolated-fixture'&&(issuance.parentApproval.id!=='r1-nine-town-models-2026-10-13'||issuance.parentApproval.sha256!=='2ac6267d17ed08452665a0b2de92ec4da89915fe8619b668b85585301327502b'))throw Error('Native selection parent approval differs from frozen campaign');
 if(options.mode==='step8'&&candidates!==0||options.mode==='adoption'&&candidates!==1)throw Error('Native selection admission set differs from governed operation');
 if(authority.mode!=='isolated-fixture'&&selection.seals.length!==(options.mode==='adoption'?25:27))throw Error('Incomplete production native seal selection');
 if(options.pool.options.connectionString)core.governance.step8SocketConnection(options.pool.options.connectionString);
 const db=createCanonicalWitnessReadPool(options.pool.options);
 try{
  const fence=await core.audit.createReadOnlyManagedSourceAudit(bound),inventoryPin={path:join(resolve(bound.stateDir??core.civic.CIVIC_POLICY_STATE_DIR),'inventory.json'),sha256:fence.inventorySha256},epochFiles=new Map<string,FileRecord>();await readPrivate(inventoryPin,epochFiles,512*1024*1024);
  const value:ContextState={core,policy:bound,selection,selectionPin:{...issuance.selection,bytes:frameBytes.length},issuancePin:{...selectionPin,bytes:issuanceBytes.length},issuance,native:new Map(),files,db,steps:new Map(),fence,inventoryPin,inventoryStamp:epochFiles.get(pinKey(inventoryPin))!.stamp,finished:false};
  class ReadOnlyCas extends core.cas.DistrictCas {override async read(hash:string){core.adapter.HashSchema.parse(hash);return fence.read(join(this.root,'sha256',hash.slice(0,2),hash),hash);}override async put():Promise<never>{throw Error('Canonical witness CAS is read-only');}}
  const cas=new ReadOnlyCas(options.casRoot);
  for(const selected of selection.seals){await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');try{await canonicalSeal(value,selected,cas);await db.query('COMMIT');}catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}}
  await assertCurrent(value);
  const context:WitnessedProvenanceContext=Object.freeze({witnesses:selection.seals.length,async finish():Promise<void>{const live=state(context);try{await assertCurrent(live);await live.fence.finish();}finally{live.finished=true;await live.db.end();}}});contexts.set(context,value);return context;
 }catch(error){await db.end();throw error;}
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
 const attestation={schemaVersion:'stadtstack-r1-native-provenance-union-v2',issuance:value.issuancePin,selection:value.selectionPin,witnesses:[...value.native.values()].map(witness=>witness.identity),nativeOutput:native.output,nativeProvenance:native.provenance,targets:inputs.targets,inventory:{sha256,bytes:bytes.length}},attestationBytes=encode(attestation);
 return {inventory,bytes,sha256,attestation,attestationBytes,attestationSha256:digest(attestationBytes)};
}
export async function buildProvenanceSupplement(raw:SupplementEvidence,policy:CivicPolicyOptions,context:WitnessedProvenanceContext){const inputs=EvidenceSchema.parse(raw);return withContext(policy,context,value=>supplemented(value,inputs));}
async function authenticatedSupplement(value:ContextState,inputs:SupplementEvidence,raw:z.infer<typeof ProvenanceSupplementPinSchema>){const pin=ProvenanceSupplementPinSchema.parse(raw),expected=await supplemented(value,inputs),bytes=await readPrivate(pin.inventory,value.files),attestation=await readPrivate(pin.attestation,value.files);if(!bytes.equals(expected.bytes)||!attestation.equals(expected.attestationBytes))throw Error('Supplement differs from exact governed canonical witness set');const reader=await value.core.provenance.authenticatePublicationProvenance(pin.inventory.path,pin.inventory.sha256,value.policy);for(const input of expected.inventory.inputs)await reader.read(resolve(dirname(pin.inventory.path),input.path));return {reader,inventory:expected.inventory};}
/** The final capability and exact live binding checks come from unchanged Core. */
export async function authenticateSupplement(raw:SupplementEvidence,pin:z.infer<typeof ProvenanceSupplementPinSchema>,policy:CivicPolicyOptions,context:WitnessedProvenanceContext):Promise<AuthenticatedPublicationProvenance>{const inputs=EvidenceSchema.parse(raw);return withContext(policy,context,async value=>(await authenticatedSupplement(value,inputs,pin)).reader);}
export async function authenticateSealProvenance(output:NativeProvenancePin,selection:SupplementSelection|undefined,policy:CivicPolicyOptions,context:WitnessedProvenanceContext){return withContext(policy,context,async value=>{const native=nativeRecord(value,output);if(!selection){const reader=await value.core.provenance.authenticatePublicationProvenance(native.provenance.path,native.provenance.sha256,value.policy);for(const input of native.inventory.inputs)await reader.read(resolve(dirname(native.provenance.path),input.path));return {reader,inventory:native.inventory,originalProvenance:native.provenance};}const {targets,...pin}=ProvenanceSupplementSelectionSchema.parse(selection),authenticated=await authenticatedSupplement(value,{nativeOutput:output,nativeProvenance:native.provenance,targets},pin);return {...authenticated,originalProvenance:native.provenance};});}
