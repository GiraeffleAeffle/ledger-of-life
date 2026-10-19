import {isAbsolute,resolve} from 'node:path';
import {z} from 'zod';
import {HashSchema} from './district-adapter-contract.ts';

export const ImportDispositionPinSchema=z.object({path:z.string().refine(path=>isAbsolute(path)&&resolve(path)===path),sha256:HashSchema}).strict();
const Pin=ImportDispositionPinSchema;
export const ImportRejectionReasonSchema=z.enum(['unsupported_mime','scope_mismatch','source_policy_stale']);
const PermanentReasons=z.tuple([z.literal('unsupported_mime'),z.literal('scope_mismatch')]);
export const ImportDispositionDecisionSchema=z.object({
 schemaVersion:z.literal('stadtstack-r1-import-disposition-decision-v1'),id:z.string().min(1),issuedBy:z.literal('owner'),issuedAt:z.iso.datetime(),expiresAt:z.iso.datetime(),
 nativeSealSelection:Pin,catalogue:Pin,
 policy:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('permanent_only'),enabledReasons:PermanentReasons}).strict(),
  z.object({kind:z.literal('include_expired_unregistered_discovery'),enabledReasons:z.tuple([z.literal('unsupported_mime'),z.literal('scope_mismatch'),z.literal('source_policy_stale')]),ownerDecision:z.literal('dispose_without_processing')}).strict(),
 ]),
 sources:z.array(z.object({municipalityId:z.string().min(1),sourceId:z.string().min(1),corpus:Pin,sealResult:Pin,manifest:Pin,importResult:Pin,documents:z.array(z.object({documentId:z.string().min(1),sourceSha256:HashSchema,reasonCode:ImportRejectionReasonSchema}).strict()).min(1)}).strict()).min(1),
}).strict();
export type ImportDispositionDecision=z.infer<typeof ImportDispositionDecisionSchema>;
export const ImportRejectionDispositionSchema=z.object({
 kind:z.literal('import_rejection'),municipalityId:z.string().min(1),sourceId:z.string().min(1),corpusSha256:HashSchema,documentId:z.string().min(1),sourceSha256:HashSchema,reasonCode:ImportRejectionReasonSchema,
 rule:z.literal('crawl_import_rejection_v1'),decision:Pin,sealResult:Pin,manifest:Pin,importResult:Pin,registry:Pin,
 processed:z.literal(false),admittedRecordIds:z.tuple([]),
}).strict();
export type ImportRejectionDisposition=z.infer<typeof ImportRejectionDispositionSchema>;
