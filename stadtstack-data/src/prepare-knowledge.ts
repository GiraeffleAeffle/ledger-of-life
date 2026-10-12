import {readFile,lstat,realpath} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {validateKnowledgeRelease,hashSchema,sha256} from './district-schema.ts';
import {buildDistrictCoverage,knowledgePublicationHold,knowledgePublicationQuarantineCase,projectDistrictCoverage,assertKnowledgeSlice} from './district-publication.ts';
import {assertPublicUrls} from './publication-quality.ts';
import {authenticateTextRunContribution,textSchemaProjectionSchema} from './text-run-lineage.ts';
import type {TextRunContribution,TextLineageArtifact} from './text-run-lineage.ts';
import {authenticateRetainedKnowledgePublication} from './retained-knowledge-lineage.ts';
import type {RetainedKnowledgePublicationInput,AuthenticatedRetainedKnowledgePublication} from './retained-knowledge-lineage.ts';
import {composeDistrictRelease} from './district-release-composition.ts';
import type {DistrictRunAdmission,DistrictReleaseComposition} from './district-release-composition.ts';
import {assertCivicPolicyAuthority,assertHostNotOptedOut,assertSourceHostsNotOptedOut,assertManagedSourceBindings,CIVIC_POLICY_AUTHORITY,CIVIC_ACQUISITION_DECISION_ID} from './civic-opt-out.ts';
import type {CivicPolicyOptions,RetainedPublicationBinding} from './civic-opt-out.ts';
import {PreparedDocumentSchema,verifyPreparedDocument,assertPreparedSourcesActive,preparedSourceBindings} from './district-prepared-document.ts';
import type {PreparedDocument} from './district-prepared-document.ts';
import {writeManagedSourceJson,writePrivateJson} from './district-private-io.ts';
import type {SourceArtifactBinding} from './district-private-io.ts';
import {knowledgePreparationInputsSchema} from './district-publication-inputs.ts';
import {operatorRegistryConfigSchema,operatorRegistryConfigSourcePinSchema,operatorRegistryConfigBindingSchema,importOperatorRegistryConfig,readOperatorRegistryConfigSourcePin} from './district-registry-config.ts';
import {authorizedPilotCorpusSchema} from './district-corpus.ts';
import {retainedPublicationSources} from './district-retained-import.ts';

