import {load} from 'cheerio';
import type {CheerioAPI} from 'cheerio';
import type {AnyNode} from 'domhandler';
import {XMLValidator} from 'fast-xml-parser';
import {assertSnapshot, canonicalJson, digest, HashSchema, observation, ScopeSchema, semanticHash, StructuredLocatorSchema} from '../district-adapter-contract.ts';
import type {AdmittedSnapshot, AdapterCoverage, AdapterScope, DiscoveryResult, ParseResult, ResourceReference, StructuredAdapter, StructuredLocator, StructuredObservation} from '../district-adapter-contract.ts';

export const PLANNING_WFS_VERSION = 'planning-wfs-native-v1';
/** MV participation is routed by the acquisition registry to existing crawlMvPlanningApi, outside the parser sandbox. */
export const PLANNING_WFS_SOURCES = {
 'sh-plan-xplan-wfs': {endpoint:'https://service.gdi-sh.de/WFS_SH_PLANUNG', namespace:'http://www.deegree.org/xplanung/1/0', types:['BP_Plan','FP_Plan','LP_Plan','RP_Plan','SO_Plan'], agsPrefix:'01', incomplete:false},
 'mv-lup-bplan-wfs': {endpoint:'https://geoportal.kreis-lup.de/ows/gdimrh/bebauungsplaene-lup', namespace:'http://mapserver.gis.umn.edu/mapserver', types:['Bauleitplaene'], agsPrefix:'13076', incomplete:true},
} as const;
type PlanningSourceId = keyof typeof PLANNING_WFS_SOURCES;
export interface PlanningFeatureSchema {sourceId:PlanningSourceId; sourceSha256:string; namespace:string; featureType:string; fields:Record<string,string>}
export interface PlanningExtent {ags:string; bbox:[number,number,number,number]; crs:'EPSG:25832'; evidenceSha256:string}
export interface PlanningFeatureJoin {sourceId:PlanningSourceId; sourceSha256:string; nativeId:string; ags:string; evidence:StructuredLocator}
export interface PlanningWfsOptions {schemas?:PlanningFeatureSchema[]; extents?:PlanningExtent[]; joins?:PlanningFeatureJoin[]; pageSize?:number}
const LIMITATIONS = ['No feature population has been collected or municipality completeness established.', 'A spatial search envelope is not a verified municipality assignment.', 'GML outlines are not original full XPlan packages; geometry is retained in its explicit native CRS.', 'Linked documents require separate origin/rights admission.', 'Plan status/dates do not prove a permit, construction, operator, expenditure or measured outcome.', 'Serialized amendment strings remain attributed references, not automatic cross-plan identity merges.'];

