import {test} from 'node:test';
import assert from 'node:assert/strict';
import {digest, type AdmittedSnapshot, type AdapterScope} from '../src/district-adapter-contract.ts';
import {createEducationAdapter, educationAdapter, EDUCATION_SOURCES} from '../src/adapters/education.ts';

// Reduced publisher-native HTML/OOXML fixtures, not normalized JSON records.
// Fixture counts/sentinels are counterfactual; schema/labels come from the primary references in education-contract.json.
const adapter=createEducationAdapter({admission:'admitted',pageSize:1});
const urls:Record<string,string>={'kita-hoppegarten':'https://www.gemeinde-hoppegarten.de/seite/186856/kindertagesstaetten.html','kita-ruedersdorf':'https://www.ruedersdorf.de/meine-gemeinde/familien-und-soziales/kitas/','school-stats-bb':'https://download.statistik-berlin-brandenburg.de/report.xlsx','school-stats-sh':'https://www.statistik-nord.de/report.xlsx','school-stats-mv':'https://www.laiv-mv.de/report.xlsx','kita-regional-statistics':'https://www.regionalstatistik.de/genesisws/rest/2020/data/tablefile'};
function scope(sourceId='kita-hoppegarten',ags='12064227'):AdapterScope{return {publisherId:'official-fixture-publisher',sourceId,municipalityId:ags,ags,tenant:null,observationWindow:'2025'};}
function snapshot(content:string|Uint8Array,sourceId='kita-hoppegarten',url=urls[sourceId]):AdmittedSnapshot {
 const bytes=typeof content==='string'?new TextEncoder().encode(content):content;
 return {bytes,sourceSha256:digest(bytes),url,mimeType:typeof content==='string'?(sourceId==='kita-regional-statistics'?'text/csv':'text/html'):'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',retrievedAt:'2026-10-11T00:00:00Z',policyReceiptSha256:'a'.repeat(64),sourceVersion:'native-fixture-v1'};
}
const hop=(entries:string)=>`<main><div id="content"><div class="template-page template-page-effect"><h1>Kitaverzeichnis:</h1><p><strong>Kindertagesstätten in Trägerschaft der Gemeinde Hoppegarten</strong></p>${entries}</div></div></main>`;
const facility=(id:string,name='Kita Entdeckerland')=>`<div class="btgrid"><div class="row"><div class="col"><div class="content"><p><a href="/verzeichnis/visitenkarte.php?mandat=${id}"><strong>${name}</strong></a></p><p>15366 Hoppegarten</p><p><a href="tel:012345">DO_NOT_IMPORT_PHONE</a></p></div></div></div></div>`;
const card=`<div class="integration-card"><h2><a class="sd-organisation--name-link" href="https://www.ruedersdorf.de/strukturierte-daten/organisationen/kitas/kita-zwergenschloss/">Kita Zwergenschloss</a></h2><div class="integration-card__postal-address-wrapper"><address>Hans-Schröer-Straße 34, Herzfelde, 15378 Rüdersdorf bei Berlin</address></div><p class="sd-contact--name">DO_NOT_IMPORT_PERSON</p><a href="mailto:DO_NOT_IMPORT_EMAIL">DO_NOT_IMPORT_EMAIL</a></div>`;
function crc32(bytes:Uint8Array):number {let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc&1)?(crc>>>1)^0xedb88320:crc>>>1;}return (crc^0xffffffff)>>>0;}
/** Native uncompressed OOXML container builder; no production parser duplication. */
function workbook(sheet:string,rows:string[][],style?:{address:string;numFmtId:number;formatCode?:string;inherit?:'row'|'column';explicitGeneral?:boolean}):Uint8Array {
 const xml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
 const members:Record<string,string>={
  '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
  'xl/workbook.xml':`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml':`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${style?.inherit==='column'?`<cols><col min="${style.address.charCodeAt(0)-64}" max="${style.address.charCodeAt(0)-64}" style="1"/></cols>`:''}<sheetData>${rows.map((row,r)=>`<row r="${r+1}"${style?.inherit==='row'&&Number(style.address.slice(1))===r+1?' s="1" customFormat="1"':''}>${row.map((value,c)=>{const address=String.fromCharCode(65+c)+(r+1);return style?.address===address?`<c r="${address}"${style.explicitGeneral?' s="0"':style.inherit?'':' s="1"'}><v>${xml(value)}</v></c>`:`<c r="${address}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`;}).join('')}</row>`).join('')}</sheetData></worksheet>`,
 };
 if(style)members['xl/styles.xml']=`<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${style.formatCode?`<numFmts count="1"><numFmt numFmtId="${style.numFmtId}" formatCode="${xml(style.formatCode)}"/></numFmts>`:''}<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="${style.numFmtId}"/></cellXfs></styleSheet>`;
 const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
 for(const [name,text] of Object.entries(members)){const n=Buffer.from(name),data=Buffer.from(text),crc=crc32(data),l=Buffer.alloc(30),c=Buffer.alloc(46);l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt32LE(crc,14);l.writeUInt32LE(data.length,18);l.writeUInt32LE(data.length,22);l.writeUInt16LE(n.length,26);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);local.push(l,n,data);central.push(c,n);offset+=l.length+n.length+data.length;}
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(members).length,8);end.writeUInt16LE(Object.keys(members).length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,directory,end]);
}
test('Hoppegarten native mandate IDs keep leading zeros, facility/location and explicit operator roles only',()=>{
 const input=snapshot(hop(facility('0036035'))),result=adapter.parse(input,scope());
 assert.equal(result.coverage.state,'partial');assert.ok(result.observations.some(o=>o.nativeId==='mandat:0036035'&&o.value==='Kita Entdeckerland'));
 assert.ok(result.observations.some(o=>o.predicate==='operates'));assert.ok(result.observations.some(o=>o.predicate==='located_in'&&o.value==='municipality:12064227'));
 assert.ok(result.observations.every(o=>o.geography.ags==='12064227'&&o.sourceReferenceDate===null));
 assert.ok(result.observations.every(o=>o.evidence.every(e=>e.sourceSha256===input.sourceSha256&&e.format==='html')));
 assert.ok(!JSON.stringify(result).includes('DO_NOT_IMPORT'));assert.ok(!result.observations.some(o=>/capacity|occupancy|forecast/.test(o.predicate)));
});
test('Hoppegarten provider groups are not inferred from brands or the host',()=>{
 const content=hop(facility('1')).replace('Kindertagesstätten in Trägerschaft der Gemeinde Hoppegarten','Unbenannter Träger');
 const result=adapter.parse(snapshot(content),scope());assert.ok(result.observations.some(o=>o.predicate==='facility_name'));assert.ok(!result.observations.some(o=>o.predicate==='operates'));
});
test('offered municipal places remain separate from approved capacity, occupancy and forecasts',()=>{
 const statement='<p>In der Gemeinde Hoppegarten werden 970 Betreuungsplätze in elf Kindertagesstätten für Kinder im Alter von 0 Jahren bis zum Schuleintritt angeboten.</p>';
 const result=adapter.parse(snapshot(hop(statement+facility('1'))),scope());const places=result.observations.find(o=>o.predicate==='places_offered')!;
 assert.equal(places.value,970);assert.equal(places.unit,'places');assert.equal(places.subject,'municipality:12064227');assert.equal(places.date,null);
 assert.ok(!result.observations.some(o=>/approved_capacity|occupancy|forecast/.test(o.predicate)));
});
test('native discovery is bounded, deduplicated and cursor bound to snapshot and scope',()=>{
 const input=snapshot(hop(facility('1')+facility('2')+facility('1'))),first=adapter.discover(input,scope(),null);
 assert.equal(first.resources.length,1);assert.equal(first.resources[0].nativeId,'mandat:1');assert.ok(first.coverage.nextCursor);
 const last=adapter.discover(input,scope(),first.coverage.nextCursor);assert.equal(last.resources[0].nativeId,'mandat:2');assert.equal(last.coverage.nextCursor,null);
 assert.equal(adapter.discover(snapshot(hop(facility('3'))),scope(),first.coverage.nextCursor).coverage.state,'held_quality');
});
test('recognized empty, changed-schema, withdrawn and rights/access-held states remain distinct',()=>{
 assert.equal(adapter.parse(snapshot(hop('')),scope()).coverage.state,'empty');
 assert.equal(adapter.parse(snapshot('<main><h1>Kitas</h1><article>Changed layout</article></main>'),scope()).coverage.state,'held_quality');
 const withdrawn=adapter.parse(snapshot('<main>Dieses Verzeichnis wurde zurückgezogen.</main>'),scope());assert.equal(withdrawn.coverage.state,'not_checked');assert.equal(withdrawn.observations.length,0);
 assert.equal(educationAdapter.parse(snapshot(hop(facility('1'))),scope()).coverage.state,'held_origin');
 assert.equal(createEducationAdapter({admission:'blocked_access'}).parse(snapshot(hop('')),scope()).coverage.state,'blocked_access');
 assert.equal(createEducationAdapter({admission:'blocked_policy'}).discover(snapshot(hop('')),scope(),null).coverage.state,'blocked_policy');
});
test('Rüdersdorf landing discovers original result URL and does not fabricate an empty roster',()=>{
 const resultUrl='https://www.ruedersdorf.de/meine-gemeinde/familien-und-soziales/kitas/organisation-list.html?i4xpath=native-fixture&h=2&h_=4';
 const input=snapshot(`<div class="component-organisations"><div data-integration-result-page="${resultUrl.replaceAll('&','&amp;')}"><div class="integration-result"></div><div class="loading is-active"></div></div></div>`,'kita-ruedersdorf');const sc=scope('kita-ruedersdorf','12064428');
 assert.equal(adapter.discover(input,sc,null).resources[0].url,resultUrl);assert.equal(adapter.parse(input,sc).coverage.state,'not_checked');
});
test('Rüdersdorf native card labels do not convert contacts, brand or domain into operator identity',()=>{
 const result=adapter.parse(snapshot(card,'kita-ruedersdorf'),scope('kita-ruedersdorf','12064428'));
 assert.equal(result.coverage.state,'partial');assert.ok(result.observations.some(o=>o.value==='Kita Zwergenschloss'));assert.ok(!result.observations.some(o=>o.predicate==='operates'));assert.ok(!JSON.stringify(result).includes('DO_NOT_IMPORT'));
});
test('Rüdersdorf detail uses explicit municipal operator sentence, never Förderverein umbrella field',()=>{
 const content='<main id="main-content"><h1 class="main-column__headline">Kita Zwergenschloss</h1><p class="sd-organisation--umbrellaOrganisationName">Träger: Gemeinde Rüdersdorf bei Berlin / Förderverein der Kita Zwergenschloss e.V.</p><div class="sd-organisation--description"><p>Träger der Einrichtung ist die Gemeinde Rüdersdorf bei Berlin.</p></div><p class="sd-contact--name">DO_NOT_IMPORT_PERSON</p></main>';
 const input=snapshot(content,'kita-ruedersdorf','https://www.ruedersdorf.de/strukturierte-daten/organisationen/kitas/kita-zwergenschloss/'),result=adapter.parse(input,scope('kita-ruedersdorf','12064428'));
 assert.equal(result.observations.filter(o=>o.predicate==='operates').length,1);assert.ok(!result.observations.some(o=>o.subject.includes('Förderverein')));assert.ok(!JSON.stringify(result).includes('DO_NOT_IMPORT'));
});
const reports=[
 {source:'school-stats-bb',ags:'12064472',sheet:'Tab1.1.+1.2',title:'1 Selbstständige Schulen des Schuljahres 2025/26 nach Schulformen',rows:[['Kreisfreie Stadt\nLandkreis','Selbst-\nständige\nSchulen'],['Märkisch-Oderland','70']],district:'12064',value:70},
 {source:'school-stats-sh',ags:'01053100',sheet:'Tab. 1.2',title:'1.2 Einrichtungen an den allgemeinbildenden Schulen in Schleswig-Holstein im Schuljahr 2017/18 nach Schulart und Kreisen',rows:[['KREISFREIE STADT\nKreis','Ins-\ngesamt'],['','Einrichtungen an öffentlichen und privaten Schulen'],['Herzogtum Lauenburg','71']],district:'01053',value:71},
 {source:'school-stats-mv',ags:'13076090',sheet:'2.1',title:'Allgemeinbildende Schulen im Schuljahr 2025/26 nach Organisationsformen',rows:[['Lfd. Nr.','Land\nKreisfreie Stadt\nLandkreis','Schulen\ninsgesamt'],['13','Ludwigslust-Parchim','80']],district:'13076',value:80},
];
for(const report of reports)test(`${report.source} parses original OOXML district totals, not municipal school capacity`,()=>{
 const input=snapshot(workbook(report.sheet,[[report.title],...report.rows]),report.source),sc=scope(report.source,report.ags),result=adapter.parse(input,sc);
 assert.equal(result.coverage.state,'partial');assert.equal(result.observations[0].value,report.value);assert.equal(result.observations[0].subject,`administrative-area:KR:${report.district}`);assert.equal(result.observations[0].geography.ags,null);
 assert.ok(result.observations[0].evidence.some(e=>e.rawValue===String(report.value)&&e.sheet===report.sheet&&e.cells.length===1));assert.equal(result.observations[0].dateRole,'school_year');
 const empty=adapter.parse(snapshot(workbook(report.sheet,[[report.title],report.rows[0]]),report.source),sc);assert.equal(empty.coverage.state,'empty');
 assert.equal(adapter.parse(snapshot(workbook('changed-sheet',[[report.title],...report.rows]),report.source),sc).coverage.state,'held_quality');
});
test('school numeric suppression, date schema changes, and native-byte tampering fail honestly',()=>{
 const r=reports[0],sc=scope(r.source,r.ags);const input=snapshot(workbook(r.sheet,[[r.title],r.rows[0],['Märkisch-Oderland','•']]),r.source);const result=adapter.parse(input,sc);assert.equal(result.observations[0].value,null);assert.ok(result.observations[0].evidence.some(e=>e.rawValue==='•'));
 assert.equal(adapter.parse({...input,sourceSha256:'0'.repeat(64)},sc).coverage.state,'held_quality');
 assert.equal(adapter.parse(snapshot(workbook(r.sheet,[[r.title.replace('2025/26','2025/2027')],...r.rows]),r.source),sc).coverage.state,'held_quality');
});
test('licensed Kita native GENESIS cells keep KR granularity and 1 March reference',()=>{
 const content='GENESIS-Tabelle: 22541-01-04\nGenehmigte Plätze (Anzahl);;\n;;2025\n;;Insgesamt\n01053;Herzogtum Lauenburg;123\n__________\n',input=snapshot(content,'kita-regional-statistics'),result=adapter.parse(input,scope('kita-regional-statistics','01053100'));
 assert.equal(result.coverage.state,'partial');assert.equal(result.observations[0].value,123);assert.equal(result.observations[0].date,'2025-03-01');assert.equal(result.observations[0].geography.ags,null);assert.ok(result.observations[0].subject.includes('KR:01053'));
 assert.equal(adapter.parse(snapshot(content.replace('01053;Herzogtum Lauenburg;123','12064;Märkisch-Oderland;123'),'kita-regional-statistics'),scope('kita-regional-statistics','01053100')).coverage.state,'empty');
 assert.equal(adapter.parse(snapshot(content.replace('__________',''),'kita-regional-statistics'),scope('kita-regional-statistics','01053100')).coverage.state,'held_quality');
 assert.equal(adapter.parse(snapshot(content.replace('(Anzahl);;','(Anzahl);;;'),'kita-regional-statistics'),scope('kita-regional-statistics','01053100')).coverage.state,'held_quality','A wider header than the native data row is malformed, not partial coverage');
});
test('every family route stays scoped to nine pilots; paid/restricted directories held; K03 unaddressed',()=>{
 assert.equal(EDUCATION_SOURCES.length,6);
 for(const source of ['sh-school-directory','mv-kita-directory','mv-school-directory'])assert.equal(adapter.parse(snapshot('<main>Directory</main>'),scope(source)).coverage.state,'blocked_policy');
 for(const ags of ['13076090','13076108','13076060']){const result=adapter.parse(snapshot(hop(facility('1'))),scope('kita-hoppegarten',ags));assert.equal(result.coverage.state,'not_applicable');assert.equal(result.observations.length,0);}
 assert.equal(adapter.parse(snapshot(hop('')),scope('kita-hoppegarten','12060001')).coverage.state,'not_applicable');
 assert.equal(adapter.parse(snapshot('{"facilities":[]}', 'kita-hoppegarten'),scope()).coverage.state,'held_quality');
});

