import {test} from 'node:test';
import assert from 'node:assert/strict';
import {digest, type AdapterScope, type AdmittedSnapshot} from '../src/district-adapter-contract.ts';
import {createEnergyAtlasAdapter, energyAtlasAdapter, observedAtlasLayers, type AtlasLayerContract} from '../src/adapters/energy-atlas.ts';

// Handwritten native-format protocol fixtures, not captured production records or coverage evidence.
const receipt='a'.repeat(64);
const scope:AdapterScope={publisherId:'mv-atlas',sourceId:'mv-energy-atlas',municipalityId:'ludwigslust',ags:'13076090',tenant:null,observationWindow:'2026-10-11'};
function snapshot(body:unknown,url='https://energieatlas-mv.de/fis/index.php?selected_layer_id=253'):AdmittedSnapshot {const bytes=new TextEncoder().encode(typeof body==='string'?body:JSON.stringify(body));return {bytes,sourceSha256:digest(bytes),url,mimeType:typeof body==='string'?'application/xml':'application/json',retrievedAt:'2026-10-11T00:00:00Z',policyReceiptSha256:receipt,sourceVersion:'fixture-v1'};}
const admitted:AtlasLayerContract={...observedAtlasLayers.find(layer=>layer.nativeLayerId==='253')!,license:{state:'admitted',label:'Fixture-only rights proof',receiptSha256:receipt}};
const adapter=createEnergyAtlasAdapter([admitted]);
const feature={type:'Feature',id:'0007',properties:{ags:'13076090',gemeindename:'Ludwigslust',summe_mwh:123.5},geometry:{type:'Polygon',coordinates:[[[11,53],[12,53],[12,54],[11,53]]]}};
const collection=(features:unknown[])=>({type:'FeatureCollection',features});
const overlay=(id:number)=>({type:'GeoJSON',url:'https://energieatlas-mv.de/fis/index.php',infoAttribute:id===253?'ags':'einheitmastrnummer',layerAttributes:id===253?{ags:'ags'}:{einheitmastrnummer:'Einheit Mastr. Nr'},params:{gast:7,go:'Daten_Export_Exportieren',Stelle_ID:7,selected_layer_id:id,export_format:'GeoJSON',epsg:4326,all:1,browserwidth:800,browserheight:600}});

