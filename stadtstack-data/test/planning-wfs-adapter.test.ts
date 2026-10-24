import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlanningWfsAdapter, planningFeatureSchemas, planningWfsAdapter, PLANNING_WFS_SOURCES, readPlanningXml} from '../src/adapters/planning-wfs.ts';
import type {PlanningFeatureSchema, PlanningFeatureJoin} from '../src/adapters/planning-wfs.ts';
import {digest, semanticHash} from '../src/district-adapter-contract.ts';
import type {AdmittedSnapshot, AdapterScope, StructuredLocator} from '../src/district-adapter-contract.ts';

// Synthetic native WFS/XSD fixtures, not downloaded features or a publisher coverage claim.
const sourceId='mv-lup-bplan-wfs';
const scope:AdapterScope={publisherId:'landkreis-ludwigslust-parchim',sourceId,municipalityId:'ludwigslust',ags:'13076090',tenant:null,observationWindow:'fixture-2026'};
const endpoint=PLANNING_WFS_SOURCES[sourceId].endpoint;
function snapshot(xml:string,url=endpoint+'?service=WFS&version=2.0.0&request=GetFeature&typeNames=ms%3ABauleitplaene&bbox=600000%2C5900000%2C610000%2C5910000%2CEPSG%3A25832&srsName=EPSG%3A25832&count=100&startIndex=0&outputFormat=application%2Fgml%2Bxml%3B+version%3D3.2'):AdmittedSnapshot {
 const bytes=Buffer.from(xml);return {bytes,url,sourceSha256:digest(bytes),mimeType:'application/gml+xml',retrievedAt:'2026-10-11T00:00:00.000Z',policyReceiptSha256:digest('synthetic fixture policy'),sourceVersion:null};
}
const lupFields:Record<string,string>={msGeometry:'gml:GeometryPropertyType',Name:'string',Gemeinde:'string',Ortsteil:'string',Rechtsstand:'string',Inkrafttretensdatum:'string',Hauptplanart:'string',Planart:'string',Anzahl_Dokumente:'string',Dokumentart_1:'string',URL_1:'string',Dokumentbeschreibung_1:'string'};
const schema:PlanningFeatureSchema={sourceId,sourceSha256:digest('native xsd fixture'),namespace:PLANNING_WFS_SOURCES[sourceId].namespace,featureType:'Bauleitplaene',fields:lupFields};
const geometry='<gml:Polygon srsName="urn:ogc:def:crs:EPSG::25832"><gml:exterior><gml:LinearRing><gml:posList>600000 5900000 600100 5900000 600100 5900100 600000 5900000</gml:posList></gml:LinearRing></gml:exterior><gml:interior><gml:LinearRing><gml:posList>600010 5900010 600020 5900010 600020 5900020 600010 5900010</gml:posList></gml:LinearRing></gml:interior></gml:Polygon>';
function feature(fields='<ms:Name>B-Plan 17 – 2. Änderung</ms:Name><ms:Gemeinde>Ludwigslust</ms:Gemeinde><ms:Rechtsstand>rechtskräftig</ms:Rechtsstand><ms:Inkrafttretensdatum>09.10.2026</ms:Inkrafttretensdatum><ms:URL_1>https://bauleitplaene-mv.de/download/fixture.pdf</ms:URL_1>') {
 return `<wfs:member><ms:Bauleitplaene gml:id="Bauleitplaene.17"><ms:msGeometry>${geometry}</ms:msGeometry>${fields}</ms:Bauleitplaene></wfs:member>`;
}
function collection(body:string,attributes='numberMatched="1" numberReturned="1"'):string {
 return `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ms="http://mapserver.gis.umn.edu/mapserver" xmlns:gml="http://www.opengis.net/gml/3.2" ${attributes}>${body}</wfs:FeatureCollection>`;
}
function join(input:AdmittedSnapshot,ags=scope.ags,nativeId='Bauleitplaene.17'):PlanningFeatureJoin {
 const evidence:StructuredLocator={sourceSha256:digest('synthetic municipality boundary'),format:'xml',nativeId:ags,path:'/fixture/verifiedMunicipalityJoin',sheet:null,rowKey:null,cells:[],rawValue:ags,schemaHash:semanticHash({fixture:'boundary'}),mappingVersion:'fixture-boundary-join-v1'};
 return {sourceId,sourceSha256:input.sourceSha256,nativeId,ags,evidence};
}
function adapter(input:AdmittedSnapshot,ags=scope.ags){return createPlanningWfsAdapter({schemas:[schema],joins:[join(input,ags)]});}
const capabilities=`<wfs:WFS_Capabilities xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:ms="http://mapserver.gis.umn.edu/mapserver" version="2.0.0"><ows:ServiceIdentification><ows:AccessConstraints>Datenlizenz Deutschland - Namensnennung - 2.0. Quellenvermerk: Landkreis Ludwigslust-Parchim</ows:AccessConstraints></ows:ServiceIdentification><wfs:FeatureTypeList><wfs:FeatureType><wfs:Name>ms:Bauleitplaene</wfs:Name><wfs:DefaultCRS>urn:ogc:def:crs:EPSG::25832</wfs:DefaultCRS></wfs:FeatureType></wfs:FeatureTypeList></wfs:WFS_Capabilities>`;

