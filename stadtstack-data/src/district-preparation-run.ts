import {readFile,mkdir} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {z} from 'zod';
import {readOperatorRegistryInputPin,type OperatorRegistryInputPin} from './district-registry-config.ts';
import {loadFrozenCorpus,groupCrawlDocuments,selectExtractionGroups,authorizedPilotCorpusSchema} from './district-corpus.ts';
import {hashSchema,sha256} from './district-schema.ts';
import {safeFailure} from './district-claims.ts';
import {PreparedDocumentSchema,PREPARED_VM_ROOT,prepareDocument,verifyPreparedDocument,assertPreparedSourcesActive,preparedSourceBindings,collectPreparationToolVersions,preparationExtractorSha256,cachePreparedDocument,type PreparedSourceReference} from './district-prepared-document.ts';
import {municipalityBindingSchema,quarantineCaseSchema,type QuarantineCase} from './district-inference.ts';
import {writePrivateJson} from './district-private-io.ts';
import {assertCivicPolicyAuthority,assertManagedSourceReadable,assertManagedSourceBindings,initializeManagedAcquisitionLane,HostOptedOutError,CivicPolicyStateError,CIVIC_POLICY_AUTHORITY,type CivicPolicyOptions} from './civic-opt-out.ts';
import {APPROVED_OWNER_ROBOTS_OVERRIDE} from './source-policy.ts';
import {readBoundSourceObservation} from './source-observation.ts';

