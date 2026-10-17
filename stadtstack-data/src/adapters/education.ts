import {load} from 'cheerio';
import {assertSnapshot, canonicalJson, observation, ScopeSchema, semanticHash, type AdapterScope, type AdmittedSnapshot, type AdapterCoverage, type StructuredAdapter, type StructuredLocator, type StructuredObservation, type ResourceReference, type ParseResult} from '../district-adapter-contract.ts';
import {readXlsx, type NativeTable, type NativeCell} from './structured-tables.ts';
import {createGenesisAdapter} from './genesis.ts';

export const EDUCATION_VERSION = 'education-native-v1';
export const EDUCATION_SOURCES = ['school-stats-bb', 'school-stats-sh', 'school-stats-mv', 'kita-regional-statistics', 'kita-hoppegarten', 'kita-ruedersdorf'] as const;
const PILOTS: Record<string,true> = {'12064472':true,'12064227':true,'12064428':true,'01053100':true,'01053090':true,'01053116':true,'13076090':true,'13076108':true,'13076060':true};
const LIMITATIONS = ['Context is not measured project impact.', 'K03 MV operator identity remains unaddressed; BB facility lists and district aggregates do not answer it.', 'A roster is neither occupancy nor available places; missing entries are not withdrawals.', 'Operator names are source-scoped mentions, not verified legal identity; validity bounds remain unknown.', 'Contacts and private people are excluded.'];
export interface EducationOptions {admission?: 'admitted'|'held_origin'|'blocked_policy'|'blocked_access'; pageSize?: number}
export interface EducationRawField {path: string; rawValue: string; format: 'html'|'xlsx'; sheet: string|null; cells: string[]}
const kitaStatistics = createGenesisAdapter('kita-regional-statistics', {
  '22541-01-04': {level: 'KR', referenceDay: '03-01', statistic: 'kita_institutions_approved_places_staff'},
  '22543-03-01': {level: 'KR', referenceDay: '03-01', statistic: 'kita_u3_rate'},
});
function coverage(s: AdmittedSnapshot, scope: AdapterScope, state: AdapterCoverage['state'], reason: string, rows=0, nextCursor: string|null=null): AdapterCoverage {
  return {state, reason, scope: `${scope.sourceId}:${scope.ags}:${scope.observationWindow}`, checkedAt: s.retrievedAt, observedRows: rows, nextCursor, limitations: LIMITATIONS};
}
function gate(s: AdmittedSnapshot, scope: AdapterScope, options: EducationOptions): AdapterCoverage|null {
  ScopeSchema.parse(scope); assertSnapshot(s);
  if (!Object.hasOwn(PILOTS,scope.ags)) return coverage(s,scope,'not_applicable','Outside the nine approved pilot municipalities');
  if (['sh-school-directory','mv-school-directory','mv-kita-directory'].includes(scope.sourceId)) return coverage(s,scope,'blocked_policy','Restricted SH and paid MV directories are excluded; no purchase or access bypass');
  if (!(EDUCATION_SOURCES as readonly string[]).includes(scope.sourceId)) return coverage(s,scope,'not_applicable','Not a family-7 catalog source');
  if ((scope.sourceId==='kita-hoppegarten' && scope.ags!=='12064227') || (scope.sourceId==='kita-ruedersdorf' && scope.ags!=='12064428')) return coverage(s,scope,'not_applicable','Local BB inventory cannot establish another municipality or MV K03');
  const statePrefixes: Record<string,string> = {'school-stats-bb':'12','school-stats-sh':'01','school-stats-mv':'13'};
  if (scope.sourceId.startsWith('school-stats-') && !scope.ags.startsWith(statePrefixes[scope.sourceId])) return coverage(s,scope,'not_applicable','State statistics are outside this pilot state');
  const url = new URL(s.url);
  const hosts: Record<string,string[]> = {'kita-hoppegarten':['www.gemeinde-hoppegarten.de'], 'kita-ruedersdorf':['www.ruedersdorf.de'], 'school-stats-bb':['www.statistik-berlin-brandenburg.de','download.statistik-berlin-brandenburg.de'], 'school-stats-sh':['www.statistik-nord.de'], 'school-stats-mv':['www.laiv-mv.de'], 'kita-regional-statistics':['www.regionalstatistik.de']};
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || !hosts[scope.sourceId].includes(url.hostname)) return coverage(s,scope,'held_origin','Snapshot publisher does not match the catalog route');
  if (/Schulverzeichnis|SVExportEINR|\/Verzeichnisse\//i.test(decodeURIComponent(url.pathname))) return coverage(s,scope,'blocked_policy','Address-directory distribution is not an aggregate statistical report');
  if (s.bytes.byteLength>16*1024*1024) return coverage(s,scope,'held_quality','Snapshot exceeds bounded native input size');
  if (options.admission!=='admitted') return coverage(s,scope,options.admission??'held_origin','Distribution-specific rights require an acquisition admission receipt; public access is not a licence');
  return null;
}
function html(s: AdmittedSnapshot) {if (!/html/i.test(s.mimeType)) throw Error('Expected original HTML bytes'); return load(new TextDecoder('utf-8',{fatal:true}).decode(s.bytes));}
function raw(path: string, rawValue: string): EducationRawField {return {path,rawValue,format:'html',sheet:null,cells:[]};}
function make(s: AdmittedSnapshot, scope: AdapterScope, nativeId: string, kind: string, subject: string, predicate: string, value: string|number|null, fields: EducationRawField[], options: {unit?:string;date?:string;district?:string;limitations?:string[]}={}): StructuredObservation {
  const schemaHash=semanticHash({source:scope.sourceId,mapping:EDUCATION_VERSION,format:fields[0].format,sheet:fields[0].sheet});
  const evidence: StructuredLocator[]=fields.map(f=>({...f,sourceSha256:s.sourceSha256,nativeId,rowKey:nativeId,schemaHash,mappingVersion:EDUCATION_VERSION}));
  return observation({publisherId:scope.publisherId,sourceId:scope.sourceId,nativeId,nativeVersion:s.sourceVersion,kind,subject,predicate,value,unit:options.unit??null,date:options.date??null,dateRole:options.date?'school_year':null,financialRole:'none',geography:{ags:options.district?null:scope.ags,basis:options.district?'verified_join':'source_explicit',role:'administrative_area'},sourceReferenceDate:options.date??null,publishedAt:null,retrievedAt:s.retrievedAt,evidence,limitations:[...LIMITATIONS,...(options.district?[`District ${options.district}; never disaggregated into municipality ${scope.ags}. Boundary vintage unverified.`]:[]),...(options.limitations??[])]});
}
function resource(href: string, s: AdmittedSnapshot, nativeId: string, format='html'): ResourceReference {
  const url=new URL(href,s.url); if (!['http:','https:'].includes(url.protocol)||url.username||url.password) throw Error('Unsafe resource URL');
  return {url:url.href,nativeId,parentId:s.url,method:'GET',body:null,format};
}
function page(resources: ResourceReference[], s: AdmittedSnapshot, scope: AdapterScope, cursor: string|null, size: number) {
  const unique=[...new Map(resources.map(r=>[r.url,r])).values()]; if(unique.length>1000) throw Error('Discovery resource bound');
  const binding=semanticHash({sha:s.sourceSha256,scope,resources:unique,size}); let offset=0;
  if(cursor!==null){const c=JSON.parse(cursor); if(c.binding!==binding||!Number.isInteger(c.offset)||c.offset<0||c.offset>=unique.length)throw Error('Invalid or stale cursor');offset=c.offset;}
  const next=offset+size<unique.length?canonicalJson({binding,offset:offset+size}):null;
  return {resources:unique.slice(offset,offset+size),coverage:coverage(s,scope,unique.length?'partial':'not_checked',unique.length?'Observed native references only; corpus completeness is unverified':'No native resource links observed; this is not a zero-facility result',unique.length,next)};
}
function hoppegarten(s: AdmittedSnapshot, scope: AdapterScope): ParseResult {
  const $=html(s), root=$('#content .template-page-effect'); if(root.length!==1 || !root.find('h1').text().includes('Kitaverzeichnis')) throw Error('Changed Hoppegarten inventory structure');
  const out: StructuredObservation[]=[], seen=new Set<string>(); let operator: {name:string;field:EducationRawField;parent:object}|null=null;
  root.find('p,a,h1,h2,h3,h4,h5,h6').each((_,el)=>{
    const node=$(el), text=node.text(), label=text.replace(/\s+/g,' ').trim();
    if(node.is('h1,h2,h3,h4,h5,h6')){operator=null;return;}
    if(node.is('p') && !node.find('a').length){
      if(/^Kindertagesstätten in Trägerschaft der /.test(label)){
        const name=label.slice('Kindertagesstätten in Trägerschaft der '.length);
        operator=/^(?:Gemeinde Hoppegarten|Kinderland Krümelbude gGmbH)$/.test(name)?{name,field:raw(`#content .template-page-effect p:eq(${root.find('p').index(el)})/text()`,text),parent:node.parent()[0]}:null;
      }else if(label && operator && (node.parent()[0]===operator.parent || node.find('strong').length) && !/^Im Ortsteil (?:Hönow:|Dahlwitz-Hoppegarten)$/.test(label)){
        operator=null;
      }
    }
    if(!node.is('a')||!label||!/(?:Kita|Hort)/.test(label))return;
    const href=node.attr('href');if(!href)return; const url=new URL(href,s.url);
    if(url.hostname!=='www.gemeinde-hoppegarten.de'||url.pathname!=='/verzeichnis/visitenkarte.php')return;
    const id=url.searchParams.get('mandat');if(!id||!/^\d+$/.test(id))throw Error('Changed native mandate ID');if(seen.has(id))return;seen.add(id);
    const nativeId=`mandat:${id}`, path=`#content .template-page-effect a[href=${JSON.stringify(href)}]`;
    const fields=[raw(path+'/text()',text),raw(path+'/@href',href)];
    out.push(make(s,scope,nativeId,label.startsWith('Hort')?'Hort':'Kita',`${scope.sourceId}:${nativeId}`,'facility_name',label,fields));
    const locality=node.closest('.content').find('p').filter((_,p)=>$(p).text().trim()==='15366 Hoppegarten');
    if(locality.length)out.push(make(s,scope,nativeId,'FacilityLocation',`${scope.sourceId}:${nativeId}`,'located_in','municipality:12064227',[...fields,raw(`#content .template-page-effect p:eq(${root.find('p').index(locality[0])})/text()`,locality.first().text())]));
    const groupBlock=node.closest('.btgrid');
    const facilityOperator=operator && groupBlock.length===1 && groupBlock.parent()[0]===operator.parent?operator:null;
    if(facilityOperator)out.push(make(s,scope,nativeId,'OrganizationFacilityRole',`${scope.sourceId}:operator:${semanticHash(facilityOperator.name)}`,'operates',`${scope.sourceId}:${nativeId}`,[...fields,facilityOperator.field],{limitations:[`Named operator: ${facilityOperator.name}; explicit structurally bounded Trägerschaft group, no validity interval established.`]}));
    if(facilityOperator)out.push(make(s,scope,nativeId,'Organization',`${scope.sourceId}:operator:${semanticHash(facilityOperator.name)}`,'organization_name',facilityOperator.name,[facilityOperator.field]));
  });
  // The introductory offered-places statement is a municipal total, not per-facility capacity/occupancy.
  root.find('p').each((i,el)=>{const text=$(el).text();const match=/In der Gemeinde Hoppegarten werden (\d+) Betreuungsplätze in elf Kindertagesstätten[^.]*angeboten\./.exec(text);if(match)out.push(make(s,scope,'municipal-offered-kita-places','EducationObservation','municipality:12064227','places_offered',Number(match[1]),[raw(`#content .template-page-effect p:eq(${i})/text()/matched-statement`,match[0])],{unit:'places',limitations:['Municipal total, ages 0 to school entry; no source reference date on the statement. Not approved capacity, free places or occupancy.']}));});
  return {observations:out,coverage:coverage(s,scope,out.length?'partial':'empty',out.length?'Parsed named roster entries and explicit provider groups; full current inventory and valid time unverified':'No entries in recognized inventory; disappearance is not a withdrawal',seen.size)};
}
function ruedersdorf(s: AdmittedSnapshot, scope: AdapterScope): ParseResult {
  const $=html(s), out: StructuredObservation[]=[];
  const cards=$('.integration-card');
  if(cards.length){cards.each((i,el)=>{const node=$(el),a=node.find('a.sd-organisation--name-link'); if(a.length!==1)throw Error('Changed native organization card');const href=a.attr('href')!,url=new URL(href,s.url);
    if(url.hostname!=='www.ruedersdorf.de'||!/^\/strukturierte-daten\/organisationen\/kitas\/[^/]+\/$/.test(url.pathname))throw Error('Unrecognized facility native URL');
    const name=a.text().trim();if(!name)throw Error('Missing facility label');out.push(make(s,scope,url.pathname,'Kita',`${scope.sourceId}:${url.pathname}`,'facility_name',name,[raw(`.integration-card:eq(${i}) a.sd-organisation--name-link/text()`,a.text()),raw(`.integration-card:eq(${i}) a.sd-organisation--name-link/@href`,href)]));
    const address=node.find('.integration-card__postal-address-wrapper address');if(address.length===1 && /(?:^|,\s*)\d{5} Rüdersdorf bei Berlin$/.test(address.text().trim()))out.push(make(s,scope,url.pathname,'FacilityLocation',`${scope.sourceId}:${url.pathname}`,'located_in','municipality:12064428',[raw(`.integration-card:eq(${i}) a.sd-organisation--name-link/@href`,href),raw(`.integration-card:eq(${i}) .integration-card__postal-address-wrapper address/text()`,address.text())]));
  });return {observations:out,coverage:coverage(s,scope,'partial','Facility card names only; brand/domain/contact never establishes operator; list pagination/completeness unverified',cards.length)};}
  const url=new URL(s.url);
  if(/^\/strukturierte-daten\/organisationen\/kitas\/[^/]+\/$/.test(url.pathname)){
    const heading=$('#main-content h1.main-column__headline');if(heading.length!==1)throw Error('Changed native facility detail');const name=heading.text().trim(),id=url.pathname,subject=`${scope.sourceId}:${id}`,nameField=raw('#main-content h1.main-column__headline/text()',heading.text());
    out.push(make(s,scope,id,'Kita',subject,'facility_name',name,[nameField]));
    // Only this inspected unambiguous explicit sentence is mapped; umbrellaOrganisationName may include a Förderverein and is not an operator field.
    $('#main-content .sd-organisation--description p').each((i,el)=>{
      const text=$(el).clone().find('br').replaceWith('\n').end().text(),match=/(?:^|[.\n])\s*(Träger der Einrichtung ist die Gemeinde Rüdersdorf bei Berlin\.)/.exec(text);
      if(!match)return;
      const roleField=raw(`#main-content .sd-organisation--description p:eq(${i})/text()/matched-statement`,match[1]),operator=`${scope.sourceId}:operator:gemeinde-ruedersdorf`;
      out.push(make(s,scope,id,'OrganizationFacilityRole',operator,'operates',subject,[nameField,roleField],{limitations:['Named operator: Gemeinde Rüdersdorf bei Berlin. Dachorganisation/Förderverein is not mapped as an additional operator. Unknown valid time.']}));
      out.push(make(s,scope,id,'Organization',operator,'organization_name','Gemeinde Rüdersdorf bei Berlin',[roleField]));
    });
    return {observations:out,coverage:coverage(s,scope,'partial','Attributed facility detail; unmapped/ambiguous operator text remains unresolved',1)};
  }
  if($('.component-organisations [data-integration-result-page]').length)return {observations:[],coverage:coverage(s,scope,'not_checked','Native landing is a dynamic inventory shell; acquire its observed result URL through shared policy')};
  if($('.integration-result').length && !$('.loading.is-active').length)return {observations:[],coverage:coverage(s,scope,'empty','Recognized empty native result container; not a withdrawal')};
  throw Error('Changed Rüdersdorf native inventory schema');
}
interface SchoolMapping {sheet:string;title:string;district:string;name:string;geographyColumn:number;valueColumn:number;header:string;predicate:string;unit:string}
const SCHOOL_MAPPINGS: Record<string,SchoolMapping[]>={
 'school-stats-bb':[{sheet:'Tab1.1.+1.2',title:'Selbstständige Schulen des Schuljahres',district:'12064',name:'Märkisch-Oderland',geographyColumn:0,valueColumn:1,header:'SelbstständigeSchulen',predicate:'school_count',unit:'schools'}, {sheet:'Tab2.1',title:'Schülerinnen und Schüler des Schuljahres',district:'12064',name:'Märkisch-Oderland',geographyColumn:0,valueColumn:1,header:'SchülerinnenundSchüler',predicate:'enrolled_pupils',unit:'pupils'}],
 'school-stats-sh':[{sheet:'Tab. 1.2',title:'Einrichtungen an den allgemeinbildenden Schulen',district:'01053',name:'Herzogtum Lauenburg',geographyColumn:0,valueColumn:1,header:'Insgesamt',predicate:'school_institutions',unit:'institutions'}, {sheet:'Tab. 1.4',title:'Schülerinnen und Schüler an den allgemeinbildenden Schulen',district:'01053',name:'Herzogtum Lauenburg',geographyColumn:0,valueColumn:1,header:'Insgesamt',predicate:'enrolled_pupils',unit:'pupils'}],
 'school-stats-mv':[{sheet:'2.1',title:'Allgemeinbildende Schulen im Schuljahr',district:'13076',name:'Ludwigslust-Parchim',geographyColumn:1,valueColumn:2,header:'Schuleninsgesamt',predicate:'school_count',unit:'schools'}, {sheet:'2.4',title:'Schüler im Schuljahr',district:'13076',name:'Ludwigslust-Parchim',geographyColumn:1,valueColumn:3,header:'Schüler',predicate:'enrolled_pupils',unit:'pupils'}],
};
function field(table: NativeTable,cell: NativeCell): EducationRawField {return {format:'xlsx',sheet:table.sheet,cells:[cell.address],path:`${table.sheet}!${cell.address}`,rawValue:cell.raw};}
function school(s: AdmittedSnapshot,scope:AdapterScope):ParseResult {
 const tables=readXlsx(s.bytes),out:StructuredObservation[]=[];let matched=0;
 for(const mapping of SCHOOL_MAPPINGS[scope.sourceId]){
  const table=tables.find(t=>t.sheet===mapping.sheet);if(!table)continue;matched++;
  let title:NativeCell|undefined;for(const row of table.rows){title=row?.find(c=>c?.raw.includes(mapping.title));if(title)break;}if(!title)throw Error(`Changed title in ${mapping.sheet}`);
  const year=/Schuljahr(?:es)?\s+(20\d{2})\/(20\d{2}|\d{2})/.exec(title.raw);if(!year)throw Error('Missing native school year');
  const end=year[2].length===2?Number(year[1].slice(0,2)+year[2]):Number(year[2]);if(end!==Number(year[1])+1)throw Error('Invalid native school-year interval');const period=`${year[1]}/${end}`;
  const header=table.rows.find(row=>row?.[mapping.valueColumn] && row[mapping.valueColumn].raw.replace(/[-\s\u00ad]/g,'')===mapping.header)?.[mapping.valueColumn];if(!header)throw Error(`Changed metric header ${mapping.sheet}`);
  const rowIndex=table.rows.findIndex(row=>row?.[mapping.geographyColumn]?.raw.trim()===mapping.name);if(rowIndex<0)continue;const row=table.rows[rowIndex];
  const marker=scope.sourceId==='school-stats-sh'?(mapping.predicate==='school_institutions'?'Einrichtungen an öffentlichen und privaten Schulen':'Öffentliche und private Schulen'):scope.sourceId==='school-stats-mv'&&mapping.predicate==='enrolled_pupils'?'Allgemeinbildende Schulen insgesamt':scope.sourceId==='school-stats-bb'&&mapping.predicate==='enrolled_pupils'?'insgesamt':null;
  let scopeCell:NativeCell|undefined;
  if(marker){for(let r=rowIndex-1;r>=0;r--){const cells=table.rows[r];if(!cells)continue;const labels=cells.filter(c=>c?.raw.trim());if(labels.length===1){scopeCell=labels[0];break;}}if(!scopeCell||scopeCell.raw.trim()!==marker)throw Error('Changed total/public/private/sex section ordering');}
  if(scope.sourceId==='school-stats-mv'&&mapping.predicate==='enrolled_pupils'&&row[2]?.raw.trim()!=='zusammen')throw Error('Changed sex-total row');
  const value=row[mapping.valueColumn];if(!value)throw Error('Missing native aggregate cell');const lexeme=value.raw.trim();let number:number|null;
  if(value.dateStyle||value.type==='date'||value.numberFormat?.percentStyle)throw Error('Native date/percentage format contradicts school-count unit');
  if(/^[0-9]+$/.test(lexeme))number=Number(lexeme);else if(/^[-–.•…x/]$/.test(lexeme))number=null;else throw Error('Changed statistical numeric/suppression code');
  if(number!==null&&!Number.isSafeInteger(number))throw Error('Unsafe aggregate count');
  const id=`${mapping.sheet}:${mapping.district}:${period}:all:${mapping.predicate}`;
  out.push(make(s,scope,id,'StatisticalObservation',`administrative-area:KR:${mapping.district}`,mapping.predicate,number,[field(table,title),field(table,header),field(table,row[mapping.geographyColumn]),field(table,value),...(scopeCell?[field(table,scopeCell)]:[])],{unit:mapping.unit,date:period,district:mapping.district,limitations:['Native district-label join, not a municipality value. Evidenced total/public-private section; school definitions differ across states.',`Raw statistical cell ${JSON.stringify(lexeme)} retained; suppressed/missing/not-applicable symbols are not zero. Numeric 0 may be rounded per source legend.`]}));
 }
 if(!matched)throw Error('Unrecognized original school report workbook; schema mapping requires review');
 return {observations:out,coverage:coverage(s,scope,out.length?'partial':'empty',out.length?'Mapped district school/enrolment totals only; other report tables deliberately not credited as covered':'Mapped native sheets contain no matching district row; no municipality absence inferred',out.length)};
}
export function createEducationAdapter(options: EducationOptions={}): StructuredAdapter {
 const size=options.pageSize??20;if(!Number.isInteger(size)||size<1||size>100)throw Error('Invalid bounded discovery page size');
 return {id:'education',version:EDUCATION_VERSION,
 discover(s,scope,cursor){try{const held=gate(s,scope,options);if(held)return {resources:[],coverage:held};if(scope.sourceId==='kita-regional-statistics'){const result=kitaStatistics.discover(s,scope,cursor);return {...result,coverage:{...result.coverage,limitations:[...result.coverage.limitations,...LIMITATIONS]}};}
  const $=html(s),resources:ResourceReference[]=[];
  if(scope.sourceId==='kita-ruedersdorf'){
   $('.component-organisations [data-integration-result-page]').each((_,el)=>{const href=$(el).attr('data-integration-result-page')!;resources.push(resource(href,s,new URL(href,s.url).pathname));});
   $('a.sd-organisation--name-link').each((_,el)=>{const href=$(el).attr('href');if(href)resources.push(resource(href,s,new URL(href,s.url).pathname));});
  } else if(scope.sourceId==='kita-hoppegarten'){
   $('#content .template-page-effect a[href]').each((_,el)=>{const href=$(el).attr('href')!,url=new URL(href,s.url);if(url.pathname==='/verzeichnis/visitenkarte.php'&&url.searchParams.has('mandat'))resources.push(resource(href,s,`mandat:${url.searchParams.get('mandat')}`));else if(/Kindereinrichtungenflyer.*\.pdf$/i.test(url.pathname))resources.push(resource(href,s,url.pathname,'pdf'));});
  } else {
   const anchors=scope.sourceId==='school-stats-sh'?$('#c4631').find('a[href]'):scope.sourceId==='school-stats-mv'?$('#page').find('a[href]'):$.root().find('a[href]');
   anchors.each((_,el)=>{const href=$(el).attr('href')!,url=new URL(href,s.url),path=decodeURIComponent(url.pathname);if(/Schulverzeichnis|SVExportEINR|Verzeichn/i.test(path))return;
    if(/\.xlsx$/i.test(path)&& (scope.sourceId!=='school-stats-mv'||/B1131 /.test(path)))resources.push(resource(href,s,path,'xlsx'));
    else if(scope.sourceId==='school-stats-bb'&&/^\/b-i-\d+-j\/?$/.test(path))resources.push(resource(href,s,path));
    else if(scope.sourceId==='school-stats-sh'&&path.includes('/product/4631/'))resources.push(resource(href,s,path));
   });
   if(scope.sourceId==='school-stats-mv'&&$('[data-gaia-app="schulstandorteallg"]').length)resources.push(resource('https://www.laiv-mv.de/Statistik/Ver%C3%B6ffentlichungen/Statistische-Berichte/B',s,'observed-school-report-index'));
  }
  return page(resources,s,scope,cursor,size);
 }catch{return {resources:[],coverage:coverage(s,scope,'held_quality','Invalid byte binding, scope, original schema or cursor')};}},
 parse(s,scope){try{const held=gate(s,scope,options);if(held)return {observations:[],coverage:held};if(scope.sourceId==='kita-regional-statistics'){const result=kitaStatistics.parse(s,scope);return {...result,coverage:{...result.coverage,limitations:[...result.coverage.limitations,...LIMITATIONS]}};}
  if(/html/i.test(s.mimeType)){
   const $=html(s),visible=$('main,#content,#page').text()||$('body').text();
   if(/Dieses (?:Verzeichnis|Dokument) wurde zurückgezogen\./.test(visible))return {observations:[],coverage:coverage(s,scope,'not_checked','Publisher explicitly withdrew this resource; retain earlier evidence for reconciliation, do not infer facility closure')};
   if(scope.sourceId==='kita-hoppegarten')return hoppegarten(s,scope);if(scope.sourceId==='kita-ruedersdorf')return ruedersdorf(s,scope);
   return {observations:[],coverage:coverage(s,scope,'not_checked','Statistical landing links are not measured school cells; acquire native workbook via shared policy')};
  }
  if(scope.sourceId.startsWith('school-stats-') && s.bytes[0]===0x50&&s.bytes[1]===0x4b)return school(s,scope);
  return {observations:[],coverage:coverage(s,scope,'held_quality','No admitted native-format mapping; PDF requires the isolated document/evidence lane, never normalized JSON inputs')};
 }catch{return {observations:[],coverage:coverage(s,scope,'held_quality','Invalid byte binding, scope or changed native education schema')};}}
 };
}
export const educationAdapter=createEducationAdapter();
