import {test} from 'node:test';
import assert from 'node:assert/strict';
import {digest,ObservationSchema} from '../src/district-adapter-contract.ts';
import type {AdmittedSnapshot,AdapterScope} from '../src/district-adapter-contract.ts';
import {discoverFundingOperations,FUNDING_DISTRIBUTIONS,fundingCapabilityReceipt,fundingOperationsAdapter,parseFundingOperations} from '../src/adapters/funding-operations.ts';
import {columnName} from '../src/adapters/structured-tables.ts';

// Bounded synthetic native-format fixtures, not snapshots of actual publisher bytes.
// Header aliases are candidate mappings; production source qualification and rights remain held.
function snapshot(bytes:string|Uint8Array,url:string,mimeType:string,sourceVersion:string|null='fixture-v1'):AdmittedSnapshot {
 const body=typeof bytes==='string'?Buffer.from(bytes):bytes;return {bytes:body,url,mimeType,sourceSha256:digest(body),retrievedAt:'2026-10-11T00:00:00Z',policyReceiptSha256:digest('admitted-synthetic-fixture'),sourceVersion};
}
function scope(sourceId='funding-sh-efre-beneficiaries'):AdapterScope{return {publisherId:'fixture-managing-authority',sourceId,municipalityId:'ratzeburg',ags:'01053100',tenant:null,observationWindow:'fixture-window'};}
const headers=['Vorhabennummer','Name des Begünstigten','Bezeichnung des Vorhabens','Fonds','Förderfähige Gesamtkosten','EU-Kofinanzierungssatz','Beginn des Vorhabens','Ende des Vorhabens','Standort des Vorhabens','Sitz des Begünstigten','AGS des Vorhabens','AGS des Begünstigten','Rechtsstatus des Begünstigten','CCI','Förderperiode','Verwaltungsbehörde','Status','Datenstand','Veröffentlicht am','Beschreibung des Vorhabens','Kontakt','Straße'];
const values=['00042','Fixture Förderverein','Fixture Investition','EFRE','1.234,56','50','01.01.2025','31.12.2027','Ratzeburg','Hamburg','01053100','02000000','juristische Person','TEST-CCI','2021-2027','Fixture Verwaltungsbehörde','bewilligt','31.08.2026','01.09.2026','private contact: Erika Muster, person@example.invalid','Erika Muster','Privatstraße 1'];
function csv(rows:string[][]):string {return rows.map(row=>row.map(v=>'"'+v.replace(/"/g,'""')+'"').join(';')).join('\r\n')+'\r\n';}
function zip(entries:Record<string,string>):Uint8Array {
 const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
 for(const [path,text] of Object.entries(entries)){const name=Buffer.from(path),bytes=Buffer.from(text);let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}crc=(crc^0xffffffff)>>>0;
  const l=Buffer.alloc(30);l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt32LE(crc,14);l.writeUInt32LE(bytes.length,18);l.writeUInt32LE(bytes.length,22);l.writeUInt16LE(name.length,26);
  const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc,16);c.writeUInt32LE(bytes.length,20);c.writeUInt32LE(bytes.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);local.push(l,name,bytes);central.push(c,name);offset+=l.length+name.length+bytes.length;
 }const dir=Buffer.concat(central),e=Buffer.alloc(22);e.writeUInt32LE(0x06054b50);e.writeUInt16LE(Object.keys(entries).length,8);e.writeUInt16LE(Object.keys(entries).length,10);e.writeUInt32LE(dir.length,12);e.writeUInt32LE(offset,16);return Buffer.concat([...local,dir,e]);
}
function escape(raw:string):string {return raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function xlsx(rows:Array<Array<string|number>>,codes=false,settings:{styles?:Record<string,number>;customFormats?:Record<string,string>;date1904?:boolean;columnDefaults?:Array<{min:number;max:number;format:number}>;rowDefaults?:Record<number,number>}={}):Uint8Array {
 const formatIds=[...new Set([0,...Object.values(settings.styles??{}),...(settings.columnDefaults??[]).map(c=>c.format),...Object.values(settings.rowDefaults??{})])];
 const cols=settings.columnDefaults?'<cols>'+settings.columnDefaults.map(c=>`<col min="${c.min}" max="${c.max}" style="${formatIds.indexOf(c.format)}"/>`).join('')+'</cols>':'';
 const sheet=(rows:Array<Array<string|number>>)=>'<worksheet>'+cols+'<sheetData>'+rows.map((row,ri)=>{const rowFormat=settings.rowDefaults?.[ri+1],rowStyle=rowFormat===undefined?'':` s="${formatIds.indexOf(rowFormat)}" customFormat="1"`;return `<row r="${ri+1}"${rowStyle}>`+row.map((v,ci)=>{const address=columnName(ci)+(ri+1),format=settings.styles?.[address],style=format===undefined?'':` s="${formatIds.indexOf(format)}"`;return typeof v==='number'?`<c r="${address}"${style}><v>${v}</v></c>`:`<c r="${address}"${style} t="inlineStr"><is><t>${escape(v)}</t></is></c>`;}).join('')+'</row>';}).join('')+'</sheetData></worksheet>';
 const entries:Record<string,string>={'[Content_Types].xml':'<Types/>','xl/workbook.xml':`<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${settings.date1904?'<workbookPr date1904="1"/>':''}<sheets><sheet name="Vorhaben" r:id="rId1"/>${codes?'<sheet name="Codes" r:id="rId2"/>':''}</sheets></workbook>`,'xl/_rels/workbook.xml.rels':`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>${codes?'<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>':''}</Relationships>`,'xl/worksheets/sheet1.xml':sheet(rows)};
 if(settings.styles||settings.columnDefaults||settings.rowDefaults)entries['xl/styles.xml']='<styleSheet><numFmts>'+Object.entries(settings.customFormats??{}).map(([id,code])=>`<numFmt numFmtId="${id}" formatCode="${escape(code)}"/>`).join('')+'</numFmts><cellXfs>'+formatIds.map(id=>`<xf numFmtId="${id}"/>`).join('')+'</cellXfs></styleSheet>';
 if(codes)entries['xl/worksheets/sheet2.xml']=sheet([['Code','Bezeichnung'],['001','Fixture Interventionskategorie']]);return zip(entries);
}
function operationSnapshot(sourceId:string,rows:string[][]=[headers,values]):AdmittedSnapshot {
 const p=FUNDING_DISTRIBUTIONS[sourceId];return snapshot(p.format==='xlsx'?xlsx(rows):csv(rows),p.landing,p.format==='xlsx'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'text/csv; charset=utf-8');
}
test('SH EFRE native CSV emits byte-bound approval observations, not paid amounts or completion',()=>{
 const s=operationSnapshot('funding-sh-efre-beneficiaries'),r=parseFundingOperations(s,scope());assert.equal(r.coverage.state,'partial');assert.equal(r.coverage.observedRows,1);assert.ok(r.observations.length>0);
 for(const o of r.observations){assert.ok(ObservationSchema.safeParse(o).success);assert.equal(o.nativeId,'00042');assert.equal(o.nativeVersion,'fixture-v1');assert.equal(o.sourceReferenceDate,'2026-08-31');assert.equal(o.publishedAt,'2026-09-01');assert.equal(o.retrievedAt,'2026-10-11T00:00:00Z');assert.ok(o.evidence.every(e=>e.sourceSha256===s.sourceSha256&&e.format==='csv'));}
 const cost=r.observations.find(o=>o.predicate==='approved_eligible_cost')!;assert.equal(cost.value,'1234.56');assert.equal(cost.financialRole,'approval');assert.equal(cost.unit,'EUR');assert.ok(cost.evidence.some(e=>e.rawValue==='1.234,56'));assert.ok(cost.evidence.some(e=>e.rawValue==='Förderfähige Gesamtkosten'));
 assert.ok(r.observations.every(o=>o.financialRole!=='payment'&&!/completed|implements|commissioned/.test(o.predicate)));assert.ok(!JSON.stringify(r).includes('Erika Muster'));assert.ok(!JSON.stringify(r).includes('Privatstraße'));
 const programme=JSON.parse(String(r.observations.find(o=>o.predicate==='programme')!.value));assert.deepEqual([programme.authority,programme.fund,programme.period,programme.code],['Fixture Verwaltungsbehörde','EFRE','2021-2027','TEST-CCI']);
 const site=r.observations.find(o=>o.predicate==='project_location')!,office=r.observations.find(o=>o.predicate==='beneficiary_office')!;assert.deepEqual(site.geography,{ags:'01053100',basis:'source_explicit',role:'project_location'});assert.deepEqual(office.geography,{ags:'02000000',basis:'source_explicit',role:'beneficiary_office'});
 assert.deepEqual(parseFundingOperations(s,scope()),r);
});
test('all four current workbook source routes parse native OOXML and retain exact cell evidence',()=>{
 for(const sourceId of ['funding-bb-efre-jtf-beneficiaries','funding-bb-esf-beneficiaries','funding-mv-efre-beneficiaries','funding-mv-esf-beneficiaries']){
  const row=[...values];row[3]=FUNDING_DISTRIBUTIONS[sourceId].funds[0];const s=operationSnapshot(sourceId,[headers,row]),r=parseFundingOperations(s,scope(sourceId));assert.ok(r.observations.length>0,sourceId);assert.ok(r.observations.every(o=>o.evidence.every(e=>e.format==='xlsx'&&e.sheet==='Vorhaben')));assert.equal(r.coverage.state,'partial');
 }
});
test('BB combined list distinguishes JTF, Excel numeric dates, native code sheets and absent programme code',()=>{
 const row:Array<string|number>=[...values];row[3]='JTF';row[4]=1234.56;row[6]=1;row[7]=61;row[13]='';const sourceId='funding-bb-efre-jtf-beneficiaries';const r=parseFundingOperations(snapshot(xlsx([headers,row],true,{styles:{G2:14,H2:14}}),FUNDING_DISTRIBUTIONS[sourceId].landing,'application/zip'),scope(sourceId));
 assert.equal(r.observations.find(o=>o.predicate==='operation_start')!.date,'1900-01-01');assert.equal(r.observations.find(o=>o.predicate==='operation_end')!.date,'1900-03-01');const p=JSON.parse(String(r.observations.find(o=>o.predicate==='programme')!.value));assert.equal(p.fund,'JTF');assert.equal(p.code,null);assert.match(p.identityBasis,/incomplete/);assert.equal(r.observations.filter(o=>o.kind==='FundingCodeDefinition').length,1);assert.equal(r.observations.find(o=>o.kind==='FundingCodeDefinition')!.evidence[0].rawValue,'001');
});
test('empty native lists differ from missing/changed/aggregate schemas; unchanged-byte parse is deterministic',()=>{
 const empty=parseFundingOperations(operationSnapshot('funding-sh-efre-beneficiaries',[headers]),scope());assert.equal(empty.coverage.state,'empty');assert.equal(empty.observations.length,0);
 for(const rows of [[['Programme','Budget'],['EFRE','1000000']],[[...headers].map(h=>h==='Vorhabennummer'?'UNKNOWN-SCHEMA':h),values]]){const r=parseFundingOperations(operationSnapshot('funding-sh-efre-beneficiaries',rows),scope());assert.equal(r.coverage.state,'held_quality');assert.equal(r.observations.length,0);}
 const reordered=[...headers].reverse(),reverse=[...values].reverse();assert.ok(parseFundingOperations(operationSnapshot('funding-sh-efre-beneficiaries',[reordered,reverse]),scope()).observations.length>0);
});
test('successor/code-sheet links are discovered from admitted landings without filename/date guessing',()=>{
 const sourceId='funding-mv-efre-beneficiaries',url=FUNDING_DISTRIBUTIONS[sourceId].landing;const s=snapshot('<a href="/serviceassistent/download?id=NEXT-ID">Liste der Vorhaben 2021–2027</a><a href="/codes.xlsx">Erläuterungen der Codes</a><a href="/old.xlsx">Liste der Vorhaben 2014–2020</a><a href="/monitor.pdf">Art.42 Finanzbericht</a><a href="https://evil.invalid/list.xlsx">Liste der Vorhaben</a><a rel="next" href="?page=2">Weiter</a>',url,'text/html');const r=discoverFundingOperations(s,scope(sourceId));assert.equal(r.coverage.state,'partial');assert.equal(r.coverage.nextCursor,url+'?page=2');assert.ok(r.resources.some(x=>x.url.endsWith('id=NEXT-ID')&&x.format==='xlsx'));assert.ok(r.resources.some(x=>x.url.endsWith('codes.xlsx')));assert.ok(!r.resources.some(x=>/old|monitor|evil/.test(x.url)));assert.ok(r.resources.every(x=>x.parentId===url));assert.equal(discoverFundingOperations(s,scope(sourceId),'different-page').coverage.state,'held_quality');
 const e=discoverFundingOperations(snapshot('<p>Keine verknüpften Listen</p>',url,'text/html'),scope(sourceId));assert.equal(e.coverage.state,'empty');assert.ok(!JSON.stringify(e).includes('withdrawn'));
});
test('explicit withdrawal is a tombstone only; partial disappearance never manufactures one',()=>{
 const row=[...values];row[16]='widerrufen';row[1]='';row[12]='';const r=parseFundingOperations(operationSnapshot('funding-sh-efre-beneficiaries',[headers,row]),scope());assert.equal(r.observations.length,1);assert.equal(r.observations[0].predicate,'source_status');assert.equal(r.observations[0].value,'withdrawn');assert.equal(r.observations[0].financialRole,'none');
});
test('malformed amount/date/AGS, mixed fund ambiguity, duplicate IDs and conflicting period hold whole rows',()=>{
 for(const [index,value] of [[4,'1,23,45'],[6,'31.02.2026'],[10,'1053100'],[14,'2014-2020']] as Array<[number,string]>){const row=[...values];row[index]=value;const r=parseFundingOperations(operationSnapshot('funding-sh-efre-beneficiaries',[headers,row]),scope());assert.equal(r.coverage.state,'held_quality');assert.equal(r.observations.length,0);}
 const duplicates=parseFundingOperations(operationSnapshot('funding-sh-efre-beneficiaries',[headers,values,[...values]]),scope());assert.equal(duplicates.coverage.state,'held_quality');assert.equal(duplicates.observations.length,0);
 const mixed=[...values];mixed[3]='';assert.equal(parseFundingOperations(operationSnapshot('funding-bb-efre-jtf-beneficiaries',[headers,mixed]),scope('funding-bb-efre-jtf-beneficiaries')).observations.length,0);
});
test('unqualified recipient names and generic public-body words remain held',()=>{
 for(const status of ['natürliche Person','','unknown']){const row=[...values];row[1]='Stadt Beispiel';row[12]=status;const r=parseFundingOperations(operationSnapshot('funding-sh-efre-beneficiaries',[headers,row]),scope());assert.equal(r.coverage.state,'held_quality');assert.equal(r.observations.length,0);assert.ok(!JSON.stringify(r).includes('Stadt Beispiel'));}
});
test('SH ESF is honestly PDF-held even if caller supplies an older spreadsheet',()=>{
 const sourceId='funding-sh-esf-beneficiaries',s=snapshot('%PDF-1.7\nFixture with merged/misaligned text columns',FUNDING_DISTRIBUTIONS[sourceId].landing,'application/pdf');const r=parseFundingOperations(s,scope(sourceId));assert.equal(r.coverage.state,'held_quality');assert.equal(r.observations.length,0);assert.match(r.coverage.reason,/PDF/);assert.equal(discoverFundingOperations(s,scope(sourceId)).resources[0].format,'pdf');assert.equal(parseFundingOperations(snapshot(xlsx([headers,values]),s.url,'application/zip'),scope(sourceId)).observations.length,0);
});
const bleHeaders=['Begünstigtennummer','Name des Begünstigten','Rechtsstatus des Begünstigten','Fonds','Agrar-Haushaltsjahr','Maßnahmencode','ELER-Zahlungen (EUR)','Nationale Kofinanzierungszahlungen (EUR)','Gemeinde','AGS des Begünstigten','Straße','Kontakt'];
const bleValues=['B-0001','Fixture Körperschaft','juristische Person','ELER','2024/2025','M-TEST','2.345,67','123,45','Ratzeburg','01053100','Privatstraße 2','Private Person'];
test('BLE native disclosure amounts are agricultural-year ELER payments, not project approvals/sites',()=>{
 const sourceId='funding-eler-ble-beneficiaries',s=snapshot(csv([bleHeaders,bleValues]),'https://www.agrarzahlungen.de/agrarfonds/fixture.csv','text/csv'),r=parseFundingOperations(s,scope(sourceId));const amount=r.observations.find(o=>o.predicate==='eler_payment')!;assert.equal(amount.value,'2345.67');assert.equal(amount.financialRole,'payment');assert.equal(amount.date,'2025-10-15');assert.equal(amount.dateRole,'agricultural_financial_year_end');assert.equal(amount.sourceReferenceDate,null);assert.ok(!r.observations.some(o=>o.predicate==='project_location'||o.kind==='FundingOperation'));assert.equal(r.observations.find(o=>o.predicate==='beneficiary_office')!.geography.role,'beneficiary_office');assert.ok(!JSON.stringify(r).includes('Privatstraße'));assert.ok(!JSON.stringify(r).includes('Private Person'));
 const egfl=[...bleValues];egfl[3]='EGFL';assert.equal(parseFundingOperations(snapshot(csv([bleHeaders,egfl]),s.url,s.mimeType),scope(sourceId)).observations.length,0);
 const year=[...bleValues];year[4]='2025';assert.equal(parseFundingOperations(snapshot(csv([bleHeaders,year]),s.url,s.mimeType),scope(sourceId)).coverage.state,'held_quality');
});
test('BLE native HTML table pagination remains partial and merged layouts are held',()=>{
 const sourceId='funding-eler-ble-beneficiaries',body='<table><tr>'+bleHeaders.map(v=>'<th>'+escape(v)+'</th>').join('')+'</tr><tr>'+bleValues.map(v=>'<td>'+escape(v)+'</td>').join('')+'</tr></table><a rel="next" href="?seite=2">Weiter</a>',s=snapshot(body,'https://www.agrarzahlungen.de/agrarfonds/suche','text/html'),r=parseFundingOperations(s,scope(sourceId));assert.equal(r.coverage.state,'partial');assert.equal(r.coverage.nextCursor,s.url+'?seite=2');assert.ok(r.observations.length>0);assert.ok(r.observations.every(o=>o.evidence.every(e=>e.format==='html')));assert.equal(parseFundingOperations(snapshot(body.replace('<td>','<td colspan="2">'),s.url,'text/html'),scope(sourceId)).coverage.state,'held_quality');
});
test('access challenges are separate from empty/schema holds; evidence binding fails closed',()=>{
 const sourceId='funding-eler-ble-beneficiaries',s=snapshot('<title>Access denied CAPTCHA</title>','https://www.agrarzahlungen.de/agrarfonds/suche','text/html');assert.equal(parseFundingOperations(s,scope(sourceId)).coverage.state,'blocked_access');assert.equal(discoverFundingOperations(s,scope(sourceId)).coverage.state,'blocked_access');assert.throws(()=>parseFundingOperations({...s,sourceSha256:'0'.repeat(64)},scope(sourceId)),/binding/);assert.throws(()=>parseFundingOperations({...s,policyReceiptSha256:'invalid'},scope(sourceId)));
});
test('source version changes observations, not native operation subject; capability receipt never claims live admission',()=>{
 const s=operationSnapshot('funding-sh-efre-beneficiaries'),a=parseFundingOperations(s,scope()),b=parseFundingOperations({...s,sourceVersion:'corrected-v2'},scope());assert.deepEqual(a.observations.map(o=>o.subject),b.observations.map(o=>o.subject));assert.notDeepEqual(a.observations.map(o=>o.id),b.observations.map(o=>o.id));const receipt=fundingCapabilityReceipt();assert.equal(receipt.distributions.length,7);assert.equal(receipt.productionState,'held_origin');assert.equal(receipt.distributions.find(d=>d.sourceId==='funding-sh-esf-beneficiaries')!.state,'held_quality');assert.equal(receipt.distributions.find(d=>d.sourceId==='funding-eler-ble-beneficiaries')!.state,'blocked_access');assert.equal(fundingOperationsAdapter.id,'funding-operations');
});
test('eligible and total approved costs remain separate when both source columns exist',()=>{
 const s=operationSnapshot('funding-sh-efre-beneficiaries',[[...headers,'Gesamtkosten des Vorhabens'],[...values,'2.000,00']]),r=parseFundingOperations(s,scope());
 assert.equal(r.observations.find(o=>o.predicate==='approved_eligible_cost')!.value,'1234.56');assert.equal(r.observations.find(o=>o.predicate==='approved_total_cost')!.value,'2000');assert.ok(r.observations.every(o=>o.financialRole!=='payment'));
});
test('only approved complete terminal legal-form assertions in native beneficiary field admit source-scoped mentions',()=>{
 for(const suffix of ['GmbH','gGmbH','GmbH & Co. KG','UG (haftungsbeschränkt)','UG (haftungsbeschränkt) & Co. KG','e.V.','e. V.','eG','KdöR','KöR','AöR']){
  const row=[...values];row[1]='Fixture Organisation '+suffix;const nativeHeaders=headers.filter((_,i)=>i!==12),nativeRow=row.filter((_,i)=>i!==12);
  const r=parseFundingOperations(operationSnapshot('funding-sh-efre-beneficiaries',[nativeHeaders,nativeRow]),scope());assert.ok(r.observations.length>0,suffix);
  const basis=r.observations.find(o=>o.predicate==='recipient_type_basis')!;assert.equal(basis.value,'source_asserted_legal_form');assert.ok(basis.evidence.some(e=>e.rawValue===row[1]));assert.ok(basis.limitations.some(l=>l.includes('not legal identity')));assert.equal(basis.geography.ags,null);
 }
 for(const name of ['Fixture AG','Fixture KG','Fixture OHG','Fixture SE','Stadt Ratzeburg','Firma BeispielGmbH','Anna Person','Fixture GmbH in Gründung']){
  const row=[...values];row[1]=name;row[12]='';row[2]='Title GmbH';const r=parseFundingOperations(operationSnapshot('funding-sh-efre-beneficiaries',[headers,row]),scope());assert.equal(r.observations.length,0,name);
 }
 for(const status of ['natürliche Person','Privatperson','Einzelperson','natural person','nicht juristische Person']){
  const row=[...values];row[1]='Fixture GmbH';row[12]=status;assert.equal(parseFundingOperations(operationSnapshot('funding-sh-efre-beneficiaries',[headers,row]),scope()).observations.length,0,status);
 }
});
test('same-row explicit operation AGS follows amounts/dates/programme/recipient relationships with source evidence',()=>{
 const r=parseFundingOperations(operationSnapshot('funding-sh-efre-beneficiaries'),scope());
 for(const predicate of ['approved_eligible_cost','eu_cofinancing_rate','operation_start','operation_end','programme','supported_by','awarded_to']){
  const fact=r.observations.find(o=>o.predicate===predicate)!;assert.deepEqual(fact.geography,{ags:'01053100',basis:'source_explicit',role:'project_location'},predicate);
  assert.ok(fact.evidence.some(e=>e.rawValue==='01053100'&&e.rowKey==='2'),predicate);assert.ok(fact.evidence.some(e=>e.rawValue==='AGS des Vorhabens'),predicate);
 }
 assert.equal(r.observations.find(o=>o.predicate==='beneficiary_name')!.geography.ags,null);assert.equal(r.observations.find(o=>o.predicate==='beneficiary_office')!.geography.ags,'02000000');
});
test('office-only AGS, scope AGS and NUTS indicators never localize operation financial facts',()=>{
 const row=[...values];row[8]='DE409';row[10]='';const r=parseFundingOperations(operationSnapshot('funding-sh-efre-beneficiaries',[headers,row]),scope());
 for(const predicate of ['approved_eligible_cost','operation_start','programme','supported_by','awarded_to'])assert.deepEqual(r.observations.find(o=>o.predicate===predicate)!.geography,{ags:null,basis:'unknown',role:'unknown'},predicate);
 assert.deepEqual(r.observations.find(o=>o.predicate==='project_location')!.geography,{ags:null,basis:'unknown',role:'project_location'});
 assert.deepEqual(r.observations.find(o=>o.predicate==='beneficiary_office')!.geography,{ags:'02000000',basis:'source_explicit',role:'beneficiary_office'});
});
test('native percent styles scale exact numeric values with raw style receipts, never magnitude/header heuristics',()=>{
 const sourceId='funding-bb-efre-jtf-beneficiaries',url=FUNDING_DISTRIBUTIONS[sourceId].landing;
 for(const [id,code,input,expected] of [[9,null,0.6,'60'],[10,null,3.5,'350'],[164,'0.00%',0.006,'0.6'],[165,'0.00"%"',0.6,'0.6'],[166,'0.00\\%',0.6,'0.6'],[0,null,0.6,'0.6']] as Array<[number,string|null,number,string]>){
  const nativeHeaders=[...headers],row:Array<string|number>=[...values];nativeHeaders[5]='EU-Kofinanzierungssatz (in %)';row[5]=input;
  const bytes=xlsx([nativeHeaders,row],false,{styles:{F2:id},customFormats:code===null?{}:{[id]:code}}),r=parseFundingOperations(snapshot(bytes,url,'application/zip'),scope(sourceId)),rate=r.observations.find(o=>o.predicate==='eu_cofinancing_rate')!;
  assert.equal(rate.value,expected,id+':'+code);assert.equal(rate.unit,'percent');assert.ok(rate.evidence.some(e=>e.rawValue===String(input)));assert.ok(rate.supportingEvidence.some(e=>e.role==='source_metadata'&&e.locator.path.includes('numFmtId')&&e.locator.rawValue===String(id)));
  assert.ok(rate.supportingEvidence.every(e=>e.locator.sourceSha256===digest(bytes)&&e.locator.cells.length===0&&e.locator.sheet===null));if(code!==null)assert.ok(rate.supportingEvidence.some(e=>e.locator.path.endsWith('/@formatCode')&&e.locator.rawValue===code));
 }
 const nativeHeaders=[...headers],row=[...values];nativeHeaders[5]='EU-Kofinanzierungssatz (in %)';row[5]='0,6';const csvResult=parseFundingOperations(operationSnapshot('funding-sh-efre-beneficiaries',[nativeHeaders,row]),scope());assert.equal(csvResult.observations.find(o=>o.predicate==='eu_cofinancing_rate')!.value,'0.6');
});
test('numeric date columns require true native date style and bind workbook epoch, General numeric year is held',()=>{
 const sourceId='funding-bb-efre-jtf-beneficiaries',url=FUNDING_DISTRIBUTIONS[sourceId].landing,row:Array<string|number>=[...values];row[6]=2026;
 const general=parseFundingOperations(snapshot(xlsx([headers,row]),url,'application/zip'),scope(sourceId));assert.equal(general.coverage.state,'held_quality');assert.equal(general.observations.length,0);
 row[6]=1;const r=parseFundingOperations(snapshot(xlsx([headers,row],false,{styles:{G2:14},date1904:true}),url,'application/zip'),scope(sourceId)),date=r.observations.find(o=>o.predicate==='operation_start')!;
 assert.equal(date.date,'1904-01-02');assert.ok(date.supportingEvidence.some(e=>e.locator.path.endsWith('/@date1904')&&e.locator.rawValue==='1'));assert.ok(date.supportingEvidence.some(e=>e.locator.path.endsWith('/@numFmtId')&&e.locator.rawValue==='14'));
 row[4]=0.6;assert.equal(parseFundingOperations(snapshot(xlsx([headers,row],false,{styles:{G2:14,E2:9}}),url,'application/zip'),scope(sourceId)).observations.length,0);
});
test('funding inherits native row/column percent and date styles with whole-archive selection receipts',()=>{
 const sourceId='funding-bb-efre-jtf-beneficiaries',url=FUNDING_DISTRIBUTIONS[sourceId].landing,row:Array<string|number>=[...values];row[5]=0.6;
 for(const settings of [{columnDefaults:[{min:6,max:6,format:9}]},{rowDefaults:{2:9}}]){
  const bytes=xlsx([headers,row],false,settings),r=parseFundingOperations(snapshot(bytes,url,'application/zip'),scope(sourceId)),rate=r.observations.find(o=>o.predicate==='eu_cofinancing_rate')!;
  assert.equal(rate.value,'60');assert.equal(rate.unit,'percent');assert.ok(rate.evidence.some(e=>e.rawValue==='0.6'));assert.ok(rate.supportingEvidence.every(e=>e.locator.sourceSha256===digest(bytes)));
  assert.ok(rate.supportingEvidence.some(e=>e.locator.path.includes('/cols/col[')||e.locator.path.endsWith('/@customFormat')));assert.equal(fundingCapabilityReceipt().nativeNumberFormatVersion,'native-number-format-v2');
 }
 row[6]=1;row[7]=61;const bytes=xlsx([headers,row],false,{columnDefaults:[{min:6,max:6,format:9},{min:7,max:8,format:14}]}),r=parseFundingOperations(snapshot(bytes,url,'application/zip'),scope(sourceId)),start=r.observations.find(o=>o.predicate==='operation_start')!;
 assert.equal(start.date,'1900-01-01');assert.ok(start.supportingEvidence.some(e=>e.locator.path.includes('/cols/col[2]/@style')));assert.ok(start.supportingEvidence.some(e=>e.locator.path.endsWith('/@date1904')));
 const explicitGeneral=parseFundingOperations(snapshot(xlsx([headers,row],false,{styles:{G2:0},columnDefaults:[{min:7,max:8,format:14}]}),url,'application/zip'),scope(sourceId));assert.equal(explicitGeneral.coverage.state,'held_quality');assert.equal(explicitGeneral.observations.length,0);
});
test('independently held rows yield honest partial coverage while retaining fully proven municipal operation rows',()=>{
 const unqualified=[...values];unqualified[0]='00043';unqualified[1]='PRIVATE RECIPIENT';unqualified[12]='natürliche Person';
 const s=operationSnapshot('funding-sh-efre-beneficiaries',[headers,values,unqualified]),r=parseFundingOperations(s,scope());
 assert.equal(r.coverage.state,'partial');assert.equal(r.coverage.observedRows,2);assert.match(r.coverage.reason,/1 row\(s\) held/);assert.ok(r.coverage.limitations.some(l=>l.includes('Independently held rows: 1')));assert.ok(r.observations.length>0);
 assert.ok(r.observations.every(o=>o.nativeId==='00042'&&o.evidence.every(e=>e.sourceSha256===s.sourceSha256)));assert.ok(!JSON.stringify(r).includes('PRIVATE RECIPIENT'));assert.ok(!r.observations.some(o=>o.nativeId==='00043'));
 assert.deepEqual(r.observations.find(o=>o.predicate==='approved_eligible_cost')!.geography,{ags:'01053100',basis:'source_explicit',role:'project_location'});assert.equal(r.observations.find(o=>o.predicate==='approved_eligible_cost')!.financialRole,'approval');assert.ok(r.observations.some(o=>o.predicate==='awarded_to'));assert.ok(r.observations.every(o=>o.financialRole!=='payment'));
});
test('duplicate native keys hold every ambiguous occurrence without withholding independent valid rows',()=>{
 const other=[...values];other[0]='00044';const r=parseFundingOperations(operationSnapshot('funding-sh-efre-beneficiaries',[headers,values,[...values],other]),scope());
 assert.equal(r.coverage.state,'partial');assert.match(r.coverage.reason,/2 row\(s\) held/);assert.ok(r.observations.length>0);assert.ok(r.observations.every(o=>o.nativeId==='00044'));
});
test('whole-file schema ambiguity still holds every row rather than partially admitting earlier data',()=>{
 const ambiguousHeaders=[...headers,'Vorhaben-ID'];const r=parseFundingOperations(operationSnapshot('funding-sh-efre-beneficiaries',[ambiguousHeaders,[...values,'00042']]),scope());
 assert.equal(r.coverage.state,'held_quality');assert.equal(r.observations.length,0);assert.match(r.coverage.reason,/Ambiguous duplicate semantic column/);
});