test('licensed capabilities discover native schema; feature request needs verified scoped envelope',()=>{
 const input=snapshot(capabilities,endpoint+'?SERVICE=WFS&REQUEST=GetCapabilities');
 const metadata=planningWfsAdapter.discover(input,scope,null);
 assert.equal(metadata.resources.length,1);assert.equal(new URL(metadata.resources[0].url).searchParams.get('request'),'DescribeFeatureType');
 assert.equal(metadata.coverage.state,'partial');
 const configured=createPlanningWfsAdapter({extents:[{ags:scope.ags,bbox:[600000,5900000,610000,5910000],crs:'EPSG:25832',evidenceSha256:digest('fixture-boundary')}]});
 const discovered=configured.discover(input,scope,null),request=discovered.resources.find(item=>new URL(item.url).searchParams.get('request')==='GetFeature')!;
 assert.equal(new URL(request.url).searchParams.get('bbox'),'600000,5900000,610000,5910000,EPSG:25832');
 assert.equal(discovered.coverage.state,'partial');
 assert.equal(planningWfsAdapter.parse(input,scope).coverage.state,'not_checked');
});

test('positive LUP native GML retains IDs, full amendment labels, CRS/rings and date roles',()=>{
 const input=snapshot(collection(feature())),configured=adapter(input),result=configured.parse(input,scope);
 assert.equal(result.coverage.state,'partial');assert.ok(result.coverage.limitations.some(item=>item.includes('inventory explicitly incomplete')));
 const title=result.observations.find(item=>item.predicate==='plan_name')!;
 assert.equal(title.value,'B-Plan 17 – 2. Änderung');assert.equal(title.nativeId,'Bauleitplaene.17');assert.equal(title.nativeVersion,null);
 assert.equal(title.geography.ags,'13076090');assert.equal(title.geography.basis,'verified_join');
 const date=result.observations.find(item=>item.dateRole==='legal_effective')!;
 assert.equal(date.value,'2026-10-09');assert.equal(date.datePrecision,'day');assert.equal(date.evidence[0].rawValue,'09.10.2026');assert.equal(date.publishedAt,null);
 const footprint=result.observations.find(item=>item.kind==='PlanGeometry')!;
 assert.equal(footprint.unit,'m');assert.match(String(footprint.value),/600000 5900000/);assert.match(String(footprint.value),/gml:interior/);
 assert.equal(footprint.evidence[0].sourceSha256,input.sourceSha256);assert.equal(footprint.evidence.length,1);
 assert.deepEqual(footprint.supportingEvidence,[{role:'municipality_join',locator:join(input).evidence}]);
 assert.equal(footprint.datePrecision,'unknown');
 assert.ok(result.observations.every(item=>item.evidence.every(locator=>locator.sourceSha256===input.sourceSha256)));
 assert.ok(!result.observations.some(item=>/operator|permit|payment|completion/.test(item.predicate)));
 assert.deepEqual(configured.parse(input,scope),result);
 assert.equal(configured.discover(input,scope,null).resources[0].parentId,'Bauleitplaene.17');
});

