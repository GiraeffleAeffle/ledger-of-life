import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {districtRegistrySchema} from './district-registry.ts';
import {validateKnowledgeRelease} from './district-schema.ts';
import {buildDistrictCoverage,crawlSummarySchema} from './district-publication.ts';
import {assertPublicUrls} from './publication-quality.ts';
import {cacheDir,root,save} from './common.ts';

const {values}=parseArgs({options:{registry:{type:'string',default:join(root,'sources','district-registry.json')},index:{type:'string',default:join(cacheDir,'districts','index.json')},records:{type:'string',default:join(cacheDir,'district-extract','records.json')},quarantine:{type:'string',default:join(cacheDir,'district-extract','quarantine.json')},'extraction-run':{type:'string',default:join(cacheDir,'district-extract','extraction-run.json')},'minimum-per-district':{type:'string',default:'1'}}});
const minimum=Number(values['minimum-per-district']);
if(!Number.isInteger(minimum)||minimum<1)throw Error('Release acceptance requires at least one evidenced municipality in each district; individual record gates remain mandatory');
const registry=districtRegistrySchema.parse(JSON.parse(await readFile(resolve(values.registry!),'utf8')));
const knowledge=validateKnowledgeRelease(JSON.parse(await readFile(resolve(values.records!),'utf8')),registry);
const crawlInput=JSON.parse(await readFile(resolve(values.index!),'utf8'));
const crawl=crawlSummarySchema.parse(crawlInput);
const quarantine=JSON.parse(await readFile(resolve(values.quarantine!),'utf8'));
const extractionRun=JSON.parse(await readFile(resolve(values['extraction-run']!),'utf8'));
const collectedSources=new Set(crawl.documents.map(document=>JSON.stringify([document.municipalityId,document.sourceId,document.sha256,document.url])));
for(const record of knowledge.records){
 for(const source of record.sources)if(!collectedSources.has(JSON.stringify([record.municipalityId,source.id,source.sha256,source.url])))throw Error(`Knowledge source is not bound to the actual collected corpus: ${record.id}`);
}
const undated=knowledge.records.filter(record=>record.documentDate===null&&record.stageDate===null&&!record.stages.some(event=>event.date!==null));
const undatedIds=new Set(undated.map(record=>record.id));
if(!Array.isArray(quarantine.cases))throw Error('Missing actual extraction quarantine evidence');
for(const record of undated)quarantine.cases.push({municipalityId:record.municipalityId,sourceId:record.sources[0].id,sourceSha256:record.extraction.inputSha256,reason:'Publication withheld: no sourced document, stage or historical stage date',recordId:record.id});
knowledge.records=knowledge.records.filter(record=>!undatedIds.has(record.id));
await save(join(cacheDir,'knowledge-publication-quarantine.json'),JSON.stringify({schemaVersion:'stadtstack-publication-quarantine-v1',records:undated.map(record=>({id:record.id,municipalityId:record.municipalityId,reason:'missing_sourced_date'}))},null,2)+'\n');
for(const district of registry.districts){
 const observed=new Set(knowledge.records.filter(record=>record.districtId===district.id&&record.stage!=='unknown').map(record=>record.municipalityId));
 if(observed.size<minimum)throw Error(`Vertical slice incomplete for ${district.id}: ${observed.size}/${minimum} municipalities have dated passing records with a sourced stage`);
}
if(!knowledge.records.length)throw Error('No passing knowledge records');
const coverage=buildDistrictCoverage(registry,crawlInput,knowledge.records,quarantine,knowledge.records[0].extraction.model,extractionRun);
assertPublicUrls({registry,records:knowledge,coverage});
for(const [name,data] of [['registry',registry],['records',knowledge],['coverage',coverage]] as const)await save(join(cacheDir,'staging','knowledge',name+'.json'),JSON.stringify(data,null,2)+'\n');
console.log(JSON.stringify({schemaVersion:knowledge.schemaVersion,records:knowledge.records.length,municipalities:coverage.municipalities.filter(city=>city.publishedRecords>0).length,districts:coverage.districts.map(district=>({id:district.id,municipalitiesWithRecords:district.municipalitiesWithRecords,municipalitiesWithDatedStages:district.municipalitiesWithDatedStages,records:district.publishedRecords,quarantined:district.quarantinedRecords})),municipalityCoverage:coverage.municipalities.map(city=>({id:city.id,status:city.status,publishedRecords:city.publishedRecords,datedStagedRecords:city.datedStagedRecords}))}));
