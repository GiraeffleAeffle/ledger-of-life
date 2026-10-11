import {join,resolve,relative,isAbsolute,basename} from 'node:path';
import {readFile,realpath} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {z} from 'zod';
import {outDir as legacyOutDir} from './common.ts';
import {diff,retainChanges,signalChangeRecord,knowledgeChangeRecord,knowledgeChanges,changeSnapshotHash,type ChangeRecord} from './changes.ts';
import {validatePublication,cityFeedSchema,collectionSchema,type Catalogue,type FeatureCollection,type CityFeed} from './schema.ts';
import {compactCollection} from './min.ts';
import {validateCore} from './core.ts';
import {normalizePublicationSignals,assertPublicUrls} from './publication-quality.ts';
import {normalizeRegionalPublication} from './regional-quality.ts';
import {sourceHealth,cityTemporalCoverage,assertSourceHealth} from './source-health.ts';
import {dataReleaseSchema,dataReleaseId,requireReleaseFiles,type DataRelease} from './data-release.ts';
import {districtRegistrySchema} from './district-registry.ts';
import {DistrictKnowledgeRecordSchema,validateKnowledgeRelease,knowledgeEvidenceHash,hashSchema,sha256,type DistrictKnowledgeRecord} from './district-schema.ts';
import {districtCoverageSchema,validateDistrictCoverage,assertKnowledgeSlice} from './district-publication.ts';
import {buildKnowledgeGraph} from './district-graph.ts';
import {textLineageRecordSha256} from './text-run-lineage.ts';
import {knowledgePreparationInputsSchema,sealPublicationInputs,verifyPublicationStaging,verifyPublicationPolicyReceipts,type PublicationDependency,type PublicationInputs} from './district-publication-inputs.ts';
import {PublicationPlanSchema,encodePredecessorMetadata,type PublicationPlan} from './district-publication-plan.ts';
import {readPublicationAuditPin,readPublicationSourcePin,admitPublicationKnowledge,type PublicationAuditPin} from './district-publication-policy.ts';
import {readAuthenticatedGitSnapshotSourcePin} from './district-git-snapshot-import.ts';
import {readBoundSourceObservation} from './source-observation.ts';
import {verifyCorpusManifest} from './corpus-manifest.ts';
import {assertCivicPolicyAuthority,assertHostNotOptedOut,readCivicOptOutSnapshot,initializeManagedAcquisitionLane,CIVIC_POLICY_AUTHORITY,CIVIC_ACQUISITION_DECISION_ID,type CivicPolicyOptions} from './civic-opt-out.ts';
import {readPinnedJson,writeManagedSourceArtifact,type SourceArtifactBinding} from './district-private-io.ts';
import type {KnowledgeSourcePin} from './prepare-knowledge.ts';

export {PublicationPlanSchema};
export type {PublicationPlan};
const encoded=(value:unknown)=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const decoded=(bytes:Uint8Array):unknown=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
const contained=(root:string,path:string)=>{const name=relative(resolve(root),resolve(path));return !!name&&!name.startsWith('..')&&!isAbsolute(name);};
function bindings(...groups:SourceArtifactBinding[][]):SourceArtifactBinding[]{
 const unique=new Map<string,SourceArtifactBinding>();
 for(const binding of groups.flat()){
  if(binding.kind==='authenticated_git_snapshot')throw Error('Historical Git snapshot content cannot enter public artifacts');
  const derived={...binding,independentAllowed:false};unique.set(textLineageRecordSha256(derived),derived);
 }
 return [...unique.values()];
}
async function codeDependency(files:string[]):Promise<string>{
 const fileHashes=await Promise.all(files.map(async path=>({path,sha256:sha256(await readFile(new URL(path,import.meta.url)))})));
 return textLineageRecordSha256(fileHashes);
}
/** The private pre-cleanup snapshot contributes only identity/version/source hashes.
 * Its titles, summaries, geometry, URLs and old raw rows never enter publication. */
