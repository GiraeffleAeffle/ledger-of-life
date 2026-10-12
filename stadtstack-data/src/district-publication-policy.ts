import {readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {hashSchema,sha256,type DistrictKnowledgeRecord} from './district-schema.ts';
import {textLineageRecordSha256,textSchemaProjectionSchema,type TextLineageArtifact} from './text-run-lineage.ts';
import {knowledgeSourcePinSchema,knowledgePreparedSourcePinSchema,knowledgeRetainedPublicationSourcePinSchema,type KnowledgeSourcePin} from './prepare-knowledge.ts';
import {PreparedDocumentSchema,verifyPreparedDocument,assertPreparedSourcesActive,preparedSourceBindings} from './district-prepared-document.ts';
import {assertCivicPolicyAuthority,assertHostNotOptedOut,assertManagedSourceReadable,assertManagedSourceBindings,readCivicOptOutSnapshot,type CivicPolicyOptions} from './civic-opt-out.ts';
import {writePrivateJson,type SourceArtifactBinding} from './district-private-io.ts';
import {authenticateRetainedKnowledgePublication,retainedKnowledgeRecordOrigin,RetainedKnowledgeLineageSchema,type RetainedKnowledgeLineage,type AuthenticatedRetainedKnowledgePublication} from './retained-knowledge-lineage.ts';

export const publicationAuditPinSchema=z.object({path:z.string().min(1),sha256:hashSchema,bytes:z.number().int().nonnegative().max(512*1024*1024)}).strict();
export type PublicationAuditPin=z.infer<typeof publicationAuditPinSchema>;
export const publicationRetainedBaselineSchema=z.object({manifest:publicationAuditPinSchema,records:knowledgeRetainedPublicationSourcePinSchema,coverage:knowledgeRetainedPublicationSourcePinSchema,registry:knowledgeRetainedPublicationSourcePinSchema,schemaProjection:textSchemaProjectionSchema.optional()}).strict();
export type PublicationRetainedBaseline=z.infer<typeof publicationRetainedBaselineSchema>;
export const publicationAdmissionSchema=z.union([
 z.object({recordId:z.string().min(1),prepared:z.array(knowledgePreparedSourcePinSchema).min(1)}).strict(),
 z.object({recordId:z.string().min(1),retainedPublication:z.object({originalEvidenceHash:hashSchema}).strict()}).strict(),
]);
export type PublicationAdmission=z.infer<typeof publicationAdmissionSchema>;
const sourceDecisionSchema=z.object({referenceIdSha256:hashSchema,urlSha256:hashSchema,sourceSha256:hashSchema,textSha256:hashSchema,preparedReceiptSha256:hashSchema,policySha256:hashSchema}).strict();
const retainedSourceDecisionSchema=z.object({referenceIdSha256:hashSchema,urlSha256:hashSchema,sourceSha256:hashSchema,originalPolicySha256:hashSchema}).strict();
const decisionFields={recordId:z.string().min(1),evidenceHash:hashSchema,checkedAt:z.iso.datetime(),decision:z.literal('admitted')};
const recordDecisionSchema=z.discriminatedUnion('basis',[
 z.object({...decisionFields,basis:z.literal('prepared_source'),sources:z.array(sourceDecisionSchema).min(1)}).strict(),
 z.object({...decisionFields,basis:z.literal('retained_publication'),publication:z.object({releaseId:hashSchema,manifestSha256:hashSchema,recordsSha256:hashSchema,coverageSha256:hashSchema,registrySha256:hashSchema,origin:RetainedKnowledgeLineageSchema.shape.selectedRecordOrigins.element}).strict(),sources:z.array(retainedSourceDecisionSchema).min(1)}).strict(),
]);
export const publicationPolicyReceiptsSchema=z.object({schemaVersion:z.literal('stadtstack-publication-policy-receipts-v2'),authorityId:z.string().min(1),authoritySha256:hashSchema,snapshotSha256:hashSchema,contractSha256:hashSchema,records:z.array(recordDecisionSchema)}).strict();
export type PublicationPolicyReceipts=z.infer<typeof publicationPolicyReceiptsSchema>;

export async function readPublicationAuditPin(pin:PublicationAuditPin,policy:CivicPolicyOptions):Promise<Buffer>{
 publicationAuditPinSchema.parse(pin);await assertCivicPolicyAuthority(policy);
 const metadata=await lstat(pin.path);
 if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size!==pin.bytes)throw Error('Publication input type or length differs from its pin');
 const bytes=await readFile(pin.path);
 if(bytes.byteLength!==pin.bytes||sha256(bytes)!==pin.sha256)throw Error('Publication input bytes differ from their pin');
 return bytes;
}
export async function readPublicationSourcePin(pin:KnowledgeSourcePin,policy:CivicPolicyOptions):Promise<Buffer>{
 knowledgeSourcePinSchema.parse(pin);
 for(const binding of pin.bindings)await assertHostNotOptedOut(binding.url,policy);
 await assertManagedSourceReadable(pin.path,policy);await assertManagedSourceBindings(pin.path,pin.bindings,policy);
 const bytes=await readPublicationAuditPin({path:pin.path,sha256:pin.sha256,bytes:pin.bytes},policy);
 await assertManagedSourceReadable(pin.path,policy);await assertManagedSourceBindings(pin.path,pin.bindings,policy);
 return bytes;
}
export async function publicationPolicyContractSha256():Promise<string>{
 const files=['district-publication-policy.ts','retained-knowledge-lineage.ts','retained-knowledge-coverage.ts','district-release-composition.ts','district-publication.ts','prepare-knowledge.ts','district-private-io.ts','source-policy.ts','document-origin.ts','document-origin-rules.ts','document-origin-contract.ts','civic-opt-out.ts','district-schema.ts','district-prepared-document.ts'];
 return textLineageRecordSha256(await Promise.all(files.map(async name=>({name,sha256:sha256(await readFile(new URL(name,import.meta.url)))}))));
}
async function readRetainedBaseline(input:PublicationRetainedBaseline,recordIds:string[],policy:CivicPolicyOptions){
 const pins=publicationRetainedBaselineSchema.parse(input);
 const artifacts:Record<'manifest'|'records'|'coverage'|'registry',TextLineageArtifact>={
  manifest:{sha256:pins.manifest.sha256,bytes:await readPublicationAuditPin(pins.manifest,policy)},
  records:{sha256:pins.records.sha256,bytes:await readPublicationSourcePin(pins.records,policy)},
  coverage:{sha256:pins.coverage.sha256,bytes:await readPublicationSourcePin(pins.coverage,policy)},
  registry:{sha256:pins.registry.sha256,bytes:await readPublicationSourcePin(pins.registry,policy)},
 };
 const baseline=authenticateRetainedKnowledgePublication({artifacts,recordIds,schemaProjection:pins.schemaProjection});
 for(const kind of ['records','coverage','registry'] as const){
  const member=baseline.lineage.members[kind];
  for(const binding of pins[kind].bindings)if(binding.publication.manifestSha256!==baseline.lineage.manifestSha256||binding.publication.releaseId!==baseline.lineage.releaseId||binding.publication.memberPath!==member.path||binding.publication.memberSha256!==member.sha256||binding.publication.memberBytes!==member.bytes)throw Error('Retained knowledge provenance differs from its authentic public cohort');
 }
 return {baseline,bindings:[...pins.records.bindings,...pins.coverage.bindings,...pins.registry.bindings]};
}
/** Exercises current authority/objection gates. Native claims require actual prepared
 * receipts; unchanged retained facts use only authentic sealed publication evidence.
 * Pinned original admission clocks may be reused only after every input is rechecked. */
