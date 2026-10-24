import {load} from 'cheerio';
import {assertSnapshot, observation, semanticHash, ScopeSchema} from '../district-adapter-contract.ts';
import type {AdmittedSnapshot, AdapterScope, AdapterCoverage, StructuredAdapter, StructuredObservation, StructuredLocator, ResourceReference} from '../district-adapter-contract.ts';

export const MUNICIPAL_FINANCE_VERSION = 'municipal-finance-html-v2';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINKS = 2000;
const MAX_ROWS = 2000;
const MAX_CELLS = 20000;
const PAGE_SIZE = 100;
const SOURCE_SCHEMA = semanticHash({version:MUNICIPAL_FINANCE_VERSION, native:'HTML a[href], headings, caption, th, td; no PDF cell mapping'});
const TOWNS = [
 ['strausberg','12064472','Strausberg'], ['hoppegarten','12064227','Hoppegarten'],
 ['ruedersdorf','12064428','Rüdersdorf'], ['ratzeburg','01053100','Ratzeburg'],
 ['moelln','01053090','Mölln'], ['schwarzenbek','01053116','Schwarzenbek'],
 ['ludwigslust','13076090','Ludwigslust'], ['parchim','13076108','Parchim'], ['hagenow','13076060','Hagenow'],
] as const;
export type FinanceDocumentClass = 'budget_plan'|'budget_statute'|'supplementary_budget'|'annual_account'|'consolidated_account'|'participation_report'|'account_approval_notice'|'supervisory_approval'|'publication_notice'|'interactive_budget'|'finance_index'|'unknown';
export type FinanceBudgetScope = 'core_budget'|'special_fund'|'school_association'|'consolidated'|'enterprise'|'unknown';
export interface FinanceDocument {
 resource:ResourceReference; title:string; documentClass:FinanceDocumentClass; fiscalYears:string[];
 issuer:string|null; budgetScope:FinanceBudgetScope; status:'listed'|'withdrawn';
 publishedAt:string|null; rawContext:string; locator:StructuredLocator; evidence:StructuredLocator[];
}
export interface FinancePdfRoute {
 resource:ResourceReference; documentClass:FinanceDocumentClass; fiscalYears:string[];
 issuer:string|null; budgetScope:FinanceBudgetScope;
 requiredStage:'isolated_pdf_text_or_ocr_then_evidence';
 receiptState:'not_checked'; limitations:string[];
}
export interface FinanceCapabilityReceipt {
 adapterId:string; version:string; sourceId:string; ags:string;
 implementedFormats:string[]; productionState:'held_origin'|'blocked_policy';
 collectionPerformed:false; limitations:string[]; contractSha256:string;
}
const squash=(value:string)=>value.replace(/\s+/gu,' ').trim();
function town(scope:AdapterScope) {
 ScopeSchema.parse(scope);
 const entry=TOWNS.find(([id])=>scope.sourceId===id+'-finance-documents');
 if(!entry||entry[1]!==scope.ags)throw Error('Municipal finance source/AGS mismatch');
 return entry;
}
export function municipalFinanceCapability(scope:AdapterScope):FinanceCapabilityReceipt {
 town(scope);
 const receipt={adapterId:'municipal-finance',version:MUNICIPAL_FINANCE_VERSION,sourceId:scope.sourceId,ags:scope.ags,
  implementedFormats:['html'],productionState:scope.sourceId==='hagenow-finance-documents'?'blocked_policy' as const:'held_origin' as const,
  collectionPerformed:false as const,limitations:['Catalog discovery is not document-level rights admission.','PDF contents require the shared credential-free isolated preparation and evidence jobs.','No full-account or measured-outcome coverage inferred from notices.']};
 return {...receipt,contractSha256:semanticHash(receipt)};
}
function coverage(snapshot:AdmittedSnapshot,scope:AdapterScope,state:AdapterCoverage['state'],reason:string,rows=0,nextCursor:string|null=null,limitations:string[]=[]):AdapterCoverage {
 return {state,scope:scope.sourceId+':'+scope.ags+':'+scope.observationWindow,reason,checkedAt:snapshot.retrievedAt,nextCursor,observedRows:rows,limitations};
}
function check(snapshot:AdmittedSnapshot,scope:AdapterScope):AdapterCoverage|null {
 town(scope); assertSnapshot(snapshot);
 if(snapshot.bytes.length>MAX_BYTES)return coverage(snapshot,scope,'held_quality','HTML byte limit exceeded');
 if(!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(snapshot.mimeType))return coverage(snapshot,scope,'held_quality',/pdf/i.test(snapshot.mimeType)?'Original PDF requires isolated preparation; HTML locators cannot represent PDF evidence':'Unsupported native format');
 return null;
}
function locator(snapshot:AdmittedSnapshot,nativeId:string,path:string,rawValue:string,schemaHash=SOURCE_SCHEMA,cells:string[]=[]):StructuredLocator {
 return {sourceSha256:snapshot.sourceSha256,format:'html',nativeId,path,sheet:null,rowKey:nativeId,cells,rawValue,schemaHash,mappingVersion:MUNICIPAL_FINANCE_VERSION};
}
function classify(text:string):FinanceDocumentClass {
 if(/(?:bekanntmachung|beschluss|feststellung|genehmigung|entlastung|veröffentlichung).{0,100}(?:jahresabschluss|jahresrechnung)|(?:jahresabschluss|jahresrechnung).{0,100}(?:bekanntmachung|beschluss|feststellung|genehmigung|entlastung)/iu.test(text))return 'account_approval_notice';
 if(/(?:bekanntmachung|veröffentlichung).{0,100}beteiligungsbericht/iu.test(text))return 'publication_notice';
 if(/(?:kommunalaufsicht|rechtsaufsicht|genehmigungsschreiben|aufsichtsbehördliche genehmigung|genehmigung des haushalts)/iu.test(text))return 'supervisory_approval';
 if(/gesamtabschluss/iu.test(text))return 'consolidated_account';
 if(/beteiligungsbericht/iu.test(text))return 'participation_report';
 if(/jahresabschl(?:uss|üsse)|jahresrechnung/iu.test(text))return 'annual_account';
 if(/nachtrag/iu.test(text))return 'supplementary_budget';
 if(/(?:interaktiv|ikvs|produkthaushalt\.xhtml)/iu.test(text))return 'interactive_budget';
 if(/haushaltsplan|gesamthaushalt|kernhaushalt|haushaltsunterlagen|haushalt\s+\d{4}/iu.test(text))return 'budget_plan';
 if(/haushaltssatzung/iu.test(text))return 'budget_statute';
 if(/finanzen|haushalt|beteiligungen/iu.test(text))return 'finance_index';
 return 'unknown';
}
function years(text:string):string[] {
 const values=new Set<string>();
 // Full calendar dates express publication/adoption clocks, not an additional fiscal year.
 text=text.replace(/\b\d{1,2}\.\d{1,2}\.(?:19|20)\d{2}\b|\b(?:19|20)\d{2}-\d{2}-\d{2}\b/gu,'');
 for(const match of text.matchAll(/\b((?:19|20)\d{2})\s*(?:[–—/-]\s*((?:19|20)?\d{2}))?\b/gu)) {
  values.add(match[1]);
  if(match[2]) {const end=match[2].length===2?match[1].slice(0,2)+match[2]:match[2];if(Number(end)>=Number(match[1])&&Number(end)-Number(match[1])<=10)for(let year=Number(match[1])+1;year<=Number(end);year++)values.add(String(year));}
 }
 return [...values].sort();
}
function budgetScope(text:string):FinanceBudgetScope {
 if(/schulverband/iu.test(text))return 'school_association';
 if(/sondervermögen|sanierungsgebiet|stadtumbau ost|altstadt|sonderhaushalt/iu.test(text))return 'special_fund';
 if(/gesamtabschluss|konsolidiert/iu.test(text))return 'consolidated';
 if(/eigenbetrieb|wirtschaftsbetriebe|gmbh|aktiengesellschaft/iu.test(text))return 'enterprise';
 if(/kernhaushalt/iu.test(text))return 'core_budget';
 return 'unknown';
}
function issuer(text:string,scope:AdapterScope):string|null {
 const school=text.match(/Schulverband\s+Schwarzenbek\s+Nordost/iu);if(school)return squash(school[0]);
 const name=town(scope)[2];
 const literal=text.match(new RegExp('(?:Stadt|Gemeinde)\\s+'+name+'(?:\\s+bei\\s+Berlin)?','iu'));
 return literal?squash(literal[0]):null;
}
function publicationDate(text:string):string|null {
 const match=text.match(/(?:veröffentlicht(?:\s+am)?|eingestellt(?:\s+am)?|bekanntgemacht(?:\s+am)?)\s*:?\s*(\d{2})\.(\d{2})\.(\d{4})/iu);
 if(!match)return null;
 const result=match[3]+'-'+match[2]+'-'+match[1];
 const parsed=new Date(result+'T00:00:00Z');return Number.isFinite(parsed.valueOf())&&parsed.toISOString().slice(0,10)===result?result:null;
}
function safeUrl(href:string,base:string):string|null {
 try {const url=new URL(href,base);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||/login|logon|logout|registrier/iu.test(url.pathname))return null;url.hash='';return url.href;}catch{return null;}
}
function format(url:string,mime:string):string {
 if(/\.pdf(?:\?|$)|[?&]ext=pdf(?:&|$)|[?&]fid=[^&]*\.pdf(?:&|$)/iu.test(url)||/application\/pdf/iu.test(mime)||/[?&]tx_tgmdownloads_main%5bdownload%5d=/iu.test(url))return 'pdf';
 return 'html';
}
function blockedHtml(html:string):boolean {
 const $=load(html);
 return $('input[type=password]').length>0||/access denied|zugriff verweigert|captcha|403 forbidden/iu.test($('title,h1').text());
}
export function municipalFinanceDocuments(snapshot:AdmittedSnapshot,scope:AdapterScope):{documents:FinanceDocument[];coverage:AdapterCoverage} {
 const failure=check(snapshot,scope);if(failure)return {documents:[],coverage:failure};
 let html:string;
 try {html=new TextDecoder('utf-8',{fatal:true}).decode(snapshot.bytes);}catch{return {documents:[],coverage:coverage(snapshot,scope,'held_quality','Invalid UTF-8 HTML snapshot')};}
 if(blockedHtml(html))return {documents:[],coverage:coverage(snapshot,scope,'blocked_access','Authentication/access challenge in admitted index')};
 const $=load(html),anchors=$('a[href]');
 if(anchors.length>MAX_LINKS)return {documents:[],coverage:coverage(snapshot,scope,'held_quality','Index link limit exceeded')};
 const documents:FinanceDocument[]=[];
 const pageHeading=squash($('h1').first().text());
 anchors.each((index,element)=>{
  const anchor=$(element);if(anchor.closest('nav,header,footer').length)return;
  const url=safeUrl(anchor.attr('href')??'',snapshot.url);if(!url||url===snapshot.url)return;
  const title=squash(anchor.text()||anchor.attr('title')||'');
  const container=anchor.closest('tr,li,p');
  const rawContext=container.length?container.text():anchor.text();
  const nearby=squash(rawContext),heading=squash((container.length?container:anchor).prevAll('h2,h3,h4').first().text());
  const context=[title,nearby,heading].filter(Boolean).join(' ');
  let documentClass=classify(context);
  // Heading fallback is only a class hint for a dated download, never evidence of approval or spending.
  if(documentClass==='unknown'&&years(title).length&&classify(pageHeading)!=='unknown')documentClass=classify(pageHeading);
  if(documentClass==='unknown')return;
  const nativeId=scope.sourceId+':'+url;
  const resource:ResourceReference={url,nativeId,parentId:scope.sourceId+':'+snapshot.url,method:'GET',body:null,format:format(url,anchor.attr('type')??'')};
  const status=/zurückgezogen|widerrufen|nicht mehr verfügbar|withdrawn/iu.test(context)||anchor.closest('del,s').length?'withdrawn' as const:'listed' as const;
  const hrefEvidence=locator(snapshot,nativeId,`a[href][${index}]/@href`,anchor.attr('href')??'');
  const evidence=[hrefEvidence,locator(snapshot,nativeId,`a[href][${index}]/text()`,anchor.text()),locator(snapshot,nativeId,`a[href][${index}]/@title`,anchor.attr('title')??''),locator(snapshot,nativeId,`a[href][${index}]/closest(tr,li,p)/text()`,rawContext),locator(snapshot,nativeId,`a[href][${index}]/closest(tr,li,p)/preceding-heading/text()`,(container.length?container:anchor).prevAll('h2,h3,h4').first().text()),locator(snapshot,nativeId,'h1[0]/text()',$('h1').first().text())];
  documents.push({resource,title,documentClass,fiscalYears:years(title||nearby),issuer:issuer(context,scope),budgetScope:budgetScope(context),status,publishedAt:publicationDate(nearby),rawContext,locator:hrefEvidence,evidence});
 });
 const unique=new Map<string,FinanceDocument>();for(const doc of documents)if(!unique.has(doc.resource.nativeId))unique.set(doc.resource.nativeId,doc);
 const result=[...unique.values()].sort((a,b)=>a.resource.nativeId.localeCompare(b.resource.nativeId,'en'));
 const explicitEmpty=/keine\s+(?:haushaltsunterlagen|finanzdokumente|jahresabschlüsse|dokumente|einträge)\s+(?:vorhanden|verfügbar|gefunden)/iu.test($('main,article,body').first().text());
 const state=result.length?'partial':explicitEmpty?'empty':'held_quality';
 return {documents:result,coverage:coverage(snapshot,scope,state,result.length?'Listed finance references only; document contents uninspected':explicitEmpty?'Explicit empty finance index':'No recognized finance entries; empty coverage not established',result.length,null,['One HTML page is not a complete fiscal/document inventory.','Index titles cannot establish actual expenditure, final approval, legal identity or current enterprise operation.'])};
}
export function municipalFinancePdfRoutes(snapshot:AdmittedSnapshot,scope:AdapterScope):FinancePdfRoute[] {
 return municipalFinanceDocuments(snapshot,scope).documents.filter(doc=>doc.resource.format==='pdf'&&doc.status==='listed').map(doc=>({resource:doc.resource,documentClass:doc.documentClass,fiscalYears:doc.fiscalYears,issuer:doc.issuer,budgetScope:doc.budgetScope,requiredStage:'isolated_pdf_text_or_ocr_then_evidence',receiptState:'not_checked',limitations:['Recheck document-specific rights and issuer against received PDF bytes.','An account approval notice is not a full account; a participation-report notice may include the report only after inspection.','No model calls or PDF subprocesses are performed by this adapter.']}));
}
interface Header {raw:string; field:string|null; role:StructuredObservation['financialRole']; year:string|null; currency:string|null; scale:number|null; grossNet:'gross'|'net'|'unknown'}
function header(raw:string):Header {
 const text=squash(raw),year=years(text);let field:string|null=null;
 if(/^(?:produkt|produktnummer|produkt-nr\.?|produktkonto)$/iu.test(text))field='product_id';
 else if(/^(?:investition(?:snummer)?|investitions-nr\.?|maßnahmen?(?:nummer|-nr\.?)|maßnahme-id)$/iu.test(text))field='investment_id';
 else if(/^(?:haushaltsjahr|fiskaljahr|jahr)$/iu.test(text))field='fiscal_year';
 else if(/^(?:herausgeber|haushaltsträger|körperschaft|issuer)$/iu.test(text))field='issuer';
 else if(/^(?:haushaltsbereich|haushaltsumfang|haushaltsart)$/iu.test(text))field='budget_scope';
 else if(/^(?:unternehmen|beteiligungsgesellschaft)$/iu.test(text))field='enterprise_name';
 else if(/(?:beteiligungsquote|kapitalanteil|anteil)/iu.test(text)&&/%|prozent/iu.test(text))field='participation_percent';
 else if(/ansatz|plan(?:ung)?|ergebnis|ist[-\s]|ausgezahlt|genehmigt|aufwendungen|auszahlungen|erträge|einzahlungen/iu.test(text))field='amount';
 const roles:Header['role'][]=[];
 if(/genehmigt/iu.test(text))roles.push('approval');
 if(/ausgezahlt/iu.test(text))roles.push('payment');
 if(/ergebnis|ist[-\s]/iu.test(text))roles.push('actual');
 if(/ansatz|plan(?:ung)?|ermächtigung/iu.test(text))roles.push('plan');
 const role:Header['role']=field==='amount'&&roles.length===1&&!/abweichung|differenz|saldo|prognose|vorläufig|voraussichtlich|forecast/iu.test(text)?roles[0]:'none';
 const currency=/\b(?:EUR|Euro|TEUR|MEUR)\b|€/iu.test(text)?'EUR':null;
 const thousandMagnitude=/\bTEUR\b|\bT\s*(?:€|EUR\b)|\b(?:Tsd\.?|Tausend)\s*(?:€|EUR\b|Euro\b)/iu;
 const millionMagnitude=/\bMEUR\b|\b(?:Mio\.?|Million(?:en)?)\s*(?:€|EUR\b|Euro\b)/iu;
 const thousands=thousandMagnitude.test(text),millions=millionMagnitude.test(text);
 const unknownMagnitude=/\b(?:Mrd|Milliard(?:e|en)|Billion(?:en)?|[kG]EUR|Hundert(?:tausend)?)\b|(?:\bin\b|[×*^])\s*\d/iu.test(text);
 const unrecognizedMagnitude=/\b(?:TEUR|MEUR|Tsd|Tausend|Mio|Million(?:en)?)\b|\bT\s*(?:€|EUR\b)/iu.test(text.replace(thousandMagnitude,'').replace(millionMagnitude,''));
 const scale=unknownMagnitude||unrecognizedMagnitude||thousands&&millions?null:thousands?1000:millions?1000000:1;
 return {raw,field,role,year:year.length===1?year[0]:null,currency,scale,grossNet:/brutto/iu.test(text)?'gross':/netto/iu.test(text)?'net':'unknown'};
}
function decimal(raw:string):number|null {
 const text=raw.trim().replace(/\u00a0/gu,' ').replace(/\s*(?:EUR|€|%|TEUR)\s*$/iu,'').trim();
 if(!/^[+-]?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/u.test(text))return null;
 const value=Number(text.replace(/\./gu,'').replace(',','.'));return Number.isFinite(value)?value:null;
}
function financialTables(snapshot:AdmittedSnapshot,scope:AdapterScope):{observations:StructuredObservation[];rows:number;issues:string[]} {
 const $=load(new TextDecoder('utf-8',{fatal:true}).decode(snapshot.bytes)),observations:StructuredObservation[]=[],issues:string[]=[];
 let rows=0;
 if($('tr').length>MAX_ROWS||$('th,td').length>MAX_CELLS)return {observations,rows,issues:['HTML table row/cell limit exceeded']};
 $('table').each((tableIndex,table)=>{
  const node=$(table),heading=squash(node.find('caption').first().text()||node.prevAll('h2,h3').first().text()),headerRow=node.find('tr').filter((_,row)=>$(row).find('th').length>0).first();
  if(!headerRow.length)return;
  const headerCells=headerRow.children('th,td'),headers=headerCells.toArray().map(cell=>header($(cell).text()));
  if(!headers.some(h=>h.field==='amount'||h.field==='participation_percent'))return;
  if(headerCells.length>64) {issues.push(`table[${tableIndex}]: column limit exceeded`);return;}
  if(headerCells.toArray().some(cell=>Number($(cell).attr('colspan')??1)!==1||Number($(cell).attr('rowspan')??1)!==1)) {issues.push(`table[${tableIndex}]: multi-level headers require a pinned schema`);return;}
  const schemaHash=semanticHash({version:MUNICIPAL_FINANCE_VERSION,headers:headers.map(h=>h.raw)});
  node.find('tr').each((rowIndex,row)=>{
   if($(row).find('th').length)return;
   const cells=$(row).children('td');if(!cells.length)return;rows++;
   if(cells.length!==headers.length||cells.toArray().some(cell=>Number($(cell).attr('colspan')??1)!==1||Number($(cell).attr('rowspan')??1)!==1)) {issues.push(`table[${tableIndex}]/tr[${rowIndex}]: cell/header shape changed`);return;}
   const raw=cells.toArray().map(cell=>$(cell).text()),get=(field:string)=>{const index=headers.findIndex(h=>h.field===field);return index<0?null:squash(raw[index]);};
   const product=get('product_id'),investment=get('investment_id'),rowYear=get('fiscal_year');
   const nativeId=scope.sourceId+':'+snapshot.url+`:table[${tableIndex}]:row[${rowIndex}]:`+semanticHash({product,investment});
   const path=`table[${tableIndex}]/tr[${rowIndex}]`;
   const allEvidence=raw.map((value,index)=>locator(snapshot,nativeId,path+`/td[${index}]`,value,schemaHash,[`th[${index}]`,path+`/td[${index}]`]));
   headers.forEach((h,index)=>allEvidence.push(locator(snapshot,nativeId,`table[${tableIndex}]/header/column[${index}]/text()`,h.raw,schemaHash)));
   allEvidence.push(locator(snapshot,nativeId,`table[${tableIndex}]/caption-or-preceding-heading/text()`,node.find('caption').first().text()||node.prevAll('h2,h3').first().text(),schemaHash));
   const emit=(predicate:string,value:string|number|null,year:string|null,role:StructuredObservation['financialRole'],unit:string|null,limitations:string[],column:number|null=null)=>{
    const subject=column===null?nativeId:nativeId+`:column[${column}]`;
    const separateIssuer=budgetScope((get('issuer')??'')+' '+(get('budget_scope')??'')+' '+heading)==='school_association';
    observations.push(observation({publisherId:scope.publisherId,sourceId:scope.sourceId,nativeId:subject,nativeVersion:snapshot.sourceVersion,kind:'FiscalObservation',subject,predicate,value,unit,date:year,dateRole:year?'fiscal_year':null,financialRole:role,geography:{ags:separateIssuer?null:scope.ags,basis:separateIssuer?'unknown':'verified_join',role:'administrative_area'},sourceReferenceDate:year,publishedAt:null,retrievedAt:snapshot.retrievedAt,evidence:allEvidence,limitations}));
   };
   const base=['Source-scoped fiscal row, not a verified project or legal entity.','Municipal AGS is the catalog issuer join, not project location.'];
   for(const field of ['product_id','investment_id','issuer','budget_scope','enterprise_name']) {const value=get(field);if(value)emit(field,value,null,'none',null,base);}
   headers.forEach((h,index)=>{
    if(h.field!=='amount'&&h.field!=='participation_percent')return;
    const year=h.year??(/^(?:19|20)\d{2}$/u.test(rowYear??'')?rowYear:null);
    const number=decimal(raw[index]);
    if(number===null) {issues.push(`${path}/td[${index}]: missing/suppressed/unrecognized numeric cell`);return;}
    if(!year) {issues.push(`${path}/td[${index}]: fiscal year not unambiguously sourced`);return;}
    if(h.field==='participation_percent') {
     if(!get('enterprise_name')||number<0||number>100) {issues.push(`${path}: invalid participation row`);return;}
     emit('participation_percent',number,year,'none','percent',[...base,'Ownership share as reported for the fiscal year; no network operation or confirmed-current identity assertion.']);return;
    }
    if(h.role==='none'||!h.currency) {issues.push(`${path}/td[${index}]: financial role or currency unknown`);return;}
    if(h.scale===null) {issues.push(`${path}/td[${index}]: unsupported or conflicting monetary magnitude qualifier`);return;}
    const amount=number*h.scale;
    const extra=[...base,`Amount basis: ${h.grossNet}.`,`Budget scope: ${get('budget_scope')??budgetScope(heading)}.`, `Issuer: ${get('issuer')??issuer(heading,scope)??'unknown'}.`, `Source column: ${h.raw}.`];
    emit('amount',amount,year,h.role,h.currency,extra,index);
    emit('gross_net',h.grossNet,year,'none',null,base,index);
    emit('amount_budget_scope',get('budget_scope')??budgetScope(heading),year,'none',null,base,index);
    emit('amount_issuer',get('issuer')??issuer(heading,scope),year,'none',null,base,index);
   });
  });
 });
 return {observations,rows,issues:[...new Set(issues)].sort()};
}
export const municipalFinanceAdapter:StructuredAdapter={
 id:'municipal-finance',version:MUNICIPAL_FINANCE_VERSION,
 discover(snapshot,scope,cursor) {
  let offset=0;
  if(cursor) {
   const value=JSON.parse(cursor) as {sourceSha256?:unknown;offset?:unknown};
   if(!value||value.sourceSha256!==snapshot.sourceSha256||typeof value.offset!=='number'||!Number.isSafeInteger(value.offset)||value.offset<0)throw Error('Finance cursor does not bind this snapshot');
   offset=value.offset;
  }
  const result=municipalFinanceDocuments(snapshot,scope);
  if(['held_quality','blocked_access'].includes(result.coverage.state))return {resources:[],coverage:result.coverage};
  const eligible=result.documents.filter(doc=>doc.status==='listed');
  if(offset>eligible.length)throw Error('Finance cursor offset exceeds eligible snapshot resources');
  const resources=eligible.slice(offset,offset+PAGE_SIZE).map(doc=>doc.resource);
  const nextCursor=offset+PAGE_SIZE<eligible.length?JSON.stringify({sourceSha256:snapshot.sourceSha256,offset:offset+PAGE_SIZE}):null;
  // Public next-page links remain native resources; their absence never proves archive completeness.
  const $=load(new TextDecoder().decode(snapshot.bytes));
  if(!nextCursor)$('a[rel~=next],link[rel~=next]').each((_,element)=>{const url=safeUrl($(element).attr('href')??'',snapshot.url);if(url)resources.push({url,nativeId:scope.sourceId+':'+url,parentId:scope.sourceId+':'+snapshot.url,method:'GET',body:null,format:'html'});});
  return {resources,coverage:{...result.coverage,nextCursor,observedRows:resources.length}};
 },
 parse(snapshot,scope) {
  const result=municipalFinanceDocuments(snapshot,scope);
  if(result.coverage.state==='blocked_access'||result.coverage.state==='held_quality'&&result.coverage.reason!=='No recognized finance entries; empty coverage not established')return {observations:[],coverage:result.coverage};
  const observations:StructuredObservation[]=[];
  for(const doc of result.documents) {
   const facts:Record<string,string|null>={title:doc.title,document_class:doc.documentClass,listing_status:doc.status,document_issuer:doc.issuer,budget_scope:doc.budgetScope,resource_url:doc.resource.url};
   for(const year of doc.fiscalYears)facts['fiscal_year:'+year]=year;
   for(const [predicate,value] of Object.entries(facts))observations.push(observation({publisherId:scope.publisherId,sourceId:scope.sourceId,nativeId:doc.resource.nativeId,nativeVersion:snapshot.sourceVersion,kind:'BudgetDocumentReference',subject:doc.resource.nativeId,predicate:predicate.startsWith('fiscal_year:')?'fiscal_year':predicate,value,unit:null,date:predicate.startsWith('fiscal_year:')?value:null,dateRole:predicate.startsWith('fiscal_year:')?'fiscal_year':null,financialRole:'none',geography:{ags:doc.budgetScope==='school_association'?null:scope.ags,basis:doc.budgetScope==='school_association'?'unknown':'verified_join',role:'administrative_area'},sourceReferenceDate:null,publishedAt:doc.publishedAt,retrievedAt:snapshot.retrievedAt,evidence:doc.evidence,limitations:['Listed document metadata only; contents, actual accounts, approval and expenditure unverified.','Unknown issuer/budget scope is not defaulted to municipal core.','Fiscal title years do not establish publication or event dates.']}));
  }
  const tables=financialTables(snapshot,scope);observations.push(...tables.observations);
  const unique=[...new Map(observations.map(value=>[value.id,value])).values()].sort((a,b)=>a.id.localeCompare(b.id,'en'));
  return {observations:unique,coverage:coverage(snapshot,scope,tables.issues.length&&!unique.length?'held_quality':unique.length?'partial':result.coverage.state,tables.issues.length?'Some native fiscal cells held; inspect limitations':unique.length?'Attributed index metadata and explicit native HTML fiscal cells parsed':result.coverage.reason,result.documents.length+tables.rows,null,[...result.coverage.limitations,...tables.issues])};
 },
};