const pinSchema=z.object({path:z.string().min(1),sha256:hashSchema,bytes:z.number().int().nonnegative().max(512*1024*1024)}).strict();
const publicationBinding=z.object({manifestSha256:hashSchema,releaseId:z.string().min(1),memberPath:z.string().min(1),memberSha256:hashSchema,memberBytes:z.number().int().nonnegative()}).strict();
const preparedBindingSchema=z.object({kind:z.literal('prepared_source'),url:z.url(),sourceSha256:hashSchema,observationId:z.string().min(1),receiptSha256:hashSchema,independentAllowed:z.boolean()}).strict();
const retainedBindingSchema=z.object({kind:z.literal('retained_publication'),url:z.url(),sourceSha256:hashSchema.nullable().optional(),publication:publicationBinding,independentAllowed:z.literal(false)}).strict();
export const knowledgeHttpObservationBindingSchema=z.object({kind:z.literal('http_observation'),url:z.url(),sourceSha256:hashSchema,observationId:z.string().min(1),receiptSha256:hashSchema,independentAllowed:z.boolean()}).strict();
const bindingSchema=z.discriminatedUnion('kind',[
 preparedBindingSchema,
 retainedBindingSchema,
 operatorRegistryConfigBindingSchema,
 knowledgeHttpObservationBindingSchema,
]);
export const knowledgeSourcePinSchema=pinSchema.extend({bindings:z.array(bindingSchema).min(1)}).strict();
export type KnowledgeSourcePin=z.infer<typeof knowledgeSourcePinSchema>;
export type KnowledgeAuditPin=z.infer<typeof pinSchema>;
export const knowledgePreparedSourcePinSchema=pinSchema.extend({bindings:z.array(preparedBindingSchema).min(1)}).strict();
export type KnowledgePreparedSourcePin=z.infer<typeof knowledgePreparedSourcePinSchema>;
export const knowledgeRetainedPublicationSourcePinSchema=pinSchema.extend({bindings:z.array(retainedBindingSchema).min(1)}).strict().superRefine((pin,ctx)=>{
 if(pin.bindings.some(binding=>binding.publication.memberSha256!==pin.sha256||binding.publication.memberBytes!==pin.bytes))ctx.addIssue({code:'custom',message:'Retained member pin must contain the exact authenticated publication member bytes'});
});
export type KnowledgeRetainedPublicationSourcePin=z.infer<typeof knowledgeRetainedPublicationSourcePinSchema>;
export const knowledgeRegistryInputSchema=z.union([operatorRegistryConfigSourcePinSchema,operatorRegistryConfigSchema]);
export type KnowledgeRegistryInput=z.infer<typeof knowledgeRegistryInputSchema>;
const runShape={runId:hashSchema,pins:z.object({corpusSha256:hashSchema,registrySha256:hashSchema,promptContractSha256:hashSchema,schemaSha256:hashSchema}).strict(),artifacts:z.object({extractionRun:pinSchema,records:knowledgeSourcePinSchema,quarantine:knowledgeSourcePinSchema,crawl:knowledgeSourcePinSchema,registry:knowledgeRegistryInputSchema,preparationPlan:knowledgeSourcePinSchema.optional()}).strict(),admissions:z.array(z.object({recordId:z.string().min(1),prepared:z.array(knowledgePreparedSourcePinSchema).min(1)}).strict()),schemaProjection:textSchemaProjectionSchema.optional()};
export const prepareKnowledgeOptionsSchema=z.object({
 schemaVersion:z.literal('stadtstack-managed-knowledge-intake-v1'),
 policy:z.object({stateDir:z.string().min(1),authorityId:z.string().min(1),authoritySha256:hashSchema}).strict(),
 registry:knowledgeRegistryInputSchema,
 runs:z.array(z.object({...runShape,sourceArtifactKind:z.literal('native_extraction_output')}).strict()),
 retainedPublication:z.object({artifacts:z.object({manifest:pinSchema,records:knowledgeRetainedPublicationSourcePinSchema,coverage:knowledgeRetainedPublicationSourcePinSchema,registry:knowledgeRetainedPublicationSourcePinSchema}).strict(),admissions:z.array(z.object({recordId:z.string().min(1),originalEvidenceHash:hashSchema}).strict()),schemaProjection:textSchemaProjectionSchema.optional()}).strict().optional(),
 approvedRunOrder:z.array(hashSchema),generatedAt:z.iso.datetime({offset:true}),minimumPerDistrict:z.number().int().min(1).default(1),
 output:z.object({root:z.string().min(1),stagingDir:z.string().min(1),auditDir:z.string().min(1)}).strict(),
}).strict().superRefine((options,ctx)=>{if(!options.runs.length&&!options.retainedPublication)ctx.addIssue({code:'custom',message:'Knowledge intake requires a real native run or authenticated retained publication baseline'});});
export type PrepareKnowledgeOptions=z.infer<typeof prepareKnowledgeOptionsSchema>;

