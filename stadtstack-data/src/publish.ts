import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {diff} from './changes.ts';
import {cacheDir,outDir,jsonFile,save} from './common.ts';
import {validatePublication,cityFeedSchema} from './schema.ts';
import {compactCollection} from './min.ts';
import type {Catalogue,FeatureCollection,CityFeed} from './schema.ts';
import {hash} from './common.ts';
import {validateCore,validateCoreBytes,extractorVersion} from './core.ts';
import type {CoreBundle} from './core-schema.ts';
const catalogue=await jsonFile<Catalogue>(join(cacheDir,'staging','catalogue.json'));if(!catalogue)throw Error('Run npm run collect first');const collections:Record<string,unknown>={},feeds:Record<string,unknown>={};for(const city of catalogue.cities){collections[city.id]=await jsonFile<FeatureCollection>(join(cacheDir,'staging','cities',city.id,'signals.geojson'));feeds[city.id]=await jsonFile(join(cacheDir,'staging','cities',city.id,'feed.json'));}
const validated=validatePublication(catalogue,collections);const validatedFeeds:Record<string,CityFeed>=Object.fromEntries(Object.entries(feeds).map(([id,feed])=>[id,cityFeedSchema.parse(feed)]));for(const city of catalogue.cities)if(validatedFeeds[city.id].cityId!==city.id)throw Error(`Wrong feed city for ${city.id}`);
// All required gates are validated before the first public output is replaced.
let core:CoreBundle|undefined;
if(validated.collections.strausberg){
 core=validateCore(await jsonFile(join(cacheDir,'staging','core','strausberg-facts.json')),validated.collections.strausberg);
 await validateCoreBytes(core);
 if(validated.catalogue.coreBundle?.version!==core.version)throw Error('Catalogue/core release binding mismatch');
}
const coreOnly=process.argv.includes('--core-only');
if(coreOnly&&!core)throw Error('Core-only publication requires Strausberg core gates');
const prepared=validated.catalogue.cities.filter(city=>!coreOnly||city.id==='strausberg').map(city=>{
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
 if(!coreOnly){const feed=validatedFeeds[city.id];await save(join(directory,'feed.json'),JSON.stringify(feed,null,2)+'\n');}
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
 'Eight pilot cities. Council archives and live OParl feeds cover recent pages, not all proceedings; highways include a ~25 km margin for commutes, not municipal streetwork; places are unverified OSM listings. Collection failures appear in catalogue sources. Null geometry means citywide or not yet geocoded; an approximate point does not establish impacts at an address. No private location or profile enters these public files.'
];
await save(join(outDir,'README.md'),summary.join('\n')+'\n');