export function historicalSignalChangeRecords(input:unknown,cityId:string):ChangeRecord[]{
 const source=z.object({sha256:hashSchema.nullable()}).passthrough();
 const value=z.object({type:z.literal('FeatureCollection'),features:z.array(z.object({properties:z.object({id:z.string().min(1),cityId:z.literal(cityId),version:hashSchema,sources:z.array(source)}).passthrough()}).passthrough())}).passthrough().parse(input);
 return value.features.map(({properties:record})=>({id:record.id,cityId,recordType:'signal',revision:{version:record.version,evidenceHash:null,sourceHashes:[...new Set(record.sources.flatMap(item=>item.sha256?[item.sha256]:[]))].sort(),metricClaims:[]},sources:[],semanticEvidence:[]}));
}
function historicalKnowledge(input:unknown):DistrictKnowledgeRecord[]{
 const envelope=z.object({schemaVersion:z.enum(['stadtstack-knowledge-v2','stadtstack-knowledge-v3']),records:z.array(z.unknown())}).passthrough().parse(input);
 const fields=z.object(DistrictKnowledgeRecordSchema.shape);
 return envelope.records.map(raw=>{fields.parse(raw);const record=raw as DistrictKnowledgeRecord;if(record.verification.evidenceHash!==knowledgeEvidenceHash(record))throw Error('Authentic prior knowledge evidence hash mismatch');return record;});
}
async function priorRelease(plan:PublicationPlan,policy:CivicPolicyOptions){
 const manifestBytes=await readPublicationAuditPin(plan.priorRelease.manifest,policy),manifest=dataReleaseSchema.parse(decoded(manifestBytes));
 if(manifest.id!==plan.priorRelease.releaseId||dataReleaseId(manifest.files)!==manifest.id)throw Error('Authentic predecessor manifest identity mismatch');
 requireReleaseFiles(manifest,[]);
 const members=new Map<string,{bytes:Buffer;bindings:SourceArtifactBinding[]}>();
 for(const member of plan.priorRelease.members){
  if(members.has(member.memberPath))throw Error('Duplicate explicit predecessor member');
  const expected=manifest.files.find(file=>file.path===member.memberPath);
  if(!expected||expected.sha256!==member.pin.sha256||expected.bytes!==member.pin.bytes)throw Error('Predecessor member is not bound to the authentic manifest');
  let bytes:Buffer,sourceBindings:SourceArtifactBinding[]=[];
  if('metadata' in member){
   if(member.metadata.manifestSha256!==plan.priorRelease.manifest.sha256||member.metadata.releaseId!==manifest.id)throw Error('Predecessor metadata authorization differs from the original sealed member');
   // The strict role codec and manifest pin authenticate these bytes before use.
   // member.pin.path is an audit locator, never permission to open an ungoverned file.
   bytes=encodePredecessorMetadata(member.metadata);
   if(bytes.length!==expected.bytes||sha256(bytes)!==expected.sha256)throw Error('Predecessor metadata bytes differ from the original sealed member');
  }else{
   for(const binding of member.pin.bindings)if(binding.kind!=='retained_publication'||binding.publication.manifestSha256!==plan.priorRelease.manifest.sha256||binding.publication.releaseId!==manifest.id||binding.publication.memberPath!==member.memberPath||binding.publication.memberSha256!==expected.sha256||binding.publication.memberBytes!==expected.bytes)throw Error('Predecessor provenance is not the original sealed member');
   bytes=await readPublicationSourcePin(member.pin,policy);sourceBindings=member.pin.bindings;
  }
  members.set(member.memberPath,{bytes,bindings:sourceBindings});
 }
 return {manifest,members,get(path:string){const value=members.get(path);if(!value)throw Error('Missing explicit authenticated predecessor member: '+path);return value;}};
}
async function regionalResolver(plan:PublicationPlan,registry:z.infer<typeof districtRegistrySchema>,policy:CivicPolicyOptions,used:SourceArtifactBinding[]){
 if(!plan.regionalSources)return undefined;
 const input=plan.regionalSources;
 if(new Set(input.indexes.map(index=>index.name)).size!==input.indexes.length)throw Error('Regional corpus roots need unique index names');
 const verified=await verifyCorpusManifest({manifest:{path:input.manifest.path,sha256:input.manifest.sha256},indexes:input.indexes,policy});
 return async(source:{url:string;sourceSha256:string})=>{
  const selected=input.documents.filter(document=>document.url===source.url&&document.sourceSha256===source.sourceSha256);
  if(!selected.length)return null;
  if(selected.length!==1)throw Error('Regional source observation is ambiguous');
  const document=selected[0],root=input.indexes.find(index=>index.name===document.indexName)?.rawRoot;
  if(!root)throw Error('Regional source lacks an explicit corpus root');
  const rows=verified.records.filter(record=>record.url===source.url&&record.sha256===source.sourceSha256&&record.bodyState==='retained'&&record.http.bindingStatus==='bound'&&record.http.observationSha256===document.observation.sha256&&record.memberships.some(member=>member.name===document.indexName));
  if(rows.length!==1||!rows[0].casPath)throw Error('Regional source is not bound to its retained corpus observation');
  const row=rows[0],observationName=basename(document.observation.path);
  if(resolve(document.observation.path)!==resolve(root,'observations',observationName))throw Error('Regional observation escapes its explicit immutable observation root');
  const registered=registry.municipalities.find(city=>city.id===row.municipalityId)?.sources.find(candidate=>candidate.id===row.sourceId);
  if(!registered||registered.url!==row.sourceEndpoint)throw Error('Regional source is not bound to the current registered civic source');
  const admitted=await readBoundSourceObservation({rawRoot:root,document:{url:row.url,sha256:row.sha256,mimeType:row.contentType,retrievedAt:row.fetchedAt,checkedAt:row.checkedAt??undefined,status:row.http.status??undefined,observationPath:document.observation.path},policy,registeredSource:registered});
  if(admitted.binding.receiptSha256!==document.observation.sha256||!/html/i.test(admitted.observation.mimeType))throw Error('Regional immutable observation or HTML source binding rejected');
  await readPublicationAuditPin(document.observation,policy);
  used.push({...admitted.binding,independentAllowed:false});return {url:source.url,bytes:admitted.sourceBytes};
 };
}

