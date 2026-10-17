import {z} from 'zod';
import {HashSchema,semanticHash} from './district-adapter-contract.ts';
import {DistrictKnowledgeRecordSchema,type DistrictKnowledgeRecord} from './district-schema.ts';
import type {GraphClaims} from './district-graph-claims.ts';

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
  assertionEncoding:z.object({value:z.null(),unit:z.null(),modality:assertionModality.optional()}).strict(),claimId:z.string()}).strict()).min(1),
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
   if(relation)assertionEncoding.modality=relationModalityEncoding[relation.modality];
   const body={selector:path,asserted,quote,assertionEncoding};
   propositions.push({...body,claimId:'proposition:'+semanticHash({version:'r1-record-propositions-v2',recordId:record.id,...body})});
  };
  if(Array.isArray(value))value.forEach((member,index)=>add(member,selector+'/'+index));else add(value,selector);
 }
 return SourcePropositionProjectionSchema.parse({version:'r1-record-propositions-v2',recordId:record.id,recordSha256:semanticHash(record),
  projectionSha256:semanticHash(projection),sources:sources.map(({id,url,sha256})=>({id,url,sha256})),bindings,qualifications,context,propositions});
}