function contained(root:string,path:string){const part=relative(resolve(root),resolve(path));return part!==''&&!part.startsWith('..')&&!isAbsolute(part);}
async function readPin(pin:KnowledgeAuditPin,policy:CivicPolicyOptions,source?:KnowledgeSourcePin):Promise<TextLineageArtifact>{
 await assertCivicPolicyAuthority(policy);
 if(source){
  await assertSourceHostsNotOptedOut(source.bindings.map(binding=>binding.url),policy);
  // Exact bindings check current bytes, all active ancestors and every declared
  // URL's enrolled provenance; no per-URL inventory reload is necessary.
  await assertManagedSourceBindings(pin.path,source.bindings,policy);
 }
 const metadata=await lstat(pin.path);
 if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size!==pin.bytes)throw Error('Knowledge input file type/length differs from explicit pin');
 const bytes=await readFile(pin.path);
 if(bytes.byteLength!==pin.bytes||sha256(bytes)!==pin.sha256)throw Error('Knowledge input byte hash differs from explicit pin');
 if(source)await assertManagedSourceBindings(pin.path,source.bindings,policy);
 return {sha256:pin.sha256,bytes:new TextDecoder('utf-8',{fatal:true}).decode(bytes)};
}
function decoded(artifact:TextLineageArtifact):unknown{return JSON.parse(typeof artifact.bytes==='string'?artifact.bytes:new TextDecoder('utf-8',{fatal:true}).decode(artifact.bytes));}
async function readRegistryInput(input:KnowledgeRegistryInput,options:PrepareKnowledgeOptions){
 const pin='kind' in input?await importOperatorRegistryConfig({...input,managedRoot:options.output.root,destinationPath:'intake/configuration/'+input.sha256+'.json'},options.policy):input;
 const {bytes,registry}=await readOperatorRegistryConfigSourcePin(pin,options.policy);
 const artifact:TextLineageArtifact={sha256:pin.sha256,bytes};
 return {pin,artifact,registry};
}

export type CurrentKnowledgeAdmission=
 |{basis:'native_prepared';runId:string;recordId:string;originalEvidenceHash:string;preparedReceiptSha256s:string[];checkedAt:string}
 |{basis:'retained_publication';recordId:string;originalEvidenceHash:string;publication:RetainedPublicationBinding;checkedAt:string};

async function readRetainedPublication(input:NonNullable<PrepareKnowledgeOptions['retainedPublication']>,policy:CivicPolicyOptions){
 const artifacts:RetainedKnowledgePublicationInput['artifacts']={
  manifest:await readPin(input.artifacts.manifest,policy),
  records:await readPin(input.artifacts.records,policy,input.artifacts.records),
  coverage:await readPin(input.artifacts.coverage,policy,input.artifacts.coverage),
  registry:await readPin(input.artifacts.registry,policy,input.artifacts.registry),
 };
 const contribution:RetainedKnowledgePublicationInput={artifacts,recordIds:input.admissions.map(admission=>admission.recordId),...(input.schemaProjection?{schemaProjection:input.schemaProjection}:{})};
 const baseline=authenticateRetainedKnowledgePublication(contribution),bindings:SourceArtifactBinding[]=[];
 for(const kind of ['records','coverage','registry'] as const){
  const pin=input.artifacts[kind],member=baseline.lineage.members[kind];
  if(pin.bindings.some(binding=>binding.publication.manifestSha256!==artifacts.manifest.sha256||binding.publication.releaseId!==baseline.lineage.releaseId||binding.publication.memberPath!==member.path))throw Error('Retained source pin does not bind the selected publication member');
  const sources=retainedPublicationSources(decoded(artifacts[kind])),expected=new Set(sources.map(source=>JSON.stringify([source.url,source.sourceSha256]))),declared=new Set(pin.bindings.map(binding=>JSON.stringify([binding.url,binding.sourceSha256??null])));
  if(expected.size!==declared.size||[...expected].some(key=>!declared.has(key)))throw Error('Retained publication source inventory is incomplete or extra');
  for(const source of sources)await assertHostNotOptedOut(source.url,policy);
  bindings.push(...pin.bindings);
 }
 const records=new Map(baseline.records.map(record=>[record.id,record]));
 const admissions:CurrentKnowledgeAdmission[]=[];
 for(const requested of input.admissions){
  const record=records.get(requested.recordId)!;
  if(record.verification.evidenceHash!==requested.originalEvidenceHash)throw Error('Retained admission original evidence hash mismatch');
  for(const source of record.sources)await assertHostNotOptedOut(source.url,policy);
  admissions.push({basis:'retained_publication',recordId:record.id,originalEvidenceHash:requested.originalEvidenceHash,publication:{manifestSha256:artifacts.manifest.sha256,releaseId:baseline.lineage.releaseId,memberPath:'knowledge/records.json',memberSha256:artifacts.records.sha256,memberBytes:input.artifacts.records.bytes},checkedAt:new Date().toISOString()});
 }
 return {contribution,baseline,bindings,admissions};
}