/** Canonical publication consumes only explicit pinned, governed inputs. No source
 * acquisition, native model, old-output fallback or implicit Git lookup occurs. */
export async function publish(input:{plan:PublicationPlan;policy:CivicPolicyOptions}):Promise<{release:DataRelease;publicationInputs:PublicationInputs;policyReceipts:PublicationAuditPin}>{
 const plan=PublicationPlanSchema.parse(input.plan),authority=await assertCivicPolicyAuthority(input.policy),policy={...input.policy,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
 if(!contained(plan.output.managedRoot,plan.output.releaseDir)||resolve(plan.output.managedRoot)===resolve(legacyOutDir)||contained(legacyOutDir,plan.output.managedRoot)||contained(plan.output.managedRoot,plan.output.auditDir)||contained(plan.output.auditDir,plan.output.managedRoot)||resolve(plan.output.auditDir)===resolve(plan.output.managedRoot))throw Error('Publication requires isolated managed output and separate audit metadata; legacy out is read-only');
 const originalPins=[...plan.staging,...plan.priorRelease.members.map(member=>member.pin),plan.priorRelease.manifest,plan.knowledgePreparation,...plan.admissions.flatMap(item=>'prepared' in item?item.prepared:[]),...(plan.retainedPublication?[plan.retainedPublication.manifest,plan.retainedPublication.records,plan.retainedPublication.coverage,plan.retainedPublication.registry]:[]),...plan.legacyBaselines.map(item=>item.pin),...(plan.policyReceipts?[plan.policyReceipts]:[])];
 if(originalPins.some(pin=>resolve(pin.path)===resolve(plan.output.releaseDir)||contained(plan.output.releaseDir,pin.path)))throw Error('Publication output cannot enclose or replace original inputs');
 const staged=new Map<string,{bytes:Buffer;pin:KnowledgeSourcePin}>();
 for(const {memberPath,...pin} of plan.staging){if(staged.has(memberPath))throw Error('Duplicate publication staging member');staged.set(memberPath,{bytes:await readPublicationSourcePin(pin,policy),pin});}
 const stage=(path:string)=>{const value=staged.get(path);if(!value)throw Error('Missing explicit publication staging member: '+path);return value;};
 const catalogue=decoded(stage('catalogue.json').bytes) as Catalogue,collections:Record<string,FeatureCollection>={},feeds:Record<string,CityFeed>={},cityQuality=[];
 if(!catalogue||!Array.isArray(catalogue.cities))throw Error('Publication catalogue is missing');
 for(const city of catalogue.cities){
  const original=collectionSchema.parse(decoded(stage(`cities/${city.id}/signals.geojson`).bytes)),normalized=normalizePublicationSignals(original.features);
  collections[city.id]={type:'FeatureCollection',features:normalized.features};
  city.sources=city.sources.map(source=>sourceHealth(source,normalized.features));city.temporalCoverage=cityTemporalCoverage(normalized.features);
  cityQuality.push({cityId:city.id,...normalized.counts,quarantined:normalized.quarantined,sources:city.sources.map(source=>({id:source.id,status:source.status,recordCount:source.recordCount,publishedRecordCount:source.publishedRecordCount,coverage:source.coverage,licence:source.licence,licenceEvidence:source.licenceEvidence}))});
  feeds[city.id]=cityFeedSchema.parse(decoded(stage(`cities/${city.id}/feed.json`).bytes));if(feeds[city.id].cityId!==city.id)throw Error('Publication feed city mismatch');
 }
 const prior=await priorRelease(plan,policy),cityIds=catalogue.cities.map(city=>city.id),priorPaths=[...cityIds.flatMap(city=>[`cities/${city}/signals.geojson`,`cities/${city}/changes.json`]),'knowledge/records.json'].sort();
 requireReleaseFiles(prior.manifest,[...priorPaths,'core/strausberg-facts.json','core/release-manifest.json','core/handover-draft.json']);for(const path of priorPaths)prior.get(path);
 const registry=districtRegistrySchema.parse(decoded(stage('knowledge/registry.json').bytes)),knowledge=validateKnowledgeRelease(decoded(stage('knowledge/records.json').bytes),registry),coverage=districtCoverageSchema.parse(decoded(stage('knowledge/coverage.json').bytes));
 const regionalBindings:SourceArtifactBinding[]=[],resolver=await regionalResolver(plan,registry,policy,regionalBindings),regional=await normalizeRegionalPublication(decoded(stage('regions/brandenburg-mol/topics.json').bytes),resolver);
 validateDistrictCoverage(coverage,registry,knowledge.records);assertKnowledgeSlice(registry,knowledge.records);
 const preparation=knowledgePreparationInputsSchema.parse(decoded(await readPublicationAuditPin(plan.knowledgePreparation,policy)));
 for(const output of preparation.outputs){const actual=stage(output.path);if(output.sha256!==sha256(actual.bytes)||output.bytes!==actual.bytes.byteLength)throw Error('Knowledge output differs from exercised preparation receipt');}
 const admitted=await admitPublicationKnowledge({records:knowledge.records,admissions:plan.admissions,retainedPublication:plan.retainedPublication,auditDir:plan.output.auditDir,policyReceipts:plan.policyReceipts},policy);
 if(textLineageRecordSha256(coverage.retainedPublication)!==textLineageRecordSha256(admitted.retainedPublication))throw Error('Coverage retained origins differ from actual publication admission');
 const graph=buildKnowledgeGraph(stage('knowledge/records.json').bytes.toString('utf8')),validated=validatePublication(catalogue,collections);
 assertSourceHealth(validated.catalogue,validated.collections);
 const coreBytes=stage('core/strausberg-facts.json').bytes;
 if(sha256(coreBytes)!==sha256(prior.get('core/strausberg-facts.json').bytes))throw Error('New core claims require governed acquisition; only the authenticated retained core is supported');
 const core=validateCore(decoded(coreBytes),validated.collections.strausberg);
 if(validated.catalogue.coreBundle?.version!==core.version)throw Error('Catalogue/core release binding mismatch');
 assertPublicUrls({catalogue:validated.catalogue,collections:validated.collections,feeds,regional:regional.data,registry,knowledge,coverage,graph,core});
 const dependencies=new Map<string,PublicationDependency>(preparation.dependencies.map(item=>[item.role,item]));
 const dependency=(role:PublicationDependency['role'],sha256:string)=>dependencies.set(role,{role,sha256});
 dependency('policy_receipts',admitted.pin.sha256);
 dependency('publication_contract',await codeDependency(['publish.ts','district-publication-plan.ts','district-publication-inputs.ts','district-publication-policy.ts','retained-knowledge-lineage.ts','retained-knowledge-coverage.ts','district-release-composition.ts','district-publication.ts','district-retained-import.ts','district-git-snapshot-import.ts','district-registry-config.ts','source-observation.ts','publication-quality.ts','regional-quality.ts','changes.ts']));
 dependency('graph_contract',await codeDependency(['district-graph.ts','district-graph-claims.ts','mcp-source-identity.ts']));dependency('schema_contract',await codeDependency(['district-schema.ts','schema.ts','core-schema.ts']));
 dependency('legacy_city_changes',textLineageRecordSha256({prior:priorPaths.filter(path=>path.endsWith('/changes.json')).map(path=>({path,sha256:sha256(prior.get(path).bytes)})),earlier:plan.legacyBaselines.map(item=>({cityId:item.cityId,snapshot:item.pin.snapshot})).sort((a,b)=>a.cityId.localeCompare(b.cityId))}));
 if(plan.regionalSources)dependency('regional_policy_receipts',textLineageRecordSha256({manifestSha256:plan.regionalSources.manifest.sha256,observations:plan.regionalSources.documents.map(item=>({urlSha256:sha256(item.url),sourceSha256:item.sourceSha256,observationSha256:item.observation.sha256})).sort((a,b)=>a.urlSha256.localeCompare(b.urlSha256))}));
 const publicationInputs=sealPublicationInputs({asOf:plan.asOf,policy:{snapshotSha256:admitted.receipts.snapshotSha256,receipts:admitted.receipts.records.map(record=>({recordId:record.recordId,receiptSha256:textLineageRecordSha256(record)}))},dependencies:[...dependencies.values()],staging:new Map([...staged].map(([path,value])=>[path,value.bytes])),priorRelease:{gitCommit:plan.priorRelease.gitCommit,manifestSha256:plan.priorRelease.manifest.sha256,releaseId:prior.manifest.id,members:priorPaths.map(path=>prior.manifest.files.find(file=>file.path===path)!)},retainedPublication:admitted.retainedPublication});
 verifyPublicationStaging(publicationInputs,cityIds,new Map([...staged].map(([path,value])=>[path,value.bytes])));verifyPublicationPolicyReceipts(publicationInputs,knowledge.records.map(record=>record.id));
 const baselineByCity=new Map(plan.legacyBaselines.map(item=>[item.cityId,item.pin]));if(baselineByCity.size!==plan.legacyBaselines.length||plan.legacyBaselines.some(item=>!cityIds.includes(item.cityId)))throw Error('Historical baseline city inventory mismatch');
 const allBindings=bindings(...[...staged.values()].map(value=>value.pin.bindings),... [...prior.members.values()].map(value=>value.bindings),admitted.bindings,regionalBindings),outputs=new Map<string,{bytes:Buffer;bindings:SourceArtifactBinding[]}>();
 const put=(path:string,bytes:Buffer,sourceBindings:SourceArtifactBinding[])=>{if(outputs.has(path))throw Error('Duplicate public output');outputs.set(path,{bytes,bindings:bindings(sourceBindings.length?sourceBindings:allBindings)});};
 for(const city of validated.catalogue.cities){
  const path=`cities/${city.id}/signals.geojson`,collection=validated.collections[city.id],full=encoded(collection),min=Buffer.from(JSON.stringify(compactCollection(collection))+'\n'),current=collection.features.map(signalChangeRecord),previous=collectionSchema.parse(decoded(prior.get(path).bytes)).features.map(signalChangeRecord),changePath=`cities/${city.id}/changes.json`,oldFeed=decoded(prior.get(changePath).bytes),sourceBindings=bindings(stage(path).pin.bindings,prior.get(path).bindings);
  let changeBytes:Buffer;
  if(changeSnapshotHash(previous)===changeSnapshotHash(current)){
   const legacy=!(typeof oldFeed==='object'&&oldFeed!==null&&'schemaVersion' in oldFeed);
   const baseline=baselineByCity.get(city.id);
   if(legacy&&!baseline)throw Error('Legacy change reconstruction requires its authentic private Git snapshot');
   const earlier=legacy?historicalSignalChangeRecords(decoded(await readAuthenticatedGitSnapshotSourcePin(baseline!,policy)),city.id):undefined;
   const retained=retainChanges(oldFeed,current,earlier,[{cityId:city.id,recordType:'signal'}]);changeBytes=legacy?encoded(retained):prior.get(changePath).bytes;
  }else changeBytes=encoded(diff(previous,current,plan.clocks.manifestGeneratedAt,[],[{cityId:city.id,recordType:'signal'}]));
  city.minUrl=`cities/${city.id}/signals.min.geojson`;city.fullBytes=full.byteLength;city.minBytes=min.byteLength;
  put(path,full,sourceBindings);put(city.minUrl,min,sourceBindings);put(changePath,changeBytes,sourceBindings);put(`cities/${city.id}/feed.json`,encoded(feeds[city.id]),stage(`cities/${city.id}/feed.json`).pin.bindings);
 }
 const oldKnowledge=historicalKnowledge(decoded(prior.get('knowledge/records.json').bytes)),oldKnowledgeChanges=prior.members.get('knowledge/changes.json'),knowledgeScopes=[...new Set([...oldKnowledge,...knowledge.records].map(record=>record.municipalityId))].sort().map(cityId=>({cityId,recordType:'knowledge' as const}));
 let knowledgeChangeBytes:Buffer;
 if(oldKnowledgeChanges&&changeSnapshotHash(oldKnowledge.map(knowledgeChangeRecord))===changeSnapshotHash(knowledge.records.map(knowledgeChangeRecord))){retainChanges(decoded(oldKnowledgeChanges.bytes),knowledge.records.map(knowledgeChangeRecord),undefined,knowledgeScopes);knowledgeChangeBytes=oldKnowledgeChanges.bytes;}
 else knowledgeChangeBytes=encoded(knowledgeChanges(oldKnowledge,knowledge.records,plan.clocks.manifestGeneratedAt,knowledgeScopes));
 const qualityReport={schemaVersion:'stadtstack-publication-quality-v1',generatedAt:plan.clocks.qualityGeneratedAt,policy:{publicUrls:'required',councilBodyBinding:'required',emptySuccess:'forbidden',sourceEventDates:'required; unresolved comparison records quarantined',placeDates:'observation only; no invented event date',core:'authenticated retained release; no new raw PDF or model verification',authoritySha256:authority.authoritySha256},cities:cityQuality,regional:{input:regional.inputRecords,published:regional.publishedRecords,quarantined:regional.quarantined},knowledge:{published:knowledge.records.length,municipalities:coverage.municipalities.filter(city=>city.publishedRecords>0).length,districts:coverage.districts,models:coverage.models,graph:{entities:graph.entities.length,edges:graph.edges.length,recordsSha256:graph.recordsSha256},policy:'Original claims and actual model judgments, current source admission, sourced dates and authenticated multi-run lineage; no independent truth certification.'},summary:{publishedRecords:cityQuality.reduce((total,city)=>total+city.published,0)+regional.publishedRecords+knowledge.records.length,quarantinedRecords:cityQuality.reduce((total,city)=>total+city.quarantined.length,0)+regional.quarantined.length+coverage.municipalities.reduce((total,city)=>total+city.quarantinedRecords,0),cities:cityIds.length,knowledgeMunicipalities:coverage.municipalities.filter(city=>city.publishedRecords>0).length,districts:coverage.districts.length}};
 const coreManifest=z.object({schemaVersion:z.literal('stadtstack-core-release-v1'),bundleSha256:hashSchema,bundleVersion:hashSchema,corpus:z.object({fullPath:z.literal('cities/strausberg/signals.geojson'),fullSha256:hashSchema,minPath:z.literal('cities/strausberg/signals.min.geojson'),minSha256:hashSchema}).strict()}).passthrough().parse(decoded(prior.get('core/release-manifest.json').bytes));
 if(coreManifest.bundleSha256!==sha256(coreBytes)||coreManifest.bundleVersion!==core.version)throw Error('Retained core manifest binding mismatch');
 coreManifest.corpus.fullSha256=sha256(outputs.get(coreManifest.corpus.fullPath)!.bytes);coreManifest.corpus.minSha256=sha256(outputs.get(coreManifest.corpus.minPath)!.bytes);
 put('catalogue.json',encoded(validated.catalogue),allBindings);put('core/strausberg-facts.json',coreBytes,stage('core/strausberg-facts.json').pin.bindings);put('core/release-manifest.json',encoded(coreManifest),bindings(prior.get('core/release-manifest.json').bindings,stage('core/strausberg-facts.json').pin.bindings));put('core/handover-draft.json',prior.get('core/handover-draft.json').bytes,stage('core/strausberg-facts.json').pin.bindings);
 put('regions/brandenburg-mol/topics.json',encoded(regional.data),bindings(stage('regions/brandenburg-mol/topics.json').pin.bindings,regionalBindings));
 for(const name of ['registry','records','coverage'])put(`knowledge/${name}.json`,stage(`knowledge/${name}.json`).bytes,bindings(stage(`knowledge/${name}.json`).pin.bindings,admitted.bindings));
 put('knowledge/graph.json',encoded(graph),bindings(stage('knowledge/records.json').pin.bindings,admitted.bindings));put('knowledge/changes.json',knowledgeChangeBytes,bindings(prior.get('knowledge/records.json').bindings,stage('knowledge/records.json').pin.bindings,admitted.bindings));put('knowledge/publication-inputs.json',encoded(publicationInputs),allBindings);put('quality-report.json',encoded(qualityReport),allBindings);
 const files=[...outputs].map(([path,value])=>({path,sha256:sha256(value.bytes),bytes:value.bytes.byteLength})).sort((a,b)=>a.path.localeCompare(b.path)),release=dataReleaseSchema.parse({schemaVersion:'stadtstack-data-release-v1',id:dataReleaseId(files),generatedAt:plan.clocks.manifestGeneratedAt,files,quality:qualityReport.summary});
 const assertCurrent=async()=>{if((await readCivicOptOutSnapshot(policy)).sha256!==admitted.receipts.snapshotSha256)throw Error('Current source objection state differs from publication admission');for(const binding of allBindings)await assertHostNotOptedOut(binding.url,policy);};
 await assertCurrent();await initializeManagedAcquisitionLane(plan.output.managedRoot,{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',...policy});
 for(const [path,value] of outputs){await assertCurrent();await writeManagedSourceArtifact(plan.output.managedRoot,join(plan.output.releaseDir,path),value.bytes,value.bindings,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});}
 await assertCurrent();await writeManagedSourceArtifact(plan.output.managedRoot,join(plan.output.releaseDir,'release-manifest.json'),encoded(release),allBindings,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 return {release,publicationInputs,policyReceipts:admitted.pin};
}
export async function publishMain(argv=process.argv.slice(2)){
 const args=parseArgs({args:argv,options:{plan:{type:'string'},'plan-sha256':{type:'string'}},strict:true,allowPositionals:false});
 if(!args.values.plan||!args.values['plan-sha256'])throw Error('publish requires --plan PATH --plan-sha256 SHA256');
 const authority=await assertCivicPolicyAuthority(CIVIC_POLICY_AUTHORITY);if(authority.mode!=='codex-workstation-local'||process.platform!=='linux')throw Error('Publication CLI requires the authoritative Codex VM');
 const policy={...CIVIC_POLICY_AUTHORITY,authoritySha256:authority.authoritySha256},plan=PublicationPlanSchema.parse(await readPinnedJson(args.values.plan,args.values['plan-sha256']));
 const result=await publish({plan,policy});console.log(JSON.stringify({releaseId:result.release.id,files:result.release.files.length,publicationInputSha256:result.publicationInputs.inputSha256,policyReceipts:result.policyReceipts}));
}
if(process.argv[1]&&await realpath(process.argv[1]).then(entry=>import.meta.url===pathToFileURL(entry).href,()=>false))await publishMain();
