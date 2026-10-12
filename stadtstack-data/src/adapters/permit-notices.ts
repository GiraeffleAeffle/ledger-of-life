import {load} from 'cheerio';
import type {Cheerio} from 'cheerio';
import type {AnyNode} from 'domhandler';
import {assertSnapshot,observation,ScopeSchema,semanticHash} from '../district-adapter-contract.ts';
import type {AdmittedSnapshot,AdapterScope,AdapterCoverage,StructuredAdapter,StructuredLocator,StructuredObservation,ResourceReference} from '../district-adapter-contract.ts';

export const PERMIT_NOTICES_VERSION='permit-notices-html-v1';
export const PERMIT_NOTICE_SOURCES={
 'uvp-bb':'https://www.uvp-verbund.de/freitextsuche?provider=bb',
 'uvp-sh':'https://www.uvp-verbund.de/freitextsuche?provider=sh',
 'uvp-mv':'https://www.uvp-verbund.de/freitextsuche?provider=mv',
 'bimschg-bb':'https://lfu.brandenburg.de/lfu/de/aktuelles/oeffentliche-bekanntmachungen/immissionsschutzrecht-genehmigungsverfahren/genehmigungsverfahrensstelle-ost/',
 'bimschg-sh':'https://bimschg.bob-sh.de/',
 'bimschg-mv':'https://www.stalu-mv.de/wm/Service/Presse_Bekanntmachungen/',
} as const;
export type PermitNoticeSourceId=keyof typeof PERMIT_NOTICE_SOURCES;
const LIMITS={bytes:8*1024*1024,links:2000,fields:1000};
const LIMITATIONS=[
 'UVP is not an inventory of all BImSchG permits; an application, screening, consultation or linked decision is not a granted permit or construction.',
 'Index coverage is page-local, not municipal completeness. Location names do not establish AGS; scope AGS is never copied into records.',
 'Decisions, objections, conditions and fulfillment require separately admitted document/text evidence and residual substantive gates.',
 'Every discovered attachment requires its own acquisition/origin decision; official hyperlinks do not license third-party studies.',
];
export const permitNoticesCapabilityReceipt={
 adapterId:'permit-notices',version:PERMIT_NOTICES_VERSION,family:13,
 formats:['html'],networkInParser:false,discoveryInput:'admitted HTML snapshot',
 nativeIdentities:['UVP docuuid','BOB-SH procedure UUID','authority-scoped explicit file reference','source-document fallback (not project identity)'],
 deterministicFields:['index title','authority label','file reference','location label','explicit AGS','publication date','source reference date','inspection/objection deadlines','published procedure type/status','document links'],
 unsupportedClaims:['permit granted','permit authorizes project','objection disposition','conditions fulfilled','construction complete','payment'],
 sources:Object.entries(PERMIT_NOTICE_SOURCES).map(([sourceId,url])=>({sourceId,url,collectionState:'held_origin',reason:'Distribution/document rights unresolved; no live collection or endpoint verification performed by this adapter.'})),
 limits:LIMITS,limitations:LIMITATIONS,
} as const;