test('all three native pupil totals preserve evidenced sex/public-private scope and school years',()=>{
 const pupilReports=[
  {source:'school-stats-bb',ags:'12064472',sheet:'Tab2.1',rows:[['Schülerinnen und Schüler des Schuljahres 2025/26 nach Schulformen und Geschlecht'],['Kreisfreie Stadt\nLandkreis','Schülerinnen\nund Schüler'],['','insgesamt'],['Barnim','100'],['Märkisch-Oderland','22313'],['','weiblich'],['Märkisch-Oderland','10870']],expected:22313,period:'2025/2026'},
  {source:'school-stats-sh',ags:'01053100',sheet:'Tab. 1.4',rows:[['Schülerinnen und Schüler an den allgemeinbildenden Schulen im Schuljahr 2017/18 nach Schulart und Kreisen'],['Kreis','Ins-\ngesamt'],['','Öffentliche und private Schulen'],['Dithmarschen','100'],['Herzogtum Lauenburg','12345'],['','darunter öffentliche Schulen'],['Herzogtum Lauenburg','10000']],expected:12345,period:'2017/2018'},
  {source:'school-stats-mv',ags:'13076090',sheet:'2.4',rows:[['','','','Schüler im Schuljahr 2025/26 nach Schularten und Geschlecht'],['Nr.','Landkreis','Geschlecht','Schüler'],['','','Allgemeinbildende Schulen insgesamt'],['23','Vorpommern-Greifswald','zusammen','100'],['25','Ludwigslust-Parchim','zusammen','21224'],['26','','weiblich','10479'],['','','Öffentliche allgemeinbildende Schulen'],['51','Ludwigslust-Parchim','zusammen','20574']],expected:21224,period:'2025/2026'},
 ];
 for(const r of pupilReports){
  const result=adapter.parse(snapshot(workbook(r.sheet,r.rows),r.source),scope(r.source,r.ags));
  assert.equal(result.coverage.state,'partial');assert.equal(result.observations[0].predicate,'enrolled_pupils');assert.equal(result.observations[0].value,r.expected);assert.equal(result.observations[0].date,r.period);assert.equal(result.observations[0].unit,'pupils');
  const changed=r.rows.map(row=>row.map(value=>value==='Allgemeinbildende Schulen insgesamt'?'Öffentliche allgemeinbildende Schulen':value==='Öffentliche und private Schulen'?'darunter öffentliche Schulen':value==='insgesamt'?'weiblich':value));
  assert.equal(adapter.parse(snapshot(workbook(r.sheet,changed),r.source),scope(r.source,r.ags)).coverage.state,'held_quality');
 }
});
test('statistical discovery excludes restricted SH directory while preserving original report resource',()=>{
 const content='<main><section id="c4631"><a href="/fileadmin/Dokumente/Statistische_Berichte/B_I_1_j17_SH.xlsx">XLSX</a></section><section><a href="/fileadmin/Dokumente/Schulverzeichnis_A_24-25_EXTERN-1.pdf">Verzeichnis</a></section></main>';
 const result=adapter.discover(snapshot(content,'school-stats-sh','https://www.statistik-nord.de/zahlen-fakten/bildung-rechtspflege/schulen-berufsbildung'),scope('school-stats-sh','01053100'),null);
 assert.equal(result.resources.length,1);assert.equal(result.resources[0].format,'xlsx');assert.ok(!result.resources.some(r=>r.url.includes('Schulverzeichnis')));
});
test('negated operator sentence and Förderverein-only detail never become operates',()=>{
 const content='<main id="main-content"><h1 class="main-column__headline">Kita Zwergenschloss</h1><p class="sd-organisation--umbrellaOrganisationName">Förderverein der Kita Zwergenschloss e.V.</p><div class="sd-organisation--description"><p>Nicht Träger der Einrichtung ist die Gemeinde Rüdersdorf bei Berlin.</p></div></main>';
 const result=adapter.parse(snapshot(content,'kita-ruedersdorf','https://www.ruedersdorf.de/strukturierte-daten/organisationen/kitas/kita-zwergenschloss/'),scope('kita-ruedersdorf','12064428'));
 assert.equal(result.coverage.state,'partial');assert.ok(!result.observations.some(o=>o.predicate==='operates'));
});