test('empty is page-local and never an inventory deletion or complete source assertion',()=>{
 const input=snapshot(collection('','numberMatched="0" numberReturned="0"'));
 assert.equal(planningWfsAdapter.parse(input,scope).coverage.state,'empty');
 assert.deepEqual(planningWfsAdapter.parse(input,scope).observations,[]);
 assert.equal(planningWfsAdapter.parse(snapshot(collection('','numberMatched="10" numberReturned="0"')),scope).coverage.state,'held_quality');
});

test('verified neighbouring municipality features do not hold an admissible in-scope bbox page',()=>{
 const neighbour=feature('<ms:Name>Neighbour plan</ms:Name><ms:Gemeinde>Parchim</ms:Gemeinde>').replace('gml:id="Bauleitplaene.17"','gml:id="Bauleitplaene.18"');
 const input=snapshot(collection(feature()+neighbour,'numberMatched="2" numberReturned="2"'));
 const configured=createPlanningWfsAdapter({schemas:[schema],joins:[join(input),join(input,'13076108','Bauleitplaene.18')]}),result=configured.parse(input,scope);
 assert.equal(result.coverage.state,'partial');assert.equal(result.coverage.observedRows,2);
 assert.ok(result.observations.length>0);assert.ok(result.observations.every(item=>item.nativeId==='Bauleitplaene.17'&&item.geography.ags===scope.ags));
 assert.ok(result.coverage.limitations.some(item=>item.includes('1 features with verified joins to other municipalities')));
 assert.ok(configured.discover(input,scope,null).resources.every(item=>item.parentId!=='Bauleitplaene.18'));
 const unresolved=createPlanningWfsAdapter({schemas:[schema],joins:[join(input)]}).parse(input,scope);
 assert.equal(unresolved.coverage.state,'held_quality');assert.match(unresolved.coverage.reason,/1 features lack/);
});

test('paginated fixture follows only admitted next link with exact scope and advancing cursor',()=>{
 const first=snapshot(collection(feature()));const next=new URL(first.url);next.searchParams.set('startIndex','1');
 const xml=collection(feature(),`numberMatched="2" numberReturned="1" next="${next.href.replaceAll('&','&amp;')}"`),input=snapshot(xml);
 const configured=adapter(input),result=configured.discover(input,scope,next.href);
 assert.equal(result.coverage.state,'partial');assert.equal(result.coverage.nextCursor,next.href);assert.ok(result.resources.some(item=>item.url===next.href));
 assert.equal(configured.discover(input,scope,'invented-cursor').coverage.state,'held_quality');
 const wrong=new URL(next);wrong.searchParams.set('bbox','0,0,1,1,EPSG:25832');
 const changed=snapshot(collection(feature(),`numberMatched="2" numberReturned="1" next="${wrong.href.replaceAll('&','&amp;')}"`));
 assert.equal(adapter(changed).discover(changed,scope,null).coverage.state,'held_quality');
});

test('changed schema fails closed; unknown town join and coordinate CRS are not guessed',()=>{
 const changed=snapshot(collection(feature('<ms:Renamed_Planname>Changed</ms:Renamed_Planname>')));
 assert.equal(adapter(changed).parse(changed,scope).coverage.state,'held_quality');
 const valid=snapshot(collection(feature()));
 assert.equal(planningWfsAdapter.parse(valid,scope).coverage.state,'held_quality');
 assert.equal(createPlanningWfsAdapter({schemas:[schema]}).parse(valid,scope).coverage.state,'held_quality');
 assert.equal(adapter(valid,'13076108').parse(valid,scope).observations.length,0);
 const noCrs=snapshot(collection(feature()).replace(' srsName="urn:ogc:def:crs:EPSG::25832"',''));
 assert.equal(adapter(noCrs).parse(noCrs,scope).coverage.state,'held_quality');
 const badDate=snapshot(collection(feature('<ms:Inkrafttretensdatum>31.02.2026</ms:Inkrafttretensdatum>')));
 assert.equal(adapter(badDate).parse(badDate,scope).coverage.state,'held_quality');
});

