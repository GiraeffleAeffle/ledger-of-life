import {spawnSync} from 'node:child_process';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {cacheDir,cachedFetch,hash,jsonFile,save,signal,sourceFrom} from './common.ts';
import {cities} from './cities.ts';
import {provider} from './provider.ts';
import {geocode} from './council.ts';
import {councilId} from './dedupe.ts';
import type {Catalogue,FeatureCollection} from './schema.ts';
import {evaluateCore} from './evaluate-core.ts';
const threshold=.8,penalizeAmbiguousClaims=true;const model=provider.id;const mode=process.env.FAITHFULNESS_MODE??'llm';if(!['llm','hybrid','system_one'].includes(mode))throw Error('FAITHFULNESS_MODE must be llm, hybrid, or system_one');const jev=mode!=='llm';if(jev&&!process.env.TYPESAFE_API_KEY)throw Error(`FAITHFULNESS_MODE=${mode} requires TYPESAFE_API_KEY; set it in stadtstack-data/.env.local (value redacted)`);
async function pdfText(bytes:Uint8Array,identifier:string){const filename=join(cacheDir,'pdf',identifier+'.pdf'),textfile=join(cacheDir,'pdf',identifier+'.txt');await save(filename,bytes);const task=getDocument({data:new Uint8Array(bytes),useSystemFonts:true});try{const pdf=await task.promise,page=await pdf.getPage(1),content=await page.getTextContent(),text=content.items.map(item=>'str' in item?item.str:'').join(' ');await save(textfile,text);return text;}finally{await task.destroy();}}
const codex=provider.generateJson;
async function faithfulness(statement:string,text:string){const key=hash(`faithfulness-v2\n${mode}\n${mode==='system_one'?'typesafe:jev':model}\n${threshold}\n${penalizeAmbiguousClaims}\n${statement}\n${text}`);const path=join(cacheDir,'faithfulness',key+'.json');const previous=await jsonFile<{score:number;reason:string;evaluator:string;threshold:number}>(path);if(previous)return previous;const pythonEnv=mode==='llm'?'venv':'venv-jev';const judge=spawnSync(join(cacheDir,pythonEnv,'bin','python'),[join('src','faithfulness.py')],{input:JSON.stringify({statement,source:text,threshold,penalize_ambiguous_claims:penalizeAmbiguousClaims,mode}),encoding:'utf8',timeout:240000,env:{...process.env,DEEPEVAL_TELEMETRY_OPT_OUT:'YES'}});if(judge.status!==0)throw Error(`DeepEval failed: ${judge.stderr.slice(-700)}`);const result=JSON.parse(judge.stdout.trim().split('\n').at(-1)!) as {score:number;reason:string;evaluator:string;threshold:number};await save(path,JSON.stringify(result));return result;}
const stagingCatalogue=await jsonFile<Catalogue>(join(cacheDir,'staging','catalogue.json'));if(!stagingCatalogue)throw Error('Collect first');
const catalogue=stagingCatalogue.cities.some(city=>city.id==='strausberg')?await evaluateCore():stagingCatalogue;
for(const city of cities.filter(c=>c.endpoint&&catalogue.cities.some(x=>x.id===c.id))){
 const path=join(cacheDir,'staging','cities',city.id,'signals.geojson');
 const collection=await jsonFile<FeatureCollection>(path);
 if(!collection)continue;
 const folder=join(cacheDir,'ccf','data','de',city.id,'paper');
 let files:string[];
 try{files=await readdir(folder);}catch{continue;}
 const candidates:{sourceId:string;date:string;file:{downloadUrl:string;mimeType?:string}}[]=[];
 for(const filename of files.filter(n=>n.endsWith('.json'))){
  const record=JSON.parse(await readFile(join(folder,filename),'utf8')) as {source_id:string;deleted_at?:string|null;modified_at:string;data:{date?:string;auxiliaryFile?:{downloadUrl?:string;mimeType?:string}[];mainFile?:{downloadUrl?:string;mimeType?:string}}};
  if(record.deleted_at||Date.parse(record.data.date??record.modified_at)<Date.now()-60*86400000)continue;
  const file=[record.data.mainFile,...(record.data.auxiliaryFile??[])].find(f=>f?.downloadUrl&&(!f.mimeType||f.mimeType==='application/pdf'));
  if(file?.downloadUrl)candidates.push({sourceId:record.source_id,date:record.data.date??record.modified_at,file:{downloadUrl:file.downloadUrl,mimeType:file.mimeType}});
 }
 candidates.sort((a,b)=>b.date.localeCompare(a.date));
 let attempted=0,evaluated=0;
 for(const candidate of candidates){
  if(attempted>=10||evaluated>=1)break;
  const paper=collection.features.find(f=>f.properties.id===councilId(candidate.sourceId));
  if(!paper)continue;
  attempted++;
  try{
   const pdf=await cachedFetch(candidate.file.downloadUrl,2592000000,{timeout:25000});
   const text=(await pdfText(pdf.body,hash(candidate.file.downloadUrl).slice(0,24))).slice(0,6500);
   if(text.replace(/\s+/g,'').length<250)continue;
   const draft=await codex(`Schreibe nur aus der belegten Ratsvorlage in EIGENEN Worten, ohne Entscheidung oder Durchführung zu behaupten: genau eine knappe Aussage und nächster Schritt, nenne eventuell belegte öffentliche Straße/Plätze. Nur JSON {"statement":"...","nextStep":"...","placeMentions":[]}. Titel: ${paper.properties.title}. PDF Seite 1:\\n${text}`);
   if(!draft.nextStep.trim())draft.nextStep='Originalvorlage und weiteren Beratungsstand beim zuständigen Rat prüfen.';
   const verdict=await faithfulness(draft.statement,text);
   paper.properties.statement=draft.statement;
   paper.properties.nextStep=draft.nextStep;
   if(!paper.geometry&&draft.placeMentions?.length){const point=await geocode(city,draft.placeMentions.join(' '));if(point){paper.geometry={type:'Point',coordinates:point};paper.properties.geometryPrecision='approximate';paper.properties.scale='street';paper.properties.unknowns.push('Lage aus PDF-Ortsnennung näherungsweise geokodiert');}}
   paper.properties.sources.push(sourceFrom(pdf,'Ratsvorlage PDF, Seite 1',city.name,'PDF Seite 1; Textauszug der Vorlage','unknown','facts_with_attribution'));
   paper.properties.extraction={method:'llm',model,faithfulness:verdict};
   paper.properties.reviewState=verdict.score>=threshold?'auto_checked':'candidate';
   paper.properties.version=hash(JSON.stringify({title:paper.properties.title,statement:draft.statement,nextStep:draft.nextStep,pdf:pdf.sha256,geometry:paper.geometry}));
   evaluated++;
   console.log(city.id,'PDF evaluated',verdict.score,paper.properties.reviewState);
  }catch(error){console.error(city.id,'PDF sample:',String(error));}
 }
 await save(path,JSON.stringify(collection));
}
await save(join(cacheDir,'staging','catalogue.json'),JSON.stringify(catalogue));