export function planningXmlLocalName(name:string):string {return name.split(':').at(-1)!;}
/** No DTD/entity expansion, external schema loading, network, subprocesses or CRS guessing. */
export function readPlanningXml(snapshot:AdmittedSnapshot):CheerioAPI {
 assertSnapshot(snapshot);
 if(snapshot.bytes.byteLength>4*1024*1024)throw Error('Planning XML byte limit');
 const text=new TextDecoder('utf-8',{fatal:true}).decode(snapshot.bytes);
 if(/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('Planning XML DTD/entities prohibited');
 let depth=0,tags=0;
 for(const token of text.matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>/g)){
  const tag=token[0];if(tag.startsWith('<!')||tag.startsWith('<?'))continue;
  if(++tags>100000)throw Error('Planning XML element limit');
  if(tag.startsWith('</'))depth--;else if(!tag.endsWith('/>'))depth++;
  if(depth>64)throw Error('Planning XML depth limit');
 }
 if(XMLValidator.validate(text)!==true)throw Error('Malformed planning XML');
 return load(text,{xml:true});
}
function elements($:CheerioAPI,name:string){return $('*').filter((_i,node)=>planningXmlLocalName(node.name)===name);}
function namespace($:CheerioAPI,node:AnyNode,prefix:string):string|null {
 let current=$(node);
 while(current.length){const uri=current.attr(prefix?'xmlns:'+prefix:'xmlns');if(uri)return uri;current=current.parent();}
 return null;
}
function sourceFor(scope:AdapterScope){ScopeSchema.parse(scope);return PLANNING_WFS_SOURCES[scope.sourceId as PlanningSourceId];}
function coverage(scope:AdapterScope,snapshot:AdmittedSnapshot,state:AdapterCoverage['state'],reason:string,rows=0,nextCursor:string|null=null):AdapterCoverage {
 return {state,scope:canonicalJson(scope),reason,checkedAt:snapshot.retrievedAt,nextCursor,observedRows:rows,limitations:[...LIMITATIONS,...(scope.sourceId==='mv-lup-bplan-wfs'?['Publisher inventory explicitly incomplete; daily synchronization does not establish full coverage.']:[])]};
}
function baseUrl(raw:string,endpoint:string):URL {
 const url=new URL(raw);const expected=new URL(endpoint);
 if(url.origin!==expected.origin||url.pathname!==expected.pathname||url.username||url.password)throw Error('Planning service URL/source binding mismatch');
 return url;
}
function request(endpoint:string,operation:string,params:Record<string,string>):string {
 const url=new URL(endpoint);url.searchParams.set('service','WFS');url.searchParams.set('version','2.0.0');url.searchParams.set('request',operation);
 for(const [key,value] of Object.entries(params))url.searchParams.set(key,value);
 return url.href;
}
function parameter(url:URL,name:string):string|null {return [...url.searchParams].find(([key])=>key.toLowerCase()===name.toLowerCase())?.[1]??null;}
function queryScopeIdentity(url:URL):string {
 const values:Record<string,string>={},seen=new Set<string>();
 for(const [original,value] of url.searchParams){
  const key=original.toLowerCase();
  if(seen.has(key))throw Error('Ambiguous repeated WFS selector');seen.add(key);
  if(key!=='startindex')values[key]=key==='request'||key==='service'?value.toLowerCase():value;
 }
 return canonicalJson(values);
}
function normalizeCrs(value:string):string|null {
 const match=/^(?:EPSG:|urn:ogc:def:crs:EPSG::|https?:\/\/www\.opengis\.net\/def\/crs\/EPSG\/0\/)(25832|25833|4326)$/.exec(value);
 return match?'EPSG:'+match[1]:null;
}
function day(value:string):string|null {
 let normalized=value;
 const german=/^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
 if(german)normalized=`${german[3]}-${german[2]}-${german[1]}`;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(normalized))return null;
 const date=new Date(normalized+'T00:00:00Z');
 return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===normalized?normalized:null;
}
/** Extract only inline native XSD definitions; imports/includes are not fetched. */
export function planningFeatureSchemas(snapshot:AdmittedSnapshot,sourceId:PlanningSourceId):PlanningFeatureSchema[] {
 const $=readPlanningXml(snapshot),source=PLANNING_WFS_SOURCES[sourceId];baseUrl(snapshot.url,source.endpoint);
 const root=$.root().children().first();
 if(planningXmlLocalName(root[0]?.name??'')!=='schema'||root.attr('targetNamespace')!==source.namespace)throw Error('Unexpected planning XSD namespace');
 return source.types.map(featureType=>{
  const declaration=root.children().filter((_i,node)=>planningXmlLocalName(node.name)==='element'&&$(node).attr('name')===featureType).first();
  if(!declaration.length)throw Error('Planning XSD feature declaration missing: '+featureType);
  let definition=declaration;
  const namedType=declaration.attr('type');
  if(namedType)definition=root.children().filter((_i,node)=>planningXmlLocalName(node.name)==='complexType'&&$(node).attr('name')===planningXmlLocalName(namedType)).first();
  const fields:Record<string,string>={};
  definition.find('*').filter((_i,node)=>planningXmlLocalName(node.name)==='element').each((_i,node)=>{
   const name=$(node).attr('name'),type=$(node).attr('type');
   if(!name||!type||fields[name])throw Error('Unsupported planning field declaration');fields[name]=type;
  });
  const geometry=featureType==='Bauleitplaene'?'msGeometry':'raeumlicherGeltungsbereich';
  if(!fields[geometry])throw Error('Planning schema geometry field missing');
  return {sourceId,sourceSha256:snapshot.sourceSha256,namespace:source.namespace,featureType,fields};
 });
}
const DATE_ROLES:Record<string,string>={Inkrafttretensdatum:'legal_effective',inkrafttretensDatum:'legal_effective',inkrafttretenDatum:'legal_effective',datumDesInkrafttretens:'legal_effective',wirksamkeitsDatum:'legal_effective',genehmigungsDatum:'plan_approval',satzungsbeschlussDatum:'plan_adoption_resolution',planbeschlussDatum:'plan_resolution',aufstellungsbeschlussDatum:'procedure_initiation_resolution',ausfertigungsDatum:'execution',untergangsDatum:'legal_end',gueltigkeitBeginn:'source_valid_from',gueltigkeitEnde:'source_valid_to',veroeffentlichungsDatum:'publication',technHerstellDatum:'technical_preparation',auslegungsStartDatum:'consultation_start',auslegungsEndDatum:'consultation_end',auslegungStartDatum:'consultation_start',auslegungEndDatum:'consultation_end',traegerbeteiligungsStartDatum:'authority_consultation_start',traegerbeteiligungsEndDatum:'authority_consultation_end',aenderungenBisDatum:'amendments_as_of'};
const AMENDMENT_FIELDS:Record<string,true>={aendert:true,aendertPlan:true,aendertPlanBereich:true,wurdeGeaendertVon:true,wurdeGeaendertVonPlan:true,wurdeGeaendertVonPlanBereich:true};
const DOCUMENT_FIELDS:Record<string,true>={refBeschreibung:true,refBegruendung:true,refRechtsplan:true,refUmweltbericht:true,refSatzung:true,refPlangrundlage:true,refLegende:true,externeReferenz:true,URL_1:true,URL_2:true,URL_3:true,URL_4:true,URL_5:true};

