import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {modelReadiness,subscriptionChat} from './district-model.ts';
import {PROVIDER_CONFIGS,type ExtractorProvider,type ModelEvidence,type UsageContext} from './district-model-contract.ts';
import {cachedModelAnswer} from './district-answer-cache.ts';
import type {CachedAnswer} from './district-answer-cache.ts';
import {verifyPreparedDocument,type PreparedDocument,type PreparedExpectation} from './district-prepared-document.ts';
import {DistrictExtractionClaimsSchema,DistrictKnowledgeRecordSchema,hashSchema,sha256,knowledgeEvidenceHash,type DistrictExtractionClaims,type DistrictKnowledgeRecord} from './district-schema.ts';
import {EntityMentionSchema,RelationClaimSchema,normalizeGraphClaims,normalizeRelationActions} from './district-graph-claims.ts';
import {EXTRACTOR_VERSION,PROMPT_VERSION,JUDGE_PROMPT_VERSION,PROMPT_SHA256,JUDGE_PROMPT_SHA256,CLAIM_SCHEMA_SHA256,EXTRACTION_INSTRUCTIONS,JUDGE_INSTRUCTIONS,outputJSONSchema,extractionOutputSchema,judgeJSONSchema,judgeSchema,LIMITATION,documentChunks,deterministicChecks,restoreSourceQuotes,extractionCacheKey,rebindSourceReferences,extractorHash,safeFailure,type DocumentChunk} from './district-claims.ts';
import {TOPIC_VOCABULARY} from './topic-vocabulary.ts';

export const municipalityBindingSchema=z.object({id:z.string().regex(/^[a-z0-9-]+$/),name:z.string().min(1),ags:z.string().regex(/^\d{8}$/),districtId:z.string().min(1)}).strict();
export type MunicipalityBinding=z.infer<typeof municipalityBindingSchema>;
export const quarantineCaseSchema=z.object({documentId:z.string(),municipalityId:z.string(),sourceId:z.string(),sourceSha256:hashSchema,chunk:z.number().int().nonnegative().nullable(),reason:z.string(),candidate:DistrictKnowledgeRecordSchema.optional()}).strict();
export type QuarantineCase=z.infer<typeof quarantineCaseSchema>;
export const documentResultSchema=z.object({schemaVersion:z.literal('stadtstack-document-result-v2'),taskId:hashSchema,groupId:hashSchema,provider:z.enum(['openai-subscription','anthropic-subscription']),purpose:z.enum(['production','agreement']),municipalityId:z.string(),sourceSha256:hashSchema,preparedSha256:hashSchema,promptSha256:hashSchema,schemaSha256:hashSchema,generatedAt:z.iso.datetime(),records:z.array(DistrictKnowledgeRecordSchema),quarantine:z.array(quarantineCaseSchema),chunks:z.array(z.object({index:z.number().int().nonnegative(),outcome:z.enum(['admitted','rejected','no_case']),responseSha256:hashSchema.nullable(),recordId:z.string().nullable()}).strict())}).strict();
export type DocumentResult=z.infer<typeof documentResultSchema>;
const rawClaimsFromRecordSchema=DistrictExtractionClaimsSchema.extend({entities:z.array(EntityMentionSchema.strip()),relations:z.array(RelationClaimSchema.strip())}).strip();