test('Rüdersdorf bounded native result fixtures distinguish empty, paginated, changed and withdrawn',()=>{
 const sc=scope('kita-ruedersdorf','12064428');
 assert.equal(adapter.parse(snapshot('<div class="integration-result"></div>','kita-ruedersdorf'),sc).coverage.state,'empty');
 const two=snapshot(card+card.replaceAll('kita-zwergenschloss/','kita-sonnenschein/').replaceAll('Kita Zwergenschloss','Kita Sonnenschein'),'kita-ruedersdorf');
 const first=adapter.discover(two,sc,null);assert.ok(first.coverage.nextCursor);const next=adapter.discover(two,sc,first.coverage.nextCursor);assert.equal(next.resources.length,1);assert.ok(next.resources[0].url.endsWith('/kita-sonnenschein/'));
 assert.equal(adapter.parse(snapshot('<div class="integration-card"><h2>Changed native field</h2></div>','kita-ruedersdorf'),sc).coverage.state,'held_quality');
 assert.equal(adapter.parse(snapshot('<main>Dieses Dokument wurde zurückgezogen.</main>','kita-ruedersdorf'),sc).coverage.state,'not_checked');
});
test('Kita rate native percent cells do not become approved/free places; blocked and withdrawn native responses are not empty',()=>{
 const sc=scope('kita-regional-statistics','01053100'),content='GENESIS-Tabelle: 22543-03-01\nBetreuungsquote unter 3 Jahre (%);;\n;;2025\n;;Insgesamt\n01053;Herzogtum Lauenburg;32,5\n__________\n';
 const result=adapter.parse(snapshot(content,'kita-regional-statistics'),sc);assert.equal(result.coverage.state,'partial');assert.equal(result.observations[0].unit,'%');assert.equal(result.observations[0].value,32.5);assert.equal(result.observations[0].date,'2025-03-01');assert.ok(result.observations[0].predicate.includes('kita_u3_rate'));assert.ok(!result.observations.some(o=>o.predicate==='places_offered'));
 for(const [reason,state] of [['Zugang gesperrt','blocked_access'],['Tabelle wurde zurückgezogen','held_quality']]){
  const native=JSON.stringify({Status:{Code:1,Type:'Error',Content:reason}}),input={...snapshot(native,'kita-regional-statistics'),mimeType:'application/json'};
  const held=adapter.parse(input,sc);assert.equal(held.coverage.state,state);assert.equal(held.observations.length,0);
 }
});

