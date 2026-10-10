import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {cacheDir,outDir,hash,jsonFile,save,ua} from './common.ts';
import {selected,extractorVersion,meaning,pageOne,deterministic,assertionHash,factVersion,bundleVersion,judgeEvidenceHash,coreSignal,validateCore,validateCoreBytes} from './core.ts';
import type {CoreFact,CoreBundle} from './core-schema.ts';
import {gatePolicy,faithfulnessGateSchema} from './core-schema.ts';
import type {Catalogue,FeatureCollection} from './schema.ts';
export async function evaluateCore(fromPublished=false){
 const base=fromPublished?outDir:join(cacheDir,'staging');
 const catalogue=await jsonFile<Catalogue>(join(base,'catalogue.json'));
 const collection=await jsonFile<FeatureCollection>(join(base,'cities','strausberg','signals.geojson'));
 if(!catalogue||!collection||!catalogue.cities.some(c=>c.id==='strausberg'))throw Error('Strausberg catalogue/corpus required');
 const sources=new Map<string,{bytes:Uint8Array;text:string;retrievedAt:string;sha256:string}>();
 const facts:CoreFact[]=[];
 for(const required of selected){
  if(!sources.has(required.url)){
   const response=await fetch(required.url,{headers:{'User-Agent':ua},signal:AbortSignal.timeout(60000)});
   if(!response.ok)throw Error(`Core original PDF unavailable: HTTP ${response.status}`);
   const bytes=new Uint8Array(await response.arrayBuffer());if(Buffer.from(bytes.subarray(0,5)).toString()!=='%PDF-')throw Error('Core source is not PDF');
   const sha256=hash(bytes),text=await pageOne(bytes),retrievedAt=new Date().toISOString();
   await save(join(cacheDir,'pdf',sha256+'.pdf'),bytes);await save(join(cacheDir,'pdf',sha256+'.txt'),text);
   sources.set(required.url,{bytes,text,retrievedAt,sha256});
  }
  const source=sources.get(required.url)!,checks=deterministic(source.text,required.id);
  const cacheKey=hash(JSON.stringify({sourceSha256:source.sha256,statementHash:hash(required.statement),contextHash:hash(source.text),extractorVersion,gatePolicy}));
  const gatePath=join(cacheDir,'core-judge',cacheKey+'.json');
  let faithfulness=await jsonFile<CoreFact['verification']['faithfulness']>(gatePath);
  if(faithfulness){
   faithfulness=faithfulnessGateSchema.parse(faithfulness);
   const {evidenceHash,...record}=faithfulness;
   if(record.statementHash!==hash(required.statement)||record.contextHash!==hash(source.text)||judgeEvidenceHash(record)!==evidenceHash)throw Error('Cached core judge evidence tampered');
  }else{
   const version=spawnSync(join(cacheDir,'venv','bin','python'),['-c','from importlib.metadata import version; print(version("deepeval"))'],{encoding:'utf8'});
   if(version.status!==0||version.stdout.trim()!==gatePolicy.metricVersion)throw Error('Required DeepEval metric version unavailable');
   const judge=spawnSync(join(cacheDir,'venv','bin','python'),['src/faithfulness.py'],{input:JSON.stringify({statement:required.statement,source:source.text,threshold:.8,penalize_ambiguous_claims:true,mode:'llm'}),encoding:'utf8',timeout:600000,env:{...process.env,DEEPEVAL_TELEMETRY_OPT_OUT:'YES'}});
   if(judge.status!==0){
    const unavailable=/model.*(?:not supported|unavailable|not found|does not exist)|unsupported.*model|gpt-6-luna/i.test(judge.stderr??'');
    throw Error(unavailable?'Required model codex:gpt-6-luna unavailable; no substitute or auto-verified release produced.':'Actual DeepEval core evaluation failed; no auto-verified release produced.');
   }
   const result=JSON.parse(judge.stdout.trim()) as {score:number;threshold:number;reason:string;evaluator:string};
   if(!Number.isFinite(result.score)||result.score<.8||result.score>1||result.threshold!==.8||!result.reason||!result.evaluator.includes('codex:gpt-6-luna'))throw Error('Actual core faithfulness gate failed');
   const record={...result,threshold:.8 as const,model:'codex:gpt-6-luna' as const,actual:true as const,evaluatedAt:new Date().toISOString(),statementHash:hash(required.statement),contextHash:hash(source.text)};
   faithfulness=faithfulnessGateSchema.parse({...record,evidenceHash:judgeEvidenceHash(record)});
   await save(gatePath,JSON.stringify(faithfulness));
  }
  await save(join(cacheDir,'core-evidence',faithfulness.evidenceHash+'.json'),JSON.stringify(faithfulness));
  const draft={id:required.id,topic:required.topic,statement:required.statement,assertion:required.assertion,source:{url:required.url,sha256:source.sha256,retrievedAt:source.retrievedAt,documentDate:required.documentDate,locator:required.locator,publisher:'Stadt Strausberg' as const,title:required.title}};
  facts.push({...draft,version:factVersion(draft),verification:{status:'auto-verified',meaning,evidenceBasis:'single-primary-source; no independent corroboration',policy:gatePolicy,extractorVersion,assertionHash:assertionHash(draft),sourceSha256:source.sha256,deterministic:{passed:true,checks},faithfulness}});
  console.log(required.id,'actual faithfulness',faithfulness.score);
 }
 const bundle:CoreBundle={schemaVersion:'stadtstack-core-facts-v1',cityId:'strausberg',version:bundleVersion(facts),generatedAt:new Date().toISOString(),facts};
 collection.features=collection.features.filter(f=>!selected.some(s=>s.id===f.properties.id));collection.features.push(...facts.map(coreSignal));
 validateCore(bundle,collection);await validateCoreBytes(bundle);
 catalogue.coreBundle={path:'core/strausberg-facts.json',version:bundle.version,manifestPath:'core/release-manifest.json'};
 const city=catalogue.cities.find(c=>c.id==='strausberg')!;
 for(const f of facts){const id=f.topic==='water'?'straussee-monitoring':'budget-ordinance';city.sources=city.sources.filter(s=>s.id!==id);city.sources.push({id,kind:f.topic==='water'?'water':'budget',publisher:f.source.publisher,url:f.source.url,licence:f.topic==='budget'?'§ 5 UrhG – amtliches Werk':'unknown',reuse:f.topic==='budget'?'official_work':'facts_with_attribution',retrievedAt:f.source.retrievedAt,status:'ok'});}
 const staging=join(cacheDir,'staging');
 if(fromPublished){for(const c of catalogue.cities){if(c.id!=='strausberg')await save(join(staging,'cities',c.id,'signals.geojson'),await readFile(join(outDir,'cities',c.id,'signals.geojson')));await save(join(staging,'cities',c.id,'feed.json'),await readFile(join(outDir,'cities',c.id,'feed.json')));}}
 await save(join(staging,'cities','strausberg','signals.geojson'),JSON.stringify(collection));
 await save(join(staging,'catalogue.json'),JSON.stringify(catalogue));
 await save(join(staging,'core','strausberg-facts.json'),JSON.stringify(bundle,null,2)+'\n');
 return catalogue;
}
if(process.argv[1]&&new URL(import.meta.url).pathname===process.argv[1])await evaluateCore(process.argv.includes('--from-published'));
