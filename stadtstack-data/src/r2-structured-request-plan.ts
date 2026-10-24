import {HashSchema} from './district-adapter-contract.ts';
import type {DiscoveryResult} from './district-adapter-contract.ts';
import {MASTR_PILOT_AGS} from './adapters/mastr.ts';
import {GENESIS_BASE} from './adapters/genesis.ts';
import {publicUrl} from './polite-fetch.ts';

export const R2_HOUSING_YEAR='2024';
export const R2_MASTR_LANDING='https://www.marktstammdatenregister.de/MaStR/Datendownload';
export const R2_STRUCTURED_CAPS=Object.freeze({maxBulkCompressedBytes:8*1024**3,maxTotalBodyBytes:8*1024**3+128*1024**2,maxExpandedBytes:64*1024**3,maxMemberExpandedBytes:16*1024**3,maxMembers:2048,maxExpansionRatio:100,maxSelectedOutputBytes:16*1024**2,maxWorkerMemoryBytes:768*1024**2,maxInFlight:1,minSpacingMs:5000,automaticRetries:0,maxHours:2,modelCalls:0,paidMicroUsd:0});
export interface R2StructuredRequest {
 id:string;phase:'preflight'|'genesis_metadata'|'genesis_data'|'mastr_bulk';sourceId:string;municipalityId:string|null;
 url:string;method:'GET'|'POST';body:string|null;contentType:string|null;
 maxBodyBytes:number;maxNetworkAttempts:number;credentials:'none'|'existing_owner_headers';
}
const MiB=1024**2;
const preflight:readonly [string,string,number][]=[
 ['mastr','https://www.marktstammdatenregister.de/robots.txt',65536],
 ['mastr','https://www.marktstammdatenregister.de/.well-known/tdmrep.json',262144],
 ['mastr',R2_MASTR_LANDING,2*MiB],
 ['mastr','https://www.marktstammdatenregister.de/MaStR/Startseite/Impressum',2*MiB],
 ['mastr','https://www.marktstammdatenregister.de/MaStRHilfe/subpages/datenexport.html',2*MiB],
 ['mastr','https://www.marktstammdatenregister.de/MaStRHilfe/subpages/schutzFreigabe.html',2*MiB],
 ['licence','https://www.govdata.de/robots.txt',65536],
 ['licence','https://www.govdata.de/.well-known/tdmrep.json',262144],
 ['licence','https://www.govdata.de/dl-de/by-2-0',2*MiB],
 ['regionalstatistik-genesis','https://www.statistikportal.de/robots.txt',65536],
 ['regionalstatistik-genesis','https://www.statistikportal.de/.well-known/tdmrep.json',262144],
 ['regionalstatistik-genesis','https://www.statistikportal.de/de/open-data',2*MiB],
 ['regionalstatistik-genesis','https://www.regionalstatistik.de/robots.txt',65536],
 ['regionalstatistik-genesis','https://www.regionalstatistik.de/.well-known/tdmrep.json',262144],
 ['regionalstatistik-genesis',GENESIS_BASE+'application.wadl',MiB],
];
/** Pure draft generation only: no fetch, credential read, issuance or admission. */
export function buildR2StructuredRequestPlan(){
 const requests:R2StructuredRequest[]=preflight.map(([sourceId,url,maxBodyBytes],index)=>({id:'preflight-'+(index+1),phase:'preflight',sourceId,municipalityId:null,url,method:'GET',body:null,contentType:null,maxBodyBytes,maxNetworkAttempts:8,credentials:'none'}));
 requests.push({id:'housing-metadata',phase:'genesis_metadata',sourceId:'regionalstatistik-genesis',municipalityId:null,url:GENESIS_BASE+'metadata/table',method:'POST',body:'name=31231-02-01&area=free&language=de',contentType:'application/x-www-form-urlencoded',maxBodyBytes:MiB,maxNetworkAttempts:8,credentials:'none'});
 for(const [municipalityId,ags] of Object.entries(MASTR_PILOT_AGS))requests.push({id:'housing-'+municipalityId,phase:'genesis_data',sourceId:'regionalstatistik-genesis',municipalityId,url:GENESIS_BASE+'data/table',method:'POST',body:new URLSearchParams({name:'31231-02-01',area:'free',language:'de',regionalvariable:'GEMEIN',regionalkey:ags,startyear:R2_HOUSING_YEAR,endyear:R2_HOUSING_YEAR,compress:'false',transpose:'false',job:'false',format:'datencsv',quality:'on'}).toString(),contentType:'application/x-www-form-urlencoded',maxBodyBytes:4*MiB,maxNetworkAttempts:8,credentials:'existing_owner_headers'});
 return {schemaVersion:'stadtstack-r2-structured-request-plan-v1',id:'r2-structured-sources-2026-10-24',issuedAt:'',state:'unissued_review_draft',ownerApproval:{path:'/home/max/.local/state/stadtstack-data/r2-authorities/stadtstack-data/reports/approvals/r2-owner-approval-2026-10-24.json',sha256:'fc7f7acd93a7ab1c6a3044e24367bec52891a0b96b9b3852276079b7f37ce8e4',section:'approved.structuredSources'},municipalities:MASTR_PILOT_AGS,requests,maxPrimaryRequestsIncludingOneResolvedBulk:requests.length+1,maxNetworkAttemptsIncludingPolicyRedirectFailure:(requests.length+1)*8,caps:R2_STRUCTURED_CAPS,mastr:{route:'official_single_bulk_zip',state:'blocked_until_native_download_manifest_and_streaming_sandbox_review',landing:R2_MASTR_LANDING,maxFiles:1,bulkRequestNotYetAuthorized:true,requiresSeparateStructuredCap:true,existingCoreAcquisitionMaxBytes:64*MiB,existingStructuredWorkerTransportMaxBytes:90*MiB,missingNativeEvidence:['Exact static ZIP href and its current version/size from admitted landing bytes','Published integrity evidence if any; explicitly record absent publisher hash rather than fabricate one','Native solar/wind/operator XML schema and public-organization disclosure fields','Reviewed bounded streaming acquisition and ZIP/XML parser sandbox, not the current whole-buffer CSV route']},genesis:{table:'31231-02-01',year:R2_HOUSING_YEAR,referenceDate:R2_HOUSING_YEAR+'-12-31',yearChoice:'Explicit bounded comparable year; not a claim that it is the latest available year',metadataGate:'Successful admitted native table metadata must confirm table 31231-02-01, GE/GEMEIN and requested year before any data POST; otherwise stop for review, no guessed suffix or variable',credentialPolicy:'Existing owner-account headers injected by Core for data/table only; no credential values or GAST fallback in this plan',fallbackRequests:0},issuancePreconditions:['Main review and separate structured security release v3; R1 structured release v2 is not authority for this plan','Byte-pinned current robots/TDM, licence, distribution markings and attribution; no inherited R1 robots exception','Review preflight and pin its manifest before resolving/issuing the one bulk request; newly observed redirect/download hosts require explicit review and policy admission','Streaming bulk transport/parser and minimized native XML mapping must be reviewed before bulk fetch or parsing; never raise the generic 64MiB/90MiB limits','Bound all policy probes, redirects, failures and response bytes in the single global ledger; no automatic retry or additional pages']};
}