interface Field {key:string;label:string;raw:string;path:string}
interface RecordRow {nativeId:string;identityKind:string;fields:Field[];parentId:string|null}
interface Page {rows:RecordRow[];resources:ResourceReference[];coverage:AdapterCoverage;schemaHash:string}
const labels:Record<string,string>={
 'titel':'title','vorhaben':'title','vorhabenbezeichnung':'title','bezeichnung des vorhabens':'title',
 'zuständige behörde':'authority','genehmigungsbehörde':'authority','behörde':'authority',
 'aktenzeichen':'file_reference','geschäftszeichen':'file_reference','az':'file_reference',
 'ort':'location','standort':'location','gemeinde':'location','vorhabenstandort':'location',
 'gemeindeschlüssel':'ags','amtlicher gemeindeschlüssel':'ags','ags':'ags',
 'veröffentlichungsdatum':'publication_date','veröffentlicht am':'publication_date','bekanntmachungsdatum':'publication_date',
 'stand':'source_reference_date','stand der informationen':'source_reference_date',
 'auslegungsbeginn':'inspection_start','beginn der auslegung':'inspection_start',
 'auslegungsende':'inspection_end','ende der auslegung':'inspection_end',
 'einwendungsfrist':'objection_deadline','ende der einwendungsfrist':'objection_deadline',
 'verfahrensart':'procedure_type','art des verfahrens':'procedure_type','uvp-kategorie':'procedure_type',
 'verfahrensstand':'status','status':'status',
};
const clean=(text:string)=>text.replace(/\s+/gu,' ').trim();
function keyFor(label:string):string|undefined {
 return labels[clean(label).toLocaleLowerCase('de').replace(/[:.]$/u,'')];
}
function sourceId(scope:AdapterScope):PermitNoticeSourceId {
 ScopeSchema.parse(scope);
 if(!Object.hasOwn(PERMIT_NOTICE_SOURCES,scope.sourceId))throw Error('Unsupported permit notice source');
 return scope.sourceId as PermitNoticeSourceId;
}
function publicLink(href:string,base:string):URL|null {
 try {
  const url=new URL(href,base),host=url.hostname.toLowerCase();
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||host==='localhost'||!host.includes('.')||host.endsWith('.local')||/^(?:\d+\.){3}\d+$/.test(host)||host.includes(':'))return null;
  url.hash='';return url;
 }catch{return null;}
}
function nativeIdentity(url:URL,source:PermitNoticeSourceId):{id:string;kind:string}|null {
 if(source.startsWith('uvp-')){
  const uuid=url.searchParams.get('docuuid');
  if(uuid&&/^[a-zA-Z0-9_-]{1,160}$/.test(uuid))return {id:uuid,kind:'uvp_docuuid'};
 }
 if(source==='bimschg-sh'){
  const match=url.pathname.match(/\/verfahren\/([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\/public\/detail\/?$/i);
  if(match)return {id:match[1].toLowerCase(),kind:'bobsh_procedure'};
 }
 return null;
}
function parseDate(raw:string):string|null {
 const match=raw.match(/^(?:(\d{4})-(\d{2})-(\d{2})|(\d{1,2})\.(\d{1,2})\.(\d{4}))$/);
 if(!match)return null;
 const year=Number(match[1]??match[6]),month=Number(match[2]??match[5]),day=Number(match[3]??match[4]);
 const value=new Date(Date.UTC(year,month-1,day));
 if(value.getUTCFullYear()!==year||value.getUTCMonth()!==month-1||value.getUTCDate()!==day)return null;
 return `${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}
function page(snapshot:AdmittedSnapshot,scope:AdapterScope,cursor:string|null):Page {
 assertSnapshot(snapshot);
 const source=sourceId(scope),root=new URL(PERMIT_NOTICE_SOURCES[source]),url=new URL(snapshot.url);
 const coverage=(state:AdapterCoverage['state'],reason:string,observedRows=0,nextCursor:string|null=null):AdapterCoverage=>({state,scope:`${scope.sourceId}: ${snapshot.url}; requested municipality ${scope.municipalityId}/${scope.ags} (not an evidenced geographic binding)`,reason,checkedAt:snapshot.retrievedAt,nextCursor,observedRows,limitations:[...LIMITATIONS]});
 const halt=(state:AdapterCoverage['state'],reason:string):Page=>({rows:[],resources:[],coverage:coverage(state,reason),schemaHash:semanticHash({version:PERMIT_NOTICES_VERSION,source})});
 if(url.hostname!==root.hostname||source.startsWith('uvp-')&&url.searchParams.has('provider')&&url.searchParams.get('provider')!==source.slice(4))return halt('held_quality','Snapshot does not belong to the catalog source/state slice.');
 if(cursor!==null&&cursor!==snapshot.url)return halt('held_quality','Cursor must be the exact previously discovered page URL of this admitted snapshot.');
 if(snapshot.bytes.byteLength>LIMITS.bytes)return halt('held_quality','HTML byte limit exceeded; no partial parsing.');
 if(!/^text\/html(?:;|$)|^application\/xhtml\+xml(?:;|$)/i.test(snapshot.mimeType))return halt('held_quality','Only original HTML indices/details are supported; linked documents require the document pipeline.');
 let html:string;try{html=new TextDecoder('utf-8',{fatal:true}).decode(snapshot.bytes);}catch{return halt('held_quality','Invalid UTF-8 HTML; acquisition must preserve/declare the actual encoding.');}
 const $=load(html),main=$('main').first().length?$('main').first():$('body');
 const text=clean(main.text());
 if($('input[type=password],iframe[src*="captcha"],.g-recaptcha').length||/zugriff verweigert|access denied|403 forbidden|bitte melden sie sich an/i.test(text))return halt('blocked_access','Access-control/challenge page; no discovery or negative relevance inference.');
 if(/404 not found|seite wurde nicht gefunden|seite nicht gefunden/i.test(text))return halt('held_quality','Missing page is not an explicit procedure withdrawal.');
 if($('a[href]').length>LIMITS.links||$('dt,tr').length>LIMITS.fields)return halt('held_quality','HTML record/link limit exceeded; no silent truncation.');
 function path(element:AnyNode|undefined):string {
  if(!element)throw Error('Missing HTML evidence node');
  const parts:string[]=[];
  for(let current=$(element);current.length;current=current.parent()){
   const node=current[0];if(node.type!=='tag')break;
   parts.unshift(`${node.name}:nth-of-type(${current.prevAll(node.name).length+1})`);
  }
  return parts.join(' > ');
 }
 function fields(container:Cheerio<AnyNode>):Field[] {
  const result:Field[]=[];
  container.find('dt').each((_,element)=>{
   const label=clean($(element).text()),key=keyFor(label),value=$(element).next('dd');
   if(key&&value.length)result.push({key,label,raw:value.text(),path:path(value[0])});
  });
  container.find('tr').each((_,element)=>{
   const cells=$(element).children('th,td');
   if(cells.length!==2)return;
   const label=clean(cells.eq(0).text()),key=keyFor(label);
   if(key)result.push({key,label,raw:cells.eq(1).text(),path:path(cells[1])});
  });
  return result;
 }
 const detailIdentity=nativeIdentity(url,source);
 const hasIndexLinks=main.find('a[href]').toArray().some(element=>{
  const target=publicLink($(element).attr('href')!,snapshot.url);
  if(target&&(/\.pdf(?:$|[?&#])|\.zip(?:$|[?&#])/i.test(target.href)||$(element).attr('type')==='application/pdf'||$(element).attr('download')!==undefined||/\/download|\/dokument|\/document|\/loadDocument/i.test(target.pathname)))return false;
  return target&&target.hostname===root.hostname&&target.href!==snapshot.url&&(nativeIdentity(target,source)||source==='bimschg-mv'&&target.searchParams.get('processor')==='processor.sa.pressemitteilung'&&target.searchParams.has('id')||source==='bimschg-bb'&&target.pathname!==url.pathname&&/bekanntmach|genehmig|immissionsschutz/i.test(target.pathname+' '+$(element).text()));
 });
 const detailFields=detailIdentity||!hasIndexLinks?fields(main):[];
 const authorityValues=[...new Set(detailFields.filter(field=>field.key==='authority').map(field=>clean(field.raw)).filter(Boolean))];
 const fileValues=[...new Set(detailFields.filter(field=>field.key==='file_reference').map(field=>clean(field.raw)).filter(Boolean))];
 const scopedFile=authorityValues.length===1&&fileValues.length===1?`authority-file:${semanticHash({publisher:scope.publisherId,authority:authorityValues[0],file:fileValues[0]})}`:null;
 const detailId=detailIdentity?.id??scopedFile??`source-document:${semanticHash({publisher:scope.publisherId,source,url:snapshot.url})}`;
 const rows:RecordRow[]=[],resources:ResourceReference[]=[];
 const h1=main.find('h1').first();
 const detailRow:RecordRow|null=detailIdentity||detailFields.length?{nativeId:detailId,identityKind:detailIdentity?.kind??(scopedFile?'authority_file_reference':'source_document'),parentId:null,fields:[...(h1.length?[{key:'title',label:'h1',raw:h1.text(),path:path(h1[0])}]:[]),...detailFields]}:null;
 if(detailRow)rows.push(detailRow);
 let nextCursor:string|null=null,paginationConflict=false;
 main.find('a[href]').each((_,element)=>{
  const anchor=$(element);
  if(anchor.closest('header,footer').length||anchor.closest('nav').length&&!anchor.closest('[aria-label*="agin"],.pagination,.pager').length)return;
  const href=anchor.attr('href')!,target=publicLink(href,snapshot.url);
  if(!target||/login|logout|registrier|\/kontakt|\/impressum|\/datenschutz/i.test(target.href))return;
  const label=clean(anchor.text()),rawHref:Field={key:'document_url',label,raw:href,path:path(element)+'/@href'};
  const next=anchor.attr('rel')?.split(/\s+/).includes('next')||anchor.closest('.pagination,.pager,[aria-label*="agin"]').length&&/^(?:weiter|nächste(?: seite)?|next|›|»)$/i.test(label);
  if(next&&target.hostname===root.hostname&&target.href!==snapshot.url){
   if(nextCursor&&nextCursor!==target.href)paginationConflict=true;
   nextCursor=target.href;resources.push({url:target.href,nativeId:`page:${semanticHash(target.href)}`,parentId:null,method:'GET',body:null,format:'html'});return;
  }
  const identity=nativeIdentity(target,source);
  const fileFormat=/\.pdf(?:$|[?&#])/i.test(target.href)||anchor.attr('type')==='application/pdf'?'pdf':/\.zip(?:$|[?&#])/i.test(target.href)?'zip':null;
  const download=fileFormat||anchor.attr('download')!==undefined||/\/download|\/dokument|\/document|\/loadDocument/i.test(target.pathname);
  const notice=target.hostname===root.hostname&&(identity||source==='bimschg-mv'&&target.searchParams.get('processor')==='processor.sa.pressemitteilung'&&target.searchParams.has('id')||source==='bimschg-bb'&&target.pathname!==url.pathname&&/bekanntmach|genehmig|immissionsschutz/i.test(target.pathname+' '+label));
  if(!download&&!notice)return;
  const nativeId=identity?.id??`source-document:${semanticHash({publisher:scope.publisherId,source,url:target.href})}`;
  resources.push({url:target.href,nativeId,parentId:detailRow?.nativeId??null,method:'GET',body:null,format:fileFormat??(download?'document':'html')});
  if(notice&&!download){
   const card=anchor.closest('article,li,tr'),indexFields=card.length?fields(card):[];
   if(card.is('tr')){
    const headers=card.closest('table').find('thead tr').first().children('th,td'),cells=card.children('td');
    if(headers.length===cells.length)headers.each((index,header)=>{
     const label=clean($(header).text()),key=keyFor(label);
     if(key)indexFields.push({key,label,raw:cells.eq(index).text(),path:path(cells[index])});
    });
   }
   rows.push({nativeId,identityKind:identity?.kind??'source_document',parentId:null,fields:[{key:'title',label:'index link',raw:anchor.text(),path:path(element)}, {key:'detail_url',label:'index href',raw:href,path:path(element)+'/@href'},...indexFields]});
  }else if(detailRow)detailRow.fields.push(rawHref,{key:'document_label',label:'attachment label',raw:anchor.text(),path:path(element)});
  else rows.push({nativeId,identityKind:'source_document',parentId:null,fields:[rawHref,{key:'document_label',label:'attachment label',raw:anchor.text(),path:path(element)}]});
 });
 if(paginationConflict)return halt('held_quality','Conflicting next-page links; traversal held rather than choosing a cursor.');
 const uniqueResources=[...new Map(resources.map(resource=>[resource.url,resource])).values()].sort((a,b)=>a.url.localeCompare(b.url,'en'));
 const rowMap=new Map<string,RecordRow>();
 for(const row of rows){
  const existing=rowMap.get(row.nativeId);
  if(existing)existing.fields.push(...row.fields);else rowMap.set(row.nativeId,row);
 }
 for(const row of rowMap.values())row.fields=[...new Map(row.fields.map(field=>[`${field.key}\n${field.path}\n${field.raw}`,field])).values()];
 const uniqueRows=[...rowMap.values()].sort((a,b)=>a.nativeId.localeCompare(b.nativeId,'en'));
 const emptyMarker=/^(?:keine (?:treffer|ergebnisse|verfahren|bekanntmachungen)(?: gefunden| vorhanden)?|0\s+treffer)[.!]?$/i;
 const explicitEmpty=emptyMarker.test(text)||main.find('p,[role=status],.alert,.search-result-count').toArray().some(element=>emptyMarker.test(clean($(element).text())));
 if(!rows.length&&!resources.length&&!explicitEmpty)return halt('held_quality','No recognized native detail/index fields, document links or explicit empty-result marker; schema change is not empty coverage.');
 const schemaHash=semanticHash({version:PERMIT_NOTICES_VERSION,source,fields:[...new Set(rows.flatMap(row=>row.fields.map(field=>`${field.key}:${field.label}`)))].sort()});
 return {rows:uniqueRows,resources:uniqueResources,schemaHash,coverage:coverage(!rows.length&&!resources.length?'empty':'partial',!rows.length&&!resources.length?'Explicit empty result on this admitted page only; no statewide/municipal absence claim.':'Native HTML metadata/link extraction only; geography and residual legal decision evidence remain unresolved.',uniqueRows.length,nextCursor)};
}
export const permitNoticesAdapter:StructuredAdapter={
 id:'permit-notices',version:PERMIT_NOTICES_VERSION,
 discover(snapshot,scope,cursor){const result=page(snapshot,scope,cursor);return {resources:result.resources,coverage:result.coverage};},
 parse(snapshot,scope){
  const result=page(snapshot,scope,null),observations:StructuredObservation[]=[];
  for(const row of result.rows){
   const explicitAgs=row.fields.filter(field=>field.key==='ags').map(field=>clean(field.raw));
   const ags=explicitAgs.length&&new Set(explicitAgs).size===1&&/^\d{8}$/.test(explicitAgs[0])?explicitAgs[0]:null;
   const publicationDates=[...new Set(row.fields.filter(field=>field.key==='publication_date').map(field=>parseDate(clean(field.raw))))];
   const referenceDates=[...new Set(row.fields.filter(field=>field.key==='source_reference_date').map(field=>parseDate(clean(field.raw))))];
   for(const field of row.fields){
    const normalized=clean(field.raw),dateField=field.key.endsWith('_date')||['inspection_start','inspection_end','objection_deadline'].includes(field.key);
    const date=dateField?parseDate(normalized):null;
    const evidence:StructuredLocator={sourceSha256:snapshot.sourceSha256,format:'html',nativeId:row.nativeId,path:field.path,sheet:null,rowKey:row.nativeId,cells:[field.label],rawValue:field.raw,schemaHash:result.schemaHash,mappingVersion:PERMIT_NOTICES_VERSION};
    const limitations=[...LIMITATIONS,`Identity basis: ${row.identityKind}; source-document fallback is not a procedure/project identity.`];
    if(dateField&&!date)limitations.push('Date field retained verbatim; no unambiguous valid full date parsed.');
    if(field.key==='status'&&/zurückgezogen|aufgehoben|widerrufen|eingestellt/i.test(normalized))limitations.push('Explicit source status retained; no historical observation deletion or inferred legal effect.');
    const value=field.key.endsWith('_url')?publicLink(normalized,snapshot.url)?.href??normalized:normalized;
    observations.push(observation({publisherId:scope.publisherId,sourceId:scope.sourceId,nativeId:row.nativeId,nativeVersion:snapshot.sourceVersion,kind:row.identityKind==='source_document'?'PermitNoticeDocumentMetadata':'PermitProcedureMetadata',subject:`${scope.publisherId}:${scope.sourceId}:${row.nativeId}`,predicate:`published_${field.key}`,value,unit:null,date,dateRole:dateField?field.key:null,financialRole:'none',geography:{ags,basis:ags?'source_explicit':'unknown',role:ags?'project_location':'unknown'},sourceReferenceDate:referenceDates.length===1?referenceDates[0]:null,publishedAt:publicationDates.length===1?publicationDates[0]:null,retrievedAt:snapshot.retrievedAt,evidence:[evidence],limitations}));
   }
  }
  observations.sort((a,b)=>a.id.localeCompare(b.id,'en'));
  return {observations,coverage:result.coverage};
 },
};
