import {join,resolve,dirname,basename} from 'node:path';
import {readFile,realpath} from 'node:fs/promises';
import {diff,retainChanges,signalChangeRecord,knowledgeChangeRecord,knowledgeChanges,validateChanges,changeSnapshotHash,type ChangeRecord} from './changes.ts';
import {cacheDir,outDir as defaultOutDir,save,root} from './common.ts';
import {validatePublication,catalogueSchema,cityFeedSchema,collectionSchema} from './schema.ts';
import {compactCollection} from './min.ts';
import type {Catalogue,FeatureCollection,CityFeed} from './schema.ts';
import {hash} from './common.ts';
import {validateCore} from './core.ts';
import type {CoreBundle} from './core-schema.ts';
import {normalizePublicationSignals,assertPublicUrls} from './publication-quality.ts';
import {normalizeRegionalPublication} from './regional-quality.ts';
import {sourceHealth,cityTemporalCoverage,assertSourceHealth} from './source-health.ts';
import {publishDataRelease} from './data-release.ts';
import {districtRegistrySchema} from './district-registry.ts';
import {validateKnowledgeRelease} from './district-schema.ts';
import {districtCoverageSchema,validateDistrictCoverage,assertKnowledgeSlice} from './district-publication.ts';
import {buildKnowledgeGraph,graphIdentityInputs} from './district-graph.ts';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {parseArgs} from 'node:util';
import {identityDaySchema} from './district-entity-resolution.ts';
import {publicationInputsSchema,publicationStagingPathSchema,knowledgePreparationInputsSchema,sealPublicationInputs,verifyPublicationStaging,verifyPublicationPolicyReceipts,requiredPublicationStaging,type PublicationDependency} from './district-publication-inputs.ts';
import {priorReleaseSchema,loadPriorPublicationRelease,type PriorReleaseCache} from './district-publication-predecessor.ts';
import {recheckPublicationPolicy} from './district-publication-policy.ts';
import {admitPublicationIdentities} from './district-publication-identity.ts';
import {structuredRunSchema,verifyStructuredRunReceipts,projectStructuredCoverageReceipt,structuredReceiptMatches} from './district-structured-run.ts';
import {DistrictCas} from './district-cas.ts';
import {canonicalJson,semanticHash} from './district-adapter-contract.ts';
import {assertHostNotOptedOut,readCivicOptOutSnapshot} from './civic-opt-out.ts';
import type {DistrictKnowledgeRecord} from './district-schema.ts';
import {loadPolicyReceipt,recheckPolicyReceipt} from './district-policy-receipt.ts';
import {admitCriticalKnowledge,assertCriticalAdmissionsBound} from './district-critical-assessment.ts';
import {CriticalAdmissionsSchema} from './district-critical-assessment-contract.ts';
import {readBoundSourceObservation} from './source-observation.ts';
import {CIVIC_ACQUISITION_DECISION_ID} from './civic-opt-out.ts';
import {parserIsolationContractSha256} from './district-parser-isolation.ts';

