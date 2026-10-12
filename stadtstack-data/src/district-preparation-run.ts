import {readFile,mkdir} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {z} from 'zod';
import {readOperatorRegistryInputPin,type OperatorRegistryInputPin} from './district-registry-config.ts';
import {loadFrozenCorpus,groupCrawlDocuments,selectExtractionGroups,authorizedPilotCorpusSchema} from './district-corpus.ts';
import {hashSchema,sha256} from './district-schema.ts';
import {safeFailure} from './district-claims.ts';
import {PreparedDocumentSchema,PREPARED_VM_ROOT,prepareDocument,readPreparedDocument,verifyPreparedDocument,assertPreparedSourcesActive,collectPreparationToolVersions,preparationExtractorSha256,cachePreparedDocument,preparedSourceBindings,type PreparedSourceReference} from './district-prepared-document.ts';
import {municipalityBindingSchema,quarantineCaseSchema,type QuarantineCase} from './district-inference.ts';
import {writePrivateJson} from './district-private-io.ts';
import {CIVIC_ACQUISITION_DECISION_ID,assertCivicPolicyAuthority,assertManagedSourceReadable,assertManagedSourceBindings,initializeManagedAcquisitionLane,withManagedSourceWrite,HostOptedOutError,CivicPolicyStateError,type CivicPolicyOptions,type ManagedSourceBinding} from './civic-opt-out.ts';
import {readBoundSourceObservation} from './source-observation.ts';

export const PREPARATION_ARTIFACT_ROOT=join(dirname(PREPARED_VM_ROOT),'preparation-artifacts');
export const preparedExpectationSchema=PreparedDocumentSchema.pick({receiptSha256:true,municipalityId:true,sourceSha256:true,extractorSha256:true,references:true,toolVersions:true}).strict();
export const preparationGroupSchema=z.object({municipality:municipalityBindingSchema,documentIds:z.array(z.string()).min(1),expected:preparedExpectationSchema,referenceWarnings:z.array(z.object({documentId:z.string(),sourceId:z.string(),reason:z.string()}).strict())}).strict();
export const preparationPlanSchema=z.object({schemaVersion:z.literal('stadtstack-preparation-plan-v1'),generatedAt:z.iso.datetime(),corpusSha256:authorizedPilotCorpusSchema,registrySha256:hashSchema,extractorSha256:hashSchema,maxDocumentsPerMunicipality:z.number().int().positive().nullable(),availableDocumentGroups:z.number().int().nonnegative(),selectedDocumentGroups:z.number().int().nonnegative(),selectedRepresentations:z.number().int().nonnegative(),municipalities:z.array(municipalityBindingSchema.extend({availableDocumentGroups:z.number().int().nonnegative(),selectedDocumentGroups:z.number().int().nonnegative(),selectedRepresentations:z.number().int().nonnegative()})),groups:z.array(preparationGroupSchema),quarantine:z.array(quarantineCaseSchema)}).strict();
export type PreparationPlan=z.infer<typeof preparationPlanSchema>;
export type PreparationGroup=z.infer<typeof preparationGroupSchema>;