test('withdrawn legal status remains attributed; absent features do not retract a plan',()=>{
 const withdrawn=snapshot(collection(feature('<ms:Name>B-Plan 17 – 2. Änderung</ms:Name><ms:Rechtsstand>aufgehoben</ms:Rechtsstand>')));
 const result=adapter(withdrawn).parse(withdrawn,scope);
 assert.equal(result.observations.find(item=>item.predicate==='native_legal_status')?.value,'aufgehoben');
 assert.equal(result.coverage.state,'partial');
 assert.ok(!result.observations.some(item=>item.predicate==='repeals'||item.predicate==='deleted'));
});

test('blocked access and unresolved Hoppegarten rights remain distinct',()=>{
 const blocked=snapshot('<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1"><ows:Exception exceptionCode="AccessDenied"><ows:ExceptionText>Access blocked</ows:ExceptionText></ows:Exception></ows:ExceptionReport>');
 assert.equal(planningWfsAdapter.parse(blocked,scope).coverage.state,'blocked_access');
 assert.equal(planningWfsAdapter.discover(blocked,scope,null).coverage.state,'blocked_access');
 const hoppe={...scope,sourceId:'hoppegarten-fnp-wfs',municipalityId:'hoppegarten',ags:'12064227'};
 assert.equal(planningWfsAdapter.parse(blocked,hoppe).coverage.state,'held_origin');
 const noLicence=snapshot(capabilities.replace('Datenlizenz Deutschland - Namensnennung - 2.0. Quellenvermerk: Landkreis Ludwigslust-Parchim','Keine Einschränkung; Copyright'));
 assert.equal(planningWfsAdapter.discover(noLicence,scope,null).coverage.state,'held_origin');
});

test('native inline DescribeFeatureType schema extraction never resolves imports',()=>{
 const fields=Object.entries(lupFields).map(([name,type])=>`<element name="${name}" type="${type}" minOccurs="0"/>`).join('');
 const xsd=snapshot(`<schema xmlns="http://www.w3.org/2001/XMLSchema" xmlns:ms="http://mapserver.gis.umn.edu/mapserver" xmlns:gml="http://www.opengis.net/gml/3.2" targetNamespace="http://mapserver.gis.umn.edu/mapserver"><import namespace="http://www.opengis.net/gml/3.2" schemaLocation="https://invalid.example/never-fetched.xsd"/><element name="Bauleitplaene" type="ms:BauleitplaeneType"/><complexType name="BauleitplaeneType"><complexContent><extension base="gml:AbstractFeatureType"><sequence>${fields}</sequence></extension></complexContent></complexType></schema>`);
 const actual=planningFeatureSchemas(xsd,sourceId);
 assert.equal(actual[0].sourceSha256,xsd.sourceSha256);assert.deepEqual(actual[0].fields,lupFields);
});

