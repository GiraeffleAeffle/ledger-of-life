import {readFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {districtRegistrySchema} from './district-registry.ts';
import {validateKnowledgeRelease} from './district-schema.ts';
import {authorizedPilotCorpusSchema} from './district-corpus.ts';
import {buildDistrictCoverage,crawlSummarySchema,knowledgePublicationHold} from './district-publication.ts';
import {assertPublicUrls} from './publication-quality.ts';
import {cacheDir,root,save,hash} from './common.ts';

export type PrepareKnowledgeOptions={registry:string;index:string;records:string;quarantine:string;extractionRun:string;minimum?:number;stagingDir?:string;publicationQuarantinePath?:string;coverageGeneratedAt?:string};
/** Cache-only publication gates; input record and extraction timestamps are preserved. */
export async function prepareKnowledge(options:PrepareKnowledgeOptions){
const minimum=options.minimum??1;
if(!Number.isInteger(minimum)||minimum<1)throw Error('Release acceptance requires at least one evidenced municipality in each district; individual record gates remain mandatory');
const registryBytes=await readFile(resolve(options.registry)),registry=districtRegistrySchema.parse(JSON.parse(registryBytes.toString('utf8')));
const knowledge=validateKnowledgeRelease(JSON.parse(await readFile(resolve(options.records),'utf8')),registry);
const crawlBytes=await readFile(resolve(options.index)),crawlInput=JSON.parse(crawlBytes.toString('utf8'));
const crawl=crawlSummarySchema.parse(crawlInput);
const quarantine=JSON.parse(await readFile(resolve(options.quarantine),'utf8'));
const extractionRun=JSON.parse(await readFile(resolve(options.extractionRun),'utf8'));
authorizedPilotCorpusSchema.parse(extractionRun.corpusSha256);
if(extractionRun.corpusSha256!==hash(crawlBytes)||extractionRun.registrySha256!==hash(registryBytes))throw Error('Extraction run is not bound to the frozen corpus/registry bytes');
const collectedSources=new Set(crawl.documents.map(document=>JSON.stringify([document.municipalityId,document.sourceId,document.sha256,document.url])));
for(const record of knowledge.records){
 for(const source of record.sources)if(!collectedSources.has(JSON.stringify([record.municipalityId,source.id,source.sha256,source.url])))throw Error(`Knowledge source is not bound to the actual collected corpus: ${record.id}`);
}
const publicationHolds=knowledge.records.flatMap(record=>{const hold=knowledgePublicationHold(record);return hold?[{record,hold}]:[];});
const withheldIds=new Set(publicationHolds.map(({record})=>record.id));
if(!Array.isArray(quarantine.cases))throw Error('Missing actual extraction quarantine evidence');
for(const {record,hold} of publicationHolds)quarantine.cases.push({municipalityId:record.municipalityId,sourceId:record.sources[0].id,sourceSha256:record.extraction.inputSha256,reason:`Publication withheld: ${hold.reasons.join(', ')}`,recordId:record.id});
knowledge.records=knowledge.records.filter(record=>!withheldIds.has(record.id));
await save(options.publicationQuarantinePath??join(cacheDir,'knowledge-publication-quarantine.json'),JSON.stringify({schemaVersion:'stadtstack-publication-quarantine-v1',records:publicationHolds.map(({record,hold})=>({id:record.id,municipalityId:record.municipalityId,...hold}))},null,2)+'\n');
for(const district of registry.districts){
 const observed=new Set(knowledge.records.filter(record=>record.districtId===district.id&&record.stage!=='unknown').map(record=>record.municipalityId));
 if(observed.size<minimum)throw Error(`Vertical slice incomplete for ${district.id}: ${observed.size}/${minimum} municipalities have dated passing records with a sourced stage`);
}
if(!knowledge.records.length)throw Error('No passing knowledge records');
const coverage=buildDistrictCoverage(registry,crawlInput,knowledge.records,quarantine,extractionRun,options.coverageGeneratedAt);
assertPublicUrls({registry,records:knowledge,coverage});
for(const [name,data] of [['registry',registry],['records',knowledge],['coverage',coverage]] as const)await save(join(options.stagingDir??join(cacheDir,'staging','knowledge'),name+'.json'),JSON.stringify(data,null,2)+'\n');
return {schemaVersion:knowledge.schemaVersion,records:knowledge.records.length,municipalities:coverage.municipalities.filter(city=>city.publishedRecords>0).length,districts:coverage.districts.map(district=>({id:district.id,municipalitiesWithRecords:district.municipalitiesWithRecords,municipalitiesWithDatedStages:district.municipalitiesWithDatedStages,records:district.publishedRecords,quarantined:district.quarantinedRecords})),municipalityCoverage:coverage.municipalities.map(city=>({id:city.id,status:city.status,publishedRecords:city.publishedRecords,datedStagedRecords:city.datedStagedRecords}))};
}
if(process.argv[1]&&await realpath(process.argv[1]).then(entry=>import.meta.url===pathToFileURL(entry).href,()=>false)){
 const {values}=parseArgs({options:{registry:{type:'string',default:join(root,'sources','district-registry.json')},index:{type:'string',default:join(cacheDir,'pilot-coverage-completion','index-authorized.json')},records:{type:'string',default:join(cacheDir,'district-joint','records.json')},quarantine:{type:'string',default:join(cacheDir,'district-joint','quarantine.json')},'extraction-run':{type:'string',default:join(cacheDir,'district-joint','extraction-run.json')},'minimum-per-district':{type:'string',default:'1'}}});
 console.log(JSON.stringify(await prepareKnowledge({registry:values.registry!,index:values.index!,records:values.records!,quarantine:values.quarantine!,extractionRun:values['extraction-run']!,minimum:Number(values['minimum-per-district'])})));
}
