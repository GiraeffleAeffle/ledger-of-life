import {createHash} from 'node:crypto';
import {z} from 'zod';

export const ADAPTER_CONTRACT_VERSION='district-structured-v1';
export const digest=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export function canonicalJson(value:unknown):string {
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(Object.is(value,-0)?0:value);
 if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
 if(typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalJson((value as Record<string,unknown>)[key])).join(',')+'}';
 throw Error('Unsupported canonical value');
}
export const semanticHash=(value:unknown)=>digest(canonicalJson(value));
export const HashSchema=z.string().regex(/^[a-f0-9]{64}$/);
export const ScopeSchema=z.object({publisherId:z.string().min(1),sourceId:z.string().min(1),municipalityId:z.string().min(1),ags:z.string().regex(/^\d{8}$/),tenant:z.string().nullable(),observationWindow:z.string().min(1)}).strict();
export type AdapterScope=z.infer<typeof ScopeSchema>;
export const CoverageSchema=z.object({state:z.enum(['complete','empty','not_applicable','not_checked','partial','blocked_policy','blocked_access','held_origin','held_quality','failed_execution']),scope:z.string().min(1),reason:z.string().min(1),checkedAt:z.iso.datetime().nullable(),nextCursor:z.string().nullable(),observedRows:z.number().int().nonnegative(),limitations:z.array(z.string())}).strict();
export type AdapterCoverage=z.infer<typeof CoverageSchema>;
export const StructuredLocatorSchema=z.object({sourceSha256:HashSchema,format:z.enum(['json','xml','csv','xls','xlsx','html','gtfs']),nativeId:z.string().min(1),path:z.string().min(1),sheet:z.string().nullable(),rowKey:z.string().nullable(),cells:z.array(z.string()),rawValue:z.union([z.string(),z.number(),z.boolean(),z.null()]),schemaHash:HashSchema,mappingVersion:z.string().min(1)}).strict();
export type StructuredLocator=z.infer<typeof StructuredLocatorSchema>;
export const ObservationSchema=z.object({id:HashSchema,publisherId:z.string().min(1),sourceId:z.string().min(1),nativeId:z.string().min(1),nativeVersion:z.string().nullable(),kind:z.string().min(1),subject:z.string().min(1),predicate:z.string().min(1),value:z.union([z.string(),z.number(),z.boolean(),z.null()]),unit:z.string().nullable(),date:z.string().nullable(),dateRole:z.string().nullable(),financialRole:z.enum(['plan','approval','payment','actual','none']),geography:z.object({ags:z.string().regex(/^\d{8}$/).nullable(),basis:z.enum(['source_explicit','verified_join','unknown']),role:z.enum(['project_location','performance_location','beneficiary_office','operator_seat','administrative_area','unknown'])}).strict(),sourceReferenceDate:z.string().nullable(),publishedAt:z.string().nullable(),retrievedAt:z.iso.datetime(),evidence:z.array(StructuredLocatorSchema).min(1),limitations:z.array(z.string())}).strict();
export type StructuredObservation=z.infer<typeof ObservationSchema>;
export interface ResourceReference {url:string;nativeId:string;parentId:string|null;method:'GET'|'POST';body:string|null;format:string}
export interface AdmittedSnapshot {sourceSha256:string;bytes:Uint8Array;url:string;mimeType:string;retrievedAt:string;policyReceiptSha256:string;sourceVersion:string|null}
export interface DiscoveryResult {resources:ResourceReference[];coverage:AdapterCoverage}
export interface ParseResult {observations:StructuredObservation[];coverage:AdapterCoverage}
/** Discovery consumes already acquired snapshots; parsers never receive networking capabilities. */
export interface StructuredAdapter {id:string;version:string;discover(snapshot:AdmittedSnapshot,scope:AdapterScope,cursor:string|null):DiscoveryResult;parse(snapshot:AdmittedSnapshot,scope:AdapterScope):ParseResult}
export function assertSnapshot(snapshot:AdmittedSnapshot):void {HashSchema.parse(snapshot.policyReceiptSha256);if(digest(snapshot.bytes)!==snapshot.sourceSha256)throw Error('Source byte binding mismatch');}
export function observation(input:Omit<StructuredObservation,'id'>):StructuredObservation {return ObservationSchema.parse({...input,id:semanticHash(input)});}
