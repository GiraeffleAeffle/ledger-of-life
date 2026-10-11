import {assertSnapshot, observation, semanticHash, type AdmittedSnapshot, type AdapterScope, type AdapterCoverage, type StructuredAdapter, type ParseResult, type StructuredObservation} from '../district-adapter-contract.ts';
import {readCsv, readXlsx, nativePercentValue, type NativeTable, type NativeCell} from './structured-tables.ts';

export const STATE_STATISTICS_VERSION = 'state-statistics-native-v1';
export const STATE_FINANCE_SOURCES = {
 'statistics-berlin-brandenburg-finance': {prefix:'12', series:['LII2','LII3','LII6','LII7','LIII1']},
 'statistics-nord-schleswig-holstein-finance': {prefix:'01', series:['LII7','Gemeindetabelle','Realsteuer']},
 'statistics-mv-laiv-finance': {prefix:'13', series:['L223','L233','L273']},
} as const;
const PILOTS:Record<string,true> = {'12064472':true,'12064227':true,'12064428':true,'01053100':true,'01053090':true,'01053116':true,'13076090':true,'13076108':true,'13076060':true};
export interface StateStatisticsOptions {rights:'unknown'|'admitted'; pageSize?:number; csvDelimiter?:string}
function coverage(scope:AdapterScope,snapshot:AdmittedSnapshot,state:AdapterCoverage['state'],reason:string,observedRows=0,nextCursor:string|null=null,limitations:string[]=[]):AdapterCoverage {
 return {state,scope:scope.ags,reason,checkedAt:snapshot.retrievedAt,nextCursor,observedRows,limitations};
}
function gate(snapshot:AdmittedSnapshot,scope:AdapterScope,options:StateStatisticsOptions):AdapterCoverage|null {
 assertSnapshot(snapshot);
 const source=STATE_FINANCE_SOURCES[scope.sourceId as keyof typeof STATE_FINANCE_SOURCES];
 if(!source||!PILOTS[scope.ags]||!scope.ags.startsWith(source.prefix))return coverage(scope,snapshot,'not_applicable','Outside catalog source and nine-pilot scope');
 const text=new TextDecoder().decode(snapshot.bytes.subarray(0,8192));
 if(/captcha|access denied|zugriff verweigert|login required/i.test(text))return coverage(scope,snapshot,'blocked_access','Captured access wall');
 if(/\b410 Gone\b|Bericht zurückgezogen|Veröffentlichung zurückgezogen/i.test(text))return coverage(scope,snapshot,'partial','Explicit withdrawal; no inferred deletion or replacement');
 if(options.rights!=='admitted')return coverage(scope,snapshot,'held_origin','Resource-specific rights unresolved; catalog does not establish permission');
 return null;
}
interface Metric {predicate:string;unit:string;period:string;date:string;role:string;budget:string}
function metric(header:string,title:string):Metric|null {
 const text=(header+' '+title).replace(/\s+/g,' ').trim();
 const years=[...header.matchAll(/\b(20\d{2})\b/g)].map(m=>m[1]);
 const titleYears=[...title.matchAll(/\b(20\d{2})\b/g)].map(m=>m[1]);
 const year=new Set(years).size===1?years[0]:years.length===0&&new Set(titleYears).size===1?titleYears[0]:null;
 if(!year)return null;
 let predicate:string;
 if(/Hebesatz|Hebesätze/i.test(header))predicate=/Gewerbe/i.test(header)?'trade_tax_rate':/Grundsteuer\s*A/i.test(header)?'property_tax_a_rate':/Grundsteuer\s*B/i.test(header)?'property_tax_b_rate':'';
 else if(/Schulden/i.test(header))predicate='statistical_debt';
 else if(/Istaufkommen|Steuereinnahmen|Steuereinnahmekraft/i.test(header))predicate='statistical_tax_receipts';
 else if(/Einzahlungen|Einnahmen/i.test(header))predicate='statistical_receipts';
 else if(/Auszahlungen|Ausgaben/i.test(header))predicate='statistical_expenditure';
 else return null;
 if(!predicate)return null;
 const dimensionText = header.match(/\bEUR\b|\bEuro\b|%/i) ? header : title;
 const units = new Set([...dimensionText.matchAll(/(?:EUR|Euro)\s*je\s*Einwohner|(?:1\s*000|Tsd\.?)\s*(?:EUR|Euro)|\b(?:EUR|Euro)\b|%/gi)].map(match => /je\s*Einwohner/i.test(match[0]) ? 'EUR/person' : /^(?:1\s*000|Tsd)/i.test(match[0]) ? '1000 EUR' : match[0] === '%' ? '%' : 'EUR'));
 if(units.size!==1)return null;
 const unit=[...units][0];
 if(predicate.endsWith('_rate')&&unit!=='%'||!predicate.endsWith('_rate')&&unit==='%')return null;
 const scopeText=/Kernhaushalt|Extrahaushalt|Sondervermögen|konsolidiert|Gesamthaushalt/i.test(header)?header:title;
 const scopes=[/Kernhaushalt/i.test(scopeText)?'core':null,/Extrahaushalt|Sondervermögen/i.test(scopeText)?'special':null,/konsolidiert|Gesamthaushalt/i.test(scopeText)?'consolidated':null].filter(Boolean);
 const budget=scopes.length===1?scopes[0]:scopes.length===0&&predicate.includes('tax')?'tax_statistics':null;
 if(!budget)return null;
 const cash=/Kassenstatistik|Kassenergebnisse|L223|LII2|L\s*II\s*2/i.test(text);
 const quarters=[...text.matchAll(/([1-4])\.?\s*Quartal/gi)].map(match=>match[1]);
 if(new Set(quarters).size>1)return null;
 const quarter=quarters.length?Number(quarters[0]):null;
 if(cash&&!quarter)return null;
 const period=cash?`${year}-Q1:Q${quarter}`:year;
 const month=cash?quarter!*3:12;
 const day=month===3||month===12?31:30;
 return {predicate,unit,period,date:`${year}-${String(month).padStart(2,'0')}-${day}`,role:predicate==='statistical_debt'?'stock_reference_date':cash?'cumulative_cash_period_end':'annual_statistical_period_end',budget};
}
function numeric(cell:NativeCell):number|null {
 const s=cell.raw.trim();
 if(['','.', '..','…','/','x','X','-'].includes(s))return null;
 const lexeme=cell.type==='number'?s:s.replace(/\./g,'').replace(',','.').replace(/\s/g,'');
 if(!(cell.type==='number'?/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/:/^-?\d+(\.\d+)?$/).test(lexeme))throw Error('Unrecognized numeric cell');
 const value=Number(lexeme);if(!Number.isFinite(value))throw Error('Nonfinite value');return value;
}
function parseTables(tables:NativeTable[],snapshot:AdmittedSnapshot,scope:AdapterScope):ParseResult {
 const observations:StructuredObservation[]=[];let districtRows=0, matchedRows=0, unresolved=0;
 for(const table of tables){
  const firstData=table.rows.findIndex(row=>row?.some(c=>c&&(/^\d{8}$/.test(c.raw.trim())||/^\d{5}$/.test(c.raw.trim()))));
  if(firstData<0)continue;
  const headerRows=table.rows.slice(0,firstData).filter(Boolean);
  const titleCells=headerRows.filter(row=>row.filter(c=>c?.raw.trim()).length===1).flat().filter(c=>c?.raw.trim());
  const title=titleCells.map(c=>c.raw).join(' ');
  const schemaHash=semanticHash(headerRows.map(row=>Array.from(row,c=>c??null)));
  for(const row of table.rows.slice(firstData)){
   if(!row)continue;
   const key=row.find(c=>c&&(/^\d{8}$/.test(c.raw.trim())||/^\d{5}$/.test(c.raw.trim())));if(!key)continue;
   if(key.raw.trim()===scope.ags.slice(0,5)){districtRows++;continue;}
   if(key.raw.trim()!==scope.ags)continue;matchedRows++;
   for(let column=0;column<row.length;column++){
    const cell=row[column];if(!cell||cell===key)continue;
    const headers=headerRows.map(r=>r[column]).filter((c):c is NativeCell=>Boolean(c));
    const m=metric(headers.map(c=>c.raw).join(' '),title);if(!m)continue;
    if(cell.numberFormat?.percentStyle&&m.unit!=='%')throw Error('Native percentage number format conflicts with monetary unit');
    const percentLexeme=cell.type==='number'&&cell.numberFormat?.percentStyle?nativePercentValue(cell):null;
    const value=percentLexeme===null?numeric(cell):Number(percentLexeme);
    if(value===null){unresolved++;continue;}
    if(!Number.isFinite(value))throw Error('Nonfinite native percentage value');
    const nativeId=`${table.sheet??'csv'}:${key.raw.trim()}:${m.predicate}:${m.period}:${m.budget}:${cell.address}`;
    const supportingEvidence = cell.numberFormat?.evidence.map(item=>({
     role:'source_metadata' as const,
     locator:{sourceSha256:snapshot.sourceSha256,format:'xlsx' as const,nativeId,path:item.path,sheet:null,rowKey:null,cells:[],rawValue:item.rawValue,schemaHash:semanticHash(cell.numberFormat),mappingVersion:cell.numberFormat!.mappingVersion},
    }))??[];
    observations.push(observation({
     publisherId:scope.publisherId,sourceId:scope.sourceId,nativeId,nativeVersion:snapshot.sourceVersion,
     kind:'FiscalObservation',subject:`municipality:${scope.ags}:${m.budget}`,predicate:m.predicate,value,unit:m.unit,
     date:m.date,dateRole:m.role,financialRole:'none',geography:{ags:scope.ags,basis:'source_explicit',role:'administrative_area'},
     sourceReferenceDate:m.date,publishedAt:null,retrievedAt:snapshot.retrievedAt,
     evidence:[key,...titleCells,...headers,cell].map(c=>({sourceSha256:snapshot.sourceSha256,format:table.format,nativeId,path:`${table.sheet??'csv'}!${c.address}`,sheet:table.sheet,rowKey:key.raw,cells:[c.address],rawValue:c.raw,schemaHash,mappingVersion:STATE_STATISTICS_VERSION})),
     supportingEvidence,
     limitations:[`Budget scope: ${m.budget}; statistical period: ${m.period}`,'Statistical context only: not product appropriation, town annual account, payment to a project or measured project impact'],
    }));
   }
  }
 }
 const limitations=[`${districtRows} district rows excluded; district totals are not municipal values`,`${unresolved} empty/suppressed cells excluded`,'Publication date and boundary vintage not inferred','Native workbook layouts not yet validated against admitted publisher downloads'];
 const state=observations.length?'partial':matchedRows?'held_quality':districtRows?'partial':'held_quality';
 return {observations,coverage:coverage(scope,snapshot,state,observations.length?'Mapped explicit native municipal cells; live resource coverage unverified':matchedRows?'Municipal rows found but no supported metric/unit/scope/period':'Municipal granularity or known schema not established',matchedRows,null,limitations)};
}
export function createStateStatisticsAdapter(options:StateStatisticsOptions={rights:'unknown'}):StructuredAdapter {
 const pageSize=options.pageSize??25;if(!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw Error('Invalid page size');
 return {id:'state-statistics',version:STATE_STATISTICS_VERSION,
  discover(snapshot,scope,cursor){
   const held=gate(snapshot,scope,options);if(held)return {resources:[],coverage:held};
   const html=new TextDecoder().decode(snapshot.bytes);if(html.length>2_000_000)return {resources:[],coverage:coverage(scope,snapshot,'held_quality','Landing exceeds bound')};
   const resources=[];const seen=new Set<string>();
   for(const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
    const url=new URL(match[1].replace(/&amp;/g,'&'),snapshot.url);if(!['https:','http:'].includes(url.protocol))continue;
    const format=/\.xlsx(?:$|\?)/i.test(url.href)?'xlsx':/\.csv(?:$|\?)|detailexport/i.test(url.href)?'csv':null;if(!format||seen.has(url.href))continue;
    seen.add(url.href);resources.push({url:url.href,nativeId:url.href,parentId:snapshot.url,method:'GET' as const,body:null,format});
   }
   const start=cursor===null?0:Number(cursor);if(!Number.isSafeInteger(start)||start<0||start>resources.length)throw Error('Invalid cursor');
   const page=resources.slice(start,start+pageSize),next=start+page.length<resources.length?String(start+page.length):null;
   return {resources:page,coverage:coverage(scope,snapshot,resources.length?'partial':'empty',resources.length?'Advertised links only; format, rights and municipal granularity require admission':'No advertised native tables in supplied landing',page.length,next,['No inferred API or archive completeness'])};
  },
  parse(snapshot,scope){const held=gate(snapshot,scope,options);if(held)return {observations:[],coverage:held};try{
   const tables=snapshot.bytes[0]===0x50&&snapshot.bytes[1]===0x4b?readXlsx(snapshot.bytes):/csv/i.test(snapshot.mimeType)||/\.csv(?:$|\?)/i.test(snapshot.url)?[readCsv(snapshot.bytes,{delimiter:options.csvDelimiter??';'})]:null;
   if(!tables)return {observations:[],coverage:coverage(scope,snapshot,'held_quality','Expected native XLSX/CSV; PDF and HTML are not fiscal cell evidence')};
   if(tables.every(t=>t.rows.length===0))return {observations:[],coverage:coverage(scope,snapshot,'empty','Empty native table snapshot')};
   return parseTables(tables,snapshot,scope);
  }catch(error){return {observations:[],coverage:coverage(scope,snapshot,'held_quality',`Native table/schema failure: ${error instanceof Error?error.message:'unknown error'}`)};}}
 };
}
export const stateStatisticsAdapter=createStateStatisticsAdapter();
