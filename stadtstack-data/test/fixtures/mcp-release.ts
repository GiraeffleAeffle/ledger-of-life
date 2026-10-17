import {hash,signal,sourceFrom} from '../../src/common.ts';
import {QueryIndex,type Regional} from '../../src/mcp-query.ts';
import {coreBundleSchema,gatePolicy,type CoreFact} from '../../src/core-schema.ts';
import {KNOWLEDGE_SCHEMA_VERSION} from '../../src/district-schema.ts';
import {buildKnowledgeGraph} from '../../src/district-graph.ts';
import {GraphIndex} from '../../src/district-graph-query.ts';
import {districtRegistrySchema} from '../../src/district-registry.ts';
import {buildDistrictCoverage} from '../../src/district-publication.ts';
import {sealPublicationInputs,type PublicationInputs} from '../../src/district-publication-inputs.ts';
import {dataReleaseId} from '../../src/data-release.ts';
import {diff,signalChangeRecord} from '../../src/changes.ts';
import type {ReleasedData,ReleasedKnowledge} from '../../src/mcp-release.ts';
import type {Catalogue} from '../../src/schema.ts';
import {verifiedMask} from './revocations.ts';

// In-memory, synthetic serving metadata only. Not admission receipts, publisher facts,
// a finalized candidate, or a fixture that can bypass the governed release loader.
const at='2026-10-10T12:00:00.000Z';
export function syntheticRelease(index?:QueryIndex):ReleasedData {
 const sourceBytes=Buffer.from('Synthetic core source');
 const source=sourceFrom({body:sourceBytes,sha256:hash(sourceBytes),retrievedAt:at,url:'https://example.org/synthetic-core'},'Synthetic','Synthetic publisher','Synthetic fixture');
 const features=['first','second','third'].map(id=>signal({id:`fixture:${id}`,cityId:'strausberg',kind:'council_paper',category:'planning',title:`Synthetic Solarpark ${id}`,statement:`Synthetic Solarpark ${id}`,status:'draft',startDate:'2025-08-07',endDate:null,nextStep:'Synthetic fixture',unknowns:[],scale:'city',geometryPrecision:'none',sources:[source],extraction:{method:'structured'},reviewState:'candidate',asOf:at},null));
 const facts:CoreFact[]=features.map((feature,i)=>{
  const id=feature.properties.id,statement=feature.properties.statement,assertion={value:i+1,unit:'EUR' as const},assertionHash=hash(JSON.stringify({id,statement,assertion})),extractorVersion='synthetic-fixture';
  const faithfulness={score:1,threshold:0.8 as const,reason:'Synthetic metadata; no model judgment',evaluator:'synthetic-fixture',model:'codex:gpt-6-luna' as const,actual:true as const,evaluatedAt:at,statementHash:hash(statement),contextHash:source.sha256!};
  return {id,statement,assertion,source:{url:source.url,sha256:source.sha256!,retrievedAt:at,publisher:'Stadt Strausberg',documentDate:'2025-08-07',locator:source.locator,title:'Synthetic fixture'},version:hash(JSON.stringify({assertionHash,sourceSha256:source.sha256,extractorVersion})),topic:'budget',verification:{status:'auto-verified',meaning:'Passed named automated gates; not human review or independent truth certification.',evidenceBasis:'single-primary-source; no independent corroboration',policy:gatePolicy,extractorVersion,assertionHash,sourceSha256:source.sha256!,deterministic:{passed:true,checks:['synthetic-fixture']},faithfulness:{...faithfulness,evidenceHash:hash(JSON.stringify(faithfulness))}}};
 });
 const bundle=coreBundleSchema.parse({schemaVersion:'stadtstack-core-facts-v1',cityId:'strausberg',version:hash(JSON.stringify(facts.map(({id,version})=>({id,version})))),generatedAt:at,facts});
 const knowledge:ReleasedKnowledge={schemaVersion:KNOWLEDGE_SCHEMA_VERSION,generatedAt:at,identityAssertions:[],identityAdmissions:[],records:index?.knowledge?.records??[]};
 const knowledgeBytes=JSON.stringify(knowledge),files=[{path:'knowledge/records.json',sha256:hash(knowledgeBytes),bytes:Buffer.byteLength(knowledgeBytes)}];
 const releaseId=index?.releaseId??dataReleaseId(files),revocations=verifiedMask(releaseId);
 const catalogue:Catalogue={schemaVersion:'stadtstack-signals-v1',generatedAt:at,publisher:'Synthetic fixture',cities:[{id:'strausberg',name:'Strausberg',state:'Synthetic',center:[13.88,52.58],bbox:[13,52,14,53],sources:[]}]};
 const regional:Regional=index?.regional??{schemaVersion:'stadtstack-regional-topics-v1',generatedAt:at,asOf:at.slice(0,10),region:{id:'synthetic',name:'Synthetic'},municipalities:[],topics:[]};
 const identity={url:'https://example.org/identity',locator:'Synthetic identity fixture',sha256:hash('synthetic identity'),retrievedAt:at};
 const registry=districtRegistrySchema.parse({schemaVersion:'stadtstack-source-registry-v1',generatedAt:at,districts:[{id:'maerkisch-oderland',name:'Synthetic district',ags:'12064',state:'Synthetic',inventorySources:[identity],inventoryAsOf:at,inventoryComplete:true}],municipalities:[{id:'strausberg',name:'Strausberg',ags:'12064472',districtId:'maerkisch-oderland',districtAgs:'12064',amt:null,administrativeStatus:'amtsfrei',administrativeEvidence:[identity],identitySources:[identity],sources:['council','participation','gazette','website'].map(kind=>({id:kind,kind,url:null,vendor:'unknown',checkState:'not_checked',checkedAt:null,evidence:[],reason:'Synthetic fixture; no acquisition'})),seedDocuments:[{url:'https://example.org/seed',sourceId:'website',title:'Synthetic seed',documentDate:null,dateReason:'Synthetic fixture',evidence:[identity]}]}],inventory:[{ags:'12064472',name:'Strausberg',districtId:'maerkisch-oderland',identitySourceUrl:identity.url,pilot:true,sourceCheckState:'not_checked',reason:'Synthetic fixture'}],notes:[]});
 const coverage=buildDistrictCoverage(registry,{schemaVersion:'stadtstack-crawl-index-v1',generatedAt:at,documents:[],checks:[]},[],{schemaVersion:'stadtstack-quarantine-v1',cases:[]},null,at);
 const dependencies:PublicationInputs['dependencies']=(['registry','candidate_records','candidate_quarantine','policy_receipts','critical_assessments','publication_contract','graph_contract','schema_contract'] as const).map(role=>({role,sha256:hash(`synthetic ${role}`)}));
 const priorMembers=[...files,{path:'cities/strausberg/signals.geojson',sha256:hash(JSON.stringify(features)),bytes:Buffer.byteLength(JSON.stringify(features))}];
 const publicationInputs=sealPublicationInputs({asOf:at.slice(0,10),policy:{snapshotSha256:hash(JSON.stringify({records:[]})),receipts:[]},dependencies,staging:new Map([['knowledge/records.json',Buffer.from(knowledgeBytes)]]),priorRelease:{gitCommit:'0'.repeat(40),manifestSha256:hash('synthetic predecessor manifest'),releaseId:dataReleaseId(priorMembers),members:priorMembers}});
 const graphData=buildKnowledgeGraph(knowledgeBytes,{asOf:at.slice(0,10)}),graph=new GraphIndex(releaseId,graphData,knowledgeBytes,undefined,revocations);
 return {mode:'sealed',revocations,dataManifest:{schemaVersion:'stadtstack-data-release-v1',id:releaseId,generatedAt:at,files,quality:{publishedRecords:features.length,quarantinedRecords:0,cities:1}},publicationInputs,bundle,manifest:{bundleSha256:hash(JSON.stringify(bundle)),bundleVersion:bundle.version},catalogue,features:index?[]:features,feeds:{},changes:index?{}:{strausberg:diff([],features.map(signalChangeRecord),at)},regional,knowledge,knowledgeBytes,registry,coverage,servedCoverage:null,knowledgeChanges:{schemaVersion:'stadtstack-changes-v2',generatedAt:at,snapshots:[],events:[]},graphData:graph.graphView(),graph,index:index??new QueryIndex(releaseId,at,features,regional,catalogue),visibility:null};
}