export function createPlanningWfsAdapter(options:PlanningWfsOptions={}):StructuredAdapter {
 // Copy/freeze configuration identity, so subsequent caller mutation cannot change replay semantics.
 const config=JSON.parse(canonicalJson({...options,pageSize:options.pageSize??100})) as Required<Pick<PlanningWfsOptions,'pageSize'>>&PlanningWfsOptions;
 if(!Number.isInteger(config.pageSize)||config.pageSize<1||config.pageSize>1000)throw Error('Planning page size must be 1..1000');
 for(const schema of config.schemas??[]){HashSchema.parse(schema.sourceSha256);if(schema.namespace!==PLANNING_WFS_SOURCES[schema.sourceId]?.namespace||!Object.keys(schema.fields).length)throw Error('Invalid native schema configuration');}
 for(const extent of config.extents??[]){HashSchema.parse(extent.evidenceSha256);if(!/^\d{8}$/.test(extent.ags)||extent.crs!=='EPSG:25832'||extent.bbox.length!==4||!extent.bbox.every(Number.isFinite)||extent.bbox[0]>=extent.bbox[2]||extent.bbox[1]>=extent.bbox[3])throw Error('Invalid verified municipality envelope');}
 for(const join of config.joins??[]){HashSchema.parse(join.sourceSha256);StructuredLocatorSchema.parse(join.evidence);if(!/^\d{8}$/.test(join.ags)||!join.nativeId||!PLANNING_WFS_SOURCES[join.sourceId])throw Error('Invalid verified planning feature join');}
 const configurationKeys=new Set<string>();
 function registerConfiguration(key:string){if(configurationKeys.has(key))throw Error('Duplicate or contradictory planning configuration');configurationKeys.add(key);}
 for(const item of config.schemas??[])registerConfiguration(canonicalJson(['schema',item.sourceId,item.featureType]));
 for(const item of config.extents??[])registerConfiguration(canonicalJson(['extent',item.ags]));
 for(const item of config.joins??[])registerConfiguration(canonicalJson(['join',item.sourceId,item.sourceSha256,item.nativeId]));
 const mappingVersion=PLANNING_WFS_VERSION+':'+semanticHash(config);
 function parse(snapshot:AdmittedSnapshot,scope:AdapterScope):ParseResult {
  const source=sourceFor(scope);
  if(!source)return {observations:[],coverage:coverage(scope,snapshot,scope.sourceId.startsWith('hoppegarten-')?'held_origin':'not_applicable','Source rights unresolved or outside licensed SH/LUP WFS contract')};
  if(!scope.ags.startsWith(source.agsPrefix))return {observations:[],coverage:coverage(scope,snapshot,'not_applicable','Municipality outside publisher geographic scope')};
  try {
   const $=readPlanningXml(snapshot);baseUrl(snapshot.url,source.endpoint);
   const exception=elements($,'ExceptionReport').length||elements($,'ServiceExceptionReport').length;
   if(exception){const code=elements($,'Exception').first().attr('exceptionCode')??'';return {observations:[],coverage:coverage(scope,snapshot,/AccessDenied|NotAuthorized/i.test(code)?'blocked_access':'held_quality','Publisher exception: '+code)};}
   const collection=$.root().children().first();
   if(planningXmlLocalName(collection[0]?.name??'')!=='FeatureCollection')return {observations:[],coverage:coverage(scope,snapshot,'not_checked','Snapshot is metadata, not a feature population')};
   const collectionTag=collection[0].name;
   if(namespace($,collection[0],collectionTag.includes(':')?collectionTag.split(':')[0]:'')!=='http://www.opengis.net/wfs/2.0')throw Error('Unexpected WFS feature collection namespace');
   const members=collection.children().filter((_i,node)=>['member','featureMember'].includes(planningXmlLocalName(node.name)));
   if(members.length>config.pageSize)throw Error('Planning page feature limit');
   const returned=collection.attr('numberReturned');if(returned!==undefined&&(!/^\d+$/.test(returned)||Number(returned)!==members.length))throw Error('WFS numberReturned mismatch');
   const observations:StructuredObservation[]=[];let unjoined=0,outOfScope=0;const seen=new Set<string>();
   members.each((_i,member)=>{
    const feature=$(member).children();if(feature.length!==1)throw Error('Unexpected WFS member');
    const featureTag=feature[0].name,featureType=planningXmlLocalName(featureTag);
    if(!source.types.some(type=>type===featureType)||namespace($,feature[0],featureTag.includes(':')?featureTag.split(':')[0]:'')!==source.namespace)throw Error('Unexpected native planning feature/namespace');
    const schema=config.schemas?.find(item=>item.sourceId===scope.sourceId&&item.featureType===featureType);
    if(!schema)throw Error('Admitted native feature schema required before parsing');
    const nativeId=feature.attr('gml:id');
    if(!nativeId||namespace($,feature[0],'gml')!=='http://www.opengis.net/gml/3.2'||seen.has(nativeId))throw Error('Missing/duplicate native GML identity');seen.add(nativeId);
    const children=feature.children(),fieldNames=new Set<string>();
    children.each((_n,node)=>{
     const field=planningXmlLocalName(node.name),uri=namespace($,node,node.name.includes(':')?node.name.split(':')[0]:'');
     if(field==='boundedBy'&&uri==='http://www.opengis.net/gml/3.2')return;
     if(uri!==source.namespace||!Object.hasOwn(schema.fields,field)||fieldNames.has(field))throw Error('Native feature schema changed: '+node.name);
     fieldNames.add(field);
    });
    const join=config.joins?.find(item=>item.sourceId===scope.sourceId&&item.sourceSha256===snapshot.sourceSha256&&item.nativeId===nativeId);
    if(!join){unjoined++;return;}
    if(join.ags!==scope.ags){outOfScope++;return;}
    const schemaHash=semanticHash(schema),subject=canonicalJson([scope.publisherId,scope.sourceId,nativeId]);
    const geometryName=featureType==='Bauleitplaene'?'msGeometry':'raeumlicherGeltungsbereich';
    if(!children.filter((_n,node)=>planningXmlLocalName(node.name)===geometryName).length)throw Error('Native geometry missing');
    children.each((_n,node)=>{
     const field=planningXmlLocalName(node.name),cell=$(node);if(field==='boundedBy')return;
     if(cell.attr('xsi:nil')==='true'||cell.attr('xsi:nil')==='1')return;
     const geometry=field===geometryName;
     if(!geometry&&cell.children().length)throw Error('Unexpected complex native scalar: '+field);
     const raw=geometry?$.xml(node):cell.text();if(!raw.trim())return;
     if(raw.length>1000000)throw Error('Native field output limit');
     let value:string|boolean=raw,date:string|null=null,dateRole:string|null=null,unit:string|null=null,predicate='native_field:'+field;
     if(geometry){
      const geometric=cell.children().first();const crs=normalizeCrs(geometric.attr('srsName')??collection.attr('srsName')??'');
      if(!crs)throw Error('Geometry lacks supported explicit CRS');
      const geometryTag=geometric[0]?.name??'';
      if(!geometryTag||namespace($,geometric[0],geometryTag.includes(':')?geometryTag.split(':')[0]:'')!=='http://www.opengis.net/gml/3.2')throw Error('Unexpected geometry namespace');
      // Coordinates and axis order are not swapped or transformed. Keep holes/multisurfaces intact.
      if(!['Polygon','MultiSurface','MultiPolygon','Surface','Point','LineString','MultiCurve'].includes(planningXmlLocalName(geometric[0]?.name??'')))throw Error('Unsupported native geometry');
      const positions=cell.find('*').filter((_j,position)=>['pos','posList'].includes(planningXmlLocalName(position.name)));
      if(!positions.length)throw Error('Native geometry has no supported coordinate encoding');
      positions.each((_j,position)=>{
       if(namespace($,position,position.name.includes(':')?position.name.split(':')[0]:'')!=='http://www.opengis.net/gml/3.2')throw Error('Unexpected geometry coordinate namespace');
       const dimension=Number($(position).attr('srsDimension')??geometric.attr('srsDimension')??'2'),coordinates=$(position).text().trim().split(/\s+/);
       if(![2,3].includes(dimension)||coordinates.length%dimension||coordinates.some(coordinate=>!coordinate||!Number.isFinite(Number(coordinate))))throw Error('Invalid native geometry coordinates/dimension');
      });
      predicate='covers_native_geometry';unit=crs==='EPSG:4326'?'degree':'m';
     } else if(DATE_ROLES[field]){
      dateRole=DATE_ROLES[field];date=day(raw.trim());
      if(!date&&['gueltigkeitBeginn','gueltigkeitEnde'].includes(field)&&/^\d{4}-\d{2}-\d{2}T/.test(raw.trim())&&Number.isFinite(Date.parse(raw.trim())))date=day(raw.trim().slice(0,10));
      if(!date)throw Error('Invalid native calendar date: '+field);value=date;predicate='dated_plan_event';
     } else if(AMENDMENT_FIELDS[field])predicate=field.startsWith('wurde')?'amended_by_reference':'amendment_reference';
     else if(DOCUMENT_FIELDS[field])predicate='document_reference';
     else if(['name','Name','xpPlanName'].includes(field))predicate='plan_name';
     else if(field==='nummer')predicate='plan_number';
     else if(['rechtsstand','rechtsstandWert','Rechtsstand'].includes(field))predicate='native_legal_status';
     if(!geometry&&planningXmlLocalName(schema.fields[field])==='boolean'){
      if(!['true','false','1','0'].includes(raw.trim()))throw Error('Invalid native boolean: '+field);
      value=raw.trim()==='true'||raw.trim()==='1';
     }
     const locator:StructuredLocator={sourceSha256:snapshot.sourceSha256,format:'xml',nativeId,path:`/FeatureCollection/member/${featureTag}[@gml:id=${JSON.stringify(nativeId)}]/${node.name}`,sheet:null,rowKey:null,cells:[],rawValue:raw,schemaHash,mappingVersion};
     observations.push(observation({publisherId:scope.publisherId,sourceId:scope.sourceId,nativeId,nativeVersion:snapshot.sourceVersion,kind:geometry?'PlanGeometry':AMENDMENT_FIELDS[field]?'PlanAmendmentReference':'SpatialPlan',subject,predicate,value,unit,date,dateRole,financialRole:'none',geography:{ags:join.ags,basis:'verified_join',role:'project_location'},sourceReferenceDate:dateRole==='amendments_as_of'?date:null,publishedAt:dateRole==='publication'?date:null,retrievedAt:snapshot.retrievedAt,evidence:[locator],supportingEvidence:[{role:'municipality_join',locator:join.evidence}],limitations:[...LIMITATIONS,...(field==='xpVersion'?['xpVersion is the XPlan schema version, not a legal amendment/version.']:[])]}));
    });
   });
   const next=collection.attr('next')??null,matched=collection.attr('numberMatched');
   if(next){
    const url=baseUrl(new URL(next,snapshot.url).href,source.endpoint),current=baseUrl(snapshot.url,source.endpoint);
    if(queryScopeIdentity(url)!==queryScopeIdentity(current))throw Error('WFS next link changed geographic/query scope');
    const offset=parameter(url,'startIndex'),prior=parameter(current,'startIndex')??'0';
    if(parameter(url,'request')?.toLowerCase()!=='getfeature'||parameter(url,'service')?.toLowerCase()!=='wfs'||!offset||!/^\d+$/.test(offset)||!Number.isSafeInteger(Number(offset))||Number(offset)<=Number(prior))throw Error('WFS next cursor does not advance within query scope');
   }
   if(!members.length&&matched!==undefined&&matched!=='0'&&matched!=='unknown')throw Error('Incomplete empty feature page');
   const state=unjoined?'held_quality':members.length?'partial':next?'partial':'empty';
   const resultCoverage=coverage(scope,snapshot,state,unjoined?`${unjoined} features lack snapshot-bound verified municipality joins`:'Only this admitted feature page was interpreted; no inventory completeness or deletion inference',members.length,next);
   if(outOfScope)resultCoverage.limitations.push(`${outOfScope} features with verified joins to other municipalities were omitted from this scope.`);
   return {observations,coverage:resultCoverage};
  } catch(error){return {observations:[],coverage:coverage(scope,snapshot,'held_quality',error instanceof Error?error.message:'Native planning parse failed')};}
 }
 function discover(snapshot:AdmittedSnapshot,scope:AdapterScope,cursor:string|null):DiscoveryResult {
  const source=sourceFor(scope);
  if(!source)return {resources:[],coverage:coverage(scope,snapshot,scope.sourceId.startsWith('hoppegarten-')?'held_origin':'not_applicable','No rights-admitted source in licensed SH/LUP contract; use existing MV route separately')};
  if(!scope.ags.startsWith(source.agsPrefix))return {resources:[],coverage:coverage(scope,snapshot,'not_applicable','Municipality outside publisher scope')};
  try {
   const $=readPlanningXml(snapshot);baseUrl(snapshot.url,source.endpoint);
   if(elements($,'ExceptionReport').length||elements($,'ServiceExceptionReport').length){const code=elements($,'Exception').first().attr('exceptionCode')??'';return {resources:[],coverage:coverage(scope,snapshot,/AccessDenied|NotAuthorized/i.test(code)?'blocked_access':'held_quality','Publisher exception: '+code)};}
   if(elements($,'WFS_Capabilities').length){
    if(cursor)throw Error('Capability snapshot does not accept a feature cursor');
    const root=elements($,'WFS_Capabilities').first();if(root.attr('version')!=='2.0.0')throw Error('Only WFS 2.0 discovery is admitted');
    const licence=elements($,'Fees').text()+' '+elements($,'AccessConstraints').text();
    if(!/dl-by-de\/2\.0|Datenlizenz Deutschland[\s\S]*Namensnennung[\s\S]*2\.0/i.test(licence))return {resources:[],coverage:coverage(scope,snapshot,'held_origin','Named distribution licence no longer evidenced in capabilities')};
    const resources:ResourceReference[]=[];
    elements($,'FeatureType').each((_i,node)=>{
     const type=$(node),name=type.children().filter((_j,child)=>planningXmlLocalName(child.name)==='Name').text().trim();
     if(!source.types.some(item=>item===planningXmlLocalName(name)))return;
     const nameNode=type.children().filter((_j,child)=>planningXmlLocalName(child.name)==='Name')[0];
     if(namespace($,nameNode,name.includes(':')?name.split(':')[0]:'')!==source.namespace)throw Error('Capability type namespace changed');
     const crs=type.children().filter((_j,child)=>['DefaultCRS','OtherCRS'].includes(planningXmlLocalName(child.name))).toArray().map(child=>normalizeCrs($(child).text().trim()));
     if(!crs.includes('EPSG:25832'))throw Error('Publisher removed supported projected CRS');
     resources.push({url:request(source.endpoint,'DescribeFeatureType',{typeNames:name}),nativeId:name,parentId:scope.sourceId,method:'GET',body:null,format:'xml'});
     const extent=config.extents?.find(item=>item.ags===scope.ags);
     if(extent)resources.push({url:request(source.endpoint,'GetFeature',{typeNames:name,srsName:extent.crs,bbox:[...extent.bbox,extent.crs].join(','),count:String(config.pageSize),startIndex:'0',outputFormat:'application/gml+xml; version=3.2'}),nativeId:name,parentId:scope.sourceId,method:'GET',body:null,format:'xml'});
    });
    const reason=resources.length?'Advertised native types discovered; operations not exercised; feature requests require verified envelope':'Expected feature types absent; publisher schema/capabilities changed';
    return {resources,coverage:coverage(scope,snapshot,resources.length?'partial':'held_quality',reason)};
   }
   const parsed=parse(snapshot,scope),resources:ResourceReference[]=[];
   if(['held_quality','blocked_access','held_origin'].includes(parsed.coverage.state))return {resources,coverage:parsed.coverage};
   const collection=elements($,'FeatureCollection').first(),next=collection.attr('next')??null;
   if(cursor&&cursor!==next)throw Error('Cursor does not match admitted publisher next link');
   if(next){
    const url=new URL(next,snapshot.url),offset=parameter(url,'startIndex')!;
    resources.push({url:url.href,nativeId:'page:'+offset,parentId:scope.sourceId,method:'GET',body:null,format:'xml'});
   }
   for(const item of parsed.observations.filter(item=>item.predicate==='document_reference')){
    if(typeof item.value!=='string'||!/^https?:\/\/[^\s]+$/.test(item.value))continue;
    const url=new URL(item.value);if(url.username||url.password)throw Error('Document reference contains credentials');
    if(!resources.some(resource=>resource.url===url.href))resources.push({url:url.href,nativeId:item.nativeId+':document:'+digest(url.href),parentId:item.nativeId,method:'GET',body:null,format:'source-linked-document'});
   }
   return {resources,coverage:{...parsed.coverage,nextCursor:next}};
  }catch(error){return {resources:[],coverage:coverage(scope,snapshot,'held_quality',error instanceof Error?error.message:'Native planning discovery failed')};}
 }
 return {id:'planning-wfs',version:mappingVersion,discover,parse};
}
export const planningWfsAdapter=createPlanningWfsAdapter();
