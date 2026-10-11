import {readFile,mkdir} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {z} from 'zod';
import {loadDistrictRegistry} from './district-registry.ts';
import {loadFrozenCorpus,groupCrawlDocuments,selectExtractionGroups,authorizedPilotCorpusSchema} from './district-corpus.ts';
import {assertSubscriptionSourcePolicy,hashSchema,sha256} from './district-schema.ts';
import {safeFailure} from './district-claims.ts';
import {PreparedDocumentSchema,PREPARED_VM_ROOT,prepareDocument,verifyPreparedDocument,readAuthorizedSourceBytes,collectPreparationToolVersions,preparationExtractorSha256,cachePreparedDocument,type PreparedSourceReference} from './district-prepared-document.ts';
import {municipalityBindingSchema,quarantineCaseSchema,type QuarantineCase} from './district-inference.ts';
import {writePrivateJson} from './district-private-io.ts';

export const VM_PROJECT='/home/max/civic-knowledge-slice/stadtstack-data';
export const VM_NODE='/home/max/.local/share/mise/installs/node/24.21.0/bin/node';
export const VM_RESULT_ROOT=VM_PROJECT+'/cache/district-joint/results';
export const preparedExpectationSchema=PreparedDocumentSchema.pick({receiptSha256:true,municipalityId:true,sourceSha256:true,extractorSha256:true,references:true,toolVersions:true}).strict();
export const preparationGroupSchema=z.object({municipality:municipalityBindingSchema,documentIds:z.array(z.string()).min(1),expected:preparedExpectationSchema,referenceWarnings:z.array(z.object({documentId:z.string(),sourceId:z.string(),reason:z.string()}).strict())}).strict();
export const preparationPlanSchema=z.object({schemaVersion:z.literal('stadtstack-preparation-plan-v1'),generatedAt:z.iso.datetime(),corpusSha256:authorizedPilotCorpusSchema,registrySha256:hashSchema,extractorSha256:hashSchema,maxDocumentsPerMunicipality:z.number().int().positive().nullable(),availableDocumentGroups:z.number().int().nonnegative(),selectedDocumentGroups:z.number().int().nonnegative(),selectedRepresentations:z.number().int().nonnegative(),municipalities:z.array(municipalityBindingSchema.extend({availableDocumentGroups:z.number().int().nonnegative(),selectedDocumentGroups:z.number().int().nonnegative(),selectedRepresentations:z.number().int().nonnegative()})),groups:z.array(preparationGroupSchema),quarantine:z.array(quarantineCaseSchema)}).strict();
export type PreparationPlan=z.infer<typeof preparationPlanSchema>;
export type PreparationGroup=z.infer<typeof preparationGroupSchema>;
export async function prepareFrozenCorpus(options:{index:string;expectedIndexSha256:string;registry:string;rawRoot:string;maxDocumentsPerMunicipality?:number}):Promise<{plan:PreparationPlan;planSha256:string;path:string}>{
 if(process.platform!=='linux')throw Error('Frozen source preparation runs on the authorized VM');
 const corpus=await loadFrozenCorpus(options.index,options.expectedIndexSha256),registryBytes=await readFile(options.registry),registry=await loadDistrictRegistry(options.registry);
 const available=groupCrawlDocuments(corpus.documents),seeds=registry.municipalities.flatMap(municipality=>municipality.seedDocuments.map(seed=>({municipalityId:municipality.id,sourceId:seed.sourceId,url:seed.url})));
 const selected=selectExtractionGroups(corpus.documents,seeds,options.maxDocumentsPerMunicipality),extractorSha256=await preparationExtractorSha256();
 const groups:PreparationGroup[]=[],quarantine:QuarantineCase[]=[],toolVersions=new Map<string,Record<string,string>>();
 await mkdir(join(PREPARED_VM_ROOT,'indexes'),{recursive:true,mode:0o700});
 for(const documents of selected){
  const first=documents[0],municipality=registry.municipalities.find(item=>item.id===first.municipalityId),references:PreparedSourceReference[]=[],warnings:PreparationGroup['referenceWarnings']=[];
  let sourcePath:string|undefined,mimeType:string|undefined;
  for(const document of documents){
   try{
    const source=municipality?.sources.find(item=>item.id===document.sourceId);
    if(!municipality||municipality.ags!==document.ags||municipality.districtId!==document.districtId||!source||source.checkState!=='checked'||!source.url)throw Error('Unbound source or municipality identity');
    const policy=assertSubscriptionSourcePolicy(document.policy,document);
    if(mimeType&&mimeType!==document.mimeType)throw Error('Source MIME conflict within identical-byte group');
    references.push({id:source.id,url:document.url,sha256:document.sha256,retrievedAt:document.retrievedAt,locator:`document-sha256:${document.sha256}`,mimeType:document.mimeType,sourceType:source.kind,policy});
    sourcePath??=resolve(dirname(resolve(options.index)),document.localPath);mimeType??=document.mimeType;
   }catch(error){warnings.push({documentId:document.id,sourceId:document.sourceId,reason:safeFailure(error)});}
  }
  try{
   if(!municipality||!sourcePath||!mimeType||!references.length)throw Error('Unbound source group has no permissible reference');
   const bytes=await readAuthorizedSourceBytes(options.rawRoot,sourcePath,first.sha256);
   let versions=toolVersions.get(mimeType);if(!versions){versions=await collectPreparationToolVersions(mimeType);toolVersions.set(mimeType,versions);}
   const key=sha256(JSON.stringify({municipalityId:municipality.id,sourceSha256:first.sha256,extractorSha256,versions,references})),indexPath=join(PREPARED_VM_ROOT,'indexes',key+'.json');
   let receipt;
   try{
    const pointer=z.object({receiptSha256:hashSchema}).strict().parse(JSON.parse(await readFile(indexPath,'utf8')));
    receipt=verifyPreparedDocument(JSON.parse(await readFile(join(PREPARED_VM_ROOT,pointer.receiptSha256+'.json'),'utf8')),{...pointer,municipalityId:municipality.id,sourceSha256:first.sha256,extractorSha256,references,toolVersions:versions},bytes);
   }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   if(!receipt){receipt=await prepareDocument({bytes,municipalityId:municipality.id,references,mimeType,extractorSha256,toolVersions:versions});await cachePreparedDocument(PREPARED_VM_ROOT,receipt);await writePrivateJson(indexPath,{receiptSha256:receipt.receiptSha256});}
   const expected={receiptSha256:receipt.receiptSha256,municipalityId:receipt.municipalityId,sourceSha256:receipt.sourceSha256,extractorSha256:receipt.extractorSha256,references:receipt.references,toolVersions:receipt.toolVersions};
   groups.push({municipality:{id:municipality.id,name:municipality.name,ags:municipality.ags,districtId:municipality.districtId},documentIds:documents.map(document=>document.id),expected,referenceWarnings:warnings});
  }catch(error){quarantine.push({documentId:first.id,municipalityId:first.municipalityId,sourceId:first.sourceId,sourceSha256:first.sha256,chunk:null,reason:safeFailure(error)});}
 }
 const plan=preparationPlanSchema.parse({schemaVersion:'stadtstack-preparation-plan-v1',generatedAt:new Date().toISOString(),corpusSha256:options.expectedIndexSha256,registrySha256:sha256(registryBytes),extractorSha256,maxDocumentsPerMunicipality:options.maxDocumentsPerMunicipality??null,availableDocumentGroups:available.length,selectedDocumentGroups:selected.length,selectedRepresentations:selected.reduce((n,group)=>n+group.length,0),municipalities:registry.municipalities.map(municipality=>({id:municipality.id,name:municipality.name,ags:municipality.ags,districtId:municipality.districtId,availableDocumentGroups:available.filter(group=>group[0].municipalityId===municipality.id).length,selectedDocumentGroups:selected.filter(group=>group[0].municipalityId===municipality.id).length,selectedRepresentations:selected.filter(group=>group[0].municipalityId===municipality.id).reduce((n,group)=>n+group.length,0)})),groups,quarantine});
 const encoded=JSON.stringify(plan,null,2)+'\n',planSha256=sha256(encoded),path=join(PREPARED_VM_ROOT,'plans',planSha256+'.json');
 await writePrivateJson(path,plan);
 return {plan,planSha256,path};
}
