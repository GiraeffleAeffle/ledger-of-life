import {readFile,lstat} from 'node:fs/promises';
import {z} from 'zod';
import {pathToFileURL} from 'node:url';
import {ScopeSchema,HashSchema,CoverageSchema,ObservationSchema,PARSER_INPUT_MAX_BYTES,canonicalJson,digest,type StructuredAdapter,type AdmittedSnapshot} from './district-adapter-contract.ts';
import {genesisAdapter} from './adapters/genesis.ts';
import {mastrAdapter} from './adapters/mastr.ts';
import {createPlanningWfsAdapter,type PlanningWfsOptions} from './adapters/planning-wfs.ts';
import {fundingOperationsAdapter} from './adapters/funding-operations.ts';
import {createProcurementAdapter} from './adapters/procurement.ts';
import {createCouncilAdapter,type CouncilAdapterOptions} from './adapters/council.ts';
import {permitNoticesAdapter} from './adapters/permit-notices.ts';
import {municipalFinanceAdapter} from './adapters/municipal-finance.ts';
import {sectorPlansAdapter} from './adapters/sector-plans.ts';
import {createZensusAdapter,type ZensusOptions} from './adapters/zensus.ts';
import {createGtfsAdapter} from './adapters/gtfs.ts';
import {createStateStatisticsAdapter,type StateStatisticsOptions} from './adapters/state-statistics.ts';
import {createEducationAdapter,type EducationOptions} from './adapters/education.ts';
import {createEnergyAtlasAdapter,type AtlasLayerContract} from './adapters/energy-atlas.ts';
import {createGaugesAdapter,stateGaugesAdapter} from './adapters/gauges.ts';

