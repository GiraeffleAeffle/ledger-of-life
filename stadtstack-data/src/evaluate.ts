import {spawnSync} from 'node:child_process';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {cacheDir,cachedFetch,hash,jsonFile,save,signal,sourceFrom} from './common.ts';
import {cities} from './cities.ts';
import {provider} from './provider.ts';
import {geocode} from './council.ts';
import type {Catalogue,FeatureCollection} from './schema.ts';
const threshold=.8;const model=provider.id;
async function pdfText(bytes:Uint8Array,identifier:string){const filename=join(cacheDir,'pdf',identifier+'.pdf'),textfile=join(cacheDir,'pdf',identifier+'.txt');await save(filename,bytes);const task=getDocument({data:new Uint8Array(bytes),useSystemFonts:true});try{const pdf=await task.promise,page=await pdf.getPage(1),content=await page.getTextContent(),text=content.items.map(item=>'str' in item?item.str:'').join(' ');await save(textfile,text);return text;}finally{await task.destroy();}}
const codex=provider.generateJson;
async function faithfulness(statement:string,text:string){const key=hash(statement+'\n'+text);const path=join(cacheDir,'faithfulness',key+'.json');const previous=await jsonFile<{score:number;reason:string;evaluator:string;threshold:number}>(path);if(previous)return previous;const judge=spawnSync(join(cacheDir,'venv','bin','python'),[join('src','faithfulness.py')],{input:JSON.stringify({statement,source:text,threshold}),encoding:'utf8',timeout:240000,env:{...process.env,DEEPEVAL_TELEMETRY_OPT_OUT:'YES'}});if(judge.status!==0)throw Error(`DeepEval failed: ${judge.stderr.slice(-700)}`);const result=JSON.parse(judge.stdout.trim().split('\n').at(-1)!) as {score:number;reason:string;evaluator:string;threshold:number};await save(path,JSON.stringify(result));return result;}
const catalogue=await jsonFile<Catalogue>(join(cacheDir,'staging','catalogue.json'));if(!catalogue)throw Error('Collect first');
const budgetUrl='https://www.stadt-strausberg.de/wp-content/uploads/2025/04/2024-11-07_Haushaltssatzung_2025_2026.pdf';const strausberg=await jsonFile<FeatureCollection>(join(cacheDir,'staging','cities','strausberg','signals.geojson'));
if(strausberg&&catalogue.cities.some(c=>c.id==='strausberg')){
 try{
  const e=await cachedFetch(budgetUrl,2592000000,{timeout:30000});
  const text=(await pdfText(e.body,'strausberg-budget')).slice(0,4800);
  const excerpt=text.slice(Math.max(0,text.indexOf('§ 1')-100),text.indexOf('§ 2')>0?text.indexOf('§ 2'):4800);
  for(const [year,amount] of [[2025,'17.941.270'],[2026,'12.609.320']] as const){
   if(!text.includes(amount))throw Error(`Source page 1 lacks ${amount}`);
   const draft=await codex(`Du schreibst eine eigenständige faktentreue deutsche Kurzfassung (maximal 2 Sätze) für eine Stadtkarte. §1 der Haushaltssatzung legt für ${year} GEPLANTE Auszahlungen aus Investitionstätigkeit in Höhe von ${amount} EUR fest. NICHT als tatsächliche Ausgaben darstellen. Antworte nur JSON {"statement":"...","nextStep":"...","placeMentions":[]}. Quellenauszug:\n${excerpt}`);
   if(!draft.nextStep.trim())draft.nextStep='Bei der Stadt Strausberg nach konkreten Projekten und dem tatsächlichen Ausgabestand fragen.';
   if(!/(geplant|plan|haushaltsansatz|haushaltsplan|vorgesehen)/i.test(draft.statement)||/(tatsächlich.{0,30}ausgegeben|bereits.{0,30}ausgegeben|wurden.{0,30}ausgegeben)/i.test(draft.statement))throw Error(`LLM did not preserve planned-versus-actual distinction for ${year}`);
   const verdict=await faithfulness(draft.statement,excerpt);
   const feature=signal({id:`budget:investment-outlays-${year}`,cityId:'strausberg',kind:'budget',category:'Geplante Investitionsauszahlungen',title:`Investitionsplan ${year}: ${amount} €`,statement:draft.statement,status:'Haushaltsansatz; keine tatsächliche Ausgabe',startDate:`${year}-01-01`,endDate:`${year}-12-31`,nextStep:draft.nextStep,unknowns:['Tatsächliche Ausgaben nicht durch Haushaltssatzung belegt','Einzelprojekte und vollständiger Plan online nicht verfügbar'],scale:'city',geometryPrecision:'none',sources:[sourceFrom(e,'Haushaltssatzung 2025/2026','Stadt Strausberg',`PDF Seite 1, § 1, Zeile „Auszahlungen aus Investitionstätigkeit“, Spalte ${year}`,'§ 5 UrhG – amtliches Werk','official_work')],extraction:{method:'llm',model,faithfulness:verdict},reviewState:verdict.score>=threshold?'auto_checked':'candidate',asOf:e.retrievedAt},null);
   strausberg.features=strausberg.features.filter(f=>f.properties.id!==feature.properties.id);
   strausberg.features.push(feature);
   console.log('budget',year,verdict.score,feature.properties.reviewState);
  }
  catalogue.cities.find(c=>c.id==='strausberg')!.sources.push({id:'budget-ordinance',kind:'budget',publisher:'Stadt Strausberg',url:budgetUrl,licence:'§ 5 UrhG – amtliches Werk',reuse:'official_work',retrievedAt:e.retrievedAt});
  await save(join(cacheDir,'staging','cities','strausberg','signals.geojson'),JSON.stringify(strausberg));
 }catch(error){
  console.error('budget evaluation:',String(error));
  catalogue.cities.find(c=>c.id==='strausberg')!.sources.push({id:'budget-ordinance',kind:'budget',publisher:'Stadt Strausberg',url:budgetUrl,licence:'unknown',reuse:'official_work',retrievedAt:new Date().toISOString(),status:'failed',error:String(error)});
 }
}
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
  const paper=collection.features.find(f=>f.properties.id===`ccf:${encodeURIComponent(candidate.sourceId)}`);
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
