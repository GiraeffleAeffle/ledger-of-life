import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {digest,type AdapterScope,type AdmittedSnapshot} from '../src/district-adapter-contract.ts';
import {createStateStatisticsAdapter,stateStatisticsAdapter} from '../src/adapters/state-statistics.ts';
const scope:AdapterScope={publisherId:'statistik-nord',sourceId:'statistics-nord-schleswig-holstein-finance',municipalityId:'ratzeburg',ags:'01053100',tenant:null,observationWindow:'2026-10'};
function snapshot(text:string,mimeType='text/csv'):AdmittedSnapshot {const bytes=new TextEncoder().encode(text);return {bytes,sourceSha256:digest(bytes),url:'https://www.statistik-nord.de/example.csv',mimeType,retrievedAt:'2026-10-11T00:00:00Z',policyReceiptSha256:digest('fixture-policy'),sourceVersion:'fixture'};}
const adapter=createStateStatisticsAdapter({rights:'admitted',pageSize:1});
// Constructed native fixtures, not downloaded publisher rows or proof of their schemas.
describe('state finance native snapshots',()=>{
 it('preserves leading-zero AGS, raw cells, debt stock date and core scope',()=>{
  const result=adapter.parse(snapshot('Gemeindeschlüssel;Schulden Kernhaushalte 2025 EUR\n01053100;1234\n01053;9876\n'),scope);
  assert.equal(result.observations.length,1);const value=result.observations[0];
  assert.equal(value.geography.ags,'01053100');assert.equal(value.date,'2025-12-31');assert.equal(value.dateRole,'stock_reference_date');assert.ok(value.subject.endsWith(':core'));assert.equal(value.value,1234);assert.equal(value.financialRole,'none');assert.equal(value.evidence.at(-1)?.rawValue,'1234');assert.equal(result.coverage.state,'partial');
 });
 it('maps BB tax rates, not appropriations',()=>{
  const bb={...scope,sourceId:'statistics-berlin-brandenburg-finance',ags:'12064227'};
  const result=adapter.parse(snapshot('Gemeindeschlüssel;Gewerbesteuer Hebesatz 2025 %\n12064227;350\n'),bb);
  assert.equal(result.observations[0]?.predicate,'trade_tax_rate');assert.equal(result.observations[0]?.unit,'%');assert.ok(result.observations[0]?.subject.endsWith(':tax_statistics'));
 });
 it('distinguishes MV cumulative cash quarters from annual accounts',()=>{
  const mv={...scope,sourceId:'statistics-mv-laiv-finance',ags:'13076060'};
  const result=adapter.parse(snapshot('L223 Kassenstatistik Kernhaushalte 2025 2. Quartal\nGemeindeschlüssel;Einzahlungen EUR\n13076060;12,5\n'),mv);
  assert.equal(result.observations[0]?.date,'2025-06-30');assert.equal(result.observations[0]?.dateRole,'cumulative_cash_period_end');assert.equal(result.observations[0]?.value,12.5);
 });
 it('keeps special and consolidated scopes explicit',()=>{
  for(const budget of ['Sondervermögen','konsolidierter Gesamthaushalt']){
   const result=adapter.parse(snapshot(`Gemeindeschlüssel;Schulden ${budget} 2025 EUR\n01053100;12\n`),scope);
   assert.ok(result.observations[0]?.subject.endsWith(budget==='Sondervermögen'?':special':':consolidated'));
  }
 });
 it('does not leak units or budget scopes between mixed columns',()=>{
  const result=adapter.parse(snapshot('Gemeindeschlüssel;Schulden Kernhaushalte 2025 EUR;Schulden konsolidierter Gesamthaushalt 2025 EUR je Einwohner;Schulden Sondervermögen 2025 1 000 EUR\n01053100;1000;12,5;7\n'),scope);
  assert.deepEqual(result.observations.map(value=>[value.unit,value.subject.split(':').at(-1)]),[['EUR','core'],['EUR/person','consolidated'],['1000 EUR','special']]);
 });
 it('holds a column with unknown or conflicting unit and scope despite siblings',()=>{
  const result=adapter.parse(snapshot('Gemeindeschlüssel;Schulden Kernhaushalte 2025 EUR;Schulden Kernhaushalte 2025;Schulden 2025 EUR;Schulden Kernhaushalte Sondervermögen 2025 EUR;Schulden Kernhaushalte 2025 EUR und EUR je Einwohner\n01053100;1;2;3;4;5\n'),scope);
  assert.equal(result.observations.length,1);assert.equal(result.observations[0]?.value,1);
 });
 it('uses unambiguous one-cell table titles without overriding explicit column units',()=>{
  const result=adapter.parse(snapshot('Kernhaushalte 2025 1 000 EUR\nGemeindeschlüssel;Schulden;Schulden EUR je Einwohner\n01053100;9;2,5\n'),scope);
  assert.deepEqual(result.observations.map(value=>value.unit),['1000 EUR','EUR/person']);
  assert.equal(adapter.parse(snapshot('Kernhaushalte 2025 EUR und EUR je Einwohner\nGemeindeschlüssel;Schulden\n01053100;9\n'),scope).coverage.state,'held_quality');
 });
 it('never distributes district totals or repairs truncated IDs',()=>{
  assert.deepEqual(adapter.parse(snapshot('Gemeindeschlüssel;Schulden Kernhaushalte 2025 EUR\n01053;1234\n1053100;5678\n'),scope).observations,[]);
 });
 it('holds changed schemas, missing or ambiguous dates/scopes, and suppression',()=>{
  for(const header of ['Unknown metric 2025 EUR','Schulden Kernhaushalte EUR','Schulden 2025 EUR','Schulden Kernhaushalte 2024 2025 EUR'])assert.equal(adapter.parse(snapshot(`Gemeindeschlüssel;${header}\n01053100;12\n`),scope).coverage.state,'held_quality');
  assert.deepEqual(adapter.parse(snapshot('Gemeindeschlüssel;Schulden Kernhaushalte 2025 EUR\n01053100;/\n'),scope).observations,[]);
 });
 it('distinguishes empty, blocked, withdrawn and rights holds',()=>{
  assert.equal(adapter.parse(snapshot(''),scope).coverage.state,'empty');assert.equal(adapter.parse(snapshot('Access denied'),scope).coverage.state,'blocked_access');assert.equal(adapter.parse(snapshot('Bericht zurückgezogen'),scope).coverage.state,'partial');assert.equal(stateStatisticsAdapter.parse(snapshot('anything'),scope).coverage.state,'held_origin');
 });
 it('paginates advertised native links only',()=>{
  const page=snapshot('<a href="/a.xlsx">XLSX</a><a href="/b.csv">CSV</a>','text/html');const first=adapter.discover(page,scope,null);
  assert.equal(first.resources.length,1);assert.equal(first.coverage.nextCursor,'1');const second=adapter.discover(page,scope,first.coverage.nextCursor);assert.equal(second.resources[0]?.url,'https://www.statistik-nord.de/b.csv');assert.equal(second.coverage.nextCursor,null);assert.equal(adapter.discover(snapshot('<p>No files</p>','text/html'),scope,null).coverage.state,'empty');
 });
 it('rejects corrupted binding and malformed workbooks',()=>{
  const changed=snapshot('data');changed.sourceSha256=digest('different');assert.throws(()=>adapter.parse(changed,scope),/binding/);assert.equal(adapter.parse(snapshot('PKnot-a-workbook','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),scope).coverage.state,'held_quality');
 });
});
function workbookSnapshot(sheetXml:string,stylesXml?:string):AdmittedSnapshot {
 const files:Record<string,string>={
  '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  'xl/workbook.xml':'<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Debt" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml':sheetXml,
 };
 if(stylesXml)files['xl/styles.xml']=stylesXml;
 const locals:Buffer[]=[],central:Buffer[]=[];let offset=0;
 for(const [name,text] of Object.entries(files)){
  const path=Buffer.from(name),data=Buffer.from(text);let crc=0xffffffff;
  for(const byte of data){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc&1)?0xedb88320^(crc>>>1):crc>>>1;}crc=(crc^0xffffffff)>>>0;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(path.length,26);
  const directory=Buffer.alloc(46);directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt32LE(crc,16);directory.writeUInt32LE(data.length,20);directory.writeUInt32LE(data.length,24);directory.writeUInt16LE(path.length,28);directory.writeUInt32LE(offset,42);
  locals.push(local,path,data);central.push(directory,path);offset+=local.length+path.length+data.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 const bytes=Buffer.concat([...locals,directory,end]);return {...snapshot(''),bytes,sourceSha256:digest(bytes),mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
}
it('parses sparse native OOXML cells retaining coordinates and numeric lexemes',()=>{
 const input=workbookSnapshot('<worksheet><sheetData><row r="2"><c r="A2" t="inlineStr"><is><t>Gemeindeschlüssel</t></is></c><c r="C2" t="inlineStr"><is><t>Schulden Kernhaushalte 2025 EUR</t></is></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>01053100</t></is></c><c r="C4"><v>1.25E3</v></c></row></sheetData></worksheet>');
 const parsed=adapter.parse(input,scope);assert.equal(parsed.observations[0]?.value,1250);assert.deepEqual(parsed.observations[0]?.evidence.at(-1)?.cells,['C4']);assert.equal(parsed.observations[0]?.evidence.at(-1)?.rawValue,'1.25E3');assert.equal(parsed.observations[0]?.evidence.at(-1)?.sheet,'Debt');
});
it('scales only native percent-styled numeric tax-rate cells and preserves raw values',()=>{
 const styles='<styleSheet><numFmts><numFmt numFmtId="164" formatCode="0.00%"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="9"/><xf numFmtId="164"/></cellXfs></styleSheet>';
 const input=workbookSnapshot('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Gemeindeschlüssel</t></is></c><c r="B1" t="inlineStr"><is><t>Gewerbesteuer Hebesatz 2025 %</t></is></c><c r="C1" t="inlineStr"><is><t>Grundsteuer A Hebesatz 2025 %</t></is></c><c r="D1" t="inlineStr"><is><t>Grundsteuer B Hebesatz 2025 %</t></is></c><c r="E1" t="inlineStr"><is><t>Gewerbesteuer Hebesatz 2025 %</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>01053100</t></is></c><c r="B2" s="1"><v>3.5</v></c><c r="C2" s="2"><v>0.075</v></c><c r="D2"><v>350</v></c><c r="E2"><v>0.5</v></c></row></sheetData></worksheet>',styles);
 const parsed=adapter.parse(input,scope);assert.deepEqual(parsed.observations.map(value=>value.value),[350,7.5,350,0.5]);assert.deepEqual(parsed.observations.map(value=>value.evidence.find(item=>item.cells.includes(value.nativeId.split(':').at(-1)!))?.rawValue),['3.5','0.075','350','0.5']);
 assert.ok(parsed.observations[0]?.supportingEvidence.some(item=>item.role==='source_metadata'&&item.locator.path.includes('styles.xml')));
 assert.ok(parsed.observations[0]?.supportingEvidence.some(item=>String(item.locator.rawValue)==='9'));
});
it('holds native percent-formatted amount columns rather than publishing a wrong monetary unit',()=>{
 const input=workbookSnapshot('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Gemeindeschlüssel</t></is></c><c r="B1" t="inlineStr"><is><t>Schulden Kernhaushalte 2025 EUR</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>01053100</t></is></c><c r="B2" s="1"><v>0.5</v></c></row></sheetData></worksheet>','<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="9"/></cellXfs></styleSheet>');
 const parsed=adapter.parse(input,scope);assert.deepEqual(parsed.observations,[]);assert.equal(parsed.coverage.state,'held_quality');
});