test('SH flattened native fields preserve amendment references, date chronology and XPlan schema version',()=>{
 const shId='sh-plan-xplan-wfs',shSource=PLANNING_WFS_SOURCES[shId],shScope={...scope,sourceId:shId,publisherId:'gdi-sh',municipalityId:'moelln',ags:'01053090'};
 const shSchema:PlanningFeatureSchema={sourceId:shId,sourceSha256:digest('SH schema fixture'),namespace:shSource.namespace,featureType:'BP_Plan',fields:{raeumlicherGeltungsbereich:'gml:GeometryPropertyType',name:'string',nummer:'string',xpVersion:'string',aendertPlan:'string',satzungsbeschlussDatum:'date',inkrafttretensDatum:'date',untergangsDatum:'date',staedtebaulicherVertrag:'boolean'}};
 const xml=`<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:xplan="http://www.deegree.org/xplanung/1/0" xmlns:gml="http://www.opengis.net/gml/3.2" numberMatched="1" numberReturned="1"><wfs:member><xplan:BP_Plan gml:id="BP_Plan.fixture2"><xplan:raeumlicherGeltungsbereich>${geometry}</xplan:raeumlicherGeltungsbereich><xplan:name>B-Plan 86 2. Änderung</xplan:name><xplan:nummer>86 2. Änderung</xplan:nummer><xplan:xpVersion>5.4</xplan:xpVersion><xplan:aendertPlan>BP_Plan.fixture1</xplan:aendertPlan><xplan:satzungsbeschlussDatum>2026-09-01</xplan:satzungsbeschlussDatum><xplan:inkrafttretensDatum>2026-09-15</xplan:inkrafttretensDatum><xplan:untergangsDatum>2026-10-01</xplan:untergangsDatum><xplan:staedtebaulicherVertrag>true</xplan:staedtebaulicherVertrag></xplan:BP_Plan></wfs:member></wfs:FeatureCollection>`;
 const input=snapshot(xml,shSource.endpoint+'?service=WFS&request=GetFeature');
 const shJoin:PlanningFeatureJoin={...join(input,shScope.ags,'BP_Plan.fixture2'),sourceId:shId};
 const configured=createPlanningWfsAdapter({schemas:[shSchema],joins:[shJoin]}),result=configured.parse(input,shScope);
 assert.equal(result.coverage.state,'partial');assert.equal(result.observations.find(item=>item.predicate==='amendment_reference')?.value,'BP_Plan.fixture1');
 assert.equal(result.observations.find(item=>item.predicate==='plan_number')?.value,'86 2. Änderung');
 assert.deepEqual(result.observations.filter(item=>item.dateRole).map(item=>[item.dateRole,item.date]),[['plan_adoption_resolution','2026-09-01'],['legal_effective','2026-09-15'],['legal_end','2026-10-01']]);
 assert.ok(result.observations.every(item=>item.nativeVersion===null));
 assert.equal(result.observations.find(item=>item.predicate==='native_field:staedtebaulicherVertrag')?.value,true);
});

test('XML security/size/hash limits fail closed; configuration is immutable and contradictions held',()=>{
 const entity=snapshot('<!DOCTYPE Plan [<!ENTITY x SYSTEM "file:///etc/passwd">]><Plan>&x;</Plan>');
 assert.throws(()=>readPlanningXml(entity),/DTD/);
 assert.equal(planningWfsAdapter.parse(entity,scope).coverage.state,'held_quality');
 const oversized=snapshot('<x>'+'a'.repeat(4*1024*1024)+'</x>');assert.throws(()=>readPlanningXml(oversized),/byte limit/);
 const malformed=snapshot('<x><y></x>');assert.throws(()=>readPlanningXml(malformed),/Malformed/);
 const deep=snapshot('<x>'.repeat(65)+'</x>'.repeat(65));assert.throws(()=>readPlanningXml(deep),/depth limit/);
 const tagBomb=snapshot('<x>'+'<v/>'.repeat(100000)+'</x>');assert.throws(()=>readPlanningXml(tagBomb),/element limit/);
 const invalidGeometry=snapshot(collection(feature()).replace('600000 5900000 600100','NaN 5900000 600100'));
 assert.equal(adapter(invalidGeometry).parse(invalidGeometry,scope).coverage.state,'held_quality');
 const wrongNamespace=snapshot(collection(feature()).replace('xmlns:ms="http://mapserver.gis.umn.edu/mapserver"','xmlns:ms="https://invalid.example/schema"'));
 assert.equal(adapter(wrongNamespace).parse(wrongNamespace,scope).coverage.state,'held_quality');
 const input=snapshot(collection(feature()));assert.equal(adapter(input).parse({...input,sourceSha256:digest('wrong')},scope).coverage.state,'held_quality');
 const duplicate=join(input);assert.throws(()=>createPlanningWfsAdapter({joins:[duplicate,{...duplicate,ags:'13076108'}]}),/contradictory/);
 const options={schemas:[schema],joins:[join(input)]},configured=createPlanningWfsAdapter(options);options.joins[0].ags='13076108';
 assert.equal(configured.parse(input,scope).observations[0].geography.ags,'13076090');
});

test('MV participation is outside the pure WFS parser and remains on its existing acquisition route',()=>{
 for(const sourceId of ['ludwigslust-participation','parchim-participation','hagenow-participation'])assert.equal(planningWfsAdapter.parse(snapshot(collection('','numberMatched="0" numberReturned="0"')),{...scope,sourceId}).coverage.state,'not_applicable');
});