test('native positive heat observation retains ID, AGS, vintage, unit, geometry and raw evidence',()=>{
 const input=snapshot(collection([feature]));const result=adapter.parse(input,scope);assert.equal(result.coverage.state,'partial');assert.equal(result.observations.length,2);
 const heat=result.observations[0]!;assert.equal(heat.nativeId,'0007');assert.equal(heat.geography.ags,'13076090');assert.equal(heat.value,123.5);assert.equal(heat.unit,'MWh');assert.equal(heat.sourceReferenceDate,'2023-12');assert.equal(heat.evidence[0]!.rawValue,123.5);assert.equal(heat.evidence[0]!.sourceSha256,input.sourceSha256);assert.match(heat.limitations.join(' '),/no heat-plan adoption/);
 assert.equal(result.observations[1]!.value,JSON.stringify(feature.geometry));
});
test('empty is scoped absence in snapshot, not withdrawal or source completeness',()=>{const result=adapter.parse(snapshot(collection([])),scope);assert.equal(result.coverage.state,'empty');assert.deepEqual(result.observations,[]);assert.match(result.coverage.reason,/completeness unverified/);});
test('native next page remains partial and does not silently fetch',()=>{const result=adapter.parse(snapshot({...collection([feature]),links:[{rel:'next',href:'?selected_layer_id=253&page=2'}]}),scope);assert.equal(result.coverage.state,'partial');assert.match(result.coverage.nextCursor!,/page=2/);assert.equal(result.coverage.observedRows,1);});
test('schema changes hold the entire page rather than return partially mapped records',()=>{for(const changed of [{...feature,properties:{...feature.properties,summe_mwh:'123,5'}},{...feature,properties:{gemeindename:'Ludwigslust',summe_mwh:123.5}}]){const result=adapter.parse(snapshot(collection([feature,changed])),scope);assert.equal(result.coverage.state,'held_quality');assert.deepEqual(result.observations,[]);}});
test('withdrawn native plant status is an attributed source field, never inferred from missing page',()=>{
 const contract:AtlasLayerContract={...admitted,fields:[{field:'status',kind:'GenerationAsset',predicate:'source_status',unit:null}],propertySchema:{ags:'string',status:'string'}};
 const result=createEnergyAtlasAdapter([contract]).parse(snapshot(collection([{...feature,properties:{ags:'13076090',status:'endgültig stillgelegt'}}])),scope);
 assert.equal(result.observations[0]!.value,'endgültig stillgelegt');assert.equal(result.observations[0]!.predicate,'source_status');assert.equal(result.coverage.state,'partial');
});
test('unknown rights stay held and malformed/hash-mismatched bytes fail closed',()=>{assert.equal(energyAtlasAdapter.parse(snapshot(collection([feature])),scope).coverage.state,'held_origin');assert.equal(adapter.parse({...snapshot(collection([feature])),sourceSha256:'b'.repeat(64)},scope).coverage.state,'held_quality');});
test('SH is viewer only and wrong-state pilots are not applicable',()=>{const sh={...scope,sourceId:'sh-heat-atlas',ags:'01053100'};assert.equal(energyAtlasAdapter.discover(snapshot('<html/>'),sh,null).coverage.state,'not_checked');assert.deepEqual(energyAtlasAdapter.parse(snapshot('<html/>'),sh).observations,[]);assert.equal(energyAtlasAdapter.parse(snapshot(collection([])),{...scope,ags:'01053100'}).coverage.state,'not_applicable');});
test('MV native config discovery is bounded, paginated, empty and changed-schema aware',()=>{const input=snapshot({overlays:[overlay(126),overlay(253)]},'https://energieatlas-mv.de/layerdef.json');const first=energyAtlasAdapter.discover(input,scope,null);assert.equal(first.resources[0]!.nativeId,'126');assert.equal(first.coverage.nextCursor,'1');assert.equal(energyAtlasAdapter.discover(input,scope,'1').resources[0]!.nativeId,'253');assert.equal(energyAtlasAdapter.discover(snapshot({overlays:[]}),scope,null).coverage.state,'empty');assert.equal(energyAtlasAdapter.discover(snapshot({layers:[]}),scope,null).coverage.state,'held_quality');});
test('WFS native capabilities enumerate schemas only and reject XML entities',()=>{
 const bb={...scope,sourceId:'bb-heat-wfs',ags:'12064227'};const body='<wfs:WFS_Capabilities xmlns:wfs="http://www.opengis.net/wfs/2.0" version="2.0.0"><wfs:FeatureTypeList><wfs:FeatureType><wfs:Name>waermekataster:potenzial_gemarkungen_abwasser</wfs:Name></wfs:FeatureType></wfs:FeatureTypeList></wfs:WFS_Capabilities>';
 const result=energyAtlasAdapter.discover(snapshot(body,'https://energieportal-brandenburg.de/geoserver/waermekataster/wfs'),bb,null);assert.equal(result.resources.length,1);assert.match(result.resources[0]!.url,/DescribeFeatureType/);assert.equal(result.coverage.state,'partial');
 assert.equal(energyAtlasAdapter.discover(snapshot('<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///secret">]>'+body),bb,null).coverage.state,'held_quality');
});
test('numeric AGS, cross-origin pagination and unsupported semantic mappings hold',()=>{
 assert.equal(adapter.parse(snapshot(collection([{...feature,properties:{...feature.properties,ags:13076090}}])),scope).coverage.state,'held_quality');
 assert.equal(adapter.parse(snapshot({...collection([feature]),links:[{rel:'next',href:'https://other.invalid/'}]}),scope).coverage.state,'held_quality');
 const unsafe={...admitted,fields:[{field:'summe_mwh',kind:'HeatDemandObservation' as const,predicate:'adopts_heat_plan',unit:'MWh'}]};assert.equal(createEnergyAtlasAdapter([unsafe]).parse(snapshot(collection([feature])),scope).coverage.state,'held_quality');
});
test('explicit layer exclusion is blocked policy, and native identity fields support id-less exports',()=>{
 const excluded={...admitted,license:{state:'excluded' as const,label:null,receiptSha256:null}};
 assert.equal(createEnergyAtlasAdapter([excluded]).parse(snapshot(collection([feature])),scope).coverage.state,'blocked_policy');
 const {id:_id,...withoutId}=feature;
 assert.equal(adapter.parse(snapshot(collection([withoutId])),scope).observations[0]!.nativeId,'13076090');
});
test('native XSD discovery proposes bounded municipal requests without admitting unknown rights',()=>{
 const bb={...scope,sourceId:'bb-heat-wfs',ags:'12064227'};
 const xsd='<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema"><xsd:complexType name="potential"><xsd:sequence><xsd:element name="waermepot" type="xsd:double"/><xsd:element name="nutzungpot" type="xsd:double"/><xsd:element name="einheit" type="xsd:string"/><xsd:element name="gemeinde_schluessel" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:schema>';
 const input=snapshot(xsd,'https://energieportal-brandenburg.de/geoserver/waermekataster/wfs?typeNames=waermekataster%3Apotenzial_gemarkungen_abwasser');
 const result=energyAtlasAdapter.discover(input,bb,null);assert.equal(result.coverage.state,'held_origin');assert.equal(result.resources.length,1);
 const request=new URL(result.resources[0]!.url);assert.equal(request.searchParams.get('count'),'1000');assert.equal(request.searchParams.get('CQL_FILTER'),"gemeinde_schluessel='12064227'");
 assert.equal(energyAtlasAdapter.discover(snapshot(xsd.replace('name="waermepot" type="xsd:double"','name="waermepot" type="xsd:string"'),input.url),bb,null).coverage.state,'held_quality');
});
test('MV exact native form POST selector binds unmodified export URL',()=>{
 const input=snapshot(collection([feature]),'https://energieatlas-mv.de/fis/index.php');
 input.request={method:'POST',contentType:'application/x-www-form-urlencoded',body:'gast=7&go=Daten_Export_Exportieren&Stelle_ID=7&selected_layer_id=253&export_format=GeoJSON&epsg=4326&all=1&browserwidth=800&browserheight=600'};
 assert.equal(adapter.parse(input,scope).observations[0]!.value,123.5);
 assert.equal(input.url,'https://energieatlas-mv.de/fis/index.php');
 const missing=snapshot(collection([feature]),input.url);
 assert.equal(adapter.parse(missing,scope).coverage.state,'held_origin');
 assert.equal(adapter.parse({...input,url:input.url+'?selected_layer_id=126'},scope).coverage.state,'held_quality');
 assert.equal(adapter.parse({...input,request:{...input.request,body:input.request.body+'&selected_layer_id=126'}},scope).coverage.state,'held_quality');
 assert.equal(adapter.parse({...input,request:{...input.request,contentType:'application/json'}},scope).coverage.state,'held_quality');
});