/** Explicit, cache-only current admission of original artifacts. Never manufactures a combined extraction run. */
export async function prepareKnowledge(input:PrepareKnowledgeOptions){
 const options=prepareKnowledgeOptionsSchema.parse(input),authority=await assertCivicPolicyAuthority(options.policy);
 if(!contained(options.output.root,options.output.stagingDir)||resolve(options.output.auditDir)===resolve(options.output.root)||contained(options.output.root,options.output.auditDir)||contained(options.output.auditDir,options.output.root))throw Error('Knowledge staging must be inside managed output and audit metadata outside it');
 if(options.approvedRunOrder.length!==options.runs.length||new Set(options.approvedRunOrder).size!==options.runs.length||options.runs.some((run,index)=>run.runId!==options.approvedRunOrder[index]))throw Error('Contributions require a unique, explicitly approved input order');
 const inputPins=[options.registry,...(options.retainedPublication?Object.values(options.retainedPublication.artifacts):[]),...options.runs.flatMap(run=>[...Object.values(run.artifacts).filter((pin):pin is KnowledgeAuditPin=>pin!==undefined),...run.admissions.flatMap(admission=>admission.prepared)])];
 if(inputPins.some(pin=>resolve(pin.path)===resolve(options.output.root)||contained(options.output.root,pin.path)||contained(options.output.auditDir,pin.path)))throw Error('Knowledge output must not overwrite or enclose original intake artifacts');
 const registryInput=await readRegistryInput(options.registry,options),registry=registryInput.registry;
 const bindings:SourceArtifactBinding[]=[...registryInput.pin.bindings],contributions:TextRunContribution[]=[],admissions:DistrictRunAdmission[]=[];
 const preparedReceipts:PreparedDocument[]=[],currentAdmissions:CurrentKnowledgeAdmission[]=[];
 let retainedPublication:RetainedKnowledgePublicationInput|undefined,retainedBaseline:AuthenticatedRetainedKnowledgePublication|null=null;
 if(options.retainedPublication){
  const retained=await readRetainedPublication(options.retainedPublication,options.policy);
  retainedPublication=retained.contribution;retainedBaseline=retained.baseline;bindings.push(...retained.bindings);currentAdmissions.push(...retained.admissions);
 }
 const publicationHolds:DistrictReleaseComposition['quarantine']['cases']=[];
 for(const run of options.runs){
  const runRegistry=await readRegistryInput(run.artifacts.registry,options);
  const artifacts:TextRunContribution['artifacts']={extractionRun:await readPin(run.artifacts.extractionRun,options.policy),records:await readPin(run.artifacts.records,options.policy,run.artifacts.records),quarantine:await readPin(run.artifacts.quarantine,options.policy,run.artifacts.quarantine),crawl:await readPin(run.artifacts.crawl,options.policy,run.artifacts.crawl),registry:runRegistry.artifact};
  bindings.push(...runRegistry.pin.bindings);
  for(const key of ['records','quarantine','crawl'] as const)bindings.push(...run.artifacts[key].bindings);
  if(run.artifacts.preparationPlan){artifacts.preparationPlan=await readPin(run.artifacts.preparationPlan,options.policy,run.artifacts.preparationPlan);bindings.push(...run.artifacts.preparationPlan.bindings);}
  const contribution:TextRunContribution={runId:run.runId,pins:run.pins,artifacts,sourceArtifactKind:'native_extraction_output'};
  const authenticated=authenticateTextRunContribution(contribution),recordIds:string[]=[];
  authorizedPilotCorpusSchema.parse(authenticated.extractionRun.corpusSha256);
  if(new Set(run.admissions.map(item=>item.recordId)).size!==run.admissions.length)throw Error('Duplicate record in current admission inventory');
  for(const request of run.admissions){
   const record=authenticated.records.find(record=>record.id===request.recordId);
   if(!record||record.verification.status!=='auto-verified')throw Error('Current admission requires an actual passing original record');
   const current:PreparedDocument[]=[];
   for(const pin of request.prepared){
    const parsed=PreparedDocumentSchema.parse(decoded(await readPin(pin,options.policy,pin))),prepared=verifyPreparedDocument(parsed,parsed);
    await assertPreparedSourcesActive(prepared.references,options.policy);
    if(prepared.municipalityId!==record.municipalityId||prepared.sourceSha256!==record.extraction.inputSha256||prepared.textSha256!==record.extraction.textSha256||record.extraction.chunk.end>prepared.textLength)throw Error('Current prepared receipt does not bind the original record source/text');
    current.push(prepared);preparedReceipts.push(prepared);bindings.push(...preparedSourceBindings(prepared.references,prepared.receiptSha256));
   }
   for(const source of record.sources)if(!current.some(prepared=>prepared.sourceSha256===source.sha256&&prepared.mimeType===source.mimeType&&prepared.references.some(reference=>reference.id===source.id&&reference.url===source.url&&reference.sha256===source.sha256&&reference.mimeType===source.mimeType)))throw Error('Current prepared references do not cover every original source identity');
   const hold=knowledgePublicationHold(record);
   if(hold){publicationHolds.push(knowledgePublicationQuarantineCase(record,hold));continue;}
   recordIds.push(record.id);currentAdmissions.push({basis:'native_prepared',runId:run.runId,recordId:record.id,originalEvidenceHash:record.verification.evidenceHash,preparedReceiptSha256s:[...new Set(current.map(prepared=>prepared.receiptSha256))].sort(),checkedAt:new Date().toISOString()});
  }
  contributions.push(contribution);admissions.push({runId:run.runId,recordIds,...(run.schemaProjection?{schemaProjection:run.schemaProjection}:{})});
 }
 const composition=composeDistrictRelease({contributions,approvedRunOrder:options.approvedRunOrder,admissions,generatedAt:options.generatedAt,...(retainedPublication?{retainedPublication}:{})});
 const knowledge=validateKnowledgeRelease(composition.records,registry);
 if(!knowledge.records.length)throw Error('No passing knowledge records');
 assertKnowledgeSlice(registry,knowledge.records,options.minimumPerDistrict);
 const quarantine={...composition.quarantine,cases:[...composition.quarantine.cases,...publicationHolds]};
 const coverage=buildDistrictCoverage(registry,composition.crawl,knowledge.records,quarantine,composition.lineage,options.generatedAt,composition.retainedPublication);
 assertPublicUrls({registry,records:knowledge,coverage});
 for(const prepared of preparedReceipts)await assertPreparedSourcesActive(prepared.references,options.policy);
 const sourceBindings=[...new Map(bindings.map(binding=>[JSON.stringify(binding),binding])).values()];
 const managed={decisionId:CIVIC_ACQUISITION_DECISION_ID,...options.policy};
 const outputPins:KnowledgeSourcePin[]=[];
 for(const [name,value] of [['registry',registry],['records',knowledge],['coverage',coverage]] as const){
  const path=join(options.output.stagingDir,name+'.json'),bytes=Buffer.byteLength(JSON.stringify(value,null,2)+'\n');
  const digest=await writeManagedSourceJson(options.output.root,path,value,sourceBindings,managed);outputPins.push(knowledgeSourcePinSchema.parse({path,sha256:digest,bytes,bindings:sourceBindings}));
 }
 const retainedIdentity=retainedBaseline?{releaseId:retainedBaseline.lineage.releaseId,manifestSha256:retainedBaseline.lineage.manifestSha256}:null;
 const candidateRecords={schemaVersion:'stadtstack-intake-candidate-records-v1',retainedPublication:retainedPublication?{...retainedIdentity,artifactSha256:retainedPublication.artifacts.records.sha256,records:decoded(retainedPublication.artifacts.records)}:null,runs:contributions.map(run=>({runId:run.runId,artifactSha256:run.artifacts.records.sha256,records:decoded(run.artifacts.records)}))};
 const candidateQuarantine={schemaVersion:'stadtstack-intake-candidate-quarantine-v1',retainedPublication:retainedIdentity?{...retainedIdentity,privateQuarantineAvailability:'not_supplied'}:null,runs:contributions.map(run=>({runId:run.runId,artifactSha256:run.artifacts.quarantine.sha256,quarantine:decoded(run.artifacts.quarantine)}))};
 const privatePins:Record<string,KnowledgeSourcePin>={};
 for(const [name,value] of [['candidate-records',candidateRecords],['candidate-quarantine',candidateQuarantine],['quarantine',quarantine],['provenance',{...composition.provenance,retainedPublication:composition.retainedPublication}],['crawl',composition.crawl]] as const){
  const path=join(options.output.root,'intake',name+'.json'),bytes=Buffer.byteLength(JSON.stringify(value,null,2)+'\n');
  privatePins[name]=knowledgeSourcePinSchema.parse({path,sha256:await writeManagedSourceJson(options.output.root,path,value,sourceBindings,managed),bytes,bindings:sourceBindings});
 }
 const receipt=knowledgePreparationInputsSchema.parse({schemaVersion:'stadtstack-knowledge-preparation-inputs-v1',dependencies:[{role:'registry',sha256:options.registry.sha256},{role:'candidate_records',sha256:privatePins['candidate-records'].sha256},{role:'candidate_quarantine',sha256:privatePins['candidate-quarantine'].sha256}],outputs:outputPins.map((pin,index)=>({path:['knowledge/registry.json','knowledge/records.json','knowledge/coverage.json'][index],sha256:pin.sha256,bytes:pin.bytes}))});
 const auditPins:Record<string,KnowledgeAuditPin>={};
 for(const [name,value] of [['knowledge-preparation-inputs',receipt],['text-lineage',composition.lineage],['retained-publication-lineage',retainedBaseline?{...retainedBaseline.lineage,selectedRecordOrigins:composition.retainedPublication?.selectedRecordOrigins??[]}:null],['composition-audit',composition.audit],['current-admissions',{schemaVersion:'stadtstack-knowledge-current-admissions-v2',authorityId:authority.authorityId,authoritySha256:authority.authoritySha256,records:currentAdmissions}]] as const){
  const path=join(options.output.auditDir,name+'.json');auditPins[name]={path,sha256:await writePrivateJson(path,value),bytes:Buffer.byteLength(JSON.stringify(value,null,2)+'\n')};
 }
 return {schemaVersion:knowledge.schemaVersion,records:knowledge.records.length,municipalities:coverage.accounting.publishedMunicipalities,accounting:coverage.accounting,districts:coverage.districts,municipalityCoverage:projectDistrictCoverage(coverage).municipalities,outputs:outputPins,privateArtifacts:privatePins,audit:auditPins,preparationReceipt:auditPins['knowledge-preparation-inputs']};
}

