import {z} from 'zod';
import {hash} from './common.ts';
import {regionalStatement,regionalStatementFields} from './regional-statement.ts';
import {verifyRegionalStatementSnapshot} from './district-regional-statement-verification.ts';
import type {RegionalStatementSourceResolver} from './regional-statement.ts';
import {CivicPolicyStateError,HostOptedOutError} from './civic-opt-out.ts';
import {ParserIsolationError} from './district-parser-isolation.ts';
const item=z.object({title:z.string(),url:z.url(),date:z.string().nullable(),locator:z.string(),...regionalStatementFields}).passthrough().superRefine((item,ctx)=>{try{regionalStatement(item);}catch{ctx.addIssue({code:'custom',message:'Invalid regional statement evidence'});}});
const regional=z.object({schemaVersion:z.literal('stadtstack-regional-topics-v1'),generatedAt:z.string(),asOf:z.string(),coverage:z.record(z.string(),z.unknown()),topics:z.array(z.object({id:z.string(),municipalities:z.array(z.object({municipalityId:z.string(),items:z.array(item)}).passthrough())}).passthrough())}).passthrough();
export interface RegionalQuarantine {id:string;cityId:string;reason:string}
/** Unknown source dates are withheld from dated comparisons, never replaced by release time. */
export async function normalizeRegionalPublication(input:unknown,resolveStatementSource?:RegionalStatementSourceResolver){
 const data=regional.parse(input),quarantined:RegionalQuarantine[]=[];
 let inputRecords=0,publishedRecords=0;
 for(const topic of data.topics){
  for(const municipality of topic.municipalities){
   const accepted:typeof municipality.items=[];
   for(const item of municipality.items){
    inputRecords++;
    const reject=(reason:string)=>quarantined.push({id:`regional:${topic.id}:${municipality.municipalityId}:${hash(item.url+'\n'+item.locator).slice(0,16)}`,cityId:municipality.municipalityId,reason});
    const date=item.date;
    if(!date||!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==date.slice(0,10)){
     reject('source_event_date_missing_or_invalid');continue;
    }
    if(item.statementEvidence){
     // Resolve from authoritative retained observations, not caller-supplied staging data.
     // Authorization errors propagate: an unavailable/currently denied policy never becomes permission.
     const snapshot=await resolveStatementSource?.({url:item.url,sourceSha256:item.statementEvidence[0].sourceSha256});
     if(!snapshot){reject('statement_source_snapshot_missing');continue;}
     try{await verifyRegionalStatementSnapshot(item,snapshot);}
     catch(error){
      if(error instanceof CivicPolicyStateError||error instanceof HostOptedOutError||snapshot.sourceContext?.signal?.aborted||error instanceof ParserIsolationError&&['unavailable','security_review_required'].includes(error.reason))throw error;
      reject('statement_source_snapshot_mismatch');continue;
     }
    }
    accepted.push(item);publishedRecords++;
   }
   municipality.items=accepted;
  }
  topic.municipalities=topic.municipalities.filter(municipality=>municipality.items.length);
 }
 data.topics=data.topics.filter(topic=>topic.municipalities.length);
 data.coverage={...data.coverage,datedPublication:{inputRecords,publishedRecords,quarantinedRecords:quarantined.length,municipalities:new Set(data.topics.flatMap(t=>t.municipalities.map(m=>m.municipalityId))).size,singleMunicipalityTopics:data.topics.filter(t=>t.municipalities.length===1).map(t=>t.id),policy:'Only sourced complete event dates enter comparison; null/invalid dates are quarantined, never replaced by retrieval or release timestamps. Substantive statements additionally require current-policy-authorized retained URL/hash bytes and exact normalized source excerpts.'}};
 return {data,quarantined,inputRecords,publishedRecords};
}