test('Hoppegarten provider scope stops at headings, free-carrier paragraphs and Hort transitions',()=>{
 for(const separator of ['<h2>Weitere Einrichtungen</h2>','<p><strong>Kindertagesstätten in freier Trägerschaft</strong></p>','<h2>Horte</h2>','<p><strong>Horte in anderer Trägerschaft</strong></p>']){
  const result=adapter.parse(snapshot(hop(facility('1')+separator+facility('2','Hort Neue Einrichtung'))),scope());
  assert.equal(result.coverage.state,'partial');
  assert.ok(result.observations.some(o=>o.nativeId==='mandat:1'&&o.predicate==='operates'));
  assert.ok(result.observations.some(o=>o.nativeId==='mandat:2'&&o.predicate==='facility_name'));
  assert.ok(!result.observations.some(o=>o.nativeId==='mandat:2'&&(o.predicate==='operates'||o.predicate==='organization_name')));
 }
});
test('Hoppegarten role requires a sibling native grid within the exact provider container',()=>{
 const outside=`<section>${facility('2')}</section>`,result=adapter.parse(snapshot(hop(facility('1')+outside)),scope());
 assert.ok(result.observations.some(o=>o.nativeId==='mandat:1'&&o.predicate==='operates'));
 assert.ok(!result.observations.some(o=>o.nativeId==='mandat:2'&&o.predicate==='operates'));
 const within=adapter.parse(snapshot(hop('<p><strong>Im Ortsteil Hönow:</strong></p>'+facility('3')+'<p><strong>Im Ortsteil Dahlwitz-Hoppegarten</strong></p>'+facility('4'))),scope());
 assert.equal(within.observations.filter(o=>o.predicate==='operates').length,2);
});