export const PublicationOptionsSchema=z.object({stagingDir:z.string().min(1),outDir:z.string().min(1),asOf:identityDaySchema,priorRelease:priorReleaseSchema,legacyPreviousReleases:z.record(z.string().regex(/^[a-z0-9-]+$/),priorReleaseSchema).optional(),policyReceipts:z.string().min(1),regionalPolicyReceipts:z.string().min(1).optional(),identityAssessments:z.string().min(1).optional(),criticalAssessments:z.string().min(1).optional(),structuredRun:z.string().min(1).optional(),casRoot:z.string().min(1).optional(),policyStateDir:z.string().min(1).optional(),policyAuthorityId:z.string().min(1).optional(),policyAuthoritySha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),qualityGeneratedAt:z.iso.datetime(),manifestGeneratedAt:z.iso.datetime(),offlineReplay:z.boolean().optional(),priorCityRoot:z.string().min(1).optional(),publicationInputs:z.string().min(1).optional()}).strict().superRefine((value,ctx)=>{if(value.offlineReplay&&(!value.priorCityRoot||!value.publicationInputs))ctx.addIssue({code:'custom',message:'Exact replay requires authentic staged predecessor and original publication input seal'});});
export type PublicationOptions=z.infer<typeof PublicationOptionsSchema>;
/** Live and replay publication both require complete staging, never mutable target output fallbacks. */
export async function publicationInput(path:string,options:PublicationOptions):Promise<unknown>{
 publicationStagingPathSchema.parse(path);
 return JSON.parse(await readFile(join(options.stagingDir,path),'utf8'));
}
async function publicationDirectory(path:string):Promise<string>{
 const absolute=resolve(path);
 try{return await realpath(absolute);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const parent=dirname(absolute);if(parent===absolute)throw error;return join(await publicationDirectory(parent),basename(absolute));}
}
export async function publish(input:PublicationOptions,predecessors?:PriorReleaseCache){
const options=PublicationOptionsSchema.parse(input),replay=options.offlineReplay===true,outDir=options.outDir;
const outputDirectory=await publicationDirectory(outDir),stageDirectory=await publicationDirectory(options.stagingDir),priorDirectory=options.priorCityRoot?await publicationDirectory(options.priorCityRoot):undefined,historicalDirectory=await publicationDirectory(defaultOutDir);
if(stageDirectory===outputDirectory||priorDirectory===outputDirectory||outputDirectory===historicalDirectory||replay&&(stageDirectory===historicalDirectory||priorDirectory===historicalDirectory))throw Error('Publication cannot use the target output as an input or replay destination');
const staging=new Map<string,Buffer>();
const sourceInput=async(path:string)=>{publicationStagingPathSchema.parse(path);const bytes=await readFile(join(options.stagingDir,path));staging.set(path,bytes);return JSON.parse(bytes.toString('utf8'));};
const catalogue=catalogueSchema.parse(await sourceInput('catalogue.json'));
requiredPublicationStaging(catalogue.cities.map(city=>city.id));
const priorPaths=[...catalogue.cities.flatMap(city=>[`cities/${city.id}/signals.geojson`,`cities/${city.id}/changes.json`]),'knowledge/records.json','core/strausberg-facts.json','core/release-manifest.json','core/handover-draft.json'];
const baseline=await loadPriorPublicationRelease(options.priorRelease,priorPaths,options.manifestGeneratedAt,undefined,predecessors);
if(options.priorCityRoot)for(const [path,bytes] of baseline.files)if(!bytes.equals(await readFile(join(options.priorCityRoot,path))))throw Error('Staged predecessor differs from authentic committed release');
const collections:Record<string,FeatureCollection>={},feeds:Record<string,unknown>={};
const cityQuality=[];
for(const city of catalogue.cities){
 const original=collectionSchema.parse(await sourceInput(join('cities',city.id,'signals.geojson')));
 const normalized=normalizePublicationSignals(original.features);
 collections[city.id]={type:'FeatureCollection',features:normalized.features};
 city.sources=city.sources.map(source=>sourceHealth(source,normalized.features));
 city.temporalCoverage=cityTemporalCoverage(normalized.features);
 cityQuality.push({cityId:city.id,...normalized.counts,quarantined:normalized.quarantined,sources:city.sources.map(source=>({id:source.id,status:source.status,recordCount:source.recordCount,publishedRecordCount:source.publishedRecordCount,coverage:source.coverage,licence:source.licence,licenceEvidence:source.licenceEvidence}))});
 feeds[city.id]=await sourceInput(join('cities',city.id,'feed.json'));
}
const regionalInput=await sourceInput('regions/brandenburg-mol/topics.json');
const cas=new DistrictCas(options.casRoot??join(cacheDir,'districts','cas'));
const policyOptions={...(options.policyStateDir?{stateDir:options.policyStateDir}:{}),...(options.policyAuthorityId?{authorityId:options.policyAuthorityId}:{}),...(options.policyAuthoritySha256?{authoritySha256:options.policyAuthoritySha256}:{})},publicationEpoch=await readCivicOptOutSnapshot(policyOptions);
const knowledgeRegistry=districtRegistrySchema.parse(await sourceInput('knowledge/registry.json'));
const regionalInventory=options.regionalPolicyReceipts?z.object({sources:z.array(z.object({sourceUrl:z.url(),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),receiptSha256:z.string().regex(/^[a-f0-9]{64}$/),currentReceiptSha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),observation:z.object({rawRoot:z.string().min(1),path:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/),mimeType:z.string().min(1),retrievedAt:z.iso.datetime(),checkedAt:z.iso.datetime(),status:z.number().int().min(200).max(399)}).strict()}).strict())}).strict().parse(JSON.parse(await readFile(resolve(options.regionalPolicyReceipts),'utf8'))):undefined;
const regional=await normalizeRegionalPublication(regionalInput,regionalInventory?async({url,sourceSha256})=>{
 const entries=regionalInventory.sources.filter(source=>source.sourceUrl===url&&source.sourceSha256===sourceSha256);if(entries.length!==1)return null;
 const entry=entries[0],proof=await loadPolicyReceipt(cas,entry.receiptSha256),currentProof=entry.currentReceiptSha256?await loadPolicyReceipt(cas,entry.currentReceiptSha256):undefined;
 if(proof.source.url!==url||proof.source.sha256!==sourceSha256)throw Error('Regional current-policy receipt source binding mismatch');
 await recheckPolicyReceipt(proof,{...policyOptions,evaluationAt:new Date().toISOString(),...(currentProof?{currentProof}:{})});
 const city=knowledgeRegistry.municipalities.find(city=>city.id===proof.scope.municipalityId&&city.ags===proof.scope.ags),registeredSource=city?.sources.find(source=>source.id===proof.scope.sourceId);
 if(!registeredSource)throw Error('Regional statement lacks its actual registered source scope');
 const rawRoot=await realpath(resolve(entry.observation.rawRoot)),admitted=await readBoundSourceObservation({rawRoot,document:{url,sha256:sourceSha256,mimeType:entry.observation.mimeType,retrievedAt:entry.observation.retrievedAt,checkedAt:entry.observation.checkedAt,status:entry.observation.status,observationPath:resolve(entry.observation.path)},policy:policyOptions,registeredSource});
 if(admitted.binding.receiptSha256!==entry.observation.sha256||admitted.observation.mimeType!==proof.source.mimeType)throw Error('Regional immutable observation differs from its original policy proof');
 return {url,bytes:admitted.sourceBytes,sourceContext:{...policyOptions,root:rawRoot,bindings:[admitted.binding],decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'fetch' as const,purpose:'document' as const}};
}:undefined);
const knowledge=validateKnowledgeRelease(await sourceInput('knowledge/records.json'),knowledgeRegistry);
const knowledgeCoverage=districtCoverageSchema.parse(await sourceInput('knowledge/coverage.json'));
const criticalProjection=CriticalAdmissionsSchema.parse(await sourceInput('knowledge/assessment-admissions.json'));
assertCriticalAdmissionsBound(knowledge.records,criticalProjection.admissions);
validateDistrictCoverage(knowledgeCoverage,knowledgeRegistry,knowledge.records);
assertKnowledgeSlice(knowledgeRegistry,knowledge.records);
const knowledgeBytes=staging.get('knowledge/records.json')!.toString('utf8');
const knowledgeGraph=buildKnowledgeGraph(knowledgeBytes,{asOf:options.asOf});
const validated=validatePublication(catalogue,collections);
const validatedFeeds:Record<string,CityFeed>=Object.fromEntries(Object.entries(feeds).map(([id,feed])=>[id,cityFeedSchema.parse(feed)]));
for(const city of catalogue.cities)if(validatedFeeds[city.id].cityId!==city.id)throw Error(`Wrong feed city for ${city.id}`);
assertSourceHealth(validated.catalogue,validated.collections);
assertPublicUrls({catalogue:validated.catalogue,collections:validated.collections,feeds:validatedFeeds,regional:regional.data,knowledgeRegistry,knowledge,knowledgeCoverage,knowledgeGraph});
const qualityReport={schemaVersion:'stadtstack-publication-quality-v1',generatedAt:options.qualityGeneratedAt,
 policy:{publicUrls:'required',councilBodyBinding:'required',emptySuccess:'forbidden',sourceEventDates:'required; unresolved comparison records quarantined',placeDates:'observation only; no invented event date',core:'authenticated retained release; no new raw PDF or model verification'},
 cities:cityQuality,regional:{input:regional.inputRecords,published:regional.publishedRecords,quarantined:regional.quarantined},
 knowledge:{published:knowledge.records.length,textModelRecords:knowledge.records.filter(record=>record.kind==='text_model').length,structuredRecords:knowledge.records.filter(record=>record.kind==='structured').length,municipalities:knowledgeCoverage.municipalities.filter(city=>city.publishedRecords>0).length,districts:knowledgeCoverage.districts,models:knowledgeCoverage.models,adapters:knowledgeCoverage.adapters,graph:{asOf:knowledgeGraph.asOf,entities:knowledgeGraph.entities.length,edges:knowledgeGraph.edges.length,recordsSha256:knowledgeGraph.recordsSha256},policy:'Text claims retain actual model/faithfulness provenance. Structured fields are replayed against original admitted native bytes and mapping contracts; no model score or prose quote is invented. Identity reviews use actual A/B/C source-bound reconciliation; not independent truth certification.'},
 summary:{publishedRecords:cityQuality.reduce((n,c)=>n+c.published,0)+regional.publishedRecords+knowledge.records.length,quarantinedRecords:cityQuality.reduce((n,c)=>n+c.quarantined.length,0)+regional.quarantined.length+knowledgeCoverage.municipalities.reduce((n,city)=>n+city.quarantinedRecords,0),cities:catalogue.cities.length,knowledgeMunicipalities:knowledgeCoverage.municipalities.filter(city=>city.publishedRecords>0).length,districts:knowledgeCoverage.districts.length,knowledgeTextModelRecords:knowledge.records.filter(record=>record.kind==='text_model').length,knowledgeStructuredRecords:knowledge.records.filter(record=>record.kind==='structured').length}};