export const STRUCTURED_WORKER_VERSION='district-structured-worker-v1';
export const StructuredSnapshotMetadataSchema=z.object({sourceSha256:HashSchema,url:z.url(),mimeType:z.string().min(1),retrievedAt:z.iso.datetime(),policyReceiptSha256:HashSchema,sourceVersion:z.string().nullable(),request:z.object({method:z.enum(['GET','POST']),body:z.string().nullable(),contentType:z.string().nullable()}).strict()}).strict();
export const StructuredWorkerRequestSchema=z.object({version:z.literal(STRUCTURED_WORKER_VERSION),operation:z.enum(['discover','parse']),adapter:z.enum(['genesis','mastr','planning-wfs','funding-operations','procurement','council','permit-notices','municipal-finance','sector-plans','zensus','gtfs','state-statistics','education','energy-atlas','gauges','state-gauges']),options:z.record(z.string(),z.unknown()),scope:ScopeSchema,cursor:z.string().nullable(),snapshot:StructuredSnapshotMetadataSchema,inputArtifactSha256:HashSchema,auxiliary:z.array(z.object({slot:z.enum(['municipalBoundaries','stationSnapshot']),snapshot:StructuredSnapshotMetadataSchema}).strict()).max(2)}).strict();
export const StructuredInputBundleSchema=z.object({version:z.literal('structured-input-bundle-v1'),sourceBytes:z.string().max(90*1024*1024),auxiliary:z.array(z.object({slot:z.enum(['municipalBoundaries','stationSnapshot']),bytes:z.string().max(90*1024*1024)}).strict()).max(2)}).strict();
export type StructuredWorkerRequest=z.infer<typeof StructuredWorkerRequestSchema>;
/** Fixed allowlisted factories only. Configuration is pinned in job identity; no module paths, evaluation or network capability. */
export function structuredAdapterFor(request:StructuredWorkerRequest,auxiliary:Partial<Record<'municipalBoundaries'|'stationSnapshot',AdmittedSnapshot>>={}):StructuredAdapter {
 const options=request.options;
 if(Object.hasOwn(options,'municipalBoundaries')||Object.hasOwn(options,'stationSnapshot'))throw Error('Supporting snapshot bytes must use admitted artifact transport');
 switch(request.adapter){
  case 'genesis':return genesisAdapter;
  case 'mastr':return mastrAdapter;
  case 'planning-wfs':return createPlanningWfsAdapter(options as PlanningWfsOptions);
  case 'funding-operations':return fundingOperationsAdapter;
  case 'procurement':return createProcurementAdapter(options as Parameters<typeof createProcurementAdapter>[0]);
  case 'council':return createCouncilAdapter(options as CouncilAdapterOptions);
  case 'permit-notices':return permitNoticesAdapter;
  case 'municipal-finance':return municipalFinanceAdapter;
  case 'sector-plans':return sectorPlansAdapter;
  case 'zensus':return createZensusAdapter(options as ZensusOptions);
  case 'gtfs':return createGtfsAdapter({municipalBoundaries:auxiliary.municipalBoundaries});
  case 'state-statistics':return createStateStatisticsAdapter(options as unknown as StateStatisticsOptions);
  case 'education':return createEducationAdapter(options as EducationOptions);
  case 'energy-atlas':return createEnergyAtlasAdapter(options.layers as AtlasLayerContract[]|undefined);
  case 'gauges':return createGaugesAdapter({stationSnapshot:auxiliary.stationSnapshot});
  case 'state-gauges':return stateGaugesAdapter;
 }
}
export const StructuredOutputPageSchema=z.object({offset:z.number().int().nonnegative(),end:z.number().int().nonnegative(),total:z.number().int().nonnegative(),nextCursor:z.string().nullable(),bindingSha256:HashSchema,sourceCoverage:CoverageSchema}).strict();
export function pageStructuredResult(result:{observations:z.infer<typeof ObservationSchema>[];coverage:z.infer<typeof CoverageSchema>},request:StructuredWorkerRequest){
 const bindingSha256=digest(canonicalJson({...request,cursor:null}));
 let offset=0;
 if(request.cursor!==null){const cursor=z.object({kind:z.literal('structured-output-page-v1'),bindingSha256:HashSchema,offset:z.number().int().nonnegative()}).strict().parse(JSON.parse(request.cursor));if(cursor.bindingSha256!==bindingSha256)throw Error('Structured output cursor scope mismatch');offset=cursor.offset;}
 if(offset>result.observations.length||offset===result.observations.length&&offset!==0)throw Error('Structured output cursor exceeds result');
 let end=offset,bytes=0;
 while(end<result.observations.length){const size=Buffer.byteLength(canonicalJson(result.observations[end]));if(size>2*1024*1024)throw Error('Single structured observation exceeds bounded page');if(end>offset&&bytes+size>2*1024*1024)break;bytes+=size;end++;}
 const nextCursor=end<result.observations.length?canonicalJson({kind:'structured-output-page-v1',bindingSha256,offset:end}):null;
 const page=StructuredOutputPageSchema.parse({offset,end,total:result.observations.length,nextCursor,bindingSha256,sourceCoverage:result.coverage});
 const paged=offset>0||end<result.observations.length;
 return {result:{observations:result.observations.slice(offset,end),coverage:paged?{...result.coverage,state:['complete','empty'].includes(result.coverage.state)?'partial' as const:result.coverage.state,nextCursor:nextCursor??result.coverage.nextCursor,limitations:[...result.coverage.limitations,'Bounded parser-output page; full source completeness requires all output pages and the original source coverage receipt.']}:result.coverage},page};
}
export async function runStructuredWorker(artifactPath:string,requestInput:unknown):Promise<string> {
 if(artifactPath!=='/input/document')throw Error('Structured worker requires selected sandbox input');
 const request=StructuredWorkerRequestSchema.parse(requestInput),stat=await lstat(artifactPath);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>PARSER_INPUT_MAX_BYTES)throw Error('Structured input bound/type rejected');
 const artifactBytes=await readFile(artifactPath);
 if(digest(artifactBytes)!==request.inputArtifactSha256)throw Error('Structured worker input artifact hash mismatch');
 let bytes=artifactBytes;
 const auxiliary:Partial<Record<'municipalBoundaries'|'stationSnapshot',AdmittedSnapshot>>={};
 if(request.auxiliary.length){
  const bundle=StructuredInputBundleSchema.parse(JSON.parse(artifactBytes.toString('utf8')));
  bytes=Buffer.from(bundle.sourceBytes,'base64');if(bytes.toString('base64')!==bundle.sourceBytes)throw Error('Noncanonical bundled source bytes');
  if(bundle.auxiliary.length!==request.auxiliary.length||new Set(bundle.auxiliary.map(row=>row.slot)).size!==bundle.auxiliary.length)throw Error('Supporting bundle inventory mismatch');
  for(const declared of request.auxiliary){const item=bundle.auxiliary.find(row=>row.slot===declared.slot);if(!item)throw Error('Missing supporting source bytes');const content=Buffer.from(item.bytes,'base64');if(content.toString('base64')!==item.bytes||digest(content)!==declared.snapshot.sourceSha256)throw Error('Supporting source byte binding mismatch');auxiliary[declared.slot]={...declared.snapshot,bytes:content};}
 }
 if(digest(bytes)!==request.snapshot.sourceSha256)throw Error('Structured worker source hash mismatch');
 const snapshot:AdmittedSnapshot={...request.snapshot,bytes},adapter=structuredAdapterFor(request,auxiliary);
 const parsed=request.operation==='parse'?adapter.parse(snapshot,request.scope):adapter.discover(snapshot,request.scope,request.cursor);
 CoverageSchema.parse(parsed.coverage);
 if('observations' in parsed)for(const row of parsed.observations)ObservationSchema.parse(row);
 const {result,page}='observations' in parsed?pageStructuredResult(parsed,request):{result:parsed,page:null};
 const output=canonicalJson({version:STRUCTURED_WORKER_VERSION,requestSha256:digest(canonicalJson(request)),adapterId:adapter.id,adapterVersion:adapter.version,result,page});
 if(Buffer.byteLength(output)>4*1024*1024)throw Error('Structured parser output bound exceeded');
 return output;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try {
  if(process.argv.length!==4||Buffer.byteLength(process.argv[3])>65536)throw Error('Structured request bound rejected');
  process.stdout.write(await runStructuredWorker(process.argv[2],JSON.parse(process.argv[3])));
 }catch{process.stderr.write('Structured parser rejected bounded input\n');process.exitCode=1;}
}
