import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {diff} from './changes.ts';
import {cacheDir,outDir,jsonFile,save} from './common.ts';
import {validatePublication,cityFeedSchema,collectionSchema} from './schema.ts';
import {compactCollection} from './min.ts';
import type {Catalogue,FeatureCollection,CityFeed} from './schema.ts';
import {hash} from './common.ts';
import {validateCore,validateCoreBytes,extractorVersion} from './core.ts';
import type {CoreBundle} from './core-schema.ts';
import {normalizePublicationSignals,assertPublicUrls} from './publication-quality.ts';
import {normalizeRegionalPublication} from './regional-quality.ts';
import {sourceHealth,cityTemporalCoverage,assertSourceHealth} from './source-health.ts';
import {publishDataRelease} from './data-release.ts';
import {districtRegistrySchema} from './district-registry.ts';
import {validateKnowledgeRelease} from './district-schema.ts';
import {districtCoverageSchema,validateDistrictCoverage,assertKnowledgeSlice} from './district-publication.ts';
if(process.argv.length>2)throw Error('publish takes no options; every release is validated as one complete dataset');
const catalogue=await jsonFile<Catalogue>(join(cacheDir,'staging','catalogue.json'));
if(!catalogue)throw Error('Run collection or quality refresh first');
const collections:Record<string,FeatureCollection>={},feeds:Record<string,unknown>={};
const cityQuality=[];
for(const city of catalogue.cities){
 const original=collectionSchema.parse(await jsonFile(join(cacheDir,'staging','cities',city.id,'signals.geojson')));
 const normalized=normalizePublicationSignals(original.features);
 collections[city.id]={type:'FeatureCollection',features:normalized.features};
 city.sources=city.sources.map(source=>sourceHealth(source,normalized.features));
 city.temporalCoverage=cityTemporalCoverage(normalized.features);
 cityQuality.push({cityId:city.id,...normalized.counts,quarantined:normalized.quarantined,sources:city.sources.map(source=>({id:source.id,status:source.status,recordCount:source.recordCount,publishedRecordCount:source.publishedRecordCount,coverage:source.coverage,licence:source.licence,licenceEvidence:source.licenceEvidence}))});
 feeds[city.id]=await jsonFile(join(cacheDir,'staging','cities',city.id,'feed.json'));
}
const regionalInput=await jsonFile(join(cacheDir,'staging','regions','brandenburg-mol','topics.json'))??await jsonFile(join(outDir,'regions','brandenburg-mol','topics.json'));
const regional=normalizeRegionalPublication(regionalInput);
const knowledgeRegistry=districtRegistrySchema.parse(await jsonFile(join(cacheDir,'staging','knowledge','registry.json'))??await jsonFile(join(outDir,'knowledge','registry.json')));
const knowledge=validateKnowledgeRelease(await jsonFile(join(cacheDir,'staging','knowledge','records.json'))??await jsonFile(join(outDir,'knowledge','records.json')),knowledgeRegistry);
const knowledgeCoverage=districtCoverageSchema.parse(await jsonFile(join(cacheDir,'staging','knowledge','coverage.json'))??await jsonFile(join(outDir,'knowledge','coverage.json')));
validateDistrictCoverage(knowledgeCoverage,knowledgeRegistry,knowledge.records);
assertKnowledgeSlice(knowledgeRegistry,knowledge.records);
const validated=validatePublication(catalogue,collections);
const validatedFeeds:Record<string,CityFeed>=Object.fromEntries(Object.entries(feeds).map(([id,feed])=>[id,cityFeedSchema.parse(feed)]));
for(const city of catalogue.cities)if(validatedFeeds[city.id].cityId!==city.id)throw Error(`Wrong feed city for ${city.id}`);
assertSourceHealth(validated.catalogue,validated.collections);
assertPublicUrls({catalogue:validated.catalogue,collections:validated.collections,feeds:validatedFeeds,regional:regional.data,knowledgeRegistry,knowledge,knowledgeCoverage});
const qualityReport={schemaVersion:'stadtstack-publication-quality-v1',generatedAt:new Date().toISOString(),
 policy:{publicUrls:'required',councilBodyBinding:'required',emptySuccess:'forbidden',sourceEventDates:'required; unresolved comparison records quarantined',placeDates:'observation only; no invented event date'},
 cities:cityQuality,regional:{input:regional.inputRecords,published:regional.publishedRecords,quarantined:regional.quarantined},
 knowledge:{published:knowledge.records.length,municipalities:knowledgeCoverage.municipalities.filter(city=>city.publishedRecords>0).length,districts:knowledgeCoverage.districts,policy:'Actual subscription extraction plus deterministic, source-policy, faithfulness and sourced-date publication gates; discovery coverage is not full municipal coverage.'},
 summary:{publishedRecords:cityQuality.reduce((n,c)=>n+c.published,0)+regional.publishedRecords+knowledge.records.length,quarantinedRecords:cityQuality.reduce((n,c)=>n+c.quarantined.length,0)+regional.quarantined.length+knowledgeCoverage.municipalities.reduce((n,city)=>n+city.quarantinedRecords,0),cities:catalogue.cities.length,knowledgeMunicipalities:knowledgeCoverage.municipalities.filter(city=>city.publishedRecords>0).length,districts:knowledgeCoverage.districts.length}};
