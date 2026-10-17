import {z} from 'zod';
import {HashSchema,canonicalJson,semanticHash} from './district-adapter-contract.ts';
import {DistrictKnowledgeRecordSchema,type DistrictKnowledgeRecord} from './district-schema.ts';
import type {GraphClaims} from './district-graph-claims.ts';
import {AssessmentContextHold} from './district-assessment-context.ts';

// The full private snapshot is never provider data. It preserves even prior model
// metadata while the blind, source-assertion partition is independently rebuilt.
export const SourceRecordBindingSchema=z.object({version:z.literal('assessment-source-record-v2'),recordSha256:HashSchema,record:DistrictKnowledgeRecordSchema}).strict();
const source=z.object({id:z.string(),url:z.string(),sha256:HashSchema}).strict();
const retained=z.object({selector:z.string(),value:z.unknown(),valueSha256:HashSchema}).strict();
const assertionModality=z.enum(['confirmed','planned','conditional','negated','historical','unknown']);
// The assessment wire is deliberately coarser than the retained graph claim.
// These are encoding categories, not promotion to an independently verified fact.
const relationModalityEncoding={
 asserted:'confirmed',decided:'confirmed',implemented:'confirmed',planned:'planned',proposed:'planned',
 conditional:'conditional',negated:'negated',historical:'historical',
} as const satisfies Record<GraphClaims['relations'][number]['modality'],z.infer<typeof assertionModality>>;
export const SourcePropositionProjectionSchema=z.object({
 version:z.literal('r1-record-propositions-v2'),recordId:z.string(),recordSha256:HashSchema,projectionSha256:HashSchema,
 sources:z.array(source),
 bindings:z.array(retained.extend({basis:z.enum(['retained_record','source_document_sha256','graph_identity'])}).strict()),
 qualifications:z.array(retained.extend({reason:z.enum(['null','empty_string','empty_array','unknown'])}).strict()),
 context:z.array(retained),
 propositions:z.array(z.object({selector:z.string(),asserted:z.unknown(),quote:z.string().nullable(),
  assertionEncoding:z.object({value:z.null(),unit:z.null(),modality:assertionModality.optional(),subjectId:z.string().nullable().optional(),objectId:z.string().nullable().optional()}).strict(),claimId:z.string()}).strict()).min(1),
}).strict();
export type SourcePropositionProjection=z.infer<typeof SourcePropositionProjectionSchema>;
const pointer=(key:string)=>key.replaceAll('~','~0').replaceAll('/','~1');
const metadata=new Set(['id','kind','municipalityId','ags','districtId']);
const graphMetadata=new Set(['entityId','identityBasis','fromId','toId']);
const quoteFields:Record<string,string>={title:'titleQuote',summary:'summaryQuote',caseKey:'caseQuote',caseKeyType:'caseQuote',
 caseType:'caseQuote',documentDate:'documentDateQuote',stage:'stageQuote',originalStatus:'stageQuote',stageDate:'stageDateQuote'};
/** No classifier outcome or unknown placeholder is silently converted to fact.
 * Positive classifications stay source propositions, even without a usable quote.
 * Text-model records have no typed quantity field: asserted is the claim payload,
 * never assertion.value. Quantitative critical targets retain their own encoding. */