export async function admitPublicationKnowledge(input:{records:DistrictKnowledgeRecord[];admissions:PublicationAdmission[];retainedPublication?:PublicationRetainedBaseline;auditDir:string;policyReceipts?:PublicationAuditPin},policy:CivicPolicyOptions):Promise<{pin:PublicationAuditPin;receipts:PublicationPolicyReceipts;bindings:SourceArtifactBinding[];retainedPublication:RetainedKnowledgeLineage|null}> {
 const authority=await assertCivicPolicyAuthority(policy),snapshot=await readCivicOptOutSnapshot(policy),contractSha256=await publicationPolicyContractSha256();
 const byId=new Map(input.admissions.map(item=>[item.recordId,publicationAdmissionSchema.parse(item)]));
 if(byId.size!==input.admissions.length||byId.size!==input.records.length||new Set(input.records.map(record=>record.id)).size!==input.records.length||input.records.some(record=>!byId.has(record.id)))throw Error('Publication needs an exact current admission inventory');
 const retainedIds=[...byId.values()].filter(request=>'retainedPublication' in request).map(request=>request.recordId);
 if(retainedIds.length&&!input.retainedPublication)throw Error('Retained admissions require the authentic public publication baseline');
 if(input.retainedPublication&&!retainedIds.length)throw Error('Unused retained publication baseline');
 let retained:AuthenticatedRetainedKnowledgePublication|null=null;
 const decisions:PublicationPolicyReceipts['records']=[],bindings:SourceArtifactBinding[]=[],retainedOrigins:RetainedKnowledgeLineage['selectedRecordOrigins']=[];
 if(input.retainedPublication){const admitted=await readRetainedBaseline(input.retainedPublication,retainedIds,policy);retained=admitted.baseline;bindings.push(...admitted.bindings);}
 for(const record of input.records){
  const request=byId.get(record.id)!;
  if('retainedPublication' in request){
   if(!retained)throw Error('Retained publication baseline missing');
   const index=retained.records.findIndex(original=>original.id===record.id),original=retained.records[index];
   if(!original||original.verification.evidenceHash!==request.retainedPublication.originalEvidenceHash)throw Error('Retained admission original evidence binding mismatch');
   const origin=retainedKnowledgeRecordOrigin(retained,index,record);
   await assertPreparedSourcesActive(original.sources,policy);
   const sources=original.sources.map(source=>({referenceIdSha256:sha256(source.id),urlSha256:sha256(source.url),sourceSha256:source.sha256,originalPolicySha256:textLineageRecordSha256(source.policy)})).sort((a,b)=>textLineageRecordSha256(a).localeCompare(textLineageRecordSha256(b)));
   retainedOrigins.push(origin);
   decisions.push({recordId:record.id,evidenceHash:record.verification.evidenceHash,checkedAt:new Date().toISOString(),decision:'admitted',basis:'retained_publication',publication:{releaseId:retained.lineage.releaseId,manifestSha256:retained.lineage.manifestSha256,recordsSha256:retained.lineage.members.records.sha256,coverageSha256:retained.lineage.members.coverage.sha256,registrySha256:retained.lineage.members.registry.sha256,origin},sources});
   continue;
  }
  const prepared=[];
  for(const pin of request.prepared){
   if(pin.bindings.some(binding=>binding.kind!=='prepared_source'))throw Error('Claim admission requires actual prepared-source provenance');
   const raw=PreparedDocumentSchema.parse(JSON.parse((await readPublicationSourcePin(pin,policy)).toString('utf8'))),receipt=verifyPreparedDocument(raw,raw);
   if(pin.bindings.some(binding=>binding.receiptSha256!==receipt.receiptSha256))throw Error('Prepared-source provenance differs from the actual receipt');
   await assertPreparedSourcesActive(receipt.references,policy);prepared.push(receipt);
  }
  const sources:z.infer<typeof sourceDecisionSchema>[]=[];
  for(const source of record.sources){
   const matches=prepared.flatMap(receipt=>receipt.municipalityId===record.municipalityId&&receipt.sourceSha256===record.extraction.inputSha256&&receipt.textSha256===record.extraction.textSha256?receipt.references.filter(reference=>reference.id===source.id&&reference.url===source.url&&reference.sha256===source.sha256&&reference.mimeType===source.mimeType).map(reference=>({receipt,reference})):[]);
   if(matches.length!==1)throw Error('Published source lacks one unambiguous current prepared receipt');
   const {receipt,reference}=matches[0];await assertPreparedSourcesActive([reference],policy);
   sources.push({referenceIdSha256:sha256(reference.id),urlSha256:sha256(reference.url),sourceSha256:reference.sha256,textSha256:receipt.textSha256,preparedReceiptSha256:receipt.receiptSha256,policySha256:textLineageRecordSha256(reference.policy)});
   bindings.push(...preparedSourceBindings([reference],receipt.receiptSha256));
  }
  sources.sort((a,b)=>textLineageRecordSha256(a).localeCompare(textLineageRecordSha256(b)));
  decisions.push({recordId:record.id,evidenceHash:record.verification.evidenceHash,checkedAt:new Date().toISOString(),decision:'admitted',basis:'prepared_source',sources});
 }
 decisions.sort((a,b)=>a.recordId.localeCompare(b.recordId));
 const retainedPublication=retained?RetainedKnowledgeLineageSchema.parse({...retained.lineage,selectedRecordOrigins:retainedOrigins.sort((a,b)=>a.outputRecordIndex-b.outputRecordIndex)}):null;
 const current=publicationPolicyReceiptsSchema.parse({schemaVersion:'stadtstack-publication-policy-receipts-v2',authorityId:authority.authorityId,authoritySha256:authority.authoritySha256,snapshotSha256:snapshot.sha256,contractSha256,records:decisions});
 if((await readCivicOptOutSnapshot(policy)).sha256!==snapshot.sha256)throw Error('Source objection state changed during publication admission');
 if(input.policyReceipts){
  const original=publicationPolicyReceiptsSchema.parse(JSON.parse((await readPublicationAuditPin(input.policyReceipts,policy)).toString('utf8')));
  const withoutClocks=(value:PublicationPolicyReceipts)=>({...value,records:value.records.map(({checkedAt:_checkedAt,...decision})=>decision)});
  if(textLineageRecordSha256(withoutClocks(original))!==textLineageRecordSha256(withoutClocks(current)))throw Error('Pinned publication policy receipts do not match current admission');
  return {pin:input.policyReceipts,receipts:original,bindings,retainedPublication};
 }
 const bytes=JSON.stringify(current,null,2)+'\n',digest=sha256(bytes),path=join(input.auditDir,'policy-receipts-'+digest+'.json');
 await writePrivateJson(path,current);
 return {pin:{path,sha256:digest,bytes:Buffer.byteLength(bytes)},receipts:current,bindings,retainedPublication};
}