export const VM_PROJECT='/home/max/civic-knowledge-slice/stadtstack-data';
export const VM_NODE='/home/max/.local/share/mise/installs/node/24.21.0/bin/node';
export const VM_RESULT_ROOT=VM_PROJECT+'/cache/district-joint/owner-policy-2026-10-11/source-content/results';
export const preparedExpectationSchema=PreparedDocumentSchema.pick({receiptSha256:true,municipalityId:true,sourceSha256:true,extractorSha256:true,references:true,toolVersions:true}).strict();
export const preparationGroupSchema=z.object({municipality:municipalityBindingSchema,documentIds:z.array(z.string()).min(1),expected:preparedExpectationSchema,referenceWarnings:z.array(z.object({documentId:z.string(),sourceId:z.string(),reason:z.string()}).strict())}).strict();
export const preparationPlanSchema=z.object({schemaVersion:z.literal('stadtstack-preparation-plan-v1'),generatedAt:z.iso.datetime(),corpusSha256:authorizedPilotCorpusSchema,registrySha256:hashSchema,extractorSha256:hashSchema,maxDocumentsPerMunicipality:z.number().int().positive().nullable(),availableDocumentGroups:z.number().int().nonnegative(),selectedDocumentGroups:z.number().int().nonnegative(),selectedRepresentations:z.number().int().nonnegative(),municipalities:z.array(municipalityBindingSchema.extend({availableDocumentGroups:z.number().int().nonnegative(),selectedDocumentGroups:z.number().int().nonnegative(),selectedRepresentations:z.number().int().nonnegative()})),groups:z.array(preparationGroupSchema),quarantine:z.array(quarantineCaseSchema)}).strict();
export type PreparationPlan=z.infer<typeof preparationPlanSchema>;
export type PreparationGroup=z.infer<typeof preparationGroupSchema>;
export async function prepareFrozenCorpus(options:{index:string;expectedIndexSha256:string;registry:OperatorRegistryInputPin;rawRoot:string;maxDocumentsPerMunicipality?:number;policy?:CivicPolicyOptions}):Promise<{plan:PreparationPlan;planSha256:string;path:string}>{
 if(process.platform!=='linux')throw Error('Frozen source preparation runs on the authorized VM');
 const selectedPolicy=options.policy??CIVIC_POLICY_AUTHORITY,authority=await assertCivicPolicyAuthority(selectedPolicy),policy={...selectedPolicy,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
 const {bytes:registryBytes,registry}=await readOperatorRegistryInputPin(options.registry,policy);
 await assertManagedSourceReadable(options.index,policy);
 const corpus=await loadFrozenCorpus(options.index,options.expectedIndexSha256);
 await assertManagedSourceReadable(options.index,policy);
 const available=groupCrawlDocuments(corpus.documents),seeds=registry.municipalities.flatMap(municipality=>municipality.seedDocuments.map(seed=>({municipalityId:municipality.id,sourceId:seed.sourceId,url:seed.url})));
 const selected=selectExtractionGroups(corpus.documents,seeds,options.maxDocumentsPerMunicipality),extractorSha256=await preparationExtractorSha256();
 const groups:PreparationGroup[]=[],quarantine:QuarantineCase[]=[],toolVersions=new Map<string,Record<string,string>>();
 await initializeManagedAcquisitionLane(PREPARED_VM_ROOT,{decisionId:APPROVED_OWNER_ROBOTS_OVERRIDE.id,kind:'prepared',...policy});
 await mkdir(join(PREPARED_VM_ROOT,'indexes'),{recursive:true,mode:0o700});
 for(const documents of selected){
  const first=documents[0],municipality=registry.municipalities.find(item=>item.id===first.municipalityId),references:PreparedSourceReference[]=[],warnings:PreparationGroup['referenceWarnings']=[];
  let bytes:Buffer|undefined,mimeType:string|undefined;
  for(const document of documents){
   try{
    const source=municipality?.sources.find(item=>item.id===document.sourceId);
    if(!municipality||municipality.ags!==document.ags||municipality.districtId!==document.districtId||!source||source.checkState!=='checked'||!source.url)throw Error('Unbound source or municipality identity');
    if(resolve(dirname(resolve(options.index)),document.localPath)!==resolve(options.rawRoot,'sha256',document.sha256))throw Error('Frozen source path differs from its original managed CAS location');
    const admitted=await readBoundSourceObservation({rawRoot:options.rawRoot,document,policy,registeredSource:source}),sourcePolicy=admitted.policy;
    if(mimeType&&mimeType!==document.mimeType)throw Error('Source MIME conflict within identical-byte group');
    references.push({id:source.id,url:document.url,sha256:document.sha256,retrievedAt:document.retrievedAt,locator:`document-sha256:${document.sha256}`,mimeType:document.mimeType,sourceType:source.kind,policy:sourcePolicy});
    bytes??=admitted.sourceBytes;mimeType??=document.mimeType;
   }catch(error){if(error instanceof HostOptedOutError||error instanceof CivicPolicyStateError)throw error;warnings.push({documentId:document.id,sourceId:document.sourceId,reason:safeFailure(error)});}
  }
  try{
   if(!municipality||!bytes||!mimeType||!references.length)throw Error('Unbound source group has no permissible reference');
   await assertPreparedSourcesActive(references,policy);
   let versions=toolVersions.get(mimeType);if(!versions){versions=await collectPreparationToolVersions(mimeType);toolVersions.set(mimeType,versions);}
   const key=sha256(JSON.stringify({municipalityId:municipality.id,sourceSha256:first.sha256,extractorSha256,versions,references})),indexPath=join(PREPARED_VM_ROOT,'indexes',key+'.json');
   let receipt;
   try{
    const pointer=z.object({receiptSha256:hashSchema}).strict().parse(JSON.parse(await readFile(indexPath,'utf8')));
    await assertPreparedSourcesActive(references,policy);
    const path=join(PREPARED_VM_ROOT,pointer.receiptSha256+'.json'),bindings=preparedSourceBindings(references,pointer.receiptSha256);
    await assertManagedSourceBindings(path,bindings,policy);
    receipt=verifyPreparedDocument(JSON.parse(await readFile(join(PREPARED_VM_ROOT,pointer.receiptSha256+'.json'),'utf8')),{...pointer,municipalityId:municipality.id,sourceSha256:first.sha256,extractorSha256,references,toolVersions:versions},bytes);
    await assertManagedSourceBindings(path,bindings,policy);
   }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   if(!receipt){receipt=await prepareDocument({bytes,municipalityId:municipality.id,references,mimeType,extractorSha256,toolVersions:versions,managedRoot:PREPARED_VM_ROOT,policy});await cachePreparedDocument(PREPARED_VM_ROOT,receipt,{decisionId:APPROVED_OWNER_ROBOTS_OVERRIDE.id,...policy});await writePrivateJson(indexPath,{receiptSha256:receipt.receiptSha256});}
   const expected={receiptSha256:receipt.receiptSha256,municipalityId:receipt.municipalityId,sourceSha256:receipt.sourceSha256,extractorSha256:receipt.extractorSha256,references:receipt.references,toolVersions:receipt.toolVersions};
   groups.push({municipality:{id:municipality.id,name:municipality.name,ags:municipality.ags,districtId:municipality.districtId},documentIds:documents.map(document=>document.id),expected,referenceWarnings:warnings});
  }catch(error){if(error instanceof HostOptedOutError||error instanceof CivicPolicyStateError)throw error;quarantine.push({documentId:first.id,municipalityId:first.municipalityId,sourceId:first.sourceId,sourceSha256:first.sha256,chunk:null,reason:safeFailure(error)});}
 }
 const plan=preparationPlanSchema.parse({schemaVersion:'stadtstack-preparation-plan-v1',generatedAt:new Date().toISOString(),corpusSha256:options.expectedIndexSha256,registrySha256:sha256(registryBytes),extractorSha256,maxDocumentsPerMunicipality:options.maxDocumentsPerMunicipality??null,availableDocumentGroups:available.length,selectedDocumentGroups:selected.length,selectedRepresentations:selected.reduce((n,group)=>n+group.length,0),municipalities:registry.municipalities.map(municipality=>({id:municipality.id,name:municipality.name,ags:municipality.ags,districtId:municipality.districtId,availableDocumentGroups:available.filter(group=>group[0].municipalityId===municipality.id).length,selectedDocumentGroups:selected.filter(group=>group[0].municipalityId===municipality.id).length,selectedRepresentations:selected.filter(group=>group[0].municipalityId===municipality.id).reduce((n,group)=>n+group.length,0)})),groups,quarantine});
 const encoded=JSON.stringify(plan,null,2)+'\n',planSha256=sha256(encoded),path=join(PREPARED_VM_ROOT,'plans',planSha256+'.json');
 await assertPreparedSourcesActive(groups.flatMap(group=>group.expected.references),policy);
 await writePrivateJson(path,plan);
 return {plan,planSha256,path};
}