export function sourceRecordPropositions(record:DistrictKnowledgeRecord,blind:(value:unknown)=>unknown):SourcePropositionProjection{
 const {extraction:_extraction,verification:_verification,sources,...claims}=record;
 const projection=z.record(z.string(),z.unknown()).parse(blind(claims));
 const bindings:SourcePropositionProjection['bindings']=[],qualifications:SourcePropositionProjection['qualifications']=[],context:SourcePropositionProjection['context']=[];
 const retain=(selector:string,value:unknown)=>({selector,value,valueSha256:semanticHash(value)});
 const unset=(value:unknown,field:string):SourcePropositionProjection['qualifications'][number]['reason']|null=>value===null?'null':value===''?'empty_string':Array.isArray(value)&&!value.length?'empty_array':value==='unknown'&&['stage','caseType'].includes(field)||value==='none'&&field==='precision'?'unknown':null;
 const clean=(value:unknown,selector:string):unknown=>{
  if(Array.isArray(value))return value.map((member,index)=>clean(member,selector+'/'+index));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).flatMap(([key,member])=>{
   const path=selector+'/'+pointer(key),reason=unset(member,key);
   if(key==='mentionId'){context.push(retain(path,member));return [];}
   if(graphMetadata.has(key)){bindings.push({...retain(path,member),basis:'graph_identity'});return [];}
   if(reason){qualifications.push({...retain(path,member),reason});return [];}
   return [[key,clean(member,path)]];
  }));
  return value;
 };
 const propositions:SourcePropositionProjection['propositions']=[];
 for(const [field,value] of Object.entries(projection).sort(([a],[b])=>a<b?-1:a>b?1:0)){
  const selector='/'+pointer(field),reason=unset(value,field);
  if(metadata.has(field)){bindings.push({...retain(selector,value),basis:'retained_record'});continue;}
  if(record.caseKeyType==='source_document'&&(field==='caseKey'||field==='caseKeyType')){
   if(record.caseKey!==`source_document:${record.extraction.inputSha256}`)throw Error('Generated source-document identity changed');
   bindings.push({...retain(selector,value),basis:'source_document_sha256'});continue;
  }
  if(reason){qualifications.push({...retain(selector,value),reason});continue;}
  if(field.endsWith('Quote')){context.push(retain(selector,value));continue;}
  const add=(member:unknown,path:string)=>{
   let asserted=clean(member,path);
   if(field==='relations'&&member&&typeof member==='object'&&'fromMention' in member&&'toMention' in member){
    const from=record.entities.find(entity=>entity.mentionId===member.fromMention),to=record.entities.find(entity=>entity.mentionId===member.toMention);
    if(!from||!to)throw Error('Source relation has an unknown directional endpoint');
    asserted={...asserted as Record<string,unknown>,subject:{mentionId:from.mentionId,name:from.name,type:from.type},object:{mentionId:to.mentionId,name:to.name,type:to.type}};
   }
   const associated=member&&typeof member==='object'&&'quote' in member?member.quote:projection[quoteFields[field]??field+'Quote'];
   const quote=typeof associated==='string'&&associated.length?associated:null;
   const relation=field==='relations'?record.relations[Number(path.slice('/relations/'.length))]:undefined;
   const assertionEncoding:SourcePropositionProjection['propositions'][number]['assertionEncoding']={value:null,unit:null};
   if(relation){
    assertionEncoding.modality=relationModalityEncoding[relation.modality];
    assertionEncoding.subjectId=relation.fromId;assertionEncoding.objectId=relation.toId;
   }
   const body={selector:path,asserted,quote,assertionEncoding};
   propositions.push({...body,claimId:'proposition:'+semanticHash({version:'r1-record-propositions-v2',recordId:record.id,...body})});
  };
  if(Array.isArray(value))value.forEach((member,index)=>add(member,selector+'/'+index));else add(value,selector);
 }
 return SourcePropositionProjectionSchema.parse({version:'r1-record-propositions-v2',recordId:record.id,recordSha256:semanticHash(record),
  projectionSha256:semanticHash(projection),sources:sources.map(({id,url,sha256})=>({id,url,sha256})),bindings,qualifications,context,propositions});
}

type QuoteEvidence=ReadonlyArray<{locators:ReadonlyArray<{quote:string}>}>;
const providerEncoding={quoteReferences:'$quote contains [evidenceIndex,locatorIndex] pairs resolving the exact supplied locator quote; qualification/context pairs are [selector,value]; authenticated bookkeeping is hash-bound privately, not a source claim.'} as const;
const isQuote=(key:string)=>key==='quote'||key.endsWith('Quote');
/** Resolve only the reserved, explicitly tagged reference form. Never accept an
 * out-of-bounds index, mixed quote contents, duplicate pair, or ambiguous object. */