// All required gates are validated before the first public output is replaced.
let core:CoreBundle|undefined;
if(validated.collections.strausberg){
 core=validateCore(await jsonFile(join(cacheDir,'staging','core','strausberg-facts.json')),validated.collections.strausberg);
 await validateCoreBytes(core);
 if(validated.catalogue.coreBundle?.version!==core.version)throw Error('Catalogue/core release binding mismatch');
}
if(!core)throw Error('A full data release requires the selected Strausberg core facts');
const prepared=validated.catalogue.cities.map(city=>{
 const collection=validated.collections[city.id],full=JSON.stringify(collection,null,2)+'\n',min=JSON.stringify(compactCollection(collection))+'\n';
 city.minUrl=`cities/${city.id}/signals.min.geojson`;
 city.fullBytes=Buffer.byteLength(full);
 city.minBytes=Buffer.byteLength(min);
 return {city,collection,full,min};
});
for(const {city,collection,full,min} of prepared){
 const directory=join(outDir,'cities',city.id),fullPath=join(directory,'signals.geojson'),changesPath=join(directory,'changes.json');
 let priorText:string|undefined;
 try{priorText=await readFile(fullPath,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(priorText!==full){
  const prior=priorText?JSON.parse(priorText) as FeatureCollection:undefined;
  if(priorText)await save(join(outDir,'previous','cities',city.id,'signals.geojson'),priorText);
  await save(fullPath,full);
  const changes={...diff(prior?.features??[],collection.features),generatedAt:catalogue.generatedAt};
  await save(changesPath,JSON.stringify(changes,null,2)+'\n');
 }else if(!await jsonFile(changesPath))throw Error(`Missing change manifest for ${city.id}`);
 await save(join(directory,'signals.min.geojson'),min);
 const feed=validatedFeeds[city.id];await save(join(directory,'feed.json'),JSON.stringify(feed,null,2)+'\n');
 console.log(city.id,collection.features.length,city.fullBytes,city.minBytes);
}
await save(join(outDir,'catalogue.json'),JSON.stringify(validated.catalogue,null,2)+'\n');
if(core){
 const bytes=JSON.stringify(core,null,2)+'\n',bundleSha256=hash(bytes);
 const manifest={schemaVersion:'stadtstack-core-release-v1',cityId:'strausberg',generatedAt:core.generatedAt,bundlePath:'core/strausberg-facts.json',bundleSha256,bundleVersion:core.version,extractorVersion,facts:core.facts.map(f=>({id:f.id,version:f.version,assertionHash:f.verification.assertionHash,sourceSha256:f.source.sha256,evidenceHash:f.verification.faithfulness.evidenceHash})),sources:core.facts.map(f=>({url:f.source.url,sha256:f.source.sha256,retrievedAt:f.source.retrievedAt,documentDate:f.source.documentDate})),gates:{required:true,deterministic:'passed',faithfulnessThreshold:.8,model:'codex:gpt-6-luna'},corpus:{fullPath:'cities/strausberg/signals.geojson',fullSha256:hash(prepared.find(p=>p.city.id==='strausberg')!.full),minPath:'cities/strausberg/signals.min.geojson',minSha256:hash(prepared.find(p=>p.city.id==='strausberg')!.min)}};
 await save(join(outDir,'core','strausberg-facts.json'),bytes);
 await save(join(outDir,'core','release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 await save(join(outDir,'core','handover-draft.json'),JSON.stringify({schemaVersion:'stadtstack-handover-draft-v1',label:'DRAFT — not sent; no municipality handover or receipt',status:'not-sent',recipient:'Stadt Strausberg (draft only)',bundleVersion:core.version,bundleSha256,facts:manifest.facts,request:'Bitte die verlinkten Originalquellen und gegebenenfalls neuere Veröffentlichungen prüfen.',pollResults:null,councilReceipt:null},null,2)+'\n');
}
await save(join(outDir,'regions','brandenburg-mol','topics.json'),JSON.stringify(regional.data,null,2)+'\n');
for(const [name,data] of [['registry',knowledgeRegistry],['records',knowledge],['coverage',knowledgeCoverage]] as const)await save(join(outDir,'knowledge',name+'.json'),JSON.stringify(data,null,2)+'\n');
await save(join(outDir,'quality-report.json'),JSON.stringify(qualityReport,null,2)+'\n');
const releasePaths=['catalogue.json','quality-report.json','regions/brandenburg-mol/topics.json','core/strausberg-facts.json','core/release-manifest.json','core/handover-draft.json','knowledge/registry.json','knowledge/records.json','knowledge/coverage.json',
 ...catalogue.cities.flatMap(city=>['signals.geojson','signals.min.geojson','feed.json','changes.json'].map(file=>`cities/${city.id}/${file}`))];
const dataRelease=await publishDataRelease(outDir,releasePaths,qualityReport.summary);
console.log('data release',dataRelease.id,qualityReport.summary);
const summary=[
 '# Stadtstack open-data snapshot',
 '',
 `As of: ${catalogue.generatedAt}. Publisher: ${catalogue.publisher}. This export contains separately attributed derived facts, not municipal endorsement, complete inventories, current operating-status guarantees, or third-party PDF/image reproductions.`,
 '',
 '## Attribution and reuse',
 '',
 ...catalogue.cities.flatMap(c=>[`${c.name} (${c.id}): ${c.sources.map(s=>`${s.id} — ${s.publisher}, ${s.licence}, ${s.reuse}${s.status==='failed'?' (failed; '+s.error+')':''}`).join('; ') || 'no source available'}`, '']),
 'OpenStreetMap place records are an ODbL 1.0 derivative database: © OpenStreetMap contributors, https://www.openstreetmap.org/copyright ; reuse and share-alike obligations apply to that separable subset. Source-specific licence and reuse metadata on each record controls other records; a public PDF is not itself an open-data licence. Ordinance facts are attributed under § 5 UrhG; council papers are short original factual summaries with outbound links, not copied attachments. Autobahn API licence is not verified. The city feeds contain only headlines, publisher names, publication/event dates and source links; feed licences are unknown, and no article body is reproduced. Treat feed items as attribution-linked factual notices, not licensed article text.',
 '',
 '## Compact map display',
 '',
 'Each city also publishes `signals.min.geojson` beside the full `signals.geojson`. Catalogue `minUrl` is relative to this catalogue; `fullBytes` and `minBytes` are exact UTF-8 file sizes. The compact map projection retains all features and stable ids/versions, with coordinates snapped to five decimals and line/polygon vertices simplified by Douglas–Peucker at ~4 m, keeping valid polygon topology. Sub-grid multipolygon components and holes can be omitted from the display geometry; the full file is unchanged. Each compact record carries `sourceCount`, one attributed `primarySource` and optional faithfulness score/threshold; exact locators, source hashes, all sources and review reasoning remain in the full feature retrievable by id. ODbL and all other source-specific rights apply equally to both projections.',
 '',
 '## Shared object identity',
 '',
 'CCF and live OParl records sharing the same upstream object URL become one council feature with a provider-independent `council:` id. HTTP/HTTPS and trailing slash variations are normalized; the newer upstream modification wins, but both archive and live source entries remain attributed. Nearby OSM nodes and ways with the same name/category are represented once with both ODbL sources. Repeated title and date alone do not prove identity: separate binding-plan polygons, highway segments and committee meetings may legitimately share them. On this first canonical-ID cutover, removed legacy `ccf:`/`oparl:` identifiers and added `council:` identifiers are a migration, not proof that proposals were withdrawn.',
 '',
 '## Automated core facts',
 '',
 'core/strausberg-facts.json and core/release-manifest.json bind three selected assertions to original PDF byte SHA-256, extractor/assertion versions, named deterministic checks and actual DeepEval/Codex faithfulness evidence (threshold 0.8). auto-verified means these automated gates passed, not human review or independent truth certification; the evidence uses one primary source per assertion, not independent corroboration. The 14 September 2026 lake value is historical, relative to Normalstau, and its source is dated 5 October 2026. Budget values are planned investment outlays, not actual spending. core/handover-draft.json is labelled not-sent: no poll result, municipal endorsement or council receipt is claimed. Original PDFs and extracted text stay in ignored cache.',
 '',
 '## Coverage and privacy',
 '',
 'Pilot-city coverage is source-specific. Council collection requests 24 months and records complete/partial/empty/failed coverage and body identity; it is not a claim of all proceedings. Missing source dates are quarantined from comparisons, not replaced by retrieval time. Highway information includes a ~25 km commuter margin; OSM places remain unverified observations. quality-report.json records withheld counts/reasons; release-manifest.json binds every public data file, including regional records, to one release identity. No private location or profile enters these public files.'
];
await save(join(outDir,'README.md'),summary.join('\n')+'\n');
