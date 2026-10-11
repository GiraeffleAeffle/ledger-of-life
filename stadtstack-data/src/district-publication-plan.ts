import {z} from 'zod';
import {hashSchema,daySchema,sha256} from './district-schema.ts';
import {knowledgeSourcePinSchema} from './prepare-knowledge.ts';
import {gitSnapshotSourcePinSchema} from './district-git-snapshot-import.ts';
import {publicationAuditPinSchema,publicationAdmissionSchema,publicationRetainedBaselineSchema} from './district-publication-policy.ts';
import {publicationStagingPathSchema} from './district-publication-inputs.ts';
import {releasePathSchema} from './data-release.ts';
import {changesSchema} from './changes.ts';
import {retainedPublicationSources} from './district-retained-import.ts';

const metadataId=z.string().min(1).max(512).regex(/^[^\s<>]+$/);
const legacyChangeMetadataSchema=z.object({added:z.array(metadataId),changed:z.array(metadataId),removed:z.array(metadataId),generatedAt:z.iso.datetime()}).strict();
const coreHandoverMetadataSchema=z.object({
 schemaVersion:z.literal('stadtstack-handover-draft-v1'),
 label:z.literal('DRAFT — not sent; no municipality handover or receipt'),status:z.literal('not-sent'),
 recipient:z.literal('Stadt Strausberg (draft only)'),bundleVersion:hashSchema,bundleSha256:hashSchema,
 facts:z.array(z.object({id:z.enum(['lake:straussee-level-2026-09-14','budget:investment-outlays-2025','budget:investment-outlays-2026']),version:hashSchema,assertionHash:hashSchema,sourceSha256:hashSchema,evidenceHash:hashSchema}).strict()).length(3).refine(facts=>new Set(facts.map(fact=>fact.id)).size===3),
 request:z.literal('Bitte die verlinkten Originalquellen und gegebenenfalls neuere Veröffentlichungen prüfen.'),pollResults:z.null(),councilReceipt:z.null(),
}).strict();
const metadataChangeReasons:Record<string,string>={added:'Record entered the published collection.',changed:'Published revision changed.',removed:'Record is absent from this publication; absence alone does not establish source withdrawal or supersession.'};
export const publicationPredecessorMetadataSchema=z.object({
 role:z.enum(['legacy_city_changes','changes_v2_metadata','core_handover_draft']),
 manifestSha256:hashSchema,releaseId:hashSchema,
 encoding:z.object({indent:z.number().int().min(0).max(8),trailingNewlines:z.number().int().min(0).max(2)}).strict(),
 value:z.unknown(),
}).strict();
export type PublicationPredecessorMetadata=z.infer<typeof publicationPredecessorMetadataSchema>;

/** Reconstruct only allowlisted metadata, never open an ungoverned predecessor file to classify it. */
export function encodePredecessorMetadata(input:PublicationPredecessorMetadata):Buffer{
 const metadata=publicationPredecessorMetadataSchema.parse(input);
 let value:unknown;
 if(metadata.role==='legacy_city_changes')value=legacyChangeMetadataSchema.parse(metadata.value);
 else if(metadata.role==='core_handover_draft')value=coreHandoverMetadataSchema.parse(metadata.value);
 else{
  const feed=changesSchema.parse(metadata.value);
  if(feed.events.some(event=>metadataChangeReasons[event.kind]!==event.reason||event.evidence!==null||event.targetRevision!==null||(event.previous?.metricClaims.length??0)!==0||(event.current?.metricClaims.length??0)!==0||!metadataId.safeParse(event.id).success||!metadataId.safeParse(event.cityId).success)||feed.snapshots.some(snapshot=>!metadataId.safeParse(snapshot.cityId).success))throw Error('Source-bearing change history requires governed source provenance');
  value=feed;
 }
 if(retainedPublicationSources(value).length)throw Error('Source-bearing predecessor cannot use a metadata role');
 const bytes=Buffer.from(JSON.stringify(value,null,metadata.encoding.indent)+'\n'.repeat(metadata.encoding.trailingNewlines));
 if(bytes.length>8*1024*1024)throw Error('Predecessor metadata exceeds its byte bound');
 return bytes;
}

const predecessorMetadataMemberSchema=z.object({memberPath:releasePathSchema,pin:publicationAuditPinSchema,metadata:publicationPredecessorMetadataSchema}).strict().superRefine((member,ctx)=>{
 const {role}=member.metadata,city=/^cities\/([a-z0-9-]+)\/changes\.json$/.exec(member.memberPath);
 if(role==='core_handover_draft'?member.memberPath!=='core/handover-draft.json':role==='legacy_city_changes'?!city:!city&&member.memberPath!=='knowledge/changes.json'){
  ctx.addIssue({code:'custom',message:'Predecessor metadata role/path mismatch'});return;
 }
 try{
  const bytes=encodePredecessorMetadata(member.metadata);
  if(bytes.length!==member.pin.bytes||sha256(bytes)!==member.pin.sha256)throw Error('pin mismatch');
  if(role==='changes_v2_metadata'){
   const feed=changesSchema.parse(member.metadata.value);
   if([...feed.events,...feed.snapshots].some(record=>city?record.cityId!==city[1]||record.recordType!=='signal':record.recordType!=='knowledge'))throw Error('scope mismatch');
  }
 }catch{ctx.addIssue({code:'custom',message:'Invalid authenticated content-free predecessor metadata'});}
});
export const publicationPredecessorMemberSchema=z.union([
 z.object({memberPath:releasePathSchema,pin:knowledgeSourcePinSchema}).strict(),
 predecessorMetadataMemberSchema,
]);

export const PublicationPlanSchema=z.object({
 schemaVersion:z.literal('stadtstack-managed-publication-plan-v1'),asOf:daySchema,
 clocks:z.object({qualityGeneratedAt:z.iso.datetime(),manifestGeneratedAt:z.iso.datetime()}).strict(),
 output:z.object({managedRoot:z.string().min(1),releaseDir:z.string().min(1),auditDir:z.string().min(1)}).strict(),
 staging:z.array(knowledgeSourcePinSchema.extend({memberPath:publicationStagingPathSchema}).strict()).min(1),
 knowledgePreparation:publicationAuditPinSchema,
 admissions:z.array(publicationAdmissionSchema),
 retainedPublication:publicationRetainedBaselineSchema.optional(),
 priorRelease:z.object({gitCommit:z.string().regex(/^[a-f0-9]{40}$/),manifest:publicationAuditPinSchema,releaseId:hashSchema,members:z.array(publicationPredecessorMemberSchema).min(1)}).strict(),
 legacyBaselines:z.array(z.object({cityId:z.string().regex(/^[a-z0-9-]+$/),pin:gitSnapshotSourcePinSchema}).strict()).default([]),
 regionalSources:z.object({manifest:publicationAuditPinSchema,indexes:z.array(z.object({name:z.string().min(1),rawRoot:z.string().min(1)}).strict()).min(1),documents:z.array(z.object({url:z.url(),sourceSha256:hashSchema,indexName:z.string().min(1),observation:publicationAuditPinSchema}).strict())}).strict().optional(),
 policyReceipts:publicationAuditPinSchema.optional(),
}).strict();
export type PublicationPlan=z.infer<typeof PublicationPlanSchema>;