test('school count cells hold percent/date styles and do not infer percentages from headers or magnitude',()=>{
 const r=reports[0],sc=scope(r.source,r.ags),rows=[[r.title],r.rows[0],['Märkisch-Oderland','70']];
 for(const style of [{address:'B3',numFmtId:9},{address:'B3',numFmtId:177,formatCode:'0.0%'},{address:'B3',numFmtId:14}]){
  const held=adapter.parse(snapshot(workbook(r.sheet,rows,style),r.source),sc);
  assert.equal(held.coverage.state,'held_quality');assert.equal(held.observations.length,0);
 }
 const unstyled=adapter.parse(snapshot(workbook(r.sheet,[[r.title],r.rows[0],['Märkisch-Oderland','1']],{address:'B3',numFmtId:0}),r.source),sc);
 assert.equal(unstyled.coverage.state,'partial');assert.equal(unstyled.observations[0].value,1);assert.equal(unstyled.observations[0].unit,'schools');
});

test('school counts reject inherited row/column percent and date formats while explicit General wins',()=>{
 const r=reports[0],sc=scope(r.source,r.ags),rows=[[r.title],r.rows[0],['Märkisch-Oderland','70']];
 for(const inherit of ['row','column'] as const){
  for(const numFmtId of [9,14]){
   const held=adapter.parse(snapshot(workbook(r.sheet,rows,{address:'B3',numFmtId,inherit}),r.source),sc);
   assert.equal(held.coverage.state,'held_quality');assert.equal(held.observations.length,0);
   const general=adapter.parse(snapshot(workbook(r.sheet,rows,{address:'B3',numFmtId,inherit,explicitGeneral:true}),r.source),sc);
   assert.equal(general.coverage.state,'partial');assert.equal(general.observations[0].value,70);
  }
 }
});