export async function prepareFrozenCorpus(options:{index:string;expectedIndexSha256:string;registry:OperatorRegistryInputPin;rawRoot:string;maxDocumentsPerMunicipality?:number;policy?:CivicPolicyOptions;signal?:AbortSignal}):Promise<{plan:PreparationPlan;planSha256:string;path:string}>{
 if(process.platform!=='linux')throw Error('Frozen source preparation runs on the authorized VM');
 options.signal?.throwIfAborted();
 const authority=await assertCivicPolicyAuthority(options.policy),policy={...options.policy,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
 const preparedRoot=PREPARED_VM_ROOT,artifactRoot=PREPARATION_ARTIFACT_ROOT;
 const lane={...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID};
 for(const [path,kind] of [[preparedRoot,'prepared'],[artifactRoot,'artifacts']] as const){
  await mkdir(path,{recursive:true,mode:0o700});await initializeManagedAcquisitionLane(path,{...lane,kind});
 }
 await assertManagedSourceReadable(options.index,policy);
 const registryAdmission=await readOperatorRegistryInputPin(options.registry,policy),registryBytes=registryAdmission.bytes,registry=registryAdmission.registry;
 await assertManagedSourceBindings(options.index,registryAdmission.bindings,policy,'operator_registry_config');
 const corpus=await loadFrozenCorpus(options.index,options.expectedIndexSha256);
 await assertManagedSourceBindings(options.index,registryAdmission.bindings,policy,'operator_registry_config');
 const available=groupCrawlDocuments(corpus.documents),seeds=registry.municipalities.flatMap(municipality=>municipality.seedDocuments.map(seed=>({municipalityId:municipality.id,sourceId:seed.sourceId,url:seed.url})));
 const selected=selectExtractionGroups(corpus.documents,seeds,options.maxDocumentsPerMunicipality),extractorSha256=await preparationExtractorSha256();
 const groups:PreparationGroup[]=[],quarantine:QuarantineCase[]=[],toolVersions=new Map<string,Record<string,string>>(),acquisitionBindings:ManagedSourceBinding[]=[];
 for(const documents of selected){
  options.signal?.throwIfAborted();
  const first=documents[0],municipality=registry.municipalities.find(item=>item.id===first.municipalityId),references:PreparedSourceReference[]=[],warnings:PreparationGroup['referenceWarnings']=[],sourceBindings:ManagedSourceBinding[]=[];
  let bytes:Buffer|undefined,mimeType:string|undefined;
  for(const document of documents){
   try{
    options.signal?.throwIfAborted();
    const source=municipality?.sources.find(item=>item.id===document.sourceId);
    if(!municipality||municipality.ags!==document.ags||municipality.districtId!==document.districtId||!source||source.checkState!=='checked'||!source.url)throw Error('Unbound source or municipality identity');
    if(resolve(dirname(resolve(options.index)),document.localPath)!==resolve(options.rawRoot,'sha256',document.sha256))throw Error('Frozen source path differs from its original managed CAS location');
    const acquired=await readBoundSourceObservation({rawRoot:options.rawRoot,document,policy,registeredSource:source});
    if(mimeType&&mimeType!==document.mimeType)throw Error('Source MIME conflict within identical-byte group');
    references.push({id:source.id,url:document.url,sha256:document.sha256,retrievedAt:document.retrievedAt,locator:`document-sha256:${document.sha256}`,mimeType:document.mimeType,sourceType:source.kind,policy:acquired.policy});
    sourceBindings.push(acquired.binding);
    acquisitionBindings.push(acquired.binding);
    bytes??=acquired.sourceBytes;mimeType??=document.mimeType;
   }catch(error){options.signal?.throwIfAborted();if(error instanceof HostOptedOutError||error instanceof CivicPolicyStateError)throw error;warnings.push({documentId:document.id,sourceId:document.sourceId,reason:safeFailure(error)});}
  }
  try{
   options.signal?.throwIfAborted();
   if(!municipality||!bytes||!mimeType||!references.length)throw Error('Unbound source group has no permissible reference');
   const sourceContext={...lane,root:preparedRoot,kind:'prepared' as const,bindings:sourceBindings,purpose:'document' as const,signal:options.signal};
   let versions=toolVersions.get(mimeType);if(!versions){versions=await collectPreparationToolVersions(mimeType,sourceContext);toolVersions.set(mimeType,versions);}
   options.signal?.throwIfAborted();
   const key=sha256(JSON.stringify({municipalityId:municipality.id,sourceSha256:first.sha256,extractorSha256,versions,references})),relativeIndex=join('indexes',key+'.json'),indexPath=join(artifactRoot,relativeIndex);
   let receipt;
   try{
    await assertManagedSourceReadable(indexPath,policy);
    const pointer=z.object({receiptSha256:hashSchema}).strict().parse(JSON.parse(await readFile(indexPath,'utf8')));
    await assertManagedSourceReadable(indexPath,policy);
    receipt=await readPreparedDocument({...pointer,municipalityId:municipality.id,sourceSha256:first.sha256,extractorSha256,references,toolVersions:versions},policy);
    verifyPreparedDocument(receipt,receipt,bytes);
   }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   if(!receipt){
    receipt=await prepareDocument({bytes,municipalityId:municipality.id,references,mimeType,extractorSha256,toolVersions:versions,managedRoot:preparedRoot,policy,sourceBindings,signal:options.signal});
    await cachePreparedDocument(preparedRoot,receipt,lane);
    const pointer={receiptSha256:receipt.receiptSha256},contentSha256=sha256(JSON.stringify(pointer,null,2)+'\n');
    const bindings=preparedSourceBindings(receipt.references,receipt.receiptSha256).map(binding=>({...binding,relativePath:relativeIndex,contentSha256}));
    await withManagedSourceWrite(artifactRoot,bindings,()=>writePrivateJson(indexPath,pointer),policy);
   }
   options.signal?.throwIfAborted();
   const expected={receiptSha256:receipt.receiptSha256,municipalityId:receipt.municipalityId,sourceSha256:receipt.sourceSha256,extractorSha256:receipt.extractorSha256,references:receipt.references,toolVersions:receipt.toolVersions};
   groups.push({municipality:{id:municipality.id,name:municipality.name,ags:municipality.ags,districtId:municipality.districtId},documentIds:documents.map(document=>document.id),expected,referenceWarnings:warnings});
  }catch(error){options.signal?.throwIfAborted();if(error instanceof HostOptedOutError||error instanceof CivicPolicyStateError)throw error;quarantine.push({documentId:first.id,municipalityId:first.municipalityId,sourceId:first.sourceId,sourceSha256:first.sha256,chunk:null,reason:safeFailure(error)});}
 }
 options.signal?.throwIfAborted();
 const plan=preparationPlanSchema.parse({schemaVersion:'stadtstack-preparation-plan-v1',generatedAt:new Date().toISOString(),corpusSha256:options.expectedIndexSha256,registrySha256:sha256(registryBytes),extractorSha256,maxDocumentsPerMunicipality:options.maxDocumentsPerMunicipality??null,availableDocumentGroups:available.length,selectedDocumentGroups:selected.length,selectedRepresentations:selected.reduce((n,group)=>n+group.length,0),municipalities:registry.municipalities.map(municipality=>({id:municipality.id,name:municipality.name,ags:municipality.ags,districtId:municipality.districtId,availableDocumentGroups:available.filter(group=>group[0].municipalityId===municipality.id).length,selectedDocumentGroups:selected.filter(group=>group[0].municipalityId===municipality.id).length,selectedRepresentations:selected.filter(group=>group[0].municipalityId===municipality.id).reduce((n,group)=>n+group.length,0)})),groups,quarantine});
 const encoded=JSON.stringify(plan,null,2)+'\n',planSha256=sha256(encoded),relativePlan=join('plans',planSha256+'.json'),path=join(artifactRoot,relativePlan);
 const bindings=[...registryAdmission.bindings.map(binding=>({...binding,relativePath:relativePlan,contentSha256:planSha256})),...acquisitionBindings.map(binding=>({...binding,relativePath:relativePlan,contentSha256:planSha256,independentAllowed:false}))];
 if(!acquisitionBindings.length)throw Error('No authenticated acquisition binding is available for a managed preparation plan');
 await assertPreparedSourcesActive(groups.flatMap(group=>group.expected.references),policy);
 await withManagedSourceWrite(artifactRoot,bindings,()=>writePrivateJson(path,plan),policy);
 return {plan,planSha256,path};
}
