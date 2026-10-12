import {readPlanningXml, planningXmlLocalName} from './planning-wfs.ts';
import {assertSnapshot, observation, semanticHash, ScopeSchema, type AdmittedSnapshot, type AdapterScope, type AdapterCoverage, type StructuredAdapter, type StructuredObservation, type ResourceReference} from '../district-adapter-contract.ts';

export const ENERGY_ATLAS_VERSION = 'energy-atlas-native-v1';
const pilots:Record<string,true> = {'12064472':true,'12064227':true,'12064428':true,'01053100':true,'01053090':true,'01053116':true,'13076090':true,'13076108':true,'13076060':true};
const prefixes: Record<string,string> = {'bb-heat-wfs':'12','bb-energy-wfs':'12','mv-energy-atlas':'13','sh-heat-atlas':'01'};
const limitations = ['Context only: no heat-plan adoption, zoning, connection promise, operator identity or measured project impact.', 'Missing features on partial pages are not withdrawals.'];
export interface AtlasFieldMapping {field:string; kind:'HeatDemandObservation'|'HeatPotential'|'GenerationAsset'|'AtlasContext'; predicate:string; unit:string|null; unitField?:string}
/** Only a reviewed layer schema and layer-specific origin receipt may enable parsing. */
export interface AtlasLayerContract {
 sourceId:'bb-heat-wfs'|'bb-energy-wfs'|'mv-energy-atlas'; nativeLayerId:string;
 propertySchema: Record<string,'string'|'number'|'boolean'|'null'>;
 fields:AtlasFieldMapping[]; agsField:string|null; nativeIdField?:string;
 referenceDate:string|null; method:string|null; granularity:string; crs:'EPSG:4326';
 license:{state:'unknown'|'admitted'|'excluded'; label:string|null; receiptSha256:string|null};
}
type ObjectValue = Record<string,unknown>;
function object(value:unknown):ObjectValue {if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected native object'); return value as ObjectValue;}
function text(snapshot:AdmittedSnapshot):string {assertSnapshot(snapshot);if(snapshot.bytes.length>8_000_000)throw Error('Snapshot exceeds 8 MB');return new TextDecoder('utf-8',{fatal:true}).decode(snapshot.bytes);}
function coverage(snapshot:AdmittedSnapshot,scope:AdapterScope,state:AdapterCoverage['state'],reason:string,rows=0,nextCursor:string|null=null):AdapterCoverage {return {state,reason,scope:`${scope.sourceId}:${scope.ags}`,checkedAt:snapshot.retrievedAt,nextCursor,observedRows:rows,limitations};}
function scopeCheck(scope:AdapterScope):void {ScopeSchema.parse(scope);if(!pilots[scope.ags])throw Error('Outside nine-pilot scope');if(!prefixes[scope.sourceId])throw Error('Unknown atlas source');}
function disposition(snapshot:AdmittedSnapshot,scope:AdapterScope):AdapterCoverage|null {
 if(!scope.ags.startsWith(prefixes[scope.sourceId]!))return coverage(snapshot,scope,'not_applicable','State atlas does not cover this pilot');
 const url=new URL(snapshot.url);
 if(scope.sourceId==='sh-heat-atlas')return coverage(snapshot,scope,'not_checked','SH viewer only; no observed structured API or download');
 if(!['http:','https:'].includes(url.protocol))throw Error('Invalid source URL');
 return null;
}
function geometry(value:unknown,depth=0):void {
 if(depth>12)throw Error('Geometry nesting limit');
 const g=object(value);
 if(g.type==='GeometryCollection'){if(!Array.isArray(g.geometries))throw Error('Invalid geometry collection');for(const child of g.geometries)geometry(child,depth+1);return;}
 const dimensions:Record<string,number>={Point:0,MultiPoint:1,LineString:1,MultiLineString:2,Polygon:2,MultiPolygon:3};
 if(typeof g.type!=='string'||!(g.type in dimensions))throw Error('Unknown geometry type');
 const positions=(v:unknown,d:number):void=>{if(!Array.isArray(v)||v.length===0)throw Error('Invalid coordinates');if(d){for(const child of v)positions(child,d-1);}else{if(v.length<2||v.length>3||!v.every(n=>typeof n==='number'&&Number.isFinite(n))||Math.abs(v[0] as number)>180||Math.abs(v[1] as number)>90)throw Error('Invalid EPSG:4326 position');}};
 positions(g.coordinates,dimensions[g.type]!);
}
function nativeSchema(properties:ObjectValue):Record<string,string> {return Object.fromEntries(Object.entries(properties).map(([key,value])=>{if(value!==null&&!['string','number','boolean'].includes(typeof value))throw Error('Non-scalar native property');if(typeof value==='number'&&!Number.isFinite(value))throw Error('Nonfinite property');return [key,value===null?'null':typeof value];}));}
function layerUrl(snapshot:AdmittedSnapshot):string|null {
 const url=new URL(snapshot.url);
 const query=url.searchParams.get('selected_layer_id')??url.searchParams.get('typeNames')??url.searchParams.get('typeName');
 if(snapshot.request?.method!=='POST')return query;
 if(snapshot.request.body===null)return query;
 if(snapshot.request.body.length>65536)throw Error('Atlas request selector exceeds bound');
 if(snapshot.request.contentType!==null&&!/^application\/x-www-form-urlencoded(?:;|$)/i.test(snapshot.request.contentType))throw Error('Unsupported atlas request selector encoding');
 const form=new URLSearchParams(snapshot.request.body);const values=form.getAll('selected_layer_id');
 if(values.length>1)throw Error('Ambiguous native layer selector');
 const selected=values[0]??null;
 if(selected!==null&&(!/^\d+$/.test(selected)||query!==null&&query!==selected))throw Error('Conflicting native layer selectors');
 return selected??query;
}
export function createEnergyAtlasAdapter(layers:readonly AtlasLayerContract[]=observedAtlasLayers):StructuredAdapter {
 const contracts=new Map(layers.map(layer=>[`${layer.sourceId}:${layer.nativeLayerId}`,layer]));
 return {id:'energy-atlas',version:ENERGY_ATLAS_VERSION,
 discover(snapshot,scope,cursor){
  try {scopeCheck(scope);const body=text(snapshot);const held=disposition(snapshot,scope);if(held)return {resources:[],coverage:held};
   if(cursor!==null&&!/^\d+$/.test(cursor))throw Error('Invalid bounded discovery cursor');
   if(scope.sourceId==='mv-energy-atlas') {
    const config=object(JSON.parse(body));if(!Array.isArray(config.overlays)||config.overlays.length>1000)throw Error('Native MV overlays missing or oversized');
    const candidates=config.overlays.map(object).filter(layer=>layer.type==='GeoJSON'&&['126','253'].includes(String(object(layer.params).selected_layer_id)));
    const start=Number(cursor??0);if(!Number.isSafeInteger(start)||start>candidates.length)throw Error('Cursor outside observed layers');
    const resources:ResourceReference[]=candidates.slice(start,start+1).map(layer=>{
     const params=object(layer.params);const url=new URL(String(layer.url));if(url.href!=='https://energieatlas-mv.de/fis/index.php'||params.export_format!=='GeoJSON'||params.epsg!==4326)throw Error('MV export configuration changed');
     if(!object(layer.layerAttributes)[String(layer.infoAttribute)])throw Error('MV native identity schema changed');
     return {url:url.href,nativeId:String(params.selected_layer_id),parentId:null,method:'POST',body:new URLSearchParams(Object.entries(params).map(([key,value]):[string,string]=>[key,String(value)])).toString(),format:'json'};
    });
    return {resources,coverage:coverage(snapshot,scope,resources.length?'partial':'empty','Native MV configured layers; export population and per-layer rights remain unverified',resources.length,start+1<candidates.length?String(start+1):null)};
   }
   return discoverWfs(snapshot,scope,body,cursor,contracts);
  } catch(error){return {resources:[],coverage:coverage(snapshot,scope,'held_quality',String(error))};}
 },
 parse(snapshot,scope){
  try {scopeCheck(scope);const body=text(snapshot);const held=disposition(snapshot,scope);if(held)return {observations:[],coverage:held};
   const id=layerUrl(snapshot);const contract=id?contracts.get(`${scope.sourceId}:${id}`):undefined;
   if(!contract)return {observations:[],coverage:coverage(snapshot,scope,'held_origin','No reviewed native layer schema and per-layer rights receipt')};
   if(contract.license.state==='excluded')return {observations:[],coverage:coverage(snapshot,scope,'blocked_policy','Layer explicitly excluded')};
   if(contract.license.state!=='admitted'||!contract.license.receiptSha256||!/^[a-f0-9]{64}$/.test(contract.license.receiptSha256))return {observations:[],coverage:coverage(snapshot,scope,'held_origin','Unknown layer license')};
   if(contract.license.receiptSha256!==snapshot.policyReceiptSha256)throw Error('Layer rights receipt mismatch');
   const root=object(JSON.parse(body));if(root.type!=='FeatureCollection'||!Array.isArray(root.features)||root.features.length>10000)throw Error('Expected bounded native GeoJSON FeatureCollection');
   if(root.crs!==undefined)throw Error('GeoJSON CRS extension requires separate reviewed mapping');
   const schemaHash=semanticHash(contract.propertySchema);const observations:StructuredObservation[]=[];const ids=new Set<string>();let scoped=0;
   for(let index=0;index<root.features.length;index++){
    const feature=object(root.features[index]);if(feature.type!=='Feature')throw Error('Expected native feature');
    const properties=object(feature.properties);nativeSchema(properties);
    const nativeKey=feature.id??(contract.nativeIdField?properties[contract.nativeIdField]:undefined);
    if(typeof nativeKey!=='string'&&typeof nativeKey!=='number'||typeof nativeKey==='number'&&!Number.isSafeInteger(nativeKey)||String(nativeKey)==='')throw Error('Native feature ID required');
    const nativeId=String(nativeKey);if(ids.has(nativeId))throw Error('Duplicate native feature ID');ids.add(nativeId);
    for(const [key,type] of Object.entries(contract.propertySchema)){if(!(key in properties)||properties[key]!==null&&typeof properties[key]!==type)throw Error('Native property schema changed');}
    if(feature.geometry!==null)geometry(feature.geometry);
    const ags=contract.agsField?properties[contract.agsField]:null;
    if(ags!==null&&(typeof ags!=='string'||!/^\d{8}$/.test(ags)))throw Error('AGS must be an eight-digit native string');
    if(ags!==null&&ags!==scope.ags)continue;scoped++;
    const locator=(path:string,rawValue:string|number|boolean|null)=>({sourceSha256:snapshot.sourceSha256,format:'json' as const,nativeId,path,sheet:null,rowKey:nativeId,cells:[],rawValue,schemaHash,mappingVersion:ENERGY_ATLAS_VERSION});
    const add=(predicate:string,kind:string,value:string|number|boolean|null,unit:string|null,path:string,rawValue:string|number|boolean|null)=>observations.push(observation({
     publisherId:scope.publisherId,sourceId:scope.sourceId,nativeId,nativeVersion:snapshot.sourceVersion,kind,subject:`${scope.publisherId}:${contract.nativeLayerId}:${nativeId}`,predicate,value,unit,date:contract.referenceDate,dateRole:contract.referenceDate?'source_reference':null,financialRole:'none',
     geography:{ags:typeof ags==='string'?ags:null,basis:ags===null?'unknown':'source_explicit',role:ags===null?'unknown':'administrative_area'},
     sourceReferenceDate:contract.referenceDate,publishedAt:null,retrievedAt:snapshot.retrievedAt,
     evidence:[locator(path,rawValue),...(typeof ags==='string'&&contract.agsField?[locator(`$.features[${index}].properties[${JSON.stringify(contract.agsField)}]`,ags)]:[]),locator(feature.id!==undefined?`$.features[${index}].id`:`$.features[${index}].properties[${JSON.stringify(contract.nativeIdField)}]`,nativeKey)],
     limitations:[...limitations,`Granularity: ${contract.granularity}`,`Method: ${contract.method??'unknown'}`,`Layer license: ${contract.license.label??'unspecified'}`,...(ags===null?['No municipality assignment; geometry is not an AGS join.']:[])]
    }));
    for(const field of contract.fields){
     if(!(field.field in properties))throw Error('Missing mapped field');
     if(/operat|adopt|resolution|connection|impact/i.test(field.predicate))throw Error('Unsupported atlas inference');
     const value=properties[field.field] as string|number|boolean|null;
     const rawUnit=field.unitField?properties[field.unitField]:field.unit;
     if(rawUnit!==null&&typeof rawUnit!=='string')throw Error('Native unit must be a string');
     add(field.predicate,field.kind,value,rawUnit as string|null,`$.features[${index}].properties[${JSON.stringify(field.field)}]`,value);
     if(field.unitField)add(`${field.predicate}_unit`,'AtlasContext',rawUnit as string|null,null,`$.features[${index}].properties[${JSON.stringify(field.unitField)}]`,rawUnit as string|null);
    }
    const rawGeometry=JSON.stringify(feature.geometry);add('geometry','AtlasContext',rawGeometry,null,`$.features[${index}].geometry`,rawGeometry);
   }
   const links=Array.isArray(root.links)?root.links:[];const next=links.map(object).find(link=>link.rel==='next');let nextCursor:string|null=null;
   if(next){if(typeof next.href!=='string')throw Error('Malformed next link');const url=new URL(next.href,snapshot.url);if(url.origin!==new URL(snapshot.url).origin)throw Error('Cross-origin next page');nextCursor=url.href;}
   return {observations,coverage:coverage(snapshot,scope,nextCursor?'partial':scoped?'partial':'empty',nextCursor?'Native next page remains':'Snapshot parsed; source-wide/town completeness unverified',scoped,nextCursor)};
  }catch(error){return {observations:[],coverage:coverage(snapshot,scope,'held_quality',String(error))};}
 }};
}

// Discovery advertises bounded resources; acquisition still needs its own policy decision.
function discoverWfs(snapshot:AdmittedSnapshot,scope:AdapterScope,_body:string,cursor:string|null,contracts:Map<string,AtlasLayerContract>):{resources:ResourceReference[];coverage:AdapterCoverage} {
 const $=readPlanningXml(snapshot);
 const root=$.root().children().first();const rootName=planningXmlLocalName(root[0]?.name??'');
 if(rootName==='schema'){
  const id=layerUrl(snapshot);const contract=id?contracts.get(`${scope.sourceId}:${id}`):undefined;
  if(!contract||!contract.agsField)throw Error('No mapped native feature schema');
  const fields:Record<string,string>={};$('*').each((_index,node)=>{if('name' in node&&planningXmlLocalName(node.name)==='element'){const name=$(node).attr('name');const type=$(node).attr('type');if(name&&type)fields[name]=type.split(':').pop()!;}});
  for(const [name,type] of Object.entries(contract.propertySchema)){if(!fields[name]||(type==='number'?!['decimal','double','float','int','integer'].includes(fields[name]!):fields[name]!==type))throw Error('DescribeFeatureType schema changed');}
  const url=new URL(snapshot.url);url.search='';const params={service:'WFS',version:'2.0.0',request:'GetFeature',typeNames:id!,outputFormat:'application/json',srsName:'EPSG:4326',count:'1000',startIndex:'0',CQL_FILTER:`${contract.agsField}='${scope.ags}'`};for(const [key,value] of Object.entries(params))url.searchParams.set(key,value);
  return {resources:[{url:url.href,nativeId:id!,parentId:id!,method:'GET',body:null,format:'json'}],coverage:coverage(snapshot,scope,'held_origin','Native schema inspected; proposed feature request remains subject to per-layer rights admission',0)};
 }
 if(rootName!=='WFS_Capabilities')throw Error('Expected native WFS capabilities or DescribeFeatureType');
 const version=root.attr('version');if(!version||!['2.0.0','1.1.0','1.0.0'].includes(version))throw Error('Unknown WFS version');
 const names:string[]=[];
 $('*').each((_index,node)=>{if('name' in node&&planningXmlLocalName(node.name)==='FeatureType'){$(node).children().each((_child,element)=>{if(planningXmlLocalName(element.name)==='Name')names.push($(element).text().trim());});}});
 if(names.length>1000||names.some(name=>!/^[\w.:-]+$/.test(name)))throw Error('Invalid feature type names');
 const start=Number(cursor??0);if(!Number.isSafeInteger(start)||start>names.length)throw Error('Invalid cursor');
 const resources=names.slice(start,start+20).map(name=>{const url=new URL(snapshot.url);url.search='';url.searchParams.set('service','WFS');url.searchParams.set('version',version);url.searchParams.set('request','DescribeFeatureType');url.searchParams.set(version==='2.0.0'?'typeNames':'typeName',name!);return {url:url.href,nativeId:name!,parentId:null,method:'GET' as const,body:null,format:'xml'};});
 return {resources,coverage:coverage(snapshot,scope,resources.length?'partial':'empty','Advertised feature types only; native schema, rights and feature population unverified',resources.length,start+20<names.length?String(start+20):null)};
}
const unknownLicense={state:'unknown' as const,label:null,receiptSha256:null};
/** BB types observed in DescribeFeatureType; MV types provisional until an export snapshot is inspected. */
export const observedAtlasLayers:readonly AtlasLayerContract[]=[
 {sourceId:'bb-heat-wfs',nativeLayerId:'waermekataster:potenzial_gemarkungen_abwasser',propertySchema:{waermepot:'number',nutzungpot:'number',einheit:'string',gemeinde_schluessel:'string'},fields:[{field:'waermepot',kind:'HeatPotential',predicate:'source_heat_potential',unit:null,unitField:'einheit'},{field:'nutzungpot',kind:'HeatPotential',predicate:'source_utilization_potential',unit:null,unitField:'einheit'}],agsField:'gemeinde_schluessel',referenceDate:'2022',method:'Source potential model; substantive model and data quality unverified',granularity:'Gemarkung; not municipality total',crs:'EPSG:4326',license:unknownLicense},
 {sourceId:'bb-energy-wfs',nativeLayerId:'energieerzeugung:energieerzeugung_einzelanlagen_solar',propertySchema:{bruttoleistung_der_einheit_kw:'number',nettonennleistung_der_einheit_kw:'number',gemeindeschluessel:'string',mastr_nr_der_einheit:'string',berichtsjahr:'number'},fields:[{field:'bruttoleistung_der_einheit_kw',kind:'GenerationAsset',predicate:'gross_capacity',unit:'kW'},{field:'nettonennleistung_der_einheit_kw',kind:'GenerationAsset',predicate:'net_capacity',unit:'kW'},{field:'berichtsjahr',kind:'AtlasContext',predicate:'reporting_year',unit:null},{field:'mastr_nr_der_einheit',kind:'AtlasContext',predicate:'mastr_unit_id',unit:null}],agsField:'gemeindeschluessel',referenceDate:null,method:'MaStR-derived inventory; registration is not measured generation',granularity:'Plant; generally >=30 kW per service description',crs:'EPSG:4326',license:unknownLicense},
 {sourceId:'mv-energy-atlas',nativeLayerId:'253',nativeIdField:'ags',propertySchema:{ags:'string',gemeindename:'string',summe_mwh:'number'},fields:[{field:'summe_mwh',kind:'HeatDemandObservation',predicate:'source_heat_energy_consumption',unit:'MWh'}],agsField:'ags',referenceDate:'2023-12',method:'INFAS 360 survey-based heating and warm-water consumption; not metered project results',granularity:'Municipality',crs:'EPSG:4326',license:unknownLicense},
 {sourceId:'mv-energy-atlas',nativeLayerId:'126',nativeIdField:'einheitmastrnummer',propertySchema:{einheitmastrnummer:'string',ags8:'string',bruttoleistung:'number',nettonennleistung:'number'},fields:[{field:'bruttoleistung',kind:'GenerationAsset',predicate:'gross_capacity',unit:'kW'},{field:'nettonennleistung',kind:'GenerationAsset',predicate:'net_capacity',unit:'kW'},{field:'einheitmastrnummer',kind:'AtlasContext',predicate:'mastr_unit_id',unit:null}],agsField:'ags8',referenceDate:'2026-01',method:'MaStR-derived wind inventory',granularity:'Plant point; no network operator inference',crs:'EPSG:4326',license:unknownLicense}
];
export const energyAtlasAdapter=createEnergyAtlasAdapter();