export async function jointExtractionContract(){
 const extractorSha256=await extractorHash();
 // Work-plan prompt identity binds both actual prompts and the gate implementation.
 return {promptSha256:sha256(JSON.stringify({extraction:PROMPT_SHA256,judge:JUDGE_PROMPT_SHA256,extractorSha256})),schemaSha256:CLAIM_SCHEMA_SHA256,extractorSha256};
}
async function cachedAnswer(provider:ExtractorProvider,identity:ModelEvidence,system:string,input:unknown,schema:object,cacheRoot:string,usage:UsageContext):Promise<CachedAnswer>{
 usage.signal?.throwIfAborted();
 const binding=sha256(JSON.stringify({provider,modelIdentitySha256:identity.modelIdentitySha256,system,input,schema}));
 return cachedModelAnswer({cacheRoot,binding,modelIdentitySha256:identity.modelIdentitySha256,signal:usage.signal},async()=>{
  usage.signal?.throwIfAborted();
  const answer=await subscriptionChat(provider,system,input,schema,usage).catch(error=>{usage.signal?.throwIfAborted();throw error;});
  usage.signal?.throwIfAborted();
  if(answer.evidence.modelIdentitySha256!==identity.modelIdentitySha256||answer.evidence.provider!==provider)throw Error('Subscription CLI identity changed during document processing');
  return {binding,modelIdentitySha256:identity.modelIdentitySha256,receivedAt:new Date().toISOString(),value:answer.value,responseSha256:answer.responseSha256,returnedModel:answer.returnedModel,runtimeWarnings:answer.runtimeWarnings};
 });
}
function cachedClaims(record:DistrictKnowledgeRecord):DistrictExtractionClaims{
 return rawClaimsFromRecordSchema.parse({...record,caseKey:record.caseKeyType==='source_document'?null:record.caseKey});
}
export async function inferPreparedDocument(options:{taskId:string;groupId:string;purpose:'production'|'agreement';provider:ExtractorProvider;municipality:MunicipalityBinding;prepared:PreparedDocument;expected:PreparedExpectation;contract:{promptSha256:string;schemaSha256:string};out:string;usage:Omit<UsageContext,'purpose'|'groupId'>}):Promise<DocumentResult>{
 options.usage.signal?.throwIfAborted();
 const municipality=municipalityBindingSchema.parse(options.municipality),prepared=verifyPreparedDocument(options.prepared,options.expected),contract=await jointExtractionContract();
 if(prepared.municipalityId!==municipality.id||contract.promptSha256!==options.contract.promptSha256||contract.schemaSha256!==options.contract.schemaSha256)throw Error('Prepared source or joint extraction contract mismatch');
 hashSchema.parse(options.taskId);hashSchema.parse(options.groupId);
 options.usage.signal?.throwIfAborted();
 const records:DistrictKnowledgeRecord[]=[],quarantine:QuarantineCase[]=[],chunks:DocumentResult['chunks']=[];
 const source=prepared.references[0],documentId='document:'+prepared.sourceSha256;
 const rejection=(chunk:number|null,reason:string,candidate?:DistrictKnowledgeRecord)=>quarantine.push({documentId,municipalityId:municipality.id,sourceId:source.id,sourceSha256:prepared.sourceSha256,chunk,reason,...(candidate?{candidate}:{})});
 const result={schemaVersion:'stadtstack-document-result-v2',taskId:options.taskId,groupId:options.groupId,provider:options.provider,purpose:options.purpose,municipalityId:municipality.id,sourceSha256:prepared.sourceSha256,preparedSha256:prepared.receiptSha256,promptSha256:contract.promptSha256,schemaSha256:contract.schemaSha256,records,quarantine,chunks};
 let document:DocumentChunk[];
 try{document=documentChunks(prepared.text);}
 catch(error){
  options.usage.signal?.throwIfAborted();
  // A deterministic source budget failure is not a provider outage. Reject the
  // whole document before readiness/generation; never truncate or admit a prefix.
  if(!(error instanceof Error)||error.message!=='Document exceeds model chunk limit')throw error;
  rejection(null,'Document exceeds model chunk limit; entire document quarantined before model readiness (no truncation or model calls)');
  return documentResultSchema.parse({...result,generatedAt:new Date().toISOString()});
 }
 options.usage.signal?.throwIfAborted();
 const identity=await modelReadiness(options.provider,options.usage.signal),config=PROVIDER_CONFIGS[options.provider];
 const cacheRoot=join(options.out,'cache');await mkdir(cacheRoot,{recursive:true,mode:0o700});
 for(const chunk of document){
  options.usage.signal?.throwIfAborted();
  const cacheKey=extractionCacheKey({provider:options.provider,documentHash:prepared.sourceSha256,textHash:prepared.textSha256,extractorHash:contract.extractorSha256,modelIdentitySha256:identity.modelIdentitySha256,chunk:{index:chunk.index,start:chunk.start,end:chunk.end},municipalityId:municipality.id,sourceBinding:JSON.stringify(municipality)}),recordPath=join(cacheRoot,cacheKey+'.record.json');
  const references=prepared.references.map(reference=>({...reference,locator:`text-sha256:${prepared.textSha256};chars:${chunk.start}-${chunk.end}`}));
  let cached:DistrictKnowledgeRecord|undefined;
  try{cached=DistrictKnowledgeRecordSchema.parse(JSON.parse(await readFile(recordPath,'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw Error('Source extraction cache invalid');}
  if(cached){
   if(cached.extraction.cacheKey!==cacheKey||cached.extraction.provider!==options.provider||cached.extraction.textSha256!==prepared.textSha256||cached.ags!==municipality.ags||cached.districtId!==municipality.districtId)throw Error('Source extraction cache binding mismatch');
   if(cached.verification.status==='auto-verified'&&!deterministicChecks(cachedClaims(cached),chunk.text,municipality.name).passed)throw Error('Source extraction cache no longer passes exact checks');
   cached=rebindSourceReferences(cached,references);
   if(cached.verification.status==='auto-verified')records.push(cached);else rejection(chunk.index,cached.verification.reason??'Candidate gates failed',cached);
   chunks.push({index:chunk.index,outcome:cached.verification.status==='auto-verified'?'admitted':'rejected',responseSha256:cached.extraction.responseSha256,recordId:cached.id});continue;
  }
  // Operational/model failures propagate: the provider lane pauses instead of retrying every chunk.
  const answer=await cachedAnswer(options.provider,identity,EXTRACTION_INSTRUCTIONS,{municipality:{id:municipality.id,name:municipality.name},vocabulary:TOPIC_VOCABULARY.map(({pattern:_pattern,...topic})=>topic),source:{text:chunk.text}},outputJSONSchema,cacheRoot,{...options.usage,purpose:options.purpose==='agreement'?'agreement':'extraction',groupId:options.groupId});
  const decoded=extractionOutputSchema.safeParse(answer.value);
  if(!decoded.success){rejection(chunk.index,'Structured output/schema validation failed');chunks.push({index:chunk.index,outcome:'rejected',responseSha256:answer.responseSha256,recordId:null});continue;}
  if(!decoded.data.record){rejection(chunk.index,'No supported case in source excerpt');chunks.push({index:chunk.index,outcome:'no_case',responseSha256:answer.responseSha256,recordId:null});continue;}
  const restored=restoreSourceQuotes(decoded.data.record,chunk.text,chunk.start),{claims,normalization:relationNormalization}=normalizeRelationActions(restored.claims),normalization=restored.normalization,deterministic=deterministicChecks(claims,chunk.text,municipality.name);
  let faithfulness:DistrictKnowledgeRecord['verification']['faithfulness']={score:null,threshold:0.8,model:identity.model,provider:identity.provider,tool:identity.tool,toolVersion:identity.toolVersion,modelIdentitySha256:identity.modelIdentitySha256,returnedModel:null,reason:'Not evaluated: deterministic gate failed',evaluatedAt:null,responseSha256:null,sameModel:true,limitation:LIMITATION};
  if(deterministic.passed){
   const judgment=await cachedAnswer(options.provider,identity,JUDGE_INSTRUCTIONS,{source:{text:chunk.text},candidate:claims},judgeJSONSchema,cacheRoot,{...options.usage,purpose:options.purpose==='agreement'?'agreement':'judge',groupId:options.groupId});
   const judged=judgeSchema.safeParse(judgment.value);
   if(judged.success){faithfulness={...faithfulness,score:judged.data.score,reason:judged.data.reason,evaluatedAt:judgment.receivedAt,responseSha256:judgment.responseSha256,returnedModel:judgment.returnedModel,runtimeWarnings:judgment.runtimeWarnings};if(judged.data.criticalUnsupported)deterministic.checks.push({id:'judge_critical_claims',passed:false,reason:'Actual model judge found a critically unsupported claim'});deterministic.passed=deterministic.checks.every(check=>check.passed);}
   else faithfulness.reason='Actual judge returned invalid structured output';
  }
  const passed=deterministic.passed&&faithfulness.score!==null&&faithfulness.score>=0.8&&faithfulness.responseSha256!==null;
  try{
   const graph=normalizeGraphClaims(claims,{municipalityId:municipality.id,sourceSha256:prepared.sourceSha256});
   const caseKey=claims.caseKey??`source_document:${prepared.sourceSha256}`;
   const candidate={...claims,...graph,id:`knowledge:${municipality.id}:${sha256(`${caseKey}\n${prepared.sourceSha256}\n${chunk.index}`).slice(0,24)}`,municipalityId:municipality.id,ags:municipality.ags,districtId:municipality.districtId,caseKey,sources:references,
    extraction:{extractorVersion:EXTRACTOR_VERSION,extractorSha256:contract.extractorSha256,...identity,returnedModel:answer.returnedModel,runtimeWarnings:answer.runtimeWarnings,quoteNormalization:normalization,...(relationNormalization?{relationNormalization:{...relationNormalization,sourceSha256:prepared.sourceSha256,textSha256:prepared.textSha256,responseSha256:answer.responseSha256}}:{}),promptVersion:PROMPT_VERSION,promptSha256:PROMPT_SHA256,judgePromptVersion:JUDGE_PROMPT_VERSION,judgePromptSha256:JUDGE_PROMPT_SHA256,inputSha256:prepared.sourceSha256,textSha256:prepared.textSha256,responseSha256:answer.responseSha256,ocrUsed:prepared.ocrUsed,textMethod:prepared.method,documentLimitations:[...prepared.limitations,config.toolLimitation],cacheKey,extractedAt:answer.receivedAt,chunk:{index:chunk.index,count:chunk.count,start:chunk.start,end:chunk.end}},
    verification:{status:passed?'auto-verified':'candidate',deterministic,faithfulness,evidenceHash:'',...(!passed?{reason:!deterministic.passed?deterministic.checks.filter(check=>!check.passed).map(check=>check.id).join(', '):'Faithfulness gate not passed'}:{})}};
   candidate.verification.evidenceHash=knowledgeEvidenceHash(candidate);
   const record=rebindSourceReferences(DistrictKnowledgeRecordSchema.parse(candidate),references);
   const temporary=recordPath+'.tmp';await writeFile(temporary,JSON.stringify(record)+'\n',{mode:0o600});await rename(temporary,recordPath);
   if(passed)records.push(record);else rejection(chunk.index,record.verification.reason??'Candidate gates failed',record);
   chunks.push({index:chunk.index,outcome:passed?'admitted':'rejected',responseSha256:answer.responseSha256,recordId:record.id});
  }catch(error){rejection(chunk.index,safeFailure(error));chunks.push({index:chunk.index,outcome:'rejected',responseSha256:answer.responseSha256,recordId:null});}
 }
 options.usage.signal?.throwIfAborted();
 return documentResultSchema.parse({...result,generatedAt:new Date().toISOString()});
}