export function resolveProviderQuoteReferences(value:unknown,evidence:QuoteEvidence):unknown{
 if(Array.isArray(value))return value.map(member=>resolveProviderQuoteReferences(member,evidence));
 if(!value||typeof value!=='object')return value;
 if(Object.hasOwn(value,'$quote')){
  const refs=(value as {$quote:unknown}).$quote;
  if(Object.keys(value).length!==1||!Array.isArray(refs)||!refs.length)throw new AssessmentContextHold();
  let quote:string|undefined;const seen=new Set<string>();
  for(const pair of refs){
   if(!Array.isArray(pair)||pair.length!==2||!pair.every(index=>Number.isSafeInteger(index)&&index>=0))throw new AssessmentContextHold();
   const [sourceIndex,locatorIndex]=pair as [number,number],selected=evidence[sourceIndex]?.locators[locatorIndex]?.quote,key=sourceIndex+':'+locatorIndex;
   if(typeof selected!=='string'||seen.has(key)||quote!==undefined&&selected!==quote)throw new AssessmentContextHold();
   seen.add(key);quote=selected;
  }
  return quote;
 }
 return Object.fromEntries(Object.entries(value).map(([key,member])=>[key,resolveProviderQuoteReferences(member,evidence)]));
}
/** Provider-only encoding; private record, complete partition, hashes, claim IDs,
 * all positive values and shared evidence remain unchanged. */
export function compactSourceProviderData(projection:SourcePropositionProjection,evidence:QuoteEvidence,criticalTarget?:unknown){
 const quotes=new Map<string,Array<[number,number]>>();
 evidence.forEach((source,sourceIndex)=>source.locators.forEach((locator,locatorIndex)=>{
  const refs=quotes.get(locator.quote)??[];refs.push([sourceIndex,locatorIndex]);quotes.set(locator.quote,refs);
 }));
 const reference=(quote:string)=>{const refs=quotes.get(quote);if(!refs?.length)throw new AssessmentContextHold();return {$quote:refs};};
 const encode=(value:unknown):unknown=>{
  if(Array.isArray(value))return value.map(encode);
  if(!value||typeof value!=='object')return value;
  if(Object.hasOwn(value,'$quote'))throw new AssessmentContextHold();
  return Object.fromEntries(Object.entries(value).map(([key,member])=>[key,isQuote(key)&&typeof member==='string'&&member.length?reference(member):encode(member)]));
 };
 const {bindings,qualifications,context,propositions,...retainedProjection}=projection;
 const claim={...retainedProjection,version:'r1-provider-propositions-v3',bindingsSha256:semanticHash(bindings),
  qualifications:qualifications.map(({selector,value})=>[selector,value]),
  context:context.map(({selector,value})=>[selector,typeof value==='string'&&selector.endsWith('Quote')?reference(value):value]),
  propositions:encode(propositions)};
 // Round-trip against the authenticated partition, not a model interpretation.
 if(canonicalJson(resolveProviderQuoteReferences(claim.propositions,evidence))!==canonicalJson(propositions)
  ||canonicalJson(resolveProviderQuoteReferences(claim.context,evidence))!==canonicalJson(context.map(({selector,value})=>[selector,value])))throw new AssessmentContextHold();
 const encodedCritical=criticalTarget===undefined?undefined:encode(criticalTarget);
 if(criticalTarget!==undefined&&canonicalJson(resolveProviderQuoteReferences(encodedCritical,evidence))!==canonicalJson(criticalTarget))throw new AssessmentContextHold();
 return {providerEncoding,claim,...(criticalTarget===undefined?{}:{criticalTarget:encodedCritical})};
}
/** Re-derive the complete deterministic wire, including every matching quote
 * occurrence. Valid-looking but altered/omitted references are not admitted. */
export function assertCompactSourceProviderData(value:unknown,projection:SourcePropositionProjection,evidence:QuoteEvidence,criticalTarget?:unknown){
 const expected=compactSourceProviderData(projection,evidence,criticalTarget);
 resolveProviderQuoteReferences(value,evidence);
 if(canonicalJson(value)!==canonicalJson(expected))throw new AssessmentContextHold();
 return expected;
}