// All required gates are validated before the first public output is replaced.
let core:CoreBundle|undefined;
if(validated.collections.strausberg){
 core=validateCore(await sourceInput('core/strausberg-facts.json'),validated.collections.strausberg);
 if(hash(staging.get('core/strausberg-facts.json')!)!==hash(baseline.files.get('core/strausberg-facts.json')!))throw Error('New core claims require governed acquisition; only the authenticated retained core is supported');
 if(validated.catalogue.coreBundle?.version!==core.version)throw Error('Catalogue/core release binding mismatch');
}
if(!core)throw Error('A full data release requires the selected Strausberg core facts');
const prepared=validated.catalogue.cities.map(city=>{
 const collection=validated.collections[city.id],full=JSON.stringify(collection,null,2)+'\n',min=JSON.stringify(compactCollection(collection))+'\n';
 city.minUrl=`cities/${city.id}/signals.min.geojson`;
 city.fullBytes=Buffer.byteLength(full);
 city.minBytes=Buffer.byteLength(min);
 return {city,collection,full,min};
});
const retainedCoreBytes=staging.get('core/strausberg-facts.json')!;
const retainedCoreManifest=z.object({schemaVersion:z.literal('stadtstack-core-release-v1'),bundleSha256:z.string().regex(/^[a-f0-9]{64}$/),bundleVersion:z.string().regex(/^[a-f0-9]{64}$/),corpus:z.object({fullPath:z.literal('cities/strausberg/signals.geojson'),fullSha256:z.string().regex(/^[a-f0-9]{64}$/),minPath:z.literal('cities/strausberg/signals.min.geojson'),minSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()}).passthrough().parse(JSON.parse(baseline.files.get('core/release-manifest.json')!.toString('utf8')));
if(retainedCoreManifest.bundleSha256!==hash(retainedCoreBytes)||retainedCoreManifest.bundleVersion!==core.version)throw Error('Retained core manifest binding mismatch');
const retainedCity=prepared.find(city=>city.city.id==='strausberg')!;
retainedCoreManifest.corpus.fullSha256=hash(retainedCity.full);retainedCoreManifest.corpus.minSha256=hash(retainedCity.min);
const handoff=knowledgePreparationInputsSchema.parse(JSON.parse(await readFile(join(options.stagingDir,'knowledge/preparation-inputs.json'),'utf8')));
for(const output of handoff.outputs){const bytes=staging.get(output.path);if(!bytes||bytes.length!==output.bytes||hash(bytes)!==output.sha256)throw Error('Prepared knowledge changed after its bound admission handoff');}
const originalInputs=options.publicationInputs?publicationInputsSchema.parse(JSON.parse(await readFile(resolve(options.publicationInputs),'utf8'))):undefined;
if(originalInputs&&originalInputs.asOf!==options.asOf)throw Error('Replay graph asOf differs from original publication inputs');
const inventory=JSON.parse(await readFile(resolve(options.policyReceipts),'utf8'));
const policy=await recheckPublicationPolicy(knowledge.records,inventory,cas,{evaluationAt:new Date().toISOString(),...(options.policyStateDir?{stateDir:options.policyStateDir}:{}),...(originalInputs?{originalPolicy:originalInputs.policy}:{})});
if(policy.optOutSnapshotSha256!==publicationEpoch.sha256)throw Error('Knowledge admission uses another current-policy epoch');
if(handoff.dependencies.find(dependency=>dependency.role==='policy_receipts')?.sha256!==policy.inventorySha256)throw Error('Publication policy inventory is not the authentic preparation input');
const identity=graphIdentityInputs(knowledge),assessmentInventory=options.identityAssessments?JSON.parse(await readFile(resolve(options.identityAssessments),'utf8')):{assertions:[]};
const admissions=await admitPublicationIdentities({assertions:identity.assertions,mentions:identity.mentions,additionalSourceHashes:identity.additionalSourceHashes,inventoryInput:assessmentInventory,cas,...(options.policyStateDir?{stateDir:options.policyStateDir}:{}),currentAdmissionReceipts:policy.currentAdmissionReceipts,originalAdmissions:knowledge.identityAdmissions});
if(handoff.dependencies.find(dependency=>dependency.role==='identity_assessments')?.sha256!==admissions.dependencySha256)throw Error('Identity assessment dependencies changed after preparation');
const criticalInventory=options.criticalAssessments?JSON.parse(await readFile(resolve(options.criticalAssessments),'utf8')):{records:[]};
const critical=await admitCriticalKnowledge(knowledge.records,criticalInventory,cas,{policyOptions,currentAdmissionReceipts:policy.currentAdmissionReceipts,originalAdmissions:criticalProjection.admissions});
if(critical.holds.length||handoff.dependencies.find(dependency=>dependency.role==='critical_assessments')?.sha256!==critical.dependencySha256)throw Error('Critical assessments changed or no longer admit the prepared records');
if(knowledgeCoverage.structuredRun){
 if(!options.structuredRun)throw Error('Native publication requires its actual structured run and receipts');
 const bytes=await readFile(resolve(options.structuredRun)),run=structuredRunSchema.parse(JSON.parse(bytes.toString('utf8')));
 if(handoff.dependencies.find(dependency=>dependency.role==='structured_run')?.sha256!==hash(bytes))throw Error('Structured run changed after preparation');
 const checked=await verifyStructuredRunReceipts(run,cas,{evaluationAt:new Date().toISOString(),...(options.policyStateDir?{stateDir:options.policyStateDir}:{}),currentAdmissionReceipts:policy.currentAdmissionReceipts});
 if(handoff.dependencies.find(dependency=>dependency.role==='structured_receipts')?.sha256!==checked.dependencySha256)throw Error('Native source receipts changed after preparation');
 const expectedCoverage=run.coverage.map(receipt=>({...projectStructuredCoverageReceipt(receipt),publishedRecords:knowledge.records.filter(record=>record.kind==='structured'&&structuredReceiptMatches(record,receipt)).length}));
 if(canonicalJson(expectedCoverage)!==canonicalJson(knowledgeCoverage.adapters))throw Error('Public native coverage differs from its controlled original-receipt projection');
}
const legacyBindings:unknown[]=[];
const cityChanges=new Map<string,string>();
for(const {city,collection} of prepared){
 const previous=collectionSchema.parse(JSON.parse(baseline.files.get(`cities/${city.id}/signals.geojson`)!.toString('utf8'))),current=collection.features.map(signalChangeRecord),beforeRecords=previous.features.map(signalChangeRecord);
 let changes,retained:string|undefined;
 if(changeSnapshotHash(beforeRecords)===changeSnapshotHash(current)){
  const priorBytes=baseline.files.get(`cities/${city.id}/changes.json`)!,feed=JSON.parse(priorBytes.toString('utf8'));
  let before:ChangeRecord[]|undefined;
  if(feed.schemaVersion!=='stadtstack-changes-v2'){
   const pin=options.legacyPreviousReleases?.[city.id];if(!pin)throw Error(`Legacy unchanged changes require an authentic earlier snapshot: ${city.id}`);
   const legacy=await loadPriorPublicationRelease(pin,[`cities/${city.id}/signals.geojson`],baseline.manifest.generatedAt,baseline.manifest.id,predecessors);
   before=collectionSchema.parse(JSON.parse(legacy.files.get(`cities/${city.id}/signals.geojson`)!.toString('utf8'))).features.map(signalChangeRecord);
   legacyBindings.push({cityId:city.id,...legacy.priorRelease});
  }
  changes=retainChanges(feed,current,before,[{cityId:city.id,recordType:'signal'}]);
  if(feed.schemaVersion==='stadtstack-changes-v2')retained=priorBytes.toString('utf8');
 }else changes=diff(beforeRecords,current,catalogue.generatedAt,[],[{cityId:city.id,recordType:'signal'}]);
 cityChanges.set(city.id,retained??JSON.stringify(changes,null,2)+'\n');
}
const oldKnowledge=z.object({records:z.array(z.object({id:z.string(),municipalityId:z.string(),verification:z.object({evidenceHash:z.string().regex(/^[a-f0-9]{64}$/)}).passthrough()}).passthrough())}).passthrough().parse(JSON.parse(baseline.files.get('knowledge/records.json')!.toString('utf8')));
const priorKnowledge=oldKnowledge.records as unknown as typeof knowledge.records;
const currentText=knowledge.records.filter((record):record is DistrictKnowledgeRecord=>record.kind==='text_model'),oldText=priorKnowledge.filter(record=>!('kind' in record)||record.kind==='text_model');
const textChanges=knowledgeChanges(oldText as DistrictKnowledgeRecord[],currentText,knowledge.generatedAt);
const explicit=textChanges.events.flatMap(event=>event.evidence&&event.targetRevision!==null&&(event.kind==='withdrawn'||event.kind==='superseded')?[{id:event.id,cityId:event.cityId,recordType:event.recordType,kind:event.kind,targetRevision:event.targetRevision,reason:event.reason,evidence:event.evidence}]:[]);
const knowledgeChangesFeed=validateChanges(diff(priorKnowledge.map(knowledgeChangeRecord),knowledge.records.map(knowledgeChangeRecord),knowledge.generatedAt,explicit,knowledgeRegistry.municipalities.map(city=>({cityId:city.id,recordType:'knowledge' as const}))),knowledge.records.map(knowledgeChangeRecord));
const dependencies:PublicationDependency[]=[...handoff.dependencies];
if(regionalInventory)dependencies.push({role:'regional_policy_receipts',sha256:semanticHash(regionalInventory.sources.map(({currentReceiptSha256,...original})=>original).sort((a,b)=>a.sourceUrl.localeCompare(b.sourceUrl)||a.sourceSha256.localeCompare(b.sourceSha256)))});
const contractGroups:{role:'publication_contract'|'graph_contract'|'schema_contract';files:string[]}[]=[{role:'publication_contract',files:['publish.ts','prepare-knowledge.ts','district-publication.ts','district-publication-inputs.ts','district-publication-policy.ts','district-publication-identity.ts','district-publication-predecessor.ts','district-critical-assessment.ts','district-critical-assessment-contract.ts','district-r1-text-composition.ts','text-run-lineage.ts','district-release-composition.ts','district-structured-run.ts','data-release.ts','changes.ts','publication-quality.ts','regional-quality.ts','regional-statement.ts','district-regional-statement-worker.ts','source-health.ts','core.ts','min.ts']},{role:'graph_contract',files:['district-graph.ts','district-graph-claims.ts','district-entity-resolution.ts']},{role:'schema_contract',files:['district-schema.ts','district-structured-record.ts','district-adapter-contract.ts']}];
for(const group of contractGroups)dependencies.push({role:group.role,sha256:semanticHash(await Promise.all(group.files.map(async file=>({file,sha256:hash(await readFile(join(root,'src',file)))}))))});
dependencies.push({role:'parser_contract',sha256:await parserIsolationContractSha256()},{role:'regional_contract',sha256:hash(await readFile(join(root,'regional','statements.mjs')))});
if(legacyBindings.length)dependencies.push({role:'legacy_city_changes',sha256:semanticHash(legacyBindings)});
const presealEpoch=await readCivicOptOutSnapshot({ ...policyOptions,authorityId:publicationEpoch.authorityId,authoritySha256:publicationEpoch.authoritySha256 });
if(presealEpoch.sha256!==publicationEpoch.sha256)throw Error('Current policy changed during whole-publication admission');
const publicationInputs=sealPublicationInputs({asOf:options.asOf,policy:policy.policy,dependencies,staging,priorRelease:baseline.priorRelease});
verifyPublicationStaging(publicationInputs,catalogue.cities.map(city=>city.id),staging);verifyPublicationPolicyReceipts(publicationInputs,knowledge.records.map(record=>record.id));
if(originalInputs&&canonicalJson(originalInputs)!==canonicalJson(publicationInputs))throw Error('Reconstructed publication inputs differ from original immutable seal');
const evidenceUrls=new Set<string>();
for(const collection of Object.values(validated.collections))for(const feature of collection.features)for(const source of feature.properties.sources){evidenceUrls.add(source.url);if(source.snapshotUrl)evidenceUrls.add(source.snapshotUrl);}
for(const feed of Object.values(validatedFeeds)){for(const source of feed.sources){evidenceUrls.add(source.url);if(source.pageUrl)evidenceUrls.add(source.pageUrl);}for(const item of feed.items){evidenceUrls.add(item.url);if(item.locationSource){evidenceUrls.add(item.locationSource.url);if(item.locationSource.geometrySourceUrl)evidenceUrls.add(item.locationSource.geometrySourceUrl);}}}
for(const topic of regional.data.topics)for(const municipality of topic.municipalities)for(const item of municipality.items)evidenceUrls.add(item.url);
for(const fact of core.facts)evidenceUrls.add(fact.source.url);
for(const record of knowledge.records)for(const source of record.kind==='structured'?[record.source,...record.supportingSources]:record.sources)evidenceUrls.add(source.url);
for(const url of evidenceUrls)await assertHostNotOptedOut(url,{...policyOptions,authorityId:publicationEpoch.authorityId,authoritySha256:publicationEpoch.authoritySha256});
const finalEpoch=await readCivicOptOutSnapshot({ ...policyOptions,authorityId:publicationEpoch.authorityId,authoritySha256:publicationEpoch.authoritySha256 });
if(finalEpoch.sha256!==publicationEpoch.sha256)throw Error('Current policy changed before release publication');
for(const {city,collection,full,min} of prepared){
 const directory=join(outDir,'cities',city.id),fullPath=join(directory,'signals.geojson'),changesPath=join(directory,'changes.json');
 await save(fullPath,full);
 await save(changesPath,cityChanges.get(city.id)!);
 await save(join(directory,'signals.min.geojson'),min);
 const feed=validatedFeeds[city.id];await save(join(directory,'feed.json'),JSON.stringify(feed,null,2)+'\n');
 if(!replay)console.log(city.id,collection.features.length,city.fullBytes,city.minBytes);
}
await save(join(outDir,'catalogue.json'),JSON.stringify(validated.catalogue,null,2)+'\n');
if(core){
 const bytes=staging.get('core/strausberg-facts.json')!;
 await save(join(outDir,'core','strausberg-facts.json'),bytes.toString('utf8'));
 await save(join(outDir,'core','release-manifest.json'),JSON.stringify(retainedCoreManifest,null,2)+'\n');
 await save(join(outDir,'core','handover-draft.json'),baseline.files.get('core/handover-draft.json')!.toString('utf8'));
}
await save(join(outDir,'regions','brandenburg-mol','topics.json'),JSON.stringify(regional.data,null,2)+'\n');
await save(join(outDir,'knowledge','records.json'),knowledgeBytes);
await save(join(outDir,'knowledge','assessment-admissions.json'),staging.get('knowledge/assessment-admissions.json')!.toString('utf8'));
for(const [name,data] of [['registry',knowledgeRegistry],['coverage',knowledgeCoverage],['graph',knowledgeGraph]] as const)await save(join(outDir,'knowledge',name+'.json'),JSON.stringify(data,null,2)+'\n');
await save(join(outDir,'quality-report.json'),JSON.stringify(qualityReport,null,2)+'\n');
await save(join(outDir,'knowledge','changes.json'),JSON.stringify(knowledgeChangesFeed,null,2)+'\n');
await save(join(outDir,'knowledge','publication-inputs.json'),JSON.stringify(publicationInputs,null,2)+'\n');
const releasePaths=['catalogue.json','quality-report.json','regions/brandenburg-mol/topics.json','core/strausberg-facts.json','core/release-manifest.json','core/handover-draft.json','knowledge/registry.json','knowledge/records.json','knowledge/coverage.json','knowledge/graph.json','knowledge/changes.json','knowledge/publication-inputs.json','knowledge/assessment-admissions.json',
 ...catalogue.cities.flatMap(city=>['signals.geojson','signals.min.geojson','feed.json','changes.json'].map(file=>`cities/${city.id}/${file}`))];
const commitEpoch=await readCivicOptOutSnapshot({ ...policyOptions,authorityId:publicationEpoch.authorityId,authoritySha256:publicationEpoch.authoritySha256 });
if(commitEpoch.sha256!==publicationEpoch.sha256)throw Error('Current policy changed before manifest commit');
const dataRelease=await publishDataRelease(outDir,releasePaths,qualityReport.summary,options.manifestGeneratedAt);
if(!replay)console.log('data release',dataRelease.id,qualityReport.summary);
const summary=[
 '# Stadtstack open-data snapshot',
 '',
 `As of: ${catalogue.generatedAt}. Publisher: ${catalogue.publisher}. This export contains separately attributed derived facts, not municipal endorsement, complete inventories, current operating-status guarantees, or third-party PDF/image reproductions.`,
 '',
 '## Attribution and reuse',
 '',
 ...catalogue.cities.flatMap(c=>[`${c.name} (${c.id}): ${c.sources.map(s=>`${s.id} — ${s.publisher}, ${s.licence}, ${s.reuse}${s.status==='failed'?' (failed; '+s.error+')':''}`).join('; ') || 'no source available'}`, '']),
 'OpenStreetMap place records are an ODbL 1.0 derivative database: © OpenStreetMap contributors, https://www.openstreetmap.org/copyright ; reuse and share-alike obligations apply to that separable subset. Source-specific licence and reuse metadata on each record controls other records; a public PDF is not itself an open-data licence. Ordinance facts are attributed under § 5 UrhG; council papers are short original factual summaries with outbound links, not copied attachments. Autobahn API licence is not verified. The city feeds contain only headlines, publisher names, publication/event dates and source links; feed licences are unknown, and no article body is reproduced. Treat feed items as attribution-linked factual notices, not licensed article text.',
 '',
 '## Compact map display',
 '',
 'Each city also publishes `signals.min.geojson` beside the full `signals.geojson`. Catalogue `minUrl` is relative to this catalogue; `fullBytes` and `minBytes` are exact UTF-8 file sizes. The compact map projection retains all features and stable ids/versions, with coordinates snapped to five decimals and line/polygon vertices simplified by Douglas–Peucker at ~4 m, keeping valid polygon topology. Sub-grid multipolygon components and holes can be omitted from the display geometry; the full file is unchanged. Each compact record carries `sourceCount`, one attributed `primarySource` and optional faithfulness score/threshold; exact locators, source hashes, all sources and review reasoning remain in the full feature retrievable by id. ODbL and all other source-specific rights apply equally to both projections.',
 '',
 '## Shared object identity',
 '',
 'CCF and live OParl records sharing the same upstream object URL become one council feature with a provider-independent `council:` id. HTTP/HTTPS and trailing slash variations are normalized; the newer upstream modification wins, but both archive and live source entries remain attributed. Nearby OSM nodes and ways with the same name/category are represented once with both ODbL sources. Repeated title and date alone do not prove identity: separate binding-plan polygons, highway segments and committee meetings may legitimately share them. On this first canonical-ID cutover, removed legacy `ccf:`/`oparl:` identifiers and added `council:` identifiers are a migration, not proof that proposals were withdrawn.',
 '',
 '## Automated core facts',
 '',
 'core/strausberg-facts.json and core/release-manifest.json bind three selected assertions to original PDF byte SHA-256, extractor/assertion versions, named deterministic checks and actual DeepEval/Codex faithfulness evidence (threshold 0.8). auto-verified means these automated gates passed, not human review or independent truth certification; the evidence uses one primary source per assertion, not independent corroboration. The 14 September 2026 lake value is historical, relative to Normalstau, and its source is dated 5 October 2026. Budget values are planned investment outlays, not actual spending. core/handover-draft.json is labelled not-sent: no poll result, municipal endorsement or council receipt is claimed. Original PDFs and extracted text stay in ignored cache.',
 '',
 '## Coverage and privacy',
 '',
 'Pilot-city coverage is source-specific. Council collection requests 24 months and records complete/partial/empty/failed coverage and body identity; it is not a claim of all proceedings. Missing source dates are quarantined from comparisons, not replaced by retrieval time. Highway information includes a ~25 km commuter margin; OSM places remain unverified observations. quality-report.json records withheld counts/reasons; release-manifest.json binds every public data file, including regional records, to one release identity. No private location or profile enters these public files.'
];
await save(join(outDir,'README.md'),summary.join('\n')+'\n');
return dataRelease;
}
if(process.argv[1]&&await realpath(process.argv[1]).then(entry=>import.meta.url===pathToFileURL(entry).href,()=>false)){
 const {values}=parseArgs({options:{'staging-dir':{type:'string',default:join(cacheDir,'staging')},'out-dir':{type:'string',default:join(cacheDir,'publication','r1','release')},'as-of':{type:'string'},'prior-release':{type:'string'},'legacy-previous-releases':{type:'string'},'policy-receipts':{type:'string'},'regional-policy-receipts':{type:'string'},'identity-assessments':{type:'string'},'critical-assessments':{type:'string'},'structured-run':{type:'string'},'cas-root':{type:'string'},'policy-state-dir':{type:'string'},'policy-authority-id':{type:'string'},'policy-authority-sha256':{type:'string'},'quality-generated-at':{type:'string'},'manifest-generated-at':{type:'string'}}});
 if(!values['prior-release']||!values['policy-receipts']||!values['as-of']||!values['quality-generated-at']||!values['manifest-generated-at'])throw Error('Publication requires --as-of, --prior-release, --policy-receipts and explicit quality/manifest clocks');
 await publish({stagingDir:values['staging-dir']!,outDir:values['out-dir']!,asOf:values['as-of']!,priorRelease:JSON.parse(await readFile(resolve(values['prior-release']),'utf8')),legacyPreviousReleases:values['legacy-previous-releases']?JSON.parse(await readFile(resolve(values['legacy-previous-releases']),'utf8')):undefined,policyReceipts:values['policy-receipts'],regionalPolicyReceipts:values['regional-policy-receipts'],identityAssessments:values['identity-assessments'],criticalAssessments:values['critical-assessments'],structuredRun:values['structured-run'],casRoot:values['cas-root'],policyStateDir:values['policy-state-dir'],policyAuthorityId:values['policy-authority-id'],policyAuthoritySha256:values['policy-authority-sha256'],qualityGeneratedAt:values['quality-generated-at'],manifestGeneratedAt:values['manifest-generated-at']});
}