export interface R2MastrDiscoveryPins {sourceSha256:string;policyReceiptSha256:string;stepReceiptSha256:string;resultSha256:string}
/** Plan from sandbox-produced references, never parse untrusted HTML on the
 * host. Main must authenticate these pins against native committed discovery
 * and replay before issuing anything; this pure planner is not admission. */
export function planR2MastrBulkRequest(discovery:DiscoveryResult,pins:R2MastrDiscoveryPins){
 for(const hash of Object.values(pins))HashSchema.parse(hash);
 if(discovery.coverage.state!=='partial'||discovery.coverage.nextCursor!==null||discovery.resources.length!==discovery.coverage.observedRows)throw Error('Complete bounded native discovery references required before selecting the bulk request');
 const candidates=new Map<string,string>();
 for(const resource of discovery.resources){
  if(resource.format!=='zip')continue;
  const url=publicUrl(resource.url);
  if(resource.parentId!==R2_MASTR_LANDING||resource.method!=='GET'||resource.body!==null||url.protocol!=='https:'||url.hash||!url.pathname.toLowerCase().endsWith('.zip')||resource.nativeId!==url.pathname+url.search)throw Error('Bulk reference differs from exact native static download discovery');
  if([...url.searchParams.keys()].some(key=>/token|signature|session|password|secret|api.?key|expires|^sig$/iu.test(key)))throw Error('Session/signed/credential-bearing bulk URL is not the approved static route');
  candidates.set(url.href,resource.nativeId);
 }
 if(candidates.size!==1)throw Error('Exactly one native static Gesamtdatenexport ZIP link must be pinned after preflight; no invented endpoint or latest-version guess');
 const [url,nativeId]=[...candidates][0],originReviewRequired=new URL(url).origin!==new URL(R2_MASTR_LANDING).origin;
 const request:R2StructuredRequest={id:'mastr-bulk',phase:'mastr_bulk',sourceId:'mastr',municipalityId:null,url,method:'GET',body:null,contentType:null,maxBodyBytes:R2_STRUCTURED_CAPS.maxBulkCompressedBytes,maxNetworkAttempts:8,credentials:'none'};
 return {request,discovery:{...pins,landing:R2_MASTR_LANDING,nativeId},originReviewRequired,versionSizeAndPublisherIntegrity:'Require independent exact native metadata/quote pins; not inferred by this resolver',requiresCanonicalDiscoveryReplay:true,requiresNewIssuedRequestPin:true,requiresReviewedStreamingTransportAndParser:true,executableByExistingCore:false};
}