export async function prepareKnowledgeMain(argv:string[]){
 const {values}=parseArgs({args:argv,options:{config:{type:'string'},'config-sha256':{type:'string'}}});
 if(!values.config||!values['config-sha256'])throw Error('Usage: --config PATH --config-sha256 SHA256; explicit managed cache-only inputs required');
 const authority=await assertCivicPolicyAuthority(CIVIC_POLICY_AUTHORITY);
 const bytes=await readFile(resolve(values.config));
 if(sha256(bytes)!==hashSchema.parse(values['config-sha256']))throw Error('Knowledge intake config byte pin mismatch');
 const options=prepareKnowledgeOptionsSchema.parse(JSON.parse(bytes.toString('utf8')));
 if(options.policy.authorityId!==authority.authorityId||options.policy.authoritySha256!==authority.authoritySha256||resolve(options.policy.stateDir)!==resolve(CIVIC_POLICY_AUTHORITY.stateDir))throw Error('Native knowledge intake requires the authoritative VM policy');
 return prepareKnowledge(options);
}
if(process.argv[1]&&await realpath(process.argv[1]).then(entry=>import.meta.url===pathToFileURL(entry).href,()=>false)){
 try{console.log(JSON.stringify(await prepareKnowledgeMain(process.argv.slice(2))));}catch(error){console.error(error instanceof Error&&error.message.startsWith('Usage:')?error.message:'Managed knowledge intake failed; inspect pinned input identities and current source authority');process.exitCode=1;}
}
