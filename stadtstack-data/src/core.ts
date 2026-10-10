import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {cacheDir,hash} from './common.ts';
import {coreBundleSchema,verificationSchema,faithfulnessGateSchema} from './core-schema.ts';
import type {CoreFact,CoreBundle} from './core-schema.ts';
import type {FeatureCollection,Signal} from './schema.ts';
export const extractorVersion='strausberg-core-pdf-v1';
export const lakeUrl='https://www.stadt-strausberg.de/wp-content/uploads/2025/05/26-10-05_Stauhoehe-Straussee.pdf';
export const budgetUrl='https://www.stadt-strausberg.de/wp-content/uploads/2025/04/2024-11-07_Haushaltssatzung_2025_2026.pdf';
export const meaning='Passed named automated gates; not human review or independent truth certification.' as const;
export const selected=[
 {id:'lake:straussee-level-2026-09-14',topic:'water' as const,assertion:{date:'2026-09-14',value:-1.61,unit:'m' as const,reference:'Normalstau'},statement:'Am 14.09.2026 lag der Wasserstand des Straussees 1,61 m unter Normalstau (historische Messung).',url:lakeUrl,documentDate:'2026-10-05',title:'Monitoring des Wasserstandes im Straussee',locator:'PDF Seite 1, Zeile 14.09.2026; Defizit 161 cm; Normalstau 65,49 m DHHN 92'},
 ...([2025,2026] as const).map((year,i)=>({id:`budget:investment-outlays-${year}`,topic:'budget' as const,assertion:{year,value:[17941270,12609320][i],unit:'EUR' as const},statement:`Der Haushaltsplan der Stadt Strausberg setzt für ${year} geplante Auszahlungen aus Investitionstätigkeit von ${['17.941.270','12.609.320'][i]} EUR fest.`,url:budgetUrl,documentDate:'2024-11-07',title:'Haushaltssatzung 2025/2026',locator:`PDF Seite 1, § 1, Zeile Auszahlungen aus Investitionstätigkeit, Spalte ${year}`}))
];
export async function pageOne(bytes:Uint8Array){
 const task=getDocument({data:new Uint8Array(bytes),useSystemFonts:true});
 try{
  const pdf=await task.promise,page=await pdf.getPage(1),content=await page.getTextContent();
  const items=content.items.filter(item=>'str' in item);
  items.sort((a,b)=>Math.abs(a.transform[5]-b.transform[5])>2?b.transform[5]-a.transform[5]:a.transform[4]-b.transform[4]);
  return items.map(item=>item.str).join(' ').replace(/\s+/g,' ').trim();
 }finally{await task.destroy();}
}
export function deterministic(text:string,id:string){
 const normal=text.replace(/\s+/g,' ').trim();
 if(id===selected[0].id){
  if(!/Stand:\s*05\.10\.2026/.test(normal)||!normal.includes('Normalstau 65,49 m DHHN 92')||!/14\.09\.2026\s+-26\s+63,88\s+Wert vom LfU erhalten\s+161(?:\s|$)/.test(normal))throw Error('Lake measurement row/reference/date mismatch');
  if(Math.round((65.49-63.88)*100)!==161)throw Error('Lake unit/reference mismatch');
  return ['document-date-2026-10-05','measurement-row-2026-09-14','reference-normalstau-65.49-m-DHHN92','deficit-161-cm-to-minus-1.61-m'];
 }
 if(!selected.some(f=>f.id===id))throw Error('Unknown required fact');
 if(!/Stand:\s*07\.11\.2024/.test(normal)||!/Haushaltsjahr\s+2025\s+2026/.test(normal)||!normal.includes('festgesetzt')||!/Auszahlungen aus Investitionstätigkeit\s+17\.941\.270,00 EUR\s+12\.609\.320,00 EUR/.test(normal))throw Error('Budget row/year-column/plan mismatch');
 return ['document-date-2024-11-07','section-1-plan-not-actual','year-columns-2025-2026','investment-outlays-row-and-EUR'];
}
export function assertionHash(f:Pick<CoreFact,'id'|'statement'|'assertion'>){return hash(JSON.stringify({id:f.id,statement:f.statement,assertion:f.assertion}));}
export function factVersion(f:Pick<CoreFact,'id'|'statement'|'assertion'|'source'>){return hash(JSON.stringify({assertionHash:assertionHash(f),sourceSha256:f.source.sha256,extractorVersion}));}
export function bundleVersion(facts:CoreFact[]){return hash(JSON.stringify(facts.map(f=>({id:f.id,version:f.version}))));}
export function judgeEvidenceHash(g:Omit<CoreFact['verification']['faithfulness'],'evidenceHash'>){return hash(JSON.stringify({score:g.score,threshold:g.threshold,reason:g.reason,evaluator:g.evaluator,model:g.model,actual:g.actual,evaluatedAt:g.evaluatedAt,statementHash:g.statementHash,contextHash:g.contextHash}));}
export function validateCore(input:unknown,collection:FeatureCollection){
 const bundle=coreBundleSchema.parse(input);
 for(const required of selected){
  const fact=bundle.facts.find(f=>f.id===required.id);if(!fact)throw Error(`Missing required core fact ${required.id}`);
  if(fact.statement!==required.statement||JSON.stringify(fact.assertion)!==JSON.stringify(required.assertion)||fact.source.url!==required.url||fact.source.documentDate!==required.documentDate||fact.source.locator!==required.locator)throw Error(`Required core assertion mismatch: ${required.id}`);
  const v=fact.verification,g=v.faithfulness,{evidenceHash,...record}=g;
  if(v.extractorVersion!==extractorVersion||v.assertionHash!==assertionHash(fact)||v.sourceSha256!==fact.source.sha256||fact.version!==factVersion(fact)||g.statementHash!==hash(fact.statement)||evidenceHash!==judgeEvidenceHash(record))throw Error(`Tampered core evidence: ${fact.id}`);
  const signal=collection.features.filter(f=>f.properties.id===fact.id);if(signal.length!==1)throw Error(`Missing/duplicate core signal ${fact.id}`);
  const p=signal[0].properties;
  if(p.version!==fact.version||p.statement!==fact.statement||p.reviewState!=='auto_checked'||JSON.stringify(verificationSchema.parse(p.verification))!==JSON.stringify(v)||JSON.stringify(p.assertion)!==JSON.stringify(fact.assertion)||p.sources[0].sha256!==fact.source.sha256||p.sources[0].url!==fact.source.url||p.sources[0].locator!==fact.source.locator)throw Error(`Core signal mismatch: ${fact.id}`);
 }
 if(bundle.version!==bundleVersion(bundle.facts))throw Error('Core bundle version mismatch');
 return bundle;
}
export async function validateCoreBytes(bundle:CoreBundle){
 const texts=new Map<string,string>();
 for(const fact of bundle.facts){
  let text=texts.get(fact.source.sha256);
  if(text===undefined){
   const bytes=new Uint8Array(await readFile(join(cacheDir,'pdf',fact.source.sha256+'.pdf')));
   if(hash(bytes)!==fact.source.sha256)throw Error(`Source bytes changed: ${fact.id}`);
   text=await pageOne(bytes);texts.set(fact.source.sha256,text);
  }
  const checks=deterministic(text,fact.id);
  if(JSON.stringify(checks)!==JSON.stringify(fact.verification.deterministic.checks)||hash(text)!==fact.verification.faithfulness.contextHash)throw Error(`Source gate stale: ${fact.id}`);
  const evidence=JSON.parse(await readFile(join(cacheDir,'core-evidence',fact.verification.faithfulness.evidenceHash+'.json'),'utf8'));
  if(JSON.stringify(faithfulnessGateSchema.parse(evidence))!==JSON.stringify(faithfulnessGateSchema.parse(fact.verification.faithfulness)))throw Error(`Judge evidence missing/changed: ${fact.id}`);
 }
}
export function coreSignal(f:CoreFact):Signal{
 const year=f.assertion.year,date=f.assertion.date;
 return {type:'Feature',geometry:null,properties:{id:f.id,version:f.version,cityId:'strausberg',kind:f.topic==='budget'?'budget':'measurement',category:f.topic==='budget'?'Geplante Investitionsauszahlungen':'Historischer Wasserstand',title:f.topic==='budget'?`Investitionsplan ${year}`:'Straussee: historische Messung 14.09.2026',statement:f.statement,status:f.topic==='budget'?'Plan (Haushaltssatzung)':'Historische Messung',startDate:date??`${year}-01-01`,endDate:date??`${year}-12-31`,nextStep:'Originalquelle und neueren Stand bei der Stadt prüfen.',unknowns:[f.topic==='budget'?'Tatsächliche Ausgaben und Einzelprojekte nicht belegt':'Keine Aussage zum heutigen Wasserstand'],scale:'city',geometryPrecision:'none',sources:[{...f.source,snapshotUrl:f.source.url,snapshot:true,licence:f.topic==='budget'?'§ 5 UrhG – amtliches Werk':'unknown',reuse:f.topic==='budget'?'official_work':'facts_with_attribution'}],extraction:{method:'structured',faithfulness:f.verification.faithfulness},reviewState:'auto_checked',asOf:f.source.documentDate,assertion:f.assertion,verification:f.verification}};
}
